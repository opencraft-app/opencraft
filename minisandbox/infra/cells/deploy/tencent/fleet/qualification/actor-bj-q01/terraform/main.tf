locals {
  common_tags = {
    product    = "actor-serverless"
    purpose    = "qualification"
    cell       = "actor-bj-q01"
    managed-by = "minisandbox"
  }

  observability_repositories = toset([
    "observability-busybox",
    "observability-grafana",
    "observability-k8s-sidecar",
    "observability-kube-state-metrics",
    "observability-kubectl",
    "observability-prometheus",
    "observability-prometheus-adapter",
    "observability-prometheus-config-reloader",
    "observability-prometheus-operator",
    "observability-webhook-certgen",
  ])

  # q01 validates releases produced by the current regional registry while
  # retaining its original bootstrap registry for rollback evidence. Both
  # endpoints are desired state, never operator-created hidden dependencies.
  tcr_vpc_registries = {
    bootstrap = var.tcr_registry_id
    release   = var.release_tcr_registry_id
  }
}

data "tencentcloud_user_info" "current" {}

# Every image required after a control-node replacement must exist in the
# private, VPC-attached TCR. Cached images on the original nodes are not a
# supply-chain or availability guarantee.
resource "tencentcloud_tcr_repository" "observability" {
  for_each = local.observability_repositories

  instance_id    = var.tcr_registry_id
  namespace_name = "actor-fleet"
  name           = each.value
  brief_desc     = "q01 pinned observability image"
  description    = "Private image supply for unattended q01 control-node replacement."
  force_delete   = false

  lifecycle {
    prevent_destroy = true
  }
}

resource "tencentcloud_tcr_vpc_attachment" "qualification" {
  for_each = local.tcr_vpc_registries

  instance_id              = each.value
  vpc_id                   = var.vpc_id
  subnet_id                = var.tcr_attachment_subnet_id
  region_name              = var.region
  enable_public_domain_dns = true
  enable_vpc_domain_dns    = true

  lifecycle {
    prevent_destroy = true
  }
}

# TKE owns only the managed control plane here. Control, runtime, and FDB
# worker capacity is deliberately represented by the checked-in MachineSet
# YAML so Terraform and the load-driven controllers never share a writer.
resource "tencentcloud_kubernetes_cluster" "qualification" {
  cluster_name                 = var.cluster_name
  cluster_desc                 = "Dedicated Beijing qualification cluster for Actor serverless capacity, FDB and cold-tier gates."
  cluster_os                   = "tlinux3.1x86_64"
  cluster_deploy_type          = "MANAGED_CLUSTER"
  cluster_version              = "1.30.0"
  cluster_level                = "L20"
  auto_upgrade_cluster_level   = false
  container_runtime            = "containerd"
  network_type                 = "GR"
  vpc_id                       = var.vpc_id
  cluster_cidr                 = "10.200.0.0/16"
  service_cidr                 = "10.201.0.0/22"
  cluster_max_pod_num          = 64
  cluster_max_service_num      = 1024
  ignore_cluster_cidr_conflict = false
  cluster_ipvs                 = true
  node_name_type               = "lan-ip"
  deletion_protection          = true
  project_id                   = 0

  tags = local.common_tags

  lifecycle {
    prevent_destroy = true
    # Provider 1.83.11 imports this remote field as an empty string but gives
    # omitted configuration the ForceNew default GENERAL. The create request
    # and live cluster already establish the OS type; never replace a cluster
    # merely to normalize this lossy provider read.
    # runtime_version is also read but never handled by this provider's Update
    # implementation, so owning it would create permanent no-op drift.
    ignore_changes = [cluster_os_type, runtime_version]
  }
}

# Do not set versioning_enable. Tencent COS cannot return a bucket to the
# NeverEnabled state after versioning has once been enabled, and provider
# 1.83.11 cannot distinguish Suspended from NeverEnabled on read. The remote
# empty versioning document remains a separate admission proof.
resource "tencentcloud_cos_bucket" "storage" {
  for_each = var.buckets

  bucket               = each.value
  acl                  = "private"
  encryption_algorithm = "AES256"
  force_clean          = false

  tags = merge(local.common_tags, {
    role       = each.key == "cold" ? "depot-cold" : each.key == "backup" ? "fdb-backup" : each.key == "code" ? "worker-code" : each.key == "evidence" ? "qualification-evidence" : "build-relay"
    versioning = "never-enabled"
  })

  dynamic "lifecycle_rules" {
    for_each = each.key == "relay" ? [1] : []
    content {
      id            = "expire-build-relay-after-one-day"
      filter_prefix = "relay/"
      expiration {
        days = 1
      }
      abort_incomplete_multipart_upload {
        days_after_initiation = 1
      }
    }
  }

  lifecycle {
    prevent_destroy = true
  }
}

# Enable projected ServiceAccount identity once per cluster. TKE owns issuer
# key rotation. Its API requires the webhook creation flag when it creates the
# CAM provider, but the controller declares its token projection directly and
# does not depend on webhook mutation. It receives no long-lived AK/SK: STS
# exchanges its exact ServiceAccount token for a short-lived role.
resource "tencentcloud_cam_role_policy_attachment_by_name" "tke_oidc_config" {
  role_name   = "TKE_QCSRole"
  policy_name = "QcloudAccessForTKERoleInOIDCConfig"

  lifecycle {
    prevent_destroy = true
  }
}

resource "tencentcloud_kubernetes_auth_attachment" "pod_workload_identity" {
  cluster_id                              = tencentcloud_kubernetes_cluster.qualification.id
  use_tke_default                         = true
  auto_create_discovery_anonymous_auth    = true
  auto_create_oidc_config                 = true
  auto_create_client_id                   = ["sts.cloud.tencent.com"]
  auto_install_pod_identity_webhook_addon = true

  depends_on = [tencentcloud_cam_role_policy_attachment_by_name.tke_oidc_config]
}

resource "tencentcloud_cam_policy" "runtime_exact_scale_down" {
  name        = "actor-bj-q01-runtime-exact-scale-down"
  description = "Allow only exact native Machine deletion and pool contraction in q01."
  document = jsonencode({
    version = "2.0"
    statement = [{
      effect   = "allow"
      action   = ["name/tke:DeleteClusterMachines"]
      resource = ["qcs::tke:${var.region}:uin/${data.tencentcloud_user_info.current.owner_uin}:cluster/${var.cluster_id}"]
    }]
  })

  tags = merge(local.common_tags, {
    role = "runtime-exact-scale-down"
  })

  lifecycle {
    prevent_destroy = true
  }
}

resource "tencentcloud_cam_role" "runtime_exact_scale_down" {
  name             = "actor-bj-q01-runtime-scale-down"
  description      = "OIDC workload identity for one exact q01 runtime Machine scale-down operation."
  console_login    = false
  session_duration = 7200
  document = jsonencode({
    version = "2.0"
    statement = [{
      effect = "allow"
      principal = {
        # CAM's live CreateRole API accepts oidc-provider here. Some Tencent
        # documentation renders this segment as oidcProvider, which the API
        # rejects with InvalidParameter.PrincipalError.
        federated = ["qcs::cam::uin/${data.tencentcloud_user_info.current.owner_uin}:oidc-provider/${var.cluster_id}"]
      }
      action = ["name/sts:AssumeRoleWithWebIdentity"]
      condition = {
        string_equal = {
          "oidc:aud" = ["sts.cloud.tencent.com"]
          "oidc:sub" = ["system:serviceaccount:actor-fdb-cell-system:actor-bj-q01-runtime-capacity"]
        }
      }
    }]
  })

  tags = merge(local.common_tags, {
    role = "runtime-exact-scale-down"
  })

  depends_on = [tencentcloud_kubernetes_auth_attachment.pod_workload_identity]

  lifecycle {
    prevent_destroy = true
  }
}

resource "tencentcloud_cam_role_policy_attachment" "runtime_exact_scale_down" {
  role_id   = tencentcloud_cam_role.runtime_exact_scale_down.id
  policy_id = tencentcloud_cam_policy.runtime_exact_scale_down.id

  lifecycle {
    prevent_destroy = true
  }
}

# The release Hook is not a cluster administrator. It may only submit a
# pre-approved immutable command to one exact Beijing builder and read that
# invocation's result. It cannot submit arbitrary RunCommand content. Command
# publication and the actor-release-approved tag are owned by a separate
# release-artifact identity.
resource "tencentcloud_cam_policy" "release_hook_exact_tat" {
  name        = "actor-bj-q01-release-hook-exact-tat"
  description = "Allow the q01 release Hook to invoke only its exact TAT builder."
  document = jsonencode({
    version = "2.0"
    statement = [
      {
        effect = "allow"
        action = [
          "name/tat:InvokeCommand",
          "name/tat:DescribeInvocationTasks",
        ]
        resource = [
          "qcs::cvm:${var.region}:uin/${data.tencentcloud_user_info.current.owner_uin}:instance/${var.release_builder_instance_id}",
        ]
      },
      {
        effect = "allow"
        action = [
          "name/tat:InvokeCommand",
          "name/tat:DescribeInvocationTasks",
        ]
        resource = [
          "qcs::tat:${var.region}:uin/${data.tencentcloud_user_info.current.owner_uin}:command/*",
        ]
        condition = {
          "for_any_value:string_equal" = {
            "qcs:resource_tag" = ["actor-release-approved&true"]
          }
        }
      },
    ]
  })

  tags = merge(local.common_tags, {
    role = "release-hook-exact-tat"
  })

  lifecycle {
    prevent_destroy = true
  }
}

resource "tencentcloud_cam_role" "release_hook_exact_tat" {
  name             = "actor-bj-q01-release-hook"
  description      = "OIDC identity for the q01 Argo transactional release Hook."
  console_login    = false
  session_duration = 7200
  document = jsonencode({
    version = "2.0"
    statement = [{
      effect = "allow"
      principal = {
        federated = ["qcs::cam::uin/${data.tencentcloud_user_info.current.owner_uin}:oidc-provider/${var.cluster_id}"]
      }
      action = ["name/sts:AssumeRoleWithWebIdentity"]
      condition = {
        string_equal = {
          "oidc:aud" = ["sts.cloud.tencent.com"]
          "oidc:sub" = ["system:serviceaccount:actor-release-system:actor-release-hook"]
        }
      }
    }]
  })

  tags = merge(local.common_tags, {
    role = "release-hook-exact-tat"
  })

  depends_on = [tencentcloud_kubernetes_auth_attachment.pod_workload_identity]

  lifecycle {
    prevent_destroy = true
  }
}

resource "tencentcloud_cam_role_policy_attachment" "release_hook_exact_tat" {
  role_id   = tencentcloud_cam_role.release_hook_exact_tat.id
  policy_id = tencentcloud_cam_policy.release_hook_exact_tat.id

  lifecycle {
    prevent_destroy = true
  }
}
