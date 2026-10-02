terraform {
  required_version = ">= 1.8.0"

  required_providers {
    tencentcloud = {
      source  = "tencentcloudstack/tencentcloud"
      version = "1.83.11"
    }
  }
}

provider "tencentcloud" {
  region = var.region
}
