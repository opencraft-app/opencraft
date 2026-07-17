package observability

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"strings"
)

type Correlator struct {
	key   []byte
	keyID string
}

func NewCorrelator(key, keyID string) *Correlator {
	return &Correlator{key: []byte(key), keyID: strings.TrimSpace(keyID)}
}

func (c *Correlator) Hash(purpose, secret string) (string, string, bool) {
	if c == nil || len(c.key) == 0 || c.keyID == "" || secret == "" {
		return "", "", false
	}
	digest := hmac.New(sha256.New, c.key)
	_, _ = digest.Write([]byte(purpose))
	_, _ = digest.Write([]byte{0})
	_, _ = digest.Write([]byte(secret))
	return hex.EncodeToString(digest.Sum(nil)[:12]), c.keyID, true
}
