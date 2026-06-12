package resourcequery

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

// stdQueryResourcePara 是 happy-path 入参：含 uin / appId / resourceIds / payMode=1 / region。
// 注意 queryResource 关键差异 — 不传 subProductCode 也合法（PDF §2.2）。
func stdQueryResourcePara() json.RawMessage {
	return rawJSON(`{
		"uin": "100012345678",
		"appId": 12345,
		"productCode": "p_lighthouse",
		"payMode": 1,
		"region": 1,
		"resourceIds": ["p1","p2"]
	}`)
}

func runQueryResource(t *testing.T, deps Deps, para json.RawMessage) jifei.Framework {
	t.Helper()
	resp, err := makeQueryResourceHandler(deps)(context.Background(), para)
	if err != nil {
		t.Fatalf("handler error: %v", err)
	}
	if resp.ReturnCode != resp.ReturnValue {
		t.Fatalf("Q58 invariant: returnCode=%d returnValue=%d", resp.ReturnCode, resp.ReturnValue)
	}
	return resp
}

// 1. happy-path：
//   - resourceIds 透传到 ctl.ListPassesByResourceIDs（appID + passIDs）
//   - **不**走 BundleStore.ListBundleDefsBySubProductCode（PDF §2.2 / 设计稿 §2.4 明示）
//   - 每条 pass 的 BundleID 通过 GetBundleDefinitionByID 反查（去重）
//   - resources[i].uin / appId 用入参透传（不是 pass.Uin / pass.AppID）
//   - total = len(resources)（命中数，不是入参 resourceIds 的数量）
func TestQueryResource_HappyPath(t *testing.T) {
	defA := stdBundleDef("bundle_a")
	bundleStore := &fakeBundleStore{
		byIDs: map[string]*store.BundleDefinition{"bundle_a": defA},
	}
	ctl := &fakeCTLClient{
		listByResPasses: []*ctlclient.PassDetail{
			{PassID: "p1", BundleID: "bundle_a", RenewFlag: "AUTO_RENEW"},
			{PassID: "p2", BundleID: "bundle_a"},
		},
	}
	deps := newDeps(ctl, bundleStore)

	resp := runQueryResource(t, deps, stdQueryResourcePara())
	if resp.ReturnCode != 0 {
		t.Fatalf("expected ok, got %d (%s)", resp.ReturnCode, resp.ReturnMessage)
	}
	// ctl 入参回放
	if ctl.listByResLastAppID != 12345 {
		t.Errorf("ctl appID expected 12345, got %d", ctl.listByResLastAppID)
	}
	if len(ctl.listByResLastPassIDs) != 2 || ctl.listByResLastPassIDs[0] != "p1" {
		t.Errorf("ctl passIDs expected [p1,p2], got %v", ctl.listByResLastPassIDs)
	}
	// 关键差异：BundleStore.ListBundleDefsBySubProductCode 不应被调用
	if bundleStore.listBySubCalls != 0 {
		t.Errorf("queryResource MUST NOT call ListBundleDefsBySubProductCode, got %d calls", bundleStore.listBySubCalls)
	}
	// total = 命中数
	if resp.Data["total"].(int64) != 2 {
		t.Errorf("total mismatch: %v (expected 2)", resp.Data["total"])
	}
	resources, _ := resp.Data["resources"].([]map[string]interface{})
	if len(resources) != 2 {
		t.Fatalf("expected 2 resources, got %d", len(resources))
	}
	// resources[0] uin / appId 透传校验
	r1 := resources[0]
	if r1["uin"] != "100012345678" {
		t.Errorf("uin must be input string, got %v", r1["uin"])
	}
	if r1["appId"] != int64(12345) {
		t.Errorf("appId must be input int64, got %v", r1["appId"])
	}
	if r1["resourceId"] != "p1" {
		t.Errorf("resourceId mismatch: %v", r1["resourceId"])
	}
	if r1["renewFlag"] != 1 {
		t.Errorf("renewFlag AUTO_RENEW must be 1, got %v", r1["renewFlag"])
	}
	// batch 反查 dedup：2 条 pass 都引用 bundle_a → 一次 batch 调用，去重后 IDs = ["bundle_a"]
	if bundleStore.batchGetCalls != 1 {
		t.Errorf("expected 1 GetBundleDefinitionsByIDs call (single batch), got %d", bundleStore.batchGetCalls)
	}
	if len(bundleStore.lastBatchIDs) != 1 || bundleStore.lastBatchIDs[0] != "bundle_a" {
		t.Errorf("expected batch IDs to dedup to [bundle_a], got %v", bundleStore.lastBatchIDs)
	}
}

// 2. payMode 缺省 = 1（PDF §2.2 关键差异 — 入参 payMode 字段缺省 / 显式 0 应按 1 处理走正常逻辑，
//    **不**短路返空；这是 queryResource 与 getAllAppIds / getUserResources 的关键差异）
func TestQueryResource_PayModeDefaultIsOne(t *testing.T) {
	defA := stdBundleDef("bundle_a")
	bundleStore := &fakeBundleStore{
		byIDs: map[string]*store.BundleDefinition{"bundle_a": defA},
	}
	ctl := &fakeCTLClient{
		listByResPasses: []*ctlclient.PassDetail{
			{PassID: "p1", BundleID: "bundle_a"},
		},
	}
	deps := newDeps(ctl, bundleStore)
	// 关键：payMode 字段缺失（== 0），handler 内部应填默认 1，**不**应短路
	para := rawJSON(`{
		"uin": "100",
		"appId": 12345,
		"productCode": "p_lighthouse",
		"region": 1,
		"resourceIds": ["p1"]
	}`)
	resp := runQueryResource(t, deps, para)
	if resp.ReturnCode != 0 {
		t.Fatalf("payMode default should be 1 (no short-circuit), got %d (%s)", resp.ReturnCode, resp.ReturnMessage)
	}
	// ctl 应被调用（证明非短路）
	if ctl.listByResCalls != 1 {
		t.Errorf("ctl must be called when payMode defaulted to 1, got %d calls", ctl.listByResCalls)
	}
	resources, _ := resp.Data["resources"].([]map[string]interface{})
	if len(resources) != 1 {
		t.Errorf("expected 1 resource, got %d", len(resources))
	}
}

// 3. payMode 显式 != 1 → 短路返空，不调 ctl
func TestQueryResource_PayModeNotPrepay_ReturnsEmpty(t *testing.T) {
	ctl := &fakeCTLClient{}
	deps := newDeps(ctl, emptyBundleStore())
	para := rawJSON(`{
		"uin": "100",
		"appId": 12345,
		"productCode": "p_lighthouse",
		"payMode": 2,
		"region": 1,
		"resourceIds": ["p1"]
	}`)
	resp := runQueryResource(t, deps, para)
	if resp.ReturnCode != 0 {
		t.Fatalf("expected ok, got %d", resp.ReturnCode)
	}
	if ctl.listByResCalls != 0 {
		t.Errorf("ctl must NOT be called when payMode != 1, got %d calls", ctl.listByResCalls)
	}
	resources, _ := resp.Data["resources"].([]map[string]interface{})
	if len(resources) != 0 {
		t.Errorf("expected empty resources, got %v", resources)
	}
	if resp.Data["total"].(int64) != 0 {
		t.Errorf("total expected 0, got %v", resp.Data["total"])
	}
}

// 4. resourceIds 为空数组 → ReturnCodeInvalidPara
func TestQueryResource_EmptyResourceIDs(t *testing.T) {
	deps := newDeps(&fakeCTLClient{}, emptyBundleStore())
	para := rawJSON(`{
		"uin": "100",
		"appId": 12345,
		"productCode": "p_lighthouse",
		"payMode": 1,
		"region": 1,
		"resourceIds": []
	}`)
	resp := runQueryResource(t, deps, para)
	if resp.ReturnCode != ReturnCodeInvalidPara {
		t.Fatalf("expected ReturnCodeInvalidPara, got %d", resp.ReturnCode)
	}
	if !strings.Contains(resp.ReturnMessage, "resourceIds") {
		t.Errorf("message should mention resourceIds, got %q", resp.ReturnMessage)
	}
}

// 5. resourceIds 缺失 → ReturnCodeInvalidPara
func TestQueryResource_MissingResourceIDs(t *testing.T) {
	deps := newDeps(&fakeCTLClient{}, emptyBundleStore())
	para := rawJSON(`{
		"uin": "100",
		"appId": 12345,
		"productCode": "p_lighthouse",
		"payMode": 1,
		"region": 1
	}`)
	resp := runQueryResource(t, deps, para)
	if resp.ReturnCode != ReturnCodeInvalidPara {
		t.Fatalf("expected ReturnCodeInvalidPara, got %d", resp.ReturnCode)
	}
}

// 6. resourceIds 长度超 100（resourceIDsMax）→ ReturnCodeInvalidPara
func TestQueryResource_ResourceIDsOverLimit(t *testing.T) {
	deps := newDeps(&fakeCTLClient{}, emptyBundleStore())
	ids := make([]string, resourceIDsMax+1)
	for i := range ids {
		ids[i] = "rid"
	}
	idsJSON, _ := json.Marshal(ids)
	para := rawJSON(`{
		"uin": "100",
		"appId": 12345,
		"productCode": "p_lighthouse",
		"payMode": 1,
		"region": 1,
		"resourceIds": ` + string(idsJSON) + `
	}`)
	resp := runQueryResource(t, deps, para)
	if resp.ReturnCode != ReturnCodeInvalidPara {
		t.Fatalf("expected ReturnCodeInvalidPara, got %d", resp.ReturnCode)
	}
	if !strings.Contains(resp.ReturnMessage, "exceed limit") {
		t.Errorf("message should mention exceed limit, got %q", resp.ReturnMessage)
	}
}

// 7. resourceIds 含空字符串元素 → ReturnCodeInvalidPara
func TestQueryResource_ResourceIDsContainsEmpty(t *testing.T) {
	deps := newDeps(&fakeCTLClient{}, emptyBundleStore())
	para := rawJSON(`{
		"uin": "100",
		"appId": 12345,
		"productCode": "p_lighthouse",
		"payMode": 1,
		"region": 1,
		"resourceIds": ["p1", "", "p3"]
	}`)
	resp := runQueryResource(t, deps, para)
	if resp.ReturnCode != ReturnCodeInvalidPara {
		t.Fatalf("expected ReturnCodeInvalidPara, got %d", resp.ReturnCode)
	}
	if !strings.Contains(resp.ReturnMessage, "resourceIds[1]") {
		t.Errorf("message should locate empty element index, got %q", resp.ReturnMessage)
	}
}

// 8. ctl 过滤后命中数 < 入参 resourceIds 数量（PDF §1.2：销毁 / 不存在的资源不返回）
//    → total = len(resources)，**不是**入参的数量（这是合法行为，调用方自行差集判断）
func TestQueryResource_PartialMatch_TotalEqualsHitCount(t *testing.T) {
	defA := stdBundleDef("bundle_a")
	bundleStore := &fakeBundleStore{
		byIDs: map[string]*store.BundleDefinition{"bundle_a": defA},
	}
	// 入参 3 个 resourceId，但 ctl 只返 1 个（其他被销毁 / 不存在 — ctl 内部已过滤）
	ctl := &fakeCTLClient{
		listByResPasses: []*ctlclient.PassDetail{
			{PassID: "p1", BundleID: "bundle_a"},
		},
	}
	deps := newDeps(ctl, bundleStore)
	para := rawJSON(`{
		"uin": "100",
		"appId": 12345,
		"productCode": "p_lighthouse",
		"payMode": 1,
		"region": 1,
		"resourceIds": ["p1","p2","p3"]
	}`)
	resp := runQueryResource(t, deps, para)
	if resp.ReturnCode != 0 {
		t.Fatalf("expected ok, got %d (%s)", resp.ReturnCode, resp.ReturnMessage)
	}
	resources, _ := resp.Data["resources"].([]map[string]interface{})
	if len(resources) != 1 {
		t.Fatalf("expected 1 resource (ctl filtered), got %d", len(resources))
	}
	if resp.Data["total"].(int64) != 1 {
		t.Errorf("total must be hit count (1), not input count (3); got %v", resp.Data["total"])
	}
}

// 9. ctl 调用失败 → ReturnCodeUpstreamUnavailable
func TestQueryResource_CTLError(t *testing.T) {
	ctl := &fakeCTLClient{listByResErr: errors.New("ctl 503")}
	deps := newDeps(ctl, emptyBundleStore())
	resp := runQueryResource(t, deps, stdQueryResourcePara())
	if resp.ReturnCode != ReturnCodeUpstreamUnavailable {
		t.Fatalf("expected ReturnCodeUpstreamUnavailable, got %d", resp.ReturnCode)
	}
}

// 10. uin 选填 — 缺失 → 仍然成功（v1.7.28 BUG-19 修订：PDF §2.2 不要求 uin）
func TestQueryResource_MissingUin(t *testing.T) {
	deps := newDeps(&fakeCTLClient{}, emptyBundleStore())
	para := rawJSON(`{
		"appId": 12345,
		"productCode": "p_lighthouse",
		"payMode": 1,
		"region": 1,
		"resourceIds": ["p1"]
	}`)
	resp := runQueryResource(t, deps, para)
	if resp.ReturnCode != 0 {
		t.Fatalf("expected ReturnCode=0 (uin optional per PDF §2.2), got %d msg=%q", resp.ReturnCode, resp.ReturnMessage)
	}
}

// 11. uin 非数字字符串 → ReturnCodeInvalidPara
func TestQueryResource_NonNumericUin(t *testing.T) {
	deps := newDeps(&fakeCTLClient{}, emptyBundleStore())
	para := rawJSON(`{
		"uin": "abc",
		"appId": 12345,
		"productCode": "p_lighthouse",
		"payMode": 1,
		"region": 1,
		"resourceIds": ["p1"]
	}`)
	resp := runQueryResource(t, deps, para)
	if resp.ReturnCode != ReturnCodeInvalidPara {
		t.Fatalf("expected ReturnCodeInvalidPara, got %d", resp.ReturnCode)
	}
}

// 12. appId <= 0 → ReturnCodeInvalidPara
func TestQueryResource_ZeroAppID(t *testing.T) {
	deps := newDeps(&fakeCTLClient{}, emptyBundleStore())
	para := rawJSON(`{
		"uin": "100",
		"appId": 0,
		"productCode": "p_lighthouse",
		"payMode": 1,
		"region": 1,
		"resourceIds": ["p1"]
	}`)
	resp := runQueryResource(t, deps, para)
	if resp.ReturnCode != ReturnCodeInvalidPara {
		t.Fatalf("expected ReturnCodeInvalidPara, got %d", resp.ReturnCode)
	}
}

// 13. invalid JSON → ReturnCodeInvalidPara（含 "invalid para json" 提示）
func TestQueryResource_InvalidJSON(t *testing.T) {
	deps := newDeps(&fakeCTLClient{}, emptyBundleStore())
	resp := runQueryResource(t, deps, rawJSON(`{not json`))
	if resp.ReturnCode != ReturnCodeInvalidPara {
		t.Fatalf("expected ReturnCodeInvalidPara, got %d", resp.ReturnCode)
	}
	if !strings.Contains(resp.ReturnMessage, "invalid para json") {
		t.Errorf("message should mention invalid para json, got %q", resp.ReturnMessage)
	}
}

// 14. ctl 返空数组 → resources=[] / total=0（不报错）
func TestQueryResource_EmptyResult(t *testing.T) {
	ctl := &fakeCTLClient{listByResPasses: nil}
	deps := newDeps(ctl, emptyBundleStore())
	resp := runQueryResource(t, deps, stdQueryResourcePara())
	if resp.ReturnCode != 0 {
		t.Fatalf("expected ok, got %d", resp.ReturnCode)
	}
	resources, ok := resp.Data["resources"].([]map[string]interface{})
	if !ok {
		t.Fatalf("resources must be []map[string]interface{}, got %T", resp.Data["resources"])
	}
	if len(resources) != 0 {
		t.Errorf("resources must be empty, got %v", resources)
	}
	if resp.Data["total"].(int64) != 0 {
		t.Errorf("total must be 0, got %v", resp.Data["total"])
	}
}

// 15. bundle 已下架（批量反查时该 bundleID 在结果 map 中缺失）→ 软错，goodsDetail 退化空 map
func TestQueryResource_BundleDefDeleted_GracefulDegrade(t *testing.T) {
	bundleStore := &fakeBundleStore{
		byIDs: map[string]*store.BundleDefinition{}, // 不放任何 def → 批量结果缺失 key
	}
	ctl := &fakeCTLClient{
		listByResPasses: []*ctlclient.PassDetail{
			{PassID: "p1", BundleID: "bundle_gone"},
		},
	}
	deps := newDeps(ctl, bundleStore)
	resp := runQueryResource(t, deps, stdQueryResourcePara())
	if resp.ReturnCode != 0 {
		t.Fatalf("bundle deleted should NOT be a hard error, got %d (%s)", resp.ReturnCode, resp.ReturnMessage)
	}
	resources, _ := resp.Data["resources"].([]map[string]interface{})
	if len(resources) != 1 {
		t.Fatalf("expected 1 resource, got %d", len(resources))
	}
	gd, _ := resources[0]["goodsDetail"].(map[string]interface{})
	if len(gd) != 0 {
		t.Errorf("goodsDetail must be empty (bundle deleted), got %+v", gd)
	}
}

// 16. BundleStore 真异常（非 ErrNotFound）→ ReturnCodeUpstreamUnavailable
func TestQueryResource_BundleStoreHardError(t *testing.T) {
	bundleStore := &fakeBundleStore{
		byIDs:   map[string]*store.BundleDefinition{},
		byIDErr: errors.New("connection refused"),
	}
	ctl := &fakeCTLClient{
		listByResPasses: []*ctlclient.PassDetail{{PassID: "p1", BundleID: "b1"}},
	}
	deps := newDeps(ctl, bundleStore)
	resp := runQueryResource(t, deps, stdQueryResourcePara())
	if resp.ReturnCode != ReturnCodeUpstreamUnavailable {
		t.Fatalf("expected ReturnCodeUpstreamUnavailable, got %d", resp.ReturnCode)
	}
}

// 17. nil pass 元素 → 跳过不 panic
func TestQueryResource_NilPassElement_Skipped(t *testing.T) {
	defA := stdBundleDef("bundle_a")
	bundleStore := &fakeBundleStore{
		byIDs: map[string]*store.BundleDefinition{"bundle_a": defA},
	}
	ctl := &fakeCTLClient{
		listByResPasses: []*ctlclient.PassDetail{
			{PassID: "p1", BundleID: "bundle_a"},
			nil,
		},
	}
	deps := newDeps(ctl, bundleStore)
	resp := runQueryResource(t, deps, stdQueryResourcePara())
	if resp.ReturnCode != 0 {
		t.Fatalf("expected ok, got %d", resp.ReturnCode)
	}
	resources, _ := resp.Data["resources"].([]map[string]interface{})
	if len(resources) != 1 {
		t.Errorf("nil element must be skipped, got %d resources", len(resources))
	}
	// total 也应该是过滤后的 1
	if resp.Data["total"].(int64) != 1 {
		t.Errorf("total must be filtered count (1), got %v", resp.Data["total"])
	}
}
