package siteauth

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"strings"
	"time"
)

const (
	launchTTL  = 5 * time.Minute
	stateTTL   = 5 * time.Minute
	handoffTTL = 5 * time.Second
	maxTTL     = 5 * time.Minute
)

var (
	ErrInvalidToken = errors.New("invalid auth token")
	ErrTokenConfig  = errors.New("invalid auth token config")
)

type TokenCodecConfig struct {
	ActiveKeyID string
	Keys        map[string][]byte
	Clock       func() time.Time
	Rand        io.Reader
	SessionTTL  time.Duration
}

type TokenCodec struct {
	activeKeyID string
	keys        map[string]cipher.AEAD
	clock       func() time.Time
	rand        io.Reader
	sessionTTL  time.Duration
}

type LaunchClaims struct {
	SiteID      string `json:"site_id"`
	SiteHost    string `json:"site_host"`
	ReturnTo    string `json:"return_to"`
	CallbackURL string `json:"callback_url"`
}

type StateClaims struct {
	SiteID       string `json:"site_id"`
	SiteHost     string `json:"site_host"`
	ReturnTo     string `json:"return_to"`
	CallbackURL  string `json:"callback_url"`
	State        string `json:"state"`
	PKCEVerifier string `json:"pkce_verifier"`
	Nonce        string `json:"nonce"`
	LaunchDigest string `json:"launch_digest"`
}

type HandoffClaims struct {
	SiteID   string `json:"site_id"`
	SiteHost string `json:"site_host"`
	UserID   string `json:"user_id"`
	Nonce    string `json:"nonce"`
	ReturnTo string `json:"return_to"`
}

type SessionClaims struct {
	SiteID   string `json:"site_id"`
	SiteHost string `json:"site_host"`
	UserID   string `json:"user_id"`
	Nonce    string `json:"nonce"`
}

type tokenEnvelope struct {
	Kind       string          `json:"kind"`
	IssuedAt   int64           `json:"iat"`
	ExpiresAt  int64           `json:"exp"`
	ClaimsJSON json.RawMessage `json:"claims"`
}

func NewTokenCodec(cfg TokenCodecConfig) (*TokenCodec, error) {
	activeKeyID := strings.TrimSpace(cfg.ActiveKeyID)
	if activeKeyID == "" || len(cfg.Keys) == 0 {
		return nil, ErrTokenConfig
	}
	keys := make(map[string]cipher.AEAD, len(cfg.Keys))
	for keyID, rawKey := range cfg.Keys {
		keyID = strings.TrimSpace(keyID)
		if keyID == "" {
			return nil, ErrTokenConfig
		}
		if len(rawKey) < 32 {
			return nil, fmt.Errorf("%w: key %q must be at least 32 bytes", ErrTokenConfig, keyID)
		}
		block, err := aes.NewCipher(rawKey[:32])
		if err != nil {
			return nil, fmt.Errorf("%w: key %q: %v", ErrTokenConfig, keyID, err)
		}
		aead, err := cipher.NewGCM(block)
		if err != nil {
			return nil, fmt.Errorf("%w: key %q: %v", ErrTokenConfig, keyID, err)
		}
		keys[keyID] = aead
	}
	aead, ok := keys[activeKeyID]
	if !ok || aead == nil {
		return nil, fmt.Errorf("%w: active key %q missing", ErrTokenConfig, activeKeyID)
	}
	clock := cfg.Clock
	if clock == nil {
		clock = time.Now
	}
	random := cfg.Rand
	if random == nil {
		random = rand.Reader
	}
	sessionTTL := cfg.SessionTTL
	if sessionTTL <= 0 {
		sessionTTL = maxTTL
	}
	if sessionTTL > maxTTL {
		return nil, fmt.Errorf("%w: session ttl must not exceed %s", ErrTokenConfig, maxTTL)
	}
	return &TokenCodec{
		activeKeyID: activeKeyID,
		keys:        keys,
		clock:       clock,
		rand:        random,
		sessionTTL:  sessionTTL,
	}, nil
}

func (c *TokenCodec) SealLaunch(claims LaunchClaims) (string, error) {
	if claims.SiteID = strings.TrimSpace(claims.SiteID); claims.SiteID == "" {
		return "", ErrInvalidToken
	}
	if claims.SiteHost = normalizeHost(claims.SiteHost); claims.SiteHost == "" || claims.ReturnTo == "" || claims.CallbackURL == "" {
		return "", ErrInvalidToken
	}
	return c.seal("launch", launchTTL, claims)
}

func (c *TokenCodec) OpenLaunch(raw string) (*LaunchClaims, error) {
	var claims LaunchClaims
	if err := c.open(raw, "launch", &claims); err != nil {
		return nil, err
	}
	return &claims, nil
}

func (c *TokenCodec) SealState(claims StateClaims) (string, error) {
	if claims.SiteID = strings.TrimSpace(claims.SiteID); claims.SiteID == "" {
		return "", ErrInvalidToken
	}
	if claims.SiteHost = normalizeHost(claims.SiteHost); claims.SiteHost == "" || claims.ReturnTo == "" || claims.CallbackURL == "" || claims.State == "" || claims.PKCEVerifier == "" || claims.Nonce == "" || claims.LaunchDigest == "" {
		return "", ErrInvalidToken
	}
	return c.seal("state", stateTTL, claims)
}

func (c *TokenCodec) OpenState(raw string) (*StateClaims, error) {
	var claims StateClaims
	if err := c.open(raw, "state", &claims); err != nil {
		return nil, err
	}
	return &claims, nil
}

func (c *TokenCodec) SealHandoff(claims HandoffClaims) (string, error) {
	if claims.SiteID = strings.TrimSpace(claims.SiteID); claims.SiteID == "" {
		return "", ErrInvalidToken
	}
	if claims.SiteHost = normalizeHost(claims.SiteHost); claims.SiteHost == "" || claims.UserID == "" || claims.Nonce == "" || claims.ReturnTo == "" {
		return "", ErrInvalidToken
	}
	return c.seal("handoff", handoffTTL, claims)
}

func (c *TokenCodec) OpenHandoff(raw string, expectedHost string) (*HandoffClaims, error) {
	var claims HandoffClaims
	if err := c.open(raw, "handoff", &claims); err != nil {
		return nil, err
	}
	if claims.SiteHost != normalizeHost(expectedHost) {
		return nil, ErrInvalidToken
	}
	return &claims, nil
}

func (c *TokenCodec) SealSession(claims SessionClaims) (string, error) {
	if claims.SiteID = strings.TrimSpace(claims.SiteID); claims.SiteID == "" {
		return "", ErrInvalidToken
	}
	if claims.SiteHost = normalizeHost(claims.SiteHost); claims.SiteHost == "" || claims.UserID == "" || claims.Nonce == "" {
		return "", ErrInvalidToken
	}
	return c.seal("session", c.sessionTTL, claims)
}

func (c *TokenCodec) OpenSession(raw string, expectedHost string) (*SessionClaims, error) {
	var claims SessionClaims
	if err := c.open(raw, "session", &claims); err != nil {
		return nil, err
	}
	if claims.SiteHost != normalizeHost(expectedHost) {
		return nil, ErrInvalidToken
	}
	return &claims, nil
}

func (c *TokenCodec) seal(kind string, ttl time.Duration, claims any) (string, error) {
	if c == nil || ttl <= 0 {
		return "", ErrInvalidToken
	}
	claimsJSON, err := json.Marshal(claims)
	if err != nil {
		return "", err
	}
	now := c.clock()
	env := tokenEnvelope{
		Kind:       kind,
		IssuedAt:   now.Unix(),
		ExpiresAt:  now.Add(ttl).Unix(),
		ClaimsJSON: claimsJSON,
	}
	plaintext, err := json.Marshal(env)
	if err != nil {
		return "", err
	}
	aead := c.keys[c.activeKeyID]
	nonce := make([]byte, aead.NonceSize())
	if _, err := io.ReadFull(c.rand, nonce); err != nil {
		return "", err
	}
	sealed := aead.Seal(nil, nonce, plaintext, []byte(scopeAAD(kind)))
	payload := append(nonce, sealed...)
	return c.activeKeyID + "." + base64.RawURLEncoding.EncodeToString(payload), nil
}

func (c *TokenCodec) open(raw string, expectedKind string, out any) error {
	if c == nil || strings.TrimSpace(raw) == "" {
		return ErrInvalidToken
	}
	parts := strings.SplitN(raw, ".", 2)
	if len(parts) != 2 || strings.TrimSpace(parts[0]) == "" || strings.TrimSpace(parts[1]) == "" {
		return ErrInvalidToken
	}
	aead, ok := c.keys[strings.TrimSpace(parts[0])]
	if !ok {
		return ErrInvalidToken
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil || len(payload) <= aead.NonceSize() {
		return ErrInvalidToken
	}
	nonce := payload[:aead.NonceSize()]
	ciphertext := payload[aead.NonceSize():]
	plaintext, err := aead.Open(nil, nonce, ciphertext, []byte(scopeAAD(expectedKind)))
	if err != nil {
		return ErrInvalidToken
	}
	var env tokenEnvelope
	if err := json.Unmarshal(plaintext, &env); err != nil {
		return ErrInvalidToken
	}
	if env.Kind != expectedKind || env.IssuedAt <= 0 || env.ExpiresAt <= env.IssuedAt {
		return ErrInvalidToken
	}
	now := c.clock().Unix()
	if now > env.ExpiresAt || now < env.IssuedAt-5 {
		return ErrInvalidToken
	}
	if err := json.Unmarshal(env.ClaimsJSON, out); err != nil {
		return ErrInvalidToken
	}
	return nil
}

func DigestToken(raw string) string {
	sum := sha256.Sum256([]byte(raw))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

func scopeAAD(kind string) string {
	return "site-gateway-auth/v1/" + kind
}

func normalizeHost(raw string) string {
	raw = strings.TrimSpace(raw)
	if host, _, err := net.SplitHostPort(raw); err == nil {
		raw = host
	}
	return strings.TrimSuffix(strings.ToLower(raw), ".")
}
