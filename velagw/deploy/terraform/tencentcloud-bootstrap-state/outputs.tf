output "bucket" {
  description = "COS bucket name for Terraform remote state."
  value       = tencentcloud_cos_bucket.terraform_state.bucket
}

output "region" {
  description = "COS bucket region."
  value       = var.region
}

output "prod_backend_hcl" {
  description = "Copy this into ../tencentcloud-prod/backend.hcl or pass as -backend-config arguments."
  value       = <<EOT
region = "${var.region}"
bucket = "${tencentcloud_cos_bucket.terraform_state.bucket}"
prefix = "llmgateway/prod"
EOT
}
