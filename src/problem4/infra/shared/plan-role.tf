# Pull requests and main run plan tests: data source lookups only. The
# tests plan against an empty local state, so no state bucket access.
data "aws_iam_policy_document" "plan_trust" {
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
      values = [
        "repo:${var.github_repository}:pull_request",
        "repo:${var.github_repository}:ref:refs/heads/main",
      ]
    }
  }
}

resource "aws_iam_role" "plan" {
  name                 = "p4-github-plan"
  assume_role_policy   = data.aws_iam_policy_document.plan_trust.json
  max_session_duration = 3600
}

data "aws_iam_policy_document" "plan" {
  statement {
    sid = "ListLookups"
    actions = [
      "cloudfront:ListCachePolicies",
      "cloudfront:ListOriginRequestPolicies",
      "cloudfront:ListResponseHeadersPolicies",
      "ec2:DescribeAvailabilityZones",
      "ec2:DescribeManagedPrefixLists",
      "iam:ListOpenIDConnectProviders",
    ]
    resources = ["*"]
  }
  statement {
    sid = "ManagedCloudFrontPolicies"
    actions = [
      "cloudfront:GetCachePolicy",
      "cloudfront:GetOriginRequestPolicy",
      "cloudfront:GetResponseHeadersPolicy",
    ]
    resources = [
      "arn:aws:cloudfront::*:cache-policy/*",
      "arn:aws:cloudfront::*:origin-request-policy/*",
      "arn:aws:cloudfront::*:response-headers-policy/*",
    ]
  }
  statement {
    sid       = "CloudFrontPrefixList"
    actions   = ["ec2:GetManagedPrefixListEntries"]
    resources = ["arn:aws:ec2:${var.region}:*:prefix-list/*"]
  }
  statement {
    sid       = "BackendRepository"
    actions   = ["ecr:DescribeImages", "ecr:DescribeRepositories", "ecr:ListTagsForResource"]
    resources = [aws_ecr_repository.backend.arn]
  }
  statement {
    sid       = "GithubProvider"
    actions   = ["iam:GetOpenIDConnectProvider"]
    resources = [aws_iam_openid_connect_provider.github.arn]
  }
  statement {
    sid       = "LatestAmazonLinux"
    actions   = ["ssm:GetParameter"]
    resources = ["arn:aws:ssm:${var.region}::parameter/aws/service/ami-amazon-linux-latest/*"]
  }
  statement {
    sid       = "ArtifactBucketExists"
    actions   = ["s3:GetBucketLocation", "s3:ListBucket"]
    resources = [aws_s3_bucket.artifacts.arn]
  }
}

resource "aws_iam_role_policy" "plan" {
  name   = "plan"
  role   = aws_iam_role.plan.id
  policy = data.aws_iam_policy_document.plan.json
}
