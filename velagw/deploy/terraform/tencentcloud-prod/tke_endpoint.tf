resource "tencentcloud_kubernetes_cluster_endpoint" "internet" {
  cluster_id                      = tencentcloud_kubernetes_cluster.main.id
  cluster_internet                = true
  cluster_internet_security_group = tencentcloud_security_group.control_edge.id

  extensive_parameters = jsonencode({
    AddressIPVersion = "IPV4"
    InternetAccessible = {
      InternetChargeType      = "TRAFFIC_POSTPAID_BY_HOUR"
      InternetMaxBandwidthOut = 10
    }
  })

  depends_on = [tencentcloud_kubernetes_serverless_node_pool.main]
}
