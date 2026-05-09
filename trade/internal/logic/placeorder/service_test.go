package placeorder

import (
	"context"
	"errors"
	"strings"
	"sync/atomic"
	"testing"

	"git.woa.com/wisp/mono/trade/internal/ctlclient"
	"git.woa.com/wisp/mono/trade/internal/jifeiclient"
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
	generateDealsFn      func(ctx context.Context, req *jifeiclient.GenerateDealsRequest) (*jifeiclient.GenerateDealsResponse, error)
	generateDealsCalls   atomic.Int32
	lastGenerateDealsReq *jifeiclient.GenerateDealsRequest
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

type fakeOrderWriter struct {
	createOrderFn          func(ctx context.Context, in store.CreateOrderInput) error
	createOrderCalls       atomic.Int32
	lastCreateOrderInput   store.CreateOrderInput
	markProvisionedFn      func(ctx context.Context, dealName, resourceID string) error
	markProvisionedCalls   atomic.Int32
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

type fakeOrderStore struct {
	getOrderByDealNameFn func(ctx context.Context, dealName string) (*store.TradeOrder, error)
}

func (f *fakeOrderStore) GetOrderByDealName(ctx context.Context, dealName string) (*store.TradeOrder, error) {
	if f.getOrderByDealNameFn != nil {
		return f.getOrderByDealNameFn(ctx, dealName)
	}
	return nil, errors.New("fakeOrderStore: GetOrderByDealName not implemented")
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
		RegionID:       1,
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
	ctl     *fakeCTL
	bundle  *fakeBundleStore
	jifei   *fakeJifei
	writer  *fakeOrderWriter
	store   *fakeOrderStore
	service *Service
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
		writer: &fakeOrderWriter{},
		store:  &fakeOrderStore{},
	}
	d.service = New(Deps{
		CTLClient:   d.ctl,
		BundleStore: d.bundle,
		JifeiClient: d.jifei,
		OrderWriter: d.writer,
		OrderStore:  d.store,
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
	if len(jReq.GoodsInfos) != 1 {
		t.Fatalf("expected GoodsInfos len 1, got %d", len(jReq.GoodsInfos))
	}
	gi := jReq.GoodsInfos[0]
	if gi.GoodsCategoryID != "100059" {
		t.Errorf("GoodsCategoryID mismatch: got %q", gi.GoodsCategoryID)
	}
	if gi.RegionID != 1 || gi.GoodsNum != 1 || gi.PayMode != 1 {
		t.Errorf("RegionID/GoodsNum/PayMode mismatch: %+v", gi)
	}
	if gi.GoodsDetail["productCode"] != "p_lighthouse" {
		t.Errorf("goodsDetail.productCode mismatch: %+v", gi.GoodsDetail)
	}
	if gi.GoodsDetail["sv_cpu"] != "2" {
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
	if jReq.GoodsInfos[0].GoodsNum != 1 {
		t.Errorf("expected GoodsNum default to 1, got %d", jReq.GoodsInfos[0].GoodsNum)
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
	def.CategoryIDs = []store.CategoryIDEntry{{Scene: "renew", Category: "100060"}}
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
			EventID:       "ev-1",
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
			PayURL:   "https://buy.cloud.tencent.com/abc",
		}, nil
	}
	url, err := d.service.GeneratePayURL(context.Background(), "deal-1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if url != "https://buy.cloud.tencent.com/abc" {
		t.Errorf("url mismatch: %q", url)
	}
}

func TestGeneratePayURL_EmptyDealName(t *testing.T) {
	d := newStdDeps()
	_, err := d.service.GeneratePayURL(context.Background(), "")
	if !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("expected ErrInvalidInput, got %v", err)
	}
}

func TestGeneratePayURL_NotFound(t *testing.T) {
	d := newStdDeps()
	d.store.getOrderByDealNameFn = func(ctx context.Context, dealName string) (*store.TradeOrder, error) {
		return nil, store.ErrTradeOrderNotFound
	}
	_, err := d.service.GeneratePayURL(context.Background(), "deal-x")
	if !errors.Is(err, store.ErrTradeOrderNotFound) {
		t.Fatalf("expected wrap of ErrTradeOrderNotFound, got %v", err)
	}
}

func TestGeneratePayURL_PayURLNotCached(t *testing.T) {
	d := newStdDeps()
	d.store.getOrderByDealNameFn = func(ctx context.Context, dealName string) (*store.TradeOrder, error) {
		return &store.TradeOrder{DealName: dealName, PayURL: ""}, nil
	}
	_, err := d.service.GeneratePayURL(context.Background(), "deal-1")
	if !errors.Is(err, ErrPayURLUnavailable) {
		t.Fatalf("expected ErrPayURLUnavailable, got %v", err)
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
