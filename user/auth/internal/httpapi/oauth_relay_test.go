package httpapi

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestOAuthRelayStateRoundTrip(t *testing.T) {
	encoded, err := encodeOAuthRelayState(oauthRelayState{
		Version:           1,
		Mode:              oauthRelayModeIssuer,
		Provider:          "github",
		Nonce:             "nonce-123",
		IssuerRedirectURI: "https://lightclaw.tech/auth/oauth/github/callback",
		TargetCallbackURI: "https://api-sandbox-kr-3.lightclaw.tech/auth/oauth/github/callback",
	})
	if err != nil {
		t.Fatalf("encode relay state: %v", err)
	}
	decoded, err := decodeOAuthRelayState(encoded)
	if err != nil {
		t.Fatalf("decode relay state: %v", err)
	}
	if decoded.Provider != "github" || decoded.Nonce != "nonce-123" || decoded.TargetCallbackURI != "https://api-sandbox-kr-3.lightclaw.tech/auth/oauth/github/callback" {
		t.Fatalf("unexpected decoded relay state: %+v", decoded)
	}
}

func TestOAuthRelayRejectsInvalidIssuerRedirectURI(t *testing.T) {
	cases := []string{
		"http://lightclaw.tech/auth/oauth/qq/callback",
		"https://user@lightclaw.tech/auth/oauth/qq/callback",
		"https://relay.example.com/auth/oauth/qq/callback",
		"https://lightclaw.tech:8443/auth/oauth/qq/callback",
		"https://lightclaw.tech/auth/oauth/github/callback",
		"https://lightclaw.tech/auth/oauth/qq/callback?next=1",
	}
	for _, raw := range cases {
		if err := validateOAuthRelayIssuerRedirectURI("qq", raw); err == nil {
			t.Fatalf("expected issuer redirect uri %q to be rejected", raw)
		}
	}
}

func TestOAuthRelayTargetCallbackIsDerivedFromSandboxHost(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "https://api-sandbox-sg-1.lightclaw.tech/auth/oauth/qq/start", nil)
	target, err := deriveOAuthRelayTargetCallbackURI(req, "qq", qqOAuthStateCookiePath)
	if err != nil {
		t.Fatalf("derive target callback: %v", err)
	}
	if target != "https://api-sandbox-sg-1.lightclaw.tech/auth/oauth/qq/callback" {
		t.Fatalf("unexpected target callback: %q", target)
	}
}

func TestOAuthRelayRejectsNonSandboxTargetHosts(t *testing.T) {
	cases := []string{
		"https://lightclaw.tech/auth/oauth/qq/callback",
		"https://api.lightclaw.tech/auth/oauth/qq/callback",
		"https://api-sandbox-bj-x.lightclaw.tech/auth/oauth/qq/callback",
		"https://api-sandbox-bj-7.example.com/auth/oauth/qq/callback",
		"https://api-sandbox-bj-7.lightclaw.tech:8443/auth/oauth/qq/callback",
	}
	for _, raw := range cases {
		if err := validateOAuthRelayTargetCallbackURI("qq", raw); err == nil {
			t.Fatalf("expected target callback %q to be rejected", raw)
		}
	}
}

func TestOAuthRelayStartRejectsNonSandboxStartHost(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "https://lightclaw.tech/auth/oauth/qq/start?relay_mode=issuer&issuer_redirect_uri=https%3A%2F%2Flightclaw.tech%2Fauth%2Foauth%2Fqq%2Fcallback", nil)
	if _, err := buildOAuthStartState(req, "qq", qqOAuthStateCookiePath, "https://lightclaw.tech/auth/oauth/qq/callback", "nonce"); err == nil {
		t.Fatal("expected relay start on non-sandbox host to fail")
	}
}

func TestOAuthRelayCurrentCallbackMatching(t *testing.T) {
	state := oauthRelayState{
		Version:           1,
		Mode:              oauthRelayModeIssuer,
		Provider:          "qq",
		Nonce:             "nonce",
		IssuerRedirectURI: "https://lightclaw.tech/auth/oauth/qq/callback",
		TargetCallbackURI: "https://api-sandbox-bj-7.lightclaw.tech/auth/oauth/qq/callback",
	}
	issuerReq := httptest.NewRequest(http.MethodGet, "https://lightclaw.tech/auth/oauth/qq/callback", nil)
	targetReq := httptest.NewRequest(http.MethodGet, "https://api-sandbox-bj-7.lightclaw.tech/auth/oauth/qq/callback", nil)
	otherReq := httptest.NewRequest(http.MethodGet, "https://api-sandbox-bj-8.lightclaw.tech/auth/oauth/qq/callback", nil)
	if !isOAuthRelayIssuerCallback(issuerReq, state) {
		t.Fatal("expected issuer callback to match")
	}
	if !isOAuthRelayTargetCallback(targetReq, state) {
		t.Fatal("expected target callback to match")
	}
	if isOAuthRelayTargetCallback(otherReq, state) {
		t.Fatal("expected different sandbox callback to be rejected")
	}
}
