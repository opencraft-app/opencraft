package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestCreateUpgradeUsesConfiguredSource(t *testing.T) {
	var request struct {
		Source string `json:"source"`
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/admin/set-upgrades" {
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"success":true,"data":{"id":"batch-1","status":"pending","runs":[]}}`))
	}))
	defer server.Close()

	client := newAPIClient(server.URL, "test-token")
	_, err := client.createUpgrade(context.Background(), config{
		Source:      "prod",
		Namespace:   "llmgateway",
		Fleet:       "prod",
		TargetSetID: "set-canary",
		TargetImage: "registry.example/llmgateway@sha256:abc",
	})
	if err != nil {
		t.Fatal(err)
	}
	if request.Source != "prod" {
		t.Fatalf("source = %q, want prod", request.Source)
	}
}
