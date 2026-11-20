resource "aws_elasticache_subnet_group" "limits" {
  name       = "${local.name}-limits"
  subnet_ids = [for subnet in aws_subnet.isolated : subnet.id]
}

# Same eviction as wave 1's Redis: counters are disposable, so evict any key.
resource "aws_elasticache_parameter_group" "limits" {
  name   = "${local.name}-limits"
  family = "valkey${split(".", var.valkey.engine_version)[0]}"
  parameter {
    name  = "maxmemory-policy"
    value = "allkeys-lru"
  }
}

# Every user group must contain a user named default; this one is off.
resource "aws_elasticache_user" "default" {
  user_id       = "${local.name}-default"
  user_name     = "default"
  engine        = "valkey"
  access_string = "off -@all"
  authentication_mode {
    type = "no-password-required"
  }
}

# oms-api signs in with its task role and may touch only rate limit keys.
resource "aws_elasticache_user" "oms_api" {
  user_id       = "${local.name}-oms-api"
  user_name     = "${local.name}-oms-api"
  engine        = "valkey"
  access_string = "on ~rl:* -@all +@connection +@read +@write +@scripting +info"
  authentication_mode {
    type = "iam"
  }
}

resource "aws_elasticache_user_group" "limits" {
  user_group_id = "${local.name}-limits"
  engine        = "valkey"
  user_ids      = [aws_elasticache_user.default.user_id, aws_elasticache_user.oms_api.user_id]
}

# Rate limit counters only: losing them resets windows, so no snapshots.
resource "aws_elasticache_replication_group" "limits" {
  replication_group_id        = "${local.name}-limits"
  description                 = "Rate limit counters for oms-api"
  engine                      = "valkey"
  engine_version              = var.valkey.engine_version
  parameter_group_name        = aws_elasticache_parameter_group.limits.name
  node_type                   = var.valkey.node_type
  num_cache_clusters          = 2
  preferred_cache_cluster_azs = slice(keys(local.zones), 0, 2)
  automatic_failover_enabled  = true
  multi_az_enabled            = true
  subnet_group_name           = aws_elasticache_subnet_group.limits.name
  security_group_ids          = [aws_security_group.store["valkey"].id]
  at_rest_encryption_enabled  = true
  kms_key_id                  = aws_kms_key.data["stream"].arn
  transit_encryption_enabled  = true
  user_group_ids              = [aws_elasticache_user_group.limits.user_group_id]
  auto_minor_version_upgrade  = true
  maintenance_window          = "sun:19:00-sun:20:00"
}
