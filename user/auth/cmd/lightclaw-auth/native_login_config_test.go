package main

import (
	"github.com/openclaw/openclaw/mono/backend/auth/internal/service"
	"testing"
)

func TestNativeLoginHasNoMemoryFallback(t *testing.T) {
	if buildNativeLoginCodes(service.NewMemoryStore(service.StoreOptions{})) != nil {
		t.Fatal("native login must not silently use per-process code state")
	}
}
