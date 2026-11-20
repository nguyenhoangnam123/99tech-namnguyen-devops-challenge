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

output "workloads" {
  description = "Security group and task role for each ECS service."
  value = {
    for name in local.workloads : name => {
      security_group_id = aws_security_group.workload[name].id
      task_role_arn     = aws_iam_role.task[name].arn
    }
  }
}

output "database" {
  value = {
    writer = aws_rds_cluster.ledger.endpoint
    reader = aws_rds_cluster.ledger.reader_endpoint
    users  = local.database_users
  }
}

output "kafka_bootstrap_brokers" {
  value = aws_msk_cluster.log.bootstrap_brokers_sasl_iam
}

output "valkey" {
  value = {
    endpoint = aws_elasticache_replication_group.limits.primary_endpoint_address
    user     = aws_elasticache_user.oms_api.user_name
  }
}
