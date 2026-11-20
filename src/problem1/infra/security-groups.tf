locals {
  workloads = toset(["oms-api", "oms-relay", "oms-settler", "matcher", "marketdata"])
  # Who may open a connection to each data store; nothing else can.
  # The matcher never touches the database, and only oms-api uses Valkey.
  stores = {
    aurora = { port = 5432, clients = ["oms-api", "oms-relay", "oms-settler"] }
    msk    = { port = 9096, clients = ["oms-relay", "oms-settler", "matcher", "marketdata"] }
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

# AWS APIs, ECR and the telemetry back ends, through the NAT gateways.
resource "aws_vpc_security_group_egress_rule" "https" {
  for_each          = local.workloads
  security_group_id = aws_security_group.workload[each.key].id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  description       = "AWS APIs over HTTPS"
}
