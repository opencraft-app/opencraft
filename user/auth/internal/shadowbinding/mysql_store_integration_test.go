package shadowbinding

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"testing"
	"time"

	_ "github.com/go-sql-driver/mysql"
	internalmigrations "github.com/openclaw/openclaw/mono/backend/auth/internal/migrations"
)

func TestMySQLStoreAdminBindingLifecycle(t *testing.T) {
	dsn := os.Getenv("LIGHTCLAW_AUTH_TEST_DSN")
	if dsn == "" {
		t.Skip("LIGHTCLAW_AUTH_TEST_DSN is not set")
	}
	if err := internalmigrations.Run(dsn); err != nil {
		t.Fatalf("run migrations: %v", err)
	}
	db, err := sql.Open("mysql", dsn)
	if err != nil {
		t.Fatalf("open mysql: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })

	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Microsecond)
	suffix := time.Now().UnixNano()
	userA := fmt.Sprintf("shadow-admin-%d-a", suffix)
	userB := fmt.Sprintf("shadow-admin-%d-b", suffix)
	userC := fmt.Sprintf("shadow-admin-%d-c", suffix)
	for _, userID := range []string{userA, userB, userC} {
		if _, err := db.ExecContext(ctx, `
			INSERT INTO users (id, name, invite_required, created_at, updated_at)
			VALUES (?, ?, FALSE, ?, ?)
		`, userID, userID, now, now); err != nil {
			t.Fatalf("create test user %s: %v", userID, err)
		}
	}
	t.Cleanup(func() {
		_, _ = db.ExecContext(context.Background(), `DELETE FROM users WHERE id IN (?, ?, ?)`, userA, userB, userC)
	})

	store := NewMySQLStore(db)
	first := Binding{
		UserID:         userA,
		ShadowUserName: fmt.Sprintf("shadow-%d", suffix),
		Uin:            450860000013,
		OwnerUin:       450860000002,
		AppID:          1300000001,
	}
	created, err := store.UpsertAdminBinding(ctx, first, now)
	if err != nil {
		t.Fatalf("create admin binding: %v", err)
	}
	if created.Status != StatusActive || !sameBindingIdentity(created, first) {
		t.Fatalf("created binding = %#v, want active identity %#v", created, first)
	}

	idempotent, err := store.UpsertAdminBinding(ctx, first, now.Add(time.Second))
	if err != nil {
		t.Fatalf("repeat identical admin binding: %v", err)
	}
	if !sameBindingIdentity(idempotent, first) || idempotent.Status != StatusActive {
		t.Fatalf("idempotent binding = %#v, want active identity %#v", idempotent, first)
	}

	changed := first
	changed.AppID++
	if _, err := store.UpsertAdminBinding(ctx, changed, now.Add(2*time.Second)); !errors.Is(err, ErrBindingConflict) {
		t.Fatalf("change active binding error = %v, want ErrBindingConflict", err)
	}

	sameUIN := first
	sameUIN.UserID = userB
	sameUIN.ShadowUserName += "-other"
	if _, err := store.UpsertAdminBinding(ctx, sameUIN, now.Add(3*time.Second)); !errors.Is(err, ErrBindingConflict) {
		t.Fatalf("duplicate active UIN error = %v, want ErrBindingConflict", err)
	}

	sameUserName := first
	sameUserName.UserID = userC
	sameUserName.Uin++
	if _, err := store.UpsertAdminBinding(ctx, sameUserName, now.Add(4*time.Second)); !errors.Is(err, ErrBindingConflict) {
		t.Fatalf("duplicate active shadow username error = %v, want ErrBindingConflict", err)
	}

	disabled, err := store.DisableAdminBinding(ctx, userA, now.Add(5*time.Second))
	if err != nil {
		t.Fatalf("disable admin binding: %v", err)
	}
	if disabled.Status != StatusDisabled {
		t.Fatalf("disabled binding status = %q, want %q", disabled.Status, StatusDisabled)
	}
	if _, err := store.DisableAdminBinding(ctx, userA, now.Add(6*time.Second)); err != nil {
		t.Fatalf("repeat disable admin binding: %v", err)
	}

	reused := first
	reused.UserID = userB
	reused.ShadowUserName += "-reused"
	reusedBinding, err := store.UpsertAdminBinding(ctx, reused, now.Add(7*time.Second))
	if err != nil {
		t.Fatalf("reuse disabled UIN: %v", err)
	}
	if reusedBinding.Status != StatusActive || !sameBindingIdentity(reusedBinding, reused) {
		t.Fatalf("reused binding = %#v, want active identity %#v", reusedBinding, reused)
	}

	rebound := first
	rebound.Uin++
	rebound.ShadowUserName += "-rebound"
	reboundBinding, err := store.UpsertAdminBinding(ctx, rebound, now.Add(8*time.Second))
	if err != nil {
		t.Fatalf("rebind disabled user: %v", err)
	}
	if reboundBinding.Status != StatusActive || !sameBindingIdentity(reboundBinding, rebound) {
		t.Fatalf("rebound binding = %#v, want active identity %#v", reboundBinding, rebound)
	}
}
