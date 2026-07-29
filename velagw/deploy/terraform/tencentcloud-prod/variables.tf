variable "tencentcloud_secret_id" {
  description = "TencentCloud SecretId. Prefer env TENCENTCLOUD_SECRET_ID or TF_VAR_tencentcloud_secret_id."
  type        = string
  default     = null
  sensitive   = true
}

variable "tencentcloud_secret_key" {
  description = "TencentCloud SecretKey. Prefer env TENCENTCLOUD_SECRET_KEY or TF_VAR_tencentcloud_secret_key."
  type        = string
  default     = null
  sensitive   = true
}

variable "region" {
  description = "Production region."
  type        = string

  validation {
    condition     = can(regex("^ap-[a-z0-9-]+$", var.region))
    error_message = "region must be an explicit TencentCloud region such as ap-beijing or ap-shanghai."
  }
}

variable "region_alias" {
  description = "Short stable region alias used in resource names. Keep existing aliases unchanged to avoid resource replacement."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{0,7}$", var.region_alias))
    error_message = "region_alias must be 1-8 lowercase letters, digits, or hyphens and start with a letter."
  }
}

variable "project" {
  description = "Name prefix for all resources."
  type        = string
  default     = "llmgateway"
}

variable "environment" {
  description = "Environment tag."
  type        = string
  default     = "prod"
}

variable "availability_zones" {
  description = "Zones used by subnets, TKE node pools, CDB, and Redis. Keep at least two zones in the selected region."
  type        = list(string)

  validation {
    condition     = length(var.availability_zones) >= 2 && alltrue([for zone in var.availability_zones : trimspace(zone) != ""])
    error_message = "availability_zones must contain at least two non-empty zones."
  }
}

variable "vpc_cidr" {
  description = "New production VPC CIDR."
  type        = string
  default     = "10.64.0.0/16"
}

variable "public_subnet_cidrs" {
  description = "Public edge/NAT subnet CIDRs. Same length as availability_zones."
  type        = list(string)
  default     = ["10.64.0.0/24", "10.64.1.0/24"]
}

variable "app_subnet_cidrs" {
  description = "Private TKE node/pod subnet CIDRs. Same length as availability_zones."
  type        = list(string)
  default     = ["10.64.10.0/23", "10.64.12.0/23"]
}

variable "data_subnet_cidrs" {
  description = "Private database subnet CIDRs. Same length as availability_zones."
  type        = list(string)
  default     = ["10.64.20.0/24", "10.64.21.0/24"]
}

variable "admin_cidrs" {
  description = "CIDRs allowed to access control-plane ingress and optional SSH. Keep this narrow in production."
  type        = list(string)
  default     = []
}

variable "traffic_backend_cidrs" {
  description = "Client source CIDRs allowed to reach traffic Pods through CLB direct-access. CLB-to-Pod keeps the original client source IP."
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "traffic_backend_port" {
  description = "Pod port exposed by llmgateway-traffic behind the CLB."
  type        = string
  default     = "18080"
}

variable "nat_eip_bandwidth" {
  description = "Egress public bandwidth in Mbps."
  type        = number
  default     = 100

  validation {
    condition     = var.nat_eip_bandwidth >= 1 && var.nat_eip_bandwidth <= 100
    error_message = "nat_eip_bandwidth must be between 1 and 100 Mbps."
  }
}

variable "egress_gateway_mode" {
  description = "Private-subnet egress implementation: managed_nat, nat_instance, or disabled."
  type        = string
  default     = "managed_nat"

  validation {
    condition     = contains(["managed_nat", "nat_instance", "disabled"], var.egress_gateway_mode)
    error_message = "egress_gateway_mode must be managed_nat, nat_instance, or disabled."
  }
}

variable "nat_instance_image_id" {
  description = "Regional Linux image used by NAT instances when egress_gateway_mode is nat_instance."
  type        = string
  default     = ""
}

variable "nat_instance_type" {
  description = "CVM instance type used by each same-zone NAT instance."
  type        = string
  default     = "SA9.MEDIUM2"
}

variable "nat_instance_key_ids" {
  description = "Existing TencentCloud SSH key IDs attached to NAT instances."
  type        = list(string)
  default     = []
}

variable "nat_instance_admin_cidrs" {
  description = "CIDRs allowed to SSH to NAT instances for restricted operations."
  type        = list(string)
  default     = []
}

variable "nat_instance_system_disk_type" {
  description = "System disk type used by NAT instances."
  type        = string
  default     = "CLOUD_BSSD"
}

variable "nat_instance_system_disk_size" {
  description = "System disk size used by NAT instances in GiB."
  type        = number
  default     = 50

  validation {
    condition     = var.nat_instance_system_disk_size >= 50
    error_message = "nat_instance_system_disk_size must be at least 50 GiB."
  }
}

variable "dns_domain" {
  description = "DNSPod root domain used for production LLMGateway endpoints."
  type        = string
  default     = "lightvela.com"
}

variable "control_dns_subdomain" {
  description = "DNSPod subdomain for the control-plane endpoint."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9.-]*[a-z0-9]$", var.control_dns_subdomain))
    error_message = "control_dns_subdomain must be an explicit non-empty DNS subdomain."
  }
}

variable "traffic_dns_subdomain" {
  description = "DNSPod subdomain for the traffic-plane endpoint."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9.-]*[a-z0-9]$", var.traffic_dns_subdomain))
    error_message = "traffic_dns_subdomain must be an explicit non-empty DNS subdomain."
  }
}

variable "edge_dns_enabled" {
  description = "Manage control and traffic DNS records. Disable only during first-stage regional bootstrap before Kubernetes creates the CLBs."
  type        = bool
  default     = true
}

variable "control_clb_domain" {
  description = "Kubernetes-created control Service CLB default domain. Terraform manages DNS CNAME to this value, but does not own the CLB."
  type        = string

  validation {
    condition     = trimspace(var.control_clb_domain) != ""
    error_message = "control_clb_domain must not be empty. A placeholder is allowed only while edge_dns_enabled is false."
  }
}

variable "traffic_clb_domain" {
  description = "Kubernetes-created traffic Service CLB default domain. Terraform manages DNS CNAME to this value, but does not own the CLB."
  type        = string

  validation {
    condition     = trimspace(var.traffic_clb_domain) != ""
    error_message = "traffic_clb_domain must not be empty. A placeholder is allowed only while edge_dns_enabled is false."
  }
}

variable "control_cert_id" {
  description = "Existing TencentCloud SSL certificate ID used by the control HTTPS listener."
  type        = string

  validation {
    condition     = trimspace(var.control_cert_id) != "" && !startswith(lower(trimspace(var.control_cert_id)), "replace")
    error_message = "control_cert_id must be a real certificate ID, not a placeholder."
  }
}

variable "traffic_cert_id" {
  description = "Existing TencentCloud SSL certificate ID used by the traffic HTTPS listener."
  type        = string

  validation {
    condition     = trimspace(var.traffic_cert_id) != "" && !startswith(lower(trimspace(var.traffic_cert_id)), "replace")
    error_message = "traffic_cert_id must be a real certificate ID, not a placeholder."
  }
}

variable "tags" {
  description = "Extra TencentCloud tags."
  type        = map(string)
  default     = {}
}

variable "manage_tcr_repository" {
  description = "Manage the configured TCR namespace and repository in this regional state. Disable when reusing an existing cross-region registry."
  type        = bool
  default     = true
}

variable "tcr_instance_id" {
  description = "Existing Tencent Container Registry instance ID used to publish LLMGateway images."
  type        = string

  validation {
    condition     = trimspace(var.tcr_instance_id) != "" && !startswith(lower(trimspace(var.tcr_instance_id)), "replace")
    error_message = "tcr_instance_id must be a real regional instance ID, not a placeholder."
  }
}

variable "tcr_public_domain" {
  description = "Public domain of the existing Tencent Container Registry instance."
  type        = string

  validation {
    condition     = trimspace(var.tcr_public_domain) != "" && !startswith(lower(trimspace(var.tcr_public_domain)), "replace")
    error_message = "tcr_public_domain must be a real regional registry domain, not a placeholder."
  }
}

variable "tcr_namespace" {
  description = "TCR namespace for LLMGateway images."
  type        = string
  default     = "llmgateway"
}

variable "tcr_repository" {
  description = "TCR repository for the LLMGateway multi-binary image."
  type        = string
  default     = "llmgateway"
}

variable "tke_cluster_version" {
  description = "TKE Kubernetes version. Confirm availability in the selected region before plan."
  type        = string
  default     = "1.30.0"
}

variable "tke_cluster_description" {
  description = "Optional regional TKE description. Set it for existing clusters to preserve metadata exactly."
  type        = string
  default     = null
}

variable "tke_cluster_level" {
  description = "Managed TKE cluster level. Examples: L5, L20, L50, L100."
  type        = string
  default     = "L20"
}

variable "tke_node_pool_type" {
  description = "TKE worker type. Keep serverless for existing regions; use standard where Super Nodes are unavailable."
  type        = string
  default     = "serverless"

  validation {
    condition     = contains(["serverless", "standard"], var.tke_node_pool_type)
    error_message = "tke_node_pool_type must be serverless or standard."
  }
}

variable "tke_internet_endpoint_enabled" {
  description = "Whether to expose the Kubernetes API through a public TKE endpoint."
  type        = bool
  default     = true
}

variable "tke_internet_endpoint_domain" {
  description = "Optional custom domain signed by TKE for the public Kubernetes API endpoint."
  type        = string
  default     = ""

  validation {
    condition     = trimspace(var.tke_internet_endpoint_domain) == "" || can(regex("^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$", var.tke_internet_endpoint_domain))
    error_message = "tke_internet_endpoint_domain must be empty or a lowercase fully qualified domain name."
  }
}

variable "tke_intranet_endpoint_enabled" {
  description = "Whether to expose the Kubernetes API through an app-subnet private TKE endpoint."
  type        = bool
  default     = false
}

variable "tke_intranet_endpoint_subnet_index" {
  description = "Index of the app subnet used by the private Kubernetes API endpoint."
  type        = number
  default     = 0

  validation {
    condition     = var.tke_intranet_endpoint_subnet_index >= 0 && var.tke_intranet_endpoint_subnet_index < length(var.availability_zones)
    error_message = "tke_intranet_endpoint_subnet_index must select an existing app subnet."
  }
}

variable "standard_node_pool" {
  description = "Per-zone CVM node pool configuration used when tke_node_pool_type is standard."
  type = object({
    instance_type              = string
    backup_instance_types      = list(string)
    node_os                    = string
    min_size                   = number
    max_size                   = number
    desired_capacity           = number
    enable_auto_scale          = bool
    public_ip_assigned         = bool
    internet_max_bandwidth_out = number
    system_disk_type           = string
    system_disk_size           = number
  })
  default = {
    instance_type              = "SA9.LARGE8"
    backup_instance_types      = ["SA5.LARGE8"]
    node_os                    = "tlinux3.1x86_64"
    min_size                   = 1
    max_size                   = 3
    desired_capacity           = 1
    enable_auto_scale          = false
    public_ip_assigned         = false
    internet_max_bandwidth_out = 0
    system_disk_type           = "CLOUD_PREMIUM"
    system_disk_size           = 100
  }

  validation {
    condition = (
      var.standard_node_pool.min_size >= 1
      && var.standard_node_pool.max_size >= var.standard_node_pool.min_size
      && var.standard_node_pool.desired_capacity >= var.standard_node_pool.min_size
      && var.standard_node_pool.desired_capacity <= var.standard_node_pool.max_size
      && trimspace(var.standard_node_pool.instance_type) != ""
    )
    error_message = "standard_node_pool must define a valid instance type and min <= desired <= max with at least one node per zone."
  }
}

variable "standard_node_pool_password" {
  description = "Login password for standard CVM workers. Required only when tke_node_pool_type is standard."
  type        = string
  default     = null
  sensitive   = true

  validation {
    condition = (
      var.standard_node_pool_password == null
      || (length(var.standard_node_pool_password) >= 8 && length(var.standard_node_pool_password) <= 16)
    )
    error_message = "standard_node_pool_password must be null or between 8 and 16 characters."
  }
}

variable "standard_node_pool_generation" {
  description = "Name suffix used when standard node pools need zero-downtime replacement."
  type        = string
  default     = "v1"
}

variable "tke_cluster_cidr" {
  description = "Kubernetes pod CIDR, must not overlap with VPC/service CIDRs."
  type        = string
  default     = "172.20.0.0/16"
}

variable "tke_service_cidr" {
  description = "Kubernetes service CIDR, must not overlap with VPC/pod CIDRs."
  type        = string
  default     = "172.21.0.0/22"
}

variable "mysql_root_password" {
  description = "Root password for all managed MySQL instances."
  type        = string
  sensitive   = true
}

variable "redis_password" {
  description = "Redis password. TencentCloud Redis requires 8-16 characters."
  type        = string
  sensitive   = true
}

variable "control_mysql" {
  description = "LLMGateway control-plane MySQL sizing."
  type = object({
    mem_size    = number
    volume_size = number
    cpu         = number
  })
  default = {
    mem_size    = 4000
    volume_size = 100
    cpu         = 2
  }
}

variable "control_redis" {
  description = "LLMGateway control-plane Redis sizing."
  type = object({
    type_id              = number
    mem_size             = number
    redis_shard_num      = number
    redis_replicas_num   = number
    replica_zone_indexes = list(number)
  })
  default = {
    type_id              = 18
    mem_size             = 1024
    redis_shard_num      = 3
    redis_replicas_num   = 3
    replica_zone_indexes = [0, 1, 1]
  }
}

variable "redis_zone_ids" {
  description = "Optional explicit mapping from availability-zone name to TencentCloud numeric Redis zone ID. Use when the provider's Redis zone data source is unavailable."
  type        = map(number)
  default     = {}
}

variable "shards" {
  description = "Business data shards. Each shard can host multiple new-api Sets."
  type = map(object({
    zone_index                 = number
    mysql_mem_size             = number
    mysql_volume_size          = number
    mysql_cpu                  = number
    redis_type_id              = number
    redis_mem_size             = number
    redis_shard_num            = number
    redis_replicas             = number
    redis_replica_zone_indexes = optional(list(number), [])
    max_sets                   = number
  }))
  default = {
    shard-a = {
      zone_index        = 0
      mysql_mem_size    = 4000
      mysql_volume_size = 100
      mysql_cpu         = 2
      redis_type_id     = 17
      redis_mem_size    = 1024
      redis_shard_num   = 1
      redis_replicas    = 1
      max_sets          = 4
    }
    shard-b = {
      zone_index        = 1
      mysql_mem_size    = 4000
      mysql_volume_size = 100
      mysql_cpu         = 2
      redis_type_id     = 17
      redis_mem_size    = 1024
      redis_shard_num   = 1
      redis_replicas    = 1
      max_sets          = 4
    }
  }
}
