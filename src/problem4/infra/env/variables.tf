variable "environment" {
  type = string
  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "environment must be staging or production."
  }
}

variable "region" {
  type    = string
  default = "ap-southeast-1"
}

variable "github_repository" {
  type    = string
  default = "nguyenhoangnam123/99tech-namnguyen-devops-challenge"
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
