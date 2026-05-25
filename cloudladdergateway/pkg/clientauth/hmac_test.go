package clientauth

import (
	"net/http"
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

func TestSignHTTPHeaders(t *testing.T) {
	headers := http.Header{}
	now := time.Date(2026, 5, 11, 8, 0, 0, 0, time.UTC)
	req := HTTPRequest{
		Caller:  "shadow",
		RouteID: "tcapi-billing-cn-dev",
		Method:  "POST",
		Path:    "/",
		Query:   "Action=CreateOrders",
		Body:    []byte(`{"id":"order"}`),
	}
	SignHTTPHeaders("secret", headers, req, now)

	expected := auth.Sign("secret", auth.Request{
		Caller:    req.Caller,
		RouteID:   req.RouteID,
		Method:    req.Method,
		Path:      req.Path,
		Query:     req.Query,
		Body:      req.Body,
		Timestamp: "2026-05-11T08:00:00Z",
	})
	if headers.Get(HeaderCaller) != "shadow" {
		t.Fatalf("unexpected caller %q", headers.Get(HeaderCaller))
	}
	if headers.Get(HeaderTimestamp) != "2026-05-11T08:00:00Z" {
		t.Fatalf("unexpected timestamp %q", headers.Get(HeaderTimestamp))
	}
	if headers.Get(HeaderSignature) != expected {
		t.Fatalf("unexpected signature %q want %q", headers.Get(HeaderSignature), expected)
	}
}
