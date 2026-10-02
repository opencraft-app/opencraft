data "tencentcloud_user_info" "current" {}

data "tencentcloud_zones" "cvm" {
  product = "cvm"
}

data "terraform_remote_state" "foundation" {
  backend = "cos"
  config = {
    region  = var.region
    bucket  = var.terraform_state_bucket
    prefix  = var.foundation_state_prefix
    key     = "terraform.tfstate"
    encrypt = true
  }
}

data "terraform_remote_state" "management" {
  backend = "cos"
  config = {
    region  = var.region
    bucket  = var.terraform_state_bucket
    prefix  = var.management_state_prefix
    key     = "terraform.tfstate"
    encrypt = true
  }
}

data "tencentcloud_images" "node" {
  image_type       = ["PUBLIC_IMAGE"]
  image_name_regex = var.node_image_name_regex
}

locals {
  available_cvm_zones = toset([
    for zone in data.tencentcloud_zones.cvm.zone_list : zone.zone
    if zone.zone_state == "AVAILABLE" && zone.zone_type == "availability-zone"
  ])
  cell_suffix      = trimprefix(var.cell_id, "actor-")
  bootstrap_subnet = var.subnets[var.bootstrap_subnet_key]
  node_image_id    = one(data.tencentcloud_images.node.images[*].image_id)
  registry         = data.terraform_remote_state.foundation.outputs.registry
  regional_network = data.terraform_remote_state.foundation.outputs.network
  management       = data.terraform_remote_state.management.outputs.management_inventory
  # C reaches each Cell's private Engine endpoint through the reviewed CCN
  # aggregate. Public and unrelated RFC1918 ranges remain excluded.
  node_ingress_cidrs = toset([var.vpc_cidr, var.cluster_pod_cidr, var.regional_vpc_aggregate])
  api_ingress_cidrs  = setunion(toset([var.vpc_cidr, local.management.network.vpcCidr]), var.trusted_api_cidrs)
  network_cidrs = merge(
    {
      aggregate     = var.regional_vpc_aggregate
      vpc           = var.vpc_cidr
      pod           = var.cluster_pod_cidr
      service       = var.cluster_service_cidr
      managementVpc = local.management.network.vpcCidr
      managementPod = local.management.network.podCidr
      managementSvc = local.management.network.serviceCidr
    },
    { for key, subnet in var.subnets : "subnet:${key}" => subnet.cidr_block },
    { for cidr in var.reserved_cidrs : "reserved:${cidr}" => cidr },
  )
  network_starts = {
    for name, cidr in local.network_cidrs : name => sum([
      for index, octet in split(".", cidrhost(cidr, 0)) : parseint(octet, 10) * pow(256, 3 - index)
    ])
  }
  network_ends = {
    for name, cidr in local.network_cidrs : name => local.network_starts[name] + pow(2, 32 - parseint(split("/", cidr)[1], 10)) - 1
  }
  planned_range_names    = ["vpc", "pod", "service"]
  subnet_range_names     = [for key in keys(var.subnets) : "subnet:${key}"]
  reserved_range_names   = [for cidr in var.reserved_cidrs : "reserved:${cidr}"]
  management_range_names = ["managementVpc", "managementPod", "managementSvc"]
  bucket_names = {
    cold     = "actor-depot-cold-${var.environment}-${local.cell_suffix}-nv1-${var.account_app_id}"
    backup   = "actor-fdb-backup-${var.environment}-${local.cell_suffix}-nv1-${var.account_app_id}"
    code     = "actor-worker-code-${var.environment}-${local.cell_suffix}-nv1-${var.account_app_id}"
    relay    = "actor-build-relay-${var.environment}-${local.cell_suffix}-nv1-${var.account_app_id}"
    evidence = "actor-qualification-evidence-${var.environment}-${local.cell_suffix}-nv1-${var.account_app_id}"
  }
  tags = merge({
    product     = "actor-serverless"
    cell        = var.cell_id
    environment = var.environment
    managed-by  = "terraform"
  }, var.tags)
}

check "bootstrap_subnet_exists" {
  assert {
    condition     = contains(keys(var.subnets), var.bootstrap_subnet_key)
    error_message = "bootstrap_subnet_key must select one entry from subnets."
  }
}

check "availability_mode_matches_subnets" {
  assert {
    condition = (
      var.availability_mode == "production-multi-zone" ?
      length(distinct([for subnet in values(var.subnets) : subnet.availability_zone])) == 3 :
      length(distinct([for subnet in values(var.subnets) : subnet.availability_zone])) == 1
    )
    error_message = "production-multi-zone requires three AZs; qualification-single-zone requires exactly one AZ."
  }
}

check "node_image_is_unambiguous" {
  assert {
    condition     = length(data.tencentcloud_images.node.images) == 1
    error_message = "node_image_name_regex must resolve to exactly one public image."
  }
}

check "network_ranges_are_distinct" {
  assert {
    condition = (
      local.network_starts.aggregate <= local.network_starts.vpc &&
      local.network_ends.aggregate >= local.network_ends.vpc &&
      alltrue([
        for left_index, left in local.planned_range_names : alltrue([
          for right_index, right in local.planned_range_names :
          left_index >= right_index || local.network_ends[left] < local.network_starts[right] || local.network_ends[right] < local.network_starts[left]
        ])
      ]) &&
      alltrue([
        for subnet in local.subnet_range_names :
        local.network_starts.vpc <= local.network_starts[subnet] && local.network_ends.vpc >= local.network_ends[subnet]
      ]) &&
      alltrue(flatten([
        for planned in local.planned_range_names : [
          for reserved in local.reserved_range_names :
          local.network_ends[planned] < local.network_starts[reserved] || local.network_ends[reserved] < local.network_starts[planned]
        ]
      ]))
    )
    error_message = "VPC must be in the regional aggregate; subnets must be inside it; VPC/Pod/Service ranges must be distinct and avoid reserved CIDRs."
  }
}

check "management_contract_matches" {
  assert {
    condition = (
      local.management.region == var.region &&
      local.management.network.ccnId == local.regional_network.ccn_id &&
      alltrue(flatten([
        for planned in local.planned_range_names : [
          for management in local.management_range_names :
          local.network_ends[planned] < local.network_starts[management] || local.network_ends[management] < local.network_starts[planned]
        ]
      ]))
    )
    error_message = "management and Cell must use the same regional CCN and non-overlapping VPC/Pod/Service CIDRs."
  }
}

resource "tencentcloud_vpc" "cell" {
  name       = "${var.cell_id}-vpc"
  cidr_block = var.vpc_cidr
  tags       = local.tags

  lifecycle {
    precondition {
      condition = (
        length(local.available_cvm_zones) >= (var.availability_mode == "production-multi-zone" ? 3 : 1) &&
        alltrue([for subnet in values(var.subnets) : contains(local.available_cvm_zones, subnet.availability_zone)])
      )
      error_message = "Live CVM zone availability does not satisfy the Cell availability mode or selected subnet zones."
    }
  }
}

resource "tencentcloud_subnet" "cell" {
  for_each = var.subnets

  name              = "${var.cell_id}-${each.key}"
  vpc_id            = tencentcloud_vpc.cell.id
  availability_zone = each.value.availability_zone
  cidr_block        = each.value.cidr_block
  tags              = merge(local.tags, { zone = each.value.availability_zone })
}

resource "tencentcloud_security_group" "node" {
  name        = "${var.cell_id}-node"
  description = "Cell node and routed Pod traffic; no public ingress."
  tags        = local.tags
}

resource "tencentcloud_security_group_rule" "node_ingress" {
  for_each = local.node_ingress_cidrs

  security_group_id = tencentcloud_security_group.node.id
  type              = "ingress"
  cidr_ip           = each.value
  ip_protocol       = "ALL"
  policy            = "ACCEPT"
  description       = "Cell-internal node or routed Pod traffic"
}

resource "tencentcloud_security_group_rule" "node_egress" {
  security_group_id = tencentcloud_security_group.node.id
  type              = "egress"
  cidr_ip           = "0.0.0.0/0"
  ip_protocol       = "ALL"
  policy            = "ACCEPT"
  description       = "Outbound package, Tencent API, TCR and COS access"
}

resource "tencentcloud_security_group" "api" {
  name        = "${var.cell_id}-tke-api"
  description = "Private TKE API ingress from the Cell and reviewed management CIDRs."
  tags        = local.tags
}

resource "tencentcloud_security_group_rule" "api_ingress" {
  for_each = local.api_ingress_cidrs

  security_group_id = tencentcloud_security_group.api.id
  type              = "ingress"
  cidr_ip           = each.value
  ip_protocol       = "TCP"
  port_range        = "443"
  policy            = "ACCEPT"
  description       = "Private Kubernetes API"
}

resource "tencentcloud_security_group_rule" "api_egress" {
  security_group_id = tencentcloud_security_group.api.id
  type              = "egress"
  cidr_ip           = "0.0.0.0/0"
  ip_protocol       = "ALL"
  policy            = "ACCEPT"
  description       = "Managed API endpoint return traffic"
}

resource "tencentcloud_key_pair" "cell" {
  key_name   = "${replace(var.cell_id, "-", "_")}_operator"
  public_key = trimspace(var.ssh_public_key)
  tags       = local.tags
}

resource "tencentcloud_kubernetes_cluster" "cell" {
  cluster_name                 = var.cell_id
  cluster_desc                 = "Actor serverless Cell ${var.cell_id}."
  cluster_os                   = var.cluster_os
  cluster_deploy_type          = "MANAGED_CLUSTER"
  cluster_version              = var.cluster_version
  cluster_level                = var.cluster_level
  auto_upgrade_cluster_level   = false
  container_runtime            = "containerd"
  network_type                 = "GR"
  vpc_id                       = tencentcloud_vpc.cell.id
  cluster_cidr                 = var.cluster_pod_cidr
  service_cidr                 = var.cluster_service_cidr
  cluster_max_pod_num          = 64
  cluster_max_service_num      = 1024
  ignore_cluster_cidr_conflict = false
  ignore_service_cidr_conflict = false
  cluster_ipvs                 = true
  node_name_type               = "lan-ip"
  deletion_protection          = var.deletion_protection
  project_id                   = 0
  tags                         = local.tags

  # Native NodePools have independent min/max bounds, while scale-in remains
  # a cluster-wide TKE policy. Keep removals serial so one bad eviction or
  # readiness transition cannot turn an ordinary trough into a fleet event.
  node_pool_global_config {
    is_scale_in_enabled            = true
    expander                       = "least-waste"
    max_concurrent_scale_in        = 1
    scale_in_delay                 = 10
    scale_in_unneeded_time         = 10
    scale_in_utilization_threshold = 50
    ignore_daemon_sets_utilization = true
    skip_nodes_with_local_storage  = true
    skip_nodes_with_system_pods    = true
  }
}

# One Terraform-owned worker breaks the empty-cluster/private-endpoint cycle and
# is also the TAT build/operator host. MachineSet YAML remains the sole owner of
# elastic control, FDB and runtime capacity.
resource "tencentcloud_instance" "bootstrap" {
  instance_name              = "${var.cell_id}-bootstrap"
  availability_zone          = local.bootstrap_subnet.availability_zone
  image_id                   = local.node_image_id
  instance_type              = var.bootstrap_instance_type
  instance_charge_type       = "POSTPAID_BY_HOUR"
  vpc_id                     = tencentcloud_vpc.cell.id
  subnet_id                  = tencentcloud_subnet.cell[var.bootstrap_subnet_key].id
  orderly_security_groups    = [tencentcloud_security_group.node.id]
  key_ids                    = [tencentcloud_key_pair.cell.id]
  allocate_public_ip         = false
  internet_max_bandwidth_out = 0
  system_disk_type           = "CLOUD_BSSD"
  system_disk_size           = 100
  disable_api_termination    = var.deletion_protection
  tags                       = merge(local.tags, { role = "bootstrap-builder" })
}

resource "tencentcloud_kubernetes_cluster_attachment" "bootstrap" {
  cluster_id      = tencentcloud_kubernetes_cluster.cell.id
  instance_id     = tencentcloud_instance.bootstrap.id
  key_ids         = [tencentcloud_key_pair.cell.id]
  security_groups = [tencentcloud_security_group.node.id]
  unschedulable   = 0
  labels = {
    "fleet.actor.dev/cell-name" = var.cell_id
    "fleet.actor.dev/bootstrap" = "true"
  }

  worker_config {
    desired_pod_num = 64
  }
}

resource "tencentcloud_kubernetes_cluster_endpoint" "private" {
  cluster_id                      = tencentcloud_kubernetes_cluster.cell.id
  cluster_internet                = false
  cluster_intranet                = true
  cluster_intranet_subnet_id      = tencentcloud_subnet.cell[var.bootstrap_subnet_key].id
  cluster_intranet_security_group = tencentcloud_security_group.api.id

  depends_on = [tencentcloud_kubernetes_cluster_attachment.bootstrap]
}

# NetworkPolicy objects are inert without the TKE controller. Install and pin
# it as infrastructure state before any platform manifest relies on isolation.
resource "tencentcloud_kubernetes_addon" "network_policy" {
  cluster_id    = tencentcloud_kubernetes_cluster.cell.id
  addon_name    = "networkpolicy"
  addon_version = var.network_policy_addon_version
  raw_values = jsonencode({
    global = {
      cluster = {
        clusterCidr      = var.cluster_pod_cidr
        highAvailability = true
        serviceCidr      = var.cluster_service_cidr
        networkType      = "GR"
      }
    }
  })

  depends_on = [tencentcloud_kubernetes_cluster_endpoint.private]
}

data "tencentcloud_kubernetes_addons" "cluster_autoscaler" {
  cluster_id = tencentcloud_kubernetes_cluster.cell.id
  addon_name = "cluster-autoscaler"

  depends_on = [tencentcloud_kubernetes_cluster_endpoint.private]
}

locals {
  cluster_autoscaler_observed = jsondecode(data.tencentcloud_kubernetes_addons.cluster_autoscaler.addons[0].decode_values)
}

# TKE installs cluster-autoscaler as a built-in addon, but its default
# max-nodes-total is only 20. That silently prevents an otherwise healthy
# Native NodePool from reacting to Pending Pods once fixed/FDB/runtime nodes
# consume the allowance. Own the complete reviewed config through the
# provider's built-in-addon configuration resource so rebuilds cannot regress
# to that account default.
resource "tencentcloud_kubernetes_addon_config" "cluster_autoscaler" {
  cluster_id    = tencentcloud_kubernetes_cluster.cell.id
  addon_name    = "cluster-autoscaler"
  addon_version = var.cluster_autoscaler_addon_version
  raw_values = jsonencode({
    autoDiscovery = {
      labels = [{ "node.tke.cloud.tencent.com/autoscaling-enabled" = "true" }]
    }
    extraArgs = {
      expander                         = "least-waste"
      ignore-daemonsets-utilization    = true
      ignore-taint_1                   = "tke.cloud.tencent.com/direct-eni-unavailable"
      ignore-taint_2                   = "tke.cloud.tencent.com/eni-ip-unavailable"
      ignore-taint_3                   = "tke.cloud.tencent.com/uninitialized"
      ignore-taint_4                   = "tke.cloud.tencent.com/no-aia-ip"
      max-empty-bulk-delete            = 1
      max-nodes-total                  = var.cluster_autoscaler_max_nodes_total
      max-total-unready-percentage     = 33
      ok-total-unready-count           = 3
      scale-down-delay-after-add       = "10m"
      scale-down-enabled               = true
      scale-down-unneeded-time         = "10m"
      scale-down-unready-time          = "20m"
      scale-down-utilization-threshold = 0.5
      skip-nodes-with-local-storage    = true
      skip-nodes-with-system-pods      = true
    }
    global = {
      cluster = {
        # UpdateAddon rewrites this server-owned restart token on every
        # request. Preserve the observed value so Terraform still repairs all
        # owned keys without creating an endless one-field update loop.
        haRestartAt      = try(local.cluster_autoscaler_observed.global.cluster.haRestartAt, "0")
        highAvailability = true
      }
    }
    image = { repository = "ccr.ccs.tencentyun.com/tkeimages/cluster-autoscaler" }
    resources = {
      limits   = { cpu = "2", memory = "4Gi" }
      requests = { cpu = "200m", memory = "256Mi" }
    }
  })

  depends_on = [tencentcloud_kubernetes_cluster_endpoint.private]
}

# Cluster Autoscaler discovers only Native NodePools registered through the
# TKE control-plane API. A MachineSet applied directly through Kubernetes may
# create Machines, but its scaling bounds do not imply EnableAutoscaling and
# it is absent from DescribeNodePools. Terraform therefore owns this cloud
# resource; Argo owns only the workloads that select its generated np-* ID.
resource "tencentcloud_kubernetes_native_node_pool" "stateless" {
  cluster_id = tencentcloud_kubernetes_cluster.cell.id
  name       = "${var.cell_id}-stateless"
  type       = "Native"

  labels {
    name  = "fleet.actor.dev/cell"
    value = var.cell_id
  }
  labels {
    name  = "fleet.actor.dev/cell-name"
    value = var.cell_id
  }
  labels {
    name  = "fleet.actor.dev/stateless-pool"
    value = "true"
  }
  labels {
    name  = "fleet.actor.dev/stateless-admitted"
    value = "true"
  }
  labels {
    name  = "rivet.dev/stateless"
    value = "true"
  }

  taints {
    key    = "rivet.dev/stateless"
    value  = "true"
    effect = "NoSchedule"
  }
  taints {
    # CA ignores this taint only in its future-node scheduling simulation. The
    # real Node retains it until the unprivileged admission probe succeeds.
    key    = "startup-taint.cluster-autoscaler.kubernetes.io/stateless-admission"
    value  = "pending"
    effect = "NoSchedule"
  }

  tags {
    resource_type = "machine"
    dynamic "tags" {
      for_each = local.tags
      content {
        key   = tags.key
        value = tags.value
      }
    }
  }

  deletion_protection = var.deletion_protection
  unschedulable       = false

  native {
    scaling {
      min_replicas  = var.stateless_node_pool.min_replicas
      max_replicas  = var.stateless_node_pool.max_replicas
      create_policy = "ZoneEquality"
    }
    subnet_ids           = [for key in sort(keys(tencentcloud_subnet.cell)) : tencentcloud_subnet.cell[key].id]
    instance_charge_type = "POSTPAID_BY_HOUR"
    system_disk {
      disk_type = "CLOUD_SSD"
      disk_size = 100
    }
    instance_types     = var.stateless_node_pool.instance_types
    security_group_ids = [tencentcloud_security_group.node.id]
    auto_repair        = false
    runtime_root_dir   = "/var/lib/containerd"
    enable_autoscaling = true
    replicas           = var.stateless_node_pool.replicas
    key_ids            = [tencentcloud_key_pair.cell.id]
  }

  # replicas is the creation seed only. The provider reads the live desired
  # count back into this field after Cluster Autoscaler changes it; ignoring
  # that one leaf prevents a later infrastructure apply from scaling a healthy
  # pool back to its bootstrap count. min/max remain Terraform-owned.
  lifecycle {
    ignore_changes = [native[0].replicas]
  }

  depends_on = [
    tencentcloud_kubernetes_cluster_attachment.bootstrap,
    tencentcloud_kubernetes_addon_config.cluster_autoscaler,
  ]
}

resource "tencentcloud_tcr_vpc_attachment" "cell" {
  instance_id = local.registry.id
  vpc_id      = tencentcloud_vpc.cell.id
  subnet_id   = tencentcloud_subnet.cell[var.bootstrap_subnet_key].id
  region_name = var.region
  # Resolve the canonical inventory hostname to this Cell's private endpoint;
  # public TCR operation remains disabled at the instance boundary.
  enable_public_domain_dns = true
  enable_vpc_domain_dns    = true
}

resource "tencentcloud_ccn_attachment_v2" "cell" {
  ccn_id          = local.regional_network.ccn_id
  instance_id     = tencentcloud_vpc.cell.id
  instance_type   = "VPC"
  instance_region = var.region
  description     = "Actor Cell ${var.cell_id} VPC"
}

resource "tencentcloud_cos_bucket" "storage" {
  for_each = local.bucket_names

  bucket               = each.value
  acl                  = "private"
  encryption_algorithm = "AES256"
  force_clean          = false
  tags = merge(local.tags, {
    role       = each.key
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
}

# FDB backup and Depot cold storage use independent, Cell-scoped identities.
# Their long-lived keys are bootstrap material stored only in encrypted
# Terraform state and the sensitive bootstrap output; neither identity can
# access another Cell or the Cell's code/relay/evidence buckets.
locals {
  data_plane_storage = {
    cold = {
      bucket = tencentcloud_cos_bucket.storage["cold"].bucket
      actions = [
        "name/cos:GetBucket",
        "name/cos:ListMultipartUploads",
        "name/cos:GetObject",
        "name/cos:HeadObject",
        "name/cos:ListParts",
        "name/cos:PutObject",
        "name/cos:InitiateMultipartUpload",
        "name/cos:UploadPart",
        "name/cos:UploadPartCopy",
        "name/cos:CompleteMultipartUpload",
        "name/cos:AbortMultipartUpload",
        "name/cos:DeleteObject",
        "name/cos:DeleteMultipleObjects",
      ]
    }
    backup = {
      bucket = tencentcloud_cos_bucket.storage["backup"].bucket
      actions = [
        "name/cos:GetBucket",
        "name/cos:ListMultipartUploads",
        "name/cos:GetObject",
        "name/cos:HeadObject",
        "name/cos:ListParts",
        "name/cos:PutObject",
        "name/cos:InitiateMultipartUpload",
        "name/cos:UploadPart",
        "name/cos:UploadPartCopy",
        "name/cos:CompleteMultipartUpload",
        "name/cos:AbortMultipartUpload",
        "name/cos:DeleteObject",
        "name/cos:DeleteMultipleObjects",
      ]
    }
  }
}

resource "tencentcloud_cam_user" "data_plane_storage" {
  for_each = var.storage_identity_mode == "dedicated-users" ? local.data_plane_storage : {}

  name          = "${var.cell_id}-${each.key}-storage"
  remark        = "Cell-scoped ${each.key} object data plane for ${var.cell_id}."
  console_login = false
  use_api       = true
  force_delete  = true
  tags          = merge(local.tags, { role = "${each.key}-storage" })
}

resource "tencentcloud_cam_policy" "data_plane_storage" {
  for_each = var.storage_identity_mode == "dedicated-users" ? local.data_plane_storage : {}

  name        = "${var.cell_id}-${each.key}-storage"
  description = "Read/write/delete only ${each.value.bucket}."
  document = jsonencode({
    version = "2.0"
    statement = [{
      effect = "allow"
      action = each.value.actions
      resource = [
        "qcs::cos:${var.region}:uid/${var.account_app_id}:${each.value.bucket}",
        "qcs::cos:${var.region}:uid/${var.account_app_id}:${each.value.bucket}/*",
      ]
    }]
  })
  tags = merge(local.tags, { role = "${each.key}-storage" })
}

resource "tencentcloud_cam_user_policy_attachment" "data_plane_storage" {
  for_each = var.storage_identity_mode == "dedicated-users" ? local.data_plane_storage : {}

  user_name = tencentcloud_cam_user.data_plane_storage[each.key].id
  policy_id = tencentcloud_cam_policy.data_plane_storage[each.key].id
}

resource "tencentcloud_kubernetes_auth_attachment" "pod_workload_identity" {
  cluster_id                              = tencentcloud_kubernetes_cluster.cell.id
  use_tke_default                         = true
  auto_create_discovery_anonymous_auth    = true
  auto_create_oidc_config                 = true
  auto_create_client_id                   = ["sts.cloud.tencent.com"]
  auto_install_pod_identity_webhook_addon = true

  lifecycle {
    precondition {
      condition     = try(local.regional_network.tke_oidc_config_ready, false)
      error_message = "foundation must own and attach the account-scoped TKE OIDC policy before a Cell configures workload identity."
    }
  }
}

resource "tencentcloud_cam_policy" "runtime_exact_scale_down" {
  name        = "${var.cell_id}-runtime-exact-scale-down"
  description = "Delete only exact native Machines from ${var.cell_id}."
  document = jsonencode({
    version = "2.0"
    statement = [{
      effect   = "allow"
      action   = ["name/tke:DeleteClusterMachines"]
      resource = ["qcs::tke:${var.region}:uin/${data.tencentcloud_user_info.current.owner_uin}:cluster/${tencentcloud_kubernetes_cluster.cell.id}"]
    }]
  })
  tags = local.tags
}

resource "tencentcloud_cam_role" "runtime_exact_scale_down" {
  name             = "${var.cell_id}-runtime-scale-down"
  description      = "OIDC identity for exact runtime Machine deletion in ${var.cell_id}."
  console_login    = false
  session_duration = 7200
  document = jsonencode({
    version = "2.0"
    statement = [{
      effect = "allow"
      principal = {
        federated = ["qcs::cam::uin/${data.tencentcloud_user_info.current.owner_uin}:oidc-provider/${tencentcloud_kubernetes_cluster.cell.id}"]
      }
      action = ["name/sts:AssumeRoleWithWebIdentity"]
      condition = {
        string_equal = {
          "oidc:aud" = ["sts.cloud.tencent.com"]
          "oidc:sub" = ["system:serviceaccount:actor-fdb-cell-system:${var.cell_id}-runtime-capacity"]
        }
      }
    }]
  })
  tags       = local.tags
  depends_on = [tencentcloud_kubernetes_auth_attachment.pod_workload_identity]
}

resource "tencentcloud_cam_role_policy_attachment" "runtime_exact_scale_down" {
  role_id   = tencentcloud_cam_role.runtime_exact_scale_down.id
  policy_id = tencentcloud_cam_policy.runtime_exact_scale_down.id
}

resource "tencentcloud_cam_policy" "release_hook_exact_tat" {
  name        = "${var.cell_id}-release-hook-exact-tat"
  description = "Invoke only approved release commands on the exact Cell builder."
  document = jsonencode({
    version = "2.0"
    statement = [
      {
        effect   = "allow"
        action   = ["name/tat:InvokeCommand", "name/tat:DescribeInvocationTasks"]
        resource = ["qcs::cvm:${var.region}:uin/${data.tencentcloud_user_info.current.owner_uin}:instance/${tencentcloud_instance.bootstrap.id}"]
      },
      {
        effect   = "allow"
        action   = ["name/tat:InvokeCommand", "name/tat:DescribeInvocationTasks"]
        resource = ["qcs::tat:${var.region}:uin/${data.tencentcloud_user_info.current.owner_uin}:command/*"]
        condition = {
          "for_any_value:string_equal" = {
            "qcs:resource_tag" = ["actor-release-approved&true"]
          }
        }
      },
    ]
  })
  tags = local.tags
}

resource "tencentcloud_cam_role" "release_hook_exact_tat" {
  name             = "${var.cell_id}-release-hook"
  description      = "OIDC identity for the ${var.cell_id} transactional release Hook."
  console_login    = false
  session_duration = 7200
  document = jsonencode({
    version = "2.0"
    statement = [{
      effect = "allow"
      principal = {
        federated = ["qcs::cam::uin/${data.tencentcloud_user_info.current.owner_uin}:oidc-provider/${tencentcloud_kubernetes_cluster.cell.id}"]
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
  tags       = local.tags
  depends_on = [tencentcloud_kubernetes_auth_attachment.pod_workload_identity]
}

resource "tencentcloud_cam_role_policy_attachment" "release_hook_exact_tat" {
  role_id   = tencentcloud_cam_role.release_hook_exact_tat.id
  policy_id = tencentcloud_cam_policy.release_hook_exact_tat.id
}

locals {
  cell_inventory = {
    schemaVersion    = 1
    cellId           = var.cell_id
    environment      = var.environment
    region           = var.region
    availabilityMode = var.availability_mode
    fleet = {
      poolName       = var.fleet_binding.pool_name
      poolUid        = var.fleet_binding.pool_uid
      claimName      = var.fleet_binding.claim_name
      claimUid       = var.fleet_binding.claim_uid
      className      = var.fleet_binding.class_name
      datacenterName = var.fleet_binding.datacenter_name
      scaleOutEpoch  = var.fleet_binding.scale_out_epoch
      profileDigest  = var.fleet_binding.profile_digest
    }
    network = {
      ccnId             = local.regional_network.ccn_id
      ccnAttachmentId   = tencentcloud_ccn_attachment_v2.cell.id
      vpcId             = tencentcloud_vpc.cell.id
      vpcCidr           = var.vpc_cidr
      nodeSecurityGroup = tencentcloud_security_group.node.id
      apiSecurityGroup  = tencentcloud_security_group.api.id
      podCidr           = var.cluster_pod_cidr
      serviceCidr       = var.cluster_service_cidr
      subnets = {
        for key, subnet in tencentcloud_subnet.cell : key => {
          id   = subnet.id
          zone = var.subnets[key].availability_zone
          cidr = var.subnets[key].cidr_block
        }
      }
    }
    management = {
      managementId = local.management.managementId
      clusterId    = local.management.kubernetes.clusterId
      vpcId        = local.management.network.vpcId
      vpcCidr      = local.management.network.vpcCidr
    }
    kubernetes = {
      clusterId      = tencentcloud_kubernetes_cluster.cell.id
      clusterName    = tencentcloud_kubernetes_cluster.cell.cluster_name
      clusterVersion = var.cluster_version
      # The provider's cluster_intranet_domain may be empty for PGW endpoints.
      # Extract only the non-secret server URL from the generated kubeconfig;
      # certificate and client credentials remain in sensitive_bootstrap.
      privateEndpoint = nonsensitive(
        yamldecode(tencentcloud_kubernetes_cluster_endpoint.private.kube_config_intranet).clusters[0].cluster.server
      )
      bootstrapInstanceId = tencentcloud_instance.bootstrap.id
      operatorKeyId       = tencentcloud_key_pair.cell.id
      statelessNodePoolId = split("#", tencentcloud_kubernetes_native_node_pool.stateless.id)[1]
      clusterAutoscaler = {
        addonVersion  = var.cluster_autoscaler_addon_version
        maxNodesTotal = var.cluster_autoscaler_max_nodes_total
      }
      networkPolicy = {
        addonName    = "networkpolicy"
        addonVersion = var.network_policy_addon_version
        controller   = "kube-system/networkpolicy"
      }
    }
    registry = {
      id        = local.registry.id
      host      = local.registry.host
      namespace = local.registry.namespace
      accessIp  = tencentcloud_tcr_vpc_attachment.cell.access_ip
    }
    storage = {
      for role, bucket in tencentcloud_cos_bucket.storage : role => bucket.bucket
    }
    identity = {
      runtimeScaleDownRole = tencentcloud_cam_role.runtime_exact_scale_down.name
      releaseHookRole      = tencentcloud_cam_role.release_hook_exact_tat.name
      coldStorageUser = var.storage_identity_mode == "dedicated-users" ? (
        tencentcloud_cam_user.data_plane_storage["cold"].name
      ) : "root-account-shared"
      backupStorageUser = var.storage_identity_mode == "dedicated-users" ? (
        tencentcloud_cam_user.data_plane_storage["backup"].name
      ) : "root-account-shared"
    }
  }
}
