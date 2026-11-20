data "aws_availability_zones" "available" {
  state = "available"
}

locals {
  name  = "p1-${var.environment}"
  zones = { for i, zone in slice(sort(data.aws_availability_zones.available.names), 0, var.zone_count) : zone => i }
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

locals {
  # Staging shares one NAT gateway in the first zone.
  nat_zones = var.nat_per_zone ? local.zones : { (keys(local.zones)[0]) = 0 }
}

resource "aws_eip" "nat" {
  for_each = local.nat_zones
  domain   = "vpc"
  tags     = { Name = "${local.name}-nat-${each.key}" }
}

resource "aws_nat_gateway" "main" {
  for_each      = local.nat_zones
  allocation_id = aws_eip.nat[each.key].id
  subnet_id     = aws_subnet.public[each.key].id
  tags          = { Name = "${local.name}-${each.key}" }
  depends_on    = [aws_internet_gateway.main]
}

resource "aws_route_table" "private" {
  for_each = local.zones
  vpc_id   = aws_vpc.main.id
  tags     = { Name = "${local.name}-private-${each.key}" }
}

resource "aws_route" "private_nat" {
  for_each               = local.zones
  route_table_id         = aws_route_table.private[each.key].id
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id         = aws_nat_gateway.main[var.nat_per_zone ? each.key : keys(local.zones)[0]].id
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
resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.main.id
  service_name      = "com.amazonaws.${var.region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [for table in aws_route_table.private : table.id]
  tags              = { Name = "${local.name}-s3" }
}
