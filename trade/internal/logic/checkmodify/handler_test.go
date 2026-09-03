package checkmodify

import (
	"context"
	"encoding/json"
	"errors"
	"sort"
	"strings"
	"testing"

	"git.woa.com/wisp/mono/trade/internal/ctlclient"
	"git.woa.com/wisp/mono/trade/internal/httpapi/jifei"
	jifeiproto "git.woa.com/wisp/mono/trade/internal/jifei"
	"git.woa.com/wisp/mono/trade/internal/store"
)

// 需求：TAPD 1010132091137784162 §5.2 / §7.1

const (
	testPassID     = "pass-001"
	testUin        = "100012345678"
	testAppID      = int64(12345678)
	sourceBundleID = "bundle_sail"
	targetBundleID = "bundle_cruise"
)

// ---- fakes -------------------------------------------------------------------

type fakeCTLClient struct {
	resp    *ctlclient.CheckPassModifyResponse
	err     error
	lastReq *ctlclient.CheckPassModifyRequest
	calls   int
}

func (f *fakeCTLClient) CheckPassModify(_ context.Context, _ string, req *ctlclient.CheckPassModifyRequest) (*ctlclient.CheckPassModifyResponse, error) {
	f.calls++
	f.lastReq = req
	if f.err != nil {
		return nil, f.err
	}
	if f.resp != nil {
		return f.resp, nil
	}
	return &ctlclient.CheckPassModifyResponse{PassID: testPassID, Allowed: true}, nil
}

func (f *fakeCTLClient) ModifyPass(_ context.Context, _ string, _ *ctlclient.ModifyPassRequest) (*ctlclient.ModifyPassResponse, error) {
	return nil, errors.New("ModifyPass not used in checkmodify tests")
}
func (f *fakeCTLClient) GetBundleByID(_ context.Context, _ string) (*ctlclient.BundleDetail, error) {
	return nil, errors.New("GetBundleByID not used in checkmodify tests")
}
func (f *fakeCTLClient) ListPassesByUser(_ context.Context, _ string) ([]*ctlclient.PassDetail, error) {
	return nil, errors.New("ListPassesByUser not used in checkmodify tests")
}
func (f *fakeCTLClient) CompletePass(_ context.Context, _ *ctlclient.CompletePassRequest) (*ctlclient.PassDetail, error) {
	return nil, errors.New("CompletePass not used in checkmodify tests")
}
func (f *fakeCTLClient) TransferPass(_ context.Context, _ *ctlclient.TransferPassRequest) (*ctlclient.PassDetail, error) {
	return nil, errors.New("TransferPass not used in checkmodify tests")
}
func (f *fakeCTLClient) ListPassAppIDs(_ context.Context, _ []string, _, _ int) ([]int64, int64, error) {
	return nil, 0, errors.New("ListPassAppIDs not used in checkmodify tests")
}
func (f *fakeCTLClient) ListPassesByAppID(_ context.Context, _ int64, _ []string, _, _ int) ([]*ctlclient.PassDetail, int64, error) {
	return nil, 0, errors.New("ListPassesByAppID not used in checkmodify tests")
}
func (f *fakeCTLClient) ListPassesByResourceIDs(_ context.Context, _ int64, _ []string) ([]*ctlclient.PassDetail, error) {
	return nil, errors.New("ListPassesByResourceIDs not used in checkmodify tests")
}
func (f *fakeCTLClient) IsolatePass(_ context.Context, _ string, _ *ctlclient.IsolatePassRequest) (*ctlclient.IsolatePassResponse, error) {
	return nil, errors.New("IsolatePass not used in checkmodify tests")
}
func (f *fakeCTLClient) RenewPass(_ context.Context, _ string, _ *ctlclient.RenewPassRequest) (*ctlclient.RenewPassResponse, error) {
	return nil, errors.New("RenewPass not used in checkmodify tests")
}
func (f *fakeCTLClient) DestroyPass(_ context.Context, _ string, _ *ctlclient.DestroyPassRequest) (*ctlclient.DestroyPassResponse, error) {
	return nil, errors.New("DestroyPass not used in checkmodify tests")
}

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

// ListBundleDefsBySubProductCode 是 checkModify 反查套餐的唯一入口（见 resolve.go）：
// 计费不回传 bundleId / newBundleId，源与目标全靠 oldConfig / newConfig 的 SV 集合
// 在同 (productCode, subProductCode) 域内反查。桩实现按这两个维度过滤，
// 与真实 DAO 的 WHERE 条件保持一致。
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

func stdDefs() map[string]*store.BundleDefinition {
	return map[string]*store.BundleDefinition{
		sourceBundleID: {
			BundleID:       sourceBundleID,
			ProductCode:    "p_lighthouse",
			SubProductCode: "sp_lightvela_cn",
			Pid:            4001,
			SVList:         map[string]int64{"sv_cpu": 2, "sv_mem": 4, "sv_disk": 60},
		},
		targetBundleID: {
			BundleID:       targetBundleID,
			ProductCode:    "p_lighthouse",
			SubProductCode: "sp_lightvela_cn",
			Pid:            4001,
			SVList:         map[string]int64{"sv_cpu": 4, "sv_mem": 8, "sv_disk": 80},
		},
	}
}

func stdParaMap() map[string]any {
	return map[string]any{
		"uin":            testUin,
		"operateUin":     testUin,
		"appId":          testAppID,
		"payMode":        1,
		"resourceId":     testPassID,
		"region":         1,
		"productCode":    "p_lighthouse",
		"subProductCode": "sp_lightvela_cn",
		"goodsDetail": map[string]any{
			"goodsNum":    1,
			"pid":         4001,
			"bundleId":    sourceBundleID,
			"newBundleId": targetBundleID,
			"curDeadline": "2026-06-15 10:30:00",
			"oldConfig":   map[string]any{"sv_cpu": 2, "sv_mem": 4, "sv_disk": 60},
			"newConfig":   map[string]any{"sv_cpu": 4, "sv_mem": 8, "sv_disk": 80},
		},
	}
}

func stdBuilder() *jifei.FrameworkBuilder {
	return &jifei.FrameworkBuilder{ComponentName: "trade", Version: "v1"}
}

func stdDeps() (Deps, *fakeCTLClient) {
	ctl := &fakeCTLClient{}
	return Deps{
		CTLClient:   ctl,
		BundleStore: &fakeBundleStore{defs: stdDefs()},
		Builder:     stdBuilder(),
	}, ctl
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

// goodsDetail 里改一个字段并返回整个 para map。
func paraWithGoodsDetail(mutate func(map[string]any)) map[string]any {
	para := stdParaMap()
	mutate(para["goodsDetail"].(map[string]any))
	return para
}

// ---- happy path --------------------------------------------------------------

func TestCheckModifyHappyPath(t *testing.T) {
	deps, ctl := stdDeps()
	resp := invokeHandler(t, deps, stdParaMap())

	if resp.ReturnCode != 0 {
		t.Fatalf("returnCode = %d, want 0 (msg=%q)", resp.ReturnCode, resp.ReturnMessage)
	}
	// data.status = 0 是"可变配"的协议信号，缺了计费判协议不合规。
	if resp.Data["status"] != 0 {
		t.Errorf("data = %+v, want status=0", resp.Data)
	}
	// 且**只有** status（§5.3）：pass、Plan、AgentQuota、实例列表都是 LightVela 内部
	// 领域状态，泄漏给计费等于把内部模型变成对外契约，之后再改就要走计费接入单。
	if len(resp.Data) != 1 {
		t.Errorf("data has %d keys (%+v), want exactly status", len(resp.Data), resp.Data)
	}
	if ctl.calls != 1 {
		t.Fatalf("ctl CheckPassModify calls = %d, want 1", ctl.calls)
	}
	req := ctl.lastReq
	if req.SourceBundleID != sourceBundleID || req.TargetBundleID != targetBundleID {
		t.Errorf("bundle pair = %q → %q", req.SourceBundleID, req.TargetBundleID)
	}
	if req.Uin != 100012345678 || req.AppID != testAppID {
		t.Errorf("uin/appId = %d/%d", req.Uin, req.AppID)
	}
	if req.CurDeadline == nil {
		t.Fatal("CurDeadline is nil, want parsed value")
	}
	// 计费传的是北京时间字面值；用 CST 解析后 UTC 应为 02:30（BUG-33 同因保护）。
	if got := req.CurDeadline.UTC().Format("2006-01-02 15:04:05"); got != "2026-06-15 02:30:00" {
		t.Errorf("CurDeadline in UTC = %q, want 2026-06-15 02:30:00", got)
	}
}

// ---- InvalidPara (600801) ----------------------------------------------------

func TestCheckModifyInvalidParaBadJSON(t *testing.T) {
	deps, _ := stdDeps()
	resp, err := makeHandler(deps)(context.Background(), json.RawMessage(`{not json`))
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if resp.ReturnCode != ReturnCodeInvalidPara {
		t.Fatalf("returnCode = %d, want %d", resp.ReturnCode, ReturnCodeInvalidPara)
	}
}

func TestCheckModifyInvalidPara(t *testing.T) {
	cases := []struct {
		name string
		para map[string]any
		want string
	}{
		{"missing uin", func() map[string]any { p := stdParaMap(); p["uin"] = ""; return p }(), "uin"},
		{"invalid uin", func() map[string]any { p := stdParaMap(); p["uin"] = "invalid"; return p }(), "uin"},
		{"zero uin", func() map[string]any { p := stdParaMap(); p["uin"] = "0"; return p }(), "uin"},
		{"overflow uin", func() map[string]any { p := stdParaMap(); p["uin"] = "9223372036854775808"; return p }(), "uin"},
		{"missing curDeadline", paraWithGoodsDetail(func(gd map[string]any) { delete(gd, "curDeadline") }), "curDeadline"},
		{"missing appId", func() map[string]any { p := stdParaMap(); p["appId"] = 0; return p }(), "appId"},
		{"missing resourceId", func() map[string]any { p := stdParaMap(); p["resourceId"] = ""; return p }(), "resourceId"},
		{"postpaid", func() map[string]any { p := stdParaMap(); p["payMode"] = 2; return p }(), "payMode"},
		{"goodsNum not 1", paraWithGoodsDetail(func(gd map[string]any) { gd["goodsNum"] = 2 }), "goodsNum"},
		{"missing oldConfig", paraWithGoodsDetail(func(gd map[string]any) { delete(gd, "oldConfig") }), "oldConfig"},
		{"missing newConfig", paraWithGoodsDetail(func(gd map[string]any) { delete(gd, "newConfig") }), "newConfig"},
		{"missing subProductCode", func() map[string]any { p := stdParaMap(); p["subProductCode"] = ""; return p }(), "subProductCode"},
		{"missing productCode", func() map[string]any { p := stdParaMap(); p["productCode"] = ""; return p }(), "productCode"},
		{"bad curDeadline", paraWithGoodsDetail(func(gd map[string]any) { gd["curDeadline"] = "2026/06/15 10:30:00" }), "curDeadline"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			deps, ctl := stdDeps()
			resp := invokeHandler(t, deps, c.para)
			if resp.ReturnCode != ReturnCodeInvalidPara {
				t.Fatalf("returnCode = %d, want %d (msg=%q)",
					resp.ReturnCode, ReturnCodeInvalidPara, resp.ReturnMessage)
			}
			if !strings.Contains(resp.ReturnMessage, c.want) {
				t.Errorf("message %q should mention %q", resp.ReturnMessage, c.want)
			}
			if ctl.calls != 0 {
				t.Errorf("参数错时不应打到 ctl, calls=%d", ctl.calls)
			}
		})
	}
}

// ---- BundleNotFound (600802) -------------------------------------------------

func TestCheckModifyBundleNotFound(t *testing.T) {
	for _, missing := range []string{sourceBundleID, targetBundleID} {
		t.Run(missing, func(t *testing.T) {
			defs := stdDefs()
			delete(defs, missing)
			deps, _ := stdDeps()
			deps.BundleStore = &fakeBundleStore{defs: defs}

			resp := invokeHandler(t, deps, stdParaMap())
			if resp.ReturnCode != ReturnCodeBundleNotFound {
				t.Fatalf("returnCode = %d, want %d (msg=%q)",
					resp.ReturnCode, ReturnCodeBundleNotFound, resp.ReturnMessage)
			}
		})
	}
}

// SV 集合反查不到在册套餐的各种成因，全部归 600802。
//
// 这组用例的归类随"改用 SV 反查"发生了变化：以前套餐身份由 goodsDetail.bundleId 给出，
// SV 对不上是"已知套餐 + 配置漂移" → 600803；现在 SV **就是**套餐身份，对不上意味着
// "这套配置不对应任何在册套餐" → 600802。拒绝的行为没变，只是错误码语义更准确。
//
// 业务价值不变且仍是这一层最关键的保护：它保证"计费准备扣的钱"和"我们准备发的货"
// 描述同一个规格。运营改了 SV 却没同步计费接入单时，这里 fail-closed，
// 不会让用户按巡游价拿到启航配置。
func TestCheckModifyUnresolvableSVIsBundleNotFound(t *testing.T) {
	cases := []struct {
		name    string
		para    map[string]any
		defs    map[string]*store.BundleDefinition
		wantMsg string
	}{
		{
			// 计费准备扣巡游的钱，newConfig 却描述别的规格。
			name:    "newConfig value drifted from every bundle",
			para:    paraWithGoodsDetail(func(gd map[string]any) { gd["newConfig"] = map[string]any{"sv_cpu": 8, "sv_mem": 8, "sv_disk": 80} }),
			wantMsg: "newConfig sv list matches no bundle definition",
		},
		{
			name:    "newConfig key count differs",
			para:    paraWithGoodsDetail(func(gd map[string]any) { gd["newConfig"] = map[string]any{"sv_cpu": 4} }),
			wantMsg: "newConfig sv list matches no bundle definition",
		},
		{
			name:    "oldConfig drifted from every bundle",
			para:    paraWithGoodsDetail(func(gd map[string]any) { gd["oldConfig"] = map[string]any{"sv_cpu": 1} }),
			wantMsg: "oldConfig sv list matches no bundle definition",
		},
		{
			// 目标套餐被挪到别的 SP：本期只做同 SP，检索域按 para.subProductCode 限定，
			// 于是目标在域内查不到 → 600802。跨 SP 变配请求进不来是这一层的边界保证。
			name: "target moved to another sub product",
			para: stdParaMap(),
			defs: func() map[string]*store.BundleDefinition {
				defs := stdDefs()
				defs[targetBundleID].SubProductCode = "sp_lightvela_ai_cn"
				return defs
			}(),
			wantMsg: "newConfig sv list matches no bundle definition",
		},
		{
			// 计费送来的 SP 与我们在册的都不匹配 → 检索域为空。
			name:    "para sub product drifted",
			para:    func() map[string]any { p := stdParaMap(); p["subProductCode"] = "sp_other"; return p }(),
			wantMsg: "no bundle definition for",
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			deps, ctl := stdDeps()
			if c.defs != nil {
				deps.BundleStore = &fakeBundleStore{defs: c.defs}
			}
			resp := invokeHandler(t, deps, c.para)
			if resp.ReturnCode != ReturnCodeBundleNotFound {
				t.Fatalf("returnCode = %d, want %d (msg=%q)",
					resp.ReturnCode, ReturnCodeBundleNotFound, resp.ReturnMessage)
			}
			if !strings.Contains(resp.ReturnMessage, c.wantMsg) {
				t.Errorf("message %q should mention %q", resp.ReturnMessage, c.wantMsg)
			}
			if ctl.calls != 0 {
				t.Errorf("反查失败时不应打到 ctl, calls=%d", ctl.calls)
			}
		})
	}
}

// ---- ConfigMismatch (600803) -------------------------------------------------

func TestCheckModifyConfigMismatch(t *testing.T) {
	cases := []struct {
		name    string
		para    map[string]any
		defs    map[string]*store.BundleDefinition
		wantMsg string
	}{
		{
			name:    "same source and target",
			para:    paraWithGoodsDetail(func(gd map[string]any) { gd["newConfig"] = map[string]any{"sv_cpu": 2, "sv_mem": 4, "sv_disk": 60} }),
			wantMsg: "identical",
		},
		{
			name:    "pid mismatch",
			para:    paraWithGoodsDetail(func(gd map[string]any) { gd["pid"] = 9999 }),
			wantMsg: "pid mismatch",
		},
		{
			// 同 SP 内出现两个 sv_list 完全相同的套餐：任何选择都是猜，必须拒。
			// 这是 SV 反查唯一性前提被破坏时的兜底（见 resolve.go）。
			name: "ambiguous target: duplicated sv list in same sp",
			para: stdParaMap(),
			defs: func() map[string]*store.BundleDefinition {
				defs := stdDefs()
				defs["bundle_cruise_clone"] = &store.BundleDefinition{
					BundleID:       "bundle_cruise_clone",
					ProductCode:    "p_lighthouse",
					SubProductCode: "sp_lightvela_cn",
					Pid:            4001,
					SVList:         map[string]int64{"sv_cpu": 4, "sv_mem": 8, "sv_disk": 80},
				}
				return defs
			}(),
			wantMsg: "ambiguous",
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			deps, ctl := stdDeps()
			if c.defs != nil {
				deps.BundleStore = &fakeBundleStore{defs: c.defs}
			}
			resp := invokeHandler(t, deps, c.para)
			if resp.ReturnCode != ReturnCodeConfigMismatch {
				t.Fatalf("returnCode = %d, want %d (msg=%q)",
					resp.ReturnCode, ReturnCodeConfigMismatch, resp.ReturnMessage)
			}
			if !strings.Contains(resp.ReturnMessage, c.wantMsg) {
				t.Errorf("message %q should mention %q", resp.ReturnMessage, c.wantMsg)
			}
			if ctl.calls != 0 {
				t.Errorf("对账失败时不应打到 ctl, calls=%d", ctl.calls)
			}
		})
	}
}

// ---- NotModifiable (600804) / InternalError (600805) ------------------------

func TestCheckModifyCTLErrorClassification(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want int
	}{
		{
			name: "ctl 4xx is permanent business error",
			err:  &ctlclient.Error{HTTPStatus: 409, Code: "PASS_MODIFYING", Message: "pass is modifying"},
			want: ReturnCodeNotModifiable,
		},
		{
			name: "pass not found",
			err:  ctlclient.ErrNotFound,
			want: ReturnCodeNotModifiable,
		},
		{
			name: "ctl 5xx is retriable",
			err:  &ctlclient.Error{HTTPStatus: 500, Code: "INTERNAL", Message: "boom"},
			want: ReturnCodeInternalError,
		},
		{
			name: "network error is retriable",
			err:  errors.New("connection refused"),
			want: ReturnCodeInternalError,
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			deps, ctl := stdDeps()
			ctl.err = c.err
			resp := invokeHandler(t, deps, stdParaMap())
			if resp.ReturnCode != c.want {
				t.Fatalf("returnCode = %d, want %d (msg=%q)", resp.ReturnCode, c.want, resp.ReturnMessage)
			}
		})
	}
}

func TestCheckModifyBundleStoreErrorIsInternal(t *testing.T) {
	deps, _ := stdDeps()
	deps.BundleStore = &fakeBundleStore{defs: stdDefs(), err: errors.New("db down")}
	resp := invokeHandler(t, deps, stdParaMap())
	if resp.ReturnCode != ReturnCodeInternalError {
		t.Fatalf("returnCode = %d, want %d (msg=%q)",
			resp.ReturnCode, ReturnCodeInternalError, resp.ReturnMessage)
	}
}

// ---- Install -----------------------------------------------------------------

func TestInstallRegistersCheckModifyHandler(t *testing.T) {
	d := jifei.NewDispatcher("lightvela", stdBuilder())
	deps, _ := stdDeps()

	Install(d, deps)

	defer func() {
		if r := recover(); r == nil {
			t.Error("expected panic on duplicate Install (dispatcher.Register 同名重复)")
		}
	}()
	Install(d, deps)
}

// ---- 出向 ↔ 回调 契约 --------------------------------------------------------

// 出向构造和回调解析是两个包各写一半的同一份契约：BuildModifyGoodsDetail 写 key，
// 本包读 key。手写 fixture 断言不到这层——任一侧改 key 名都要等到联调才炸。
//
// ⚠️ 这条用例的前身把 BuildModifyGoodsDetail 的出向报文**原样**喂回 checkModify，
// 于是 bundleId / newBundleId 一直在，把"计费不回传自定义键"这个真实缺陷完整遮住了
// （2026-09-02 联调，变配下单固定 502 / 700002）。现在改为先过一遍
// jifeiCallbackFilter 模拟计费的字段过滤，再喂回 handler：出向仍取真实构造函数（保住
// key 名契约），入向形状则与实测回调一致。
func TestCheckModifyAcceptsGoodsDetailBuiltByInquiryPath(t *testing.T) {
	defs := stdDefs()
	source, target := defs[sourceBundleID], defs[targetBundleID]

	built := jifeiproto.BuildModifyGoodsDetail(jifeiproto.ModifyGoodsDetailInput{
		ProductCode:    source.ProductCode,
		SubProductCode: source.SubProductCode,
		Pid:            source.Pid,
		ResourceID:     testPassID,
		CurDeadline:    "2026-06-15 10:30:00",
		SourceBundleID: sourceBundleID,
		TargetBundleID: targetBundleID,
		SourceSVList:   source.SVList,
		TargetSVList:   target.SVList,
	})

	// 先自检：出向确实带了这两个自定义键（否则本用例的"过滤"就没在过滤任何东西，
	// 断言会变成空转）。
	for _, key := range []string{"bundleId", "newBundleId"} {
		if _, ok := built[key]; !ok {
			t.Fatalf("BuildModifyGoodsDetail 不再输出 %q；"+
				"若是有意删除，请同步删掉本用例的过滤自检", key)
		}
	}

	para := stdParaMap()
	para["goodsDetail"] = jifeiCallbackFilter(built)

	deps, ctl := stdDeps()
	// invokeHandler 会把整个 para 过一遍 JSON，所以数值到达 handler 时是 float64，
	// 与计费真实回调同形。
	resp := invokeHandler(t, deps, para)

	if resp.ReturnCode != 0 {
		t.Fatalf("returnCode = %d, want 0 (msg=%q)", resp.ReturnCode, resp.ReturnMessage)
	}
	if ctl.calls != 1 {
		t.Fatalf("ctl CheckPassModify calls = %d, want 1", ctl.calls)
	}
	req := ctl.lastReq
	if req.SourceBundleID != sourceBundleID || req.TargetBundleID != targetBundleID {
		t.Fatalf("bundle pair = %q → %q", req.SourceBundleID, req.TargetBundleID)
	}
	if req.CurDeadline == nil {
		t.Fatal("CurDeadline is nil, want the built literal parsed back")
	}
}

// jifeiCallbackFilter 模拟计费对 checkModify 回调 goodsDetail 的字段过滤。
//
// 依据实测报文（2026-09-02 20:48:31 journald `[jifei-cb-in]`，pass-ery75v2j 变配下单）：
// 出向送了 productCode / subProductCode / pid / resourceId / bundleId / newBundleId /
// 顶层展平 sv_* / oldConfig / newConfig / curDeadline / goodsNum，
// 回调只剩 **oldConfig / newConfig / curDeadline / goodsNum** 四个键——计费只回传它协议
// 字段表里认识的键，其余（含 trade 自塞的自定义键）一律丢弃。
//
// 注意 oldConfig / newConfig **内层**的 pid / productCode / subProductCode 是被保留的
// （它们是变配询价协议要求的自描述字段，见 jifei.buildModifyConfig），所以这里只过滤
// 顶层，不动内层。
func jifeiCallbackFilter(goodsDetail map[string]interface{}) map[string]interface{} {
	kept := map[string]bool{
		"oldConfig":   true,
		"newConfig":   true,
		"curDeadline": true,
		"goodsNum":    true,
	}
	out := make(map[string]interface{}, len(kept))
	for key, value := range goodsDetail {
		if kept[key] {
			out[key] = value
		}
	}
	return out
}

// TestCheckModifyAcceptsRealBillingCallbackShape 用 2026-09-02 联调实测抓到的**原始**
// 回调报文（journald `[jifei-cb-in]`，国内通用 启航→巡游，pass-ery75v2j）锁死入向形状。
//
// 为什么要单独留这一条而不是只靠上面那条：jifeiCallbackFilter 毕竟是我们**推断**出的
// 过滤规则；这条是计费真身发过的字节。两条一起看，才能区分"我们对协议的理解变了"和
// "计费真的改了报文"。签名 / eventId 等外层字段与本包无关，故只保留 interface.para。
//
// 报文里的 sv 名和 pid 是生产接入单里的真值，与本文件其它用例的化名 fixture 不同，
// 因此本用例自带 bundle 定义，不复用 stdDefs()。
func TestCheckModifyAcceptsRealBillingCallbackShape(t *testing.T) {
	const realPara = `{
      "appId": 1374209606,
      "uin": "700003135209",
      "region": 1,
      "zoneId": 100001,
      "resourceId": "pass-ery75v2j",
      "operateUin": "700003135209",
      "creator": "700003135209",
      "goodsDetail": {
        "newConfig": {
          "pid": 1059119,
          "productCode": "p_lighthouse",
          "subProductCode": "sp_lighthouse_lightvela_mc",
          "sv_lighthouse_lv_bw_cruise_mc_01": 1,
          "sv_lighthouse_lv_compute_cruise_mc_lg8_01": 1,
          "sv_lighthouse_lv_disk_cruise_mc_80gb": 1,
          "sv_lighthouse_lv_slot_cruise_mc_01": 1
        },
        "oldConfig": {
          "pid": 1059119,
          "productCode": "p_lighthouse",
          "subProductCode": "sp_lighthouse_lightvela_mc",
          "sv_lighthouse_lv_bw_launch_mc_01": 1,
          "sv_lighthouse_lv_compute_launch_mc_med4_01": 1,
          "sv_lighthouse_lv_disk_launch_mc_50gb": 1,
          "sv_lighthouse_lv_slot_launch_mc_01": 1
        },
        "curDeadline": "2026-09-06 07:20:11",
        "goodsNum": 1
      },
      "payMode": 1,
      "projectId": 0,
      "activityId": "",
      "subProductCode": "sp_lighthouse_lightvela_mc",
      "productCode": "p_lighthouse"
    }`

	prodDefs := map[string]*store.BundleDefinition{
		"bundle_launch_01": {
			BundleID:       "bundle_launch_01",
			ProductCode:    "p_lighthouse",
			SubProductCode: "sp_lighthouse_lightvela_mc",
			Pid:            1059119,
			SVList: map[string]int64{
				"sv_lighthouse_lv_compute_launch_mc_med4_01": 1,
				"sv_lighthouse_lv_disk_launch_mc_50gb":       1,
				"sv_lighthouse_lv_bw_launch_mc_01":           1,
				"sv_lighthouse_lv_slot_launch_mc_01":         1,
			},
		},
		"bundle_cruise_01": {
			BundleID:       "bundle_cruise_01",
			ProductCode:    "p_lighthouse",
			SubProductCode: "sp_lighthouse_lightvela_mc",
			Pid:            1059119,
			SVList: map[string]int64{
				"sv_lighthouse_lv_compute_cruise_mc_lg8_01": 1,
				"sv_lighthouse_lv_disk_cruise_mc_80gb":      1,
				"sv_lighthouse_lv_bw_cruise_mc_01":          1,
				"sv_lighthouse_lv_slot_cruise_mc_01":        1,
			},
		},
	}

	ctl := &fakeCTLClient{}
	deps := Deps{
		CTLClient:   ctl,
		BundleStore: &fakeBundleStore{defs: prodDefs},
		Builder:     stdBuilder(),
	}

	resp, err := makeHandler(deps)(context.Background(), json.RawMessage(realPara))
	if err != nil {
		t.Fatalf("makeHandler returned non-nil err: %v", err)
	}
	if resp.ReturnCode != 0 {
		t.Fatalf("returnCode = %d, want 0 (msg=%q)", resp.ReturnCode, resp.ReturnMessage)
	}
	if resp.Data["status"] != 0 || len(resp.Data) != 1 {
		t.Errorf("data = %+v, want exactly {status:0}", resp.Data)
	}
	if ctl.calls != 1 {
		t.Fatalf("ctl CheckPassModify calls = %d, want 1", ctl.calls)
	}
	req := ctl.lastReq
	if req.SourceBundleID != "bundle_launch_01" || req.TargetBundleID != "bundle_cruise_01" {
		t.Fatalf("bundle pair = %q → %q, want bundle_launch_01 → bundle_cruise_01",
			req.SourceBundleID, req.TargetBundleID)
	}
	if req.Uin != 700003135209 || req.AppID != 1374209606 {
		t.Errorf("uin/appId = %d/%d", req.Uin, req.AppID)
	}
	if req.CurDeadline == nil {
		t.Fatal("CurDeadline is nil")
	}
	if got := req.CurDeadline.UTC().Format("2006-01-02 15:04:05"); got != "2026-09-05 23:20:11" {
		t.Errorf("CurDeadline in UTC = %q, want 2026-09-05 23:20:11 (CST 07:20:11)", got)
	}
}
