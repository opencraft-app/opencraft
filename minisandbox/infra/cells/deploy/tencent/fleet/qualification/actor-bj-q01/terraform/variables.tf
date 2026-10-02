variable "region" {
  type    = string
  default = "ap-beijing"

  validation {
    condition     = var.region == "ap-beijing"
    error_message = "The q01 qualification substrate may exist only in ap-beijing."
  }
}

variable "tcr_registry_id" {
  description = "Existing Beijing private TCR instance used by q01."
  type        = string
  default     = "tcr-g7ax6o7q"

  validation {
    condition     = can(regex("^tcr-[a-z0-9]+$", var.tcr_registry_id))
    error_message = "tcr_registry_id must be a Tencent TCR instance ID."
  }
}

variable "release_tcr_registry_id" {
  description = "Current regional private TCR whose exact artifacts are qualified by q01."
  type        = string
  default     = "tcr-q9w0spg4"

  validation {
    condition     = can(regex("^tcr-[a-z0-9]+$", var.release_tcr_registry_id))
    error_message = "release_tcr_registry_id must be a Tencent TCR instance ID."
  }
}

variable "tcr_attachment_subnet_id" {
  description = "Stable q01 private subnet used for both TCR VPC endpoints."
  type        = string
  default     = "subnet-qljvksy9"

  validation {
    condition     = can(regex("^subnet-[a-z0-9]+$", var.tcr_attachment_subnet_id))
    error_message = "tcr_attachment_subnet_id must be a Tencent subnet ID."
  }
}

variable "vpc_id" {
  type    = string
  default = "vpc-6c2snz3a"
}

variable "cluster_name" {
  type    = string
  default = "actor-serverless-qual-bj"

  validation {
    condition     = var.cluster_name == "actor-serverless-qual-bj"
    error_message = "This module owns only the dedicated q01 qualification cluster."
  }
}

variable "cluster_id" {
  description = "Existing q01 cluster ID used only by import-existing.sh."
  type        = string
  default     = "cls-ike1rebd"

  validation {
    condition     = can(regex("^cls-[a-z0-9]+$", var.cluster_id))
    error_message = "cluster_id must be a Tencent TKE cluster ID."
  }
}

variable "release_builder_instance_id" {
  description = "Exact Beijing CVM that may execute reviewed transactional release programs through TAT."
  type        = string

  validation {
    condition     = can(regex("^ins-[a-z0-9]+$", var.release_builder_instance_id))
    error_message = "release_builder_instance_id must be one exact CVM instance ID."
  }
}

variable "buckets" {
  description = "Private NeverEnabled-versioning q01 data/evidence buckets plus the short-lived artifact relay."
  type        = map(string)
  default = {
    cold     = "actor-depot-cold-prod-bj-q01-nv1-1388575217"
    backup   = "actor-fdb-backup-prod-bj-q01-nv1-1388575217"
    code     = "actor-worker-code-qual-bj-q01-nv1-1388575217"
    relay    = "actor-build-relay-qual-bj-q01-nv1-1388575217"
    evidence = "actor-qualification-evidence-prod-bj-q01-nv1-1388575217"
  }

  validation {
    condition = (
      length(var.buckets) == 5 &&
      can(var.buckets.cold) &&
      can(var.buckets.backup) &&
      can(var.buckets.code) &&
      can(var.buckets.relay) &&
      can(var.buckets.evidence) &&
      can(regex("^actor-depot-cold-prod-bj-q01-nv1-[0-9]+$", var.buckets.cold)) &&
      can(regex("^actor-fdb-backup-prod-bj-q01-nv1-[0-9]+$", var.buckets.backup)) &&
      can(regex("^actor-worker-code-qual-bj-q01-nv1-[0-9]+$", var.buckets.code)) &&
      can(regex("^actor-build-relay-qual-bj-q01-nv1-[0-9]+$", var.buckets.relay)) &&
      can(regex("^actor-qualification-evidence-prod-bj-q01-nv1-[0-9]+$", var.buckets.evidence))
    )
    error_message = "buckets must be the five exact q01 NeverEnabled-versioning identities."
  }
}
