# One task role per service. The ECS stack attaches them; each grants
# only what that service's code does, so a compromised task stays small.
# adot's write access belongs to the observability stack that owns it.
locals {
  kafka_arn = "arn:aws:kafka:${var.region}:${local.account}"
  cluster   = "${aws_msk_cluster.log.cluster_name}/${aws_msk_cluster.log.cluster_uuid}"
  kafka_access = {
    oms-relay   = { read = [], write = ["orders.commands"], groups = [], transactional_ids = [] }
    matcher     = { read = ["orders.commands"], write = ["matcher.events"], groups = ["matcher", "matcher-replay-*"], transactional_ids = ["matcher"] }
    oms-settler = { read = ["matcher.events"], write = [], groups = ["oms-settler"], transactional_ids = [] }
    marketdata  = { read = ["matcher.events"], write = [], groups = ["marketdata-*"], transactional_ids = [] }
  }
  # Postgres roles from the restricted-role migration; see Problem 5.
  database_users = { oms-api = "oms_api", oms-relay = "oms_relay", oms-settler = "oms_settler" }
}

resource "aws_iam_role" "task" {
  for_each = local.workloads
  name     = "${local.name}-${each.key}"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = "sts:AssumeRole"
      Condition = {
        StringEquals = { "aws:SourceAccount" = local.account }
        ArnLike      = { "aws:SourceArn" = "arn:aws:ecs:${var.region}:${local.account}:*" }
      }
    }]
  })
}

resource "aws_iam_role_policy" "kafka" {
  for_each = local.kafka_access
  name     = "kafka"
  role     = aws_iam_role.task[each.key].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat(
      [{
        Sid      = "Connect"
        Effect   = "Allow"
        Action   = concat(["kafka-cluster:Connect"], length(each.value.write) > 0 ? ["kafka-cluster:WriteDataIdempotently"] : [])
        Resource = aws_msk_cluster.log.arn
      }],
      length(each.value.read) > 0 ? [{
        Sid      = "ReadTopics"
        Effect   = "Allow"
        Action   = ["kafka-cluster:DescribeTopic", "kafka-cluster:ReadData"]
        Resource = [for topic in each.value.read : "${local.kafka_arn}:topic/${local.cluster}/${topic}"]
      }] : [],
      length(each.value.write) > 0 ? [{
        Sid      = "WriteTopics"
        Effect   = "Allow"
        Action   = ["kafka-cluster:DescribeTopic", "kafka-cluster:WriteData"]
        Resource = [for topic in each.value.write : "${local.kafka_arn}:topic/${local.cluster}/${topic}"]
      }] : [],
      length(each.value.groups) > 0 ? [{
        Sid      = "ConsumerGroups"
        Effect   = "Allow"
        Action   = ["kafka-cluster:AlterGroup", "kafka-cluster:DescribeGroup"]
        Resource = [for group in each.value.groups : "${local.kafka_arn}:group/${local.cluster}/${group}"]
      }] : [],
      length(each.value.transactional_ids) > 0 ? [{
        Sid      = "TransactionalIds"
        Effect   = "Allow"
        Action   = ["kafka-cluster:AlterTransactionalId", "kafka-cluster:DescribeTransactionalId"]
        Resource = [for id in each.value.transactional_ids : "${local.kafka_arn}:transactional-id/${local.cluster}/${id}"]
      }] : [],
    )
  })
}

resource "aws_iam_role_policy" "database" {
  for_each = local.database_users
  name     = "database"
  role     = aws_iam_role.task[each.key].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid      = "ConnectAsOwnUser"
      Effect   = "Allow"
      Action   = "rds-db:connect"
      Resource = "arn:aws:rds-db:${var.region}:${local.account}:dbuser:${aws_rds_cluster.ledger.cluster_resource_id}/${each.value}"
    }]
  })
}

resource "aws_iam_role_policy" "valkey" {
  name = "valkey"
  role = aws_iam_role.task["oms-api"].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid      = "ConnectAsOmsApi"
      Effect   = "Allow"
      Action   = "elasticache:Connect"
      Resource = [aws_elasticache_replication_group.limits.arn, aws_elasticache_user.oms_api.arn]
    }]
  })
}

# Creates and configures the two topics at deploy time; no service may.
resource "aws_iam_role" "kafka_admin" {
  name = "${local.name}-kafka-admin"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { AWS = "arn:aws:iam::${local.account}:role/${var.deploy_role_name}" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "kafka_admin" {
  name = "topics"
  role = aws_iam_role.kafka_admin.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "Connect"
        Effect   = "Allow"
        Action   = ["kafka-cluster:Connect", "kafka-cluster:DescribeCluster"]
        Resource = aws_msk_cluster.log.arn
      },
      {
        Sid    = "ManageTopics"
        Effect = "Allow"
        Action = [
          "kafka-cluster:CreateTopic", "kafka-cluster:DescribeTopic", "kafka-cluster:AlterTopic",
          "kafka-cluster:DescribeTopicDynamicConfiguration", "kafka-cluster:AlterTopicDynamicConfiguration",
        ]
        Resource = [for topic in ["orders.commands", "matcher.events"] : "${local.kafka_arn}:topic/${local.cluster}/${topic}"]
      },
    ]
  })
}
