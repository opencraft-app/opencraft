locals {
  tags = merge({
    product    = "actor-serverless"
    role       = "terraform-state"
    managed-by = "terraform"
  }, var.tags)
}

# This is the only create-first root that deliberately starts with local state:
# a backend cannot store its state in a bucket that does not exist yet. After
# creation, every foundation and Cell root uses this bucket through Terraform's
# locking COS backend. Runtime cold/backup buckets remain NeverEnabled; state is
# intentionally versioned because it is control-plane data, not Actor data.
resource "tencentcloud_cos_bucket" "state" {
  bucket               = var.state_bucket_name
  acl                  = "private"
  encryption_algorithm = "AES256"
  versioning_enable    = true
  force_clean          = false
  tags                 = local.tags

  lifecycle {
    prevent_destroy = true
  }
}
