package proxyauth

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"time"
)

var ErrInvalidToken = errors.New("invalid proxy token")

type Authenticator struct {
	secret []byte
}

type claims struct {
	Username  string `json:"u"`
	ExpiresAt int64  `json:"exp"`
}

func New(secret string) *Authenticator {
	return &Authenticator{secret: []byte(secret)}
}

func (a *Authenticator) Mint(username string, ttl time.Duration) (string, error) {
	payload, err := json.Marshal(claims{
		Username:  strings.TrimSpace(username),
		ExpiresAt: time.Now().Add(ttl).Unix(),
	})
	if err != nil {
		return "", err
	}
	signature := a.sign(payload)
	return encode(payload) + "." + encode(signature), nil
}

func (a *Authenticator) Validate(token string) (string, error) {
	parts := strings.Split(strings.TrimSpace(token), ".")
	if len(parts) != 2 {
		return "", ErrInvalidToken
	}

	payload, err := decode(parts[0])
	if err != nil {
		return "", ErrInvalidToken
	}
	signature, err := decode(parts[1])
	if err != nil {
		return "", ErrInvalidToken
	}
	if !hmac.Equal(signature, a.sign(payload)) {
		return "", ErrInvalidToken
	}

	var parsed claims
	if err := json.Unmarshal(payload, &parsed); err != nil {
		return "", ErrInvalidToken
	}
	if strings.TrimSpace(parsed.Username) == "" {
		return "", ErrInvalidToken
	}
	if time.Now().Unix() > parsed.ExpiresAt {
		return "", ErrInvalidToken
	}
	return parsed.Username, nil
}

func (a *Authenticator) sign(payload []byte) []byte {
	mac := hmac.New(sha256.New, a.secret)
	_, _ = mac.Write(payload)
	return mac.Sum(nil)
}

func encode(value []byte) string {
	return base64.RawURLEncoding.EncodeToString(value)
}

func decode(value string) ([]byte, error) {
	return base64.RawURLEncoding.DecodeString(value)
}
