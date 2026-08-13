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

func TestCreatePayURLSignsWithTemporaryCredentials(t *testing.T) {
	var captured *http.Request
	client, err := NewTencentCloudClient(Config{
		Endpoint:      "billing.test.tencentcloudapi.com",
		XQCloudUserID: "800000294207",
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
	if resp.URL != "https://buy.cloud.tencent.com/v1/r/1450008583/qz_goods_info?token_id=E-1" {
		t.Fatalf("URL = %q", resp.URL)
	}
}

func TestCreatePayURLParamsUsesBillingCloudAPIFieldNames(t *testing.T) {
	req := &CreatePayURLRequest{
		OrderIDs:      []string{" 20260811207021864194801 ", ""},
		Platform:      "mobile",
		ContractOrder: 1,
		CancelURL:     "https://intl-sandbox-kr-1.preview.lightclaw.tech/subscribe/?pay=cancel",
		ReturnURL:     "https://intl-sandbox-kr-1.preview.lightclaw.tech/subscribe/?pay=return",
		PayScene:      "credit_card",
		PayOption:     "chargePay",
		Application:   "intlSaaSLightvela",
	}

	params, err := createPayURLParams(req)
	if err != nil {
		t.Fatalf("createPayURLParams: %v", err)
	}

	want := map[string]any{
		"OrderIds":      []string{"20260811207021864194801"},
		"Platform":      "mobile",
		"ContractOrder": 1,
		"CancelUrl":     "https://intl-sandbox-kr-1.preview.lightclaw.tech/subscribe/?pay=cancel",
		"ReturnUrl":     "https://intl-sandbox-kr-1.preview.lightclaw.tech/subscribe/?pay=return",
		"PayScene":      "credit_card",
		"PayOption":     "chargePay",
		"Application":   "intlSaaSLightvela",
	}
	if !reflect.DeepEqual(params, want) {
		t.Fatalf("params mismatch:\n got  %#v\n want %#v", params, want)
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
