package placeorder

import (
	"context"
	"errors"
	"strings"
	"testing"

	"git.woa.com/wisp/mono/trade/internal/ctlclient"
	"git.woa.com/wisp/mono/trade/internal/jifeiclient"
	"git.woa.com/wisp/mono/trade/internal/store"
)

// 同 SP 变配下单。需求：TAPD 1010132091137784162 §4.1 / §5.1 / §7.1

const (
	modifySourceBundleID = "bundle_sail"
	modifyTargetBundleID = "bundle_cruise"

	// oldConfig/newConfig 内层自带的三件套真值（计费变配询价/下单强制要求）。
	modifyProductCode    = "p_lighthouse"
	modifySubProductCode = "sp_lightvela_cn"
	modifyPid            = int64(4001)
)

type fakeModifyFlowReader struct {
	flow  *store.Flow
	err   error
	calls int
}

func (f *fakeModifyFlowReader) GetFlow(
	_ context.Context,
	_, _, _ string,
) (*store.Flow, error) {
	f.calls++
	return f.flow, f.err
}

func modifyDefs() map[string]*store.BundleDefinition {
	return map[string]*store.BundleDefinition{
		modifySourceBundleID: {
			BundleID:       modifySourceBundleID,
			ProductCode:    modifyProductCode,
			SubProductCode: modifySubProductCode,
			Pid:            modifyPid,
			CategoryIDs: []store.CategoryIDEntry{
				{Scene: "purchase", Category: 100059},
			},
			SVList: map[string]int64{"sv_cpu": 2, "sv_mem": 4, "sv_disk": 60},
		},
		modifyTargetBundleID: {
			BundleID:       modifyTargetBundleID,
			ProductCode:    modifyProductCode,
			SubProductCode: modifySubProductCode,
			Pid:            modifyPid,
			CategoryIDs: []store.CategoryIDEntry{
				{Scene: "purchase", Category: 100061},
				{Scene: "modify", Category: 2025048},
			},
			SVList: map[string]int64{"sv_cpu": 4, "sv_mem": 8, "sv_disk": 80},
		},
	}
}

func stdPlaceModifyOrderReq() PlaceModifyOrderRequest {
	return PlaceModifyOrderRequest{
		ExternalUserID: "user-1",
		Uin:            "1000123456",
		AppID:          "10001",
		ResourceID:     "lhpass-r1",
		SourceBundleID: modifySourceBundleID,
		TargetBundleID: modifyTargetBundleID,
		CurDeadline:    "2026-06-15 10:30:00",
		PayMode:        1,
	}
}

// newModifyDeps 在 newStdDeps 之上把 BundleStore 换成源/目标双套餐，
// 并让 ctl 对任意 bundleId 都返 ONLINE。
func newModifyDeps() *stdDeps {
	d := newStdDeps()
	flowReader := &fakeModifyFlowReader{err: store.ErrFlowNotFound}
	d.bundle = &fakeBundleStore{defs: modifyDefs()}
	d.ctl = &fakeCTL{getBundleByIDFn: func(_ context.Context, id string) (*ctlclient.BundleDetail, error) {
		return &ctlclient.BundleDetail{BundleID: id, BundleName: "Cruise", BundleState: "ONLINE"}, nil
	}}
	d.service = New(Deps{
		CTLClient:        d.ctl,
		BundleStore:      d.bundle,
		JifeiClient:      d.jifei,
		OrderWriter:      d.writer,
		OrderStore:       d.store,
		ModifyFlowReader: flowReader,
	})
	return d
}

// 两步式下单：goodsDetail 形状 + trade_order 落库的关键字段。
func TestPlaceModifyOrderHappyPath(t *testing.T) {
	d := newModifyDeps()

	got, err := d.service.PlaceModifyOrder(context.Background(), stdPlaceModifyOrderReq())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.DealName == "" || got.BigOrderID == "" {
		t.Fatalf("DealName/BigOrderID empty: %+v", got)
	}

	jr := d.jifei.lastGenerateDealsReq
	if jr == nil || len(jr.Goods) != 1 {
		t.Fatalf("expected exactly one Goods item, got %+v", jr)
	}
	if jr.AppID != 10001 {
		t.Errorf("AppID = %d, want 10001", jr.AppID)
	}
	gi := jr.Goods[0]
	if gi.GoodsCategoryID != 2025048 {
		t.Errorf("GoodsCategoryID = %d, want 2025048 (target scene=modify)", gi.GoodsCategoryID)
	}
	if gi.GoodsNum != 1 {
		t.Errorf("GoodsNum = %d, want 1 (变配协议固定 1)", gi.GoodsNum)
	}
	gd := gi.GoodsDetail
	if gd["resourceId"] != "lhpass-r1" || gd["curDeadline"] != "2026-06-15 10:30:00" {
		t.Errorf("resourceId/curDeadline mis-set: %+v", gd)
	}
	if gd["bundleId"] != modifySourceBundleID || gd["newBundleId"] != modifyTargetBundleID {
		t.Errorf("bundleId/newBundleId = %v/%v", gd["bundleId"], gd["newBundleId"])
	}
	// oldConfig/newConfig 是 map[string]interface{}：内层除 sv_* 外还自带
	// pid/productCode/subProductCode（计费变配询价读内层三件套，缺则 371008）。
	newConfig, ok := gd["newConfig"].(map[string]interface{})
	if !ok || newConfig["sv_cpu"] != int64(4) || newConfig["sv_disk"] != int64(80) {
		t.Errorf("newConfig = %v (%T), want target sv list", gd["newConfig"], gd["newConfig"])
	}
	oldConfig, ok := gd["oldConfig"].(map[string]interface{})
	if !ok || oldConfig["sv_cpu"] != int64(2) || oldConfig["sv_disk"] != int64(60) {
		t.Errorf("oldConfig = %v (%T), want source sv list", gd["oldConfig"], gd["oldConfig"])
	}
	for label, config := range map[string]map[string]interface{}{"oldConfig": oldConfig, "newConfig": newConfig} {
		if config["pid"] != modifyPid {
			t.Errorf("%s.pid = %v, want %d", label, config["pid"], modifyPid)
		}
		if config["productCode"] != modifyProductCode {
			t.Errorf("%s.productCode = %v, want %q", label, config["productCode"], modifyProductCode)
		}
		if config["subProductCode"] != modifySubProductCode {
			t.Errorf("%s.subProductCode = %v, want %q", label, config["subProductCode"], modifySubProductCode)
		}
	}

	in := d.writer.lastCreateOrderInput
	if in.OrderType != store.OrderTypeModify {
		t.Errorf("OrderType = %q, want %q", in.OrderType, store.OrderTypeModify)
	}
	// bundle_id 落目标套餐：订单卖的是"升到巡游"。
	if in.BundleID != modifyTargetBundleID {
		t.Errorf("BundleID = %q, want target %q", in.BundleID, modifyTargetBundleID)
	}
	if in.ResourceID != "lhpass-r1" || in.ResourceType != "pass" {
		t.Errorf("ResourceID/ResourceType = %q/%q", in.ResourceID, in.ResourceType)
	}
	if in.Status != "pending_pay" {
		t.Errorf("Status = %q, want pending_pay", in.Status)
	}
	// 变配不改到期时间，period/time_unit 不该被填。
	if in.Period != 0 || in.TimeUnit != "" {
		t.Errorf("Period/TimeUnit = %d/%q, want zero values for modify", in.Period, in.TimeUnit)
	}
}

// 询价和下单必须送出完全一致的 goodsDetail，否则确认页差价与实际扣款不一致。
// 这里锁住"两个变体走同一构造器"这件事（inquiry 侧的一致性由共享的
// jifei.BuildModifyGoodsDetail 保证，跨包无法在单测里直接对比）。
func TestPlaceModifyOrderVariantsShareGoodsDetail(t *testing.T) {
	twoStep := newModifyDeps()
	if _, err := twoStep.service.PlaceModifyOrder(context.Background(), stdPlaceModifyOrderReq()); err != nil {
		t.Fatalf("PlaceModifyOrder: %v", err)
	}

	oneShot := newModifyDeps()
	oneShot.jifei.generateDealsAndPayFn = func(_ context.Context, _ *jifeiclient.GenerateDealsAndPayRequest) (*jifeiclient.GenerateDealsAndPayResponse, error) {
		return modifyDealsAndPayResp(), nil
	}
	if _, err := oneShot.service.PlaceModifyOrderAndPay(context.Background(), stdPlaceModifyOrderReq()); err != nil {
		t.Fatalf("PlaceModifyOrderAndPay: %v", err)
	}

	want := twoStep.jifei.lastGenerateDealsReq.Goods[0].GoodsDetail
	got := oneShot.jifei.lastGenerateDealsAndPayReq.Goods[0].GoodsDetail
	if len(got) != len(want) {
		t.Fatalf("goodsDetail key count differs: one-shot=%d two-step=%d", len(got), len(want))
	}
	for k, wantValue := range want {
		gotValue, exists := got[k]
		if !exists {
			t.Errorf("one-shot goodsDetail missing key %q", k)
			continue
		}
		// oldConfig / newConfig 是 map，逐键比。
		wantMap, isMap := wantValue.(map[string]interface{})
		if !isMap {
			if gotValue != wantValue {
				t.Errorf("goodsDetail[%q] = %v, want %v", k, gotValue, wantValue)
			}
			continue
		}
		gotMap, ok := gotValue.(map[string]interface{})
		if !ok {
			t.Errorf("goodsDetail[%q] type = %T, want map[string]interface{}", k, gotValue)
			continue
		}
		if len(gotMap) != len(wantMap) {
			t.Errorf("goodsDetail[%q] key count = %d, want %d", k, len(gotMap), len(wantMap))
		}
		for sv, v := range wantMap {
			if gotMap[sv] != v {
				t.Errorf("goodsDetail[%q][%q] = %v, want %v", k, sv, gotMap[sv], v)
			}
		}
	}
}

func modifyDealsAndPayResp() *jifeiclient.GenerateDealsAndPayResponse {
	return &jifeiclient.GenerateDealsAndPayResponse{
		DealNames:  []string{"20260509000000001-001"},
		BigDealIDs: []string{"20260509000000001"},
		ResourceIDs: map[string][]string{
			"20260509000000001-001": {"lhpass-r1"},
		},
		DealDeliverResults: map[string]map[string]interface{}{
			"20260509000000001-001": {"state": "0"},
		},
	}
}

// 一体化路径：同步发货成功才落库，且直接落完成态。
func TestPlaceModifyOrderAndPayPersistsOnlyOnSyncDelivery(t *testing.T) {
	d := newModifyDeps()
	d.jifei.generateDealsAndPayFn = func(_ context.Context, _ *jifeiclient.GenerateDealsAndPayRequest) (*jifeiclient.GenerateDealsAndPayResponse, error) {
		return modifyDealsAndPayResp(), nil
	}

	got, err := d.service.PlaceModifyOrderAndPay(context.Background(), stdPlaceModifyOrderReq())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.DealName != "20260509000000001-001" || got.BigOrderID != "20260509000000001" {
		t.Errorf("unexpected result: %+v", got)
	}
	if d.jifei.generateDealsCalls.Load() != 0 {
		t.Errorf("两步式 GenerateDeals 不应被调用, got %d", d.jifei.generateDealsCalls.Load())
	}
	req := d.jifei.lastGenerateDealsAndPayReq
	if req.AutoVoucher == nil || *req.AutoVoucher != 1 {
		t.Errorf("AutoVoucher = %v, want *1", req.AutoVoucher)
	}
	in := d.writer.lastCreateOrderInput
	if in.Status != "provisioned" {
		t.Errorf("Status = %q, want provisioned", in.Status)
	}
	if in.OrderType != store.OrderTypeModify {
		t.Errorf("OrderType = %q, want %q", in.OrderType, store.OrderTypeModify)
	}
}

// 异步中态（state="1"）已经完成扣款，必须先落 paid_pending_provision；
// 后续由 jifei 回调 modifyResource 把同一订单推进到 provisioned。
func TestPlaceModifyOrderAndPayPersistsPaidPendingProvisionOnAsyncDelivery(t *testing.T) {
	d := newModifyDeps()
	d.jifei.generateDealsAndPayFn = func(_ context.Context, _ *jifeiclient.GenerateDealsAndPayRequest) (*jifeiclient.GenerateDealsAndPayResponse, error) {
		resp := modifyDealsAndPayResp()
		resp.DealDeliverResults["20260509000000001-001"]["state"] = "1"
		resp.ResourceIDs["20260509000000001-001"] = nil
		return resp, nil
	}

	if _, err := d.service.PlaceModifyOrderAndPay(context.Background(), stdPlaceModifyOrderReq()); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if d.writer.createOrderCalls.Load() != 1 {
		t.Fatalf("CreateOrder calls=%d, want 1 for paid async delivery",
			d.writer.createOrderCalls.Load())
	}
	in := d.writer.lastCreateOrderInput
	if in.Status != store.OrderStatusPaidPendingProvision {
		t.Errorf("Status = %q, want %q", in.Status, store.OrderStatusPaidPendingProvision)
	}
	if in.ResourceID != "lhpass-r1" || in.OrderType != store.OrderTypeModify {
		t.Errorf("async modify order = %+v", in)
	}
}

func TestPlaceModifyOrderAndPayPromotesOrderWhenCompletionWonInsertRace(t *testing.T) {
	d := newModifyDeps()
	d.jifei.generateDealsAndPayFn = func(_ context.Context, _ *jifeiclient.GenerateDealsAndPayRequest) (*jifeiclient.GenerateDealsAndPayResponse, error) {
		resp := modifyDealsAndPayResp()
		resp.DealDeliverResults["20260509000000001-001"]["state"] = "1"
		resp.ResourceIDs["20260509000000001-001"] = nil
		return resp, nil
	}
	reader := d.service.deps.ModifyFlowReader.(*fakeModifyFlowReader)
	resourceID := "lhpass-r1"
	reader.err = nil
	reader.flow = &store.Flow{
		ID:         9001,
		DealName:   "20260509000000001-001",
		ResourceID: &resourceID,
		FlowType:   store.FlowTypeModifyResource,
		AppID:      "10001",
		Status:     store.FlowStatusCompleted,
	}

	if _, err := d.service.PlaceModifyOrderAndPay(context.Background(), stdPlaceModifyOrderReq()); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if reader.calls != 1 {
		t.Fatalf("GetFlow calls=%d, want 1", reader.calls)
	}
	if d.writer.markProvisionedCalls.Load() != 1 {
		t.Fatalf("MarkOrderProvisioned calls=%d, want 1", d.writer.markProvisionedCalls.Load())
	}
}

func TestPlaceModifyOrderInvalidInput(t *testing.T) {
	d := newModifyDeps()
	base := stdPlaceModifyOrderReq()
	cases := []struct {
		name string
		mut  func(*PlaceModifyOrderRequest)
		want string
	}{
		{"missing resource_id", func(r *PlaceModifyOrderRequest) { r.ResourceID = "" }, "resource_id"},
		{"missing source", func(r *PlaceModifyOrderRequest) { r.SourceBundleID = "" }, "source_bundle_id"},
		{"missing target", func(r *PlaceModifyOrderRequest) { r.TargetBundleID = "" }, "target_bundle_id"},
		{"same source and target", func(r *PlaceModifyOrderRequest) { r.TargetBundleID = r.SourceBundleID }, "must differ"},
		{"missing cur_deadline", func(r *PlaceModifyOrderRequest) { r.CurDeadline = "" }, "cur_deadline"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			req := base
			c.mut(&req)
			_, err := d.service.PlaceModifyOrder(context.Background(), req)
			if err == nil || !errors.Is(err, ErrInvalidInput) || !strings.Contains(err.Error(), c.want) {
				t.Errorf("err = %v, want ErrInvalidInput containing %q", err, c.want)
			}
		})
	}
}

func TestPlaceModifyOrderRejectsCrossSubProduct(t *testing.T) {
	d := newModifyDeps()
	defs := modifyDefs()
	defs[modifyTargetBundleID].SubProductCode = "sp_lightvela_ai_cn"
	d.bundle.defs = defs

	_, err := d.service.PlaceModifyOrder(context.Background(), stdPlaceModifyOrderReq())
	if !errors.Is(err, ErrModifyCrossSubProduct) {
		t.Fatalf("err = %v, want ErrModifyCrossSubProduct", err)
	}
}

// 缺 scene=modify 的 categoryId 时 fail-closed，且不能真的去下单——
// 那会创建一笔语义错误的真实订单。
func TestPlaceModifyOrderRequiresModifyCategoryID(t *testing.T) {
	d := newModifyDeps()
	defs := modifyDefs()
	defs[modifyTargetBundleID].CategoryIDs = []store.CategoryIDEntry{{Scene: "purchase", Category: 100061}}
	d.bundle.defs = defs

	_, err := d.service.PlaceModifyOrder(context.Background(), stdPlaceModifyOrderReq())
	if err == nil || !strings.Contains(err.Error(), "category_ids[scene=modify]") {
		t.Fatalf("err = %v, want missing modify category error", err)
	}
	if d.jifei.generateDealsCalls.Load() != 0 {
		t.Errorf("GenerateDeals must not be called, calls=%d", d.jifei.generateDealsCalls.Load())
	}
}

func TestPlaceModifyOrderRejectsOfflineTargetBundle(t *testing.T) {
	d := newModifyDeps()
	d.ctl.getBundleByIDFn = func(_ context.Context, id string) (*ctlclient.BundleDetail, error) {
		return &ctlclient.BundleDetail{BundleID: id, BundleState: "OFFLINE"}, nil
	}

	_, err := d.service.PlaceModifyOrder(context.Background(), stdPlaceModifyOrderReq())
	if !errors.Is(err, ErrBundleOffline) {
		t.Fatalf("err = %v, want ErrBundleOffline", err)
	}
}
