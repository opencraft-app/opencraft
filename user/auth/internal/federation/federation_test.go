package federation

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"
)

func testRegistry(t *testing.T) *Registry {
	t.Helper()
	registry, err := NewRegistry([]Client{{
		ID:           "personal-site",
		DisplayName:  "Personal Site",
		CallbackPath: "/auth/lightvela/callback",
		CallbackHosts: []CallbackHost{
			{Host: "lightvela.site", IncludeSubdomains: true},
			{Host: "lightvela.tech", IncludeSubdomains: true},
		},
		ExactCallbackURLs: []string{"http://localhost:5173/auth/lightvela/callback"},
		HMACKeys:          map[string][]byte{"h1": bytes.Repeat([]byte{0x44}, 32)},
	}})
	if err != nil {
		t.Fatalf("NewRegistry: %v", err)
	}
	return registry
}

func TestRegistryValidatesOnlyOwnedExactCallbacks(t *testing.T) {
	registry := testRegistry(t)
	for _, raw := range []string{
		"https://lightvela.site/auth/lightvela/callback",
		"https://a.b.lightvela.tech/auth/lightvela/callback",
		"http://localhost:5173/auth/lightvela/callback",
	} {
		got, err := registry.ValidateCallback("personal-site", raw)
		if err != nil {
			t.Fatalf("ValidateCallback(%q): %v", raw, err)
		}
		if got != raw {
			t.Fatalf("normalized callback = %q, want %q", got, raw)
		}
	}
	if got, err := registry.ValidateCallback("personal-site", "https://lightvela.site:443/auth/lightvela/callback"); err != nil || got != "https://lightvela.site/auth/lightvela/callback" {
		t.Fatalf("default HTTPS port normalization = %q, %v", got, err)
	}

	for _, raw := range []string{
		"http://lightvela.site/auth/lightvela/callback",
		"https://user@lightvela.site/auth/lightvela/callback",
		"https://lightvela.site:8443/auth/lightvela/callback",
		"https://evillightvela.site/auth/lightvela/callback",
		"https://lightvela.tech.evil.com/auth/lightvela/callback",
		"https://lightvela.tech-attacker.com/auth/lightvela/callback",
		"https://lightvela.site/auth/lightvela/callback/extra",
		"https://lightvela.site/auth/lightvela/callback#fragment",
	} {
		if _, err := registry.ValidateCallback("personal-site", raw); err == nil {
			t.Fatalf("ValidateCallback(%q) succeeded, want rejection", raw)
		}
	}
}

func TestCodecRoundTripsAndSeparatesTokenClasses(t *testing.T) {
	now := time.Date(2026, 8, 21, 10, 0, 0, 0, time.UTC)
	codec, err := NewCodec(CodecConfig{
		Environment: "test",
		ActiveKeyID: "k2",
		Keys: map[string][]byte{
			"k1": bytes.Repeat([]byte{0x11}, 32),
			"k2": bytes.Repeat([]byte{0x22}, 32),
		},
		NonceKey: bytes.Repeat([]byte{0x33}, 32),
	})
	if err != nil {
		t.Fatalf("NewCodec: %v", err)
	}

	ticket, err := codec.IssueHandoff(HandoffClaims{
		SourceSessionToken: "source-secret",
		UserID:             "user-1",
		ClientID:           "personal-site",
		RedirectURI:        "https://app.lightvela.site/auth/lightvela/callback",
		IssuedAt:           now,
		ExpiresAt:          now.Add(5 * time.Second),
	})
	if err != nil {
		t.Fatalf("IssueHandoff: %v", err)
	}
	claims, err := codec.ParseHandoff(ticket, now.Add(5*time.Second-time.Nanosecond))
	if err != nil {
		t.Fatalf("ParseHandoff before expiry: %v", err)
	}
	if claims.SourceSessionToken != "source-secret" || claims.UserID != "user-1" || claims.KeyID != "k2" {
		t.Fatalf("unexpected claims: %+v", claims)
	}
	if _, err := codec.ParseHandoff(ticket, now.Add(5*time.Second)); err == nil {
		t.Fatal("expired handoff parsed successfully")
	}
	if _, err := codec.ParseDelegated(ticket, now); err == nil {
		t.Fatal("handoff parsed as delegated session")
	}

	otherEnvironment, err := NewCodec(CodecConfig{
		Environment: "production",
		ActiveKeyID: "k2",
		Keys:        map[string][]byte{"k2": bytes.Repeat([]byte{0x22}, 32)},
		NonceKey:    bytes.Repeat([]byte{0x33}, 32),
	})
	if err != nil {
		t.Fatalf("NewCodec(other): %v", err)
	}
	if _, err := otherEnvironment.ParseHandoff(ticket, now); err == nil {
		t.Fatal("cross-environment handoff parsed successfully")
	}
}

func TestCodecRejectsTokenKeyIDThatDoesNotMatchEncryptedClaims(t *testing.T) {
	now := time.Date(2026, 8, 21, 10, 0, 0, 0, time.UTC)
	sharedKey := bytes.Repeat([]byte{0x11}, 32)
	codec, err := NewCodec(CodecConfig{
		Environment: "test", ActiveKeyID: "k1",
		Keys: map[string][]byte{"k1": sharedKey, "k2": sharedKey}, NonceKey: bytes.Repeat([]byte{0x33}, 32),
	})
	if err != nil {
		t.Fatal(err)
	}
	ticket, err := codec.IssueHandoff(HandoffClaims{
		SourceSessionToken: "source-secret", UserID: "user-1", ClientID: "personal-site",
		RedirectURI: "https://app.lightvela.site/auth/lightvela/callback", IssuedAt: now, ExpiresAt: now.Add(5 * time.Second),
	})
	if err != nil {
		t.Fatal(err)
	}
	tampered := strings.Replace(ticket, "lvf1.k1.", "lvf1.k2.", 1)
	if _, err := codec.ParseHandoff(tampered, now); err == nil {
		t.Fatal("token with mismatched outer and encrypted key IDs parsed successfully")
	}
}

func TestDelegatedExchangeIsDeterministicPerHandoffCiphertext(t *testing.T) {
	now := time.Date(2026, 8, 21, 10, 0, 0, 0, time.UTC)
	codec, err := NewCodec(CodecConfig{
		Environment: "test",
		ActiveKeyID: "k1",
		Keys:        map[string][]byte{"k1": bytes.Repeat([]byte{0x11}, 32)},
		NonceKey:    bytes.Repeat([]byte{0x33}, 32),
	})
	if err != nil {
		t.Fatalf("NewCodec: %v", err)
	}
	ticket, err := codec.IssueHandoff(HandoffClaims{
		SourceSessionToken: "source-secret",
		UserID:             "user-1",
		ClientID:           "personal-site",
		RedirectURI:        "https://app.lightvela.site/auth/lightvela/callback",
		IssuedAt:           now,
		ExpiresAt:          now.Add(5 * time.Second),
	})
	if err != nil {
		t.Fatalf("IssueHandoff: %v", err)
	}
	claims, err := codec.ParseHandoff(ticket, now)
	if err != nil {
		t.Fatalf("ParseHandoff: %v", err)
	}

	first, err := codec.IssueDelegated(ticket, claims, now.Add(time.Hour))
	if err != nil {
		t.Fatalf("IssueDelegated(first): %v", err)
	}
	second, err := codec.IssueDelegated(ticket, claims, now.Add(time.Hour))
	if err != nil {
		t.Fatalf("IssueDelegated(second): %v", err)
	}
	if first != second {
		t.Fatal("replayed exchange minted a different delegated session")
	}
	delegated, err := codec.ParseDelegated(first, now.Add(30*time.Minute))
	if err != nil {
		t.Fatalf("ParseDelegated: %v", err)
	}
	if delegated.SourceSessionToken != "source-secret" || delegated.ClientID != "personal-site" {
		t.Fatalf("unexpected delegated claims: %+v", delegated)
	}
}

func TestDelegatedExchangeRemainsDeterministicAcrossActiveKeyRotation(t *testing.T) {
	now := time.Date(2026, 8, 21, 10, 0, 0, 0, time.UTC)
	keys := map[string][]byte{
		"k1": bytes.Repeat([]byte{0x11}, 32),
		"k2": bytes.Repeat([]byte{0x22}, 32),
	}
	before, err := NewCodec(CodecConfig{Environment: "test", ActiveKeyID: "k1", Keys: keys, NonceKey: bytes.Repeat([]byte{0x33}, 32)})
	if err != nil {
		t.Fatal(err)
	}
	after, err := NewCodec(CodecConfig{Environment: "test", ActiveKeyID: "k2", Keys: keys, NonceKey: bytes.Repeat([]byte{0x33}, 32)})
	if err != nil {
		t.Fatal(err)
	}
	ticket, err := before.IssueHandoff(HandoffClaims{
		SourceSessionToken: "source-secret", UserID: "user-1", ClientID: "personal-site",
		RedirectURI: "https://app.lightvela.site/auth/lightvela/callback", IssuedAt: now, ExpiresAt: now.Add(5 * time.Second),
	})
	if err != nil {
		t.Fatal(err)
	}
	claims, err := after.ParseHandoff(ticket, now)
	if err != nil {
		t.Fatal(err)
	}
	first, err := before.IssueDelegated(ticket, claims, now.Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	second, err := after.IssueDelegated(ticket, claims, now.Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if first != second {
		t.Fatal("active key rotation changed deterministic exchange output")
	}
}

func TestVerifierChecksCanonicalRequestAndBody(t *testing.T) {
	now := time.Date(2026, 8, 21, 10, 0, 0, 0, time.UTC)
	registry := testRegistry(t)
	verifier := NewVerifier(registry, 30*time.Second)
	body := []byte(`{"ticket":"opaque"}`)
	req, err := http.NewRequest(http.MethodPost, "https://auth.example/auth/federation/exchange?b=2&a=hello%20world", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set(HeaderClientID, "personal-site")
	req.Header.Set(HeaderKeyID, "h1")
	req.Header.Set(HeaderTimestamp, now.Format(time.RFC3339))
	req.Header.Set(HeaderRequestID, "req_0123456789abcdef")
	canonical := CanonicalString("personal-site", "h1", http.MethodPost, "/auth/federation/exchange", url.Values{"a": {"hello world"}, "b": {"2"}}, now.Format(time.RFC3339), "req_0123456789abcdef", body)
	mac := hmac.New(sha256.New, bytes.Repeat([]byte{0x44}, 32))
	_, _ = mac.Write([]byte(canonical))
	req.Header.Set(HeaderSignature, base64.RawURLEncoding.EncodeToString(mac.Sum(nil)))

	identity, err := verifier.Verify(req, body, now)
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if identity.ClientID != "personal-site" || identity.KeyID != "h1" || identity.RequestID != "req_0123456789abcdef" {
		t.Fatalf("unexpected identity: %+v", identity)
	}
	if _, err := verifier.Verify(req, []byte(`{"ticket":"tampered"}`), now); err == nil {
		t.Fatal("body tampering verified successfully")
	}
	if _, err := verifier.Verify(req, body, now.Add(31*time.Second)); err == nil {
		t.Fatal("stale signed request verified successfully")
	}
	req.URL.RawQuery = "a=1;b=2"
	canonical = CanonicalString("personal-site", "h1", http.MethodPost, "/auth/federation/exchange", req.URL.Query(), now.Format(time.RFC3339), "req_0123456789abcdef", body)
	mac = hmac.New(sha256.New, bytes.Repeat([]byte{0x44}, 32))
	_, _ = mac.Write([]byte(canonical))
	req.Header.Set(HeaderSignature, base64.RawURLEncoding.EncodeToString(mac.Sum(nil)))
	if _, err := verifier.Verify(req, body, now); err == nil {
		t.Fatal("malformed canonical query verified successfully")
	}
}
