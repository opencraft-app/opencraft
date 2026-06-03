package store

import (
	"crypto/rand"
	"encoding/hex"
)

func randomHex(bytes int) string {
	if bytes <= 0 {
		bytes = 8
	}
	buf := make([]byte, bytes)
	if _, err := rand.Read(buf); err != nil {
		return "random"
	}
	return hex.EncodeToString(buf)
}
