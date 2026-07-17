package httpapi

import (
	"encoding/base64"
	"strings"
)

func externalKeyForHTTPTest(seed byte) string {
	payload := make([]byte, 69)
	payload[0] = 2
	copy(payload[1:], strings.Repeat(string([]byte{seed}), 68))
	return "sk-" + base64.RawURLEncoding.EncodeToString(payload)
}
