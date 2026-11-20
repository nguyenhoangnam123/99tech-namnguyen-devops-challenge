resource "aws_db_subnet_group" "ledger" {
  name       = "${local.name}-ledger"
  subnet_ids = [for subnet in aws_subnet.isolated : subnet.id]
}

resource "aws_rds_cluster_parameter_group" "ledger" {
  name   = "${local.name}-ledger"
  family = "aurora-postgresql${split(".", var.aurora.engine_version)[0]}"
  # Clients must use TLS; DATABASE_URL sets sslmode=verify-full.
  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }
  # Audit trail: every schema and role change, plus slow statements.
  parameter {
    name         = "shared_preload_libraries"
    value        = "pg_stat_statements,pgaudit"
    apply_method = "pending-reboot"
  }
  parameter {
    name  = "pgaudit.log"
    value = "ddl,role"
  }
  parameter {
    name  = "log_statement"
    value = "ddl"
  }
  parameter {
    name  = "log_min_duration_statement"
    value = "1000"
  }
}

# Created here so the audit log is encrypted and kept a year; RDS would
# otherwise create it unencrypted and keep it forever.
resource "aws_cloudwatch_log_group" "ledger" {
  name              = "/aws/rds/cluster/${local.name}-ledger/postgresql"
  retention_in_days = 365
  kms_key_id        = aws_kms_key.data["logs"].arn
}

resource "aws_rds_cluster" "ledger" {
  cluster_identifier                  = "${local.name}-ledger"
  engine                              = "aurora-postgresql"
  engine_version                      = var.aurora.engine_version
  database_name                       = "exchange"
  master_username                     = "exchange_admin"
  manage_master_user_password         = true
  master_user_secret_kms_key_id       = aws_kms_key.data["ledger"].arn
  iam_database_authentication_enabled = true
  db_subnet_group_name                = aws_db_subnet_group.ledger.name
  vpc_security_group_ids              = [aws_security_group.store["aurora"].id]
  db_cluster_parameter_group_name     = aws_rds_cluster_parameter_group.ledger.name
  storage_encrypted                   = true
  kms_key_id                          = aws_kms_key.data["ledger"].arn
  backup_retention_period             = 7
  preferred_backup_window             = "18:00-19:00"
  preferred_maintenance_window        = "sun:19:00-sun:20:00"
  copy_tags_to_snapshot               = true
  enabled_cloudwatch_logs_exports     = ["postgresql"]
  deletion_protection                 = !var.allow_destroy
  skip_final_snapshot                 = var.allow_destroy
  final_snapshot_identifier           = var.allow_destroy ? null : "${local.name}-ledger-final"
  depends_on                          = [aws_cloudwatch_log_group.ledger]
}

# The writer and each reader sit in different zones; a reader is promoted
# when the writer's zone fails.
resource "aws_rds_cluster_instance" "ledger" {
  count                           = var.aurora.instances
  identifier                      = "${local.name}-ledger-${count.index}"
  cluster_identifier              = aws_rds_cluster.ledger.id
  engine                          = aws_rds_cluster.ledger.engine
  engine_version                  = aws_rds_cluster.ledger.engine_version
  instance_class                  = var.aurora.instance_class
  availability_zone               = keys(local.zones)[count.index % var.zone_count]
  publicly_accessible             = false
  auto_minor_version_upgrade      = true
  performance_insights_enabled    = true
  performance_insights_kms_key_id = aws_kms_key.data["ledger"].arn
  monitoring_interval             = 15
  monitoring_role_arn             = aws_iam_role.rds_monitoring.arn
  promotion_tier                  = count.index
}

# Enhanced monitoring: per-process CPU and memory, which Performance
# Insights does not show.
resource "aws_iam_role" "rds_monitoring" {
  name = "${local.name}-rds-monitoring"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "monitoring.rds.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "rds_monitoring" {
  role       = aws_iam_role.rds_monitoring.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonRDSEnhancedMonitoringRole"
}
