package federation

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	cryptorand "crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"
)

const (
	tokenVersion   = 1
	handoffScope   = "federation:handoff"
	delegatedScope = "federation:session"
	switchScope    = "federation:switch"
)

var ErrInvalidToken = errors.New("invalid federation token")

type CodecConfig struct {
	Environment string
	ActiveKeyID string
	Keys        map[string][]byte
	NonceKey    []byte
	Random      io.Reader
}

type Codec struct {
	environment string
	activeKeyID string
	keys        map[string][]byte
	nonceKey    []byte
	random      io.Reader
}

type HandoffClaims struct {
	Version            int       `json:"version"`
	KeyID              string    `json:"kid"`
	Scope              string    `json:"scope"`
	SourceSessionToken string    `json:"source_session_token"`
	UserID             string    `json:"user_id"`
	ClientID           string    `json:"client_id"`
	RedirectURI        string    `json:"normalized_redirect_uri"`
	IssuedAt           time.Time `json:"issued_at"`
	ExpiresAt          time.Time `json:"expires_at"`
	RandomNonce        string    `json:"random_nonce"`
}

type DelegatedClaims struct {
	Version            int       `json:"version"`
	KeyID              string    `json:"kid"`
	Scope              string    `json:"scope"`
	SourceSessionToken string    `json:"source_session_token"`
	UserID             string    `json:"user_id"`
	ClientID           string    `json:"client_id"`
	IssuedAt           time.Time `json:"issued_at"`
	ExpiresAt          time.Time `json:"expires_at"`
}

type SwitchClaims struct {
	Version            int       `json:"version"`
	KeyID              string    `json:"kid"`
	Scope              string    `json:"scope"`
	SourceSessionToken string    `json:"source_session_token"`
	UserID             string    `json:"user_id"`
	IssuedAt           time.Time `json:"issued_at"`
	ExpiresAt          time.Time `json:"expires_at"`
}

func NewCodec(config CodecConfig) (*Codec, error) {
	config.Environment = strings.TrimSpace(config.Environment)
	config.ActiveKeyID = strings.TrimSpace(config.ActiveKeyID)
	if config.Environment == "" || config.ActiveKeyID == "" || len(config.NonceKey) < 32 {
		return nil, fmt.Errorf("%w: incomplete codec configuration", ErrInvalidToken)
	}
	keys := make(map[string][]byte, len(config.Keys))
	for keyID, key := range config.Keys {
		if strings.TrimSpace(keyID) == "" || (len(key) != 16 && len(key) != 24 && len(key) != 32) {
			return nil, fmt.Errorf("%w: invalid AEAD key", ErrInvalidToken)
		}
		keys[keyID] = append([]byte(nil), key...)
	}
	if _, ok := keys[config.ActiveKeyID]; !ok {
		return nil, fmt.Errorf("%w: active key is missing", ErrInvalidToken)
	}
	random := config.Random
	if random == nil {
		random = cryptorand.Reader
	}
	return &Codec{
		environment: config.Environment,
		activeKeyID: config.ActiveKeyID,
		keys:        keys,
		nonceKey:    append([]byte(nil), config.NonceKey...),
		random:      random,
	}, nil
}

func (c *Codec) IssueHandoff(claims HandoffClaims) (string, error) {
	claims.Version = tokenVersion
	claims.KeyID = c.activeKeyID
	claims.Scope = handoffScope
	if claims.RandomNonce == "" {
		random := make([]byte, 16)
		if _, err := io.ReadFull(c.random, random); err != nil {
			return "", err
		}
		claims.RandomNonce = base64.RawURLEncoding.EncodeToString(random)
	}
	return c.encrypt(c.activeKeyID, handoffScope, claims, nil)
}

func (c *Codec) ParseHandoff(token string, now time.Time) (HandoffClaims, error) {
	var claims HandoffClaims
	if err := c.decrypt(token, handoffScope, &claims); err != nil {
		return HandoffClaims{}, err
	}
	if claims.KeyID != tokenKeyID(token) || claims.Version != tokenVersion || claims.Scope != handoffScope || claims.SourceSessionToken == "" || claims.UserID == "" || claims.ClientID == "" || claims.RedirectURI == "" || claims.IssuedAt.IsZero() || claims.ExpiresAt.IsZero() || claims.RandomNonce == "" || !now.Before(claims.ExpiresAt) {
		return HandoffClaims{}, ErrInvalidToken
	}
	return claims, nil
}

func (c *Codec) IssueDelegated(handoffToken string, handoff HandoffClaims, expiresAt time.Time) (string, error) {
	keyID := strings.TrimSpace(handoff.KeyID)
	if _, ok := c.keys[keyID]; !ok {
		return "", ErrInvalidToken
	}
	claims := DelegatedClaims{
		Version:            tokenVersion,
		KeyID:              keyID,
		Scope:              delegatedScope,
		SourceSessionToken: handoff.SourceSessionToken,
		UserID:             handoff.UserID,
		ClientID:           handoff.ClientID,
		IssuedAt:           handoff.IssuedAt,
		ExpiresAt:          expiresAt,
	}
	mac := hmac.New(sha256.New, c.nonceKey)
	_, _ = mac.Write([]byte("federation:delegated-nonce\x00"))
	_, _ = mac.Write([]byte(handoffToken))
	nonce := mac.Sum(nil)
	return c.encrypt(keyID, delegatedScope, claims, nonce)
}

func (c *Codec) ParseDelegated(token string, now time.Time) (DelegatedClaims, error) {
	var claims DelegatedClaims
	if err := c.decrypt(token, delegatedScope, &claims); err != nil {
		return DelegatedClaims{}, err
	}
	if claims.KeyID != tokenKeyID(token) || claims.Version != tokenVersion || claims.Scope != delegatedScope || claims.SourceSessionToken == "" || claims.UserID == "" || claims.ClientID == "" || claims.IssuedAt.IsZero() || claims.ExpiresAt.IsZero() || !now.Before(claims.ExpiresAt) {
		return DelegatedClaims{}, ErrInvalidToken
	}
	return claims, nil
}

func (c *Codec) IssueSwitch(claims SwitchClaims) (string, error) {
	claims.Version = tokenVersion
	claims.KeyID = c.activeKeyID
	claims.Scope = switchScope
	return c.encrypt(c.activeKeyID, switchScope, claims, nil)
}

func (c *Codec) ParseSwitch(token string, now time.Time) (SwitchClaims, error) {
	var claims SwitchClaims
	if err := c.decrypt(token, switchScope, &claims); err != nil {
		return SwitchClaims{}, err
	}
	if claims.KeyID != tokenKeyID(token) || claims.Version != tokenVersion || claims.Scope != switchScope || claims.SourceSessionToken == "" || claims.UserID == "" || claims.IssuedAt.IsZero() || claims.ExpiresAt.IsZero() || !now.Before(claims.ExpiresAt) {
		return SwitchClaims{}, ErrInvalidToken
	}
	return claims, nil
}

func tokenKeyID(token string) string {
	parts := strings.Split(token, ".")
	if len(parts) != 3 || parts[0] != "lvf1" {
		return ""
	}
	return parts[1]
}

func (c *Codec) encrypt(keyID, scope string, claims any, deterministicNonce []byte) (string, error) {
	aead, err := newAEAD(c.keys[keyID])
	if err != nil {
		return "", err
	}
	nonce := make([]byte, aead.NonceSize())
	if deterministicNonce == nil {
		if _, err := io.ReadFull(c.random, nonce); err != nil {
			return "", err
		}
	} else {
		copy(nonce, deterministicNonce)
	}
	plaintext, err := json.Marshal(claims)
	if err != nil {
		return "", err
	}
	ciphertext := aead.Seal(nil, nonce, plaintext, c.associatedData(scope))
	payload := append(nonce, ciphertext...)
	return "lvf1." + keyID + "." + base64.RawURLEncoding.EncodeToString(payload), nil
}

func (c *Codec) decrypt(token, scope string, target any) error {
	parts := strings.Split(token, ".")
	if len(parts) != 3 || parts[0] != "lvf1" {
		return ErrInvalidToken
	}
	key, ok := c.keys[parts[1]]
	if !ok {
		return ErrInvalidToken
	}
	aead, err := newAEAD(key)
	if err != nil {
		return ErrInvalidToken
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil || len(payload) <= aead.NonceSize() {
		return ErrInvalidToken
	}
	plaintext, err := aead.Open(nil, payload[:aead.NonceSize()], payload[aead.NonceSize():], c.associatedData(scope))
	if err != nil || json.Unmarshal(plaintext, target) != nil {
		return ErrInvalidToken
	}
	return nil
}

func (c *Codec) associatedData(scope string) []byte {
	return []byte("lightvela-federation\x00" + c.environment + "\x00" + scope)
}

func newAEAD(key []byte) (cipher.AEAD, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}
