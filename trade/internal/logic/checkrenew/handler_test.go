package checkrenew

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"git.woa.com/wisp/mono/trade/internal/ctlclient"
	"git.woa.com/wisp/mono/trade/internal/httpapi/jifei"
	jifeiproto "git.woa.com/wisp/mono/trade/internal/jifei"
)

// ---- mock 实现 ---------------------------------------------------------------

// fakeCTLClient 仅实现 checkRenew 实际用到的 ListPassesByResourceIDs；其余方法返 unused 错误，
// 与 checkcreate / isolateresource 包内现有 fakeCTLClient 同型范式（避免引入 sql/mock 第三方依赖）。
type fakeCTLClient struct {
	passes    []*ctlclient.PassDetail
	passesErr error
}

func (f *fakeCTLClient) GetBundleByID(_ context.Context, _ string) (*ctlclient.BundleDetail, error) {
	return nil, errors.New("GetBundleByID not used in checkrenew tests")
}
func (f *fakeCTLClient) ListPassesByUser(_ context.Context, _ string) ([]*ctlclient.PassDetail, error) {
	return nil, errors.New("ListPassesByUser not used in checkrenew tests")
}
func (f *fakeCTLClient) CompletePass(_ context.Context, _ *ctlclient.CompletePassRequest) (*ctlclient.PassDetail, error) {
	return nil, errors.New("CompletePass not used in checkrenew tests")
}
func (f *fakeCTLClient) TransferPass(_ context.Context, _ *ctlclient.TransferPassRequest) (*ctlclient.PassDetail, error) {
	return nil, errors.New("TransferPass not used in checkrenew tests")
}
func (f *fakeCTLClient) ListPassAppIDs(_ context.Context, _ []string, _, _ int) ([]int64, int64, error) {
	return nil, 0, errors.New("ListPassAppIDs not used in checkrenew tests")
}
func (f *fakeCTLClient) ListPassesByAppID(_ context.Context, _ int64, _ []string, _, _ int) ([]*ctlclient.PassDetail, int64, error) {
	return nil, 0, errors.New("ListPassesByAppID not used in checkrenew tests")
}
func (f *fakeCTLClient) ListPassesByResourceIDs(_ context.Context, _ int64, _ []string) ([]*ctlclient.PassDetail, error) {
	return f.passes, f.passesErr
}
func (f *fakeCTLClient) IsolatePass(_ context.Context, _ string, _ *ctlclient.IsolatePassRequest) (*ctlclient.IsolatePassResponse, error) {
	return nil, errors.New("IsolatePass not used in checkrenew tests")
}
func (f *fakeCTLClient) RenewPass(_ context.Context, _ string, _ *ctlclient.RenewPassRequest) (*ctlclient.RenewPassResponse, error) {
	return nil, errors.New("RenewPass not used in checkrenew tests")
}

func (f *fakeCTLClient) DestroyPass(_ context.Context, _ string, _ *ctlclient.DestroyPassRequest) (*ctlclient.DestroyPassResponse, error) {
	return nil, errors.New("DestroyPass not used in checkrenew tests")
}

// ---- 标准 happy-path fixtures ------------------------------------------------

const (
	testPassID = "pass-001"
	testUin    = "100012345678"
	testAppID  = int64(12345678)
)

// stdExpired 是 happy-path pass.expired_time（当地时区，与 jifei goodsDetail.curDeadline 对齐）。
//
// 用 time.Date 构造避免依赖 wall clock；所有测试 jifei envelope 的 curDeadline 字符串与此严格一致。
func stdExpired() time.Time {
	return time.Date(2026, 6, 1, 12, 0, 0, 0, time.Local)
}

func stdExpiredStr() string {
	return stdExpired().Format(jifeiproto.CurDeadlineLayout)
}

// stdPass 是默认 active 状态的 pass（IsolatedTime/DeletedTime 都是 nil → 推导 active）。
func stdPass() *ctlclient.PassDetail {
	return &ctlclient.PassDetail{
		PassID:      testPassID,
		Uin:         100012345678,
		AppID:       testAppID,
		ExpiredTime: stdExpired(),
		// IsolatedTime / DeletedTime nil → 推导 status = active
	}
}

// stdParaJSON 构造一个 happy-path callbackPara JSON。
//
// curDeadline 默认与 stdExpired() 完全一致；任一调用方按需覆盖字段（用 map[string]any 拼装 JSON）。
func stdParaMap() map[string]any {
	return map[string]any{
		"uin":            testUin,
		"operateUin":     testUin,
		"appId":          testAppID,
		"payMode":        1,
		"resourceId":     testPassID,
		"region":         1,
		"zoneId":         100001,
		"productCode":    "lighthouse",
		"subProductCode": "pass",
		"goodsDetail": map[string]any{
			"timeSpan":      1,
			"timeUnit":      "m",
			"goodsNum":      1,
			"curDeadline":   stdExpiredStr(),
			"autoRenewFlag": 0,
			"pid":           int64(2147483647),
			"sv_lighthouse": 1,
		},
	}
}

func stdBuilder() *jifei.FrameworkBuilder {
	return &jifei.FrameworkBuilder{
		ComponentName: "trade",
		Version:       "v1",
	}
}

// invokeHandler 序列化 paraMap 并调 makeHandler — 复用 dispatcher 的 raw JSON 入参约定。
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

func TestCheckRenew_HappyPath_ReturnsSuccess(t *testing.T) {
	deps := Deps{
		CTLClient: &fakeCTLClient{passes: []*ctlclient.PassDetail{stdPass()}},
		Builder:   stdBuilder(),
	}
	resp := invokeHandler(t, deps, stdParaMap())

	if resp.ReturnCode != 0 {
		t.Fatalf("happy path: returnCode must be 0, got %d (msg=%q)", resp.ReturnCode, resp.ReturnMessage)
	}
	if resp.ReturnValue != 0 {
		t.Errorf("Q58: returnCode == returnValue must hold; got %d != %d", resp.ReturnCode, resp.ReturnValue)
	}
}

// ---- InvalidPara (600401) — 涵盖 Q12=a + Q14=a InvalidPara 落点 -----------------

func TestCheckRenew_InvalidPara_BadJSON(t *testing.T) {
	deps := Deps{CTLClient: &fakeCTLClient{}, Builder: stdBuilder()}
	resp, err := makeHandler(deps)(context.Background(), json.RawMessage(`{not json`))
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if resp.ReturnCode != ReturnCodeInvalidPara {
		t.Fatalf("expected %d (InvalidPara), got %d (msg=%q)",
			ReturnCodeInvalidPara, resp.ReturnCode, resp.ReturnMessage)
	}
}

func TestCheckRenew_InvalidPara_MissingUin(t *testing.T) {
	deps := Deps{CTLClient: &fakeCTLClient{}, Builder: stdBuilder()}
	para := stdParaMap()
	para["uin"] = ""
	resp := invokeHandler(t, deps, para)
	if resp.ReturnCode != ReturnCodeInvalidPara {
		t.Fatalf("expected InvalidPara, got %d (msg=%q)", resp.ReturnCode, resp.ReturnMessage)
	}
	if !strings.Contains(resp.ReturnMessage, "uin") {
		t.Errorf("error message should mention 'uin'; got %q", resp.ReturnMessage)
	}
}

func TestCheckRenew_InvalidPara_PayModeNot1(t *testing.T) {
	deps := Deps{CTLClient: &fakeCTLClient{}, Builder: stdBuilder()}
	para := stdParaMap()
	para["payMode"] = 2 // 后付费
	resp := invokeHandler(t, deps, para)
	if resp.ReturnCode != ReturnCodeInvalidPara {
		t.Fatalf("expected InvalidPara, got %d (msg=%q)", resp.ReturnCode, resp.ReturnMessage)
	}
	if !strings.Contains(resp.ReturnMessage, "payMode") {
		t.Errorf("error message should mention 'payMode'; got %q", resp.ReturnMessage)
	}
}

func TestCheckRenew_InvalidPara_TimeUnitNotInWhitelist(t *testing.T) {
	// Q12=a：timeUnit ∉ {y,m,d} 严格白名单（'p' 等历史值不接受）。
	deps := Deps{CTLClient: &fakeCTLClient{}, Builder: stdBuilder()}
	para := stdParaMap()
	gd, _ := para["goodsDetail"].(map[string]any)
	gd["timeUnit"] = "p" // 历史"购买"语义，不再接受
	resp := invokeHandler(t, deps, para)
	if resp.ReturnCode != ReturnCodeInvalidPara {
		t.Fatalf("expected InvalidPara for timeUnit='p', got %d (msg=%q)",
			resp.ReturnCode, resp.ReturnMessage)
	}
	if !strings.Contains(resp.ReturnMessage, "Q12=a") {
		t.Errorf("error message should cite 'Q12=a' design ref; got %q", resp.ReturnMessage)
	}
}

func TestCheckRenew_InvalidPara_TimeUnitYearAccepted(t *testing.T) {
	// Q19=b：全链路放开 'y'，checkRenew 必须接受 timeUnit='y'。
	deps := Deps{
		CTLClient: &fakeCTLClient{passes: []*ctlclient.PassDetail{stdPass()}},
		Builder:   stdBuilder(),
	}
	para := stdParaMap()
	gd, _ := para["goodsDetail"].(map[string]any)
	gd["timeUnit"] = "y"
	resp := invokeHandler(t, deps, para)
	if resp.ReturnCode != 0 {
		t.Fatalf("Q19=b: timeUnit='y' must be accepted; got %d (msg=%q)",
			resp.ReturnCode, resp.ReturnMessage)
	}
}

func TestCheckRenew_InvalidPara_TimeSpanZero(t *testing.T) {
	deps := Deps{CTLClient: &fakeCTLClient{}, Builder: stdBuilder()}
	para := stdParaMap()
	gd, _ := para["goodsDetail"].(map[string]any)
	gd["timeSpan"] = 0
	resp := invokeHandler(t, deps, para)
	if resp.ReturnCode != ReturnCodeInvalidPara {
		t.Fatalf("expected InvalidPara, got %d", resp.ReturnCode)
	}
}

func TestCheckRenew_InvalidPara_GoodsNumNot1(t *testing.T) {
	deps := Deps{CTLClient: &fakeCTLClient{}, Builder: stdBuilder()}
	para := stdParaMap()
	gd, _ := para["goodsDetail"].(map[string]any)
	gd["goodsNum"] = 2
	resp := invokeHandler(t, deps, para)
	if resp.ReturnCode != ReturnCodeInvalidPara {
		t.Fatalf("expected InvalidPara (goodsNum>1), got %d (msg=%q)",
			resp.ReturnCode, resp.ReturnMessage)
	}
}

// ---- PassNotFound (600402) ---------------------------------------------------

func TestCheckRenew_PassNotFound_EmptyList(t *testing.T) {
	// PDF §1.2：不存在的 pass 在 ListPassesByResourceIDs 返回空列表（不报错）。
	deps := Deps{
		CTLClient: &fakeCTLClient{passes: []*ctlclient.PassDetail{}},
		Builder:   stdBuilder(),
	}
	resp := invokeHandler(t, deps, stdParaMap())
	if resp.ReturnCode != ReturnCodePassNotFound {
		t.Fatalf("expected PassNotFound, got %d (msg=%q)",
			resp.ReturnCode, resp.ReturnMessage)
	}
}

func TestCheckRenew_PassNotFound_CTLErrNotFound(t *testing.T) {
	// 兼容路径：ctl 路由配置异常返 404 → ErrNotFound 也归 PassNotFound。
	deps := Deps{
		CTLClient: &fakeCTLClient{passesErr: ctlclient.ErrNotFound},
		Builder:   stdBuilder(),
	}
	resp := invokeHandler(t, deps, stdParaMap())
	if resp.ReturnCode != ReturnCodePassNotFound {
		t.Fatalf("expected PassNotFound on ErrNotFound, got %d", resp.ReturnCode)
	}
}

// ---- PassNotRenewable (600403) ----------------------------------------------

func TestCheckRenew_PassNotRenewable_UinMismatch(t *testing.T) {
	// Q14=a 收敛：PassUinMismatch 归并到 PassNotRenewable。
	pass := stdPass()
	pass.Uin = 999999999 // 不归属 testUin

	deps := Deps{
		CTLClient: &fakeCTLClient{passes: []*ctlclient.PassDetail{pass}},
		Builder:   stdBuilder(),
	}
	resp := invokeHandler(t, deps, stdParaMap())
	if resp.ReturnCode != ReturnCodePassNotRenewable {
		t.Fatalf("expected PassNotRenewable for uin mismatch, got %d (msg=%q)",
			resp.ReturnCode, resp.ReturnMessage)
	}
	if !strings.Contains(resp.ReturnMessage, "uin mismatch") {
		t.Errorf("expected 'uin mismatch' in error, got %q", resp.ReturnMessage)
	}
}

func TestCheckRenew_PassNotRenewable_AppIDMismatch(t *testing.T) {
	pass := stdPass()
	pass.AppID = 999

	deps := Deps{
		CTLClient: &fakeCTLClient{passes: []*ctlclient.PassDetail{pass}},
		Builder:   stdBuilder(),
	}
	resp := invokeHandler(t, deps, stdParaMap())
	if resp.ReturnCode != ReturnCodePassNotRenewable {
		t.Fatalf("expected PassNotRenewable for appId mismatch, got %d", resp.ReturnCode)
	}
}

func TestCheckRenew_PassNotRenewable_PassDeleted(t *testing.T) {
	pass := stdPass()
	deletedAt := time.Now()
	pass.DeletedTime = &deletedAt

	deps := Deps{
		CTLClient: &fakeCTLClient{passes: []*ctlclient.PassDetail{pass}},
		Builder:   stdBuilder(),
	}
	resp := invokeHandler(t, deps, stdParaMap())
	if resp.ReturnCode != ReturnCodePassNotRenewable {
		t.Fatalf("expected PassNotRenewable for deleted pass, got %d (msg=%q)",
			resp.ReturnCode, resp.ReturnMessage)
	}
	if !strings.Contains(resp.ReturnMessage, "deleted") {
		t.Errorf("expected 'deleted' in error, got %q", resp.ReturnMessage)
	}
}

func TestCheckRenew_PassRenewable_IsolatedAccepted(t *testing.T) {
	// 到期续费：pass.status=isolated 是合法续费场景（§3.3 分支 B）。
	pass := stdPass()
	isolatedAt := time.Now().Add(-1 * time.Hour)
	pass.IsolatedTime = &isolatedAt

	deps := Deps{
		CTLClient: &fakeCTLClient{passes: []*ctlclient.PassDetail{pass}},
		Builder:   stdBuilder(),
	}
	resp := invokeHandler(t, deps, stdParaMap())
	if resp.ReturnCode != 0 {
		t.Fatalf("isolated pass must be renewable; got %d (msg=%q)",
			resp.ReturnCode, resp.ReturnMessage)
	}
}

// ---- CurDeadlineMismatch (600404) -------------------------------------------

func TestCheckRenew_CurDeadlineMismatch(t *testing.T) {
	// 业务校验：jifei goodsDetail.curDeadline ≠ ctl.pass.expired_time → 600404。
	deps := Deps{
		CTLClient: &fakeCTLClient{passes: []*ctlclient.PassDetail{stdPass()}},
		Builder:   stdBuilder(),
	}
	para := stdParaMap()
	gd, _ := para["goodsDetail"].(map[string]any)
	gd["curDeadline"] = "2027-01-01 00:00:00" // 与 stdExpired() 不一致
	resp := invokeHandler(t, deps, para)
	if resp.ReturnCode != ReturnCodeCurDeadlineMismatch {
		t.Fatalf("expected CurDeadlineMismatch, got %d (msg=%q)",
			resp.ReturnCode, resp.ReturnMessage)
	}
	if !strings.Contains(resp.ReturnMessage, "curDeadline mismatch") {
		t.Errorf("expected 'curDeadline mismatch' in error, got %q", resp.ReturnMessage)
	}
}

func TestCheckRenew_CurDeadline_BadFormat(t *testing.T) {
	// 格式错（非 YYYY-MM-DD HH:MM:SS）也归 600404 — 字面"curDeadline 不一致"语义覆盖。
	deps := Deps{
		CTLClient: &fakeCTLClient{passes: []*ctlclient.PassDetail{stdPass()}},
		Builder:   stdBuilder(),
	}
	para := stdParaMap()
	gd, _ := para["goodsDetail"].(map[string]any)
	gd["curDeadline"] = "2026/06/01 12:00:00"
	resp := invokeHandler(t, deps, para)
	if resp.ReturnCode != ReturnCodeCurDeadlineMismatch {
		t.Fatalf("expected CurDeadlineMismatch for bad format, got %d", resp.ReturnCode)
	}
}

func TestCheckRenew_CurDeadline_Missing(t *testing.T) {
	deps := Deps{
		CTLClient: &fakeCTLClient{passes: []*ctlclient.PassDetail{stdPass()}},
		Builder:   stdBuilder(),
	}
	para := stdParaMap()
	gd, _ := para["goodsDetail"].(map[string]any)
	delete(gd, "curDeadline")
	resp := invokeHandler(t, deps, para)
	if resp.ReturnCode != ReturnCodeCurDeadlineMismatch {
		t.Fatalf("expected CurDeadlineMismatch for missing curDeadline, got %d", resp.ReturnCode)
	}
}

// ---- InternalError (600406) -------------------------------------------------

func TestCheckRenew_InternalError_CTLNetworkErr(t *testing.T) {
	// ctl 调用 5xx / 网络错 → 600406 InternalError。
	deps := Deps{
		CTLClient: &fakeCTLClient{passesErr: errors.New("connection refused")},
		Builder:   stdBuilder(),
	}
	resp := invokeHandler(t, deps, stdParaMap())
	if resp.ReturnCode != ReturnCodeInternalError {
		t.Fatalf("expected InternalError, got %d (msg=%q)",
			resp.ReturnCode, resp.ReturnMessage)
	}
}

// ---- Install -----------------------------------------------------------------

func TestInstall_RegistersCheckRenewHandler(t *testing.T) {
	// 复用 jifei 包的 NewDispatcher（与 isolateresource_test.go / checkcreate_test.go 同范式）。
	// 不直接断言路由结果（dispatcher 内部测试已覆盖 Register）；这里仅断言 Install 不 panic。
	d := jifei.NewDispatcher("lightvela", stdBuilder())
	deps := Deps{
		CTLClient: &fakeCTLClient{},
		Builder:   stdBuilder(),
	}

	// Install 应该 Register InterfaceNameCheckRenew，不 panic。
	Install(d, deps)

	// 重复 Install 必 panic（Q60 dispatcher 同名重复注册即 panic）。
	defer func() {
		if r := recover(); r == nil {
			t.Errorf("expected panic on duplicate Install (dispatcher.Register 同名重复)")
		}
	}()
	Install(d, deps)
}

// ---- BUG-33 时区契约回归 ------------------------------------------------------

// TestVerifyCurDeadline_BUG33_UTCExpiredTimeCSTCurDeadlineEqual BUG-33 回归保护：
//
// 真实生产形态复现：
//   - ctl pass.ExpiredTime 是 UTC time.Time（ctl 全栈 UTC 存储）
//   - jifei 拿到的 curDeadline 字符串是北京时间字面值（trade resourcequery/mapper.go
//     用 time.FixedZone("CST", 8*3600) 显式格式化输出给 jifei，jifei 后续在
//     checkRenew 回调里原样回传）
//
// trade pod 在生产/联调环境跑 UTC 时区，旧实现用 time.ParseInLocation(..., time.Local)
// 解析 jifei 传回的 CST 字面值会得到 UTC instant，与 ctl UTC time.Time 相差 8h，
// 错误归因到 600404 CurDeadlineMismatch（北京时间联调 seqId 431e5e69 现场印证）。
//
// 修复后必须保证：UTC time.Time + CST 字面值能正确等价匹配，verifyCurDeadline 返空串。
func TestVerifyCurDeadline_BUG33_UTCExpiredTimeCSTCurDeadlineEqual(t *testing.T) {
	// ctl 给的 pass.ExpiredTime：UTC 形态（与 ctl 全栈 UTC 规范一致）。
	expiredUTC := time.Date(2026, 6, 22, 7, 22, 50, 0, time.UTC)

	// trade resourcequery/mapper.go 用 CST FixedZone 格式化后给 jifei 的字面值：
	// 同一时刻在北京时间下是 15:22:50（+8h）。
	cstStr := "2026-06-22 15:22:50"

	gd := map[string]interface{}{
		"curDeadline": cstStr,
	}

	if msg := verifyCurDeadline(gd, expiredUTC); msg != "" {
		t.Fatalf("expected verifyCurDeadline to accept CST literal vs UTC time.Time, got mismatch: %s", msg)
	}
}

// TestVerifyCurDeadline_BUG33_RejectsActualMismatch 边界保护：
//
// 修复 BUG-33 不能误开闸 — 真实业务上不一致的时间必须照旧返 600404，
// 防止把"始终视为相等"当成修复。本用例用差 1 小时的 curDeadline 验证 mismatch 仍能被拦截。
func TestVerifyCurDeadline_BUG33_RejectsActualMismatch(t *testing.T) {
	expiredUTC := time.Date(2026, 6, 22, 7, 22, 50, 0, time.UTC)
	// 北京时间 16:22:50 = UTC 08:22:50，与 expiredUTC 实际相差 1h。
	gd := map[string]interface{}{
		"curDeadline": "2026-06-22 16:22:50",
	}

	msg := verifyCurDeadline(gd, expiredUTC)
	if msg == "" {
		t.Fatal("expected verifyCurDeadline to reject genuinely mismatched curDeadline, got empty msg")
	}
	if !strings.Contains(msg, "curDeadline mismatch") {
		t.Fatalf("expected 'curDeadline mismatch' in error msg, got %q", msg)
	}
}

// TestVerifyCurDeadline_BUG33_ErrorMessageShowsBeijingTime 错误消息可读性保护：
//
// 之前错误信息里 ctl.pass.expired_time 用 t.Format() 输出，会展示成 trade pod 本地时区
// 字面值（在 UTC pod 里就是 UTC 字符串），与 jifei 传回的 CST 字面值不在同一时区，
// 排障时极易误读为"trade 拿到了 UTC 字符串"。修复后强制按北京时间展示，便于直观对比。
func TestVerifyCurDeadline_BUG33_ErrorMessageShowsBeijingTime(t *testing.T) {
	expiredUTC := time.Date(2026, 6, 22, 7, 22, 50, 0, time.UTC) // = 北京时间 15:22:50
	gd := map[string]interface{}{
		"curDeadline": "2027-01-01 00:00:00", // 故意大错位
	}

	msg := verifyCurDeadline(gd, expiredUTC)
	if msg == "" {
		t.Fatal("expected mismatch error msg, got empty")
	}
	// 错误消息中的 ctl.pass.expired_time 必须是北京时间字面值 "2026-06-22 15:22:50"，
	// 不能是 UTC 字面值 "2026-06-22 07:22:50"。
	if !strings.Contains(msg, "2026-06-22 15:22:50") {
		t.Fatalf("expected error msg to show ctl.pass.expired_time as Beijing time '2026-06-22 15:22:50', got %q", msg)
	}
	if strings.Contains(msg, "2026-06-22 07:22:50") {
		t.Fatalf("error msg must NOT show ctl.pass.expired_time as UTC literal '2026-06-22 07:22:50', got %q", msg)
	}
}
