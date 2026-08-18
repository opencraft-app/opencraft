package siteauth

import (
	"crypto/ed25519"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

func TestVerifierAcceptsValidSiteAccessToken(t *testing.T) {
	now := time.Date(2026, 8, 18, 12, 0, 0, 0, time.UTC)
	publicKey, privateKey, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}

	token := signTestToken(t, privateKey, jwt.SigningMethodEdDSA, "key-1", Claims{
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer:    "lightvela-auth",
			Audience:  jwt.ClaimStrings{"lightvela-site-gateway"},
			Subject:   "user-1",
			IssuedAt:  jwt.NewNumericDate(now.Add(-time.Minute)),
			ExpiresAt: jwt.NewNumericDate(now.Add(time.Minute)),
			ID:        "ticket-1",
		},
		SiteHost: "abc.lightvela.tech",
		State:    "state-1",
	})

	verifier, err := NewVerifier(Config{
		Issuer:     "lightvela-auth",
		Audience:   "lightvela-site-gateway",
		PublicKeys: map[string]ed25519.PublicKey{"key-1": publicKey},
		Clock:      func() time.Time { return now },
	})
	if err != nil {
		t.Fatal(err)
	}

	claims, err := verifier.Verify(token, "abc.lightvela.tech", "state-1")
	if err != nil {
		t.Fatalf("Verify() error = %v", err)
	}
	if claims.Subject != "user-1" || claims.SiteHost != "abc.lightvela.tech" {
		t.Fatalf("claims = %+v", claims)
	}
}

func TestVerifierRejectsInvalidSiteAccessTokens(t *testing.T) {
	now := time.Date(2026, 8, 18, 12, 0, 0, 0, time.UTC)
	publicKey, privateKey, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	_, otherPrivateKey, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}

	baseClaims := Claims{
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer:    "lightvela-auth",
			Audience:  jwt.ClaimStrings{"lightvela-site-gateway"},
			IssuedAt:  jwt.NewNumericDate(now.Add(-time.Minute)),
			ExpiresAt: jwt.NewNumericDate(now.Add(time.Minute)),
			ID:        "ticket-1",
		},
		SiteHost: "abc.lightvela.tech",
		State:    "state-1",
	}

	tests := []struct {
		name  string
		sign  ed25519.PrivateKey
		alg   jwt.SigningMethod
		kid   string
		claim Claims
		host  string
		state string
	}{
		{name: "bad signature", sign: otherPrivateKey, alg: jwt.SigningMethodEdDSA, kid: "key-1", claim: baseClaims, host: "abc.lightvela.tech", state: "state-1"},
		{name: "unknown kid", sign: privateKey, alg: jwt.SigningMethodEdDSA, kid: "unknown", claim: baseClaims, host: "abc.lightvela.tech", state: "state-1"},
		{name: "wrong algorithm", sign: privateKey, alg: jwt.SigningMethodHS256, kid: "key-1", claim: baseClaims, host: "abc.lightvela.tech", state: "state-1"},
		{name: "wrong issuer", sign: privateKey, alg: jwt.SigningMethodEdDSA, kid: "key-1", claim: func() Claims { c := baseClaims; c.Issuer = "other"; return c }(), host: "abc.lightvela.tech", state: "state-1"},
		{name: "wrong audience", sign: privateKey, alg: jwt.SigningMethodEdDSA, kid: "key-1", claim: func() Claims { c := baseClaims; c.Audience = jwt.ClaimStrings{"other"}; return c }(), host: "abc.lightvela.tech", state: "state-1"},
		{name: "expired", sign: privateKey, alg: jwt.SigningMethodEdDSA, kid: "key-1", claim: func() Claims { c := baseClaims; c.ExpiresAt = jwt.NewNumericDate(now.Add(-time.Second)); return c }(), host: "abc.lightvela.tech", state: "state-1"},
		{name: "wrong host", sign: privateKey, alg: jwt.SigningMethodEdDSA, kid: "key-1", claim: baseClaims, host: "other.lightvela.tech", state: "state-1"},
		{name: "wrong state", sign: privateKey, alg: jwt.SigningMethodEdDSA, kid: "key-1", claim: baseClaims, host: "abc.lightvela.tech", state: "other"},
	}

	verifier, err := NewVerifier(Config{
		Issuer:     "lightvela-auth",
		Audience:   "lightvela-site-gateway",
		PublicKeys: map[string]ed25519.PublicKey{"key-1": publicKey},
		Clock:      func() time.Time { return now },
	})
	if err != nil {
		t.Fatal(err)
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			token := signTestToken(t, tt.sign, tt.alg, tt.kid, tt.claim)
			if _, err := verifier.Verify(token, tt.host, tt.state); err == nil {
				t.Fatal("Verify() unexpectedly succeeded")
			}
		})
	}
}

func TestVerifierRejectsWrongTokenType(t *testing.T) {
	now := time.Date(2026, 8, 18, 12, 0, 0, 0, time.UTC)
	publicKey, privateKey, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	verifier, err := NewVerifier(Config{
		Issuer:     "lightvela-auth",
		Audience:   "lightvela-site-gateway",
		PublicKeys: map[string]ed25519.PublicKey{"key-1": publicKey},
		Clock:      func() time.Time { return now },
	})
	if err != nil {
		t.Fatal(err)
	}
	token := signTestTokenWithType(t, privateKey, jwt.SigningMethodEdDSA, "key-1", Claims{
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer:    "lightvela-auth",
			Audience:  jwt.ClaimStrings{"lightvela-site-gateway"},
			IssuedAt:  jwt.NewNumericDate(now.Add(-time.Minute)),
			ExpiresAt: jwt.NewNumericDate(now.Add(time.Minute)),
			ID:        "ticket-1",
		},
		SiteHost: "abc.lightvela.tech",
		State:    "state-1",
	}, "JWT")
	if _, err := verifier.Verify(token, "abc.lightvela.tech", "state-1"); err == nil {
		t.Fatal("Verify() unexpectedly accepted the wrong typ")
	}
}

func signTestToken(t *testing.T, key ed25519.PrivateKey, method jwt.SigningMethod, kid string, claims Claims) string {
	return signTestTokenWithType(t, key, method, kid, claims, tokenType)
}

func signTestTokenWithType(t *testing.T, key ed25519.PrivateKey, method jwt.SigningMethod, kid string, claims Claims, typ string) string {
	t.Helper()
	token := jwt.NewWithClaims(method, claims)
	token.Header["typ"] = typ
	token.Header["kid"] = kid
	if method == jwt.SigningMethodHS256 {
		// The verifier must reject this before trying to use an incompatible key.
		signed, err := token.SignedString([]byte(strings.Repeat("x", 32)))
		if err != nil {
			t.Fatal(err)
		}
		return signed
	}
	signed, err := token.SignedString(key)
	if err != nil {
		t.Fatal(err)
	}
	return signed
}
