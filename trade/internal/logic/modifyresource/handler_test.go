package modifyresource

import (
	"context"
	"encoding/json"
	"errors"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"git.woa.com/wisp/mono/trade/internal/ctlclient"
	"git.woa.com/wisp/mono/trade/internal/httpapi/jifei"
	jifeiproto "git.woa.com/wisp/mono/trade/internal/jifei"
	"git.woa.com/wisp/mono/trade/internal/store"
)

// 需求：TAPD 1010132091137784162 §5.2 / §7.1

const (
	testDealName       = "20260509000000001-001"
	testPassID         = "lhpass-r1"
	testAppIDStr       = "12345678"
	testFlowID         = int64(9001)
	testSourceBundleID = "bundle_sail"
	testTargetBundleID = "bundle_cruise"
)

const (
	testProductCode    = "p_lighthouse"
	testSubProductCode = "sp_lightvela_cn"
)

// ---- fakes -------------------------------------------------------------------

type markCall struct {
	dealName     string
	flowType     string
	appID        string
	responseBody []byte
}

type fakeFlowStore struct {
	mu sync.Mutex

	tryAcquireFunc      func(ctx context.Context, dealName, flowType, appID string, body []byte) (bool, *store.Flow, error)
	getFlowFunc         func(ctx context.Context, dealName, flowType, appID string) (*store.Flow, error)
	markCompletedCalls  []markCall
	markFailedCalls     []markCall
	recordAcceptedFn    func(ctx context.Context, id int64, resourceID string, body []byte) error
	recordAcceptedCalls []acceptedCall
}

type acceptedCall struct {
	id           int64
	resourceID   string
	responseBody []byte
}

func (f *fakeFlowStore) TryAcquireSlot(ctx context.Context, dealName, flowType, appID string, body []byte) (bool, *store.Flow, error) {
	if f.tryAcquireFunc != nil {
		return f.tryAcquireFunc(ctx, dealName, flowType, appID, body)
	}
	return true, nil, nil
}
func (f *fakeFlowStore) GetFlow(ctx context.Context, dealName, flowType, appID string) (*store.Flow, error) {
	if f.getFlowFunc != nil {
		return f.getFlowFunc(ctx, dealName, flowType, appID)
	}
	return &store.Flow{ID: testFlowID, DealName: dealName, FlowType: flowType, AppID: appID}, nil
}
func (f *fakeFlowStore) MarkCompleted(_ context.Context, dealName, flowType, appID string, body []byte) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.markCompletedCalls = append(f.markCompletedCalls, markCall{dealName, flowType, appID, append([]byte(nil), body...)})
	return nil
}
func (f *fakeFlowStore) MarkFailed(_ context.Context, dealName, flowType, appID string, body []byte) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.markFailedCalls = append(f.markFailedCalls, markCall{dealName, flowType, appID, append([]byte(nil), body...)})
	return nil
}
func (f *fakeFlowStore) MarkCompletedWithResourceID(_ context.Context, _, _, _, _ string, _ []byte) error {
	return nil
}
func (f *fakeFlowStore) RecordAcceptedByID(ctx context.Context, id int64, resourceID string, body []byte) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.recordAcceptedCalls = append(f.recordAcceptedCalls, acceptedCall{
		id: id, resourceID: resourceID, responseBody: append([]byte(nil), body...),
	})
	if f.recordAcceptedFn != nil {
		return f.recordAcceptedFn(ctx, id, resourceID, body)
	}
	return nil
}
func (f *fakeFlowStore) ListInProgressBefore(_ context.Context, _ time.Time, _ int) ([]*store.Flow, error) {
	return nil, nil
}
func (f *fakeFlowStore) TryAcquireSlotForIsolate(_ context.Context, _, _, _, _ string, _ []byte, _ *string) (bool, *store.Flow, error) {
	return false, nil, errors.New("TryAcquireSlotForIsolate not used in modifyresource tests")
}
func (f *fakeFlowStore) MarkCompletedByID(_ context.Context, _ int64, _ []byte) error {
	return errors.New("MarkCompletedByID not used in modifyresource tests")
}
func (f *fakeFlowStore) MarkFailedByID(_ context.Context, _ int64, _ []byte) error {
	return errors.New("MarkFailedByID not used in modifyresource tests")
}
func (f *fakeFlowStore) DeleteByID(_ context.Context, _ int64) error {
	return errors.New("DeleteByID not used in modifyresource tests")
}
func (f *fakeFlowStore) GetByID(_ context.Context, _ int64) (*store.Flow, error) {
	return nil, store.ErrFlowNotFound
}

type fakeCTLClient struct {
	modifyFunc func(ctx context.Context, passID string, req *ctlclient.ModifyPassRequest) (*ctlclient.ModifyPassResponse, error)
	lastReq    *ctlclient.ModifyPassRequest
	calls      int
}

func (f *fakeCTLClient) ModifyPass(ctx context.Context, passID string, req *ctlclient.ModifyPassRequest) (*ctlclient.ModifyPassResponse, error) {
	f.calls++
	f.lastReq = req
	if f.modifyFunc != nil {
		return f.modifyFunc(ctx, passID, req)
	}
	return &ctlclient.ModifyPassResponse{PassID: passID, TaskID: "task-1"}, nil
}
func (f *fakeCTLClient) CheckPassModify(_ context.Context, _ string, _ *ctlclient.CheckPassModifyRequest) (*ctlclient.CheckPassModifyResponse, error) {
	return nil, errors.New("CheckPassModify not used in modifyresource tests")
}
func (f *fakeCTLClient) GetBundleByID(_ context.Context, _ string) (*ctlclient.BundleDetail, error) {
	return nil, errors.New("GetBundleByID not used in modifyresource tests")
}
func (f *fakeCTLClient) ListPassesByUser(_ context.Context, _ string) ([]*ctlclient.PassDetail, error) {
	return nil, errors.New("ListPassesByUser not used in modifyresource tests")
}
func (f *fakeCTLClient) CompletePass(_ context.Context, _ *ctlclient.CompletePassRequest) (*ctlclient.PassDetail, error) {
	return nil, errors.New("CompletePass not used in modifyresource tests")
}
func (f *fakeCTLClient) TransferPass(_ context.Context, _ *ctlclient.TransferPassRequest) (*ctlclient.PassDetail, error) {
	return nil, errors.New("TransferPass not used in modifyresource tests")
}
func (f *fakeCTLClient) ListPassAppIDs(_ context.Context, _ []string, _, _ int) ([]int64, int64, error) {
	return nil, 0, errors.New("ListPassAppIDs not used in modifyresource tests")
}
func (f *fakeCTLClient) ListPassesByAppID(_ context.Context, _ int64, _ []string, _, _ int) ([]*ctlclient.PassDetail, int64, error) {
	return nil, 0, errors.New("ListPassesByAppID not used in modifyresource tests")
}
func (f *fakeCTLClient) ListPassesByResourceIDs(_ context.Context, _ int64, _ []string) ([]*ctlclient.PassDetail, error) {
	return nil, errors.New("ListPassesByResourceIDs not used in modifyresource tests")
}
func (f *fakeCTLClient) IsolatePass(_ context.Context, _ string, _ *ctlclient.IsolatePassRequest) (*ctlclient.IsolatePassResponse, error) {
	return nil, errors.New("IsolatePass not used in modifyresource tests")
}
func (f *fakeCTLClient) RenewPass(_ context.Context, _ string, _ *ctlclient.RenewPassRequest) (*ctlclient.RenewPassResponse, error) {
	return nil, errors.New("RenewPass not used in modifyresource tests")
}
func (f *fakeCTLClient) DestroyPass(_ context.Context, _ string, _ *ctlclient.DestroyPassRequest) (*ctlclient.DestroyPassResponse, error) {
	return nil, errors.New("DestroyPass not used in modifyresource tests")
}

// fakeBundleStore 桩 trade_bundle_definition。
//
// ListBundleDefsBySubProductCode 是本 handler 反查套餐的唯一入口：计费不回传
// bundleId / newBundleId，源与目标全靠 oldConfig / newConfig 的 SV 集合在同
// (productCode, subProductCode) 域内反查。桩实现按这两个维度过滤，与真实 DAO 的
// WHERE 条件保持一致，否则测试会放过"检索域没传进去"这类缺陷。
type fakeBundleStore struct {
	defs map[string]*store.BundleDefinition
	err  error
}

func (f *fakeBundleStore) GetBundleDefinitionByID(_ context.Context, id string) (*store.BundleDefinition, error) {
	def := f.defs[id]
	if def == nil {
		return nil, store.ErrBundleDefinitionNotFound
	}
	return def, nil
}

func (f *fakeBundleStore) ListBundleDefsBySubProductCode(
	_ context.Context,
	productCode, subProductCode string,
) ([]*store.BundleDefinition, error) {
	if f.err != nil {
		return nil, f.err
	}
	out := make([]*store.BundleDefinition, 0, len(f.defs))
	for _, def := range f.defs {
		if def == nil {
			continue
		}
		if def.ProductCode == productCode && def.SubProductCode == subProductCode {
			out = append(out, def)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].BundleID < out[j].BundleID })
	return out, nil
}

func (f *fakeBundleStore) GetBundleDefinitionsByIDs(_ context.Context, ids []string) (map[string]*store.BundleDefinition, error) {
	if f.err != nil {
		return nil, f.err
	}
	out := make(map[string]*store.BundleDefinition, len(ids))
	for _, id := range ids {
		if def := f.defs[id]; def != nil {
			out[id] = def
		}
	}
	return out, nil
}

// ---- fixtures ----------------------------------------------------------------

func stdBuilder() *jifei.FrameworkBuilder {
	return &jifei.FrameworkBuilder{ComponentName: "trade", Version: "v1"}
}

// stdDefs 的 SV 集合必须与 stdParaMap 的 oldConfig / newConfig 逐项相等，
// 否则反查落空，所有用例都会退化成 600901。
func stdDefs() map[string]*store.BundleDefinition {
	return map[string]*store.BundleDefinition{
		testSourceBundleID: {
			BundleID:       testSourceBundleID,
			ProductCode:    testProductCode,
			SubProductCode: testSubProductCode,
			Pid:            4001,
			SVList:         map[string]int64{"sv_cpu": 2, "sv_mem": 4, "sv_disk": 60},
		},
		testTargetBundleID: {
			BundleID:       testTargetBundleID,
			ProductCode:    testProductCode,
			SubProductCode: testSubProductCode,
			Pid:            4001,
			SVList:         map[string]int64{"sv_cpu": 4, "sv_mem": 8, "sv_disk": 80},
		},
	}
}

func stdParaMap() map[string]any {
	return map[string]any{
		"dealName":       testDealName,
		"appId":          12345678,
		"uin":            "100012345678",
		"resourceId":     testPassID,
		"tranId":         "tran-1",
		"productCode":    testProductCode,
		"subProductCode": testSubProductCode,
		"goodsDetail": map[string]any{
			"goodsNum":    1,
			"curDeadline": "2026-06-15 10:30:00",
			"oldConfig": map[string]any{
				"sv_cpu": 2, "sv_mem": 4, "sv_disk": 60,
				// 内层元信息：计费变配询价强制要求，反查时必须被 sv_ 前缀过滤掉，
				// 否则会以"键数不一致"误判成配置不符。
				"pid": 4001, "productCode": testProductCode, "subProductCode": testSubProductCode,
			},
			"newConfig": map[string]any{
				"sv_cpu": 4, "sv_mem": 8, "sv_disk": 80,
				"pid": 4001, "productCode": testProductCode, "subProductCode": testSubProductCode,
			},
		},
	}
}

func stdDeps() (Deps, *fakeFlowStore, *fakeCTLClient) {
	flows := &fakeFlowStore{}
	ctl := &fakeCTLClient{}
	return Deps{
		FlowStore:   flows,
		CTLClient:   ctl,
		Builder:     stdBuilder(),
		BundleStore: &fakeBundleStore{defs: stdDefs()},
	}, flows, ctl
}

func invokeHandler(t *testing.T, deps Deps, paraMap map[string]any) jifei.Framework {
	t.Helper()
	raw, err := json.Marshal(paraMap)
	if err != nil {
		t.Fatalf("marshal para: %v", err)
	}
	resp, err := makeHandler(deps)(context.Background(), raw)
	if err != nil {
		t.Fatalf("makeHandler returned non-nil err: %v", err)
	}
	return resp
}

// ---- happy path --------------------------------------------------------------

func TestModifyResourceHappyPath(t *testing.T) {
	deps, flows, ctl := stdDeps()
	resp := invokeHandler(t, deps, stdParaMap())

	if resp.ReturnCode != 0 {
		t.Fatalf("returnCode = %d, want 0 (msg=%q)", resp.ReturnCode, resp.ReturnMessage)
	}
	// flowId 是异步语义的唯一出参，为 0 会让计费当成同步发货完成。
	if resp.Data["flowId"] != testFlowID {
		t.Errorf("data.flowId = %v, want %d", resp.Data["flowId"], testFlowID)
	}
	if ctl.calls != 1 {
		t.Fatalf("ctl ModifyPass calls = %d, want 1", ctl.calls)
	}
	req := ctl.lastReq
	if req.SourceBundleID != testSourceBundleID || req.TargetBundleID != testTargetBundleID {
		t.Errorf("bundle pair = %q → %q", req.SourceBundleID, req.TargetBundleID)
	}
	// CTL 用 flow_id 区分"同一笔单重投"和"另一笔单插队"，为 0 时并发保护失效。
	if req.FlowID != testFlowID {
		t.Errorf("FlowID = %d, want %d", req.FlowID, testFlowID)
	}
	if req.DealName != testDealName || req.TranID != "tran-1" {
		t.Errorf("dealName/tranId = %q/%q", req.DealName, req.TranID)
	}
	if req.Uin != 100012345678 || req.AppID != 12345678 {
		t.Errorf("uin/appId = %d/%d", req.Uin, req.AppID)
	}
	if len(flows.markCompletedCalls) != 0 {
		t.Fatalf("markCompleted calls = %d, want 0 before CTL parent completion", len(flows.markCompletedCalls))
	}
	if len(flows.recordAcceptedCalls) != 1 {
		t.Fatalf("RecordAcceptedByID calls = %d, want 1", len(flows.recordAcceptedCalls))
	}
	if got := flows.recordAcceptedCalls[0]; got.id != testFlowID || got.resourceID != testPassID ||
		!strings.Contains(string(got.responseBody), `"flowId"`) {
		t.Errorf("RecordAcceptedByID call = %+v", got)
	}
}

// ---- InvalidPara (B 类，不退款) ------------------------------------------------

func TestModifyResourceInvalidPara(t *testing.T) {
	cases := []struct {
		name string
		para map[string]any
		want string
	}{
		{"missing dealName", func() map[string]any { p := stdParaMap(); p["dealName"] = ""; return p }(), "dealName"},
		{"invalid uin", func() map[string]any { p := stdParaMap(); p["uin"] = "invalid"; return p }(), "uin"},
		{"zero uin", func() map[string]any { p := stdParaMap(); p["uin"] = "0"; return p }(), "uin"},
		{"overflow uin", func() map[string]any { p := stdParaMap(); p["uin"] = "9223372036854775808"; return p }(), "uin"},
		{"missing curDeadline", func() map[string]any {
			p := stdParaMap()
			delete(p["goodsDetail"].(map[string]any), "curDeadline")
			return p
		}(), "curDeadline"},
		{"missing appId", func() map[string]any { p := stdParaMap(); p["appId"] = 0; return p }(), "appId"},
		{"missing resourceId", func() map[string]any { p := stdParaMap(); p["resourceId"] = ""; return p }(), "resourceId"},
		// oldConfig / newConfig 取代了原先的 bundleId / newBundleId 必填校验：
		// 计费只回传协议内字段，自定义键实测被丢弃（2026-09-02 曾固定返 600901）。
		{"missing oldConfig", func() map[string]any {
			p := stdParaMap()
			delete(p["goodsDetail"].(map[string]any), "oldConfig")
			return p
		}(), "oldConfig"},
		{"missing newConfig", func() map[string]any {
			p := stdParaMap()
			delete(p["goodsDetail"].(map[string]any), "newConfig")
			return p
		}(), "newConfig"},
		// 只剩内层元信息、没有任何 sv_*：形状合法但无从判断规格，必须拒。
		{"oldConfig without sv items", func() map[string]any {
			p := stdParaMap()
			p["goodsDetail"].(map[string]any)["oldConfig"] = map[string]any{"pid": 4001}
			return p
		}(), "oldConfig"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			deps, flows, ctl := stdDeps()
			flows.tryAcquireFunc = func(context.Context, string, string, string, []byte) (bool, *store.Flow, error) {
				t.Error("invalid para must not acquire a flow slot")
				return false, nil, errors.New("unexpected flow acquisition")
			}
			resp := invokeHandler(t, deps, c.para)
			if resp.ReturnCode != ReturnCodeInvalidPara {
				t.Fatalf("returnCode = %d, want %d (msg=%q)",
					resp.ReturnCode, ReturnCodeInvalidPara, resp.ReturnMessage)
			}
			if !strings.Contains(resp.ReturnMessage, c.want) {
				t.Errorf("message %q should mention %q", resp.ReturnMessage, c.want)
			}
			// 参数级失败必须发生在抢占之前：否则 dealName 为空的坏请求会占掉 flow 槽位。
			if ctl.calls != 0 || len(flows.markCompletedCalls) != 0 || len(flows.markFailedCalls) != 0 {
				t.Error("invalid para must short-circuit before ctl / flow writes")
			}
		})
	}
}

func TestModifyResourceInvalidParaBadJSON(t *testing.T) {
	deps, _, _ := stdDeps()
	resp, err := makeHandler(deps)(context.Background(), json.RawMessage(`{not json`))
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if resp.ReturnCode != ReturnCodeInvalidPara {
		t.Fatalf("returnCode = %d, want %d", resp.ReturnCode, ReturnCodeInvalidPara)
	}
}

// ---- 幂等：抢占失败三分支 -------------------------------------------------------

func TestModifyResourceReplaysCompletedFlow(t *testing.T) {
	deps, flows, ctl := stdDeps()
	persisted, err := json.Marshal(jifei.Framework{
		ReturnCode: 0, ReturnValue: 0, ComponentName: "trade", Version: "v1",
		Data: map[string]any{"flowId": testFlowID},
	})
	if err != nil {
		t.Fatalf("marshal persisted response: %v", err)
	}
	flows.tryAcquireFunc = func(context.Context, string, string, string, []byte) (bool, *store.Flow, error) {
		return false, &store.Flow{
			ID: testFlowID, DealName: testDealName, Status: store.FlowStatusCompleted, ResponseBody: persisted,
		}, nil
	}

	resp := invokeHandler(t, deps, stdParaMap())
	if resp.ReturnCode != 0 {
		t.Fatalf("returnCode = %d, want replayed 0 (msg=%q)", resp.ReturnCode, resp.ReturnMessage)
	}
	// 回放路径不能再受理一次：重复入队会让 CTL 侧多跑一轮变配。
	if ctl.calls != 0 {
		t.Errorf("ctl ModifyPass calls = %d, want 0 on replay", ctl.calls)
	}
	// 重投必须回同一个 flowId（§8.1）。回放丢了 flowId 或换了新值，jifei 会去
	// queryFlow 一个不存在的 flow，把一笔已受理的单判成发货失败去退款。
	if got := flowIDFromData(t, resp.Data); got != testFlowID {
		t.Errorf("replayed flowId = %d, want the original %d", got, testFlowID)
	}
}

// flowIDFromData 从回调响应里取 flowId。
// 回放走的是持久化后再反序列化的路径，数值到达这里是 float64；首次受理是 int64。
func flowIDFromData(t *testing.T, data map[string]any) int64 {
	t.Helper()
	switch v := data["flowId"].(type) {
	case int64:
		return v
	case float64:
		return int64(v)
	default:
		t.Fatalf("data.flowId is %T (%v), want a number", data["flowId"], data["flowId"])
		return 0
	}
}

func TestModifyResourceInProgressWithoutAcceptanceRetriesCTLIdempotently(t *testing.T) {
	deps, flows, ctl := stdDeps()
	flows.tryAcquireFunc = func(context.Context, string, string, string, []byte) (bool, *store.Flow, error) {
		return false, &store.Flow{
			ID: testFlowID, DealName: testDealName, Status: store.FlowStatusInProgress,
		}, nil
	}

	resp := invokeHandler(t, deps, stdParaMap())
	if resp.ReturnCode != 0 {
		t.Fatalf("returnCode = %d, want recovered success", resp.ReturnCode)
	}
	if ctl.calls != 1 {
		t.Errorf("ctl calls = %d, want 1 idempotent retry", ctl.calls)
	}
	if len(flows.recordAcceptedCalls) != 1 {
		t.Fatalf("RecordAcceptedByID calls = %d, want 1", len(flows.recordAcceptedCalls))
	}
}

func TestModifyResourceInProgressWithAcceptanceReplaysWithoutCTL(t *testing.T) {
	deps, flows, ctl := stdDeps()
	persisted, err := json.Marshal(jifei.Framework{
		ReturnCode: 0, ReturnValue: 0, ComponentName: "trade", Version: "v1",
		Data: map[string]any{"flowId": testFlowID},
	})
	if err != nil {
		t.Fatal(err)
	}
	flows.tryAcquireFunc = func(context.Context, string, string, string, []byte) (bool, *store.Flow, error) {
		return false, &store.Flow{
			ID: testFlowID, DealName: testDealName, Status: store.FlowStatusInProgress,
			ResponseBody: persisted,
		}, nil
	}

	resp := invokeHandler(t, deps, stdParaMap())
	if resp.ReturnCode != 0 || flowIDFromData(t, resp.Data) != testFlowID {
		t.Fatalf("unexpected replay response: %+v", resp)
	}
	if ctl.calls != 0 {
		t.Errorf("ctl calls = %d, want 0 for accepted replay", ctl.calls)
	}
}

func TestModifyResourceRecordAcceptanceFailureIsRetriable(t *testing.T) {
	deps, flows, _ := stdDeps()
	flows.recordAcceptedFn = func(context.Context, int64, string, []byte) error {
		return errors.New("db unavailable")
	}

	resp := invokeHandler(t, deps, stdParaMap())
	if resp.ReturnCode != ReturnCodeUpstreamUnavailable {
		t.Fatalf("returnCode = %d, want %d", resp.ReturnCode, ReturnCodeUpstreamUnavailable)
	}
	if len(flows.markCompletedCalls) != 0 {
		t.Fatalf("must not complete flow when acceptance persistence fails")
	}
}

func TestModifyResourceCorruptedReplay(t *testing.T) {
	cases := []struct {
		name string
		body []byte
	}{
		{"empty body", nil},
		{"unparsable body", []byte(`{not json`)},
		// Q58 不变量：returnCode 必须 == returnValue，破坏时不能原样回放。
		{"invariant broken", []byte(`{"returnCode":0,"returnValue":352014}`)},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			deps, flows, _ := stdDeps()
			flows.tryAcquireFunc = func(context.Context, string, string, string, []byte) (bool, *store.Flow, error) {
				return false, &store.Flow{
					ID: testFlowID, DealName: testDealName,
					Status: store.FlowStatusFailed, ResponseBody: c.body,
				}, nil
			}
			resp := invokeHandler(t, deps, stdParaMap())
			if resp.ReturnCode != ReturnCodeFlowReplayCorrupted {
				t.Fatalf("returnCode = %d, want %d (msg=%q)",
					resp.ReturnCode, ReturnCodeFlowReplayCorrupted, resp.ReturnMessage)
			}
		})
	}
}

func TestModifyResourceAcquireErrorIsRetriable(t *testing.T) {
	deps, flows, _ := stdDeps()
	flows.tryAcquireFunc = func(context.Context, string, string, string, []byte) (bool, *store.Flow, error) {
		return false, nil, errors.New("db down")
	}
	resp := invokeHandler(t, deps, stdParaMap())
	if resp.ReturnCode != ReturnCodeUpstreamUnavailable {
		t.Fatalf("returnCode = %d, want %d", resp.ReturnCode, ReturnCodeUpstreamUnavailable)
	}
}

func TestModifyResourceWinnerFlowLookupFailure(t *testing.T) {
	deps, flows, ctl := stdDeps()
	flows.getFlowFunc = func(context.Context, string, string, string) (*store.Flow, error) {
		return nil, store.ErrFlowNotFound
	}
	resp := invokeHandler(t, deps, stdParaMap())
	if resp.ReturnCode != ReturnCodeUpstreamUnavailable {
		t.Fatalf("returnCode = %d, want %d", resp.ReturnCode, ReturnCodeUpstreamUnavailable)
	}
	// 拿不到 flowId 就不能受理：CTL 侧没有幂等键会导致重投时无法识别同一笔单。
	if ctl.calls != 0 {
		t.Errorf("ctl calls = %d, want 0", ctl.calls)
	}
}

// ---- Q56 A/B 分类：退款 vs 重试 -----------------------------------------------

func TestModifyResourceCTLErrorClassification(t *testing.T) {
	cases := []struct {
		name          string
		err           error
		wantCode      int
		wantMarkFail  bool
		wantCompleted bool
	}{
		{
			// A 类：CTL 认定这笔单永久发不出去（含另一笔变配占着 pass）。
			name:         "ctl 4xx refunds",
			err:          &ctlclient.Error{HTTPStatus: 409, Code: "PASS_MODIFYING", Message: "held by another flow"},
			wantCode:     jifei.RefundReturnCode,
			wantMarkFail: true,
		},
		{
			name:         "pass not found refunds",
			err:          ctlclient.ErrNotFound,
			wantCode:     jifei.RefundReturnCode,
			wantMarkFail: true,
		},
		{
			name:     "ctl 5xx retries",
			err:      &ctlclient.Error{HTTPStatus: 503, Code: "UNAVAILABLE", Message: "boom"},
			wantCode: ReturnCodeUpstreamUnavailable,
		},
		{
			name:     "network error retries",
			err:      errors.New("connection refused"),
			wantCode: ReturnCodeUpstreamUnavailable,
		},
		{
			// 内部 token 不一致是配置错，rotate 后可恢复 → 不能退款。
			name:     "unauthorized retries",
			err:      ctlclient.ErrUnauthorized,
			wantCode: ReturnCodeUpstreamUnavailable,
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			deps, flows, ctl := stdDeps()
			ctl.modifyFunc = func(context.Context, string, *ctlclient.ModifyPassRequest) (*ctlclient.ModifyPassResponse, error) {
				return nil, c.err
			}
			resp := invokeHandler(t, deps, stdParaMap())
			if resp.ReturnCode != c.wantCode {
				t.Fatalf("returnCode = %d, want %d (msg=%q)", resp.ReturnCode, c.wantCode, resp.ReturnMessage)
			}
			if got := len(flows.markFailedCalls) > 0; got != c.wantMarkFail {
				t.Errorf("markFailed = %v, want %v", got, c.wantMarkFail)
			}
			// B 类必须保留 in_progress，交给 reconcile worker 按 ctl 实际状态收敛。
			if len(flows.markCompletedCalls) != 0 {
				t.Errorf("markCompleted calls = %d, want 0", len(flows.markCompletedCalls))
			}
		})
	}
}

func TestModifyResourceEmptyPassIDIsRetriable(t *testing.T) {
	deps, flows, ctl := stdDeps()
	ctl.modifyFunc = func(context.Context, string, *ctlclient.ModifyPassRequest) (*ctlclient.ModifyPassResponse, error) {
		return &ctlclient.ModifyPassResponse{}, nil
	}
	resp := invokeHandler(t, deps, stdParaMap())
	if resp.ReturnCode != ReturnCodeUpstreamUnavailable {
		t.Fatalf("returnCode = %d, want %d (msg=%q)",
			resp.ReturnCode, ReturnCodeUpstreamUnavailable, resp.ReturnMessage)
	}
	if len(flows.markCompletedCalls) != 0 || len(flows.markFailedCalls) != 0 {
		t.Error("协议异常应保留 in_progress")
	}
}

// curDeadline 格式错走 InvalidPara，且不能受理发货。
func TestModifyResourceBadCurDeadline(t *testing.T) {
	deps, _, ctl := stdDeps()
	para := stdParaMap()
	para["goodsDetail"].(map[string]any)["curDeadline"] = "2026/06/15 10:30:00"

	resp := invokeHandler(t, deps, para)
	if resp.ReturnCode != ReturnCodeInvalidPara {
		t.Fatalf("returnCode = %d, want %d", resp.ReturnCode, ReturnCodeInvalidPara)
	}
	if ctl.calls != 0 {
		t.Errorf("ctl calls = %d, want 0", ctl.calls)
	}
}

// ---- Install -----------------------------------------------------------------

func TestInstallRegistersModifyResourceHandler(t *testing.T) {
	d := jifei.NewDispatcher("lightvela", stdBuilder())
	deps, _, _ := stdDeps()

	Install(d, deps)

	defer func() {
		if r := recover(); r == nil {
			t.Error("expected panic on duplicate Install (dispatcher.Register 同名重复)")
		}
	}()
	Install(d, deps)
}

// 与 checkmodify 的同名用例同理：下单时实际送出的 goodsDetail 必须能被发货回调读回来。
// 这里是钱已经扣了之后的路径，key 漂移的代价是把可交付的单判成发货失败去退款。
func TestModifyResourceAcceptsGoodsDetailBuiltByOrderPath(t *testing.T) {
	para := stdParaMap()
	para["goodsDetail"] = jifeiproto.BuildModifyGoodsDetail(jifeiproto.ModifyGoodsDetailInput{
		ProductCode:    "p_lighthouse",
		SubProductCode: "sp_lightvela_cn",
		Pid:            4001,
		ResourceID:     testPassID,
		CurDeadline:    "2026-06-15 10:30:00",
		SourceBundleID: testSourceBundleID,
		TargetBundleID: testTargetBundleID,
		SourceSVList:   map[string]int64{"sv_cpu": 2, "sv_mem": 4, "sv_disk": 60},
		TargetSVList:   map[string]int64{"sv_cpu": 4, "sv_mem": 8, "sv_disk": 80},
	})

	deps, _, ctl := stdDeps()
	resp := invokeHandler(t, deps, para)

	if resp.ReturnCode != 0 {
		t.Fatalf("returnCode = %d, want 0 (msg=%q)", resp.ReturnCode, resp.ReturnMessage)
	}
	if ctl.calls != 1 {
		t.Fatalf("ctl ModifyPass calls = %d, want 1", ctl.calls)
	}
	req := ctl.lastReq
	if req.SourceBundleID != testSourceBundleID || req.TargetBundleID != testTargetBundleID {
		t.Fatalf("bundle pair = %q → %q", req.SourceBundleID, req.TargetBundleID)
	}
	if req.CurDeadline == nil {
		t.Fatal("CurDeadline is nil, want the built literal parsed back")
	}
}

// ---- SV 反查（2026-09-02 实测缺陷的回归） --------------------------------------

// jifeiCallbackFilter 模拟计费的真实行为：只回传协议字段表内认识的键，
// trade 出向自塞的 bundleId / newBundleId 被丢弃。
//
// 这是本 handler 曾固定返 600901 "goodsDetail.bundleId is required" 的根因。
// 不动内层 oldConfig / newConfig 的 pid 等元信息：那些是计费协议要求的，会原样回来。
func jifeiCallbackFilter(goodsDetail map[string]any) map[string]any {
	allowed := map[string]bool{
		"oldConfig": true, "newConfig": true, "curDeadline": true,
		"goodsNum": true, "pid": true, "timeSpan": true, "timeUnit": true,
	}
	out := make(map[string]any, len(goodsDetail))
	for k, v := range goodsDetail {
		if allowed[k] {
			out[k] = v
		}
	}
	return out
}

// 计费过滤掉自定义键后仍必须能发货：源 / 目标全靠 SV 集合反查。
func TestModifyResourceResolvesBundlesAfterJifeiDropsCustomKeys(t *testing.T) {
	para := stdParaMap()
	built := jifeiproto.BuildModifyGoodsDetail(jifeiproto.ModifyGoodsDetailInput{
		ProductCode:    testProductCode,
		SubProductCode: testSubProductCode,
		Pid:            4001,
		ResourceID:     testPassID,
		CurDeadline:    "2026-06-15 10:30:00",
		SourceBundleID: testSourceBundleID,
		TargetBundleID: testTargetBundleID,
		SourceSVList:   map[string]int64{"sv_cpu": 2, "sv_mem": 4, "sv_disk": 60},
		TargetSVList:   map[string]int64{"sv_cpu": 4, "sv_mem": 8, "sv_disk": 80},
	})
	filtered := jifeiCallbackFilter(built)
	if _, ok := filtered["bundleId"]; ok {
		t.Fatal("fixture 失效：过滤后仍带 bundleId，这条用例就测不到反查了")
	}
	para["goodsDetail"] = filtered

	deps, _, ctl := stdDeps()
	resp := invokeHandler(t, deps, para)

	if resp.ReturnCode != 0 {
		t.Fatalf("returnCode = %d, want 0 (msg=%q)", resp.ReturnCode, resp.ReturnMessage)
	}
	req := ctl.lastReq
	if req.SourceBundleID != testSourceBundleID || req.TargetBundleID != testTargetBundleID {
		t.Fatalf("bundle pair = %q → %q, want %q → %q",
			req.SourceBundleID, req.TargetBundleID, testSourceBundleID, testTargetBundleID)
	}
}

// 反查失败的分档：配置问题 vs DB 故障要用不同码，且都不能退款。
func TestModifyResourceResolveFailures(t *testing.T) {
	cases := []struct {
		name     string
		mutate   func(*Deps, map[string]any)
		wantCode int
		wantMsg  string
	}{
		{
			// 运营改了 SV 没同步接入单：B 类重试，修好配置这笔单还能发货，不能退款。
			name: "newConfig matches no bundle",
			mutate: func(_ *Deps, para map[string]any) {
				para["goodsDetail"].(map[string]any)["newConfig"] = map[string]any{
					"sv_cpu": 16, "sv_mem": 32, "sv_disk": 500,
				}
			},
			wantCode: ReturnCodeInvalidPara,
			wantMsg:  "newConfig",
		},
		{
			// 同 SP 内两个套餐共用同一份 SV：任何选择都是猜，fail-closed。
			name: "ambiguous sv list",
			mutate: func(d *Deps, _ map[string]any) {
				defs := stdDefs()
				defs["bundle_cruise_dup"] = &store.BundleDefinition{
					BundleID:       "bundle_cruise_dup",
					ProductCode:    testProductCode,
					SubProductCode: testSubProductCode,
					Pid:            4001,
					SVList:         map[string]int64{"sv_cpu": 4, "sv_mem": 8, "sv_disk": 80},
				}
				d.BundleStore = &fakeBundleStore{defs: defs}
			},
			wantCode: ReturnCodeInvalidPara,
			wantMsg:  "ambiguous",
		},
		{
			// DB 故障与"配置对不上"要能区分：值班的处置动作完全不同。
			name: "bundle store db error is upstream",
			mutate: func(d *Deps, _ map[string]any) {
				d.BundleStore = &fakeBundleStore{defs: stdDefs(), err: errors.New("db down")}
			},
			wantCode: ReturnCodeUpstreamUnavailable,
			wantMsg:  "db down",
		},
		{
			// 检索域缺失会让候选集跨 SP，违背本期同 SP 边界。
			name: "missing subProductCode",
			mutate: func(_ *Deps, para map[string]any) {
				para["subProductCode"] = ""
			},
			wantCode: ReturnCodeInvalidPara,
			wantMsg:  "subProductCode",
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			deps, flows, ctl := stdDeps()
			para := stdParaMap()
			c.mutate(&deps, para)

			resp := invokeHandler(t, deps, para)
			if resp.ReturnCode != c.wantCode {
				t.Fatalf("returnCode = %d, want %d (msg=%q)", resp.ReturnCode, c.wantCode, resp.ReturnMessage)
			}
			if !strings.Contains(resp.ReturnMessage, c.wantMsg) {
				t.Errorf("message %q should mention %q", resp.ReturnMessage, c.wantMsg)
			}
			// 反查失败绝不能退款，也不能受理发货。
			if resp.ReturnCode == jifei.RefundReturnCode {
				t.Error("反查失败不得退款：修好配置后这笔单仍可发货")
			}
			if ctl.calls != 0 {
				t.Errorf("ctl calls = %d, want 0", ctl.calls)
			}
			if len(flows.markCompletedCalls) != 0 || len(flows.markFailedCalls) != 0 {
				t.Error("B 类失败应保留 in_progress 交给 reconcile 收敛")
			}
		})
	}
}
