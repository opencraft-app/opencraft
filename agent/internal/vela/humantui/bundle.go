package humantui

import (
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"errors"
	"strings"

	"velachat/agent/internal/reactvaxis"
)

//go:embed assets/human-client.bundle.js
var bundleSource string

//go:embed assets/human-client.bundle.sha256
var bundleSHA256File string

func EmbeddedBundle() (reactvaxis.Bundle, error) {
	if len(bundleSource) < 100_000 ||
		strings.Contains(bundleSource, "@tencentcloud") ||
		strings.Contains(bundleSource, "expo-router") ||
		strings.Contains(bundleSource, "react-dom") ||
		strings.Contains(bundleSource, "require(") ||
		!strings.Contains(bundleSource, "__velaTui") ||
		!strings.Contains(bundleSource, "auth-form-panel") ||
		!strings.Contains(bundleSource, "terminal-management-frame") {
		return reactvaxis.Bundle{}, errors.New("Human TUI bundle 内容无效")
	}
	digest := sha256.Sum256([]byte(bundleSource))
	actual := hex.EncodeToString(digest[:])
	if actual != expectedBundleSHA256() {
		return reactvaxis.Bundle{}, errors.New("Human TUI bundle SHA-256 漂移")
	}
	return reactvaxis.Bundle{
		Name: "vela-human-client", Protocol: reactvaxis.ProtocolV2,
		Source: bundleSource, SHA256: actual,
	}, nil
}

func expectedBundleSHA256() string {
	return strings.TrimSpace(bundleSHA256File)
}
