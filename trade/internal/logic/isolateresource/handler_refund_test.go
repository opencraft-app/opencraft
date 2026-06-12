// Package isolateresource 退费分支单测（v1.7.30 BUG-35）。
//
// 设计稿：.tmp/jifei_pdf_txt/预付费资源隔离接口+-+isolateResource.md §2.2 退费场景
//
// 关键不变量：
//   - DealName / NewDeadline 必须同时出现或同时缺失（half-set → 600305 NewDeadlineInvalid）
//   - NewDeadline 是北京时间字面值，必须按 jifeiproto.CurDeadlineLocation 解析
//   - 解析失败 / 零值 → 600305
//   - happy 退费场景：dealName 透传 store.TryAcquireSlotForIsolate +
//     NewDeadline (UTC time.Time) + DealName 透传 ctlclient.IsolatePassRequest
package isolateresource

import (
	"context"
	"testing"
	"time"

	"git.woa.com/wisp/mono/trade/internal/ctlclient"
	jifeiproto "git.woa.com/wisp/mono/trade/internal/jifei"
	"git.woa.com/wisp/mono/trade/internal/store"
)

// refundPara 构造一个退费场景的 callbackPara：
// 同时带 DealName + NewDeadline（北京时间字面值）+ BillingIsolateType=refund。
func refundPara(dealName, newDeadline string) callbackPara {
	p := defaultPara()
	p.DealName = dealName
	p.NewDeadline = newDeadline
	p.BillingIsolateType = "refund"
	return p
}

// TestHandler_RefundBranch_HalfSet_DealNameOnly 退费 half-set 校验：
// 仅传 DealName 不传 NewDeadline → 600305 NewDeadlineInvalid。
func TestHandler_RefundBranch_HalfSet_DealNameOnly(t *testing.T) {
	p := defaultPara()
	p.DealName = "deal-refund-only"
	// p.NewDeadline 留空

	deps := newDeps(&fakeFlowStore{}, &fakeCTLClient{})
	resp, _ := makeHandler(deps)(context.Background(), paraJSON(t, p))

	if resp.ReturnCode != ReturnCodeNewDeadlineInvalid {
		t.Errorf("expected returnCode=%d (NewDeadlineInvalid), got %d msg=%q",
			ReturnCodeNewDeadlineInvalid, resp.ReturnCode, resp.ReturnMessage)
	}
}

// TestHandler_RefundBranch_HalfSet_NewDeadlineOnly 退费 half-set 校验：
// 仅传 NewDeadline 不传 DealName → 600305。
func TestHandler_RefundBranch_HalfSet_NewDeadlineOnly(t *testing.T) {
	p := defaultPara()
	p.NewDeadline = "2026-06-22 15:22:50"
	// p.DealName 留空

	deps := newDeps(&fakeFlowStore{}, &fakeCTLClient{})
	resp, _ := makeHandler(deps)(context.Background(), paraJSON(t, p))

	if resp.ReturnCode != ReturnCodeNewDeadlineInvalid {
		t.Errorf("expected returnCode=%d (NewDeadlineInvalid), got %d msg=%q",
			ReturnCodeNewDeadlineInvalid, resp.ReturnCode, resp.ReturnMessage)
	}
}

// TestHandler_RefundBranch_NewDeadlineBadFormat 退费格式校验：
// NewDeadline 格式不符 PDF §2.2 layout → 600305。
func TestHandler_RefundBranch_NewDeadlineBadFormat(t *testing.T) {
	p := refundPara("deal-001", "not-a-time-literal")

	deps := newDeps(&fakeFlowStore{}, &fakeCTLClient{})
	resp, _ := makeHandler(deps)(context.Background(), paraJSON(t, p))

	if resp.ReturnCode != ReturnCodeNewDeadlineInvalid {
		t.Errorf("expected returnCode=%d (NewDeadlineInvalid), got %d msg=%q",
			ReturnCodeNewDeadlineInvalid, resp.ReturnCode, resp.ReturnMessage)
	}
}

// TestHandler_RefundBranch_HappyPath_PassesDealNameAndCSTNewDeadline 退费 happy path：
//   - dealName 必须以 *string 形式透传给 store.TryAcquireSlotForIsolate（非 nil 且值匹配）
//   - newDeadline 必须按 CST 解析为绝对时刻 UTC time.Time，再透传给 ctlclient.IsolatePassRequest
//
// 用确定时刻：北京时间 "2026-06-22 15:22:50" = UTC 07:22:50 (相差 8h)。
func TestHandler_RefundBranch_HappyPath_PassesDealNameAndCSTNewDeadline(t *testing.T) {
	const wantFlowID int64 = 9001
	const wantDealName = "deal-refund-happy"
	const newDeadlineCST = "2026-06-22 15:22:50"

	var gotDealNamePtr *string
	flow := &fakeFlowStore{
		tryAcquireIsolateFunc: func(_ context.Context, resourceID, flowType, appID, uin string, _ []byte, dealName *string) (bool, *store.Flow, error) {
			gotDealNamePtr = dealName
			return true, &store.Flow{ID: wantFlowID, Status: store.FlowStatusInProgress}, nil
		},
	}
	var gotIsolateReq *ctlclient.IsolatePassRequest
	ctl := &fakeCTLClient{
		isolatePassFunc: func(_ context.Context, _ string, req *ctlclient.IsolatePassRequest) (*ctlclient.IsolatePassResponse, error) {
			gotIsolateReq = req
			return &ctlclient.IsolatePassResponse{TaskID: "task-refund-1"}, nil
		},
	}
	deps := newDeps(flow, ctl)

	resp, _ := makeHandler(deps)(context.Background(), paraJSON(t, refundPara(wantDealName, newDeadlineCST)))
	if resp.ReturnCode != 0 {
		t.Fatalf("expected success returnCode=0, got %d msg=%q", resp.ReturnCode, resp.ReturnMessage)
	}

	// store 透传校验：dealName 必须非 nil 且值匹配
	if gotDealNamePtr == nil {
		t.Fatalf("dealName must be non-nil for refund branch")
	}
	if *gotDealNamePtr != wantDealName {
		t.Errorf("dealName mismatch: got %q want %q", *gotDealNamePtr, wantDealName)
	}

	// ctlclient 透传校验：DealName 字符串 + NewDeadline UTC 绝对时刻
	if gotIsolateReq == nil {
		t.Fatalf("ctl IsolatePass req is nil")
	}
	if gotIsolateReq.DealName != wantDealName {
		t.Errorf("ctlclient.IsolatePassRequest.DealName mismatch: got %q want %q",
			gotIsolateReq.DealName, wantDealName)
	}
	if gotIsolateReq.NewDeadline == nil {
		t.Fatalf("ctlclient.IsolatePassRequest.NewDeadline must be non-nil for refund branch")
	}
	// 北京时间 15:22:50 == UTC 07:22:50（绝对时刻 Equal）
	wantUTC := time.Date(2026, 6, 22, 7, 22, 50, 0, time.UTC)
	if !gotIsolateReq.NewDeadline.Equal(wantUTC) {
		t.Errorf("NewDeadline not parsed in CST: got %s want %s",
			gotIsolateReq.NewDeadline.UTC().Format(time.RFC3339),
			wantUTC.Format(time.RFC3339))
	}
	// 进一步保险：把 NewDeadline 按 CST 重新格式化应得到原字面值
	if jifeiproto.FormatCurDeadline(*gotIsolateReq.NewDeadline) != newDeadlineCST {
		t.Errorf("round-trip CST format mismatch: got %q want %q",
			jifeiproto.FormatCurDeadline(*gotIsolateReq.NewDeadline), newDeadlineCST)
	}

	// flowId 透传保留与生命周期场景一致
	gotFlowID, _ := resp.Data["flowId"].(int64)
	if gotFlowID != wantFlowID {
		t.Errorf("data.flowId mismatch: got %v want %d", resp.Data["flowId"], wantFlowID)
	}
}

// TestHandler_LifecycleBranch_DealNameNilPropagated 生命周期场景回归保护：
// 不传 DealName / NewDeadline → store 收到 dealName=nil（区分 isolate 生命周期 vs 退费 vs createResource）。
func TestHandler_LifecycleBranch_DealNameNilPropagated(t *testing.T) {
	var gotDealNamePtr *string
	gotDealNameSeen := false
	flow := &fakeFlowStore{
		tryAcquireIsolateFunc: func(_ context.Context, _, _, _, _ string, _ []byte, dealName *string) (bool, *store.Flow, error) {
			gotDealNamePtr = dealName
			gotDealNameSeen = true
			return true, &store.Flow{ID: 9100, Status: store.FlowStatusInProgress}, nil
		},
	}
	ctl := &fakeCTLClient{
		isolatePassFunc: func(_ context.Context, _ string, req *ctlclient.IsolatePassRequest) (*ctlclient.IsolatePassResponse, error) {
			if req.NewDeadline != nil {
				t.Errorf("lifecycle branch must propagate NewDeadline=nil to ctl, got %v", req.NewDeadline)
			}
			if req.DealName != "" {
				t.Errorf("lifecycle branch must propagate DealName=\"\" to ctl, got %q", req.DealName)
			}
			return &ctlclient.IsolatePassResponse{TaskID: "task-lifecycle-1"}, nil
		},
	}
	deps := newDeps(flow, ctl)

	resp, _ := makeHandler(deps)(context.Background(), paraJSON(t, defaultPara()))
	if resp.ReturnCode != 0 {
		t.Fatalf("expected success returnCode=0, got %d", resp.ReturnCode)
	}
	if !gotDealNameSeen {
		t.Fatalf("TryAcquireSlotForIsolate not called")
	}
	if gotDealNamePtr != nil {
		t.Errorf("lifecycle branch must pass dealName=nil to store, got *string=%q", *gotDealNamePtr)
	}
}
