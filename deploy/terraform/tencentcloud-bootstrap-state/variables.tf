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
  description = "Region where the Terraform state bucket is created."
  type        = string
  default     = "ap-beijing"
}

variable "bucket_name_prefix" {
  description = "COS bucket name prefix. The account app_id is appended automatically because COS bucket names must end with app_id."
  type        = string
  default     = "llmgateway-prod-tfstate"
}

variable "force_clean" {
  description = "Whether to delete all objects when destroying the bucket. Keep false for production state buckets."
  type        = bool
  default     = false
}

variable "tags" {
  description = "Extra TencentCloud tags."
  type        = map(string)
  default     = {}
}
