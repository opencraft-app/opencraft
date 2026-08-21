package main

import (
	"bytes"
	"encoding/base64"
	"io"
	"log/slog"
	"testing"
	"time"
)

func TestBuildFederationConfigIsDisabledByDefault(t *testing.T) {
	t.Setenv("LIGHTCLAW_FEDERATION_ENABLED", "")
	if config := buildFederationConfig(slog.New(slog.NewTextHandler(io.Discard, nil))); config != nil {
		t.Fatal("federation config enabled without explicit flag")
	}
}

func TestBuildFederationConfigRequiresCompleteSecretBackedConfiguration(t *testing.T) {
	t.Setenv("LIGHTCLAW_FEDERATION_ENABLED", "true")
	t.Setenv("LIGHTCLAW_FEDERATION_ENVIRONMENT", "test")
	t.Setenv("LIGHTCLAW_FEDERATION_ACTIVE_AEAD_KEY_ID", "k1")
	t.Setenv("LIGHTCLAW_FEDERATION_AEAD_KEYS_JSON", `{"k1":"`+base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{0x11}, 32))+`"}`)
	t.Setenv("LIGHTCLAW_FEDERATION_NONCE_KEY", base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{0x22}, 32)))
	t.Setenv("LIGHTCLAW_FEDERATION_CLIENTS_JSON", `[{"id":"personal-site","display_name":"Personal Site","callback_path":"/auth/lightvela/callback","callback_hosts":[{"host":"lightvela.site","include_subdomains":true}],"hmac_keys":{"h1":"`+base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{0x33}, 32))+`"}}]`)
	t.Setenv("LIGHTCLAW_FEDERATION_CTL_BASE_URL", "http://ctl.internal")
	t.Setenv("LIGHTCLAW_FEDERATION_CTL_INTERNAL_TOKEN", "internal-token")
	t.Setenv("LIGHTCLAW_FEDERATION_DELEGATED_SESSION_TTL_SECONDS", "28800")
	config := buildFederationConfig(slog.New(slog.NewTextHandler(io.Discard, nil)))
	if config == nil {
		t.Fatal("complete federation configuration was rejected")
	}
	if config.HandoffTTL != 5*time.Second || config.DelegatedSessionTTL != 8*time.Hour {
		t.Fatalf("unexpected lifetimes: handoff=%s delegated=%s", config.HandoffTTL, config.DelegatedSessionTTL)
	}

	t.Setenv("LIGHTCLAW_FEDERATION_NONCE_KEY", "not-base64")
	if config := buildFederationConfig(slog.New(slog.NewTextHandler(io.Discard, nil))); config != nil {
		t.Fatal("invalid nonce key did not fail closed")
	}
}
