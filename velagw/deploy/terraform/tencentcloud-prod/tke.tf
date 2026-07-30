resource "tencentcloud_kubernetes_cluster" "main" {
  vpc_id                     = tencentcloud_vpc.main.id
  cluster_name               = "${local.name_prefix}-tke"
  cluster_desc               = coalesce(var.tke_cluster_description, "LLMGateway production TKE cluster in ${var.region}.")
  cluster_deploy_type        = "MANAGED_CLUSTER"
  cluster_version            = var.tke_cluster_version
  cluster_level              = var.tke_cluster_level
  cluster_cidr               = var.tke_cluster_cidr
  service_cidr               = var.tke_service_cidr
  cluster_max_pod_num        = 64
  cluster_max_service_num    = 1024
  container_runtime          = "containerd"
  acquire_cluster_admin_role = true
  deletion_protection        = true
  tags                       = local.common_tags
}

resource "tencentcloud_kubernetes_serverless_node_pool" "main" {
  count = var.tke_node_pool_type == "serverless" ? 1 : 0

  cluster_id = tencentcloud_kubernetes_cluster.main.id
  name       = "${var.project}-${var.environment}-serverless"

  dynamic "serverless_nodes" {
    for_each = tencentcloud_subnet.app

    content {
      display_name = "${local.name_prefix}-serverless-${serverless_nodes.key}"
      subnet_id    = serverless_nodes.value.id
    }
  }

  security_group_ids = [tencentcloud_security_group.tke_runtime.id]

  labels = {
    "llmgateway.io/runtime" = "serverless"
  }
}

resource "tencentcloud_kubernetes_node_pool" "standard" {
  for_each = var.tke_node_pool_type == "standard" ? local.app_subnets : {}

  cluster_id           = tencentcloud_kubernetes_cluster.main.id
  vpc_id               = tencentcloud_vpc.main.id
  name                 = "${var.project}-${var.environment}-${var.region_alias}-${each.key}-${var.standard_node_pool_generation}"
  subnet_ids           = [tencentcloud_subnet.app[each.key].id]
  min_size             = var.standard_node_pool.min_size
  max_size             = var.standard_node_pool.max_size
  desired_capacity     = var.standard_node_pool.enable_auto_scale ? null : var.standard_node_pool.desired_capacity
  enable_auto_scale    = var.standard_node_pool.enable_auto_scale
  deletion_protection  = true
  delete_keep_instance = false
  node_os              = var.standard_node_pool.node_os
  node_os_type         = "GENERAL"
  wait_node_ready      = var.standard_node_pool.enable_auto_scale ? false : true
  labels = {
    "llmgateway.io/runtime"       = "standard"
    "topology.kubernetes.io/zone" = each.value.zone
  }

  auto_scaling_config {
    instance_type              = var.standard_node_pool.instance_type
    backup_instance_types      = var.standard_node_pool.backup_instance_types
    instance_charge_type       = "POSTPAID_BY_HOUR"
    password                   = var.standard_node_pool_password
    system_disk_type           = var.standard_node_pool.system_disk_type
    system_disk_size           = var.standard_node_pool.system_disk_size
    orderly_security_group_ids = [tencentcloud_security_group.tke_runtime.id]
    public_ip_assigned         = var.standard_node_pool.public_ip_assigned
    internet_charge_type       = var.standard_node_pool.public_ip_assigned ? "TRAFFIC_POSTPAID_BY_HOUR" : null
    internet_max_bandwidth_out = var.standard_node_pool.internet_max_bandwidth_out
    enhanced_monitor_service   = true
    enhanced_security_service  = true
  }

  node_config {
    is_schedule = true
  }

  timeouts {
    create = "45m"
    update = "45m"
  }

  # TKE omits these write-only/defaulted fields when reading standard pools in
  # newer regions. Ignoring the read-back gap prevents needless pool replacement.
  lifecycle {
    create_before_destroy = true
    ignore_changes = [
      unschedulable,
      auto_scaling_config[0].password,
      node_config,
    ]
  }
}
