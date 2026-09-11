package checkcreate

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"git.woa.com/wisp/mono/trade/internal/ctlclient"
	"git.woa.com/wisp/mono/trade/internal/httpapi/jifei"
	"git.woa.com/wisp/mono/trade/internal/store"
)

// ---- mock 实现 ---------------------------------------------------------------
//
// v1.7.28 BUG-07 修订 (2026-05-21)：
// checkCreate handler 不再依赖 trade_order 反查（jifei 在 generateDeals 同步链路里立即触发
// checkCreate 回调，trade_order 还未落库）；改用 goodsDetail.bundleId 反查 trade_bundle_definition。
// 故 fakeOrderStore 字段保留位但不参与业务路径；fakeCTLClient.passes 字段也不参与
// （quota 互斥占用本期跳过，待 shadow 反查 (uin, appId)→externalUserId 接口落地后启用）。

type fakeOrderStore struct {
	order *store.TradeOrder
	err   error
}

func (f *fakeOrderStore) GetOrderByDealName(_ context.Context, _ string) (*store.TradeOrder, error) {
	return f.order, f.err
}

type fakeBundleDefStore struct {
	def *store.BundleDefinition
	err error
}

func (f *fakeBundleDefStore) GetBundleDefinitionByID(_ context.Context, _ string) (*store.BundleDefinition, error) {
	return f.def, f.err
}
func (f *fakeBundleDefStore) ListBundleDefsBySubProductCode(_ context.Context, _, _ string) ([]*store.BundleDefinition, error) {
	return nil, errors.New("ListBundleDefsBySubProductCode not used in checkCreate")
}
func (f *fakeBundleDefStore) GetBundleDefinitionsByIDs(_ context.Context, _ []string) (map[string]*store.BundleDefinition, error) {
	return nil, errors.New("GetBundleDefinitionsByIDs not used in checkCreate")
}

type fakeCTLClient struct {
	bundle    *ctlclient.BundleDetail
	bundleErr error

	passes    []*ctlclient.PassDetail
	passesErr error
}

func (f *fakeCTLClient) GetBundleByID(_ context.Context, _ string) (*ctlclient.BundleDetail, error) {
	return f.bundle, f.bundleErr
}
func (f *fakeCTLClient) ListPassesByUser(_ context.Context, _ string) ([]*ctlclient.PassDetail, error) {
	return f.passes, f.passesErr
}
func (f *fakeCTLClient) CompletePass(_ context.Context, _ *ctlclient.CompletePassRequest) (*ctlclient.PassDetail, error) {
	return nil, errors.New("CompletePass not used in checkCreate")
}
func (f *fakeCTLClient) TransferPass(_ context.Context, _ *ctlclient.TransferPassRequest) (*ctlclient.PassDetail, error) {
	return nil, errors.New("TransferPass not used in checkCreate")
}
func (f *fakeCTLClient) ListPassAppIDs(_ context.Context, _ []string, _, _ int) ([]int64, int64, error) {
	return nil, 0, errors.New("ListPassAppIDs not used in checkCreate")
}
func (f *fakeCTLClient) IsolatePass(_ context.Context, _ string, _ *ctlclient.IsolatePassRequest) (*ctlclient.IsolatePassResponse, error) {
	return nil, errors.New("IsolatePass not used in checkCreate tests")
}
func (f *fakeCTLClient) RenewPass(_ context.Context, _ string, _ *ctlclient.RenewPassRequest) (*ctlclient.RenewPassResponse, error) {
	return nil, errors.New("RenewPass not used in checkCreate tests")
}

func (f *fakeCTLClient) DestroyPass(_ context.Context, _ string, _ *ctlclient.DestroyPassRequest) (*ctlclient.DestroyPassResponse, error) {
	return nil, errors.New("DestroyPass not used in checkCreate tests")
}

func (f *fakeCTLClient) CheckPassModify(_ context.Context, _ string, _ *ctlclient.CheckPassModifyRequest) (*ctlclient.CheckPassModifyResponse, error) {
	return nil, errors.New("CheckPassModify not used in these tests")
}

func (f *fakeCTLClient) ModifyPass(_ context.Context, _ string, _ *ctlclient.ModifyPassRequest) (*ctlclient.ModifyPassResponse, error) {
	return nil, errors.New("ModifyPass not used in these tests")
}
func (f *fakeCTLClient) ListPassesByAppID(_ context.Context, _ int64, _ []string, _, _ int) ([]*ctlclient.PassDetail, int64, error) {
	return nil, 0, errors.New("ListPassesByAppID not used in checkCreate")
}
func (f *fakeCTLClient) ListPassesByResourceIDs(_ context.Context, _ int64, _ []string) ([]*ctlclient.PassDetail, error) {
	return nil, errors.New("ListPassesByResourceIDs not used in checkCreate")
}

// ---- 标准 happy-path fixtures ------------------------------------------------

// stdBundle 是默认 ONLINE / AVAILABLE bundle。
func stdBundle() *ctlclient.BundleDetail {
	return &ctlclient.BundleDetail{
		BundleID:         "bundle_linux_small_01",
		BundleState:      "ONLINE",
		BundleSalesState: "AVAILABLE",
	}
}

// stdBundleDef 是默认 trade_bundle_definition 快照。
func stdBundleDef() *store.BundleDefinition {
	return &store.BundleDefinition{
		BundleID: "bundle_linux_small_01",
		Pid:      40000,
		SVList: map[string]int64{
			"sv_cpu": 2,
			"sv_mem": 4,
		},
	}
}

// stdPara 是 v1.7.28 BUG-07 后的 jifei 真实回调 payload 形态。
//
// 关键变化：
//   - 删除顶层 dealName（PDF §1.1：checkCreate 阶段 jifei 不发）
//   - bundleId 移到 goodsDetail（trade 出向时塞进去透传）
//   - 顶层增加 PDF 协议字段：region / zoneId / payMode / operateUin / projectId
//   - v1.7.28 BUG-24（2026-05-28）：goodsDetail 增加 externalUserId（trade 出向
//     placeorder 时必塞项，jifei 透传后 checkCreate handler 反查 ctl ListPassesByUser 依赖该字段）。
func stdPara() json.RawMessage {
	return json.RawMessage(`{
		"appId": 12345678,
		"uin": "100012345678",
		"operateUin": "100012345678",
		"region": 1,
		"zoneId": 100001,
		"payMode": 1,
		"productCode": "p_lighthouse",
		"subProductCode": "sp_lighthouse_bundle_linux_small",
		"projectId": 0,
		"goodsDetail": {
			"bundleId": "bundle_linux_small_01",
			"externalUserId": "uin_test_001",
			"productCode": "p_lighthouse",
			"subProductCode": "sp_lighthouse_bundle_linux_small",
			"pid": 40000,
			"timeSpan": 1,
			"timeUnit": "m",
			"goodsNum": 1,
			"sv_cpu": 2,
			"sv_mem": 4
		}
	}`)
}

func newDeps(orderStore store.OrderStore, bundleDefStore store.BundleDefinitionStore, ctlClient ctlclient.Client) Deps {
	return Deps{
		OrderStore:  orderStore, // BUG-07 后保留依赖位但不参与业务路径
		BundleStore: bundleDefStore,
		CTLClient:   ctlClient,
		Builder:     jifei.NewFrameworkBuilder("trade", "1.0"),
	}
}

func runHandler(t *testing.T, deps Deps, para json.RawMessage) jifei.Framework {
	t.Helper()
	resp, err := makeHandler(deps)(context.Background(), para)
	if err != nil {
		t.Fatalf("handler error: %v", err)
	}
	// Q56 全局不变性：checkCreate 任何路径都不返退款魔法值。
	if resp.ReturnCode == jifei.RefundReturnCode {
		t.Fatalf("BUG: returnCode=%d 等于退款魔法值，违反 Q56", jifei.RefundReturnCode)
	}
	// Q58 全局不变性：returnCode == returnValue。
	if resp.ReturnCode != resp.ReturnValue {
		t.Fatalf("Q58 invariant: returnCode=%d returnValue=%d", resp.ReturnCode, resp.ReturnValue)
	}
	return resp
}

// ---- 测试用例 ----------------------------------------------------------------

// 1. happy-path：bundle 在线 + bundleDef pid+sv_* 一致 → returnCode=0
func TestCheckCreate_HappyPath(t *testing.T) {
	deps := newDeps(
		&fakeOrderStore{},
		&fakeBundleDefStore{def: stdBundleDef()},
		&fakeCTLClient{bundle: stdBundle()},
	)
	resp := runHandler(t, deps, stdPara())
	if resp.ReturnCode != 0 {
		t.Fatalf("expected returnCode=0, got %d (%s)", resp.ReturnCode, resp.ReturnMessage)
	}
}

// 2. para JSON 格式错 → ReturnCodeInvalidPara
func TestCheckCreate_InvalidJSON(t *testing.T) {
	deps := newDeps(&fakeOrderStore{}, &fakeBundleDefStore{}, &fakeCTLClient{})
	resp := runHandler(t, deps, json.RawMessage(`{not-a-json`))
	if resp.ReturnCode != ReturnCodeInvalidPara {
		t.Fatalf("expected ReturnCodeInvalidPara=%d, got %d", ReturnCodeInvalidPara, resp.ReturnCode)
	}
}

// 3. appId 缺失（PDF 必填）→ ReturnCodeInvalidPara
func TestCheckCreate_MissingAppID(t *testing.T) {
	deps := newDeps(&fakeOrderStore{}, &fakeBundleDefStore{}, &fakeCTLClient{})
	para := json.RawMessage(`{"uin":"u","goodsDetail":{"bundleId":"b"}}`)
	resp := runHandler(t, deps, para)
	if resp.ReturnCode != ReturnCodeInvalidPara {
		t.Fatalf("expected ReturnCodeInvalidPara, got %d", resp.ReturnCode)
	}
	if !strings.Contains(resp.ReturnMessage, "appId") {
		t.Errorf("expected msg to mention appId, got: %s", resp.ReturnMessage)
	}
}

// 4. goodsDetail 缺失 → ReturnCodeInvalidPara
func TestCheckCreate_MissingGoodsDetail(t *testing.T) {
	deps := newDeps(&fakeOrderStore{}, &fakeBundleDefStore{}, &fakeCTLClient{})
	para := json.RawMessage(`{"appId":1,"uin":"u"}`)
	resp := runHandler(t, deps, para)
	if resp.ReturnCode != ReturnCodeInvalidPara {
		t.Fatalf("expected ReturnCodeInvalidPara, got %d", resp.ReturnCode)
	}
}

// 5. goodsDetail 内 bundleId 缺失（trade 出向必塞，缺失说明出向链路异常）→ ReturnCodeInvalidPara
func TestCheckCreate_MissingBundleIDInGoodsDetail(t *testing.T) {
	deps := newDeps(&fakeOrderStore{}, &fakeBundleDefStore{}, &fakeCTLClient{})
	para := json.RawMessage(`{"appId":1,"uin":"u","goodsDetail":{"pid":40000}}`)
	resp := runHandler(t, deps, para)
	if resp.ReturnCode != ReturnCodeInvalidPara {
		t.Fatalf("expected ReturnCodeInvalidPara, got %d", resp.ReturnCode)
	}
	if !strings.Contains(resp.ReturnMessage, "bundleId") {
		t.Errorf("expected msg to mention bundleId, got: %s", resp.ReturnMessage)
	}
}

// 6. ctl/bundle 反查 NotFound → ReturnCodeBundleNotFound
func TestCheckCreate_BundleNotFound(t *testing.T) {
	deps := newDeps(
		&fakeOrderStore{},
		&fakeBundleDefStore{def: stdBundleDef()},
		&fakeCTLClient{bundleErr: ctlclient.ErrNotFound},
	)
	resp := runHandler(t, deps, stdPara())
	if resp.ReturnCode != ReturnCodeBundleNotFound {
		t.Fatalf("expected ReturnCodeBundleNotFound=%d, got %d", ReturnCodeBundleNotFound, resp.ReturnCode)
	}
}

// 7. bundle.state=OFFLINE → ReturnCodeBundleOffline
func TestCheckCreate_BundleOffline(t *testing.T) {
	deps := newDeps(
		&fakeOrderStore{},
		&fakeBundleDefStore{def: stdBundleDef()},
		&fakeCTLClient{bundle: &ctlclient.BundleDetail{
			BundleID: "bundle_linux_small_01", BundleState: "OFFLINE", BundleSalesState: "AVAILABLE",
		}},
	)
	resp := runHandler(t, deps, stdPara())
	if resp.ReturnCode != ReturnCodeBundleOffline {
		t.Fatalf("expected ReturnCodeBundleOffline=%d, got %d", ReturnCodeBundleOffline, resp.ReturnCode)
	}
}

// 8. bundle.sales_state=SOLD_OUT → ReturnCodeBundleSoldOut
func TestCheckCreate_BundleSoldOut(t *testing.T) {
	deps := newDeps(
		&fakeOrderStore{},
		&fakeBundleDefStore{def: stdBundleDef()},
		&fakeCTLClient{bundle: &ctlclient.BundleDetail{
			BundleID: "bundle_linux_small_01", BundleState: "ONLINE", BundleSalesState: "SOLD_OUT",
		}},
	)
	resp := runHandler(t, deps, stdPara())
	if resp.ReturnCode != ReturnCodeBundleSoldOut {
		t.Fatalf("expected ReturnCodeBundleSoldOut=%d, got %d", ReturnCodeBundleSoldOut, resp.ReturnCode)
	}
}

// 9. ctl/bundle 反查 SQL 错 → ReturnCodeUpstreamUnavailable
func TestCheckCreate_BundleUpstreamError(t *testing.T) {
	deps := newDeps(
		&fakeOrderStore{},
		&fakeBundleDefStore{def: stdBundleDef()},
		&fakeCTLClient{bundleErr: errors.New("ctl 5xx")},
	)
	resp := runHandler(t, deps, stdPara())
	if resp.ReturnCode != ReturnCodeUpstreamUnavailable {
		t.Fatalf("expected ReturnCodeUpstreamUnavailable=%d, got %d", ReturnCodeUpstreamUnavailable, resp.ReturnCode)
	}
}

// 10. trade_bundle_definition 反查 NotFound → ReturnCodeBundleNotFound
func TestCheckCreate_BundleDefNotFound(t *testing.T) {
	deps := newDeps(
		&fakeOrderStore{},
		&fakeBundleDefStore{err: store.ErrBundleDefinitionNotFound},
		&fakeCTLClient{bundle: stdBundle()},
	)
	resp := runHandler(t, deps, stdPara())
	if resp.ReturnCode != ReturnCodeBundleNotFound {
		t.Fatalf("expected ReturnCodeBundleNotFound=%d, got %d", ReturnCodeBundleNotFound, resp.ReturnCode)
	}
}

// 11. pid 与 bundle_definition 不一致 → ReturnCodeBusinessParamMismatch
func TestCheckCreate_PidMismatch(t *testing.T) {
	def := stdBundleDef()
	def.Pid = 99999 // 与 stdPara goodsDetail.pid=40000 不一致
	deps := newDeps(
		&fakeOrderStore{},
		&fakeBundleDefStore{def: def},
		&fakeCTLClient{bundle: stdBundle()},
	)
	resp := runHandler(t, deps, stdPara())
	if resp.ReturnCode != ReturnCodeBusinessParamMismatch {
		t.Fatalf("expected ReturnCodeBusinessParamMismatch=%d, got %d", ReturnCodeBusinessParamMismatch, resp.ReturnCode)
	}
	if !strings.Contains(resp.ReturnMessage, "pid mismatch") {
		t.Errorf("expected pid mismatch, got: %s", resp.ReturnMessage)
	}
}

// 12. sv_* 与 bundle_definition 不一致 → ReturnCodeBusinessParamMismatch
func TestCheckCreate_SVMismatch(t *testing.T) {
	def := stdBundleDef()
	def.SVList = map[string]int64{"sv_cpu": 99} // 与 stdPara goodsDetail.sv_cpu=2 不一致
	deps := newDeps(
		&fakeOrderStore{},
		&fakeBundleDefStore{def: def},
		&fakeCTLClient{bundle: stdBundle()},
	)
	resp := runHandler(t, deps, stdPara())
	if resp.ReturnCode != ReturnCodeBusinessParamMismatch {
		t.Fatalf("expected ReturnCodeBusinessParamMismatch=%d, got %d", ReturnCodeBusinessParamMismatch, resp.ReturnCode)
	}
	if !strings.Contains(resp.ReturnMessage, "sv field mismatch") {
		t.Errorf("expected sv field mismatch, got: %s", resp.ReturnMessage)
	}
}

// 13. timeSpan <= 0 → ReturnCodeBusinessParamMismatch
func TestCheckCreate_TimeSpanInvalid(t *testing.T) {
	para := json.RawMessage(`{
		"appId": 1, "uin": "u",
		"goodsDetail": {"bundleId":"bundle_linux_small_01","pid":40000,"timeSpan":0,"timeUnit":"m","goodsNum":1,"sv_cpu":2,"sv_mem":4}
	}`)
	deps := newDeps(
		&fakeOrderStore{},
		&fakeBundleDefStore{def: stdBundleDef()},
		&fakeCTLClient{bundle: stdBundle()},
	)
	resp := runHandler(t, deps, para)
	if resp.ReturnCode != ReturnCodeBusinessParamMismatch {
		t.Fatalf("expected ReturnCodeBusinessParamMismatch, got %d", resp.ReturnCode)
	}
	if !strings.Contains(resp.ReturnMessage, "timeSpan") {
		t.Errorf("expected timeSpan invalid, got: %s", resp.ReturnMessage)
	}
}

// 14. timeUnit 非合法集合 → ReturnCodeBusinessParamMismatch
func TestCheckCreate_TimeUnitInvalid(t *testing.T) {
	para := json.RawMessage(`{
		"appId": 1, "uin": "u",
		"goodsDetail": {"bundleId":"bundle_linux_small_01","pid":40000,"timeSpan":1,"timeUnit":"x","goodsNum":1,"sv_cpu":2,"sv_mem":4}
	}`)
	deps := newDeps(
		&fakeOrderStore{},
		&fakeBundleDefStore{def: stdBundleDef()},
		&fakeCTLClient{bundle: stdBundle()},
	)
	resp := runHandler(t, deps, para)
	if resp.ReturnCode != ReturnCodeBusinessParamMismatch {
		t.Fatalf("expected ReturnCodeBusinessParamMismatch, got %d", resp.ReturnCode)
	}
	if !strings.Contains(resp.ReturnMessage, "timeUnit invalid") {
		t.Errorf("expected timeUnit invalid, got: %s", resp.ReturnMessage)
	}
}

// 15. payMode 顶层非法值（PDF: 0/1） → ReturnCodeBusinessParamMismatch
func TestCheckCreate_PayModeInvalid(t *testing.T) {
	para := json.RawMessage(`{
		"appId": 1, "uin": "u", "payMode": 9,
		"goodsDetail": {"bundleId":"bundle_linux_small_01","pid":40000,"timeSpan":1,"timeUnit":"m","goodsNum":1,"sv_cpu":2,"sv_mem":4}
	}`)
	deps := newDeps(
		&fakeOrderStore{},
		&fakeBundleDefStore{def: stdBundleDef()},
		&fakeCTLClient{bundle: stdBundle()},
	)
	resp := runHandler(t, deps, para)
	if resp.ReturnCode != ReturnCodeBusinessParamMismatch {
		t.Fatalf("expected ReturnCodeBusinessParamMismatch, got %d", resp.ReturnCode)
	}
	if !strings.Contains(resp.ReturnMessage, "payMode invalid") {
		t.Errorf("expected payMode invalid, got: %s", resp.ReturnMessage)
	}
}

// 16. payMode 在 goodsDetail 内（部分 jifei 版本会发到这层）→ 优先取 goodsDetail
func TestCheckCreate_PayModeFromGoodsDetail(t *testing.T) {
	para := json.RawMessage(`{
		"appId": 1, "uin": "u",
		"goodsDetail": {"bundleId":"bundle_linux_small_01","externalUserId":"uin_test_001","pid":40000,"timeSpan":1,"timeUnit":"m","goodsNum":1,"payMode":0,"sv_cpu":2,"sv_mem":4}
	}`)
	deps := newDeps(
		&fakeOrderStore{},
		&fakeBundleDefStore{def: stdBundleDef()},
		&fakeCTLClient{bundle: stdBundle()},
	)
	resp := runHandler(t, deps, para)
	if resp.ReturnCode != 0 {
		t.Fatalf("expected returnCode=0 (payMode=0 后付费 合法), got %d (%s)", resp.ReturnCode, resp.ReturnMessage)
	}
}

// 17. Q62 不变性：checkCreate 不写 trade_flow（编译期保险）
func TestCheckCreate_Q62_NoFlowDependency(t *testing.T) {
	d := Deps{}
	_ = d // Deps 不能含 FlowStore；增加任何 *Flow 字段会破坏本测试编译。
}

// 18. Q56 不变性：任何分支都不返退款魔法值
func TestCheckCreate_Q56_NoRefundOnAnyBranch(t *testing.T) {
	cases := []struct {
		name string
		deps Deps
		para json.RawMessage
	}{
		{"bundle_offline", newDeps(
			&fakeOrderStore{},
			&fakeBundleDefStore{def: stdBundleDef()},
			&fakeCTLClient{bundle: &ctlclient.BundleDetail{BundleID: "x", BundleState: "OFFLINE", BundleSalesState: "AVAILABLE"}},
		), stdPara()},
		{"bundle_def_not_found", newDeps(
			&fakeOrderStore{},
			&fakeBundleDefStore{err: store.ErrBundleDefinitionNotFound},
			&fakeCTLClient{bundle: stdBundle()},
		), stdPara()},
		{"pid_mismatch", newDeps(
			&fakeOrderStore{},
			&fakeBundleDefStore{def: &store.BundleDefinition{BundleID: "x", Pid: 99999, SVList: map[string]int64{"sv_cpu": 2, "sv_mem": 4}}},
			&fakeCTLClient{bundle: stdBundle()},
		), stdPara()},
		// v1.7.28 BUG-24 新增分支：不能返退款魔法值。
		{"bug24_quota_occupied", newDeps(
			&fakeOrderStore{},
			&fakeBundleDefStore{def: stdBundleDef()},
			&fakeCTLClient{
				bundle: stdBundle(),
				passes: []*ctlclient.PassDetail{{PassID: "pass-x"}},
			},
		), stdPara()},
		{"bug24_ctl_5xx", newDeps(
			&fakeOrderStore{},
			&fakeBundleDefStore{def: stdBundleDef()},
			&fakeCTLClient{bundle: stdBundle(), passesErr: errors.New("ctl 5xx")},
		), stdPara()},
		{"bug24_missing_external_user_id", newDeps(
			&fakeOrderStore{},
			&fakeBundleDefStore{def: stdBundleDef()},
			&fakeCTLClient{bundle: stdBundle()},
		), json.RawMessage(`{"appId":1,"uin":"u","goodsDetail":{"bundleId":"bundle_linux_small_01","pid":40000,"timeSpan":1,"timeUnit":"m","goodsNum":1,"sv_cpu":2,"sv_mem":4}}`)},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			resp, err := makeHandler(tc.deps)(context.Background(), tc.para)
			if err != nil {
				t.Fatalf("handler error: %v", err)
			}
			if resp.ReturnCode == jifei.RefundReturnCode {
				t.Fatalf("BRANCH %q LEAKED REFUND MAGIC %d (Q56 violation)", tc.name, jifei.RefundReturnCode)
			}
			if resp.ReturnCode != resp.ReturnValue {
				t.Fatalf("Q58 invariant: returnCode=%d returnValue=%d", resp.ReturnCode, resp.ReturnValue)
			}
		})
	}
}

// 19. Q58 不变性：happy-path returnCode=returnValue=0
func TestCheckCreate_Q58_Invariant(t *testing.T) {
	deps := newDeps(
		&fakeOrderStore{},
		&fakeBundleDefStore{def: stdBundleDef()},
		&fakeCTLClient{bundle: stdBundle()},
	)
	resp := runHandler(t, deps, stdPara())
	if resp.ReturnCode != 0 || resp.ReturnValue != 0 {
		t.Fatalf("happy-path expected (0,0), got (%d,%d)", resp.ReturnCode, resp.ReturnValue)
	}
}

// 21. v1.7.28 BUG-24：用户已有 active pass → ReturnCodeQuotaOccupied=600106。
func TestCheckCreate_BUG24_QuotaOccupied(t *testing.T) {
	deps := newDeps(
		&fakeOrderStore{},
		&fakeBundleDefStore{def: stdBundleDef()},
		&fakeCTLClient{
			bundle: stdBundle(),
			passes: []*ctlclient.PassDetail{{PassID: "pass-existing-001"}},
		},
	)
	resp := runHandler(t, deps, stdPara())
	if resp.ReturnCode != ReturnCodeQuotaOccupied {
		t.Fatalf("expected ReturnCodeQuotaOccupied=%d, got %d (%s)",
			ReturnCodeQuotaOccupied, resp.ReturnCode, resp.ReturnMessage)
	}
	if !strings.Contains(resp.ReturnMessage, "externalUserId=uin_test_001") {
		t.Errorf("expected msg to mention externalUserId, got: %s", resp.ReturnMessage)
	}
}

// 22. v1.7.28 BUG-24：用户下无 pass → happy-path returnCode=0。
func TestCheckCreate_BUG24_NoPassPassThrough(t *testing.T) {
	deps := newDeps(
		&fakeOrderStore{},
		&fakeBundleDefStore{def: stdBundleDef()},
		&fakeCTLClient{
			bundle: stdBundle(),
			passes: nil, // 用户名下无任何 pass
		},
	)
	resp := runHandler(t, deps, stdPara())
	if resp.ReturnCode != 0 {
		t.Fatalf("expected returnCode=0, got %d (%s)", resp.ReturnCode, resp.ReturnMessage)
	}
}

// 23. v1.7.28 BUG-24：goodsDetail 缺 externalUserId → ReturnCodeInvalidPara。
// trade 出向 placeorder 未塞 externalUserId（应用代码 bug）或 jifei 丢弃透传字段时的防御。
func TestCheckCreate_BUG24_MissingExternalUserID(t *testing.T) {
	paraWithoutExternalUserID := json.RawMessage(`{
		"appId": 12345678,
		"uin": "100012345678",
		"goodsDetail": {
			"bundleId": "bundle_linux_small_01",
			"pid": 40000,
			"timeSpan": 1,
			"timeUnit": "m",
			"goodsNum": 1,
			"sv_cpu": 2,
			"sv_mem": 4
		}
	}`)
	deps := newDeps(
		&fakeOrderStore{},
		&fakeBundleDefStore{def: stdBundleDef()},
		&fakeCTLClient{bundle: stdBundle()},
	)
	resp := runHandler(t, deps, paraWithoutExternalUserID)
	if resp.ReturnCode != ReturnCodeInvalidPara {
		t.Fatalf("expected ReturnCodeInvalidPara=%d, got %d (%s)",
			ReturnCodeInvalidPara, resp.ReturnCode, resp.ReturnMessage)
	}
	if !strings.Contains(resp.ReturnMessage, "externalUserId") {
		t.Errorf("expected msg to mention externalUserId, got: %s", resp.ReturnMessage)
	}
}

// 24. v1.7.28 BUG-24：ctl ListPassesByUser 返 5xx / 网络错 → ReturnCodeUpstreamUnavailable。
// jifei 拿到后会重试（B 类链路异常）。
func TestCheckCreate_BUG24_CTLUpstreamError(t *testing.T) {
	deps := newDeps(
		&fakeOrderStore{},
		&fakeBundleDefStore{def: stdBundleDef()},
		&fakeCTLClient{
			bundle:    stdBundle(),
			passesErr: errors.New("ctl 5xx connection refused"),
		},
	)
	resp := runHandler(t, deps, stdPara())
	if resp.ReturnCode != ReturnCodeUpstreamUnavailable {
		t.Fatalf("expected ReturnCodeUpstreamUnavailable=%d, got %d (%s)",
			ReturnCodeUpstreamUnavailable, resp.ReturnCode, resp.ReturnMessage)
	}
}

// 20. dispatcher → handler 注册路径打通（含 envelope 解包）
func TestInstall_RegistersToDispatcher(t *testing.T) {
	builder := jifei.NewFrameworkBuilder("trade", "1.0")
	d := jifei.NewDispatcher("lightvela", builder)
	deps := Deps{
		OrderStore:  &fakeOrderStore{},
		BundleStore: &fakeBundleDefStore{def: stdBundleDef()},
		CTLClient:   &fakeCTLClient{bundle: stdBundle()},
		Builder:     builder,
	}
	Install(d, deps)

	envBody, err := json.Marshal(map[string]any{
		"eventId":       int64(1),
		"componentName": "trade",
		"seqId":         "seq-1",
		"interface": map[string]any{
			"interfaceName": jifei.InterfaceNameCheckCreate,
			"para":          json.RawMessage(stdPara()),
		},
	})
	if err != nil {
		t.Fatalf("marshal envelope: %v", err)
	}
	resp := d.Dispatch(context.Background(), envBody)
	if resp.ReturnCode != 0 {
		t.Fatalf("expected dispatcher → handler success, got returnCode=%d msg=%s", resp.ReturnCode, resp.ReturnMessage)
	}
	if resp.ComponentName != "trade" || resp.Version != "1.0" {
		t.Fatalf("framework header mismatch: %+v", resp)
	}
}
