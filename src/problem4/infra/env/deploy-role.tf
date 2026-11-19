# Only a job running in this GitHub environment can assume this role,
# so production's required reviewers gate every production deploy.
data "aws_iam_openid_connect_provider" "github" {
  url = "https://token.actions.githubusercontent.com"
}

data "aws_s3_bucket" "artifacts" {
  bucket = "p4-artifacts-${data.aws_caller_identity.current.account_id}-${var.region}"
}

data "aws_iam_policy_document" "deploy_trust" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [data.aws_iam_openid_connect_provider.github.arn]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["${var.github_subject}:environment:${var.environment}"]
    }
  }
}

resource "aws_iam_role" "deploy" {
  name                 = "p4-github-deploy-${var.environment}"
  assume_role_policy   = data.aws_iam_policy_document.deploy_trust.json
  max_session_duration = 3600
}

locals {
  launch_template_arn = "arn:aws:ec2:${var.region}:${data.aws_caller_identity.current.account_id}:launch-template/${aws_launch_template.backend.id}"
}

data "aws_iam_policy_document" "deploy" {
  statement {
    sid     = "ReadDeployConfig"
    actions = ["ssm:GetParameter"]
    resources = [
      aws_ssm_parameter.deploy.arn,
      aws_ssm_parameter.image_tag.arn,
    ]
  }
  statement {
    sid       = "RecordLiveImage"
    actions   = ["ssm:PutParameter"]
    resources = [aws_ssm_parameter.image_tag.arn]
  }
  statement {
    sid       = "CheckImageExists"
    actions   = ["ecr:DescribeImages"]
    resources = [data.aws_ecr_repository.backend.arn]
  }
  statement {
    sid = "Describe"
    actions = [
      "autoscaling:DescribeAutoScalingGroups",
      "autoscaling:DescribeInstanceRefreshes",
      "autoscaling:DescribeScalingActivities",
      "ec2:DescribeLaunchTemplateVersions",
      "ec2:DescribeLaunchTemplates",
    ]
    resources = ["*"]
  }
  statement {
    sid       = "NewTemplateVersion"
    actions   = ["ec2:CreateLaunchTemplateVersion"]
    resources = [local.launch_template_arn]
  }
  statement {
    sid = "RollInstances"
    actions = [
      "autoscaling:CancelInstanceRefresh",
      "autoscaling:RollbackInstanceRefresh",
      "autoscaling:StartInstanceRefresh",
    ]
    resources = [aws_autoscaling_group.backend.arn]
  }
  # Pointing the group at a template version is checked as if the
  # caller launched it: RunInstances, CreateTags and PassRole.
  statement {
    sid       = "LaunchFromTemplate"
    actions   = ["ec2:RunInstances", "ec2:CreateTags"]
    resources = ["*"]
    condition {
      test     = "ArnEquals"
      variable = "ec2:LaunchTemplate"
      values   = [local.launch_template_arn]
    }
  }
  statement {
    sid       = "PassInstanceRole"
    actions   = ["iam:PassRole"]
    resources = [aws_iam_role.backend_instance.arn]
    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["ec2.amazonaws.com"]
    }
  }
  # Auto Scaling checks rollback alarms with DescribeAlarms on alarm:*,
  # not on the two alarms the refresh names.
  statement {
    sid       = "RollbackAlarms"
    actions   = ["cloudwatch:DescribeAlarms"]
    resources = ["arn:aws:cloudwatch:${var.region}:${data.aws_caller_identity.current.account_id}:alarm:*"]
  }
  statement {
    sid       = "ReadFrontendBuilds"
    actions   = ["s3:GetObject"]
    resources = ["${data.aws_s3_bucket.artifacts.arn}/frontend/*"]
  }
  statement {
    sid       = "ListFrontendBuilds"
    actions   = ["s3:ListBucket"]
    resources = [data.aws_s3_bucket.artifacts.arn]
    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["frontend/*"]
    }
  }
  statement {
    sid       = "PublishSite"
    actions   = ["s3:ListBucket", "s3:PutObject"]
    resources = [aws_s3_bucket.site.arn, "${aws_s3_bucket.site.arn}/*"]
  }
  statement {
    sid       = "Invalidate"
    actions   = ["cloudfront:CreateInvalidation", "cloudfront:GetInvalidation"]
    resources = [aws_cloudfront_distribution.site.arn]
  }
}

resource "aws_iam_role_policy" "deploy" {
  name   = "deploy"
  role   = aws_iam_role.deploy.id
  policy = data.aws_iam_policy_document.deploy.json
}

# Everything the deploy scripts look up, in one parameter.
resource "aws_ssm_parameter" "deploy" {
  name = "/p4/${var.environment}/deploy"
  type = "String"
  value = jsonencode({
    region              = var.region
    autoscaling_group   = aws_autoscaling_group.backend.name
    launch_template_id  = aws_launch_template.backend.id
    rollback_alarms     = [aws_cloudwatch_metric_alarm.backend_5xx.alarm_name, aws_cloudwatch_metric_alarm.backend_unhealthy.alarm_name]
    image_tag_parameter = aws_ssm_parameter.image_tag.name
    ecr_repository      = data.aws_ecr_repository.backend.name
    artifact_bucket     = data.aws_s3_bucket.artifacts.id
    site_bucket         = aws_s3_bucket.site.id
    distribution_id     = aws_cloudfront_distribution.site.id
    url                 = "https://${aws_cloudfront_distribution.site.domain_name}"
  })
}
