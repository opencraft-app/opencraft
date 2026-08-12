package cloudbillingclient

import (
	"context"
	"reflect"
	"testing"
)

func TestCreatePayURLParamsUsesBillingCloudAPIFieldNames(t *testing.T) {
	req := &CreatePayURLRequest{
		OrderIDs:      []string{" 20260811207021864194801 ", ""},
		Platform:      "mobile",
		ContractOrder: 1,
		CancelURL:     "https://intl-sandbox-kr-1.preview.lightclaw.tech/subscribe/?pay=cancel",
		ReturnURL:     "https://intl-sandbox-kr-1.preview.lightclaw.tech/subscribe/?pay=return",
		PayScene:      "credit_card",
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
