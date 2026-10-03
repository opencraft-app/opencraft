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

data "tencentcloud_images" "node" {
  image_type       = ["PUBLIC_IMAGE"]
  image_name_regex = var.node_image_name_regex
}

data "tencentcloud_zones" "cvm" {
  product = "cvm"
}

locals {
  available_cvm_zones = toset([
    for zone in data.tencentcloud_zones.cvm.zone_list : zone.zone
    if zone.zone_state == "AVAILABLE" && zone.zone_type == "availability-zone"
  ])
  management_suffix = trimprefix(var.management_id, "actor-")
  bootstrap_subnet  = var.subnets[var.bootstrap_subnet_key]
  ha_worker_subnets = { for key, subnet in var.subnets : key => subnet if key != var.bootstrap_subnet_key }
  node_image_id     = one(data.tencentcloud_images.node.images[*].image_id)
  registry          = data.terraform_remote_state.foundation.outputs.registry
  regional_network  = data.terraform_remote_state.foundation.outputs.network
  code_plane_bucket_names = {
    backup   = "actor-fdb-backup-prod-${local.management_suffix}-nv1-${var.account_app_id}"
    code     = "actor-worker-code-prod-${local.management_suffix}-nv1-${var.account_app_id}"
    evidence = "actor-qualification-evidence-prod-${local.management_suffix}-nv1-${var.account_app_id}"
  }
  # Runtime Cells reach regional C services through CCN. Keep the current VPC
  # rule explicit and admit the reviewed regional VPC aggregate; public and
  # unrelated RFC1918 ranges remain outside this security group contract.
  node_ingress_cidrs = toset([var.vpc_cidr, var.cluster_pod_cidr, var.regional_vpc_aggregate])
  api_ingress_cidrs  = setunion(toset([var.vpc_cidr]), var.trusted_api_cidrs)
  workers_api_ingress_cidrs = setunion(
    toset([var.vpc_cidr]),
    var.trusted_workers_api_cidrs,
  )
  object_router_ingress_cidrs = toset([var.regional_vpc_aggregate])
  # Runtime Hosts fetch immutable Worker versions from the regional Registry.
  # The Registry CLB admits only VPCs inside the reviewed regional aggregate;
  # untrusted guest code has no direct network path to this endpoint.
  worker_registry_ingress_cidrs = toset([var.regional_vpc_aggregate])
  network_cidrs = merge(
    {
      aggregate = var.regional_vpc_aggregate
      vpc       = var.vpc_cidr
      pod       = var.cluster_pod_cidr
      service   = var.cluster_service_cidr
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
  planned_range_names  = ["vpc", "pod", "service"]
  subnet_range_names   = [for key in keys(var.subnets) : "subnet:${key}"]
  reserved_range_names = [for cidr in var.reserved_cidrs : "reserved:${cidr}"]
  tags = merge({
    product    = "actor-serverless"
    cluster    = var.management_id
    role       = "regional-management"
    managed-by = "terraform"
  }, var.tags)
}

# The bootstrap CVM has no public IP. Source bundles and one-shot protected
# inputs cross that boundary through short-lived presigned COS objects rather
# than TAT command chunks. The relay is not a durable data or state store.
resource "tencentcloud_cos_bucket" "bootstrap_relay" {
  bucket               = "actor-bootstrap-relay-${local.management_suffix}-nv1-${var.account_app_id}"
  acl                  = "private"
  encryption_algorithm = "AES256"
  force_clean          = false
  tags = merge(local.tags, {
    role       = "bootstrap-relay"
    versioning = "never-enabled"
  })

  lifecycle_rules {
    id            = "expire-bootstrap-relay-after-one-day"
    filter_prefix = "relay/"
    expiration {
      days = 1
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }
}

# Regional Worker code and code-plane FDB backups belong to C, not to any
# runtime Cell. Both buckets deliberately remain versioning NeverEnabled: the
# Registry publishes immutable content-addressed objects, while FDB backup
# manages its own mutation log and snapshot retention protocol.
resource "tencentcloud_cos_bucket" "code_plane" {
  for_each = local.code_plane_bucket_names

  bucket               = each.value
  acl                  = "private"
  encryption_algorithm = "AES256"
  force_clean          = false
  tags = merge(local.tags, {
    role       = "code-plane-${each.key}"
    versioning = "never-enabled"
  })
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

resource "tencentcloud_vpc" "management" {
  name       = "${var.management_id}-vpc"
  cidr_block = var.vpc_cidr
  tags       = local.tags

  lifecycle {
    precondition {
      condition = (
        length(local.available_cvm_zones) >= (var.availability_mode == "production-multi-zone" ? 3 : 1) &&
        alltrue([for subnet in values(var.subnets) : contains(local.available_cvm_zones, subnet.availability_zone)])
      )
      error_message = "Live CVM zone availability does not satisfy the management availability mode or selected subnet zones."
    }
  }
}

resource "tencentcloud_subnet" "management" {
  for_each = var.subnets

  name              = "${var.management_id}-${each.key}"
  vpc_id            = tencentcloud_vpc.management.id
  availability_zone = each.value.availability_zone
  cidr_block        = each.value.cidr_block
  tags              = merge(local.tags, { zone = each.value.availability_zone })
}

resource "tencentcloud_security_group" "node" {
  name        = "${var.management_id}-node"
  description = "Management node traffic; no public ingress."
  tags        = local.tags
}

resource "tencentcloud_security_group_rule" "node_ingress" {
  for_each = local.node_ingress_cidrs

  security_group_id = tencentcloud_security_group.node.id
  type              = "ingress"
  cidr_ip           = each.value
  ip_protocol       = "ALL"
  policy            = "ACCEPT"
  description       = "Management-cluster node or routed Pod traffic"
}

resource "tencentcloud_security_group_rule" "node_egress" {
  security_group_id = tencentcloud_security_group.node.id
  type              = "egress"
  cidr_ip           = "0.0.0.0/0"
  ip_protocol       = "ALL"
  policy            = "ACCEPT"
  description       = "Outbound Tencent API, TCR, COS, Git and Cell access"
}

resource "tencentcloud_security_group" "api" {
  name        = "${var.management_id}-tke-api"
  description = "Private management TKE API ingress."
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

# This group is attached to the private Workers API CLB by the TKE Service
# controller. It is intentionally narrower than the management-node group:
# Cells share regional CCN reachability but must not acquire management API
# ingress merely because their VPC is routable.
resource "tencentcloud_security_group" "workers_api" {
  name        = "${var.management_id}-workers-api"
  description = "Private Workers API ingress from C and reviewed operator networks only."
  tags        = merge(local.tags, { role = "workers-api-ingress" })
}

resource "tencentcloud_security_group_rule" "workers_api_ingress" {
  for_each = local.workers_api_ingress_cidrs

  security_group_id = tencentcloud_security_group.workers_api.id
  type              = "ingress"
  cidr_ip           = each.value
  ip_protocol       = "TCP"
  port_range        = "6688"
  policy            = "ACCEPT"
  description       = "Private Workers API"
}

resource "tencentcloud_security_group_rule" "workers_api_egress" {
  security_group_id = tencentcloud_security_group.workers_api.id
  type              = "egress"
  cidr_ip           = var.vpc_cidr
  ip_protocol       = "ALL"
  policy            = "ACCEPT"
  description       = "Workers API CLB backends in the management VPC"
}

# Runtime Cell hosts call this listener only for authenticated Durable Object
# routing. Reuse the Workers API CLB group, but isolate the trust domains by
# listener port: Cells receive 19085 only, while /v1 remains on 6688 and the
# Object Router CLB has no 6688 listener. This also avoids consuming one scarce
# regional security-group slot per management plane.
resource "tencentcloud_security_group_rule" "object_router_ingress" {
  for_each = local.object_router_ingress_cidrs

  security_group_id = tencentcloud_security_group.workers_api.id
  type              = "ingress"
  cidr_ip           = each.value
  ip_protocol       = "TCP"
  port_range        = "19085"
  policy            = "ACCEPT"
  description       = "Authenticated regional Object Router"
}

resource "tencentcloud_security_group" "worker_registry" {
  name        = "${var.management_id}-worker-registry"
  description = "Private regional Worker Registry ingress from admitted runtime VPCs."
  tags        = merge(local.tags, { role = "worker-registry-ingress" })
}

resource "tencentcloud_security_group_rule" "worker_registry_ingress" {
  for_each = local.worker_registry_ingress_cidrs

  security_group_id = tencentcloud_security_group.worker_registry.id
  type              = "ingress"
  cidr_ip           = each.value
  ip_protocol       = "TCP"
  port_range        = "8080"
  policy            = "ACCEPT"
  description       = "Regional Worker code lookup"
}

resource "tencentcloud_security_group_rule" "worker_registry_egress" {
  security_group_id = tencentcloud_security_group.worker_registry.id
  type              = "egress"
  cidr_ip           = var.vpc_cidr
  ip_protocol       = "ALL"
  policy            = "ACCEPT"
  description       = "Worker Registry CLB backends in the management VPC"
}

# One regional group is attached to every Cell's private Prometheus federation
# CLB.  CCN supplies reachability, while this group makes C the only VPC that
# may scrape the bounded aggregate endpoint.  Kubernetes
# loadBalancerSourceRanges is retained as defense in depth but is not trusted
# as the cloud authorization boundary.
resource "tencentcloud_security_group" "federation" {
  name        = "${var.management_id}-prometheus-federation"
  description = "Private Cell federation ingress from the management VPC only."
  tags        = merge(local.tags, { role = "prometheus-federation-ingress" })
}

resource "tencentcloud_security_group_rule" "federation_ingress" {
  security_group_id = tencentcloud_security_group.federation.id
  type              = "ingress"
  cidr_ip           = var.vpc_cidr
  ip_protocol       = "TCP"
  port_range        = "9090"
  policy            = "ACCEPT"
  description       = "Hub Prometheus federation scrape"
}

resource "tencentcloud_security_group_rule" "federation_egress" {
  security_group_id = tencentcloud_security_group.federation.id
  type              = "egress"
  cidr_ip           = var.regional_vpc_aggregate
  ip_protocol       = "ALL"
  policy            = "ACCEPT"
  description       = "Federation CLB backends in regional Cells"
}

resource "tencentcloud_key_pair" "management" {
  key_name   = "${replace(var.management_id, "-", "_")}_operator"
  public_key = trimspace(var.ssh_public_key)
  tags       = local.tags
}

resource "tencentcloud_kubernetes_cluster" "management" {
  cluster_name                 = var.management_id
  cluster_desc                 = "Actor regional management cluster ${var.management_id}."
  cluster_os                   = var.cluster_os
  cluster_deploy_type          = "MANAGED_CLUSTER"
  cluster_version              = var.cluster_version
  cluster_level                = var.cluster_level
  auto_upgrade_cluster_level   = false
  container_runtime            = "containerd"
  network_type                 = "GR"
  vpc_id                       = tencentcloud_vpc.management.id
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
}

resource "tencentcloud_instance" "bootstrap" {
  instance_name              = "${var.management_id}-bootstrap"
  availability_zone          = local.bootstrap_subnet.availability_zone
  image_id                   = local.node_image_id
  instance_type              = var.bootstrap_instance_type
  instance_charge_type       = "POSTPAID_BY_HOUR"
  vpc_id                     = tencentcloud_vpc.management.id
  subnet_id                  = tencentcloud_subnet.management[var.bootstrap_subnet_key].id
  orderly_security_groups    = [tencentcloud_security_group.node.id]
  key_ids                    = [tencentcloud_key_pair.management.id]
  allocate_public_ip         = false
  internet_max_bandwidth_out = 0
  system_disk_type           = "CLOUD_BSSD"
  system_disk_size           = 100
  disable_api_termination    = var.deletion_protection
  # TKE propagates cluster tags onto attached CVMs and therefore owns the
  # shared `role` key. Node purpose remains explicit in Kubernetes labels.
  tags = local.tags
}

resource "tencentcloud_kubernetes_cluster_attachment" "bootstrap" {
  cluster_id      = tencentcloud_kubernetes_cluster.management.id
  instance_id     = tencentcloud_instance.bootstrap.id
  key_ids         = [tencentcloud_key_pair.management.id]
  security_groups = [tencentcloud_security_group.node.id]
  unschedulable   = 0
  labels = {
    "fleet.actor.dev/control-pool"         = "true"
    "fleet.actor.dev/management-bootstrap" = "true"
  }

  worker_config {
    desired_pod_num = 64
  }
}

# Argo CD's HA manifest has hard hostname anti-affinity for Redis, HAProxy,
# repo-server and API-server replicas. The create-first management cluster
# therefore starts with one schedulable worker in each of the three reviewed
# zones; the operator/bootstrap host is one of those workers, not extra hidden
# capacity.
resource "tencentcloud_instance" "ha_worker" {
  for_each = local.ha_worker_subnets

  instance_name              = "${var.management_id}-${each.key}"
  availability_zone          = each.value.availability_zone
  image_id                   = local.node_image_id
  instance_type              = var.bootstrap_instance_type
  instance_charge_type       = "POSTPAID_BY_HOUR"
  vpc_id                     = tencentcloud_vpc.management.id
  subnet_id                  = tencentcloud_subnet.management[each.key].id
  orderly_security_groups    = [tencentcloud_security_group.node.id]
  key_ids                    = [tencentcloud_key_pair.management.id]
  allocate_public_ip         = false
  internet_max_bandwidth_out = 0
  system_disk_type           = "CLOUD_BSSD"
  system_disk_size           = 100
  disable_api_termination    = var.deletion_protection
  tags                       = merge(local.tags, { zone = each.value.availability_zone })
}

resource "tencentcloud_kubernetes_cluster_attachment" "ha_worker" {
  for_each = tencentcloud_instance.ha_worker

  cluster_id      = tencentcloud_kubernetes_cluster.management.id
  instance_id     = each.value.id
  key_ids         = [tencentcloud_key_pair.management.id]
  security_groups = [tencentcloud_security_group.node.id]
  unschedulable   = 0
  labels = {
    "fleet.actor.dev/control-pool"  = "true"
    "fleet.actor.dev/management-ha" = "true"
  }

  worker_config {
    desired_pod_num = 64
  }
}

# Image compilation must not consume the nodefs, CPU or I/O budget that keeps
# Workers API, Argo and the HPA metrics pipeline available. This CVM is not a
# Kubernetes worker. Operations still run on bootstrap under the existing
# shared operation lock; a build host does not establish a second lock domain.
resource "tencentcloud_security_group" "runtime_builder" {
  name        = "${var.management_id}-runtime-builder"
  description = "Standalone runtime builder; TAT access only, no ingress rules."
  tags        = merge(local.tags, { role = "runtime-builder" })
}

resource "tencentcloud_security_group_rule" "runtime_builder_egress" {
  security_group_id = tencentcloud_security_group.runtime_builder.id
  type              = "egress"
  cidr_ip           = "0.0.0.0/0"
  ip_protocol       = "ALL"
  policy            = "ACCEPT"
  description       = "Outbound build dependencies, Tencent API, TCR and COS"
}

resource "tencentcloud_instance" "runtime_builder" {
  instance_name              = "${var.management_id}-runtime-builder"
  availability_zone          = local.bootstrap_subnet.availability_zone
  image_id                   = local.node_image_id
  instance_type              = var.runtime_builder_instance_type
  instance_charge_type       = "POSTPAID_BY_HOUR"
  vpc_id                     = tencentcloud_vpc.management.id
  subnet_id                  = tencentcloud_subnet.management[var.bootstrap_subnet_key].id
  orderly_security_groups    = [tencentcloud_security_group.runtime_builder.id]
  key_ids                    = [tencentcloud_key_pair.management.id]
  allocate_public_ip         = false
  internet_max_bandwidth_out = 0
  system_disk_type           = "CLOUD_BSSD"
  system_disk_size           = 100
  disable_api_termination    = var.deletion_protection
  tags                       = merge(local.tags, { role = "runtime-builder" })
}

# Separate resources expose the exact CBS identity for bootstrap validation.
# Do not choose a guest device by order or format an existing control-node disk.
resource "tencentcloud_cbs_storage" "runtime_builder" {
  storage_name      = "${var.management_id}-runtime-builder-data"
  storage_type      = "CLOUD_BSSD"
  storage_size      = var.runtime_builder_data_disk_gib
  availability_zone = local.bootstrap_subnet.availability_zone
  charge_type       = "POSTPAID_BY_HOUR"
  force_delete      = false
  tags              = merge(local.tags, { role = "runtime-builder-cache" })
}

resource "tencentcloud_cbs_storage_attachment" "runtime_builder" {
  storage_id  = tencentcloud_cbs_storage.runtime_builder.id
  instance_id = tencentcloud_instance.runtime_builder.id
}

resource "tencentcloud_kubernetes_cluster_endpoint" "private" {
  cluster_id                      = tencentcloud_kubernetes_cluster.management.id
  cluster_internet                = false
  cluster_intranet                = true
  cluster_intranet_subnet_id      = tencentcloud_subnet.management[var.bootstrap_subnet_key].id
  cluster_intranet_security_group = tencentcloud_security_group.api.id

  depends_on = [tencentcloud_kubernetes_cluster_attachment.bootstrap]
}

# The Kubernetes API stores NetworkPolicy resources even when no data-plane
# controller enforces them. Own the TKE controller explicitly so a clean-room
# rebuild cannot report false isolation merely because policy objects exist.
resource "tencentcloud_kubernetes_addon" "network_policy" {
  cluster_id    = tencentcloud_kubernetes_cluster.management.id
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

resource "tencentcloud_tcr_vpc_attachment" "management" {
  instance_id = local.registry.id
  vpc_id      = tencentcloud_vpc.management.id
  subnet_id   = tencentcloud_subnet.management[var.bootstrap_subnet_key].id
  region_name = var.region
  # Keep one canonical digest reference everywhere. Inside this VPC the
  # ordinary TCR hostname resolves to the private attachment IP while the
  # registry's public access remains closed.
  enable_public_domain_dns = true
  enable_vpc_domain_dns    = true
}

resource "tencentcloud_ccn_attachment_v2" "management" {
  ccn_id          = local.regional_network.ccn_id
  instance_id     = tencentcloud_vpc.management.id
  instance_type   = "VPC"
  instance_region = var.region
  description     = "Actor regional management VPC"
}

locals {
  management_inventory = {
    schemaVersion    = 1
    managementId     = var.management_id
    region           = var.region
    availabilityMode = var.availability_mode
    network = {
      ccnId                       = local.regional_network.ccn_id
      ccnAttachmentId             = tencentcloud_ccn_attachment_v2.management.id
      ccnRouteTableId             = tencentcloud_ccn_attachment_v2.management.route_table_id
      vpcId                       = tencentcloud_vpc.management.id
      vpcCidr                     = var.vpc_cidr
      regionalVpcAggregate        = var.regional_vpc_aggregate
      nodeSecurityGroup           = tencentcloud_security_group.node.id
      apiSecurityGroup            = tencentcloud_security_group.api.id
      workersApiSecurityGroup     = tencentcloud_security_group.workers_api.id
      objectRouterSecurityGroup   = tencentcloud_security_group.workers_api.id
      workerRegistrySecurityGroup = tencentcloud_security_group.worker_registry.id
      federationSecurityGroup     = tencentcloud_security_group.federation.id
      podCidr                     = var.cluster_pod_cidr
      serviceCidr                 = var.cluster_service_cidr
      subnets = {
        for key, subnet in tencentcloud_subnet.management : key => {
          id   = subnet.id
          zone = var.subnets[key].availability_zone
          cidr = var.subnets[key].cidr_block
        }
      }
    }
    kubernetes = {
      clusterId      = tencentcloud_kubernetes_cluster.management.id
      clusterName    = tencentcloud_kubernetes_cluster.management.cluster_name
      clusterVersion = var.cluster_version
      privateEndpoint = nonsensitive(
        yamldecode(tencentcloud_kubernetes_cluster_endpoint.private.kube_config_intranet).clusters[0].cluster.server
      )
      bootstrapInstanceId = tencentcloud_instance.bootstrap.id
      initialWorkerInstanceIds = concat(
        [tencentcloud_instance.bootstrap.id],
        [for key in sort(keys(tencentcloud_instance.ha_worker)) : tencentcloud_instance.ha_worker[key].id]
      )
      operatorKeyId = tencentcloud_key_pair.management.id
      networkPolicy = {
        addonName    = "networkpolicy"
        addonVersion = var.network_policy_addon_version
        controller   = "kube-system/networkpolicy"
      }
    }
    runtimeBuilder = {
      instanceId               = tencentcloud_instance.runtime_builder.id
      privateIp                = tencentcloud_instance.runtime_builder.private_ip
      availabilityZone         = local.bootstrap_subnet.availability_zone
      instanceType             = var.runtime_builder_instance_type
      attachedToKubernetes     = false
      operationsInstanceId     = tencentcloud_instance.bootstrap.id
      securityGroupId          = tencentcloud_security_group.runtime_builder.id
      dataDiskId               = tencentcloud_cbs_storage.runtime_builder.id
      dataDiskAttachmentId     = tencentcloud_cbs_storage_attachment.runtime_builder.id
      dataDiskGiB              = var.runtime_builder_data_disk_gib
      storageBootstrapRequired = true
    }
    registry = {
      id        = local.registry.id
      host      = local.registry.host
      namespace = local.registry.namespace
      accessIp  = tencentcloud_tcr_vpc_attachment.management.access_ip
    }
    storage = {
      codePlaneBackupBucket       = tencentcloud_cos_bucket.code_plane["backup"].bucket
      qualificationEvidenceBucket = tencentcloud_cos_bucket.code_plane["evidence"].bucket
      workerCodeBucket            = tencentcloud_cos_bucket.code_plane["code"].bucket
    }
  }
}
