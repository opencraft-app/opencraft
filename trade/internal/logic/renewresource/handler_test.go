package renewresource

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

type markCall struct {
	dealName     string
	flowType     string
	appID        string
	responseBody []byte
}

type fakeFlowStore struct {
	mu sync.Mutex

	tryAcquireFunc     func(ctx context.Context, dealName, flowType, appID string, body []byte) (bool, *store.Flow, error)
	getFlowFunc        func(ctx context.Context, dealName, flowType, appID string) (*store.Flow, error)
	markCompletedCalls []markCall
	markFailedCalls    []markCall
	markCompletedErr   error
	markFailedErr      error
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

// MarkCompletedWithResourceID — v1.7.28 BUG-18 新增方法的 fake；
// renew 链路本身不调用它（renew handler 不写 trade_flow.resource_id），仅为满足接口实现。
func (f *fakeFlowStore) MarkCompletedWithResourceID(_ context.Context, _, _, _, _ string, _ []byte) error {
	return nil
}

func (f *fakeFlowStore) MarkFailed(_ context.Context, dealName, flowType, appID string, responseBody []byte) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.markFailedCalls = append(f.markFailedCalls, markCall{dealName, flowType, appID, append([]byte(nil), responseBody...)})
	return f.markFailedErr
}

func (f *fakeFlowStore) GetFlow(ctx context.Context, dealName, flowType, appID string) (*store.Flow, error) {
	if f.getFlowFunc != nil {
		return f.getFlowFunc(ctx, dealName, flowType, appID)
	}
	return nil, store.ErrFlowNotFound
}

func (f *fakeFlowStore) ListInProgressBefore(_ context.Context, _ time.Time, _ int) ([]*store.Flow, error) {
	return nil, nil
}

// 未使用方法（renewresource 测试不行使 isolate / by-id 路径）
func (f *fakeFlowStore) TryAcquireSlotForIsolate(_ context.Context, _, _, _, _ string, _ []byte, _ *string) (bool, *store.Flow, error) {
	return false, nil, errors.New("TryAcquireSlotForIsolate not used in renewresource tests")
}
func (f *fakeFlowStore) MarkCompletedByID(_ context.Context, _ int64, _ []byte) error {
	return errors.New("MarkCompletedByID not used in renewresource tests")
}
func (f *fakeFlowStore) MarkFailedByID(_ context.Context, _ int64, _ []byte) error {
	return errors.New("MarkFailedByID not used in renewresource tests")
}
func (f *fakeFlowStore) DeleteByID(_ context.Context, _ int64) error {
	return errors.New("DeleteByID not used in renewresource tests")
}
func (f *fakeFlowStore) GetByID(_ context.Context, _ int64) (*store.Flow, error) {
	return nil, store.ErrFlowNotFound
}

type fakeCTLClient struct {
	renewFunc func(ctx context.Context, passID string, req *ctlclient.RenewPassRequest) (*ctlclient.RenewPassResponse, error)
}

// 仅实现 RenewPass，其余 9 方法返 unused error（renewresource 测试不行使其他路径）
func (f *fakeCTLClient) GetBundleByID(_ context.Context, _ string) (*ctlclient.BundleDetail, error) {
	return nil, errors.New("GetBundleByID not used in renewresource tests")
}
func (f *fakeCTLClient) ListPassesByUser(_ context.Context, _ string) ([]*ctlclient.PassDetail, error) {
	return nil, errors.New("ListPassesByUser not used in renewresource tests")
}
func (f *fakeCTLClient) CompletePass(_ context.Context, _ *ctlclient.CompletePassRequest) (*ctlclient.PassDetail, error) {
	return nil, errors.New("CompletePass not used in renewresource tests")
}
func (f *fakeCTLClient) TransferPass(_ context.Context, _ *ctlclient.TransferPassRequest) (*ctlclient.PassDetail, error) {
	return nil, errors.New("TransferPass not used in renewresource tests")
}
func (f *fakeCTLClient) ListPassAppIDs(_ context.Context, _ []string, _, _ int) ([]int64, int64, error) {
	return nil, 0, errors.New("ListPassAppIDs not used in renewresource tests")
}
func (f *fakeCTLClient) ListPassesByAppID(_ context.Context, _ int64, _ []string, _, _ int) ([]*ctlclient.PassDetail, int64, error) {
	return nil, 0, errors.New("ListPassesByAppID not used in renewresource tests")
}
func (f *fakeCTLClient) ListPassesByResourceIDs(_ context.Context, _ int64, _ []string) ([]*ctlclient.PassDetail, error) {
	return nil, errors.New("ListPassesByResourceIDs not used in renewresource tests")
}
func (f *fakeCTLClient) IsolatePass(_ context.Context, _ string, _ *ctlclient.IsolatePassRequest) (*ctlclient.IsolatePassResponse, error) {
	return nil, errors.New("IsolatePass not used in renewresource tests")
}
func (f *fakeCTLClient) RenewPass(ctx context.Context, passID string, req *ctlclient.RenewPassRequest) (*ctlclient.RenewPassResponse, error) {
	return f.renewFunc(ctx, passID, req)
}

func (f *fakeCTLClient) DestroyPass(_ context.Context, _ string, _ *ctlclient.DestroyPassRequest) (*ctlclient.DestroyPassResponse, error) {
	return nil, errors.New("DestroyPass not used in renewresource tests")
}

// ===== 测试 helper =============================================================

func newBuilder() *jifei.FrameworkBuilder {
	return jifei.NewFrameworkBuilder("trade", "1.0")
}

// validOrder 返回一个标准的 renew 类型 trade_order，便于子测试微调字段。
func validOrder() *store.TradeOrder {
	return &store.TradeOrder{
		ID:             1,
		BigOrderID:     "big-1",
		DealName:       "deal-r1",
		ExternalUserID: "user-1",
		Uin:            "12345",
		AppID:          "67890",
		BundleID:       "bdl-x",
		OrderType:      store.OrderTypeRenew,
		Period:         1,
		TimeUnit:       "m",
		GoodsNum:       1,
		ResourceType:   "pass",
		ResourceID:     "pass-r1",
		Status:         "pending_pay",
	}
}

// stdParaMap 构造一份合法 renewResource para（map 形式，便于个别字段覆盖）。
func stdParaMap() map[string]any {
	return map[string]any{
		"dealName":   "deal-r1",
		"appId":      int64(67890),
		"uin":        "12345",
		"resourceId": "pass-r1",
		"goodsNum":   1,
		"goodsDetail": map[string]any{
			"timeSpan": 1,
			"timeUnit": "m",
		},
	}
}

// callHandler 用给定 deps + para map 调用 handler，返回 framework 响应。
func callHandler(t *testing.T, deps Deps, para map[string]any) jifei.Framework {
	t.Helper()
	raw, err := json.Marshal(para)
	if err != nil {
		t.Fatalf("marshal para: %v", err)
	}
	h := makeHandler(deps)
	resp, err := h(context.Background(), raw)
	if err != nil {
		t.Fatalf("handler returned error (should never happen, errors are mapped to framework): %v", err)
	}
	return resp
}

// winnerAcquire 是 fakeFlowStore.TryAcquireSlot 的 winner 默认实现。
func winnerAcquire(_ context.Context, _, _, _ string, _ []byte) (bool, *store.Flow, error) {
	return true, nil, nil
}

// winnerGetFlow 是 fakeFlowStore.GetFlow 的 winner 默认实现（v1.7.28 BUG-28）。
// renewresource handler 赢家路径会重查一次拿 trade_flow.id 作为 flowId 返回。
// 这里返回一个 ID=42 的伪 flow 允许主链路走完（ID 具体值不影响逻辑，仅需非 0）。
func winnerGetFlow(_ context.Context, dealName, flowType, appID string) (*store.Flow, error) {
	return &store.Flow{
		ID:       testWinnerFlowID,
		DealName: dealName,
		FlowType: flowType,
		AppID:    appID,
		Status:   store.FlowStatusInProgress,
	}, nil
}

// testWinnerFlowID 是 winner 路径下 fakeFlowStore.GetFlow 返回的 trade_flow.id。
// 选 42 只为可读性，任何非 0 值都合法（PDF 协议仅要求 flowId != 0）。
const testWinnerFlowID int64 = 42

// makeWinnerDeps 构造一组默认 winner 路径的 Deps。
func makeWinnerDeps(orderFn func(context.Context, string) (*store.TradeOrder, error),
	ctlFn func(context.Context, string, *ctlclient.RenewPassRequest) (*ctlclient.RenewPassResponse, error)) (Deps, *fakeFlowStore) {
	flow := &fakeFlowStore{
		tryAcquireFunc: winnerAcquire,
		getFlowFunc:    winnerGetFlow,
	}
	return Deps{
		OrderStore: &fakeOrderStore{getFunc: orderFn},
		FlowStore:  flow,
		CTLClient:  &fakeCTLClient{renewFunc: ctlFn},
		Builder:    newBuilder(),
	}, flow
}

// ===== 测试：InvalidPara (600501) ============================================

func TestHandler_InvalidPara_BadJSON(t *testing.T) {
	deps, _ := makeWinnerDeps(nil, nil)
	h := makeHandler(deps)
	resp, err := h(context.Background(), json.RawMessage([]byte("not-a-json")))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.ReturnCode != ReturnCodeInvalidPara {
		t.Errorf("expect %d, got %d", ReturnCodeInvalidPara, resp.ReturnCode)
	}
	if resp.ReturnCode != resp.ReturnValue {
		t.Errorf("Q58 invariant broken: returnCode=%d returnValue=%d", resp.ReturnCode, resp.ReturnValue)
	}
}

func TestHandler_InvalidPara_MissingDealName(t *testing.T) {
	deps, _ := makeWinnerDeps(nil, nil)
	p := stdParaMap()
	delete(p, "dealName")
	resp := callHandler(t, deps, p)
	if resp.ReturnCode != ReturnCodeInvalidPara {
		t.Errorf("expect %d, got %d (msg=%s)", ReturnCodeInvalidPara, resp.ReturnCode, resp.ReturnMessage)
	}
}

func TestHandler_InvalidPara_MissingAppID(t *testing.T) {
	deps, _ := makeWinnerDeps(nil, nil)
	p := stdParaMap()
	delete(p, "appId")
	resp := callHandler(t, deps, p)
	if resp.ReturnCode != ReturnCodeInvalidPara {
		t.Errorf("expect %d, got %d", ReturnCodeInvalidPara, resp.ReturnCode)
	}
}

func TestHandler_InvalidPara_MissingResourceID(t *testing.T) {
	// renewResource 强约束 resourceId（与 createresource 差异点）
	deps, _ := makeWinnerDeps(nil, nil)
	p := stdParaMap()
	delete(p, "resourceId")
	resp := callHandler(t, deps, p)
	if resp.ReturnCode != ReturnCodeInvalidPara {
		t.Errorf("expect %d, got %d", ReturnCodeInvalidPara, resp.ReturnCode)
	}
	if !strings.Contains(resp.ReturnMessage, "resourceId") {
		t.Errorf("expect msg mention resourceId, got %q", resp.ReturnMessage)
	}
}

// v1.7.28 BUG-14 同模式修复后 TestHandler_InvalidPara_GoodsNumZero 已删除：
// jifei renewResource 顶层不发 goodsNum（PDF §请求参数 + 实测 callback），只在
// goodsDetail.goodsNum 嵌套；trade callbackPara.GoodsNum 顶层字段保留但不再校验。

// ===== 测试：trade_order 反查降级语义（v1.7.28 BUG-25 修订 2026-05-21）=========
//
// BUG-25 修订前：runMainFlow Step T2 强依赖 trade_order 反查（找不到 → 600502 B 类；
// DB 错 → 600504 B 类；order_type/resource_type/resource_id 不一致 → A 类退款）。
// 但 PlaceRenewOrderAndPay 时序问题导致 jifei 同步推 renewResource 早于 trade INSERT
// trade_order，T2 永远 600502 + trade_flow 抢占 in_progress 死锁。
//
// BUG-25 修订：runMainFlow 完全脱离 trade_order 反查，直接从 jifei 入参 + goodsDetail
// 调 ctl.RenewPass，失败 / 找不到 / 数据漂移都不阻塞主链路。
//
// **v1.7.32 BUG-XX 修订（2026-06-08）**：进一步删除 BUG-25 遗留的“trade_order.resource_id
// 已回填 → 幂等回放”分支。该分支误适配续费场景（续费的 trade_order.resource_id 在
// PlaceRenewOrder INSERT 时即写入 pass_id，非新购“createResource 后回填”语义），导致首次正常
// jifei 回调即被误判为“已发货回放”，跳过 ctl.RenewPass 调用。jifei 重投同 dealName 的幂等保护由
// 外层 TryAcquireSlot + handleLoser 完整覆盖，OrderStore 在 runMainFlow 中不再被调用。
//
// 旧测试：TestHandler_OrderNotFound_BClass / TestHandler_OrderStoreInfraError_BClass /
// TestHandler_OrderTypeNotRenew_Refund / TestHandler_ResourceTypeNotPass_Refund /
// TestHandler_ResourceIDEmpty_Refund / TestHandler_ResourceIDDriftWithJifei_Refund
// 共 6 条已删除（语义不再适用，与 BUG-25 同步删除）。
// TestHandler_IdempotentReplayWhenOrderHasResourceID 已删除（v1.7.32 BUG-XX）。
// 保留以下两条 fallthrough 覆盖新语义。

// TestHandler_OrderNotFound_FallthroughToCTL: trade_order 找不到也正常走 ctl.RenewPass
// 主链路（最常见的场景：jifei 同步推回调早于 PlaceRenewOrderAndPay INSERT trade_order，
// 即原 BUG-25 死锁触发条件）。
func TestHandler_OrderNotFound_FallthroughToCTL(t *testing.T) {
	deps, flow := makeWinnerDeps(
		func(_ context.Context, _ string) (*store.TradeOrder, error) {
			return nil, store.ErrTradeOrderNotFound
		},
		func(_ context.Context, passID string, req *ctlclient.RenewPassRequest) (*ctlclient.RenewPassResponse, error) {
			// 期望：handler 直接用 para.ResourceID 调 ctl，不依赖 trade_order
			if passID != "pass-r1" {
				t.Errorf("expect passID from para.ResourceID, got %q", passID)
			}
			if req.TimeSpan != 1 || req.TimeUnit != "m" {
				t.Errorf("expect TimeSpan/TimeUnit from goodsDetail, got %+v", req)
			}
			return &ctlclient.RenewPassResponse{PassID: "pass-r1", TaskID: "task-1"}, nil
		},
	)
	resp := callHandler(t, deps, stdParaMap())
	if resp.ReturnCode != 0 {
		t.Errorf("expect success (fallthrough), got %d msg=%s", resp.ReturnCode, resp.ReturnMessage)
	}
	if len(flow.markCompletedCalls) != 1 {
		t.Errorf("expect MarkCompleted, got %d", len(flow.markCompletedCalls))
	}
}

// TestHandler_OrderStoreInfraError_FallthroughToCTL: trade_order DB 错也不阻塞主链路。
func TestHandler_OrderStoreInfraError_FallthroughToCTL(t *testing.T) {
	deps, _ := makeWinnerDeps(
		func(_ context.Context, _ string) (*store.TradeOrder, error) {
			return nil, errors.New("db conn refused")
		},
		func(_ context.Context, _ string, _ *ctlclient.RenewPassRequest) (*ctlclient.RenewPassResponse, error) {
			return &ctlclient.RenewPassResponse{PassID: "pass-r1"}, nil
		},
	)
	resp := callHandler(t, deps, stdParaMap())
	if resp.ReturnCode != 0 {
		t.Errorf("expect success (fallthrough on DB err), got %d", resp.ReturnCode)
	}
}

// ===== 测试：ctl RenewPass 错误归并 ===========================================

func TestHandler_CTLPassNotFound_Refund(t *testing.T) {
	// v1.7.28 BUG-25 修订：order 改为不存在（fallthrough 路径），不再走 trade_order 反查
	deps, _ := makeWinnerDeps(
		func(_ context.Context, _ string) (*store.TradeOrder, error) { return nil, store.ErrTradeOrderNotFound },
		func(_ context.Context, _ string, _ *ctlclient.RenewPassRequest) (*ctlclient.RenewPassResponse, error) {
			return nil, ctlclient.ErrNotFound
		},
	)
	resp := callHandler(t, deps, stdParaMap())
	if resp.ReturnCode != jifei.RefundReturnCode {
		t.Errorf("expect refund (PassNotFound), got %d", resp.ReturnCode)
	}
}

// 注：以下 ctl 错误归并测试 v1.7.28 BUG-25 修订前都基于 "order=validOrder() 走
// trade_order 反查路径 → ctl 调用错" 的两段式 mock；修订后 trade_order 反查仅作
// 幂等回放可选检查（命中 resource_id 才回放），未命中（或 ResourceID=""）就直接走
// ctl 主链路。下列 case 用 order.ResourceID="" 让幂等回放短路失效，进入 ctl 主链路。

func TestHandler_CTLPassRenewing_Refund(t *testing.T) {
	order := validOrder()
	order.ResourceID = "" // BUG-25 修订：让幂等回放路径短路失效，进入 ctl 主链路
	deps, _ := makeWinnerDeps(
		func(_ context.Context, _ string) (*store.TradeOrder, error) { return order, nil },
		func(_ context.Context, _ string, _ *ctlclient.RenewPassRequest) (*ctlclient.RenewPassResponse, error) {
			return nil, &ctlclient.Error{
				HTTPStatus: 403,
				Code:       ctlclient.ErrCodePassRenewing,
				Message:    "pass already renewing",
				RequestID:  "req-1",
			}
		},
	)
	resp := callHandler(t, deps, stdParaMap())
	if resp.ReturnCode != jifei.RefundReturnCode {
		t.Errorf("expect refund (PassRenewing concurrent), got %d", resp.ReturnCode)
	}
}

func TestHandler_CTLPassNotRenewable_Refund(t *testing.T) {
	order := validOrder()
	order.ResourceID = ""
	deps, _ := makeWinnerDeps(
		func(_ context.Context, _ string) (*store.TradeOrder, error) { return order, nil },
		func(_ context.Context, _ string, _ *ctlclient.RenewPassRequest) (*ctlclient.RenewPassResponse, error) {
			return nil, &ctlclient.Error{
				HTTPStatus: 403,
				Code:       ctlclient.ErrCodePassNotRenewable,
				Message:    "pass isolated/deleted",
				RequestID:  "req-2",
			}
		},
	)
	resp := callHandler(t, deps, stdParaMap())
	if resp.ReturnCode != jifei.RefundReturnCode {
		t.Errorf("expect refund (PassNotRenewable), got %d", resp.ReturnCode)
	}
}

func TestHandler_CTLPassNotFoundCode_Refund(t *testing.T) {
	order := validOrder()
	order.ResourceID = ""
	deps, _ := makeWinnerDeps(
		func(_ context.Context, _ string) (*store.TradeOrder, error) { return order, nil },
		func(_ context.Context, _ string, _ *ctlclient.RenewPassRequest) (*ctlclient.RenewPassResponse, error) {
			return nil, &ctlclient.Error{
				HTTPStatus: 404,
				Code:       ctlclient.ErrCodePassNotFound,
				Message:    "pass not found",
				RequestID:  "req-3",
			}
		},
	)
	resp := callHandler(t, deps, stdParaMap())
	if resp.ReturnCode != jifei.RefundReturnCode {
		t.Errorf("expect refund (PassNotFound code), got %d", resp.ReturnCode)
	}
}

func TestHandler_CTLPassRenewNotImplement_BClass(t *testing.T) {
	order := validOrder()
	order.ResourceID = ""
	deps, _ := makeWinnerDeps(
		func(_ context.Context, _ string) (*store.TradeOrder, error) { return order, nil },
		func(_ context.Context, _ string, _ *ctlclient.RenewPassRequest) (*ctlclient.RenewPassResponse, error) {
			return nil, &ctlclient.Error{
				HTTPStatus: 501,
				Code:       ctlclient.ErrCodePassRenewNotImplement,
				Message:    "cvm async not implemented",
				RequestID:  "req-4",
			}
		},
	)
	resp := callHandler(t, deps, stdParaMap())
	if resp.ReturnCode != ReturnCodeUpstreamUnavailable {
		t.Errorf("expect %d (B class for 501 placeholder), got %d", ReturnCodeUpstreamUnavailable, resp.ReturnCode)
	}
	if resp.ReturnCode == jifei.RefundReturnCode {
		t.Errorf("PASS_RENEW_NOT_IMPLEMENTED MUST NOT trigger refund")
	}
}

func TestHandler_CTLOther4xx_Refund(t *testing.T) {
	order := validOrder()
	order.ResourceID = ""
	deps, _ := makeWinnerDeps(
		func(_ context.Context, _ string) (*store.TradeOrder, error) { return order, nil },
		func(_ context.Context, _ string, _ *ctlclient.RenewPassRequest) (*ctlclient.RenewPassResponse, error) {
			return nil, &ctlclient.Error{
				HTTPStatus: 400,
				Code:       ctlclient.ErrCodePassInvalidParam,
				Message:    "invalid param",
				RequestID:  "req-5",
			}
		},
	)
	resp := callHandler(t, deps, stdParaMap())
	if resp.ReturnCode != jifei.RefundReturnCode {
		t.Errorf("expect refund (other 4xx), got %d", resp.ReturnCode)
	}
}

func TestHandler_CTLUnauthorized_BClass(t *testing.T) {
	order := validOrder()
	order.ResourceID = ""
	deps, _ := makeWinnerDeps(
		func(_ context.Context, _ string) (*store.TradeOrder, error) { return order, nil },
		func(_ context.Context, _ string, _ *ctlclient.RenewPassRequest) (*ctlclient.RenewPassResponse, error) {
			return nil, ctlclient.ErrUnauthorized
		},
	)
	resp := callHandler(t, deps, stdParaMap())
	if resp.ReturnCode != ReturnCodeUpstreamUnavailable {
		t.Errorf("expect %d (B class for unauthorized), got %d", ReturnCodeUpstreamUnavailable, resp.ReturnCode)
	}
}

func TestHandler_CTL5xx_BClass(t *testing.T) {
	order := validOrder()
	order.ResourceID = ""
	deps, _ := makeWinnerDeps(
		func(_ context.Context, _ string) (*store.TradeOrder, error) { return order, nil },
		func(_ context.Context, _ string, _ *ctlclient.RenewPassRequest) (*ctlclient.RenewPassResponse, error) {
			return nil, &ctlclient.Error{
				HTTPStatus: 500,
				Code:       "INTERNAL",
				Message:    "ctl down",
				RequestID:  "req-6",
			}
		},
	)
	resp := callHandler(t, deps, stdParaMap())
	if resp.ReturnCode != ReturnCodeUpstreamUnavailable {
		t.Errorf("expect %d (B class for 5xx), got %d", ReturnCodeUpstreamUnavailable, resp.ReturnCode)
	}
}

func TestHandler_CTLNetworkError_BClass(t *testing.T) {
	order := validOrder()
	order.ResourceID = ""
	deps, _ := makeWinnerDeps(
		func(_ context.Context, _ string) (*store.TradeOrder, error) { return order, nil },
		func(_ context.Context, _ string, _ *ctlclient.RenewPassRequest) (*ctlclient.RenewPassResponse, error) {
			return nil, errors.New("dial tcp: connection refused")
		},
	)
	resp := callHandler(t, deps, stdParaMap())
	if resp.ReturnCode != ReturnCodeUpstreamUnavailable {
		t.Errorf("expect %d (B class for network), got %d", ReturnCodeUpstreamUnavailable, resp.ReturnCode)
	}
}

func TestHandler_CTLEmptyPassID_BClass(t *testing.T) {
	order := validOrder()
	order.ResourceID = ""
	deps, _ := makeWinnerDeps(
		func(_ context.Context, _ string) (*store.TradeOrder, error) { return order, nil },
		func(_ context.Context, _ string, _ *ctlclient.RenewPassRequest) (*ctlclient.RenewPassResponse, error) {
			return &ctlclient.RenewPassResponse{PassID: "", TaskID: ""}, nil
		},
	)
	resp := callHandler(t, deps, stdParaMap())
	if resp.ReturnCode != ReturnCodeUpstreamUnavailable {
		t.Errorf("expect %d (empty passId), got %d", ReturnCodeUpstreamUnavailable, resp.ReturnCode)
	}
}

// ===== 测试：Happy path =======================================================

// TestHandler_HappyPath_RenewSuccess: 走 ctl 主链路（v1.7.28 BUG-25 修订后
// trade_order.resource_id="" 时不命中幂等回放，正常调 ctl.RenewPass）。
func TestHandler_HappyPath_RenewSuccess(t *testing.T) {
	order := validOrder()
	order.ResourceID = "" // BUG-25 修订：避免命中幂等回放路径，走 ctl 主链路
	var capturedReq *ctlclient.RenewPassRequest
	var capturedPassID string
	deps, flow := makeWinnerDeps(
		func(_ context.Context, _ string) (*store.TradeOrder, error) { return order, nil },
		func(_ context.Context, passID string, req *ctlclient.RenewPassRequest) (*ctlclient.RenewPassResponse, error) {
			capturedPassID = passID
			capturedReq = req
			return &ctlclient.RenewPassResponse{PassID: "pass-r1", TaskID: "task-renew-1"}, nil
		},
	)
	resp := callHandler(t, deps, stdParaMap())
	if resp.ReturnCode != 0 {
		t.Fatalf("expect success (0), got %d msg=%s", resp.ReturnCode, resp.ReturnMessage)
	}
	if resp.ReturnValue != 0 {
		t.Errorf("Q58 invariant: returnValue must be 0, got %d", resp.ReturnValue)
	}
	// 验证 ctl 入参
	if capturedPassID != "pass-r1" {
		t.Errorf("expect passID=pass-r1, got %s", capturedPassID)
	}
	if capturedReq == nil {
		t.Fatalf("ctl req nil")
	}
	if capturedReq.TimeSpan != 1 || capturedReq.TimeUnit != "m" || capturedReq.DealName != "deal-r1" {
		t.Errorf("ctl req mismatch: %+v", capturedReq)
	}
	// 验证收尾走 MarkCompleted
	if len(flow.markCompletedCalls) != 1 {
		t.Errorf("expect 1 MarkCompleted call, got %d", len(flow.markCompletedCalls))
	}
	mc := flow.markCompletedCalls[0]
	if mc.dealName != "deal-r1" || mc.flowType != store.FlowTypeRenewResource || mc.appID != "67890" {
		t.Errorf("MarkCompleted args mismatch: %+v", mc)
	}
	// 验证响应 data.flowId（PDF renewResource.pdf §3.2 要 int 不为 0，BUG-28 修订）
	if got, ok := resp.Data["flowId"].(int64); !ok || got != testWinnerFlowID {
		t.Errorf("expect data.flowId=%d, got %v", testWinnerFlowID, resp.Data["flowId"])
	}
}

// ===== 测试：抢占式幂等三分支 =================================================

func TestHandler_LoserPathInProgress(t *testing.T) {
	flow := &fakeFlowStore{
		tryAcquireFunc: func(_ context.Context, _, _, _ string, _ []byte) (bool, *store.Flow, error) {
			return false, &store.Flow{
				DealName: "deal-r1",
				Status:   store.FlowStatusInProgress,
			}, nil
		},
	}
	deps := Deps{
		OrderStore: &fakeOrderStore{},
		FlowStore:  flow,
		CTLClient:  &fakeCTLClient{},
		Builder:    newBuilder(),
	}
	resp := callHandler(t, deps, stdParaMap())
	if resp.ReturnCode != ReturnCodeFlowInProgress {
		t.Errorf("expect %d, got %d", ReturnCodeFlowInProgress, resp.ReturnCode)
	}
	// loser 路径不应触发 MarkCompleted/MarkFailed
	if len(flow.markCompletedCalls) != 0 || len(flow.markFailedCalls) != 0 {
		t.Errorf("loser path must not write trade_flow status")
	}
}

func TestHandler_LoserPathCompletedReplay(t *testing.T) {
	// 构造一个合法的成功响应做回放（PDF 协议：data.flowId int 不为 0，BUG-28 修订）
	prev := newBuilder().NewSuccess(map[string]any{"flowId": int64(999)})
	body, _ := json.Marshal(prev)
	flow := &fakeFlowStore{
		tryAcquireFunc: func(_ context.Context, _, _, _ string, _ []byte) (bool, *store.Flow, error) {
			return false, &store.Flow{
				DealName:     "deal-r1",
				Status:       store.FlowStatusCompleted,
				ResponseBody: body,
			}, nil
		},
	}
	deps := Deps{
		OrderStore: &fakeOrderStore{},
		FlowStore:  flow,
		CTLClient:  &fakeCTLClient{},
		Builder:    newBuilder(),
	}
	resp := callHandler(t, deps, stdParaMap())
	if resp.ReturnCode != 0 {
		t.Errorf("expect replayed success (0), got %d", resp.ReturnCode)
	}
	// replay 路径：response_body 反序列化后数字变为 float64（encoding/json 默认行为）
	if got, ok := resp.Data["flowId"].(float64); !ok || int64(got) != 999 {
		t.Errorf("expect replayed flowId=999, got %v (type %T)", resp.Data["flowId"], resp.Data["flowId"])
	}
}

func TestHandler_LoserPathFailedReplayRefund(t *testing.T) {
	prev := newBuilder().NewRefund()
	body, _ := json.Marshal(prev)
	flow := &fakeFlowStore{
		tryAcquireFunc: func(_ context.Context, _, _, _ string, _ []byte) (bool, *store.Flow, error) {
			return false, &store.Flow{
				DealName:     "deal-r1",
				Status:       store.FlowStatusFailed,
				ResponseBody: body,
			}, nil
		},
	}
	deps := Deps{
		OrderStore: &fakeOrderStore{},
		FlowStore:  flow,
		CTLClient:  &fakeCTLClient{},
		Builder:    newBuilder(),
	}
	resp := callHandler(t, deps, stdParaMap())
	if resp.ReturnCode != jifei.RefundReturnCode {
		t.Errorf("expect replayed refund, got %d", resp.ReturnCode)
	}
}

func TestHandler_LoserPathCompletedCorruptedBody(t *testing.T) {
	// response_body 不变量破坏 (returnCode != returnValue) → 走 corrupted 兜底
	bad := jifei.Framework{ReturnCode: 0, ReturnValue: 42, ComponentName: "trade", Version: "1.0"}
	body, _ := json.Marshal(bad)
	flow := &fakeFlowStore{
		tryAcquireFunc: func(_ context.Context, _, _, _ string, _ []byte) (bool, *store.Flow, error) {
			return false, &store.Flow{
				DealName:     "deal-r1",
				Status:       store.FlowStatusCompleted,
				ResponseBody: body,
			}, nil
		},
	}
	deps := Deps{
		OrderStore: &fakeOrderStore{},
		FlowStore:  flow,
		CTLClient:  &fakeCTLClient{},
		Builder:    newBuilder(),
	}
	resp := callHandler(t, deps, stdParaMap())
	if resp.ReturnCode != ReturnCodeFlowReplayCorrupted {
		t.Errorf("expect %d (corrupted), got %d", ReturnCodeFlowReplayCorrupted, resp.ReturnCode)
	}
}

func TestHandler_LoserPathCompletedEmptyBody(t *testing.T) {
	flow := &fakeFlowStore{
		tryAcquireFunc: func(_ context.Context, _, _, _ string, _ []byte) (bool, *store.Flow, error) {
			return false, &store.Flow{
				DealName:     "deal-r1",
				Status:       store.FlowStatusCompleted,
				ResponseBody: nil,
			}, nil
		},
	}
	deps := Deps{
		OrderStore: &fakeOrderStore{},
		FlowStore:  flow,
		CTLClient:  &fakeCTLClient{},
		Builder:    newBuilder(),
	}
	resp := callHandler(t, deps, stdParaMap())
	if resp.ReturnCode != ReturnCodeFlowReplayCorrupted {
		t.Errorf("expect %d (corrupted/empty), got %d", ReturnCodeFlowReplayCorrupted, resp.ReturnCode)
	}
}

func TestHandler_LoserPathUnknownStatus(t *testing.T) {
	flow := &fakeFlowStore{
		tryAcquireFunc: func(_ context.Context, _, _, _ string, _ []byte) (bool, *store.Flow, error) {
			return false, &store.Flow{
				DealName: "deal-r1",
				Status:   "weird-state",
			}, nil
		},
	}
	deps := Deps{
		OrderStore: &fakeOrderStore{},
		FlowStore:  flow,
		CTLClient:  &fakeCTLClient{},
		Builder:    newBuilder(),
	}
	resp := callHandler(t, deps, stdParaMap())
	if resp.ReturnCode != ReturnCodeUpstreamUnavailable {
		t.Errorf("expect %d (unknown status), got %d", ReturnCodeUpstreamUnavailable, resp.ReturnCode)
	}
}

func TestHandler_LoserPathExistingNil_Defensive(t *testing.T) {
	flow := &fakeFlowStore{
		tryAcquireFunc: func(_ context.Context, _, _, _ string, _ []byte) (bool, *store.Flow, error) {
			return false, nil, nil
		},
	}
	deps := Deps{
		OrderStore: &fakeOrderStore{},
		FlowStore:  flow,
		CTLClient:  &fakeCTLClient{},
		Builder:    newBuilder(),
	}
	resp := callHandler(t, deps, stdParaMap())
	if resp.ReturnCode != ReturnCodeUpstreamUnavailable {
		t.Errorf("expect %d, got %d", ReturnCodeUpstreamUnavailable, resp.ReturnCode)
	}
}

// ===== 测试：TryAcquireSlot 基础设施错 → B 类 ================================

func TestHandler_TryAcquireInfraError_BClass(t *testing.T) {
	flow := &fakeFlowStore{
		tryAcquireFunc: func(_ context.Context, _, _, _ string, _ []byte) (bool, *store.Flow, error) {
			return false, nil, errors.New("db deadlock")
		},
	}
	deps := Deps{
		OrderStore: &fakeOrderStore{},
		FlowStore:  flow,
		CTLClient:  &fakeCTLClient{},
		Builder:    newBuilder(),
	}
	resp := callHandler(t, deps, stdParaMap())
	if resp.ReturnCode != ReturnCodeUpstreamUnavailable {
		t.Errorf("expect %d, got %d", ReturnCodeUpstreamUnavailable, resp.ReturnCode)
	}
}

// ===== 测试：Install 注册 + 重复注册 panic ====================================

func TestInstall_RegistersHandler(t *testing.T) {
	d := jifei.NewDispatcher("lightvela", newBuilder())
	deps := Deps{
		OrderStore: &fakeOrderStore{getFunc: func(_ context.Context, _ string) (*store.TradeOrder, error) {
			o := validOrder()
			o.ResourceID = "" // BUG-25 修订：让幂等回放路径短路，验证 Install 后 ctl 主链路可达
			return o, nil
		}},
		FlowStore: &fakeFlowStore{tryAcquireFunc: winnerAcquire, getFlowFunc: winnerGetFlow},
		CTLClient: &fakeCTLClient{
			renewFunc: func(_ context.Context, _ string, _ *ctlclient.RenewPassRequest) (*ctlclient.RenewPassResponse, error) {
				return &ctlclient.RenewPassResponse{PassID: "pass-r1"}, nil
			},
		},
		Builder: newBuilder(),
	}
	Install(d, deps)
	names := d.RegisteredInterfaceNames()
	found := false
	for _, n := range names {
		if n == jifei.InterfaceNameRenewResource {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("expect renewResource registered, got %v", names)
	}
}

func TestInstall_DuplicateRegisterPanics(t *testing.T) {
	d := jifei.NewDispatcher("lightvela", newBuilder())
	deps := Deps{
		OrderStore: &fakeOrderStore{},
		FlowStore:  &fakeFlowStore{tryAcquireFunc: winnerAcquire, getFlowFunc: winnerGetFlow},
		CTLClient:  &fakeCTLClient{},
		Builder:    newBuilder(),
	}
	Install(d, deps)
	defer func() {
		if r := recover(); r == nil {
			t.Errorf("expected panic on duplicate Register, got none")
		}
	}()
	Install(d, deps) // 第二次注册同名 interface → panic（Q60 拍板）
}

// ===== 测试：FlowType 常量与 trade_flow 一致 ==================================

func TestFlowType_RenewResource(t *testing.T) {
	if flowType != "renew_resource" {
		t.Errorf("flowType must be renew_resource, got %q", flowType)
	}
	if flowType != store.FlowTypeRenewResource {
		t.Errorf("flowType drift from store.FlowTypeRenewResource")
	}
}
