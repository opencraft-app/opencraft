package config

import "testing"

func TestParseAPIConfResetsInvalidChurnGuardPressureConfig(t *testing.T) {
	original := ServerConf
	t.Cleanup(func() {
		ServerConf = original
	})

	enabled := true
	ServerConf = &GlobalConfig{
		APIConfig: &APIConfig{
			Instance: &InstanceAPIConfig{
				DefaultTemplateClassID:    "openclaw-default",
				CreatePoolMaxAttempts:     -1,
				ChurnGuardEnabled:         &enabled,
				UserAbuseCreateThreshold:  -1,
				UserAbuseDestroyThreshold: 0,
				UserAbuseCooldownSeconds:  -10,
				UserAbuseRefreshSeconds:   0,
				PressureRefreshSec:        -1,
				PressureTTLSec:            0,
				PressureCleanRatio:        1.5,
				PressureMinClean:          0,
			},
		},
	}

	parseAPIConf()

	instance := ServerConf.APIConfig.Instance
	if instance.CreatePoolMaxAttempts != 0 {
		t.Fatalf("expected create pool max attempts fallback to 0, got %d", instance.CreatePoolMaxAttempts)
	}
	if instance.DefaultTemplateClassID != "openclaw-default" {
		t.Fatalf("expected template class id to be preserved, got %q", instance.DefaultTemplateClassID)
	}
	if instance.PressureRefreshSec != 5 {
		t.Fatalf("expected default refresh seconds, got %d", instance.PressureRefreshSec)
	}
	if instance.UserAbuseCreateThreshold != 10 {
		t.Fatalf("expected default user abuse create threshold, got %d", instance.UserAbuseCreateThreshold)
	}
	if instance.UserAbuseDestroyThreshold != 8 {
		t.Fatalf("expected default user abuse destroy threshold, got %d", instance.UserAbuseDestroyThreshold)
	}
	if instance.UserAbuseCooldownSeconds != 600 {
		t.Fatalf("expected default user abuse cooldown seconds, got %d", instance.UserAbuseCooldownSeconds)
	}
	if instance.UserAbuseRefreshSeconds != 10 {
		t.Fatalf("expected default user abuse refresh seconds, got %d", instance.UserAbuseRefreshSeconds)
	}
	if instance.PressureTTLSec != 15 {
		t.Fatalf("expected default ttl seconds, got %d", instance.PressureTTLSec)
	}
	if instance.PressureCleanRatio != 0.25 {
		t.Fatalf("expected default clean ratio, got %v", instance.PressureCleanRatio)
	}
	if instance.PressureMinClean != 2 {
		t.Fatalf("expected default min clean, got %d", instance.PressureMinClean)
	}
	if instance.SoulTemplateDir != "/etc/ctl/souls" {
		t.Fatalf("expected default soul template dir, got %q", instance.SoulTemplateDir)
	}
}
