locals {
  fdb_nodes = {
    b6-1 = { zone = "ap-beijing-6", ordinal = 1 }
    b6-2 = { zone = "ap-beijing-6", ordinal = 2 }
    b7-1 = { zone = "ap-beijing-7", ordinal = 1 }
    b7-2 = { zone = "ap-beijing-7", ordinal = 2 }
    b8-1 = { zone = "ap-beijing-8", ordinal = 1 }
    b8-2 = { zone = "ap-beijing-8", ordinal = 2 }
  }

  # Runtime capacity is deliberately spread across the same three Beijing
  # availability zones as the Cell.  The b6-1 key names the former singleton
  # runtime instance so the moved block below preserves it in-place.
  runtime_nodes = {
    b6-1 = { zone = "ap-beijing-6", ordinal = 1 }
    b7-1 = { zone = "ap-beijing-7", ordinal = 2 }
    b8-1 = { zone = "ap-beijing-8", ordinal = 3 }
  }

  common_tags = {
    cluster = "actor"
    owner   = "skipzhang"
    cell    = var.cell_id
    driver  = "rivet-fdb-cos-v1"
  }
}

# COS cannot return a bucket to the NeverEnabled state after versioning has once been enabled.
# Multi-AZ buckets also cannot disable versioning.  These are therefore fresh, ordinary Beijing
# buckets with the no-versioning property created from the first request.  Never import either of
# the older Cell B multi-AZ/versioned qualification buckets into these resources.
#
# Deliberately omit versioning_enable. TencentCloud Provider 1.83.11 maps false updates to
# PutBucketVersioning(Status=Suspended), while its Read path collapses Suspended and NeverEnabled to
# the same false value. Terraform therefore cannot prove this invariant; verify the empty remote
# versioning document with verify_cos_no_versioning.py before admitting the Cell.
resource "tencentcloud_cos_bucket" "cold" {
  bucket               = var.cold_bucket
  acl                  = "private"
  multi_az             = false
  encryption_algorithm = "AES256"
  force_clean          = false

  tags = merge(local.common_tags, {
    role       = "depot-cold"
    versioning = "never-enabled"
  })

  lifecycle {
    prevent_destroy = true
  }
}

resource "tencentcloud_cos_bucket" "backup" {
  bucket               = var.backup_bucket
  acl                  = "private"
  multi_az             = false
  encryption_algorithm = "AES256"
  force_clean          = false

  tags = merge(local.common_tags, {
    role       = "fdb-backup"
    versioning = "never-enabled"
  })

  lifecycle {
    prevent_destroy = true
  }
}

resource "tencentcloud_placement_group" "fdb" {
  name     = "${var.cell_id}-fdb-host-spread"
  type     = "HOST"
  affinity = 1

  tags = merge(local.common_tags, {
    role = "fdb-placement"
  })
}

resource "tencentcloud_instance" "fdb" {
  for_each = local.fdb_nodes

  instance_name              = "${var.cell_id}-fdb-${each.key}"
  availability_zone          = each.value.zone
  image_id                   = var.image_id
  instance_type              = var.fdb_instance_type
  instance_charge_type       = "POSTPAID_BY_HOUR"
  vpc_id                     = var.vpc_id
  subnet_id                  = var.subnets[each.value.zone]
  orderly_security_groups    = [var.security_group_id]
  placement_group_id         = tencentcloud_placement_group.fdb.id
  allocate_public_ip         = false
  internet_max_bandwidth_out = 0
  system_disk_type           = "CLOUD_BSSD"
  system_disk_size           = 50
  disable_api_termination    = true

  data_disks {
    data_disk_type       = "CLOUD_BSSD"
    data_disk_size       = var.fdb_data_disk_size_gib
    delete_with_instance = false
    encrypt              = var.enable_cbs_encryption
  }

  tags = merge(local.common_tags, {
    role    = "fdb"
    zone    = each.value.zone
    ordinal = tostring(each.value.ordinal)
  })

  lifecycle {
    prevent_destroy = true
  }
}

moved {
  from = tencentcloud_instance.runtime
  to   = tencentcloud_instance.runtime["b6-1"]
}

resource "tencentcloud_instance" "runtime" {
  for_each = local.runtime_nodes

  instance_name              = "${var.cell_id}-runtime-${each.value.ordinal}"
  availability_zone          = each.value.zone
  image_id                   = var.image_id
  instance_type              = var.runtime_instance_type
  instance_charge_type       = "POSTPAID_BY_HOUR"
  vpc_id                     = var.vpc_id
  subnet_id                  = var.subnets[each.value.zone]
  orderly_security_groups    = [var.security_group_id]
  allocate_public_ip         = false
  internet_max_bandwidth_out = 0
  system_disk_type           = "CLOUD_BSSD"
  system_disk_size           = 100
  disable_api_termination    = true

  tags = merge(local.common_tags, {
    role    = "runtime"
    zone    = each.value.zone
    ordinal = tostring(each.value.ordinal)
  })

  lifecycle {
    prevent_destroy = true
  }
}
