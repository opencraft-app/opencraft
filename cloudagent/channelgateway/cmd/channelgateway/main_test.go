package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"cloudagent/channelgateway/internal/config"
	"cloudagent/channelgateway/internal/store"
)

func TestHealthzReportsCurrentLeaseState(t *testing.T) {
	state := &channelLeaseState{}
	state.Set(store.ChannelLease{
		ChannelAccountID: "wecom-a",
		OwnerID:          "owner-a",
		FencingToken:     1,
		ExpiresAt:        time.Date(2026, 6, 3, 1, 0, 0, 0, time.UTC),
	})
	req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	rec := httptest.NewRecorder()
	healthHandler(config.Config{OwnerID: "owner-a"}, state).ServeHTTP(rec, req)
	var first map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &first); err != nil {
		t.Fatalf("decode first response: %v", err)
	}
	if first["fencing_token"] != float64(1) {
		t.Fatalf("unexpected first health response: %#v", first)
	}
	state.Set(store.ChannelLease{
		ChannelAccountID: "wecom-a",
		OwnerID:          "owner-a",
		FencingToken:     2,
		ExpiresAt:        time.Date(2026, 6, 3, 1, 1, 0, 0, time.UTC),
	})
	rec = httptest.NewRecorder()
	healthHandler(config.Config{OwnerID: "owner-a"}, state).ServeHTTP(rec, req)
	var second map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &second); err != nil {
		t.Fatalf("decode second response: %v", err)
	}
	if second["fencing_token"] != float64(2) || second["lease_expires_at"] == first["lease_expires_at"] {
		t.Fatalf("health response should use current lease state: first=%#v second=%#v", first, second)
	}
}

func TestInitializeACPWithRetryToleratesGatewayStartupOrdering(t *testing.T) {
	client := &fakeACPInitializer{
		failures: 2,
		err:      errors.New("connection refused"),
	}
	if err := initializeACPWithRetry(context.Background(), client, time.Nanosecond); err != nil {
		t.Fatalf("initialize with retry: %v", err)
	}
	if client.attempts != 3 {
		t.Fatalf("expected 3 attempts, got %d", client.attempts)
	}
}

func TestInitializeACPWithRetryStopsOnContextCancel(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	client := &fakeACPInitializer{
		failures: 10,
		err:      errors.New("connection refused"),
	}
	if err := initializeACPWithRetry(ctx, client, time.Nanosecond); !errors.Is(err, context.Canceled) {
		t.Fatalf("expected context cancellation, got %v", err)
	}
	if client.attempts != 1 {
		t.Fatalf("expected one immediate attempt before cancellation, got %d", client.attempts)
	}
}

type fakeACPInitializer struct {
	failures int
	err      error
	attempts int
}

func (f *fakeACPInitializer) Initialize(context.Context) error {
	f.attempts++
	if f.attempts <= f.failures {
		return f.err
	}
	return nil
}
