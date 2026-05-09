// Package trade adapter 单元测试。
//
// 测试覆盖：
//   - PlaceOrder 成功路径（含 Bearer token 注入校验）
//   - GeneratePayURL 成功路径（含 dealName 路径拼接）
//   - 4xx 错误解码为 *Error（携带 Code / Message）
//   - 5xx 错误且无 JSON body 时降级为 HTTP500
//   - 空 BaseURL / 空 dealName 直接报错
//   - dealName 含特殊字符时正确转义
package trade

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func newTestAdapter(t *testing.T, baseURL, token string) Adapter {
	t.Helper()
	return NewTradeAdapter(&Config{
		BaseURL: baseURL,
		Token:   token,
		Timeout: 5,
	}, nil)
}

func TestPlaceOrder_Success(t *testing.T) {
	var (
		gotMethod string
		gotPath   string
		gotAuth   string
		gotCT     string
		gotReq    PlaceOrderRequest
	)

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod = r.Method
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		gotCT = r.Header.Get("Content-Type")
		if err := json.NewDecoder(r.Body).Decode(&gotReq); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(PlaceOrderResult{
			DealName:   "DEAL-2026-001",
			BigOrderID: "BIG-2026-001",
		})
	}))
	defer server.Close()

	adp := newTestAdapter(t, server.URL, "internal-token")

	result, err := adp.PlaceOrder(context.Background(), &PlaceOrderRequest{
		ExternalUserID: "usr_test",
		BundleID:       "bundle_basic_monthly",
		Period:         1,
		TimeUnit:       "m",
		GoodsNum:       1,
		PayMode:        1,
		RegionID:       47,
	})
	if err != nil {
		t.Fatalf("PlaceOrder: %v", err)
	}

	if gotMethod != http.MethodPost {
		t.Fatalf("expected POST, got %s", gotMethod)
	}
	if gotPath != "/internal/trade/orders" {
		t.Fatalf("unexpected path: %s", gotPath)
	}
	if gotAuth != "Bearer internal-token" {
		t.Fatalf("expected bearer header, got %q", gotAuth)
	}
	if gotCT != "application/json" {
		t.Fatalf("expected application/json content-type, got %q", gotCT)
	}
	if gotReq.ExternalUserID != "usr_test" || gotReq.BundleID != "bundle_basic_monthly" ||
		gotReq.Period != 1 || gotReq.TimeUnit != "m" || gotReq.RegionID != 47 {
		t.Fatalf("unexpected request body: %+v", gotReq)
	}
	if result == nil || result.DealName != "DEAL-2026-001" || result.BigOrderID != "BIG-2026-001" {
		t.Fatalf("unexpected result: %+v", result)
	}
}

func TestPlaceOrder_BaseURLMissing(t *testing.T) {
	adp := NewTradeAdapter(&Config{}, nil)
	_, err := adp.PlaceOrder(context.Background(), &PlaceOrderRequest{ExternalUserID: "x"})
	if err == nil || !strings.Contains(err.Error(), "base_url not configured") {
		t.Fatalf("expected base_url error, got %v", err)
	}
}

func TestPlaceOrder_NilRequest(t *testing.T) {
	adp := newTestAdapter(t, "http://example.invalid", "")
	_, err := adp.PlaceOrder(context.Background(), nil)
	if err == nil || !strings.Contains(err.Error(), "request is nil") {
		t.Fatalf("expected nil request error, got %v", err)
	}
}

func TestPlaceOrderAndPay_Success(t *testing.T) {
	var (
		gotMethod string
		gotPath   string
		gotAuth   string
		gotReq    PlaceOrderRequest
	)

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod = r.Method
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		if err := json.NewDecoder(r.Body).Decode(&gotReq); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		// 一体化接口下 PayURL/ExpireAt 永空
		_ = json.NewEncoder(w).Encode(PlaceOrderResult{
			DealName:   "DEAL-AP-001",
			BigOrderID: "BIG-AP-001",
		})
	}))
	defer server.Close()

	adp := newTestAdapter(t, server.URL, "internal-token")

	result, err := adp.PlaceOrderAndPay(context.Background(), &PlaceOrderRequest{
		ExternalUserID: "usr_test",
		BundleID:       "bundle_basic_monthly",
		Period:         1,
		TimeUnit:       "m",
		GoodsNum:       1,
		PayMode:        1,
		RegionID:       47,
	})
	if err != nil {
		t.Fatalf("PlaceOrderAndPay: %v", err)
	}

	if gotMethod != http.MethodPost {
		t.Fatalf("expected POST, got %s", gotMethod)
	}
	if gotPath != "/internal/trade/orders/place-and-pay" {
		t.Fatalf("unexpected path: %s", gotPath)
	}
	if gotAuth != "Bearer internal-token" {
		t.Fatalf("expected bearer header, got %q", gotAuth)
	}
	if gotReq.ExternalUserID != "usr_test" || gotReq.BundleID != "bundle_basic_monthly" {
		t.Fatalf("unexpected request body: %+v", gotReq)
	}
	if result == nil || result.DealName != "DEAL-AP-001" || result.BigOrderID != "BIG-AP-001" {
		t.Fatalf("unexpected result: %+v", result)
	}
	// 一体化接口下 PayURL/ExpireAt 应为空（trade 侧不返）
	if result.PayURL != "" || result.ExpireAt != "" {
		t.Fatalf("expected empty PayURL/ExpireAt, got %+v", result)
	}
}

func TestPlaceOrderAndPay_NilRequest(t *testing.T) {
	adp := newTestAdapter(t, "http://example.invalid", "")
	_, err := adp.PlaceOrderAndPay(context.Background(), nil)
	if err == nil || !strings.Contains(err.Error(), "request is nil") {
		t.Fatalf("expected nil request error, got %v", err)
	}
}

func TestPlaceOrderAndPay_BaseURLMissing(t *testing.T) {
	adp := NewTradeAdapter(&Config{}, nil)
	_, err := adp.PlaceOrderAndPay(context.Background(), &PlaceOrderRequest{ExternalUserID: "x"})
	if err == nil || !strings.Contains(err.Error(), "base_url not configured") {
		t.Fatalf("expected base_url error, got %v", err)
	}
}

func TestPlaceOrderAndPay_BusinessError_DecodedAsTradeError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadGateway)
		_ = json.NewEncoder(w).Encode(errorResponse{
			Code:    "JifeiResponseInvalid",
			Message: "deal name missing",
		})
	}))
	defer server.Close()

	adp := newTestAdapter(t, server.URL, "tok")

	_, err := adp.PlaceOrderAndPay(context.Background(), &PlaceOrderRequest{ExternalUserID: "usr_test"})
	var tradeErr *Error
	if !errors.As(err, &tradeErr) {
		t.Fatalf("expected *trade.Error, got %T: %v", err, err)
	}
	if tradeErr.Status != http.StatusBadGateway || tradeErr.Code != "JifeiResponseInvalid" {
		t.Fatalf("unexpected error: %+v", tradeErr)
	}
	if !strings.Contains(tradeErr.Endpoint, "/internal/trade/orders/place-and-pay") {
		t.Fatalf("expected endpoint /internal/trade/orders/place-and-pay, got %q", tradeErr.Endpoint)
	}
}

func TestPlaceOrder_BusinessError_DecodedAsTradeError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusNotFound)
		_ = json.NewEncoder(w).Encode(errorResponse{
			Code:    "BundleNotFound",
			Message: "bundle bundle_x not found",
		})
	}))
	defer server.Close()

	adp := newTestAdapter(t, server.URL, "tok")

	_, err := adp.PlaceOrder(context.Background(), &PlaceOrderRequest{
		ExternalUserID: "usr_test",
		BundleID:       "bundle_x",
	})
	if err == nil {
		t.Fatalf("expected error, got nil")
	}

	var tradeErr *Error
	if !errors.As(err, &tradeErr) {
		t.Fatalf("expected *trade.Error, got %T: %v", err, err)
	}
	if tradeErr.Status != http.StatusNotFound {
		t.Fatalf("expected status 404, got %d", tradeErr.Status)
	}
	if tradeErr.Code != "BundleNotFound" {
		t.Fatalf("expected code BundleNotFound, got %q", tradeErr.Code)
	}
	if !strings.Contains(tradeErr.Message, "bundle_x") {
		t.Fatalf("expected message to contain bundle_x, got %q", tradeErr.Message)
	}
	if !strings.Contains(tradeErr.Endpoint, "/internal/trade/orders") {
		t.Fatalf("expected endpoint to contain /internal/trade/orders, got %q", tradeErr.Endpoint)
	}
	// Error() 应包含状态码与业务码，便于日志检索。
	if !strings.Contains(tradeErr.Error(), "404") || !strings.Contains(tradeErr.Error(), "BundleNotFound") {
		t.Fatalf("Error() output missing fields: %s", tradeErr.Error())
	}
}

func TestPlaceOrder_5xxFallbackToHTTPCode(t *testing.T) {
	// 5xx 且无 JSON body：Code 应回退为 HTTP500，Message 用 raw body trim。
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = io.WriteString(w, "  internal boom  ")
	}))
	defer server.Close()

	adp := newTestAdapter(t, server.URL, "tok")

	_, err := adp.PlaceOrder(context.Background(), &PlaceOrderRequest{ExternalUserID: "usr_test"})
	var tradeErr *Error
	if !errors.As(err, &tradeErr) {
		t.Fatalf("expected *trade.Error, got %T: %v", err, err)
	}
	if tradeErr.Status != http.StatusInternalServerError {
		t.Fatalf("expected 500, got %d", tradeErr.Status)
	}
	if tradeErr.Code != "HTTP500" {
		t.Fatalf("expected code HTTP500, got %q", tradeErr.Code)
	}
	if tradeErr.Message != "internal boom" {
		t.Fatalf("expected trimmed raw body, got %q", tradeErr.Message)
	}
}

func TestGeneratePayURL_Success(t *testing.T) {
	var (
		gotPath string
		gotAuth string
		gotCT   string
	)

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		gotCT = r.Header.Get("Content-Type")
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(PayURLResult{
			PayURL: "https://buy.cloud.tencent.com/lighthouse/mock?dealName=DEAL-2026-001&token=mock",
		})
	}))
	defer server.Close()

	adp := newTestAdapter(t, server.URL, "internal-token")

	result, err := adp.GeneratePayURL(context.Background(), "DEAL-2026-001")
	if err != nil {
		t.Fatalf("GeneratePayURL: %v", err)
	}
	if gotPath != "/internal/trade/orders/DEAL-2026-001/pay-url" {
		t.Fatalf("unexpected path: %s", gotPath)
	}
	if gotAuth != "Bearer internal-token" {
		t.Fatalf("expected bearer header, got %q", gotAuth)
	}
	// 无 body 调用时不应设 Content-Type（避免误导上游）。
	if gotCT != "" {
		t.Fatalf("expected empty content-type for no-body request, got %q", gotCT)
	}
	if result == nil || !strings.Contains(result.PayURL, "DEAL-2026-001") {
		t.Fatalf("unexpected result: %+v", result)
	}
}

func TestGeneratePayURL_DealNameRequired(t *testing.T) {
	adp := newTestAdapter(t, "http://example.invalid", "")
	for _, dealName := range []string{"", "   "} {
		_, err := adp.GeneratePayURL(context.Background(), dealName)
		if err == nil || !strings.Contains(err.Error(), "dealName is required") {
			t.Fatalf("expected dealName required error for %q, got %v", dealName, err)
		}
	}
}

func TestGeneratePayURL_BaseURLMissing(t *testing.T) {
	adp := NewTradeAdapter(&Config{}, nil)
	_, err := adp.GeneratePayURL(context.Background(), "DEAL-X")
	if err == nil || !strings.Contains(err.Error(), "base_url not configured") {
		t.Fatalf("expected base_url error, got %v", err)
	}
}

func TestGeneratePayURL_PathEscaped(t *testing.T) {
	// dealName 含 "/" 等特殊字符时必须 PathEscape，否则会被解析为多段路径。
	var gotRawPath string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// httptest 拿到的 r.URL.Path 已被解码；用 RawPath 校验转义结果。
		if r.URL.RawPath != "" {
			gotRawPath = r.URL.RawPath
		} else {
			gotRawPath = r.URL.Path
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(PayURLResult{PayURL: "https://x"})
	}))
	defer server.Close()

	adp := newTestAdapter(t, server.URL, "tok")

	_, err := adp.GeneratePayURL(context.Background(), "deal/with/slash")
	if err != nil {
		t.Fatalf("GeneratePayURL: %v", err)
	}
	if !strings.Contains(gotRawPath, "deal%2Fwith%2Fslash") {
		t.Fatalf("expected escaped path, got %q", gotRawPath)
	}
}

func TestGeneratePayURL_TokenOptional(t *testing.T) {
	// Token 为空时不应注入 Authorization header（避免发出 "Bearer " 这种坏值）。
	var gotAuth string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(PayURLResult{PayURL: "https://x"})
	}))
	defer server.Close()

	adp := newTestAdapter(t, server.URL, "")

	_, err := adp.GeneratePayURL(context.Background(), "DEAL-X")
	if err != nil {
		t.Fatalf("GeneratePayURL: %v", err)
	}
	if gotAuth != "" {
		t.Fatalf("expected no auth header when token empty, got %q", gotAuth)
	}
}

func TestErrorOnNilReceiver(t *testing.T) {
	// 健壮性：*Error 为 nil 时不应 panic。
	var e *Error
	if got := e.Error(); got != "" {
		t.Fatalf("expected empty string for nil receiver, got %q", got)
	}
}

// ============================================================================
// InquiryBatch（迭代 8C）
// ============================================================================

func TestInquiryBatch_Success(t *testing.T) {
	var (
		gotMethod string
		gotPath   string
		gotAuth   string
		gotCT     string
		gotReq    InquiryBatchRequest
	)

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod = r.Method
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		gotCT = r.Header.Get("Content-Type")
		if err := json.NewDecoder(r.Body).Decode(&gotReq); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(InquiryBatchResult{
			Prices: []*BundleQuote{
				{
					BundleID:      "bundle_basic_monthly",
					BundleName:    "基础版月卡",
					Price:         "9.90",
					TotalCost:     "9.90",
					RealTotalCost: "9.90",
					Currency:      "CNY",
					Discount:      1.0,
					TimeSpan:      1,
					TimeUnit:      "m",
					GoodsNum:      1,
				},
				{
					BundleID:      "bundle_pro_yearly",
					BundleName:    "专业版年卡",
					Price:         "999.00",
					TotalCost:     "999.00",
					RealTotalCost: "899.10",
					Currency:      "CNY",
					Discount:      0.9,
					TimeSpan:      1,
					TimeUnit:      "y",
					GoodsNum:      1,
				},
			},
		})
	}))
	defer server.Close()

	adp := newTestAdapter(t, server.URL, "internal-token")

	result, err := adp.InquiryBatch(context.Background(), &InquiryBatchRequest{
		ExternalUserID: "usr_test",
		BundleIDs:      []string{"bundle_basic_monthly", "bundle_pro_yearly"},
		Period:         1,
		TimeUnit:       "m",
		GoodsNum:       1,
		PayMode:        1,
		RegionID:       47,
	})
	if err != nil {
		t.Fatalf("InquiryBatch: %v", err)
	}

	if gotMethod != http.MethodPost {
		t.Fatalf("expected POST, got %s", gotMethod)
	}
	if gotPath != "/internal/trade/inquiry/batch" {
		t.Fatalf("unexpected path: %s", gotPath)
	}
	if gotAuth != "Bearer internal-token" {
		t.Fatalf("expected bearer header, got %q", gotAuth)
	}
	if gotCT != "application/json" {
		t.Fatalf("expected application/json content-type, got %q", gotCT)
	}
	if len(gotReq.BundleIDs) != 2 || gotReq.BundleIDs[0] != "bundle_basic_monthly" {
		t.Fatalf("unexpected request body: %+v", gotReq)
	}
	if gotReq.Period != 1 || gotReq.TimeUnit != "m" || gotReq.RegionID != 47 || gotReq.PayMode != 1 || gotReq.GoodsNum != 1 {
		t.Fatalf("unexpected request defaults: %+v", gotReq)
	}
	if result == nil || len(result.Prices) != 2 {
		t.Fatalf("unexpected result: %+v", result)
	}
	if result.Prices[0].BundleID != "bundle_basic_monthly" || result.Prices[0].RealTotalCost != "9.90" {
		t.Fatalf("unexpected first quote: %+v", result.Prices[0])
	}
	if result.Prices[1].Discount != 0.9 || result.Prices[1].Currency != "CNY" {
		t.Fatalf("unexpected second quote: %+v", result.Prices[1])
	}
}

func TestInquiryBatch_BaseURLMissing(t *testing.T) {
	adp := NewTradeAdapter(&Config{}, nil)
	_, err := adp.InquiryBatch(context.Background(), &InquiryBatchRequest{
		ExternalUserID: "x",
		BundleIDs:      []string{"b1"},
	})
	if err == nil || !strings.Contains(err.Error(), "base_url not configured") {
		t.Fatalf("expected base_url error, got %v", err)
	}
}

func TestInquiryBatch_NilRequest(t *testing.T) {
	adp := newTestAdapter(t, "http://example.invalid", "")
	_, err := adp.InquiryBatch(context.Background(), nil)
	if err == nil || !strings.Contains(err.Error(), "request is nil") {
		t.Fatalf("expected nil request error, got %v", err)
	}
}

func TestInquiryBatch_EmptyBundleIDs(t *testing.T) {
	adp := newTestAdapter(t, "http://example.invalid", "tok")
	_, err := adp.InquiryBatch(context.Background(), &InquiryBatchRequest{
		ExternalUserID: "usr",
		BundleIDs:      nil,
	})
	if err == nil || !strings.Contains(err.Error(), "bundleIds is required") {
		t.Fatalf("expected bundleIds required error, got %v", err)
	}
}

func TestInquiryBatch_BusinessError_DecodedAsTradeError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusNotFound)
		_ = json.NewEncoder(w).Encode(errorResponse{
			Code:    "BundleNotFound",
			Message: "bundle bundle_x not found",
		})
	}))
	defer server.Close()

	adp := newTestAdapter(t, server.URL, "tok")

	_, err := adp.InquiryBatch(context.Background(), &InquiryBatchRequest{
		ExternalUserID: "usr_test",
		BundleIDs:      []string{"bundle_x"},
		Period:         1,
		TimeUnit:       "m",
	})
	var tradeErr *Error
	if !errors.As(err, &tradeErr) {
		t.Fatalf("expected *trade.Error, got %T: %v", err, err)
	}
	if tradeErr.Status != http.StatusNotFound || tradeErr.Code != "BundleNotFound" {
		t.Fatalf("unexpected error: %+v", tradeErr)
	}
	if !strings.Contains(tradeErr.Endpoint, "/internal/trade/inquiry/batch") {
		t.Fatalf("expected endpoint /internal/trade/inquiry/batch, got %q", tradeErr.Endpoint)
	}
}

func TestInquiryBatch_TokenOptional(t *testing.T) {
	// Token 为空时不应注入 Authorization header（避免发出 "Bearer " 这种坏值）。
	var gotAuth string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(InquiryBatchResult{Prices: []*BundleQuote{}})
	}))
	defer server.Close()

	adp := newTestAdapter(t, server.URL, "")

	_, err := adp.InquiryBatch(context.Background(), &InquiryBatchRequest{
		ExternalUserID: "x",
		BundleIDs:      []string{"b1"},
	})
	if err != nil {
		t.Fatalf("InquiryBatch: %v", err)
	}
	if gotAuth != "" {
		t.Fatalf("expected no auth header when token empty, got %q", gotAuth)
	}
}
