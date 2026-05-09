package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

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

func newTestRouter() *gin.Engine {
	return NewRouter(ServerConfig{
		InternalServiceToken:    "test-token",
		JifeiComponentName:      "trade",
		JifeiProtocolVersion:    "1.0",
		JifeiOurInterfacePrefix: "lightvela",
		OrderStore:              fakeOrderStoreNotFound{},
		BundleStore:             fakeBundleDefStoreUnused{},
		CTLClient:               fakeCTLClientUnused{},
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

// 迭代 5 起 checkCreate 是真 handler；router 测试构造一个会让 handler 在第一步
// trade_order 反查就 not_found 退出的请求 — 验证：
//
//  1. routing 命中（不再是 stub 的 ReturnCodeNotImplemented=501001）
//  2. handler 真的拿到 para 并按业务码返 ReturnCodeOrderNotFound=600101
//  3. HTTP 200 + Q58 returnCode == returnValue 不变量
//  4. 不返退款魔法值 352014（Q56 不变量）
func TestNewRouter_JifeiCallback_CheckCreateRoutedToRealHandler(t *testing.T) {
	r := newTestRouter()
	body := `{
        "seqId": "seq-int",
        "interface": {
          "interfaceName": "lightvela.pass.checkCreate",
          "para": {
            "dealName": "deal-not-in-db",
            "bundleId": "bx",
            "goodsNum": 1,
            "goodsDetail": {"pid":"40000","timeSpan":1,"timeUnit":"m","goodsNum":1,"payMode":1}
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
	// 600101 = checkcreate.ReturnCodeOrderNotFound
	if int(rc) != 600101 {
		t.Errorf("expected business returnCode 600101 (OrderNotFound), got %v (msg=%v)", rc, resp["returnMessage"])
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

// 迭代 5 起 NewRouter 强制三个业务依赖非 nil — 验证 panic 行为：
// nil 任一字段必然 panic（启动期暴露配置错而不是延迟到第一个请求）。
func TestNewRouter_NilDeps_Panics(t *testing.T) {
	cases := []struct {
		name string
		cfg  ServerConfig
	}{
		{"order_store_nil", ServerConfig{
			JifeiComponentName: "trade", JifeiProtocolVersion: "1.0", JifeiOurInterfacePrefix: "lightvela",
			OrderStore: nil, BundleStore: fakeBundleDefStoreUnused{}, CTLClient: fakeCTLClientUnused{},
		}},
		{"bundle_store_nil", ServerConfig{
			JifeiComponentName: "trade", JifeiProtocolVersion: "1.0", JifeiOurInterfacePrefix: "lightvela",
			OrderStore: fakeOrderStoreNotFound{}, BundleStore: nil, CTLClient: fakeCTLClientUnused{},
		}},
		{"ctl_client_nil", ServerConfig{
			JifeiComponentName: "trade", JifeiProtocolVersion: "1.0", JifeiOurInterfacePrefix: "lightvela",
			OrderStore: fakeOrderStoreNotFound{}, BundleStore: fakeBundleDefStoreUnused{}, CTLClient: nil,
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
