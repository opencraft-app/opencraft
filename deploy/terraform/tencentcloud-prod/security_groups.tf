resource "tencentcloud_security_group" "traffic_edge" {
  name        = "${local.name_prefix}-traffic-edge"
  description = "Public HTTPS edge for llmgateway-traffic."
  tags        = local.common_tags
}

resource "tencentcloud_security_group_rule_set" "traffic_edge" {
  security_group_id = tencentcloud_security_group.traffic_edge.id

  ingress {
    action      = "ACCEPT"
    cidr_block  = "0.0.0.0/0"
    port        = "443"
    protocol    = "TCP"
    description = "Public HTTPS traffic gateway."
  }

  ingress {
    action      = "DROP"
    cidr_block  = "0.0.0.0/0"
    port        = "ALL"
    protocol    = "ALL"
    description = "Deny all other ingress."
  }

  egress {
    action      = "ACCEPT"
    cidr_block  = "0.0.0.0/0"
    port        = "ALL"
    protocol    = "ALL"
    description = "Allow outbound."
  }
}

resource "tencentcloud_security_group" "control_edge" {
  name        = "${local.name_prefix}-control-edge"
  description = "Restricted HTTPS edge for llmgateway-control."
  tags        = local.common_tags
}

resource "tencentcloud_security_group_rule_set" "control_edge" {
  security_group_id = tencentcloud_security_group.control_edge.id

  dynamic "ingress" {
    for_each = var.admin_cidrs

    content {
      action      = "ACCEPT"
      cidr_block  = ingress.value
      port        = "443"
      protocol    = "TCP"
      description = "Restricted HTTPS control gateway."
    }
  }

  ingress {
    action      = "DROP"
    cidr_block  = "0.0.0.0/0"
    port        = "ALL"
    protocol    = "ALL"
    description = "Deny all other ingress."
  }

  egress {
    action      = "ACCEPT"
    cidr_block  = "0.0.0.0/0"
    port        = "ALL"
    protocol    = "ALL"
    description = "Allow outbound."
  }
}

resource "tencentcloud_security_group" "tke_runtime" {
  name        = "${local.name_prefix}-tke-nodes"
  description = "TKE Serverless runtime security group."
  tags        = local.common_tags
}

resource "tencentcloud_security_group_rule_set" "tke_runtime" {
  security_group_id = tencentcloud_security_group.tke_runtime.id

  dynamic "ingress" {
    for_each = concat(var.app_subnet_cidrs, [var.tke_cluster_cidr, var.tke_service_cidr])

    content {
      action      = "ACCEPT"
      cidr_block  = ingress.value
      port        = "ALL"
      protocol    = "ALL"
      description = "Allow internal TKE Serverless traffic."
    }
  }

  dynamic "ingress" {
    for_each = var.traffic_backend_cidrs

    content {
      action      = "ACCEPT"
      cidr_block  = ingress.value
      port        = var.traffic_backend_port
      protocol    = "TCP"
      description = "Allow public CLB direct-access traffic to llmgateway-traffic Pods."
    }
  }

  dynamic "ingress" {
    for_each = var.admin_cidrs

    content {
      action      = "ACCEPT"
      cidr_block  = ingress.value
      port        = "22"
      protocol    = "TCP"
      description = "Optional restricted SSH access."
    }
  }

  ingress {
    action      = "DROP"
    cidr_block  = "0.0.0.0/0"
    port        = "ALL"
    protocol    = "ALL"
    description = "Deny all other ingress."
  }

  egress {
    action      = "ACCEPT"
    cidr_block  = "0.0.0.0/0"
    port        = "ALL"
    protocol    = "ALL"
    description = "Allow outbound."
  }
}

resource "tencentcloud_security_group" "mysql" {
  name        = "${local.name_prefix}-mysql"
  description = "MySQL access from TKE app subnets only."
  tags        = local.common_tags
}

resource "tencentcloud_security_group_rule_set" "mysql" {
  security_group_id = tencentcloud_security_group.mysql.id

  dynamic "ingress" {
    for_each = var.app_subnet_cidrs

    content {
      action      = "ACCEPT"
      cidr_block  = ingress.value
      port        = "3306"
      protocol    = "TCP"
      description = "Allow MySQL from TKE app subnets."
    }
  }

  ingress {
    action      = "DROP"
    cidr_block  = "0.0.0.0/0"
    port        = "ALL"
    protocol    = "ALL"
    description = "Deny all other ingress."
  }

  egress {
    action      = "ACCEPT"
    cidr_block  = "0.0.0.0/0"
    port        = "ALL"
    protocol    = "ALL"
    description = "Allow outbound."
  }
}

resource "tencentcloud_security_group" "redis" {
  name        = "${local.name_prefix}-redis"
  description = "Redis access from TKE app subnets only."
  tags        = local.common_tags
}

resource "tencentcloud_security_group_rule_set" "redis" {
  security_group_id = tencentcloud_security_group.redis.id

  dynamic "ingress" {
    for_each = var.app_subnet_cidrs

    content {
      action      = "ACCEPT"
      cidr_block  = ingress.value
      port        = "6379"
      protocol    = "TCP"
      description = "Allow Redis from TKE app subnets."
    }
  }

  ingress {
    action      = "DROP"
    cidr_block  = "0.0.0.0/0"
    port        = "ALL"
    protocol    = "ALL"
    description = "Deny all other ingress."
  }

  egress {
    action      = "ACCEPT"
    cidr_block  = "0.0.0.0/0"
    port        = "ALL"
    protocol    = "ALL"
    description = "Allow outbound."
  }
}
