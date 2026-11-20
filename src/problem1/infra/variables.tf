variable "region" {
  type    = string
  default = "ap-southeast-1"
}

variable "environment" {
  type = string
  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "environment must be staging or production."
  }
}

variable "vpc_cidr" {
  type = string
  validation {
    condition     = can(cidrsubnet(var.vpc_cidr, 4, 15)) && endswith(var.vpc_cidr, "/16")
    error_message = "vpc_cidr must be a /16; each subnet is a /20."
  }
}

variable "zone_ids" {
  description = "Availability Zone IDs used by every tier, such as apse1-az1; IDs, unlike names, mean the same zone in every account."
  type        = list(string)
  validation {
    condition     = contains([2, 3], length(distinct(var.zone_ids))) && length(distinct(var.zone_ids)) == length(var.zone_ids)
    error_message = "zone_ids must list two or three distinct zones."
  }
  validation {
    condition     = length(var.zone_ids) == 3 || var.environment != "production"
    error_message = "production must span three zones."
  }
}

variable "aurora" {
  type = object({ instance_class = string, instances = number, engine_version = string })
  validation {
    condition     = var.aurora.instances >= 1 && var.aurora.instances <= 3
    error_message = "aurora.instances is a writer plus up to two readers."
  }
}

variable "msk" {
  type = object({ instance_type = string, brokers = number, volume_gb = number, kafka_version = string })
  validation {
    condition     = var.msk.brokers % length(var.zone_ids) == 0
    error_message = "msk.brokers must be a multiple of the zone count; MSK spreads brokers evenly."
  }
}

variable "valkey" {
  type = object({ node_type = string, engine_version = string })
}

variable "allow_destroy" {
  description = "Drops deletion protection and final snapshots; for throwaway environments only."
  type        = bool
  default     = false
}

variable "deploy_role_name" {
  description = "IAM role that applies this stack; it alone manages keys and Kafka topics."
  type        = string
  default     = "p1-terraform-deploy"
}

variable "break_glass_role_name" {
  description = "Emergency role, used under two-person control; any use pages."
  type        = string
  default     = "break-glass"
}
