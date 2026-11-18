variable "region" {
  type    = string
  default = "ap-southeast-1"
}

variable "github_repository" {
  description = "owner/name of the repository whose workflows may assume the roles."
  type        = string
  default     = "nguyenhoangnam123/99tech-namnguyen-devops-challenge"
}

variable "allow_destroy" {
  description = "Let destroy empty the artifact bucket. Off outside test accounts."
  type        = bool
  default     = false
}
