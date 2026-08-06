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
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Fatalf("read request body: %v", err)
		}
		if !strings.Contains(string(body), `"auto_renew_flag":"auto_renew"`) {
			t.Fatalf("request body missing auto_renew_flag=auto_renew: %s", string(body))
		}
		if err := json.Unmarshal(body, &gotReq); err != nil {
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

	// Q41 修订 2026-05-11：region/zone 完全收敛到 trade 内部，ctl 端入参不再透传
	result, err := adp.PlaceOrder(context.Background(), &PlaceOrderRequest{
		ExternalUserID: "usr_test",
		BundleID:       "bundle_basic_monthly",
		Period:         1,
		TimeUnit:       "m",
		GoodsNum:       1,
		PayMode:        1,
		AutoRenewFlag:  "auto_renew",
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
		gotReq.Period != 1 || gotReq.TimeUnit != "m" {
		t.Fatalf("unexpected request body: %+v", gotReq)
	}
	if gotReq.AutoRenewFlag != "auto_renew" {
		t.Fatalf("expected auto_renew_flag to be forwarded, got %+v", gotReq)
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

func TestListDianshiRecords_AllowsEmptyFilter(t *testing.T) {
	var (
		gotMethod   string
		gotPath     string
		gotRawQuery string
	)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod = r.Method
		gotPath = r.URL.Path
		gotRawQuery = r.URL.RawQuery
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"orders":[],"participations":[]}`)
	}))
	defer server.Close()

	adp := newTestAdapter(t, server.URL, "internal-token")
	result, err := adp.ListDianshiRecords(context.Background(), DianshiRecordFilter{})
	if err != nil {
		t.Fatalf("ListDianshiRecords empty filter: %v", err)
	}
	if gotMethod != http.MethodGet {
		t.Fatalf("expected GET, got %s", gotMethod)
	}
	if gotPath != "/internal/trade/dianshi/orders" {
		t.Fatalf("unexpected path: %s", gotPath)
	}
	if gotRawQuery != "" {
		t.Fatalf("expected empty query, got %q", gotRawQuery)
	}
	if result == nil || len(result.Orders) != 0 || len(result.Participations) != 0 {
		t.Fatalf("unexpected result: %+v", result)
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

	// Q41 修订 2026-05-11：region/zone 完全收敛到 trade 内部，ctl 端入参不再透传
	result, err := adp.PlaceOrderAndPay(context.Background(), &PlaceOrderRequest{
		ExternalUserID: "usr_test",
		BundleID:       "bundle_basic_monthly",
		Period:         1,
		TimeUnit:       "m",
		GoodsNum:       1,
		PayMode:        1,
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

	result, err := adp.GeneratePayURL(context.Background(), "DEAL-2026-001", nil)
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
		_, err := adp.GeneratePayURL(context.Background(), dealName, nil)
		if err == nil || !strings.Contains(err.Error(), "dealName is required") {
			t.Fatalf("expected dealName required error for %q, got %v", dealName, err)
		}
	}
}

func TestGeneratePayURL_BaseURLMissing(t *testing.T) {
	adp := NewTradeAdapter(&Config{}, nil)
	_, err := adp.GeneratePayURL(context.Background(), "DEAL-X", nil)
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

	_, err := adp.GeneratePayURL(context.Background(), "deal/with/slash", nil)
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

	_, err := adp.GeneratePayURL(context.Background(), "DEAL-X", nil)
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
					Price:         "9.90",
					TotalCost:     "9.90",
					RealTotalCost: "9.90",
					Currency:      "CNY",
					Discount:      1.0,
				},
				{
					BundleID:      "bundle_pro_yearly",
					Price:         "999.00",
					TotalCost:     "999.00",
					RealTotalCost: "899.10",
					Currency:      "CNY",
					Discount:      0.9,
				},
			},
		})
	}))
	defer server.Close()

	adp := newTestAdapter(t, server.URL, "internal-token")

	// Q41 修订 2026-05-11：region/zone 完全收敛到 trade 内部，ctl 端入参不再透传
	result, err := adp.InquiryBatch(context.Background(), &InquiryBatchRequest{
		ExternalUserID: "usr_test",
		BundleIDs:      []string{"bundle_basic_monthly", "bundle_pro_yearly"},
		Period:         1,
		TimeUnit:       "m",
		GoodsNum:       1,
		PayMode:        1,
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
	if gotReq.Period != 1 || gotReq.TimeUnit != "m" || gotReq.PayMode != 1 || gotReq.GoodsNum != 1 {
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

// === CompleteFlow 测试：trade-pass-isolate §10 Q22-I-E 端到端闭环 ===

func TestCompleteFlow_Success(t *testing.T) {
	var (
		gotMethod string
		gotPath   string
		gotAuth   string
		gotCT     string
		gotReq    CompleteFlowRequest
	)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod = r.Method
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		gotCT = r.Header.Get("Content-Type")
		if err := json.NewDecoder(r.Body).Decode(&gotReq); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		w.WriteHeader(http.StatusOK)
		// trade 侧返回空 body，adapter 应该容忍
	}))
	defer server.Close()

	adp := newTestAdapter(t, server.URL, "internal-token")

	if err := adp.CompleteFlow(context.Background(), 4242, "completed", ""); err != nil {
		t.Fatalf("CompleteFlow: %v", err)
	}

	if gotMethod != http.MethodPost {
		t.Fatalf("expected POST, got %s", gotMethod)
	}
	if gotPath != "/internal/trade/flows/4242/complete" {
		t.Fatalf("unexpected path: %s", gotPath)
	}
	if gotAuth != "Bearer internal-token" {
		t.Fatalf("expected bearer header, got %q", gotAuth)
	}
	if gotCT != "application/json" {
		t.Fatalf("expected json content-type, got %q", gotCT)
	}
	if gotReq.Result != "completed" {
		t.Fatalf("expected result=completed, got %q", gotReq.Result)
	}
	if gotReq.Message != "" {
		t.Fatalf("expected empty message, got %q", gotReq.Message)
	}
}

func TestCompleteFlow_FailedWithMessage(t *testing.T) {
	var gotReq CompleteFlowRequest
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&gotReq)
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	adp := newTestAdapter(t, server.URL, "tok")
	if err := adp.CompleteFlow(context.Background(), 99, "failed", "child task timeout"); err != nil {
		t.Fatalf("CompleteFlow: %v", err)
	}
	if gotReq.Result != "failed" || gotReq.Message != "child task timeout" {
		t.Fatalf("unexpected req: %+v", gotReq)
	}
}

func TestCompleteFlow_RejectsInvalidArgs(t *testing.T) {
	adp := newTestAdapter(t, "http://unused", "tok")

	// flowID == 0 直接报错（不发请求）
	if err := adp.CompleteFlow(context.Background(), 0, "completed", ""); err == nil {
		t.Fatal("expected error for flowID=0")
	}
	// 负数同样拦截
	if err := adp.CompleteFlow(context.Background(), -1, "completed", ""); err == nil {
		t.Fatal("expected error for flowID<0")
	}
	// 空 result 报错
	if err := adp.CompleteFlow(context.Background(), 1, "  ", ""); err == nil {
		t.Fatal("expected error for empty result")
	}
}

func TestCompleteFlow_BaseURLNotConfigured(t *testing.T) {
	adp := NewTradeAdapter(&Config{Token: "tok"}, nil)
	err := adp.CompleteFlow(context.Background(), 1, "completed", "")
	if err == nil || !strings.Contains(err.Error(), "base_url not configured") {
		t.Fatalf("expected base_url error, got %v", err)
	}
}

func TestCompleteFlow_TradeError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusNotFound)
		_ = json.NewEncoder(w).Encode(errorResponse{Code: "FlowNotFound", Message: "flow_id=999 not found"})
	}))
	defer server.Close()

	adp := newTestAdapter(t, server.URL, "tok")
	err := adp.CompleteFlow(context.Background(), 999, "completed", "")
	if err == nil {
		t.Fatal("expected error")
	}
	var tradeErr *Error
	if !errors.As(err, &tradeErr) {
		t.Fatalf("expected *trade.Error, got %T: %v", err, err)
	}
	if tradeErr.Status != http.StatusNotFound || tradeErr.Code != "FlowNotFound" {
		t.Fatalf("unexpected error: %+v", tradeErr)
	}
	if !strings.Contains(tradeErr.Endpoint, "/internal/trade/flows/999/complete") {
		t.Fatalf("unexpected endpoint: %q", tradeErr.Endpoint)
	}
}

// ============================================================================
// PlaceRenewOrder tests (R-D-5)
//
// 设计稿：.tmp/trade-pass-renew-design.md §3.3 / §4.4 / R-D-5
// ============================================================================

func TestPlaceRenewOrder_Success(t *testing.T) {
	var (
		gotMethod string
		gotPath   string
		gotAuth   string
		gotCT     string
		gotReq    PlaceRenewOrderRequest
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
			DealName:   "DEAL-RENEW-001",
			BigOrderID: "BIG-RENEW-001",
		})
	}))
	defer server.Close()

	adp := newTestAdapter(t, server.URL, "internal-token")
	result, err := adp.PlaceRenewOrder(context.Background(), &PlaceRenewOrderRequest{
		ExternalUserID: "usr_test",
		BundleID:       "bundle_basic_monthly",
		ResourceID:     "lhpass-r1",
		Period:         1,
		TimeUnit:       "m",
		GoodsNum:       1,
		PayMode:        1,
	})
	if err != nil {
		t.Fatalf("PlaceRenewOrder: %v", err)
	}

	if gotMethod != http.MethodPost {
		t.Fatalf("expected POST, got %s", gotMethod)
	}
	if gotPath != "/internal/trade/orders/renew" {
		t.Fatalf("unexpected path: %s", gotPath)
	}
	if gotAuth != "Bearer internal-token" {
		t.Fatalf("expected bearer header, got %q", gotAuth)
	}
	if gotCT != "application/json" {
		t.Fatalf("expected application/json content-type, got %q", gotCT)
	}
	// R-D-5 关键不变量：ResourceID 必须透传到 trade
	if gotReq.ExternalUserID != "usr_test" || gotReq.BundleID != "bundle_basic_monthly" ||
		gotReq.ResourceID != "lhpass-r1" || gotReq.Period != 1 || gotReq.TimeUnit != "m" {
		t.Fatalf("unexpected request body: %+v", gotReq)
	}
	if result.DealName != "DEAL-RENEW-001" || result.BigOrderID != "BIG-RENEW-001" {
		t.Fatalf("unexpected result: %+v", result)
	}
}

func TestPlaceRenewOrder_NilRequest(t *testing.T) {
	adp := newTestAdapter(t, "http://example.invalid", "")
	_, err := adp.PlaceRenewOrder(context.Background(), nil)
	if err == nil || !strings.Contains(err.Error(), "request is nil") {
		t.Fatalf("expected nil request error, got %v", err)
	}
}

func TestPlaceRenewOrder_BaseURLMissing(t *testing.T) {
	adp := NewTradeAdapter(&Config{}, nil)
	_, err := adp.PlaceRenewOrder(context.Background(), &PlaceRenewOrderRequest{ExternalUserID: "x"})
	if err == nil || !strings.Contains(err.Error(), "base_url not configured") {
		t.Fatalf("expected base_url error, got %v", err)
	}
}

func TestPlaceRenewOrder_4xxDecodedAsError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusConflict)
		_ = json.NewEncoder(w).Encode(map[string]string{
			"code":    "BundleOffline",
			"message": "bundle is offline",
		})
	}))
	defer server.Close()

	adp := newTestAdapter(t, server.URL, "tok")
	_, err := adp.PlaceRenewOrder(context.Background(), &PlaceRenewOrderRequest{
		ExternalUserID: "usr_test",
		BundleID:       "bundle_x",
		ResourceID:     "lhpass-r1",
	})
	var tradeErr *Error
	if !errors.As(err, &tradeErr) {
		t.Fatalf("expected *trade.Error, got %T: %v", err, err)
	}
	if tradeErr.Status != http.StatusConflict || tradeErr.Code != "BundleOffline" {
		t.Fatalf("unexpected error: %+v", tradeErr)
	}
}

// ============================================================================
// PlaceRenewOrderAndPay tests (R-D-7b)
//
// 设计稿：.tmp/trade-pass-renew-design.md §3.3 / §4.4 / R-D-7
// ============================================================================

func TestPlaceRenewOrderAndPay_Success(t *testing.T) {
	var (
		gotMethod string
		gotPath   string
		gotAuth   string
		gotReq    PlaceRenewOrderRequest
	)

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod = r.Method
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		if err := json.NewDecoder(r.Body).Decode(&gotReq); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(PlaceOrderResult{
			DealName:   "DEAL-RENEW-PAY-001",
			BigOrderID: "BIG-RENEW-PAY-001",
		})
	}))
	defer server.Close()

	adp := newTestAdapter(t, server.URL, "internal-token")
	result, err := adp.PlaceRenewOrderAndPay(context.Background(), &PlaceRenewOrderRequest{
		ExternalUserID: "usr_test",
		BundleID:       "bundle_basic_monthly",
		ResourceID:     "lhpass-r1",
		Period:         1,
		TimeUnit:       "m",
		GoodsNum:       1,
		PayMode:        1,
	})
	if err != nil {
		t.Fatalf("PlaceRenewOrderAndPay: %v", err)
	}

	if gotMethod != http.MethodPost {
		t.Fatalf("expected POST, got %s", gotMethod)
	}
	if gotPath != "/internal/trade/orders/renew/place-and-pay" {
		t.Fatalf("unexpected path: %s", gotPath)
	}
	if gotAuth != "Bearer internal-token" {
		t.Fatalf("expected bearer header, got %q", gotAuth)
	}
	// R-D-7b 关键不变量：ResourceID 必须透传到 trade（与 PlaceRenewOrder 一致）
	if gotReq.ResourceID != "lhpass-r1" {
		t.Fatalf("ResourceID mismatch: %+v", gotReq)
	}
	if result.DealName != "DEAL-RENEW-PAY-001" || result.BigOrderID != "BIG-RENEW-PAY-001" {
		t.Fatalf("unexpected result: %+v", result)
	}
}

func TestPlaceRenewOrderAndPay_NilRequest(t *testing.T) {
	adp := newTestAdapter(t, "http://example.invalid", "")
	_, err := adp.PlaceRenewOrderAndPay(context.Background(), nil)
	if err == nil || !strings.Contains(err.Error(), "request is nil") {
		t.Fatalf("expected nil request error, got %v", err)
	}
}

func TestPlaceRenewOrderAndPay_BaseURLMissing(t *testing.T) {
	adp := NewTradeAdapter(&Config{}, nil)
	_, err := adp.PlaceRenewOrderAndPay(context.Background(), &PlaceRenewOrderRequest{ExternalUserID: "x"})
	if err == nil || !strings.Contains(err.Error(), "base_url not configured") {
		t.Fatalf("expected base_url error, got %v", err)
	}
}

func TestPlaceRenewOrderAndPay_4xxDecodedAsError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		_ = json.NewEncoder(w).Encode(map[string]string{
			"code":    "InvalidRequest",
			"message": "resource_id is required for renew",
		})
	}))
	defer server.Close()

	adp := newTestAdapter(t, server.URL, "tok")
	_, err := adp.PlaceRenewOrderAndPay(context.Background(), &PlaceRenewOrderRequest{
		ExternalUserID: "usr_test",
		BundleID:       "bundle_x",
		// 缺 ResourceID
	})
	var tradeErr *Error
	if !errors.As(err, &tradeErr) {
		t.Fatalf("expected *trade.Error, got %T: %v", err, err)
	}
	if tradeErr.Status != http.StatusBadRequest || tradeErr.Code != "InvalidRequest" {
		t.Fatalf("unexpected error: %+v", tradeErr)
	}
}

// ============================================================================
// DeleteResource 测试（trade-pass-destroy §3.5 / §4.5.3 / §11-A Q1/Q2/Q26/Q27）
//
// 对应 ctl → trade 出向调用：POST /internal/trade/resources/{resourceID}/delete
// 入参 DTO 仅 3 字段（UIN/AppID/BundleID），SubProductCode 由 trade 反查（Q27）
// ============================================================================

func TestDeleteResource_Success(t *testing.T) {
	var (
		gotMethod string
		gotPath   string
		gotAuth   string
		gotCT     string
		gotReq    DeleteResourceRequest
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
		_ = json.NewEncoder(w).Encode(DeleteResourceResult{ReferenceID: "REF-DEL-001"})
	}))
	defer server.Close()

	adp := newTestAdapter(t, server.URL, "internal-token")
	result, err := adp.DeleteResource(context.Background(), "lhpass-d1", &DeleteResourceRequest{
		UIN:      "1234567890",
		AppID:    251000001,
		BundleID: "bundle_basic_monthly",
	})
	if err != nil {
		t.Fatalf("DeleteResource: %v", err)
	}

	if gotMethod != http.MethodPost {
		t.Fatalf("expected POST, got %s", gotMethod)
	}
	if gotPath != "/internal/trade/resources/lhpass-d1/delete" {
		t.Fatalf("unexpected path: %s", gotPath)
	}
	if gotAuth != "Bearer internal-token" {
		t.Fatalf("expected bearer header, got %q", gotAuth)
	}
	if gotCT != "application/json" {
		t.Fatalf("expected application/json content-type, got %q", gotCT)
	}
	// Q27 关键不变量：DTO 仅 3 字段，不包含 SubProductCode
	if gotReq.UIN != "1234567890" || gotReq.AppID != 251000001 || gotReq.BundleID != "bundle_basic_monthly" {
		t.Fatalf("unexpected request body: %+v", gotReq)
	}
	if result == nil || result.ReferenceID != "REF-DEL-001" {
		t.Fatalf("unexpected result: %+v", result)
	}
}

func TestDeleteResource_ResourceIDPathEscaped(t *testing.T) {
	// resourceID 含 "/" 等特殊字符时必须 PathEscape，与 GeneratePayURL 同范式
	var gotRawPath string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotRawPath = r.URL.EscapedPath()
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(DeleteResourceResult{ReferenceID: "OK"})
	}))
	defer server.Close()
	adp := newTestAdapter(t, server.URL, "tok")
	_, err := adp.DeleteResource(context.Background(), "lh/pass d1", &DeleteResourceRequest{
		UIN: "1", AppID: 1, BundleID: "b",
	})
	if err != nil {
		t.Fatalf("DeleteResource: %v", err)
	}
	if !strings.Contains(gotRawPath, "lh%2Fpass%20d1") {
		t.Fatalf("expected path-escaped resourceID in %q", gotRawPath)
	}
}

func TestDeleteResource_BaseURLMissing(t *testing.T) {
	adp := NewTradeAdapter(&Config{}, nil)
	_, err := adp.DeleteResource(context.Background(), "lhpass-d1", &DeleteResourceRequest{UIN: "1"})
	if err == nil || !strings.Contains(err.Error(), "base_url not configured") {
		t.Fatalf("expected base_url error, got %v", err)
	}
}

func TestDeleteResource_RejectsInvalidArgs(t *testing.T) {
	adp := newTestAdapter(t, "http://unused", "tok")
	// resourceID 必填
	if _, err := adp.DeleteResource(context.Background(), "", &DeleteResourceRequest{UIN: "1"}); err == nil ||
		!strings.Contains(err.Error(), "resourceID is required") {
		t.Fatalf("expected resourceID required error, got %v", err)
	}
	if _, err := adp.DeleteResource(context.Background(), "   ", &DeleteResourceRequest{UIN: "1"}); err == nil ||
		!strings.Contains(err.Error(), "resourceID is required") {
		t.Fatalf("expected resourceID required error (whitespace), got %v", err)
	}
	// req 必填
	if _, err := adp.DeleteResource(context.Background(), "lhpass-d1", nil); err == nil ||
		!strings.Contains(err.Error(), "request is nil") {
		t.Fatalf("expected nil request error, got %v", err)
	}
}

func TestDeleteResource_4xxDecodedAsError(t *testing.T) {
	// trade 端可能返 404 PASS_NOT_FOUND / 409 PASS_BUNDLE_OFFLINE 等业务错误
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusNotFound)
		_ = json.NewEncoder(w).Encode(map[string]string{
			"code":    "PassNotFound",
			"message": "pass lhpass-d1 not found in trade",
		})
	}))
	defer server.Close()
	adp := newTestAdapter(t, server.URL, "tok")
	_, err := adp.DeleteResource(context.Background(), "lhpass-d1", &DeleteResourceRequest{
		UIN: "1", AppID: 1, BundleID: "b",
	})
	if err == nil {
		t.Fatalf("expected non-nil error")
	}
	var tradeErr *Error
	if !errors.As(err, &tradeErr) {
		t.Fatalf("expected *trade.Error, got %T: %v", err, err)
	}
	if tradeErr.Status != http.StatusNotFound || tradeErr.Code != "PassNotFound" {
		t.Fatalf("unexpected error: %+v", tradeErr)
	}
}

func TestDeleteResource_5xxFallbackToHTTPCode(t *testing.T) {
	// 5xx 且无 JSON body：Code 应回退为 HTTP500（与 PlaceOrder_5xxFallbackToHTTPCode 同范式）
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte("upstream service unavailable"))
	}))
	defer server.Close()
	adp := newTestAdapter(t, server.URL, "tok")
	_, err := adp.DeleteResource(context.Background(), "lhpass-d1", &DeleteResourceRequest{
		UIN: "1", AppID: 1, BundleID: "b",
	})
	if err == nil {
		t.Fatalf("expected non-nil error")
	}
	var tradeErr *Error
	if !errors.As(err, &tradeErr) {
		t.Fatalf("expected *trade.Error, got %T: %v", err, err)
	}
	if tradeErr.Status != http.StatusInternalServerError {
		t.Fatalf("unexpected status: %d", tradeErr.Status)
	}
}

// ============================================================================
// RefundResource 测试（trade-pass-refund-design.md v0.5 §8 commit 3）
//
// 对应 ctl → trade 出向调用：POST /internal/trade/resources/{resourceID}/refund
// 入参 DTO 仅 3 字段（UIN/AppID/BundleID），SubProductCode 由 trade 反查（与 DeleteResource Q27 同款）
// 与 DeleteResource 5 个测试对偶
// ============================================================================

func TestRefundResource_Success(t *testing.T) {
	var (
		gotMethod string
		gotPath   string
		gotAuth   string
		gotCT     string
		gotReq    RefundResourceRequest
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
		_ = json.NewEncoder(w).Encode(RefundResourceResult{
			DealName:  "deal-refund-001",
			BigDealID: "big-deal-refund-001",
		})
	}))
	defer server.Close()

	adp := newTestAdapter(t, server.URL, "internal-token")
	result, err := adp.RefundResource(context.Background(), "lhpass-r1", &RefundResourceRequest{
		OwnerUin: "1234567890",
		UIN:      "1234567890",
		AppID:    251000001,
		BundleID: "bundle_basic_monthly",
	})
	if err != nil {
		t.Fatalf("RefundResource: %v", err)
	}

	if gotMethod != http.MethodPost {
		t.Fatalf("expected POST, got %s", gotMethod)
	}
	if gotPath != "/internal/trade/resources/lhpass-r1/refund" {
		t.Fatalf("unexpected path: %s", gotPath)
	}
	if gotAuth != "Bearer internal-token" {
		t.Fatalf("expected bearer header, got %q", gotAuth)
	}
	if gotCT != "application/json" {
		t.Fatalf("expected application/json content-type, got %q", gotCT)
	}
	// 关键不变量（Q3=a 单条退款 + Q5=a 无 category_ids + Q27 trade 反查 SubProductCode
	// + v0.7 修订 2026-06-24 加回 OwnerUin）：DTO 4 字段全量进 HTTP body。
	if gotReq.OwnerUin != "1234567890" ||
		gotReq.UIN != "1234567890" ||
		gotReq.AppID != 251000001 || gotReq.BundleID != "bundle_basic_monthly" {
		t.Fatalf("unexpected request body: %+v", gotReq)
	}
	if result == nil || result.DealName != "deal-refund-001" || result.BigDealID != "big-deal-refund-001" {
		t.Fatalf("unexpected result: %+v", result)
	}
}

func TestRefundResource_ResourceIDPathEscaped(t *testing.T) {
	// resourceID 含 "/" 等特殊字符时必须 PathEscape，与 DeleteResource 同范式
	var gotRawPath string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotRawPath = r.URL.EscapedPath()
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(RefundResourceResult{DealName: "d", BigDealID: "b"})
	}))
	defer server.Close()
	adp := newTestAdapter(t, server.URL, "tok")
	_, err := adp.RefundResource(context.Background(), "lh/pass r1", &RefundResourceRequest{
		UIN: "1", AppID: 1, BundleID: "b",
	})
	if err != nil {
		t.Fatalf("RefundResource: %v", err)
	}
	if !strings.Contains(gotRawPath, "lh%2Fpass%20r1") {
		t.Fatalf("expected path-escaped resourceID in %q", gotRawPath)
	}
}

func TestRefundResource_BaseURLMissing(t *testing.T) {
	adp := NewTradeAdapter(&Config{}, nil)
	_, err := adp.RefundResource(context.Background(), "lhpass-r1", &RefundResourceRequest{UIN: "1"})
	if err == nil || !strings.Contains(err.Error(), "base_url not configured") {
		t.Fatalf("expected base_url error, got %v", err)
	}
}

func TestRefundResource_RejectsInvalidArgs(t *testing.T) {
	adp := newTestAdapter(t, "http://unused", "tok")
	// resourceID 必填
	if _, err := adp.RefundResource(context.Background(), "", &RefundResourceRequest{UIN: "1"}); err == nil ||
		!strings.Contains(err.Error(), "resourceID is required") {
		t.Fatalf("expected resourceID required error, got %v", err)
	}
	if _, err := adp.RefundResource(context.Background(), "   ", &RefundResourceRequest{UIN: "1"}); err == nil ||
		!strings.Contains(err.Error(), "resourceID is required") {
		t.Fatalf("expected resourceID required error (whitespace), got %v", err)
	}
	// req 必填
	if _, err := adp.RefundResource(context.Background(), "lhpass-r1", nil); err == nil ||
		!strings.Contains(err.Error(), "request is nil") {
		t.Fatalf("expected nil request error, got %v", err)
	}
}

func TestRefundResource_4xxDecodedAsError(t *testing.T) {
	// trade 端可能返 502 UpstreamBusinessError / 404 BundleDefinitionNotFound 等业务错误
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadGateway)
		_ = json.NewEncoder(w).Encode(map[string]string{
			"code":    "UpstreamBusinessError",
			"message": "jifei OnlineRefund: returnCode=101103 deal not yet delivered",
		})
	}))
	defer server.Close()
	adp := newTestAdapter(t, server.URL, "tok")
	_, err := adp.RefundResource(context.Background(), "lhpass-r1", &RefundResourceRequest{
		UIN: "1", AppID: 1, BundleID: "b",
	})
	if err == nil {
		t.Fatalf("expected non-nil error")
	}
	var tradeErr *Error
	if !errors.As(err, &tradeErr) {
		t.Fatalf("expected *trade.Error, got %T: %v", err, err)
	}
	if tradeErr.Status != http.StatusBadGateway || tradeErr.Code != "UpstreamBusinessError" {
		t.Fatalf("unexpected error: %+v", tradeErr)
	}
}

func TestRefundResource_5xxFallbackToHTTPCode(t *testing.T) {
	// 5xx 且无 JSON body：Code 应回退为 HTTP500（与 PlaceOrder/DeleteResource 同范式）
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte("upstream service unavailable"))
	}))
	defer server.Close()
	adp := newTestAdapter(t, server.URL, "tok")
	_, err := adp.RefundResource(context.Background(), "lhpass-r1", &RefundResourceRequest{
		UIN: "1", AppID: 1, BundleID: "b",
	})
	if err == nil {
		t.Fatalf("expected non-nil error")
	}
	var tradeErr *Error
	if !errors.As(err, &tradeErr) {
		t.Fatalf("expected *trade.Error, got %T: %v", err, err)
	}
	if tradeErr.Status != http.StatusInternalServerError {
		t.Fatalf("unexpected status: %d", tradeErr.Status)
	}
}
