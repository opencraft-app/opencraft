package jifei

import (
	"context"
	"errors"
	"reflect"
	"sort"
	"testing"

	"git.woa.com/wisp/mono/trade/internal/jifeiclient"
	"git.woa.com/wisp/mono/trade/internal/store"
)

// ---------------------------------------------------------------------------
// fake jifeiclient.Client
// ---------------------------------------------------------------------------

// fakeJifei 是 jifeiclient.Client 接口的测试替身。
//
// 通过 GetPriceFn / GenerateDealsFn 注入预期行为；同时记录 LastGetPriceReq /
// LastGenerateDealsReq 供断言协议层入参字段拼装是否正确（sv_* 展平 / productInfo
// 透传 / fixed regionId/zoneId / Q42 不传 currency 等约束）。
type fakeJifei struct {
	GetPriceFn       func(ctx context.Context, req *jifeiclient.GetPriceRequest) (*jifeiclient.GetPriceResponse, error)
	GenerateDealsFn  func(ctx context.Context, req *jifeiclient.GenerateDealsRequest) (*jifeiclient.GenerateDealsResponse, error)

	LastGetPriceReq      *jifeiclient.GetPriceRequest
	LastGenerateDealsReq *jifeiclient.GenerateDealsRequest
}

func (f *fakeJifei) GetPrice(ctx context.Context, req *jifeiclient.GetPriceRequest) (*jifeiclient.GetPriceResponse, error) {
	f.LastGetPriceReq = req
	if f.GetPriceFn != nil {
		return f.GetPriceFn(ctx, req)
	}
	return &jifeiclient.GetPriceResponse{}, nil
}

func (f *fakeJifei) GenerateDeals(ctx context.Context, req *jifeiclient.GenerateDealsRequest) (*jifeiclient.GenerateDealsResponse, error) {
	f.LastGenerateDealsReq = req
	if f.GenerateDealsFn != nil {
		return f.GenerateDealsFn(ctx, req)
	}
	return &jifeiclient.GenerateDealsResponse{}, nil
}

// 编译期断言：fakeJifei 实现 jifeiclient.Client。
var _ jifeiclient.Client = (*fakeJifei)(nil)

// ---------------------------------------------------------------------------
// fake BundleDefinitionStore
// ---------------------------------------------------------------------------

// fakeBundleDefStore 用 map 模拟 trade_bundle_definition 表；不存在时返
// store.ErrBundleDefinitionNotFound（与真 DAO 行为对齐）。
type fakeBundleDefStore struct {
	defs map[string]*store.BundleDefinition

	// CallLog 记录调用顺序，便于断言 InquiryBatch 是否按 BundleIDs 顺序反查。
	CallLog []string
}

func (f *fakeBundleDefStore) GetBundleDefinitionByID(ctx context.Context, bundleID string) (*store.BundleDefinition, error) {
	f.CallLog = append(f.CallLog, bundleID)
	d, ok := f.defs[bundleID]
	if !ok {
		return nil, store.ErrBundleDefinitionNotFound
	}
	return d, nil
}

var _ store.BundleDefinitionStore = (*fakeBundleDefStore)(nil)

// ---------------------------------------------------------------------------
// 测试 fixture：常用 BundleDefinition
// ---------------------------------------------------------------------------

func makeBundleDef(bundleID string) *store.BundleDefinition {
	return &store.BundleDefinition{
		ID:             1,
		BundleID:       bundleID,
		ProductCode:    "p_lighthouse",
		SubProductCode: "sp_lighthouse_basic",
		Pid:            "10001",
		CategoryIDs: []store.CategoryIDEntry{
			{Scene: "purchase", Category: "100059"},
			{Scene: "renew", Category: "100060"},
		},
		SVList: map[string]interface{}{
			"cpu":      "2",
			"memory":   "4",
			"bandwidth": "5",
		},
		ProductInfo: []map[string]interface{}{
			{"key": "image", "value": "ubuntu-22.04"},
			{"key": "instance_family", "value": "general"},
		},
	}
}

// ---------------------------------------------------------------------------
// InquiryBatch 测试
// ---------------------------------------------------------------------------

func TestInquiryBatch_HappyPath(t *testing.T) {
	t.Parallel()

	defStore := &fakeBundleDefStore{
		defs: map[string]*store.BundleDefinition{
			"bundle-001": makeBundleDef("bundle-001"),
			"bundle-002": makeBundleDef("bundle-002"),
		},
	}
	jf := &fakeJifei{
		GetPriceFn: func(ctx context.Context, req *jifeiclient.GetPriceRequest) (*jifeiclient.GetPriceResponse, error) {
			return &jifeiclient.GetPriceResponse{
				Data: []jifeiclient.GetPriceData{
					{
						Price: "100.00", TotalCost: "100.00", RealTotalCost: "80.00",
						Currency: "CNY",
						PolicyDetail: &jifeiclient.PolicyDetail{Total: 0.8, User: 0.9, Common: 0.89},
					},
					{
						Price: "200.00", TotalCost: "200.00", RealTotalCost: "180.00",
						Currency: "CNY",
						PolicyDetail: &jifeiclient.PolicyDetail{Total: 0.9},
					},
				},
			}, nil
		},
	}
	a := New(jf, defStore)

	got, err := a.InquiryBatch(context.Background(), &InquiryRequest{
		OwnerUin:  "1001",
		Uin:       "1001",
		BundleIDs: []string{"bundle-001", "bundle-002"},
		Period:    1,
		TimeUnit:  "m",
		GoodsNum:  1,
		Currency:  "CNY",
	})
	if err != nil {
		t.Fatalf("InquiryBatch: unexpected error: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("len(got)=%d want 2", len(got))
	}

	// 1) bundle 顺序 1:1 对应
	if got[0].BundleID != "bundle-001" || got[1].BundleID != "bundle-002" {
		t.Errorf("bundle id order mismatch: %+v", got)
	}
	// 2) 价格透传
	if got[0].Price != "100.00" || got[0].RealTotalCost != "80.00" || got[1].RealTotalCost != "180.00" {
		t.Errorf("price field passthrough mismatch: %+v", got)
	}
	// 3) policyDetail.total 拍平为 discount
	if got[0].Discount != 0.8 || got[1].Discount != 0.9 {
		t.Errorf("discount flatten mismatch: got[0]=%v got[1]=%v", got[0].Discount, got[1].Discount)
	}
	// 4) Currency
	if got[0].Currency != "CNY" {
		t.Errorf("currency passthrough mismatch: %v", got[0].Currency)
	}

	// 5) defStore 调用顺序与 BundleIDs 一致
	if !reflect.DeepEqual(defStore.CallLog, []string{"bundle-001", "bundle-002"}) {
		t.Errorf("bundleDef call order mismatch: %v", defStore.CallLog)
	}

	// 6) jifeiclient 入参拼装：fixed regionId/zoneId、scene=purchase、payMode=1
	req := jf.LastGetPriceReq
	if req == nil {
		t.Fatal("LastGetPriceReq is nil")
	}
	if req.OwnerUin != "1001" || req.Uin != "1001" {
		t.Errorf("ownerUin/uin not propagated: %+v", req)
	}
	if len(req.ResInfo) != 2 {
		t.Fatalf("ResInfo size mismatch: %d", len(req.ResInfo))
	}
	for i, ri := range req.ResInfo {
		if ri.RegionID != fixedRegionID {
			t.Errorf("ResInfo[%d].RegionID = %d want %d", i, ri.RegionID, fixedRegionID)
		}
		if ri.ZoneID != fixedZoneID {
			t.Errorf("ResInfo[%d].ZoneID = %d want %d", i, ri.ZoneID, fixedZoneID)
		}
		if ri.GoodsNum != 1 {
			t.Errorf("ResInfo[%d].GoodsNum = %d want 1", i, ri.GoodsNum)
		}
		if ri.PayMode != 1 {
			t.Errorf("ResInfo[%d].PayMode = %d want 1", i, ri.PayMode)
		}
		if ri.Action != "purchase" {
			t.Errorf("ResInfo[%d].Action = %s want purchase", i, ri.Action)
		}
		if ri.GoodsCategoryID != "100059" {
			t.Errorf("ResInfo[%d].GoodsCategoryID = %s want 100059 (purchase scene)", i, ri.GoodsCategoryID)
		}
		if ri.Currency != "CNY" {
			t.Errorf("ResInfo[%d].Currency = %s want CNY", i, ri.Currency)
		}
	}
}

func TestInquiryBatch_GoodsDetailFlattenSV(t *testing.T) {
	t.Parallel()

	def := makeBundleDef("bundle-001")
	defStore := &fakeBundleDefStore{
		defs: map[string]*store.BundleDefinition{"bundle-001": def},
	}
	jf := &fakeJifei{
		GetPriceFn: func(ctx context.Context, req *jifeiclient.GetPriceRequest) (*jifeiclient.GetPriceResponse, error) {
			return &jifeiclient.GetPriceResponse{
				Data: []jifeiclient.GetPriceData{{Price: "1", TotalCost: "1", RealTotalCost: "1", Currency: "CNY"}},
			}, nil
		},
	}
	a := New(jf, defStore)

	if _, err := a.InquiryBatch(context.Background(), &InquiryRequest{
		OwnerUin: "1001", Uin: "1001",
		BundleIDs: []string{"bundle-001"},
		Period:    3, TimeUnit: "m", GoodsNum: 1, Currency: "CNY",
	}); err != nil {
		t.Fatalf("InquiryBatch: %v", err)
	}

	gd := jf.LastGetPriceReq.ResInfo[0].GoodsDetail
	if gd == nil {
		t.Fatal("GoodsDetail is nil")
	}

	// 基础字段
	checkEq := func(k string, want interface{}) {
		t.Helper()
		if !reflect.DeepEqual(gd[k], want) {
			t.Errorf("GoodsDetail[%s] = %v want %v", k, gd[k], want)
		}
	}
	checkEq("productCode", "p_lighthouse")
	checkEq("subProductCode", "sp_lighthouse_basic")
	checkEq("pid", "10001")
	checkEq("timeSpan", 3)
	checkEq("timeUnit", "m")

	// sv_* 展平：sv_list.cpu="2" → goodsDetail.sv_cpu="2"
	checkEq("sv_cpu", "2")
	checkEq("sv_memory", "4")
	checkEq("sv_bandwidth", "5")

	// 关键负面断言：原始 key（不带 sv_ 前缀）不应出现
	for _, k := range []string{"cpu", "memory", "bandwidth"} {
		if _, exist := gd[k]; exist {
			t.Errorf("GoodsDetail should NOT contain raw key %q (must be sv_-prefixed)", k)
		}
	}

	// productInfo 透传（数组）
	pi, ok := gd["productInfo"].([]map[string]interface{})
	if !ok {
		t.Fatalf("GoodsDetail[productInfo] type unexpected: %T", gd["productInfo"])
	}
	if len(pi) != 2 {
		t.Errorf("productInfo length = %d want 2", len(pi))
	}

	// 互斥校验：sv_productInfo 不应作为 sv_* 展平的副产品出现（productInfo 不在 sv_list 里）
	if _, exist := gd["sv_productInfo"]; exist {
		t.Errorf("GoodsDetail should NOT have sv_productInfo (productInfo is array, not sv_)")
	}
}

func TestInquiryBatch_BundleDefinitionNotFound(t *testing.T) {
	t.Parallel()

	defStore := &fakeBundleDefStore{
		defs: map[string]*store.BundleDefinition{
			"bundle-001": makeBundleDef("bundle-001"),
			// "bundle-missing" 不存在
		},
	}
	jf := &fakeJifei{}
	a := New(jf, defStore)

	_, err := a.InquiryBatch(context.Background(), &InquiryRequest{
		OwnerUin: "1001", Uin: "1001",
		BundleIDs: []string{"bundle-001", "bundle-missing"},
		Period:    1, TimeUnit: "m", GoodsNum: 1, Currency: "CNY",
	})
	if err == nil {
		t.Fatal("InquiryBatch should fail when bundle not found")
	}
	if !errors.Is(err, store.ErrBundleDefinitionNotFound) {
		t.Errorf("error should wrap ErrBundleDefinitionNotFound, got: %v", err)
	}
	// 缺失的 bundle 失败后不应继续调用 jifei
	if jf.LastGetPriceReq != nil {
		t.Error("jifei should NOT be called when bundle definition lookup fails")
	}
}

func TestInquiryBatch_MissingPurchaseCategory(t *testing.T) {
	t.Parallel()

	def := makeBundleDef("bundle-001")
	def.CategoryIDs = []store.CategoryIDEntry{
		{Scene: "renew", Category: "100060"}, // 没有 purchase 场景
	}
	defStore := &fakeBundleDefStore{
		defs: map[string]*store.BundleDefinition{"bundle-001": def},
	}
	jf := &fakeJifei{}
	a := New(jf, defStore)

	_, err := a.InquiryBatch(context.Background(), &InquiryRequest{
		OwnerUin: "1001", Uin: "1001",
		BundleIDs: []string{"bundle-001"},
		Period:    1, TimeUnit: "m", GoodsNum: 1, Currency: "CNY",
	})
	if err == nil {
		t.Fatal("expected error when purchase category missing")
	}
	if jf.LastGetPriceReq != nil {
		t.Error("jifei should NOT be called when category missing")
	}
}

func TestInquiryBatch_JifeiBusinessError(t *testing.T) {
	t.Parallel()

	defStore := &fakeBundleDefStore{
		defs: map[string]*store.BundleDefinition{"bundle-001": makeBundleDef("bundle-001")},
	}
	cgwErr := &jifeiclient.CGWError{ReturnCode: -10001, ReturnMessage: "uin not exists"}
	jf := &fakeJifei{
		GetPriceFn: func(ctx context.Context, req *jifeiclient.GetPriceRequest) (*jifeiclient.GetPriceResponse, error) {
			return nil, cgwErr
		},
	}
	a := New(jf, defStore)

	_, err := a.InquiryBatch(context.Background(), &InquiryRequest{
		OwnerUin: "1001", Uin: "1001",
		BundleIDs: []string{"bundle-001"},
		Period:    1, TimeUnit: "m", GoodsNum: 1, Currency: "CNY",
	})
	if err == nil {
		t.Fatal("expected error propagated from jifei")
	}
	var got *jifeiclient.CGWError
	if !errors.As(err, &got) {
		t.Errorf("error should wrap *CGWError (errors.As), got: %v", err)
	}
	if got != nil && got.ReturnCode != -10001 {
		t.Errorf("ReturnCode = %d want -10001", got.ReturnCode)
	}
}

func TestInquiryBatch_ResponseSizeMismatch(t *testing.T) {
	t.Parallel()

	defStore := &fakeBundleDefStore{
		defs: map[string]*store.BundleDefinition{
			"bundle-001": makeBundleDef("bundle-001"),
			"bundle-002": makeBundleDef("bundle-002"),
		},
	}
	jf := &fakeJifei{
		GetPriceFn: func(ctx context.Context, req *jifeiclient.GetPriceRequest) (*jifeiclient.GetPriceResponse, error) {
			// 故意只返 1 条
			return &jifeiclient.GetPriceResponse{
				Data: []jifeiclient.GetPriceData{{Price: "1", Currency: "CNY"}},
			}, nil
		},
	}
	a := New(jf, defStore)

	_, err := a.InquiryBatch(context.Background(), &InquiryRequest{
		OwnerUin: "1001", Uin: "1001",
		BundleIDs: []string{"bundle-001", "bundle-002"},
		Period:    1, TimeUnit: "m", GoodsNum: 1, Currency: "CNY",
	})
	if err == nil {
		t.Fatal("expected size mismatch error")
	}
}

func TestInquiryBatch_InputValidation(t *testing.T) {
	t.Parallel()

	a := New(&fakeJifei{}, &fakeBundleDefStore{})

	cases := []struct {
		name string
		req  *InquiryRequest
	}{
		{"nil", nil},
		{"empty bundles", &InquiryRequest{OwnerUin: "1", Uin: "1", Period: 1, TimeUnit: "m", GoodsNum: 1}},
		{"missing ownerUin", &InquiryRequest{Uin: "1", BundleIDs: []string{"a"}, Period: 1, TimeUnit: "m", GoodsNum: 1}},
		{"missing uin", &InquiryRequest{OwnerUin: "1", BundleIDs: []string{"a"}, Period: 1, TimeUnit: "m", GoodsNum: 1}},
		{"period zero", &InquiryRequest{OwnerUin: "1", Uin: "1", BundleIDs: []string{"a"}, Period: 0, TimeUnit: "m", GoodsNum: 1}},
		{"empty timeUnit", &InquiryRequest{OwnerUin: "1", Uin: "1", BundleIDs: []string{"a"}, Period: 1, GoodsNum: 1}},
		{"goodsNum zero", &InquiryRequest{OwnerUin: "1", Uin: "1", BundleIDs: []string{"a"}, Period: 1, TimeUnit: "m", GoodsNum: 0}},
	}
	for _, c := range cases {
		c := c
		t.Run(c.name, func(t *testing.T) {
			t.Parallel()
			if _, err := a.InquiryBatch(context.Background(), c.req); err == nil {
				t.Errorf("case %q should fail validation but got nil error", c.name)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// PlaceOrder 测试
// ---------------------------------------------------------------------------

func TestPlaceOrder_HappyPath(t *testing.T) {
	t.Parallel()

	defStore := &fakeBundleDefStore{
		defs: map[string]*store.BundleDefinition{"bundle-001": makeBundleDef("bundle-001")},
	}
	jf := &fakeJifei{
		GenerateDealsFn: func(ctx context.Context, req *jifeiclient.GenerateDealsRequest) (*jifeiclient.GenerateDealsResponse, error) {
			return &jifeiclient.GenerateDealsResponse{
				BigDealID: "big-2026050801",
				DealNames: []string{"deal-2026050801-1"},
				PriceInfos: []map[string]interface{}{
					{"realTotalCost": "80.00"},
				},
			}, nil
		},
	}
	a := New(jf, defStore)

	got, err := a.PlaceOrder(context.Background(), &PlaceOrderRequest{
		OwnerUin: "1001", Uin: "1001",
		BundleID: "bundle-001",
		Period:   1, TimeUnit: "m", GoodsNum: 1, PayMode: 1,
	})
	if err != nil {
		t.Fatalf("PlaceOrder: %v", err)
	}
	if got.BigOrderID != "big-2026050801" {
		t.Errorf("BigOrderID = %s want big-2026050801", got.BigOrderID)
	}
	if got.DealName != "deal-2026050801-1" {
		t.Errorf("DealName = %s want deal-2026050801-1", got.DealName)
	}

	// 协议层入参字段拼装
	req := jf.LastGenerateDealsReq
	if req == nil {
		t.Fatal("LastGenerateDealsReq is nil")
	}
	if req.OwnerUin != "1001" || req.Uin != "1001" {
		t.Errorf("ownerUin/uin propagation mismatch: %+v", req)
	}
	if len(req.GoodsInfos) != 1 {
		t.Fatalf("GoodsInfos length = %d want 1", len(req.GoodsInfos))
	}
	gi := req.GoodsInfos[0]
	if gi.GoodsCategoryID != "100059" {
		t.Errorf("GoodsCategoryID = %s want 100059", gi.GoodsCategoryID)
	}
	if gi.RegionID != fixedRegionID || gi.ZoneID != fixedZoneID {
		t.Errorf("region/zone fixed mismatch: region=%d zone=%d", gi.RegionID, gi.ZoneID)
	}
	if gi.GoodsNum != 1 {
		t.Errorf("GoodsNum = %d want 1", gi.GoodsNum)
	}
	if gi.PayMode != 1 {
		t.Errorf("PayMode = %d want 1 (Q42 Lighthouse 预付费)", gi.PayMode)
	}
	// GoodsDetail 同样应展平 sv_*
	if gi.GoodsDetail["sv_cpu"] != "2" {
		t.Errorf("GoodsDetail.sv_cpu = %v want 2", gi.GoodsDetail["sv_cpu"])
	}
	if gi.GoodsDetail["productCode"] != "p_lighthouse" {
		t.Errorf("GoodsDetail.productCode = %v want p_lighthouse", gi.GoodsDetail["productCode"])
	}
}

func TestPlaceOrder_BundleNotFound(t *testing.T) {
	t.Parallel()

	defStore := &fakeBundleDefStore{defs: map[string]*store.BundleDefinition{}}
	jf := &fakeJifei{}
	a := New(jf, defStore)

	_, err := a.PlaceOrder(context.Background(), &PlaceOrderRequest{
		OwnerUin: "1001", Uin: "1001", BundleID: "bundle-missing",
		Period: 1, TimeUnit: "m", GoodsNum: 1, PayMode: 1,
	})
	if err == nil || !errors.Is(err, store.ErrBundleDefinitionNotFound) {
		t.Errorf("expected wrapped ErrBundleDefinitionNotFound, got: %v", err)
	}
	if jf.LastGenerateDealsReq != nil {
		t.Error("jifei.GenerateDeals should NOT be called when bundle missing")
	}
}

func TestPlaceOrder_EmptyDealNames(t *testing.T) {
	t.Parallel()

	defStore := &fakeBundleDefStore{
		defs: map[string]*store.BundleDefinition{"bundle-001": makeBundleDef("bundle-001")},
	}
	jf := &fakeJifei{
		GenerateDealsFn: func(ctx context.Context, req *jifeiclient.GenerateDealsRequest) (*jifeiclient.GenerateDealsResponse, error) {
			return &jifeiclient.GenerateDealsResponse{
				BigDealID: "big-001",
				DealNames: []string{}, // 协议异常：BigDealId 有但 DealNames 空
			}, nil
		},
	}
	a := New(jf, defStore)

	_, err := a.PlaceOrder(context.Background(), &PlaceOrderRequest{
		OwnerUin: "1001", Uin: "1001", BundleID: "bundle-001",
		Period: 1, TimeUnit: "m", GoodsNum: 1, PayMode: 1,
	})
	if err == nil {
		t.Fatal("expected error when DealNames is empty")
	}
}

func TestPlaceOrder_JifeiBusinessError(t *testing.T) {
	t.Parallel()

	defStore := &fakeBundleDefStore{
		defs: map[string]*store.BundleDefinition{"bundle-001": makeBundleDef("bundle-001")},
	}
	cgwErr := &jifeiclient.CGWError{ReturnCode: -90404, ReturnMessage: "balance not enough"}
	jf := &fakeJifei{
		GenerateDealsFn: func(ctx context.Context, req *jifeiclient.GenerateDealsRequest) (*jifeiclient.GenerateDealsResponse, error) {
			return nil, cgwErr
		},
	}
	a := New(jf, defStore)

	_, err := a.PlaceOrder(context.Background(), &PlaceOrderRequest{
		OwnerUin: "1001", Uin: "1001", BundleID: "bundle-001",
		Period: 1, TimeUnit: "m", GoodsNum: 1, PayMode: 1,
	})
	if err == nil {
		t.Fatal("expected error propagated from jifei")
	}
	var got *jifeiclient.CGWError
	if !errors.As(err, &got) {
		t.Fatalf("error should wrap *CGWError, got: %v", err)
	}
	if got.ReturnCode != -90404 {
		t.Errorf("ReturnCode = %d want -90404", got.ReturnCode)
	}
}

func TestPlaceOrder_InputValidation(t *testing.T) {
	t.Parallel()

	a := New(&fakeJifei{}, &fakeBundleDefStore{})

	cases := []struct {
		name string
		req  *PlaceOrderRequest
	}{
		{"nil", nil},
		{"missing ownerUin", &PlaceOrderRequest{Uin: "1", BundleID: "a", Period: 1, TimeUnit: "m", GoodsNum: 1, PayMode: 1}},
		{"missing uin", &PlaceOrderRequest{OwnerUin: "1", BundleID: "a", Period: 1, TimeUnit: "m", GoodsNum: 1, PayMode: 1}},
		{"empty bundleID", &PlaceOrderRequest{OwnerUin: "1", Uin: "1", Period: 1, TimeUnit: "m", GoodsNum: 1, PayMode: 1}},
		{"period zero", &PlaceOrderRequest{OwnerUin: "1", Uin: "1", BundleID: "a", Period: 0, TimeUnit: "m", GoodsNum: 1, PayMode: 1}},
		{"empty timeUnit", &PlaceOrderRequest{OwnerUin: "1", Uin: "1", BundleID: "a", Period: 1, GoodsNum: 1, PayMode: 1}},
		{"goodsNum zero", &PlaceOrderRequest{OwnerUin: "1", Uin: "1", BundleID: "a", Period: 1, TimeUnit: "m", GoodsNum: 0, PayMode: 1}},
		{"payMode invalid", &PlaceOrderRequest{OwnerUin: "1", Uin: "1", BundleID: "a", Period: 1, TimeUnit: "m", GoodsNum: 1, PayMode: 99}},
	}
	for _, c := range cases {
		c := c
		t.Run(c.name, func(t *testing.T) {
			t.Parallel()
			if _, err := a.PlaceOrder(context.Background(), c.req); err == nil {
				t.Errorf("case %q should fail validation", c.name)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// buildGoodsDetail 内部纯函数测试
// ---------------------------------------------------------------------------

func TestBuildGoodsDetail_EmptySVList(t *testing.T) {
	t.Parallel()

	def := &store.BundleDefinition{
		ProductCode:    "p_lighthouse",
		SubProductCode: "sp_basic",
		Pid:            "10001",
		SVList:         map[string]interface{}{}, // 空对象合法
	}
	gd := buildGoodsDetail(def, 6, "m")
	if gd["productCode"] != "p_lighthouse" {
		t.Errorf("productCode = %v", gd["productCode"])
	}
	// 不应有任何 sv_ 前缀字段
	for k := range gd {
		if len(k) >= 3 && k[:3] == "sv_" {
			t.Errorf("empty SVList should not produce sv_* fields, but got %s", k)
		}
	}
	// productInfo 字段不应该出现（def.ProductInfo 是 nil）
	if _, ok := gd["productInfo"]; ok {
		t.Error("productInfo should be absent when def.ProductInfo is nil/empty")
	}
}

func TestBuildGoodsDetail_AllSVKeysPrefixed(t *testing.T) {
	t.Parallel()

	def := &store.BundleDefinition{
		SVList: map[string]interface{}{
			"alpha": "A", "beta": 2, "gamma": true,
		},
	}
	gd := buildGoodsDetail(def, 1, "m")

	// 收集所有 sv_ 前缀 key，验证集合等于 {sv_alpha, sv_beta, sv_gamma}
	got := []string{}
	for k := range gd {
		if len(k) >= 3 && k[:3] == "sv_" {
			got = append(got, k)
		}
	}
	sort.Strings(got)
	want := []string{"sv_alpha", "sv_beta", "sv_gamma"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("sv_ keys = %v want %v", got, want)
	}
	// 类型保持原样（map[string]interface{}）
	if gd["sv_beta"].(int) != 2 {
		t.Errorf("sv_beta type/value mismatch: %v", gd["sv_beta"])
	}
}
