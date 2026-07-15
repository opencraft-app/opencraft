package main

import "testing"

func TestShadowCloudLadderSecretFallback(t *testing.T) {
	t.Setenv("SHADOW_CLOUDLADDER_HMAC_SECRET", "")
	t.Setenv("CLOUDLADDER_SHADOW_HMAC_SECRET", "legacy-secret")
	if got := shadowCloudLadderSecret(); got != "legacy-secret" {
		t.Fatalf("shadowCloudLadderSecret() = %q, want legacy fallback", got)
	}

	t.Setenv("SHADOW_CLOUDLADDER_HMAC_SECRET", "preferred-secret")
	if got := shadowCloudLadderSecret(); got != "preferred-secret" {
		t.Fatalf("shadowCloudLadderSecret() = %q, want preferred value", got)
	}
}
