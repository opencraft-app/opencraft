package internalapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"git.woa.com/wisp/mono/trade/internal/logic/inquiry"
	"git.woa.com/wisp/mono/trade/internal/logic/placeorder"
	"git.woa.com/wisp/mono/trade/internal/store"
)

// ===== fakeFlowStore（仅本测试文件用：MarkCompletedByID + MarkFailedByID） ===========

type fakeFlowStoreCallback struct {
	mu sync.Mutex

	markCompletedByIDFn func(ctx context.Context, id int64, body []byte) error
	calls               []markCompletedByIDCall

	// R-MR-5（2026-05-24）：跟踪 MarkFailedByID 调用。
	markFailedByIDFn func(ctx context.Context, id int64, body []byte) error
	failedCalls      []markCompletedByIDCall
	getByIDFn        func(ctx context.Context, id int64) (*store.Flow, error)
}

type markCompletedByIDCall struct {
	id   int64
	body []byte
}

func (f *fakeFlowStoreCallback) TryAcquireSlot(_ context.Context, _, _, _ string, _ []byte) (bool, *store.Flow, error) {
	return false, nil, errors.New("not used")
}
func (f *fakeFlowStoreCallback) TryAcquireSlotForIsolate(_ context.Context, _, _, _, _ string, _ []byte, _ *string) (bool, *store.Flow, error) {
	return false, nil, errors.New("not used")
}
func (f *fakeFlowStoreCallback) MarkCompletedWithResourceID(_ context.Context, _, _, _, _ string, _ []byte) error {
	return nil
}

func (f *fakeFlowStoreCallback) MarkCompleted(_ context.Context, _, _, _ string, _ []byte) error {
	return errors.New("not used")
}
func (f *fakeFlowStoreCallback) MarkFailed(_ context.Context, _, _, _ string, _ []byte) error {
	return errors.New("not used")
}
func (f *fakeFlowStoreCallback) MarkCompletedByID(ctx context.Context, id int64, body []byte) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, markCompletedByIDCall{id: id, body: append([]byte(nil), body...)})
	if f.markCompletedByIDFn != nil {
		return f.markCompletedByIDFn(ctx, id, body)
	}
	return nil
}
func (f *fakeFlowStoreCallback) MarkFailedByID(ctx context.Context, id int64, body []byte) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.failedCalls = append(f.failedCalls, markCompletedByIDCall{id: id, body: append([]byte(nil), body...)})
	if f.markFailedByIDFn != nil {
		return f.markFailedByIDFn(ctx, id, body)
	}
	return nil
}
func (f *fakeFlowStoreCallback) DeleteByID(_ context.Context, _ int64) error {
	return errors.New("not used")
}
func (f *fakeFlowStoreCallback) GetFlow(_ context.Context, _, _, _ string) (*store.Flow, error) {
	return nil, store.ErrFlowNotFound
}

func (f *fakeFlowStoreCallback) GetByID(ctx context.Context, id int64) (*store.Flow, error) {
	if f.getByIDFn != nil {
		return f.getByIDFn(ctx, id)
	}
	return nil, store.ErrFlowNotFound
}
func (f *fakeFlowStoreCallback) ListInProgressBefore(_ context.Context, _ time.Time, _ int) ([]*store.Flow, error) {
	return nil, errors.New("not used")
}

// ===== test env with FlowStore ===============================================

func newCallbackEnv(t *testing.T, flow *fakeFlowStoreCallback) *gin.Engine {
	return newCallbackEnvWithOrderUpdater(t, flow, nil)
}

func newCallbackEnvWithOrderUpdater(
	t *testing.T,
	flow *fakeFlowStoreCallback,
	orders OrderProvisionUpdater,
) *gin.Engine {
	t.Helper()
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
		InternalServiceToken: "test-token",
		Inquiry:              inq,
		PlaceOrder:           po,
		FlowStore:            flow,
		OrderUpdater:         orders,
	})
	return r
}

type fakeModifyOrderUpdater struct {
	err        error
	dealName   string
	resourceID string
	calls      int
}

func (f *fakeModifyOrderUpdater) MarkOrderProvisioned(
	_ context.Context,
	dealName, resourceID string,
) error {
	f.calls++
	f.dealName = dealName
	f.resourceID = resourceID
	return f.err
}

func doCallbackJSON(r *gin.Engine, flowID string, body any, withAuth bool) *httptest.ResponseRecorder {
	var buf bytes.Buffer
	if body != nil {
		_ = json.NewEncoder(&buf).Encode(body)
	}
	req := httptest.NewRequest(http.MethodPost, "/internal/trade/flows/"+flowID+"/complete", &buf)
	req.Header.Set("Content-Type", "application/json")
	if withAuth {
		req.Header.Set("Authorization", "Bearer test-token")
	}
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	return rec
}

// 空 body 版本（ContentLength==0 走快路径）。
func doCallbackEmpty(r *gin.Engine, flowID string, withAuth bool) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, "/internal/trade/flows/"+flowID+"/complete", http.NoBody)
	if withAuth {
		req.Header.Set("Authorization", "Bearer test-token")
	}
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	return rec
}

// ===== 用例 ==================================================================

func TestFlowComplete_HappyPath(t *testing.T) {
	flow := &fakeFlowStoreCallback{}
	r := newCallbackEnv(t, flow)

	rec := doCallbackJSON(r, "4242", map[string]any{
		"result":  "completed",
		"message": "task all-success",
	}, true)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d body=%s", rec.Code, rec.Body.String())
	}
	var resp map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	if ack, _ := resp["ack"].(bool); !ack {
		t.Errorf("expected ack=true, got %v", resp["ack"])
	}
	if len(flow.calls) != 1 {
		t.Fatalf("expected 1 MarkCompletedByID call, got %d", len(flow.calls))
	}
	if flow.calls[0].id != 4242 {
		t.Errorf("expected id=4242, got %d", flow.calls[0].id)
	}
	if !strings.Contains(string(flow.calls[0].body), "completed") {
		t.Errorf("expected body to contain 'completed', got %s", string(flow.calls[0].body))
	}
}

func TestFlowComplete_ModifyPromotesOrderAndPreservesAcceptanceResponse(t *testing.T) {
	resourceID := "pass-1"
	acceptedBody := []byte(`{"returnCode":0,"returnValue":0,"data":{"flowId":4242}}`)
	flow := &fakeFlowStoreCallback{
		getByIDFn: func(_ context.Context, id int64) (*store.Flow, error) {
			return &store.Flow{
				ID: id, DealName: "deal-1", ResourceID: &resourceID,
				FlowType: store.FlowTypeModifyResource, Status: store.FlowStatusInProgress,
				ResponseBody: acceptedBody,
			}, nil
		},
	}
	orders := &fakeModifyOrderUpdater{}
	r := newCallbackEnvWithOrderUpdater(t, flow, orders)

	rec := doCallbackJSON(r, "4242", map[string]any{"result": "completed"}, true)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d body=%s", rec.Code, rec.Body.String())
	}
	if orders.calls != 1 || orders.dealName != "deal-1" || orders.resourceID != resourceID {
		t.Fatalf("unexpected order promotion: %+v", orders)
	}
	if len(flow.calls) != 1 || !bytes.Equal(flow.calls[0].body, acceptedBody) {
		t.Fatalf("completion must preserve accepted framework body, got %+v", flow.calls)
	}
}

func TestFlowComplete_ModifyOrderFailureKeepsCallbackRetryable(t *testing.T) {
	resourceID := "pass-1"
	flow := &fakeFlowStoreCallback{
		getByIDFn: func(_ context.Context, id int64) (*store.Flow, error) {
			return &store.Flow{
				ID: id, DealName: "deal-before-insert", ResourceID: &resourceID,
				FlowType: store.FlowTypeModifyResource, Status: store.FlowStatusInProgress,
				ResponseBody: []byte(`{"returnCode":0,"returnValue":0}`),
			}, nil
		},
	}
	orders := &fakeModifyOrderUpdater{err: store.ErrTradeOrderNotFound}
	r := newCallbackEnvWithOrderUpdater(t, flow, orders)

	rec := doCallbackJSON(r, "4243", map[string]any{"result": "completed"}, true)
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("expected 502, got %d body=%s", rec.Code, rec.Body.String())
	}
	if len(flow.calls) != 0 {
		t.Fatalf("flow must remain in_progress until order promotion succeeds")
	}
}

func TestFlowComplete_ModifyWaitsForAcceptanceMetadata(t *testing.T) {
	flow := &fakeFlowStoreCallback{
		getByIDFn: func(_ context.Context, id int64) (*store.Flow, error) {
			return &store.Flow{
				ID: id, DealName: "deal-1", FlowType: store.FlowTypeModifyResource,
				Status: store.FlowStatusInProgress,
			}, nil
		},
	}
	orders := &fakeModifyOrderUpdater{}
	r := newCallbackEnvWithOrderUpdater(t, flow, orders)

	rec := doCallbackJSON(r, "4244", map[string]any{"result": "completed"}, true)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected 503, got %d body=%s", rec.Code, rec.Body.String())
	}
	if orders.calls != 0 || len(flow.calls) != 0 {
		t.Fatalf("must not complete before modifyResource acceptance is recorded")
	}
}

func TestFlowComplete_EmptyBody_StillWritesNilOrEmptyResponse(t *testing.T) {
	flow := &fakeFlowStoreCallback{}
	r := newCallbackEnv(t, flow)

	rec := doCallbackEmpty(r, "1000", true)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d body=%s", rec.Code, rec.Body.String())
	}
	if len(flow.calls) != 1 {
		t.Fatalf("expected 1 call, got %d", len(flow.calls))
	}
	if flow.calls[0].id != 1000 {
		t.Errorf("expected id=1000, got %d", flow.calls[0].id)
	}
}

func TestFlowComplete_InvalidFlowID(t *testing.T) {
	cases := []struct {
		name   string
		flowID string
	}{
		{"non-numeric", "abc"},
		{"zero", "0"},
		{"negative", "-1"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			flow := &fakeFlowStoreCallback{}
			r := newCallbackEnv(t, flow)
			rec := doCallbackJSON(r, tc.flowID, map[string]any{"result": "completed"}, true)
			if rec.Code != http.StatusBadRequest {
				t.Errorf("expected 400, got %d body=%s", rec.Code, rec.Body.String())
			}
			if len(flow.calls) != 0 {
				t.Errorf("FlowStore should NOT be called on invalid flowID, got %d calls", len(flow.calls))
			}
		})
	}
}

func TestFlowComplete_MalformedJSON(t *testing.T) {
	flow := &fakeFlowStoreCallback{}
	r := newCallbackEnv(t, flow)

	req := httptest.NewRequest(http.MethodPost, "/internal/trade/flows/77/complete", strings.NewReader(`{not json`))
	req.Header.Set("Authorization", "Bearer test-token")
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", rec.Code)
	}
}

func TestFlowComplete_DBError_Returns502(t *testing.T) {
	flow := &fakeFlowStoreCallback{
		markCompletedByIDFn: func(_ context.Context, _ int64, _ []byte) error {
			return errors.New("connection refused")
		},
	}
	r := newCallbackEnv(t, flow)

	rec := doCallbackJSON(r, "5000", map[string]any{"result": "completed"}, true)
	if rec.Code != http.StatusBadGateway {
		t.Errorf("expected 502 on DB failure, got %d", rec.Code)
	}
	if len(flow.calls) != 1 {
		t.Errorf("expected 1 call (failed at MarkCompletedByID), got %d", len(flow.calls))
	}
}

func TestFlowComplete_AuthRequired(t *testing.T) {
	flow := &fakeFlowStoreCallback{}
	r := newCallbackEnv(t, flow)

	rec := doCallbackJSON(r, "1", map[string]any{"result": "completed"}, false)
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("expected 401, got %d", rec.Code)
	}
	if len(flow.calls) != 0 {
		t.Errorf("FlowStore should NOT be called without auth, got %d calls", len(flow.calls))
	}
}

// FlowStore 未注入时（Sub-4 之前的旧调用方），路由不挂载 → 404。
// 这条用例验证 Install 的"FlowStore == nil 时不挂载"分支语义，避免 Sub-4 之前的
// 测试套件被强制要求注入 FlowStore。
func TestFlowComplete_RouteNotMountedWhenFlowStoreNil(t *testing.T) {
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
		InternalServiceToken: "test-token",
		Inquiry:              inq,
		PlaceOrder:           po,
		// FlowStore 故意不传
	})
	rec := doCallbackJSON(r, "1", map[string]any{"result": "completed"}, true)
	if rec.Code != http.StatusNotFound {
		t.Errorf("expected 404 when FlowStore not injected, got %d", rec.Code)
	}
}

// 防御：response_body 实际写入的内容是合法 JSON（不是裸字符串）。
func TestFlowComplete_ResponseBodyIsJSONForm(t *testing.T) {
	flow := &fakeFlowStoreCallback{}
	r := newCallbackEnv(t, flow)

	rec := doCallbackJSON(r, "9999", map[string]any{
		"result":  "completed",
		"message": "ok",
	}, true)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	if len(flow.calls) != 1 {
		t.Fatalf("expected 1 call, got %d", len(flow.calls))
	}
	var parsed map[string]any
	if err := json.Unmarshal(flow.calls[0].body, &parsed); err != nil {
		t.Fatalf("response body must be valid JSON, got %s err=%v", string(flow.calls[0].body), err)
	}
	if parsed["result"] != "completed" {
		t.Errorf("body.result mismatch: got %v", parsed["result"])
	}
}

// 防御兜底：用 io.ReadAll 检查 happy path body 中没有意外控制字节
// （此前 jsonMarshal 多层 indirection 自我纠正后的回归保护）。
func TestFlowComplete_NoBinaryGarbageInBody(t *testing.T) {
	flow := &fakeFlowStoreCallback{}
	r := newCallbackEnv(t, flow)

	rec := doCallbackJSON(r, "12345", map[string]any{"result": "completed"}, true)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	bodyBytes, _ := io.ReadAll(rec.Body)
	for _, b := range bodyBytes {
		if b < 0x20 && b != '\n' && b != '\t' && b != '\r' {
			t.Fatalf("response contains binary control byte %x; body=%q", b, string(bodyBytes))
		}
	}
}

// ===== R-MR-5 续费失败路径：result="failed" → MarkFailedByID =================

// TestFlowComplete_ResultFailed_RoutesToMarkFailed 验证：2026-05-24 R-MR-5 升级后，
// req.Result == "failed" 必须调 MarkFailedByID（不是 MarkCompletedByID），让 trade_flow
// 状态落 failed，后续 jifei 计费查询时自动退款。
func TestFlowComplete_ResultFailed_RoutesToMarkFailed(t *testing.T) {
	flow := &fakeFlowStoreCallback{}
	r := newCallbackEnv(t, flow)

	rec := doCallbackJSON(r, "7777", map[string]any{
		"result":  "failed",
		"message": "renew rollback completed; jifei should refund",
	}, true)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d body=%s", rec.Code, rec.Body.String())
	}

	// MarkFailedByID 必须被调 1 次；MarkCompletedByID 必须未被调
	if len(flow.failedCalls) != 1 {
		t.Fatalf("expected 1 MarkFailedByID call, got %d", len(flow.failedCalls))
	}
	if len(flow.calls) != 0 {
		t.Errorf("MarkCompletedByID MUST NOT be called for result=failed; got %d calls", len(flow.calls))
	}
	if flow.failedCalls[0].id != 7777 {
		t.Errorf("expected id=7777, got %d", flow.failedCalls[0].id)
	}
	if !strings.Contains(string(flow.failedCalls[0].body), "failed") {
		t.Errorf("expected body to contain 'failed', got %s", string(flow.failedCalls[0].body))
	}
}

// TestFlowComplete_ResultFailed_DBError_Returns502 验证：failed 路径下的 DB 写失败
// 同样返 502 UpstreamError（与 completed 路径同范式）。
func TestFlowComplete_ResultFailed_DBError_Returns502(t *testing.T) {
	flow := &fakeFlowStoreCallback{
		markFailedByIDFn: func(_ context.Context, _ int64, _ []byte) error {
			return errors.New("connection refused")
		},
	}
	r := newCallbackEnv(t, flow)

	rec := doCallbackJSON(r, "6666", map[string]any{"result": "failed"}, true)
	if rec.Code != http.StatusBadGateway {
		t.Errorf("expected 502 on DB failure, got %d", rec.Code)
	}
	if len(flow.failedCalls) != 1 {
		t.Errorf("expected 1 MarkFailedByID call (failed at DB), got %d", len(flow.failedCalls))
	}
}

// TestFlowComplete_UnknownResult_DefaultsToCompleted 验证：未知字面量保守按 completed
// 走，避免误触发退款。这保证了与旧 ctl 调用方的兼容：即使 ctl 未来传进一个未知字面量，
// 也不会造成资金事故；只有明确的 "failed" 才会走退款链路。
func TestFlowComplete_UnknownResult_DefaultsToCompleted(t *testing.T) {
	cases := []string{"", "completed", "unknown_value", "COMPLETED" /* 大小写不与 failed 匹配亦保守 */, "FAILED" /* 同上 */}
	for _, result := range cases {
		t.Run("result="+result, func(t *testing.T) {
			flow := &fakeFlowStoreCallback{}
			r := newCallbackEnv(t, flow)

			rec := doCallbackJSON(r, "5555", map[string]any{"result": result}, true)
			if rec.Code != http.StatusOK {
				t.Fatalf("expected 200, got %d body=%s", rec.Code, rec.Body.String())
			}
			if len(flow.calls) != 1 {
				t.Errorf("expected 1 MarkCompletedByID call (default path), got %d", len(flow.calls))
			}
			if len(flow.failedCalls) != 0 {
				t.Errorf("MarkFailedByID MUST NOT be called for non-exact 'failed' result %q", result)
			}
		})
	}
}
