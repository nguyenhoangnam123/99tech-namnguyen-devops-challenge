# Builds on main push one image and one frontend bundle per commit.
# Pull requests and other branches get no AWS access at all.
data "aws_iam_policy_document" "build_trust" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github.arn]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${var.github_repository}:ref:refs/heads/main"]
    }
  }
}

resource "aws_iam_role" "build" {
  name                 = "p4-github-build"
  assume_role_policy   = data.aws_iam_policy_document.build_trust.json
  max_session_duration = 3600
}

data "aws_iam_policy_document" "build" {
  statement {
    sid       = "RegistryLogin"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }
  statement {
    sid = "PushBackendImage"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:BatchGetImage",
      "ecr:CompleteLayerUpload",
      "ecr:DescribeImages",
      "ecr:InitiateLayerUpload",
      "ecr:PutImage",
      "ecr:UploadLayerPart",
    ]
    resources = [aws_ecr_repository.backend.arn]
  }
  statement {
    sid       = "ListFrontendBuilds"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.artifacts.arn]
    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["frontend/*"]
    }
  }
  statement {
    sid       = "UploadFrontendBuild"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.artifacts.arn}/frontend/*"]
  }
  statement {
    sid       = "ReadBuildConfig"
    actions   = ["ssm:GetParameter"]
    resources = [aws_ssm_parameter.build.arn]
  }
}

resource "aws_iam_role_policy" "build" {
  name   = "build"
  role   = aws_iam_role.build.id
  policy = data.aws_iam_policy_document.build.json
}
