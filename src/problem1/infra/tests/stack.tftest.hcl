# Applies against a mocked AWS provider: no account, no credentials, no
# cost. Checks the properties the P1 design relies on.
mock_provider "aws" {
  mock_data "aws_availability_zones" {
    defaults = { names = ["ap-southeast-1a", "ap-southeast-1b", "ap-southeast-1c"] }
  }
  mock_data "aws_caller_identity" {
    defaults = { account_id = "123456789012" }
  }
  # Real ARNs where the provider validates a reference.
  mock_resource "aws_msk_configuration" {
    defaults = { arn = "arn:aws:kafka:ap-southeast-1:123456789012:configuration/log/1" }
  }
  mock_resource "aws_msk_cluster" {
    defaults = { arn = "arn:aws:kafka:ap-southeast-1:123456789012:cluster/log/1" }
  }
  mock_resource "aws_kms_key" {
    defaults = { arn = "arn:aws:kms:ap-southeast-1:123456789012:key/1" }
  }
  mock_resource "aws_secretsmanager_secret" {
    defaults = { arn = "arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:p1" }
  }
  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::123456789012:role/p1" }
  }
  mock_resource "aws_rds_cluster" {
    defaults = { master_user_secret = [{ secret_arn = "arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:ledger" }] }
  }
}

variables {
  environment  = "production"
  vpc_cidr     = "10.20.0.0/16"
  zone_count   = 3
  nat_per_zone = true
  aurora       = { instance_class = "db.r7g.large", instances = 2, engine_version = "17.11" }
  msk          = { instance_type = "kafka.m7g.large", brokers = 3, volume_gb = 100, kafka_version = "4.1.x.kraft" }
  valkey       = { node_type = "cache.t4g.small", engine_version = "8.2" }
}

run "every_tier_spans_three_zones" {
  assert {
    condition = alltrue([
      for tier in [aws_subnet.public, aws_subnet.private, aws_subnet.isolated] :
      length(distinct([for subnet in tier : subnet.availability_zone])) == 3
    ])
    error_message = "Each tier needs one subnet in each of three zones."
  }
  assert {
    condition     = length(aws_nat_gateway.main) == 3 && alltrue([for zone, route in aws_route.private_nat : route.nat_gateway_id == aws_nat_gateway.main[zone].id])
    error_message = "Each zone's tasks must leave through that zone's NAT gateway."
  }
}

run "data_subnets_have_no_route_out" {
  assert {
    condition = alltrue(concat(
      [for route in aws_route.private_nat : route.route_table_id != aws_route_table.isolated.id],
      [aws_route.public_internet.route_table_id != aws_route_table.isolated.id],
      [!contains(aws_vpc_endpoint.s3.route_table_ids, aws_route_table.isolated.id)],
      [for association in aws_route_table_association.isolated : association.route_table_id == aws_route_table.isolated.id],
    ))
    error_message = "The isolated route table must keep only the local route."
  }
  assert {
    condition = alltrue([
      for subnets in [
        aws_db_subnet_group.ledger.subnet_ids,
        aws_msk_cluster.log.broker_node_group_info[0].client_subnets,
        aws_elasticache_subnet_group.limits.subnet_ids,
      ] : toset(subnets) == toset([for subnet in aws_subnet.isolated : subnet.id])
    ])
    error_message = "Aurora, MSK and Valkey must sit in the isolated subnets."
  }
}

run "each_store_admits_only_its_clients" {
  assert {
    condition = toset(keys(aws_vpc_security_group_ingress_rule.store)) == toset([
      "aurora/oms-api", "aurora/oms-relay", "aurora/oms-settler",
      "msk/oms-relay", "msk/oms-settler", "msk/matcher", "msk/marketdata",
      "valkey/oms-api",
    ])
    error_message = "A data store admits a service that never uses it, or misses one that does."
  }
  assert {
    condition = alltrue([
      for rule in aws_vpc_security_group_ingress_rule.store :
      rule.cidr_ipv4 == null && rule.cidr_ipv6 == null && rule.referenced_security_group_id != null
    ])
    error_message = "Data store ingress must name a workload security group, never an address range."
  }
}

run "ledger_is_durable_and_private" {
  assert {
    condition     = aws_rds_cluster.ledger.storage_encrypted && aws_rds_cluster.ledger.deletion_protection && !aws_rds_cluster.ledger.skip_final_snapshot
    error_message = "The ledger must be encrypted, protected from deletion and snapshotted on destroy."
  }
  assert {
    condition     = one([for p in aws_rds_cluster_parameter_group.ledger.parameter : p.value if p.name == "rds.force_ssl"]) == "1"
    error_message = "Aurora must refuse clients without TLS."
  }
  assert {
    condition     = length(distinct([for db in aws_rds_cluster_instance.ledger : db.availability_zone])) == 2 && alltrue([for db in aws_rds_cluster_instance.ledger : !db.publicly_accessible])
    error_message = "Writer and reader must be private and in different zones."
  }
}

run "log_survives_a_broker" {
  assert {
    condition = alltrue([
      for setting in ["default.replication.factor=3", "min.insync.replicas=2", "transaction.state.log.min.isr=2", "unclean.leader.election.enable=false", "auto.create.topics.enable=false"] :
      strcontains(aws_msk_configuration.log.server_properties, setting)
    ])
    error_message = "MSK must replicate three ways and acknowledge only in-sync writes."
  }
  assert {
    condition     = !aws_msk_cluster.log.client_authentication[0].unauthenticated && aws_msk_cluster.log.client_authentication[0].sasl[0].scram
    error_message = "Every Kafka client must authenticate."
  }
  assert {
    condition     = aws_msk_cluster.log.encryption_info[0].encryption_in_transit[0].client_broker == "TLS" && aws_msk_cluster.log.encryption_info[0].encryption_in_transit[0].in_cluster
    error_message = "Kafka traffic must be TLS end to end."
  }
}

run "limits_fail_over" {
  assert {
    condition = alltrue([
      aws_elasticache_replication_group.limits.multi_az_enabled,
      aws_elasticache_replication_group.limits.automatic_failover_enabled,
      aws_elasticache_replication_group.limits.num_cache_clusters == 2,
      tostring(aws_elasticache_replication_group.limits.transit_encryption_enabled) == "true",
      tostring(aws_elasticache_replication_group.limits.at_rest_encryption_enabled) == "true",
    ])
    error_message = "Valkey needs a replica in another zone, failover and TLS."
  }
}

run "staging_is_smaller_but_still_spans_zones" {
  variables {
    environment  = "staging"
    vpc_cidr     = "10.21.0.0/16"
    zone_count   = 2
    nat_per_zone = false
    aurora       = { instance_class = "db.t4g.medium", instances = 1, engine_version = "17.11" }
    msk          = { instance_type = "kafka.t3.small", brokers = 2, volume_gb = 20, kafka_version = "4.1.x.kraft" }
  }
  assert {
    condition     = length(aws_nat_gateway.main) == 1 && length(aws_subnet.isolated) == 2
    error_message = "Staging uses one NAT gateway and two zones."
  }
  assert {
    condition     = strcontains(aws_msk_configuration.log.server_properties, "min.insync.replicas=1")
    error_message = "Two brokers cannot require two in-sync replicas and still take writes."
  }
}

run "rejects_an_unknown_environment" {
  command = plan
  variables { environment = "dev" }
  expect_failures = [var.environment]
}

run "rejects_uneven_brokers" {
  command = plan
  variables { msk = { instance_type = "kafka.m7g.large", brokers = 4, volume_gb = 100, kafka_version = "4.1.x.kraft" } }
  expect_failures = [var.msk]
}

run "production_needs_three_brokers" {
  command = plan
  variables {
    zone_count = 2
    msk        = { instance_type = "kafka.m7g.large", brokers = 2, volume_gb = 100, kafka_version = "4.1.x.kraft" }
  }
  expect_failures = [var.msk]
}
