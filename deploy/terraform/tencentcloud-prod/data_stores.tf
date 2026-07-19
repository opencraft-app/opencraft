resource "tencentcloud_mysql_instance" "control" {
  instance_name     = "${local.name_prefix}-control-mysql"
  engine_version    = "8.0"
  charge_type       = "POSTPAID"
  root_password     = var.mysql_root_password
  availability_zone = var.availability_zones[0]
  first_slave_zone  = var.availability_zones[min(1, length(var.availability_zones) - 1)]
  slave_deploy_mode = 1
  slave_sync_mode   = 1
  internet_service  = 0
  intranet_port     = 3306
  mem_size          = var.control_mysql.mem_size
  volume_size       = var.control_mysql.volume_size
  cpu               = var.control_mysql.cpu
  vpc_id            = tencentcloud_vpc.main.id
  subnet_id         = local.data_subnet_ids[0]
  security_groups   = [tencentcloud_security_group.mysql.id]
  tags              = local.common_tags

  parameters = {
    character_set_server = "utf8mb4"
    max_connections      = "1000"
  }

  timeouts {
    create = "30m"
    delete = "30m"
  }
}

resource "tencentcloud_redis_instance" "control" {
  name               = "${local.name_prefix}-control-redis"
  availability_zone  = var.availability_zones[0]
  type_id            = var.control_redis.type_id
  charge_type        = "POSTPAID"
  mem_size           = var.control_redis.mem_size
  redis_shard_num    = var.control_redis.redis_shard_num
  redis_replicas_num = var.control_redis.redis_replicas_num
  port               = 6379
  password           = var.redis_password
  vpc_id             = tencentcloud_vpc.main.id
  subnet_id          = local.data_subnet_ids[0]
  security_groups    = [tencentcloud_security_group.redis.id]
  tags               = local.common_tags
}

resource "tencentcloud_mysql_instance" "shard" {
  for_each = var.shards

  instance_name     = "${local.name_prefix}-${each.key}-mysql"
  engine_version    = "8.0"
  charge_type       = "POSTPAID"
  root_password     = var.mysql_root_password
  availability_zone = var.availability_zones[each.value.zone_index]
  first_slave_zone  = var.availability_zones[(each.value.zone_index + 1) % length(var.availability_zones)]
  slave_deploy_mode = 1
  slave_sync_mode   = 1
  internet_service  = 0
  intranet_port     = 3306
  mem_size          = each.value.mysql_mem_size
  volume_size       = each.value.mysql_volume_size
  cpu               = each.value.mysql_cpu
  vpc_id            = tencentcloud_vpc.main.id
  subnet_id         = local.data_subnet_ids[each.value.zone_index]
  security_groups   = [tencentcloud_security_group.mysql.id]
  tags              = merge(local.common_tags, { shard = each.key })

  parameters = {
    character_set_server = "utf8mb4"
    max_connections      = "1000"
  }

  timeouts {
    create = "30m"
    delete = "30m"
  }
}

resource "tencentcloud_redis_instance" "shard" {
  for_each = var.shards

  name               = "${local.name_prefix}-${each.key}-redis"
  availability_zone  = var.availability_zones[each.value.zone_index]
  type_id            = each.value.redis_type_id
  charge_type        = "POSTPAID"
  mem_size           = each.value.redis_mem_size
  redis_shard_num    = each.value.redis_shard_num
  redis_replicas_num = each.value.redis_replicas
  port               = 6379
  password           = var.redis_password
  vpc_id             = tencentcloud_vpc.main.id
  subnet_id          = local.data_subnet_ids[each.value.zone_index]
  security_groups    = [tencentcloud_security_group.redis.id]
  tags               = merge(local.common_tags, { shard = each.key })
}
