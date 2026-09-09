package auth

import (
	"errors"
	"path/filepath"
	"testing"
	"time"

	"github.com/openclaw/openclaw/mono/cloudladdergateway/internal/config"
)

func TestRequiredCutoverBlocksProxyButKeepsBillingCallback(t *testing.T) {
	t.Setenv("CLOUDLADDER_PAYMENT_HMAC_SECRET", "payment-secret")
	t.Setenv("CLOUDLADDER_SHADOW_HMAC_SECRET", "shadow-secret")
	t.Setenv("CLOUDLADDER_TRADE_HMAC_SECRET", "trade-secret")
	cfg, err := config.Load(filepath.Join("..", "..", "config.example.yaml"))
	if err != nil {
		t.Fatalf("load example config: %v", err)
	}
	cfg.Auth.Mode = config.AuthModeRequired
	authenticator, err := New(cfg)
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}

	proxyRequest := Request{
		RouteID: "jifei-prod",
		Method:  "POST",
		Path:    "/interfaces/interface.php",
		Body:    []byte(`{"interface":{"interfaceName":"qcloud.price.getPrice"}}`),
	}
	if err := authenticator.Verify(proxyRequest); !errors.Is(err, ErrMissingCredentials) {
		t.Fatalf("unsigned jifei-prod error = %v, want ErrMissingCredentials", err)
	}
	proxyRequest.Caller = "lightvela-trade"
	proxyRequest.Timestamp = time.Now().UTC().Format(time.RFC3339)
	proxyRequest.Signature = Sign("trade-secret", proxyRequest)
	if err := authenticator.Verify(proxyRequest); err != nil {
		t.Fatalf("signed jifei-prod rejected: %v", err)
	}

	callbackRequest := Request{
		RouteID: "jifei-callback-sh",
		Method:  "POST",
		Path:    "/trade/jifei/callback",
	}
	if err := authenticator.Verify(callbackRequest); err != nil {
		t.Fatalf("unsigned billing callback rejected: %v", err)
	}
}

func TestSignatureContractMatchesTradeClientVector(t *testing.T) {
	req := Request{
		Caller:    "lightvela-trade",
		RouteID:   "jifei-prod",
		Method:    "POST",
		Path:      "/interfaces/interface.php",
		Timestamp: "2026-09-08T00:59:16Z",
		Body:      []byte(`{"billingParam":{"pointOfSale":"safe"}}`),
	}
	const want = "sha256=4d5a87d3cc343b62b3027d04b00be2e8e8de7905273091dd8dadb6708201c756"
	if got := Sign("secret", req); got != want {
		t.Fatalf("Sign() = %q, want trade client contract %q", got, want)
	}
}

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

func TestAuthenticatorOptionalMode(t *testing.T) {
	t.Setenv("TRADE_SECRET", "secret-123")
	authenticator, err := New(config.Config{
		Auth: config.AuthConfig{
			Mode:          "optional",
			TimestampSkew: "5m",
			Callers: []config.CallerConfig{{
				ID:        "lightvela-trade",
				SecretEnv: "TRADE_SECRET",
				Routes:    []string{"jifei-prod"},
			}},
		},
		Routes: []config.RouteConfig{{ID: "jifei-prod"}},
	})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}

	unsigned := Request{RouteID: "jifei-prod", Method: "POST", Path: "/interfaces/interface.php"}
	if err := authenticator.Verify(unsigned); err != nil {
		t.Fatalf("unsigned optional request rejected: %v", err)
	}

	partial := unsigned
	partial.Caller = "lightvela-trade"
	if err := authenticator.Verify(partial); !errors.Is(err, ErrMissingCredentials) {
		t.Fatalf("partial signature error = %v, want ErrMissingCredentials", err)
	}

	signed := unsigned
	signed.Caller = "lightvela-trade"
	signed.Timestamp = time.Now().UTC().Format(time.RFC3339)
	signed.Signature = Sign("secret-123", signed)
	if err := authenticator.Verify(signed); err != nil {
		t.Fatalf("valid optional signature rejected: %v", err)
	}

	tampered := signed
	tampered.Body = []byte(`{"billingParam":{"pointOfSale":"tampered"}}`)
	if err := authenticator.Verify(tampered); !errors.Is(err, ErrInvalidSignature) {
		t.Fatalf("tampered request error = %v, want ErrInvalidSignature", err)
	}
}

func TestAuthenticatorOptionalModeSkipsUnconfiguredCallers(t *testing.T) {
	t.Setenv("TRADE_SECRET", "secret-123")
	authenticator, err := New(config.Config{
		Auth: config.AuthConfig{
			Mode: "optional",
			Callers: []config.CallerConfig{
				{ID: "lightvela-trade", SecretEnv: "TRADE_SECRET", Routes: []string{"jifei-prod"}},
				{ID: "legacy-payment", SecretEnv: "MISSING_PAYMENT_SECRET", Routes: []string{"billing-prod"}},
			},
		},
		Routes: []config.RouteConfig{{ID: "jifei-prod"}, {ID: "billing-prod"}},
	})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}

	legacySigned := Request{
		Caller:    "legacy-payment",
		RouteID:   "billing-prod",
		Method:    "POST",
		Path:      "/",
		Timestamp: time.Now().UTC().Format(time.RFC3339),
		Signature: "sha256=spoofed",
	}
	if err := authenticator.Verify(legacySigned); !errors.Is(err, ErrUnknownCaller) {
		t.Fatalf("unconfigured signed caller error = %v, want ErrUnknownCaller", err)
	}
	if err := authenticator.Verify(Request{RouteID: "billing-prod", Method: "POST", Path: "/"}); err != nil {
		t.Fatalf("unsigned legacy caller rejected in optional mode: %v", err)
	}
}

func TestAuthenticatorDisabledModePreservesLegacyBypass(t *testing.T) {
	authenticator, err := New(config.Config{Auth: config.AuthConfig{Mode: "disabled"}})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	if err := authenticator.Verify(Request{Caller: "spoofed", Signature: "invalid"}); err != nil {
		t.Fatalf("disabled mode rejected legacy request: %v", err)
	}
}

func TestVerifyRequiredCallerEnforcesHMACWhenGlobalAuthIsDisabled(t *testing.T) {
	t.Setenv("DEVELOPER_ROUTE_SECRET", "developer-route-secret")
	authenticator, err := New(config.Config{Auth: config.AuthConfig{
		Mode: config.AuthModeDisabled, TimestampSkew: "5m",
		Callers: []config.CallerConfig{{ID: "lightclaw-auth", SecretEnv: "DEVELOPER_ROUTE_SECRET"}},
	}})
	if err != nil {
		t.Fatalf("new authenticator: %v", err)
	}
	req := Request{Caller: "lightclaw-auth", RouteID: "developer-route-registration", Method: "GET", Path: "/v1/dev-environments/registration", Query: "uin=450860000013", Timestamp: time.Now().UTC().Format(time.RFC3339)}
	if err := authenticator.VerifyRequiredCaller(req, "lightclaw-auth"); !errors.Is(err, ErrMissingCredentials) {
		t.Fatalf("unsigned request error = %v", err)
	}
	req.Signature = Sign("developer-route-secret", req)
	if err := authenticator.VerifyRequiredCaller(req, "lightclaw-auth"); err != nil {
		t.Fatalf("verify required caller: %v", err)
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
