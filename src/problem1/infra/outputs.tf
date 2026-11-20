output "vpc_id" {
  value = aws_vpc.main.id
}

output "subnet_ids" {
  value = {
    public   = [for subnet in aws_subnet.public : subnet.id]
    private  = [for subnet in aws_subnet.private : subnet.id]
    isolated = [for subnet in aws_subnet.isolated : subnet.id]
  }
}

output "workload_security_group_ids" {
  description = "Attach to the matching ECS service."
  value       = { for name, group in aws_security_group.workload : name => group.id }
}

output "database" {
  value = {
    writer        = aws_rds_cluster.ledger.endpoint
    reader        = aws_rds_cluster.ledger.reader_endpoint
    master_secret = aws_rds_cluster.ledger.master_user_secret[0].secret_arn
  }
}

output "kafka" {
  value = {
    bootstrap_brokers = aws_msk_cluster.log.bootstrap_brokers_sasl_scram
    user_secrets      = { for name, secret in aws_secretsmanager_secret.kafka : name => secret.arn }
  }
}

output "valkey" {
  value = {
    endpoint    = aws_elasticache_replication_group.limits.primary_endpoint_address
    auth_secret = aws_secretsmanager_secret.valkey.arn
  }
}
