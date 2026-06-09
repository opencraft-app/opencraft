locals {
  common_tags = merge(var.tags, {
    region = var.region
  })

  subnet_zones = {
    app_a     = var.availability_zones[0]
    app_b     = var.availability_zones[1]
    service_a = var.availability_zones[0]
    db_a      = var.availability_zones[0]
    db_b      = var.availability_zones[1]
  }

  # Initial production layout:
  # - temporal: unsharded metadata/default tables
  # - temporal_sharded: two Vitess keyranges, -80 and 80-
  # - temporal_visibility: visibility store
  #
  # Future 2 -> 4 -> 8 expansion should add target MySQL instances first,
  # then run the Vitess VReplication/reshard runbook before source removal.
  mysql_tablets = {
    temporal = {
      keyspace = "temporal"
      database = "temporal"
      subnet   = "db_a"
      zone     = var.availability_zones[0]
      ro_zone  = var.availability_zones[1]
      shard    = {}
    }
    temporal_sharded_left = {
      keyspace = "temporal_sharded"
      database = "temporal_sharded"
      subnet   = "db_a"
      zone     = var.availability_zones[0]
      ro_zone  = var.availability_zones[1]
      shard    = { end = "80" }
    }
    temporal_sharded_right = {
      keyspace = "temporal_sharded"
      database = "temporal_sharded"
      subnet   = "db_b"
      zone     = var.availability_zones[1]
      ro_zone  = var.availability_zones[0]
      shard    = { start = "80" }
    }
    temporal_visibility = {
      keyspace = "temporal_visibility"
      database = "temporal_visibility"
      subnet   = "db_b"
      zone     = var.availability_zones[1]
      ro_zone  = var.availability_zones[0]
      shard    = {}
    }
  }

  vitess_global_privileges = [
    "ALTER",
    "ALTER ROUTINE",
    "CREATE",
    "CREATE ROUTINE",
    "CREATE TEMPORARY TABLES",
    "CREATE USER",
    "CREATE VIEW",
    "DELETE",
    "DROP",
    "EVENT",
    "EXECUTE",
    "INDEX",
    "INSERT",
    "LOCK TABLES",
    "PROCESS",
    "REFERENCES",
    "RELOAD",
    "REPLICATION CLIENT",
    "REPLICATION SLAVE",
    "SELECT",
    "SHOW DATABASES",
    "SHOW VIEW",
    "TRIGGER",
    "UPDATE",
  ]
}

resource "tencentcloud_vpc" "this" {
  name         = "${var.name_prefix}-vpc"
  cidr_block   = var.vpc_cidr
  is_multicast = false
  tags         = local.common_tags
}

resource "tencentcloud_subnet" "this" {
  for_each = var.subnet_cidrs

  name              = "${var.name_prefix}-${each.key}"
  vpc_id            = tencentcloud_vpc.this.id
  cidr_block        = each.value
  availability_zone = local.subnet_zones[each.key]
  is_multicast      = false
  tags              = local.common_tags
}

resource "tencentcloud_security_group" "tke" {
  name        = "${var.name_prefix}-tke-sg"
  description = "TKE workload security group for Temporal on Vitess."
}

resource "tencentcloud_security_group_rule_set" "tke" {
  security_group_id = tencentcloud_security_group.tke.id

  ingress {
    action      = "ACCEPT"
    cidr_block  = var.vpc_cidr
    protocol    = "ALL"
    port        = "all"
    description = "Allow workload traffic inside the VPC."
  }

  dynamic "ingress" {
    for_each = toset(var.api_server_allowed_cidrs)

    content {
      action      = "ACCEPT"
      cidr_block  = ingress.value
      protocol    = "TCP"
      port        = "443"
      description = "Allow kubectl access to the TKE API endpoint."
    }
  }

  egress {
    action      = "ACCEPT"
    cidr_block  = var.vpc_cidr
    protocol    = "ALL"
    port        = "all"
    description = "Allow VPC egress."
  }
}

resource "tencentcloud_security_group" "mysql" {
  name        = "${var.name_prefix}-mysql-sg"
  description = "TencentDB for MySQL access from the Temporal/Vitess VPC only."
}

resource "tencentcloud_security_group_rule_set" "mysql" {
  security_group_id = tencentcloud_security_group.mysql.id

  ingress {
    action      = "ACCEPT"
    cidr_block  = var.vpc_cidr
    protocol    = "TCP"
    port        = "3306"
    description = "Allow VTTablet and operational jobs from the VPC."
  }

  egress {
    action      = "ACCEPT"
    cidr_block  = var.vpc_cidr
    protocol    = "ALL"
    port        = "all"
    description = "Allow VPC egress."
  }
}

resource "tencentcloud_kubernetes_cluster" "this" {
  vpc_id                  = tencentcloud_vpc.this.id
  cluster_cidr            = var.cluster_cidr
  cluster_name            = "${var.name_prefix}-tke"
  cluster_desc            = "Production Temporal on Vitess TKE cluster."
  cluster_max_pod_num     = 64
  cluster_max_service_num = 1024
  cluster_version         = var.kubernetes_version
  cluster_deploy_type     = "MANAGED_CLUSTER"
  cluster_level           = var.cluster_level

  labels = {
    service = "temporal-vitess"
    tier    = "prod"
  }
}

resource "tencentcloud_kubernetes_serverless_node_pool" "this" {
  cluster_id = tencentcloud_kubernetes_cluster.this.id
  name       = "${var.name_prefix}-serverless"

  dynamic "serverless_nodes" {
    for_each = {
      app_a = tencentcloud_subnet.this["app_a"].id
      app_b = tencentcloud_subnet.this["app_b"].id
    }

    content {
      display_name = "${var.name_prefix}-${serverless_nodes.key}"
      subnet_id    = serverless_nodes.value
    }
  }

  security_group_ids = [tencentcloud_security_group.tke.id]

  labels = {
    service = "temporal-vitess"
    tier    = "prod"
  }
}

resource "tencentcloud_kubernetes_cluster_endpoint" "internet" {
  count = length(var.api_server_allowed_cidrs) > 0 ? 1 : 0

  cluster_id                      = tencentcloud_kubernetes_cluster.this.id
  cluster_internet                = true
  cluster_internet_security_group = tencentcloud_security_group.tke.id
  extensive_parameters            = var.api_server_lb_parameters
}

resource "tencentcloud_mysql_instance" "tablet" {
  for_each = local.mysql_tablets

  instance_name     = "${var.name_prefix}-${replace(each.key, "_", "-")}"
  engine_version    = var.mysql_engine_version
  device_type       = var.mysql_device_type
  charge_type       = "POSTPAID"
  root_password     = var.mysql_root_password
  slave_deploy_mode = 1
  slave_sync_mode   = 1
  availability_zone = each.value.zone
  cpu               = var.mysql_cpu
  mem_size          = var.mysql_mem_size_mb
  volume_size       = var.mysql_volume_size_gb
  vpc_id            = tencentcloud_vpc.this.id
  subnet_id         = tencentcloud_subnet.this[each.value.subnet].id
  internet_service  = 0
  intranet_port     = 3306
  security_groups   = [tencentcloud_security_group.mysql.id]

  tags = merge(local.common_tags, {
    keyspace = each.value.keyspace
    tablet   = each.key
  })

  parameters = {
    character_set_server = "utf8mb4"
    max_connections      = "2000"
  }

  cluster_topology {
    read_write_node {
      zone = each.value.zone
    }

    read_only_nodes {
      zone = each.value.ro_zone
    }
  }

  timeouts {
    create = "60m"
    delete = "60m"
  }

  lifecycle {
    ignore_changes = [
      parameters,
      root_password,
    ]
  }
}

resource "tencentcloud_mysql_database" "tablet" {
  for_each = local.mysql_tablets

  instance_id        = tencentcloud_mysql_instance.tablet[each.key].id
  db_name            = each.value.database
  character_set_name = "utf8mb4"
}

resource "tencentcloud_mysql_account" "vitess" {
  for_each = local.mysql_tablets

  mysql_id             = tencentcloud_mysql_instance.tablet[each.key].id
  name                 = var.mysql_vitess_user
  password             = var.mysql_vitess_password
  description          = "Vitess externalDatastore account."
  max_user_connections = 10240
}

resource "tencentcloud_mysql_privilege" "vitess" {
  for_each = local.mysql_tablets

  mysql_id     = tencentcloud_mysql_instance.tablet[each.key].id
  account_name = tencentcloud_mysql_account.vitess[each.key].name
  account_host = "%"
  global       = local.vitess_global_privileges
  depends_on   = [tencentcloud_mysql_database.tablet]
}
