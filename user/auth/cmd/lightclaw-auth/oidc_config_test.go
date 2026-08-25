package main

import (
	"bytes"
	"encoding/base64"
	"io"
	"log/slog"
	"testing"
	"time"

	"github.com/openclaw/openclaw/mono/backend/auth/internal/oidc"
)

func testOIDCCodeStore() oidc.CodeStore {
	return oidc.NewMemoryCodeStore(time.Now)
}

func TestBuildOIDCConfigIsDisabledByDefault(t *testing.T) {
	t.Setenv("LIGHTCLAW_OIDC_ENABLED", "")
	if config := buildOIDCConfig(slog.New(slog.NewTextHandler(io.Discard, nil)), nil); config != nil {
		t.Fatal("oidc config enabled without explicit flag")
	}
}

func TestBuildOIDCConfigRequiresExactRedirectURIsAndSigningKey(t *testing.T) {
	t.Setenv("LIGHTCLAW_OIDC_ENABLED", "true")
	t.Setenv("LIGHTCLAW_OIDC_ISSUER", "https://auth.lightclaw.test")
	t.Setenv("LIGHTCLAW_OIDC_SIGNING_KEY_ID", "oidc-1")
	t.Setenv("LIGHTCLAW_OIDC_SIGNING_KEYS_JSON", `{"oidc-1":"`+base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{0x11}, 32))+`"}`)
	t.Setenv("LIGHTCLAW_OIDC_CLIENTS_JSON", `[{"id":"site-gateway","display_name":"Lightvela Sites","redirect_uris":["https://sites-auth.lightvela.tech/auth/lightvela/callback","https://sites-auth.lightvela.site/auth/lightvela/callback"]}]`)

	if config := buildOIDCConfigWithCodeStore(slog.New(slog.NewTextHandler(io.Discard, nil)), testOIDCCodeStore()); config == nil {
		t.Fatal("complete oidc config was rejected")
	}

	t.Setenv("LIGHTCLAW_OIDC_CLIENTS_JSON", `[{"id":"site-gateway","display_name":"Lightvela Sites","redirect_uris":["https://sites-auth.lightvela.tech/auth/lightvela/callback?x=1"]}]`)
	if config := buildOIDCConfigWithCodeStore(slog.New(slog.NewTextHandler(io.Discard, nil)), testOIDCCodeStore()); config != nil {
		t.Fatal("invalid exact redirect URI did not fail closed")
	}

	t.Setenv("LIGHTCLAW_OIDC_CLIENTS_JSON", `[
		{"id":"site-gateway","display_name":"Lightvela Sites","redirect_uris":["https://sites-auth.lightvela.tech/auth/lightvela/callback","https://sites-auth.lightvela.site/auth/lightvela/callback"]},
		{"id":"other","display_name":"Other","redirect_uris":["https://other.example.com/callback"]}
	]`)
	if config := buildOIDCConfigWithCodeStore(slog.New(slog.NewTextHandler(io.Discard, nil)), testOIDCCodeStore()); config != nil {
		t.Fatal("multiple oidc clients did not fail closed")
	}
}

func TestBuildOIDCConfigRejectsNonMySQLStore(t *testing.T) {
	t.Setenv("LIGHTCLAW_OIDC_ENABLED", "true")
	if config := buildOIDCConfig(slog.New(slog.NewTextHandler(io.Discard, nil)), nil); config != nil {
		t.Fatal("oidc config enabled without a persistent MySQL code store")
	}
}

func TestBuildOIDCConfigRejectsNonCanonicalIssuerURL(t *testing.T) {
	t.Setenv("LIGHTCLAW_OIDC_ENABLED", "true")
	t.Setenv("LIGHTCLAW_OIDC_SIGNING_KEY_ID", "oidc-1")
	t.Setenv("LIGHTCLAW_OIDC_SIGNING_KEYS_JSON", `{"oidc-1":"`+base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{0x11}, 32))+`"}`)
	t.Setenv("LIGHTCLAW_OIDC_CLIENTS_JSON", `[{"id":"site-gateway","display_name":"Lightvela Sites","redirect_uris":["https://sites-auth.lightvela.tech/auth/lightvela/callback","https://sites-auth.lightvela.site/auth/lightvela/callback"]}]`)

	for _, issuer := range []string{
		"http://auth.lightclaw.test",
		"https://user:pass@auth.lightclaw.test",
		"https://auth.lightclaw.test?x=1",
		"https://auth.lightclaw.test#frag",
		"/relative",
	} {
		t.Setenv("LIGHTCLAW_OIDC_ISSUER", issuer)
		if config := buildOIDCConfigWithCodeStore(slog.New(slog.NewTextHandler(io.Discard, nil)), testOIDCCodeStore()); config != nil {
			t.Fatalf("issuer %q did not fail closed", issuer)
		}
	}
}

func TestBuildOIDCConfigRejectsAuthorizationCodeTTLDrift(t *testing.T) {
	t.Setenv("LIGHTCLAW_OIDC_ENABLED", "true")
	t.Setenv("LIGHTCLAW_OIDC_ISSUER", "https://auth.lightclaw.test")
	t.Setenv("LIGHTCLAW_OIDC_SIGNING_KEY_ID", "oidc-1")
	t.Setenv("LIGHTCLAW_OIDC_SIGNING_KEYS_JSON", `{"oidc-1":"`+base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{0x11}, 32))+`"}`)
	t.Setenv("LIGHTCLAW_OIDC_CLIENTS_JSON", `[{"id":"site-gateway","display_name":"Lightvela Sites","redirect_uris":["https://sites-auth.lightvela.tech/auth/lightvela/callback","https://sites-auth.lightvela.site/auth/lightvela/callback"]}]`)

	for _, ttl := range []string{"0", "4", "6", "30"} {
		t.Setenv("LIGHTCLAW_OIDC_AUTHORIZATION_CODE_TTL_SECONDS", ttl)
		if config := buildOIDCConfigWithCodeStore(slog.New(slog.NewTextHandler(io.Discard, nil)), testOIDCCodeStore()); config != nil {
			t.Fatalf("authorization code ttl %q did not fail closed", ttl)
		}
	}
}
