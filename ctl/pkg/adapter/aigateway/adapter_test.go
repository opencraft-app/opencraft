package aigateway

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"ctl/pkg/config"
)

func TestEnsureUserUsesInternalContract(t *testing.T) {
	t.Helper()

	var authHeader string
	var request EnsureUserRequest

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		authHeader = r.Header.Get("Authorization")
		if r.URL.Path != "/api/internal/users/ensure" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(apiResponse{
			Code:    0,
			Message: "ok",
			Data:    mustRawJSON(t, EnsureUserResponse{UserID: request.UserID, Result: "created"}),
		})
	}))
	defer server.Close()

	adapter := NewAiGatewayAdapter(&config.AiGatewayConfig{
		BaseURL:              server.URL,
		InternalServiceToken: "internal-token",
		Timeout:              5,
	}, nil)

	resp, err := adapter.EnsureUser(context.Background(), "usr_test", "Nick")
	if err != nil {
		t.Fatalf("ensure user: %v", err)
	}
	if authHeader != "Bearer internal-token" {
		t.Fatalf("expected internal auth header, got %q", authHeader)
	}
	if request.UserID != "usr_test" || request.Nickname != "Nick" {
		t.Fatalf("unexpected request: %+v", request)
	}
	if resp == nil || resp.Result != "created" || resp.UserID != "usr_test" {
		t.Fatalf("unexpected response: %+v", resp)
	}
}

func TestEnsureUserRequiresInternalToken(t *testing.T) {
	adapter := NewAiGatewayAdapter(&config.AiGatewayConfig{
		BaseURL: "http://example.invalid",
		Timeout: 5,
	}, nil)

	_, err := adapter.EnsureUser(context.Background(), "usr_test", "")
	if !errors.Is(err, ErrAiGatewayNotConfigured) {
		t.Fatalf("expected internal token error, got %v", err)
	}
}

func mustRawJSON(t *testing.T, value any) json.RawMessage {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("marshal raw data: %v", err)
	}
	return data
}
