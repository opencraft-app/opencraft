variable "region" {
  description = "Tencent Cloud region shared by the operations VPC and regional Actor fleet."
  type        = string
}

variable "terraform_state_bucket" {
  description = "Regional COS bucket containing the foundation and management Terraform states."
  type        = string
}

variable "foundation_state_prefix" {
  description = "COS prefix containing the regional foundation state."
  type        = string
  default     = "actor-fleet/foundation"
}

variable "management_state_prefix" {
  description = "COS prefix containing the regional management state."
  type        = string
  default     = "actor-fleet/management"
}

variable "operations_vpc_name" {
  description = "Exact name of the existing LightVela operations VPC."
  type        = string

  validation {
    condition     = length(trimspace(var.operations_vpc_name)) >= 3
    error_message = "operations_vpc_name must be an exact nonempty VPC name."
  }
}

variable "operations_vpc_cidr" {
  description = "Reviewed aggregate advertised by the operations VPC."
  type        = string

  validation {
    condition = (
      can(cidrhost(var.operations_vpc_cidr, 0)) &&
      can(regex("/(1[2-9]|2[0-9]|3[0-2])$", var.operations_vpc_cidr))
    )
    error_message = "operations_vpc_cidr must be valid IPv4 and no broader than /12."
  }
}

variable "route_table_name" {
  description = "Stable name of the fail-closed operations route table."
  type        = string
  default     = "actor-operations-only"
}
