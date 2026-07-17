locals {
  name_prefix = "${var.project}-${var.environment}-${var.region_alias}"

  common_tags = var.tags

  zones = {
    for idx, zone in var.availability_zones : tostring(idx) => zone
  }

  public_subnets = {
    for idx, cidr in var.public_subnet_cidrs : tostring(idx) => {
      cidr = cidr
      zone = var.availability_zones[idx]
    }
  }

  app_subnets = {
    for idx, cidr in var.app_subnet_cidrs : tostring(idx) => {
      cidr = cidr
      zone = var.availability_zones[idx]
    }
  }

  data_subnets = {
    for idx, cidr in var.data_subnet_cidrs : tostring(idx) => {
      cidr = cidr
      zone = var.availability_zones[idx]
    }
  }

  app_subnet_ids = [
    for idx in sort(keys(tencentcloud_subnet.app)) : tencentcloud_subnet.app[idx].id
  ]

  data_subnet_ids = [
    for idx in sort(keys(tencentcloud_subnet.data)) : tencentcloud_subnet.data[idx].id
  ]
}
