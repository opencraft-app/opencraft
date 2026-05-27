package wispcloud

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"time"
)

func firstEnv(keys ...string) string {
	for _, key := range keys {
		if value := strings.TrimSpace(os.Getenv(key)); value != "" {
			return value
		}
	}
	return ""
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

func envInt(key string, fallback int) int {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}
	var parsed int
	if _, err := fmt.Sscanf(value, "%d", &parsed); err != nil || parsed <= 0 {
		return fallback
	}
	return parsed
}

func envDurationSeconds(key string, fallback time.Duration) time.Duration {
	value := envInt(key, 0)
	if value <= 0 {
		return fallback
	}
	return time.Duration(value) * time.Second
}

func quoteServerField(value string) string {
	encoded, _ := json.Marshal(value)
	return string(encoded)
}

func randomHex(bytes int) string {
	buf := make([]byte, bytes)
	if _, err := rand.Read(buf); err != nil {
		panic(fmt.Sprintf("random id failed: %v", err))
	}
	return hex.EncodeToString(buf)
}
