variable "platform_cls_enabled" {
  description = "Provision bounded platform diagnostic storage only. This does not install an agent or authorize collection from an old API image."
  type        = bool
  default     = false
}

variable "platform_cls_retention_days" {
  description = "Finite standard-storage retention for platform WARN/ERROR logs."
  type        = number
  default     = 7

  validation {
    condition = (
      var.platform_cls_retention_days == floor(var.platform_cls_retention_days) &&
      var.platform_cls_retention_days >= 1 && var.platform_cls_retention_days <= 30
    )
    error_message = "platform_cls_retention_days must be an integer from 1 to 30."
  }
}

variable "platform_cls_collector_enabled" {
  description = "Install the separately pinned official collector in C only. Does not create LogConfig or authorize collection. Requires platform_cls_enabled."
  type        = bool
  default     = false
}

locals {
  # Beijing's 2026-10-04 catalog and default values select this chart. These
  # registry-reported digests are not collector behavior qualification.
  platform_cls_collector_version = "1.1.25"
  platform_cls_collector_images = {
    log_agent   = "ccr.ccs.tencentyun.com/tkeimages/log-agent:v1.1.25@sha256:6b3be6d2df3597fecb186fd75d9312df59345c1e052ef66e267e24caed5dc879"
    loglistener = "ccr.ccs.tencentyun.com/tkeimages/loglistener:v2.10.1.2@sha256:9350d197d22d6ffe279574e29c119408851a7048a06720e6c424e824fab5a602"
    provisioner = "ccr.ccs.tencentyun.com/tkeimages/cls-provisioner:v1.1.25@sha256:813e404648cef4b9183263914237755306d826361ad95f7e0b90de470ab08a37"
  }
  platform_cls_collector_values = {
    global = {
      registry            = "ccr.ccs.tencentyun.com"
      logconfigproEnabled = false
      logconfigv2Enabled  = false
    }
    kafkalistener = { enabled = false }
    logAgent = {
      image = {
        repository = "tkeimages/log-agent"
        tag        = "v${split(":v", local.platform_cls_collector_images.log_agent)[1]}"
      }
    }
    loglistener = {
      enabled = true
      image = {
        repository = "tkeimages/loglistener"
        tag        = "v${split(":v", local.platform_cls_collector_images.loglistener)[1]}"
      }
    }
    provisioner = {
      addRole = false
      image = {
        repository = "tkeimages/cls-provisioner"
        tag        = "v${split(":v", local.platform_cls_collector_images.provisioner)[1]}"
      }
    }
  }
}

# TKE's addon manager owns the agent, provisioner and CRD. Argo owns only the
# separately admitted LogConfig, never a second copy of these workloads.
resource "tencentcloud_kubernetes_addon" "platform_cls" {
  count         = var.platform_cls_collector_enabled ? 1 : 0
  cluster_id    = tencentcloud_kubernetes_cluster.management.id
  addon_name    = "tke-log-agent"
  addon_version = local.platform_cls_collector_version
  # Provider 1.83.11 encodes JSON for InstallAddon; do not double-base64 it.
  raw_values = jsonencode(local.platform_cls_collector_values)

  depends_on = [tencentcloud_cls_index.workers_api]

  lifecycle {
    precondition {
      condition     = var.platform_cls_enabled
      error_message = "Provision the separately owned CLS topic/index before enabling the C collector."
    }
  }
}

output "platform_cls_collector_binding" {
  description = "Pinned collector intent only. No API safety, live image, CRD, cloud ownership or CLS query qualification."
  value = var.platform_cls_collector_enabled ? {
    schema              = "actor-platform-cls-collector-binding/v1"
    managementId        = var.management_id
    clusterId           = tencentcloud_kubernetes_cluster.management.id
    region              = var.region
    addonName           = "tke-log-agent"
    addonVersion        = local.platform_cls_collector_version
    images              = local.platform_cls_collector_images
    valuesDigest        = "sha256:${sha256(jsonencode(local.platform_cls_collector_values))}"
    collectionAdmission = "unqualified"
    canaryAuthorized    = false
  } : null
}

# Terraform owns topic lifecycle, retention and index policy. LogConfig selects
# an exact existing topic and must not repeat these fields or create by name.
resource "tencentcloud_cls_logset" "platform" {
  count       = var.platform_cls_enabled ? 1 : 0
  logset_name = "${var.management_id}-platform"
  tags = {
    management = var.management_id
    owner      = "terraform"
    purpose    = "platform-diagnostics"
  }
}

resource "tencentcloud_cls_topic" "workers_api" {
  count                = var.platform_cls_enabled ? 1 : 0
  logset_id            = tencentcloud_cls_logset.platform[0].id
  topic_name           = "${var.management_id}-workers-api-errors"
  period               = var.platform_cls_retention_days
  storage_type         = "hot"
  hot_period           = 0
  partition_count      = 1
  auto_split           = false
  max_split_partitions = 1
  is_web_tracking      = false
  describes            = "Structured platform diagnostics only; no user JavaScript console or request payloads."
  tags = {
    management = var.management_id
    owner      = "terraform"
    purpose    = "platform-diagnostics"
  }
}

resource "tencentcloud_cls_index" "workers_api" {
  count                   = var.platform_cls_enabled ? 1 : 0
  topic_id                = tencentcloud_cls_topic.workers_api[0].id
  status                  = true
  include_internal_fields = false
  metadata_flag           = 2

  rule {
    dynamic_index {
      status = false
    }
    key_value {
      case_sensitive = true
      dynamic "key_values" {
        for_each = toset(["request_id", "error", "level", "msg", "listener", "transport_phase"])
        content {
          key = key_values.value
          value {
            type        = "text"
            sql_flag    = false
            contain_z_h = false
            tokenizer   = ""
          }
        }
      }
    }
  }
}

# Keep this separate from the strict bootstrap management_inventory schema.
output "platform_cls_binding" {
  description = "Credential-free storage/collection identity. Rendering is not agent, image or live-collection qualification."
  value = var.platform_cls_enabled ? {
    schema         = "actor-platform-cls-binding/v1"
    managementId   = var.management_id
    clusterId      = tencentcloud_kubernetes_cluster.management.id
    region         = var.region
    logsetId       = tencentcloud_cls_logset.platform[0].id
    topicId        = tencentcloud_cls_topic.workers_api[0].id
    retentionDays  = var.platform_cls_retention_days
    workload       = "workers-api"
    namespace      = "workers-api-system"
    container      = "workers-api"
    logSchema      = "workers-api-platform-json/v1"
    collectionMode = "incremental-warn-error"
  } : null
}
