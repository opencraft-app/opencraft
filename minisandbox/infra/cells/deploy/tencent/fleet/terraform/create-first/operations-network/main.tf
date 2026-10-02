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

data "tencentcloud_vpc_instances" "operations" {
  name       = var.operations_vpc_name
  cidr_block = var.operations_vpc_cidr
}

locals {
  regional_network           = data.terraform_remote_state.foundation.outputs.network
  management                 = data.terraform_remote_state.management.outputs.management_inventory
  management_vpc_id          = local.management.network.vpcId
  default_ccn_route_table_id = local.management.network.ccnRouteTableId
  operations_vpc             = one(data.tencentcloud_vpc_instances.operations.instance_list)
}

# A custom table defaults to rejecting every route. Accept only the regional C
# VPC, so the operations network never learns routes for runtime Cell VPCs.
resource "tencentcloud_ccn_route_table" "operations" {
  ccn_id      = local.regional_network.ccn_id
  name        = var.route_table_name
  description = "LightVela operations network: regional Actor C only"

  lifecycle {
    precondition {
      condition = (
        local.management.region == var.region &&
        local.management.network.ccnId == local.regional_network.ccn_id &&
        local.default_ccn_route_table_id != ""
      )
      error_message = "foundation and management must describe one regional CCN with a resolved default route table."
    }
  }
}

resource "tencentcloud_ccn_route_table_input_policies" "operations" {
  ccn_id         = local.regional_network.ccn_id
  route_table_id = tencentcloud_ccn_route_table.operations.id

  policies {
    action      = "accept"
    description = "Accept routes only from the regional management VPC"
    route_conditions {
      name          = "instance-id"
      values        = [local.management_vpc_id]
      match_pattern = 1
    }
  }
}

# Propagation policies use first-match semantics and otherwise end in Tencent's
# immutable ANY/accept rule. Permit the operations prefix to C first, then deny
# it to every other VPC. This also isolates Cells added after this state was
# applied, without maintaining a fallible list of runtime VPC IDs.
resource "tencentcloud_ccn_route_table_broadcast_policies" "default_isolation" {
  ccn_id         = local.regional_network.ccn_id
  route_table_id = local.default_ccn_route_table_id

  policies {
    action      = "accept"
    description = "Operations routes may reach regional management C"
    route_conditions {
      name          = "cidr-block"
      values        = [var.operations_vpc_cidr]
      match_pattern = 0
    }
    broadcast_conditions {
      name          = "instance-id"
      values        = [local.management_vpc_id]
      match_pattern = 1
    }
  }

  policies {
    action      = "drop"
    description = "Operations routes must not reach runtime or future VPCs"
    route_conditions {
      name          = "cidr-block"
      values        = [var.operations_vpc_cidr]
      match_pattern = 0
    }
    broadcast_conditions {
      name          = "instance-type"
      values        = ["VPC"]
      match_pattern = 1
    }
  }
}

resource "tencentcloud_ccn_attachment_v2" "operations" {
  ccn_id          = local.regional_network.ccn_id
  instance_id     = local.operations_vpc.vpc_id
  instance_type   = "VPC"
  instance_region = var.region
  route_table_id  = tencentcloud_ccn_route_table.operations.id
  description     = "LightVela operations VPC isolated to Actor regional C"

  depends_on = [
    tencentcloud_ccn_route_table_input_policies.operations,
    tencentcloud_ccn_route_table_broadcast_policies.default_isolation,
  ]
}
