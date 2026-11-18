output "build_role_arn" {
  value = aws_iam_role.build.arn
}

output "ecr_repository_url" {
  value = aws_ecr_repository.backend.repository_url
}

output "artifact_bucket" {
  value = aws_s3_bucket.artifacts.id
}
