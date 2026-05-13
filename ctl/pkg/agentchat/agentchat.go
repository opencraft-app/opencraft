package agentchat

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"
)

const defaultBusinessCode = "lightvela"

var (
	ErrInvalidConfig    = errors.New("agentchat config is invalid")
	ErrInvalidSignature = errors.New("agentchat signature is invalid")
	ErrInvalidToken     = errors.New("agentchat launch token is invalid")
	ErrExpiredToken     = errors.New("agentchat launch token is expired")
	ErrInvalidRequest   = errors.New("agentchat request is invalid")
)

type Config struct {
	BusinessCode      string
	SecretID          string
	SecretKey         string
	LaunchTokenSecret string
	LaunchTokenTTL    time.Duration
	TimestampSkew     time.Duration
}

type CallbackRequest struct {
	LaunchToken  string
	BusinessCode string
	Timestamp    int64
	Sign         string
}

type LaunchTokenClaims struct {
	UserID       string `json:"user_id"`
	InstanceID   string `json:"instance_id"`
	BusinessCode string `json:"businessCode"`
	IssuedAt     int64  `json:"iat"`
	ExpiresAt    int64  `json:"exp"`
}

func (c Config) normalized() Config {
	c.BusinessCode = strings.TrimSpace(c.BusinessCode)
	if c.BusinessCode == "" {
		c.BusinessCode = defaultBusinessCode
	}
	c.SecretID = strings.TrimSpace(c.SecretID)
	c.SecretKey = strings.TrimSpace(c.SecretKey)
	c.LaunchTokenSecret = strings.TrimSpace(c.LaunchTokenSecret)
	if c.LaunchTokenTTL <= 0 {
		c.LaunchTokenTTL = 5 * time.Minute
	}
	if c.TimestampSkew <= 0 {
		c.TimestampSkew = 5 * time.Minute
	}
	return c
}

func (c Config) ValidateForIssue() error {
	c = c.normalized()
	if c.BusinessCode == "" || c.LaunchTokenSecret == "" || c.LaunchTokenTTL <= 0 {
		return ErrInvalidConfig
	}
	return nil
}

func (c Config) ValidateForCallback() error {
	c = c.normalized()
	if c.BusinessCode == "" || c.SecretID == "" || c.SecretKey == "" || c.LaunchTokenSecret == "" ||
		c.LaunchTokenTTL <= 0 || c.TimestampSkew <= 0 {
		return ErrInvalidConfig
	}
	return nil
}

func IssueLaunchToken(cfg Config, userID, instanceID string, now time.Time) (string, int64, error) {
	cfg = cfg.normalized()
	if err := cfg.ValidateForIssue(); err != nil {
		return "", 0, err
	}
	userID = strings.TrimSpace(userID)
	instanceID = strings.TrimSpace(instanceID)
	if userID == "" || instanceID == "" {
		return "", 0, ErrInvalidRequest
	}
	expiresAt := now.Add(cfg.LaunchTokenTTL).Unix()
	claims := LaunchTokenClaims{
		UserID:       userID,
		InstanceID:   instanceID,
		BusinessCode: cfg.BusinessCode,
		IssuedAt:     now.Unix(),
		ExpiresAt:    expiresAt,
	}
	payload, err := json.Marshal(claims)
	if err != nil {
		return "", 0, err
	}
	encodedPayload := base64.RawURLEncoding.EncodeToString(payload)
	signature := signHex([]byte(cfg.LaunchTokenSecret), encodedPayload)
	return encodedPayload + "." + signature, expiresAt, nil
}

func VerifyLaunchToken(cfg Config, token string, now time.Time) (*LaunchTokenClaims, error) {
	cfg = cfg.normalized()
	if err := cfg.ValidateForIssue(); err != nil {
		return nil, err
	}
	token = strings.TrimSpace(token)
	parts := strings.Split(token, ".")
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return nil, ErrInvalidToken
	}
	expected := signHex([]byte(cfg.LaunchTokenSecret), parts[0])
	if !constantTimeStringEqual(expected, parts[1]) {
		return nil, ErrInvalidToken
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return nil, ErrInvalidToken
	}
	var claims LaunchTokenClaims
	if err := json.Unmarshal(payload, &claims); err != nil {
		return nil, ErrInvalidToken
	}
	if strings.TrimSpace(claims.UserID) == "" || strings.TrimSpace(claims.InstanceID) == "" {
		return nil, ErrInvalidToken
	}
	if claims.BusinessCode != cfg.BusinessCode {
		return nil, ErrInvalidToken
	}
	if claims.ExpiresAt <= now.Unix() {
		return nil, ErrExpiredToken
	}
	return &claims, nil
}

func VerifyCallbackSignature(cfg Config, req CallbackRequest, now time.Time) error {
	cfg = cfg.normalized()
	if err := cfg.ValidateForCallback(); err != nil {
		return err
	}
	req.LaunchToken = strings.TrimSpace(req.LaunchToken)
	req.BusinessCode = strings.TrimSpace(req.BusinessCode)
	req.Sign = strings.TrimSpace(req.Sign)
	if req.LaunchToken == "" || req.BusinessCode == "" || req.Timestamp <= 0 || req.Sign == "" {
		return ErrInvalidRequest
	}
	if req.BusinessCode != cfg.BusinessCode {
		return ErrInvalidSignature
	}
	delta := now.Unix() - req.Timestamp
	if delta < 0 {
		delta = -delta
	}
	if time.Duration(delta)*time.Second > cfg.TimestampSkew {
		return ErrInvalidSignature
	}
	params := map[string]string{
		"businessCode": req.BusinessCode,
		"launch_token": req.LaunchToken,
		"timestamp":    strconv.FormatInt(req.Timestamp, 10),
	}
	expected := GenerateCallbackSign(cfg, params)
	if req.Sign != strings.ToLower(req.Sign) || !constantTimeStringEqual(expected, req.Sign) {
		return ErrInvalidSignature
	}
	return nil
}

func GenerateCallbackSign(cfg Config, params map[string]string) string {
	cfg = cfg.normalized()
	keys := make([]string, 0, len(params))
	for key := range params {
		if key == "sign" {
			continue
		}
		keys = append(keys, key)
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys)+2)
	for _, key := range keys {
		parts = append(parts, fmt.Sprintf("%s=%s", key, params[key]))
	}
	parts = append(parts, "secretId="+cfg.SecretID, "secretKey="+cfg.SecretKey)
	return signHex([]byte(cfg.SecretKey), strings.Join(parts, "&"))
}

func signHex(secret []byte, data string) string {
	mac := hmac.New(sha256.New, secret)
	_, _ = mac.Write([]byte(data))
	return hex.EncodeToString(mac.Sum(nil))
}

func constantTimeStringEqual(expected, actual string) bool {
	expectedBytes := []byte(expected)
	actualBytes := []byte(actual)
	if len(expectedBytes) != len(actualBytes) {
		padded := make([]byte, len(expectedBytes))
		copy(padded, actualBytes)
		_ = subtle.ConstantTimeCompare(expectedBytes, padded)
		return false
	}
	return subtle.ConstantTimeCompare(expectedBytes, actualBytes) == 1
}
