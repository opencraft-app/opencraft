variable "management_id" {
  description = "Stable regional management-cluster identity."
  type        = string
  default     = "actor-bj-c01"

  validation {
    condition     = can(regex("^actor-[a-z]{2}-c[0-9]{2}$", var.management_id))
    error_message = "management_id must match actor-<region-code>-c<ordinal>."
  }
}

variable "region" {
  type    = string
  default = "ap-beijing"
}

variable "availability_mode" {
  description = "Failure-domain contract. qualification-single-zone is explicit non-production evidence for regions exposing only one AZ."
  type        = string
  default     = "production-multi-zone"

  validation {
    condition     = contains(["production-multi-zone", "qualification-single-zone"], var.availability_mode)
    error_message = "availability_mode must be production-multi-zone or qualification-single-zone."
  }
}

variable "terraform_state_bucket" {
  description = "Versioned COS bucket created by bootstrap-state."
  type        = string
}

variable "account_app_id" {
  description = "Tencent account AppId used only to make the private bootstrap relay bucket globally unique."
  type        = string

  validation {
    condition     = can(regex("^[0-9]{10}$", var.account_app_id))
    error_message = "account_app_id must be the 10-digit Tencent COS AppId."
  }
}

variable "foundation_state_prefix" {
  description = "COS backend prefix containing the regional foundation state."
  type        = string
  default     = "actor-fleet/foundation"
}

variable "vpc_cidr" {
  type = string

  validation {
    condition     = can(cidrhost(var.vpc_cidr, 0))
    error_message = "vpc_cidr must be a valid CIDR."
  }
}

variable "regional_vpc_aggregate" {
  description = "Reviewed regional aggregate from network/ccn-plan.yaml."
  type        = string
  default     = "10.160.0.0/12"

  validation {
    condition     = can(cidrhost(var.regional_vpc_aggregate, 0))
    error_message = "regional_vpc_aggregate must be a valid CIDR."
  }
}

variable "reserved_cidrs" {
  description = "Existing corporate, VPC, VPN, Docker, Pod and Service ranges that this cluster must not overlap."
  type        = set(string)

  validation {
    condition     = alltrue([for cidr in var.reserved_cidrs : can(cidrhost(cidr, 0))])
    error_message = "reserved_cidrs must contain only valid CIDRs."
  }
}

variable "subnets" {
  description = "Exactly three management subnets keyed by stable logical names."
  type = map(object({
    availability_zone = string
    cidr_block        = string
  }))

  validation {
    condition = (
      length(var.subnets) == 3 &&
      length(distinct([for subnet in values(var.subnets) : subnet.cidr_block])) == 3 &&
      alltrue([for subnet in values(var.subnets) : can(cidrhost(subnet.cidr_block, 0))])
    )
    error_message = "subnets must contain three valid, distinct CIDRs."
  }
}

variable "bootstrap_subnet_key" {
  type    = string
  default = "z1"
}

variable "cluster_pod_cidr" {
  type = string

  validation {
    condition     = can(cidrhost(var.cluster_pod_cidr, 0))
    error_message = "cluster_pod_cidr must be a valid CIDR."
  }
}

variable "cluster_service_cidr" {
  type = string

  validation {
    condition     = can(cidrhost(var.cluster_service_cidr, 0))
    error_message = "cluster_service_cidr must be a valid CIDR."
  }
}

variable "trusted_api_cidrs" {
  description = "Reviewed operator CIDRs allowed to reach the private management TKE API."
  type        = set(string)
  default     = []

  validation {
    condition     = alltrue([for cidr in var.trusted_api_cidrs : can(cidrhost(cidr, 0))])
    error_message = "trusted_api_cidrs must contain only valid CIDRs."
  }
}

variable "trusted_workers_api_cidrs" {
  description = "Additional reviewed source CIDRs allowed to reach the private Workers API CLB; the management VPC is always included."
  type        = set(string)
  default     = []

  validation {
    condition = alltrue([
      for cidr in var.trusted_workers_api_cidrs :
      can(cidrhost(cidr, 0)) && can(regex("/(1[2-9]|2[0-9]|3[0-2])$", cidr))
    ])
    error_message = "trusted_workers_api_cidrs must contain valid IPv4 CIDRs no broader than /12."
  }
}

variable "cluster_version" {
  description = "Explicit TKE version reviewed at plan time."
  type        = string
}

variable "cluster_level" {
  type    = string
  default = "L20"
}

variable "network_policy_addon_version" {
  description = "Reviewed TKE NetworkPolicy controller addon version installed before platform bootstrap."
  type        = string
  default     = "1.0.6"

  validation {
    condition     = can(regex("^[0-9]+\\.[0-9]+\\.[0-9]+$", var.network_policy_addon_version))
    error_message = "network_policy_addon_version must be an explicit semantic version."
  }
}

variable "cluster_os" {
  type    = string
  default = "tlinux3.1x86_64"
}

variable "node_image_name_regex" {
  description = "Anchored exact-name selector for one reviewed public node image."
  type        = string

  validation {
    condition     = startswith(var.node_image_name_regex, "^") && endswith(var.node_image_name_regex, "$")
    error_message = "node_image_name_regex must be anchored at both ends."
  }
}

variable "bootstrap_instance_type" {
  type    = string
  default = "SA9.LARGE8"
}

variable "runtime_builder_instance_type" {
  description = "Dedicated build CVM, never attached to TKE. Independent of control-plane capacity."
  type        = string
  default     = "SA9.4XLARGE32"

  validation {
    condition     = can(regex("^[A-Za-z0-9]+\\.[A-Za-z0-9]+$", var.runtime_builder_instance_type))
    error_message = "runtime_builder_instance_type must be an explicit CVM type."
  }
}

variable "runtime_builder_data_disk_gib" {
  description = "Disposable build CBS capacity. This envelope is not a measured full-V8 build peak or a runtime quota."
  type        = number
  default     = 512

  validation {
    condition = (
      var.runtime_builder_data_disk_gib >= 256 &&
      var.runtime_builder_data_disk_gib <= 4096 &&
      var.runtime_builder_data_disk_gib == floor(var.runtime_builder_data_disk_gib)
    )
    error_message = "runtime_builder_data_disk_gib must be an integer between 256 and 4096."
  }
}

variable "ssh_public_key" {
  description = "Operator-owned public key; the private half never enters Terraform state."
  type        = string
  sensitive   = true

  validation {
    condition     = can(regex("^(ssh-(rsa|ed25519)|ecdsa-sha2-nistp(256|384|521)) [A-Za-z0-9+/=]+(?: .*)?$", trimspace(var.ssh_public_key)))
    error_message = "ssh_public_key must be an OpenSSH public key."
  }
}

variable "deletion_protection" {
  description = "Protect management TKE and bootstrap CVM from ordinary destroy."
  type        = bool
  default     = true
}

variable "tags" {
  type    = map(string)
  default = {}
}
