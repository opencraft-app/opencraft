// Package destroyresource v1.7.31 前置幂等捷径单测。
//
// 背景：jifei 销毁回调存在重投行为（例如 destroy ack 后再次下发同 resourceId 的 destroyResource），
// 对已被物理销毁（INSERT history_pass + DELETE pass）的 pass 反复触发会让 trade 抢 slot + 反向调
// ctl DestroyPass，ctl 因 pass 不存在返 PASS_NOT_FOUND/404 被映射为 600403，业务感知为"销毁报错"。
//
// 修复：在 §3.4 抢占式幂等之前增加 ctl ListPassesByResourceIDs 前置查询：
//   - pass 不存在（返空数组）= 已物理销毁/未曾存在 → 幂等返成功不带 flowId
//   - pass 仍存在（任意状态）= 销毁未完成 → 继续走原抢占式路径
//   - 查询失败 → best-effort 降级走原 §3.4 路径（不阻塞）
package destroyresource

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"

	"git.woa.com/wisp/mono/trade/internal/ctlclient"
	"git.woa.com/wisp/mono/trade/internal/store"
)

// TestHandler_IdempotentShortcut_PassNotFound ctl 反查返空数组（pass 已物理销毁
// 或从未存在）→ 不抢 slot、不调 ctl DestroyPass、立即幂等返成功不带 flowId。
func TestHandler_IdempotentShortcut_PassNotFound(t *testing.T) {
	flow := &fakeFlowStore{
		tryAcquireIsolateFunc: func(_ context.Context, _, _, _, _ string, _ []byte) (bool, *store.Flow, error) {
			t.Fatalf("TryAcquireSlotForIsolate MUST NOT be called when pass not found")
			return false, nil, nil
		},
	}
	ctl := &fakeCTLClient{
		listPassesByResourceIDsFunc: func(_ context.Context, appID int64, passIDs []string) ([]*ctlclient.PassDetail, error) {
			if appID != 251000001 || len(passIDs) != 1 || passIDs[0] != "lhins-abcd1234" {
				t.Errorf("unexpected ctl query args: appID=%d passIDs=%v", appID, passIDs)
			}
			return []*ctlclient.PassDetail{}, nil
		},
		destroyFunc: func(_ context.Context, _ string, _ *ctlclient.DestroyPassRequest) (*ctlclient.DestroyPassResponse, error) {
			t.Fatalf("CTLClient.DestroyPass MUST NOT be called when pass not found")
			return nil, nil
		},
	}
	deps := newDeps(flow, ctl)

	resp, _ := makeHandler(deps)(context.Background(), paraJSON(t, defaultPara()))
	if resp.ReturnCode != 0 {
		t.Fatalf("expected idempotent success returnCode=0, got %d msg=%q", resp.ReturnCode, resp.ReturnMessage)
	}
	if _, ok := resp.Data["flowId"]; ok {
		t.Errorf("data.flowId MUST NOT be present on idempotent shortcut, got %v", resp.Data["flowId"])
	}
	if len(flow.deleteByIDCalls) != 0 {
		t.Errorf("DeleteByID MUST NOT be called on idempotent shortcut, got %d calls", len(flow.deleteByIDCalls))
	}
}

// TestHandler_IdempotentShortcut_PassStillExists_ContinuesToAcquireSlot
// ctl 反查命中 pass（pass 仍存在，无论 IsolatedTime 是否非 nil）→ 销毁未完成，
// 必须继续走 §3.4 抢占式幂等推进销毁主链。
//
// 与 isolateresource 不同：destroy 链路不能把 IsolatedTime != nil 当作终态短路，
// 因为 isolated 状态的 pass 仍需走 destroy 把它真正销毁掉。
func TestHandler_IdempotentShortcut_PassStillExists_ContinuesToAcquireSlot(t *testing.T) {
	const wantFlowID int64 = 7777

	var acquireCalls int32
	flow := &fakeFlowStore{
		tryAcquireIsolateFunc: func(_ context.Context, _, _, _, _ string, _ []byte) (bool, *store.Flow, error) {
			atomic.AddInt32(&acquireCalls, 1)
			return true, &store.Flow{ID: wantFlowID, Status: store.FlowStatusInProgress}, nil
		},
	}
	var destroyCalls int32
	ctl := &fakeCTLClient{
		listPassesByResourceIDsFunc: func(_ context.Context, _ int64, _ []string) ([]*ctlclient.PassDetail, error) {
			// 返回 pass 仍存在（无论什么状态都不应短路）
			return []*ctlclient.PassDetail{
				{PassID: "lhins-abcd1234"},
			}, nil
		},
		destroyFunc: func(_ context.Context, _ string, _ *ctlclient.DestroyPassRequest) (*ctlclient.DestroyPassResponse, error) {
			atomic.AddInt32(&destroyCalls, 1)
			return &ctlclient.DestroyPassResponse{TaskID: "task-pass-still-exists"}, nil
		},
	}
	deps := newDeps(flow, ctl)

	resp, _ := makeHandler(deps)(context.Background(), paraJSON(t, defaultPara()))
	if resp.ReturnCode != 0 {
		t.Fatalf("expected acquire-slot success returnCode=0, got %d msg=%q", resp.ReturnCode, resp.ReturnMessage)
	}
	if atomic.LoadInt32(&acquireCalls) != 1 {
		t.Errorf("expected TryAcquireSlotForIsolate to be called once, got %d", acquireCalls)
	}
	if atomic.LoadInt32(&destroyCalls) != 1 {
		t.Errorf("expected CTLClient.DestroyPass to be called once, got %d", destroyCalls)
	}
	gotFlowID, _ := resp.Data["flowId"].(int64)
	if gotFlowID != wantFlowID {
		t.Errorf("expected data.flowId=%d (acquire-slot path), got %v", wantFlowID, resp.Data["flowId"])
	}
}

// TestHandler_IdempotentShortcut_CTLQueryFailure_DegradesToAcquireSlot
// ctl 反查失败（网络/超时/5xx）→ best-effort 降级走原 §3.4 抢占式幂等路径，不阻塞返回。
func TestHandler_IdempotentShortcut_CTLQueryFailure_DegradesToAcquireSlot(t *testing.T) {
	const wantFlowID int64 = 5555

	var acquireCalls int32
	flow := &fakeFlowStore{
		tryAcquireIsolateFunc: func(_ context.Context, _, _, _, _ string, _ []byte) (bool, *store.Flow, error) {
			atomic.AddInt32(&acquireCalls, 1)
			return true, &store.Flow{ID: wantFlowID, Status: store.FlowStatusInProgress}, nil
		},
	}
	var destroyCalls int32
	ctl := &fakeCTLClient{
		listPassesByResourceIDsFunc: func(_ context.Context, _ int64, _ []string) ([]*ctlclient.PassDetail, error) {
			return nil, errors.New("ctl 5xx / network error")
		},
		destroyFunc: func(_ context.Context, _ string, _ *ctlclient.DestroyPassRequest) (*ctlclient.DestroyPassResponse, error) {
			atomic.AddInt32(&destroyCalls, 1)
			return &ctlclient.DestroyPassResponse{TaskID: "task-degraded"}, nil
		},
	}
	deps := newDeps(flow, ctl)

	resp, _ := makeHandler(deps)(context.Background(), paraJSON(t, defaultPara()))
	if resp.ReturnCode != 0 {
		t.Fatalf("expected degraded success returnCode=0, got %d msg=%q", resp.ReturnCode, resp.ReturnMessage)
	}
	if atomic.LoadInt32(&acquireCalls) != 1 {
		t.Errorf("expected TryAcquireSlotForIsolate to be called once after ctl query failure, got %d", acquireCalls)
	}
	if atomic.LoadInt32(&destroyCalls) != 1 {
		t.Errorf("expected CTLClient.DestroyPass to be called once after ctl query failure, got %d", destroyCalls)
	}
	gotFlowID, _ := resp.Data["flowId"].(int64)
	if gotFlowID != wantFlowID {
		t.Errorf("expected data.flowId=%d (degraded acquire-slot path), got %v", wantFlowID, resp.Data["flowId"])
	}
}
