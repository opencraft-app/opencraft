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
  description = "Zones used by subnets, TKE Serverless, CDB, and Redis. Keep at least two zones in the selected region."
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
  description = "Private TKE Serverless/pod subnet CIDRs. Same length as availability_zones."
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

variable "tcr_instance_id" {
  description = "Existing regional Tencent Container Registry instance ID used to publish LLMGateway images."
  type        = string

  validation {
    condition     = trimspace(var.tcr_instance_id) != "" && !startswith(lower(trimspace(var.tcr_instance_id)), "replace")
    error_message = "tcr_instance_id must be a real regional instance ID, not a placeholder."
  }
}

variable "tcr_public_domain" {
  description = "Public domain of the existing regional Tencent Container Registry instance."
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
    type_id            = number
    mem_size           = number
    redis_shard_num    = number
    redis_replicas_num = number
  })
  default = {
    type_id            = 17
    mem_size           = 1024
    redis_shard_num    = 1
    redis_replicas_num = 1
  }
}

variable "shards" {
  description = "Business data shards. Each shard can host multiple new-api Sets."
  type = map(object({
    zone_index        = number
    mysql_mem_size    = number
    mysql_volume_size = number
    mysql_cpu         = number
    redis_type_id     = number
    redis_mem_size    = number
    redis_shard_num   = number
    redis_replicas    = number
    max_sets          = number
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
