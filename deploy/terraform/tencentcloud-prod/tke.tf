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
