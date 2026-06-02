package httpapi

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/url"
	"strings"
	"time"

	"github.com/openclaw/openclaw/mono/backend/auth/internal/service"
)

const (
	deviceBindTokenPrefix = "tatdev_"
	deviceBindTokenScope  = "tat:device-bind"
)

type deviceBindTokenCodec struct {
	secret []byte
	ttl    time.Duration
	now    func() time.Time
}

type deviceBindClaims struct {
	Scope       string `json:"scope"`
	UserID      string `json:"uid"`
	DeviceNonce string `json:"nonce,omitempty"`
	ExpiresAt   int64  `json:"exp"`
	IssuedAt    int64  `json:"iat"`
	TokenID     string `json:"jti"`
}

func newDeviceBindTokenCodec(secret string, ttl time.Duration) *deviceBindTokenCodec {
	trimmed := strings.TrimSpace(secret)
	if trimmed == "" {
		return nil
	}
	if ttl <= 0 {
		ttl = 10 * time.Minute
	}
	return &deviceBindTokenCodec{
		secret: []byte(trimmed),
		ttl:    ttl,
		now:    time.Now,
	}
}

func (c *deviceBindTokenCodec) Issue(session *service.AuthSession, returnTo string) (string, time.Time, error) {
	if c == nil {
		return "", time.Time{}, fmt.Errorf("device bind token codec is not configured")
	}
	if session == nil || strings.TrimSpace(session.User.ID) == "" {
		return "", time.Time{}, fmt.Errorf("missing authenticated user")
	}
	now := c.now().UTC()
	expiresAt := now.Add(c.ttl)
	tokenID, err := randomHex(16)
	if err != nil {
		return "", time.Time{}, fmt.Errorf("create token id: %w", err)
	}
	claims := deviceBindClaims{
		Scope:       deviceBindTokenScope,
		UserID:      strings.TrimSpace(session.User.ID),
		DeviceNonce: deviceNonceFromReturnTo(returnTo),
		ExpiresAt:   expiresAt.Unix(),
		IssuedAt:    now.Unix(),
		TokenID:     tokenID,
	}
	payload, err := json.Marshal(claims)
	if err != nil {
		return "", time.Time{}, fmt.Errorf("encode device bind token: %w", err)
	}
	payloadPart := base64.RawURLEncoding.EncodeToString(payload)
	signature := c.sign(payloadPart)
	return deviceBindTokenPrefix + payloadPart + "." + signature, expiresAt, nil
}

func (c *deviceBindTokenCodec) Verify(token string) (deviceBindClaims, error) {
	var claims deviceBindClaims
	if c == nil {
		return claims, fmt.Errorf("device bind token codec is not configured")
	}
	trimmed := strings.TrimSpace(token)
	if !strings.HasPrefix(trimmed, deviceBindTokenPrefix) {
		return claims, fmt.Errorf("not a device bind token")
	}
	parts := strings.Split(strings.TrimPrefix(trimmed, deviceBindTokenPrefix), ".")
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return claims, fmt.Errorf("invalid device bind token")
	}
	expected := c.sign(parts[0])
	if !hmac.Equal([]byte(expected), []byte(parts[1])) {
		return claims, fmt.Errorf("invalid device bind token signature")
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return claims, fmt.Errorf("decode device bind token: %w", err)
	}
	if err := json.Unmarshal(payload, &claims); err != nil {
		return claims, fmt.Errorf("parse device bind token: %w", err)
	}
	if claims.Scope != deviceBindTokenScope || strings.TrimSpace(claims.UserID) == "" {
		return claims, fmt.Errorf("invalid device bind token scope")
	}
	if c.now().UTC().Unix() >= claims.ExpiresAt {
		return claims, fmt.Errorf("device bind token expired")
	}
	return claims, nil
}

func (c *deviceBindTokenCodec) sign(payloadPart string) string {
	mac := hmac.New(sha256.New, c.secret)
	_, _ = mac.Write([]byte(payloadPart))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func randomHex(bytesLen int) (string, error) {
	raw := make([]byte, bytesLen)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	return hex.EncodeToString(raw), nil
}

func deviceNonceFromReturnTo(returnTo string) string {
	parsed, err := url.Parse(strings.TrimSpace(returnTo))
	if err != nil {
		return ""
	}
	return strings.TrimSpace(parsed.Query().Get("device_nonce"))
}

func isDeviceBindReturnTo(returnTo string) bool {
	parsed, err := url.Parse(strings.TrimSpace(returnTo))
	if err != nil {
		return false
	}
	return strings.EqualFold(parsed.Scheme, "http") &&
		isLoopbackHost(parsed.Hostname()) &&
		(parsed.Path == "/lightvela/callback" || parsed.Path == "/lightvela/auth-callback")
}

func appendDeviceBindTokenToReturnTo(rawURL string, token string, expiresAt time.Time) string {
	redirectURL := strings.TrimSpace(rawURL)
	if redirectURL == "" || strings.TrimSpace(token) == "" {
		return redirectURL
	}
	parsed, err := url.Parse(redirectURL)
	if err != nil {
		return redirectURL
	}
	query := parsed.Query()
	query.Set("device_bind_token", strings.TrimSpace(token))
	if !expiresAt.IsZero() {
		query.Set("expires_at", expiresAt.UTC().Format(time.RFC3339))
	}
	parsed.RawQuery = query.Encode()
	parsed.Fragment = ""
	return parsed.String()
}
