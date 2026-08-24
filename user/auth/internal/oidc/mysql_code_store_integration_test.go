package oidc

import (
	"context"
	"os"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	internalmigrations "github.com/openclaw/openclaw/mono/backend/auth/internal/migrations"
	"github.com/openclaw/openclaw/mono/backend/auth/internal/service"
)

func TestMySQLCodeStoreConsumesAuthorizationCodeOnce(t *testing.T) {
	dsn := os.Getenv("LIGHTCLAW_AUTH_TEST_DSN")
	if dsn == "" {
		t.Skip("LIGHTCLAW_AUTH_TEST_DSN is not set")
	}
	if err := internalmigrations.Run(dsn); err != nil {
		t.Fatalf("run migrations: %v", err)
	}

	authStore, err := service.NewMySQLStore(dsn, service.StoreOptions{})
	if err != nil {
		t.Fatalf("open mysql store: %v", err)
	}
	t.Cleanup(func() { _ = authStore.DB().Close() })

	now := time.Now().UTC()
	store := NewMySQLCodeStore(authStore.DB())
	code := "mysql-oidc-code"
	verifier := "mysql-verifier-1234567890"
	if err := store.CreateAuthorizationCode(context.Background(), CreateAuthorizationCodeInput{
		Code:          code,
		ClientID:      "site-gateway",
		UserID:        "user-mysql",
		RedirectURI:   "https://sites-auth.lightvela.tech/auth/lightvela/callback",
		Scope:         "openid profile email",
		CodeChallenge: S256Challenge(verifier),
		Nonce:         "nonce-mysql",
		ExpiresAt:     now.Add(5 * time.Second),
		CreatedAt:     now,
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
				Verifier:    verifier,
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

func TestMySQLCodeStoreCreateAuthorizationCodeBestEffortCleansExpiredRows(t *testing.T) {
	dsn := os.Getenv("LIGHTCLAW_AUTH_TEST_DSN")
	if dsn == "" {
		t.Skip("LIGHTCLAW_AUTH_TEST_DSN is not set")
	}
	if err := internalmigrations.Run(dsn); err != nil {
		t.Fatalf("run migrations: %v", err)
	}

	authStore, err := service.NewMySQLStore(dsn, service.StoreOptions{})
	if err != nil {
		t.Fatalf("open mysql store: %v", err)
	}
	t.Cleanup(func() { _ = authStore.DB().Close() })

	now := time.Now().UTC()
	store := NewMySQLCodeStore(authStore.DB())
	oldCode := "mysql-oidc-expired-old"
	freshCode := "mysql-oidc-fresh"
	oldHash := codeHash(oldCode)
	freshHash := codeHash(freshCode)

	if _, err := authStore.DB().ExecContext(context.Background(), `
		INSERT INTO oidc_authorization_codes (
			code_hash, client_id, user_id, redirect_uri, scope, code_challenge, nonce, expires_at, created_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
	`, oldHash[:], "site-gateway", "user-old", "https://sites-auth.lightvela.tech/auth/lightvela/callback", "openid profile email", S256Challenge("old-verifier"), "old-nonce", now.Add(-11*time.Minute), now.Add(-12*time.Minute)); err != nil {
		t.Fatalf("insert expired row: %v", err)
	}

	if err := store.CreateAuthorizationCode(context.Background(), CreateAuthorizationCodeInput{
		Code:          freshCode,
		ClientID:      "site-gateway",
		UserID:        "user-fresh",
		RedirectURI:   "https://sites-auth.lightvela.tech/auth/lightvela/callback",
		Scope:         "openid profile email",
		CodeChallenge: S256Challenge("fresh-verifier"),
		Nonce:         "fresh-nonce",
		ExpiresAt:     now.Add(5 * time.Second),
		CreatedAt:     now,
	}); err != nil {
		t.Fatalf("CreateAuthorizationCode() error = %v", err)
	}

	var expiredCount int
	if err := authStore.DB().QueryRowContext(context.Background(), `
		SELECT COUNT(*) FROM oidc_authorization_codes WHERE code_hash = ?
	`, oldHash[:]).Scan(&expiredCount); err != nil {
		t.Fatalf("count expired row: %v", err)
	}
	if expiredCount != 0 {
		t.Fatalf("expired row count = %d, want 0", expiredCount)
	}

	var freshCount int
	if err := authStore.DB().QueryRowContext(context.Background(), `
		SELECT COUNT(*) FROM oidc_authorization_codes WHERE code_hash = ?
	`, freshHash[:]).Scan(&freshCount); err != nil {
		t.Fatalf("count fresh row: %v", err)
	}
	if freshCount != 1 {
		t.Fatalf("fresh row count = %d, want 1", freshCount)
	}
}
