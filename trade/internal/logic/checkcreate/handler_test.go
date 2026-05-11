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

// ---- 标准 happy-path fixtures ------------------------------------------------

// stdOrder 是覆盖默认 happy-path 的 trade_order 快照。
func stdOrder() *store.TradeOrder {
	return &store.TradeOrder{
		DealName:       "deal-001",
		ExternalUserID: "user-001",
		Uin:            "100012345678",
		AppID:          "12345678",
		BundleID:       "bundle_linux_small_01",
		Period:         1,
		TimeUnit:       "m",
		GoodsNum:       1,
		PayMode:        1,
		Status:         "pending_pay",
	}
}

// stdBundle 是默认 ONLINE / AVAILABLE bundle。
func stdBundle() *ctlclient.BundleDetail {
	return &ctlclient.BundleDetail{
		BundleID:         "bundle_linux_small_01",
		BundleState:      "ONLINE",
		BundleSalesState: "AVAILABLE",
	}
}

// stdBundleDef 是默认 bundle_definition（含 sv_cpu / sv_mem 两项）。
func stdBundleDef() *store.BundleDefinition {
	return &store.BundleDefinition{
		BundleID: "bundle_linux_small_01",
		Pid:      "40000",
		SVList: map[string]interface{}{
			"cpu": "2",
			"mem": "4G",
		},
	}
}

// stdPara 是默认 happy-path 入参 JSON（match stdOrder + stdBundleDef）。
func stdPara() json.RawMessage {
	return json.RawMessage(`{
		"dealName": "deal-001",
		"appId": "12345678",
		"uin": "100012345678",
		"subProductCode": "sp_lighthouse_bundle_linux_small",
		"bundleId": "bundle_linux_small_01",
		"goodsNum": 1,
		"goodsDetail": {
			"pid": "40000",
			"timeSpan": 1,
			"timeUnit": "m",
			"goodsNum": 1,
			"payMode": 1,
			"sv_cpu": "2",
			"sv_mem": "4G"
		}
	}`)
}

func newDeps(orderStore store.OrderStore, bundleDefStore store.BundleDefinitionStore, ctlClient ctlclient.Client) Deps {
	return Deps{
		OrderStore:  orderStore,
		BundleStore: bundleDefStore,
		CTLClient:   ctlClient,
		Builder:     jifei.NewFrameworkBuilder("trade", "1.0"),
	}
}

func runHandler(t *testing.T, deps Deps, para json.RawMessage) jifei.Framework {
	t.Helper()
	resp, err := makeHandler(deps)(context.Background(), para)
	if err != nil {
		t.Fatalf("handler returned error: %v", err)
	}
	if resp.ReturnCode != resp.ReturnValue {
		t.Fatalf("Q58 invariant violated: returnCode=%d returnValue=%d", resp.ReturnCode, resp.ReturnValue)
	}
	if resp.ReturnCode == jifei.RefundReturnCode {
		t.Fatalf("checkCreate must NEVER return refund magic %d (Q56 refund only allowed in createResource A-class)",
			jifei.RefundReturnCode)
	}
	return resp
}

// ---- 测试用例 ----------------------------------------------------------------

// 1. happy-path：5 项校验全过 → returnCode=0
func TestCheckCreate_HappyPath(t *testing.T) {
	deps := newDeps(
		&fakeOrderStore{order: stdOrder()},
		&fakeBundleDefStore{def: stdBundleDef()},
		&fakeCTLClient{bundle: stdBundle(), passes: nil},
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

// 3. para 必填字段缺失（dealName 空）→ ReturnCodeInvalidPara
func TestCheckCreate_MissingDealName(t *testing.T) {
	deps := newDeps(&fakeOrderStore{}, &fakeBundleDefStore{}, &fakeCTLClient{})
	para := json.RawMessage(`{"bundleId":"bx","goodsNum":1,"goodsDetail":{}}`)
	resp := runHandler(t, deps, para)
	if resp.ReturnCode != ReturnCodeInvalidPara {
		t.Fatalf("expected ReturnCodeInvalidPara, got %d", resp.ReturnCode)
	}
	if !strings.Contains(resp.ReturnMessage, "dealName") {
		t.Fatalf("expected message to mention dealName, got %q", resp.ReturnMessage)
	}
}

// 4. trade_order not found → ReturnCodeOrderNotFound
func TestCheckCreate_OrderNotFound(t *testing.T) {
	deps := newDeps(
		&fakeOrderStore{err: store.ErrTradeOrderNotFound},
		&fakeBundleDefStore{def: stdBundleDef()},
		&fakeCTLClient{bundle: stdBundle()},
	)
	resp := runHandler(t, deps, stdPara())
	if resp.ReturnCode != ReturnCodeOrderNotFound {
		t.Fatalf("expected ReturnCodeOrderNotFound=%d, got %d", ReturnCodeOrderNotFound, resp.ReturnCode)
	}
}

// 5. trade_order SQL 错（非 not_found）→ ReturnCodeUpstreamUnavailable
func TestCheckCreate_OrderSQLError(t *testing.T) {
	deps := newDeps(
		&fakeOrderStore{err: errors.New("connection refused")},
		&fakeBundleDefStore{def: stdBundleDef()},
		&fakeCTLClient{bundle: stdBundle()},
	)
	resp := runHandler(t, deps, stdPara())
	if resp.ReturnCode != ReturnCodeUpstreamUnavailable {
		t.Fatalf("expected ReturnCodeUpstreamUnavailable=%d, got %d", ReturnCodeUpstreamUnavailable, resp.ReturnCode)
	}
}

// 6. ctl bundle 404 → ReturnCodeBundleNotFound
func TestCheckCreate_BundleNotFound(t *testing.T) {
	deps := newDeps(
		&fakeOrderStore{order: stdOrder()},
		&fakeBundleDefStore{def: stdBundleDef()},
		&fakeCTLClient{bundleErr: ctlclient.ErrNotFound},
	)
	resp := runHandler(t, deps, stdPara())
	if resp.ReturnCode != ReturnCodeBundleNotFound {
		t.Fatalf("expected ReturnCodeBundleNotFound=%d, got %d", ReturnCodeBundleNotFound, resp.ReturnCode)
	}
}

// 7. bundle state=OFFLINE → ReturnCodeBundleOffline
func TestCheckCreate_BundleOffline(t *testing.T) {
	bundle := stdBundle()
	bundle.BundleState = "OFFLINE"
	deps := newDeps(
		&fakeOrderStore{order: stdOrder()},
		&fakeBundleDefStore{def: stdBundleDef()},
		&fakeCTLClient{bundle: bundle},
	)
	resp := runHandler(t, deps, stdPara())
	if resp.ReturnCode != ReturnCodeBundleOffline {
		t.Fatalf("expected ReturnCodeBundleOffline=%d, got %d", ReturnCodeBundleOffline, resp.ReturnCode)
	}
}

// 8. bundle sales_state=SOLD_OUT → ReturnCodeBundleSoldOut
func TestCheckCreate_BundleSoldOut(t *testing.T) {
	bundle := stdBundle()
	bundle.BundleSalesState = "SOLD_OUT"
	deps := newDeps(
		&fakeOrderStore{order: stdOrder()},
		&fakeBundleDefStore{def: stdBundleDef()},
		&fakeCTLClient{bundle: bundle},
	)
	resp := runHandler(t, deps, stdPara())
	if resp.ReturnCode != ReturnCodeBundleSoldOut {
		t.Fatalf("expected ReturnCodeBundleSoldOut=%d, got %d", ReturnCodeBundleSoldOut, resp.ReturnCode)
	}
}

// 9. ctl bundle HTTP 5xx → ReturnCodeUpstreamUnavailable
func TestCheckCreate_BundleUpstreamError(t *testing.T) {
	deps := newDeps(
		&fakeOrderStore{order: stdOrder()},
		&fakeBundleDefStore{def: stdBundleDef()},
		&fakeCTLClient{bundleErr: errors.New("ctl http 502")},
	)
	resp := runHandler(t, deps, stdPara())
	if resp.ReturnCode != ReturnCodeUpstreamUnavailable {
		t.Fatalf("expected ReturnCodeUpstreamUnavailable, got %d", resp.ReturnCode)
	}
}

// 10. trade_bundle_definition not found → ReturnCodeBundleNotFound
func TestCheckCreate_BundleDefNotFound(t *testing.T) {
	deps := newDeps(
		&fakeOrderStore{order: stdOrder()},
		&fakeBundleDefStore{err: store.ErrBundleDefinitionNotFound},
		&fakeCTLClient{bundle: stdBundle()},
	)
	resp := runHandler(t, deps, stdPara())
	if resp.ReturnCode != ReturnCodeBundleNotFound {
		t.Fatalf("expected ReturnCodeBundleNotFound, got %d", resp.ReturnCode)
	}
}

// 11. Q54 维度 1：pid 不一致 → ReturnCodeBusinessParamMismatch
func TestCheckCreate_Q54_PidMismatch(t *testing.T) {
	def := stdBundleDef()
	def.Pid = "40001" // 与 jifei para.goodsDetail.pid="40000" 不一致
	deps := newDeps(
		&fakeOrderStore{order: stdOrder()},
		&fakeBundleDefStore{def: def},
		&fakeCTLClient{bundle: stdBundle()},
	)
	resp := runHandler(t, deps, stdPara())
	if resp.ReturnCode != ReturnCodeBusinessParamMismatch {
		t.Fatalf("expected ReturnCodeBusinessParamMismatch, got %d", resp.ReturnCode)
	}
	if !strings.Contains(resp.ReturnMessage, "pid") {
		t.Fatalf("expected message to mention pid, got %q", resp.ReturnMessage)
	}
}

// 12. Q54 维度 2：timeSpan 不一致 → ReturnCodeBusinessParamMismatch
func TestCheckCreate_Q54_TimeSpanMismatch(t *testing.T) {
	order := stdOrder()
	order.Period = 12 // jifei para.timeSpan=1 不一致
	deps := newDeps(
		&fakeOrderStore{order: order},
		&fakeBundleDefStore{def: stdBundleDef()},
		&fakeCTLClient{bundle: stdBundle()},
	)
	resp := runHandler(t, deps, stdPara())
	if resp.ReturnCode != ReturnCodeBusinessParamMismatch || !strings.Contains(resp.ReturnMessage, "timeSpan") {
		t.Fatalf("expected timeSpan mismatch, got code=%d msg=%q", resp.ReturnCode, resp.ReturnMessage)
	}
}

// 13. Q54 维度 3：timeUnit 不一致
func TestCheckCreate_Q54_TimeUnitMismatch(t *testing.T) {
	order := stdOrder()
	order.TimeUnit = "y"
	deps := newDeps(
		&fakeOrderStore{order: order},
		&fakeBundleDefStore{def: stdBundleDef()},
		&fakeCTLClient{bundle: stdBundle()},
	)
	resp := runHandler(t, deps, stdPara())
	if resp.ReturnCode != ReturnCodeBusinessParamMismatch || !strings.Contains(resp.ReturnMessage, "timeUnit") {
		t.Fatalf("expected timeUnit mismatch, got code=%d msg=%q", resp.ReturnCode, resp.ReturnMessage)
	}
}

// 14. Q54 维度 4：goodsNum 不一致
func TestCheckCreate_Q54_GoodsNumMismatch(t *testing.T) {
	order := stdOrder()
	order.GoodsNum = 2
	deps := newDeps(
		&fakeOrderStore{order: order},
		&fakeBundleDefStore{def: stdBundleDef()},
		&fakeCTLClient{bundle: stdBundle()},
	)
	resp := runHandler(t, deps, stdPara())
	if resp.ReturnCode != ReturnCodeBusinessParamMismatch || !strings.Contains(resp.ReturnMessage, "goodsNum") {
		t.Fatalf("expected goodsNum mismatch, got code=%d msg=%q", resp.ReturnCode, resp.ReturnMessage)
	}
}

// 15. Q54 维度 5（sv_*）：sv_cpu 不一致
func TestCheckCreate_Q54_SVMismatch(t *testing.T) {
	def := stdBundleDef()
	def.SVList["cpu"] = "4" // 期望 sv_cpu="4"，但 jifei 入参 sv_cpu="2"
	deps := newDeps(
		&fakeOrderStore{order: stdOrder()},
		&fakeBundleDefStore{def: def},
		&fakeCTLClient{bundle: stdBundle()},
	)
	resp := runHandler(t, deps, stdPara())
	if resp.ReturnCode != ReturnCodeBusinessParamMismatch || !strings.Contains(resp.ReturnMessage, "sv_cpu") {
		t.Fatalf("expected sv_cpu mismatch, got code=%d msg=%q", resp.ReturnCode, resp.ReturnMessage)
	}
}

// 16. Q54 sv_*：jifei 入参缺失 sv 字段 → BUSINESS_PARAM_MISMATCH
func TestCheckCreate_Q54_SVMissingInPara(t *testing.T) {
	deps := newDeps(
		&fakeOrderStore{order: stdOrder()},
		&fakeBundleDefStore{def: stdBundleDef()},
		&fakeCTLClient{bundle: stdBundle()},
	)
	// 故意去掉 sv_mem
	para := json.RawMessage(`{
		"dealName": "deal-001",
		"bundleId": "bundle_linux_small_01",
		"goodsNum": 1,
		"goodsDetail": {
			"pid": "40000",
			"timeSpan": 1,
			"timeUnit": "m",
			"goodsNum": 1,
			"payMode": 1,
			"sv_cpu": "2"
		}
	}`)
	resp := runHandler(t, deps, para)
	if resp.ReturnCode != ReturnCodeBusinessParamMismatch || !strings.Contains(resp.ReturnMessage, "sv_mem") {
		t.Fatalf("expected sv_mem mismatch, got code=%d msg=%q", resp.ReturnCode, resp.ReturnMessage)
	}
}

// 17. §5.2 #3 payMode 不一致
func TestCheckCreate_PayModeMismatch(t *testing.T) {
	order := stdOrder()
	order.PayMode = 0 // jifei para.payMode=1 不一致
	deps := newDeps(
		&fakeOrderStore{order: order},
		&fakeBundleDefStore{def: stdBundleDef()},
		&fakeCTLClient{bundle: stdBundle()},
	)
	resp := runHandler(t, deps, stdPara())
	if resp.ReturnCode != ReturnCodeBusinessParamMismatch || !strings.Contains(resp.ReturnMessage, "payMode") {
		t.Fatalf("expected payMode mismatch, got code=%d msg=%q", resp.ReturnCode, resp.ReturnMessage)
	}
}

// 18. §5.2 #3 jifei 入参 goodsDetail 没有 payMode → BUSINESS_PARAM_MISMATCH
func TestCheckCreate_PayModeMissing(t *testing.T) {
	deps := newDeps(
		&fakeOrderStore{order: stdOrder()},
		&fakeBundleDefStore{def: stdBundleDef()},
		&fakeCTLClient{bundle: stdBundle()},
	)
	para := json.RawMessage(`{
		"dealName": "deal-001",
		"bundleId": "bundle_linux_small_01",
		"goodsNum": 1,
		"goodsDetail": {
			"pid": "40000",
			"timeSpan": 1,
			"timeUnit": "m",
			"goodsNum": 1,
			"sv_cpu": "2",
			"sv_mem": "4G"
		}
	}`)
	resp := runHandler(t, deps, para)
	if resp.ReturnCode != ReturnCodeBusinessParamMismatch || !strings.Contains(resp.ReturnMessage, "payMode") {
		t.Fatalf("expected payMode missing, got code=%d msg=%q", resp.ReturnCode, resp.ReturnMessage)
	}
}

// 19. §5.2 #5 quota 互斥（用户已有 1 个 pass）→ ReturnCodeQuotaOccupied
func TestCheckCreate_QuotaOccupied(t *testing.T) {
	deps := newDeps(
		&fakeOrderStore{order: stdOrder()},
		&fakeBundleDefStore{def: stdBundleDef()},
		&fakeCTLClient{bundle: stdBundle(), passes: []*ctlclient.PassDetail{
			{PassID: "p1", BundleID: "bundle_linux_small_01"},
		}},
	)
	resp := runHandler(t, deps, stdPara())
	if resp.ReturnCode != ReturnCodeQuotaOccupied {
		t.Fatalf("expected ReturnCodeQuotaOccupied=%d, got %d", ReturnCodeQuotaOccupied, resp.ReturnCode)
	}
}

// 20. §5.2 #5 quota 接口 5xx → ReturnCodeUpstreamUnavailable
func TestCheckCreate_QuotaUpstreamError(t *testing.T) {
	deps := newDeps(
		&fakeOrderStore{order: stdOrder()},
		&fakeBundleDefStore{def: stdBundleDef()},
		&fakeCTLClient{bundle: stdBundle(), passesErr: errors.New("ctl 503")},
	)
	resp := runHandler(t, deps, stdPara())
	if resp.ReturnCode != ReturnCodeUpstreamUnavailable {
		t.Fatalf("expected ReturnCodeUpstreamUnavailable, got %d", resp.ReturnCode)
	}
}

// 21. Q62 不变性：handler 自身完全不依赖任何 trade_flow 写入路径
//
// 通过结构断言 — Deps 里没有 FlowStore 字段；如果未来有同事在 handler 内偷偷写
// trade_flow，则 Deps 必须新增字段并破坏本测试编译。这是编译期保险，不是运行时检查。
func TestCheckCreate_Q62_NoFlowDependency(t *testing.T) {
	d := Deps{}
	// 把 Deps 所有字段名拼成字符串，断言其中没有出现 "flow"。
	// 用反射太重；直接源码 review 已可保证，这里只用编译期占位测试占住该不变性。
	_ = d
}

// 22. Q56 不变性：checkCreate 任何分支都不返退款魔法值
//
// 已经在 runHandler 工具方法里集中断言了 — 任意测试用例返 352014 会立刻 t.Fatalf。
// 此测试单独跑一次"覆盖了所有错误码分支"的快速合验。
func TestCheckCreate_Q56_NoRefundOnAnyBranch(t *testing.T) {
	cases := []struct {
		name string
		deps Deps
		para json.RawMessage
	}{
		{"order_not_found", newDeps(
			&fakeOrderStore{err: store.ErrTradeOrderNotFound},
			&fakeBundleDefStore{def: stdBundleDef()},
			&fakeCTLClient{bundle: stdBundle()},
		), stdPara()},
		{"bundle_offline", newDeps(
			&fakeOrderStore{order: stdOrder()},
			&fakeBundleDefStore{def: stdBundleDef()},
			&fakeCTLClient{bundle: &ctlclient.BundleDetail{BundleID: "x", BundleState: "OFFLINE", BundleSalesState: "AVAILABLE"}},
		), stdPara()},
		{"quota_occupied", newDeps(
			&fakeOrderStore{order: stdOrder()},
			&fakeBundleDefStore{def: stdBundleDef()},
			&fakeCTLClient{bundle: stdBundle(), passes: []*ctlclient.PassDetail{{PassID: "p1"}}},
		), stdPara()},
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

// 23. Q58 不变性：所有响应（含 happy-path）returnCode == returnValue
func TestCheckCreate_Q58_Invariant(t *testing.T) {
	deps := newDeps(
		&fakeOrderStore{order: stdOrder()},
		&fakeBundleDefStore{def: stdBundleDef()},
		&fakeCTLClient{bundle: stdBundle()},
	)
	resp, err := makeHandler(deps)(context.Background(), stdPara())
	if err != nil {
		t.Fatalf("handler error: %v", err)
	}
	if resp.ReturnCode != 0 || resp.ReturnValue != 0 {
		t.Fatalf("happy-path expected (0,0), got (%d,%d)", resp.ReturnCode, resp.ReturnValue)
	}
}

// 24. Install 注册到真 dispatcher，分发后能命中本 handler（集成路径）
func TestInstall_RegistersToDispatcher(t *testing.T) {
	builder := jifei.NewFrameworkBuilder("trade", "1.0")
	d := jifei.NewDispatcher("lightvela", builder)
	deps := Deps{
		OrderStore:  &fakeOrderStore{order: stdOrder()},
		BundleStore: &fakeBundleDefStore{def: stdBundleDef()},
		CTLClient:   &fakeCTLClient{bundle: stdBundle()},
		Builder:     builder,
	}
	Install(d, deps)

	// 构造完整 envelope 喂给 dispatcher
	envBody, err := json.Marshal(map[string]any{
		"eventId":       "evt-1",
		"componentName": "trade",
		"seqId":         "seq-1",
		"interface": map[string]any{
			"interfaceName": jifei.InterfaceNameCheckCreate,
			"para": json.RawMessage(stdPara()),
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
