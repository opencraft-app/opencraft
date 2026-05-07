package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoadEnablesOTLPAuditFromStandardEnv(t *testing.T) {
	t.Setenv("OTEL_EXPORTER_OTLP_LOGS_ENDPOINT", "http://otel-collector:4318/v1/logs")
	path := filepath.Join(t.TempDir(), "config.yaml")
	if err := os.WriteFile(path, []byte(`
routes:
  - id: billing.query_bill
    upstream:
      base_url: "http://idc-billing.internal"
`), 0o600); err != nil {
		t.Fatalf("write config: %v", err)
	}

	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if !cfg.Audit.OTLP.Enabled {
		t.Fatal("expected OTLP audit logs to be enabled from env")
	}
}

func TestLoadAcceptsPolarisUpstreamAndDefaultsDiscovery(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.yaml")
	if err := os.WriteFile(path, []byte(`
routes:
  - id: billing.query_bill
    upstream:
      scheme: http
      polaris:
        service: billing
        namespace: Production
`), 0o600); err != nil {
		t.Fatalf("write config: %v", err)
	}

	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if cfg.Discovery.Polaris.SidecarURL != "http://127.0.0.1:8080" {
		t.Fatalf("unexpected sidecar default %q", cfg.Discovery.Polaris.SidecarURL)
	}
	if cfg.Discovery.Polaris.StaleOnError == nil || !*cfg.Discovery.Polaris.StaleOnError {
		t.Fatal("expected stale_on_error to default true")
	}
	if cfg.Transport.MaxIdleConns != 100 || cfg.Transport.MaxIdleConnsPerHost != 20 {
		t.Fatalf("unexpected transport defaults %+v", cfg.Transport)
	}
}

func TestLoadRejectsAmbiguousUpstream(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.yaml")
	if err := os.WriteFile(path, []byte(`
routes:
  - id: billing.query_bill
    upstream:
      base_url: http://billing.internal
      polaris:
        service: billing
        namespace: Production
`), 0o600); err != nil {
		t.Fatalf("write config: %v", err)
	}

	if _, err := Load(path); err == nil {
		t.Fatal("expected ambiguous upstream config to fail")
	}
}
