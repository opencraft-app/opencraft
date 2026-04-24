package aigateway

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(req *http.Request) (*http.Response, error) {
	return f(req)
}

func TestSyntheticPhoneForExternalUserIsStableAndNonEmpty(t *testing.T) {
	first := syntheticPhoneForExternalUser("usr_e6d3bc6caa59e8415ba1d04c")
	second := syntheticPhoneForExternalUser("usr_e6d3bc6caa59e8415ba1d04c")
	other := syntheticPhoneForExternalUser("usr_other")

	if first != second {
		t.Fatalf("expected deterministic phone, got %q and %q", first, second)
	}
	if len(first) != 11 {
		t.Fatalf("expected 11-digit phone, got %q", first)
	}
	if first[:2] != "13" {
		t.Fatalf("expected synthetic phone to start with 13, got %q", first)
	}
	if first == other {
		t.Fatalf("expected distinct users to map to different phones, both=%q", first)
	}
}

func TestClientUsesInternalSubscriptionEndpoint(t *testing.T) {
	var gotAuth string
	var gotPath string
	var gotBody map[string]string
	client := NewClient("http://ai-gateway.internal")
	client.httpClient = &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		gotAuth = r.Header.Get("Authorization")
		gotPath = r.URL.Path
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Fatalf("read request body: %v", err)
		}
		if err := json.Unmarshal(body, &gotBody); err != nil {
			t.Fatalf("decode request body: %v", err)
		}
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     http.Header{"Content-Type": []string{"application/json"}},
			Body:       io.NopCloser(strings.NewReader(`{"id":"sub-1","user_id":"user-1","plan_id":"plan-free","status":"active"}`)),
		}, nil
	})}
	_, err := client.SetSubscriptionByExternalUID(t.Context(), "usr_123", "plan-free")
	if err != nil {
		t.Fatalf("expected set subscription to succeed, got error: %v", err)
	}
	if gotPath != "/api/internal/subscriptions/apply" {
		t.Fatalf("expected internal apply path, got %q", gotPath)
	}
	if gotAuth != "" {
		t.Fatalf("expected no internal auth header, got %q", gotAuth)
	}
	if gotBody["user_id"] != "usr_123" {
		t.Fatalf("expected user_id in request body, got %#v", gotBody)
	}
	if _, ok := gotBody["external_user_id"]; ok {
		t.Fatalf("expected external_user_id to be absent, got %#v", gotBody)
	}
}
