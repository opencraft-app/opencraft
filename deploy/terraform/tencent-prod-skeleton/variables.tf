variable "region" {
  description = "Tencent Cloud region for the production Temporal on Vitess stack."
  type        = string
  default     = "ap-beijing"
}

variable "name_prefix" {
  description = "Name prefix for all resources."
  type        = string
  default     = "temporal-vitess-prod"
}

variable "availability_zones" {
  description = "At least two availability zones that support TKE Serverless and TencentDB for MySQL."
  type        = list(string)

  validation {
    condition     = length(var.availability_zones) >= 2
    error_message = "Provide at least two availability zones."
  }
}

variable "vpc_cidr" {
  description = "VPC CIDR."
  type        = string
  default     = "10.90.0.0/16"
}

variable "subnet_cidrs" {
  description = "Subnet CIDRs keyed by logical subnet name."
  type        = map(string)
  default = {
    app_a     = "10.90.0.0/20"
    app_b     = "10.90.16.0/20"
    service_a = "10.90.32.0/20"
    db_a      = "10.90.48.0/20"
    db_b      = "10.90.64.0/20"
  }
}

variable "cluster_cidr" {
  description = "TKE pod CIDR."
  type        = string
  default     = "172.21.0.0/16"
}

variable "kubernetes_version" {
  description = "TKE Kubernetes version. Confirm available versions in the target region before apply."
  type        = string
  default     = "1.30.0"
}

variable "cluster_level" {
  description = "Managed TKE cluster level."
  type        = string
  default     = "L20"
}

variable "api_server_allowed_cidrs" {
  description = "CIDR allowlist for the managed TKE internet API endpoint. Leave empty to keep it disabled."
  type        = list(string)
  default     = []
}

variable "api_server_lb_parameters" {
  description = "JSON encoded CLB parameters used when creating the managed TKE internet API endpoint."
  type        = string
  default     = "{\"InternetAccessible\":{\"InternetChargeType\":\"TRAFFIC_POSTPAID_BY_HOUR\",\"InternetMaxBandwidthOut\":10}}"
}

variable "mysql_root_password" {
  description = "Root password used when purchasing the MySQL instances."
  type        = string
  sensitive   = true
}

variable "mysql_vitess_user" {
  description = "MySQL account used by Vitess externalDatastore."
  type        = string
  default     = "vt_dba"
}

variable "mysql_vitess_password" {
  description = "Password for mysql_vitess_user. The same password is used on all initial MySQL instances."
  type        = string
  sensitive   = true
}

variable "mysql_cpu" {
  description = "TencentDB for MySQL CPU cores."
  type        = number
  default     = 4
}

variable "mysql_mem_size_mb" {
  description = "TencentDB for MySQL memory size in MB."
  type        = number
  default     = 8000
}

variable "mysql_volume_size_gb" {
  description = "TencentDB for MySQL disk size in GB."
  type        = number
  default     = 500
}

variable "mysql_engine_version" {
  description = "TencentDB for MySQL engine version."
  type        = string
  default     = "8.0"
}

variable "mysql_device_type" {
  description = "TencentDB for MySQL device type. Keep this cloud-native for the planned production path."
  type        = string
  default     = "CLOUD_NATIVE_CLUSTER"
}

variable "managed_etcd_address" {
  description = "Tencent Cloud managed etcd client endpoint for Vitess topology, for example host:port."
  type        = string
}

variable "managed_etcd_root_path" {
  description = "Vitess global topology root path in managed etcd."
  type        = string
  default     = "/vitess/temporal-vitess-prod/global"
}

variable "tags" {
  description = "Common resource tags."
  type        = map(string)
  default = {
    service   = "temporal-vitess"
    managedBy = "terraform"
    tier      = "prod"
  }
}
