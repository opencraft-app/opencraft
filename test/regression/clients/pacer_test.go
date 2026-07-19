package clients

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"git.woa.com/wisp/mono2/llmgateway/test/regression/framework"
)

func TestPacerFaultClientUpdatesEveryPod(t *testing.T) {
	updates := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/__regression/fault" || r.Header.Get("Authorization") != "Bearer internal-token" {
			t.Fatalf("request = %s auth=%q", r.URL.Path, r.Header.Get("Authorization"))
		}
		var policy PacerFaultPolicy
		if err := json.NewDecoder(r.Body).Decode(&policy); err != nil {
			t.Fatal(err)
		}
		if !policy.Enabled || policy.StatusCode != http.StatusServiceUnavailable {
			t.Fatalf("policy = %+v", policy)
		}
		updates++
		_, _ = w.Write([]byte(`{"success":true}`))
	}))
	defer server.Close()
	sanitizer := framework.NewSanitizer()
	client := NewPacerFaultClient(server.Client(), sanitizer)

	if err := client.Apply(t.Context(), []string{server.URL, server.URL}, sanitizer.Secret("internal-token"), PacerFaultPolicy{Enabled: true, StatusCode: 503, Message: "fail"}); err != nil {
		t.Fatal(err)
	}
	if updates != 2 {
		t.Fatalf("updates = %d", updates)
	}
}
