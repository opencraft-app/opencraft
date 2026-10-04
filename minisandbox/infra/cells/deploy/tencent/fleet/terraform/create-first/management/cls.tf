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
