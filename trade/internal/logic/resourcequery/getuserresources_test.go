package resourcequery

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"git.woa.com/wisp/mono/trade/internal/ctlclient"
	"git.woa.com/wisp/mono/trade/internal/httpapi/jifei"
	"git.woa.com/wisp/mono/trade/internal/store"
)

func stdUserResourcesPara() json.RawMessage {
	return rawJSON(`{
		"uin": "100012345678",
		"appId": 12345,
		"productCode": "p_lighthouse",
		"subProductCode": "sp_lighthouse_pass",
		"payMode": 1,
		"region": 1,
		"pageNo": 0,
		"pageSize": 1000
	}`)
}

func runGetUserResources(t *testing.T, deps Deps, para json.RawMessage) jifei.Framework {
	t.Helper()
	resp, err := makeGetUserResourcesHandler(deps)(context.Background(), para)
	if err != nil {
		t.Fatalf("handler error: %v", err)
	}
	if resp.ReturnCode != resp.ReturnValue {
		t.Fatalf("Q58 invariant: returnCode=%d returnValue=%d", resp.ReturnCode, resp.ReturnValue)
	}
	return resp
}

// 1. happy-path：sub 解析 → ctl 反查 → BundleStore batch 获取 → 字段映射
func TestGetUserResources_HappyPath(t *testing.T) {
	defA := stdBundleDef("bundle_a")
	defB := stdBundleDef("bundle_b")
	bundleStore := &fakeBundleStore{
		byIDs:     map[string]*store.BundleDefinition{"bundle_a": defA, "bundle_b": defB},
		listBySub: []*store.BundleDefinition{defA, defB},
	}
	created := time.Date(2026, 5, 11, 0, 0, 0, 0, time.UTC)
	expired := time.Date(2027, 5, 11, 0, 0, 0, 0, time.UTC)
	ctl := &fakeCTLClient{
		listByAppPasses: []*ctlclient.PassDetail{
			{PassID: "p1", BundleID: "bundle_a", CreatedTime: created, ExpiredTime: expired, RenewFlag: "AUTO_RENEW"},
			{PassID: "p2", BundleID: "bundle_b", CreatedTime: created, ExpiredTime: expired, RenewFlag: ""},
			{PassID: "p3", BundleID: "bundle_a", CreatedTime: created, ExpiredTime: expired}, // 同 bundle_a，复用 cache
		},
		listByAppTotal: 3,
	}
	deps := newDeps(ctl, bundleStore)

	resp := runGetUserResources(t, deps, stdUserResourcesPara())
	if resp.ReturnCode != 0 {
		t.Fatalf("expected ok, got %d (%s)", resp.ReturnCode, resp.ReturnMessage)
	}
	// ctl 收到的 appID 与 bundle_ids 与入参对齐
	if ctl.listByAppLastAppID != 12345 {
		t.Errorf("ctl appID expected 12345, got %d", ctl.listByAppLastAppID)
	}
	if len(ctl.listByAppLastBundleIDs) != 2 {
		t.Errorf("ctl bundle_ids expected 2 entries, got %v", ctl.listByAppLastBundleIDs)
	}
	// total 透传
	if resp.Data["total"].(int64) != 3 {
		t.Errorf("total mismatch: %v", resp.Data["total"])
	}
	// resources 字段集
	resources, _ := resp.Data["resources"].([]map[string]interface{})
	if len(resources) != 3 {
		t.Fatalf("expected 3 resources, got %d", len(resources))
	}
	// 第 1 条（pass_a）字段断言
	r1 := resources[0]
	if r1["resourceId"] != "p1" {
		t.Errorf("resources[0].resourceId mismatch: %v", r1["resourceId"])
	}
	if r1["uin"] != "100012345678" {
		t.Errorf("uin must be input string, got %v", r1["uin"])
	}
	if r1["appId"] != int64(12345) {
		t.Errorf("appId must be input int64, got %v", r1["appId"])
	}
	if r1["renewFlag"] != 1 {
		t.Errorf("renewFlag AUTO_RENEW must be 1, got %v", r1["renewFlag"])
	}
	// goodsDetail 不为空
	gd, _ := r1["goodsDetail"].(map[string]interface{})
	if gd["pid"] != int64(40000) {
		t.Errorf("goodsDetail.pid mismatch: %v", gd["pid"])
	}
	// batchGetBundleDefs N+1 dedup 验证：3 条 pass 但只有 2 个不同 bundleID
	// → 一次 batch SQL 调用，去重后 IDs = [bundle_a, bundle_b]
	if bundleStore.batchGetCalls != 1 {
		t.Errorf("expected 1 GetBundleDefinitionsByIDs call (single batch), got %d", bundleStore.batchGetCalls)
	}
	gotSet := make(map[string]bool, len(bundleStore.lastBatchIDs))
	for _, id := range bundleStore.lastBatchIDs {
		gotSet[id] = true
	}
	if len(bundleStore.lastBatchIDs) != 2 || !gotSet["bundle_a"] || !gotSet["bundle_b"] {
		t.Errorf("expected batch IDs to dedup to {bundle_a, bundle_b}, got %v", bundleStore.lastBatchIDs)
	}
}

// 2. uin 缺失 → ReturnCodeInvalidPara
func TestGetUserResources_MissingUin(t *testing.T) {
	deps := newDeps(&fakeCTLClient{}, emptyBundleStore())
	para := rawJSON(`{"appId":12345,"productCode":"p_lighthouse","payMode":1,"region":1,"pageNo":0,"pageSize":1000}`)
	resp := runGetUserResources(t, deps, para)
	if resp.ReturnCode != ReturnCodeInvalidPara {
		t.Fatalf("expected ReturnCodeInvalidPara, got %d", resp.ReturnCode)
	}
	if !strings.Contains(resp.ReturnMessage, "uin") {
		t.Errorf("message should mention uin, got %q", resp.ReturnMessage)
	}
}

// 3. uin 非数字字符串 → ReturnCodeInvalidPara
func TestGetUserResources_NonNumericUin(t *testing.T) {
	deps := newDeps(&fakeCTLClient{}, emptyBundleStore())
	para := rawJSON(`{
		"uin": "abc",
		"appId": 12345,
		"productCode": "p_lighthouse",
		"payMode": 1,
		"region": 1,
		"pageNo": 0,
		"pageSize": 1000
	}`)
	resp := runGetUserResources(t, deps, para)
	if resp.ReturnCode != ReturnCodeInvalidPara {
		t.Fatalf("expected ReturnCodeInvalidPara, got %d", resp.ReturnCode)
	}
}

// 4. appId <= 0 → ReturnCodeInvalidPara
func TestGetUserResources_ZeroAppID(t *testing.T) {
	deps := newDeps(&fakeCTLClient{}, emptyBundleStore())
	para := rawJSON(`{
		"uin": "100",
		"appId": 0,
		"productCode": "p_lighthouse",
		"payMode": 1,
		"region": 1,
		"pageNo": 0,
		"pageSize": 1000
	}`)
	resp := runGetUserResources(t, deps, para)
	if resp.ReturnCode != ReturnCodeInvalidPara {
		t.Fatalf("expected ReturnCodeInvalidPara, got %d", resp.ReturnCode)
	}
}

// 5. payMode != 1 → 短路返空，不调 ctl
func TestGetUserResources_PayModeNotPrepay_ReturnsEmpty(t *testing.T) {
	ctl := &fakeCTLClient{}
	deps := newDeps(ctl, emptyBundleStore())
	para := rawJSON(`{
		"uin": "100",
		"appId": 12345,
		"productCode": "p_lighthouse",
		"payMode": 0,
		"region": 1,
		"pageNo": 0,
		"pageSize": 1000
	}`)
	resp := runGetUserResources(t, deps, para)
	if resp.ReturnCode != 0 {
		t.Fatalf("expected ok, got %d", resp.ReturnCode)
	}
	if ctl.listByAppCalls != 0 {
		t.Errorf("ctl must NOT be called, got %d calls", ctl.listByAppCalls)
	}
	resources, _ := resp.Data["resources"].([]map[string]interface{})
	if len(resources) != 0 {
		t.Errorf("expected empty resources, got %v", resources)
	}
}

// 6. ctl 调用失败 → ReturnCodeUpstreamUnavailable
func TestGetUserResources_CTLError(t *testing.T) {
	bundleStore := emptyBundleStore()
	bundleStore.listBySub = []*store.BundleDefinition{{BundleID: "b1"}}
	ctl := &fakeCTLClient{listByAppErr: errors.New("ctl 503")}
	deps := newDeps(ctl, bundleStore)
	resp := runGetUserResources(t, deps, stdUserResourcesPara())
	if resp.ReturnCode != ReturnCodeUpstreamUnavailable {
		t.Fatalf("expected ReturnCodeUpstreamUnavailable, got %d", resp.ReturnCode)
	}
}

// 7. bundle 已下架（批量反查时 bundle_b 在结果 map 中缺失）→
//    handler 不报错，对应 pass 的 goodsDetail 退化为空 map
func TestGetUserResources_BundleDefDeleted_GracefulDegrade(t *testing.T) {
	defA := stdBundleDef("bundle_a")
	bundleStore := &fakeBundleStore{
		byIDs:     map[string]*store.BundleDefinition{"bundle_a": defA}, // bundle_b 不存在 → ErrNotFound
		listBySub: []*store.BundleDefinition{defA, {BundleID: "bundle_b"}},
	}
	ctl := &fakeCTLClient{
		listByAppPasses: []*ctlclient.PassDetail{
			{PassID: "p1", BundleID: "bundle_a"},
			{PassID: "p2", BundleID: "bundle_b"},
		},
		listByAppTotal: 2,
	}
	deps := newDeps(ctl, bundleStore)
	resp := runGetUserResources(t, deps, stdUserResourcesPara())
	if resp.ReturnCode != 0 {
		t.Fatalf("bundle deleted should NOT be a hard error, got %d (%s)", resp.ReturnCode, resp.ReturnMessage)
	}
	resources, _ := resp.Data["resources"].([]map[string]interface{})
	if len(resources) != 2 {
		t.Fatalf("expected 2 resources, got %d", len(resources))
	}
	// p1 的 goodsDetail 完整；p2 退化空（bundle 下架）
	gd1, _ := resources[0]["goodsDetail"].(map[string]interface{})
	if gd1["pid"] != int64(40000) {
		t.Errorf("p1 goodsDetail.pid mismatch: %v", gd1["pid"])
	}
	gd2, _ := resources[1]["goodsDetail"].(map[string]interface{})
	if len(gd2) != 0 {
		t.Errorf("p2 goodsDetail should be empty (bundle deleted), got %+v", gd2)
	}
}

// 8. BundleStore 真异常（非 ErrNotFound）→ batch 反查终止 → ReturnCodeUpstreamUnavailable
func TestGetUserResources_BundleStoreHardError(t *testing.T) {
	bundleStore := &fakeBundleStore{
		byIDs:     map[string]*store.BundleDefinition{},
		byIDErr:   errors.New("connection refused"),
		listBySub: []*store.BundleDefinition{{BundleID: "b1"}},
	}
	ctl := &fakeCTLClient{
		listByAppPasses: []*ctlclient.PassDetail{{PassID: "p1", BundleID: "b1"}},
		listByAppTotal:  1,
	}
	deps := newDeps(ctl, bundleStore)
	resp := runGetUserResources(t, deps, stdUserResourcesPara())
	if resp.ReturnCode != ReturnCodeUpstreamUnavailable {
		t.Fatalf("expected ReturnCodeUpstreamUnavailable, got %d", resp.ReturnCode)
	}
}

// 9. ctl 返空数组 → resources=[] / total=0（不报错）
func TestGetUserResources_EmptyResult(t *testing.T) {
	bundleStore := emptyBundleStore()
	bundleStore.listBySub = []*store.BundleDefinition{{BundleID: "b1"}}
	ctl := &fakeCTLClient{listByAppPasses: nil, listByAppTotal: 0}
	deps := newDeps(ctl, bundleStore)
	resp := runGetUserResources(t, deps, stdUserResourcesPara())
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
}

// 10. nil pass 元素 → 跳过不 panic（防御 ctl 异常返回 nil 元素）
func TestGetUserResources_NilPassElement_Skipped(t *testing.T) {
	defA := stdBundleDef("bundle_a")
	bundleStore := &fakeBundleStore{
		byIDs:     map[string]*store.BundleDefinition{"bundle_a": defA},
		listBySub: []*store.BundleDefinition{defA},
	}
	ctl := &fakeCTLClient{
		listByAppPasses: []*ctlclient.PassDetail{
			{PassID: "p1", BundleID: "bundle_a"},
			nil, // 防御性元素
		},
		listByAppTotal: 1,
	}
	deps := newDeps(ctl, bundleStore)
	resp := runGetUserResources(t, deps, stdUserResourcesPara())
	if resp.ReturnCode != 0 {
		t.Fatalf("expected ok, got %d", resp.ReturnCode)
	}
	resources, _ := resp.Data["resources"].([]map[string]interface{})
	if len(resources) != 1 {
		t.Errorf("nil element must be skipped, got %d resources", len(resources))
	}
}
