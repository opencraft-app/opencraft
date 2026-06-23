// Package isolateresource v1.7.31 前置幂等捷径单测。
//
// 背景：jifei 永不放弃 isolateResource 重试（PDF §1.2），对已终态的 pass
// 反复触发隔离回调会导致 trade 不断抢 slot + 反向调 ctl IsolatePass，
// ctl 在 pass 已 isolated 或不存在时返 PASS_ISOLATED / 404 被映射为 600302/600303，
// jifei 据此持续重试，业务感知为"隔离一直失败"。
//
// 修复：在 §3.3 抢占式幂等之前增加 ctl ListPassesByResourceIDs 前置查询：
//   - pass 不存在（返空数组）= 已物理销毁/未曾存在 → 幂等返成功不带 flowId
//   - pass.IsolatedTime != nil = 已 isolated 终态 → 幂等返成功不带 flowId
//   - 查询失败 → best-effort 降级走原 §3.3 路径（不阻塞）
//   - 生命周期 / 退费两类业务分支一视同仁
package isolateresource

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"

	"git.woa.com/wisp/mono/trade/internal/ctlclient"
	"git.woa.com/wisp/mono/trade/internal/store"
)

// TestHandler_IdempotentShortcut_PassAlreadyIsolated 生命周期场景：
// ctl 反查命中 pass 且 IsolatedTime != nil → 不抢 slot、不调 ctl IsolatePass，
// 返成功且 data 不含 flowId（PDF §2.2 data.flowId optional）。
func TestHandler_IdempotentShortcut_PassAlreadyIsolated(t *testing.T) {
	isolatedAt := time.Date(2026, 6, 22, 3, 14, 15, 0, time.UTC)

	var acquireCalls int32
	flow := &fakeFlowStore{
		tryAcquireIsolateFunc: func(_ context.Context, _, _, _, _ string, _ []byte, _ *string) (bool, *store.Flow, error) {
			atomic.AddInt32(&acquireCalls, 1)
			t.Fatalf("TryAcquireSlotForIsolate MUST NOT be called when pass already isolated")
			return false, nil, nil
		},
	}
	ctl := &fakeCTLClient{
		listPassesByResourceIDsFunc: func(_ context.Context, appID int64, passIDs []string) ([]*ctlclient.PassDetail, error) {
			if appID != 251000001 || len(passIDs) != 1 || passIDs[0] != "lhins-abcd1234" {
				t.Errorf("unexpected ctl query args: appID=%d passIDs=%v", appID, passIDs)
			}
			return []*ctlclient.PassDetail{
				{PassID: "lhins-abcd1234", IsolatedTime: &isolatedAt},
			}, nil
		},
		isolatePassFunc: func(_ context.Context, _ string, _ *ctlclient.IsolatePassRequest) (*ctlclient.IsolatePassResponse, error) {
			t.Fatalf("CTLClient.IsolatePass MUST NOT be called when pass already isolated")
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
	if atomic.LoadInt32(&acquireCalls) != 0 {
		t.Errorf("expected zero TryAcquireSlotForIsolate calls, got %d", acquireCalls)
	}
	if len(flow.deleteByIDCalls) != 0 {
		t.Errorf("DeleteByID MUST NOT be called on idempotent shortcut, got %d calls", len(flow.deleteByIDCalls))
	}
}

// TestHandler_IdempotentShortcut_PassNotFound ctl 反查返空数组（pass 已物理销毁
// + INSERT history_pass，或从未存在）→ 隔离语义已自然达成，幂等返成功不带 flowId。
func TestHandler_IdempotentShortcut_PassNotFound(t *testing.T) {
	flow := &fakeFlowStore{
		tryAcquireIsolateFunc: func(_ context.Context, _, _, _, _ string, _ []byte, _ *string) (bool, *store.Flow, error) {
			t.Fatalf("TryAcquireSlotForIsolate MUST NOT be called when pass not found")
			return false, nil, nil
		},
	}
	ctl := &fakeCTLClient{
		listPassesByResourceIDsFunc: func(_ context.Context, _ int64, _ []string) ([]*ctlclient.PassDetail, error) {
			return []*ctlclient.PassDetail{}, nil
		},
		isolatePassFunc: func(_ context.Context, _ string, _ *ctlclient.IsolatePassRequest) (*ctlclient.IsolatePassResponse, error) {
			t.Fatalf("CTLClient.IsolatePass MUST NOT be called when pass not found")
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
}

// TestHandler_IdempotentShortcut_RefundBranch_PassAlreadyIsolated 退费场景一视同仁：
// 同样 pass 已 isolated → 不抢 slot、不调 ctl、不重写 newDeadline。
// 业务语义：pass 已隔离意味着 expired_time 已到期，重写 newDeadline 无意义。
func TestHandler_IdempotentShortcut_RefundBranch_PassAlreadyIsolated(t *testing.T) {
	isolatedAt := time.Date(2026, 6, 22, 3, 14, 15, 0, time.UTC)

	flow := &fakeFlowStore{
		tryAcquireIsolateFunc: func(_ context.Context, _, _, _, _ string, _ []byte, _ *string) (bool, *store.Flow, error) {
			t.Fatalf("TryAcquireSlotForIsolate MUST NOT be called for refund branch when pass already isolated")
			return false, nil, nil
		},
	}
	ctl := &fakeCTLClient{
		listPassesByResourceIDsFunc: func(_ context.Context, _ int64, _ []string) ([]*ctlclient.PassDetail, error) {
			return []*ctlclient.PassDetail{
				{PassID: "lhins-abcd1234", IsolatedTime: &isolatedAt},
			}, nil
		},
		isolatePassFunc: func(_ context.Context, _ string, _ *ctlclient.IsolatePassRequest) (*ctlclient.IsolatePassResponse, error) {
			t.Fatalf("CTLClient.IsolatePass MUST NOT be called for refund branch when pass already isolated")
			return nil, nil
		},
	}
	deps := newDeps(flow, ctl)

	resp, _ := makeHandler(deps)(context.Background(), paraJSON(t, refundPara("deal-refund-already-isolated", "2026-06-22 15:22:50")))
	if resp.ReturnCode != 0 {
		t.Fatalf("expected idempotent success returnCode=0, got %d msg=%q", resp.ReturnCode, resp.ReturnMessage)
	}
	if _, ok := resp.Data["flowId"]; ok {
		t.Errorf("data.flowId MUST NOT be present on idempotent shortcut, got %v", resp.Data["flowId"])
	}
}

// TestHandler_IdempotentShortcut_CTLQueryFailure_DegradesToAcquireSlot ctl 查询失败
// → best-effort 降级走原 §3.3 抢占式幂等路径（避免新依赖变成新故障点）。
//
// 这里用赢家分支兜底：故意让 ctl 查询返错，verify TryAcquireSlotForIsolate
// 仍被调用、IsolatePass 仍被调用、flowId 仍透出。
func TestHandler_IdempotentShortcut_CTLQueryFailure_DegradesToAcquireSlot(t *testing.T) {
	const wantFlowID int64 = 5555

	var acquireCalls int32
	flow := &fakeFlowStore{
		tryAcquireIsolateFunc: func(_ context.Context, _, _, _, _ string, _ []byte, _ *string) (bool, *store.Flow, error) {
			atomic.AddInt32(&acquireCalls, 1)
			return true, &store.Flow{ID: wantFlowID, Status: store.FlowStatusInProgress}, nil
		},
	}
	var isolateCalls int32
	ctl := &fakeCTLClient{
		listPassesByResourceIDsFunc: func(_ context.Context, _ int64, _ []string) ([]*ctlclient.PassDetail, error) {
			return nil, errors.New("ctl 5xx / network error")
		},
		isolatePassFunc: func(_ context.Context, _ string, _ *ctlclient.IsolatePassRequest) (*ctlclient.IsolatePassResponse, error) {
			atomic.AddInt32(&isolateCalls, 1)
			return &ctlclient.IsolatePassResponse{TaskID: "task-degraded"}, nil
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
	if atomic.LoadInt32(&isolateCalls) != 1 {
		t.Errorf("expected CTLClient.IsolatePass to be called once after ctl query failure, got %d", isolateCalls)
	}
	gotFlowID, _ := resp.Data["flowId"].(int64)
	if gotFlowID != wantFlowID {
		t.Errorf("expected data.flowId=%d (degraded acquire-slot path), got %v", wantFlowID, resp.Data["flowId"])
	}
}

// TestHandler_IdempotentShortcut_PassActiveContinuesToAcquireSlot ctl 反查命中 pass
// 但 IsolatedTime == nil（active / isolating / renewing 等非终态）→ 继续走原 §3.3 路径。
func TestHandler_IdempotentShortcut_PassActiveContinuesToAcquireSlot(t *testing.T) {
	const wantFlowID int64 = 6666

	var acquireCalls int32
	flow := &fakeFlowStore{
		tryAcquireIsolateFunc: func(_ context.Context, _, _, _, _ string, _ []byte, _ *string) (bool, *store.Flow, error) {
			atomic.AddInt32(&acquireCalls, 1)
			return true, &store.Flow{ID: wantFlowID, Status: store.FlowStatusInProgress}, nil
		},
	}
	var isolateCalls int32
	ctl := &fakeCTLClient{
		listPassesByResourceIDsFunc: func(_ context.Context, _ int64, _ []string) ([]*ctlclient.PassDetail, error) {
			// active pass：IsolatedTime == nil
			return []*ctlclient.PassDetail{
				{PassID: "lhins-abcd1234", IsolatedTime: nil},
			}, nil
		},
		isolatePassFunc: func(_ context.Context, _ string, _ *ctlclient.IsolatePassRequest) (*ctlclient.IsolatePassResponse, error) {
			atomic.AddInt32(&isolateCalls, 1)
			return &ctlclient.IsolatePassResponse{TaskID: "task-active"}, nil
		},
	}
	deps := newDeps(flow, ctl)

	resp, _ := makeHandler(deps)(context.Background(), paraJSON(t, defaultPara()))
	if resp.ReturnCode != 0 {
		t.Fatalf("expected acquire-slot success returnCode=0, got %d msg=%q", resp.ReturnCode, resp.ReturnMessage)
	}
	if atomic.LoadInt32(&acquireCalls) != 1 {
		t.Errorf("expected TryAcquireSlotForIsolate to be called once for active pass, got %d", acquireCalls)
	}
	if atomic.LoadInt32(&isolateCalls) != 1 {
		t.Errorf("expected CTLClient.IsolatePass to be called once for active pass, got %d", isolateCalls)
	}
	gotFlowID, _ := resp.Data["flowId"].(int64)
	if gotFlowID != wantFlowID {
		t.Errorf("expected data.flowId=%d (winner path), got %v", wantFlowID, resp.Data["flowId"])
	}
}
