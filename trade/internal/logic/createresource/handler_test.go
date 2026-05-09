package createresource

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"git.woa.com/wisp/mono/trade/internal/ctlclient"
	"git.woa.com/wisp/mono/trade/internal/httpapi/jifei"
	"git.woa.com/wisp/mono/trade/internal/store"
)

// ===== 测试用 fake 实现 =======================================================

type fakeOrderStore struct {
	getFunc func(ctx context.Context, dealName string) (*store.TradeOrder, error)
}

func (f *fakeOrderStore) GetOrderByDealName(ctx context.Context, dealName string) (*store.TradeOrder, error) {
	return f.getFunc(ctx, dealName)
}

type fakeOrderUpdater struct {
	mu      sync.Mutex
	calls   []orderUpdateCall
	markErr error
}

type orderUpdateCall struct {
	dealName string
	passID   string
}

func (f *fakeOrderUpdater) MarkOrderProvisioned(_ context.Context, dealName, passID string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, orderUpdateCall{dealName: dealName, passID: passID})
	return f.markErr
}

type fakeFlowStore struct {
	mu sync.Mutex

	tryAcquireFunc      func(ctx context.Context, dealName, flowType, appID string, body []byte) (bool, *store.Flow, error)
	markCompletedCalls  []markCall
	markFailedCalls     []markCall
	markCompletedErr    error
	markFailedErr       error
}

type markCall struct {
	dealName     string
	flowType     string
	appID        string
	responseBody []byte
}

func (f *fakeFlowStore) TryAcquireSlot(ctx context.Context, dealName, flowType, appID string, body []byte) (bool, *store.Flow, error) {
	return f.tryAcquireFunc(ctx, dealName, flowType, appID, body)
}

func (f *fakeFlowStore) MarkCompleted(_ context.Context, dealName, flowType, appID string, responseBody []byte) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.markCompletedCalls = append(f.markCompletedCalls, markCall{dealName, flowType, appID, append([]byte(nil), responseBody...)})
	return f.markCompletedErr
}

func (f *fakeFlowStore) MarkFailed(_ context.Context, dealName, flowType, appID string, responseBody []byte) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.markFailedCalls = append(f.markFailedCalls, markCall{dealName, flowType, appID, append([]byte(nil), responseBody...)})
	return f.markFailedErr
}

func (f *fakeFlowStore) GetFlow(_ context.Context, _, _, _ string) (*store.Flow, error) {
	return nil, store.ErrFlowNotFound
}

func (f *fakeFlowStore) ListInProgressBefore(_ context.Context, _ time.Time, _ int) ([]*store.Flow, error) {
	return nil, nil
}

type fakeCTLClient struct {
	getBundleFunc    func(ctx context.Context, bundleID string) (*ctlclient.BundleDetail, error)
	listPassesFunc   func(ctx context.Context, externalUserID string) ([]*ctlclient.PassDetail, error)
	completePassFunc func(ctx context.Context, req *ctlclient.CompletePassRequest) (*ctlclient.PassDetail, error)
}

func (f *fakeCTLClient) GetBundleByID(ctx context.Context, bundleID string) (*ctlclient.BundleDetail, error) {
	return f.getBundleFunc(ctx, bundleID)
}
func (f *fakeCTLClient) ListPassesByUser(ctx context.Context, externalUserID string) ([]*ctlclient.PassDetail, error) {
	return f.listPassesFunc(ctx, externalUserID)
}
func (f *fakeCTLClient) CompletePass(ctx context.Context, req *ctlclient.CompletePassRequest) (*ctlclient.PassDetail, error) {
	return f.completePassFunc(ctx, req)
}

// ===== helpers ===============================================================

func newBuilder() *jifei.FrameworkBuilder {
	return jifei.NewFrameworkBuilder("trade", "1.0")
}

func defaultOrder() *store.TradeOrder {
	return &store.TradeOrder{
		ID:             1,
		BigOrderID:     "big-001",
		DealName:       "deal-001",
		ExternalUserID: "user-001",
		Uin:            "100012345678",
		AppID:          "12345678",
		SubProductCode: "sp_lighthouse_bundle_linux_small",
		BundleID:       "bundle_linux_small_01",
		Period:         1,
		TimeUnit:       "m",
		GoodsNum:       1,
		PayMode:        1,
		Status:         "pending_pay",
	}
}

func defaultPara() callbackPara {
	return callbackPara{
		DealName: "deal-001",
		AppID:    "12345678",
		Uin:      "100012345678",
		BundleID: "bundle_linux_small_01",
		GoodsNum: 1,
		GoodsDetail: map[string]interface{}{
			"pid":      "40000",
			"timeSpan": float64(1),
			"timeUnit": "m",
			"goodsNum": float64(1),
		},
	}
}

func paraJSON(t *testing.T, p callbackPara) json.RawMessage {
	t.Helper()
	b, err := json.Marshal(p)
	if err != nil {
		t.Fatalf("marshal para: %v", err)
	}
	return b
}

func newDeps(
	orderStore *fakeOrderStore,
	flowStore *fakeFlowStore,
	ctlClient *fakeCTLClient,
	updater OrderProvisionUpdater,
) Deps {
	return Deps{
		OrderStore:   orderStore,
		OrderUpdater: updater,
		FlowStore:    flowStore,
		CTLClient:    ctlClient,
		Builder:      newBuilder(),
	}
}

// ===== 入参校验 ===============================================================

func TestHandler_InvalidJSON_ReturnsInvalidPara(t *testing.T) {
	deps := newDeps(
		&fakeOrderStore{},
		&fakeFlowStore{
			tryAcquireFunc: func(ctx context.Context, _, _, _ string, _ []byte) (bool, *store.Flow, error) {
				t.Fatalf("flow.TryAcquireSlot should not be called when para is invalid")
				return false, nil, nil
			},
		},
		&fakeCTLClient{},
		nil,
	)
	h := makeHandler(deps)
	resp, err := h(context.Background(), json.RawMessage(`{not valid`))
	if err != nil {
		t.Fatalf("handler error: %v", err)
	}
	if resp.ReturnCode != ReturnCodeInvalidPara {
		t.Errorf("expected ReturnCodeInvalidPara=%d, got %d", ReturnCodeInvalidPara, resp.ReturnCode)
	}
	if resp.ReturnCode != resp.ReturnValue {
		t.Errorf("Q58 invariant returnCode==returnValue broken: %d != %d", resp.ReturnCode, resp.ReturnValue)
	}
}

func TestHandler_MissingDealName_ReturnsInvalidPara(t *testing.T) {
	p := defaultPara()
	p.DealName = ""
	deps := newDeps(&fakeOrderStore{}, &fakeFlowStore{
		tryAcquireFunc: func(ctx context.Context, _, _, _ string, _ []byte) (bool, *store.Flow, error) {
			t.Fatalf("should not reach flow store")
			return false, nil, nil
		},
	}, &fakeCTLClient{}, nil)
	resp, _ := makeHandler(deps)(context.Background(), paraJSON(t, p))
	if resp.ReturnCode != ReturnCodeInvalidPara {
		t.Errorf("expected ReturnCodeInvalidPara, got %d", resp.ReturnCode)
	}
}

// ===== Q61 抢占式幂等：赢家路径 ===============================================

func TestHandler_AcquireWins_HappyPath_ReturnsSuccessAndMarksCompleted(t *testing.T) {
	flow := &fakeFlowStore{
		tryAcquireFunc: func(_ context.Context, _, _, _ string, _ []byte) (bool, *store.Flow, error) {
			return true, nil, nil
		},
	}
	order := &fakeOrderStore{
		getFunc: func(_ context.Context, dn string) (*store.TradeOrder, error) {
			if dn != "deal-001" {
				t.Errorf("unexpected dealName %q", dn)
			}
			return defaultOrder(), nil
		},
	}
	updater := &fakeOrderUpdater{}
	ctl := &fakeCTLClient{
		completePassFunc: func(_ context.Context, req *ctlclient.CompletePassRequest) (*ctlclient.PassDetail, error) {
			// 验证 trade → ctl 入参映射（§6.2 T3）
			if req.UserID != "user-001" {
				t.Errorf("UserID mismatch: got %q", req.UserID)
			}
			if req.BundleID != "bundle_linux_small_01" {
				t.Errorf("BundleID mismatch: got %q", req.BundleID)
			}
			if req.TimeSpan != 1 || req.TimeUnit != "m" {
				t.Errorf("TimeSpan/Unit mismatch: %d/%q", req.TimeSpan, req.TimeUnit)
			}
			if req.Uin != 100012345678 {
				t.Errorf("Uin mismatch: %d", req.Uin)
			}
			if req.AppID != 12345678 {
				t.Errorf("AppID mismatch: %d", req.AppID)
			}
			if req.DealName != "deal-001" {
				t.Errorf("DealName mismatch: %q", req.DealName)
			}
			if req.RenewFlag != "MANUAL_RENEW" {
				t.Errorf("RenewFlag should be MANUAL_RENEW, got %q", req.RenewFlag)
			}
			return &ctlclient.PassDetail{PassID: "pass-abc-123"}, nil
		},
	}

	deps := newDeps(order, flow, ctl, updater)
	resp, err := makeHandler(deps)(context.Background(), paraJSON(t, defaultPara()))
	if err != nil {
		t.Fatalf("handler error: %v", err)
	}
	if resp.ReturnCode != 0 {
		t.Fatalf("expected success returnCode=0, got %d msg=%q", resp.ReturnCode, resp.ReturnMessage)
	}
	if got := resp.Data["resourceId"]; got != "pass-abc-123" {
		t.Errorf("data.resourceId mismatch: %v", got)
	}
	if resp.ReturnCode != resp.ReturnValue {
		t.Errorf("Q58 invariant broken: %d != %d", resp.ReturnCode, resp.ReturnValue)
	}
	// trade_order 反向回填一次
	if len(updater.calls) != 1 {
		t.Errorf("expected 1 MarkOrderProvisioned call, got %d", len(updater.calls))
	}
	// trade_flow 收尾为 completed
	flow.mu.Lock()
	defer flow.mu.Unlock()
	if len(flow.markCompletedCalls) != 1 {
		t.Errorf("expected 1 MarkCompleted call, got %d", len(flow.markCompletedCalls))
	}
	if len(flow.markFailedCalls) != 0 {
		t.Errorf("MarkFailed should NOT be called on happy path; got %d", len(flow.markFailedCalls))
	}
	// 验证写入 trade_flow 的 response_body 正是返给 jifei 的同一份 JSON（Q61 回放保证字节级一致）
	var replayed jifei.Framework
	if err := json.Unmarshal(flow.markCompletedCalls[0].responseBody, &replayed); err != nil {
		t.Fatalf("response_body unmarshal: %v", err)
	}
	if replayed.ReturnCode != resp.ReturnCode || replayed.Data["resourceId"] != resp.Data["resourceId"] {
		t.Errorf("response_body must equal jifei response: replayed=%+v resp=%+v", replayed, resp)
	}
}

// ===== Q56 退款路径：A 类业务永久错 ============================================

func TestHandler_CTLReturns4xx_ReturnsRefundMagic_AndMarksFailed(t *testing.T) {
	flow := &fakeFlowStore{
		tryAcquireFunc: func(_ context.Context, _, _, _ string, _ []byte) (bool, *store.Flow, error) {
			return true, nil, nil
		},
	}
	order := &fakeOrderStore{
		getFunc: func(_ context.Context, _ string) (*store.TradeOrder, error) { return defaultOrder(), nil },
	}
	ctl := &fakeCTLClient{
		completePassFunc: func(_ context.Context, _ *ctlclient.CompletePassRequest) (*ctlclient.PassDetail, error) {
			return nil, &ctlclient.Error{
				HTTPStatus: 409,
				Code:       "USER_HAS_ACTIVE_PASS",
				Message:    "user already has a pass",
			}
		},
	}
	deps := newDeps(order, flow, ctl, nil)
	resp, _ := makeHandler(deps)(context.Background(), paraJSON(t, defaultPara()))

	if resp.ReturnCode != jifei.RefundReturnCode {
		t.Errorf("Q56 A 类永久错应触发退款 magic %d, got %d msg=%q",
			jifei.RefundReturnCode, resp.ReturnCode, resp.ReturnMessage)
	}
	if resp.ReturnMessage != jifei.RefundReturnMessage {
		t.Errorf("returnMessage should be %q, got %q", jifei.RefundReturnMessage, resp.ReturnMessage)
	}
	flow.mu.Lock()
	defer flow.mu.Unlock()
	if len(flow.markFailedCalls) != 1 {
		t.Errorf("MarkFailed should be called once for refund; got %d", len(flow.markFailedCalls))
	}
	if len(flow.markCompletedCalls) != 0 {
		t.Errorf("MarkCompleted MUST NOT be called for refund path; got %d", len(flow.markCompletedCalls))
	}
}

func TestHandler_CTLBundleNotFound_ReturnsRefund(t *testing.T) {
	flow := &fakeFlowStore{
		tryAcquireFunc: func(_ context.Context, _, _, _ string, _ []byte) (bool, *store.Flow, error) {
			return true, nil, nil
		},
	}
	ctl := &fakeCTLClient{
		completePassFunc: func(_ context.Context, _ *ctlclient.CompletePassRequest) (*ctlclient.PassDetail, error) {
			return nil, ctlclient.ErrNotFound
		},
	}
	order := &fakeOrderStore{
		getFunc: func(_ context.Context, _ string) (*store.TradeOrder, error) { return defaultOrder(), nil },
	}
	deps := newDeps(order, flow, ctl, nil)
	resp, _ := makeHandler(deps)(context.Background(), paraJSON(t, defaultPara()))
	if resp.ReturnCode != jifei.RefundReturnCode {
		t.Errorf("ErrNotFound should map to refund, got %d", resp.ReturnCode)
	}
}

// ===== Q56 B 类：transient 故障，保留 in_progress ==============================

func TestHandler_CTLReturns5xx_ReturnsBClassCode_FlowKeptInProgress(t *testing.T) {
	flow := &fakeFlowStore{
		tryAcquireFunc: func(_ context.Context, _, _, _ string, _ []byte) (bool, *store.Flow, error) {
			return true, nil, nil
		},
	}
	ctl := &fakeCTLClient{
		completePassFunc: func(_ context.Context, _ *ctlclient.CompletePassRequest) (*ctlclient.PassDetail, error) {
			return nil, &ctlclient.Error{HTTPStatus: 503, Code: "INTERNAL", Message: "ctl down"}
		},
	}
	order := &fakeOrderStore{
		getFunc: func(_ context.Context, _ string) (*store.TradeOrder, error) { return defaultOrder(), nil },
	}
	deps := newDeps(order, flow, ctl, nil)
	resp, _ := makeHandler(deps)(context.Background(), paraJSON(t, defaultPara()))
	if resp.ReturnCode != ReturnCodeUpstreamUnavailable {
		t.Errorf("expected ReturnCodeUpstreamUnavailable=%d, got %d", ReturnCodeUpstreamUnavailable, resp.ReturnCode)
	}
	if resp.ReturnCode == jifei.RefundReturnCode {
		t.Errorf("5xx must NOT trigger refund (would cause unintended user refund)")
	}
	flow.mu.Lock()
	defer flow.mu.Unlock()
	// 关键不变量：B 类应保留 in_progress，让 reconcile worker 兜底
	if len(flow.markCompletedCalls) != 0 || len(flow.markFailedCalls) != 0 {
		t.Errorf("B-class transient error must NOT mark flow completed/failed; completed=%d failed=%d",
			len(flow.markCompletedCalls), len(flow.markFailedCalls))
	}
}

func TestHandler_CTLNetworkError_ReturnsBClass(t *testing.T) {
	flow := &fakeFlowStore{
		tryAcquireFunc: func(_ context.Context, _, _, _ string, _ []byte) (bool, *store.Flow, error) {
			return true, nil, nil
		},
	}
	ctl := &fakeCTLClient{
		completePassFunc: func(_ context.Context, _ *ctlclient.CompletePassRequest) (*ctlclient.PassDetail, error) {
			return nil, errors.New("connection refused")
		},
	}
	order := &fakeOrderStore{
		getFunc: func(_ context.Context, _ string) (*store.TradeOrder, error) { return defaultOrder(), nil },
	}
	deps := newDeps(order, flow, ctl, nil)
	resp, _ := makeHandler(deps)(context.Background(), paraJSON(t, defaultPara()))
	if resp.ReturnCode != ReturnCodeUpstreamUnavailable {
		t.Errorf("network error should be ReturnCodeUpstreamUnavailable, got %d", resp.ReturnCode)
	}
	if resp.ReturnCode == jifei.RefundReturnCode {
		t.Errorf("network error must NOT trigger refund")
	}
}

// ===== trade_order 反查异常 ===================================================

func TestHandler_OrderNotFound_ReturnsBClass_FlowKeptInProgress(t *testing.T) {
	flow := &fakeFlowStore{
		tryAcquireFunc: func(_ context.Context, _, _, _ string, _ []byte) (bool, *store.Flow, error) {
			return true, nil, nil
		},
	}
	order := &fakeOrderStore{
		getFunc: func(_ context.Context, _ string) (*store.TradeOrder, error) {
			return nil, store.ErrTradeOrderNotFound
		},
	}
	deps := newDeps(order, flow, &fakeCTLClient{}, nil)
	resp, _ := makeHandler(deps)(context.Background(), paraJSON(t, defaultPara()))
	if resp.ReturnCode != ReturnCodeOrderNotFound {
		t.Errorf("expected ReturnCodeOrderNotFound=%d, got %d", ReturnCodeOrderNotFound, resp.ReturnCode)
	}
	if resp.ReturnCode == jifei.RefundReturnCode {
		t.Errorf("OrderNotFound should NOT trigger refund (it's a state-inconsistency, not permanent business error)")
	}
}

// ===== 已发货幂等回放（Q56 b 场景）=============================================

func TestHandler_OrderAlreadyProvisioned_ReturnsSuccessReplay(t *testing.T) {
	flow := &fakeFlowStore{
		tryAcquireFunc: func(_ context.Context, _, _, _ string, _ []byte) (bool, *store.Flow, error) {
			// 注意：本场景假定 trade_flow 没记录（如 trade pod 重启后），handler 仍能从
			// trade_order.resource_id 反查走幂等回放。
			return true, nil, nil
		},
	}
	provisioned := defaultOrder()
	provisioned.ResourceID = "pass-already-001"
	provisioned.ResourceType = "pass"
	order := &fakeOrderStore{
		getFunc: func(_ context.Context, _ string) (*store.TradeOrder, error) { return provisioned, nil },
	}
	ctl := &fakeCTLClient{
		completePassFunc: func(_ context.Context, _ *ctlclient.CompletePassRequest) (*ctlclient.PassDetail, error) {
			t.Fatalf("ctl.CompletePass MUST NOT be called when trade_order already has resource_id (idempotent replay)")
			return nil, nil
		},
	}
	deps := newDeps(order, flow, ctl, nil)
	resp, _ := makeHandler(deps)(context.Background(), paraJSON(t, defaultPara()))
	if resp.ReturnCode != 0 {
		t.Errorf("expected success replay returnCode=0, got %d", resp.ReturnCode)
	}
	if resp.Data["resourceId"] != "pass-already-001" {
		t.Errorf("expected replayed resourceId, got %v", resp.Data["resourceId"])
	}
}

// ===== Q61 输家三分支处理 ====================================================

func TestHandler_AcquireLoses_StatusCompleted_ReplaysSuccess(t *testing.T) {
	successBody := `{"returnCode":0,"returnValue":0,"componentName":"trade","version":"1.0","timestamp":1234,"returnMessage":"ok","data":{"resourceId":"pass-replay-001"}}`
	flow := &fakeFlowStore{
		tryAcquireFunc: func(_ context.Context, _, _, _ string, _ []byte) (bool, *store.Flow, error) {
			return false, &store.Flow{
				DealName:     "deal-001",
				Status:       store.FlowStatusCompleted,
				ResponseBody: []byte(successBody),
			}, nil
		},
	}
	order := &fakeOrderStore{
		getFunc: func(_ context.Context, _ string) (*store.TradeOrder, error) {
			t.Fatalf("OrderStore should NOT be called on loser path")
			return nil, nil
		},
	}
	ctl := &fakeCTLClient{
		completePassFunc: func(_ context.Context, _ *ctlclient.CompletePassRequest) (*ctlclient.PassDetail, error) {
			t.Fatalf("CTLClient should NOT be called on loser path")
			return nil, nil
		},
	}
	deps := newDeps(order, flow, ctl, nil)
	resp, _ := makeHandler(deps)(context.Background(), paraJSON(t, defaultPara()))
	if resp.ReturnCode != 0 {
		t.Errorf("loser-completed replay should yield returnCode=0, got %d", resp.ReturnCode)
	}
	if resp.Data["resourceId"] != "pass-replay-001" {
		t.Errorf("replayed data.resourceId mismatch: %v", resp.Data["resourceId"])
	}
}

func TestHandler_AcquireLoses_StatusFailed_ReplaysRefund(t *testing.T) {
	refundBody := `{"returnCode":352014,"returnValue":352014,"componentName":"trade","version":"1.0","timestamp":1234,"returnMessage":"DeliveryFailRefund","data":{}}`
	flow := &fakeFlowStore{
		tryAcquireFunc: func(_ context.Context, _, _, _ string, _ []byte) (bool, *store.Flow, error) {
			return false, &store.Flow{
				DealName:     "deal-001",
				Status:       store.FlowStatusFailed,
				ResponseBody: []byte(refundBody),
			}, nil
		},
	}
	deps := newDeps(&fakeOrderStore{}, flow, &fakeCTLClient{}, nil)
	resp, _ := makeHandler(deps)(context.Background(), paraJSON(t, defaultPara()))
	if resp.ReturnCode != jifei.RefundReturnCode {
		t.Errorf("loser-failed replay should yield refund magic %d, got %d", jifei.RefundReturnCode, resp.ReturnCode)
	}
}

func TestHandler_AcquireLoses_StatusInProgress_ReturnsBClass(t *testing.T) {
	flow := &fakeFlowStore{
		tryAcquireFunc: func(_ context.Context, _, _, _ string, _ []byte) (bool, *store.Flow, error) {
			return false, &store.Flow{
				DealName: "deal-001",
				Status:   store.FlowStatusInProgress,
			}, nil
		},
	}
	deps := newDeps(&fakeOrderStore{}, flow, &fakeCTLClient{}, nil)
	resp, _ := makeHandler(deps)(context.Background(), paraJSON(t, defaultPara()))
	if resp.ReturnCode != ReturnCodeFlowInProgress {
		t.Errorf("expected ReturnCodeFlowInProgress=%d, got %d", ReturnCodeFlowInProgress, resp.ReturnCode)
	}
	if resp.ReturnCode == jifei.RefundReturnCode {
		t.Errorf("in_progress loser must NOT trigger refund")
	}
}

func TestHandler_AcquireLoses_CorruptedResponseBody_ReturnsBClass(t *testing.T) {
	cases := []struct {
		name string
		body []byte
	}{
		{"empty body", nil},
		{"invalid JSON", []byte(`{not json`)},
		{"invariant broken: returnCode!=returnValue", []byte(`{"returnCode":0,"returnValue":1,"data":{}}`)},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			flow := &fakeFlowStore{
				tryAcquireFunc: func(_ context.Context, _, _, _ string, _ []byte) (bool, *store.Flow, error) {
					return false, &store.Flow{
						DealName:     "deal-001",
						Status:       store.FlowStatusCompleted,
						ResponseBody: tc.body,
					}, nil
				},
			}
			deps := newDeps(&fakeOrderStore{}, flow, &fakeCTLClient{}, nil)
			resp, _ := makeHandler(deps)(context.Background(), paraJSON(t, defaultPara()))
			if resp.ReturnCode != ReturnCodeFlowReplayCorrupted {
				t.Errorf("corrupted replay should yield ReturnCodeFlowReplayCorrupted=%d, got %d",
					ReturnCodeFlowReplayCorrupted, resp.ReturnCode)
			}
		})
	}
}

// ===== TryAcquireSlot 自身错误 ================================================

func TestHandler_AcquireFails_DBError_ReturnsBClass(t *testing.T) {
	flow := &fakeFlowStore{
		tryAcquireFunc: func(_ context.Context, _, _, _ string, _ []byte) (bool, *store.Flow, error) {
			return false, nil, errors.New("connection lost")
		},
	}
	deps := newDeps(&fakeOrderStore{}, flow, &fakeCTLClient{}, nil)
	resp, _ := makeHandler(deps)(context.Background(), paraJSON(t, defaultPara()))
	if resp.ReturnCode != ReturnCodeUpstreamUnavailable {
		t.Errorf("DB error should be ReturnCodeUpstreamUnavailable, got %d", resp.ReturnCode)
	}
	if resp.ReturnCode == jifei.RefundReturnCode {
		t.Errorf("DB error must NOT trigger refund")
	}
}

// ===== OrderUpdater 允许 nil（迭代 8 之前接线）+ Q56 不变量 ====================

func TestHandler_NilOrderUpdater_StillSucceeds(t *testing.T) {
	flow := &fakeFlowStore{
		tryAcquireFunc: func(_ context.Context, _, _, _ string, _ []byte) (bool, *store.Flow, error) {
			return true, nil, nil
		},
	}
	order := &fakeOrderStore{
		getFunc: func(_ context.Context, _ string) (*store.TradeOrder, error) { return defaultOrder(), nil },
	}
	ctl := &fakeCTLClient{
		completePassFunc: func(_ context.Context, _ *ctlclient.CompletePassRequest) (*ctlclient.PassDetail, error) {
			return &ctlclient.PassDetail{PassID: "pass-001"}, nil
		},
	}
	deps := newDeps(order, flow, ctl, nil) // updater = nil
	resp, _ := makeHandler(deps)(context.Background(), paraJSON(t, defaultPara()))
	if resp.ReturnCode != 0 {
		t.Errorf("nil OrderUpdater path should still succeed, got returnCode=%d", resp.ReturnCode)
	}
}

func TestHandler_OrderUpdaterFails_ReturnsBClass(t *testing.T) {
	flow := &fakeFlowStore{
		tryAcquireFunc: func(_ context.Context, _, _, _ string, _ []byte) (bool, *store.Flow, error) {
			return true, nil, nil
		},
	}
	order := &fakeOrderStore{
		getFunc: func(_ context.Context, _ string) (*store.TradeOrder, error) { return defaultOrder(), nil },
	}
	ctl := &fakeCTLClient{
		completePassFunc: func(_ context.Context, _ *ctlclient.CompletePassRequest) (*ctlclient.PassDetail, error) {
			return &ctlclient.PassDetail{PassID: "pass-001"}, nil
		},
	}
	updater := &fakeOrderUpdater{markErr: errors.New("db deadlock")}
	deps := newDeps(order, flow, ctl, updater)
	resp, _ := makeHandler(deps)(context.Background(), paraJSON(t, defaultPara()))
	if resp.ReturnCode != ReturnCodeUpstreamUnavailable {
		t.Errorf("expected ReturnCodeUpstreamUnavailable on updater fail, got %d", resp.ReturnCode)
	}
	if resp.ReturnCode == jifei.RefundReturnCode {
		t.Errorf("OrderUpdater fail must NOT trigger refund (ctl already created pass)")
	}
}

// ===== ctl 返 200 但 passId 为空 ===============================================

func TestHandler_CTLReturnsEmptyPassID_ReturnsBClass(t *testing.T) {
	flow := &fakeFlowStore{
		tryAcquireFunc: func(_ context.Context, _, _, _ string, _ []byte) (bool, *store.Flow, error) {
			return true, nil, nil
		},
	}
	order := &fakeOrderStore{
		getFunc: func(_ context.Context, _ string) (*store.TradeOrder, error) { return defaultOrder(), nil },
	}
	ctl := &fakeCTLClient{
		completePassFunc: func(_ context.Context, _ *ctlclient.CompletePassRequest) (*ctlclient.PassDetail, error) {
			return &ctlclient.PassDetail{}, nil // passId == ""
		},
	}
	deps := newDeps(order, flow, ctl, nil)
	resp, _ := makeHandler(deps)(context.Background(), paraJSON(t, defaultPara()))
	if resp.ReturnCode != ReturnCodeUpstreamUnavailable {
		t.Errorf("empty passId should be B class, got %d", resp.ReturnCode)
	}
}

// ===== 数据不一致：trade_order.uin / app_id 非数字 → 退款保护 ==================

func TestHandler_OrderUinNotNumeric_ReturnsRefund(t *testing.T) {
	bad := defaultOrder()
	bad.Uin = "not-a-number"
	flow := &fakeFlowStore{
		tryAcquireFunc: func(_ context.Context, _, _, _ string, _ []byte) (bool, *store.Flow, error) {
			return true, nil, nil
		},
	}
	order := &fakeOrderStore{
		getFunc: func(_ context.Context, _ string) (*store.TradeOrder, error) { return bad, nil },
	}
	deps := newDeps(order, flow, &fakeCTLClient{}, nil)
	resp, _ := makeHandler(deps)(context.Background(), paraJSON(t, defaultPara()))
	if resp.ReturnCode != jifei.RefundReturnCode {
		t.Errorf("malformed uin (永久不可发货) should refund, got %d", resp.ReturnCode)
	}
}

// ===== 综合不变量：所有响应都满足 Q58 returnCode==returnValue =================

func TestHandler_AllPaths_PreserveQ58Invariant(t *testing.T) {
	cases := []func() (Deps, callbackPara){
		// 赢家 happy path
		func() (Deps, callbackPara) {
			return newDeps(
				&fakeOrderStore{getFunc: func(_ context.Context, _ string) (*store.TradeOrder, error) {
					return defaultOrder(), nil
				}},
				&fakeFlowStore{tryAcquireFunc: func(_ context.Context, _, _, _ string, _ []byte) (bool, *store.Flow, error) {
					return true, nil, nil
				}},
				&fakeCTLClient{completePassFunc: func(_ context.Context, _ *ctlclient.CompletePassRequest) (*ctlclient.PassDetail, error) {
					return &ctlclient.PassDetail{PassID: "p1"}, nil
				}},
				nil,
			), defaultPara()
		},
		// 退款路径
		func() (Deps, callbackPara) {
			return newDeps(
				&fakeOrderStore{getFunc: func(_ context.Context, _ string) (*store.TradeOrder, error) {
					return defaultOrder(), nil
				}},
				&fakeFlowStore{tryAcquireFunc: func(_ context.Context, _, _, _ string, _ []byte) (bool, *store.Flow, error) {
					return true, nil, nil
				}},
				&fakeCTLClient{completePassFunc: func(_ context.Context, _ *ctlclient.CompletePassRequest) (*ctlclient.PassDetail, error) {
					return nil, ctlclient.ErrNotFound
				}},
				nil,
			), defaultPara()
		},
		// B 类路径
		func() (Deps, callbackPara) {
			return newDeps(
				&fakeOrderStore{getFunc: func(_ context.Context, _ string) (*store.TradeOrder, error) {
					return defaultOrder(), nil
				}},
				&fakeFlowStore{tryAcquireFunc: func(_ context.Context, _, _, _ string, _ []byte) (bool, *store.Flow, error) {
					return true, nil, nil
				}},
				&fakeCTLClient{completePassFunc: func(_ context.Context, _ *ctlclient.CompletePassRequest) (*ctlclient.PassDetail, error) {
					return nil, errors.New("network")
				}},
				nil,
			), defaultPara()
		},
	}
	for i, tc := range cases {
		deps, p := tc()
		resp, _ := makeHandler(deps)(context.Background(), paraJSON(t, p))
		if resp.ReturnCode != resp.ReturnValue {
			t.Errorf("case %d: Q58 invariant broken: returnCode=%d returnValue=%d",
				i, resp.ReturnCode, resp.ReturnValue)
		}
	}
}

// ===== Install 集成：handler 通过 dispatcher 路由命中 =========================

func TestInstall_RoutesCreateResourceToRealHandler(t *testing.T) {
	builder := newBuilder()
	d := jifei.NewDispatcher("lightvela", builder)
	flow := &fakeFlowStore{
		tryAcquireFunc: func(_ context.Context, _, _, _ string, _ []byte) (bool, *store.Flow, error) {
			return true, nil, nil
		},
	}
	order := &fakeOrderStore{
		getFunc: func(_ context.Context, _ string) (*store.TradeOrder, error) {
			return nil, store.ErrTradeOrderNotFound
		},
	}
	Install(d, Deps{
		OrderStore: order,
		FlowStore:  flow,
		CTLClient:  &fakeCTLClient{},
		Builder:    builder,
	})
	body := []byte(`{"interface":{"interfaceName":"lightvela.pass.createResource","para":{"dealName":"x","appId":"1","bundleId":"b","goodsNum":1}}}`)
	resp := d.Dispatch(context.Background(), body)
	if resp.ReturnCode != ReturnCodeOrderNotFound {
		t.Errorf("real handler should route and return business code 600202, got %d msg=%q", resp.ReturnCode, resp.ReturnMessage)
	}
}

// ===== 并发抢占：N 个 goroutine 同时调用，仅 1 个赢家进入主链路 ===============
//
// 此处用本地 sync 计数 fakeFlowStore 模拟唯一索引；仍是 in-process 测试，但能验证 handler
// 在"输家命中 in_progress"分支的快速失败语义（避免在压测中级联调 ctl）。

func TestHandler_ConcurrentAcquire_OnlyOneWinnerCallsCTL(t *testing.T) {
	const N = 20
	var (
		acquireMu      sync.Mutex
		acquired       bool
		ctlCalls       int32
		ctlMu          sync.Mutex
	)
	flow := &fakeFlowStore{
		tryAcquireFunc: func(_ context.Context, _, _, _ string, _ []byte) (bool, *store.Flow, error) {
			acquireMu.Lock()
			defer acquireMu.Unlock()
			if !acquired {
				acquired = true
				return true, nil, nil
			}
			return false, &store.Flow{
				DealName: "deal-001",
				Status:   store.FlowStatusInProgress,
			}, nil
		},
	}
	order := &fakeOrderStore{
		getFunc: func(_ context.Context, _ string) (*store.TradeOrder, error) { return defaultOrder(), nil },
	}
	ctl := &fakeCTLClient{
		completePassFunc: func(_ context.Context, _ *ctlclient.CompletePassRequest) (*ctlclient.PassDetail, error) {
			ctlMu.Lock()
			defer ctlMu.Unlock()
			ctlCalls++
			// 模拟略有延迟，让其它 goroutine 都进入 acquire
			time.Sleep(10 * time.Millisecond)
			return &ctlclient.PassDetail{PassID: "p1"}, nil
		},
	}
	deps := newDeps(order, flow, ctl, nil)
	h := makeHandler(deps)

	var wg sync.WaitGroup
	results := make([]int, N)
	wg.Add(N)
	for i := 0; i < N; i++ {
		go func(idx int) {
			defer wg.Done()
			resp, _ := h(context.Background(), paraJSON(t, defaultPara()))
			results[idx] = resp.ReturnCode
		}(i)
	}
	wg.Wait()

	// 关键不变量：只有 1 个赢家进入 ctl.CompletePass；其余 N-1 个全部走输家分支
	if ctlCalls != 1 {
		t.Errorf("expected exactly 1 ctl.CompletePass call (winner only), got %d", ctlCalls)
	}
	winners, losers := 0, 0
	for _, rc := range results {
		switch rc {
		case 0:
			winners++
		case ReturnCodeFlowInProgress:
			losers++
		}
	}
	if winners != 1 {
		t.Errorf("expected exactly 1 winner (returnCode=0), got %d", winners)
	}
	if losers != N-1 {
		t.Errorf("expected %d losers (ReturnCodeFlowInProgress), got %d", N-1, losers)
	}
}

// ===== Q56 严格不变量集合断言 ==================================================

func TestHandler_Q56_RefundOnlyOnAClass(t *testing.T) {
	// 任何 B 类（OrderNotFound / 5xx / network / DBError / unknown_status）都不允许触发退款
	bClassCases := []struct {
		name string
		deps func() Deps
	}{
		{
			name: "order not found",
			deps: func() Deps {
				return newDeps(
					&fakeOrderStore{getFunc: func(_ context.Context, _ string) (*store.TradeOrder, error) {
						return nil, store.ErrTradeOrderNotFound
					}},
					&fakeFlowStore{tryAcquireFunc: func(_ context.Context, _, _, _ string, _ []byte) (bool, *store.Flow, error) {
						return true, nil, nil
					}},
					&fakeCTLClient{}, nil,
				)
			},
		},
		{
			name: "ctl 5xx",
			deps: func() Deps {
				return newDeps(
					&fakeOrderStore{getFunc: func(_ context.Context, _ string) (*store.TradeOrder, error) {
						return defaultOrder(), nil
					}},
					&fakeFlowStore{tryAcquireFunc: func(_ context.Context, _, _, _ string, _ []byte) (bool, *store.Flow, error) {
						return true, nil, nil
					}},
					&fakeCTLClient{completePassFunc: func(_ context.Context, _ *ctlclient.CompletePassRequest) (*ctlclient.PassDetail, error) {
						return nil, &ctlclient.Error{HTTPStatus: 500}
					}},
					nil,
				)
			},
		},
		{
			name: "loser in_progress",
			deps: func() Deps {
				return newDeps(
					&fakeOrderStore{},
					&fakeFlowStore{tryAcquireFunc: func(_ context.Context, _, _, _ string, _ []byte) (bool, *store.Flow, error) {
						return false, &store.Flow{Status: store.FlowStatusInProgress}, nil
					}},
					&fakeCTLClient{}, nil,
				)
			},
		},
	}
	for _, tc := range bClassCases {
		t.Run(tc.name, func(t *testing.T) {
			resp, _ := makeHandler(tc.deps())(context.Background(), paraJSON(t, defaultPara()))
			if resp.ReturnCode == jifei.RefundReturnCode {
				t.Errorf("B-class %q must NOT return refund magic %d", tc.name, jifei.RefundReturnCode)
			}
			if !strings.Contains(strings.ToLower(resp.ReturnMessage), "") {
				t.Errorf("returnMessage missing context: %q", resp.ReturnMessage)
			}
		})
	}
}

// ===== HandlerTimeout 默认 ===================================================

func TestHandlerTimeout_IsAtMost4s(t *testing.T) {
	if HandlerTimeout > 5*time.Second {
		t.Errorf("HandlerTimeout=%v exceeds Q59 5s budget", HandlerTimeout)
	}
}
