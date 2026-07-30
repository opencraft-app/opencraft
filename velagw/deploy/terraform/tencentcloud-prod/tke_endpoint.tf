resource "tencentcloud_kubernetes_cluster_endpoint" "internet" {
  cluster_id                      = tencentcloud_kubernetes_cluster.main.id
  cluster_internet                = var.tke_internet_endpoint_enabled
  cluster_internet_security_group = var.tke_internet_endpoint_enabled ? tencentcloud_security_group.control_edge.id : null
  cluster_internet_domain         = var.tke_internet_endpoint_enabled && trimspace(var.tke_internet_endpoint_domain) != "" ? var.tke_internet_endpoint_domain : null
  cluster_intranet                = var.tke_intranet_endpoint_enabled
  cluster_intranet_security_group = var.tke_intranet_endpoint_enabled ? tencentcloud_security_group.tke_runtime.id : null
  cluster_intranet_subnet_id      = var.tke_intranet_endpoint_enabled ? tencentcloud_subnet.app[tostring(var.tke_intranet_endpoint_subnet_index)].id : null

  extensive_parameters = var.tke_internet_endpoint_enabled ? jsonencode({
    AddressIPVersion = "IPV4"
    InternetAccessible = {
      InternetChargeType      = "TRAFFIC_POSTPAID_BY_HOUR"
      InternetMaxBandwidthOut = 10
    }
  }) : null

  depends_on = [
    tencentcloud_kubernetes_serverless_node_pool.main,
    tencentcloud_kubernetes_node_pool.standard,
  ]
}
