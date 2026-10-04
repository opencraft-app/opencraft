terraform {
  required_version = "= 1.9.8"
  required_providers {
    tencentcloud = {
      source  = "tencentcloudstack/tencentcloud"
      version = "1.83.11"
    }
  }
}

variable "management_id" {
  type    = string
  default = "actor-bj-c01"
}

variable "region" {
  type    = string
  default = "ap-beijing"
}

locals {
  expected_collector_discovery = jsondecode(file("${path.module}/collector-discovery.json"))
}

# Schema-only fixture: all runs use Terraform's native mock provider. There is
# no backend, credential, network call, or real Kubernetes cluster operation.
resource "tencentcloud_kubernetes_cluster" "management" {
  cluster_name = var.management_id
  cluster_cidr = "10.254.0.0/16"
  vpc_id       = "vpc-test1234"
}
