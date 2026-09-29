package personaldevbilling

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

type transportFunc func(*http.Request) (*http.Response, error)

func (f transportFunc) RoundTrip(request *http.Request) (*http.Response, error) { return f(request) }

func TestProxyResignsJifeiAndRestoresCloudAPIAuthorization(t *testing.T) {
	var calls int
	proxy, err := New(Config{
		JifeiURL:                  "http://cloudladder.test/v1/proxy/jifei-billing-apigw-test/resource-center/interface",
		JifeiAppID:                "central-app",
		JifeiAppSecret:            "central-secret",
		JifeiXQCloudUserID:        "service-uin",
		JifeiCloudLadderSecret:    "jifei-cloud-secret",
		CloudAPIEndpoint:          "billing.test.tencentcloudapi.com",
		CloudAPIGatewayURL:        "http://cloudladder.test",
		CloudAPIRouteID:           "tcapi-billing-trade-intl-test",
		CloudAPICloudLadderSecret: "cloudapi-secret",
		CloudAPIXQCloudUserID:     "450860000002",
		Now:                       func() time.Time { return time.Unix(100, 0) },
		Nonce:                     func() string { return "central-nonce" },
		HTTPTransport: transportFunc(func(request *http.Request) (*http.Response, error) {
			calls++
			if calls == 1 {
				if request.Header.Get("X-CloudLadder-Signature") == "" || !strings.Contains(readBody(t, request), `"appid":"central-app"`) {
					t.Fatalf("jifei request headers=%v", request.Header)
				}
			} else {
				if request.URL.Path != "/v1/proxy/tcapi-billing-trade-intl-test/" || request.Header.Get("Authorization") != "TC3-HMAC-SHA256 signed" || request.Header.Get("X-Qcloud-User-Id") != "450860000002" {
					t.Fatalf("cloud request=%s headers=%v", request.URL.String(), request.Header)
				}
			}
			return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{}`))}, nil
		}),
	})
	if err != nil {
		t.Fatal(err)
	}
	jifeiBody := []byte(`{"interface":{"interfaceName":"qcloud.operation.ModifyResourceStatus","extraPara":{"ownerUin":"450860000023"},"para":{"uin":"450860000023"}}}`)
	if _, err := proxy.Forward(context.Background(), "jifei", "/resource-center/interface", "", "450860000023", nil, jifeiBody); err != nil {
		t.Fatal(err)
	}
	headers := make(http.Header)
	headers.Set("X-TC-Action", "CreatePayUrl")
	headers.Set(OriginalAuthorizationHeader, "TC3-HMAC-SHA256 signed")
	if _, err := proxy.Forward(context.Background(), "cloudapi", "/", "Action=CreatePayUrl", "450860000023", headers, []byte(`{}`)); err != nil {
		t.Fatal(err)
	}
	if calls != 2 {
		t.Fatalf("calls=%d", calls)
	}
}

func TestProxyRejectsCloudAPIQueryActionMismatch(t *testing.T) {
	transportCalls := 0
	proxy, err := New(Config{
		JifeiURL:                  "http://cloudladder.test/v1/proxy/jifei-billing-apigw-test/resource-center/interface",
		JifeiAppID:                "central-app",
		JifeiAppSecret:            "central-secret",
		JifeiCloudLadderSecret:    "jifei-cloud-secret",
		CloudAPIEndpoint:          "billing.test.tencentcloudapi.com",
		CloudAPIGatewayURL:        "http://cloudladder.test",
		CloudAPIRouteID:           "tcapi-billing-trade-intl-test",
		CloudAPICloudLadderSecret: "cloudapi-secret",
		CloudAPIXQCloudUserID:     "450860000002",
		HTTPTransport: transportFunc(func(*http.Request) (*http.Response, error) {
			transportCalls++
			return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{}`))}, nil
		}),
	})
	if err != nil {
		t.Fatal(err)
	}
	headers := make(http.Header)
	headers.Set("X-TC-Action", "CreatePayUrl")
	headers.Set(OriginalAuthorizationHeader, "TC3-HMAC-SHA256 signed")
	if _, err := proxy.Forward(context.Background(), "cloudapi", "/", "Action=OnlineRefund", "450860000023", headers, []byte(`{}`)); err == nil {
		t.Fatal("mismatched CloudAPI query action was accepted")
	}
	if transportCalls != 0 {
		t.Fatalf("transport calls=%d, want 0", transportCalls)
	}
}

func TestProxyRejectsCloudAPIWithoutCapabilityDerivedUIN(t *testing.T) {
	transportCalls := 0
	proxy, err := New(Config{
		JifeiURL:                  "http://cloudladder.test/v1/proxy/jifei-billing-apigw-test/resource-center/interface",
		JifeiAppID:                "central-app",
		JifeiAppSecret:            "central-secret",
		CloudAPIEndpoint:          "billing.test.tencentcloudapi.com",
		CloudAPIGatewayURL:        "http://cloudladder.test",
		CloudAPIRouteID:           "tcapi-billing-trade-intl-test",
		CloudAPICloudLadderSecret: "cloudapi-secret",
		CloudAPIXQCloudUserID:     "450860000002",
		HTTPTransport: transportFunc(func(*http.Request) (*http.Response, error) {
			transportCalls++
			return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{}`))}, nil
		}),
	})
	if err != nil {
		t.Fatal(err)
	}
	headers := make(http.Header)
	headers.Set("X-TC-Action", "CreatePayUrl")
	headers.Set(OriginalAuthorizationHeader, "TC3-HMAC-SHA256 signed")
	if _, err := proxy.Forward(context.Background(), "cloudapi", "/", "Action=CreatePayUrl", "", headers, []byte(`{}`)); err == nil {
		t.Fatal("missing capability-derived UIN was accepted")
	}
	if transportCalls != 0 {
		t.Fatalf("transport calls=%d, want 0", transportCalls)
	}
}

func TestProxyAllowsJifeiWithoutCloudLadderHMAC(t *testing.T) {
	transportCalls := 0
	proxy, err := New(Config{
		JifeiURL:       "http://cloudladder.test/v1/proxy/jifei-billing-apigw-test/resource-center/interface",
		JifeiAppID:     "central-app",
		JifeiAppSecret: "central-secret",
		Now:            func() time.Time { return time.Unix(100, 0) },
		Nonce:          func() string { return "central-nonce" },
		HTTPTransport: transportFunc(func(request *http.Request) (*http.Response, error) {
			transportCalls++
			if request.Header.Get("X-CloudLadder-Signature") != "" {
				t.Fatalf("unexpected CloudLadder signature headers=%v", request.Header)
			}
			if !strings.Contains(readBody(t, request), `"appid":"central-app"`) {
				t.Fatal("central Jifei app signature is missing")
			}
			return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{}`))}, nil
		}),
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	body := []byte(`{"interface":{"interfaceName":"qcloud.operation.ModifyResourceStatus","extraPara":{"ownerUin":"450860000023"},"para":{"uin":"450860000023"}}}`)
	if _, err := proxy.Forward(context.Background(), "jifei", "/resource-center/interface", "", "450860000023", nil, body); err != nil {
		t.Fatalf("Forward: %v", err)
	}
	if transportCalls != 1 {
		t.Fatalf("transport calls=%d", transportCalls)
	}
}

func readBody(t *testing.T, request *http.Request) string {
	t.Helper()
	body, err := io.ReadAll(request.Body)
	if err != nil {
		t.Fatal(err)
	}
	return string(body)
}
