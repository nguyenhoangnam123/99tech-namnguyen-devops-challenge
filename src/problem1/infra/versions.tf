terraform {
  required_version = ">= 1.10"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 6.73" }
  }
  # Checked in CI against a mocked AWS and never applied: this stack
  # alone costs about $1,300 a month. bucket and key via -backend-config.
  backend "s3" {
    use_lockfile = true
    encrypt      = true
  }
}

provider "aws" {
  region = var.region
  default_tags {
    tags = { project = "p1-exchange", environment = var.environment, managed-by = "terraform" }
  }
}
