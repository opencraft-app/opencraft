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
