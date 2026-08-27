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
