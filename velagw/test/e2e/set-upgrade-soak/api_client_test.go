package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
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

func TestUpsertBundlePreservesGoldenPricingSnapshots(t *testing.T) {
	var saved struct {
		Spec struct {
			Options []struct {
				Key   string `json:"key"`
				Value string `json:"value"`
			} `json:"options"`
		} `json:"spec"`
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/api/channel-bundles":
			_, _ = w.Write([]byte(`{"success":true,"data":[{"id":"golden-channels","spec":{"options":[{"key":"ModelRatio","value":"{\"existing-a\":2}"},{"key":"CompletionRatio","value":{"existing-b":3}}]}}]}`))
		case r.Method == http.MethodPost && r.URL.Path == "/api/channel-bundles":
			if err := json.NewDecoder(r.Body).Decode(&saved); err != nil {
				t.Fatal(err)
			}
			_, _ = w.Write([]byte(`{"success":true,"data":{"id":"upgrade-soak-openai"}}`))
		default:
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
	}))
	defer server.Close()

	cfg := config{Model: "llmgw-upgrade-soak", UpstreamModel: "mock", BundleID: "upgrade-soak-openai", PacerPublicURL: "http://pacer", UpstreamKey: "sk-test"}
	if err := newAPIClient(server.URL, "token").upsertBundle(t.Context(), cfg); err != nil {
		t.Fatal(err)
	}
	if len(saved.Spec.Options) != 2 {
		t.Fatalf("options = %+v", saved.Spec.Options)
	}
	values := map[string]map[string]any{}
	for _, option := range saved.Spec.Options {
		var decoded map[string]any
		if err := json.Unmarshal([]byte(option.Value), &decoded); err != nil {
			t.Fatal(err)
		}
		values[option.Key] = decoded
	}
	if values["ModelRatio"]["existing-a"] != float64(2) || values["CompletionRatio"]["existing-b"] != float64(3) {
		t.Fatalf("golden values were lost: %+v", values)
	}
	if values["ModelRatio"][cfg.Model] != float64(1) || values["CompletionRatio"][cfg.Model] != float64(1) {
		t.Fatalf("soak model was not added: %+v", values)
	}
}

func TestUpsertBundleRefusesMissingGoldenSnapshot(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			t.Fatalf("unsafe write attempted: %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"success":true,"data":[]}`))
	}))
	defer server.Close()

	err := newAPIClient(server.URL, "token").upsertBundle(t.Context(), config{Model: "model"})
	if err == nil || !strings.Contains(err.Error(), "golden-channels") {
		t.Fatalf("err = %v", err)
	}
}
