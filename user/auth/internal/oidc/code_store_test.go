package oidc

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestMemoryCodeStoreConsumesAuthorizationCodeOnce(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, 8, 24, 10, 0, 0, 0, time.UTC)
	store := NewMemoryCodeStore(func() time.Time { return now })
	code := "test-auth-code"
	challenge := S256Challenge("verifier-1234567890")
	if err := store.CreateAuthorizationCode(context.Background(), CreateAuthorizationCodeInput{
		Code:          code,
		ClientID:      "site-gateway",
		UserID:        "user-1",
		RedirectURI:   "https://sites-auth.lightvela.tech/auth/lightvela/callback",
		Scope:         "openid profile email",
		CodeChallenge: challenge,
		Nonce:         "nonce-1",
		ExpiresAt:     now.Add(5 * time.Second),
	}); err != nil {
		t.Fatalf("CreateAuthorizationCode() error = %v", err)
	}

	var successCount int32
	var wg sync.WaitGroup
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			record, err := store.ConsumeAuthorizationCode(context.Background(), ConsumeAuthorizationCodeInput{
				Code:        code,
				ClientID:    "site-gateway",
				RedirectURI: "https://sites-auth.lightvela.tech/auth/lightvela/callback",
				Verifier:    "verifier-1234567890",
				Now:         now.Add(4 * time.Second),
			})
			if err == nil && record != nil {
				atomic.AddInt32(&successCount, 1)
			}
		}()
	}
	wg.Wait()

	if successCount != 1 {
		t.Fatalf("successCount = %d, want 1", successCount)
	}
}
