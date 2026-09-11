package llmgateway

import (
	"context"
	"encoding/json"
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

	adapter := NewLLMGatewayAdapter(&config.LLMGatewayConfig{
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
	adapter := NewLLMGatewayAdapter(&config.LLMGatewayConfig{
		BaseURL: "http://example.invalid",
		Timeout: 5,
	}, nil)

	_, err := adapter.EnsureUser(context.Background(), "usr_test", "")
	if err == nil || err.Error() != "llmgateway internal_service_token not configured" {
		t.Fatalf("expected internal token error, got %v", err)
	}
}

func TestListActiveSubscriptionsUsesInternalContract(t *testing.T) {
	var authHeader string
	var gotPath string

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		authHeader = r.Header.Get("Authorization")
		gotPath = r.URL.Path
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(apiResponse{
			Code:    0,
			Message: "ok",
			Data: mustRawJSON(t, ActiveSubscriptionList{
				UserID: "usr_test",
				Subscriptions: []Subscription{
					{
						ID:           "sub-1",
						Name:         "free-credit:campaign:grant-1",
						UserID:       "usr_test",
						PlanID:       "plan-free",
						Status:       "active",
						TokenTotal:   30000,
						TokenBalance: 20000,
					},
				},
			}),
		})
	}))
	defer server.Close()

	adapter := NewLLMGatewayAdapter(&config.LLMGatewayConfig{
		BaseURL:              server.URL,
		InternalServiceToken: "internal-token",
		Timeout:              5,
	}, nil)

	list, err := adapter.ListActiveSubscriptions(context.Background(), "usr_test")
	if err != nil {
		t.Fatalf("list active subscriptions: %v", err)
	}
	if authHeader != "Bearer internal-token" {
		t.Fatalf("expected internal auth header, got %q", authHeader)
	}
	if gotPath != "/api/internal/users/usr_test/subscriptions/active" {
		t.Fatalf("path = %q", gotPath)
	}
	if list == nil || len(list.Subscriptions) != 1 {
		t.Fatalf("unexpected list: %+v", list)
	}
	if got := list.Subscriptions[0]; got.Name != "free-credit:campaign:grant-1" || got.TokenTotal != 30000 || got.TokenBalance != 20000 {
		t.Fatalf("unexpected subscription: %+v", got)
	}
}

func TestCancelSelectedSubscriptionsUsesInternalContract(t *testing.T) {
	var authHeader string
	var gotPath string
	var request CancelSelectedSubscriptionsRequest

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		authHeader = r.Header.Get("Authorization")
		gotPath = r.URL.Path
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(apiResponse{
			Code:    0,
			Message: "ok",
			Data:    mustRawJSON(t, map[string]string{"status": "ok"}),
		})
	}))
	defer server.Close()

	adapter := NewLLMGatewayAdapter(&config.LLMGatewayConfig{
		BaseURL:              server.URL,
		InternalServiceToken: "internal-token",
		Timeout:              5,
	}, nil)

	err := adapter.CancelSelectedSubscriptions(context.Background(), &CancelSelectedSubscriptionsRequest{
		UserID:                           " usr_test ",
		SubscriptionNamePrefixes:         []string{"package:", "free-credit:"},
		IncludeLegacyPackageSubscription: true,
	})
	if err != nil {
		t.Fatalf("cancel selected subscriptions: %v", err)
	}
	if authHeader != "Bearer internal-token" {
		t.Fatalf("expected internal auth header, got %q", authHeader)
	}
	if gotPath != "/api/internal/subscriptions/cancel-selected" {
		t.Fatalf("path = %q", gotPath)
	}
	if request.UserID != "usr_test" {
		t.Fatalf("user_id = %q", request.UserID)
	}
	if len(request.SubscriptionNamePrefixes) != 2 || request.SubscriptionNamePrefixes[0] != "package:" || request.SubscriptionNamePrefixes[1] != "free-credit:" {
		t.Fatalf("unexpected prefixes: %+v", request.SubscriptionNamePrefixes)
	}
	if !request.IncludeLegacyPackageSubscription {
		t.Fatalf("include legacy package subscription must be true")
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
