locals {
  kafka_clients = toset(local.stores.msk.clients)
}

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
  retention_in_days = 30
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

  client_authentication {
    unauthenticated = false
    sasl {
      scram = true
    }
  }

  encryption_info {
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

# MSK only reads SCRAM secrets encrypted with a customer managed key.
resource "aws_kms_key" "msk_users" {
  description         = "${local.name} MSK SCRAM credentials"
  enable_key_rotation = true
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "AccountAdministers"
      Effect    = "Allow"
      Principal = { AWS = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:root" }
      Action    = "kms:*"
      Resource  = "*"
    }]
  })
}

data "aws_caller_identity" "current" {}

resource "random_password" "kafka" {
  for_each = local.kafka_clients
  length   = 32
  special  = false
}

# One SCRAM user per service, so each can be rotated and traced alone.
resource "aws_secretsmanager_secret" "kafka" {
  for_each                = local.kafka_clients
  name                    = "AmazonMSK_${local.name}-${each.key}"
  kms_key_id              = aws_kms_key.msk_users.arn
  recovery_window_in_days = var.allow_destroy ? 0 : 30
}

resource "aws_secretsmanager_secret_version" "kafka" {
  for_each      = local.kafka_clients
  secret_id     = aws_secretsmanager_secret.kafka[each.key].id
  secret_string = jsonencode({ username = each.key, password = random_password.kafka[each.key].result })
}

resource "aws_msk_scram_secret_association" "log" {
  cluster_arn     = aws_msk_cluster.log.arn
  secret_arn_list = [for secret in aws_secretsmanager_secret.kafka : secret.arn]
  depends_on      = [aws_secretsmanager_secret_version.kafka]
}
