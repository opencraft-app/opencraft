output "operations_network_inventory" {
  description = "Credential-free operations-to-Actor routing inventory."
  value = {
    schemaVersion          = 1
    region                 = var.region
    ccnId                  = local.regional_network.ccn_id
    managementVpcId        = local.management_vpc_id
    operationsVpcId        = local.operations_vpc.vpc_id
    operationsVpcName      = var.operations_vpc_name
    operationsVpcCidr      = var.operations_vpc_cidr
    operationsRouteTableId = tencentcloud_ccn_route_table.operations.id
    attachmentId           = tencentcloud_ccn_attachment_v2.operations.id
    routeContract          = "operations<->management-only"
  }
}
