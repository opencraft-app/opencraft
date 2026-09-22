package cloudbillingclient

import (
	"io"
	"net/http"
	"strings"
	"testing"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) { return f(request) }

func TestPersonalDevProxyTransportPreservesTC3Request(t *testing.T) {
	transport, err := newPersonalDevProxyTransport(PersonalDevProxyConfig{
		BaseURL: "https://auth.testing/auth/dev-environments/billing-proxy", Capability: "lvdt1.123.token",
	}, roundTripFunc(func(request *http.Request) (*http.Response, error) {
		if got := request.URL.String(); got != "https://auth.testing/auth/dev-environments/billing-proxy/cloudapi/?Action=CreatePayUrl" {
			t.Fatalf("url=%q", got)
		}
		if request.Header.Get(personalDevCapabilityHeader) != "lvdt1.123.token" || request.Header.Get("Authorization") != "TC3-HMAC-SHA256 signed" {
			t.Fatalf("headers=%v", request.Header)
		}
		if got := request.Header.Get(headerXQCloudUserID); got != "" {
			t.Fatalf("personal proxy forwarded client-controlled route uin %q", got)
		}
		return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(`{}`)), Header: make(http.Header)}, nil
	}))
	if err != nil {
		t.Fatal(err)
	}
	request, _ := http.NewRequest(http.MethodPost, "https://billing.tencentcloudapi.com/?Action=CreatePayUrl", strings.NewReader(`{}`))
	request.Header.Set("Authorization", "TC3-HMAC-SHA256 signed")
	request.Header.Set(headerXQCloudUserID, "700000164995")
	if _, err := transport.RoundTrip(request); err != nil {
		t.Fatal(err)
	}
}
