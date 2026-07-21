package resourcequery

import (
	"context"
	"encoding/json"
	"errors"

	"git.woa.com/wisp/mono/trade/internal/ctlclient"
	"git.woa.com/wisp/mono/trade/internal/httpapi/jifei"
	"git.woa.com/wisp/mono/trade/internal/store"
)

// ---- fake CTLClient ---------------------------------------------------------
//
// fakeCTLClient 实现 ctlclient.Client 接口；只对反查三件套（ListPassAppIDs /
// ListPassesByAppID / ListPassesByResourceIDs）提供可配置返回值，其它 method
// 返 errors.New("not used")，避免误用导致测试静默走错路径。
//
// 字段命名规则：每个反查接口配 (returnValue, err) 两个字段；调用计数 calls* 用于
// 断言 handler 是否如预期短路（不调 ctl）/ 调用次数。

type fakeCTLClient struct {
	// ListPassAppIDs
	listAppIDs           []int64
	listAppTotal         int64
	listAppErr           error
	listAppCalls         int
	listAppLastBundleIDs []string
	listAppLastPageNo    int
	listAppLastPageSize  int

	// ListPassesByAppID
	listByAppPasses        []*ctlclient.PassDetail
	listByAppTotal         int64
	listByAppErr           error
	listByAppCalls         int
	listByAppLastAppID     int64
	listByAppLastBundleIDs []string

	// ListPassesByResourceIDs
	listByResPasses      []*ctlclient.PassDetail
	listByResErr         error
	listByResCalls       int
	listByResLastAppID   int64
	listByResLastPassIDs []string
}

func (f *fakeCTLClient) GetBundleByID(_ context.Context, _ string) (*ctlclient.BundleDetail, error) {
	return nil, errors.New("GetBundleByID not used in resourcequery")
}
func (f *fakeCTLClient) ListPassesByUser(_ context.Context, _ string) ([]*ctlclient.PassDetail, error) {
	return nil, errors.New("ListPassesByUser not used in resourcequery")
}
func (f *fakeCTLClient) CompletePass(_ context.Context, _ *ctlclient.CompletePassRequest) (*ctlclient.PassDetail, error) {
	return nil, errors.New("CompletePass not used in resourcequery")
}
func (f *fakeCTLClient) TransferPass(_ context.Context, _ *ctlclient.TransferPassRequest) (*ctlclient.PassDetail, error) {
	return nil, errors.New("TransferPass not used in resourcequery")
}
func (f *fakeCTLClient) ListPassAppIDs(_ context.Context, bundleIDs []string, pageNo, pageSize int) ([]int64, int64, error) {
	f.listAppCalls++
	f.listAppLastBundleIDs = bundleIDs
	f.listAppLastPageNo = pageNo
	f.listAppLastPageSize = pageSize
	return f.listAppIDs, f.listAppTotal, f.listAppErr
}
func (f *fakeCTLClient) ListPassesByAppID(_ context.Context, appID int64, bundleIDs []string, _, _ int) ([]*ctlclient.PassDetail, int64, error) {
	f.listByAppCalls++
	f.listByAppLastAppID = appID
	f.listByAppLastBundleIDs = bundleIDs
	return f.listByAppPasses, f.listByAppTotal, f.listByAppErr
}
func (f *fakeCTLClient) ListPassesByResourceIDs(_ context.Context, appID int64, passIDs []string) ([]*ctlclient.PassDetail, error) {
	f.listByResCalls++
	f.listByResLastAppID = appID
	f.listByResLastPassIDs = passIDs
	return f.listByResPasses, f.listByResErr
}
func (f *fakeCTLClient) IsolatePass(_ context.Context, _ string, _ *ctlclient.IsolatePassRequest) (*ctlclient.IsolatePassResponse, error) {
	return nil, errors.New("IsolatePass not used in resourcequery tests")
}

func (f *fakeCTLClient) RenewPass(_ context.Context, _ string, _ *ctlclient.RenewPassRequest) (*ctlclient.RenewPassResponse, error) {
	return nil, errors.New("RenewPass not used in resourcequery tests")
}

func (f *fakeCTLClient) DestroyPass(_ context.Context, _ string, _ *ctlclient.DestroyPassRequest) (*ctlclient.DestroyPassResponse, error) {
	return nil, errors.New("DestroyPass not used in resourcequery tests")
}

// ---- fake BundleDefinitionStore --------------------------------------------
//
// fakeBundleStore 实现 store.BundleDefinitionStore 接口。
//
// - GetBundleDefinitionByID：用 byIDs map 反查；map 中不存在 → ErrBundleDefinitionNotFound（除非 byIDErr 显式设置）
// - GetBundleDefinitionsByIDs：用 byIDs map 批量反查；不存在的 key 不在结果 map 中（与真实 MySQLStore 语义一致）；byIDErr 设置时返错
// - ListBundleDefsBySubProductCode：返 listBySub / listBySubErr
type fakeBundleStore struct {
	byIDs    map[string]*store.BundleDefinition
	byIDErr  error // 全局返错（覆盖 byIDs 查找；同时影响单条 / 批量）
	getCalls int

	// 批量调用计数 + 入参快照（用于断言 dedup 结果）
	batchGetCalls int
	lastBatchIDs  []string

	listBySub                   []*store.BundleDefinition
	listBySubErr                error
	listBySubCalls              int
	listBySubLastProductCode    string
	listBySubLastSubProductCode string
}

func (f *fakeBundleStore) GetBundleDefinitionByID(_ context.Context, bundleID string) (*store.BundleDefinition, error) {
	f.getCalls++
	if f.byIDErr != nil {
		return nil, f.byIDErr
	}
	def, ok := f.byIDs[bundleID]
	if !ok {
		return nil, store.ErrBundleDefinitionNotFound
	}
	return def, nil
}

// GetBundleDefinitionsByIDs 批量返回；不存在的 bundleID 不写入结果 map（与真实 SQL `IN(...)` 行为一致）。
func (f *fakeBundleStore) GetBundleDefinitionsByIDs(_ context.Context, bundleIDs []string) (map[string]*store.BundleDefinition, error) {
	f.batchGetCalls++
	// 拷贝入参便于断言（避免调用方持有同一切片做后续修改影响快照）
	f.lastBatchIDs = append([]string(nil), bundleIDs...)
	if f.byIDErr != nil {
		return nil, f.byIDErr
	}
	result := make(map[string]*store.BundleDefinition, len(bundleIDs))
	for _, id := range bundleIDs {
		if def, ok := f.byIDs[id]; ok {
			result[id] = def
		}
		// 不存在 → 不写入 map（调用方按缺失 key 走 graceful-degrade）
	}
	return result, nil
}

func (f *fakeBundleStore) ListBundleDefsBySubProductCode(_ context.Context, productCode, subProductCode string) ([]*store.BundleDefinition, error) {
	f.listBySubCalls++
	f.listBySubLastProductCode = productCode
	f.listBySubLastSubProductCode = subProductCode
	return f.listBySub, f.listBySubErr
}

// ---- 通用 deps 构造器 -------------------------------------------------------

func newDeps(ctl *fakeCTLClient, bundleStore *fakeBundleStore) Deps {
	return Deps{
		CTLClient:   ctl,
		BundleStore: bundleStore,
		Builder:     jifei.NewFrameworkBuilder("trade", "1.0"),
	}
}

// emptyBundleStore 返回一个空的 fake bundle store（byIDs / listBySub 都为 nil）。
func emptyBundleStore() *fakeBundleStore {
	return &fakeBundleStore{byIDs: map[string]*store.BundleDefinition{}}
}

// stdBundleDef 返一个完整的 trade_bundle_definition fixture（含 sv_* 与 productInfo）。
func stdBundleDef(bundleID string) *store.BundleDefinition {
	return &store.BundleDefinition{
		BundleID:       bundleID,
		ProductCode:    "p_lighthouse",
		SubProductCode: "sp_lighthouse_pass",
		Pid:            40000,
		// Q71（2026-05-13）：SVList 强类型 map[string]int64。
		SVList: map[string]int64{
			"sv_cpu": 2,
			"sv_mem": 4,
		},
		ProductInfo: []map[string]interface{}{
			{"name": "套餐内含", "value": "AI Agent"},
		},
	}
}

// rawJSON 是 json.RawMessage 的便捷构造器（消除测试文件里的字符串转换噪音）。
func rawJSON(s string) json.RawMessage { return json.RawMessage(s) }
