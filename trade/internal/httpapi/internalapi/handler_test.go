package internalapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
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

type fakeBundleStore struct{}

func (fakeBundleStore) GetBundleDefinitionByID(ctx context.Context, bundleID string) (*store.BundleDefinition, error) {
	return &store.BundleDefinition{
		BundleID:       bundleID,
		ProductCode:    "p_lighthouse",
		SubProductCode: "sp_test",
		Pid:            "1234",
		CategoryIDs: []store.CategoryIDEntry{
			{Scene: "purchase", Category: "100059"},
		},
		SVList: map[string]interface{}{"cpu": "2"},
	}, nil
}

type fakeJifei struct {
	getPriceFn      func(ctx context.Context, req *jifeiclient.GetPriceRequest) (*jifeiclient.GetPriceResponse, error)
	generateDealsFn func(ctx context.Context, req *jifeiclient.GenerateDealsRequest) (*jifeiclient.GenerateDealsResponse, error)
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

type fakeOrderWriter struct {
	createOrderFn    func(ctx context.Context, in store.CreateOrderInput) error
	createOrderCalls atomic.Int32
}

func (f *fakeOrderWriter) CreateOrder(ctx context.Context, in store.CreateOrderInput) error {
	f.createOrderCalls.Add(1)
	if f.createOrderFn != nil {
		return f.createOrderFn(ctx, in)
	}
	return nil
}
func (f *fakeOrderWriter) MarkOrderProvisioned(ctx context.Context, dealName, resourceID string) error {
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
	token       string
}

func newTestEnv(t *testing.T) *testEnv {
	t.Helper()
	ctl := &fakeCTL{}
	jifei := &fakeJifei{}
	orderWriter := &fakeOrderWriter{}
	orderStore := &fakeOrderStore{}

	inq := inquiry.New(inquiry.Deps{
		CTLClient:   ctl,
		BundleStore: fakeBundleStore{},
		JifeiClient: jifei,
	})
	po := placeorder.New(placeorder.Deps{
		CTLClient:   ctl,
		BundleStore: fakeBundleStore{},
		JifeiClient: jifei,
		OrderWriter: orderWriter,
		OrderStore:  orderStore,
	})

	r := gin.New()
	Install(r, Deps{
		InternalServiceToken: "test-token",
		Inquiry:              inq,
		PlaceOrder:           po,
	})

	return &testEnv{
		router:      r,
		ctl:         ctl,
		jifei:       jifei,
		orderWriter: orderWriter,
		orderStore:  orderStore,
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
		BundleStore: fakeBundleStore{},
		JifeiClient: &fakeJifei{},
	})
	po := placeorder.New(placeorder.Deps{
		CTLClient:   &fakeCTL{},
		BundleStore: fakeBundleStore{},
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
		"regionId":       1,
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
// pay url tests
// ============================================================================

func TestPayURL_HappyPath(t *testing.T) {
	env := newTestEnv(t)
	env.orderStore.getOrderByDealNameFn = func(ctx context.Context, dealName string) (*store.TradeOrder, error) {
		return &store.TradeOrder{DealName: dealName, PayURL: "https://buy.cloud.tencent.com/abc"}, nil
	}
	rec := env.doJSON(http.MethodPost, "/internal/trade/orders/deal-1/pay-url", nil, true)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d body=%s", rec.Code, rec.Body.String())
	}
	resp := decodeBody(t, rec)
	if resp["payUrl"] != "https://buy.cloud.tencent.com/abc" {
		t.Errorf("payUrl mismatch: %v", resp["payUrl"])
	}
}

func TestPayURL_NotAvailable(t *testing.T) {
	env := newTestEnv(t)
	env.orderStore.getOrderByDealNameFn = func(ctx context.Context, dealName string) (*store.TradeOrder, error) {
		return &store.TradeOrder{DealName: dealName, PayURL: ""}, nil
	}
	rec := env.doJSON(http.MethodPost, "/internal/trade/orders/deal-1/pay-url", nil, true)
	if rec.Code != http.StatusServiceUnavailable {
		t.Errorf("expected 503, got %d", rec.Code)
	}
	resp := decodeBody(t, rec)
	if resp["code"] != "PayURLNotAvailable" {
		t.Errorf("expected code=PayURLNotAvailable, got %v", resp["code"])
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
				BundleStore: fakeBundleStore{},
				JifeiClient: &fakeJifei{},
			})
			po := placeorder.New(placeorder.Deps{
				CTLClient:   &fakeCTL{},
				BundleStore: fakeBundleStore{},
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
