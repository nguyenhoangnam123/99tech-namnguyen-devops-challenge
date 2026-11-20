# One key per data class, so a key policy, a grant or a CloudTrail search
# covers exactly one kind of data. Administered by the account, not a user.
locals {
  account    = data.aws_caller_identity.current.account_id
  key_admins = [var.deploy_role_name, var.break_glass_role_name]
  keys = {
    ledger = "Aurora storage, Performance Insights, backups"
    stream = "MSK and Valkey at rest"
    logs   = "CloudWatch log groups, including flow and audit logs"
  }
}

data "aws_caller_identity" "current" {}

resource "aws_kms_key" "data" {
  for_each                = local.keys
  description             = "${local.name} ${each.key}: ${each.value}"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat(
      [{
        Sid       = "AccountAdministers"
        Effect    = "Allow"
        Principal = { AWS = "arn:aws:iam::${local.account}:root" }
        Action    = "kms:*"
        Resource  = "*"
        }, {
        # Deleting or disabling a key would make the locked backups
        # unreadable; only break-glass and the deploy role may.
        Sid       = "OnlyKeyAdminsMayDestroy"
        Effect    = "Deny"
        Principal = { AWS = "*" }
        Action    = ["kms:ScheduleKeyDeletion", "kms:DisableKey", "kms:PutKeyPolicy"]
        Resource  = "*"
        Condition = {
          ArnNotEquals = { "aws:PrincipalArn" = [for role in local.key_admins : "arn:aws:iam::${local.account}:role/${role}"] }
        }
      }],
      each.key == "logs" ? [{
        Sid       = "CloudWatchLogsInThisAccount"
        Effect    = "Allow"
        Principal = { Service = "logs.${var.region}.amazonaws.com" }
        Action    = ["kms:Encrypt", "kms:Decrypt", "kms:ReEncrypt*", "kms:GenerateDataKey*", "kms:Describe*"]
        Resource  = "*"
        Condition = {
          ArnLike = { "kms:EncryptionContext:aws:logs:arn" = "arn:aws:logs:${var.region}:${local.account}:log-group:*" }
        }
      }] : []
    )
  })
}

resource "aws_kms_alias" "data" {
  for_each      = local.keys
  name          = "alias/${local.name}-${each.key}"
  target_key_id = aws_kms_key.data[each.key].key_id
}
