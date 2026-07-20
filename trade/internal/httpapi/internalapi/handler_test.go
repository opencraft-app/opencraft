package internalapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/gin-gonic/gin"

	"git.woa.com/wisp/mono/trade/internal/ctlclient"
	"git.woa.com/wisp/mono/trade/internal/jifeiclient"
	"git.woa.com/wisp/mono/trade/internal/logic/inquiry"
	"git.woa.com/wisp/mono/trade/internal/logic/placeorder"
	"git.woa.com/wisp/mono/trade/internal/store"
)

func init() {
	gin.SetMode(gin.TestMode)
}

// ============================================================================
// fakes - inquiry / placeorder Service 通过其依赖注入间接构造，避免对 Service 的 mock。
// ============================================================================

type fakeCTL struct {
	getBundleByIDFn func(ctx context.Context, bundleID string) (*ctlclient.BundleDetail, error)
}

func (f *fakeCTL) GetBundleByID(ctx context.Context, bundleID string) (*ctlclient.BundleDetail, error) {
	if f.getBundleByIDFn != nil {
		return f.getBundleByIDFn(ctx, bundleID)
	}
	return &ctlclient.BundleDetail{
		BundleID:    bundleID,
		BundleName:  "test bundle",
		BundleState: "ONLINE",
	}, nil
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
	return nil, errors.New("IsolatePass not used in internalapi tests")
}

func (f *fakeCTL) RenewPass(_ context.Context, _ string, _ *ctlclient.RenewPassRequest) (*ctlclient.RenewPassResponse, error) {
	return nil, errors.New("RenewPass not used in internalapi tests")
}

func (f *fakeCTL) DestroyPass(_ context.Context, _ string, _ *ctlclient.DestroyPassRequest) (*ctlclient.DestroyPassResponse, error) {
	return nil, errors.New("DestroyPass not used in internalapi tests")
}

// fakeBundleStore 默认行为兼容历史用例（仅返 purchase scene）；
// R-C-7 起支持 getBundleDefinitionByIDFn 注入，方便续费场景测试覆盖 scene=renew 分支。
type fakeBundleStore struct {
	getBundleDefinitionByIDFn func(ctx context.Context, bundleID string) (*store.BundleDefinition, error)
}

func (f *fakeBundleStore) GetBundleDefinitionByID(ctx context.Context, bundleID string) (*store.BundleDefinition, error) {
	if f.getBundleDefinitionByIDFn != nil {
		return f.getBundleDefinitionByIDFn(ctx, bundleID)
	}
	return &store.BundleDefinition{
		BundleID:       bundleID,
		ProductCode:    "p_lighthouse",
		SubProductCode: "sp_test",
		// Q71（2026-05-13）：pid / category / sv_* 都是 int64（PDF §4.1 / §4.4 / §4.4.1.1.2）。
		Pid: 1234,
		CategoryIDs: []store.CategoryIDEntry{
			{Scene: "purchase", Category: 100059},
		},
		SVList: map[string]int64{"sv_cpu": 2},
	}, nil
}
func (f *fakeBundleStore) ListBundleDefsBySubProductCode(_ context.Context, _, _ string) ([]*store.BundleDefinition, error) {
	return nil, errors.New("ListBundleDefsBySubProductCode not used in internalapi handler test")
}
func (f *fakeBundleStore) GetBundleDefinitionsByIDs(_ context.Context, _ []string) (map[string]*store.BundleDefinition, error) {
	return nil, errors.New("GetBundleDefinitionsByIDs not used in internalapi handler test")
}

type fakeJifei struct {
	getPriceFn            func(ctx context.Context, req *jifeiclient.GetPriceRequest) (*jifeiclient.GetPriceResponse, error)
	generateDealsFn       func(ctx context.Context, req *jifeiclient.GenerateDealsRequest) (*jifeiclient.GenerateDealsResponse, error)
	generateDealsAndPayFn func(ctx context.Context, req *jifeiclient.GenerateDealsAndPayRequest) (*jifeiclient.GenerateDealsAndPayResponse, error)
	getMidasEarmarkingFn  func(ctx context.Context, req *jifeiclient.GetMidasEarmarkingRequest) (*jifeiclient.GetMidasEarmarkingResponse, error)
	// D-2.1: ModifyResourceStatus 钩子（jifei `qcloud.operation.ModifyResourceStatus` 销毁/隔离）
	modifyResourceStatusFn func(ctx context.Context, req *jifeiclient.ModifyResourceStatusRequest) (*jifeiclient.ModifyResourceStatusResponse, error)
	// trade-pass-refund-design.md v0.5: OnlineRefund 钩子（jifei `qcloud.Deal.OnlineRefund` 线上退款）
	onlineRefundFn func(ctx context.Context, req *jifeiclient.OnlineRefundRequest) (*jifeiclient.OnlineRefundResponse, error)
}

func (f *fakeJifei) GetPrice(ctx context.Context, req *jifeiclient.GetPriceRequest) (*jifeiclient.GetPriceResponse, error) {
	if f.getPriceFn != nil {
		return f.getPriceFn(ctx, req)
	}
	return &jifeiclient.GetPriceResponse{
		Data: []jifeiclient.GetPriceData{
			{Price: "39.00", TotalCost: "39.00", RealTotalCost: "35.10", Currency: "CNY"},
		},
	}, nil
}
func (f *fakeJifei) GenerateDeals(ctx context.Context, req *jifeiclient.GenerateDealsRequest) (*jifeiclient.GenerateDealsResponse, error) {
	if f.generateDealsFn != nil {
		return f.generateDealsFn(ctx, req)
	}
	return &jifeiclient.GenerateDealsResponse{
		BigDealID: "big-1",
		DealNames: []string{"deal-1"},
	}, nil
}
func (f *fakeJifei) GenerateDealsAndPay(ctx context.Context, req *jifeiclient.GenerateDealsAndPayRequest) (*jifeiclient.GenerateDealsAndPayResponse, error) {
	if f.generateDealsAndPayFn != nil {
		return f.generateDealsAndPayFn(ctx, req)
	}
	return &jifeiclient.GenerateDealsAndPayResponse{
		BigDealIDs: []string{"big-pay-1"},
		DealNames:  []string{"deal-pay-1"},
		ResourceIDs: map[string][]string{
			"deal-pay-1": {"lhins-default-resource"},
		},
		// v1.7.28 BUG-22/23：默认 mock 模拟 jifei 同步发货成功（state="0"），
		// PlaceOrderAndPay 才会落 trade_order(provisioned)；不带 state 字段时
		// 视为异步中态不落库（与 service.go::shouldPersistOrderAfterPay 对齐）。
		DealDeliverResults: map[string]map[string]interface{}{
			"deal-pay-1": {"state": "0"},
		},
	}, nil
}
func (f *fakeJifei) GetMidasEarmarking(ctx context.Context, req *jifeiclient.GetMidasEarmarkingRequest) (*jifeiclient.GetMidasEarmarkingResponse, error) {
	if f.getMidasEarmarkingFn != nil {
		return f.getMidasEarmarkingFn(ctx, req)
	}
	return &jifeiclient.GetMidasEarmarkingResponse{
		BillID:     "bill-default",
		URL:        "https://buy.cloud.tencent.com/midas/handler-test-default",
		AppID:      "1000029101",
		NeedCharge: 1,
	}, nil
}

// ModifyResourceStatus（D-2.1 引入）：handler_test 现有用例不调用，本方法仅为满足
// jifeiclient.Client 接口实现；如未来 D-2.2 给本 fake 加销毁端点测试，可注入 modifyResourceStatusFn。
func (f *fakeJifei) ModifyResourceStatus(ctx context.Context, req *jifeiclient.ModifyResourceStatusRequest) (*jifeiclient.ModifyResourceStatusResponse, error) {
	if f.modifyResourceStatusFn != nil {
		return f.modifyResourceStatusFn(ctx, req)
	}
	return &jifeiclient.ModifyResourceStatusResponse{
		OperationSet: []jifeiclient.ModifyResourceStatusOperation{{Status: 0}},
	}, nil
}

func (f *fakeJifei) GetDealsByKeyIndex(ctx context.Context, req *jifeiclient.GetDealsByKeyIndexRequest) (*jifeiclient.GetDealsByKeyIndexResponse, error) {
	// internalapi handler 本期不会调 GetDealsByKeyIndex（该接口由 orderstatus handler 直调
	// jifeiclient.Client）。本方法仅为满足 jifeiclient.Client interface 实现。
	return &jifeiclient.GetDealsByKeyIndexResponse{}, nil
}

// OnlineRefund（trade-pass-refund-design.md v0.5 引入）：refund handler 测试可注入
// onlineRefundFn 自定义返回；默认返单条 dealName/bigDealId 模拟 jifei 同步成功。
func (f *fakeJifei) OnlineRefund(ctx context.Context, req *jifeiclient.OnlineRefundRequest) (*jifeiclient.OnlineRefundResponse, error) {
	if f.onlineRefundFn != nil {
		return f.onlineRefundFn(ctx, req)
	}
	return &jifeiclient.OnlineRefundResponse{
		DealNames:  []string{"deal-refund-default"},
		BigDealIDs: []string{"big-deal-refund-default"},
	}, nil
}

type fakeOrderWriter struct {
	createOrderFn        func(ctx context.Context, in store.CreateOrderInput) error
	createOrderCalls     atomic.Int32
	lastCreateOrderInput store.CreateOrderInput
	updatePayURLFn       func(ctx context.Context, dealName, payURL string) error
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
	return nil
}
func (f *fakeOrderWriter) UpdatePayURL(ctx context.Context, dealName, payURL string) error {
	if f.updatePayURLFn != nil {
		return f.updatePayURLFn(ctx, dealName, payURL)
	}
	return nil
}

func (f *fakeOrderWriter) MarkOrderCancelled(ctx context.Context, dealName string) error {
	// internalapi handler 本期不调 MarkOrderCancelled（该接口由 trade orderstatus logic 调用，
	// 不走 placeorder/createresource 路径）。本方法仅为满足 store.OrderWriter interface 实现。
	return nil
}

type fakeOrderStore struct {
	getOrderByDealNameFn func(ctx context.Context, dealName string) (*store.TradeOrder, error)
}

func (f *fakeOrderStore) GetOrderByDealName(ctx context.Context, dealName string) (*store.TradeOrder, error) {
	if f.getOrderByDealNameFn != nil {
		return f.getOrderByDealNameFn(ctx, dealName)
	}
	return nil, store.ErrTradeOrderNotFound
}

// ============================================================================
// helpers
// ============================================================================

type testEnv struct {
	router      *gin.Engine
	ctl         *fakeCTL
	jifei       *fakeJifei
	orderWriter *fakeOrderWriter
	orderStore  *fakeOrderStore
	bundle      *fakeBundleStore
	token       string
}

func newTestEnv(t *testing.T) *testEnv {
	t.Helper()
	ctl := &fakeCTL{}
	jifei := &fakeJifei{}
	orderWriter := &fakeOrderWriter{}
	orderStore := &fakeOrderStore{}
	bundle := &fakeBundleStore{}

	inq := inquiry.New(inquiry.Deps{
		CTLClient:   ctl,
		BundleStore: bundle,
		JifeiClient: jifei,
	})
	po := placeorder.New(placeorder.Deps{
		CTLClient:   ctl,
		BundleStore: bundle,
		JifeiClient: jifei,
		OrderWriter: orderWriter,
		OrderStore:  orderStore,
	})

	r := gin.New()
	Install(r, Deps{
		InternalServiceToken: "test-token",
		Inquiry:              inq,
		PlaceOrder:           po,
		// D-2.2 销毁链路用户主动入口路由依赖（设计稿 §3.5 + §11-A Q26）。
		BundleStore: bundle,
		JifeiClient: jifei,
	})

	return &testEnv{
		router:      r,
		ctl:         ctl,
		jifei:       jifei,
		orderWriter: orderWriter,
		orderStore:  orderStore,
		bundle:      bundle,
		token:       "test-token",
	}
}

func (e *testEnv) doJSON(method, path string, body any, withAuth bool) *httptest.ResponseRecorder {
	var buf bytes.Buffer
	if body != nil {
		_ = json.NewEncoder(&buf).Encode(body)
	}
	req := httptest.NewRequest(method, path, &buf)
	req.Header.Set("Content-Type", "application/json")
	if withAuth {
		req.Header.Set("Authorization", "Bearer "+e.token)
	}
	rec := httptest.NewRecorder()
	e.router.ServeHTTP(rec, req)
	return rec
}

func decodeBody(t *testing.T, rec *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &m); err != nil {
		t.Fatalf("invalid JSON body: %v: raw=%s", err, rec.Body.String())
	}
	return m
}

// ============================================================================
// auth tests
// ============================================================================

func TestAuth_MissingHeader(t *testing.T) {
	env := newTestEnv(t)
	rec := env.doJSON(http.MethodPost, "/internal/trade/inquiry/batch", map[string]any{}, false)
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("expected 401, got %d", rec.Code)
	}
}

func TestAuth_WrongToken(t *testing.T) {
	env := newTestEnv(t)
	req := httptest.NewRequest(http.MethodPost, "/internal/trade/inquiry/batch", bytes.NewBufferString(`{}`))
	req.Header.Set("Authorization", "Bearer wrong-token")
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	env.router.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("expected 401, got %d", rec.Code)
	}
}

func TestAuth_EmptyConfiguredToken(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	inq := inquiry.New(inquiry.Deps{
		CTLClient:   &fakeCTL{},
		BundleStore: &fakeBundleStore{},
		JifeiClient: &fakeJifei{},
	})
	po := placeorder.New(placeorder.Deps{
		CTLClient:   &fakeCTL{},
		BundleStore: &fakeBundleStore{},
		JifeiClient: &fakeJifei{},
		OrderWriter: &fakeOrderWriter{},
		OrderStore:  &fakeOrderStore{},
	})
	Install(r, Deps{
		InternalServiceToken: "", // 配置缺失
		Inquiry:              inq,
		PlaceOrder:           po,
	})
	req := httptest.NewRequest(http.MethodPost, "/internal/trade/inquiry/batch",
		bytes.NewBufferString(`{}`))
	req.Header.Set("Authorization", "Bearer anything")
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusInternalServerError {
		t.Errorf("expected 500 when token not configured, got %d", rec.Code)
	}
}

// ============================================================================
// inquiry/batch tests
// ============================================================================

func TestInquiryBatch_HappyPath(t *testing.T) {
	env := newTestEnv(t)
	body := map[string]any{
		"externalUserId": "user-1",
		"uin":            "1000",
		"appId":          "10001",
		"bundleIds":      []string{"b1", "b2"},
		"period":         1,
		"timeUnit":       "m",
		"goodsNum":       1,
		"payMode":        1,
		"regionId":       1,
	}
	rec := env.doJSON(http.MethodPost, "/internal/trade/inquiry/batch", body, true)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d body=%s", rec.Code, rec.Body.String())
	}
	resp := decodeBody(t, rec)
	prices, _ := resp["prices"].([]any)
	if len(prices) != 2 {
		t.Errorf("expected 2 prices, got %d", len(prices))
	}
}

func TestInquiryBatch_EmptyBundleIDs(t *testing.T) {
	env := newTestEnv(t)
	body := map[string]any{
		"uin":      "1000",
		"period":   1,
		"timeUnit": "m",
	}
	rec := env.doJSON(http.MethodPost, "/internal/trade/inquiry/batch", body, true)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", rec.Code)
	}
}

func TestInquiryBatch_BundleNotFound(t *testing.T) {
	env := newTestEnv(t)
	env.ctl.getBundleByIDFn = func(ctx context.Context, bundleID string) (*ctlclient.BundleDetail, error) {
		return nil, ctlclient.ErrNotFound
	}
	body := map[string]any{
		"uin":       "1000",
		"bundleIds": []string{"missing"},
		"period":    1,
		"timeUnit":  "m",
		"payMode":   1,
	}
	rec := env.doJSON(http.MethodPost, "/internal/trade/inquiry/batch", body, true)
	if rec.Code != http.StatusNotFound {
		t.Errorf("expected 404, got %d", rec.Code)
	}
	resp := decodeBody(t, rec)
	if resp["code"] != "BundleNotFound" {
		t.Errorf("expected code=BundleNotFound, got %v", resp["code"])
	}
}

func TestInquiryBatch_MalformedJSON(t *testing.T) {
	env := newTestEnv(t)
	req := httptest.NewRequest(http.MethodPost, "/internal/trade/inquiry/batch",
		bytes.NewBufferString(`{not json`))
	req.Header.Set("Authorization", "Bearer "+env.token)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	env.router.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", rec.Code)
	}
}

// ============================================================================
// place order tests
// ============================================================================

func TestPlaceOrder_HappyPath(t *testing.T) {
	env := newTestEnv(t)
	body := map[string]any{
		"externalUserId": "user-1",
		"uin":            "1000",
		"appId":          "10001",
		"bundleId":       "b1",
		"period":         1,
		"timeUnit":       "m",
		"goodsNum":       1,
		"payMode":        1,
		// Q41 修订 2026-05-11：regionId 不再由 ctl 透传，trade 内部固定 1/100001
	}
	rec := env.doJSON(http.MethodPost, "/internal/trade/orders", body, true)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d body=%s", rec.Code, rec.Body.String())
	}
	resp := decodeBody(t, rec)
	if resp["dealName"] != "deal-1" {
		t.Errorf("dealName mismatch: %v", resp["dealName"])
	}
	if resp["bigOrderId"] != "big-1" {
		t.Errorf("bigOrderId mismatch: %v", resp["bigOrderId"])
	}
	if env.orderWriter.createOrderCalls.Load() != 1 {
		t.Errorf("expected CreateOrder called once, got %d", env.orderWriter.createOrderCalls.Load())
	}
}

func TestPlaceOrder_InvalidInput(t *testing.T) {
	env := newTestEnv(t)
	body := map[string]any{
		"bundleId": "", // 缺失
		"period":   1,
		"timeUnit": "m",
	}
	rec := env.doJSON(http.MethodPost, "/internal/trade/orders", body, true)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", rec.Code)
	}
	resp := decodeBody(t, rec)
	if resp["code"] != "InvalidRequest" {
		t.Errorf("expected code=InvalidRequest, got %v", resp["code"])
	}
}

func TestPlaceOrder_BundleOffline(t *testing.T) {
	env := newTestEnv(t)
	env.ctl.getBundleByIDFn = func(ctx context.Context, bundleID string) (*ctlclient.BundleDetail, error) {
		return &ctlclient.BundleDetail{BundleID: bundleID, BundleState: "OFFLINE"}, nil
	}
	body := map[string]any{
		"externalUserId": "u1",
		"uin":            "1000",
		"bundleId":       "b1",
		"period":         1,
		"timeUnit":       "m",
		"payMode":        1,
	}
	rec := env.doJSON(http.MethodPost, "/internal/trade/orders", body, true)
	if rec.Code != http.StatusConflict {
		t.Errorf("expected 409, got %d", rec.Code)
	}
}

func TestPlaceOrder_JifeiInvalidResponse(t *testing.T) {
	env := newTestEnv(t)
	env.jifei.generateDealsFn = func(ctx context.Context, req *jifeiclient.GenerateDealsRequest) (*jifeiclient.GenerateDealsResponse, error) {
		return &jifeiclient.GenerateDealsResponse{}, nil // 空 BigDealID / DealNames
	}
	body := map[string]any{
		"externalUserId": "u1",
		"uin":            "1000",
		"bundleId":       "b1",
		"period":         1,
		"timeUnit":       "m",
		"payMode":        1,
	}
	rec := env.doJSON(http.MethodPost, "/internal/trade/orders", body, true)
	if rec.Code != http.StatusBadGateway {
		t.Errorf("expected 502, got %d", rec.Code)
	}
}

// ============================================================================
// place order and pay tests (8B-1.5)
// ============================================================================

func TestPlaceOrderAndPay_HappyPath(t *testing.T) {
	env := newTestEnv(t)
	body := map[string]any{
		"externalUserId": "user-1",
		"uin":            "1000",
		"appId":          "10001",
		"bundleId":       "b1",
		"period":         1,
		"timeUnit":       "m",
		"goodsNum":       1,
		"payMode":        1,
		// Q41 修订 2026-05-11：regionId 不再由 ctl 透传，trade 内部固定 1/100001
	}
	rec := env.doJSON(http.MethodPost, "/internal/trade/orders/place-and-pay", body, true)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d body=%s", rec.Code, rec.Body.String())
	}
	resp := decodeBody(t, rec)
	if resp["dealName"] != "deal-pay-1" {
		t.Errorf("dealName mismatch: %v", resp["dealName"])
	}
	if resp["bigOrderId"] != "big-pay-1" {
		t.Errorf("bigOrderId mismatch: %v", resp["bigOrderId"])
	}
	// 一体化接口不返回 PayURL（与 PlaceOrder 区分的关键行为差异）
	if pu, ok := resp["payUrl"]; ok && pu != "" {
		t.Errorf("payUrl should be empty for place-and-pay, got %v", pu)
	}
	if env.orderWriter.createOrderCalls.Load() != 1 {
		t.Errorf("expected CreateOrder called once, got %d", env.orderWriter.createOrderCalls.Load())
	}
}

func TestPlaceOrderAndPay_InvalidInput(t *testing.T) {
	env := newTestEnv(t)
	body := map[string]any{
		"bundleId": "", // 必填字段缺失
		"period":   1,
		"timeUnit": "m",
	}
	rec := env.doJSON(http.MethodPost, "/internal/trade/orders/place-and-pay", body, true)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", rec.Code)
	}
	resp := decodeBody(t, rec)
	if resp["code"] != "InvalidRequest" {
		t.Errorf("expected code=InvalidRequest, got %v", resp["code"])
	}
}

// TestPlaceOrderAndPay_BundleOffline 验证 bundle 已下架时返 409 Conflict（与 PlaceOrder 一致）。
func TestPlaceOrderAndPay_BundleOffline(t *testing.T) {
	env := newTestEnv(t)
	env.ctl.getBundleByIDFn = func(ctx context.Context, bundleID string) (*ctlclient.BundleDetail, error) {
		return &ctlclient.BundleDetail{BundleID: bundleID, BundleState: "OFFLINE"}, nil
	}
	body := map[string]any{
		"externalUserId": "u1",
		"uin":            "1000",
		"bundleId":       "b1",
		"period":         1,
		"timeUnit":       "m",
		"payMode":        1,
	}
	rec := env.doJSON(http.MethodPost, "/internal/trade/orders/place-and-pay", body, true)
	if rec.Code != http.StatusConflict {
		t.Errorf("expected 409, got %d", rec.Code)
	}
}

// TestPlaceOrderAndPay_JifeiInvalidResponse 验证 jifei 返回缺失 BigDealIDs / DealNames 时返 502。
func TestPlaceOrderAndPay_JifeiInvalidResponse(t *testing.T) {
	env := newTestEnv(t)
	env.jifei.generateDealsAndPayFn = func(ctx context.Context, req *jifeiclient.GenerateDealsAndPayRequest) (*jifeiclient.GenerateDealsAndPayResponse, error) {
		return &jifeiclient.GenerateDealsAndPayResponse{}, nil // 空响应
	}
	body := map[string]any{
		"externalUserId": "u1",
		"uin":            "1000",
		"bundleId":       "b1",
		"period":         1,
		"timeUnit":       "m",
		"payMode":        1,
	}
	rec := env.doJSON(http.MethodPost, "/internal/trade/orders/place-and-pay", body, true)
	if rec.Code != http.StatusBadGateway {
		t.Errorf("expected 502, got %d", rec.Code)
	}
}

// TestPlaceOrderAndPay_AuthRequired 验证缺失 Authorization header 时返 401（与 inquiry / placeOrder 一致）。
func TestPlaceOrderAndPay_AuthRequired(t *testing.T) {
	env := newTestEnv(t)
	body := map[string]any{
		"externalUserId": "u1",
		"uin":            "1000",
		"bundleId":       "b1",
	}
	rec := env.doJSON(http.MethodPost, "/internal/trade/orders/place-and-pay", body, false)
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("expected 401, got %d", rec.Code)
	}
}

// ============================================================================
// pay url tests
// ============================================================================

func TestPayURL_HappyPath(t *testing.T) {
	env := newTestEnv(t)
	const realURL = "/v1/r/1450008583/qz_goods_info?transaction_id=E-260522160125881056" +
		"&token_id=E-260522160125881056&pf=midas_group_pay-1000-html5-1000" +
		"&out_trade_no=20260522995022875780461&deploy_env=stable"
	env.orderStore.getOrderByDealNameFn = func(ctx context.Context, dealName string) (*store.TradeOrder, error) {
		return &store.TradeOrder{
			DealName: dealName,
			Uin:      "700000164995",
			AppID:    "251202221",
			PayURL:   realURL,
		}, nil
	}
	rec := env.doJSON(http.MethodPost, "/internal/trade/orders/deal-1/pay-url", nil, true)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d body=%s", rec.Code, rec.Body.String())
	}
	resp := decodeBody(t, rec)
	if resp["payUrl"] != realURL {
		t.Errorf("payUrl mismatch: %v", resp["payUrl"])
	}
	// v1.7.30 命中缓存路径 D3 反解析：tokenId / orderId / midasAppId 从 URL 提取
	if resp["tokenId"] != "E-260522160125881056" {
		t.Errorf("tokenId: %v", resp["tokenId"])
	}
	if resp["orderId"] != "20260522995022875780461" {
		t.Errorf("orderId: %v", resp["orderId"])
	}
	if resp["midasAppId"] != "1450008583" {
		t.Errorf("midasAppId: %v", resp["midasAppId"])
	}
	if resp["uin"] != "700000164995" || resp["appId"] != "251202221" {
		t.Errorf("uin/appId: %v / %v", resp["uin"], resp["appId"])
	}
}

func TestPayURL_PayURLNotCached_CallsJifei(t *testing.T) {
	// 8B-1.6：trade_order 存在但 pay_url 列空时，调 jifei `qcloud.margin.getMidasEarmarking`
	// 拿真实 URL，HTTP 200 并写回 trade_order.pay_url 缓存。
	// v1.7.30：验证协议外字段（tokenId / orderId / midasAppId）从 jifei 顶层透传。
	env := newTestEnv(t)
	env.orderStore.getOrderByDealNameFn = func(ctx context.Context, dealName string) (*store.TradeOrder, error) {
		return &store.TradeOrder{
			DealName: dealName,
			Uin:      "1000123456",
			AppID:    "251202221",
			PayURL:   "",
		}, nil
	}
	tokenID := "E-260522160125881056"
	outTradeNo := "20260522995022875780461"
	env.jifei.getMidasEarmarkingFn = func(ctx context.Context, req *jifeiclient.GetMidasEarmarkingRequest) (*jifeiclient.GetMidasEarmarkingResponse, error) {
		return &jifeiclient.GetMidasEarmarkingResponse{
			URL:        "https://buy.cloud.tencent.com/midas?token=real",
			BillID:     "bill-1",
			AppID:      "1450008583",
			NeedCharge: 1,
			TokenID:    &tokenID,
			OutTradeNo: &outTradeNo,
		}, nil
	}
	rec := env.doJSON(http.MethodPost, "/internal/trade/orders/deal-1/pay-url", nil, true)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d body=%s", rec.Code, rec.Body.String())
	}
	resp := decodeBody(t, rec)
	want := "https://buy.cloud.tencent.com/midas?token=real"
	if resp["payUrl"] != want {
		t.Errorf("payUrl mismatch:\n  got  %v\n  want %s", resp["payUrl"], want)
	}
	if resp["tokenId"] != tokenID {
		t.Errorf("tokenId: %v", resp["tokenId"])
	}
	if resp["orderId"] != outTradeNo {
		t.Errorf("orderId: %v", resp["orderId"])
	}
	if resp["midasAppId"] != "1450008583" {
		t.Errorf("midasAppId: %v", resp["midasAppId"])
	}
	if resp["uin"] != "1000123456" || resp["appId"] != "251202221" {
		t.Errorf("uin/appId: %v / %v", resp["uin"], resp["appId"])
	}
}

// TestPayURL_PayURLNotCached_JifeiOptionalFieldsMissing 验证 D3 兜底：jifei 未返
// 协议外字段时，handler 输出 JSON 中对应 key 缺失（omitempty）。
func TestPayURL_PayURLNotCached_JifeiOptionalFieldsMissing(t *testing.T) {
	env := newTestEnv(t)
	env.orderStore.getOrderByDealNameFn = func(ctx context.Context, dealName string) (*store.TradeOrder, error) {
		return &store.TradeOrder{
			DealName: dealName,
			Uin:      "1000123456",
			AppID:    "251202221",
			PayURL:   "",
		}, nil
	}
	env.jifei.getMidasEarmarkingFn = func(ctx context.Context, req *jifeiclient.GetMidasEarmarkingRequest) (*jifeiclient.GetMidasEarmarkingResponse, error) {
		// 仅返 PDF 协议规定的 4 个字段
		return &jifeiclient.GetMidasEarmarkingResponse{
			URL:        "https://buy.cloud.tencent.com/midas/minimal",
			BillID:     "bill-1",
			AppID:      "1450008583",
			NeedCharge: 0,
		}, nil
	}
	rec := env.doJSON(http.MethodPost, "/internal/trade/orders/deal-1/pay-url", nil, true)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d body=%s", rec.Code, rec.Body.String())
	}
	resp := decodeBody(t, rec)
	// omitempty 下缺失的指针字段不应出现在 JSON
	if _, ok := resp["tokenId"]; ok {
		t.Errorf("tokenId should be omitted when jifei not returned, got %v", resp["tokenId"])
	}
	if _, ok := resp["orderId"]; ok {
		t.Errorf("orderId should be omitted when jifei not returned, got %v", resp["orderId"])
	}
	// midasAppId 是协议必返字段，jifei 返了非空串 → 需出现
	if resp["midasAppId"] != "1450008583" {
		t.Errorf("midasAppId: %v", resp["midasAppId"])
	}
}

func TestPayURL_OrderNotFound(t *testing.T) {
	env := newTestEnv(t)
	// fakeOrderStore 默认返 ErrTradeOrderNotFound
	rec := env.doJSON(http.MethodPost, "/internal/trade/orders/missing-deal/pay-url", nil, true)
	if rec.Code != http.StatusBadGateway {
		t.Errorf("expected 502, got %d", rec.Code)
	}
}

// ============================================================================
// install nil deps panic
// ============================================================================

func TestInstall_PanicsOnNilDeps(t *testing.T) {
	cases := []struct {
		name string
		mut  func(d *Deps)
	}{
		{"Inquiry nil", func(d *Deps) { d.Inquiry = nil }},
		{"PlaceOrder nil", func(d *Deps) { d.PlaceOrder = nil }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			defer func() {
				if r := recover(); r == nil {
					t.Fatal("expected panic")
				}
			}()
			r := gin.New()
			inq := inquiry.New(inquiry.Deps{
				CTLClient:   &fakeCTL{},
				BundleStore: &fakeBundleStore{},
				JifeiClient: &fakeJifei{},
			})
			po := placeorder.New(placeorder.Deps{
				CTLClient:   &fakeCTL{},
				BundleStore: &fakeBundleStore{},
				JifeiClient: &fakeJifei{},
				OrderWriter: &fakeOrderWriter{},
				OrderStore:  &fakeOrderStore{},
			})
			d := Deps{
				InternalServiceToken: "tok",
				Inquiry:              inq,
				PlaceOrder:           po,
			}
			tc.mut(&d)
			Install(r, d)
		})
	}
}

// ============================================================================
// place renew order tests (R-C-7)
//
// 设计稿引用（.tmp/trade-pass-renew-design.md §3.5 / §4.3 + R-C 切片 R-C-7）：
//   - 端点：POST /internal/trade/orders/renew
//   - 入参：placeRenewOrderRequest（9 字段含 ResourceID / BundleID 必填）
//   - 出参：placeOrderResponse（dealName / bigOrderId；PayURL/ExpireAt 留空走两步流程）
//   - 错误码：与 PlaceOrder 共用 classifyPlaceOrderError（同 sentinel 错误集）
//   - 关键差异断言：fakeOrderWriter.lastCreateOrderInput.OrderType=='renew'
//                   + ResourceID==req.ResourceID（PlaceOrder INSERT 时直接写入，不走反向回填）
// ============================================================================

// renewBundleDef 是续费场景下扩展的 BundleDefinition：CategoryIDs 同时含 purchase + renew
// 两个 scene（续费链路取 scene='renew' 的 categoryId）。
func renewBundleDef(bundleID string) *store.BundleDefinition {
	return &store.BundleDefinition{
		BundleID:       bundleID,
		ProductCode:    "p_lighthouse",
		SubProductCode: "sp_test",
		Pid:            1234,
		CategoryIDs: []store.CategoryIDEntry{
			{Scene: "purchase", Category: 100059},
			{Scene: "renew", Category: 100060},
		},
		SVList: map[string]int64{"sv_cpu": 2},
	}
}

// stubRenewBundleDefStore 让测试 env 的 fakeBundleStore 返回含 scene=renew 的定义。
func stubRenewBundleDefStore(env *testEnv) {
	env.bundle.getBundleDefinitionByIDFn = func(_ context.Context, bundleID string) (*store.BundleDefinition, error) {
		return renewBundleDef(bundleID), nil
	}
}

// renewBody 构造合法的续费下单 JSON body。
func renewBody() map[string]any {
	return map[string]any{
		"externalUserId": "user-1",
		"uin":            "1000123456",
		"appId":          "10001",
		"bundleId":       "bundle_linux_small",
		"resourceId":     "lhpass-r1",
		"curDeadline":    "2026-06-15 10:30:00", // PDF §4.3 续费必填; v1.7.20 B15
		"period":         1,
		"timeUnit":       "m",
		"goodsNum":       1,
		"payMode":        1,
	}
}

func moveInBody() map[string]any {
	return map[string]any{
		"externalUserId": "usr_migrate",
		"uin":            "700000164995",
		"appId":          "251202221",
		"bundleId":       "bundle_launch_01",
		"resourceId":     "pass-free-1",
		"curDeadline":    "2026-07-20 12:00:00",
	}
}

func TestMoveInOrder_InvalidInput(t *testing.T) {
	cases := []struct {
		name string
		mut  func(b map[string]any)
	}{
		{"missing resource_id", func(b map[string]any) { delete(b, "resourceId") }},
		{"missing cur_deadline", func(b map[string]any) { delete(b, "curDeadline") }},
		{"bad cur_deadline", func(b map[string]any) { b["curDeadline"] = "2026-07-20T12:00:00Z" }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			env := newTestEnv(t)
			body := moveInBody()
			tc.mut(body)
			rec := env.doJSON(http.MethodPost, "/internal/trade/orders/move-in", body, true)
			if rec.Code != http.StatusBadRequest {
				t.Errorf("expected 400, got %d body=%s", rec.Code, rec.Body.String())
			}
			resp := decodeBody(t, rec)
			if resp["code"] != "InvalidRequest" {
				t.Errorf("expected code=InvalidRequest, got %v", resp["code"])
			}
		})
	}
}

// TestPlaceRenewOrder_HappyPath 验证续费下单 happy path：
//   - HTTP 200 + dealName/bigOrderId 正确返回
//   - fakeOrderWriter.CreateOrder 被调用一次，且收到 OrderType='renew' + ResourceID 等于入参
//   - PayURL/ExpireAt 留空（走两步流程）
func TestPlaceRenewOrder_HappyPath(t *testing.T) {
	env := newTestEnv(t)
	stubRenewBundleDefStore(env)

	rec := env.doJSON(http.MethodPost, "/internal/trade/orders/renew", renewBody(), true)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d body=%s", rec.Code, rec.Body.String())
	}
	resp := decodeBody(t, rec)
	if resp["dealName"] != "deal-1" {
		t.Errorf("dealName mismatch: %v", resp["dealName"])
	}
	if resp["bigOrderId"] != "big-1" {
		t.Errorf("bigOrderId mismatch: %v", resp["bigOrderId"])
	}
	// PayURL/ExpireAt 留空（走两步流程，与 PlaceOrder 一致；与 PlaceOrderAndPay 区分）
	if pu, ok := resp["payUrl"]; ok && pu != "" {
		t.Errorf("payUrl should be empty for two-step renew, got %v", pu)
	}

	// R-C-7 关键不变量：trade_order INSERT 时 OrderType='renew' + ResourceID 直接写入
	if env.orderWriter.createOrderCalls.Load() != 1 {
		t.Errorf("expected CreateOrder called once, got %d", env.orderWriter.createOrderCalls.Load())
	}
	got := env.orderWriter.lastCreateOrderInput
	if got.OrderType != store.OrderTypeRenew {
		t.Errorf("OrderType mismatch: got=%q want=%q", got.OrderType, store.OrderTypeRenew)
	}
	if got.ResourceID != "lhpass-r1" {
		t.Errorf("ResourceID mismatch: got=%q want=%q", got.ResourceID, "lhpass-r1")
	}
}

// TestPlaceRenewOrder_InvalidInput 验证缺少必填字段 → 400 InvalidRequest。
//   - 缺 ResourceID（续费独有必填，与 PlaceOrder 区分）
//   - 缺 BundleID
func TestPlaceRenewOrder_InvalidInput(t *testing.T) {
	cases := []struct {
		name string
		mut  func(b map[string]any)
	}{
		{"missing resource_id", func(b map[string]any) { delete(b, "resourceId") }},
		{"missing bundle_id", func(b map[string]any) { delete(b, "bundleId") }},
		{"missing cur_deadline", func(b map[string]any) { delete(b, "curDeadline") }}, // v1.7.20 B15
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			env := newTestEnv(t)
			stubRenewBundleDefStore(env)
			body := renewBody()
			tc.mut(body)
			rec := env.doJSON(http.MethodPost, "/internal/trade/orders/renew", body, true)
			if rec.Code != http.StatusBadRequest {
				t.Errorf("expected 400, got %d body=%s", rec.Code, rec.Body.String())
			}
			resp := decodeBody(t, rec)
			if resp["code"] != "InvalidRequest" {
				t.Errorf("expected code=InvalidRequest, got %v", resp["code"])
			}
		})
	}
}

// TestPlaceRenewOrder_BundleNotFound 验证 bundle 已不存在 → 404 BundleNotFound。
func TestPlaceRenewOrder_BundleNotFound(t *testing.T) {
	env := newTestEnv(t)
	stubRenewBundleDefStore(env)
	env.ctl.getBundleByIDFn = func(_ context.Context, _ string) (*ctlclient.BundleDetail, error) {
		return nil, ctlclient.ErrNotFound
	}
	rec := env.doJSON(http.MethodPost, "/internal/trade/orders/renew", renewBody(), true)
	if rec.Code != http.StatusNotFound {
		t.Errorf("expected 404, got %d body=%s", rec.Code, rec.Body.String())
	}
	resp := decodeBody(t, rec)
	if resp["code"] != "BundleNotFound" {
		t.Errorf("expected code=BundleNotFound, got %v", resp["code"])
	}
	// 不应触发 jifei 写端
	if env.orderWriter.createOrderCalls.Load() != 0 {
		t.Errorf("CreateOrder should NOT be called when bundle not found")
	}
}

// TestPlaceRenewOrder_BundleOffline 验证 bundle 已下架 → 409 BundleOffline。
func TestPlaceRenewOrder_BundleOffline(t *testing.T) {
	env := newTestEnv(t)
	stubRenewBundleDefStore(env)
	env.ctl.getBundleByIDFn = func(_ context.Context, bundleID string) (*ctlclient.BundleDetail, error) {
		return &ctlclient.BundleDetail{BundleID: bundleID, BundleState: "OFFLINE"}, nil
	}
	rec := env.doJSON(http.MethodPost, "/internal/trade/orders/renew", renewBody(), true)
	if rec.Code != http.StatusConflict {
		t.Errorf("expected 409, got %d body=%s", rec.Code, rec.Body.String())
	}
	resp := decodeBody(t, rec)
	if resp["code"] != "BundleOffline" {
		t.Errorf("expected code=BundleOffline, got %v", resp["code"])
	}
}

// TestPlaceRenewOrder_JifeiInvalidResponse 验证 jifei generateDeals 返空 →
// 502 UpstreamInvalidResponse（与 PlaceOrder 一致行为，错误集复用）。
func TestPlaceRenewOrder_JifeiInvalidResponse(t *testing.T) {
	env := newTestEnv(t)
	stubRenewBundleDefStore(env)
	env.jifei.generateDealsFn = func(_ context.Context, _ *jifeiclient.GenerateDealsRequest) (*jifeiclient.GenerateDealsResponse, error) {
		return &jifeiclient.GenerateDealsResponse{}, nil // 空 BigDealID / DealNames
	}
	rec := env.doJSON(http.MethodPost, "/internal/trade/orders/renew", renewBody(), true)
	if rec.Code != http.StatusBadGateway {
		t.Errorf("expected 502, got %d body=%s", rec.Code, rec.Body.String())
	}
	resp := decodeBody(t, rec)
	if resp["code"] != "UpstreamInvalidResponse" {
		t.Errorf("expected code=UpstreamInvalidResponse, got %v", resp["code"])
	}
}

// TestPlaceRenewOrder_AuthRequired 验证缺失 Authorization header → 401（与其他端点一致）。
func TestPlaceRenewOrder_AuthRequired(t *testing.T) {
	env := newTestEnv(t)
	stubRenewBundleDefStore(env)
	rec := env.doJSON(http.MethodPost, "/internal/trade/orders/renew", renewBody(), false)
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("expected 401, got %d", rec.Code)
	}
}

// TestPlaceRenewOrder_MalformedJSON 验证非法 JSON → 400 InvalidRequest。
func TestPlaceRenewOrder_MalformedJSON(t *testing.T) {
	env := newTestEnv(t)
	req := httptest.NewRequest(http.MethodPost, "/internal/trade/orders/renew",
		bytes.NewBufferString(`{not json`))
	req.Header.Set("Authorization", "Bearer "+env.token)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	env.router.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", rec.Code)
	}
}

// ============================================================================
// place renew order and pay tests (R-D-7)
//
// 设计稿引用（.tmp/trade-pass-renew-design.md §3.3 / §4.4 + R-D 切片 R-D-7）：
//   - 端点：POST /internal/trade/orders/renew/place-and-pay
//   - 入参：placeRenewOrderRequest 复用（与 R-C-7 同 schema：9 字段含 ResourceID 必填）
//   - 出参：placeOrderResponse（dealName/bigOrderId；PayURL/ExpireAt 永远为空 — 一体化跳过支付 URL）
//   - 错误集：与 PlaceOrder/PlaceRenewOrder 共用 classifyPlaceOrderError
// ============================================================================

// TestPlaceRenewOrderAndPay_HappyPath 验证续费一体化端点 happy path：
//   - HTTP 200 + dealName/bigOrderId 正确返回
//   - fakeOrderWriter.CreateOrder 被调用一次，且收到 OrderType='renew' + ResourceID + Status='provisioned'
//     （v1.7.28 BUG-26 修订 2026-05-21：与 PlaceOrderAndPay BUG-23 同范式，state="0" 同步发货成功
//     时直接落完成态，不再走 paid_pending_provision 中间态；fakeJifei.GenerateDealsAndPay 默认
//     mock 已带 dealDeliverResults state="0"）
//   - PayURL/ExpireAt 永远为空（一体化区分两步式）
func TestPlaceRenewOrderAndPay_HappyPath(t *testing.T) {
	env := newTestEnv(t)
	stubRenewBundleDefStore(env)

	rec := env.doJSON(http.MethodPost, "/internal/trade/orders/renew/place-and-pay", renewBody(), true)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d body=%s", rec.Code, rec.Body.String())
	}
	resp := decodeBody(t, rec)
	if resp["dealName"] != "deal-pay-1" {
		t.Errorf("dealName mismatch: %v", resp["dealName"])
	}
	if resp["bigOrderId"] != "big-pay-1" {
		t.Errorf("bigOrderId mismatch: %v", resp["bigOrderId"])
	}
	// 一体化接口永远不返 PayURL（与 PlaceOrderAndPay 一致）
	if pu, ok := resp["payUrl"]; ok && pu != "" {
		t.Errorf("payUrl should be empty for renew-and-pay, got %v", pu)
	}

	// R-D-7 + BUG-26 修订关键不变量：trade_order INSERT 时 OrderType='renew' + ResourceID 直接写入
	// + Status='provisioned'（state=0 落完成态，与 PlaceOrderAndPay 同范式）
	if env.orderWriter.createOrderCalls.Load() != 1 {
		t.Errorf("expected CreateOrder called once, got %d", env.orderWriter.createOrderCalls.Load())
	}
	got := env.orderWriter.lastCreateOrderInput
	if got.OrderType != store.OrderTypeRenew {
		t.Errorf("OrderType mismatch: got=%q want=%q", got.OrderType, store.OrderTypeRenew)
	}
	if got.ResourceID != "lhpass-r1" {
		t.Errorf("ResourceID mismatch: got=%q want=%q", got.ResourceID, "lhpass-r1")
	}
	if got.Status != "provisioned" {
		t.Errorf("Status mismatch: got=%q want=provisioned (BUG-26: state=0 落完成态)", got.Status)
	}
}

// TestPlaceRenewOrderAndPay_InvalidInput 验证缺 ResourceID → 400 InvalidRequest（续费独有）。
func TestPlaceRenewOrderAndPay_InvalidInput(t *testing.T) {
	env := newTestEnv(t)
	stubRenewBundleDefStore(env)
	body := renewBody()
	delete(body, "resourceId")
	rec := env.doJSON(http.MethodPost, "/internal/trade/orders/renew/place-and-pay", body, true)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d body=%s", rec.Code, rec.Body.String())
	}
	resp := decodeBody(t, rec)
	if resp["code"] != "InvalidRequest" {
		t.Errorf("expected code=InvalidRequest, got %v", resp["code"])
	}
}

// TestPlaceRenewOrderAndPay_BundleOffline 验证 bundle 已下架 → 409 BundleOffline。
func TestPlaceRenewOrderAndPay_BundleOffline(t *testing.T) {
	env := newTestEnv(t)
	stubRenewBundleDefStore(env)
	env.ctl.getBundleByIDFn = func(_ context.Context, bundleID string) (*ctlclient.BundleDetail, error) {
		return &ctlclient.BundleDetail{BundleID: bundleID, BundleState: "OFFLINE"}, nil
	}
	rec := env.doJSON(http.MethodPost, "/internal/trade/orders/renew/place-and-pay", renewBody(), true)
	if rec.Code != http.StatusConflict {
		t.Errorf("expected 409, got %d body=%s", rec.Code, rec.Body.String())
	}
	resp := decodeBody(t, rec)
	if resp["code"] != "BundleOffline" {
		t.Errorf("expected code=BundleOffline, got %v", resp["code"])
	}
}

// TestPlaceRenewOrderAndPay_AuthRequired 验证缺 Authorization header → 401。
func TestPlaceRenewOrderAndPay_AuthRequired(t *testing.T) {
	env := newTestEnv(t)
	stubRenewBundleDefStore(env)
	rec := env.doJSON(http.MethodPost, "/internal/trade/orders/renew/place-and-pay", renewBody(), false)
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("expected 401, got %d", rec.Code)
	}
}

// ============================================================================
// delete resource tests (D-2.2 销毁链路用户主动入口)
//
// 设计稿：.tmp/trade-pass-destroy-design.md §3.5 + §11-A Q2/Q20/Q26
// ============================================================================

// deleteResourceBody 是 deleteResource 端点的标准入参。
//
// Q27 修订（2026-05-17）：subProductCode 不再由 ctl 透传，trade 反查 BundleDefinition 取值。
func deleteResourceBody() map[string]any {
	return map[string]any{
		"uin":      "100012345678",
		"appId":    1300012345,
		"bundleId": "bundle-test-1",
	}
}

// TestDeleteResource_HappyPath 验证：BundleStore 命中 + jifei 同步成功 →
// 200 + referenceId 透传 + jifei 入参完整。
func TestDeleteResource_HappyPath(t *testing.T) {
	env := newTestEnv(t)

	// 注入 BundleDefinition：ProductCode = "p_lighthouse" 触发 Q26 运行时反查路径；
	// SubProductCode = "sp_test" 触发 Q27 运行时反查路径（不再由 ctl 透传）。
	env.bundle.getBundleDefinitionByIDFn = func(_ context.Context, bundleID string) (*store.BundleDefinition, error) {
		return &store.BundleDefinition{
			BundleID:       bundleID,
			ProductCode:    "p_lighthouse",
			SubProductCode: "sp_test",
		}, nil
	}

	var seenReq *jifeiclient.ModifyResourceStatusRequest
	env.jifei.modifyResourceStatusFn = func(_ context.Context, req *jifeiclient.ModifyResourceStatusRequest) (*jifeiclient.ModifyResourceStatusResponse, error) {
		seenReq = req
		return &jifeiclient.ModifyResourceStatusResponse{
			OperationSet: []jifeiclient.ModifyResourceStatusOperation{{Status: 0}},
		}, nil
	}

	rec := env.doJSON(http.MethodPost,
		"/internal/trade/resources/lhins-bj-7-test-001/delete",
		deleteResourceBody(), true)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d body=%s", rec.Code, rec.Body.String())
	}
	resp := decodeBody(t, rec)
	refID, _ := resp["referenceId"].(string)
	if refID == "" {
		t.Errorf("referenceId missing, body=%s", rec.Body.String())
	}
	// Q20 ✅ 方案 C：referenceId = `<resourceID>_<UnixNano>`
	if !strings.HasPrefix(refID, "lhins-bj-7-test-001_") {
		t.Errorf("referenceId should start with resourceID_; got %q", refID)
	}

	// 验证 jifei 入参拼装（设计稿 §3.5 + PDF §1.1）。
	if seenReq == nil {
		t.Fatal("ModifyResourceStatus not called")
	}
	if seenReq.ClientType != jifeiclient.ClientTypeProduct {
		t.Errorf("clientType: got %d want %d", seenReq.ClientType, jifeiclient.ClientTypeProduct)
	}
	if seenReq.SubmitByUser != jifeiclient.SubmitByUserYes {
		t.Errorf("submitByUser: got %d want %d", seenReq.SubmitByUser, jifeiclient.SubmitByUserYes)
	}
	if seenReq.ReferenceID != refID {
		t.Errorf("referenceID mismatch: handler returned %q jifei got %q", refID, seenReq.ReferenceID)
	}
	if seenReq.ProductCode != "p_lighthouse" {
		t.Errorf("productCode: got %q want p_lighthouse", seenReq.ProductCode)
	}
	if seenReq.UIN != "100012345678" {
		t.Errorf("uin: got %q", seenReq.UIN)
	}
	if seenReq.AppID != 1300012345 {
		t.Errorf("appId: got %d", seenReq.AppID)
	}
	if seenReq.RegionID != 1 {
		// Q41 修订：trade 内部固定 region.LighthouseRegionID = 1（广州）
		t.Errorf("regionId: got %d want 1", seenReq.RegionID)
	}
	if seenReq.PayMode != jifeiclient.PayModePrepaid {
		t.Errorf("payMode: got %d want %d", seenReq.PayMode, jifeiclient.PayModePrepaid)
	}
	if seenReq.OperateName != jifeiclient.OperateNamePreDestroy {
		t.Errorf("operateName: got %q want %q", seenReq.OperateName, jifeiclient.OperateNamePreDestroy)
	}
	if len(seenReq.ResourcesParamSet) != 1 {
		t.Fatalf("ResourcesParamSet len: got %d want 1", len(seenReq.ResourcesParamSet))
	}
	item := seenReq.ResourcesParamSet[0]
	// Q27 ✅：SubProductCode 来自 BundleDefinition 反查（与 ProductCode 同源），不来自 ctl 透传。
	if item.SubProductCode != "sp_test" {
		t.Errorf("subProductCode: got %q want sp_test (from BundleDefinition)", item.SubProductCode)
	}
	if len(item.ResourceIDs) != 1 || item.ResourceIDs[0] != "lhins-bj-7-test-001" {
		t.Errorf("resourceIds mismatch: got %v", item.ResourceIDs)
	}
}

// TestDeleteResource_AuthRequired 验证缺 Authorization header → 401。
func TestDeleteResource_AuthRequired(t *testing.T) {
	env := newTestEnv(t)
	rec := env.doJSON(http.MethodPost,
		"/internal/trade/resources/lhins-x/delete",
		deleteResourceBody(), false)
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("expected 401, got %d", rec.Code)
	}
}

// TestDeleteResource_BundleNotFound 验证 BundleStore 返 ErrBundleDefinitionNotFound →
// 404 BundleDefinitionNotFound + 不调 jifei。
func TestDeleteResource_BundleNotFound(t *testing.T) {
	env := newTestEnv(t)
	env.bundle.getBundleDefinitionByIDFn = func(_ context.Context, _ string) (*store.BundleDefinition, error) {
		return nil, store.ErrBundleDefinitionNotFound
	}
	jifeiCalled := false
	env.jifei.modifyResourceStatusFn = func(_ context.Context, _ *jifeiclient.ModifyResourceStatusRequest) (*jifeiclient.ModifyResourceStatusResponse, error) {
		jifeiCalled = true
		return nil, nil
	}

	rec := env.doJSON(http.MethodPost,
		"/internal/trade/resources/lhins-x/delete",
		deleteResourceBody(), true)
	if rec.Code != http.StatusNotFound {
		t.Errorf("expected 404, got %d body=%s", rec.Code, rec.Body.String())
	}
	resp := decodeBody(t, rec)
	if resp["code"] != "BundleDefinitionNotFound" {
		t.Errorf("expected code=BundleDefinitionNotFound, got %v", resp["code"])
	}
	if jifeiCalled {
		t.Error("jifei should not be called when BundleStore returns NotFound")
	}
}

// TestDeleteResource_BundleStoreInternalError 验证 BundleStore 返非 NotFound 错 → 500 InternalError。
func TestDeleteResource_BundleStoreInternalError(t *testing.T) {
	env := newTestEnv(t)
	env.bundle.getBundleDefinitionByIDFn = func(_ context.Context, _ string) (*store.BundleDefinition, error) {
		return nil, errors.New("db connection lost")
	}
	rec := env.doJSON(http.MethodPost,
		"/internal/trade/resources/lhins-x/delete",
		deleteResourceBody(), true)
	if rec.Code != http.StatusInternalServerError {
		t.Errorf("expected 500, got %d body=%s", rec.Code, rec.Body.String())
	}
	resp := decodeBody(t, rec)
	if resp["code"] != "InternalError" {
		t.Errorf("expected code=InternalError, got %v", resp["code"])
	}
}

// TestDeleteResource_JifeiBusinessError 验证 jifei 业务错（returnCode != 0）→
// 502 UpstreamBusinessError + referenceId 透传。
func TestDeleteResource_JifeiBusinessError(t *testing.T) {
	env := newTestEnv(t)
	env.jifei.modifyResourceStatusFn = func(_ context.Context, _ *jifeiclient.ModifyResourceStatusRequest) (*jifeiclient.ModifyResourceStatusResponse, error) {
		return nil, &jifeiclient.CGWError{
			ReturnCode:    100151,
			ReturnMessage: "resource is locked",
			InterfaceName: jifeiclient.InterfaceNameModifyResourceStatus,
		}
	}
	rec := env.doJSON(http.MethodPost,
		"/internal/trade/resources/lhins-x/delete",
		deleteResourceBody(), true)
	if rec.Code != http.StatusBadGateway {
		t.Errorf("expected 502, got %d body=%s", rec.Code, rec.Body.String())
	}
	resp := decodeBody(t, rec)
	if resp["code"] != "UpstreamBusinessError" {
		t.Errorf("expected code=UpstreamBusinessError, got %v", resp["code"])
	}
	if _, ok := resp["referenceId"].(string); !ok {
		t.Error("referenceId should be present in error response for audit")
	}
}

// TestDeleteResource_JifeiHTTPError 验证 jifei HTTP 非 2xx → 502 UpstreamHTTPError。
func TestDeleteResource_JifeiHTTPError(t *testing.T) {
	env := newTestEnv(t)
	env.jifei.modifyResourceStatusFn = func(_ context.Context, _ *jifeiclient.ModifyResourceStatusRequest) (*jifeiclient.ModifyResourceStatusResponse, error) {
		return nil, jifeiclient.ErrCGWHTTPNon200
	}
	rec := env.doJSON(http.MethodPost,
		"/internal/trade/resources/lhins-x/delete",
		deleteResourceBody(), true)
	if rec.Code != http.StatusBadGateway {
		t.Errorf("expected 502, got %d body=%s", rec.Code, rec.Body.String())
	}
	resp := decodeBody(t, rec)
	if resp["code"] != "UpstreamHTTPError" {
		t.Errorf("expected code=UpstreamHTTPError, got %v", resp["code"])
	}
}

// TestDeleteResource_RequiredFieldChecks 验证必填字段表驱动校验：
// 缺 uin / appId<=0 / 缺 bundleId 全报 400 InvalidRequest。
//
// Q27 修订（2026-05-17）：subProductCode 不再入参（trade 反查 BundleDefinition 取值），
// 因此不再校验 missing_subProductCode 分支。
func TestDeleteResource_RequiredFieldChecks(t *testing.T) {
	cases := []struct {
		name    string
		mutator func(map[string]any)
	}{
		{name: "missing_uin", mutator: func(b map[string]any) { delete(b, "uin") }},
		{name: "empty_uin", mutator: func(b map[string]any) { b["uin"] = "  " }},
		{name: "zero_appId", mutator: func(b map[string]any) { b["appId"] = 0 }},
		{name: "negative_appId", mutator: func(b map[string]any) { b["appId"] = -1 }},
		{name: "missing_bundleId", mutator: func(b map[string]any) { delete(b, "bundleId") }},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			env := newTestEnv(t)
			body := deleteResourceBody()
			tc.mutator(body)
			rec := env.doJSON(http.MethodPost,
				"/internal/trade/resources/lhins-x/delete",
				body, true)
			if rec.Code != http.StatusBadRequest {
				t.Errorf("expected 400, got %d body=%s", rec.Code, rec.Body.String())
			}
			resp := decodeBody(t, rec)
			if resp["code"] != "InvalidRequest" {
				t.Errorf("expected code=InvalidRequest, got %v", resp["code"])
			}
		})
	}
}

// TestDeleteResource_DepsNilDoesNotMount 验证 BundleStore / JifeiClient 任一 nil 时
// /internal/trade/resources/:resourceID/delete 路由不挂载（向后兼容）。
func TestDeleteResource_DepsNilDoesNotMount(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	bundle := &fakeBundleStore{}
	jifei := &fakeJifei{}
	inq := inquiry.New(inquiry.Deps{
		CTLClient:   &fakeCTL{},
		BundleStore: bundle,
		JifeiClient: jifei,
	})
	po := placeorder.New(placeorder.Deps{
		CTLClient:   &fakeCTL{},
		BundleStore: bundle,
		JifeiClient: jifei,
		OrderWriter: &fakeOrderWriter{},
		OrderStore:  &fakeOrderStore{},
	})
	// 故意只传 Inquiry / PlaceOrder，不传 BundleStore / JifeiClient（旧 8A 调用方场景）。
	Install(r, Deps{
		InternalServiceToken: "test-token",
		Inquiry:              inq,
		PlaceOrder:           po,
	})

	req := httptest.NewRequest(http.MethodPost,
		"/internal/trade/resources/x/delete",
		bytes.NewBufferString(`{}`))
	req.Header.Set("Authorization", "Bearer test-token")
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	// 路由未挂载 → gin 默认 404
	if rec.Code != http.StatusNotFound {
		t.Errorf("expected 404 (route not mounted), got %d body=%s", rec.Code, rec.Body.String())
	}
}
