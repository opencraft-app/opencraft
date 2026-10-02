locals {
  tags = merge({
    product    = "actor-serverless"
    role       = "regional-foundation"
    managed-by = "terraform"
  }, var.tags)
}

# Tencent requires this account-scoped attachment before any TKE cluster can
# enable or disable its OIDC workload-identity configuration. It is shared by
# every cluster in the account, so the regional foundation is its sole owner;
# a Cell must never detach it while another Cell is still alive.
resource "tencentcloud_cam_role_policy_attachment_by_name" "tke_oidc_config" {
  role_name   = "TKE_QCSRole"
  policy_name = "QcloudAccessForTKERoleInOIDCConfig"
}

resource "tencentcloud_tcr_instance" "fleet" {
  name                  = var.registry_name
  instance_type         = var.registry_instance_type
  open_public_operation = false
  deletion_protection   = var.deletion_protection
  delete_bucket         = true
  tags                  = local.tags
}

resource "tencentcloud_tcr_namespace" "fleet" {
  instance_id  = tencentcloud_tcr_instance.fleet.id
  name         = var.registry_namespace
  is_public    = false
  is_auto_scan = true
  tags         = local.tags
}

resource "tencentcloud_tcr_repository" "fleet" {
  for_each = var.repositories

  instance_id    = tencentcloud_tcr_instance.fleet.id
  namespace_name = tencentcloud_tcr_namespace.fleet.name
  name           = each.value
  # Tencent TCR currently reports brief_desc from description after create.
  # Keep both values identical so a fresh apply converges instead of planning
  # an update to every repository forever.
  brief_desc   = "Digest-pinned build and runtime supply for Actor Cells."
  description  = "Digest-pinned build and runtime supply for Actor Cells."
  force_delete = false
}

# The regional CCN is reachability infrastructure only. Kubernetes API and
# private gateway authorization remains with endpoint/CLB security groups and
# gateway mTLS; FDB, NATS, Pod CIDRs and Service CIDRs are never advertised.
resource "tencentcloud_ccn" "fleet" {
  name                   = var.ccn_name
  description            = "Private management-to-Cell and gateway-to-gateway transport for the Actor fleet."
  qos                    = var.ccn_qos
  charge_type            = "POSTPAID"
  instance_metering_type = var.ccn_metering_type
  # Traffic-metered postpaid accounts reject OUTER_REGION_LIMIT at create
  # time. INTER_REGION_LIMIT works for both supported metering modes and is
  # the relevant boundary for a regional multi-VPC fleet.
  bandwidth_limit_type = var.ccn_bandwidth_limit_type
  route_ecmp_flag      = false
  # New CCN instances expose overlapping-route support as mandatory. Actual
  # overlap is still rejected by our reviewed VPC/CIDR contract.
  route_overlap_flag = true
  tags               = local.tags
}
