package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	tradeadapter "ctl/pkg/adapter/trade"
	bundlelogic "ctl/pkg/logic/bundle"
	"ctl/pkg/transport"
)

// stubBundleLogic 是 bundlelogic.Logic 的最小化 stub，仅实现 describeBundles 测试需要的
// DescribeBundles 方法，其它方法在被本测试套调用时直接 panic（防止误用）。
type stubBundleLogic struct {
	describeReturn []*bundlelogic.BundleDetail
	describeErr    error
}

func (s *stubBundleLogic) ImportBundle(string, string, string, int64, int64, int, string, string, bool, int, int) (*bundlelogic.BundleDetail, error) {
	panic("stubBundleLogic.ImportBundle: not implemented")
}
func (s *stubBundleLogic) GetBundles() ([]*bundlelogic.BundleDetail, error) {
	panic("stubBundleLogic.GetBundles: not implemented")
}
func (s *stubBundleLogic) ModifyBundles([]string, *bundlelogic.ModifyBundleFields) (int64, error) {
	panic("stubBundleLogic.ModifyBundles: not implemented")
}
func (s *stubBundleLogic) DescribeBundles() ([]*bundlelogic.BundleDetail, error) {
	return s.describeReturn, s.describeErr
}
func (s *stubBundleLogic) GetBundleByID(string) (*bundlelogic.BundleDetail, error) {
	panic("stubBundleLogic.GetBundleByID: not implemented")
}

// stubTradeAdapter 仅实现 InquiryBatch；其它方法被调到时直接 panic（防止误用）。
type stubTradeAdapter struct {
	inquiryReq    *tradeadapter.InquiryBatchRequest
	inquiryResult *tradeadapter.InquiryBatchResult
	inquiryErr    error
	inquiryCalled int
}

func (s *stubTradeAdapter) InquiryBatch(_ context.Context, req *tradeadapter.InquiryBatchRequest) (*tradeadapter.InquiryBatchResult, error) {
	s.inquiryCalled++
	s.inquiryReq = req
	return s.inquiryResult, s.inquiryErr
}
func (s *stubTradeAdapter) PlaceOrder(context.Context, *tradeadapter.PlaceOrderRequest) (*tradeadapter.PlaceOrderResult, error) {
	panic("stubTradeAdapter.PlaceOrder: not implemented")
}
func (s *stubTradeAdapter) PlaceOrderAndPay(context.Context, *tradeadapter.PlaceOrderRequest) (*tradeadapter.PlaceOrderResult, error) {
	panic("stubTradeAdapter.PlaceOrderAndPay: not implemented")
}
func (s *stubTradeAdapter) GeneratePayURL(context.Context, string) (*tradeadapter.PayURLResult, error) {
	panic("stubTradeAdapter.GeneratePayURL: not implemented")
}

func sampleBundleDetails() []*bundlelogic.BundleDetail {
	return []*bundlelogic.BundleDetail{
		{
			BundleID:         "bundle_basic",
			BundleName:       "Basic",
			Description:      `[{"Key":"agent_quota","Value":"3"}]`,
			BundleState:      "ONLINE",
			AgentQuota:       3,
			Credit:           1000,
			BundleSalesState: "AVAILABLE",
		},
		{
			BundleID:         "bundle_pro",
			BundleName:       "Pro",
			Description:      `[{"Key":"agent_quota","Value":"10"}]`,
			BundleState:      "ONLINE",
			AgentQuota:       10,
			Credit:           5000,
			BundleSalesState: "AVAILABLE",
		},
	}
}

func decodeUserBundles(t *testing.T, body []byte) []*transport.UserBundleResponse {
	t.Helper()
	var env struct {
		Code string `json:"code"`
		Data struct {
			Bundles []*transport.UserBundleResponse `json:"bundles"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &env); err != nil {
		t.Fatalf("decode response failed: %v body=%s", err, string(body))
	}
	if env.Code != "OK" {
		t.Fatalf("expect code=OK, got %q body=%s", env.Code, string(body))
	}
	return env.Data.Bundles
}

// TestDescribeBundles_LoggedIn_QuotesBackfilled 已登录请求（带 X-User-Id）应触发 trade
// InquiryBatch 调用，并把 BundleQuote 转成 BundlePrice 回填到对应 bundle。
func TestDescribeBundles_LoggedIn_QuotesBackfilled(t *testing.T) {
	logic := &stubBundleLogic{describeReturn: sampleBundleDetails()}
	trader := &stubTradeAdapter{
		inquiryResult: &tradeadapter.InquiryBatchResult{
			Prices: []*tradeadapter.BundleQuote{
				{
					BundleID:      "bundle_basic",
					BundleName:    "Basic",
					Price:         "9.90",
					TotalCost:     "9.90",
					RealTotalCost: "8.91",
					Currency:      "CNY",
					Discount:      0.9,
				},
				// bundle_pro 故意不回，验证未匹配上的 bundle Price 仍为 nil
			},
		},
	}
	h := &bundleHandler{logic: logic, tradeAdapter: trader}

	req := httptest.NewRequest(http.MethodGet, "/v1/bundles?time_span=2&time_unit=m", nil)
	req.Header.Set("X-User-Id", "user_123")
	rec := httptest.NewRecorder()

	h.describeBundles(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status: got %d want 200; body=%s", rec.Code, rec.Body.String())
	}
	if trader.inquiryCalled != 1 {
		t.Fatalf("trader.inquiryCalled: got %d want 1", trader.inquiryCalled)
	}
	if got := trader.inquiryReq.ExternalUserID; got != "user_123" {
		t.Fatalf("inquiryReq.ExternalUserID: got %q want %q", got, "user_123")
	}
	if got := trader.inquiryReq.Period; got != 2 {
		t.Fatalf("inquiryReq.Period: got %d want 2", got)
	}
	if got := trader.inquiryReq.TimeUnit; got != "m" {
		t.Fatalf("inquiryReq.TimeUnit: got %q want %q", got, "m")
	}
	if got, want := len(trader.inquiryReq.BundleIDs), 2; got != want {
		t.Fatalf("inquiryReq.BundleIDs len: got %d want %d", got, want)
	}

	bundles := decodeUserBundles(t, rec.Body.Bytes())
	if got := len(bundles); got != 2 {
		t.Fatalf("bundles len: got %d want 2", got)
	}

	var basic, pro *transport.UserBundleResponse
	for _, b := range bundles {
		switch b.BundleID {
		case "bundle_basic":
			basic = b
		case "bundle_pro":
			pro = b
		}
	}
	if basic == nil || pro == nil {
		t.Fatalf("missing bundle: basic=%v pro=%v", basic, pro)
	}
	if basic.Price == nil {
		t.Fatalf("basic.Price: got nil, want filled")
	}
	if basic.Price.Price != 9.9 || basic.Price.RealTotalCost != 8.91 || basic.Price.Currency != "CNY" || basic.Price.Discount != 0.9 {
		t.Fatalf("basic.Price unexpected: %+v", basic.Price)
	}
	if pro.Price != nil {
		t.Fatalf("pro.Price: got %+v, want nil (no quote returned)", pro.Price)
	}
}

// TestDescribeBundles_NoUserID_SkipsTradeRPC 未登录公开页（缺 X-User-Id）应直接走
// "无价 bundle 列表"分支，不调 trade 询价（Q31 选项 b）。
func TestDescribeBundles_NoUserID_SkipsTradeRPC(t *testing.T) {
	logic := &stubBundleLogic{describeReturn: sampleBundleDetails()}
	trader := &stubTradeAdapter{}
	h := &bundleHandler{logic: logic, tradeAdapter: trader}

	req := httptest.NewRequest(http.MethodGet, "/v1/bundles", nil)
	rec := httptest.NewRecorder()

	h.describeBundles(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status: got %d want 200; body=%s", rec.Code, rec.Body.String())
	}
	if trader.inquiryCalled != 0 {
		t.Fatalf("trader.inquiryCalled: got %d want 0 (must skip when no X-User-Id)", trader.inquiryCalled)
	}
	bundles := decodeUserBundles(t, rec.Body.Bytes())
	for _, b := range bundles {
		if b.Price != nil {
			t.Fatalf("bundle %s Price: got %+v, want nil", b.BundleID, b.Price)
		}
	}
}

// TestDescribeBundles_NilTradeAdapter 当 tradeAdapter==nil（启动期未注入 / trade 配置缺失）
// describeBundles 不应 panic，所有 bundle Price 保持 nil。
func TestDescribeBundles_NilTradeAdapter(t *testing.T) {
	logic := &stubBundleLogic{describeReturn: sampleBundleDetails()}
	h := &bundleHandler{logic: logic, tradeAdapter: nil}

	req := httptest.NewRequest(http.MethodGet, "/v1/bundles", nil)
	req.Header.Set("X-User-Id", "user_123")
	rec := httptest.NewRecorder()

	h.describeBundles(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status: got %d want 200; body=%s", rec.Code, rec.Body.String())
	}
	bundles := decodeUserBundles(t, rec.Body.Bytes())
	for _, b := range bundles {
		if b.Price != nil {
			t.Fatalf("bundle %s Price: got %+v, want nil", b.BundleID, b.Price)
		}
	}
}

// TestDescribeBundles_TradeRPCFailure_FallbackNoPrice trade RPC 失败时（5xx / 超时 /
// NotFound）所有 bundle Price 应降级为 nil，bundle 列表本身不阻断（Q-CGW-01 降级语义）。
func TestDescribeBundles_TradeRPCFailure_FallbackNoPrice(t *testing.T) {
	logic := &stubBundleLogic{describeReturn: sampleBundleDetails()}
	trader := &stubTradeAdapter{inquiryErr: context.DeadlineExceeded}
	h := &bundleHandler{logic: logic, tradeAdapter: trader}

	req := httptest.NewRequest(http.MethodGet, "/v1/bundles", nil)
	req.Header.Set("X-User-Id", "user_123")
	rec := httptest.NewRecorder()

	h.describeBundles(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status: got %d want 200; body=%s", rec.Code, rec.Body.String())
	}
	if trader.inquiryCalled != 1 {
		t.Fatalf("trader.inquiryCalled: got %d want 1", trader.inquiryCalled)
	}
	bundles := decodeUserBundles(t, rec.Body.Bytes())
	if len(bundles) != 2 {
		t.Fatalf("bundles len: got %d want 2", len(bundles))
	}
	for _, b := range bundles {
		if b.Price != nil {
			t.Fatalf("bundle %s Price: got %+v, want nil (RPC failure must fallback)", b.BundleID, b.Price)
		}
	}
}

// TestDescribeBundles_DefaultPeriod 不带 query 参数时，period/timeUnit 应回退到 (1, "m")
// （Q24 拍板）。
func TestDescribeBundles_DefaultPeriod(t *testing.T) {
	logic := &stubBundleLogic{describeReturn: sampleBundleDetails()}
	trader := &stubTradeAdapter{
		inquiryResult: &tradeadapter.InquiryBatchResult{Prices: nil},
	}
	h := &bundleHandler{logic: logic, tradeAdapter: trader}

	req := httptest.NewRequest(http.MethodGet, "/v1/bundles", nil)
	req.Header.Set("X-User-Id", "user_123")
	rec := httptest.NewRecorder()

	h.describeBundles(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status: got %d want 200", rec.Code)
	}
	if got := trader.inquiryReq.Period; got != 1 {
		t.Fatalf("Period default: got %d want 1", got)
	}
	if got := trader.inquiryReq.TimeUnit; got != "m" {
		t.Fatalf("TimeUnit default: got %q want %q", got, "m")
	}
}

// TestParseTimeSpanUnit 单元测试 parseTimeSpanUnit 各种 query 输入。
func TestParseTimeSpanUnit(t *testing.T) {
	cases := []struct {
		name        string
		query       string
		wantSpan    int
		wantUnit    string
	}{
		{"empty", "", 1, "m"},
		{"valid_y", "time_span=3&time_unit=y", 3, "y"},
		{"invalid_span_negative", "time_span=-5&time_unit=m", 1, "m"},
		{"invalid_span_zero", "time_span=0", 1, "m"},
		{"invalid_span_text", "time_span=abc", 1, "m"},
		{"only_unit", "time_unit=y", 1, "y"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "/v1/bundles?"+tc.query, nil)
			span, unit := parseTimeSpanUnit(req)
			if span != tc.wantSpan || unit != tc.wantUnit {
				t.Fatalf("parseTimeSpanUnit(%q) = (%d, %q), want (%d, %q)", tc.query, span, unit, tc.wantSpan, tc.wantUnit)
			}
		})
	}
}

// TestBundleQuoteToPrice 单元测试 BundleQuote 字符串价格 → BundlePrice float64 转换，
// 包含解析失败的字段降级为 0 的场景。
func TestBundleQuoteToPrice(t *testing.T) {
	t.Run("normal", func(t *testing.T) {
		q := &tradeadapter.BundleQuote{
			Price:         "9.90",
			TotalCost:     "9.90",
			RealTotalCost: "8.91",
			Currency:      "CNY",
			Discount:      0.9,
		}
		p := bundleQuoteToPrice(q)
		if p == nil || p.Price != 9.9 || p.RealTotalCost != 8.91 || p.Currency != "CNY" || p.Discount != 0.9 {
			t.Fatalf("got %+v", p)
		}
	})
	t.Run("invalid_string_falls_back_to_zero", func(t *testing.T) {
		q := &tradeadapter.BundleQuote{
			Price:         "not-a-number",
			TotalCost:     "",
			RealTotalCost: "10",
			Currency:      "CNY",
			Discount:      1.0,
		}
		p := bundleQuoteToPrice(q)
		if p == nil || p.Price != 0 || p.TotalCost != 0 || p.RealTotalCost != 10 {
			t.Fatalf("got %+v", p)
		}
	})
}
