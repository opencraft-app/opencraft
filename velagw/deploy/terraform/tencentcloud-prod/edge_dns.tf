locals {
  control_host = "${var.control_dns_subdomain}.${var.dns_domain}"
  traffic_host = "${var.traffic_dns_subdomain}.${var.dns_domain}"
}

resource "tencentcloud_dnspod_record" "control" {
  count = var.edge_dns_enabled ? 1 : 0

  domain      = var.dns_domain
  sub_domain  = var.control_dns_subdomain
  record_type = "CNAME"
  record_line = "默认"
  value       = var.control_clb_domain
  ttl         = 600
  status      = "ENABLE"

  lifecycle {
    precondition {
      condition     = var.control_dns_subdomain != var.traffic_dns_subdomain
      error_message = "Control and traffic DNS subdomains must be different."
    }
    precondition {
      condition     = !startswith(lower(trimspace(var.control_clb_domain)), "replace")
      error_message = "control_clb_domain must be the real CLB domain when edge_dns_enabled is true."
    }
  }
}

resource "tencentcloud_dnspod_record" "traffic" {
  count = var.edge_dns_enabled ? 1 : 0

  domain      = var.dns_domain
  sub_domain  = var.traffic_dns_subdomain
  record_type = "CNAME"
  record_line = "默认"
  value       = var.traffic_clb_domain
  ttl         = 600
  status      = "ENABLE"

  lifecycle {
    precondition {
      condition     = var.control_dns_subdomain != var.traffic_dns_subdomain
      error_message = "Control and traffic DNS subdomains must be different."
    }
    precondition {
      condition     = !startswith(lower(trimspace(var.traffic_clb_domain)), "replace")
      error_message = "traffic_clb_domain must be the real CLB domain when edge_dns_enabled is true."
    }
  }
}

# Preserve addresses for the existing Beijing state when DNS resources became
# conditional to support first-stage regional bootstrap.
moved {
  from = tencentcloud_dnspod_record.control
  to   = tencentcloud_dnspod_record.control[0]
}

moved {
  from = tencentcloud_dnspod_record.traffic
  to   = tencentcloud_dnspod_record.traffic[0]
}
