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
func (f *fakeCTL) ListPassAppIDs(_ context.Context, _ []string, _, _ int) ([]int64, int64, error) {
	return nil, 0, errors.New("not used")
}
func (f *fakeCTL) ListPassesByAppID(_ context.Context, _ int64, _ []string, _, _ int) ([]*ctlclient.PassDetail, int64, error) {
	return nil, 0, errors.New("not used")
}
func (f *fakeCTL) ListPassesByResourceIDs(_ context.Context, _ int64, _ []string) ([]*ctlclient.PassDetail, error) {
	return nil, errors.New("not used")
}

func (f *fakeCTL) IsolatePass(_ context.Context, _ string, _ *ctlclient.IsolatePassRequest) (*ctlclient.IsolatePassResponse, error) {
	return nil, errors.New("IsolatePass not used in inquiry tests")
}

func (f *fakeCTL) RenewPass(_ context.Context, _ string, _ *ctlclient.RenewPassRequest) (*ctlclient.RenewPassResponse, error) {
	return nil, errors.New("RenewPass not used in inquiry tests")
}

func (f *fakeCTL) DestroyPass(_ context.Context, _ string, _ *ctlclient.DestroyPassRequest) (*ctlclient.DestroyPassResponse, error) {
	return nil, errors.New("DestroyPass not used in inquiry tests")
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
func (f *fakeBundleStore) ListBundleDefsBySubProductCode(_ context.Context, _, _ string) ([]*store.BundleDefinition, error) {
	return nil, errors.New("ListBundleDefsBySubProductCode not used in inquiry")
}
func (f *fakeBundleStore) GetBundleDefinitionsByIDs(_ context.Context, _ []string) (map[string]*store.BundleDefinition, error) {
	return nil, errors.New("GetBundleDefinitionsByIDs not used in inquiry")
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
func (f *fakeJifei) GenerateDealsAndPay(ctx context.Context, req *jifeiclient.GenerateDealsAndPayRequest) (*jifeiclient.GenerateDealsAndPayResponse, error) {
	// inquiry service 不会调 GenerateDealsAndPay，本方法仅为满足 interface 实现
	return nil, errors.New("fakeJifei: GenerateDealsAndPay not used by inquiry")
}
func (f *fakeJifei) GetMidasEarmarking(ctx context.Context, req *jifeiclient.GetMidasEarmarkingRequest) (*jifeiclient.GetMidasEarmarkingResponse, error) {
	// inquiry service 不会调 GetMidasEarmarking，本方法仅为满足 interface 实现
	return nil, errors.New("fakeJifei: GetMidasEarmarking not used by inquiry")
}

func (f *fakeJifei) ModifyResourceStatus(ctx context.Context, req *jifeiclient.ModifyResourceStatusRequest) (*jifeiclient.ModifyResourceStatusResponse, error) {
	// inquiry service 不会调 ModifyResourceStatus，本方法仅为满足 interface 实现（D-2.1 引入）
	return nil, errors.New("fakeJifei: ModifyResourceStatus not used by inquiry")
}

func (f *fakeJifei) GetDealsByKeyIndex(ctx context.Context, req *jifeiclient.GetDealsByKeyIndexRequest) (*jifeiclient.GetDealsByKeyIndexResponse, error) {
	// inquiry service 不会调 GetDealsByKeyIndex，本方法仅为满足 interface 实现（v1.7.32 订单状态反查引入）
	return nil, errors.New("fakeJifei: GetDealsByKeyIndex not used by inquiry")
}

func (f *fakeJifei) OnlineRefund(ctx context.Context, req *jifeiclient.OnlineRefundRequest) (*jifeiclient.OnlineRefundResponse, error) {
	// inquiry service 不调 OnlineRefund，本方法仅为满足 interface 实现（trade-pass-refund-design.md v0.5 引入）
	return nil, errors.New("fakeJifei: OnlineRefund not used by inquiry")
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
		Pid:            1234,
		CategoryIDs: []store.CategoryIDEntry{
			{Scene: "purchase", Category: 100059},
		},
		// Q71（2026-05-13）：SVList 强类型 map[string]int64，与 jifei 协议 sv_* int 一致。
		SVList: map[string]int64{
			"sv_cpu": 2,
			"sv_mem": 4,
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
		// Q41 修订 2026-05-11：RegionID 字段已删除，trade 内部固定 1（广州）
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
				Pid:            1234,
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
	if got.Pid != 1234 {
		t.Errorf("Pid = %d", got.Pid)
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
	if res.GoodsCategoryID != 100059 {
		t.Errorf("GoodsCategoryID = %d, want 100059", res.GoodsCategoryID)
	}
	// v1.7.x B17：jifei PDF明示「有 categoryid 则不用传 action」，生产路径不再传 action。
	if res.Action != "" {
		t.Errorf("Action = %q, want empty (PDF: when categoryId is set, action must be omitted)", res.Action)
	}
	if res.Currency != "CNY" {
		t.Errorf("Currency = %q, want CNY", res.Currency)
	}
	gd := res.GoodsDetail
	if gd["productCode"] != "p_lighthouse" {
		t.Errorf("goodsDetail.productCode = %v", gd["productCode"])
	}
	// Q71：sv_* 值是 int64 直接透传到 jifei wire（不再 stringify）
	if gd["sv_cpu"] != int64(2) {
		t.Errorf("goodsDetail.sv_cpu = %v, want int64(2)", gd["sv_cpu"])
	}
	if gd["sv_mem"] != int64(4) {
		t.Errorf("goodsDetail.sv_mem = %v, want int64(4)", gd["sv_mem"])
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
	def.CategoryIDs = []store.CategoryIDEntry{{Scene: "renew", Category: 999}} // 缺 purchase
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
	if got.ProductCode != "p_lighthouse" || got.SubProductCode != "sp_linux_small" || got.Pid != 1234 {
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

// shadow 反查返 ErrBindingNotFound → 仅询价链路使用固定账号兜底，付费下单仍强校验。
func TestQuote_ShadowClient_BindingNotFoundUsesFallbackIdentity(t *testing.T) {
	const (
		fallbackUin   = "fallback-uin"
		fallbackAppID = "fallback-app"
	)
	shadow := &fakeShadow{
		getBindingFn: func(_ context.Context, _ string) (*shadowclient.Binding, error) {
			return nil, shadowclient.ErrBindingNotFound
		},
	}
	jifei := &fakeJifei{
		getPriceFn: func(_ context.Context, _ *jifeiclient.GetPriceRequest) (*jifeiclient.GetPriceResponse, error) {
			return stdJifeiPriceResp(), nil
		},
	}
	svc := New(Deps{
		CTLClient:            &fakeCTL{getBundleByIDFn: func(_ context.Context, _ string) (*ctlclient.BundleDetail, error) { return stdBundle(), nil }},
		BundleStore:          &fakeBundleStore{def: stdDef()},
		JifeiClient:          jifei,
		ShadowClient:         shadow,
		InquiryFallbackUin:   fallbackUin,
		InquiryFallbackAppID: fallbackAppID,
	})
	req := stdQuoteReq()
	req.Uin = ""
	req.AppID = ""
	if _, err := svc.Quote(context.Background(), req); err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if jifei.lastGetPriceArgs == nil {
		t.Fatal("expected jifei GetPrice to be called")
	}
	if jifei.lastGetPriceArgs.OwnerUin != fallbackUin || jifei.lastGetPriceArgs.Uin != fallbackUin {
		t.Errorf("jifei OwnerUin/Uin = %q/%q, want fallback %s",
			jifei.lastGetPriceArgs.OwnerUin, jifei.lastGetPriceArgs.Uin, fallbackUin)
	}
}

// shadow 反查返 ErrBindingNotFound 且未配置询价兜底 → 保持原业务错语义。
func TestQuote_ShadowClient_BindingNotFoundWithoutFallback(t *testing.T) {
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

// shadow 返回成功但 Uin 为空 → 询价链路同样使用固定账号兜底（防御 shadow 半残数据）。
func TestQuote_ShadowClient_EmptyUinReturnedUsesFallbackIdentity(t *testing.T) {
	const (
		fallbackUin   = "fallback-uin"
		fallbackAppID = "fallback-app"
	)
	shadow := &fakeShadow{
		getBindingFn: func(_ context.Context, _ string) (*shadowclient.Binding, error) {
			return &shadowclient.Binding{UserID: "user-1", Uin: "", AppID: "12345"}, nil
		},
	}
	jifei := &fakeJifei{
		getPriceFn: func(_ context.Context, _ *jifeiclient.GetPriceRequest) (*jifeiclient.GetPriceResponse, error) {
			return stdJifeiPriceResp(), nil
		},
	}
	svc := New(Deps{
		CTLClient:            &fakeCTL{getBundleByIDFn: func(_ context.Context, _ string) (*ctlclient.BundleDetail, error) { return stdBundle(), nil }},
		BundleStore:          &fakeBundleStore{def: stdDef()},
		JifeiClient:          jifei,
		ShadowClient:         shadow,
		InquiryFallbackUin:   fallbackUin,
		InquiryFallbackAppID: fallbackAppID,
	})
	req := stdQuoteReq()
	req.Uin = ""
	req.AppID = ""
	if _, err := svc.Quote(context.Background(), req); err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if jifei.lastGetPriceArgs == nil {
		t.Fatal("expected jifei GetPrice to be called")
	}
	if jifei.lastGetPriceArgs.Uin != fallbackUin {
		t.Errorf("jifei.Uin = %q, want fallback %s", jifei.lastGetPriceArgs.Uin, fallbackUin)
	}
}

// ============================================================================
// R-C-4：QuoteRenew 续费询价测试（设计稿 §3.5 / Q42 / Q47 / Q50 / R-C-4）
// ============================================================================

// stdRenewDef 与 stdDef 对偶，但 CategoryIDs 同时含 "renew" 场景（与运营录入的真实数据形态对齐）。
func stdRenewDef() *store.BundleDefinition {
	return &store.BundleDefinition{
		BundleID:       "bundle_linux_small",
		ProductCode:    "p_lighthouse",
		SubProductCode: "sp_linux_small",
		Pid:            1234,
		CategoryIDs: []store.CategoryIDEntry{
			{Scene: "purchase", Category: 100059},
			{Scene: "renew", Category: 100060},
		},
		SVList: map[string]int64{
			"sv_cpu": 2,
			"sv_mem": 4,
		},
		ProductInfo: []map[string]interface{}{{"k": "v"}},
	}
}

// stdQuoteRenewReq 与 stdQuoteReq 对偶，附加 ResourceID。
func stdQuoteRenewReq() QuoteRenewRequest {
	return QuoteRenewRequest{
		ExternalUserID: "user-1",
		Uin:            "1000123456",
		AppID:          "10001",
		BundleID:       "bundle_linux_small",
		ResourceID:     "lhpass-r1",
		CurDeadline:    "2026-06-15 10:30:00", // PDF §4.3 续费必填; v1.7.21 B16
		TimeSpan:       1,
		TimeUnit:       "m",
		GoodsNum:       1,
		PayMode:        1,
	}
}

// QuoteRenew Happy path：覆盖 jifei Action="renew"、goodsCategoryId 取 scene=renew、
// goodsDetail 注入 resourceId、其余字段透传与 Quote 一致。
func TestQuoteRenew_HappyPath(t *testing.T) {
	ctl := &fakeCTL{getBundleByIDFn: func(_ context.Context, _ string) (*ctlclient.BundleDetail, error) {
		return stdBundle(), nil
	}}
	bs := &fakeBundleStore{def: stdRenewDef()}
	jc := &fakeJifei{getPriceFn: func(_ context.Context, _ *jifeiclient.GetPriceRequest) (*jifeiclient.GetPriceResponse, error) {
		return stdJifeiPriceResp(), nil
	}}
	svc := New(Deps{CTLClient: ctl, BundleStore: bs, JifeiClient: jc})

	got, err := svc.QuoteRenew(context.Background(), stdQuoteRenewReq())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.BundleID != "bundle_linux_small" {
		t.Errorf("BundleID = %q", got.BundleID)
	}
	if got.RealTotalCost != "35.10" {
		t.Errorf("RealTotalCost = %q, want 35.10", got.RealTotalCost)
	}
	if got.Pid != 1234 {
		t.Errorf("Pid = %d, want 1234", got.Pid)
	}

	// 验证 jifei GetPrice 入参对续费的关键字段
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
	// v1.7.x B17：jifei PDF明示「有 categoryid 则不用传 action」，续费同款不再传 action。
	if res.Action != "" {
		t.Errorf("Action = %q, want empty (PDF: when categoryId is set, action must be omitted)", res.Action)
	}
	if res.GoodsCategoryID != 100060 {
		t.Errorf("GoodsCategoryID = %d, want 100060 (scene=renew)", res.GoodsCategoryID)
	}
	if res.Currency != "CNY" {
		t.Errorf("Currency = %q, want CNY", res.Currency)
	}
	gd := res.GoodsDetail
	if gd["resourceId"] != "lhpass-r1" {
		t.Errorf("goodsDetail.resourceId = %v, want lhpass-r1", gd["resourceId"])
	}
	// v1.7.21 B16: 续费询价同样透传 curDeadline (PDF §4.3 必填; 与续费下单同源)
	if gd["curDeadline"] != "2026-06-15 10:30:00" {
		t.Errorf("goodsDetail.curDeadline = %v, want 2026-06-15 10:30:00", gd["curDeadline"])
	}
	if gd["productCode"] != "p_lighthouse" {
		t.Errorf("goodsDetail.productCode = %v", gd["productCode"])
	}
	if gd["sv_cpu"] != int64(2) {
		t.Errorf("goodsDetail.sv_cpu = %v, want int64(2)", gd["sv_cpu"])
	}
	if gd["timeSpan"] != 1 || gd["timeUnit"] != "m" || gd["goodsNum"] != 1 {
		t.Errorf("timeSpan/timeUnit/goodsNum mis-set in goodsDetail: %+v", gd)
	}
}

// QuoteRenew 入参校验：ResourceID 必填新增；其余与 Quote 一致。
func TestQuoteRenew_InvalidInput(t *testing.T) {
	svc := newSvcStub()
	cases := []struct {
		name string
		req  QuoteRenewRequest
		want string
	}{
		{"missing bundle", QuoteRenewRequest{Uin: "u", ResourceID: "r", CurDeadline: "2026-06-15 10:30:00", TimeSpan: 1, TimeUnit: "m"}, "bundle_id"},
		{"missing resource_id", QuoteRenewRequest{BundleID: "b", Uin: "u", TimeSpan: 1, TimeUnit: "m"}, "resource_id"},
		// v1.7.21 B16: cur_deadline 必填 (PDF §4.3 续费独有 + 与续费下单同源)
		{"missing cur_deadline", QuoteRenewRequest{BundleID: "b", Uin: "u", ResourceID: "r", TimeSpan: 1, TimeUnit: "m"}, "cur_deadline"},
		{"missing uin (no shadow)", QuoteRenewRequest{BundleID: "b", ResourceID: "r", CurDeadline: "2026-06-15 10:30:00", TimeSpan: 1, TimeUnit: "m"}, "uin"},
		{"zero time_span", QuoteRenewRequest{BundleID: "b", Uin: "u", ResourceID: "r", CurDeadline: "2026-06-15 10:30:00", TimeSpan: 0, TimeUnit: "m"}, "time_span"},
		{"missing time_unit", QuoteRenewRequest{BundleID: "b", Uin: "u", ResourceID: "r", CurDeadline: "2026-06-15 10:30:00", TimeSpan: 1}, "time_unit"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, err := svc.QuoteRenew(context.Background(), c.req)
			if err == nil || !errors.Is(err, ErrInvalidInput) || !strings.Contains(err.Error(), c.want) {
				t.Errorf("err = %v, want ErrInvalidInput containing %q", err, c.want)
			}
		})
	}
}

// QuoteRenew bundle 不存在 → ErrBundleNotFound（与 Quote 对偶）。
func TestQuoteRenew_BundleNotFound_FromCTL(t *testing.T) {
	svc := New(Deps{
		CTLClient: &fakeCTL{getBundleByIDFn: func(_ context.Context, _ string) (*ctlclient.BundleDetail, error) {
			return nil, ctlclient.ErrNotFound
		}},
		BundleStore: &fakeBundleStore{},
		JifeiClient: &fakeJifei{},
	})
	_, err := svc.QuoteRenew(context.Background(), stdQuoteRenewReq())
	if err == nil || !errors.Is(err, ErrBundleNotFound) {
		t.Errorf("err = %v, want ErrBundleNotFound", err)
	}
}

// QuoteRenew bundle 已下架 → ErrBundleOffline（设计稿语义：下架的 bundle 不可续费）。
func TestQuoteRenew_BundleOffline(t *testing.T) {
	bundle := stdBundle()
	bundle.BundleState = "OFFLINE"
	svc := New(Deps{
		CTLClient: &fakeCTL{getBundleByIDFn: func(_ context.Context, _ string) (*ctlclient.BundleDetail, error) {
			return bundle, nil
		}},
		BundleStore: &fakeBundleStore{def: stdRenewDef()},
		JifeiClient: &fakeJifei{},
	})
	_, err := svc.QuoteRenew(context.Background(), stdQuoteRenewReq())
	if err == nil || !errors.Is(err, ErrBundleOffline) {
		t.Errorf("err = %v, want ErrBundleOffline", err)
	}
}

// QuoteRenew trade_bundle_definition 不存在 → ErrBundleNotFound。
func TestQuoteRenew_BundleDefinitionNotFound(t *testing.T) {
	svc := New(Deps{
		CTLClient:   &fakeCTL{getBundleByIDFn: func(_ context.Context, _ string) (*ctlclient.BundleDetail, error) { return stdBundle(), nil }},
		BundleStore: &fakeBundleStore{err: store.ErrBundleDefinitionNotFound},
		JifeiClient: &fakeJifei{},
	})
	_, err := svc.QuoteRenew(context.Background(), stdQuoteRenewReq())
	if err == nil || !errors.Is(err, ErrBundleNotFound) {
		t.Errorf("err = %v, want ErrBundleNotFound", err)
	}
}

// QuoteRenew 缺 scene=renew categoryId → 报"missing category_ids[scene=renew]"。
func TestQuoteRenew_MissingRenewCategory(t *testing.T) {
	def := stdRenewDef()
	def.CategoryIDs = []store.CategoryIDEntry{{Scene: "purchase", Category: 100059}} // 缺 renew
	svc := New(Deps{
		CTLClient:   &fakeCTL{getBundleByIDFn: func(_ context.Context, _ string) (*ctlclient.BundleDetail, error) { return stdBundle(), nil }},
		BundleStore: &fakeBundleStore{def: def},
		JifeiClient: &fakeJifei{},
	})
	_, err := svc.QuoteRenew(context.Background(), stdQuoteRenewReq())
	if err == nil || !strings.Contains(err.Error(), "category_ids[scene=renew]") {
		t.Errorf("err = %v, want missing renew category", err)
	}
}

// QuoteRenew jifei CGW 业务错 → 透传 *CGWError。
func TestQuoteRenew_JifeiBusinessError_Wrapped(t *testing.T) {
	svc := New(Deps{
		CTLClient:   &fakeCTL{getBundleByIDFn: func(_ context.Context, _ string) (*ctlclient.BundleDetail, error) { return stdBundle(), nil }},
		BundleStore: &fakeBundleStore{def: stdRenewDef()},
		JifeiClient: &fakeJifei{getPriceFn: func(_ context.Context, _ *jifeiclient.GetPriceRequest) (*jifeiclient.GetPriceResponse, error) {
			return nil, &jifeiclient.CGWError{ReturnCode: -1001, ReturnMessage: "category invalid"}
		}},
	})
	_, err := svc.QuoteRenew(context.Background(), stdQuoteRenewReq())
	if err == nil {
		t.Fatal("expected error")
	}
	var cgw *jifeiclient.CGWError
	if !errors.As(err, &cgw) {
		t.Errorf("err = %v, want errors.As *CGWError", err)
	}
	if !strings.Contains(err.Error(), "renew") {
		t.Errorf("err = %v, want '(renew)' marker for trace", err)
	}
}

// QuoteRenew jifei 返空 data → 报"empty data"。
func TestQuoteRenew_JifeiEmptyData(t *testing.T) {
	svc := New(Deps{
		CTLClient:   &fakeCTL{getBundleByIDFn: func(_ context.Context, _ string) (*ctlclient.BundleDetail, error) { return stdBundle(), nil }},
		BundleStore: &fakeBundleStore{def: stdRenewDef()},
		JifeiClient: &fakeJifei{getPriceFn: func(_ context.Context, _ *jifeiclient.GetPriceRequest) (*jifeiclient.GetPriceResponse, error) {
			return &jifeiclient.GetPriceResponse{Data: nil}, nil
		}},
	})
	_, err := svc.QuoteRenew(context.Background(), stdQuoteRenewReq())
	if err == nil || !strings.Contains(err.Error(), "empty data") {
		t.Errorf("err = %v, want empty data", err)
	}
}

// QuoteRenew 兜底字段回填：jifei 出参 productCode/pid/timeSpan 等为空时回填 BundleDefinition / req。
func TestQuoteRenew_FallbackFromBundleDefinition(t *testing.T) {
	svc := New(Deps{
		CTLClient:   &fakeCTL{getBundleByIDFn: func(_ context.Context, _ string) (*ctlclient.BundleDetail, error) { return stdBundle(), nil }},
		BundleStore: &fakeBundleStore{def: stdRenewDef()},
		JifeiClient: &fakeJifei{getPriceFn: func(_ context.Context, _ *jifeiclient.GetPriceRequest) (*jifeiclient.GetPriceResponse, error) {
			// 故意返回空 productCode / pid / timeSpan
			return &jifeiclient.GetPriceResponse{Data: []jifeiclient.GetPriceData{
				{Price: "1.00", TotalCost: "1.00", RealTotalCost: "1.00", Currency: "CNY"},
			}}, nil
		}},
	})
	got, err := svc.QuoteRenew(context.Background(), stdQuoteRenewReq())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.ProductCode != "p_lighthouse" || got.SubProductCode != "sp_linux_small" || got.Pid != 1234 {
		t.Errorf("fallback failed: got %+v", got)
	}
	if got.TimeSpan != 1 || got.TimeUnit != "m" || got.GoodsNum != 1 {
		t.Errorf("time fields fallback failed: got %+v", got)
	}
}

// QuoteRenew shadow 反查：Uin 空 + ShadowClient 注入 → 自动从 externalUserId 反查回填 Uin/AppID。
func TestQuoteRenew_ShadowClient_BackfillUinAndAppID(t *testing.T) {
	shadow := &fakeShadow{
		getBindingFn: func(_ context.Context, externalUserID string) (*shadowclient.Binding, error) {
			return &shadowclient.Binding{
				UserID: externalUserID,
				Uin:    "9999888",
				AppID:  "12345",
			}, nil
		},
	}
	jifei := &fakeJifei{
		getPriceFn: func(_ context.Context, _ *jifeiclient.GetPriceRequest) (*jifeiclient.GetPriceResponse, error) {
			return stdJifeiPriceResp(), nil
		},
	}
	svc := New(Deps{
		CTLClient:    &fakeCTL{getBundleByIDFn: func(_ context.Context, _ string) (*ctlclient.BundleDetail, error) { return stdBundle(), nil }},
		BundleStore:  &fakeBundleStore{def: stdRenewDef()},
		JifeiClient:  jifei,
		ShadowClient: shadow,
	})

	req := stdQuoteRenewReq()
	req.Uin = ""
	req.AppID = ""
	if _, err := svc.QuoteRenew(context.Background(), req); err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if shadow.calls.Load() != 1 {
		t.Errorf("shadow calls = %d, want 1", shadow.calls.Load())
	}
	if jifei.lastGetPriceArgs == nil || jifei.lastGetPriceArgs.Uin != "9999888" {
		t.Errorf("jifei.Uin not backfilled from shadow")
	}
}

// QuoteRenew shadow 返 ErrBindingNotFound → 映射 ErrBindingNotFound（业务错，不是 5xx）。
func TestQuoteRenew_ShadowClient_BindingNotFound(t *testing.T) {
	shadow := &fakeShadow{
		getBindingFn: func(_ context.Context, _ string) (*shadowclient.Binding, error) {
			return nil, shadowclient.ErrBindingNotFound
		},
	}
	svc := New(Deps{
		CTLClient:    &fakeCTL{},
		BundleStore:  &fakeBundleStore{def: stdRenewDef()},
		JifeiClient:  &fakeJifei{},
		ShadowClient: shadow,
	})
	req := stdQuoteRenewReq()
	req.Uin = ""
	_, err := svc.QuoteRenew(context.Background(), req)
	if err == nil || !errors.Is(err, ErrBindingNotFound) {
		t.Errorf("err = %v, want ErrBindingNotFound", err)
	}
}

// QuoteRenew shadow 注入但 ExternalUserID 也空 → ErrInvalidInput（无身份锚点）。
func TestQuoteRenew_ShadowClient_NoIdentityAnchor(t *testing.T) {
	svc := New(Deps{
		CTLClient:    &fakeCTL{},
		BundleStore:  &fakeBundleStore{def: stdRenewDef()},
		JifeiClient:  &fakeJifei{},
		ShadowClient: &fakeShadow{},
	})
	req := stdQuoteRenewReq()
	req.Uin = ""
	req.AppID = ""
	req.ExternalUserID = ""
	_, err := svc.QuoteRenew(context.Background(), req)
	if err == nil || !errors.Is(err, ErrInvalidInput) {
		t.Errorf("err = %v, want ErrInvalidInput", err)
	}
	if !strings.Contains(err.Error(), "external_user_id or uin is required") {
		t.Errorf("err = %v, want 'external_user_id or uin is required' substring", err)
	}
}
