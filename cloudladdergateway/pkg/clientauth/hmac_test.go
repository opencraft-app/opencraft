package clientauth

import (
	"testing"
	"time"

	gatewayv1 "github.com/openclaw/openclaw/mono/cloudladdergateway/gen/cloudladdergateway/v1"
	"github.com/openclaw/openclaw/mono/cloudladdergateway/internal/auth"
)

func TestSignProxyRequest(t *testing.T) {
	req := &gatewayv1.ProxyRequest{
		Caller:  "payment",
		RouteId: "billing.query_bill",
		Method:  "POST",
		Path:    "/bill/query",
		Body:    []byte(`{"id":"acct"}`),
	}
	now := time.Date(2026, 5, 7, 12, 0, 0, 0, time.UTC)
	SignProxyRequest("secret", req, now)

	expected := auth.Sign("secret", auth.Request{
		Caller:    req.GetCaller(),
		RouteID:   req.GetRouteId(),
		Method:    req.GetMethod(),
		Path:      req.GetPath(),
		Body:      req.GetBody(),
		Timestamp: req.GetTimestamp(),
	})
	if req.GetTimestamp() != "2026-05-07T12:00:00Z" {
		t.Fatalf("unexpected timestamp %q", req.GetTimestamp())
	}
	if req.GetSignature() != expected {
		t.Fatalf("unexpected signature %q want %q", req.GetSignature(), expected)
	}
}
