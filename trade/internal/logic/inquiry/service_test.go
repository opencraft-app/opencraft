package inquiry

import (
	"context"
	"errors"
	"strings"
	"sync/atomic"
	"testing"

	"git.woa.com/wisp/mono/trade/internal/ctlclient"
	"git.woa.com/wisp/mono/trade/internal/jifeiclient"
	"git.woa.com/wisp/mono/trade/internal/shadowclient"
	"git.woa.com/wisp/mono/trade/internal/store"
)

// ============================================================================
// fakes
// ============================================================================

type fakeCTL struct {
	getBundleByIDFn func(ctx context.Context, bundleID string) (*ctlclient.BundleDetail, error)
}

func (f *fakeCTL) GetBundleByID(ctx context.Context, bundleID string) (*ctlclient.BundleDetail, error) {
	if f.getBundleByIDFn != nil {
		return f.getBundleByIDFn(ctx, bundleID)
	}
	return nil, errors.New("fakeCTL: GetBundleByID not implemented")
}
func (f *fakeCTL) ListPassesByUser(ctx context.Context, externalUserID string) ([]*ctlclient.PassDetail, error) {
	return nil, errors.New("not used")
}
func (f *fakeCTL) CompletePass(ctx context.Context, req *ctlclient.CompletePassRequest) (*ctlclient.PassDetail, error) {
	return nil, errors.New("not used")
}

type fakeBundleStore struct {
	def *store.BundleDefinition
	err error
}

func (f *fakeBundleStore) GetBundleDefinitionByID(ctx context.Context, bundleID string) (*store.BundleDefinition, error) {
	if f.err != nil {
		return nil, f.err
	}
	return f.def, nil
}

type fakeJifei struct {
	getPriceFn       func(ctx context.Context, req *jifeiclient.GetPriceRequest) (*jifeiclient.GetPriceResponse, error)
	generateDealsFn  func(ctx context.Context, req *jifeiclient.GenerateDealsRequest) (*jifeiclient.GenerateDealsResponse, error)
	getPriceCalls    atomic.Int32
	lastGetPriceArgs *jifeiclient.GetPriceRequest
}

func (f *fakeJifei) GetPrice(ctx context.Context, req *jifeiclient.GetPriceRequest) (*jifeiclient.GetPriceResponse, error) {
	f.getPriceCalls.Add(1)
	f.lastGetPriceArgs = req
	if f.getPriceFn != nil {
		return f.getPriceFn(ctx, req)
	}
	return nil, errors.New("fakeJifei: GetPrice not implemented")
}
func (f *fakeJifei) GenerateDeals(ctx context.Context, req *jifeiclient.GenerateDealsRequest) (*jifeiclient.GenerateDealsResponse, error) {
	if f.generateDealsFn != nil {
		return f.generateDealsFn(ctx, req)
	}
	return nil, errors.New("fakeJifei: GenerateDeals not implemented")
}

// ============================================================================
// helpers
// ============================================================================

func stdBundle() *ctlclient.BundleDetail {
	return &ctlclient.BundleDetail{
		BundleID:    "bundle_linux_small",
		BundleName:  "Linux Small",
		BundleState: "ONLINE",
	}
}

func stdDef() *store.BundleDefinition {
	return &store.BundleDefinition{
		BundleID:       "bundle_linux_small",
		ProductCode:    "p_lighthouse",
		SubProductCode: "sp_linux_small",
		Pid:            "1234",
		CategoryIDs: []store.CategoryIDEntry{
			{Scene: "purchase", Category: "100059"},
		},
		SVList: map[string]interface{}{
			"cpu": "2",
			"mem": "4G",
		},
		ProductInfo: []map[string]interface{}{{"k": "v"}},
	}
}

func stdQuoteReq() QuoteRequest {
	return QuoteRequest{
		ExternalUserID: "user-1",
		Uin:            "1000123456",
		AppID:          "10001",
		BundleID:       "bundle_linux_small",
		TimeSpan:       1,
		TimeUnit:       "m",
		GoodsNum:       1,
		PayMode:        1,
		RegionID:       1,
	}
}

func stdJifeiPriceResp() *jifeiclient.GetPriceResponse {
	return &jifeiclient.GetPriceResponse{
		Data: []jifeiclient.GetPriceData{
			{
				Price:          "39.00",
				TotalCost:      "39.00",
				RealTotalCost:  "35.10",
				Currency:       "CNY",
				TimeUnit:       "m",
				TimeSpan:       1,
				GoodsNum:       1,
				ProductCode:    "p_lighthouse",
				SubProductCode: "sp_linux_small",
				Pid:            "1234",
				PolicyDetail:   &jifeiclient.PolicyDetail{Total: 0.9},
			},
		},
	}
}

// ============================================================================
// happy path
// ============================================================================

func TestQuote_HappyPath(t *testing.T) {
	ctl := &fakeCTL{getBundleByIDFn: func(ctx context.Context, id string) (*ctlclient.BundleDetail, error) {
		return stdBundle(), nil
	}}
	bs := &fakeBundleStore{def: stdDef()}
	jc := &fakeJifei{getPriceFn: func(ctx context.Context, req *jifeiclient.GetPriceRequest) (*jifeiclient.GetPriceResponse, error) {
		return stdJifeiPriceResp(), nil
	}}
	svc := New(Deps{CTLClient: ctl, BundleStore: bs, JifeiClient: jc})

	got, err := svc.Quote(context.Background(), stdQuoteReq())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.BundleID != "bundle_linux_small" {
		t.Errorf("BundleID = %q", got.BundleID)
	}
	if got.RealTotalCost != "35.10" {
		t.Errorf("RealTotalCost = %q, want 35.10", got.RealTotalCost)
	}
	if got.Discount != 0.9 {
		t.Errorf("Discount = %v, want 0.9", got.Discount)
	}
	if got.Pid != "1234" {
		t.Errorf("Pid = %q", got.Pid)
	}

	// 验证 jifei GetPrice 被以正确的入参调用
	args := jc.lastGetPriceArgs
	if args == nil {
		t.Fatal("expected GetPrice to be called")
	}
	if args.OwnerUin != "1000123456" || args.Uin != "1000123456" {
		t.Errorf("OwnerUin/Uin not set correctly: %+v", args)
	}
	if len(args.ResInfo) != 1 {
		t.Fatalf("ResInfo len = %d, want 1", len(args.ResInfo))
	}
	res := args.ResInfo[0]
	if res.GoodsCategoryID != "100059" {
		t.Errorf("GoodsCategoryID = %q, want 100059", res.GoodsCategoryID)
	}
	if res.Action != "purchase" {
		t.Errorf("Action = %q, want purchase", res.Action)
	}
	if res.Currency != "CNY" {
		t.Errorf("Currency = %q, want CNY", res.Currency)
	}
	gd := res.GoodsDetail
	if gd["productCode"] != "p_lighthouse" {
		t.Errorf("goodsDetail.productCode = %v", gd["productCode"])
	}
	if gd["sv_cpu"] != "2" {
		t.Errorf("goodsDetail.sv_cpu = %v, want 2", gd["sv_cpu"])
	}
	if gd["sv_mem"] != "4G" {
		t.Errorf("goodsDetail.sv_mem = %v, want 4G", gd["sv_mem"])
	}
}

// ============================================================================
// 入参校验
// ============================================================================

func TestQuote_InvalidInput_Empty(t *testing.T) {
	svc := newSvcStub()
	cases := []struct {
		name string
		req  QuoteRequest
		want string
	}{
		{"missing bundle", QuoteRequest{Uin: "u", TimeSpan: 1, TimeUnit: "m"}, "bundle_id"},
		{"missing uin", QuoteRequest{BundleID: "b", TimeSpan: 1, TimeUnit: "m"}, "uin"},
		{"zero time_span", QuoteRequest{BundleID: "b", Uin: "u", TimeSpan: 0, TimeUnit: "m"}, "time_span"},
		{"missing time_unit", QuoteRequest{BundleID: "b", Uin: "u", TimeSpan: 1}, "time_unit"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, err := svc.Quote(context.Background(), c.req)
			if err == nil || !errors.Is(err, ErrInvalidInput) || !strings.Contains(err.Error(), c.want) {
				t.Errorf("err = %v, want ErrInvalidInput containing %q", err, c.want)
			}
		})
	}
}

// ============================================================================
// ctl 错误分类
// ============================================================================

func TestQuote_BundleNotFound_FromCTL(t *testing.T) {
	svc := New(Deps{
		CTLClient: &fakeCTL{getBundleByIDFn: func(ctx context.Context, id string) (*ctlclient.BundleDetail, error) {
			return nil, ctlclient.ErrNotFound
		}},
		BundleStore: &fakeBundleStore{},
		JifeiClient: &fakeJifei{},
	})
	_, err := svc.Quote(context.Background(), stdQuoteReq())
	if err == nil || !errors.Is(err, ErrBundleNotFound) {
		t.Errorf("err = %v, want ErrBundleNotFound", err)
	}
}

func TestQuote_BundleOffline(t *testing.T) {
	bundle := stdBundle()
	bundle.BundleState = "OFFLINE"
	svc := New(Deps{
		CTLClient: &fakeCTL{getBundleByIDFn: func(ctx context.Context, id string) (*ctlclient.BundleDetail, error) {
			return bundle, nil
		}},
		BundleStore: &fakeBundleStore{def: stdDef()},
		JifeiClient: &fakeJifei{},
	})
	_, err := svc.Quote(context.Background(), stdQuoteReq())
	if err == nil || !errors.Is(err, ErrBundleOffline) {
		t.Errorf("err = %v, want ErrBundleOffline", err)
	}
}

func TestQuote_CTL5xx_Wrapped(t *testing.T) {
	svc := New(Deps{
		CTLClient: &fakeCTL{getBundleByIDFn: func(ctx context.Context, id string) (*ctlclient.BundleDetail, error) {
			return nil, &ctlclient.Error{HTTPStatus: 503, Code: "INTERNAL"}
		}},
		BundleStore: &fakeBundleStore{def: stdDef()},
		JifeiClient: &fakeJifei{},
	})
	_, err := svc.Quote(context.Background(), stdQuoteReq())
	if err == nil {
		t.Fatal("expected error")
	}
	// 5xx 不应被映射为 BundleNotFound / BundleOffline / InvalidInput
	if errors.Is(err, ErrBundleNotFound) || errors.Is(err, ErrBundleOffline) || errors.Is(err, ErrInvalidInput) {
		t.Errorf("ctl 5xx should not be classified as business error: %v", err)
	}
}

// ============================================================================
// trade_bundle_definition 错误分类
// ============================================================================

func TestQuote_BundleDefinitionNotFound(t *testing.T) {
	svc := New(Deps{
		CTLClient: &fakeCTL{getBundleByIDFn: func(ctx context.Context, id string) (*ctlclient.BundleDetail, error) {
			return stdBundle(), nil
		}},
		BundleStore: &fakeBundleStore{err: store.ErrBundleDefinitionNotFound},
		JifeiClient: &fakeJifei{},
	})
	_, err := svc.Quote(context.Background(), stdQuoteReq())
	if err == nil || !errors.Is(err, ErrBundleNotFound) {
		t.Errorf("err = %v, want ErrBundleNotFound", err)
	}
}

func TestQuote_MissingPurchaseCategory(t *testing.T) {
	def := stdDef()
	def.CategoryIDs = []store.CategoryIDEntry{{Scene: "renew", Category: "X"}} // 缺 purchase
	svc := New(Deps{
		CTLClient:   &fakeCTL{getBundleByIDFn: func(ctx context.Context, id string) (*ctlclient.BundleDetail, error) { return stdBundle(), nil }},
		BundleStore: &fakeBundleStore{def: def},
		JifeiClient: &fakeJifei{},
	})
	_, err := svc.Quote(context.Background(), stdQuoteReq())
	if err == nil || !strings.Contains(err.Error(), "category_ids[scene=purchase]") {
		t.Errorf("err = %v, want missing purchase category", err)
	}
}

// ============================================================================
// jifei CGW 错误透传
// ============================================================================

func TestQuote_JifeiBusinessError_Wrapped(t *testing.T) {
	svc := New(Deps{
		CTLClient:   &fakeCTL{getBundleByIDFn: func(ctx context.Context, id string) (*ctlclient.BundleDetail, error) { return stdBundle(), nil }},
		BundleStore: &fakeBundleStore{def: stdDef()},
		JifeiClient: &fakeJifei{getPriceFn: func(ctx context.Context, req *jifeiclient.GetPriceRequest) (*jifeiclient.GetPriceResponse, error) {
			return nil, &jifeiclient.CGWError{ReturnCode: -1001, ReturnMessage: "category invalid"}
		}},
	})
	_, err := svc.Quote(context.Background(), stdQuoteReq())
	if err == nil {
		t.Fatal("expected error")
	}
	var cgw *jifeiclient.CGWError
	if !errors.As(err, &cgw) {
		t.Errorf("err = %v, want errors.As *CGWError", err)
	}
}

func TestQuote_JifeiEmptyData(t *testing.T) {
	svc := New(Deps{
		CTLClient:   &fakeCTL{getBundleByIDFn: func(ctx context.Context, id string) (*ctlclient.BundleDetail, error) { return stdBundle(), nil }},
		BundleStore: &fakeBundleStore{def: stdDef()},
		JifeiClient: &fakeJifei{getPriceFn: func(ctx context.Context, req *jifeiclient.GetPriceRequest) (*jifeiclient.GetPriceResponse, error) {
			return &jifeiclient.GetPriceResponse{Data: nil}, nil
		}},
	})
	_, err := svc.Quote(context.Background(), stdQuoteReq())
	if err == nil || !strings.Contains(err.Error(), "empty data") {
		t.Errorf("err = %v, want empty data", err)
	}
}

// ============================================================================
// 兜底：jifei 出参字段缺失时回填 BundleDefinition 值
// ============================================================================

func TestQuote_FallbackFromBundleDefinition(t *testing.T) {
	svc := New(Deps{
		CTLClient:   &fakeCTL{getBundleByIDFn: func(ctx context.Context, id string) (*ctlclient.BundleDetail, error) { return stdBundle(), nil }},
		BundleStore: &fakeBundleStore{def: stdDef()},
		JifeiClient: &fakeJifei{getPriceFn: func(ctx context.Context, req *jifeiclient.GetPriceRequest) (*jifeiclient.GetPriceResponse, error) {
			// 故意返回 productCode / pid / timeSpan 等空字段
			return &jifeiclient.GetPriceResponse{Data: []jifeiclient.GetPriceData{
				{Price: "1.00", TotalCost: "1.00", RealTotalCost: "1.00", Currency: "CNY"},
			}}, nil
		}},
	})
	got, err := svc.Quote(context.Background(), stdQuoteReq())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.ProductCode != "p_lighthouse" || got.SubProductCode != "sp_linux_small" || got.Pid != "1234" {
		t.Errorf("fallback failed: got %+v", got)
	}
	if got.TimeSpan != 1 || got.TimeUnit != "m" || got.GoodsNum != 1 {
		t.Errorf("time fields fallback failed: got %+v", got)
	}
}

// ============================================================================
// New nil deps panic
// ============================================================================

func TestNew_NilCTL_Panics(t *testing.T) {
	defer func() {
		if r := recover(); r == nil {
			t.Fatal("expected panic")
		}
	}()
	New(Deps{BundleStore: &fakeBundleStore{}, JifeiClient: &fakeJifei{}})
}

func TestNew_NilBundleStore_Panics(t *testing.T) {
	defer func() {
		if r := recover(); r == nil {
			t.Fatal("expected panic")
		}
	}()
	New(Deps{CTLClient: &fakeCTL{}, JifeiClient: &fakeJifei{}})
}

func TestNew_NilJifeiClient_Panics(t *testing.T) {
	defer func() {
		if r := recover(); r == nil {
			t.Fatal("expected panic")
		}
	}()
	New(Deps{CTLClient: &fakeCTL{}, BundleStore: &fakeBundleStore{}})
}

// ============================================================================
// stringify 行为
// ============================================================================

func TestStringify(t *testing.T) {
	cases := []struct {
		in  interface{}
		out string
	}{
		{nil, ""},
		{"abc", "abc"},
		{float64(2), "2"},
		{float64(2.5), "2.5"},
		{int(3), "3"},
		{int64(4), "4"},
		{true, "true"},
		{false, "false"},
	}
	for _, c := range cases {
		if got := stringify(c.in); got != c.out {
			t.Errorf("stringify(%v) = %q, want %q", c.in, got, c.out)
		}
	}
}

// ============================================================================
// helpers
// ============================================================================

func newSvcStub() *Service {
	return New(Deps{
		CTLClient:   &fakeCTL{},
		BundleStore: &fakeBundleStore{},
		JifeiClient: &fakeJifei{},
	})
}

// ============================================================================
// 8B-1: shadow client integration tests
// ============================================================================

// fakeShadow 是 inquiry 测试用的 shadowclient.Client mock。
type fakeShadow struct {
	getBindingFn   func(ctx context.Context, externalUserID string) (*shadowclient.Binding, error)
	calls          atomic.Int32
	lastExternalID string
}

func (f *fakeShadow) GetBindingByExternalUserID(ctx context.Context, externalUserID string) (*shadowclient.Binding, error) {
	f.calls.Add(1)
	f.lastExternalID = externalUserID
	if f.getBindingFn != nil {
		return f.getBindingFn(ctx, externalUserID)
	}
	return nil, errors.New("fakeShadow: GetBindingByExternalUserID not implemented")
}

// 当 ShadowClient 注入 + 调用方未传 Uin/AppID 时，service 应反查 shadow 回填这两个字段。
func TestQuote_ShadowClient_BackfillUinAndAppID(t *testing.T) {
	shadow := &fakeShadow{
		getBindingFn: func(ctx context.Context, externalUserID string) (*shadowclient.Binding, error) {
			return &shadowclient.Binding{
				UserID:   externalUserID,
				Uin:      "9999888",
				OwnerUin: "9999888",
				AppID:    "12345",
			}, nil
		},
	}
	jifei := &fakeJifei{
		getPriceFn: func(ctx context.Context, req *jifeiclient.GetPriceRequest) (*jifeiclient.GetPriceResponse, error) {
			return stdJifeiPriceResp(), nil
		},
	}
	svc := New(Deps{
		CTLClient:    &fakeCTL{getBundleByIDFn: func(_ context.Context, _ string) (*ctlclient.BundleDetail, error) { return stdBundle(), nil }},
		BundleStore:  &fakeBundleStore{def: stdDef()},
		JifeiClient:  jifei,
		ShadowClient: shadow,
	})

	req := stdQuoteReq()
	req.Uin = ""
	req.AppID = ""
	if _, err := svc.Quote(context.Background(), req); err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if shadow.calls.Load() != 1 {
		t.Errorf("shadow calls = %d, want 1", shadow.calls.Load())
	}
	if shadow.lastExternalID != "user-1" {
		t.Errorf("shadow lastExternalID = %q, want user-1", shadow.lastExternalID)
	}
	if jifei.lastGetPriceArgs == nil || jifei.lastGetPriceArgs.Uin != "9999888" {
		t.Errorf("jifei.Uin = %q, want 9999888 (backfilled from shadow)",
			func() string {
				if jifei.lastGetPriceArgs == nil {
					return "<nil>"
				}
				return jifei.lastGetPriceArgs.Uin
			}())
	}
}

// 当调用方已传 Uin 时，即使 ShadowClient 注入也不应被调用（保持显式入参优先）。
func TestQuote_ShadowClient_SkippedWhenUinProvided(t *testing.T) {
	shadow := &fakeShadow{
		getBindingFn: func(_ context.Context, _ string) (*shadowclient.Binding, error) {
			t.Fatal("shadow should NOT be called when Uin is provided")
			return nil, nil
		},
	}
	jifei := &fakeJifei{
		getPriceFn: func(_ context.Context, _ *jifeiclient.GetPriceRequest) (*jifeiclient.GetPriceResponse, error) {
			return stdJifeiPriceResp(), nil
		},
	}
	svc := New(Deps{
		CTLClient:    &fakeCTL{getBundleByIDFn: func(_ context.Context, _ string) (*ctlclient.BundleDetail, error) { return stdBundle(), nil }},
		BundleStore:  &fakeBundleStore{def: stdDef()},
		JifeiClient:  jifei,
		ShadowClient: shadow,
	})
	req := stdQuoteReq() // Uin = "1000123456" 已显式提供
	if _, err := svc.Quote(context.Background(), req); err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if shadow.calls.Load() != 0 {
		t.Errorf("shadow calls = %d, want 0", shadow.calls.Load())
	}
}

// shadow 反查返 ErrBindingNotFound → service 映射为 inquiry.ErrBindingNotFound 业务错。
func TestQuote_ShadowClient_BindingNotFound(t *testing.T) {
	shadow := &fakeShadow{
		getBindingFn: func(_ context.Context, _ string) (*shadowclient.Binding, error) {
			return nil, shadowclient.ErrBindingNotFound
		},
	}
	svc := New(Deps{
		CTLClient:    &fakeCTL{},
		BundleStore:  &fakeBundleStore{def: stdDef()},
		JifeiClient:  &fakeJifei{},
		ShadowClient: shadow,
	})
	req := stdQuoteReq()
	req.Uin = ""
	req.AppID = ""
	_, err := svc.Quote(context.Background(), req)
	if err == nil {
		t.Fatal("want err")
	}
	if !errors.Is(err, ErrBindingNotFound) {
		t.Errorf("err = %v, want ErrBindingNotFound", err)
	}
}

// shadow 反查返其他错误 → service 透传（5xx 排障）。
func TestQuote_ShadowClient_UpstreamError(t *testing.T) {
	upstreamErr := errors.New("shadow 503 service unavailable")
	shadow := &fakeShadow{
		getBindingFn: func(_ context.Context, _ string) (*shadowclient.Binding, error) {
			return nil, upstreamErr
		},
	}
	svc := New(Deps{
		CTLClient:    &fakeCTL{},
		BundleStore:  &fakeBundleStore{def: stdDef()},
		JifeiClient:  &fakeJifei{},
		ShadowClient: shadow,
	})
	req := stdQuoteReq()
	req.Uin = ""
	_, err := svc.Quote(context.Background(), req)
	if err == nil {
		t.Fatal("want err")
	}
	if !errors.Is(err, upstreamErr) {
		t.Errorf("err = %v, want wrap upstream err", err)
	}
}

// 当 ShadowClient 注入但 ExternalUserID 也空 → 直接 ErrInvalidInput（无法身份溯源）。
func TestQuote_ShadowClient_NoIdentityAnchor(t *testing.T) {
	svc := New(Deps{
		CTLClient:    &fakeCTL{},
		BundleStore:  &fakeBundleStore{def: stdDef()},
		JifeiClient:  &fakeJifei{},
		ShadowClient: &fakeShadow{},
	})
	req := stdQuoteReq()
	req.Uin = ""
	req.AppID = ""
	req.ExternalUserID = ""
	_, err := svc.Quote(context.Background(), req)
	if err == nil {
		t.Fatal("want err")
	}
	if !errors.Is(err, ErrInvalidInput) {
		t.Errorf("err = %v, want ErrInvalidInput", err)
	}
	if !strings.Contains(err.Error(), "external_user_id or uin is required") {
		t.Errorf("err = %v, want 'external_user_id or uin is required' substring", err)
	}
}

// shadow 返回成功但 Uin 为空 → 也算 binding not found（防御 shadow 写入半残数据）。
func TestQuote_ShadowClient_EmptyUinReturned(t *testing.T) {
	shadow := &fakeShadow{
		getBindingFn: func(_ context.Context, _ string) (*shadowclient.Binding, error) {
			return &shadowclient.Binding{UserID: "user-1", Uin: "", AppID: "12345"}, nil
		},
	}
	svc := New(Deps{
		CTLClient:    &fakeCTL{},
		BundleStore:  &fakeBundleStore{def: stdDef()},
		JifeiClient:  &fakeJifei{},
		ShadowClient: shadow,
	})
	req := stdQuoteReq()
	req.Uin = ""
	_, err := svc.Quote(context.Background(), req)
	if err == nil {
		t.Fatal("want err")
	}
	if !errors.Is(err, ErrBindingNotFound) {
		t.Errorf("err = %v, want ErrBindingNotFound", err)
	}
}

