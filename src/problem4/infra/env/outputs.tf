output "deploy_role_arn" {
  value = aws_iam_role.deploy.arn
}

output "url" {
  value = "https://${aws_cloudfront_distribution.site.domain_name}"
}

output "alb_dns_name" {
  value = aws_lb.backend.dns_name
}
