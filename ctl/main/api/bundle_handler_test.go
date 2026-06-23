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

func (s *stubBundleLogic) ImportBundle(string, string, string, string, int64, int64, int, string, string, string, bool, int, int) (*bundlelogic.BundleDetail, error) {
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
//
// 调用观测：每次 InquiryBatch 调用都会 append 到 inquiryReqs / inquiryReqBundles，
// 便于断言 fast path / slow path 的调用次数 + 每次传入的 bundleIds 集合。
//
// 响应注入：
//   - inquiryHandler != nil 时，每次调用按 inquiryHandler(req) 动态返回（用于 per-bundle
//     成功/失败混合的 slow path 测试）；
//   - inquiryHandler == nil 时，回落到固定 inquiryResult / inquiryErr 路径（兼容
//     既有 happy-path / 全失败测试用例）。
type stubTradeAdapter struct {
	inquiryReq        *tradeadapter.InquiryBatchRequest   // 最后一次调用的请求（兼容既有断言）
	inquiryReqs       []*tradeadapter.InquiryBatchRequest // 所有调用历史
	inquiryReqBundles [][]string                          // 每次调用的 bundleIds 副本
	inquiryResult     *tradeadapter.InquiryBatchResult
	inquiryErr        error
	inquiryHandler    func(*tradeadapter.InquiryBatchRequest) (*tradeadapter.InquiryBatchResult, error)
	inquiryCalled     int
}

func (s *stubTradeAdapter) InquiryBatch(_ context.Context, req *tradeadapter.InquiryBatchRequest) (*tradeadapter.InquiryBatchResult, error) {
	s.inquiryCalled++
	s.inquiryReq = req
	s.inquiryReqs = append(s.inquiryReqs, req)
	ids := make([]string, len(req.BundleIDs))
	copy(ids, req.BundleIDs)
	s.inquiryReqBundles = append(s.inquiryReqBundles, ids)
	if s.inquiryHandler != nil {
		return s.inquiryHandler(req)
	}
	return s.inquiryResult, s.inquiryErr
}
func (s *stubTradeAdapter) InquiryRenew(context.Context, *tradeadapter.InquiryRenewRequest) (*tradeadapter.InquiryRenewResult, error) {
	panic("stubTradeAdapter.InquiryRenew: not implemented")
}
func (s *stubTradeAdapter) PlaceOrder(context.Context, *tradeadapter.PlaceOrderRequest) (*tradeadapter.PlaceOrderResult, error) {
	panic("stubTradeAdapter.PlaceOrder: not implemented")
}
func (s *stubTradeAdapter) PlaceOrderAndPay(context.Context, *tradeadapter.PlaceOrderRequest) (*tradeadapter.PlaceOrderResult, error) {
	panic("stubTradeAdapter.PlaceOrderAndPay: not implemented")
}
func (s *stubTradeAdapter) PlaceRenewOrder(context.Context, *tradeadapter.PlaceRenewOrderRequest) (*tradeadapter.PlaceOrderResult, error) {
	panic("stubTradeAdapter.PlaceRenewOrder: not implemented")
}
func (s *stubTradeAdapter) PlaceRenewOrderAndPay(context.Context, *tradeadapter.PlaceRenewOrderRequest) (*tradeadapter.PlaceOrderResult, error) {
	panic("stubTradeAdapter.PlaceRenewOrderAndPay: not implemented")
}
func (s *stubTradeAdapter) GeneratePayURL(context.Context, string, *tradeadapter.GeneratePayURLOptions) (*tradeadapter.PayURLResult, error) {
	panic("stubTradeAdapter.GeneratePayURL: not implemented")
}
func (s *stubTradeAdapter) CompleteFlow(context.Context, int64, string, string) error {
	panic("stubTradeAdapter.CompleteFlow: not implemented")
}
func (s *stubTradeAdapter) DeleteResource(context.Context, string, *tradeadapter.DeleteResourceRequest) (*tradeadapter.DeleteResourceResult, error) {
	panic("stubTradeAdapter.DeleteResource: not implemented")
}

func (s *stubTradeAdapter) QueryOrderStatus(context.Context, string, string) (*tradeadapter.OrderStatusResult, error) {
	panic("stubTradeAdapter.QueryOrderStatus: not implemented")
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
		name     string
		query    string
		wantSpan int
		wantUnit string
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

// sampleBundleDetailsWithFreeTrial 在普通 bundle 之外追加一条 bundle_free_trial_01，
// 用于验证 fetchBundleQuotes 必须把免费试用 bundle 从 trade 询价集合中剔除。
func sampleBundleDetailsWithFreeTrial() []*bundlelogic.BundleDetail {
	details := sampleBundleDetails()
	free := &bundlelogic.BundleDetail{
		BundleID:         "bundle_free_trial_01",
		BundleName:       "Free Trial",
		Description:      `[{"Key":"agent_quota","Value":"1"}]`,
		BundleState:      "ONLINE",
		AgentQuota:       1,
		Credit:           100,
		BundleSalesState: "AVAILABLE",
	}
	// 把 free_trial 放在中间位置，验证不依赖排序也能被识别为"免费试用"。
	return []*bundlelogic.BundleDetail{details[0], free, details[1]}
}

// errFromStatus 构造 ctl tradeadapter.Error，模拟 trade 上游业务错（404/409/422）。
func errFromStatus(status int, code, message string) error {
	return &tradeadapter.Error{
		Status:   status,
		Code:     code,
		Message:  message,
		Endpoint: "http://trade.trade.svc.cluster.local/internal/trade/inquiry/batch",
	}
}

// TestDescribeBundles_FreeTrialBundleSkippedFromInquiry 验证免费试用 bundle（bundle_id
// 以 freeTrialBundleIDPrefix 开头）不会进入 trade InquiryBatch 询价集合——避免 trade 因
// trade_bundle_definition 未录入返 404 BundleNotFound 拖垮整批询价。
//
// 期望：
//   - InquiryBatch 仍只调 1 次（fast path 成功）；
//   - 请求体 BundleIDs 不包含 bundle_free_trial_01；
//   - bundle_free_trial_01 的 Price 字段保持 nil（免费试用走 CreateTrialPass 链路，无报价）；
//   - 其它付费 bundle 的 Price 正常回填。
func TestDescribeBundles_FreeTrialBundleSkippedFromInquiry(t *testing.T) {
	logic := &stubBundleLogic{describeReturn: sampleBundleDetailsWithFreeTrial()}
	trader := &stubTradeAdapter{
		inquiryResult: &tradeadapter.InquiryBatchResult{
			Prices: []*tradeadapter.BundleQuote{
				{BundleID: "bundle_basic", Price: "9.90", TotalCost: "9.90", RealTotalCost: "9.90", Currency: "CNY", Discount: 1.0},
				{BundleID: "bundle_pro", Price: "29.90", TotalCost: "29.90", RealTotalCost: "29.90", Currency: "CNY", Discount: 1.0},
			},
		},
	}
	h := &bundleHandler{logic: logic, tradeAdapter: trader}

	req := httptest.NewRequest(http.MethodGet, "/v1/bundles", nil)
	req.Header.Set("X-User-Id", "user_123")
	rec := httptest.NewRecorder()

	h.describeBundles(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status: got %d want 200; body=%s", rec.Code, rec.Body.String())
	}
	if trader.inquiryCalled != 1 {
		t.Fatalf("inquiryCalled: got %d want 1 (fast path only)", trader.inquiryCalled)
	}
	if got, want := len(trader.inquiryReq.BundleIDs), 2; got != want {
		t.Fatalf("inquiryReq.BundleIDs len: got %d want %d (free_trial must be filtered)", got, want)
	}
	for _, bid := range trader.inquiryReq.BundleIDs {
		if bid == "bundle_free_trial_01" {
			t.Fatalf("bundle_free_trial_01 must NOT be sent to trade InquiryBatch; got BundleIDs=%v", trader.inquiryReq.BundleIDs)
		}
	}

	bundles := decodeUserBundles(t, rec.Body.Bytes())
	priceByID := make(map[string]*transport.BundlePrice, len(bundles))
	for _, b := range bundles {
		priceByID[b.BundleID] = b.Price
	}
	if priceByID["bundle_free_trial_01"] != nil {
		t.Fatalf("bundle_free_trial_01 Price: got %+v want nil (no quote for trial bundle)", priceByID["bundle_free_trial_01"])
	}
	if priceByID["bundle_basic"] == nil || priceByID["bundle_basic"].Price != 9.9 {
		t.Fatalf("bundle_basic Price: got %+v want {Price=9.9, ...}", priceByID["bundle_basic"])
	}
	if priceByID["bundle_pro"] == nil || priceByID["bundle_pro"].Price != 29.9 {
		t.Fatalf("bundle_pro Price: got %+v want {Price=29.9, ...}", priceByID["bundle_pro"])
	}
}

// TestDescribeBundles_PerBundleFallback_OnBatch404 验证 fast path 失败为 trade 4xx 业务错
// （404 BundleNotFound / 409 BundleOffline / 422 BindingNotFound）时，自动 fallback 到
// slow path 拆 1-by-1 询价：失败的单条降级为 nil，其它 bundle 价格正常展示（A 方案语义）。
func TestDescribeBundles_PerBundleFallback_OnBatch404(t *testing.T) {
	logic := &stubBundleLogic{describeReturn: sampleBundleDetails()} // bundle_basic + bundle_pro
	// 调用计划：
	//   call#1 (fast path, BundleIDs=[basic, pro]) → 404 BundleNotFound
	//   call#2 (slow path, BundleIDs=[basic])     → 200 + price
	//   call#3 (slow path, BundleIDs=[pro])       → 404 BundleNotFound（该条降级 nil）
	callIdx := 0
	trader := &stubTradeAdapter{
		inquiryHandler: func(req *tradeadapter.InquiryBatchRequest) (*tradeadapter.InquiryBatchResult, error) {
			callIdx++
			switch callIdx {
			case 1:
				return nil, errFromStatus(http.StatusNotFound, "BundleNotFound", "inquiry: bundle not found: trade_bundle_definition bundleId=bundle_pro")
			case 2:
				// slow path: bundle_basic 单条成功
				return &tradeadapter.InquiryBatchResult{
					Prices: []*tradeadapter.BundleQuote{
						{BundleID: "bundle_basic", Price: "9.90", TotalCost: "9.90", RealTotalCost: "9.90", Currency: "CNY", Discount: 1.0},
					},
				}, nil
			case 3:
				// slow path: bundle_pro 单条仍失败 → 该条降级 nil
				return nil, errFromStatus(http.StatusNotFound, "BundleNotFound", "inquiry: bundle not found: trade_bundle_definition bundleId=bundle_pro")
			default:
				t.Fatalf("unexpected extra InquiryBatch call #%d req=%+v", callIdx, req)
				return nil, nil
			}
		},
	}
	h := &bundleHandler{logic: logic, tradeAdapter: trader}

	req := httptest.NewRequest(http.MethodGet, "/v1/bundles", nil)
	req.Header.Set("X-User-Id", "user_123")
	rec := httptest.NewRecorder()

	h.describeBundles(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status: got %d want 200; body=%s", rec.Code, rec.Body.String())
	}
	if trader.inquiryCalled != 3 {
		t.Fatalf("inquiryCalled: got %d want 3 (1 fast path + 2 slow path)", trader.inquiryCalled)
	}
	// 验证 slow path 拆 1-by-1：第 2 次只问 basic，第 3 次只问 pro。
	if got, want := trader.inquiryReqBundles[1], []string{"bundle_basic"}; len(got) != 1 || got[0] != want[0] {
		t.Fatalf("slow path call#2 BundleIDs: got %v want %v", got, want)
	}
	if got, want := trader.inquiryReqBundles[2], []string{"bundle_pro"}; len(got) != 1 || got[0] != want[0] {
		t.Fatalf("slow path call#3 BundleIDs: got %v want %v", got, want)
	}

	bundles := decodeUserBundles(t, rec.Body.Bytes())
	priceByID := make(map[string]*transport.BundlePrice, len(bundles))
	for _, b := range bundles {
		priceByID[b.BundleID] = b.Price
	}
	// bundle_basic 仍应有价格（slow path 成功）
	if priceByID["bundle_basic"] == nil || priceByID["bundle_basic"].Price != 9.9 {
		t.Fatalf("bundle_basic Price: got %+v want {Price=9.9, ...} (slow path success)", priceByID["bundle_basic"])
	}
	// bundle_pro 应降级为 nil（slow path 单条仍失败）
	if priceByID["bundle_pro"] != nil {
		t.Fatalf("bundle_pro Price: got %+v want nil (slow path single-bundle failure must degrade)", priceByID["bundle_pro"])
	}
}

// TestDescribeBundles_BatchNonRetryableError_NoSlowPath 验证 fast path 失败为"不可
// 拆单条重试"的错误（如 400 InvalidRequest / context 取消 / 非 *tradeadapter.Error 网络错）
// 时，直接整批降级，**不会**进入 slow path 拆 1-by-1 重试。
//
// 与"5xx 上游错"的关键区别：400 InvalidRequest 表示调用方参数错（如 BundleIDs 为空 /
// PayMode 越界），拆单条单条同样会错；非 *tradeadapter.Error 表示连 HTTP 都没打通
// （base_url 未配置 / DNS 解析失败 / context 超时），拆单条同样打不通。
//
// （5xx 上游错 502/503/504 现在改为走 slow path，见
// TestDescribeBundles_PerBundleFallback_OnBatch502_SomeSucceed 等测试。）
func TestDescribeBundles_BatchNonRetryableError_NoSlowPath(t *testing.T) {
	logic := &stubBundleLogic{describeReturn: sampleBundleDetails()}
	trader := &stubTradeAdapter{
		// 400 InvalidRequest：调用方参数错（trade classifyInquiryError 把 ErrInvalidInput
		// 映射为 InvalidRequest/400）；拆单条同样会错，不应触发 slow path。
		inquiryErr: errFromStatus(http.StatusBadRequest, "InvalidRequest", "period must be > 0"),
	}
	h := &bundleHandler{logic: logic, tradeAdapter: trader}

	req := httptest.NewRequest(http.MethodGet, "/v1/bundles", nil)
	req.Header.Set("X-User-Id", "user_123")
	rec := httptest.NewRecorder()

	h.describeBundles(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status: got %d want 200", rec.Code)
	}
	if trader.inquiryCalled != 1 {
		t.Fatalf("inquiryCalled: got %d want 1 (non-retryable 400 must NOT trigger slow path retry)", trader.inquiryCalled)
	}
	bundles := decodeUserBundles(t, rec.Body.Bytes())
	for _, b := range bundles {
		if b.Price != nil {
			t.Fatalf("bundle %s Price: got %+v want nil (non-retryable error must fallback to no-price for all)", b.BundleID, b.Price)
		}
	}
}

// TestDescribeBundles_PerBundleFallback_OnBatch502_SomeSucceed 验证 fast path 失败为
// 5xx 上游错（典型场景：jifei GetPrice 对某条 bundle 的 sv 返回 371009 no price found，
// trade 包装为 502 UpstreamError）时，自动 fallback 到 slow path 拆 1-by-1：
//   - 拆单后部分 bundle 能成功（jifei 对它们的 sv 有价）→ 正常回填 Price
//   - 拆单后仍失败的 bundle → 单条降级为 nil
//
// 这是 A 方案 5xx 扩展的核心场景：避免"某一条 bundle 的 jifei 价格表问题"拖累整批
// 付费 bundle 价格展示（实测 beijing-sandbox 老 sp `sp_lighthouse_lightvela_mc`
// 在北京一区/月/预付费维度下 bundle_launch_01 的 sv_bw 缺价，连累 cruise_01 /
// voyage_01 也无价的样态）。
func TestDescribeBundles_PerBundleFallback_OnBatch502_SomeSucceed(t *testing.T) {
	logic := &stubBundleLogic{describeReturn: sampleBundleDetails()} // bundle_basic + bundle_pro
	// 调用计划：
	//   call#1 (fast path, BundleIDs=[basic, pro]) → 502 UpstreamError (jifei 371009)
	//   call#2 (slow path, BundleIDs=[basic])     → 仍 502 (该条 sv 缺价)
	//   call#3 (slow path, BundleIDs=[pro])       → 200 + price (该条 sv 有价)
	callIdx := 0
	trader := &stubTradeAdapter{
		inquiryHandler: func(req *tradeadapter.InquiryBatchRequest) (*tradeadapter.InquiryBatchResult, error) {
			callIdx++
			switch callIdx {
			case 1:
				return nil, errFromStatus(http.StatusBadGateway, "UpstreamError",
					"inquiry: jifei GetPrice: jifei cgw business error: returnCode=371009 no price found for sv_lighthouse_lv_bw_basic_mc_01")
			case 2:
				return nil, errFromStatus(http.StatusBadGateway, "UpstreamError",
					"inquiry: jifei GetPrice: jifei cgw business error: returnCode=371009 no price found for sv_lighthouse_lv_bw_basic_mc_01")
			case 3:
				return &tradeadapter.InquiryBatchResult{
					Prices: []*tradeadapter.BundleQuote{
						{BundleID: "bundle_pro", Price: "29.90", TotalCost: "29.90", RealTotalCost: "29.90", Currency: "CNY", Discount: 1.0},
					},
				}, nil
			default:
				t.Fatalf("unexpected extra InquiryBatch call #%d req=%+v", callIdx, req)
				return nil, nil
			}
		},
	}
	h := &bundleHandler{logic: logic, tradeAdapter: trader}

	req := httptest.NewRequest(http.MethodGet, "/v1/bundles", nil)
	req.Header.Set("X-User-Id", "user_123")
	rec := httptest.NewRecorder()

	h.describeBundles(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status: got %d want 200; body=%s", rec.Code, rec.Body.String())
	}
	if trader.inquiryCalled != 3 {
		t.Fatalf("inquiryCalled: got %d want 3 (1 fast path + 2 slow path)", trader.inquiryCalled)
	}
	// 验证 slow path 拆 1-by-1 顺序（slice 顺序与 sampleBundleDetails 一致：basic, pro）。
	if got, want := trader.inquiryReqBundles[1], []string{"bundle_basic"}; len(got) != 1 || got[0] != want[0] {
		t.Fatalf("slow path call#2 BundleIDs: got %v want %v", got, want)
	}
	if got, want := trader.inquiryReqBundles[2], []string{"bundle_pro"}; len(got) != 1 || got[0] != want[0] {
		t.Fatalf("slow path call#3 BundleIDs: got %v want %v", got, want)
	}

	bundles := decodeUserBundles(t, rec.Body.Bytes())
	priceByID := make(map[string]*transport.BundlePrice, len(bundles))
	for _, b := range bundles {
		priceByID[b.BundleID] = b.Price
	}
	if priceByID["bundle_basic"] != nil {
		t.Fatalf("bundle_basic Price: got %+v want nil (slow path single-bundle 502 must degrade)", priceByID["bundle_basic"])
	}
	if priceByID["bundle_pro"] == nil || priceByID["bundle_pro"].Price != 29.9 {
		t.Fatalf("bundle_pro Price: got %+v want {Price=29.9, ...} (slow path success)", priceByID["bundle_pro"])
	}
}

// TestDescribeBundles_PerBundleFallback_OnBatch502_AllFail 验证 fast path 502 触发
// slow path 后所有 bundle 单条仍失败（jifei 价格表整体缺失）时，所有 bundle Price 都
// 降级为 nil，bundle 列表本身仍正常返回（Q-CGW-01 降级语义）。
//
// 验证代价：N 次串行调用，N = quotableIDs 长度。代价可接受（实测 beijing-sandbox
// bundle 总数 ≤ 7，单条 jifei 调用毫秒级，N 次串行远低于 ctx 5s 上限）。
func TestDescribeBundles_PerBundleFallback_OnBatch502_AllFail(t *testing.T) {
	logic := &stubBundleLogic{describeReturn: sampleBundleDetails()}
	trader := &stubTradeAdapter{
		inquiryErr: errFromStatus(http.StatusBadGateway, "UpstreamError",
			"inquiry: jifei GetPrice: 371009 no price found"),
	}
	h := &bundleHandler{logic: logic, tradeAdapter: trader}

	req := httptest.NewRequest(http.MethodGet, "/v1/bundles", nil)
	req.Header.Set("X-User-Id", "user_123")
	rec := httptest.NewRecorder()

	h.describeBundles(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status: got %d want 200", rec.Code)
	}
	// 1 次 fast path + N 次 slow path（N=2，sampleBundleDetails 长度）= 3 次。
	if trader.inquiryCalled != 3 {
		t.Fatalf("inquiryCalled: got %d want 3 (1 fast path + 2 slow path)", trader.inquiryCalled)
	}
	bundles := decodeUserBundles(t, rec.Body.Bytes())
	for _, b := range bundles {
		if b.Price != nil {
			t.Fatalf("bundle %s Price: got %+v want nil (slow path all-fail must degrade all)", b.BundleID, b.Price)
		}
	}
}

// TestIsPerBundleRetryableError 单元测试可拆单条重试的错误判定。
func TestIsPerBundleRetryableError(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want bool
	}{
		{"nil_error", nil, false},
		{"plain_error", context.DeadlineExceeded, false},
		{"trade_400_invalid", errFromStatus(http.StatusBadRequest, "InvalidRequest", "bad param"), false},
		{"trade_401_unauthorized", errFromStatus(http.StatusUnauthorized, "Unauthorized", "token"), false},
		{"trade_404_bundle_not_found", errFromStatus(http.StatusNotFound, "BundleNotFound", "no def"), true},
		{"trade_409_bundle_offline", errFromStatus(http.StatusConflict, "BundleOffline", "offline"), true},
		{"trade_422_binding_not_found", errFromStatus(http.StatusUnprocessableEntity, "BindingNotFound", "no binding"), true},
		{"trade_502_upstream_error", errFromStatus(http.StatusBadGateway, "UpstreamError", "jifei 371009"), true},
		{"trade_503_service_unavailable", errFromStatus(http.StatusServiceUnavailable, "ServiceUnavailable", "pay url down"), true},
		{"trade_504_gateway_timeout", errFromStatus(http.StatusGatewayTimeout, "GatewayTimeout", "jifei timeout"), true},
		{"trade_500_unknown", errFromStatus(http.StatusInternalServerError, "InternalError", "panic"), false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := isPerBundleRetryableError(tc.err); got != tc.want {
				t.Fatalf("isPerBundleRetryableError(%v) = %v, want %v", tc.err, got, tc.want)
			}
		})
	}
}

// TestIsFreeTrialBundleID 单元测试免费试用 bundle 命名前缀判定。
func TestIsFreeTrialBundleID(t *testing.T) {
	cases := []struct {
		name string
		id   string
		want bool
	}{
		{"empty", "", false},
		{"free_trial_01", "bundle_free_trial_01", true},
		{"free_trial_long_suffix", "bundle_free_trial_anything_goes_here", true},
		{"paid_basic", "bundle_basic", false},
		{"paid_launch_01", "bundle_launch_01", false},
		{"paid_launch_ai_01", "bundle_launch_ai_01", false},
		{"similar_but_not_prefix", "trial_bundle", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := isFreeTrialBundleID(tc.id); got != tc.want {
				t.Fatalf("isFreeTrialBundleID(%q) = %v, want %v", tc.id, got, tc.want)
			}
		})
	}
}
