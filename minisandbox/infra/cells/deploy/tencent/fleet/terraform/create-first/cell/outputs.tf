output "cell_inventory" {
  description = "Credential-free Terraform-to-Argo handoff."
  value       = local.cell_inventory
}

output "cell_inventory_yaml" {
  description = "Credential-free inventory ready to write into reviewed Git desired state."
  value       = yamlencode(local.cell_inventory)
}

output "sensitive_bootstrap" {
  description = "Bootstrap-only kubeconfig and Cell-scoped storage keys; never write this output to Git or an ordinary receipt."
  sensitive   = true
  value = {
    kubeconfig            = tencentcloud_kubernetes_cluster_endpoint.private.kube_config_intranet
    storageCredentialMode = var.storage_identity_mode
    storageCredentials = {
      for role, identity in tencentcloud_cam_user.data_plane_storage : role => {
        userName        = identity.name
        bucket          = local.data_plane_storage[role].bucket
        accessKeyId     = identity.secret_id
        secretAccessKey = identity.secret_key
      }
    }
  }
}
