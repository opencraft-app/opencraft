resource "tencentcloud_tcr_namespace" "llmgateway" {
  instance_id  = var.tcr_instance_id
  name         = var.tcr_namespace
  is_public    = false
  is_auto_scan = true
}

resource "tencentcloud_tcr_repository" "llmgateway" {
  instance_id    = var.tcr_instance_id
  namespace_name = tencentcloud_tcr_namespace.llmgateway.name
  name           = var.tcr_repository
  brief_desc     = "LLMGateway production image"
  description    = "Multi-binary LLMGateway image for control, traffic, worker, and db-bootstrap."
  force_delete   = false
}
