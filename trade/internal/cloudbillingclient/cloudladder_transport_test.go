package cloudbillingclient

import (
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

type captureRoundTripper struct {
	req *http.Request
}

func (c *captureRoundTripper) RoundTrip(req *http.Request) (*http.Response, error) {
	c.req = req
	return &http.Response{
		StatusCode: http.StatusOK,
		Body:       io.NopCloser(strings.NewReader("ok")),
		Header:     http.Header{},
		Request:    req,
	}, nil
}

func TestCloudLadderTransportRewritesRequestAndSignsHeaders(t *testing.T) {
	base := &captureRoundTripper{}
	now := time.Date(2026, 5, 11, 8, 0, 0, 0, time.UTC)
	transport, err := newCloudLadderRoundTripper(cloudLadderTransportOptions{
		gatewayBaseURL: "https://cloudladdergateway.internal/base/",
		routeID:        "tcapi-billing-cn-dev",
		caller:         "trade",
		secret:         "secret",
		base:           base,
		now:            func() time.Time { return now },
	})
	if err != nil {
		t.Fatalf("new transport: %v", err)
	}
	req, err := http.NewRequest(http.MethodPost, "https://billing.dev.tencentcloudapi.com/?Action=CreatePayUrl", strings.NewReader(`{"order":1}`))
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	req.Header.Set("Authorization", "TC3-HMAC-SHA256 signed")
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-TC-Action", "CreatePayUrl")
	req.Header["X-TC-Token"] = []string{"tmp-session-token"}

	resp, err := transport.RoundTrip(req)
	if err != nil {
		t.Fatalf("round trip: %v", err)
	}
	_ = resp.Body.Close()
	if base.req == nil {
		t.Fatal("expected wrapped transport to receive request")
	}
	if got := base.req.URL.String(); got != "https://cloudladdergateway.internal/base/v1/proxy/tcapi-billing-cn-dev/?Action=CreatePayUrl" {
		t.Fatalf("unexpected rewritten URL %q", got)
	}
	if base.req.Host != "" {
		t.Fatalf("expected gateway-bound request Host to use URL host, got explicit Host %q", base.req.Host)
	}
	if got := base.req.URL.Host; got != "cloudladdergateway.internal" {
		t.Fatalf("unexpected gateway host %q", got)
	}
	if got := base.req.Header.Get(headerCloudLadderSignedHost); got != "billing.dev.tencentcloudapi.com" {
		t.Fatalf("unexpected signed host %q", got)
	}
	if got := base.req.Header.Get(headerCloudLadderCaller); got != "trade" {
		t.Fatalf("unexpected caller %q", got)
	}
	if got := base.req.Header.Get(headerCloudLadderTimestamp); got != "2026-05-11T08:00:00Z" {
		t.Fatalf("unexpected timestamp %q", got)
	}
	body, _ := io.ReadAll(base.req.Body)
	expectedSig := signCloudLadderRequest("secret", cloudLadderSignatureRequest{
		caller:    "trade",
		routeID:   "tcapi-billing-cn-dev",
		method:    http.MethodPost,
		path:      "/",
		query:     "Action=CreatePayUrl",
		body:      body,
		timestamp: "2026-05-11T08:00:00Z",
	})
	if got := base.req.Header.Get(headerCloudLadderSignature); got != expectedSig {
		t.Fatalf("unexpected signature %q want %q", got, expectedSig)
	}
	if got := base.req.Header.Get("Authorization"); got != "TC3-HMAC-SHA256 signed" {
		t.Fatalf("expected Authorization preserved, got %q", got)
	}
	if got := base.req.Header.Get("X-TC-Action"); got != "CreatePayUrl" {
		t.Fatalf("expected X-TC-Action preserved, got %q", got)
	}
	if got := base.req.Header["X-TC-Token"]; len(got) != 1 || got[0] != "tmp-session-token" {
		t.Fatalf("expected X-TC-Token preserved, got %v", got)
	}
}

func TestCloudLadderTransportPreservesEscapedCanonicalPath(t *testing.T) {
	base := &captureRoundTripper{}
	now := time.Date(2026, 5, 11, 8, 0, 0, 0, time.UTC)
	transport, err := newCloudLadderRoundTripper(cloudLadderTransportOptions{
		gatewayBaseURL: "https://cloudladdergateway.internal",
		routeID:        "tcapi-billing-cn-dev",
		caller:         "trade",
		secret:         "secret",
		base:           base,
		now:            func() time.Time { return now },
	})
	if err != nil {
		t.Fatalf("new transport: %v", err)
	}
	req, err := http.NewRequest(http.MethodPost, "https://billing.dev.tencentcloudapi.com/v1/a%2Fb?Action=CreatePayUrl", strings.NewReader("body"))
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	resp, err := transport.RoundTrip(req)
	if err != nil {
		t.Fatalf("round trip: %v", err)
	}
	_ = resp.Body.Close()

	if got := base.req.URL.EscapedPath(); got != "/v1/proxy/tcapi-billing-cn-dev/v1/a%2Fb" {
		t.Fatalf("unexpected escaped path %q", got)
	}
	body, _ := io.ReadAll(base.req.Body)
	expectedSig := signCloudLadderRequest("secret", cloudLadderSignatureRequest{
		caller:    "trade",
		routeID:   "tcapi-billing-cn-dev",
		method:    http.MethodPost,
		path:      "/v1/a%2Fb",
		query:     "Action=CreatePayUrl",
		body:      body,
		timestamp: "2026-05-11T08:00:00Z",
	})
	if got := base.req.Header.Get(headerCloudLadderSignature); got != expectedSig {
		t.Fatalf("unexpected signature %q want %q", got, expectedSig)
	}
}

func TestCloudLadderTransportDerivesSignedHostFromExplicitRequestHost(t *testing.T) {
	base := &captureRoundTripper{}
	transport, err := newCloudLadderRoundTripper(cloudLadderTransportOptions{
		gatewayBaseURL: "https://cloudladdergateway.internal",
		routeID:        "tcapi-billing-cn-dev",
		caller:         "trade",
		secret:         "secret",
		base:           base,
	})
	if err != nil {
		t.Fatalf("new transport: %v", err)
	}
	req, err := http.NewRequest(http.MethodPost, "https://127.0.0.1/", nil)
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	req.Host = "billing.dev.tencentcloudapi.com"
	resp, err := transport.RoundTrip(req)
	if err != nil {
		t.Fatalf("round trip: %v", err)
	}
	_ = resp.Body.Close()
	if got := base.req.Header.Get(headerCloudLadderSignedHost); got != "billing.dev.tencentcloudapi.com" {
		t.Fatalf("unexpected signed host %q", got)
	}
}

func TestCloudLadderTransportDoesNotConsumeOriginalBodyPermanently(t *testing.T) {
	base := &captureRoundTripper{}
	transport, err := newCloudLadderRoundTripper(cloudLadderTransportOptions{
		gatewayBaseURL: "https://cloudladdergateway.internal",
		routeID:        "tcapi-billing-cn-dev",
		caller:         "trade",
		secret:         "secret",
		base:           base,
	})
	if err != nil {
		t.Fatalf("new transport: %v", err)
	}
	req, err := http.NewRequest(http.MethodPost, "https://billing.dev.tencentcloudapi.com/", strings.NewReader("body"))
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	resp, err := transport.RoundTrip(req)
	if err != nil {
		t.Fatalf("round trip: %v", err)
	}
	_ = resp.Body.Close()
	body, _ := io.ReadAll(req.Body)
	if string(body) != "body" {
		t.Fatalf("expected original body restored, got %q", body)
	}
}

func TestCloudLadderBodySHA256MatchesGatewayEmptyBodyContract(t *testing.T) {
	if got := cloudLadderBodySHA256(nil); got != "" {
		t.Fatalf("empty body hash = %q, want empty string", got)
	}
	if got := cloudLadderBodySHA256([]byte("")); got != "" {
		t.Fatalf("zero-length body hash = %q, want empty string", got)
	}
	if got := cloudLadderBodySHA256([]byte("body")); got != "230d8358dc8e8890b4c58deeb62912ee2f20357ae92a5cc861b98e68fe31acb5" {
		t.Fatalf("body hash = %q", got)
	}
}
