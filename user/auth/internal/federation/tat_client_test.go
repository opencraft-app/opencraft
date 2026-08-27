package federation

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestTATClientUsesNarrowInternalIdentityAndSanitizesResponse(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/internal/bots/bot-1/tat/session" {
			t.Fatalf("unexpected upstream request: %s %s", r.Method, r.URL.Path)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer internal-token" {
			t.Fatalf("Authorization = %q", got)
		}
		if got := r.Header.Get("X-User-Id"); got != "user-1" {
			t.Fatalf("X-User-Id = %q", got)
		}
		if strings.Contains(r.Header.Get("Authorization"), "source-session") {
			t.Fatal("source session escaped auth boundary")
		}
		if got := r.Header.Get("X-Request-ID"); got != "req_0123456789abcdef" {
			t.Fatalf("X-Request-ID = %q", got)
		}
		w.Header().Set("X-Request-ID", "upstream-req-1")
		_ = json.NewEncoder(w).Encode(map[string]any{"data": map[string]any{
			"poolId": "must-not-pass-through", "sessionId": "sess-1", "region": "ap-beijing",
			"instanceId": "ins-1", "ownerUin": "10001", "loginUin": "10002", "appId": 123,
			"wsUrl": "wss://tat.example/ws", "cols": 120, "rows": 30, "timeoutSeconds": 3600,
			"username": "agentuser", "workingDirectory": "/home/agentuser",
		}})
	}))
	defer server.Close()

	client, err := NewTATClient(TATClientConfig{BaseURL: server.URL, InternalToken: "internal-token", Timeout: 5 * time.Second})
	if err != nil {
		t.Fatalf("NewTATClient: %v", err)
	}
	bootstrap, upstreamRequestID, err := client.CreateSession(t.Context(), "bot-1", "user-1", "req_0123456789abcdef")
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	if bootstrap.SessionID != "sess-1" || bootstrap.WsURL != "wss://tat.example/ws" || bootstrap.InstanceID != "ins-1" {
		t.Fatalf("unexpected bootstrap: %+v", bootstrap)
	}
	if upstreamRequestID != "upstream-req-1" {
		t.Fatalf("upstream request ID = %q", upstreamRequestID)
	}
	raw, err := json.Marshal(bootstrap)
	if err != nil {
		t.Fatal(err)
	}
	var fields map[string]any
	if err := json.Unmarshal(raw, &fields); err != nil {
		t.Fatal(err)
	}
	if _, ok := fields["poolId"]; ok {
		t.Fatal("sanitized bootstrap exposed poolId")
	}
}

func TestTATClientMapsOwnershipStateAndTimeoutFailures(t *testing.T) {
	for _, tc := range []struct {
		name   string
		status int
		want   error
	}{
		{name: "ownership", status: http.StatusNotFound, want: ErrTATNotFound},
		{name: "entitlement", status: http.StatusForbidden, want: ErrTATConflict},
		{name: "state", status: http.StatusConflict, want: ErrTATConflict},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(tc.status) }))
			defer server.Close()
			client, err := NewTATClient(TATClientConfig{BaseURL: server.URL, InternalToken: "internal-token", Timeout: time.Second})
			if err != nil {
				t.Fatal(err)
			}
			_, _, err = client.CreateSession(t.Context(), "bot-1", "user-1", "req_0123456789abcdef")
			if !errors.Is(err, tc.want) {
				t.Fatalf("error = %v, want %v", err, tc.want)
			}
		})
	}

	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { <-time.After(100 * time.Millisecond) }))
	defer server.Close()
	client, err := NewTATClient(TATClientConfig{BaseURL: server.URL, InternalToken: "internal-token", Timeout: 10 * time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	_, _, err = client.CreateSession(context.Background(), "bot-1", "user-1", "req_0123456789abcdef")
	if !errors.Is(err, ErrTATTimeout) {
		t.Fatalf("timeout error = %v", err)
	}
}
