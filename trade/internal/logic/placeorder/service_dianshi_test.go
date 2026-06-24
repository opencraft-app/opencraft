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
	"sync/atomic"
	"testing"

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

func (f *fakeResolver) ResolveForInquiry(_ context.Context, _, _ string) (*activity.Mapping, bool, error) {
	f.resolveInquiryCalls.Add(1)
	return f.mapping, f.useDianshi, f.err
}

func (f *fakeResolver) ResolveForPlaceOrder(_ context.Context, _, _ string) (*activity.Mapping, bool, error) {
	f.resolvePlaceCalls.Add(1)
	return f.mapping, f.useDianshi, f.err
}

// fakeDianshi 是 dianshiclient.Client 的测试替身。
type fakeDianshi struct {
	doGoodsResp    *dianshiclient.DoGoodsResponse
	doGoodsErr     error
	doGoodsCalls   atomic.Int32
	lastDoGoodsReq *dianshiclient.DoGoodsRequest
	priceResp      *dianshiclient.GetPriceResponse
	priceErr       error
	priceCalls     atomic.Int32
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

func newFakeDianshiSuccess() *fakeDianshi {
	return &fakeDianshi{
		doGoodsResp: &dianshiclient.DoGoodsResponse{
			DealNames: []string{"20260624000000000000001"},
			BigDealNo: "20260624000000000000999",
		},
	}
}

// stdActivityMapping 给点石分叉单测一份默认 mapping（启航 01 / 已开鉴权）。
func stdActivityMapping() *activity.Mapping {
	return &activity.Mapping{
		BundleID:   "bundle_launch_01",
		ActivityID: 164273735574009,
		ActID:      1862147936410255,
		SecretKey:  "demo_secret",
		Active:     true,
	}
}

// newDianshiDeps 构造一组带 ActivityResolver + DianshiClient 的依赖；命中点石。
func newDianshiDeps() (*stdDeps, *fakeResolver, *fakeDianshi) {
	d := newStdDeps() // 复用 service_test.go 的 fakeCTL/fakeBundleStore/fakeJifei/fakeOrderWriter/fakeOrderStore
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
	if in.Status != store.OrderStatusPaidPendingProvision {
		t.Errorf("trade_order.status=%q want %q", in.Status, store.OrderStatusPaidPendingProvision)
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
	// preference_param 仅含 externalUserId
	if dc.lastDoGoodsReq.Goods[0].PreferenceParam["externalUserId"] != stdPlaceOrderReq().ExternalUserID {
		t.Errorf("preference_param missing externalUserId: %+v", dc.lastDoGoodsReq.Goods[0].PreferenceParam)
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
