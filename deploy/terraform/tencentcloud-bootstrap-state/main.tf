data "tencentcloud_user_info" "current" {}

locals {
  bucket_name = "${var.bucket_name_prefix}-${data.tencentcloud_user_info.current.app_id}"
  principal   = "qcs::cam::uin/${data.tencentcloud_user_info.current.owner_uin}:uin/${data.tencentcloud_user_info.current.uin}"
  bucket_qcs  = "qcs::cos:${var.region}:uid/${data.tencentcloud_user_info.current.app_id}:${local.bucket_name}"

  common_tags = merge(
    {
      project     = "llmgateway"
      environment = "prod"
      purpose     = "terraform-state"
      region      = var.region
      managed_by  = "terraform-bootstrap"
    },
    var.tags
  )
}

resource "tencentcloud_cos_bucket" "terraform_state" {
  bucket               = local.bucket_name
  acl                  = "private"
  versioning_enable    = true
  encryption_algorithm = "AES256"
  force_clean          = var.force_clean
}

resource "tencentcloud_cos_bucket_policy" "terraform_state" {
  bucket = tencentcloud_cos_bucket.terraform_state.id

  policy = jsonencode({
    version = "2.0"
    Statement = [
      {
        Effect = "allow"
        Principal = {
          qcs = [local.principal]
        }
        Action = [
          "name/cos:GetBucket"
        ]
        Resource = [
          "${local.bucket_qcs}/*"
        ]
      },
      {
        Effect = "allow"
        Principal = {
          qcs = [local.principal]
        }
        Action = [
          "name/cos:GetObject",
          "name/cos:PutObject",
          "name/cos:DeleteObject"
        ]
        Resource = [
          "${local.bucket_qcs}/llmgateway/prod/*",
          "${local.bucket_qcs}/env:/*"
        ]
      }
    ]
  })
}
