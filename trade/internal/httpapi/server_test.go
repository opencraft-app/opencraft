package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"git.woa.com/wisp/mono/trade/internal/ctlclient"
	"git.woa.com/wisp/mono/trade/internal/store"
)

func init() {
	gin.SetMode(gin.TestMode)
}

// ---- 测试用 fake 依赖 ---------------------------------------------------------
//
// 迭代 5 起 NewRouter 强制非 nil OrderStore / BundleStore / CTLClient；
// 迭代 6 起追加 FlowStore 必填（OrderUpdater 仍允许 nil，迭代 8 接线）。
// router 层测试只关心 routing / framework invariants，不关心业务结果，
// 因此 fake 全部返"trade_order not found"让 handler 走最早的失败分支即可，
// 这样既不需要构造完整 happy-path 数据，又能命中真 handler 验证 routing 通畅。

type fakeOrderStoreNotFound struct{}

func (fakeOrderStoreNotFound) GetOrderByDealName(_ context.Context, _ string) (*store.TradeOrder, error) {
	return nil, store.ErrTradeOrderNotFound
}

type fakeBundleDefStoreUnused struct{}

func (fakeBundleDefStoreUnused) GetBundleDefinitionByID(_ context.Context, _ string) (*store.BundleDefinition, error) {
	return nil, errors.New("bundle_def store not exercised in router test")
}
func (fakeBundleDefStoreUnused) ListBundleDefsBySubProductCode(_ context.Context, _, _ string) ([]*store.BundleDefinition, error) {
	return nil, errors.New("bundle_def store not exercised in router test")
}
func (fakeBundleDefStoreUnused) GetBundleDefinitionsByIDs(_ context.Context, _ []string) (map[string]*store.BundleDefinition, error) {
	return nil, errors.New("bundle_def store not exercised in router test")
}

type fakeCTLClientUnused struct{}

func (fakeCTLClientUnused) GetBundleByID(_ context.Context, _ string) (*ctlclient.BundleDetail, error) {
	return nil, errors.New("ctl client not exercised in router test")
}
func (fakeCTLClientUnused) ListPassesByUser(_ context.Context, _ string) ([]*ctlclient.PassDetail, error) {
	return nil, errors.New("ctl client not exercised in router test")
}
func (fakeCTLClientUnused) CompletePass(_ context.Context, _ *ctlclient.CompletePassRequest) (*ctlclient.PassDetail, error) {
	return nil, errors.New("ctl client not exercised in router test")
}
func (fakeCTLClientUnused) TransferPass(_ context.Context, _ *ctlclient.TransferPassRequest) (*ctlclient.PassDetail, error) {
	return nil, errors.New("ctl client not exercised in router test")
}
func (fakeCTLClientUnused) ListPassAppIDs(_ context.Context, _ []string, _, _ int) ([]int64, int64, error) {
	return nil, 0, errors.New("ctl client not exercised in router test")
}
func (fakeCTLClientUnused) ListPassesByAppID(_ context.Context, _ int64, _ []string, _, _ int) ([]*ctlclient.PassDetail, int64, error) {
	return nil, 0, errors.New("ctl client not exercised in router test")
}
func (fakeCTLClientUnused) ListPassesByResourceIDs(_ context.Context, _ int64, _ []string) ([]*ctlclient.PassDetail, error) {
	return nil, errors.New("ctl client not exercised in router test")
}
func (fakeCTLClientUnused) IsolatePass(_ context.Context, _ string, _ *ctlclient.IsolatePassRequest) (*ctlclient.IsolatePassResponse, error) {
	return nil, errors.New("ctl client not exercised in router test")
}

func (fakeCTLClientUnused) RenewPass(_ context.Context, _ string, _ *ctlclient.RenewPassRequest) (*ctlclient.RenewPassResponse, error) {
	return nil, errors.New("ctl client not exercised in router test")
}

func (fakeCTLClientUnused) DestroyPass(_ context.Context, _ string, _ *ctlclient.DestroyPassRequest) (*ctlclient.DestroyPassResponse, error) {
	return nil, errors.New("ctl client not exercised in router test")
}

// fakeFlowStoreAcquireWins 总是返 acquired=true 让 createResource handler 进入主链路；
// 主链路第一步会撞 OrderStore 反查 not found，从而以 ReturnCodeOrderNotFound=600202 退出。
//
// 与 checkCreate 路径分开断言：checkCreate handler 的 OrderNotFound code 是 600101，
// createResource handler 的 OrderNotFound code 是 600202，路由互不串扰。
type fakeFlowStoreAcquireWins struct{}

func (fakeFlowStoreAcquireWins) TryAcquireSlot(_ context.Context, _, _, _ string, _ []byte) (bool, *store.Flow, error) {
	return true, nil, nil
}
func (fakeFlowStoreAcquireWins) MarkCompletedWithResourceID(_ context.Context, _, _, _, _ string, _ []byte) error {
	return nil
}

func (fakeFlowStoreAcquireWins) MarkCompleted(_ context.Context, _, _, _ string, _ []byte) error {
	return nil
}
func (fakeFlowStoreAcquireWins) MarkFailed(_ context.Context, _, _, _ string, _ []byte) error {
	return nil
}
func (fakeFlowStoreAcquireWins) GetFlow(_ context.Context, _, _, _ string) (*store.Flow, error) {
	return nil, store.ErrFlowNotFound
}
func (fakeFlowStoreAcquireWins) ListInProgressBefore(_ context.Context, _ time.Time, _ int) ([]*store.Flow, error) {
	return nil, nil
}

// Sub-4 新增方法 — router 测试不行使 isolate 链路。
func (fakeFlowStoreAcquireWins) TryAcquireSlotForIsolate(_ context.Context, _, _, _, _ string, _ []byte, _ *string) (bool, *store.Flow, error) {
	return false, nil, errors.New("not used in router test")
}
func (fakeFlowStoreAcquireWins) MarkCompletedByID(_ context.Context, _ int64, _ []byte) error {
	return errors.New("not used in router test")
}
func (fakeFlowStoreAcquireWins) MarkFailedByID(_ context.Context, _ int64, _ []byte) error {
	return errors.New("not used in router test")
}
func (fakeFlowStoreAcquireWins) DeleteByID(_ context.Context, _ int64) error {
	return errors.New("not used in router test")
}
func (fakeFlowStoreAcquireWins) GetByID(_ context.Context, _ int64) (*store.Flow, error) {
	return nil, store.ErrFlowNotFound
}

func newTestRouter() *gin.Engine {
	return NewRouter(ServerConfig{
		InternalServiceToken:    "test-token",
		JifeiComponentName:      "trade",
		JifeiProtocolVersion:    "1.0",
		JifeiOurInterfacePrefix: "lightvela",
		OrderStore:              fakeOrderStoreNotFound{},
		BundleStore:             fakeBundleDefStoreUnused{},
		CTLClient:               fakeCTLClientUnused{},
		FlowStore:               fakeFlowStoreAcquireWins{},
		// OrderUpdater 留 nil — createResource handler 主链路允许 OrderUpdater nil（迭代 8 接线）。
	})
}

func TestNewRouter_Healthz(t *testing.T) {
	r := newTestRouter()
	req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rec.Code)
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}
	if body["status"] != "ok" {
		t.Errorf("expected status=ok, got %+v", body)
	}
}

// 迭代 5 起 checkCreate 是真 handler；router 测试构造一个会让 handler 在 ctl/bundle
// 反查就 upstream-error 退出的请求 — 验证：
//
//  1. routing 命中（不再是 stub 的 ReturnCodeNotImplemented=501001）
//  2. handler 真的拿到 para 并按业务码返 ReturnCodeUpstreamUnavailable=600107
//     （fakeCTLClientUnused.GetBundleByID 返 error）
//  3. HTTP 200 + Q58 returnCode == returnValue 不变量
//  4. 不返退款魔法值 352014（Q56 不变量）
//
// v1.7.28 BUG-07 修订：
//   - 顶层移除 dealName/bundleId 顶层字段（PDF §1.1：jifei 不发 dealName；jifei 协议
//     无 bundleId）
//   - bundleId 移到 goodsDetail（trade 出向时塞）
//   - 顶层补 PDF 必填的 appId/uin
func TestNewRouter_JifeiCallback_CheckCreateRoutedToRealHandler(t *testing.T) {
	r := newTestRouter()
	body := `{
        "seqId": "seq-int",
        "interface": {
          "interfaceName": "lightvela.pass.checkCreate",
          "para": {
            "appId": 1,
            "uin": "u",
            "goodsDetail": {"bundleId":"bx","pid":40000,"timeSpan":1,"timeUnit":"m","goodsNum":1,"payMode":1}
          }
        }
    }`
	req := httptest.NewRequest(http.MethodPost, "/trade/jifei/callback", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("expected HTTP 200, got %d", rec.Code)
	}
	var resp map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("invalid framework JSON: %v", err)
	}

	rc, _ := resp["returnCode"].(float64)
	rv, _ := resp["returnValue"].(float64)
	if int(rc) != int(rv) {
		t.Errorf("Q58 invariant: returnCode==returnValue must hold; got %v / %v", rc, rv)
	}
	if int(rc) == 352014 {
		t.Errorf("checkCreate must NEVER return refund magic 352014; got returnCode=%v", rc)
	}
	// 600107 = checkcreate.ReturnCodeUpstreamUnavailable
	// (fakeCTLClientUnused.GetBundleByID 返 error → ctl/bundle 反查 upstream 错)
	if int(rc) != 600107 {
		t.Errorf("expected business returnCode 600107 (UpstreamUnavailable), got %v (msg=%v)", rc, resp["returnMessage"])
	}
}

// R-C-7：验证 checkRenew 真 handler 已经接线到 dispatcher。
//
// 构造一个让 handler 在最早的失败分支退出的请求 — fakeCTLClientUnused.ListPassesByResourceIDs
// 返 error，handler 内部调 ctl.ListPassesByResourceIDs(appID, [resourceID]) 反查 pass 时
// 会触发 internal error，handler 按业务码返 600406 (ReturnCodeInternalError) 退出。
//
// 验证：
//  1. routing 命中（不再是 stub 的 ReturnCodeNotImplemented=501001）
//  2. handler 真的拿到 para 并按业务码返 600406（checkrenew.ReturnCodeInternalError）
//  3. HTTP 200 + Q58 returnCode == returnValue 不变量
//  4. 不返退款魔法值 352014（Q56 不变量）
func TestNewRouter_JifeiCallback_CheckRenewRoutedToRealHandler(t *testing.T) {
	r := newTestRouter()
	body := `{
        "seqId": "seq-renew-1",
        "interface": {
          "interfaceName": "lightvela.pass.checkRenew",
          "para": {
            "appId": 10001,
            "uin": "1000123456",
            "payMode": 1,
            "resourceId": "lhpass-r1",
            "goodsDetail": {
              "pid": "1234",
              "timeSpan": 1,
              "timeUnit": "m",
              "goodsNum": 1,
              "payMode": 1,
              "curDeadline": "2026-06-15 00:00:00"
            }
          }
        }
    }`
	req := httptest.NewRequest(http.MethodPost, "/trade/jifei/callback", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("expected HTTP 200, got %d", rec.Code)
	}
	var resp map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("invalid framework JSON: %v", err)
	}
	rc, _ := resp["returnCode"].(float64)
	rv, _ := resp["returnValue"].(float64)
	if int(rc) != int(rv) {
		t.Errorf("Q58 invariant: returnCode==returnValue must hold; got %v / %v", rc, rv)
	}
	if int(rc) == 352014 {
		t.Errorf("checkRenew must NEVER return refund magic 352014; got returnCode=%v", rc)
	}
	// 600406 = checkrenew.ReturnCodeInternalError（ctl ListPassesByResourceIDs 失败路径）
	if int(rc) != 600406 {
		t.Errorf("expected business returnCode 600406 (InternalError), got %v (msg=%v)", rc, resp["returnMessage"])
	}
}

// R-C-7：验证 renewResource 真 handler 已经接线到 dispatcher。
//
// 构造一个让 handler 走"trade_flow 抢占成功 → trade_order 反查 not found"路径的请求：
// fakeFlowStoreAcquireWins.TryAcquireSlot 返 acquired=true，主链路推进到
// fakeOrderStoreNotFound.GetOrderByDealName 返 ErrTradeOrderNotFound 时，
// **v1.7.28 BUG-25 修订（2026-05-21）** 后 handler 已脱离 trade_order 反查依赖，
// 不再返 600502 (ReturnCodeOrderNotFound)；trade_order 找不到不阻塞主链路，
// 直接走 ctl.RenewPass。本测试 fakeCTL 未 mock 返 600504 (ReturnCodeUpstreamUnavailable)，
// 仍能验证 dispatcher 路由到 renewresource 真 handler（且不返 refund 魔数）。
//
// 与 checkCreate (600101) / createResource (600202) / checkRenew (600406) 的码段错开 —
// 验证 dispatcher 路由互不串扰。
func TestNewRouter_JifeiCallback_RenewResourceRoutedToRealHandler(t *testing.T) {
	r := newTestRouter()
	body := `{
        "seqId": "seq-renew-2",
        "interface": {
          "interfaceName": "lightvela.pass.renewResource",
          "para": {
            "dealName": "deal-not-in-db",
            "appId": 10001,
            "uin": "1000123456",
            "resourceId": "lhpass-r1",
            "goodsNum": 1,
            "goodsDetail": {
              "pid": "1234",
              "timeSpan": 1,
              "timeUnit": "m",
              "goodsNum": 1,
              "payMode": 1
            }
          }
        }
    }`
	req := httptest.NewRequest(http.MethodPost, "/trade/jifei/callback", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("expected HTTP 200, got %d", rec.Code)
	}
	var resp map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("invalid framework JSON: %v", err)
	}
	rc, _ := resp["returnCode"].(float64)
	rv, _ := resp["returnValue"].(float64)
	if int(rc) != int(rv) {
		t.Errorf("Q58 invariant: returnCode==returnValue must hold; got %v / %v", rc, rv)
	}
	if int(rc) == 352014 {
		t.Errorf("renewResource must NEVER return refund magic 352014 from this path; got returnCode=%v", rc)
	}
	// 600504 = renewresource.ReturnCodeUpstreamUnavailable（BUG-25 修订后 OrderNotFound 不阻塞主链路，
	// fake ctl 未 mock RenewPass 走到 ctl 失败分支返 600504）；与 checkCreate/createResource/
	// checkRenew 码段错开，验证路由到 renewresource 真 handler。
	if int(rc) != 600504 {
		t.Errorf("expected business returnCode 600504 (UpstreamUnavailable, BUG-25 fallthrough), got %v (msg=%v)", rc, resp["returnMessage"])
	}
}

func TestNewRouter_JifeiCallback_RoutingErrorReturnsFrameworkError(t *testing.T) {
	r := newTestRouter()
	// 不合法 prefix
	body := `{"interface": {"interfaceName": "qcloud.pass.checkCreate"}}`
	req := httptest.NewRequest(http.MethodPost, "/trade/jifei/callback", bytes.NewBufferString(body))
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("expected HTTP 200 even for protocol error, got %d", rec.Code)
	}
	var resp map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &resp)
	// 必须不是 352014（防误退款）
	if rc, _ := resp["returnCode"].(float64); int(rc) == 352014 {
		t.Errorf("PROTOCOL error should NEVER return refund magic 352014")
	}
}

// 迭代 5 起 NewRouter 强制三个业务依赖非 nil；迭代 6 追加 FlowStore — 验证 panic 行为：
// nil 任一字段必然 panic（启动期暴露配置错而不是延迟到第一个请求）。
func TestNewRouter_NilDeps_Panics(t *testing.T) {
	cases := []struct {
		name string
		cfg  ServerConfig
	}{
		{"order_store_nil", ServerConfig{
			JifeiComponentName: "trade", JifeiProtocolVersion: "1.0", JifeiOurInterfacePrefix: "lightvela",
			OrderStore: nil, BundleStore: fakeBundleDefStoreUnused{}, CTLClient: fakeCTLClientUnused{}, FlowStore: fakeFlowStoreAcquireWins{},
		}},
		{"bundle_store_nil", ServerConfig{
			JifeiComponentName: "trade", JifeiProtocolVersion: "1.0", JifeiOurInterfacePrefix: "lightvela",
			OrderStore: fakeOrderStoreNotFound{}, BundleStore: nil, CTLClient: fakeCTLClientUnused{}, FlowStore: fakeFlowStoreAcquireWins{},
		}},
		{"ctl_client_nil", ServerConfig{
			JifeiComponentName: "trade", JifeiProtocolVersion: "1.0", JifeiOurInterfacePrefix: "lightvela",
			OrderStore: fakeOrderStoreNotFound{}, BundleStore: fakeBundleDefStoreUnused{}, CTLClient: nil, FlowStore: fakeFlowStoreAcquireWins{},
		}},
		{"flow_store_nil", ServerConfig{
			JifeiComponentName: "trade", JifeiProtocolVersion: "1.0", JifeiOurInterfacePrefix: "lightvela",
			OrderStore: fakeOrderStoreNotFound{}, BundleStore: fakeBundleDefStoreUnused{}, CTLClient: fakeCTLClientUnused{}, FlowStore: nil,
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			defer func() {
				if r := recover(); r == nil {
					t.Errorf("expected panic for nil deps, got none")
				}
			}()
			_ = NewRouter(tc.cfg)
		})
	}
}
