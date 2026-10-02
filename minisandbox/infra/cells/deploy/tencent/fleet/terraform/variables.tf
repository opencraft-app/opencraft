variable "region" {
  type    = string
  default = "ap-beijing"

  validation {
    condition     = var.region == "ap-beijing"
    error_message = "This qualification module may only create resources in ap-beijing."
  }
}

variable "cell_id" {
  type    = string
  default = "actor-bj-b01"

  validation {
    condition     = can(regex("^actor-bj-[a-z][0-9]{2}$", var.cell_id))
    error_message = "cell_id must be a stable Beijing Cell identifier."
  }
}

variable "vpc_id" {
  type    = string
  default = "vpc-6c2snz3a"
}

variable "security_group_id" {
  type    = string
  default = "sg-jfy27iab"
}

variable "image_id" {
  type    = string
  default = "img-eb30mz89"
}

variable "fdb_instance_type" {
  type    = string
  default = "SA9.LARGE8"
}

variable "runtime_instance_type" {
  type    = string
  default = "SA9.LARGE8"
}

variable "subnets" {
  type = map(string)
  default = {
    ap-beijing-6 = "subnet-qljvksy9"
    ap-beijing-7 = "subnet-k1rounhb"
    ap-beijing-8 = "subnet-kx0feejb"
  }

  validation {
    condition     = length(var.subnets) == 3 && alltrue([for zone in ["ap-beijing-6", "ap-beijing-7", "ap-beijing-8"] : contains(keys(var.subnets), zone)])
    error_message = "subnets must contain exactly Beijing zones 6, 7, and 8."
  }
}

variable "fdb_data_disk_size_gib" {
  type    = number
  default = 200

  validation {
    condition     = var.fdb_data_disk_size_gib >= 100
    error_message = "FDB data disks must be at least 100 GiB."
  }
}

variable "enable_cbs_encryption" {
  description = "Optional Tencent CBS encryption-at-rest policy for newly created data disks."
  type        = bool
  default     = false
}

variable "cold_bucket" {
  description = "Fresh Cell cold bucket that has never had COS versioning enabled."
  type        = string
  default     = "actor-depot-cold-prod-bj-b01-nv1-1388575217"

  validation {
    condition     = can(regex("^actor-depot-cold-prod-bj-b01-nv[0-9]+-[0-9]+$", var.cold_bucket))
    error_message = "cold_bucket must use the immutable Beijing no-versioning naming contract."
  }
}

variable "backup_bucket" {
  description = "Fresh Cell FDB backup bucket that has never had COS versioning enabled."
  type        = string
  default     = "actor-fdb-backup-prod-bj-b01-nv1-1388575217"

  validation {
    condition     = can(regex("^actor-fdb-backup-prod-bj-b01-nv[0-9]+-[0-9]+$", var.backup_bucket))
    error_message = "backup_bucket must use the immutable Beijing no-versioning naming contract."
  }
}
