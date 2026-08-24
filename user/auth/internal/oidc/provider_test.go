package oidc

import (
	"bytes"
	"crypto/ed25519"
	"errors"
	"net/url"
	"testing"
	"time"
)

func newTestProvider(t *testing.T) *Provider {
	t.Helper()

	registry, err := NewRegistry([]Client{{
		ID:           "site-gateway",
		DisplayName:  "Lightvela Sites",
		RedirectURIs: []string{"https://sites-auth.lightvela.tech/auth/lightvela/callback"},
	}})
	if err != nil {
		t.Fatalf("NewRegistry() error = %v", err)
	}

	return NewProvider(ProviderConfig{
		Issuer:            "https://auth.lightclaw.test",
		AuthorizationPath: "/oauth2/authorize",
		TokenPath:         "/oauth2/token",
		JWKSPath:          "/.well-known/jwks.json",
		Registry:          registry,
		CodeStore:         NewMemoryCodeStore(func() time.Time { return time.Date(2026, 8, 24, 12, 30, 0, 0, time.UTC) }),
		SigningKeyID:      "oidc-1",
		SigningKey:        ed25519.NewKeyFromSeed(bytes.Repeat([]byte{0x11}, ed25519.SeedSize)),
		Now:               func() time.Time { return time.Date(2026, 8, 24, 12, 30, 0, 0, time.UTC) },
	})
}

func TestValidateAuthorizeRequestRejectsInvalidPKCEAndNonce(t *testing.T) {
	t.Parallel()

	provider := newTestProvider(t)
	validChallenge := "DwBzhbb51LfusnSGBa_hqYSgo7-j8BTQnip4TOnlzRo"

	for _, req := range []AuthorizeRequest{
		{
			ClientID:            "site-gateway",
			RedirectURI:         "https://sites-auth.lightvela.tech/auth/lightvela/callback",
			ResponseType:        "code",
			Scope:               "openid profile email",
			State:               "state-1",
			Nonce:               "",
			CodeChallenge:       validChallenge,
			CodeChallengeMethod: "S256",
		},
		{
			ClientID:            "site-gateway",
			RedirectURI:         "https://sites-auth.lightvela.tech/auth/lightvela/callback",
			ResponseType:        "code",
			Scope:               "openid profile email",
			State:               "state-1",
			Nonce:               string(bytes.Repeat([]byte("n"), 256)),
			CodeChallenge:       validChallenge,
			CodeChallengeMethod: "S256",
		},
		{
			ClientID:            "site-gateway",
			RedirectURI:         "https://sites-auth.lightvela.tech/auth/lightvela/callback",
			ResponseType:        "code",
			Scope:               "openid profile email",
			State:               "state-1",
			Nonce:               "nonce-1",
			CodeChallenge:       "short",
			CodeChallengeMethod: "S256",
		},
		{
			ClientID:            "site-gateway",
			RedirectURI:         "https://sites-auth.lightvela.tech/auth/lightvela/callback",
			ResponseType:        "code",
			Scope:               "openid profile email",
			State:               "state-1",
			Nonce:               "nonce-1",
			CodeChallenge:       "DwBzhbb51LfusnSGBa_hqYSgo7-j8BTQnip4TOnlzR=",
			CodeChallengeMethod: "S256",
		},
		{
			ClientID:            "site-gateway",
			RedirectURI:         "https://sites-auth.lightvela.tech/auth/lightvela/callback",
			ResponseType:        "code",
			Scope:               "openid profile email",
			State:               "state-1",
			Nonce:               "nonce-1",
			CodeChallenge:       "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
			CodeChallengeMethod: "plain",
		},
	} {
		if _, err := provider.ValidateAuthorizeRequest(req); !errors.Is(err, ErrInvalidRequest) {
			t.Fatalf("ValidateAuthorizeRequest(%+v) error = %v, want ErrInvalidRequest", req, err)
		}
	}
}

func TestConsumeAuthorizationCodeRejectsInvalidVerifierFormat(t *testing.T) {
	t.Parallel()

	provider := newTestProvider(t)
	validVerifier := "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
	created, err := provider.CreateAuthorizationCode(t.Context(), "user-1", AuthorizeRequest{
		ClientID:            "site-gateway",
		RedirectURI:         "https://sites-auth.lightvela.tech/auth/lightvela/callback",
		ResponseType:        "code",
		Scope:               "openid profile email",
		State:               "state-1",
		Nonce:               "nonce-1",
		CodeChallenge:       S256Challenge(validVerifier),
		CodeChallengeMethod: "S256",
	})
	if err != nil {
		t.Fatalf("CreateAuthorizationCode() error = %v", err)
	}
	code := extractCodeFromRedirect(t, created.RedirectTo)

	for _, verifier := range []string{
		"short",
		string(bytes.Repeat([]byte("a"), 129)),
		"dBjftJeZ4CVP mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
		"dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk=",
		" dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
		"dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk ",
	} {
		_, err := provider.ConsumeAuthorizationCode(t.Context(), TokenRequest{
			GrantType:    "authorization_code",
			Code:         code,
			ClientID:     "site-gateway",
			RedirectURI:  "https://sites-auth.lightvela.tech/auth/lightvela/callback",
			CodeVerifier: verifier,
		})
		if !errors.Is(err, ErrInvalidRequest) {
			t.Fatalf("ConsumeAuthorizationCode(%q) error = %v, want ErrInvalidRequest", verifier, err)
		}
	}
}

func extractCodeFromRedirect(t *testing.T, raw string) string {
	t.Helper()
	parsed, err := url.Parse(raw)
	if err != nil {
		t.Fatalf("url.Parse(%q) error = %v", raw, err)
	}
	code := parsed.Query().Get("code")
	if code == "" {
		t.Fatalf("redirect %q missing code", raw)
	}
	return code
}
