// Package siteauth 定义国内站访问票据的无状态校验协议。
package siteauth

import (
	"crypto/ed25519"
	"errors"
	"fmt"
	"net"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

const (
	tokenType        = "LV-Site-Access"
	MaxTokenLifetime = 5 * time.Minute
)

var (
	errInvalidConfig = errors.New("invalid site access verifier config")
	errInvalidToken  = errors.New("invalid site access token")
)

// Config contains the public verification contract shared by the Auth issuer
// and the domestic site gateway.
type Config struct {
	Issuer     string
	Audience   string
	PublicKeys map[string]ed25519.PublicKey
	Clock      func() time.Time
}

// Claims is the signed payload issued by the trusted LightVela Auth backend.
type Claims struct {
	SiteHost string `json:"site_host"`
	State    string `json:"state"`
	jwt.RegisteredClaims
}

// Verifier validates a site access token without server-side session state.
type Verifier struct {
	issuer     string
	audience   string
	publicKeys map[string]ed25519.PublicKey
	clock      func() time.Time
}

// NewVerifier validates and freezes the public-key configuration.
func NewVerifier(cfg Config) (*Verifier, error) {
	issuer := strings.TrimSpace(cfg.Issuer)
	audience := strings.TrimSpace(cfg.Audience)
	if issuer == "" || audience == "" || len(cfg.PublicKeys) == 0 {
		return nil, errInvalidConfig
	}
	keys := make(map[string]ed25519.PublicKey, len(cfg.PublicKeys))
	for kid, key := range cfg.PublicKeys {
		kid = strings.TrimSpace(kid)
		if kid == "" || len(key) != ed25519.PublicKeySize {
			return nil, fmt.Errorf("%w: invalid public key %q", errInvalidConfig, kid)
		}
		keys[kid] = append(ed25519.PublicKey(nil), key...)
	}
	clock := cfg.Clock
	if clock == nil {
		clock = time.Now
	}
	return &Verifier{issuer: issuer, audience: audience, publicKeys: keys, clock: clock}, nil
}

// Verify checks the token signature, claims, target Host, and browser state.
func (v *Verifier) Verify(rawToken, expectedHost, expectedState string) (*Claims, error) {
	if v == nil || strings.TrimSpace(rawToken) == "" {
		return nil, errInvalidToken
	}
	expectedHost = normalizeHost(expectedHost)
	if expectedHost == "" {
		return nil, errInvalidToken
	}

	claims := &Claims{}
	token, err := jwt.ParseWithClaims(
		rawToken,
		claims,
		func(token *jwt.Token) (any, error) {
			if token.Method != jwt.SigningMethodEdDSA {
				return nil, fmt.Errorf("%w: signing method", errInvalidToken)
			}
			if typ, ok := token.Header["typ"].(string); !ok || typ != tokenType {
				return nil, fmt.Errorf("%w: token type", errInvalidToken)
			}
			kid, ok := token.Header["kid"].(string)
			if !ok || strings.TrimSpace(kid) == "" {
				return nil, fmt.Errorf("%w: key id", errInvalidToken)
			}
			key, ok := v.publicKeys[kid]
			if !ok {
				return nil, fmt.Errorf("%w: unknown key id", errInvalidToken)
			}
			return key, nil
		},
		jwt.WithValidMethods([]string{jwt.SigningMethodEdDSA.Alg()}),
		jwt.WithIssuer(v.issuer),
		jwt.WithAudience(v.audience),
		jwt.WithIssuedAt(),
		jwt.WithTimeFunc(v.clock),
	)
	if err != nil || token == nil || !token.Valid {
		return nil, fmt.Errorf("%w: %v", errInvalidToken, err)
	}
	if claims.IssuedAt == nil || claims.ExpiresAt == nil || strings.TrimSpace(claims.ID) == "" {
		return nil, fmt.Errorf("%w: required claims", errInvalidToken)
	}
	lifetime := claims.ExpiresAt.Time.Sub(claims.IssuedAt.Time)
	if lifetime <= 0 || lifetime > MaxTokenLifetime {
		return nil, fmt.Errorf("%w: token lifetime", errInvalidToken)
	}
	if normalizeHost(claims.SiteHost) != expectedHost || strings.TrimSpace(claims.State) == "" || (expectedState != "" && claims.State != expectedState) {
		return nil, fmt.Errorf("%w: target binding", errInvalidToken)
	}
	return claims, nil
}

// RemainingLifetime uses the verifier clock so callback cookies cannot outlive
// the signed ticket, including in callers with an injected test clock.
func (v *Verifier) RemainingLifetime(claims *Claims) time.Duration {
	if v == nil || claims == nil || claims.ExpiresAt == nil {
		return 0
	}
	return claims.ExpiresAt.Time.Sub(v.clock())
}

func normalizeHost(raw string) string {
	raw = strings.TrimSpace(raw)
	if host, _, err := net.SplitHostPort(raw); err == nil {
		raw = host
	}
	return strings.TrimSuffix(strings.ToLower(raw), ".")
}
