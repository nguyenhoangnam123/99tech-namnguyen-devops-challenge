resource "aws_elasticache_subnet_group" "limits" {
  name       = "${local.name}-limits"
  subnet_ids = [for subnet in aws_subnet.isolated : subnet.id]
}

resource "random_password" "valkey" {
  length  = 64
  special = false
}

resource "aws_secretsmanager_secret" "valkey" {
  name                    = "${local.name}/valkey-auth"
  recovery_window_in_days = var.allow_destroy ? 0 : 30
}

resource "aws_secretsmanager_secret_version" "valkey" {
  secret_id     = aws_secretsmanager_secret.valkey.id
  secret_string = random_password.valkey.result
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

# Rate limit counters only: losing them resets windows, so no snapshots.
resource "aws_elasticache_replication_group" "limits" {
  replication_group_id       = "${local.name}-limits"
  description                = "Rate limit counters for oms-api"
  engine                     = "valkey"
  engine_version             = var.valkey.engine_version
  parameter_group_name       = aws_elasticache_parameter_group.limits.name
  node_type                  = var.valkey.node_type
  num_cache_clusters         = 2
  automatic_failover_enabled = true
  multi_az_enabled           = true
  subnet_group_name          = aws_elasticache_subnet_group.limits.name
  security_group_ids         = [aws_security_group.store["valkey"].id]
  at_rest_encryption_enabled = true
  transit_encryption_enabled = true
  auth_token                 = random_password.valkey.result
  auto_minor_version_upgrade = true
  maintenance_window         = "sun:19:00-sun:20:00"
}
