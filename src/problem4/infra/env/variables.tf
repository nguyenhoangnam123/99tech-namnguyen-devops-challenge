variable "environment" {
  type = string
  validation {
    condition     = can(regex("^(staging|production|e2e-[a-z0-9]{4,8})$", var.environment))
    error_message = "environment must be staging, production, or e2e-<id> for tests."
  }
}

variable "region" {
  type    = string
  default = "ap-southeast-1"
}

variable "github_subject" {
  description = "OIDC subject prefix in GitHub's immutable owner@id/name@id form; see actions/oidc/customization/sub."
  type        = string
  default     = "repo:nguyenhoangnam123@26792601/99tech-namnguyen-devops-challenge@1461258321"
}

variable "vpc_cidr" {
  type = string
}

variable "instance_type" {
  type    = string
  default = "t3.micro"
}

variable "instances" {
  description = "Desired backend instances; a deploy briefly runs up to twice this."
  type        = object({ min = number, desired = number, max = number })
}

variable "first_image_tag" {
  description = "Image the very first apply boots. Deploys own the tag after that."
  type        = string
}

variable "allow_destroy" {
  description = "Let destroy empty the site bucket. Off outside test accounts."
  type        = bool
  default     = false
}
