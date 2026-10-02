output "fdb_nodes" {
  value = {
    for name, node in tencentcloud_instance.fdb : name => {
      instance_id = node.id
      private_ip  = node.private_ip
      zone        = node.availability_zone
    }
  }
}

output "runtime" {
  description = "Compatibility output for the preserved primary runtime host."
  value = {
    instance_id = tencentcloud_instance.runtime["b6-1"].id
    private_ip  = tencentcloud_instance.runtime["b6-1"].private_ip
    zone        = tencentcloud_instance.runtime["b6-1"].availability_zone
  }
}

output "runtime_nodes" {
  value = {
    for name, node in tencentcloud_instance.runtime : name => {
      instance_id = node.id
      private_ip  = node.private_ip
      zone        = node.availability_zone
    }
  }
}

output "placement_group_id" {
  value = tencentcloud_placement_group.fdb.id
}

output "production_eligible" {
  value       = var.enable_cbs_encryption
  description = "False blocks RivetCell Ready status even when all functional qualifications pass."
}

output "cos_buckets" {
  value = {
    cold = {
      name                = tencentcloud_cos_bucket.cold.bucket
      url                 = tencentcloud_cos_bucket.cold.cos_bucket_url
      multi_az            = false
      versioning_contract = "verify-empty-remote-document"
    }
    backup = {
      name                = tencentcloud_cos_bucket.backup.bucket
      url                 = tencentcloud_cos_bucket.backup.cos_bucket_url
      multi_az            = false
      versioning_contract = "verify-empty-remote-document"
    }
  }
}
