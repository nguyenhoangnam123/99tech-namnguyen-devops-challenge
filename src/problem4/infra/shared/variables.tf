variable "region" {
  type    = string
  default = "ap-southeast-1"
}

variable "github_subject" {
  description = "OIDC subject prefix in GitHub's immutable owner@id/name@id form; see actions/oidc/customization/sub."
  type        = string
  default     = "repo:nguyenhoangnam123@26792601/99tech-namnguyen-devops-challenge@1461258321"
}

variable "allow_destroy" {
  description = "Let destroy empty the artifact bucket. Off outside test accounts."
  type        = bool
  default     = false
}
