package main

import "testing"

func TestConfigFromEnvBuildsThreeProductionRings(t *testing.T) {
	t.Setenv("LLMGATEWAY_CONTROL_URL", "http://llmgateway-control")
	t.Setenv("CLUSTER_ADMIN_TOKEN", "secret")
	t.Setenv("LLMGATEWAY_RELEASE_ID", "newapi-r1")
	t.Setenv("LLMGATEWAY_RELEASE_VERSION", "r1")
	t.Setenv("LLMGATEWAY_RELEASE_IMAGE", "registry/new-api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")

	cfg, err := configFromEnv()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Release.ID != "newapi-r1" || cfg.Release.Status != "stable" {
		t.Fatalf("release = %+v", cfg.Release)
	}
	if len(cfg.Rings) != 3 {
		t.Fatalf("rings = %d, want 3", len(cfg.Rings))
	}
	if cfg.Rings[0].Input.ID != "prod-canary" || cfg.Rings[0].Input.AdmissionEnabled {
		t.Fatalf("canary = %+v", cfg.Rings[0])
	}
	if cfg.Rings[2].Input.ID != "prod-stable" || !cfg.Rings[2].Input.AdmissionEnabled {
		t.Fatalf("stable = %+v", cfg.Rings[2])
	}
}
