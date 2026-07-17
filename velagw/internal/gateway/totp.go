package gateway

import (
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base32"
	"encoding/binary"
	"fmt"
	"math"
	"strings"
	"time"
)

func generateTOTPCode(secret string, now time.Time) (string, error) {
	secret = strings.ToUpper(strings.TrimSpace(strings.ReplaceAll(secret, " ", "")))
	if secret == "" {
		return "", fmt.Errorf("totp secret is required")
	}
	decoder := base32.StdEncoding.WithPadding(base32.NoPadding)
	key, err := decoder.DecodeString(secret)
	if err != nil {
		padded := secret + strings.Repeat("=", (8-len(secret)%8)%8)
		key, err = base32.StdEncoding.DecodeString(padded)
		if err != nil {
			return "", fmt.Errorf("invalid totp secret: %w", err)
		}
	}
	counter := uint64(now.UTC().Unix() / 30)
	var msg [8]byte
	binary.BigEndian.PutUint64(msg[:], counter)
	hash := hmac.New(sha1.New, key)
	if _, err := hash.Write(msg[:]); err != nil {
		return "", err
	}
	sum := hash.Sum(nil)
	offset := sum[len(sum)-1] & 0x0f
	binCode := (uint32(sum[offset])&0x7f)<<24 |
		(uint32(sum[offset+1])&0xff)<<16 |
		(uint32(sum[offset+2])&0xff)<<8 |
		(uint32(sum[offset+3]) & 0xff)
	code := binCode % uint32(math.Pow10(6))
	return fmt.Sprintf("%06d", code), nil
}
