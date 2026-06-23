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
	"time"

	"github.com/gin-gonic/gin"

	"git.woa.com/wisp/mono/trade/internal/jifeiclient"
	"git.woa.com/wisp/mono/trade/internal/logic/inquiry"
	"git.woa.com/wisp/mono/trade/internal/logic/orderstatus"
	"git.woa.com/wisp/mono/trade/internal/logic/placeorder"
	"git.woa.com/wisp/mono/trade/internal/store"
)

// ============================================================================
// 独立 testEnv (与 handler_test.go::testEnv 解耦，避免影响既有测试)
// ============================================================================

// orderStatusTestEnv 是 query-status handler 测试专用的 testEnv：
//   - 装配 orderstatus.Service 进 internalapi.Install
//   - 提供 fake OrderStore / OrderWriter / Jifei 钩子让测试编排各种场景
type orderStatusTestEnv struct {
	router *gin.Engine
	store  *fakeOrderStoreOSP
	writer *fakeOrderWriterOSP
	jifei  *fakeJifeiOSP
	token  string
}

// fakeOrderStoreOSP / fakeOrderWriterOSP / fakeJifeiOSP 是本文件专用替身，
// 命名加 OSP（OrderStatusPath）后缀避免与同包其他 fake 冲突。
type fakeOrderStoreOSP struct {
	getOrderFn func(ctx context.Context, dealName string) (*store.TradeOrder, error)
	getCalls   atomic.Int32
}

func (f *fakeOrderStoreOSP) GetOrderByDealName(ctx context.Context, dealName string) (*store.TradeOrder, error) {
	f.getCalls.Add(1)
	if f.getOrderFn != nil {
		return f.getOrderFn(ctx, dealName)
	}
	return nil, store.ErrTradeOrderNotFound
}

type fakeOrderWriterOSP struct {
	markCancelledFn    func(ctx context.Context, dealName string) error
	markCancelledCalls atomic.Int32
}

func (f *fakeOrderWriterOSP) CreateOrder(_ context.Context, _ store.CreateOrderInput) error {
	return nil
}

func (f *fakeOrderWriterOSP) MarkOrderProvisioned(_ context.Context, _, _ string) error {
	return nil
}

func (f *fakeOrderWriterOSP) UpdatePayURL(_ context.Context, _, _ string) error {
	return nil
}

func (f *fakeOrderWriterOSP) MarkOrderCancelled(ctx context.Context, dealName string) error {
	f.markCancelledCalls.Add(1)
	if f.markCancelledFn != nil {
		return f.markCancelledFn(ctx, dealName)
	}
	return nil
}

type fakeJifeiOSP struct {
	getDealsByKeyIndexFn func(ctx context.Context, req *jifeiclient.GetDealsByKeyIndexRequest) (*jifeiclient.GetDealsByKeyIndexResponse, error)
	calls                atomic.Int32
}

func (f *fakeJifeiOSP) GetPrice(_ context.Context, _ *jifeiclient.GetPriceRequest) (*jifeiclient.GetPriceResponse, error) {
	return nil, errors.New("unused")
}

func (f *fakeJifeiOSP) GenerateDeals(_ context.Context, _ *jifeiclient.GenerateDealsRequest) (*jifeiclient.GenerateDealsResponse, error) {
	return nil, errors.New("unused")
}

func (f *fakeJifeiOSP) GenerateDealsAndPay(_ context.Context, _ *jifeiclient.GenerateDealsAndPayRequest) (*jifeiclient.GenerateDealsAndPayResponse, error) {
	return nil, errors.New("unused")
}

func (f *fakeJifeiOSP) GetMidasEarmarking(_ context.Context, _ *jifeiclient.GetMidasEarmarkingRequest) (*jifeiclient.GetMidasEarmarkingResponse, error) {
	return nil, errors.New("unused")
}

func (f *fakeJifeiOSP) ModifyResourceStatus(_ context.Context, _ *jifeiclient.ModifyResourceStatusRequest) (*jifeiclient.ModifyResourceStatusResponse, error) {
	return nil, errors.New("unused")
}

func (f *fakeJifeiOSP) GetDealsByKeyIndex(ctx context.Context, req *jifeiclient.GetDealsByKeyIndexRequest) (*jifeiclient.GetDealsByKeyIndexResponse, error) {
	f.calls.Add(1)
	if f.getDealsByKeyIndexFn != nil {
		return f.getDealsByKeyIndexFn(ctx, req)
	}
	return nil, errors.New("unused")
}

func (f *fakeJifeiOSP) OnlineRefund(_ context.Context, _ *jifeiclient.OnlineRefundRequest) (*jifeiclient.OnlineRefundResponse, error) {
	return nil, errors.New("unused")
}

// newOrderStatusTestEnv 装配 orderstatus.Service + internalapi.Install 后返回 router。
//
// 与 handler_test.go::newTestEnv 不同的是：
//   - 复用同包已有的 fakeCTL / fakeBundleStore 装配最小 inquiry / placeorder service
//     （为了满足 Install 的 nil 校验）
//   - 真正 wire 起 OrderStatus = orderstatus.New(...)
func newOrderStatusTestEnv(t *testing.T) *orderStatusTestEnv {
	t.Helper()

	// 最小 inquiry / placeorder service 装配（复用同包 fakeCTL / fakeBundleStore / fakeJifei 、在 handler_test.go 已定义）。
	// 本测试不会走它们的路由，仅为了让 Install 通过 nil 校验。
	placeholderJifei := &fakeJifei{}
	inq := inquiry.New(inquiry.Deps{
		CTLClient:   &fakeCTL{},
		BundleStore: &fakeBundleStore{},
		JifeiClient: placeholderJifei,
	})
	po := placeorder.New(placeorder.Deps{
		CTLClient:   &fakeCTL{},
		BundleStore: &fakeBundleStore{},
		JifeiClient: placeholderJifei,
		OrderWriter: &fakeOrderWriter{},
		OrderStore:  &fakeOrderStore{},
	})

	osStore := &fakeOrderStoreOSP{}
	owWriter := &fakeOrderWriterOSP{}
	jc := &fakeJifeiOSP{}

	osSvc := orderstatus.New(orderstatus.Deps{
		OrderStore:  osStore,
		OrderWriter: owWriter,
		JifeiClient: jc,
	})

	r := gin.New()
	Install(r, Deps{
		InternalServiceToken: "test-token",
		Inquiry:              inq,
		PlaceOrder:           po,
		OrderStatus:          osSvc,
	})

	return &orderStatusTestEnv{
		router: r,
		store:  osStore,
		writer: owWriter,
		jifei:  jc,
		token:  "test-token",
	}
}

func (e *orderStatusTestEnv) doQueryStatus(t *testing.T, dealName string, body any, withAuth bool) *httptest.ResponseRecorder {
	t.Helper()
	var buf bytes.Buffer
	if body != nil {
		if err := json.NewEncoder(&buf).Encode(body); err != nil {
			t.Fatalf("encode body: %v", err)
		}
	}
	req := httptest.NewRequest(http.MethodPost,
		"/internal/trade/orders/"+dealName+"/query-status", &buf)
	req.Header.Set("Content-Type", "application/json")
	if withAuth {
		req.Header.Set("Authorization", "Bearer "+e.token)
	}
	rec := httptest.NewRecorder()
	e.router.ServeHTTP(rec, req)
	return rec
}

// makeTradeOrder 构造一条标准 trade_order 流水。
func makeTradeOrder(dealName, userID, status string) *store.TradeOrder {
	return &store.TradeOrder{
		ID:             1,
		BigOrderID:     "BIG-" + dealName,
		DealName:       dealName,
		ExternalUserID: userID,
		Uin:            "700000164995",
		AppID:          "251202221",
		BundleID:       "bundle-test",
		OrderType:      store.OrderTypeCreate,
		Status:         status,
		ResourceType:   "pass",
		CreatedTime:    time.Now(),
		UpdatedTime:    time.Now(),
	}
}

// ============================================================================
// handler 测试
// ============================================================================

// TestQueryOrderStatus_HappyPath_LocalTerminal 验证 B1 短路链路通过 handler。
func TestQueryOrderStatus_HappyPath_LocalTerminal(t *testing.T) {
	env := newOrderStatusTestEnv(t)
	env.store.getOrderFn = func(ctx context.Context, dealName string) (*store.TradeOrder, error) {
		return makeTradeOrder(dealName, "u1", store.OrderStatusProvisioned), nil
	}

	rec := env.doQueryStatus(t, "deal-1", map[string]any{"external_user_id": "u1"}, true)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body["status"] != "success" {
		t.Errorf("status = %v, want success", body["status"])
	}
	if body["source"] != "local" {
		t.Errorf("source = %v, want local", body["source"])
	}
	if env.jifei.calls.Load() != 0 {
		t.Errorf("B1 violated: jifei called %d times", env.jifei.calls.Load())
	}
}

// TestQueryOrderStatus_AuthRequired 验证缺 Bearer 时 401。
func TestQueryOrderStatus_AuthRequired(t *testing.T) {
	env := newOrderStatusTestEnv(t)
	rec := env.doQueryStatus(t, "deal-x", map[string]any{"external_user_id": "u1"}, false)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401; body=%s", rec.Code, rec.Body.String())
	}
}

// TestQueryOrderStatus_OrderNotFound 验证 404 ORDER_NOT_FOUND 链路。
func TestQueryOrderStatus_OrderNotFound(t *testing.T) {
	env := newOrderStatusTestEnv(t)
	env.store.getOrderFn = func(ctx context.Context, dealName string) (*store.TradeOrder, error) {
		return nil, store.ErrTradeOrderNotFound
	}
	rec := env.doQueryStatus(t, "missing", map[string]any{"external_user_id": "u1"}, true)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404; body=%s", rec.Code, rec.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body["code"] != "OrderNotFound" {
		t.Errorf("code = %v, want OrderNotFound", body["code"])
	}
}

// TestQueryOrderStatus_PermissionDenied_404 验证 B4 越权返 404 不暴露存在性。
func TestQueryOrderStatus_PermissionDenied_404(t *testing.T) {
	env := newOrderStatusTestEnv(t)
	env.store.getOrderFn = func(ctx context.Context, dealName string) (*store.TradeOrder, error) {
		return makeTradeOrder(dealName, "owner-user", store.OrderStatusPendingPay), nil
	}
	rec := env.doQueryStatus(t, "deal-y", map[string]any{"external_user_id": "attacker"}, true)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404 (B4 不暴露存在性); body=%s", rec.Code, rec.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body["code"] != "OrderNotFound" {
		t.Errorf("code = %v, want OrderNotFound (B4 越权统一返 404)", body["code"])
	}
}

// TestQueryOrderStatus_InvalidInput 验证空 external_user_id 返 400。
func TestQueryOrderStatus_InvalidInput(t *testing.T) {
	env := newOrderStatusTestEnv(t)
	rec := env.doQueryStatus(t, "deal-x", map[string]any{}, true)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body=%s", rec.Code, rec.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body["code"] != "InvalidRequest" {
		t.Errorf("code = %v, want InvalidRequest", body["code"])
	}
}

// TestQueryOrderStatus_InvalidJSON 验证非法 JSON body 返 400。
func TestQueryOrderStatus_InvalidJSON(t *testing.T) {
	env := newOrderStatusTestEnv(t)
	req := httptest.NewRequest(http.MethodPost, "/internal/trade/orders/d/query-status",
		bytes.NewBufferString("not-json"))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+env.token)
	rec := httptest.NewRecorder()
	env.router.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body=%s", rec.Code, rec.Body.String())
	}
}

// TestQueryOrderStatus_JifeiCanceled_E2E 端到端验证 B2 链路：
//   - trade_order 中态 → handler 调 service → service 调 jifei → jifei 返 canceled
//   - service 同步调 MarkOrderCancelled
//   - handler 返 200 + status="cancelled" + source="jifei"
func TestQueryOrderStatus_JifeiCanceled_E2E(t *testing.T) {
	env := newOrderStatusTestEnv(t)
	env.store.getOrderFn = func(ctx context.Context, dealName string) (*store.TradeOrder, error) {
		return makeTradeOrder(dealName, "u1", store.OrderStatusPendingPay), nil
	}
	env.jifei.getDealsByKeyIndexFn = func(ctx context.Context, req *jifeiclient.GetDealsByKeyIndexRequest) (*jifeiclient.GetDealsByKeyIndexResponse, error) {
		// 通过 JSON 反序列化构造 flexInt（unexported 类型，只能间接构造）
		raw := []byte(`{"totalNum":1,"deals":[{"dealName":"deal-bz","status":6}]}`)
		var resp jifeiclient.GetDealsByKeyIndexResponse
		if err := json.Unmarshal(raw, &resp); err != nil {
			return nil, err
		}
		return &resp, nil
	}

	rec := env.doQueryStatus(t, "deal-bz", map[string]any{"external_user_id": "u1"}, true)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body["status"] != "cancelled" {
		t.Errorf("status = %v, want cancelled", body["status"])
	}
	if body["source"] != "jifei" {
		t.Errorf("source = %v, want jifei", body["source"])
	}
	if env.writer.markCancelledCalls.Load() != 1 {
		t.Errorf("B2 violated: MarkCancelled called %d times, want 1",
			env.writer.markCancelledCalls.Load())
	}
}

// TestQueryOrderStatus_JifeiUnreachable_200WithUpstreamErr 端到端 B7 降级：
// jifei error 时仍返 200 + source=local + upstream_err，不阻断前端轮询。
func TestQueryOrderStatus_JifeiUnreachable_200WithUpstreamErr(t *testing.T) {
	env := newOrderStatusTestEnv(t)
	env.store.getOrderFn = func(ctx context.Context, dealName string) (*store.TradeOrder, error) {
		return makeTradeOrder(dealName, "u1", store.OrderStatusPendingPay), nil
	}
	env.jifei.getDealsByKeyIndexFn = func(ctx context.Context, _ *jifeiclient.GetDealsByKeyIndexRequest) (*jifeiclient.GetDealsByKeyIndexResponse, error) {
		return nil, errors.New("connection refused")
	}

	rec := env.doQueryStatus(t, "deal-7", map[string]any{"external_user_id": "u1"}, true)
	if rec.Code != http.StatusOK {
		t.Fatalf("B7 violated: status = %d, want 200 (fallback); body=%s", rec.Code, rec.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body["source"] != "local" {
		t.Errorf("source = %v, want local (B7 fallback)", body["source"])
	}
	if upErr, _ := body["upstream_err"].(string); upErr == "" {
		t.Errorf("upstream_err empty, want non-empty (B7 fallback signal)")
	}
}

// TestInstall_OrderStatusNil_RouteNotMounted 验证 OrderStatus=nil 时新路由不挂载。
//
// 这覆盖向后兼容承诺：旧测试 / 仅承载 jifei 回调的调用方留 nil 时，
// /internal/trade/orders/:dealName/query-status 应返 404（路由未匹配）。
func TestInstall_OrderStatusNil_RouteNotMounted(t *testing.T) {
	placeholderJifei := &fakeJifei{}
	inq := inquiry.New(inquiry.Deps{
		CTLClient:   &fakeCTL{},
		BundleStore: &fakeBundleStore{},
		JifeiClient: placeholderJifei,
	})
	po := placeorder.New(placeorder.Deps{
		CTLClient:   &fakeCTL{},
		BundleStore: &fakeBundleStore{},
		JifeiClient: placeholderJifei,
		OrderWriter: &fakeOrderWriter{},
		OrderStore:  &fakeOrderStore{},
	})

	r := gin.New()
	Install(r, Deps{
		InternalServiceToken: "test-token",
		Inquiry:              inq,
		PlaceOrder:           po,
		// OrderStatus 故意 nil
	})

	req := httptest.NewRequest(http.MethodPost,
		"/internal/trade/orders/d/query-status",
		bytes.NewBufferString(`{"external_user_id":"u1"}`))
	req.Header.Set("Authorization", "Bearer test-token")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	// gin 默认对未注册路由返 404
	if rec.Code != http.StatusNotFound {
		t.Errorf("nil OrderStatus deps: route should not be mounted, got status=%d body=%s",
			rec.Code, rec.Body.String())
	}
}
