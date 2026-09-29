package main

import "testing"

func TestLoadConfigDefaultsCloudPauseResumeOn(t *testing.T) {
	t.Setenv("SANDBOX_ENABLE_CLOUD_PAUSE_RESUME", "")

	cfg := loadConfig()
	if !cfg.CloudPauseResume {
		t.Fatalf("expected cloud pause/resume enabled by default")
	}
}

func TestLoadConfigCanDisableCloudPauseResume(t *testing.T) {
	t.Setenv("SANDBOX_ENABLE_CLOUD_PAUSE_RESUME", "false")

	cfg := loadConfig()
	if cfg.CloudPauseResume {
		t.Fatalf("expected cloud pause/resume disabled by explicit env")
	}
}

func TestLoadConfigReadsInternalTATSecuritySettings(t *testing.T) {
	t.Setenv("SANDBOX_API_KEY", " shared-key ")
	t.Setenv("WEBSITE_CREDENTIAL_TAT_COMMAND_ID", " cmd-website1 ")

	cfg := loadConfig()
	if cfg.InternalAPIKey != "shared-key" {
		t.Fatalf("InternalAPIKey = %q", cfg.InternalAPIKey)
	}
	if cfg.AllowedTATCommandID != "cmd-website1" {
		t.Fatalf("AllowedTATCommandID = %q", cfg.AllowedTATCommandID)
	}
}

func TestLoadConfigRegionAllowlistFailsClosedOnInvalidJSON(t *testing.T) {
	t.Setenv("WEBSITE_CREDENTIAL_TAT_COMMAND_ID", "cmd-singapore")
	t.Setenv("WEBSITE_CREDENTIAL_TAT_COMMAND_IDS_BY_REGION", "not-json")
	cfg := loadConfig()
	if cfg.AllowedTATCommandIDsByRegion == nil || len(cfg.AllowedTATCommandIDsByRegion) != 0 {
		t.Fatalf("invalid region map must fail closed: %v", cfg.AllowedTATCommandIDsByRegion)
	}
	t.Setenv("WEBSITE_CREDENTIAL_TAT_COMMAND_IDS_BY_REGION", `{"ap-johorbahru":"cmd-johor"}`)
	cfg = loadConfig()
	if cfg.AllowedTATCommandIDsByRegion["ap-johorbahru"] != "cmd-johor" {
		t.Fatalf("region map = %v", cfg.AllowedTATCommandIDsByRegion)
	}
}
