package clients

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"git.woa.com/wisp/mono2/llmgateway/test/regression/framework"
)

func TestJSONClientNeverIncludesSecretsOrRawResponseInErrors(t *testing.T) {
	sanitizer := framework.NewSanitizer()
	token := sanitizer.Secret("admin-secret-token")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer admin-secret-token" {
			t.Fatalf("Authorization = %q", got)
		}
		w.WriteHeader(http.StatusBadGateway)
		_, _ = w.Write([]byte(`{"success":false,"message":"upstream admin-secret-token failed","debug":"raw-private-body"}`))
	}))
	defer server.Close()

	client := NewJSONClient(server.URL, token, server.Client(), sanitizer)
	err := client.Do(t.Context(), http.MethodPost, "/api/test", map[string]string{"key": "admin-secret-token"}, nil)
	if err == nil {
		t.Fatal("Do() error = nil")
	}
	message := err.Error()
	if strings.Contains(message, "admin-secret-token") || strings.Contains(message, "raw-private-body") {
		t.Fatalf("error leaked response: %s", message)
	}
	for _, want := range []string{"POST", "/api/test", "502", framework.RedactedValue} {
		if !strings.Contains(message, want) {
			t.Fatalf("error missing %q: %s", want, message)
		}
	}
}

func TestJSONClientRejectsNonEnvelopeSuccessWithoutDumpingBody(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("not-json-sensitive"))
	}))
	defer server.Close()
	client := NewJSONClient(server.URL, framework.Secret{}, server.Client(), framework.NewSanitizer())
	err := client.Do(context.Background(), http.MethodGet, "/broken", nil, nil)
	if err == nil || strings.Contains(err.Error(), "not-json-sensitive") {
		t.Fatalf("error = %v", err)
	}
}

func TestSafeErrorFormattingDoesNotExposeRequestBody(t *testing.T) {
	err := &HTTPError{Method: http.MethodPost, Path: "/v1/chat/completions", Status: 500, Message: "failed"}
	if got := fmt.Sprint(err); got != "POST /v1/chat/completions returned 500: failed" {
		t.Fatalf("HTTPError = %q", got)
	}
}
