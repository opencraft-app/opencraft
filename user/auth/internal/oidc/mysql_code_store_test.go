package oidc

import (
	"testing"
	"time"
)

func TestMySQLCodeStoreShouldCleanupIsBounded(t *testing.T) {
	t.Parallel()

	store := &MySQLCodeStore{}
	now := time.Date(2026, 8, 24, 12, 20, 0, 0, time.UTC)
	if !store.shouldCleanup(now) {
		t.Fatal("first cleanup opportunity should run")
	}
	if store.shouldCleanup(now.Add(4 * time.Minute)) {
		t.Fatal("cleanup should be throttled within interval")
	}
	if !store.shouldCleanup(now.Add(5 * time.Minute)) {
		t.Fatal("cleanup should run again after interval")
	}
}
