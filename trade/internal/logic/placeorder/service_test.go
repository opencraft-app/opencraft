package placeorder

import (
	"context"
	"errors"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"git.woa.com/wisp/mono/trade/internal/cloudbillingclient"
	"git.woa.com/wisp/mono/trade/internal/ctlclient"
	"git.woa.com/wisp/mono/trade/internal/jifeiclient"
	"git.woa.com/wisp/mono/trade/internal/region"
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
func (f *fakeCTL) TransferPass(ctx context.Context, req *ctlclient.TransferPassRequest) (*ctlclient.PassDetail, error) {
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
	return nil, errors.New("IsolatePass not used in placeorder tests")
}

func (f *fakeCTL) RenewPass(_ context.Context, _ string, _ *ctlclient.RenewPassRequest) (*ctlclient.RenewPassResponse, error) {
	return nil, errors.New("RenewPass not used in placeorder tests")
}

func (f *fakeCTL) DestroyPass(_ context.Context, _ string, _ *ctlclient.DestroyPassRequest) (*ctlclient.DestroyPassResponse, error) {
	return nil, errors.New("DestroyPass not used in placeorder tests")
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
	return nil, errors.New("ListBundleDefsBySubProductCode not used in placeorder")
}
func (f *fakeBundleStore) GetBundleDefinitionsByIDs(_ context.Context, _ []string) (map[string]*store.BundleDefinition, error) {
	return nil, errors.New("GetBundleDefinitionsByIDs not used in placeorder")
}

type fakeJifei struct {
	generateDealsFn      func(ctx context.Context, req *jifeiclient.GenerateDealsRequest) (*jifeiclient.GenerateDealsResponse, error)
	generateDealsCalls   atomic.Int32
	lastGenerateDealsReq *jifeiclient.GenerateDealsRequest

	// 8B-1.5: GenerateDealsAndPay 钩子（jifei `qcloud.Deal.generateDealsAndPay` 一体化下单+支付接口）
	generateDealsAndPayFn      func(ctx context.Context, req *jifeiclient.GenerateDealsAndPayRequest) (*jifeiclient.GenerateDealsAndPayResponse, error)
	generateDealsAndPayCalls   atomic.Int32
	lastGenerateDealsAndPayReq *jifeiclient.GenerateDealsAndPayRequest

	// 8B-1.6: GetMidasEarmarking 钩子（jifei `qcloud.margin.getMidasEarmarking` 获取支付 URL）
	getMidasEarmarkingFn      func(ctx context.Context, req *jifeiclient.GetMidasEarmarkingRequest) (*jifeiclient.GetMidasEarmarkingResponse, error)
	getMidasEarmarkingCalls   atomic.Int32
	lastGetMidasEarmarkingReq *jifeiclient.GetMidasEarmarkingRequest

	// D-2.1: ModifyResourceStatus 钩子（jifei `qcloud.operation.ModifyResourceStatus` 销毁/隔离）
	// placeorder service 不会调 ModifyResourceStatus，本字段仅为满足 jifeiclient.Client 接口实现。
	modifyResourceStatusFn      func(ctx context.Context, req *jifeiclient.ModifyResourceStatusRequest) (*jifeiclient.ModifyResourceStatusResponse, error)
	modifyResourceStatusCalls   atomic.Int32
	lastModifyResourceStatusReq *jifeiclient.ModifyResourceStatusRequest
}

func (f *fakeJifei) GetPrice(ctx context.Context, req *jifeiclient.GetPriceRequest) (*jifeiclient.GetPriceResponse, error) {
	return nil, errors.New("not used")
}
func (f *fakeJifei) GenerateDeals(ctx context.Context, req *jifeiclient.GenerateDealsRequest) (*jifeiclient.GenerateDealsResponse, error) {
	f.generateDealsCalls.Add(1)
	f.lastGenerateDealsReq = req
	if f.generateDealsFn != nil {
		return f.generateDealsFn(ctx, req)
	}
	return nil, errors.New("fakeJifei: GenerateDeals not implemented")
}
func (f *fakeJifei) GenerateDealsAndPay(ctx context.Context, req *jifeiclient.GenerateDealsAndPayRequest) (*jifeiclient.GenerateDealsAndPayResponse, error) {
	f.generateDealsAndPayCalls.Add(1)
	f.lastGenerateDealsAndPayReq = req
	if f.generateDealsAndPayFn != nil {
		return f.generateDealsAndPayFn(ctx, req)
	}
	return nil, errors.New("fakeJifei: GenerateDealsAndPay not implemented")
}
func (f *fakeJifei) GetMidasEarmarking(ctx context.Context, req *jifeiclient.GetMidasEarmarkingRequest) (*jifeiclient.GetMidasEarmarkingResponse, error) {
	f.getMidasEarmarkingCalls.Add(1)
	f.lastGetMidasEarmarkingReq = req
	if f.getMidasEarmarkingFn != nil {
		return f.getMidasEarmarkingFn(ctx, req)
	}
	return nil, errors.New("fakeJifei: GetMidasEarmarking not implemented")
}

func (f *fakeJifei) ModifyResourceStatus(ctx context.Context, req *jifeiclient.ModifyResourceStatusRequest) (*jifeiclient.ModifyResourceStatusResponse, error) {
	f.modifyResourceStatusCalls.Add(1)
	f.lastModifyResourceStatusReq = req
	if f.modifyResourceStatusFn != nil {
		return f.modifyResourceStatusFn(ctx, req)
	}
	// placeorder service 不会调 ModifyResourceStatus，默认返 not implemented 让误用立即暴露
	return nil, errors.New("fakeJifei: ModifyResourceStatus not implemented (placeorder service shouldn't call it)")
}

func (f *fakeJifei) GetDealsByKeyIndex(ctx context.Context, req *jifeiclient.GetDealsByKeyIndexRequest) (*jifeiclient.GetDealsByKeyIndexResponse, error) {
	// placeorder service 不会调 GetDealsByKeyIndex（该接口由 trade orderstatus logic 直调不走
	// placeorder 包）。本方法仅为满足 jifeiclient.Client interface；默认返 not implemented 让误用立即暴露。
	return nil, errors.New("fakeJifei: GetDealsByKeyIndex not implemented (placeorder service shouldn't call it)")
}

// OnlineRefund（trade-pass-refund-design.md v0.5 引入）：placeorder service 不调 OnlineRefund（该接口
// 由 internalapi.refundResourceHandler 直调 jifeiclient.Client）。本方法仅为满足 interface 实现。
func (f *fakeJifei) OnlineRefund(ctx context.Context, req *jifeiclient.OnlineRefundRequest) (*jifeiclient.OnlineRefundResponse, error) {
	return nil, errors.New("fakeJifei: OnlineRefund not implemented (placeorder service shouldn't call it)")
}

type fakeCloudBilling struct {
	describeOrderListFn      func(ctx context.Context, credentials cloudbillingclient.TemporaryCredentials, req *cloudbillingclient.DescribeOrderListRequest) (*cloudbillingclient.DescribeOrderListResponse, error)
	describeOrderListCalls   atomic.Int32
	lastDescribeOrderListReq *cloudbillingclient.DescribeOrderListRequest
	createPayURLFn           func(ctx context.Context, credentials cloudbillingclient.TemporaryCredentials, req *cloudbillingclient.CreatePayURLRequest) (*cloudbillingclient.CreatePayURLResponse, error)
	createPayURLCalls        atomic.Int32
	lastCredentials          cloudbillingclient.TemporaryCredentials
	lastCreatePayURLReq      *cloudbillingclient.CreatePayURLRequest
}

func (f *fakeCloudBilling) DescribeOrderList(ctx context.Context, credentials cloudbillingclient.TemporaryCredentials, req *cloudbillingclient.DescribeOrderListRequest) (*cloudbillingclient.DescribeOrderListResponse, error) {
	f.describeOrderListCalls.Add(1)
	f.lastCredentials = credentials
	f.lastDescribeOrderListReq = req
	if f.describeOrderListFn != nil {
		return f.describeOrderListFn(ctx, credentials, req)
	}
	return nil, errors.New("fakeCloudBilling: DescribeOrderList not implemented")
}

func (f *fakeCloudBilling) CreatePayURL(ctx context.Context, credentials cloudbillingclient.TemporaryCredentials, req *cloudbillingclient.CreatePayURLRequest) (*cloudbillingclient.CreatePayURLResponse, error) {
	f.createPayURLCalls.Add(1)
	f.lastCredentials = credentials
	f.lastCreatePayURLReq = req
	if f.createPayURLFn != nil {
		return f.createPayURLFn(ctx, credentials, req)
	}
	return nil, errors.New("fakeCloudBilling: CreatePayURL not implemented")
}

type fakeShadowCredentials struct {
	getFn func(context.Context, string) (*shadowclient.TemporaryCredentials, error)
	calls atomic.Int32
}

func (f *fakeShadowCredentials) GetTemporaryCredentialsByExternalUserID(ctx context.Context, externalUserID string) (*shadowclient.TemporaryCredentials, error) {
	f.calls.Add(1)
	if f.getFn != nil {
		return f.getFn(ctx, externalUserID)
	}
	return &shadowclient.TemporaryCredentials{
		Uin:       "1000123456",
		OwnerUin:  "1000123456",
		SecretID:  "tmp-id",
		SecretKey: "tmp-key",
		Token:     "tmp-token",
		ExpiredAt: time.Now().Add(time.Hour),
	}, nil
}

type fakeOrderWriter struct {
	createOrderFn        func(ctx context.Context, in store.CreateOrderInput) error
	createOrderCalls     atomic.Int32
	lastCreateOrderInput store.CreateOrderInput
	markProvisionedFn    func(ctx context.Context, dealName, resourceID string) error
	markProvisionedCalls atomic.Int32

	// 8B-1.6: UpdatePayURL 钩子（GeneratePayURL 命中 jifei 后写回 trade_order.pay_url 缓存）
	updatePayURLFn        func(ctx context.Context, dealName, payURL string) error
	updatePayURLCalls     atomic.Int32
	lastUpdatePayURLDeal  string
	lastUpdatePayURLValue string
}

func (f *fakeOrderWriter) CreateOrder(ctx context.Context, in store.CreateOrderInput) error {
	f.createOrderCalls.Add(1)
	f.lastCreateOrderInput = in
	if f.createOrderFn != nil {
		return f.createOrderFn(ctx, in)
	}
	return nil
}

func (f *fakeOrderWriter) MarkOrderProvisioned(ctx context.Context, dealName, resourceID string) error {
	f.markProvisionedCalls.Add(1)
	if f.markProvisionedFn != nil {
		return f.markProvisionedFn(ctx, dealName, resourceID)
	}
	return nil
}

func (f *fakeOrderWriter) UpdatePayURL(ctx context.Context, dealName, payURL string) error {
	f.updatePayURLCalls.Add(1)
	f.lastUpdatePayURLDeal = dealName
	f.lastUpdatePayURLValue = payURL
	if f.updatePayURLFn != nil {
		return f.updatePayURLFn(ctx, dealName, payURL)
	}
	return nil
}

func (f *fakeOrderWriter) MarkOrderCancelled(ctx context.Context, dealName string) error {
	// placeorder service 不会调 MarkOrderCancelled（该接口由 trade orderstatus logic 调用，不走 placeorder。
	// 本方法仅为满足 store.OrderWriter interface）。
	return nil
}

type fakeOrderStore struct {
	getOrderByDealNameFn     func(ctx context.Context, dealName string) (*store.TradeOrder, error)
	findReusableFn           func(ctx context.Context, externalUserID string, activityID int64, bundleID string, createdAfter time.Time) (*store.TradeOrder, error)
	lastReusableCreatedAfter time.Time
}

func (f *fakeOrderStore) GetOrderByDealName(ctx context.Context, dealName string) (*store.TradeOrder, error) {
	if f.getOrderByDealNameFn != nil {
		return f.getOrderByDealNameFn(ctx, dealName)
	}
	return nil, errors.New("fakeOrderStore: GetOrderByDealName not implemented")
}

func (f *fakeOrderStore) FindReusableDianshiOrder(ctx context.Context, externalUserID string, activityID int64, bundleID string, createdAfter time.Time) (*store.TradeOrder, error) {
	f.lastReusableCreatedAfter = createdAfter
	if f.findReusableFn != nil {
		return f.findReusableFn(ctx, externalUserID, activityID, bundleID, createdAfter)
	}
	return nil, store.ErrTradeOrderNotFound
}

// ============================================================================
// helpers
// ============================================================================

// ptrString 返回字符串的指针；用于构造 jifeiclient 协议外字段（*string 类型）的测试 fixture。
func ptrString(s string) *string {
	return &s
}

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
		// Q71（2026-05-13）：SVList 强类型 map[string]int64。
		SVList: map[string]int64{
			"sv_cpu": 2,
			"sv_mem": 4,
		},
		ProductInfo: []map[string]interface{}{{"k": "v"}},
	}
}

func stdPlaceOrderReq() PlaceOrderRequest {
	return PlaceOrderRequest{
		ExternalUserID: "user-1",
		Uin:            "1000123456",
		AppID:          "10001",
		BundleID:       "bundle_linux_small",
		Period:         1,
		TimeUnit:       "m",
		GoodsNum:       1,
		PayMode:        1,
		// Q41 修订 2026-05-11：RegionID 字段已删除，trade 内部固定 1（广州）
	}
}

func stdJifeiDealsResp() *jifeiclient.GenerateDealsResponse {
	return &jifeiclient.GenerateDealsResponse{
		BigDealID: "20260509000000001",
		DealNames: []string{"20260509000000001-001"},
	}
}

// stdDeps 装配一组默认 fakes，单测里按需替换字段。
type stdDeps struct {
	ctl               *fakeCTL
	bundle            *fakeBundleStore
	jifei             *fakeJifei
	billing           *fakeCloudBilling
	shadowCredentials *fakeShadowCredentials
	writer            *fakeOrderWriter
	store             *fakeOrderStore
	service           *Service
}

func newStdDeps() *stdDeps {
	d := &stdDeps{
		ctl: &fakeCTL{
			getBundleByIDFn: func(ctx context.Context, bundleID string) (*ctlclient.BundleDetail, error) {
				return stdBundle(), nil
			},
		},
		bundle: &fakeBundleStore{def: stdDef()},
		jifei: &fakeJifei{
			generateDealsFn: func(ctx context.Context, req *jifeiclient.GenerateDealsRequest) (*jifeiclient.GenerateDealsResponse, error) {
				return stdJifeiDealsResp(), nil
			},
		},
		billing: &fakeCloudBilling{
			describeOrderListFn: func(_ context.Context, _ cloudbillingclient.TemporaryCredentials, req *cloudbillingclient.DescribeOrderListRequest) (*cloudbillingclient.DescribeOrderListResponse, error) {
				return &cloudbillingclient.DescribeOrderListResponse{Orders: []cloudbillingclient.OrderInfo{{
					OrderID: req.OrderIDs[0], RealTotalCost: "650",
				}}}, nil
			},
		},
		shadowCredentials: &fakeShadowCredentials{},
		writer:            &fakeOrderWriter{},
		store:             &fakeOrderStore{},
	}
	d.service = New(Deps{
		CTLClient:              d.ctl,
		BundleStore:            d.bundle,
		JifeiClient:            d.jifei,
		CloudBillingClient:     d.billing,
		ShadowCredentialClient: d.shadowCredentials,
		OrderWriter:            d.writer,
		OrderStore:             d.store,
	})
	return d
}

// ============================================================================
// PlaceOrder tests
// ============================================================================

func TestPlaceOrder_HappyPath(t *testing.T) {
	d := newStdDeps()
	res, err := d.service.PlaceOrder(context.Background(), stdPlaceOrderReq())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res.DealName != "20260509000000001-001" {
		t.Errorf("DealName mismatch: got %q", res.DealName)
	}
	if res.BigOrderID != "20260509000000001" {
		t.Errorf("BigOrderID mismatch: got %q", res.BigOrderID)
	}
	if res.PayURL != "" {
		t.Errorf("PayURL should be empty in PlaceOrder result, got %q", res.PayURL)
	}
	// jifei 入参验证
	if d.jifei.generateDealsCalls.Load() != 1 {
		t.Errorf("expected GenerateDeals called once, got %d", d.jifei.generateDealsCalls.Load())
	}
	jReq := d.jifei.lastGenerateDealsReq
	if jReq == nil {
		t.Fatal("expected lastGenerateDealsReq non-nil")
	}
	if jReq.OwnerUin != "1000123456" || jReq.Uin != "1000123456" {
		t.Errorf("OwnerUin/Uin mismatch: %+v", jReq)
	}
	if len(jReq.Goods) != 1 {
		t.Fatalf("expected GoodsInfos len 1, got %d", len(jReq.Goods))
	}
	gi := jReq.Goods[0]
	if gi.GoodsCategoryID != 100059 {
		t.Errorf("GoodsCategoryID mismatch: got %d", gi.GoodsCategoryID)
	}
	// Q41 修订 2026-05-11：trade 内部固定 RegionID=1 / ZoneID=100001
	if gi.RegionID != region.LighthouseRegionID || gi.ZoneID != region.LighthouseZoneID ||
		gi.GoodsNum != 1 || gi.PayMode != 1 {
		t.Errorf("RegionID/ZoneID/GoodsNum/PayMode mismatch: %+v", gi)
	}
	if gi.GoodsDetail["productCode"] != "p_lighthouse" {
		t.Errorf("goodsDetail.productCode mismatch: %+v", gi.GoodsDetail)
	}
	if gi.GoodsDetail["sv_cpu"] != int64(2) {
		t.Errorf("goodsDetail.sv_cpu mismatch: %+v", gi.GoodsDetail)
	}
	if gi.GoodsDetail["timeSpan"] != 1 {
		t.Errorf("goodsDetail.timeSpan mismatch: %+v", gi.GoodsDetail)
	}

	// trade_order 落库参数验证
	if d.writer.createOrderCalls.Load() != 1 {
		t.Errorf("expected CreateOrder called once, got %d", d.writer.createOrderCalls.Load())
	}
	in := d.writer.lastCreateOrderInput
	if in.DealName != "20260509000000001-001" {
		t.Errorf("CreateOrderInput.DealName mismatch: got %q", in.DealName)
	}
	if in.BigOrderID != "20260509000000001" {
		t.Errorf("CreateOrderInput.BigOrderID mismatch: got %q", in.BigOrderID)
	}
	if in.Status != "pending_pay" {
		t.Errorf("CreateOrderInput.Status mismatch: got %q", in.Status)
	}
	if in.SubProductCode != "sp_linux_small" {
		t.Errorf("CreateOrderInput.SubProductCode mismatch: got %q", in.SubProductCode)
	}
	if in.ResourceType != "pass" {
		t.Errorf("CreateOrderInput.ResourceType mismatch: got %q", in.ResourceType)
	}
	if in.GoodsDetail == nil || in.GoodsDetail["productCode"] != "p_lighthouse" {
		t.Errorf("CreateOrderInput.GoodsDetail mismatch: %+v", in.GoodsDetail)
	}
}

func TestPlaceOrder_IntlAutoRenewFlagAddsGoodsDetail(t *testing.T) {
	d := newStdDeps()
	d.service = New(Deps{
		CTLClient:   d.ctl,
		BundleStore: d.bundle,
		JifeiClient: d.jifei,
		OrderWriter: d.writer,
		OrderStore:  d.store,
		SiteKind:    "intl",
	})
	req := stdPlaceOrderReq()
	req.AutoRenewFlag = AutoRenewFlagAutoRenew

	if _, err := d.service.PlaceOrder(context.Background(), req); err != nil {
		t.Fatalf("PlaceOrder: %v", err)
	}
	if d.jifei.lastGenerateDealsReq == nil || len(d.jifei.lastGenerateDealsReq.Goods) != 1 {
		t.Fatalf("expected one generateDeals goods item, got %+v", d.jifei.lastGenerateDealsReq)
	}
	detail := d.jifei.lastGenerateDealsReq.Goods[0].GoodsDetail
	if detail["autoRenewFlag"] != 1 {
		t.Fatalf("jifei goodsDetail.autoRenewFlag = %v, want 1", detail["autoRenewFlag"])
	}
	if d.writer.lastCreateOrderInput.GoodsDetail["autoRenewFlag"] != 1 {
		t.Fatalf("persisted goodsDetail.autoRenewFlag = %v, want 1",
			d.writer.lastCreateOrderInput.GoodsDetail["autoRenewFlag"])
	}
}

func TestPlaceOrder_CnRejectsAutoRenewFlag(t *testing.T) {
	d := newStdDeps()
	req := stdPlaceOrderReq()
	req.AutoRenewFlag = AutoRenewFlagAutoRenew

	_, err := d.service.PlaceOrder(context.Background(), req)
	if !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("expected ErrInvalidInput, got %v", err)
	}
	if d.jifei.generateDealsCalls.Load() != 0 {
		t.Fatalf("jifei should not be called, got %d", d.jifei.generateDealsCalls.Load())
	}
}

func TestPlaceOrder_IntlRejectsUnknownAutoRenewFlag(t *testing.T) {
	d := newStdDeps()
	d.service = New(Deps{
		CTLClient:   d.ctl,
		BundleStore: d.bundle,
		JifeiClient: d.jifei,
		OrderWriter: d.writer,
		OrderStore:  d.store,
		SiteKind:    "intl",
	})
	req := stdPlaceOrderReq()
	req.AutoRenewFlag = "renew_forever"

	_, err := d.service.PlaceOrder(context.Background(), req)
	if !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("expected ErrInvalidInput, got %v", err)
	}
	if d.jifei.generateDealsCalls.Load() != 0 {
		t.Fatalf("jifei should not be called, got %d", d.jifei.generateDealsCalls.Load())
	}
}

func TestPlaceOrder_InvalidInput(t *testing.T) {
	cases := []struct {
		name string
		mut  func(req *PlaceOrderRequest)
	}{
		{"empty bundle_id", func(r *PlaceOrderRequest) { r.BundleID = "" }},
		{"empty external_user_id", func(r *PlaceOrderRequest) { r.ExternalUserID = "" }},
		{"empty uin", func(r *PlaceOrderRequest) { r.Uin = "" }},
		{"non-positive period", func(r *PlaceOrderRequest) { r.Period = 0 }},
		{"empty time_unit", func(r *PlaceOrderRequest) { r.TimeUnit = "" }},
		{"invalid pay_mode", func(r *PlaceOrderRequest) { r.PayMode = 99 }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			d := newStdDeps()
			req := stdPlaceOrderReq()
			tc.mut(&req)
			_, err := d.service.PlaceOrder(context.Background(), req)
			if !errors.Is(err, ErrInvalidInput) {
				t.Fatalf("expected ErrInvalidInput, got %v", err)
			}
			if d.jifei.generateDealsCalls.Load() != 0 {
				t.Error("jifei should not be called on validation failure")
			}
			if d.writer.createOrderCalls.Load() != 0 {
				t.Error("writer should not be called on validation failure")
			}
		})
	}
}

func TestPlaceOrder_GoodsNumZeroDefaultsToOne(t *testing.T) {
	d := newStdDeps()
	req := stdPlaceOrderReq()
	req.GoodsNum = 0
	res, err := d.service.PlaceOrder(context.Background(), req)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res.DealName == "" {
		t.Error("expected non-empty DealName")
	}
	jReq := d.jifei.lastGenerateDealsReq
	if jReq.Goods[0].GoodsNum != 1 {
		t.Errorf("expected GoodsNum default to 1, got %d", jReq.Goods[0].GoodsNum)
	}
}

func TestPlaceOrder_BundleNotFoundFromCTL(t *testing.T) {
	d := newStdDeps()
	d.ctl.getBundleByIDFn = func(ctx context.Context, bundleID string) (*ctlclient.BundleDetail, error) {
		return nil, ctlclient.ErrNotFound
	}
	_, err := d.service.PlaceOrder(context.Background(), stdPlaceOrderReq())
	if !errors.Is(err, ErrBundleNotFound) {
		t.Fatalf("expected ErrBundleNotFound, got %v", err)
	}
	if d.jifei.generateDealsCalls.Load() != 0 {
		t.Error("jifei should not be called when bundle not found")
	}
}

func TestPlaceOrder_BundleOffline(t *testing.T) {
	d := newStdDeps()
	d.ctl.getBundleByIDFn = func(ctx context.Context, bundleID string) (*ctlclient.BundleDetail, error) {
		b := stdBundle()
		b.BundleState = "OFFLINE"
		return b, nil
	}
	_, err := d.service.PlaceOrder(context.Background(), stdPlaceOrderReq())
	if !errors.Is(err, ErrBundleOffline) {
		t.Fatalf("expected ErrBundleOffline, got %v", err)
	}
}

func TestPlaceOrder_CTLGenericError(t *testing.T) {
	d := newStdDeps()
	d.ctl.getBundleByIDFn = func(ctx context.Context, bundleID string) (*ctlclient.BundleDetail, error) {
		return nil, errors.New("ctl 5xx")
	}
	_, err := d.service.PlaceOrder(context.Background(), stdPlaceOrderReq())
	if errors.Is(err, ErrBundleNotFound) || errors.Is(err, ErrBundleOffline) {
		t.Fatalf("generic ctl error should not be classified as NotFound/Offline: %v", err)
	}
	if err == nil {
		t.Fatal("expected error")
	}
}

func TestPlaceOrder_BundleDefinitionNotFound(t *testing.T) {
	d := newStdDeps()
	d.bundle.def = nil
	d.bundle.err = store.ErrBundleDefinitionNotFound
	_, err := d.service.PlaceOrder(context.Background(), stdPlaceOrderReq())
	if !errors.Is(err, ErrBundleNotFound) {
		t.Fatalf("expected ErrBundleNotFound, got %v", err)
	}
}

func TestPlaceOrder_MissingPurchaseCategory(t *testing.T) {
	d := newStdDeps()
	def := stdDef()
	def.CategoryIDs = []store.CategoryIDEntry{{Scene: "renew", Category: 100060}}
	d.bundle.def = def
	_, err := d.service.PlaceOrder(context.Background(), stdPlaceOrderReq())
	if err == nil || !strings.Contains(err.Error(), "purchase") {
		t.Fatalf("expected purchase category missing error, got %v", err)
	}
}

func TestPlaceOrder_JifeiCGWBusinessError(t *testing.T) {
	d := newStdDeps()
	d.jifei.generateDealsFn = func(ctx context.Context, req *jifeiclient.GenerateDealsRequest) (*jifeiclient.GenerateDealsResponse, error) {
		return nil, &jifeiclient.CGWError{
			ReturnCode:    40001,
			ReturnMessage: "deal already exists",
			InterfaceName: jifeiclient.InterfaceNameGenerateDeals,
			EventID:       1, // v1.7.4: int64
		}
	}
	_, err := d.service.PlaceOrder(context.Background(), stdPlaceOrderReq())
	var cgwErr *jifeiclient.CGWError
	if !errors.As(err, &cgwErr) {
		t.Fatalf("expected wrap of *CGWError, got %v", err)
	}
	if cgwErr.ReturnCode != 40001 {
		t.Errorf("ReturnCode mismatch: got %d", cgwErr.ReturnCode)
	}
	if d.writer.createOrderCalls.Load() != 0 {
		t.Error("trade_order should NOT be persisted when jifei generateDeals fails")
	}
}

func TestPlaceOrder_JifeiResponseInvalid(t *testing.T) {
	cases := []struct {
		name string
		resp *jifeiclient.GenerateDealsResponse
	}{
		{"nil response", nil},
		{"empty BigDealID", &jifeiclient.GenerateDealsResponse{BigDealID: "", DealNames: []string{"d1"}}},
		{"empty DealNames", &jifeiclient.GenerateDealsResponse{BigDealID: "big-1", DealNames: nil}},
		{"empty deal name string", &jifeiclient.GenerateDealsResponse{BigDealID: "big-1", DealNames: []string{""}}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			d := newStdDeps()
			d.jifei.generateDealsFn = func(ctx context.Context, req *jifeiclient.GenerateDealsRequest) (*jifeiclient.GenerateDealsResponse, error) {
				return tc.resp, nil
			}
			_, err := d.service.PlaceOrder(context.Background(), stdPlaceOrderReq())
			if !errors.Is(err, ErrJifeiResponseInvalid) {
				t.Fatalf("expected ErrJifeiResponseInvalid, got %v", err)
			}
			if d.writer.createOrderCalls.Load() != 0 {
				t.Error("trade_order should NOT be persisted")
			}
		})
	}
}

func TestPlaceOrder_TradeOrderDuplicate(t *testing.T) {
	d := newStdDeps()
	d.writer.createOrderFn = func(ctx context.Context, in store.CreateOrderInput) error {
		return store.ErrTradeOrderDuplicate
	}
	_, err := d.service.PlaceOrder(context.Background(), stdPlaceOrderReq())
	if !errors.Is(err, ErrDealNameDuplicate) {
		t.Fatalf("expected ErrDealNameDuplicate, got %v", err)
	}
}

func TestPlaceOrder_TradeOrderGenericPersistError(t *testing.T) {
	d := newStdDeps()
	d.writer.createOrderFn = func(ctx context.Context, in store.CreateOrderInput) error {
		return errors.New("connection reset")
	}
	_, err := d.service.PlaceOrder(context.Background(), stdPlaceOrderReq())
	if errors.Is(err, ErrDealNameDuplicate) || errors.Is(err, ErrInvalidInput) {
		t.Fatalf("generic persist error should not be classified: %v", err)
	}
	if err == nil {
		t.Fatal("expected error")
	}
}

// ============================================================================
// GeneratePayURL tests
// ============================================================================

func TestGeneratePayURL_HappyPath(t *testing.T) {
	d := newStdDeps()
	d.store.getOrderByDealNameFn = func(ctx context.Context, dealName string) (*store.TradeOrder, error) {
		return &store.TradeOrder{
			DealName: dealName,
			Uin:      "1000123456",
			AppID:    "251202221",
			PayURL:   "https://buy.cloud.tencent.com/abc",
		}, nil
	}
	detail, err := d.service.GeneratePayURL(context.Background(), "deal-1", nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if detail.PayURL != "https://buy.cloud.tencent.com/abc" {
		t.Errorf("url mismatch: %q", detail.PayURL)
	}
	// 命中缓存场景：Uin/AppID 来自 trade_order；URL 形态不含 /r/{appid}/ 也无 token_id query，
	// 协议外字段按 D3 兜底返 nil（验证不会被误置为空串）。
	if detail.Uin != "1000123456" {
		t.Errorf("Uin mismatch: %q", detail.Uin)
	}
	if detail.AppID != "251202221" {
		t.Errorf("AppID mismatch: %q", detail.AppID)
	}
	if detail.TokenID != nil {
		t.Errorf("TokenID: want nil for url without token_id query, got %v", *detail.TokenID)
	}
	if detail.OrderID != nil {
		t.Errorf("OrderID: want nil for url without out_trade_no query, got %v", *detail.OrderID)
	}
	if detail.MidasAppID != nil {
		t.Errorf("MidasAppID: want nil for url without /r/{appid}/ path, got %v", *detail.MidasAppID)
	}
}

func TestGeneratePayURL_EmptyDealName(t *testing.T) {
	d := newStdDeps()
	_, err := d.service.GeneratePayURL(context.Background(), "", nil)
	if !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("expected ErrInvalidInput, got %v", err)
	}
}

func TestGeneratePayURL_NotFound(t *testing.T) {
	d := newStdDeps()
	d.store.getOrderByDealNameFn = func(ctx context.Context, dealName string) (*store.TradeOrder, error) {
		return nil, store.ErrTradeOrderNotFound
	}
	_, err := d.service.GeneratePayURL(context.Background(), "deal-x", nil)
	if !errors.Is(err, store.ErrTradeOrderNotFound) {
		t.Fatalf("expected wrap of ErrTradeOrderNotFound, got %v", err)
	}
}

func TestGeneratePayURL_PayURLNotCached_CallsJifeiAndWritesBack(t *testing.T) {
	// 8B-1.6：trade_order 存在但 pay_url 列空时，调 jifei `qcloud.margin.getMidasEarmarking`
	// 拿真实 URL，并写回 trade_order.pay_url 缓存（Q-PAY-2 协同）。
	d := newStdDeps()
	d.store.getOrderByDealNameFn = func(ctx context.Context, dealName string) (*store.TradeOrder, error) {
		return &store.TradeOrder{DealName: dealName, Uin: "1000123456", PayURL: ""}, nil
	}
	d.jifei.getMidasEarmarkingFn = func(ctx context.Context, req *jifeiclient.GetMidasEarmarkingRequest) (*jifeiclient.GetMidasEarmarkingResponse, error) {
		// 协议层入参断言：OwnerUin / Uin 来自 trade_order，DealNames 单元素切片
		if req.OwnerUin != "1000123456" || req.Uin != "1000123456" {
			t.Errorf("ownerUin/uin mismatch: %+v", req)
		}
		if len(req.DealNames) != 1 || req.DealNames[0] != "deal-1" {
			t.Errorf("dealNames mismatch: %+v", req.DealNames)
		}
		if req.CancelURL != "https://intl-sandbox-kr-1.preview.lightclaw.tech/subscribe?pay=cancel" {
			t.Errorf("CancelURL mismatch: %q", req.CancelURL)
		}
		if req.ReturnURL != "https://intl-sandbox-kr-1.preview.lightclaw.tech/subscribe?pay=return" {
			t.Errorf("ReturnURL mismatch: %q", req.ReturnURL)
		}
		return &jifeiclient.GetMidasEarmarkingResponse{
			BillID:     "bill-1",
			URL:        "https://buy.cloud.tencent.com/midas/real?dealName=deal-1",
			AppID:      "1000029101",
			NeedCharge: 1,
			TokenID:    ptrString("E-260522160125881056"),
			OutTradeNo: ptrString("20260522995022875780461"),
		}, nil
	}
	detail, err := d.service.GeneratePayURL(context.Background(), "deal-1", &GeneratePayURLOptions{
		CancelURL: "https://intl-sandbox-kr-1.preview.lightclaw.tech/subscribe?pay=cancel",
		ReturnURL: "https://intl-sandbox-kr-1.preview.lightclaw.tech/subscribe?pay=return",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	want := "https://buy.cloud.tencent.com/midas/real?dealName=deal-1"
	if detail.PayURL != want {
		t.Errorf("URL mismatch:\n  got  %q\n  want %q", detail.PayURL, want)
	}
	// 未命中缓存路径：直接采用 jifei 顶层返回的协议外字段（不依赖 url 反解析）
	if detail.TokenID == nil || *detail.TokenID != "E-260522160125881056" {
		t.Errorf("TokenID: %v", detail.TokenID)
	}
	if detail.OrderID == nil || *detail.OrderID != "20260522995022875780461" {
		t.Errorf("OrderID: %v", detail.OrderID)
	}
	if detail.MidasAppID == nil || *detail.MidasAppID != "1000029101" {
		t.Errorf("MidasAppID: %v", detail.MidasAppID)
	}
	if detail.NeedCharge != 1 {
		t.Errorf("NeedCharge: %d", detail.NeedCharge)
	}
	if detail.Uin != "1000123456" {
		t.Errorf("Uin: %q", detail.Uin)
	}
	// 断言：trade_order.pay_url 已写回缓存
	if d.writer.updatePayURLCalls.Load() != 1 {
		t.Errorf("expected UpdatePayURL called once, got %d", d.writer.updatePayURLCalls.Load())
	}
	if d.writer.lastUpdatePayURLDeal != "deal-1" || d.writer.lastUpdatePayURLValue != want {
		t.Errorf("UpdatePayURL args mismatch: deal=%q url=%q",
			d.writer.lastUpdatePayURLDeal, d.writer.lastUpdatePayURLValue)
	}
	// 断言：jifei 调用一次
	if d.jifei.getMidasEarmarkingCalls.Load() != 1 {
		t.Errorf("expected GetMidasEarmarking called once, got %d", d.jifei.getMidasEarmarkingCalls.Load())
	}
}

func TestGeneratePayURL_IntlUsesCreatePayURLWithContractCreditCardParams(t *testing.T) {
	d := newStdDeps()
	d.service = New(Deps{
		CTLClient:              d.ctl,
		BundleStore:            d.bundle,
		JifeiClient:            d.jifei,
		CloudBillingClient:     d.billing,
		ShadowCredentialClient: d.shadowCredentials,
		OrderWriter:            d.writer,
		OrderStore:             d.store,
		SiteKind:               "intl",
	})
	d.store.getOrderByDealNameFn = func(ctx context.Context, dealName string) (*store.TradeOrder, error) {
		return &store.TradeOrder{
			DealName:       dealName,
			ExternalUserID: "usr_1",
			Uin:            "1000123456",
			AppID:          "251202221",
			PayURL:         "",
			GoodsDetail:    map[string]interface{}{"autoRenewFlag": 1},
		}, nil
	}
	d.billing.createPayURLFn = func(ctx context.Context, credentials cloudbillingclient.TemporaryCredentials, req *cloudbillingclient.CreatePayURLRequest) (*cloudbillingclient.CreatePayURLResponse, error) {
		if len(req.OrderIDs) != 1 || req.OrderIDs[0] != "deal-1" {
			t.Errorf("OrderIDs = %+v, want [deal-1]", req.OrderIDs)
		}
		if req.ContractOrder != 1 {
			t.Errorf("ContractOrder = %d, want 1", req.ContractOrder)
		}
		if req.PayScene != "credit_card" {
			t.Errorf("PayScene = %q, want credit_card", req.PayScene)
		}
		if req.PayOption != "chargePay" {
			t.Errorf("PayOption = %q, want chargePay", req.PayOption)
		}
		if req.Application != "intlSaaSLightvela" {
			t.Errorf("Application = %q, want intlSaaSLightvela", req.Application)
		}
		if req.ChargeAmount != 650 {
			t.Errorf("ChargeAmount = %d, want 650", req.ChargeAmount)
		}
		if req.CancelURL != "https://intl-sandbox-kr-1.preview.lightclaw.tech/subscribe?pay=cancel" {
			t.Errorf("CancelURL mismatch: %q", req.CancelURL)
		}
		if req.ReturnURL != "https://intl-sandbox-kr-1.preview.lightclaw.tech/subscribe?pay=return" {
			t.Errorf("ReturnURL mismatch: %q", req.ReturnURL)
		}
		return &cloudbillingclient.CreatePayURLResponse{
			URL: "https://buy.cloud.tencent.com/midas/contract?dealName=deal-1",
		}, nil
	}

	detail, err := d.service.GeneratePayURL(context.Background(), "deal-1", &GeneratePayURLOptions{
		CancelURL: "https://intl-sandbox-kr-1.preview.lightclaw.tech/subscribe?pay=cancel",
		ReturnURL: "https://intl-sandbox-kr-1.preview.lightclaw.tech/subscribe?pay=return",
	})
	if err != nil {
		t.Fatalf("GeneratePayURL: %v", err)
	}
	if detail.PayURL != "https://buy.cloud.tencent.com/midas/contract?dealName=deal-1" {
		t.Fatalf("PayURL = %q", detail.PayURL)
	}
	if detail.NeedCharge != 1 {
		t.Errorf("NeedCharge = %d, want 1", detail.NeedCharge)
	}
	if d.billing.createPayURLCalls.Load() != 1 {
		t.Errorf("CreatePayURL calls = %d, want 1", d.billing.createPayURLCalls.Load())
	}
	if d.billing.describeOrderListCalls.Load() != 1 {
		t.Errorf("DescribeOrderList calls = %d, want 1", d.billing.describeOrderListCalls.Load())
	}
	if got := d.billing.lastDescribeOrderListReq; got == nil || len(got.OrderIDs) != 1 || got.OrderIDs[0] != "deal-1" || got.PayMode != "prePay" {
		t.Fatalf("DescribeOrderList request = %+v", got)
	}
	if d.shadowCredentials.calls.Load() != 1 {
		t.Errorf("shadow credential calls = %d, want 1", d.shadowCredentials.calls.Load())
	}
	if d.billing.lastCredentials.SecretID != "tmp-id" || d.billing.lastCredentials.Token != "tmp-token" {
		t.Fatalf("Billing credentials = %+v", d.billing.lastCredentials)
	}
	if d.jifei.getMidasEarmarkingCalls.Load() != 0 {
		t.Errorf("GetMidasEarmarking calls = %d, want 0", d.jifei.getMidasEarmarkingCalls.Load())
	}
}

func TestGeneratePayURL_IntlManualRenewUsesCreatePayURLWithoutContract(t *testing.T) {
	d := newStdDeps()
	d.service = New(Deps{
		CTLClient:              d.ctl,
		BundleStore:            d.bundle,
		JifeiClient:            d.jifei,
		CloudBillingClient:     d.billing,
		ShadowCredentialClient: d.shadowCredentials,
		OrderWriter:            d.writer,
		OrderStore:             d.store,
		SiteKind:               "intl",
	})
	d.store.getOrderByDealNameFn = func(ctx context.Context, dealName string) (*store.TradeOrder, error) {
		return &store.TradeOrder{DealName: dealName, ExternalUserID: "usr_1", Uin: "1000123456", PayURL: ""}, nil
	}
	d.billing.createPayURLFn = func(ctx context.Context, credentials cloudbillingclient.TemporaryCredentials, req *cloudbillingclient.CreatePayURLRequest) (*cloudbillingclient.CreatePayURLResponse, error) {
		if req.ContractOrder != 0 {
			t.Errorf("ContractOrder = %d, want 0", req.ContractOrder)
		}
		if req.PayScene != "credit_card" {
			t.Errorf("PayScene = %q, want credit_card", req.PayScene)
		}
		if req.PayOption != "chargePay" {
			t.Errorf("PayOption = %q, want chargePay", req.PayOption)
		}
		if req.Application != "intlSaaSLightvela" {
			t.Errorf("Application = %q, want intlSaaSLightvela", req.Application)
		}
		return &cloudbillingclient.CreatePayURLResponse{URL: "https://buy.cloud.tencent.com/midas/manual?dealName=deal-1"}, nil
	}

	if _, err := d.service.GeneratePayURL(context.Background(), "deal-1", nil); err != nil {
		t.Fatalf("GeneratePayURL: %v", err)
	}
	if d.billing.createPayURLCalls.Load() != 1 {
		t.Errorf("CreatePayURL calls = %d, want 1", d.billing.createPayURLCalls.Load())
	}
	if d.jifei.getMidasEarmarkingCalls.Load() != 0 {
		t.Errorf("GetMidasEarmarking calls = %d, want 0", d.jifei.getMidasEarmarkingCalls.Load())
	}
}

func TestGeneratePayURL_IntlRejectsShadowCredentialUINMismatch(t *testing.T) {
	d := newStdDeps()
	d.service = New(Deps{
		CTLClient:              d.ctl,
		BundleStore:            d.bundle,
		JifeiClient:            d.jifei,
		CloudBillingClient:     d.billing,
		ShadowCredentialClient: d.shadowCredentials,
		OrderWriter:            d.writer,
		OrderStore:             d.store,
		SiteKind:               "intl",
	})
	d.store.getOrderByDealNameFn = func(context.Context, string) (*store.TradeOrder, error) {
		return &store.TradeOrder{DealName: "deal-1", ExternalUserID: "usr_1", Uin: "1000123456"}, nil
	}
	d.shadowCredentials.getFn = func(context.Context, string) (*shadowclient.TemporaryCredentials, error) {
		return &shadowclient.TemporaryCredentials{
			Uin:       "1000123457",
			OwnerUin:  "1000123457",
			SecretID:  "tmp-id",
			SecretKey: "tmp-key",
			Token:     "tmp-token",
			ExpiredAt: time.Now().Add(time.Hour),
		}, nil
	}

	_, err := d.service.GeneratePayURL(context.Background(), "deal-1", nil)
	if err == nil || !strings.Contains(err.Error(), "uin mismatch") {
		t.Fatalf("GeneratePayURL error = %v, want uin mismatch", err)
	}
	if d.billing.createPayURLCalls.Load() != 0 {
		t.Fatalf("CreatePayURL calls = %d, want 0", d.billing.createPayURLCalls.Load())
	}
}

func TestGeneratePayURL_IntlRejectsDescribeOrderListWithoutMatchingOrder(t *testing.T) {
	d := newStdDeps()
	d.service = New(Deps{
		CTLClient:              d.ctl,
		BundleStore:            d.bundle,
		JifeiClient:            d.jifei,
		CloudBillingClient:     d.billing,
		ShadowCredentialClient: d.shadowCredentials,
		OrderWriter:            d.writer,
		OrderStore:             d.store,
		SiteKind:               "intl",
	})
	d.store.getOrderByDealNameFn = func(context.Context, string) (*store.TradeOrder, error) {
		return &store.TradeOrder{DealName: "deal-1", ExternalUserID: "usr_1", Uin: "1000123456"}, nil
	}
	d.billing.describeOrderListFn = func(context.Context, cloudbillingclient.TemporaryCredentials, *cloudbillingclient.DescribeOrderListRequest) (*cloudbillingclient.DescribeOrderListResponse, error) {
		return &cloudbillingclient.DescribeOrderListResponse{Orders: []cloudbillingclient.OrderInfo{{
			OrderID: "another-deal", RealTotalCost: "650",
		}}}, nil
	}

	_, err := d.service.GeneratePayURL(context.Background(), "deal-1", nil)
	if err == nil || !strings.Contains(err.Error(), "did not return dealName=deal-1") {
		t.Fatalf("GeneratePayURL error = %v, want missing matching order", err)
	}
	if d.billing.createPayURLCalls.Load() != 0 {
		t.Fatalf("CreatePayURL calls = %d, want 0", d.billing.createPayURLCalls.Load())
	}
}

func TestGeneratePayURL_CnDoesNotUseContractCreditCardMidasParams(t *testing.T) {
	d := newStdDeps()
	d.store.getOrderByDealNameFn = func(ctx context.Context, dealName string) (*store.TradeOrder, error) {
		return &store.TradeOrder{DealName: dealName, Uin: "1000123456", PayURL: ""}, nil
	}
	d.jifei.getMidasEarmarkingFn = func(ctx context.Context, req *jifeiclient.GetMidasEarmarkingRequest) (*jifeiclient.GetMidasEarmarkingResponse, error) {
		if req.ContractOrder != 0 {
			t.Errorf("ContractOrder = %d, want 0", req.ContractOrder)
		}
		if req.PayScene != "" {
			t.Errorf("PayScene = %q, want empty", req.PayScene)
		}
		return &jifeiclient.GetMidasEarmarkingResponse{
			URL:        "https://buy.cloud.tencent.com/midas/cn?dealName=deal-1",
			NeedCharge: 1,
		}, nil
	}

	if _, err := d.service.GeneratePayURL(context.Background(), "deal-1", nil); err != nil {
		t.Fatalf("GeneratePayURL: %v", err)
	}
	if d.shadowCredentials.calls.Load() != 0 {
		t.Fatalf("shadow credential calls = %d, want 0 for domestic site", d.shadowCredentials.calls.Load())
	}
}

func TestGeneratePayURL_JifeiBusinessError_PassedThrough(t *testing.T) {
	// Q-PAY-5：jifei 业务错（returnCode != 0）统一透传，不在 service 层做错误码语义分类。
	d := newStdDeps()
	d.store.getOrderByDealNameFn = func(ctx context.Context, dealName string) (*store.TradeOrder, error) {
		return &store.TradeOrder{DealName: dealName, Uin: "1000123456", PayURL: ""}, nil
	}
	cgwErr := &jifeiclient.CGWError{
		ReturnCode:    100151,
		ReturnMessage: "resource lock conflict",
	}
	d.jifei.getMidasEarmarkingFn = func(ctx context.Context, req *jifeiclient.GetMidasEarmarkingRequest) (*jifeiclient.GetMidasEarmarkingResponse, error) {
		return nil, cgwErr
	}
	_, err := d.service.GeneratePayURL(context.Background(), "deal-1", nil)
	if err == nil {
		t.Fatalf("expected jifei business error, got nil")
	}
	var got *jifeiclient.CGWError
	if !errors.As(err, &got) {
		t.Fatalf("expected *CGWError pass-through, got %T: %v", err, err)
	}
	if got.ReturnCode != 100151 {
		t.Errorf("returnCode mismatch: got %d", got.ReturnCode)
	}
	// 断言：不应写回缓存
	if d.writer.updatePayURLCalls.Load() != 0 {
		t.Errorf("expected UpdatePayURL not called on jifei error, got %d", d.writer.updatePayURLCalls.Load())
	}
}

func TestGeneratePayURL_WriteBackFailure_StillReturnsURL(t *testing.T) {
	// 写回 trade_order.pay_url 失败时不阻塞用户支付：仍返 jifei URL，落库错走 ELK 日志兜底（Q-PAY-1 b）。
	d := newStdDeps()
	d.store.getOrderByDealNameFn = func(ctx context.Context, dealName string) (*store.TradeOrder, error) {
		return &store.TradeOrder{DealName: dealName, Uin: "1000123456", PayURL: ""}, nil
	}
	d.jifei.getMidasEarmarkingFn = func(ctx context.Context, req *jifeiclient.GetMidasEarmarkingRequest) (*jifeiclient.GetMidasEarmarkingResponse, error) {
		return &jifeiclient.GetMidasEarmarkingResponse{URL: "https://buy.cloud.tencent.com/midas/x"}, nil
	}
	d.writer.updatePayURLFn = func(ctx context.Context, dealName, payURL string) error {
		return errors.New("simulated db error")
	}
	url, err := d.service.GeneratePayURL(context.Background(), "deal-1", nil)
	if err != nil {
		t.Fatalf("write-back failure should not propagate, got %v", err)
	}
	if url.PayURL != "https://buy.cloud.tencent.com/midas/x" {
		t.Errorf("URL mismatch: got %q", url.PayURL)
	}
}

// TestGeneratePayURL_PayURLCached_ParsesAuxFieldsFromURL 验证命中缓存路径：
// 不调 jifei，直接从 trade_order.pay_url 反解析 token_id / out_trade_no / midas_appid
// （v1.7.30 D3 兜底链路 - 真实 URL 形态来自 2026-05-23 北京 trade 联调验证）。
func TestGeneratePayURL_PayURLCached_ParsesAuxFieldsFromURL(t *testing.T) {
	d := newStdDeps()
	const realURL = "/v1/r/1450008583/qz_goods_info?transaction_id=E-260522160125881056" +
		"&token_id=E-260522160125881056&pf=midas_group_pay-1000-html5-1000" +
		"&out_trade_no=20260522995022875780461&deploy_env=stable"
	d.store.getOrderByDealNameFn = func(ctx context.Context, dealName string) (*store.TradeOrder, error) {
		return &store.TradeOrder{
			DealName: dealName,
			Uin:      "700000164995",
			AppID:    "251202221",
			PayURL:   realURL,
		}, nil
	}
	detail, err := d.service.GeneratePayURL(context.Background(), "deal-1", nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if detail.PayURL != realURL {
		t.Errorf("PayURL: %q", detail.PayURL)
	}
	if detail.TokenID == nil || *detail.TokenID != "E-260522160125881056" {
		t.Errorf("TokenID: %v", detail.TokenID)
	}
	if detail.OrderID == nil || *detail.OrderID != "20260522995022875780461" {
		t.Errorf("OrderID: %v", detail.OrderID)
	}
	if detail.MidasAppID == nil || *detail.MidasAppID != "1450008583" {
		t.Errorf("MidasAppID: %v", detail.MidasAppID)
	}
	if detail.Uin != "700000164995" || detail.AppID != "251202221" {
		t.Errorf("Uin/AppID: %q / %q", detail.Uin, detail.AppID)
	}
	// 命中缓存路径不应调 jifei
	if d.jifei.getMidasEarmarkingCalls.Load() != 0 {
		t.Errorf("expected GetMidasEarmarking not called on cache hit, got %d",
			d.jifei.getMidasEarmarkingCalls.Load())
	}
}

// TestGeneratePayURL_JifeiOptionalFieldsMissing_FallsBackToNil 验证 D3 兜底：
// jifei 真实回包未返协议外字段（TokenID/OutTradeNo），service 必须透传 nil，
// 不能误置成 ""。
func TestGeneratePayURL_JifeiOptionalFieldsMissing_FallsBackToNil(t *testing.T) {
	d := newStdDeps()
	d.store.getOrderByDealNameFn = func(ctx context.Context, dealName string) (*store.TradeOrder, error) {
		return &store.TradeOrder{
			DealName: dealName,
			Uin:      "1000123456",
			AppID:    "251202221",
			PayURL:   "",
		}, nil
	}
	d.jifei.getMidasEarmarkingFn = func(ctx context.Context, req *jifeiclient.GetMidasEarmarkingRequest) (*jifeiclient.GetMidasEarmarkingResponse, error) {
		return &jifeiclient.GetMidasEarmarkingResponse{
			BillID:     "bill-only",
			URL:        "https://buy.cloud.tencent.com/midas/minimal",
			AppID:      "1450008583",
			NeedCharge: 0,
		}, nil
	}
	detail, err := d.service.GeneratePayURL(context.Background(), "deal-1", nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if detail.TokenID != nil {
		t.Errorf("TokenID: want nil, got %v", *detail.TokenID)
	}
	if detail.OrderID != nil {
		t.Errorf("OrderID: want nil, got %v", *detail.OrderID)
	}
	// 米大师 appid jifei 协议必返非空，按指针包装非 nil
	if detail.MidasAppID == nil || *detail.MidasAppID != "1450008583" {
		t.Errorf("MidasAppID: %v", detail.MidasAppID)
	}
	if detail.NeedCharge != 0 {
		t.Errorf("NeedCharge: %d", detail.NeedCharge)
	}
}

func TestGeneratePayURL_TradeOrderMissingUin(t *testing.T) {
	// 防御性：trade_order.uin 列在 PlaceOrder 入口就应该写入；万一为空走防御性返错。
	d := newStdDeps()
	d.store.getOrderByDealNameFn = func(ctx context.Context, dealName string) (*store.TradeOrder, error) {
		return &store.TradeOrder{DealName: dealName, Uin: "", PayURL: ""}, nil
	}
	_, err := d.service.GeneratePayURL(context.Background(), "deal-1", nil)
	if err == nil {
		t.Fatalf("expected error for missing uin")
	}
	if !strings.Contains(err.Error(), "uin") {
		t.Errorf("error should mention uin: %v", err)
	}
	// 不应调 jifei
	if d.jifei.getMidasEarmarkingCalls.Load() != 0 {
		t.Errorf("expected GetMidasEarmarking not called, got %d", d.jifei.getMidasEarmarkingCalls.Load())
	}
}

// ============================================================================
// New nil-deps panics
// ============================================================================

func TestNew_PanicsOnNilDeps(t *testing.T) {
	cases := []struct {
		name string
		mut  func(d *Deps)
	}{
		{"CTLClient nil", func(d *Deps) { d.CTLClient = nil }},
		{"BundleStore nil", func(d *Deps) { d.BundleStore = nil }},
		{"JifeiClient nil", func(d *Deps) { d.JifeiClient = nil }},
		{"OrderWriter nil", func(d *Deps) { d.OrderWriter = nil }},
		{"OrderStore nil", func(d *Deps) { d.OrderStore = nil }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			defer func() {
				if r := recover(); r == nil {
					t.Fatal("expected panic")
				}
			}()
			d := Deps{
				CTLClient:   &fakeCTL{},
				BundleStore: &fakeBundleStore{},
				JifeiClient: &fakeJifei{},
				OrderWriter: &fakeOrderWriter{},
				OrderStore:  &fakeOrderStore{},
			}
			tc.mut(&d)
			_ = New(d)
		})
	}
}

// ============================================================================
// 8B-1: shadow client integration tests
// ============================================================================

// fakeShadow 是 placeorder 测试用的 shadowclient.Client mock。
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
func TestPlaceOrder_ShadowClient_BackfillUinAndAppID(t *testing.T) {
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
	d := newStdDeps()
	svc := New(Deps{
		CTLClient:    d.ctl,
		BundleStore:  d.bundle,
		JifeiClient:  d.jifei,
		OrderWriter:  d.writer,
		OrderStore:   d.store,
		ShadowClient: shadow,
	})
	req := stdPlaceOrderReq()
	req.Uin = ""
	req.AppID = ""
	if _, err := svc.PlaceOrder(context.Background(), req); err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if shadow.calls.Load() != 1 {
		t.Errorf("shadow calls = %d, want 1", shadow.calls.Load())
	}
	if shadow.lastExternalID != "user-1" {
		t.Errorf("shadow lastExternalID = %q, want user-1", shadow.lastExternalID)
	}
	// 验证 jifei generateDeals 拿到的 OwnerUin/Uin 是反查后的 9999888
	if d.jifei.lastGenerateDealsReq == nil || d.jifei.lastGenerateDealsReq.Uin != "9999888" {
		t.Errorf("jifei.Uin = %q, want 9999888 (backfilled from shadow)",
			func() string {
				if d.jifei.lastGenerateDealsReq == nil {
					return "<nil>"
				}
				return d.jifei.lastGenerateDealsReq.Uin
			}())
	}
	// 验证 trade_order 写入的 Uin/AppID 也是回填后的值
	if d.writer.lastCreateOrderInput.Uin != "9999888" || d.writer.lastCreateOrderInput.AppID != "12345" {
		t.Errorf("trade_order: Uin=%q AppID=%q, want 9999888/12345",
			d.writer.lastCreateOrderInput.Uin, d.writer.lastCreateOrderInput.AppID)
	}
}

// 当调用方已传 Uin 时，即使 ShadowClient 注入也不应被调用。
func TestPlaceOrder_ShadowClient_SkippedWhenUinProvided(t *testing.T) {
	shadow := &fakeShadow{
		getBindingFn: func(_ context.Context, _ string) (*shadowclient.Binding, error) {
			t.Fatal("shadow should NOT be called when Uin is provided")
			return nil, nil
		},
	}
	d := newStdDeps()
	svc := New(Deps{
		CTLClient:    d.ctl,
		BundleStore:  d.bundle,
		JifeiClient:  d.jifei,
		OrderWriter:  d.writer,
		OrderStore:   d.store,
		ShadowClient: shadow,
	})
	req := stdPlaceOrderReq() // Uin 已显式提供
	if _, err := svc.PlaceOrder(context.Background(), req); err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if shadow.calls.Load() != 0 {
		t.Errorf("shadow calls = %d, want 0", shadow.calls.Load())
	}
}

// shadow 反查返 ErrBindingNotFound → service 映射为 placeorder.ErrBindingNotFound。
func TestPlaceOrder_ShadowClient_BindingNotFound(t *testing.T) {
	shadow := &fakeShadow{
		getBindingFn: func(_ context.Context, _ string) (*shadowclient.Binding, error) {
			return nil, shadowclient.ErrBindingNotFound
		},
	}
	d := newStdDeps()
	svc := New(Deps{
		CTLClient:    d.ctl,
		BundleStore:  d.bundle,
		JifeiClient:  d.jifei,
		OrderWriter:  d.writer,
		OrderStore:   d.store,
		ShadowClient: shadow,
	})
	req := stdPlaceOrderReq()
	req.Uin = ""
	req.AppID = ""
	_, err := svc.PlaceOrder(context.Background(), req)
	if err == nil {
		t.Fatal("want err")
	}
	if !errors.Is(err, ErrBindingNotFound) {
		t.Errorf("err = %v, want ErrBindingNotFound", err)
	}
	// 不应有 jifei / order writer 副作用
	if d.jifei.generateDealsCalls.Load() != 0 {
		t.Errorf("jifei.generateDeals called = %d, want 0", d.jifei.generateDealsCalls.Load())
	}
	if d.writer.createOrderCalls.Load() != 0 {
		t.Errorf("writer.createOrder called = %d, want 0", d.writer.createOrderCalls.Load())
	}
}

// shadow 反查返其他错误 → service 透传。
func TestPlaceOrder_ShadowClient_UpstreamError(t *testing.T) {
	upstreamErr := errors.New("shadow 503 service unavailable")
	shadow := &fakeShadow{
		getBindingFn: func(_ context.Context, _ string) (*shadowclient.Binding, error) {
			return nil, upstreamErr
		},
	}
	d := newStdDeps()
	svc := New(Deps{
		CTLClient:    d.ctl,
		BundleStore:  d.bundle,
		JifeiClient:  d.jifei,
		OrderWriter:  d.writer,
		OrderStore:   d.store,
		ShadowClient: shadow,
	})
	req := stdPlaceOrderReq()
	req.Uin = ""
	_, err := svc.PlaceOrder(context.Background(), req)
	if err == nil {
		t.Fatal("want err")
	}
	if !errors.Is(err, upstreamErr) {
		t.Errorf("err = %v, want wrap upstream err", err)
	}
}

// 8A 行为完全保留：ShadowClient 未注入时 Uin 强校验仍生效。
func TestPlaceOrder_NoShadowClient_UinStillRequired(t *testing.T) {
	d := newStdDeps()
	// ShadowClient 字段保持零值（nil）
	req := stdPlaceOrderReq()
	req.Uin = ""
	_, err := d.service.PlaceOrder(context.Background(), req)
	if err == nil {
		t.Fatal("want err")
	}
	if !errors.Is(err, ErrInvalidInput) {
		t.Errorf("err = %v, want ErrInvalidInput", err)
	}
	if !strings.Contains(err.Error(), "uin is required") {
		t.Errorf("err = %v, want 'uin is required' substring", err)
	}
}

// ============================================================================
// 8B-1.5: PlaceOrderAndPay tests
// ============================================================================

// TestPlaceOrderAndPay_HappyPath 验证 PlaceOrderAndPay 一体化流程：
//   - 调 jifei `qcloud.Deal.generateDealsAndPay` 一次（不再是两步式 generateDeals + payDealsNew）
//   - 入参带正确的 OwnerUin / Uin / AppID(int64) / AutoVoucher=1 / GoodsInfos[]
//   - 不调用普通 GenerateDeals
//   - v1.7.28 BUG-22/23 修订：jifei 同步发货成功（state="0" + resourceIds 非空）时
//     trade_order 直接落 status='provisioned'（一次到位），不再走 paid_pending_provision 中间态
//   - 返回 BigOrderID 取自响应 BigDealIDs[0]
func TestPlaceOrderAndPay_HappyPath(t *testing.T) {
	d := newStdDeps()
	d.jifei.generateDealsAndPayFn = func(ctx context.Context, req *jifeiclient.GenerateDealsAndPayRequest) (*jifeiclient.GenerateDealsAndPayResponse, error) {
		return &jifeiclient.GenerateDealsAndPayResponse{
			DealNames:  []string{"20260509000000001-001"},
			BigDealIDs: []string{"20260509000000001"},
			DealIDs:    []string{"1103944452"},
			ResourceIDs: map[string][]string{
				"20260509000000001-001": {"lhins-abc123"},
			},
			// v1.7.28 BUG-22/23：dealDeliverResults.state="0" 表示 jifei 同步发货成功，
			// 此时 PlaceOrderAndPay 才落库 trade_order(status='provisioned' 完成态)。
			DealDeliverResults: map[string]map[string]interface{}{
				"20260509000000001-001": {"state": "0"},
			},
		}, nil
	}

	resp, err := d.service.PlaceOrderAndPay(context.Background(), stdPlaceOrderReq())
	if err != nil {
		t.Fatalf("PlaceOrderAndPay: %v", err)
	}
	if resp.DealName != "20260509000000001-001" {
		t.Errorf("DealName = %q", resp.DealName)
	}
	if resp.BigOrderID != "20260509000000001" {
		t.Errorf("BigOrderID = %q", resp.BigOrderID)
	}
	if d.jifei.generateDealsAndPayCalls.Load() != 1 {
		t.Errorf("generateDealsAndPay calls = %d, want 1", d.jifei.generateDealsAndPayCalls.Load())
	}
	if d.jifei.generateDealsCalls.Load() != 0 {
		t.Errorf("普通 generateDeals 不应被调用, got %d", d.jifei.generateDealsCalls.Load())
	}
	if pr := d.jifei.lastGenerateDealsAndPayReq; pr == nil {
		t.Fatal("lastGenerateDealsAndPayReq is nil")
	} else {
		if pr.OwnerUin != "1000123456" || pr.Uin != "1000123456" {
			t.Errorf("para owner/uin: %+v", pr)
		}
		if pr.AppID != 10001 {
			t.Errorf("para AppID = %d, want 10001 (parsed from '10001')", pr.AppID)
		}
		if pr.AutoVoucher == nil || *pr.AutoVoucher != 1 {
			t.Errorf("para AutoVoucher = %v, want *1", pr.AutoVoucher)
		}
		if len(pr.Goods) != 1 {
			t.Fatalf("para GoodsInfos len = %d, want 1", len(pr.Goods))
		}
		if pr.Goods[0].GoodsCategoryID == 0 {
			t.Error("para GoodsCategoryID empty")
		}
		if pr.Goods[0].PayMode != 1 || pr.Goods[0].GoodsNum != 1 {
			t.Errorf("para GoodsInfos[0] PayMode/GoodsNum: %+v", pr.Goods[0])
		}
	}
	if d.writer.createOrderCalls.Load() != 1 {
		t.Errorf("trade_order createOrder calls = %d, want 1", d.writer.createOrderCalls.Load())
	}
	if d.writer.lastCreateOrderInput.Status != "provisioned" {
		t.Errorf("trade_order status = %q, want provisioned (BUG-22/23: state=0 落完成态)",
			d.writer.lastCreateOrderInput.Status)
	}
	if d.writer.lastCreateOrderInput.ResourceID != "lhins-abc123" {
		t.Errorf("trade_order ResourceID = %q, want lhins-abc123 (BUG-22/23: jifei 同步返的 pass_id 一次到位回填)",
			d.writer.lastCreateOrderInput.ResourceID)
	}
	if d.writer.lastCreateOrderInput.BigOrderID != "20260509000000001" {
		t.Errorf("trade_order BigOrderID = %q", d.writer.lastCreateOrderInput.BigOrderID)
	}
}

func TestMoveInOrderAndPay_HappyPath(t *testing.T) {
	d := newStdDeps()
	d.jifei.generateDealsAndPayFn = func(ctx context.Context, req *jifeiclient.GenerateDealsAndPayRequest) (*jifeiclient.GenerateDealsAndPayResponse, error) {
		return &jifeiclient.GenerateDealsAndPayResponse{
			DealNames:  []string{"20260720000000001-001"},
			BigDealIDs: []string{"20260720000000001"},
		}, nil
	}

	resp, err := d.service.MoveInOrderAndPay(context.Background(), MoveInOrderRequest{
		ExternalUserID: "usr_migrate",
		Uin:            "700000164995",
		AppID:          "251202221",
		BundleID:       "bundle_launch_01",
		ResourceID:     "pass-free-1",
		CurDeadline:    "2026-07-20 12:00:00",
	})
	if err != nil {
		t.Fatalf("MoveInOrderAndPay: %v", err)
	}
	if resp.DealName != "20260720000000001-001" || resp.BigOrderID != "20260720000000001" {
		t.Fatalf("unexpected response: %+v", resp)
	}
	if d.writer.createOrderCalls.Load() != 0 {
		t.Fatalf("move-in must not persist trade_order, got calls=%d", d.writer.createOrderCalls.Load())
	}

	got := d.jifei.lastGenerateDealsAndPayReq
	if got == nil {
		t.Fatal("lastGenerateDealsAndPayReq is nil")
	}
	if got.ClientToken != "lightvela-move-in:pass-free-1:bundle_launch_01" {
		t.Errorf("ClientToken = %q", got.ClientToken)
	}
	goods := got.Goods[0]
	if goods.GoodsCategoryID != 176262 || goods.Action != "preMoveIn" || goods.Type != "sp_linux_small" {
		t.Fatalf("move-in goods mismatch: %+v", goods)
	}
	detail := goods.GoodsDetail
	if detail["resourceId"] != "pass-free-1" || detail["bundleId"] != "bundle_launch_01" || detail["externalUserId"] != "usr_migrate" {
		t.Fatalf("move-in identity detail mismatch: %+v", detail)
	}
	if detail["timeSpan"] != 1 || detail["timeUnit"] != "m" {
		t.Fatalf("move-in period mismatch: %+v", detail)
	}
	if detail["curDeadline"] != "2026-07-20 12:00:00" {
		t.Fatalf("curDeadline = %v", detail["curDeadline"])
	}
	billingParam, ok := detail["billingParam"].(map[string]interface{})
	if !ok || billingParam["resourcesSource"] != "lightvela" {
		t.Fatalf("billingParam mismatch: %+v", detail["billingParam"])
	}
}

func TestMoveInOrderAndPay_InvalidInput(t *testing.T) {
	base := MoveInOrderRequest{
		ExternalUserID: "usr_migrate",
		Uin:            "700000164995",
		AppID:          "251202221",
		BundleID:       "bundle_launch_01",
		ResourceID:     "pass-free-1",
		CurDeadline:    "2026-07-20 12:00:00",
	}
	cases := []struct {
		name string
		mut  func(*MoveInOrderRequest)
		want string
	}{
		{"missing external_user_id", func(req *MoveInOrderRequest) { req.ExternalUserID = "" }, "external_user_id"},
		{"missing uin", func(req *MoveInOrderRequest) { req.Uin = "" }, "uin"},
		{"missing app_id", func(req *MoveInOrderRequest) { req.AppID = "" }, "app_id"},
		{"missing bundle_id", func(req *MoveInOrderRequest) { req.BundleID = "" }, "bundle_id"},
		{"missing resource_id", func(req *MoveInOrderRequest) { req.ResourceID = "" }, "resource_id"},
		{"missing cur_deadline", func(req *MoveInOrderRequest) { req.CurDeadline = "" }, "cur_deadline"},
		{"bad cur_deadline", func(req *MoveInOrderRequest) { req.CurDeadline = "2026-07-20T12:00:00Z" }, "cur_deadline"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			d := newStdDeps()
			req := base
			tc.mut(&req)
			_, err := d.service.MoveInOrderAndPay(context.Background(), req)
			if !errors.Is(err, ErrInvalidInput) {
				t.Fatalf("expected ErrInvalidInput, got %v", err)
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("error = %q, want contains %q", err.Error(), tc.want)
			}
		})
	}
}

// TestPlaceOrderAndPay_GenerateDealsAndPayFailure：jifei generateDealsAndPay 业务失败时
//   - 错误透传（带 placeorder: jifei GenerateDealsAndPay: ... 前缀）
//   - trade_order 不写库（避免本地有孤立 paid 状态）
func TestPlaceOrderAndPay_GenerateDealsAndPayFailure(t *testing.T) {
	d := newStdDeps()
	apiErr := errors.New("jifei 余额不足")
	d.jifei.generateDealsAndPayFn = func(ctx context.Context, req *jifeiclient.GenerateDealsAndPayRequest) (*jifeiclient.GenerateDealsAndPayResponse, error) {
		return nil, apiErr
	}

	_, err := d.service.PlaceOrderAndPay(context.Background(), stdPlaceOrderReq())
	if err == nil {
		t.Fatal("want err")
	}
	if !errors.Is(err, apiErr) {
		t.Errorf("err = %v, want wrap apiErr", err)
	}
	if !strings.Contains(err.Error(), "GenerateDealsAndPay") {
		t.Errorf("err message should mention GenerateDealsAndPay, got: %v", err)
	}
	if d.jifei.generateDealsAndPayCalls.Load() != 1 {
		t.Errorf("generateDealsAndPay calls = %d, want 1", d.jifei.generateDealsAndPayCalls.Load())
	}
	if d.writer.createOrderCalls.Load() != 0 {
		t.Errorf("trade_order createOrder should NOT be called on jifei failure, got %d",
			d.writer.createOrderCalls.Load())
	}
}

// TestPlaceOrderAndPay_InvalidResponse：响应缺失 BigDealIDs / DealNames 时返 ErrJifeiResponseInvalid。
func TestPlaceOrderAndPay_InvalidResponse(t *testing.T) {
	d := newStdDeps()
	d.jifei.generateDealsAndPayFn = func(ctx context.Context, req *jifeiclient.GenerateDealsAndPayRequest) (*jifeiclient.GenerateDealsAndPayResponse, error) {
		// 模拟协议异常：BigDealIDs 缺失
		return &jifeiclient.GenerateDealsAndPayResponse{
			DealNames: []string{"d1"},
		}, nil
	}

	_, err := d.service.PlaceOrderAndPay(context.Background(), stdPlaceOrderReq())
	if err == nil {
		t.Fatal("want err")
	}
	if !errors.Is(err, ErrJifeiResponseInvalid) {
		t.Errorf("err = %v, want ErrJifeiResponseInvalid", err)
	}
	if d.writer.createOrderCalls.Load() != 0 {
		t.Errorf("trade_order createOrder should NOT be called on invalid response, got %d",
			d.writer.createOrderCalls.Load())
	}
}

// TestPlaceOrderAndPay_InvalidAppID：非数字 AppID 应返 ErrInvalidInput，不调 jifei。
func TestPlaceOrderAndPay_InvalidAppID(t *testing.T) {
	d := newStdDeps()
	d.jifei.generateDealsAndPayFn = func(ctx context.Context, req *jifeiclient.GenerateDealsAndPayRequest) (*jifeiclient.GenerateDealsAndPayResponse, error) {
		return nil, errors.New("should not be called")
	}
	req := stdPlaceOrderReq()
	req.AppID = "not-a-number"

	_, err := d.service.PlaceOrderAndPay(context.Background(), req)
	if err == nil {
		t.Fatal("want err")
	}
	if !errors.Is(err, ErrInvalidInput) {
		t.Errorf("err = %v, want ErrInvalidInput", err)
	}
	if d.jifei.generateDealsAndPayCalls.Load() != 0 {
		t.Errorf("generateDealsAndPay should NOT be called with invalid appId, got %d",
			d.jifei.generateDealsAndPayCalls.Load())
	}
}

// TestPlaceOrderAndPay_ShadowReverseLookup：与 PlaceOrder 一致的反查逻辑也要在 PlaceOrderAndPay 生效。
//
// v1.7.28 BUG-22/23 修订：mock jifei 同步发货成功（state="0" + resourceIds 非空），
// 验证 shadow 反查 + 完整成功路径下 trade_order 直接落 status='provisioned'。
func TestPlaceOrderAndPay_ShadowReverseLookup(t *testing.T) {
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
	d := newStdDeps()
	d.jifei.generateDealsAndPayFn = func(ctx context.Context, req *jifeiclient.GenerateDealsAndPayRequest) (*jifeiclient.GenerateDealsAndPayResponse, error) {
		return &jifeiclient.GenerateDealsAndPayResponse{
			DealNames:  []string{"d1"},
			BigDealIDs: []string{"b1"},
			ResourceIDs: map[string][]string{
				"d1": {"lhins-shadow-001"},
			},
			DealDeliverResults: map[string]map[string]interface{}{
				"d1": {"state": "0"},
			},
		}, nil
	}
	svc := New(Deps{
		CTLClient:    d.ctl,
		BundleStore:  d.bundle,
		JifeiClient:  d.jifei,
		OrderWriter:  d.writer,
		OrderStore:   d.store,
		ShadowClient: shadow,
	})
	req := stdPlaceOrderReq()
	req.Uin = ""
	req.AppID = ""

	if _, err := svc.PlaceOrderAndPay(context.Background(), req); err != nil {
		t.Fatalf("PlaceOrderAndPay: %v", err)
	}
	if shadow.calls.Load() != 1 {
		t.Errorf("shadow calls = %d, want 1", shadow.calls.Load())
	}
	pr := d.jifei.lastGenerateDealsAndPayReq
	if pr.Uin != "9999888" {
		t.Errorf("generateDealsAndPay uin = %q, want backfilled 9999888", pr.Uin)
	}
	if pr.AppID != 12345 {
		t.Errorf("generateDealsAndPay AppID = %d, want backfilled 12345", pr.AppID)
	}
	if d.writer.lastCreateOrderInput.Status != "provisioned" {
		t.Errorf("trade_order status = %q, want provisioned (BUG-22/23)",
			d.writer.lastCreateOrderInput.Status)
	}
	if d.writer.lastCreateOrderInput.ResourceID != "lhins-shadow-001" {
		t.Errorf("trade_order ResourceID = %q, want lhins-shadow-001 (BUG-22/23)",
			d.writer.lastCreateOrderInput.ResourceID)
	}
}

// ============================================================================
// R-C-5：PlaceRenewOrder 续费下单测试（设计稿 §3.5 / §4.3 / R-C 切片 R-C-5）
// ============================================================================

// stdRenewDef 与 stdDef 对偶，CategoryIDs 同时含 purchase + renew。
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

func stdPlaceRenewOrderReq() PlaceRenewOrderRequest {
	return PlaceRenewOrderRequest{
		ExternalUserID: "user-1",
		Uin:            "1000123456",
		AppID:          "10001",
		BundleID:       "bundle_linux_small",
		ResourceID:     "lhpass-r1",
		CurDeadline:    "2026-06-15 10:30:00", // PDF §4.3 续费必填; v1.7.20 B15
		Period:         1,
		TimeUnit:       "m",
		GoodsNum:       1,
		PayMode:        1,
	}
}

// 完整 happy path：覆盖关键差异点（GoodsCategoryID=100060 / goodsDetail.resourceId / OrderType=renew + ResourceID 落库 / status=pending_pay）。
func TestPlaceRenewOrder_HappyPath(t *testing.T) {
	d := newStdDeps()
	d.bundle.def = stdRenewDef()
	d.jifei.generateDealsFn = func(_ context.Context, _ *jifeiclient.GenerateDealsRequest) (*jifeiclient.GenerateDealsResponse, error) {
		return stdJifeiDealsResp(), nil
	}
	svc := New(Deps{
		CTLClient:   d.ctl,
		BundleStore: d.bundle,
		JifeiClient: d.jifei,
		OrderWriter: d.writer,
		OrderStore:  d.store,
	})

	got, err := svc.PlaceRenewOrder(context.Background(), stdPlaceRenewOrderReq())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.DealName == "" || got.BigOrderID == "" {
		t.Errorf("DealName/BigOrderID empty: %+v", got)
	}

	// 验证 jifei generateDeals 入参
	jr := d.jifei.lastGenerateDealsReq
	if jr == nil {
		t.Fatal("expected GenerateDeals to be called")
	}
	if jr.OwnerUin != "1000123456" || jr.Uin != "1000123456" {
		t.Errorf("Uin/OwnerUin = %s/%s, want 1000123456", jr.Uin, jr.OwnerUin)
	}
	if len(jr.Goods) != 1 {
		t.Fatalf("GoodsInfos len = %d, want 1", len(jr.Goods))
	}
	gi := jr.Goods[0]
	if gi.GoodsCategoryID != 100060 {
		t.Errorf("GoodsCategoryID = %d, want 100060 (scene=renew)", gi.GoodsCategoryID)
	}
	if gi.RegionID != region.LighthouseRegionID {
		t.Errorf("RegionID = %d, want LighthouseRegionID", gi.RegionID)
	}
	if gi.GoodsDetail["resourceId"] != "lhpass-r1" {
		t.Errorf("goodsDetail.resourceId = %v, want lhpass-r1", gi.GoodsDetail["resourceId"])
	}
	// v1.7.20 B15: 续费独有 curDeadline 透传 (PDF §4.3 必填)
	if gi.GoodsDetail["curDeadline"] != "2026-06-15 10:30:00" {
		t.Errorf("goodsDetail.curDeadline = %v, want 2026-06-15 10:30:00", gi.GoodsDetail["curDeadline"])
	}
	if gi.GoodsDetail["productCode"] != "p_lighthouse" {
		t.Errorf("goodsDetail.productCode = %v", gi.GoodsDetail["productCode"])
	}
	// 续费同样透传 sv_*
	if gi.GoodsDetail["sv_cpu"] != int64(2) {
		t.Errorf("goodsDetail.sv_cpu = %v, want int64(2)", gi.GoodsDetail["sv_cpu"])
	}

	// 验证 trade_order 落库：OrderType=renew + ResourceID=passID + Status=pending_pay
	in := d.writer.lastCreateOrderInput
	if in.OrderType != store.OrderTypeRenew {
		t.Errorf("OrderType = %q, want %q", in.OrderType, store.OrderTypeRenew)
	}
	if in.ResourceID != "lhpass-r1" {
		t.Errorf("ResourceID = %q, want lhpass-r1", in.ResourceID)
	}
	if in.Status != "pending_pay" {
		t.Errorf("Status = %q, want pending_pay", in.Status)
	}
	if in.ResourceType != "pass" {
		t.Errorf("ResourceType = %q, want pass", in.ResourceType)
	}
	if in.DealName != got.DealName {
		t.Errorf("DealName mismatch: store=%q got=%q", in.DealName, got.DealName)
	}
	if in.BundleID != "bundle_linux_small" {
		t.Errorf("BundleID = %q", in.BundleID)
	}
	if in.SubProductCode != "sp_linux_small" {
		t.Errorf("SubProductCode = %q, want sp_linux_small (from def)", in.SubProductCode)
	}
}

// 入参校验：ResourceID 必填新增；其他字段与 PlaceOrder 一致。
func TestPlaceRenewOrder_InvalidInput(t *testing.T) {
	svc := New(Deps{
		CTLClient: &fakeCTL{}, BundleStore: &fakeBundleStore{}, JifeiClient: &fakeJifei{},
		OrderWriter: &fakeOrderWriter{}, OrderStore: &fakeOrderStore{},
	})
	cases := []struct {
		name string
		req  PlaceRenewOrderRequest
		want string
	}{
		{"missing bundle", PlaceRenewOrderRequest{ExternalUserID: "u", Uin: "u", ResourceID: "r", CurDeadline: "2026-06-15 10:30:00", Period: 1, TimeUnit: "m"}, "bundle_id"},
		{"missing resource_id", PlaceRenewOrderRequest{BundleID: "b", ExternalUserID: "u", Uin: "u", Period: 1, TimeUnit: "m"}, "resource_id"},
		// v1.7.20 B15: cur_deadline 必填 (PDF §4.3 续费)
		{"missing cur_deadline", PlaceRenewOrderRequest{BundleID: "b", ExternalUserID: "u", Uin: "u", ResourceID: "r", Period: 1, TimeUnit: "m"}, "cur_deadline"},
		{"missing external_user_id", PlaceRenewOrderRequest{BundleID: "b", Uin: "u", ResourceID: "r", CurDeadline: "2026-06-15 10:30:00", Period: 1, TimeUnit: "m"}, "external_user_id"},
		{"missing uin (no shadow)", PlaceRenewOrderRequest{BundleID: "b", ExternalUserID: "u", ResourceID: "r", CurDeadline: "2026-06-15 10:30:00", Period: 1, TimeUnit: "m"}, "uin"},
		{"zero period", PlaceRenewOrderRequest{BundleID: "b", ExternalUserID: "u", Uin: "u", ResourceID: "r", CurDeadline: "2026-06-15 10:30:00", Period: 0, TimeUnit: "m"}, "period"},
		{"missing time_unit", PlaceRenewOrderRequest{BundleID: "b", ExternalUserID: "u", Uin: "u", ResourceID: "r", CurDeadline: "2026-06-15 10:30:00", Period: 1}, "time_unit"},
		{"invalid pay_mode", PlaceRenewOrderRequest{BundleID: "b", ExternalUserID: "u", Uin: "u", ResourceID: "r", CurDeadline: "2026-06-15 10:30:00", Period: 1, TimeUnit: "m", PayMode: 9}, "pay_mode"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, err := svc.PlaceRenewOrder(context.Background(), c.req)
			if err == nil || !errors.Is(err, ErrInvalidInput) || !strings.Contains(err.Error(), c.want) {
				t.Errorf("err = %v, want ErrInvalidInput containing %q", err, c.want)
			}
		})
	}
}

// bundle 不存在 → ErrBundleNotFound（ctl ErrNotFound 路径）
func TestPlaceRenewOrder_BundleNotFound_FromCTL(t *testing.T) {
	d := newStdDeps()
	d.ctl.getBundleByIDFn = func(_ context.Context, _ string) (*ctlclient.BundleDetail, error) {
		return nil, ctlclient.ErrNotFound
	}
	svc := New(Deps{CTLClient: d.ctl, BundleStore: d.bundle, JifeiClient: d.jifei, OrderWriter: d.writer, OrderStore: d.store})
	_, err := svc.PlaceRenewOrder(context.Background(), stdPlaceRenewOrderReq())
	if err == nil || !errors.Is(err, ErrBundleNotFound) {
		t.Errorf("err = %v, want ErrBundleNotFound", err)
	}
	// 不应触发 jifei / writer
	if d.jifei.generateDealsCalls.Load() != 0 || d.writer.createOrderCalls.Load() != 0 {
		t.Errorf("upstream should NOT be called when bundle not found")
	}
}

// bundle 已下架 → ErrBundleOffline（设计稿语义：下架的 bundle 不可续费）
func TestPlaceRenewOrder_BundleOffline(t *testing.T) {
	d := newStdDeps()
	bundle := stdBundle()
	bundle.BundleState = "OFFLINE"
	d.ctl.getBundleByIDFn = func(_ context.Context, _ string) (*ctlclient.BundleDetail, error) { return bundle, nil }
	d.bundle.def = stdRenewDef()
	svc := New(Deps{CTLClient: d.ctl, BundleStore: d.bundle, JifeiClient: d.jifei, OrderWriter: d.writer, OrderStore: d.store})
	_, err := svc.PlaceRenewOrder(context.Background(), stdPlaceRenewOrderReq())
	if err == nil || !errors.Is(err, ErrBundleOffline) {
		t.Errorf("err = %v, want ErrBundleOffline", err)
	}
}

// trade_bundle_definition 不存在 → ErrBundleNotFound
func TestPlaceRenewOrder_BundleDefinitionNotFound(t *testing.T) {
	d := newStdDeps()
	d.bundle.err = store.ErrBundleDefinitionNotFound
	svc := New(Deps{CTLClient: d.ctl, BundleStore: d.bundle, JifeiClient: d.jifei, OrderWriter: d.writer, OrderStore: d.store})
	_, err := svc.PlaceRenewOrder(context.Background(), stdPlaceRenewOrderReq())
	if err == nil || !errors.Is(err, ErrBundleNotFound) {
		t.Errorf("err = %v, want ErrBundleNotFound", err)
	}
}

// 缺 scene=renew categoryId → 业务错（不应继续往下走）
func TestPlaceRenewOrder_MissingRenewCategory(t *testing.T) {
	d := newStdDeps()
	def := stdRenewDef()
	def.CategoryIDs = []store.CategoryIDEntry{{Scene: "purchase", Category: 100059}} // 缺 renew
	d.bundle.def = def
	svc := New(Deps{CTLClient: d.ctl, BundleStore: d.bundle, JifeiClient: d.jifei, OrderWriter: d.writer, OrderStore: d.store})
	_, err := svc.PlaceRenewOrder(context.Background(), stdPlaceRenewOrderReq())
	if err == nil || !strings.Contains(err.Error(), "category_ids[scene=renew]") {
		t.Errorf("err = %v, want missing renew category", err)
	}
	if d.jifei.generateDealsCalls.Load() != 0 {
		t.Error("jifei should NOT be called when renew category missing")
	}
}

// jifei generateDeals 失败 → 透传 *CGWError（带 (renew) 标记便于排障）
func TestPlaceRenewOrder_JifeiBusinessError_Wrapped(t *testing.T) {
	d := newStdDeps()
	d.bundle.def = stdRenewDef()
	d.jifei.generateDealsFn = func(_ context.Context, _ *jifeiclient.GenerateDealsRequest) (*jifeiclient.GenerateDealsResponse, error) {
		return nil, &jifeiclient.CGWError{ReturnCode: -2001, ReturnMessage: "deal pool exhausted"}
	}
	svc := New(Deps{CTLClient: d.ctl, BundleStore: d.bundle, JifeiClient: d.jifei, OrderWriter: d.writer, OrderStore: d.store})
	_, err := svc.PlaceRenewOrder(context.Background(), stdPlaceRenewOrderReq())
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
	// 不应落 trade_order
	if d.writer.createOrderCalls.Load() != 0 {
		t.Error("writer should NOT be called when jifei fails")
	}
}

// jifei 返空 BigDealID / DealNames → ErrJifeiResponseInvalid
func TestPlaceRenewOrder_JifeiEmptyResponse(t *testing.T) {
	d := newStdDeps()
	d.bundle.def = stdRenewDef()
	d.jifei.generateDealsFn = func(_ context.Context, _ *jifeiclient.GenerateDealsRequest) (*jifeiclient.GenerateDealsResponse, error) {
		return &jifeiclient.GenerateDealsResponse{BigDealID: "", DealNames: nil}, nil
	}
	svc := New(Deps{CTLClient: d.ctl, BundleStore: d.bundle, JifeiClient: d.jifei, OrderWriter: d.writer, OrderStore: d.store})
	_, err := svc.PlaceRenewOrder(context.Background(), stdPlaceRenewOrderReq())
	if err == nil || !errors.Is(err, ErrJifeiResponseInvalid) {
		t.Errorf("err = %v, want ErrJifeiResponseInvalid", err)
	}
}

// trade_order INSERT UNIQUE 冲突 → ErrDealNameDuplicate
func TestPlaceRenewOrder_OrderDuplicate(t *testing.T) {
	d := newStdDeps()
	d.bundle.def = stdRenewDef()
	d.jifei.generateDealsFn = func(_ context.Context, _ *jifeiclient.GenerateDealsRequest) (*jifeiclient.GenerateDealsResponse, error) {
		return stdJifeiDealsResp(), nil
	}
	d.writer.createOrderFn = func(_ context.Context, _ store.CreateOrderInput) error {
		return store.ErrTradeOrderDuplicate
	}
	svc := New(Deps{CTLClient: d.ctl, BundleStore: d.bundle, JifeiClient: d.jifei, OrderWriter: d.writer, OrderStore: d.store})
	_, err := svc.PlaceRenewOrder(context.Background(), stdPlaceRenewOrderReq())
	if err == nil || !errors.Is(err, ErrDealNameDuplicate) {
		t.Errorf("err = %v, want ErrDealNameDuplicate", err)
	}
}

// shadow 反查：Uin 空 + ShadowClient 注入 → 自动从 externalUserId 反查回填 Uin/AppID
func TestPlaceRenewOrder_ShadowClient_BackfillUinAndAppID(t *testing.T) {
	d := newStdDeps()
	d.bundle.def = stdRenewDef()
	d.jifei.generateDealsFn = func(_ context.Context, _ *jifeiclient.GenerateDealsRequest) (*jifeiclient.GenerateDealsResponse, error) {
		return stdJifeiDealsResp(), nil
	}
	shadow := &fakeShadow{
		getBindingFn: func(_ context.Context, externalUserID string) (*shadowclient.Binding, error) {
			return &shadowclient.Binding{UserID: externalUserID, Uin: "9999888", AppID: "12345"}, nil
		},
	}
	svc := New(Deps{
		CTLClient:    d.ctl,
		BundleStore:  d.bundle,
		JifeiClient:  d.jifei,
		OrderWriter:  d.writer,
		OrderStore:   d.store,
		ShadowClient: shadow,
	})

	req := stdPlaceRenewOrderReq()
	req.Uin = ""
	req.AppID = ""
	if _, err := svc.PlaceRenewOrder(context.Background(), req); err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if shadow.calls.Load() != 1 {
		t.Errorf("shadow calls = %d, want 1", shadow.calls.Load())
	}
	jr := d.jifei.lastGenerateDealsReq
	if jr == nil || jr.Uin != "9999888" {
		t.Errorf("jifei.Uin not backfilled from shadow")
	}
	in := d.writer.lastCreateOrderInput
	if in.Uin != "9999888" || in.AppID != "12345" {
		t.Errorf("trade_order Uin/AppID = %s/%s, want 9999888/12345", in.Uin, in.AppID)
	}
	// 续费 trade_order 仍含 OrderType=renew + ResourceID 关键字段
	if in.OrderType != store.OrderTypeRenew || in.ResourceID != "lhpass-r1" {
		t.Errorf("OrderType/ResourceID lost during shadow backfill: %+v", in)
	}
}

// shadow 返 ErrBindingNotFound → 映射 ErrBindingNotFound
func TestPlaceRenewOrder_ShadowClient_BindingNotFound(t *testing.T) {
	d := newStdDeps()
	d.bundle.def = stdRenewDef()
	shadow := &fakeShadow{
		getBindingFn: func(_ context.Context, _ string) (*shadowclient.Binding, error) {
			return nil, shadowclient.ErrBindingNotFound
		},
	}
	svc := New(Deps{
		CTLClient: d.ctl, BundleStore: d.bundle, JifeiClient: d.jifei,
		OrderWriter: d.writer, OrderStore: d.store, ShadowClient: shadow,
	})
	req := stdPlaceRenewOrderReq()
	req.Uin = ""
	_, err := svc.PlaceRenewOrder(context.Background(), req)
	if err == nil || !errors.Is(err, ErrBindingNotFound) {
		t.Errorf("err = %v, want ErrBindingNotFound", err)
	}
}

// shadow 注入但 ExternalUserID + Uin 同空 → ErrInvalidInput（ExternalUserID 始终必填）
func TestPlaceRenewOrder_ShadowClient_NoExternalUserID(t *testing.T) {
	d := newStdDeps()
	d.bundle.def = stdRenewDef()
	svc := New(Deps{
		CTLClient: d.ctl, BundleStore: d.bundle, JifeiClient: d.jifei,
		OrderWriter: d.writer, OrderStore: d.store, ShadowClient: &fakeShadow{},
	})
	req := stdPlaceRenewOrderReq()
	req.ExternalUserID = ""
	req.Uin = ""
	_, err := svc.PlaceRenewOrder(context.Background(), req)
	if err == nil || !errors.Is(err, ErrInvalidInput) {
		t.Errorf("err = %v, want ErrInvalidInput", err)
	}
	if !strings.Contains(err.Error(), "external_user_id") {
		t.Errorf("err = %v, want 'external_user_id' substring", err)
	}
}

// store INSERT 时 ResourceID 必须非空（验证 R-C-5 与 R-A migration 0003 协同）
func TestPlaceRenewOrder_OrderInputResourceIDNotEmpty(t *testing.T) {
	d := newStdDeps()
	d.bundle.def = stdRenewDef()
	d.jifei.generateDealsFn = func(_ context.Context, _ *jifeiclient.GenerateDealsRequest) (*jifeiclient.GenerateDealsResponse, error) {
		return stdJifeiDealsResp(), nil
	}
	svc := New(Deps{CTLClient: d.ctl, BundleStore: d.bundle, JifeiClient: d.jifei, OrderWriter: d.writer, OrderStore: d.store})
	if _, err := svc.PlaceRenewOrder(context.Background(), stdPlaceRenewOrderReq()); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	in := d.writer.lastCreateOrderInput
	if in.ResourceID == "" {
		t.Fatalf("续费下单 trade_order.resource_id 必须非空（INSERT 时填 pass_id），got empty")
	}
	if in.OrderType != store.OrderTypeRenew {
		t.Fatalf("续费下单 trade_order.order_type 必须为 'renew', got %q", in.OrderType)
	}
}

// ============================================================================
// R-D-7：PlaceRenewOrderAndPay 续费一体化下单测试（设计稿 §3.3 / §4.4 / R-D-7）
//
// 与 PlaceRenewOrder 的差异（合并 PlaceOrderAndPay 一体化范式 + 续费独有差异）：
//   - jifei generateDealsAndPay (vs PlaceRenewOrder 的 generateDeals)
//   - 落库 status='paid_pending_provision' (vs PlaceRenewOrder 的 'pending_pay')
//   - 出参 BigOrderID 取自响应 BigDealIDs[0] (vs PlaceRenewOrder 的 BigDealID)
//   - OrderType='renew' + ResourceID=passID 与 PlaceRenewOrder 完全一致
// ============================================================================

// TestPlaceRenewOrderAndPay_HappyPath 完整 happy path：覆盖 5 处关键不变量
//   - jifei generateDealsAndPay 入参 GoodsCategoryID=100060 (scene=renew) + goodsDetail.resourceId
//   - autoVoucher=1（一体化测试链路自动扣代金券）
//   - **v1.7.28 BUG-26 修订**（与 PlaceOrderAndPay BUG-23 同范式）：jifei 同步发货成功
//     （state="0" + resourceIds 非空）时 trade_order 直接落 Status='provisioned'（一次到位完成态），
//     不再走 paid_pending_provision 中间态
func TestPlaceRenewOrderAndPay_HappyPath(t *testing.T) {
	d := newStdDeps()
	d.bundle.def = stdRenewDef()
	d.jifei.generateDealsAndPayFn = func(_ context.Context, _ *jifeiclient.GenerateDealsAndPayRequest) (*jifeiclient.GenerateDealsAndPayResponse, error) {
		return &jifeiclient.GenerateDealsAndPayResponse{
			DealNames:  []string{"20260515000000001-001"},
			BigDealIDs: []string{"20260515000000001"},
			ResourceIDs: map[string][]string{
				// jifei 同步返的 resourceIds[dealName][0] 是透传回的 req.ResourceID（lhpass-r1）
				"20260515000000001-001": {"lhpass-r1"},
			},
			// v1.7.28 BUG-26: state="0" 表示 jifei 同步发货成功，trade_order 直接落 provisioned
			DealDeliverResults: map[string]map[string]interface{}{
				"20260515000000001-001": {"state": "0"},
			},
		}, nil
	}
	svc := New(Deps{
		CTLClient:   d.ctl,
		BundleStore: d.bundle,
		JifeiClient: d.jifei,
		OrderWriter: d.writer,
		OrderStore:  d.store,
	})

	got, err := svc.PlaceRenewOrderAndPay(context.Background(), stdPlaceRenewOrderReq())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.DealName != "20260515000000001-001" || got.BigOrderID != "20260515000000001" {
		t.Errorf("DealName/BigOrderID mismatch: got %+v", got)
	}

	// 验证 jifei generateDealsAndPay 入参（与 PlaceRenewOrder 一致 + autoVoucher）
	jr := d.jifei.lastGenerateDealsAndPayReq
	if jr == nil {
		t.Fatal("expected GenerateDealsAndPay to be called")
	}
	if jr.AutoVoucher == nil || *jr.AutoVoucher != 1 {
		t.Errorf("AutoVoucher = %v, want pointer-to-1 (一体化默认自动扣代金券)", jr.AutoVoucher)
	}
	if len(jr.Goods) != 1 {
		t.Fatalf("GoodsInfos len = %d, want 1", len(jr.Goods))
	}
	gi := jr.Goods[0]
	if gi.GoodsCategoryID != 100060 {
		t.Errorf("GoodsCategoryID = %d, want 100060 (scene=renew)", gi.GoodsCategoryID)
	}
	if gi.GoodsDetail["resourceId"] != "lhpass-r1" {
		t.Errorf("goodsDetail.resourceId = %v, want lhpass-r1 (续费独有差异)", gi.GoodsDetail["resourceId"])
	}
	// v1.7.20 B15: 续费一体化也透传 curDeadline (PDF §4.3 必填; 与 PlaceRenewOrder 共享)
	if gi.GoodsDetail["curDeadline"] != "2026-06-15 10:30:00" {
		t.Errorf("goodsDetail.curDeadline = %v, want 2026-06-15 10:30:00", gi.GoodsDetail["curDeadline"])
	}

	// 验证 trade_order 落库：OrderType=renew + ResourceID + Status=provisioned（BUG-26 修订）
	in := d.writer.lastCreateOrderInput
	if in.OrderType != store.OrderTypeRenew {
		t.Errorf("OrderType = %q, want %q", in.OrderType, store.OrderTypeRenew)
	}
	if in.ResourceID != "lhpass-r1" {
		t.Errorf("ResourceID = %q, want lhpass-r1", in.ResourceID)
	}
	if in.Status != "provisioned" {
		t.Errorf("Status = %q, want provisioned (BUG-26: state=0 落完成态)", in.Status)
	}
	if in.ResourceType != "pass" {
		t.Errorf("ResourceType = %q, want pass", in.ResourceType)
	}
	if in.BigOrderID != "20260515000000001" {
		t.Errorf("BigOrderID = %q, want 20260515000000001", in.BigOrderID)
	}
	// 不应触发 PlaceRenewOrder 的两步式 generateDeals
	if d.jifei.generateDealsCalls.Load() != 0 {
		t.Errorf("一体化路径不应调 generateDeals, got %d calls", d.jifei.generateDealsCalls.Load())
	}
}

// TestPlaceRenewOrderAndPay_InvalidInput 入参校验（复用 validatePlaceRenewOrderRequest 与 PlaceRenewOrder 一致）。
// 关键覆盖：ResourceID 必填（续费独有，与 PlaceOrderAndPay 区分）。
func TestPlaceRenewOrderAndPay_InvalidInput(t *testing.T) {
	svc := New(Deps{
		CTLClient: &fakeCTL{}, BundleStore: &fakeBundleStore{}, JifeiClient: &fakeJifei{},
		OrderWriter: &fakeOrderWriter{}, OrderStore: &fakeOrderStore{},
	})
	req := stdPlaceRenewOrderReq()
	req.ResourceID = "" // 缺续费目标 pass_id
	_, err := svc.PlaceRenewOrderAndPay(context.Background(), req)
	if err == nil || !errors.Is(err, ErrInvalidInput) || !strings.Contains(err.Error(), "resource_id") {
		t.Errorf("err = %v, want ErrInvalidInput containing resource_id", err)
	}
}

// TestPlaceRenewOrderAndPay_BundleOffline 已下架 bundle 不可续费（与 PlaceRenewOrder 一致行为）。
func TestPlaceRenewOrderAndPay_BundleOffline(t *testing.T) {
	d := newStdDeps()
	bundle := stdBundle()
	bundle.BundleState = "OFFLINE"
	d.ctl.getBundleByIDFn = func(_ context.Context, _ string) (*ctlclient.BundleDetail, error) { return bundle, nil }
	d.bundle.def = stdRenewDef()
	svc := New(Deps{CTLClient: d.ctl, BundleStore: d.bundle, JifeiClient: d.jifei, OrderWriter: d.writer, OrderStore: d.store})
	_, err := svc.PlaceRenewOrderAndPay(context.Background(), stdPlaceRenewOrderReq())
	if err == nil || !errors.Is(err, ErrBundleOffline) {
		t.Errorf("err = %v, want ErrBundleOffline", err)
	}
}

// TestPlaceRenewOrderAndPay_MissingRenewCategory 缺 scene=renew categoryId → 业务错（不应继续往下走）。
func TestPlaceRenewOrderAndPay_MissingRenewCategory(t *testing.T) {
	d := newStdDeps()
	def := stdRenewDef()
	def.CategoryIDs = []store.CategoryIDEntry{{Scene: "purchase", Category: 100059}} // 缺 renew
	d.bundle.def = def
	svc := New(Deps{CTLClient: d.ctl, BundleStore: d.bundle, JifeiClient: d.jifei, OrderWriter: d.writer, OrderStore: d.store})
	_, err := svc.PlaceRenewOrderAndPay(context.Background(), stdPlaceRenewOrderReq())
	if err == nil || !strings.Contains(err.Error(), "category_ids[scene=renew]") {
		t.Errorf("err = %v, want missing renew category", err)
	}
	if d.jifei.generateDealsAndPayCalls.Load() != 0 {
		t.Error("jifei should NOT be called when renew category missing")
	}
}

// TestPlaceRenewOrderAndPay_InvalidResponse jifei 返空响应 → ErrJifeiResponseInvalid (带 (renew) 标记)。
func TestPlaceRenewOrderAndPay_InvalidResponse(t *testing.T) {
	d := newStdDeps()
	d.bundle.def = stdRenewDef()
	d.jifei.generateDealsAndPayFn = func(_ context.Context, _ *jifeiclient.GenerateDealsAndPayRequest) (*jifeiclient.GenerateDealsAndPayResponse, error) {
		return &jifeiclient.GenerateDealsAndPayResponse{}, nil
	}
	svc := New(Deps{CTLClient: d.ctl, BundleStore: d.bundle, JifeiClient: d.jifei, OrderWriter: d.writer, OrderStore: d.store})
	_, err := svc.PlaceRenewOrderAndPay(context.Background(), stdPlaceRenewOrderReq())
	if err == nil || !errors.Is(err, ErrJifeiResponseInvalid) {
		t.Errorf("err = %v, want ErrJifeiResponseInvalid", err)
	}
	if !strings.Contains(err.Error(), "renew") {
		t.Errorf("err = %v, want '(renew)' marker for trace", err)
	}
}
