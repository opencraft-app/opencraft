package clientcli

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestCtlTenantEnsureSendsInternalRequest(t *testing.T) {
	var received map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/internal/users/ensure" || r.Method != http.MethodPost {
			t.Fatalf("request=%s %s", r.Method, r.URL.Path)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer internal-token" {
			t.Fatalf("authorization=%q", got)
		}
		if err := json.NewDecoder(r.Body).Decode(&received); err != nil {
			t.Fatal(err)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"success":true,"data":{"result":"created","user_id":"user-1"}}`))
	}))
	defer server.Close()

	var output bytes.Buffer
	root := NewRoot(Dependencies{Out: &output})
	root.SetArgs([]string{
		"--control-url", server.URL,
		"--internal-token", "internal-token",
		"ctl", "tenant", "ensure", "--user-id", "user-1", "--nickname", "Alice",
	})
	if err := root.Execute(); err != nil {
		t.Fatal(err)
	}
	if received["user_id"] != "user-1" || received["nickname"] != "Alice" {
		t.Fatalf("body=%v", received)
	}
	if !strings.Contains(output.String(), "确保租户存在") {
		t.Fatalf("output=%q", output.String())
	}
}

func TestBYOKSetParsesRepeatedProviderFlags(t *testing.T) {
	var providers []map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var input struct {
			Providers []map[string]any `json:"providers"`
		}
		if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
			t.Fatal(err)
		}
		providers = input.Providers
		_, _ = w.Write([]byte(`{"success":true,"data":{"user_id":"user-1"}}`))
	}))
	defer server.Close()

	provider := `{"id":"p1","name":"primary","protocol":"openai","base_url":"https://example.com/v1","api_key":"sk-private","model_mappings":{"auto":"model-a"},"enabled":true}`
	root := NewRoot(Dependencies{Out: &bytes.Buffer{}})
	root.SetArgs([]string{"--control-url", server.URL, "--internal-token", "token", "ctl", "byok", "set", "--user-id", "user-1", "--provider", provider})
	if err := root.Execute(); err != nil {
		t.Fatal(err)
	}
	if len(providers) != 1 || providers[0]["id"] != "p1" || providers[0]["api_key"] != "sk-private" || providers[0]["protocol"] != "openai_compatible" {
		t.Fatalf("providers=%v", providers)
	}
}

func TestMissingBusinessFlagFailsBeforeTransport(t *testing.T) {
	root := NewRoot(Dependencies{Out: &bytes.Buffer{}})
	root.SetArgs([]string{"ctl", "tenant", "ensure"})
	err := root.Execute()
	if err == nil || !strings.Contains(err.Error(), "--user-id") {
		t.Fatalf("error=%v", err)
	}
}
