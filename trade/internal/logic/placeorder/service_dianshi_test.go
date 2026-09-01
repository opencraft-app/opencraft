// Package placeorder 点石活动分叉单测（设计稿 §5.4 / §10.1）：
//
//   - PlaceOrder + Resolver useDianshi=true → 走 placeOrderDianshi 调点石 do_goods
//   - PlaceOrderAndPay + Resolver useDianshi=true → 同样走 placeOrderDianshi（点石不区分双步/一体化）
//   - Resolver useDianshi=false → 完全走 jifei 原路径，断言点石未被调
//   - PlaceRenewOrder / PlaceRenewOrderAndPay + Resolver 注入 → **不分叉**点石（设计稿 §5.5 续费写死 jifei）
//   - 点石下单失败 → 返业务错，不写任何 trade_order 落地
//   - check_sum：mapping.SecretKey 非空时 envelope.para 出现 check_sum；空时不出现
package placeorder

import (
	"context"
	"errors"
	"math"
	"sync/atomic"
	"testing"
	"time"

	"git.woa.com/wisp/mono/trade/internal/dianshiclient"
	"git.woa.com/wisp/mono/trade/internal/logic/activity"
	"git.woa.com/wisp/mono/trade/internal/store"
)

// fakeResolver 是 activity.Resolver 的测试替身。
type fakeResolver struct {
	mapping             *activity.Mapping
	useDianshi          bool
	err                 error
	resolveInquiryCalls atomic.Int32
	resolvePlaceCalls   atomic.Int32
}

type fakeParticipationReader struct {
	hit       bool
	err       error
	calls     atomic.Int32
	lastUin   string
	lastActID int64
}

func (f *fakeParticipationReader) HasUserParticipated(_ context.Context, uin string, activityID int64) (bool, error) {
	f.calls.Add(1)
	f.lastUin = uin
	f.lastActID = activityID
	return f.hit, f.err
}

func (f *fakeResolver) ResolveForInquiry(_ context.Context, _, _ string, _ int, _ string) (*activity.Mapping, bool, error) {
	f.resolveInquiryCalls.Add(1)
	return f.mapping, f.useDianshi, f.err
}

func (f *fakeResolver) ResolveForPlaceOrder(_ context.Context, _, _ string, _ int, _ string) (*activity.Mapping, bool, error) {
	f.resolvePlaceCalls.Add(1)
	return f.mapping, f.useDianshi, f.err
}

// fakeDianshi 是 dianshiclient.Client 的测试替身。
type fakeDianshi struct {
	doGoodsResp        *dianshiclient.DoGoodsResponse
	doGoodsErr         error
	doGoodsCalls       atomic.Int32
	lastDoGoodsReq     *dianshiclient.DoGoodsRequest
	doGoodsAndPayResp  *dianshiclient.DoGoodsResponse
	doGoodsAndPayErr   error
	doGoodsAndPayCalls atomic.Int32
	lastDoGoodsAndPay  *dianshiclient.DoGoodsRequest
	priceResp          *dianshiclient.GetPriceResponse
	priceErr           error
	priceCalls         atomic.Int32
}

func (f *fakeDianshi) GetActivityPrice(_ context.Context, _ *dianshiclient.GetPriceRequest) (*dianshiclient.GetPriceResponse, error) {
	f.priceCalls.Add(1)
	return f.priceResp, f.priceErr
}

func (f *fakeDianshi) DoGoods(_ context.Context, req *dianshiclient.DoGoodsRequest) (*dianshiclient.DoGoodsResponse, error) {
	f.doGoodsCalls.Add(1)
	f.lastDoGoodsReq = req
	return f.doGoodsResp, f.doGoodsErr
}

func (f *fakeDianshi) DoGoodsAndPay(_ context.Context, req *dianshiclient.DoGoodsRequest) (*dianshiclient.DoGoodsResponse, error) {
	f.doGoodsAndPayCalls.Add(1)
	f.lastDoGoodsAndPay = req
	if f.doGoodsAndPayResp != nil || f.doGoodsAndPayErr != nil {
		return f.doGoodsAndPayResp, f.doGoodsAndPayErr
	}
	return f.doGoodsResp, f.doGoodsErr
}

func newFakeDianshiSuccess() *fakeDianshi {
	return &fakeDianshi{
		doGoodsResp: &dianshiclient.DoGoodsResponse{
			DealNames:   []string{"20260624000000000000001"},
			BigDealNo:   "20260624000000000000999",
			ResourceIDs: map[string][]string{"20260624000000000000001": {"pass-dianshi-paid-1"}},
		},
	}
}

// stdActivityMapping 给点石分叉单测一份默认 mapping（启航 01 / 已开鉴权）。
func stdActivityMapping() *activity.Mapping {
	return &activity.Mapping{
		BundleID:         "bundle_launch_01",
		ActivityID:       164273735574009,
		ActID:            1862147936410255,
		SecretKey:        "demo_secret",
		Active:           true,
		TimeSpanUnit:     "14d",
		OrderExpiredTime: 1,
	}
}

// newDianshiDeps 构造一组带 ActivityResolver + DianshiClient 的依赖；命中点石。
func newDianshiDeps() (*stdDeps, *fakeResolver, *fakeDianshi) {
	d := newStdDeps() // 复用 service_test.go 的 fakeCTL/fakeBundleStore/fakeJifei/fakeOrderWriter/fakeOrderStore
	r := &fakeResolver{mapping: stdActivityMapping(), useDianshi: true}
	dc := newFakeDianshiSuccess()
	d.service = New(Deps{
		CTLClient:           d.ctl,
		BundleStore:         d.bundle,
		JifeiClient:         d.jifei,
		OrderWriter:         d.writer,
		OrderStore:          d.store,
		ParticipationReader: d.participation,
		ActivityResolver:    r,
		DianshiClient:       dc,
	})
	return d, r, dc
}

func TestPlaceOrder_DianshiBranch_HappyPath(t *testing.T) {
	d, r, dc := newDianshiDeps()

	res, err := d.service.PlaceOrder(context.Background(), stdPlaceOrderReq())
	if err != nil {
		t.Fatalf("PlaceOrder err=%v", err)
	}
	if res == nil || res.DealName != "20260624000000000000001" {
		t.Fatalf("DealName=%+v", res)
	}
	if res.BigOrderID != "20260624000000000000999" {
		t.Errorf("BigOrderID=%s", res.BigOrderID)
	}

	// Resolver 命中分叉
	if r.resolvePlaceCalls.Load() != 1 {
		t.Errorf("Resolver.ResolveForPlaceOrder calls=%d want 1", r.resolvePlaceCalls.Load())
	}
	// 出向调用：dianshi 1 次，jifei generateDeals 0 次
	if dc.doGoodsCalls.Load() != 1 {
		t.Errorf("dianshi DoGoods calls=%d want 1", dc.doGoodsCalls.Load())
	}
	if d.jifei.generateDealsCalls.Load() != 0 {
		t.Errorf("jifei generateDeals should NOT be called, calls=%d", d.jifei.generateDealsCalls.Load())
	}
	if d.jifei.generateDealsAndPayCalls.Load() != 0 {
		t.Errorf("jifei generateDealsAndPay should NOT be called, calls=%d", d.jifei.generateDealsAndPayCalls.Load())
	}
	// 落 trade_order：source='dianshi' / status='paid_pending_provision'
	if d.writer.createOrderCalls.Load() != 1 {
		t.Fatalf("CreateOrder calls=%d want 1", d.writer.createOrderCalls.Load())
	}
	in := d.writer.lastCreateOrderInput
	if in.Source != store.OrderSourceDianshi {
		t.Errorf("trade_order.source=%q want %q", in.Source, store.OrderSourceDianshi)
	}
	if in.ActivityID != 164273735574009 {
		t.Errorf("trade_order.activity_id=%d want 164273735574009", in.ActivityID)
	}
	if in.ActID != 1862147936410255 {
		t.Errorf("trade_order.act_id=%d want 1862147936410255", in.ActID)
	}
	if in.Status != store.OrderStatusPaidPendingProvision {
		t.Errorf("trade_order.status=%q want %q", in.Status, store.OrderStatusPaidPendingProvision)
	}
	if in.Period != 14 || in.TimeUnit != "d" {
		t.Errorf("trade_order period/time_unit=%d/%q want 14/d", in.Period, in.TimeUnit)
	}
	if in.GoodsDetail["timeSpan"] != 14 || in.GoodsDetail["timeUnit"] != "d" {
		t.Errorf("goods_detail timeSpan/timeUnit=%v/%v want 14/d",
			in.GoodsDetail["timeSpan"], in.GoodsDetail["timeUnit"])
	}
	if in.DealName != res.DealName {
		t.Errorf("DealName mismatch in/out")
	}
	// goods_detail 透活动元信息便于 createResource handler 排障
	if id, _ := in.GoodsDetail["dianshi_activity_id"].(int64); id != 164273735574009 {
		t.Errorf("dianshi_activity_id in goods_detail=%v", in.GoodsDetail["dianshi_activity_id"])
	}
	// envelope 出向：check_sum 非空（mapping.SecretKey != ""）
	if dc.lastDoGoodsReq.CheckSum == "" {
		t.Errorf("check_sum should be non-empty when mapping.SecretKey set")
	}
	// preference_param 5 字段断言（询价 4 字段 + 下单专属 externalUserId）
	prefParam := dc.lastDoGoodsReq.Goods[0].PreferenceParam
	if got, _ := prefParam["regionId"].(int); got != 1 {
		t.Errorf("preference_param.regionId=%v want 1", prefParam["regionId"])
	}
	if got, _ := prefParam["timeSpanUnit"].(string); got != "14d" {
		t.Errorf("preference_param.timeSpanUnit=%v want 14d", prefParam["timeSpanUnit"])
	}
	if got, _ := prefParam["subProductCode"].(string); got != "sp_linux_small" {
		t.Errorf("preference_param.subProductCode=%v want sp_linux_small", prefParam["subProductCode"])
	}
	if got, _ := prefParam["bundleId"].(string); got != "bundle_launch_01" {
		t.Errorf("preference_param.bundleId=%v want bundle_launch_01", prefParam["bundleId"])
	}
	if prefParam["externalUserId"] != stdPlaceOrderReq().ExternalUserID {
		t.Errorf("preference_param.externalUserId=%v want %s", prefParam["externalUserId"], stdPlaceOrderReq().ExternalUserID)
	}
	if got, _ := prefParam["dianshiActId"].(int64); got != stdActivityMapping().ActID {
		t.Errorf("preference_param.dianshiActId=%v want %d", prefParam["dianshiActId"], stdActivityMapping().ActID)
	}
}

func TestPlaceOrder_DianshiBranch_LaunchAIBundleUsesActivityDuration(t *testing.T) {
	d, r, dc := newDianshiDeps()
	req := stdPlaceOrderReq()
	req.BundleID = "bundle_launch_ai_01"
	r.mapping.BundleID = req.BundleID
	r.mapping.TimeSpanUnit = "3d"

	if _, err := d.service.PlaceOrder(context.Background(), req); err != nil {
		t.Fatalf("PlaceOrder err=%v", err)
	}

	prefParam := dc.lastDoGoodsReq.Goods[0].PreferenceParam
	if got, _ := prefParam["timeSpanUnit"].(string); got != "3d" {
		t.Errorf("preference_param.timeSpanUnit=%v want 3d", prefParam["timeSpanUnit"])
	}
	if got, _ := prefParam["bundleId"].(string); got != req.BundleID {
		t.Errorf("preference_param.bundleId=%v want %s", prefParam["bundleId"], req.BundleID)
	}

	order := d.writer.lastCreateOrderInput
	if order.Period != 3 || order.TimeUnit != "d" {
		t.Errorf("trade_order period/time_unit=%d/%q want 3/d", order.Period, order.TimeUnit)
	}
	if order.GoodsDetail["timeSpan"] != 3 || order.GoodsDetail["timeUnit"] != "d" {
		t.Errorf("goods_detail timeSpan/timeUnit=%v/%v want 3/d",
			order.GoodsDetail["timeSpan"], order.GoodsDetail["timeUnit"])
	}
}

func TestPlaceOrder_DianshiBranch_ReusesPendingOrder(t *testing.T) {
	d, _, dc := newDianshiDeps()
	d.store.findReusableFn = func(ctx context.Context, externalUserID string, activityID int64, bundleID string, actID int64, createdAfter time.Time) (*store.TradeOrder, error) {
		if externalUserID != stdPlaceOrderReq().ExternalUserID {
			t.Errorf("externalUserID=%q", externalUserID)
		}
		if activityID != 164273735574009 {
			t.Errorf("activityID=%d", activityID)
		}
		if bundleID != stdPlaceOrderReq().BundleID {
			t.Errorf("bundleID=%q", bundleID)
		}
		if actID != stdActivityMapping().ActID {
			t.Errorf("actID=%d", actID)
		}
		return &store.TradeOrder{
			DealName:    "20260629004153859479231",
			BigOrderID:  "20260629004153859479221",
			PayURL:      "https://buy.example/pay/reused",
			Status:      store.OrderStatusPaidPendingProvision,
			CreatedTime: time.Now().UTC().Add(-10 * time.Minute),
		}, nil
	}

	res, err := d.service.PlaceOrder(context.Background(), stdPlaceOrderReq())
	if err != nil {
		t.Fatalf("PlaceOrder err=%v", err)
	}
	if res.DealName != "20260629004153859479231" || res.BigOrderID != "20260629004153859479221" {
		t.Fatalf("unexpected reused result: %+v", res)
	}
	if res.PayURL != "https://buy.example/pay/reused" {
		t.Errorf("PayURL=%q", res.PayURL)
	}
	if dc.doGoodsCalls.Load() != 0 {
		t.Errorf("dianshi DoGoods should NOT be called on idempotency hit, calls=%d", dc.doGoodsCalls.Load())
	}
	if d.writer.createOrderCalls.Load() != 0 {
		t.Errorf("CreateOrder should NOT be called on idempotency hit, calls=%d", d.writer.createOrderCalls.Load())
	}
}

func TestPlaceOrder_DianshiBranch_OrderExpiredTimeHalfHour(t *testing.T) {
	d, r, dc := newDianshiDeps()
	r.mapping.OrderExpiredTime = 0.5
	var createdAfter time.Time
	d.store.findReusableFn = func(ctx context.Context, externalUserID string, activityID int64, bundleID string, actID int64, ca time.Time) (*store.TradeOrder, error) {
		createdAfter = ca
		return nil, store.ErrTradeOrderNotFound
	}

	before := time.Now().UTC()
	if _, err := d.service.PlaceOrder(context.Background(), stdPlaceOrderReq()); err != nil {
		t.Fatalf("PlaceOrder err=%v", err)
	}
	if dc.doGoodsCalls.Load() != 1 {
		t.Fatalf("dianshi DoGoods calls=%d want 1", dc.doGoodsCalls.Load())
	}
	gotSeconds := before.Sub(createdAfter).Seconds()
	if math.Abs(gotSeconds-1800) > 2 {
		t.Fatalf("createdAfter window seconds=%f want about 1800", gotSeconds)
	}
}

func TestPlaceOrder_DianshiBranch_OmitsCheckSumWhenSecretEmpty(t *testing.T) {
	d, r, dc := newDianshiDeps()
	r.mapping.SecretKey = ""

	if _, err := d.service.PlaceOrder(context.Background(), stdPlaceOrderReq()); err != nil {
		t.Fatalf("PlaceOrder err=%v", err)
	}
	if dc.lastDoGoodsReq.CheckSum != "" {
		t.Errorf("check_sum should be empty when mapping.SecretKey is empty, got %q", dc.lastDoGoodsReq.CheckSum)
	}
}

func TestPlaceOrder_DianshiBranch_DoGoodsBusinessError(t *testing.T) {
	d, _, dc := newDianshiDeps()
	dc.doGoodsResp = nil
	dc.doGoodsErr = &dianshiclient.CGWError{ReturnCode: 700001, ReturnMessage: "activity not allowed"}

	_, err := d.service.PlaceOrder(context.Background(), stdPlaceOrderReq())
	if err == nil {
		t.Fatal("expect business error from dianshi")
	}
	// 失败链路：没有 trade_order 落地
	if d.writer.createOrderCalls.Load() != 0 {
		t.Errorf("CreateOrder should NOT be called when dianshi DoGoods fails, calls=%d", d.writer.createOrderCalls.Load())
	}
}

func TestPlaceOrder_DianshiBranch_RejectsInvalidTimeSpanUnitBeforeDoGoods(t *testing.T) {
	d, r, dc := newDianshiDeps()
	r.mapping.TimeSpanUnit = "14days"

	_, err := d.service.PlaceOrder(context.Background(), stdPlaceOrderReq())
	if err == nil {
		t.Fatal("expect invalid activity time_span_unit error")
	}
	if dc.doGoodsCalls.Load() != 0 {
		t.Errorf("dianshi DoGoods should NOT be called for invalid time_span_unit, calls=%d", dc.doGoodsCalls.Load())
	}
	if d.writer.createOrderCalls.Load() != 0 {
		t.Errorf("CreateOrder should NOT be called for invalid time_span_unit, calls=%d", d.writer.createOrderCalls.Load())
	}
}

func TestParseDianshiTimeSpanUnit(t *testing.T) {
	tests := []struct {
		name       string
		value      string
		wantPeriod int
		wantUnit   string
		wantErr    bool
	}{
		{name: "days", value: "14d", wantPeriod: 14, wantUnit: "d"},
		{name: "months", value: "1m", wantPeriod: 1, wantUnit: "m"},
		{name: "normalizes whitespace and case", value: " 1Y ", wantPeriod: 1, wantUnit: "y"},
		{name: "empty", value: "", wantErr: true},
		{name: "missing unit", value: "14", wantErr: true},
		{name: "zero", value: "0d", wantErr: true},
		{name: "negative", value: "-1m", wantErr: true},
		{name: "unsupported unit", value: "14h", wantErr: true},
		{name: "long unit", value: "14days", wantErr: true},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			period, unit, err := parseDianshiTimeSpanUnit(tc.value)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("parseDianshiTimeSpanUnit(%q) expected error", tc.value)
				}
				return
			}
			if err != nil {
				t.Fatalf("parseDianshiTimeSpanUnit(%q) err=%v", tc.value, err)
			}
			if period != tc.wantPeriod || unit != tc.wantUnit {
				t.Fatalf("parseDianshiTimeSpanUnit(%q)=%d/%q want %d/%q",
					tc.value, period, unit, tc.wantPeriod, tc.wantUnit)
			}
		})
	}
}

func TestPlaceOrder_NonActivityBundle_StillJifei(t *testing.T) {
	d := newStdDeps()
	r := &fakeResolver{useDianshi: false} // mapping=nil 表示非活动 bundle
	dc := newFakeDianshiSuccess()
	d.service = New(Deps{
		CTLClient:        d.ctl,
		BundleStore:      d.bundle,
		JifeiClient:      d.jifei,
		OrderWriter:      d.writer,
		OrderStore:       d.store,
		ActivityResolver: r,
		DianshiClient:    dc,
	})

	if _, err := d.service.PlaceOrder(context.Background(), stdPlaceOrderReq()); err != nil {
		t.Fatalf("PlaceOrder err=%v", err)
	}
	if dc.doGoodsCalls.Load() != 0 {
		t.Errorf("dianshi DoGoods should NOT be called for non-activity bundle, calls=%d", dc.doGoodsCalls.Load())
	}
	if d.jifei.generateDealsCalls.Load() != 1 {
		t.Errorf("jifei generateDeals calls=%d want 1", d.jifei.generateDealsCalls.Load())
	}
}

func TestPlaceOrder_ResolverDBError_PropagatesAs5xx(t *testing.T) {
	d := newStdDeps()
	r := &fakeResolver{err: errors.New("db boom")}
	dc := newFakeDianshiSuccess()
	d.service = New(Deps{
		CTLClient:        d.ctl,
		BundleStore:      d.bundle,
		JifeiClient:      d.jifei,
		OrderWriter:      d.writer,
		OrderStore:       d.store,
		ActivityResolver: r,
		DianshiClient:    dc,
	})

	_, err := d.service.PlaceOrder(context.Background(), stdPlaceOrderReq())
	if err == nil {
		t.Fatal("expect error from resolver DB failure (no graceful-degrade in placeorder)")
	}
	// 既未走 jifei 也未走 dianshi
	if d.jifei.generateDealsCalls.Load() != 0 || dc.doGoodsCalls.Load() != 0 {
		t.Errorf("no out-bound call should be made on resolve fail, jifei=%d dianshi=%d",
			d.jifei.generateDealsCalls.Load(), dc.doGoodsCalls.Load())
	}
}

func TestPlaceOrderAndPay_DianshiBranch_HappyPath(t *testing.T) {
	d, r, dc := newDianshiDeps()

	res, err := d.service.PlaceOrderAndPay(context.Background(), stdPlaceOrderReq())
	if err != nil {
		t.Fatalf("PlaceOrderAndPay err=%v", err)
	}
	if res == nil || res.DealName != "20260624000000000000001" {
		t.Fatalf("DealName=%+v", res)
	}
	if r.resolvePlaceCalls.Load() != 1 {
		t.Errorf("Resolver should be called for PlaceOrderAndPay too, calls=%d", r.resolvePlaceCalls.Load())
	}
	if dc.doGoodsCalls.Load() != 1 {
		t.Errorf("dianshi DoGoods calls=%d want 1 (placeOrderAndPay should converge to same dianshi path)", dc.doGoodsCalls.Load())
	}
	if d.jifei.generateDealsAndPayCalls.Load() != 0 {
		t.Errorf("jifei generateDealsAndPay should NOT be called, calls=%d", d.jifei.generateDealsAndPayCalls.Load())
	}
}

func TestPlaceDianshiOrderAndPay_HappyPath(t *testing.T) {
	d, r, dc := newDianshiDeps()

	res, err := d.service.PlaceDianshiOrderAndPay(context.Background(), stdPlaceOrderReq())
	if err != nil {
		t.Fatalf("PlaceDianshiOrderAndPay err=%v", err)
	}
	if res == nil || res.DealName != "20260624000000000000001" {
		t.Fatalf("DealName=%+v", res)
	}
	if r.resolvePlaceCalls.Load() != 1 {
		t.Errorf("ResolveForPlaceOrder calls=%d want 1", r.resolvePlaceCalls.Load())
	}
	if dc.doGoodsAndPayCalls.Load() != 1 {
		t.Errorf("DoGoodsAndPay calls=%d want 1", dc.doGoodsAndPayCalls.Load())
	}
	if dc.doGoodsCalls.Load() != 0 {
		t.Errorf("DoGoods calls=%d want 0", dc.doGoodsCalls.Load())
	}
	if dc.priceCalls.Load() != 0 {
		t.Errorf("GetActivityPrice calls=%d want 0", dc.priceCalls.Load())
	}
	if d.jifei.generateDealsCalls.Load() != 0 || d.jifei.generateDealsAndPayCalls.Load() != 0 {
		t.Errorf("jifei calls generate=%d generateAndPay=%d want 0/0",
			d.jifei.generateDealsCalls.Load(), d.jifei.generateDealsAndPayCalls.Load())
	}
	if d.writer.createOrderCalls.Load() != 1 {
		t.Fatalf("CreateOrder calls=%d want 1", d.writer.createOrderCalls.Load())
	}
	if got := d.writer.lastCreateOrderInput; got.Source != store.OrderSourceDianshi || got.Status != store.OrderStatusProvisioned {
		t.Errorf("persisted order source/status=%q/%q want %q/%q", got.Source, got.Status,
			store.OrderSourceDianshi, store.OrderStatusProvisioned)
	} else if got.ResourceID != "pass-dianshi-paid-1" {
		t.Errorf("persisted order resource_id=%q want pass-dianshi-paid-1", got.ResourceID)
	} else if got.Period != 14 || got.TimeUnit != "d" ||
		got.GoodsDetail["timeSpan"] != 14 || got.GoodsDetail["timeUnit"] != "d" {
		t.Errorf("persisted order duration=%d/%q goods_detail=%v/%v want 14/d",
			got.Period, got.TimeUnit, got.GoodsDetail["timeSpan"], got.GoodsDetail["timeUnit"])
	}
	if dc.lastDoGoodsAndPay == nil || dc.lastDoGoodsAndPay.Goods[0].PreferenceParam["externalUserId"] != stdPlaceOrderReq().ExternalUserID {
		t.Errorf("DoGoodsAndPay request=%+v", dc.lastDoGoodsAndPay)
	}
}

func TestGrantDianshiSubscriptionUsesExplicitCampaignWithoutResolver(t *testing.T) {
	d, r, dc := newDianshiDeps()
	r.err = errors.New("grant path must not resolve trade_bundle_activity")
	campaign := DianshiGrantCampaign{
		ActivityID:   165523570799387,
		ActID:        142163399386388,
		TimeSpanUnit: "1m",
		SecretKey:    "campaign-secret",
	}

	res, err := d.service.GrantDianshiSubscription(context.Background(), stdPlaceOrderReq(), campaign)
	if err != nil {
		t.Fatalf("GrantDianshiSubscription err=%v", err)
	}
	if res == nil || res.Status != DianshiGrantStatusGranted || res.DealName == "" {
		t.Fatalf("unexpected grant result: %+v", res)
	}
	if r.resolvePlaceCalls.Load() != 0 {
		t.Fatalf("grant path resolved trade_bundle_activity %d times", r.resolvePlaceCalls.Load())
	}
	if d.participation.calls.Load() != 1 || d.participation.lastActID != campaign.ActivityID {
		t.Fatalf("participation lookup calls=%d uin=%q activityID=%d", d.participation.calls.Load(), d.participation.lastUin, d.participation.lastActID)
	}
	if got := dc.lastDoGoodsAndPay.Goods[0].ActID; got != campaign.ActID {
		t.Fatalf("Dianshi actID=%d want %d", got, campaign.ActID)
	}
	pref := dc.lastDoGoodsAndPay.Goods[0].PreferenceParam
	if pref["timeSpanUnit"] != "1m" || pref["bundleId"] != stdPlaceOrderReq().BundleID {
		t.Fatalf("unexpected preference_param=%+v", pref)
	}
	if dc.lastDoGoodsAndPay.ActivityID != campaign.ActivityID || dc.lastDoGoodsAndPay.CheckSum == "" {
		t.Fatalf("unexpected Dianshi request=%+v", dc.lastDoGoodsAndPay)
	}
	if got := d.writer.lastCreateOrderInput; got.ActivityID != campaign.ActivityID || got.ActID != campaign.ActID {
		t.Fatalf("persisted campaign activityID/actID=%d/%d", got.ActivityID, got.ActID)
	} else if got.Status != store.OrderStatusProvisioned || got.ResourceID != "pass-dianshi-paid-1" {
		t.Fatalf("persisted grant status/resource_id=%q/%q want %q/pass-dianshi-paid-1",
			got.Status, got.ResourceID, store.OrderStatusProvisioned)
	}
}

func TestPlaceDianshiOrderAndPay_RejectsMissingResourceID(t *testing.T) {
	d, _, dc := newDianshiDeps()
	dc.doGoodsAndPayResp = &dianshiclient.DoGoodsResponse{
		DealNames: []string{"20260624000000000000001"},
		BigDealNo: "20260624000000000000999",
	}

	_, err := d.service.PlaceDianshiOrderAndPay(context.Background(), stdPlaceOrderReq())
	if !errors.Is(err, ErrJifeiResponseInvalid) {
		t.Fatalf("err=%v want ErrJifeiResponseInvalid", err)
	}
	if d.writer.createOrderCalls.Load() != 0 {
		t.Fatalf("CreateOrder calls=%d want 0", d.writer.createOrderCalls.Load())
	}
}

func TestGrantDianshiSubscriptionSkipsExistingParticipation(t *testing.T) {
	d, r, dc := newDianshiDeps()
	d.participation.hit = true

	res, err := d.service.GrantDianshiSubscription(context.Background(), stdPlaceOrderReq(), DianshiGrantCampaign{
		ActivityID: 165523570799387, ActID: 142163399386388, TimeSpanUnit: "1m", SecretKey: "campaign-secret",
	})
	if err != nil {
		t.Fatalf("GrantDianshiSubscription err=%v", err)
	}
	if res == nil || res.Status != DianshiGrantStatusSkipped {
		t.Fatalf("unexpected grant result: %+v", res)
	}
	if dc.doGoodsAndPayCalls.Load() != 0 || d.writer.createOrderCalls.Load() != 0 {
		t.Fatalf("skip must not place or persist order")
	}
	if r.resolvePlaceCalls.Load() != 0 {
		t.Fatalf("skip path must not resolve trade_bundle_activity")
	}
}

func TestPlaceDianshiOrderAndPay_RejectsNonActivityBundle(t *testing.T) {
	d := newStdDeps()
	r := &fakeResolver{useDianshi: false}
	dc := newFakeDianshiSuccess()
	d.service = New(Deps{
		CTLClient:        d.ctl,
		BundleStore:      d.bundle,
		JifeiClient:      d.jifei,
		OrderWriter:      d.writer,
		OrderStore:       d.store,
		ActivityResolver: r,
		DianshiClient:    dc,
	})

	_, err := d.service.PlaceDianshiOrderAndPay(context.Background(), stdPlaceOrderReq())
	if !errors.Is(err, ErrDianshiActivityRequired) {
		t.Fatalf("err=%v want ErrDianshiActivityRequired", err)
	}
	if dc.doGoodsAndPayCalls.Load() != 0 || dc.doGoodsCalls.Load() != 0 {
		t.Errorf("dianshi calls andPay=%d goods=%d want 0/0", dc.doGoodsAndPayCalls.Load(), dc.doGoodsCalls.Load())
	}
	if d.jifei.generateDealsCalls.Load() != 0 || d.jifei.generateDealsAndPayCalls.Load() != 0 {
		t.Errorf("jifei calls generate=%d generateAndPay=%d want 0/0",
			d.jifei.generateDealsCalls.Load(), d.jifei.generateDealsAndPayCalls.Load())
	}
}

func TestPlaceRenewOrder_NeverDispatchesToDianshi(t *testing.T) {
	// 续费链路即便 Resolver 注入也写死走 jifei（设计稿 §5.5）
	d := newStdDeps()
	d.bundle = &fakeBundleStore{def: stdRenewDef()}
	r := &fakeResolver{mapping: stdActivityMapping(), useDianshi: true}
	dc := newFakeDianshiSuccess()
	d.service = New(Deps{
		CTLClient:        d.ctl,
		BundleStore:      d.bundle,
		JifeiClient:      d.jifei,
		OrderWriter:      d.writer,
		OrderStore:       d.store,
		ActivityResolver: r,
		DianshiClient:    dc,
	})

	_, err := d.service.PlaceRenewOrder(context.Background(), PlaceRenewOrderRequest{
		ExternalUserID: "user-1",
		Uin:            "1000123456",
		AppID:          "10001",
		BundleID:       "bundle_launch_01",
		ResourceID:     "pass_xxx",
		CurDeadline:    "2026-12-01 00:00:00",
		Period:         1,
		TimeUnit:       "m",
		GoodsNum:       1,
		PayMode:        1,
	})
	if err != nil {
		t.Fatalf("PlaceRenewOrder err=%v", err)
	}
	if r.resolvePlaceCalls.Load() != 0 || r.resolveInquiryCalls.Load() != 0 {
		t.Errorf("Resolver should NOT be called for renew, place=%d inquiry=%d",
			r.resolvePlaceCalls.Load(), r.resolveInquiryCalls.Load())
	}
	if dc.doGoodsCalls.Load() != 0 {
		t.Errorf("dianshi should NOT be called for renew, calls=%d", dc.doGoodsCalls.Load())
	}
}
