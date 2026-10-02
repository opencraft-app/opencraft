output "cluster" {
  value = {
    id           = tencentcloud_kubernetes_cluster.qualification.id
    name         = tencentcloud_kubernetes_cluster.qualification.cluster_name
    version      = tencentcloud_kubernetes_cluster.qualification.cluster_version
    network      = tencentcloud_kubernetes_cluster.qualification.network_type
    pod_cidr     = tencentcloud_kubernetes_cluster.qualification.cluster_cidr
    service_cidr = tencentcloud_kubernetes_cluster.qualification.service_cidr
  }
}

output "buckets" {
  value = {
    for role, bucket in tencentcloud_cos_bucket.storage : role => {
      name                = bucket.bucket
      multi_az            = false
      versioning_contract = "verify-empty-remote-document"
    }
  }
}

output "runtime_exact_scale_down_identity" {
  value = {
    role_name = tencentcloud_cam_role.runtime_exact_scale_down.name
    role_arn  = tencentcloud_cam_role.runtime_exact_scale_down.role_arn
    provider  = var.cluster_id
    subject   = "system:serviceaccount:actor-fdb-cell-system:actor-bj-q01-runtime-capacity"
    audience  = "sts.cloud.tencent.com"
    policy_id = tencentcloud_cam_policy.runtime_exact_scale_down.id
    action    = "tke:DeleteClusterMachines"
    cluster   = var.cluster_id
  }
}

output "release_hook_identity" {
  value = {
    role_name  = tencentcloud_cam_role.release_hook_exact_tat.name
    role_arn   = tencentcloud_cam_role.release_hook_exact_tat.role_arn
    provider   = var.cluster_id
    subject    = "system:serviceaccount:actor-release-system:actor-release-hook"
    audience   = "sts.cloud.tencent.com"
    policy_id  = tencentcloud_cam_policy.release_hook_exact_tat.id
    actions    = ["tat:InvokeCommand", "tat:DescribeInvocationTasks"]
    builder_id = var.release_builder_instance_id
  }
}
