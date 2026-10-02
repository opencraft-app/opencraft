variable "region" {
  description = "Tencent Cloud region that holds the fleet Terraform state bucket."
  type        = string
  default     = "ap-beijing"
}

variable "state_bucket_name" {
  description = "Globally unique COS bucket name, including the Tencent account AppId suffix."
  type        = string

  validation {
    condition     = can(regex("^actor-terraform-state-[a-z0-9-]+-[0-9]+$", var.state_bucket_name))
    error_message = "state_bucket_name must use actor-terraform-state-<scope>-<appid>."
  }
}

variable "tags" {
  type    = map(string)
  default = {}
}
