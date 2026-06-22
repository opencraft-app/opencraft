package isolateresource

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"testing"
	"time"

	"git.woa.com/wisp/mono/trade/internal/ctlclient"
	"git.woa.com/wisp/mono/trade/internal/httpapi/jifei"
	"git.woa.com/wisp/mono/trade/internal/region"
	"git.woa.com/wisp/mono/trade/internal/store"
)

// ===== 测试用 fake 实现 =======================================================

type fakeFlowStore struct {
	mu sync.Mutex

	tryAcquireIsolateFunc func(ctx context.Context, resourceID, flowType, appID, uin string, body []byte, dealName *string) (bool, *store.Flow, error)

	deleteByIDCalls []int64
	deleteByIDErr   error
}

func (f *fakeFlowStore) TryAcquireSlot(_ context.Context, _, _, _ string, _ []byte) (bool, *store.Flow, error) {
	return false, nil, errors.New("TryAcquireSlot not used in isolateResource tests")
}

func (f *fakeFlowStore) TryAcquireSlotForIsolate(ctx context.Context, resourceID, flowType, appID, uin string, body []byte, dealName *string) (bool, *store.Flow, error) {
	return f.tryAcquireIsolateFunc(ctx, resourceID, flowType, appID, uin, body, dealName)
}

func (f *fakeFlowStore) MarkCompletedWithResourceID(_ context.Context, _, _, _, _ string, _ []byte) error {
	return nil
}

func (f *fakeFlowStore) MarkCompleted(_ context.Context, _, _, _ string, _ []byte) error {
	return errors.New("MarkCompleted not used in isolateResource tests")
}
func (f *fakeFlowStore) MarkFailed(_ context.Context, _, _, _ string, _ []byte) error {
	return errors.New("MarkFailed not used in isolateResource tests")
}
func (f *fakeFlowStore) MarkCompletedByID(_ context.Context, _ int64, _ []byte) error {
	return errors.New("MarkCompletedByID not used in isolateResource tests")
}
func (f *fakeFlowStore) MarkFailedByID(_ context.Context, _ int64, _ []byte) error {
	return errors.New("MarkFailedByID not used in isolateResource tests")
}
func (f *fakeFlowStore) DeleteByID(_ context.Context, id int64) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.deleteByIDCalls = append(f.deleteByIDCalls, id)
	return f.deleteByIDErr
}
func (f *fakeFlowStore) GetFlow(_ context.Context, _, _, _ string) (*store.Flow, error) {
	return nil, store.ErrFlowNotFound
}
func (f *fakeFlowStore) GetByID(_ context.Context, _ int64) (*store.Flow, error) {
	return nil, store.ErrFlowNotFound
}
func (f *fakeFlowStore) ListInProgressBefore(_ context.Context, _ time.Time, _ int) ([]*store.Flow, error) {
	return nil, errors.New("ListInProgressBefore not used in isolateResource tests")
}

type fakeCTLClient struct {
	isolatePassFunc func(ctx context.Context, passID string, req *ctlclient.IsolatePassRequest) (*ctlclient.IsolatePassResponse, error)

	// listPassesByResourceIDsFunc 用于注入 v1.7.31 前置幂等捷径的 ctl 查询结果。
	// nil 时退化为返 errors.New(...) — 触发 handler 内部 best-effort 降级，等价于
	// 旧测试场景（query 失败 → 继续走 §3.3 抢占式幂等）。
	listPassesByResourceIDsFunc func(ctx context.Context, appID int64, passIDs []string) ([]*ctlclient.PassDetail, error)
}

func (f *fakeCTLClient) GetBundleByID(_ context.Context, _ string) (*ctlclient.BundleDetail, error) {
	return nil, errors.New("GetBundleByID not used in isolateResource tests")
}
func (f *fakeCTLClient) ListPassesByUser(_ context.Context, _ string) ([]*ctlclient.PassDetail, error) {
	return nil, errors.New("ListPassesByUser not used in isolateResource tests")
}
func (f *fakeCTLClient) CompletePass(_ context.Context, _ *ctlclient.CompletePassRequest) (*ctlclient.PassDetail, error) {
	return nil, errors.New("CompletePass not used in isolateResource tests")
}
func (f *fakeCTLClient) ListPassAppIDs(_ context.Context, _ []string, _, _ int) ([]int64, int64, error) {
	return nil, 0, errors.New("ListPassAppIDs not used in isolateResource tests")
}
func (f *fakeCTLClient) ListPassesByAppID(_ context.Context, _ int64, _ []string, _, _ int) ([]*ctlclient.PassDetail, int64, error) {
	return nil, 0, errors.New("ListPassesByAppID not used in isolateResource tests")
}
func (f *fakeCTLClient) ListPassesByResourceIDs(ctx context.Context, appID int64, passIDs []string) ([]*ctlclient.PassDetail, error) {
	if f.listPassesByResourceIDsFunc != nil {
		return f.listPassesByResourceIDsFunc(ctx, appID, passIDs)
	}
	return nil, errors.New("ListPassesByResourceIDs not used in isolateResource tests")
}
func (f *fakeCTLClient) IsolatePass(ctx context.Context, passID string, req *ctlclient.IsolatePassRequest) (*ctlclient.IsolatePassResponse, error) {
	return f.isolatePassFunc(ctx, passID, req)
}

func (f *fakeCTLClient) RenewPass(_ context.Context, _ string, _ *ctlclient.RenewPassRequest) (*ctlclient.RenewPassResponse, error) {
	return nil, errors.New("RenewPass not used in isolateResource tests")
}

func (f *fakeCTLClient) DestroyPass(_ context.Context, _ string, _ *ctlclient.DestroyPassRequest) (*ctlclient.DestroyPassResponse, error) {
	return nil, errors.New("DestroyPass not used in isolateResource tests")
}

// ===== helpers ==============================================================

func defaultPara() callbackPara {
	// 默认生命周期隔离场景（DealName / NewDeadline 都为空）。
	// 退费场景请用 refundPara() / 在变量上手工加上 DealName + NewDeadline。
	return callbackPara{
		Uin:        "10000001",
		AppID:      251000001,
		Region:     region.LighthouseRegionID,
		ResourceID: "lhins-abcd1234",
	}
}

func paraJSON(t *testing.T, p callbackPara) json.RawMessage {
	t.Helper()
	raw, err := json.Marshal(p)
	if err != nil {
		t.Fatalf("marshal para: %v", err)
	}
	return raw
}

func newDeps(flow *fakeFlowStore, ctl *fakeCTLClient) Deps {
	return Deps{
		FlowStore: flow,
		CTLClient: ctl,
		Builder:   jifei.NewFrameworkBuilder("trade", "1.0"),
	}
}

// ===== 入参 / region 校验类 ==================================================

func TestHandler_InvalidParaJSON(t *testing.T) {
	deps := newDeps(&fakeFlowStore{}, &fakeCTLClient{})
	resp, _ := makeHandler(deps)(context.Background(), json.RawMessage([]byte("not-json")))
	if resp.ReturnCode != ReturnCodeInvalidPara {
		t.Errorf("expected returnCode=%d, got %d", ReturnCodeInvalidPara, resp.ReturnCode)
	}
}

func TestHandler_MissingRequiredFields(t *testing.T) {
	cases := []struct {
		name   string
		mutate func(p *callbackPara)
	}{
		{"missing uin", func(p *callbackPara) { p.Uin = "" }},
		{"missing appId", func(p *callbackPara) { p.AppID = 0 }},
		{"missing resourceId", func(p *callbackPara) { p.ResourceID = "" }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			p := defaultPara()
			tc.mutate(&p)
			deps := newDeps(&fakeFlowStore{}, &fakeCTLClient{})
			resp, _ := makeHandler(deps)(context.Background(), paraJSON(t, p))
			if resp.ReturnCode != ReturnCodeInvalidPara {
				t.Errorf("%s: expected returnCode=%d, got %d", tc.name, ReturnCodeInvalidPara, resp.ReturnCode)
			}
		})
	}
}

func TestHandler_RegionMismatch(t *testing.T) {
	p := defaultPara()
	p.Region = 9 // 非 LighthouseRegionID(=1)
	deps := newDeps(&fakeFlowStore{}, &fakeCTLClient{})
	resp, _ := makeHandler(deps)(context.Background(), paraJSON(t, p))
	if resp.ReturnCode != ReturnCodeInvalidPara {
		t.Errorf("region mismatch: expected returnCode=%d, got %d", ReturnCodeInvalidPara, resp.ReturnCode)
	}
}

// ===== 赢家路径（happy） ====================================================

func TestHandler_WinnerPath_HappyCallsCTLAndReturnsFlowID(t *testing.T) {
	const wantFlowID int64 = 4242
	flow := &fakeFlowStore{
		tryAcquireIsolateFunc: func(_ context.Context, resourceID, flowType, appID, uin string, _ []byte, _ *string) (bool, *store.Flow, error) {
			if resourceID != "lhins-abcd1234" || flowType != store.FlowTypeIsolateResource || appID != "251000001" || uin != "10000001" {
				t.Errorf("unexpected acquire args: resource=%s flowType=%s appID=%s uin=%s", resourceID, flowType, appID, uin)
			}
			return true, &store.Flow{ID: wantFlowID, Status: store.FlowStatusInProgress}, nil
		},
	}
	var ctlCalls int
	var gotIsolateReq *ctlclient.IsolatePassRequest
	ctl := &fakeCTLClient{
		isolatePassFunc: func(_ context.Context, passID string, req *ctlclient.IsolatePassRequest) (*ctlclient.IsolatePassResponse, error) {
			ctlCalls++
			gotIsolateReq = req
			if passID != "lhins-abcd1234" {
				t.Errorf("ctl IsolatePass called with passID=%q, want lhins-abcd1234", passID)
			}
			return &ctlclient.IsolatePassResponse{PassID: passID, TaskID: "task-xyz"}, nil
		},
	}
	deps := newDeps(flow, ctl)

	resp, _ := makeHandler(deps)(context.Background(), paraJSON(t, defaultPara()))
	if resp.ReturnCode != 0 {
		t.Fatalf("expected success returnCode=0, got %d returnMessage=%s", resp.ReturnCode, resp.ReturnMessage)
	}
	if ctlCalls != 1 {
		t.Errorf("expected exactly 1 ctl.IsolatePass call, got %d", ctlCalls)
	}
	// Q22-I-E 端到端闭环：trade 必须把 trade_flow.id PK 作为 FlowID 透传给 ctl，
	// 让 ctl 父 task 终态时反向调 trade callback 把 trade_flow.status 推进到 completed。
	if gotIsolateReq == nil {
		t.Fatalf("ctl IsolatePass req is nil")
	}
	if gotIsolateReq.FlowID != wantFlowID {
		t.Errorf("expected ctl IsolatePass req.FlowID=%d, got %d", wantFlowID, gotIsolateReq.FlowID)
	}
	gotFlowID, _ := resp.Data["flowId"].(int64)
	if gotFlowID != wantFlowID {
		t.Errorf("expected data.flowId=%d, got %v", wantFlowID, resp.Data["flowId"])
	}
	if len(flow.deleteByIDCalls) != 0 {
		t.Errorf("DeleteByID must NOT be called on happy path, got %d calls", len(flow.deleteByIDCalls))
	}
}

// ===== 输家路径（回放 flowId） ===============================================

func TestHandler_LoserPath_ReplaysExistingFlowID(t *testing.T) {
	const existingFlowID int64 = 7777
	flow := &fakeFlowStore{
		tryAcquireIsolateFunc: func(_ context.Context, _, _, _, _ string, _ []byte, _ *string) (bool, *store.Flow, error) {
			return false, &store.Flow{ID: existingFlowID, Status: store.FlowStatusInProgress}, nil
		},
	}
	ctl := &fakeCTLClient{
		isolatePassFunc: func(_ context.Context, _ string, _ *ctlclient.IsolatePassRequest) (*ctlclient.IsolatePassResponse, error) {
			t.Fatalf("CTLClient.IsolatePass MUST NOT be called on loser path")
			return nil, nil
		},
	}
	deps := newDeps(flow, ctl)

	resp, _ := makeHandler(deps)(context.Background(), paraJSON(t, defaultPara()))
	if resp.ReturnCode != 0 {
		t.Fatalf("expected success returnCode=0, got %d", resp.ReturnCode)
	}
	gotFlowID, _ := resp.Data["flowId"].(int64)
	if gotFlowID != existingFlowID {
		t.Errorf("expected data.flowId=%d (loser replay), got %v", existingFlowID, resp.Data["flowId"])
	}
}

func TestHandler_LoserPath_NilExistingTreatedAsCorrupted(t *testing.T) {
	flow := &fakeFlowStore{
		tryAcquireIsolateFunc: func(_ context.Context, _, _, _, _ string, _ []byte, _ *string) (bool, *store.Flow, error) {
			// 防御场景：实现 bug — acquired=false 但回查没拿到行
			return false, nil, nil
		},
	}
	deps := newDeps(flow, &fakeCTLClient{})

	resp, _ := makeHandler(deps)(context.Background(), paraJSON(t, defaultPara()))
	if resp.ReturnCode != ReturnCodeInternalError {
		t.Errorf("expected returnCode=%d (InternalError), got %d", ReturnCodeInternalError, resp.ReturnCode)
	}
}

// ===== TryAcquire DB 错 ======================================================

func TestHandler_AcquireSlotDBError(t *testing.T) {
	flow := &fakeFlowStore{
		tryAcquireIsolateFunc: func(_ context.Context, _, _, _, _ string, _ []byte, _ *string) (bool, *store.Flow, error) {
			return false, nil, errors.New("connection refused")
		},
	}
	deps := newDeps(flow, &fakeCTLClient{})

	resp, _ := makeHandler(deps)(context.Background(), paraJSON(t, defaultPara()))
	if resp.ReturnCode != ReturnCodeFlowInProgress {
		t.Errorf("expected returnCode=%d (FlowInProgress for retry), got %d", ReturnCodeFlowInProgress, resp.ReturnCode)
	}
}

// ===== 赢家 ctl 调用失败：DELETE 回滚 + 错误码分类 ============================

func TestHandler_WinnerPath_CTLNotFoundTriggersRollbackAndIsolateFailed(t *testing.T) {
	const wantFlowID int64 = 100
	flow := &fakeFlowStore{
		tryAcquireIsolateFunc: func(_ context.Context, _, _, _, _ string, _ []byte, _ *string) (bool, *store.Flow, error) {
			return true, &store.Flow{ID: wantFlowID, Status: store.FlowStatusInProgress}, nil
		},
	}
	ctl := &fakeCTLClient{
		isolatePassFunc: func(_ context.Context, _ string, _ *ctlclient.IsolatePassRequest) (*ctlclient.IsolatePassResponse, error) {
			return nil, ctlclient.ErrNotFound
		},
	}
	deps := newDeps(flow, ctl)

	resp, _ := makeHandler(deps)(context.Background(), paraJSON(t, defaultPara()))
	if resp.ReturnCode != ReturnCodeIsolateFailed {
		t.Errorf("ctl 404 should map to IsolateFailed=%d, got %d", ReturnCodeIsolateFailed, resp.ReturnCode)
	}
	if len(flow.deleteByIDCalls) != 1 || flow.deleteByIDCalls[0] != wantFlowID {
		t.Errorf("expected DeleteByID(%d), got %v", wantFlowID, flow.deleteByIDCalls)
	}
}

func TestHandler_WinnerPath_CTLConcurrentIsolatingMappedToInProgress(t *testing.T) {
	flow := &fakeFlowStore{
		tryAcquireIsolateFunc: func(_ context.Context, _, _, _, _ string, _ []byte, _ *string) (bool, *store.Flow, error) {
			return true, &store.Flow{ID: 10, Status: store.FlowStatusInProgress}, nil
		},
	}
	ctl := &fakeCTLClient{
		isolatePassFunc: func(_ context.Context, _ string, _ *ctlclient.IsolatePassRequest) (*ctlclient.IsolatePassResponse, error) {
			return nil, &ctlclient.Error{
				HTTPStatus: 403,
				Code:       ctlclient.ErrCodePassIsolating,
				Message:    "pass already isolating",
			}
		},
	}
	deps := newDeps(flow, ctl)

	resp, _ := makeHandler(deps)(context.Background(), paraJSON(t, defaultPara()))
	if resp.ReturnCode != ReturnCodeFlowInProgress {
		t.Errorf("PASS_ISOLATING should map to FlowInProgress=%d (jifei retries → loser replay), got %d",
			ReturnCodeFlowInProgress, resp.ReturnCode)
	}
	if len(flow.deleteByIDCalls) != 1 {
		t.Errorf("expected DeleteByID rollback once, got %d calls", len(flow.deleteByIDCalls))
	}
}

func TestHandler_WinnerPath_CTL5xxMappedToInProgress(t *testing.T) {
	flow := &fakeFlowStore{
		tryAcquireIsolateFunc: func(_ context.Context, _, _, _, _ string, _ []byte, _ *string) (bool, *store.Flow, error) {
			return true, &store.Flow{ID: 11, Status: store.FlowStatusInProgress}, nil
		},
	}
	ctl := &fakeCTLClient{
		isolatePassFunc: func(_ context.Context, _ string, _ *ctlclient.IsolatePassRequest) (*ctlclient.IsolatePassResponse, error) {
			return nil, &ctlclient.Error{HTTPStatus: 503, Code: "INTERNAL", Message: "ctl down"}
		},
	}
	deps := newDeps(flow, ctl)

	resp, _ := makeHandler(deps)(context.Background(), paraJSON(t, defaultPara()))
	if resp.ReturnCode != ReturnCodeFlowInProgress {
		t.Errorf("ctl 5xx should map to FlowInProgress=%d, got %d", ReturnCodeFlowInProgress, resp.ReturnCode)
	}
	if len(flow.deleteByIDCalls) != 1 {
		t.Errorf("expected DeleteByID rollback once, got %d calls", len(flow.deleteByIDCalls))
	}
}

func TestHandler_WinnerPath_CTL4xxBusinessErrorMappedToIsolateFailed(t *testing.T) {
	flow := &fakeFlowStore{
		tryAcquireIsolateFunc: func(_ context.Context, _, _, _, _ string, _ []byte, _ *string) (bool, *store.Flow, error) {
			return true, &store.Flow{ID: 12, Status: store.FlowStatusInProgress}, nil
		},
	}
	ctl := &fakeCTLClient{
		isolatePassFunc: func(_ context.Context, _ string, _ *ctlclient.IsolatePassRequest) (*ctlclient.IsolatePassResponse, error) {
			return nil, &ctlclient.Error{HTTPStatus: 400, Code: ctlclient.ErrCodePassInvalidParam, Message: "bad request"}
		},
	}
	deps := newDeps(flow, ctl)

	resp, _ := makeHandler(deps)(context.Background(), paraJSON(t, defaultPara()))
	if resp.ReturnCode != ReturnCodeIsolateFailed {
		t.Errorf("ctl 400 PASS_INVALID_PARAM should map to IsolateFailed=%d, got %d", ReturnCodeIsolateFailed, resp.ReturnCode)
	}
}

func TestHandler_WinnerPath_NetworkErrorMappedToInProgress(t *testing.T) {
	flow := &fakeFlowStore{
		tryAcquireIsolateFunc: func(_ context.Context, _, _, _, _ string, _ []byte, _ *string) (bool, *store.Flow, error) {
			return true, &store.Flow{ID: 13, Status: store.FlowStatusInProgress}, nil
		},
	}
	ctl := &fakeCTLClient{
		isolatePassFunc: func(_ context.Context, _ string, _ *ctlclient.IsolatePassRequest) (*ctlclient.IsolatePassResponse, error) {
			return nil, errors.New("connection reset by peer")
		},
	}
	deps := newDeps(flow, ctl)

	resp, _ := makeHandler(deps)(context.Background(), paraJSON(t, defaultPara()))
	if resp.ReturnCode != ReturnCodeFlowInProgress {
		t.Errorf("network error should map to FlowInProgress=%d, got %d", ReturnCodeFlowInProgress, resp.ReturnCode)
	}
}
