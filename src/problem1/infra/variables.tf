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

variable "zone_count" {
  description = "Availability Zones used by every tier."
  type        = number
  validation {
    condition     = contains([2, 3], var.zone_count)
    error_message = "zone_count must be 2 or 3."
  }
}

variable "nat_per_zone" {
  description = "One NAT gateway per zone, so losing a zone keeps egress in the others."
  type        = bool
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
    condition     = var.msk.brokers % var.zone_count == 0
    error_message = "msk.brokers must be a multiple of zone_count; MSK spreads brokers evenly."
  }
  validation {
    condition     = var.msk.brokers >= 3 || var.environment != "production"
    error_message = "production needs three brokers for replication factor 3."
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
