output "deploy_role_arn" {
  value = aws_iam_role.deploy.arn
}

output "url" {
  value = "https://${aws_cloudfront_distribution.site.domain_name}"
}
