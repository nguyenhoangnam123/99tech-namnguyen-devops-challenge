# Pinned by zone ID: a new Local Zone or an impaired zone cannot shift the
# list, which would replace subnets and with them the MSK cluster.
data "aws_availability_zones" "pinned" {
  all_availability_zones = true
  filter {
    name   = "zone-id"
    values = var.zone_ids
  }
}

locals {
  name       = "p1-${var.environment}"
  zone_names = zipmap(data.aws_availability_zones.pinned.zone_ids, data.aws_availability_zones.pinned.names)
  zones      = { for i, id in var.zone_ids : local.zone_names[id] => i }
  # Three /20 tiers per zone: public (ALB, NAT), private (tasks),
  # isolated (data stores, no route out of the VPC).
  tiers = { public = 0, private = 4, isolated = 8 }
}

resource "aws_vpc" "main" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = { Name = local.name }
}

resource "aws_subnet" "public" {
  for_each          = local.zones
  vpc_id            = aws_vpc.main.id
  availability_zone = each.key
  cidr_block        = cidrsubnet(var.vpc_cidr, 4, local.tiers.public + each.value)
  tags              = { Name = "${local.name}-public-${each.key}", tier = "public" }
}

resource "aws_subnet" "private" {
  for_each          = local.zones
  vpc_id            = aws_vpc.main.id
  availability_zone = each.key
  cidr_block        = cidrsubnet(var.vpc_cidr, 4, local.tiers.private + each.value)
  tags              = { Name = "${local.name}-private-${each.key}", tier = "private" }
}

resource "aws_subnet" "isolated" {
  for_each          = local.zones
  vpc_id            = aws_vpc.main.id
  availability_zone = each.key
  cidr_block        = cidrsubnet(var.vpc_cidr, 4, local.tiers.isolated + each.value)
  tags              = { Name = "${local.name}-isolated-${each.key}", tier = "isolated" }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = local.name }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = "${local.name}-public" }
}

resource "aws_route" "public_internet" {
  route_table_id         = aws_route_table.public.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.main.id
}

resource "aws_route_table_association" "public" {
  for_each       = aws_subnet.public
  subnet_id      = each.value.id
  route_table_id = aws_route_table.public.id
}

# Tasks have no route to the internet. AWS APIs are reached through
# interface endpoints and S3 through its gateway endpoint.
resource "aws_route_table" "private" {
  for_each = local.zones
  vpc_id   = aws_vpc.main.id
  tags     = { Name = "${local.name}-private-${each.key}" }
}

resource "aws_route_table_association" "private" {
  for_each       = aws_subnet.private
  subnet_id      = each.value.id
  route_table_id = aws_route_table.private[each.key].id
}

# No routes beyond the VPC's local route.
resource "aws_route_table" "isolated" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = "${local.name}-isolated" }
}

resource "aws_route_table_association" "isolated" {
  for_each       = aws_subnet.isolated
  subnet_id      = each.value.id
  route_table_id = aws_route_table.isolated.id
}

# Matcher snapshots and image layers reach S3 without the NAT data charge.
# Only this account's buckets, plus the bucket ECR serves image layers from,
# so a task cannot copy data to someone else's bucket.
resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.main.id
  service_name      = "com.amazonaws.${var.region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [for table in aws_route_table.private : table.id]
  tags              = { Name = "${local.name}-s3" }
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "ThisAccountsBuckets"
        Effect    = "Allow"
        Principal = "*"
        Action    = "s3:*"
        Resource  = "*"
        Condition = { StringEquals = { "aws:ResourceAccount" = local.account } }
      },
      {
        Sid       = "EcrImageLayers"
        Effect    = "Allow"
        Principal = "*"
        Action    = "s3:GetObject"
        Resource  = "arn:aws:s3:::prod-${var.region}-starport-layer-bucket/*"
      },
    ]
  })
}

locals {
  # Everything the tasks and the telemetry collector call: image pulls,
  # logs, secrets, Managed Prometheus and X-Ray.
  interface_endpoints = toset(["ecr.api", "ecr.dkr", "logs", "secretsmanager", "aps-workspaces", "xray"])
}

resource "aws_security_group" "endpoints" {
  name        = "${local.name}-endpoints"
  description = "Interface endpoints: HTTPS from workloads only"
  vpc_id      = aws_vpc.main.id
  tags        = { Name = "${local.name}-endpoints" }
}

resource "aws_vpc_security_group_ingress_rule" "endpoints" {
  for_each                     = local.workloads
  security_group_id            = aws_security_group.endpoints.id
  referenced_security_group_id = aws_security_group.workload[each.key].id
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
  description                  = "from ${each.key}"
}

resource "aws_vpc_endpoint" "interface" {
  for_each            = local.interface_endpoints
  vpc_id              = aws_vpc.main.id
  service_name        = "com.amazonaws.${var.region}.${each.key}"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = [for subnet in aws_subnet.private : subnet.id]
  security_group_ids  = [aws_security_group.endpoints.id]
  private_dns_enabled = true
  tags                = { Name = "${local.name}-${each.key}" }
  # Callers must be this account's roles, so stolen keys from another
  # account cannot be used through the endpoint.
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "ThisAccountsPrincipals"
      Effect    = "Allow"
      Principal = "*"
      Action    = "*"
      Resource  = "*"
      Condition = { StringEquals = { "aws:PrincipalAccount" = local.account } }
    }]
  })
}

# A VPC's default group admits its own members; nothing should use it.
resource "aws_default_security_group" "closed" {
  vpc_id = aws_vpc.main.id
}

resource "aws_cloudwatch_log_group" "flow" {
  name              = "/p1/${var.environment}/vpc-flow"
  retention_in_days = 365
  kms_key_id        = aws_kms_key.data["logs"].arn
}

resource "aws_flow_log" "vpc" {
  vpc_id                   = aws_vpc.main.id
  traffic_type             = "ALL"
  log_destination_type     = "cloud-watch-logs"
  log_destination          = aws_cloudwatch_log_group.flow.arn
  iam_role_arn             = aws_iam_role.flow_logs.arn
  max_aggregation_interval = 60
}

resource "aws_iam_role" "flow_logs" {
  name = "${local.name}-flow-logs"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "vpc-flow-logs.amazonaws.com" }
      Action    = "sts:AssumeRole"
      Condition = { StringEquals = { "aws:SourceAccount" = local.account } }
    }]
  })
}

resource "aws_iam_role_policy" "flow_logs" {
  name = "write-flow-logs"
  role = aws_iam_role.flow_logs.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogStreams"]
      Resource = "${aws_cloudwatch_log_group.flow.arn}:*"
    }]
  })
}
