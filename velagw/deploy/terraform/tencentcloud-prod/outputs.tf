output "vpc_id" {
  value = tencentcloud_vpc.main.id
}

output "public_subnet_ids" {
  value = { for k, v in tencentcloud_subnet.public : k => v.id }
}

output "app_subnet_ids" {
  value = { for k, v in tencentcloud_subnet.app : k => v.id }
}

output "data_subnet_ids" {
  value = { for k, v in tencentcloud_subnet.data : k => v.id }
}

output "nat_eip" {
  value = tencentcloud_eip.nat.public_ip
}

output "security_group_ids" {
  value = {
    traffic_edge = tencentcloud_security_group.traffic_edge.id
    control_edge = tencentcloud_security_group.control_edge.id
    tke_runtime  = tencentcloud_security_group.tke_runtime.id
    mysql        = tencentcloud_security_group.mysql.id
    redis        = tencentcloud_security_group.redis.id
  }
}

output "tke_cluster_id" {
  value = tencentcloud_kubernetes_cluster.main.id
}

output "tke_external_endpoint" {
  value = tencentcloud_kubernetes_cluster_endpoint.internet.cluster_external_endpoint
}

output "control_host" {
  value = local.control_host
}

output "traffic_host" {
  value = local.traffic_host
}

output "control_clb_domain" {
  value = try(tencentcloud_dnspod_record.control[0].value, null)
}

output "traffic_clb_domain" {
  value = try(tencentcloud_dnspod_record.traffic[0].value, null)
}

output "control_cert_id" {
  value = var.control_cert_id
}

output "traffic_cert_id" {
  value = var.traffic_cert_id
}

output "llmgateway_image_repository" {
  value = "${var.tcr_public_domain}/${var.tcr_namespace}/${var.tcr_repository}"
}

output "control_mysql" {
  value = {
    id          = tencentcloud_mysql_instance.control.id
    intranet_ip = tencentcloud_mysql_instance.control.intranet_ip
    port        = 3306
  }
}

output "control_redis_id" {
  value = tencentcloud_redis_instance.control.id
}

output "shard_mysql" {
  value = {
    for shard, instance in tencentcloud_mysql_instance.shard : shard => {
      id          = instance.id
      intranet_ip = instance.intranet_ip
      port        = 3306
      max_sets    = var.shards[shard].max_sets
    }
  }
}

output "shard_redis_ids" {
  value = {
    for shard, instance in tencentcloud_redis_instance.shard : shard => instance.id
  }
}
