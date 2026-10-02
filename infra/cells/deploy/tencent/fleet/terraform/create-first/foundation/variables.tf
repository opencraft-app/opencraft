variable "region" {
  description = "Region containing the shared private image registry."
  type        = string
  default     = "ap-beijing"
}

variable "registry_name" {
  description = "Stable regional TCR instance name."
  type        = string
  default     = "actor-fleet-beijing"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,39}$", var.registry_name))
    error_message = "registry_name must be a lower-case stable name."
  }
}

variable "registry_instance_type" {
  description = "Tencent TCR instance edition."
  type        = string
  default     = "basic"

  validation {
    condition     = contains(["basic", "premium"], var.registry_instance_type)
    error_message = "registry_instance_type must be basic or premium."
  }
}

variable "registry_namespace" {
  type    = string
  default = "actor-fleet"
}

variable "ccn_name" {
  description = "Stable regional Cloud Connect Network name."
  type        = string
  default     = "actor-fleet-beijing"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,59}$", var.ccn_name))
    error_message = "ccn_name must be a lower-case stable name."
  }
}

variable "ccn_qos" {
  description = "CCN service class: PT (platinum), AU (gold), or AG (silver)."
  type        = string
  default     = "AU"

  validation {
    condition     = contains(["PT", "AU", "AG"], var.ccn_qos)
    error_message = "ccn_qos must be PT, AU, or AG."
  }
}

variable "ccn_bandwidth_limit_type" {
  description = "CCN bandwidth limit mode. INTER_REGION_LIMIT is compatible with both bandwidth- and traffic-metered postpaid accounts."
  type        = string
  default     = "INTER_REGION_LIMIT"

  validation {
    condition     = contains(["INTER_REGION_LIMIT", "OUTER_REGION_LIMIT"], var.ccn_bandwidth_limit_type)
    error_message = "ccn_bandwidth_limit_type must be INTER_REGION_LIMIT or OUTER_REGION_LIMIT."
  }
}

variable "ccn_metering_type" {
  description = "CCN postpaid metering mode. TRAFFIC keeps the regional foundation usage-based."
  type        = string
  default     = "TRAFFIC"

  validation {
    condition     = contains(["TRAFFIC", "BANDWIDTH"], var.ccn_metering_type)
    error_message = "ccn_metering_type must be TRAFFIC or BANDWIDTH."
  }
}

variable "repositories" {
  description = "Complete private repository inventory required to cold-build and cold-pull a Cell."
  type        = set(string)
  default = [
    "actor-fleet-controller",
    "actor-loadgen",
    "argocd",
    "argocd-dex",
    "argocd-haproxy",
    "argocd-redis",
    "base-distroless",
    "base-golang",
    "base-tencentcloud-cli",
    "fdb-kubernetes-monitor",
    "fdb-kubernetes-operator",
    "git-service",
    "nats",
    "observability-busybox",
    "observability-grafana",
    "observability-k8s-sidecar",
    "observability-kube-state-metrics",
    "observability-kubectl",
    "observability-prometheus",
    "observability-prometheus-adapter",
    "observability-prometheus-config-reloader",
    "observability-prometheus-operator",
    "observability-webhook-certgen",
    "release-hook",
    "rivet-runtime",
    "runtime-base",
    "worker-registry",
    "workers-api",
  ]

  validation {
    condition     = length(var.repositories) > 0 && alltrue([for name in var.repositories : can(regex("^[a-z0-9][a-z0-9._-]+$", name))])
    error_message = "repositories must contain only valid private TCR repository names."
  }
}

variable "deletion_protection" {
  description = "Protect the shared regional registry from an ordinary destroy."
  type        = bool
  default     = true
}

variable "tags" {
  type    = map(string)
  default = {}
}
