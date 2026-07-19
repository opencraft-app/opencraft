package httpapi

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"git.woa.com/wisp/mono2/llmgateway/internal/gateway"
)

func TestAdminTrafficProbeGatewayModeUsesUnifiedTrafficEndpoint(t *testing.T) {
	traffic := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/v1/chat/completions" {
			t.Fatalf("unexpected traffic request: %s %s", r.Method, r.URL.Path)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer sk-external" {
			t.Fatalf("authorization = %q", got)
		}
		var body struct {
			Model    string `json:"model"`
			Stream   bool   `json:"stream"`
			Messages []struct {
				Role    string `json:"role"`
				Content string `json:"content"`
			} `json:"messages"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if body.Model != "auto" || body.Stream || len(body.Messages) != 2 || body.Messages[1].Content != "ping" {
			t.Fatalf("unexpected request body: %+v", body)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"chatcmpl-gateway","model":"auto","choices":[{"finish_reason":"stop","message":{"role":"assistant","content":"gateway ok"}}],"usage":{"total_tokens":7}}`))
	}))
	defer traffic.Close()

	svc := gateway.NewService(gateway.NewMemoryStore(), nil, gateway.Options{})
	handler := NewControlServer(svc, Config{
		AdminToken:          "cluster-token",
		TrafficBaseURL:      traffic.URL,
		TrafficProbeClient:  traffic.Client(),
		TrafficProbeTimeout: time.Second,
	})

	req := httptest.NewRequest(http.MethodPost, "/api/admin/traffic-probe", bytes.NewBufferString(`{
		"mode":"gateway",
		"api_key":"sk-external",
		"model":"auto",
		"prompt":"ping"
	}`))
	req.Header.Set("Authorization", "Bearer cluster-token")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if !bytes.Contains(rec.Body.Bytes(), []byte(`"mode":"gateway"`)) ||
		!bytes.Contains(rec.Body.Bytes(), []byte(`"content":"gateway ok"`)) {
		t.Fatalf("unexpected response: %s", rec.Body.String())
	}
}

func TestAdminTrafficProbeSetDirectModeResolvesExternalKeyBinding(t *testing.T) {
	setTraffic := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/chat/completions" {
			t.Fatalf("unexpected set traffic path: %s", r.URL.Path)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer sk-upstream" {
			t.Fatalf("authorization = %q", got)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"chatcmpl-direct","model":"auto","choices":[{"finish_reason":"stop","message":{"role":"assistant","content":"set direct ok"}}]}`))
	}))
	defer setTraffic.Close()

	store := gateway.NewMemoryStore()
	svc := gateway.NewService(store, nil, gateway.Options{})
	if err := svc.RegisterSet(t.Context(), gateway.RegisterSetInput{
		ID: "set-a", Name: "Set A", BaseURL: setTraffic.URL, TrafficBaseURL: setTraffic.URL, Status: gateway.SetStatusActive,
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveAPIKeyBinding(t.Context(), gateway.APIKeyBinding{
		ExternalKey: "sk-external", ExternalKeyID: "key-1", Purpose: gateway.APIKeyPurposeTrafficProbe,
		UserID: "user-1", SetID: "set-a", UpstreamKey: "sk-upstream", UpstreamKeyID: 7,
	}); err != nil {
		t.Fatal(err)
	}
	handler := NewControlServer(svc, Config{
		AdminToken:          "cluster-token",
		TrafficBaseURL:      "http://unified-traffic.invalid",
		TrafficProbeClient:  setTraffic.Client(),
		TrafficProbeTimeout: time.Second,
	})

	req := httptest.NewRequest(http.MethodPost, "/api/admin/traffic-probe", bytes.NewBufferString(`{
		"mode":"set_direct",
		"user_id":"user-1",
		"model":"auto",
		"prompt":"ping"
	}`))
	req.Header.Set("Authorization", "Bearer cluster-token")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	for _, want := range []string{`"mode":"set_direct"`, `"user_id":"user-1"`, `"set_id":"set-a"`, `"key_id":"key-1"`, `"content":"set direct ok"`} {
		if !bytes.Contains(rec.Body.Bytes(), []byte(want)) {
			t.Fatalf("response missing %s: %s", want, rec.Body.String())
		}
	}
}

func TestAdminTrafficProbeAcceptsUserIDWithoutAPIKey(t *testing.T) {
	svc := gateway.NewService(gateway.NewMemoryStore(), nil, gateway.Options{})
	handler := NewControlServer(svc, Config{AdminToken: "cluster-token"})

	req := httptest.NewRequest(http.MethodPost, "/api/admin/traffic-probe", bytes.NewBufferString(`{
		"mode":"gateway",
		"user_id":"probe-user",
		"model":"auto",
		"prompt":"ping"
	}`))
	req.Header.Set("Authorization", "Bearer cluster-token")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code == http.StatusBadRequest && bytes.Contains(rec.Body.Bytes(), []byte("api_key, model and prompt are required")) {
		t.Fatalf("user_id should be accepted without api_key: %s", rec.Body.String())
	}
}
