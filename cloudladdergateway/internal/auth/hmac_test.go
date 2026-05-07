package auth

import (
	"testing"
	"time"

	"github.com/openclaw/openclaw/mono/cloudladdergateway/internal/config"
)

func TestAuthenticatorVerifiesSignedRequest(t *testing.T) {
	t.Setenv("PAYMENT_SECRET", "secret-123")
	authenticator, err := New(config.Config{
		Auth: config.AuthConfig{
			Enabled:       true,
			TimestampSkew: "5m",
			Callers: []config.CallerConfig{{
				ID:        "payment",
				SecretEnv: "PAYMENT_SECRET",
			}},
		},
		Routes: []config.RouteConfig{{
			ID:      "billing.query_bill",
			Callers: []string{"payment"},
		}},
	})
	if err != nil {
		t.Fatalf("new authenticator: %v", err)
	}

	req := Request{
		Caller:    "payment",
		RouteID:   "billing.query_bill",
		Method:    "POST",
		Path:      "/bill/query",
		Timestamp: time.Now().UTC().Format(time.RFC3339),
		Body:      []byte(`{"id":"acct"}`),
	}
	req.Signature = Sign("secret-123", req)

	if err := authenticator.Verify(req); err != nil {
		t.Fatalf("verify: %v", err)
	}
}

func TestAuthenticatorRejectsWrongRoute(t *testing.T) {
	t.Setenv("PAYMENT_SECRET", "secret-123")
	authenticator, err := New(config.Config{
		Auth: config.AuthConfig{
			Enabled:       true,
			TimestampSkew: "5m",
			Callers: []config.CallerConfig{{
				ID:        "payment",
				SecretEnv: "PAYMENT_SECRET",
				Routes:    []string{"billing.query_bill"},
			}},
		},
		Routes: []config.RouteConfig{{ID: "account.get_user"}},
	})
	if err != nil {
		t.Fatalf("new authenticator: %v", err)
	}

	req := Request{
		Caller:    "payment",
		RouteID:   "account.get_user",
		Method:    "POST",
		Path:      "/account/get",
		Timestamp: time.Now().UTC().Format(time.RFC3339),
	}
	req.Signature = Sign("secret-123", req)

	if err := authenticator.Verify(req); err == nil {
		t.Fatal("expected route denied")
	}
}
