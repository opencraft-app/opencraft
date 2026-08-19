package cloudbillingclient

import (
	"context"
	"io"
	"net/http"
	"reflect"
	"strings"
	"testing"
)

type roundTripperFunc func(*http.Request) (*http.Response, error)

func (f roundTripperFunc) RoundTrip(req *http.Request) (*http.Response, error) {
	return f(req)
}

func testCloudLadderConfig() CloudLadderConfig {
	return CloudLadderConfig{
		GatewayBaseURL: "http://cloudladdergateway.test",
		RouteID:        "tcapi-billing-trade-intl-test",
		Secret:         "cloudladder-hmac-secret",
	}
}

func TestNewTencentCloudClientRequiresCloudLadderRouting(t *testing.T) {
	_, err := NewTencentCloudClient(Config{})
	if err == nil {
		t.Fatal("NewTencentCloudClient() error = nil, want missing CloudLadder routing error")
	}
}

func TestCreatePayURLSignsWithTemporaryCredentials(t *testing.T) {
	var captured *http.Request
	client, err := NewTencentCloudClient(Config{
		Endpoint:      "billing.test.tencentcloudapi.com",
		XQCloudUserID: "800000294207",
		CloudLadder:   testCloudLadderConfig(),
		HTTPTransport: roundTripperFunc(func(req *http.Request) (*http.Response, error) {
			captured = req.Clone(req.Context())
			return &http.Response{
				StatusCode: http.StatusOK,
				Header:     http.Header{"Content-Type": []string{"application/json"}},
				Body:       io.NopCloser(strings.NewReader(`{"Response":{"Url":"/v1/r/1450008583/qz_goods_info?token_id=E-1","RequestId":"req-1"}}`)),
				Request:    req,
			}, nil
		}),
	})
	if err != nil {
		t.Fatalf("NewTencentCloudClient: %v", err)
	}
	resp, err := client.CreatePayURL(context.Background(), TemporaryCredentials{
		SecretID:  "tmp-secret-id",
		SecretKey: "tmp-secret-key",
		Token:     "tmp-session-token",
	}, &CreatePayURLRequest{OrderIDs: []string{"deal-1"}})
	if err != nil {
		t.Fatalf("CreatePayURL: %v", err)
	}
	if captured == nil {
		t.Fatal("expected transport to capture request")
	}
	if auth := captured.Header.Get("Authorization"); !strings.Contains(auth, "Credential=tmp-secret-id/") {
		t.Fatalf("Authorization = %q, want temporary secret id", auth)
	}
	if token := captured.Header["X-TC-Token"]; len(token) != 1 || token[0] != "tmp-session-token" {
		t.Fatalf("X-TC-Token = %v", token)
	}
	if got := captured.Header.Get(headerXQCloudUserID); got != "800000294207" {
		t.Fatalf("%s = %q", headerXQCloudUserID, got)
	}
	if got := captured.Header.Get(headerCloudLadderCaller); got != cloudLadderCaller {
		t.Fatalf("%s = %q, want %q", headerCloudLadderCaller, got, cloudLadderCaller)
	}
	if resp.URL != "https://buy.cloud.tencent.com/v1/r/1450008583/qz_goods_info?token_id=E-1" {
		t.Fatalf("URL = %q", resp.URL)
	}
}

func TestCreatePayURLParamsUsesBillingCloudAPIFieldNames(t *testing.T) {
	req := &CreatePayURLRequest{
		OrderIDs:      []string{" 20260811207021864194801 ", ""},
		ChargeAmount:  650,
		Platform:      "mobile",
		ContractOrder: 1,
		CancelURL:     "https://intl-sandbox-kr-1.preview.lightclaw.tech/subscribe/?pay=cancel",
		ReturnURL:     "https://intl-sandbox-kr-1.preview.lightclaw.tech/subscribe/?pay=return",
		PayScene:      "credit_card",
		PayOption:     "chargePay",
		PayType:       "normal",
		Application:   "intlSaaSLightvela",
	}

	params, err := createPayURLParams(req)
	if err != nil {
		t.Fatalf("createPayURLParams: %v", err)
	}

	want := map[string]any{
		"OrderIds":      []string{"20260811207021864194801"},
		"ChargeAmount":  int64(650),
		"Platform":      "mobile",
		"ContractOrder": 1,
		"CancelUrl":     "https://intl-sandbox-kr-1.preview.lightclaw.tech/subscribe/?pay=cancel",
		"ReturnUrl":     "https://intl-sandbox-kr-1.preview.lightclaw.tech/subscribe/?pay=return",
		"PayScene":      "credit_card",
		"PayOption":     "chargePay",
		"PayType":       "normal",
		"Application":   "intlSaaSLightvela",
	}
	if !reflect.DeepEqual(params, want) {
		t.Fatalf("params mismatch:\n got  %#v\n want %#v", params, want)
	}
}

func TestDescribeOrderListParamsUsesBillingCloudAPIFieldNames(t *testing.T) {
	params, err := describeOrderListParams(&DescribeOrderListRequest{
		OrderIDs: []string{" 20260813002021864858631 ", ""},
		Limit:    1,
		Offset:   0,
		PayMode:  "prePay",
	})
	if err != nil {
		t.Fatalf("describeOrderListParams: %v", err)
	}

	want := map[string]any{
		"OrderIds": []string{"20260813002021864858631"},
		"Limit":    int64(1),
		"Offset":   int64(0),
		"PayMode":  "prePay",
	}
	if !reflect.DeepEqual(params, want) {
		t.Fatalf("params mismatch:\n got  %#v\n want %#v", params, want)
	}
}

func TestDescribeOrderListDecodesNestedOrderInfos(t *testing.T) {
	client, err := NewTencentCloudClient(Config{
		Endpoint:      "billing.test.tencentcloudapi.com",
		XQCloudUserID: "800000294207",
		CloudLadder:   testCloudLadderConfig(),
		HTTPTransport: roundTripperFunc(func(req *http.Request) (*http.Response, error) {
			if got := req.URL.Host; got != "cloudladdergateway.test" {
				t.Fatalf("host = %q", got)
			}
			if got := req.Header.Get(headerCloudLadderSignedHost); got != "billing.test.tencentcloudapi.com" {
				t.Fatalf("signed host = %q", got)
			}
			if got := req.Header["X-TC-Action"]; len(got) != 1 || got[0] != "DescribeOrderList" {
				t.Fatalf("X-TC-Action = %v", got)
			}
			if auth := req.Header.Get("Authorization"); !strings.Contains(auth, "Credential=tmp-secret-id/") {
				t.Fatalf("Authorization = %q, want temporary secret id", auth)
			}
			if token := req.Header["X-TC-Token"]; len(token) != 1 || token[0] != "tmp-session-token" {
				t.Fatalf("X-TC-Token = %v", token)
			}
			if got := req.Header.Get(headerXQCloudUserID); got != "800000294207" {
				t.Fatalf("%s = %q", headerXQCloudUserID, got)
			}
			return &http.Response{
				StatusCode: http.StatusOK,
				Header:     http.Header{"Content-Type": []string{"application/json"}},
				Body:       io.NopCloser(strings.NewReader(`{"Response":{"TotalCount":"1","Data":[{"BigOrderId":"20260813002021864858621","OrderInfos":[{"OrderId":"20260813002021864858631","RealTotalCost":"","PriceDetail":"{\"realTotalCost\":650000000,\"highPrecisionPrice\":{\"realTotalCostHigh\":\"650000001\"}}"}]}],"RequestId":"req-order-1"}}`)),
				Request:    req,
			}, nil
		}),
	})
	if err != nil {
		t.Fatalf("NewTencentCloudClient: %v", err)
	}

	resp, err := client.DescribeOrderList(context.Background(), TemporaryCredentials{
		SecretID: "tmp-secret-id", SecretKey: "tmp-secret-key", Token: "tmp-session-token",
	}, &DescribeOrderListRequest{
		OrderIDs: []string{"20260813002021864858631"}, Limit: 1, PayMode: "prePay",
	})
	if err != nil {
		t.Fatalf("DescribeOrderList: %v", err)
	}
	if resp.RequestID != "req-order-1" || len(resp.Orders) != 1 {
		t.Fatalf("response = %+v", resp)
	}
	if got := resp.Orders[0]; got.OrderID != "20260813002021864858631" ||
		got.PriceDetailHighPrecisionRealTotalCost != "650000001" {
		t.Fatalf("order = %+v", got)
	}
}

func TestDecodeOrderPriceDetailOnlyUsesFallbackWhenHighPrecisionIsEmpty(t *testing.T) {
	tests := []struct {
		name     string
		raw      string
		wantHigh string
		wantReal string
	}{
		{
			name:     "ignore malformed fallback when high precision exists",
			raw:      `{"realTotalCost":{},"highPrecisionPrice":{"realTotalCostHigh":"650000001"}}`,
			wantHigh: "650000001",
		},
		{
			name:     "use numeric fallback when high precision is empty",
			raw:      `{"realTotalCost":650000000,"highPrecisionPrice":{"realTotalCostHigh":""}}`,
			wantReal: "650000000",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			gotHigh, gotReal, err := decodeOrderPriceDetail(tt.raw)
			if err != nil {
				t.Fatalf("decodeOrderPriceDetail: %v", err)
			}
			if gotHigh != tt.wantHigh || gotReal != tt.wantReal {
				t.Fatalf("amounts = (%q, %q), want (%q, %q)", gotHigh, gotReal, tt.wantHigh, tt.wantReal)
			}
		})
	}
}

func TestNewCreatePayURLCommonRequestRejectsMissingOrderIDs(t *testing.T) {
	_, err := NewCreatePayURLCommonRequest(context.Background(), &CreatePayURLRequest{})
	if err == nil {
		t.Fatal("expected missing OrderIds error")
	}
}

func TestNewCreatePayURLCommonRequestAddsXQCloudUserIDHeader(t *testing.T) {
	req, err := newCreatePayURLCommonRequest(
		context.Background(),
		&CreatePayURLRequest{OrderIDs: []string{"20260812207021864512621"}},
		" 800000294207 ",
	)
	if err != nil {
		t.Fatalf("newCreatePayURLCommonRequest: %v", err)
	}

	if got := req.GetHeader()[headerXQCloudUserID]; got != "800000294207" {
		t.Fatalf("%s = %q, want %q", headerXQCloudUserID, got, "800000294207")
	}
}

func TestNewCreatePayURLCommonRequestOmitsEmptyXQCloudUserIDHeader(t *testing.T) {
	req, err := newCreatePayURLCommonRequest(
		context.Background(),
		&CreatePayURLRequest{OrderIDs: []string{"20260812207021864512621"}},
		" ",
	)
	if err != nil {
		t.Fatalf("newCreatePayURLCommonRequest: %v", err)
	}

	if got := req.GetHeader()[headerXQCloudUserID]; got != "" {
		t.Fatalf("%s = %q, want empty", headerXQCloudUserID, got)
	}
}

func TestNormalizePayURLPrefixesBillingRelativeURL(t *testing.T) {
	got := normalizePayURL(" /v1/r/1450008583/qz_goods_info?token_id=E-1 ")
	want := "https://buy.cloud.tencent.com/v1/r/1450008583/qz_goods_info?token_id=E-1"
	if got != want {
		t.Fatalf("normalizePayURL = %q, want %q", got, want)
	}

	absolute := "https://buy.cloud.tencent.com/v1/r/1450008583/qz_goods_info"
	if got := normalizePayURL(absolute); got != absolute {
		t.Fatalf("absolute normalizePayURL = %q, want %q", got, absolute)
	}
}
