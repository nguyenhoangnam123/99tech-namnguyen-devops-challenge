# Daily ledger backups in a vault that nobody, including the account
# root, can shorten or empty once the lock's grace period ends.
resource "aws_backup_vault" "ledger" {
  name          = "${local.name}-ledger"
  kms_key_arn   = aws_kms_key.data["ledger"].arn
  force_destroy = var.allow_destroy
}

resource "aws_backup_vault_lock_configuration" "ledger" {
  count               = var.allow_destroy ? 0 : 1
  backup_vault_name   = aws_backup_vault.ledger.name
  min_retention_days  = 35
  max_retention_days  = 400
  changeable_for_days = 3
}

resource "aws_backup_plan" "ledger" {
  name = "${local.name}-ledger"
  rule {
    rule_name         = "daily"
    target_vault_name = aws_backup_vault.ledger.name
    schedule          = "cron(0 18 * * ? *)"
    lifecycle {
      delete_after = 35
    }
  }
}

resource "aws_iam_role" "backup" {
  name = "${local.name}-backup"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "backup.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "backup" {
  role       = aws_iam_role.backup.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForBackup"
}

resource "aws_backup_selection" "ledger" {
  name         = "${local.name}-ledger"
  plan_id      = aws_backup_plan.ledger.id
  iam_role_arn = aws_iam_role.backup.arn
  resources    = [aws_rds_cluster.ledger.arn]
}
