terraform {
  required_version = ">= 1.10"
  required_providers {
    aws    = { source = "hashicorp/aws", version = "~> 6.73" }
    random = { source = "hashicorp/random", version = "~> 3.9" }
  }
  # bucket, key and region come from -backend-config; see the Makefile.
  backend "s3" {
    use_lockfile = true
    encrypt      = true
  }
}

provider "aws" {
  region = var.region
  default_tags {
    tags = { project = "p4-ship-it-twice", stack = "env-${var.environment}", managed-by = "terraform" }
  }
}
