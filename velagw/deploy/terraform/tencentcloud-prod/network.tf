resource "tencentcloud_vpc" "main" {
  name       = local.name_prefix
  cidr_block = var.vpc_cidr
  tags       = local.common_tags

  lifecycle {
    precondition {
      condition     = alltrue([for zone in var.availability_zones : startswith(zone, "${var.region}-")])
      error_message = "Every availability zone must belong to the selected region."
    }
    precondition {
      condition = (
        length(var.public_subnet_cidrs) == length(var.availability_zones) &&
        length(var.app_subnet_cidrs) == length(var.availability_zones) &&
        length(var.data_subnet_cidrs) == length(var.availability_zones)
      )
      error_message = "Public, app, and data subnet CIDR lists must match availability_zones length."
    }
  }
}

resource "tencentcloud_eip" "nat" {
  count = var.egress_gateway_mode == "managed_nat" ? 1 : 0

  name                       = "${local.name_prefix}-nat"
  internet_charge_type       = "TRAFFIC_POSTPAID_BY_HOUR"
  internet_max_bandwidth_out = var.nat_eip_bandwidth
  tags                       = local.common_tags
}

resource "tencentcloud_route_table" "private" {
  name   = "${local.name_prefix}-private"
  vpc_id = tencentcloud_vpc.main.id
  tags   = local.common_tags
}

resource "tencentcloud_route_table" "private_by_zone" {
  for_each = var.egress_gateway_mode == "nat_instance" ? local.app_subnets : {}

  name   = "${local.name_prefix}-private-${each.key}"
  vpc_id = tencentcloud_vpc.main.id
  tags   = local.common_tags
}

resource "tencentcloud_subnet" "public" {
  for_each = local.public_subnets

  name              = "${local.name_prefix}-public-${each.key}"
  vpc_id            = tencentcloud_vpc.main.id
  availability_zone = each.value.zone
  cidr_block        = each.value.cidr
  tags              = local.common_tags
}

resource "tencentcloud_subnet" "app" {
  for_each = local.app_subnets

  name              = "${local.name_prefix}-app-${each.key}"
  vpc_id            = tencentcloud_vpc.main.id
  availability_zone = each.value.zone
  cidr_block        = each.value.cidr
  route_table_id = (
    var.egress_gateway_mode == "nat_instance"
    ? tencentcloud_route_table.private_by_zone[each.key].id
    : tencentcloud_route_table.private.id
  )
  tags = local.common_tags
}

resource "tencentcloud_subnet" "data" {
  for_each = local.data_subnets

  name              = "${local.name_prefix}-data-${each.key}"
  vpc_id            = tencentcloud_vpc.main.id
  availability_zone = each.value.zone
  cidr_block        = each.value.cidr
  tags              = local.common_tags
}

resource "tencentcloud_nat_gateway" "main" {
  count = var.egress_gateway_mode == "managed_nat" ? 1 : 0

  name                = "${local.name_prefix}-nat"
  vpc_id              = tencentcloud_vpc.main.id
  assigned_eip_set    = [tencentcloud_eip.nat[0].public_ip]
  nat_product_version = 2
  tags                = local.common_tags
}

resource "tencentcloud_instance" "nat" {
  for_each = var.egress_gateway_mode == "nat_instance" ? local.public_subnets : {}

  instance_name              = "${local.name_prefix}-nat-${each.key}"
  hostname                   = "${local.name_prefix}-nat-${each.key}"
  availability_zone          = each.value.zone
  image_id                   = var.nat_instance_image_id
  instance_type              = var.nat_instance_type
  instance_charge_type       = "POSTPAID_BY_HOUR"
  system_disk_type           = var.nat_instance_system_disk_type
  system_disk_size           = var.nat_instance_system_disk_size
  vpc_id                     = tencentcloud_vpc.main.id
  subnet_id                  = tencentcloud_subnet.public[each.key].id
  orderly_security_groups    = [tencentcloud_security_group.nat_instance[0].id]
  key_ids                    = var.nat_instance_key_ids
  allocate_public_ip         = true
  internet_charge_type       = "TRAFFIC_POSTPAID_BY_HOUR"
  internet_max_bandwidth_out = var.nat_eip_bandwidth
  user_data_raw = templatefile("${path.module}/templates/nat-instance-cloud-init.yaml.tftpl", {
    source_cidrs = distinct([
      var.vpc_cidr,
      var.tke_cluster_cidr,
    ])
  })
  user_data_replace_on_change = true
  tags                        = local.common_tags

  lifecycle {
    precondition {
      condition     = trimspace(var.nat_instance_image_id) != ""
      error_message = "nat_instance_image_id must be set when egress_gateway_mode is nat_instance."
    }
  }
}

resource "tencentcloud_route_table_entry" "private_default_egress_managed_nat" {
  count = var.egress_gateway_mode == "managed_nat" ? 1 : 0

  route_table_id         = tencentcloud_route_table.private.id
  destination_cidr_block = "0.0.0.0/0"
  next_type              = "NAT"
  next_hub               = tencentcloud_nat_gateway.main[0].id
  description            = "Private subnet outbound access through NAT."
}

resource "tencentcloud_route_table_entry" "private_default_egress_nat_instance" {
  for_each = var.egress_gateway_mode == "nat_instance" ? local.app_subnets : {}

  route_table_id         = tencentcloud_route_table.private_by_zone[each.key].id
  destination_cidr_block = "0.0.0.0/0"
  next_type              = "NORMAL_CVM"
  next_hub               = tencentcloud_instance.nat[each.key].private_ip
  description            = "Private subnet outbound access through same-zone NAT instance."
}
