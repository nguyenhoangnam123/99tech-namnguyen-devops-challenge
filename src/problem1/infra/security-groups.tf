locals {
  workloads = toset(["oms-api", "oms-relay", "oms-settler", "matcher", "marketdata", "adot"])
  # Who may open a connection to each data store; nothing else can.
  # The matcher never touches the database, and only oms-api uses Valkey.
  stores = {
    aurora = { port = 5432, clients = ["oms-api", "oms-relay", "oms-settler"] }
    msk    = { port = 9098, clients = ["oms-relay", "oms-settler", "matcher", "marketdata"] }
    valkey = { port = 6379, clients = ["oms-api"] }
  }
  grants = merge([
    for store, spec in local.stores : {
      for client in spec.clients : "${store}/${client}" => { store = store, client = client, port = spec.port }
    }
  ]...)
}

# ECS services attach these; the compute stack is not part of this one.
resource "aws_security_group" "workload" {
  #checkov:skip=CKV2_AWS_5:Attached by the ECS services, which live in another stack.
  for_each    = local.workloads
  name        = "${local.name}-${each.key}"
  description = "${each.key} tasks"
  vpc_id      = aws_vpc.main.id
  tags        = { Name = "${local.name}-${each.key}" }
}

resource "aws_security_group" "store" {
  for_each    = local.stores
  name        = "${local.name}-${each.key}"
  description = "${each.key}: inbound from its clients only"
  vpc_id      = aws_vpc.main.id
  tags        = { Name = "${local.name}-${each.key}" }
}

resource "aws_vpc_security_group_ingress_rule" "store" {
  for_each                     = local.grants
  security_group_id            = aws_security_group.store[each.value.store].id
  referenced_security_group_id = aws_security_group.workload[each.value.client].id
  ip_protocol                  = "tcp"
  from_port                    = each.value.port
  to_port                      = each.value.port
  description                  = "from ${each.value.client}"
}

resource "aws_vpc_security_group_egress_rule" "to_store" {
  for_each                     = local.grants
  security_group_id            = aws_security_group.workload[each.value.client].id
  referenced_security_group_id = aws_security_group.store[each.value.store].id
  ip_protocol                  = "tcp"
  from_port                    = each.value.port
  to_port                      = each.value.port
  description                  = "to ${each.value.store}"
}

# HTTPS only to the interface endpoints and S3; no other way out.
resource "aws_vpc_security_group_egress_rule" "endpoints" {
  for_each                     = local.workloads
  security_group_id            = aws_security_group.workload[each.key].id
  referenced_security_group_id = aws_security_group.endpoints.id
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
  description                  = "AWS APIs through interface endpoints"
}

resource "aws_vpc_security_group_egress_rule" "s3" {
  for_each          = local.workloads
  security_group_id = aws_security_group.workload[each.key].id
  prefix_list_id    = aws_vpc_endpoint.s3.prefix_list_id
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  description       = "S3 through the gateway endpoint"
}

# Every service sends OTLP over HTTP to the ADOT collector.
resource "aws_vpc_security_group_ingress_rule" "otlp" {
  for_each                     = setsubtract(local.workloads, ["adot"])
  security_group_id            = aws_security_group.workload["adot"].id
  referenced_security_group_id = aws_security_group.workload[each.key].id
  ip_protocol                  = "tcp"
  from_port                    = 4318
  to_port                      = 4318
  description                  = "OTLP from ${each.key}"
}

resource "aws_vpc_security_group_egress_rule" "otlp" {
  for_each                     = setsubtract(local.workloads, ["adot"])
  security_group_id            = aws_security_group.workload[each.key].id
  referenced_security_group_id = aws_security_group.workload["adot"].id
  ip_protocol                  = "tcp"
  from_port                    = 4318
  to_port                      = 4318
  description                  = "OTLP to the collector"
}

# The collector scrapes the brokers' JMX and node exporters.
resource "aws_vpc_security_group_ingress_rule" "msk_metrics" {
  security_group_id            = aws_security_group.store["msk"].id
  referenced_security_group_id = aws_security_group.workload["adot"].id
  ip_protocol                  = "tcp"
  from_port                    = 11001
  to_port                      = 11002
  description                  = "Prometheus scrape from adot"
}

resource "aws_vpc_security_group_egress_rule" "msk_metrics" {
  security_group_id            = aws_security_group.workload["adot"].id
  referenced_security_group_id = aws_security_group.store["msk"].id
  ip_protocol                  = "tcp"
  from_port                    = 11001
  to_port                      = 11002
  description                  = "Prometheus scrape of the brokers"
}
