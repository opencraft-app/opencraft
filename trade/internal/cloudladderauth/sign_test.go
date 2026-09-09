package cloudladderauth

import (
	"net/http"
	"net/url"
	"testing"
	"time"
)

func TestSignProxyURLHeaders(t *testing.T) {
	u, err := url.Parse("http://43.153.236.65/v1/proxy/jifei-prod/interfaces/interface.php")
	if err != nil {
		t.Fatal(err)
	}
	headers := make(http.Header)
	body := []byte(`{"billingParam":{"pointOfSale":"safe"}}`)
	now := time.Date(2026, 9, 8, 0, 59, 16, 0, time.UTC)

	err = SignProxyURLHeaders("secret", "lightvela-trade", headers, http.MethodPost, u, body, now)
	if err != nil {
		t.Fatalf("SignProxyURLHeaders() error = %v", err)
	}
	if got := headers.Get(HeaderCaller); got != "lightvela-trade" {
		t.Fatalf("%s = %q", HeaderCaller, got)
	}
	if got := headers.Get(HeaderTimestamp); got != "2026-09-08T00:59:16Z" {
		t.Fatalf("%s = %q", HeaderTimestamp, got)
	}
	const wantSignature = "sha256=4d5a87d3cc343b62b3027d04b00be2e8e8de7905273091dd8dadb6708201c756"
	if got := headers.Get(HeaderSignature); got != wantSignature {
		t.Fatalf("%s = %q, want %q", HeaderSignature, got, wantSignature)
	}
}

func TestSignProxyURLHeadersRejectsNonProxyURL(t *testing.T) {
	u, err := url.Parse("https://trade.tencentyun.com/interfaces/interface.php")
	if err != nil {
		t.Fatal(err)
	}

	err = SignProxyURLHeaders("secret", "lightvela-trade", make(http.Header), http.MethodPost, u, []byte(`{}`), time.Now())
	if err == nil {
		t.Fatal("SignProxyURLHeaders() error = nil, want non-proxy URL rejection")
	}
}

func TestSignProxyURLHeadersIncludesQueryAndBody(t *testing.T) {
	u, err := url.Parse("https://gateway.example/base/v1/proxy/route-a/path%2Fpart?Action=CreateOrders")
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 9, 8, 0, 0, 0, 0, time.UTC)

	first := make(http.Header)
	if err := SignProxyURLHeaders("secret", "trade", first, http.MethodPost, u, []byte(`{"a":1}`), now); err != nil {
		t.Fatal(err)
	}
	second := make(http.Header)
	if err := SignProxyURLHeaders("secret", "trade", second, http.MethodPost, u, []byte(`{"a":2}`), now); err != nil {
		t.Fatal(err)
	}
	if first.Get(HeaderSignature) == second.Get(HeaderSignature) {
		t.Fatal("signature did not change after body mutation")
	}

	withoutQuery := *u
	withoutQuery.RawQuery = ""
	third := make(http.Header)
	if err := SignProxyURLHeaders("secret", "trade", third, http.MethodPost, &withoutQuery, []byte(`{"a":1}`), now); err != nil {
		t.Fatal(err)
	}
	if first.Get(HeaderSignature) == third.Get(HeaderSignature) {
		t.Fatal("signature did not change after query mutation")
	}
}
