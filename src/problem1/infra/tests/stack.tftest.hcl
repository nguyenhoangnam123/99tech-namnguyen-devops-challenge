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
    defaults = { arn = "arn:aws:kms:ap-southeast-1:123456789012:key/default" }
  }
  mock_resource "aws_cloudwatch_log_group" {
    defaults = { arn = "arn:aws:logs:ap-southeast-1:123456789012:log-group:p1" }
  }
  mock_resource "aws_elasticache_user" {
    defaults = { arn = "arn:aws:elasticache:ap-southeast-1:123456789012:user:p1" }
  }
  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::123456789012:role/p1" }
  }
  mock_resource "aws_rds_cluster" {
    defaults = { master_user_secret = [{ secret_arn = "arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:ledger" }] }
  }
}

# Distinct key ARNs, so a store on the wrong key fails its test.
override_resource {
  target = aws_kms_key.data["ledger"]
  values = { arn = "arn:aws:kms:ap-southeast-1:123456789012:key/ledger" }
}

override_resource {
  target = aws_kms_key.data["stream"]
  values = { arn = "arn:aws:kms:ap-southeast-1:123456789012:key/stream" }
}

override_resource {
  target = aws_kms_key.data["logs"]
  values = { arn = "arn:aws:kms:ap-southeast-1:123456789012:key/logs" }
}

variables {
  environment = "production"
  vpc_cidr    = "10.20.0.0/16"
  zone_count  = 3
  aurora      = { instance_class = "db.r7g.large", instances = 2, engine_version = "17.11" }
  msk         = { instance_type = "kafka.m7g.large", brokers = 3, volume_gb = 100, kafka_version = "4.1.x.kraft" }
  valkey      = { node_type = "cache.t4g.small", engine_version = "8.2" }
}

run "every_tier_spans_three_zones" {
  assert {
    condition = alltrue([
      for tier in [aws_subnet.public, aws_subnet.private, aws_subnet.isolated] :
      length(distinct([for subnet in tier : subnet.availability_zone])) == 3
    ])
    error_message = "Each tier needs one subnet in each of three zones."
  }
}

run "tasks_reach_aws_only_through_endpoints" {
  assert {
    condition = alltrue([
      for endpoint in aws_vpc_endpoint.interface :
      endpoint.private_dns_enabled && toset(endpoint.subnet_ids) == toset([for subnet in aws_subnet.private : subnet.id])
    ]) && length(aws_vpc_endpoint.interface) == 6
    error_message = "Each AWS API the tasks call needs a private endpoint in every zone."
  }
  assert {
    condition = alltrue(concat(
      [for rule in aws_vpc_security_group_egress_rule.endpoints : rule.referenced_security_group_id == aws_security_group.endpoints.id && rule.cidr_ipv4 == null],
      [for rule in aws_vpc_security_group_egress_rule.s3 : rule.prefix_list_id == aws_vpc_endpoint.s3.prefix_list_id && rule.cidr_ipv4 == null],
    ))
    error_message = "Workload HTTPS may go only to the endpoints and S3, never to an address range."
  }
}

run "data_subnets_have_no_route_out" {
  assert {
    condition = alltrue(concat(
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
    condition = alltrue([
      aws_rds_cluster.ledger.kms_key_id == aws_kms_key.data["ledger"].arn,
      aws_rds_cluster.ledger.master_user_secret_kms_key_id == aws_kms_key.data["ledger"].arn,
      alltrue([for db in aws_rds_cluster_instance.ledger : db.performance_insights_kms_key_id == aws_kms_key.data["ledger"].arn]),
    ])
    error_message = "Ledger data, its master secret and Performance Insights use the ledger key."
  }
  assert {
    condition     = aws_rds_cluster.ledger.iam_database_authentication_enabled
    error_message = "Services sign in with their task role, not a shared password."
  }
  assert {
    condition = alltrue([
      strcontains(one([for p in aws_rds_cluster_parameter_group.ledger.parameter : p.value if p.name == "shared_preload_libraries"]), "pgaudit"),
      one([for p in aws_rds_cluster_parameter_group.ledger.parameter : p.value if p.name == "pgaudit.log"]) == "ddl,role",
      aws_cloudwatch_log_group.ledger.retention_in_days >= 365,
      aws_cloudwatch_log_group.ledger.kms_key_id == aws_kms_key.data["logs"].arn,
    ])
    error_message = "Schema and role changes must be audited and the log kept a year, encrypted."
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
    condition     = !aws_msk_cluster.log.client_authentication[0].unauthenticated && aws_msk_cluster.log.client_authentication[0].sasl[0].iam && !coalesce(aws_msk_cluster.log.client_authentication[0].sasl[0].scram, false)
    error_message = "Every Kafka client must authenticate with IAM, so access is per topic."
  }
  assert {
    condition     = aws_msk_cluster.log.encryption_info[0].encryption_at_rest_kms_key_arn == aws_kms_key.data["stream"].arn
    error_message = "MSK data at rest uses the stream key."
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
  assert {
    condition = alltrue([
      aws_elasticache_replication_group.limits.kms_key_id == aws_kms_key.data["stream"].arn,
      aws_elasticache_replication_group.limits.auth_token == null,
      toset(aws_elasticache_replication_group.limits.user_group_ids) == toset([aws_elasticache_user_group.limits.user_group_id]),
      startswith(aws_elasticache_user.default.access_string, "off"),
      aws_elasticache_user.oms_api.authentication_mode[0].type == "iam",
      startswith(aws_elasticache_user.oms_api.access_string, "on ~rl:* -@all"),
    ])
    error_message = "Valkey: no shared token, the default user off, and oms-api limited to rl:* keys."
  }
}

run "each_service_gets_only_its_own_access" {
  assert {
    condition     = toset(keys(aws_iam_role_policy.kafka)) == toset(["oms-relay", "matcher", "oms-settler", "marketdata"])
    error_message = "Only the four Kafka clients may hold Kafka permissions."
  }
  assert {
    condition = jsonencode({
      for name, policy in aws_iam_role_policy.kafka : name => sort(flatten([
        for statement in jsondecode(policy.policy).Statement : [for arn in statement.Resource : reverse(split("/", arn))[0]]
        if statement.Sid == "WriteTopics"
      ]))
      }) == jsonencode({
      oms-relay = ["orders.commands"], matcher = ["matcher.events"], oms-settler = [], marketdata = []
    })
    error_message = "Only the relay writes commands and only the matcher writes events."
  }
  assert {
    condition = alltrue([
      for name, policy in aws_iam_role_policy.kafka :
      length([for statement in jsondecode(policy.policy).Statement : statement if statement.Sid == "TransactionalIds"]) == (name == "matcher" ? 1 : 0)
    ])
    error_message = "Only the matcher may use a transactional id, which is what fences a stale matcher."
  }
  assert {
    condition = jsonencode({
      for name, policy in aws_iam_role_policy.database : name => reverse(split("/", jsondecode(policy.policy).Statement[0].Resource))[0]
    }) == jsonencode({ oms-api = "oms_api", oms-relay = "oms_relay", oms-settler = "oms_settler" })
    error_message = "Each database client connects as its own Postgres role, and the matcher not at all."
  }
  assert {
    condition     = aws_iam_role_policy.valkey.role == aws_iam_role.task["oms-api"].id
    error_message = "Only oms-api may connect to Valkey."
  }
  assert {
    condition = alltrue([
      for role in aws_iam_role.task :
      jsondecode(role.assume_role_policy).Statement[0].Condition.StringEquals["aws:SourceAccount"] == "123456789012"
    ])
    error_message = "Task roles must be assumable only by ECS tasks in this account."
  }
}

run "network_and_keys_are_audited" {
  assert {
    condition     = aws_flow_log.vpc.traffic_type == "ALL" && aws_flow_log.vpc.log_destination == aws_cloudwatch_log_group.flow.arn
    error_message = "Every flow in the VPC must be logged."
  }
  assert {
    condition = alltrue([
      for group in [aws_cloudwatch_log_group.flow, aws_cloudwatch_log_group.msk] :
      group.retention_in_days >= 365 && group.kms_key_id == aws_kms_key.data["logs"].arn
    ])
    error_message = "Audit logs are kept a year and encrypted with the logs key."
  }
  assert {
    condition     = alltrue([for key in aws_kms_key.data : key.enable_key_rotation])
    error_message = "Every key rotates."
  }
  assert {
    condition     = length(aws_default_security_group.closed.ingress) == 0 && length(aws_default_security_group.closed.egress) == 0
    error_message = "The default security group must allow nothing."
  }
}

run "ledger_backups_cannot_be_deleted_early" {
  assert {
    condition = alltrue([
      aws_backup_vault.ledger.kms_key_arn == aws_kms_key.data["ledger"].arn,
      aws_backup_vault_lock_configuration.ledger[0].min_retention_days >= 35,
      contains(aws_backup_selection.ledger.resources, aws_rds_cluster.ledger.arn),
      length(aws_backup_plan.ledger.rule) == 1,
      alltrue([for rule in aws_backup_plan.ledger.rule : alltrue([for keep in rule.lifecycle : keep.delete_after >= 35])]),
    ])
    error_message = "The ledger needs daily backups in a locked vault kept at least 35 days."
  }
}

run "staging_is_smaller_but_still_spans_zones" {
  # Distinct key ARNs, so a store on the wrong key fails its test.
  override_resource {
    target = aws_kms_key.data["ledger"]
    values = { arn = "arn:aws:kms:ap-southeast-1:123456789012:key/ledger" }
  }

  override_resource {
    target = aws_kms_key.data["stream"]
    values = { arn = "arn:aws:kms:ap-southeast-1:123456789012:key/stream" }
  }

  override_resource {
    target = aws_kms_key.data["logs"]
    values = { arn = "arn:aws:kms:ap-southeast-1:123456789012:key/logs" }
  }

  variables {
    environment = "staging"
    vpc_cidr    = "10.21.0.0/16"
    zone_count  = 2
    aurora      = { instance_class = "db.t4g.medium", instances = 1, engine_version = "17.11" }
    msk         = { instance_type = "kafka.t3.small", brokers = 2, volume_gb = 20, kafka_version = "4.1.x.kraft" }
  }
  assert {
    condition     = length(aws_subnet.isolated) == 2 && length(aws_vpc_endpoint.interface["logs"].subnet_ids) == 2
    error_message = "Staging spans two zones, endpoints included."
  }
  assert {
    condition     = strcontains(aws_msk_configuration.log.server_properties, "min.insync.replicas=1")
    error_message = "Two brokers cannot require two in-sync replicas and still take writes."
  }
}

run "rejects_an_unknown_environment" {
  command = plan
  # Distinct key ARNs, so a store on the wrong key fails its test.
  override_resource {
    target = aws_kms_key.data["ledger"]
    values = { arn = "arn:aws:kms:ap-southeast-1:123456789012:key/ledger" }
  }

  override_resource {
    target = aws_kms_key.data["stream"]
    values = { arn = "arn:aws:kms:ap-southeast-1:123456789012:key/stream" }
  }

  override_resource {
    target = aws_kms_key.data["logs"]
    values = { arn = "arn:aws:kms:ap-southeast-1:123456789012:key/logs" }
  }

  variables { environment = "dev" }
  expect_failures = [var.environment]
}

run "rejects_uneven_brokers" {
  command = plan
  # Distinct key ARNs, so a store on the wrong key fails its test.
  override_resource {
    target = aws_kms_key.data["ledger"]
    values = { arn = "arn:aws:kms:ap-southeast-1:123456789012:key/ledger" }
  }

  override_resource {
    target = aws_kms_key.data["stream"]
    values = { arn = "arn:aws:kms:ap-southeast-1:123456789012:key/stream" }
  }

  override_resource {
    target = aws_kms_key.data["logs"]
    values = { arn = "arn:aws:kms:ap-southeast-1:123456789012:key/logs" }
  }

  variables { msk = { instance_type = "kafka.m7g.large", brokers = 4, volume_gb = 100, kafka_version = "4.1.x.kraft" } }
  expect_failures = [var.msk]
}

run "production_needs_three_brokers" {
  command = plan
  # Distinct key ARNs, so a store on the wrong key fails its test.
  override_resource {
    target = aws_kms_key.data["ledger"]
    values = { arn = "arn:aws:kms:ap-southeast-1:123456789012:key/ledger" }
  }

  override_resource {
    target = aws_kms_key.data["stream"]
    values = { arn = "arn:aws:kms:ap-southeast-1:123456789012:key/stream" }
  }

  override_resource {
    target = aws_kms_key.data["logs"]
    values = { arn = "arn:aws:kms:ap-southeast-1:123456789012:key/logs" }
  }

  variables {
    zone_count = 2
    msk        = { instance_type = "kafka.m7g.large", brokers = 2, volume_gb = 100, kafka_version = "4.1.x.kraft" }
  }
  expect_failures = [var.msk]
}
