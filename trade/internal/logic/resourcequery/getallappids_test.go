package resourcequery

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"git.woa.com/wisp/mono/trade/internal/httpapi/jifei"
	"git.woa.com/wisp/mono/trade/internal/store"
)

// stdAppIDsPara 是默认 happy-path 的 getAllAppIds 入参（subProductCode 非空，需 ListBundleDefsBySubProductCode）。
func stdAppIDsPara() json.RawMessage {
	return rawJSON(`{
		"productCode": "p_lighthouse",
		"subProductCode": "sp_lighthouse_pass",
		"payMode": 1,
		"region": 1,
		"pageNo": 0,
		"pageSize": 20000
	}`)
}

func runGetAllAppIDs(t *testing.T, deps Deps, para json.RawMessage) jifei.Framework {
	t.Helper()
	resp, err := makeGetAllAppIDsHandler(deps)(context.Background(), para)
	if err != nil {
		t.Fatalf("handler returned error: %v", err)
	}
	if resp.ReturnCode != resp.ReturnValue {
		t.Fatalf("Q58 invariant: returnCode=%d returnValue=%d", resp.ReturnCode, resp.ReturnValue)
	}
	return resp
}

// 1. happy-path：subProductCode 解析为 bundle_ids → ctl 返回 [10001, 10002] / total=42
func TestGetAllAppIDs_HappyPath(t *testing.T) {
	bundleStore := emptyBundleStore()
	bundleStore.listBySub = []*store.BundleDefinition{
		{BundleID: "bundle_a", ProductCode: "p_lighthouse", SubProductCode: "sp_lighthouse_pass"},
		{BundleID: "bundle_b", ProductCode: "p_lighthouse", SubProductCode: "sp_lighthouse_pass"},
	}
	ctl := &fakeCTLClient{
		listAppIDs:   []int64{10001, 10002},
		listAppTotal: 42,
	}
	deps := newDeps(ctl, bundleStore)

	resp := runGetAllAppIDs(t, deps, stdAppIDsPara())
	if resp.ReturnCode != 0 {
		t.Fatalf("expected returnCode=0, got %d (%s)", resp.ReturnCode, resp.ReturnMessage)
	}
	// 校验 ctl 收到的 bundle_ids 是从 bundleStore 解析出来的
	if len(ctl.listAppLastBundleIDs) != 2 ||
		ctl.listAppLastBundleIDs[0] != "bundle_a" ||
		ctl.listAppLastBundleIDs[1] != "bundle_b" {
		t.Errorf("ctl bundle_ids must be resolved from bundleStore, got %v", ctl.listAppLastBundleIDs)
	}
	// 校验 listBySub 透传 (productCode, subProductCode)
	if bundleStore.listBySubLastProductCode != "p_lighthouse" ||
		bundleStore.listBySubLastSubProductCode != "sp_lighthouse_pass" {
		t.Errorf("ListBundleDefsBySubProductCode args mismatch")
	}
	// data 字段
	if resp.Data["total"].(int64) != 42 {
		t.Errorf("total mismatch: %v", resp.Data["total"])
	}
	appIDs, _ := resp.Data["appIds"].([]int64)
	if len(appIDs) != 2 || appIDs[0] != 10001 || appIDs[1] != 10002 {
		t.Errorf("appIds mismatch: %v", appIDs)
	}
}

// 2. subProductCode 空 → trade 不解析 bundle_ids，ctl 收到 nil/空（Q2 拍板）
func TestGetAllAppIDs_NoSubProductCode(t *testing.T) {
	bundleStore := emptyBundleStore()
	ctl := &fakeCTLClient{listAppIDs: []int64{1, 2}, listAppTotal: 2}
	deps := newDeps(ctl, bundleStore)

	para := rawJSON(`{
		"productCode": "p_lighthouse",
		"payMode": 1,
		"region": 1,
		"pageNo": 0,
		"pageSize": 1000
	}`)
	resp := runGetAllAppIDs(t, deps, para)
	if resp.ReturnCode != 0 {
		t.Fatalf("expected ok, got %d", resp.ReturnCode)
	}
	if bundleStore.listBySubCalls != 0 {
		t.Errorf("expected zero ListBundleDefsBySubProductCode calls, got %d", bundleStore.listBySubCalls)
	}
	if len(ctl.listAppLastBundleIDs) != 0 {
		t.Errorf("expected empty bundle_ids, got %v", ctl.listAppLastBundleIDs)
	}
}

// 3. payMode != 1 → 短路返空（PDF §1.1：returnCode=0 + 空数组）
func TestGetAllAppIDs_PayModeNotPrepay_ReturnsEmpty(t *testing.T) {
	ctl := &fakeCTLClient{}
	deps := newDeps(ctl, emptyBundleStore())

	para := rawJSON(`{
		"productCode": "p_lighthouse",
		"subProductCode": "sp_lighthouse_pass",
		"payMode": 0,
		"region": 1,
		"pageNo": 0,
		"pageSize": 1000
	}`)
	resp := runGetAllAppIDs(t, deps, para)
	if resp.ReturnCode != 0 {
		t.Fatalf("payMode!=1 must still return returnCode=0, got %d", resp.ReturnCode)
	}
	if resp.Data["total"].(int64) != 0 {
		t.Errorf("total must be 0, got %v", resp.Data["total"])
	}
	appIDs, _ := resp.Data["appIds"].([]int64)
	if len(appIDs) != 0 {
		t.Errorf("appIds must be empty, got %v", appIDs)
	}
	// 关键：不应调用 ctl
	if ctl.listAppCalls != 0 {
		t.Errorf("ctl must NOT be called when payMode invalid; calls=%d", ctl.listAppCalls)
	}
}

// 4. subProductCode 非空但 bundleStore 返空列表 → 短路返空，不打 ctl
func TestGetAllAppIDs_SubProductCodeResolvesEmpty_ShortCircuit(t *testing.T) {
	bundleStore := emptyBundleStore() // listBySub=nil
	ctl := &fakeCTLClient{}
	deps := newDeps(ctl, bundleStore)

	resp := runGetAllAppIDs(t, deps, stdAppIDsPara())
	if resp.ReturnCode != 0 {
		t.Fatalf("expected ok, got %d", resp.ReturnCode)
	}
	if ctl.listAppCalls != 0 {
		t.Errorf("ctl must NOT be called when sub resolves to empty; calls=%d", ctl.listAppCalls)
	}
}

// 5. ctl 返 error → ReturnCodeUpstreamUnavailable
func TestGetAllAppIDs_CTLError(t *testing.T) {
	bundleStore := emptyBundleStore()
	bundleStore.listBySub = []*store.BundleDefinition{{BundleID: "b1"}}
	ctl := &fakeCTLClient{listAppErr: errors.New("ctl 503")}
	deps := newDeps(ctl, bundleStore)

	resp := runGetAllAppIDs(t, deps, stdAppIDsPara())
	if resp.ReturnCode != ReturnCodeUpstreamUnavailable {
		t.Fatalf("expected ReturnCodeUpstreamUnavailable=%d, got %d", ReturnCodeUpstreamUnavailable, resp.ReturnCode)
	}
}

// 6. BundleStore 异常（非空 sub + DB 异常）→ ReturnCodeUpstreamUnavailable
func TestGetAllAppIDs_BundleStoreError(t *testing.T) {
	bundleStore := emptyBundleStore()
	bundleStore.listBySubErr = errors.New("connection refused")
	ctl := &fakeCTLClient{}
	deps := newDeps(ctl, bundleStore)

	resp := runGetAllAppIDs(t, deps, stdAppIDsPara())
	if resp.ReturnCode != ReturnCodeUpstreamUnavailable {
		t.Fatalf("expected ReturnCodeUpstreamUnavailable, got %d", resp.ReturnCode)
	}
	if !strings.Contains(resp.ReturnMessage, "bundle_ids") {
		t.Errorf("error message should mention bundle_ids, got %q", resp.ReturnMessage)
	}
}

// 7. JSON 格式错 → ReturnCodeInvalidPara
func TestGetAllAppIDs_InvalidJSON(t *testing.T) {
	deps := newDeps(&fakeCTLClient{}, emptyBundleStore())
	resp := runGetAllAppIDs(t, deps, rawJSON(`{not-json`))
	if resp.ReturnCode != ReturnCodeInvalidPara {
		t.Fatalf("expected ReturnCodeInvalidPara, got %d", resp.ReturnCode)
	}
}

// 8. productCode 缺失 → ReturnCodeInvalidPara
func TestGetAllAppIDs_MissingProductCode(t *testing.T) {
	deps := newDeps(&fakeCTLClient{}, emptyBundleStore())
	para := rawJSON(`{"payMode":1,"region":1,"pageNo":0,"pageSize":1000}`)
	resp := runGetAllAppIDs(t, deps, para)
	if resp.ReturnCode != ReturnCodeInvalidPara {
		t.Fatalf("expected ReturnCodeInvalidPara, got %d", resp.ReturnCode)
	}
	if !strings.Contains(resp.ReturnMessage, "productCode") {
		t.Errorf("message should mention productCode, got %q", resp.ReturnMessage)
	}
}

// 9. pageSize 超 20000 上限 → ReturnCodeInvalidPara
func TestGetAllAppIDs_PageSizeOverLimit(t *testing.T) {
	deps := newDeps(&fakeCTLClient{}, emptyBundleStore())
	para := rawJSON(`{
		"productCode": "p_lighthouse",
		"payMode": 1,
		"region": 1,
		"pageNo": 0,
		"pageSize": 30000
	}`)
	resp := runGetAllAppIDs(t, deps, para)
	if resp.ReturnCode != ReturnCodeInvalidPara {
		t.Fatalf("expected ReturnCodeInvalidPara, got %d", resp.ReturnCode)
	}
}

// 10. pageNo 负数 → ReturnCodeInvalidPara
func TestGetAllAppIDs_NegativePageNo(t *testing.T) {
	deps := newDeps(&fakeCTLClient{}, emptyBundleStore())
	para := rawJSON(`{"productCode":"p_lighthouse","payMode":1,"region":1,"pageNo":-1,"pageSize":1000}`)
	resp := runGetAllAppIDs(t, deps, para)
	if resp.ReturnCode != ReturnCodeInvalidPara {
		t.Fatalf("expected ReturnCodeInvalidPara, got %d", resp.ReturnCode)
	}
}

// 11. ctl 返 nil appIDs → 归一化为空数组（不返 null，PDF 严格要求）
func TestGetAllAppIDs_CTLReturnsNilAppIDs_NormalizesToEmpty(t *testing.T) {
	bundleStore := emptyBundleStore()
	bundleStore.listBySub = []*store.BundleDefinition{{BundleID: "b1"}}
	ctl := &fakeCTLClient{listAppIDs: nil, listAppTotal: 0}
	deps := newDeps(ctl, bundleStore)

	resp := runGetAllAppIDs(t, deps, stdAppIDsPara())
	if resp.ReturnCode != 0 {
		t.Fatalf("expected ok, got %d", resp.ReturnCode)
	}
	appIDs, ok := resp.Data["appIds"].([]int64)
	if !ok {
		t.Fatalf("appIds must be []int64, got %T", resp.Data["appIds"])
	}
	if appIDs == nil {
		t.Errorf("appIds must NOT be nil (jifei rejects null), got nil")
	}
	if len(appIDs) != 0 {
		t.Errorf("appIds must be empty, got %v", appIDs)
	}
}
