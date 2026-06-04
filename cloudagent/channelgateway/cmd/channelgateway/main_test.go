package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"cloudagent/channelgateway/internal/config"
	"cloudagent/channelgateway/internal/store"
)

func TestHealthzReportsCurrentLeaseState(t *testing.T) {
	state := newChannelRuntimeStates()
	state.SetLease(store.ChannelLease{
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
	firstAccounts := first["wecom_accounts"].([]any)
	firstAccount := firstAccounts[0].(map[string]any)
	if firstAccount["fencing_token"] != float64(1) {
		t.Fatalf("unexpected first health response: %#v", first)
	}
	state.SetLease(store.ChannelLease{
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
	secondAccounts := second["wecom_accounts"].([]any)
	secondAccount := secondAccounts[0].(map[string]any)
	if secondAccount["fencing_token"] != float64(2) || secondAccount["lease_expires_at"] == firstAccount["lease_expires_at"] {
		t.Fatalf("health response should use current lease state: first=%#v second=%#v", first, second)
	}
}

func TestHealthzPreservesRunnerStatusAcrossLeaseRenewal(t *testing.T) {
	state := newChannelRuntimeStates()
	state.SetLease(store.ChannelLease{
		ChannelAccountID: "wecom-a",
		OwnerID:          "owner-a",
		FencingToken:     1,
		ExpiresAt:        time.Date(2026, 6, 3, 1, 0, 0, 0, time.UTC),
	})
	state.SetStatus("wecom-a", "running")
	state.SetLease(store.ChannelLease{
		ChannelAccountID: "wecom-a",
		OwnerID:          "owner-a",
		FencingToken:     1,
		ExpiresAt:        time.Date(2026, 6, 3, 1, 1, 0, 0, time.UTC),
	})
	req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	rec := httptest.NewRecorder()
	healthHandler(config.Config{OwnerID: "owner-a"}, state).ServeHTTP(rec, req)
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	accounts := body["wecom_accounts"].([]any)
	account := accounts[0].(map[string]any)
	if account["status"] != "running" {
		t.Fatalf("lease renewal should not clobber runner status: %#v", body)
	}
}

func TestRedactDBTargetMasksCredentials(t *testing.T) {
	cases := []struct {
		name      string
		input     string
		forbidden string
		want      string
	}{
		{
			name:      "mysql driver dsn",
			input:     "root:secret-pass@tcp(9.135.107.6:3306)/wisp?charset=utf8mb4&parseTime=true",
			forbidden: "secret-pass",
			want:      "xxxxx@tcp(9.135.107.6:3306)/wisp?charset=utf8mb4&parseTime=true",
		},
		{
			name:      "url dsn",
			input:     "mysql://root:secret-pass@9.135.107.6:3306/wisp?charset=utf8mb4",
			forbidden: "secret-pass",
			want:      "mysql://root:xxxxx@9.135.107.6:3306/wisp?charset=utf8mb4",
		},
		{
			name:  "sqlite path",
			input: "/data/channelgateway.db",
			want:  "/data/channelgateway.db",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := redactDBTarget(tc.input)
			if tc.forbidden != "" && strings.Contains(got, tc.forbidden) {
				t.Fatalf("redacted target still contains secret: %q", got)
			}
			if got != tc.want {
				t.Fatalf("redactDBTarget() = %q, want %q", got, tc.want)
			}
		})
	}
}
