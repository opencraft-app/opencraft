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
  name                       = "${local.name_prefix}-nat"
  internet_charge_type       = "TRAFFIC_POSTPAID_BY_HOUR"
  internet_max_bandwidth_out = 100
  tags                       = local.common_tags
}

resource "tencentcloud_route_table" "private" {
  name   = "${local.name_prefix}-private"
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
  route_table_id    = tencentcloud_route_table.private.id
  tags              = local.common_tags
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
  name                = "${local.name_prefix}-nat"
  vpc_id              = tencentcloud_vpc.main.id
  assigned_eip_set    = [tencentcloud_eip.nat.public_ip]
  nat_product_version = 2
  tags                = local.common_tags
}

resource "tencentcloud_route_table_entry" "private_default_egress" {
  route_table_id         = tencentcloud_route_table.private.id
  destination_cidr_block = "0.0.0.0/0"
  next_type              = "NAT"
  next_hub               = tencentcloud_nat_gateway.main.id
  description            = "Private subnet outbound access through NAT."
}
