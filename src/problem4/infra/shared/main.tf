# Shared by both environments: GitHub's identity provider, the image
# registry and the artifact bucket. Builds publish here exactly once.
data "aws_caller_identity" "current" {}

locals {
  account = data.aws_caller_identity.current.account_id
}

resource "aws_iam_openid_connect_provider" "github" {
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
}

resource "aws_ecr_repository" "backend" {
  name                 = "p4-backend"
  image_tag_mutability = "IMMUTABLE"
  force_delete         = var.allow_destroy
  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_ecr_lifecycle_policy" "backend" {
  repository = aws_ecr_repository.backend.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep the last 50 releases for rollback"
      selection    = { tagStatus = "any", countType = "imageCountMoreThan", countNumber = 50 }
      action       = { type = "expire" }
    }]
  })
}

resource "aws_s3_bucket" "artifacts" {
  bucket        = "p4-artifacts-${local.account}-${var.region}"
  force_destroy = var.allow_destroy
}

resource "aws_s3_bucket_versioning" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_public_access_block" "artifacts" {
  bucket                  = aws_s3_bucket.artifacts.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id
  rule {
    id     = "expire-old-builds"
    status = "Enabled"
    filter { prefix = "frontend/" }
    expiration { days = 180 }
    noncurrent_version_expiration { noncurrent_days = 30 }
  }
  rule {
    id     = "abort-failed-uploads"
    status = "Enabled"
    filter {}
    abort_incomplete_multipart_upload { days_after_initiation = 7 }
  }
}

# What pipelines need to know, published where their roles can read it.
resource "aws_ssm_parameter" "build" {
  name = "/p4/shared/build"
  type = "String"
  value = jsonencode({
    ecr_repository  = aws_ecr_repository.backend.repository_url
    artifact_bucket = aws_s3_bucket.artifacts.id
  })
}
