// Package gojaim runs the Tencent LiteChat data plane inside the Vela Agent
// Host. The SDK bundle is generated at build time and embedded in the Go
// binary; it is never loaded from the runtime filesystem.
package gojaim

import (
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"errors"
	"strings"
)

var ErrInvalidBundle = errors.New("内嵌 LiteChat bundle 无效")

//go:embed assets/lite-chat-goja.js
var bundleFS embed.FS

const bundleSHA256 = "f70a4ca8f1ad29259bc4ef433a0d244ee6cbb79eb48a2c10ac4cf06cdee93bb2"

func EmbeddedBundle() string {
	source, err := bundleFS.ReadFile("assets/lite-chat-goja.js")
	if err != nil {
		panic("gojaim: embedded bundle missing: " + err.Error())
	}
	return string(source)
}

func BundleSHA256() string {
	return bundleSHA256
}

func ValidateBundle(source string) error {
	if len(source) < 100_000 ||
		strings.Contains(source, "require(") ||
		strings.Contains(source, "sourceMappingURL=") ||
		!strings.Contains(source, "TencentCloudChat") ||
		!strings.Contains(source, "__velaLiteChat") ||
		!strings.Contains(source, "__velaHost") {
		return ErrInvalidBundle
	}
	sum := sha256.Sum256([]byte(source))
	if hex.EncodeToString(sum[:]) != bundleSHA256 {
		return ErrInvalidBundle
	}
	return nil
}
