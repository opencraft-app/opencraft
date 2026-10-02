output "registry" {
  description = "Non-secret registry identity consumed from per-Cell remote state."
  value = {
    id         = tencentcloud_tcr_instance.fleet.id
    host       = tencentcloud_tcr_instance.fleet.public_domain
    namespace  = tencentcloud_tcr_namespace.fleet.name
    repository = { for name, repository in tencentcloud_tcr_repository.fleet : name => repository.url }
  }
}

output "network" {
  description = "Regional private network identity consumed by management and Cell roots."
  value = {
    ccn_id                = tencentcloud_ccn.fleet.id
    tke_oidc_config_ready = tencentcloud_cam_role_policy_attachment_by_name.tke_oidc_config.id != ""
  }
}
