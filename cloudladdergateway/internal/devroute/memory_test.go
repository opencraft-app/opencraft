package devroute

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestMemoryStoreKeepsExpiredAndDisabledRegistrationsAsTombstones(t *testing.T) {
	now := time.Date(2026, 9, 8, 9, 0, 0, 0, time.UTC)
	store := NewMemoryStore()
	registration := Registration{
		UIN:       "450860000013",
		UserID:    "usr_dev",
		BaseURL:   "http://9.134.214.121:18084",
		RenewedAt: now,
		TTL:       30 * time.Minute,
	}
	if err := store.Upsert(context.Background(), registration); err != nil {
		t.Fatalf("upsert: %v", err)
	}

	got, err := store.Get(context.Background(), registration.UIN)
	if err != nil {
		t.Fatalf("get active: %v", err)
	}
	if state := got.State(now.Add(29 * time.Minute)); state != StateActive {
		t.Fatalf("state before expiry = %q, want active", state)
	}
	if state := got.State(now.Add(31 * time.Minute)); state != StateExpired {
		t.Fatalf("state after expiry = %q, want expired", state)
	}

	if err := store.Disable(context.Background(), registration.UIN, now.Add(10*time.Minute)); err != nil {
		t.Fatalf("disable: %v", err)
	}
	disabled, err := store.Get(context.Background(), registration.UIN)
	if err != nil {
		t.Fatalf("disabled registration must remain queryable: %v", err)
	}
	if state := disabled.State(now.Add(11 * time.Minute)); state != StateDisabled {
		t.Fatalf("state after disable = %q, want disabled", state)
	}

	_, err = store.Get(context.Background(), "450860009999")
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("unknown uin error = %v, want ErrNotFound", err)
	}
}
