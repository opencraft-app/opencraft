package tradeclient

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"git.woa.com/wisp/mono/credit/internal/store"
	"git.woa.com/wisp/mono/credit/internal/usage"
)

func TestReportUsage(t *testing.T) {
	var got usage.ReportRequest
	client := NewClient("http://trade.local", "token")
	client.client.Transport = roundTripper(func(r *http.Request) (*http.Response, error) {
		if r.URL.Path != "/internal/trade/credit/resources/usage/report" || r.Header.Get("Authorization") != "Bearer token" {
			t.Fatalf("unexpected request: %s auth=%q", r.URL.Path, r.Header.Get("Authorization"))
		}
		if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
			t.Fatal(err)
		}
		return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(`{"retCode":0}`)), Header: make(http.Header)}, nil
	})
	_, err := client.ReportUsage(context.Background(), usage.ReportRequest{
		PackageID: "cpkg-1", PackageExpiredTime: time.Date(2026, 10, 3, 0, 0, 0, 0, time.UTC), CreditUsedDay: store.CreditAmount(12500),
	})
	if err != nil {
		t.Fatalf("ReportUsage: %v", err)
	}
	if got.PackageID != "cpkg-1" || got.CreditUsedDay != store.CreditAmount(12500) {
		t.Fatalf("unexpected request: %+v", got)
	}
}

func TestPlaceOrderDecodesTypedResult(t *testing.T) {
	client := NewClient("http://trade.local", "token")
	client.client.Transport = roundTripper(func(r *http.Request) (*http.Response, error) {
		if r.Method != http.MethodPost || r.URL.Path != "/internal/trade/credit/orders" {
			t.Fatalf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		var body OrderRequest
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if body.ExternalUserID != "usr-owner" || body.ProductID != "credit_1000" {
			t.Fatalf("request = %+v", body)
		}
		return &http.Response{
			StatusCode: http.StatusOK,
			Body:       io.NopCloser(strings.NewReader(`{"bigOrderId":"big-1","dealName":"deal-1"}`)),
			Header:     make(http.Header),
		}, nil
	})

	result, err := client.PlaceOrder(context.Background(), OrderRequest{
		ExternalUserID: "usr-owner",
		ProductID:      "credit_1000",
		TimeSpan:       1,
		TimeUnit:       "m",
	})
	if err != nil {
		t.Fatalf("PlaceOrder(): %v", err)
	}
	if result.BigOrderID != "big-1" || result.DealName != "deal-1" {
		t.Fatalf("result = %+v", result)
	}
}

func TestGeneratePayURLBindsCreditOrderToAuthenticatedUser(t *testing.T) {
	client := NewClient("http://trade.local", "token")
	client.client.Transport = roundTripper(func(r *http.Request) (*http.Response, error) {
		if r.Method != http.MethodPost || r.URL.Path != "/internal/trade/orders/deal-credit-1/pay-url" {
			t.Fatalf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		if r.Header.Get("Authorization") != "Bearer token" {
			t.Fatalf("authorization=%q", r.Header.Get("Authorization"))
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if body["external_user_id"] != "usr_owner" || body["expected_resource_type"] != "credit_package" {
			t.Fatalf("checkout binding=%+v", body)
		}
		if body["platform"] != "pc" || body["return_url"] != "https://lightvela.com/credit?paid=1" {
			t.Fatalf("payment options=%+v", body)
		}
		if body["wx_open_id"] != "openid-1" || body["wx_app_id"] != "wechat-app-1" {
			t.Fatalf("wechat options=%+v", body)
		}
		return &http.Response{
			StatusCode: http.StatusOK,
			Body: io.NopCloser(strings.NewReader(`{
				"payUrl":"https://buy.cloud.tencent.com/credit",
				"tokenId":"token-1",
				"orderId":"midas-1",
				"midasAppId":"app-1",
				"needCharge":1,
				"uin":"700000164995",
				"appId":"251202221"
			}`)),
			Header: make(http.Header),
		}, nil
	})

	result, err := client.GeneratePayURL(context.Background(), "deal-credit-1", PayURLRequest{
		ExternalUserID: "usr_owner",
		Platform:       "pc",
		WxOpenID:       "openid-1",
		WxAppID:        "wechat-app-1",
		ReturnURL:      "https://lightvela.com/credit?paid=1",
	})
	if err != nil {
		t.Fatalf("GeneratePayURL: %v", err)
	}
	if result.PayURL != "https://buy.cloud.tencent.com/credit" || result.NeedCharge != 1 {
		t.Fatalf("result=%+v", result)
	}
	if result.TokenID == nil || *result.TokenID != "token-1" {
		t.Fatalf("token_id=%v", result.TokenID)
	}
}

func TestGeneratePayURLPreservesTradeError(t *testing.T) {
	client := NewClient("http://trade.local", "token")
	client.client.Transport = roundTripper(func(*http.Request) (*http.Response, error) {
		return &http.Response{
			StatusCode: http.StatusNotFound,
			Body:       io.NopCloser(strings.NewReader(`{"code":"OrderNotFound","message":"order not found"}`)),
			Header:     make(http.Header),
		}, nil
	})

	_, err := client.GeneratePayURL(context.Background(), "missing", PayURLRequest{ExternalUserID: "usr_owner"})
	var tradeErr *Error
	if !errors.As(err, &tradeErr) {
		t.Fatalf("error=%v, want *Error", err)
	}
	if tradeErr.Status != http.StatusNotFound || tradeErr.Code != "OrderNotFound" {
		t.Fatalf("trade error=%+v", tradeErr)
	}
}

type roundTripper func(*http.Request) (*http.Response, error)

func (f roundTripper) RoundTrip(req *http.Request) (*http.Response, error) {
	return f(req)
}
