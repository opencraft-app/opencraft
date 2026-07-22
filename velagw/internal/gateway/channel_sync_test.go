package gateway

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestChannelSpecSyncCreatesMissingRemoteChannel(t *testing.T) {
	var remoteCreated bool
	var remoteUpdated bool
	var createdName string
	var createdKey string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.Header.Get("Authorization") != "Bearer set-admin-token" || r.Header.Get("New-Api-User") != "1" {
			t.Fatalf("missing admin auth headers for %s %s", r.Method, r.URL.Path)
		}

		switch r.Method + " " + r.URL.Path {
		case "GET /api/channel/search":
			if !strings.Contains(r.URL.RawQuery, "keyword=llmgw%3Aminimax%3AMiniMax") {
				t.Fatalf("unexpected search query: %s", r.URL.RawQuery)
			}
			items := []map[string]any{}
			if remoteCreated {
				items = append(items, map[string]any{
					"id":       21,
					"name":     "llmgw:minimax:MiniMax",
					"type":     1,
					"status":   1,
					"models":   "minimax-m2.7",
					"group":    "default",
					"base_url": "https://tokenhub.tencentmaas.com",
					"priority": 10,
					"weight":   2,
				})
			}
			writeGatewayChannelJSON(t, w, map[string]any{"success": true, "data": map[string]any{"items": items, "total": len(items)}})
		case "POST /api/channel/":
			var req struct {
				Mode    string `json:"mode"`
				Channel struct {
					Name    string  `json:"name"`
					Type    int     `json:"type"`
					Key     string  `json:"key"`
					Models  string  `json:"models"`
					Group   string  `json:"group"`
					BaseURL *string `json:"base_url"`
				} `json:"channel"`
			}
			decodeGatewayChannelJSON(t, r, &req)
			createdName = req.Channel.Name
			createdKey = req.Channel.Key
			remoteCreated = true
			writeGatewayChannelJSON(t, w, map[string]any{"success": true})
		case "PUT /api/channel/":
			var req struct {
				ID     int    `json:"id"`
				Name   string `json:"name"`
				Type   int    `json:"type"`
				Key    string `json:"key"`
				Models string `json:"models"`
				Group  string `json:"group"`
			}
			decodeGatewayChannelJSON(t, r, &req)
			if req.ID != 21 || req.Name != "llmgw:minimax:MiniMax" || req.Key != "sk-provider" {
				t.Fatalf("unexpected update payload: %+v", req)
			}
			remoteUpdated = true
			writeGatewayChannelJSON(t, w, map[string]any{"success": true})
		default:
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
	}))
	defer upstream.Close()

	store := NewMemoryStore()
	svc := NewService(store, upstream.Client().Transport, Options{})
	if err := store.SaveSet(t.Context(), Set{
		ID:               "set-a",
		Name:             "Set A",
		BaseURL:          upstream.URL,
		Status:           SetStatusActive,
		Setup:            true,
		AdminUserID:      1,
		AdminAccessToken: "set-admin-token",
	}); err != nil {
		t.Fatal(err)
	}

	spec, err := svc.UpsertChannelSpec(t.Context(), ChannelSpec{
		ID:       "minimax",
		Name:     "MiniMax",
		Type:     1,
		Key:      "sk-provider",
		BaseURL:  "https://tokenhub.tencentmaas.com",
		Models:   "minimax-m2.7",
		Group:    "default",
		Priority: 10,
		Weight:   2,
		Status:   ChannelSpecStatusEnabled,
	})
	if err != nil {
		t.Fatal(err)
	}
	if spec.KeyHash == "" || spec.Fingerprint == "" {
		t.Fatalf("spec did not derive key hash/fingerprint: %+v", spec)
	}
	pending, ok, err := store.GetChannelSyncState(t.Context(), "minimax", "set-a")
	if err != nil || !ok {
		t.Fatalf("pending state ok=%v err=%v", ok, err)
	}
	if pending.Status != ChannelSyncStatusPending {
		t.Fatalf("initial sync status = %s, want pending", pending.Status)
	}

	state, err := svc.SyncChannelToSet(t.Context(), "minimax", "set-a", ChannelSyncOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if createdName != "llmgw:minimax:MiniMax" || createdKey != "sk-provider" {
		t.Fatalf("created name/key = %q/%q", createdName, createdKey)
	}
	if !remoteUpdated {
		t.Fatal("newly created remote channel was not updated to refresh new-api channel cache")
	}
	if state.Status != ChannelSyncStatusSynced || state.RemoteChannelID != 21 || state.LastAppliedKeyHash != spec.KeyHash {
		t.Fatalf("sync state = %+v, want synced remote id 21", state)
	}
}

func decodeGatewayChannelJSON(t *testing.T, r *http.Request, out any) {
	t.Helper()
	if err := json.NewDecoder(r.Body).Decode(out); err != nil {
		t.Fatal(err)
	}
}

func writeGatewayChannelJSON(t *testing.T, w http.ResponseWriter, v any) {
	t.Helper()
	if err := json.NewEncoder(w).Encode(v); err != nil {
		t.Fatal(err)
	}
}
