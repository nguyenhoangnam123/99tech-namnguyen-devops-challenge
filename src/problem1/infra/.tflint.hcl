plugin "terraform" {
  enabled = true
  preset  = "recommended"
}

# Checks instance types and engine values, which matters for code that
# CI tests but never applies.
plugin "aws" {
  enabled = true
  version = "0.50.0"
  source  = "github.com/terraform-linters/tflint-ruleset-aws"
}
