// Package inquiry 点石活动分叉单测（设计稿 §10.1）：
//
//   - bundle 非活动 / Resolver 未注入 → 走 jifei 原路径（断言 jifei 被调、点石未调）
//   - bundle 活动 + 用户未参与 → 走 quoteDianshi（断言 dianshi 被调、jifei 未调）
//   - bundle 活动 + 用户已参与 → 回落 jifei（断言 jifei 被调、dianshi 未调）
//   - Resolver DB 错 → 降级 jifei，单条询价不 5xx
//   - QuoteRenew 不分叉点石（即便 Resolver 注入）
package inquiry

import (
	"context"
	"errors"
	"testing"

	"git.woa.com/wisp/mono/trade/internal/ctlclient"
	"git.woa.com/wisp/mono/trade/internal/dianshiclient"
	"git.woa.com/wisp/mono/trade/internal/jifeiclient"
	"git.woa.com/wisp/mono/trade/internal/logic/activity"
	"git.woa.com/wisp/mono/trade/internal/store"
)

// fakeResolver 是 activity.Resolver 的测试替身。
type fakeResolver struct {
	mapping    *activity.Mapping
	useDianshi bool
	err        error
	calls      int
}

func (f *fakeResolver) ResolveForInquiry(_ context.Context, _, _ string) (*activity.Mapping, bool, error) {
	f.calls++
	return f.mapping, f.useDianshi, f.err
}

func (f *fakeResolver) ResolveForPlaceOrder(_ context.Context, _, _ string) (*activity.Mapping, bool, error) {
	f.calls++
	return f.mapping, f.useDianshi, f.err
}

// fakeDianshi 是 dianshiclient.Client 的测试替身。
type fakeDianshi struct {
	priceResp      *dianshiclient.GetPriceResponse
	priceErr       error
	priceCalls     int
	doGoodsResp    *dianshiclient.DoGoodsResponse
	doGoodsErr     error
	doGoodsCalls   int
	lastPriceReq   *dianshiclient.GetPriceRequest
	lastDoGoodsReq *dianshiclient.DoGoodsRequest
}

func (f *fakeDianshi) GetActivityPrice(_ context.Context, req *dianshiclient.GetPriceRequest) (*dianshiclient.GetPriceResponse, error) {
	f.priceCalls++
	f.lastPriceReq = req
	return f.priceResp, f.priceErr
}

func (f *fakeDianshi) DoGoods(_ context.Context, req *dianshiclient.DoGoodsRequest) (*dianshiclient.DoGoodsResponse, error) {
	f.doGoodsCalls++
	f.lastDoGoodsReq = req
	return f.doGoodsResp, f.doGoodsErr
}

func newFakeDianshiSuccess() *fakeDianshi {
	return &fakeDianshi{
		priceResp: &dianshiclient.GetPriceResponse{
			PriceItems: []dianshiclient.PriceItem{{
				ActID: 1862147936410255, AmountUnit: "pent", Currency: "CNY", Pid: 1016641,
				Price: 990, TotalCost: 990, RealCost: 0, // 限时免费 0 元
				ProductCode: "p_lighthouse", SubProductCode: "sp_lighthouse_lightvela_ai_mc",
				TimeSpan: 1, TimeUnit: "m",
			}},
		},
	}
}

func TestQuote_DianshiBranch_NotParticipated(t *testing.T) {
	jc := &fakeJifei{}
	dc := newFakeDianshiSuccess()
	r := &fakeResolver{
		mapping:    &activity.Mapping{BundleID: "bundle_launch_01", ActivityID: 164273735574009, ActID: 1862147936410255, Active: true, TimeSpanUnit: "7d"},
		useDianshi: true,
	}
	svc := New(Deps{
		CTLClient:        &fakeCTL{getBundleByIDFn: func(_ context.Context, _ string) (*ctlclient.BundleDetail, error) { return stdBundle(), nil }},
		BundleStore:      &fakeBundleStore{def: stdDef()},
		JifeiClient:      jc,
		ActivityResolver: r,
		DianshiClient:    dc,
	})

	res, err := svc.Quote(context.Background(), QuoteRequest{
		BundleID: "bundle_launch_01", Uin: "815836472",
		TimeSpan: 1, TimeUnit: "m", GoodsNum: 1, PayMode: 1,
	})
	if err != nil {
		t.Fatalf("Quote err=%v", err)
	}
	if r.calls != 1 {
		t.Errorf("Resolver calls=%d want 1", r.calls)
	}
	if dc.priceCalls != 1 {
		t.Errorf("dianshi GetActivityPrice calls=%d want 1", dc.priceCalls)
	}
	if jc.getPriceCalls.Load() != 0 {
		t.Errorf("jifei GetPrice should NOT be called when useDianshi=true, calls=%d", jc.getPriceCalls.Load())
	}
	if dc.lastPriceReq.ActivityID != 164273735574009 {
		t.Errorf("dianshi req activity_id=%d", dc.lastPriceReq.ActivityID)
	}
	if len(dc.lastPriceReq.Goods) != 1 || dc.lastPriceReq.Goods[0].ActID != 1862147936410255 {
		t.Errorf("dianshi req goods=%+v", dc.lastPriceReq.Goods)
	}
	// preference_param 4 字段拼装断言（联调期实测推翻设计稿 §5.1 "固定 {}" 后的新套路）。
	//   - regionId       = s.region.RegionID（SiteKind="" + RegionOverride="" 藦 cn 兜底 = 1）
	//   - timeSpanUnit   = mapping.TimeSpanUnit
	//   - subProductCode = def.SubProductCode（stdDef 里是 sp_linux_small）
	//   - bundleId       = mapping.BundleID
	prefParam := dc.lastPriceReq.Goods[0].PreferenceParam
	if got, _ := prefParam["regionId"].(int); got != 1 {
		t.Errorf("preference_param.regionId=%v want 1", prefParam["regionId"])
	}
	if got, _ := prefParam["timeSpanUnit"].(string); got != "7d" {
		t.Errorf("preference_param.timeSpanUnit=%v want 7d", prefParam["timeSpanUnit"])
	}
	if got, _ := prefParam["subProductCode"].(string); got != "sp_linux_small" {
		t.Errorf("preference_param.subProductCode=%v want sp_linux_small", prefParam["subProductCode"])
	}
	if got, _ := prefParam["bundleId"].(string); got != "bundle_launch_01" {
		t.Errorf("preference_param.bundleId=%v want bundle_launch_01", prefParam["bundleId"])
	}
	if res.RealTotalCost != "0" || res.TotalCost != "990" {
		t.Errorf("RealTotalCost=%s TotalCost=%s want 0/990", res.RealTotalCost, res.TotalCost)
	}
}

func TestQuote_DianshiBranch_AlreadyParticipated_FallbackJifei(t *testing.T) {
	jc := &fakeJifei{
		getPriceFn: func(_ context.Context, _ *jifeiclient.GetPriceRequest) (*jifeiclient.GetPriceResponse, error) {
			return stdJifeiPriceResp(), nil
		},
	}
	dc := newFakeDianshiSuccess()
	r := &fakeResolver{
		mapping:    &activity.Mapping{BundleID: "bundle_launch_01", ActivityID: 164273735574009, ActID: 1862147936410255, Active: true},
		useDianshi: false, // 已参与，回落 jifei
	}
	svc := New(Deps{
		CTLClient:        &fakeCTL{getBundleByIDFn: func(_ context.Context, _ string) (*ctlclient.BundleDetail, error) { return stdBundle(), nil }},
		BundleStore:      &fakeBundleStore{def: stdDef()},
		JifeiClient:      jc,
		ActivityResolver: r,
		DianshiClient:    dc,
	})
	_, err := svc.Quote(context.Background(), QuoteRequest{
		BundleID: "bundle_launch_01", Uin: "815836472",
		TimeSpan: 1, TimeUnit: "m", GoodsNum: 1, PayMode: 1,
	})
	if err != nil {
		t.Fatalf("Quote err=%v", err)
	}
	if dc.priceCalls != 0 {
		t.Errorf("dianshi GetActivityPrice should NOT be called when participated, calls=%d", dc.priceCalls)
	}
	if jc.getPriceCalls.Load() != 1 {
		t.Errorf("jifei GetPrice should be called for fallback, calls=%d", jc.getPriceCalls.Load())
	}
}

func TestQuote_NonActivityBundle_StillJifei(t *testing.T) {
	jc := &fakeJifei{
		getPriceFn: func(_ context.Context, _ *jifeiclient.GetPriceRequest) (*jifeiclient.GetPriceResponse, error) {
			return stdJifeiPriceResp(), nil
		},
	}
	r := &fakeResolver{useDianshi: false} // 非活动 bundle，mapping=nil
	svc := New(Deps{
		CTLClient:        &fakeCTL{getBundleByIDFn: func(_ context.Context, _ string) (*ctlclient.BundleDetail, error) { return stdBundle(), nil }},
		BundleStore:      &fakeBundleStore{def: stdDef()},
		JifeiClient:      jc,
		ActivityResolver: r,
	})
	_, err := svc.Quote(context.Background(), QuoteRequest{
		BundleID: "bundle_other", Uin: "815836472",
		TimeSpan: 1, TimeUnit: "m", GoodsNum: 1, PayMode: 1,
	})
	if err != nil {
		t.Fatalf("Quote err=%v", err)
	}
	if jc.getPriceCalls.Load() != 1 {
		t.Errorf("non-activity bundle should call jifei, calls=%d", jc.getPriceCalls.Load())
	}
}

func TestQuote_ResolverDBError_FallbackJifei(t *testing.T) {
	jc := &fakeJifei{
		getPriceFn: func(_ context.Context, _ *jifeiclient.GetPriceRequest) (*jifeiclient.GetPriceResponse, error) {
			return stdJifeiPriceResp(), nil
		},
	}
	r := &fakeResolver{err: errors.New("db boom")}
	svc := New(Deps{
		CTLClient:        &fakeCTL{getBundleByIDFn: func(_ context.Context, _ string) (*ctlclient.BundleDetail, error) { return stdBundle(), nil }},
		BundleStore:      &fakeBundleStore{def: stdDef()},
		JifeiClient:      jc,
		ActivityResolver: r,
	})
	_, err := svc.Quote(context.Background(), QuoteRequest{
		BundleID: "bundle_launch_01", Uin: "815836472",
		TimeSpan: 1, TimeUnit: "m", GoodsNum: 1, PayMode: 1,
	})
	if err != nil {
		t.Fatalf("Quote err=%v (resolver DB err should not 5xx)", err)
	}
	if jc.getPriceCalls.Load() != 1 {
		t.Errorf("jifei should still be called when resolver fails, calls=%d", jc.getPriceCalls.Load())
	}
}

func TestQuoteRenew_NeverDispatchesToDianshi(t *testing.T) {
	jc := &fakeJifei{
		getPriceFn: func(_ context.Context, _ *jifeiclient.GetPriceRequest) (*jifeiclient.GetPriceResponse, error) {
			return stdJifeiPriceResp(), nil
		},
	}
	dc := newFakeDianshiSuccess()
	r := &fakeResolver{
		mapping:    &activity.Mapping{BundleID: "bundle_launch_01", ActivityID: 164273735574009, ActID: 1862147936410255, Active: true},
		useDianshi: true,
	}
	// 续费需要 scene=renew 的 categoryId（与 v1.7.21 B16 续费询价契约一致）
	def := stdDef()
	def.CategoryIDs = append(def.CategoryIDs, store.CategoryIDEntry{Scene: "renew", Category: 100060})
	svc := New(Deps{
		CTLClient:        &fakeCTL{getBundleByIDFn: func(_ context.Context, _ string) (*ctlclient.BundleDetail, error) { return stdBundle(), nil }},
		BundleStore:      &fakeBundleStore{def: def},
		JifeiClient:      jc,
		ActivityResolver: r,
		DianshiClient:    dc,
	})

	_, err := svc.QuoteRenew(context.Background(), QuoteRenewRequest{
		BundleID: "bundle_launch_01", ResourceID: "pass_xxx",
		Uin: "815836472", CurDeadline: "2026-12-01 00:00:00",
		TimeSpan: 1, TimeUnit: "m", GoodsNum: 1, PayMode: 1,
	})
	if err != nil {
		t.Fatalf("QuoteRenew err=%v", err)
	}
	if r.calls != 0 {
		t.Errorf("Resolver should NOT be called for renew, calls=%d", r.calls)
	}
	if dc.priceCalls != 0 {
		t.Errorf("dianshi should NOT be called for renew, calls=%d", dc.priceCalls)
	}
	if jc.getPriceCalls.Load() != 1 {
		t.Errorf("jifei GetPrice should be called for renew, calls=%d", jc.getPriceCalls.Load())
	}
}
