package destroyresource

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

	tryAcquireIsolateFunc func(ctx context.Context, resourceID, flowType, appID, uin string, body []byte) (bool, *store.Flow, error)

	deleteByIDCalls []int64
	deleteByIDErr   error
}

func (f *fakeFlowStore) TryAcquireSlot(_ context.Context, _, _, _ string, _ []byte) (bool, *store.Flow, error) {
	return false, nil, errors.New("TryAcquireSlot not used in destroyResource tests")
}

func (f *fakeFlowStore) TryAcquireSlotForIsolate(ctx context.Context, resourceID, flowType, appID, uin string, body []byte, dealName *string) (bool, *store.Flow, error) {
	return f.tryAcquireIsolateFunc(ctx, resourceID, flowType, appID, uin, body)
}

func (f *fakeFlowStore) MarkCompletedWithResourceID(_ context.Context, _, _, _, _ string, _ []byte) error {
	return nil
}

func (f *fakeFlowStore) MarkCompleted(_ context.Context, _, _, _ string, _ []byte) error {
	return errors.New("MarkCompleted not used in destroyResource tests")
}
func (f *fakeFlowStore) MarkFailed(_ context.Context, _, _, _ string, _ []byte) error {
	return errors.New("MarkFailed not used in destroyResource tests")
}
func (f *fakeFlowStore) MarkCompletedByID(_ context.Context, _ int64, _ []byte) error {
	return errors.New("MarkCompletedByID not used in destroyResource tests")
}
func (f *fakeFlowStore) MarkFailedByID(_ context.Context, _ int64, _ []byte) error {
	return errors.New("MarkFailedByID not used in destroyResource tests")
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
	return nil, errors.New("ListInProgressBefore not used in destroyResource tests")
}

// fakeCTLClient 仅承载 destroyResource 测试需要的 DestroyPass 路径；
// 其它 9 个方法返 unused error（避免误用）。
type fakeCTLClient struct {
	destroyFunc func(ctx context.Context, passID string, req *ctlclient.DestroyPassRequest) (*ctlclient.DestroyPassResponse, error)
}

func (f *fakeCTLClient) GetBundleByID(_ context.Context, _ string) (*ctlclient.BundleDetail, error) {
	return nil, errors.New("GetBundleByID not used in destroyResource tests")
}
func (f *fakeCTLClient) ListPassesByUser(_ context.Context, _ string) ([]*ctlclient.PassDetail, error) {
	return nil, errors.New("ListPassesByUser not used in destroyResource tests")
}
func (f *fakeCTLClient) CompletePass(_ context.Context, _ *ctlclient.CompletePassRequest) (*ctlclient.PassDetail, error) {
	return nil, errors.New("CompletePass not used in destroyResource tests")
}
func (f *fakeCTLClient) ListPassAppIDs(_ context.Context, _ []string, _, _ int) ([]int64, int64, error) {
	return nil, 0, errors.New("ListPassAppIDs not used in destroyResource tests")
}
func (f *fakeCTLClient) ListPassesByAppID(_ context.Context, _ int64, _ []string, _, _ int) ([]*ctlclient.PassDetail, int64, error) {
	return nil, 0, errors.New("ListPassesByAppID not used in destroyResource tests")
}
func (f *fakeCTLClient) ListPassesByResourceIDs(_ context.Context, _ int64, _ []string) ([]*ctlclient.PassDetail, error) {
	return nil, errors.New("ListPassesByResourceIDs not used in destroyResource tests")
}
func (f *fakeCTLClient) IsolatePass(_ context.Context, _ string, _ *ctlclient.IsolatePassRequest) (*ctlclient.IsolatePassResponse, error) {
	return nil, errors.New("IsolatePass not used in destroyResource tests")
}
func (f *fakeCTLClient) RenewPass(_ context.Context, _ string, _ *ctlclient.RenewPassRequest) (*ctlclient.RenewPassResponse, error) {
	return nil, errors.New("RenewPass not used in destroyResource tests")
}
func (f *fakeCTLClient) DestroyPass(ctx context.Context, passID string, req *ctlclient.DestroyPassRequest) (*ctlclient.DestroyPassResponse, error) {
	return f.destroyFunc(ctx, passID, req)
}

// ===== helpers ==============================================================

func defaultPara() callbackPara {
	return callbackPara{
		Uin:            "10000001",
		AppID:          251000001,
		Region:         region.LighthouseRegionID,
		ResourceID:     "lhins-abcd1234",
		DealName:       "deal-destroy-001",
		ProductCode:    "p_lighthouse", // 仅日志透传，不消费（§11 Q26）
		SubProductCode: "sub_lighthouse",
		Source:         "biz", // Q24 透传给 ctl 写 history_pass.destroy_reason
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

// noopCTLClient 是 ctl 路径不会被调到的测试用 fake（D-5b 之前的输家 / 错入参分支）。
func noopCTLClient(t *testing.T) *fakeCTLClient {
	t.Helper()
	return &fakeCTLClient{
		destroyFunc: func(_ context.Context, _ string, _ *ctlclient.DestroyPassRequest) (*ctlclient.DestroyPassResponse, error) {
			t.Errorf("ctl.DestroyPass should NOT be called in this test")
			return nil, errors.New("unexpected call")
		},
	}
}

func newDeps(flow *fakeFlowStore, ctl ctlclient.Client) Deps {
	return Deps{
		FlowStore: flow,
		CTLClient: ctl,
		Builder:   jifei.NewFrameworkBuilder("trade", "1.0"),
	}
}

// ===== 入参 / region 校验类（不会进入 ctl 调用） =============================

func TestHandler_InvalidParaJSON(t *testing.T) {
	deps := newDeps(&fakeFlowStore{}, noopCTLClient(t))
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
			deps := newDeps(&fakeFlowStore{}, noopCTLClient(t))
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
	deps := newDeps(&fakeFlowStore{}, noopCTLClient(t))
	resp, _ := makeHandler(deps)(context.Background(), paraJSON(t, p))
	if resp.ReturnCode != ReturnCodeInvalidPara {
		t.Errorf("region mismatch: expected returnCode=%d, got %d", ReturnCodeInvalidPara, resp.ReturnCode)
	}
}

// ===== 赢家路径 happy（D-5b 起调 ctl.DestroyPass 成功后返 flowId） ==========

func TestHandler_WinnerPath_CallsCTLDestroyPassThenReturnsFlowID(t *testing.T) {
	const wantFlowID int64 = 9001
	flow := &fakeFlowStore{
		tryAcquireIsolateFunc: func(_ context.Context, resourceID, ft, appID, uin string, body []byte) (bool, *store.Flow, error) {
			if resourceID != "lhins-abcd1234" {
				t.Errorf("unexpected resourceID=%q", resourceID)
			}
			if ft != store.FlowTypeDestroyResource {
				t.Errorf("expected flowType=%q, got %q", store.FlowTypeDestroyResource, ft)
			}
			if appID != "251000001" {
				t.Errorf("expected appID=251000001, got %q", appID)
			}
			if uin != "10000001" {
				t.Errorf("expected uin=10000001, got %q", uin)
			}
			if len(body) == 0 {
				t.Error("expected non-empty body raw")
			}
			return true, &store.Flow{ID: wantFlowID, Status: store.FlowStatusInProgress}, nil
		},
	}

	var ctlCalls int
	ctl := &fakeCTLClient{
		destroyFunc: func(_ context.Context, passID string, req *ctlclient.DestroyPassRequest) (*ctlclient.DestroyPassResponse, error) {
			ctlCalls++
			if passID != "lhins-abcd1234" {
				t.Errorf("ctl.DestroyPass passID=%q want lhins-abcd1234", passID)
			}
			if req.FlowID != wantFlowID {
				t.Errorf("ctl.DestroyPass req.FlowID=%d want %d (trade_flow.id PK 透传)", req.FlowID, wantFlowID)
			}
			if req.DestroyReason != "biz" {
				t.Errorf("ctl.DestroyPass req.DestroyReason=%q want biz (Q24 source 透传)", req.DestroyReason)
			}
			return &ctlclient.DestroyPassResponse{
				PassID: passID,
				TaskID: "task-d1",
			}, nil
		},
	}
	deps := newDeps(flow, ctl)

	resp, _ := makeHandler(deps)(context.Background(), paraJSON(t, defaultPara()))
	if resp.ReturnCode != 0 {
		t.Fatalf("expected success returnCode=0, got %d returnMessage=%s", resp.ReturnCode, resp.ReturnMessage)
	}
	if ctlCalls != 1 {
		t.Errorf("expected ctl.DestroyPass called once, got %d", ctlCalls)
	}
	gotFlowID, _ := resp.Data["flowId"].(int64)
	if gotFlowID != wantFlowID {
		t.Errorf("expected data.flowId=%d, got %v", wantFlowID, resp.Data["flowId"])
	}
	// 成功路径不应触发 DeleteByID 回滚
	if len(flow.deleteByIDCalls) != 0 {
		t.Errorf("happy path must NOT call DeleteByID, got %d calls", len(flow.deleteByIDCalls))
	}
}

// ===== 输家路径（回放 flowId，不调 ctl） =====================================

func TestHandler_LoserPath_ReplaysExistingFlowIDWithoutCTLCall(t *testing.T) {
	const existingFlowID int64 = 8888
	flow := &fakeFlowStore{
		tryAcquireIsolateFunc: func(_ context.Context, _, _, _, _ string, _ []byte) (bool, *store.Flow, error) {
			return false, &store.Flow{ID: existingFlowID, Status: store.FlowStatusInProgress}, nil
		},
	}
	// 输家路径必须不调 ctl（jifei 重投走输家分支幂等回放 flowId 即可）
	deps := newDeps(flow, noopCTLClient(t))

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
		tryAcquireIsolateFunc: func(_ context.Context, _, _, _, _ string, _ []byte) (bool, *store.Flow, error) {
			// 防御场景：实现 bug — acquired=false 但回查没拿到行
			return false, nil, nil
		},
	}
	deps := newDeps(flow, noopCTLClient(t))

	resp, _ := makeHandler(deps)(context.Background(), paraJSON(t, defaultPara()))
	if resp.ReturnCode != ReturnCodeInternalError {
		t.Errorf("expected returnCode=%d (InternalError), got %d", ReturnCodeInternalError, resp.ReturnCode)
	}
}

// ===== TryAcquire DB 错 ======================================================

func TestHandler_AcquireSlotDBError(t *testing.T) {
	flow := &fakeFlowStore{
		tryAcquireIsolateFunc: func(_ context.Context, _, _, _, _ string, _ []byte) (bool, *store.Flow, error) {
			return false, nil, errors.New("connection refused")
		},
	}
	deps := newDeps(flow, noopCTLClient(t))

	resp, _ := makeHandler(deps)(context.Background(), paraJSON(t, defaultPara()))
	if resp.ReturnCode != ReturnCodeFlowInProgress {
		t.Errorf("expected returnCode=%d (FlowInProgress for retry), got %d", ReturnCodeFlowInProgress, resp.ReturnCode)
	}
}

// ===== D-5b 新增：ctl 调用错误分类 + DeleteByID 回滚 =========================

// TestHandler_CTLNotFound_ReturnsDestroyFailedAndRollsBack 验证 ctl 返 ErrNotFound 时：
//   - returnCode = 600403 DestroyFailed（A 类业务永久错）
//   - DeleteByID 被调用一次（trade_flow 行回滚）
func TestHandler_CTLNotFound_ReturnsDestroyFailedAndRollsBack(t *testing.T) {
	const wantFlowID int64 = 9101
	flow := &fakeFlowStore{
		tryAcquireIsolateFunc: func(_ context.Context, _, _, _, _ string, _ []byte) (bool, *store.Flow, error) {
			return true, &store.Flow{ID: wantFlowID, Status: store.FlowStatusInProgress}, nil
		},
	}
	ctl := &fakeCTLClient{
		destroyFunc: func(_ context.Context, _ string, _ *ctlclient.DestroyPassRequest) (*ctlclient.DestroyPassResponse, error) {
			return nil, ctlclient.ErrNotFound
		},
	}
	deps := newDeps(flow, ctl)

	resp, _ := makeHandler(deps)(context.Background(), paraJSON(t, defaultPara()))
	if resp.ReturnCode != ReturnCodeDestroyFailed {
		t.Errorf("expected returnCode=%d (DestroyFailed), got %d msg=%s",
			ReturnCodeDestroyFailed, resp.ReturnCode, resp.ReturnMessage)
	}
	if len(flow.deleteByIDCalls) != 1 || flow.deleteByIDCalls[0] != wantFlowID {
		t.Errorf("expected DeleteByID called once with %d, got %v", wantFlowID, flow.deleteByIDCalls)
	}
}

// TestHandler_CTLPassTerminating_ReturnsFlowInProgress 验证 ctl 返 PASS_TERMINATING 时：
//   - returnCode = 600402 FlowInProgress（让 jifei 重试一次走输家回放等价 idempotent 成功）
//   - DeleteByID 仍被调用（trade_flow 行回滚，让下一次 jifei 重投正常进 TryAcquireSlot 输家路径）
func TestHandler_CTLPassTerminating_ReturnsFlowInProgress(t *testing.T) {
	const wantFlowID int64 = 9102
	flow := &fakeFlowStore{
		tryAcquireIsolateFunc: func(_ context.Context, _, _, _, _ string, _ []byte) (bool, *store.Flow, error) {
			return true, &store.Flow{ID: wantFlowID, Status: store.FlowStatusInProgress}, nil
		},
	}
	ctl := &fakeCTLClient{
		destroyFunc: func(_ context.Context, _ string, _ *ctlclient.DestroyPassRequest) (*ctlclient.DestroyPassResponse, error) {
			return nil, &ctlclient.Error{
				Code:       ctlclient.ErrCodePassTerminating,
				HTTPStatus: 403,
				Message:    "pass already in terminating",
			}
		},
	}
	deps := newDeps(flow, ctl)

	resp, _ := makeHandler(deps)(context.Background(), paraJSON(t, defaultPara()))
	if resp.ReturnCode != ReturnCodeFlowInProgress {
		t.Errorf("expected returnCode=%d (FlowInProgress for retry), got %d msg=%s",
			ReturnCodeFlowInProgress, resp.ReturnCode, resp.ReturnMessage)
	}
	if len(flow.deleteByIDCalls) != 1 {
		t.Errorf("expected DeleteByID called once (rollback), got %d calls", len(flow.deleteByIDCalls))
	}
}

// TestHandler_CTLInvalidParam_ReturnsDestroyFailedAndRollsBack 验证 ctl 返 PASS_INVALID_PARAM
// （pass status 不在 {deleting, isolated} 集合）→ 600403 + 回滚。
func TestHandler_CTLInvalidParam_ReturnsDestroyFailedAndRollsBack(t *testing.T) {
	const wantFlowID int64 = 9103
	flow := &fakeFlowStore{
		tryAcquireIsolateFunc: func(_ context.Context, _, _, _, _ string, _ []byte) (bool, *store.Flow, error) {
			return true, &store.Flow{ID: wantFlowID, Status: store.FlowStatusInProgress}, nil
		},
	}
	ctl := &fakeCTLClient{
		destroyFunc: func(_ context.Context, _ string, _ *ctlclient.DestroyPassRequest) (*ctlclient.DestroyPassResponse, error) {
			return nil, &ctlclient.Error{
				Code:       ctlclient.ErrCodePassInvalidParam,
				HTTPStatus: 400,
				Message:    "pass status \"active\" not eligible for destroy",
			}
		},
	}
	deps := newDeps(flow, ctl)

	resp, _ := makeHandler(deps)(context.Background(), paraJSON(t, defaultPara()))
	if resp.ReturnCode != ReturnCodeDestroyFailed {
		t.Errorf("expected returnCode=%d (DestroyFailed), got %d", ReturnCodeDestroyFailed, resp.ReturnCode)
	}
	if len(flow.deleteByIDCalls) != 1 {
		t.Errorf("expected DeleteByID called once, got %d", len(flow.deleteByIDCalls))
	}
}

// TestHandler_CTL5xx_ReturnsFlowInProgressForRetry 验证 ctl 返 500 时：
//   - returnCode = 600402 FlowInProgress（B 类基础设施错，让 jifei 重试）
//   - DeleteByID 被调用（rollback）
func TestHandler_CTL5xx_ReturnsFlowInProgressForRetry(t *testing.T) {
	const wantFlowID int64 = 9104
	flow := &fakeFlowStore{
		tryAcquireIsolateFunc: func(_ context.Context, _, _, _, _ string, _ []byte) (bool, *store.Flow, error) {
			return true, &store.Flow{ID: wantFlowID, Status: store.FlowStatusInProgress}, nil
		},
	}
	ctl := &fakeCTLClient{
		destroyFunc: func(_ context.Context, _ string, _ *ctlclient.DestroyPassRequest) (*ctlclient.DestroyPassResponse, error) {
			return nil, &ctlclient.Error{
				Code:       "INTERNAL",
				HTTPStatus: 500,
				Message:    "ctl db down",
			}
		},
	}
	deps := newDeps(flow, ctl)

	resp, _ := makeHandler(deps)(context.Background(), paraJSON(t, defaultPara()))
	if resp.ReturnCode != ReturnCodeFlowInProgress {
		t.Errorf("expected returnCode=%d (FlowInProgress for retry), got %d", ReturnCodeFlowInProgress, resp.ReturnCode)
	}
	if len(flow.deleteByIDCalls) != 1 {
		t.Errorf("expected DeleteByID called once, got %d", len(flow.deleteByIDCalls))
	}
}

// TestHandler_CTLNetworkError_ReturnsFlowInProgressForRetry 验证未识别错（网络错 / timeout）→ 600402。
func TestHandler_CTLNetworkError_ReturnsFlowInProgressForRetry(t *testing.T) {
	const wantFlowID int64 = 9105
	flow := &fakeFlowStore{
		tryAcquireIsolateFunc: func(_ context.Context, _, _, _, _ string, _ []byte) (bool, *store.Flow, error) {
			return true, &store.Flow{ID: wantFlowID, Status: store.FlowStatusInProgress}, nil
		},
	}
	ctl := &fakeCTLClient{
		destroyFunc: func(_ context.Context, _ string, _ *ctlclient.DestroyPassRequest) (*ctlclient.DestroyPassResponse, error) {
			return nil, errors.New("dial tcp: connection refused")
		},
	}
	deps := newDeps(flow, ctl)

	resp, _ := makeHandler(deps)(context.Background(), paraJSON(t, defaultPara()))
	if resp.ReturnCode != ReturnCodeFlowInProgress {
		t.Errorf("expected returnCode=%d (FlowInProgress for retry), got %d", ReturnCodeFlowInProgress, resp.ReturnCode)
	}
	if len(flow.deleteByIDCalls) != 1 {
		t.Errorf("expected DeleteByID called once, got %d", len(flow.deleteByIDCalls))
	}
}

// TestHandler_EmptySource_TombstoneAllowed 验证 Q24 拍板：source 空串合法（ctl 透传时不强校验）。
func TestHandler_EmptySource_TombstoneAllowed(t *testing.T) {
	const wantFlowID int64 = 9106
	flow := &fakeFlowStore{
		tryAcquireIsolateFunc: func(_ context.Context, _, _, _, _ string, _ []byte) (bool, *store.Flow, error) {
			return true, &store.Flow{ID: wantFlowID, Status: store.FlowStatusInProgress}, nil
		},
	}
	ctl := &fakeCTLClient{
		destroyFunc: func(_ context.Context, _ string, req *ctlclient.DestroyPassRequest) (*ctlclient.DestroyPassResponse, error) {
			if req.DestroyReason != "" {
				t.Errorf("expected empty DestroyReason for tombstone, got %q", req.DestroyReason)
			}
			return &ctlclient.DestroyPassResponse{TaskID: "task-tombstone"}, nil
		},
	}
	deps := newDeps(flow, ctl)

	p := defaultPara()
	p.Source = "" // Q24 ✅ 拍板：合法 tombstone 值
	resp, _ := makeHandler(deps)(context.Background(), paraJSON(t, p))
	if resp.ReturnCode != 0 {
		t.Fatalf("expected success, got %d msg=%s", resp.ReturnCode, resp.ReturnMessage)
	}
}
