resource "aws_msk_configuration" "log" {
  name           = "${local.name}-log"
  kafka_versions = [var.msk.kafka_version]
  # The matcher's exactly-once publish (ADR 0003) needs replicated
  # transaction state, and an acknowledged write must survive a broker.
  server_properties = <<-EOT
    auto.create.topics.enable=false
    default.replication.factor=${min(var.msk.brokers, 3)}
    min.insync.replicas=${min(var.msk.brokers, 3) - 1}
    num.partitions=12
    offsets.topic.replication.factor=${min(var.msk.brokers, 3)}
    transaction.state.log.replication.factor=${min(var.msk.brokers, 3)}
    transaction.state.log.min.isr=${min(var.msk.brokers, 3) - 1}
    unclean.leader.election.enable=false
  EOT
}

resource "aws_cloudwatch_log_group" "msk" {
  name              = "/p1/${var.environment}/msk"
  retention_in_days = 365
  kms_key_id        = aws_kms_key.data["logs"].arn
}

resource "aws_msk_cluster" "log" {
  cluster_name           = "${local.name}-log"
  kafka_version          = var.msk.kafka_version
  number_of_broker_nodes = var.msk.brokers

  broker_node_group_info {
    instance_type   = var.msk.instance_type
    client_subnets  = [for subnet in aws_subnet.isolated : subnet.id]
    security_groups = [aws_security_group.store["msk"].id]
    storage_info {
      ebs_storage_info {
        volume_size = var.msk.volume_gb
      }
    }
  }

  configuration_info {
    arn      = aws_msk_configuration.log.arn
    revision = aws_msk_configuration.log.latest_revision
  }

  # IAM, not SCRAM: no passwords to store or rotate, and each task role
  # names the topics, groups and transactional ids it may use (iam.tf).
  client_authentication {
    unauthenticated = false
    sasl {
      iam = true
    }
  }

  encryption_info {
    encryption_at_rest_kms_key_arn = aws_kms_key.data["stream"].arn
    encryption_in_transit {
      client_broker = "TLS"
      in_cluster    = true
    }
  }

  # Scraped by the ADOT collector into Managed Prometheus.
  open_monitoring {
    prometheus {
      jmx_exporter {
        enabled_in_broker = true
      }
      node_exporter {
        enabled_in_broker = true
      }
    }
  }

  logging_info {
    broker_logs {
      cloudwatch_logs {
        enabled   = true
        log_group = aws_cloudwatch_log_group.msk.name
      }
    }
  }
}
