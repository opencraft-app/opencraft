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
