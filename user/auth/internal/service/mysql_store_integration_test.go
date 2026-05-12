package service

import (
	"context"
	"os"
	"testing"
	"time"

	internalmigrations "github.com/openclaw/openclaw/mono/backend/auth/internal/migrations"
)

func TestMySQLStorePersistsImpersonationSessionMetadata(t *testing.T) {
	dsn := os.Getenv("LIGHTCLAW_AUTH_TEST_DSN")
	if dsn == "" {
		t.Skip("LIGHTCLAW_AUTH_TEST_DSN is not set")
	}

	if err := internalmigrations.Run(dsn); err != nil {
		t.Fatalf("run migrations: %v", err)
	}
	store, err := NewMySQLStore(dsn, StoreOptions{Now: fixedNow, SeedDefaultInvites: true})
	if err != nil {
		t.Fatalf("open mysql store: %v", err)
	}
	t.Cleanup(func() { _ = store.db.Close() })

	now := fixedNow().Add(time.Duration(time.Now().UnixNano()%1_000_000) * time.Nanosecond)
	normalSession, err := store.CreatePasswordSession(context.Background(), PasswordSignUpInput{
		Name:  "MySQL Impersonation",
		Email: "impersonation-mysql-" + time.Now().Format("20060102150405.000000000") + "@example.com",
	}, []byte("hash"), now, 24*time.Hour)
	if err != nil {
		t.Fatalf("create password session: %v", err)
	}
	if normalSession.Impersonated {
		t.Fatal("normal mysql session should not be impersonated")
	}

	impersonated, err := store.CreateImpersonationSession(context.Background(), normalSession.User, "MySQL round trip", now, 30*time.Minute)
	if err != nil {
		t.Fatalf("create impersonation session: %v", err)
	}
	current, err := store.CurrentSession(context.Background(), impersonated.Token, now)
	if err != nil {
		t.Fatalf("load impersonation session: %v", err)
	}
	if !current.Impersonated || current.ImpersonationReason != "MySQL round trip" {
		t.Fatalf("expected mysql impersonation metadata, got impersonated=%v reason=%q", current.Impersonated, current.ImpersonationReason)
	}
}
