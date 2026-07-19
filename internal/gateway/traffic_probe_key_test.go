package gateway

import (
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
)

func TestGetOrCreateTrafficProbeKeyReturnsOneTimeV2KeyWithoutPersistingPlaintext(t *testing.T) {
	var tokenCreates atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.Method + " " + r.URL.Path {
		case "POST /api/user/login":
			writeTestJSON(t, w, map[string]any{"success": true, "data": map[string]any{"id": 42, "username": "sgw-probe-user"}})
		case "GET /api/user/token":
			writeTestJSON(t, w, map[string]any{"success": true, "data": "user-access-token"})
		case "POST /api/token/":
			tokenCreates.Add(1)
			writeTestJSON(t, w, map[string]any{"success": true})
		case "GET /api/token/search":
			writeTestJSON(t, w, map[string]any{"success": true, "data": map[string]any{"items": []map[string]any{{"id": 7, "name": r.URL.Query().Get("keyword")}}}})
		case "POST /api/token/7/key":
			writeTestJSON(t, w, map[string]any{"success": true, "data": map[string]any{"key": "sk-upstream"}})
		default:
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
	}))
	defer upstream.Close()

	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	if err := store.SaveSet(t.Context(), Set{
		ID: "set-a", Name: "Set A", BaseURL: upstream.URL, TrafficBaseURL: upstream.URL,
		Status: SetStatusActive, Setup: true, AdminUserID: 1, AdminAccessToken: "set-admin-token",
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveUserBinding(t.Context(), UserBinding{
		ExternalUserID: "probe-user", SetID: "set-a", UpstreamUserID: 42,
		Username: "sgw-probe-user", Password: "password", ProvisionStatus: BindingProvisionStatusTokenReady,
	}); err != nil {
		t.Fatal(err)
	}

	result, err := svc.GetOrCreateTrafficProbeKey(t.Context(), "probe-user")
	if err != nil {
		t.Fatal(err)
	}
	if !result.Created || !parseTrafficRouteLookup(result.Binding.ExternalKey).Valid {
		t.Fatalf("unexpected one-time probe key: %+v", result)
	}
	if result.Binding.Purpose != "" || result.Binding.ExternalKeyHash != hashExternalKey(result.Binding.ExternalKey) {
		t.Fatalf("unexpected one-time probe binding: %+v", result.Binding)
	}
	if got := tokenCreates.Load(); got != 1 {
		t.Fatalf("upstream token creates = %d, want 1", got)
	}
	stored, ok, err := store.GetAPIKeyBindingByExternalKeyID(t.Context(), result.Binding.ExternalKeyID)
	if err != nil || !ok {
		t.Fatalf("stored probe binding: ok=%v err=%v", ok, err)
	}
	if stored.ExternalKey != "" {
		t.Fatalf("stored external key plaintext = %q", stored.ExternalKey)
	}
}
