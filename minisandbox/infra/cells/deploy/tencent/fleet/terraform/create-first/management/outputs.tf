output "management_inventory" {
  description = "Credential-free regional management inventory."
  value       = local.management_inventory
}

output "management_inventory_yaml" {
  description = "Credential-free management inventory for platform bootstrap."
  value       = yamlencode(local.management_inventory)
}

output "runtime_builder_inventory" {
  description = "Build-only CVM and attached CBS identities. Provisioning does not establish storage/build readiness."
  value       = local.runtime_builder_inventory
}

output "sensitive_bootstrap" {
  description = "Bootstrap-only kubeconfig; never write this output to Git or an ordinary receipt."
  sensitive   = true
  value = {
    kubeconfig = tencentcloud_kubernetes_cluster_endpoint.private.kube_config_intranet
  }
}

output "bootstrap_relay_bucket" {
  description = "Private one-day COS relay used to bootstrap the no-public-IP management CVM."
  value       = tencentcloud_cos_bucket.bootstrap_relay.bucket
}

output "code_plane_buckets" {
  description = "Regional immutable Worker code, code-plane FDB backup and qualification evidence buckets."
  value = {
    backup   = tencentcloud_cos_bucket.code_plane["backup"].bucket
    code     = tencentcloud_cos_bucket.code_plane["code"].bucket
    evidence = tencentcloud_cos_bucket.code_plane["evidence"].bucket
  }
}
