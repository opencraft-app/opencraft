mock_provider "tencentcloud" {}

run "disabled_by_default" {
  command = plan
  assert {
    condition     = length(tencentcloud_cls_logset.platform) == 0 && length(tencentcloud_cls_topic.workers_api) == 0 && length(tencentcloud_cls_index.workers_api) == 0
    error_message = "Default must not provision CLS resources."
  }
  assert {
    condition     = output.platform_cls_binding == null
    error_message = "Disabled CLS must not emit a collection binding."
  }
  assert {
    condition     = length(tencentcloud_kubernetes_addon.platform_cls) == 0 && output.platform_cls_collector_binding == null
    error_message = "Default must not install or authorize any collector."
  }
}

run "bounded_enabled_policy" {
  command = plan
  variables {
    platform_cls_enabled = true
  }
  assert {
    condition     = tencentcloud_cls_topic.workers_api[0].period == 7 && tencentcloud_cls_topic.workers_api[0].hot_period == 0
    error_message = "Default retention must be seven days without cold sinking."
  }
  assert {
    condition     = tencentcloud_cls_topic.workers_api[0].is_web_tracking == false && tencentcloud_cls_topic.workers_api[0].auto_split == false && tencentcloud_cls_topic.workers_api[0].partition_count == 1
    error_message = "Anonymous ingestion or unbounded partition growth is forbidden."
  }
  assert {
    condition     = length(tencentcloud_cls_index.workers_api[0].rule[0].full_text) == 0 && tencentcloud_cls_index.workers_api[0].rule[0].dynamic_index[0].status == false
    error_message = "Full-text and dynamic indexing must remain disabled."
  }
  assert {
    condition     = output.platform_cls_binding.namespace == "workers-api-system" && output.platform_cls_binding.container == "workers-api" && output.platform_cls_binding.workload == "workers-api"
    error_message = "Binding must preserve the explicit audited container."
  }
  assert {
    condition     = length(tencentcloud_kubernetes_addon.platform_cls) == 0 && output.platform_cls_collector_binding == null
    error_message = "Storage opt-in must not silently install a collector."
  }
}

run "pinned_collector_is_not_collection_admission" {
  command = plan
  variables {
    platform_cls_enabled           = true
    platform_cls_collector_enabled = true
  }
  assert {
    condition     = tencentcloud_kubernetes_addon.platform_cls[0].addon_name == "tke-log-agent" && tencentcloud_kubernetes_addon.platform_cls[0].addon_version == "1.1.25"
    error_message = "Collector must use the explicit reviewed chart, not latest."
  }
  assert {
    condition     = output.platform_cls_collector_binding.images == local.expected_collector_discovery.images && output.platform_cls_collector_binding.addonVersion == local.expected_collector_discovery.catalog.version
    error_message = "Pins must match the archived official registry/catalog observations."
  }
  assert {
    condition = alltrue([
      for name, image in output.platform_cls_collector_binding.images :
      can(regex("^ccr[.]ccs[.]tencentyun[.]com/tkeimages/[a-z-]+:v[0-9.]+@sha256:[0-9a-f]{64}$", image))
    ])
    error_message = "Every collector component must carry an immutable digest."
  }
  assert {
    condition = (
      jsondecode(tencentcloud_kubernetes_addon.platform_cls[0].raw_values).logAgent.image.tag == "v1.1.25@sha256:6b3be6d2df3597fecb186fd75d9312df59345c1e052ef66e267e24caed5dc879" &&
      jsondecode(tencentcloud_kubernetes_addon.platform_cls[0].raw_values).loglistener.image.tag == "v2.10.1.2@sha256:9350d197d22d6ffe279574e29c119408851a7048a06720e6c424e824fab5a602" &&
      jsondecode(tencentcloud_kubernetes_addon.platform_cls[0].raw_values).provisioner.image.tag == "v1.1.25@sha256:813e404648cef4b9183263914237755306d826361ad95f7e0b90de470ab08a37"
    )
    error_message = "Raw chart values must preserve each exact tag-plus-digest pin."
  }
  assert {
    condition = (
      jsondecode(tencentcloud_kubernetes_addon.platform_cls[0].raw_values).kafkalistener.enabled == false &&
      jsondecode(tencentcloud_kubernetes_addon.platform_cls[0].raw_values).global.logconfigproEnabled == false &&
      jsondecode(tencentcloud_kubernetes_addon.platform_cls[0].raw_values).global.logconfigv2Enabled == false &&
      jsondecode(tencentcloud_kubernetes_addon.platform_cls[0].raw_values).provisioner.addRole == false
    )
    error_message = "Do not enable Kafka, alternate rule controllers or dynamic role creation."
  }
  assert {
    condition     = output.platform_cls_collector_binding.collectionAdmission == "unqualified" && output.platform_cls_collector_binding.canaryAuthorized == false
    error_message = "Collector provisioning must not grant collection admission."
  }
}

run "reject_collector_without_storage" {
  command = plan
  variables {
    platform_cls_collector_enabled = true
  }
  expect_failures = [tencentcloud_kubernetes_addon.platform_cls]
}

run "reject_zero_retention" {
  command = plan
  variables {
    platform_cls_retention_days = 0
  }
  expect_failures = [var.platform_cls_retention_days]
}

run "reject_permanent_retention" {
  command = plan
  variables {
    platform_cls_retention_days = 3640
  }
  expect_failures = [var.platform_cls_retention_days]
}

run "reject_fractional_retention" {
  command = plan
  variables {
    platform_cls_retention_days = 7.5
  }
  expect_failures = [var.platform_cls_retention_days]
}
