output "backend" {
  description = "Non-secret partial backend configuration for all other roots."
  value = {
    region  = var.region
    bucket  = tencentcloud_cos_bucket.state.bucket
    encrypt = true
  }
}
