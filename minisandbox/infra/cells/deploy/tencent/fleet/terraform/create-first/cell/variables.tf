variable "cell_id" {
  description = "Stable Cell identity, for example actor-bj-k02."
  type        = string

  validation {
    condition     = can(regex("^actor-[a-z]{2}-[a-z][0-9]{2}$", var.cell_id))
    error_message = "cell_id must match actor-<region-code>-<class><ordinal>."
  }
}

variable "region" {
  type    = string
  default = "ap-beijing"
}

variable "availability_mode" {
  description = "Failure-domain contract. qualification-single-zone can never produce production topology evidence."
  type        = string
  default     = "production-multi-zone"

  validation {
    condition     = contains(["production-multi-zone", "qualification-single-zone"], var.availability_mode)
    error_message = "availability_mode must be production-multi-zone or qualification-single-zone."
  }
}

variable "environment" {
  description = "Bucket and tag environment component."
  type        = string
  default     = "prod"

  validation {
    condition     = contains(["prod", "qual"], var.environment)
    error_message = "environment must be prod or qual."
  }
}

variable "fleet_binding" {
  description = "Immutable management-plane request authorizing this exact Cell plan."
  type = object({
    pool_name       = string
    pool_uid        = string
    claim_name      = string
    claim_uid       = string
    class_name      = string
    datacenter_name = string
    scale_out_epoch = number
    profile_digest  = string
  })

  validation {
    condition = (
      can(regex("^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$", var.fleet_binding.pool_name)) &&
      can(regex("^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$", var.fleet_binding.claim_name)) &&
      can(regex("^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$", var.fleet_binding.class_name)) &&
      var.fleet_binding.datacenter_name == "default" &&
      length(var.fleet_binding.pool_uid) >= 8 &&
      length(var.fleet_binding.claim_uid) >= 8 &&
      var.fleet_binding.scale_out_epoch >= 0 &&
      floor(var.fleet_binding.scale_out_epoch) == var.fleet_binding.scale_out_epoch &&
      can(regex("^sha256:[0-9a-f]{64}$", var.fleet_binding.profile_digest))
    )
    error_message = "fleet_binding must contain valid immutable Pool/Claim identities, the per-Cell Engine datacenter 'default', a non-negative integral epoch, and profile digest."
  }
}

variable "account_app_id" {
  description = "Tencent account AppId used only to derive globally unique COS bucket names."
  type        = string

  validation {
    condition     = can(regex("^[0-9]{6,20}$", var.account_app_id))
    error_message = "account_app_id must be the numeric Tencent AppId."
  }
}

variable "storage_identity_mode" {
  description = "Storage credential owner: independent per-Cell CAM users or an externally injected shared root credential."
  type        = string
  default     = "dedicated-users"

  validation {
    condition     = contains(["dedicated-users", "shared-root"], var.storage_identity_mode)
    error_message = "storage_identity_mode must be dedicated-users or shared-root."
  }
}

variable "terraform_state_bucket" {
  description = "Versioned COS bucket created by bootstrap-state."
  type        = string
}

variable "foundation_state_prefix" {
  description = "COS backend prefix containing the regional foundation state."
  type        = string
  default     = "actor-fleet/foundation"
}

variable "management_state_prefix" {
  description = "COS backend prefix containing the regional management-cluster state."
  type        = string
  default     = "actor-fleet/management"
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
  description = "Existing corporate, VPC, VPN, Docker, Pod and Service ranges that this Cell must not overlap."
  type        = set(string)

  validation {
    condition     = alltrue([for cidr in var.reserved_cidrs : can(cidrhost(cidr, 0))])
    error_message = "reserved_cidrs must contain only valid CIDRs."
  }
}

variable "subnets" {
  description = "Exactly three Cell subnets keyed by a stable logical name."
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
  description = "Logical subnet key used by the private API endpoint, TCR attachment and bootstrap worker."
  type        = string
  default     = "z1"
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
  description = "Additional operator CIDRs allowed to reach the private TKE API; management VPC ingress is derived from management state."
  type        = set(string)
  default     = []

  validation {
    condition     = alltrue([for cidr in var.trusted_api_cidrs : can(cidrhost(cidr, 0))])
    error_message = "trusted_api_cidrs must contain only valid CIDRs."
  }
}

variable "cluster_version" {
  description = "Explicit TKE version reviewed at plan time; never inherited from an old Cell."
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
  description = "Reviewed anchored regex selecting exactly one current public node image instead of retaining an old image ID."
  type        = string

  validation {
    condition     = startswith(var.node_image_name_regex, "^") && endswith(var.node_image_name_regex, "$")
    error_message = "node_image_name_regex must be anchored at both ends so a later image cannot silently match."
  }
}

variable "bootstrap_instance_type" {
  type    = string
  default = "SA9.LARGE8"
}

variable "stateless_node_pool" {
  description = "Terraform-owned official TKE Native NodePool used by Cluster Autoscaler."
  type = object({
    instance_types = list(string)
    replicas       = number
    min_replicas   = number
    max_replicas   = number
  })

  validation {
    condition = (
      length(var.stateless_node_pool.instance_types) > 0 &&
      alltrue([for value in var.stateless_node_pool.instance_types : length(value) > 0]) &&
      var.stateless_node_pool.min_replicas >= 1 &&
      var.stateless_node_pool.min_replicas <= var.stateless_node_pool.replicas &&
      var.stateless_node_pool.replicas <= var.stateless_node_pool.max_replicas &&
      floor(var.stateless_node_pool.min_replicas) == var.stateless_node_pool.min_replicas &&
      floor(var.stateless_node_pool.replicas) == var.stateless_node_pool.replicas &&
      floor(var.stateless_node_pool.max_replicas) == var.stateless_node_pool.max_replicas
    )
    error_message = "stateless_node_pool must contain instance types and integral min <= replicas <= max capacity."
  }
}

variable "cluster_autoscaler_addon_version" {
  description = "Reviewed TKE cluster-autoscaler addon version whose values are owned by Terraform."
  type        = string
  default     = "2.1.11"

  validation {
    condition     = can(regex("^[0-9]+\\.[0-9]+\\.[0-9]+$", var.cluster_autoscaler_addon_version))
    error_message = "cluster_autoscaler_addon_version must be an explicit semantic version."
  }
}

variable "cluster_autoscaler_max_nodes_total" {
  description = "Cell-wide CA safety ceiling. This must exceed the fixed and elastic pool envelope; TKE's default of 20 is not production-safe."
  type        = number
  default     = 1024

  validation {
    condition = (
      floor(var.cluster_autoscaler_max_nodes_total) == var.cluster_autoscaler_max_nodes_total &&
      var.cluster_autoscaler_max_nodes_total >= 64 &&
      var.cluster_autoscaler_max_nodes_total <= 4096
    )
    error_message = "cluster_autoscaler_max_nodes_total must be an integer between 64 and 4096."
  }
}

variable "ssh_public_key" {
  description = "Operator-owned public key. Terraform never generates or stores the private key."
  type        = string
  sensitive   = true

  validation {
    condition     = can(regex("^(ssh-(rsa|ed25519)|ecdsa-sha2-nistp(256|384|521)) [A-Za-z0-9+/=]+(?: .*)?$", trimspace(var.ssh_public_key)))
    error_message = "ssh_public_key must be an OpenSSH public key."
  }
}

variable "deletion_protection" {
  description = "Protect the TKE control plane and bootstrap CVM until an explicitly reviewed teardown."
  type        = bool
  default     = true
}

variable "tags" {
  type    = map(string)
  default = {}
}
