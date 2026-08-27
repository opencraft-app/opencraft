// Package createresource 单测：billingActivityId 点石分支行为校验（设计稿 §5.6.1 step 4 / §10.1）。
//
// 覆盖：
//   - billingActivityId 为空或 "0" → ActivityStore 不被调用
//   - billingActivityId 非零但 ActivityStore 为 nil → 主流程不阻塞
//   - order == nil 且 billingActivityId 非零 → 仍按 callback 字段写参与记录
//   - isMySQLDuplicateError helper：识别 1062 唯一键冲突
package createresource

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"encoding/json"
	"errors"
	"sync/atomic"
	"testing"

	"git.woa.com/wisp/mono/trade/internal/ctlclient"
	"git.woa.com/wisp/mono/trade/internal/store"
)

// fakeActivityStoreCR 是 store.ActivityStore 在 createresource 单测中的替身。
type fakeActivityStoreCR struct {
	getCalls          atomic.Int32
	getMapping        *store.BundleActivity
	getErr            error
	insertCalls       atomic.Int32
	insertErr         error
	lastParticipation *store.UserActivityParticipation
}

func (f *fakeActivityStoreCR) GetBundleActivityByBundleID(_ context.Context, bundleID string) (*store.BundleActivity, error) {
	f.getCalls.Add(1)
	if f.getErr != nil {
		return nil, f.getErr
	}
	if f.getMapping != nil {
		// 浅拷贝防被测代码改 fixture
		row := *f.getMapping
		row.BundleID = bundleID
		return &row, nil
	}
	return nil, store.ErrBundleActivityNotFound
}

func (f *fakeActivityStoreCR) HasUserParticipated(_ context.Context, _ string, _ int64) (bool, error) {
	return false, errors.New("HasUserParticipated not used in createresource tests")
}

func (f *fakeActivityStoreCR) InsertUserParticipation(_ context.Context, _ *sql.Tx, row *store.UserActivityParticipation) (int64, error) {
	f.insertCalls.Add(1)
	if row != nil {
		copy := *row
		f.lastParticipation = &copy
	}
	return 1, f.insertErr
}

var _ store.ActivityStore = (*fakeActivityStoreCR)(nil)

const activityTxTestDriverName = "createresource-activity-tx"

type activityTxTestDriver struct{}
type activityTxTestConn struct{}
type activityTxTestTx struct{}

func (activityTxTestDriver) Open(string) (driver.Conn, error) { return activityTxTestConn{}, nil }
func (activityTxTestConn) Prepare(string) (driver.Stmt, error) {
	return nil, errors.New("prepare is not supported")
}
func (activityTxTestConn) Close() error              { return nil }
func (activityTxTestConn) Begin() (driver.Tx, error) { return activityTxTestTx{}, nil }
func (activityTxTestTx) Commit() error               { return nil }
func (activityTxTestTx) Rollback() error             { return nil }

func init() {
	sql.Register(activityTxTestDriverName, activityTxTestDriver{})
}

func newActivityTxTestDB(t *testing.T) *sql.DB {
	t.Helper()
	db, err := sql.Open(activityTxTestDriverName, "")
	if err != nil {
		t.Fatalf("open activity tx test db: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db
}

func newOrderWithSource(src string) *store.TradeOrder {
	o := defaultOrder()
	o.Source = src
	return o
}

func TestRunMainFlow_NoBillingActivityID_DoesNotCallActivityStore(t *testing.T) {
	flow := &fakeFlowStore{
		tryAcquireFunc: func(_ context.Context, _, _, _ string, _ []byte) (bool, *store.Flow, error) {
			return true, nil, nil
		},
	}
	ctl := &fakeCTLClient{
		completePassFunc: func(_ context.Context, _ *ctlclient.CompletePassRequest) (*ctlclient.PassDetail, error) {
			return &ctlclient.PassDetail{PassID: "pass-001"}, nil
		},
	}
	orderStore := &fakeOrderStore{
		getFunc: func(_ context.Context, _ string) (*store.TradeOrder, error) {
			// jifei 路径：source 默认 'jifei'
			return newOrderWithSource(store.OrderSourceJifei), nil
		},
	}
	act := &fakeActivityStoreCR{}

	deps := newDeps(orderStore, flow, ctl, &fakeOrderUpdater{})
	deps.ActivityStore = act
	// DB 留 nil：本路径不应触发 INSERT，留 nil 验证非 dianshi 路径不会去用 DB。

	h := makeHandler(deps)
	resp, err := h(context.Background(), paraJSON(t, defaultPara()))
	if err != nil {
		t.Fatalf("handler err=%v", err)
	}
	if resp.ReturnCode != 0 {
		t.Fatalf("expect success returnCode=0, got %d (msg=%q)", resp.ReturnCode, resp.ReturnMessage)
	}
	if act.getCalls.Load() != 0 {
		t.Errorf("ActivityStore.GetBundleActivityByBundleID should NOT be called for jifei source, calls=%d",
			act.getCalls.Load())
	}
}

func TestRunMainFlow_BillingActivityIDZero_DoesNotCallActivityStore(t *testing.T) {
	flow := &fakeFlowStore{
		tryAcquireFunc: func(_ context.Context, _, _, _ string, _ []byte) (bool, *store.Flow, error) {
			return true, nil, nil
		},
	}
	ctl := &fakeCTLClient{
		completePassFunc: func(_ context.Context, _ *ctlclient.CompletePassRequest) (*ctlclient.PassDetail, error) {
			return &ctlclient.PassDetail{PassID: "pass-001b"}, nil
		},
	}
	orderStore := &fakeOrderStore{
		getFunc: func(_ context.Context, _ string) (*store.TradeOrder, error) {
			return newOrderWithSource(store.OrderSourceDianshi), nil
		},
	}
	act := &fakeActivityStoreCR{}
	deps := newDeps(orderStore, flow, ctl, &fakeOrderUpdater{})
	deps.ActivityStore = act

	para := defaultPara()
	para.BillingActivityID = "0"
	resp, err := makeHandler(deps)(context.Background(), paraJSON(t, para))
	if err != nil {
		t.Fatalf("handler err=%v", err)
	}
	if resp.ReturnCode != 0 {
		t.Fatalf("expect success returnCode=0, got %d", resp.ReturnCode)
	}
	if act.getCalls.Load() != 0 || act.insertCalls.Load() != 0 {
		t.Errorf("activity store calls get/insert=%d/%d want 0/0", act.getCalls.Load(), act.insertCalls.Load())
	}
}

func TestRunMainFlow_DianshiBillingActivityID_NilActivityStoreDoesNotBlock(t *testing.T) {
	flow := &fakeFlowStore{
		tryAcquireFunc: func(_ context.Context, _, _, _ string, _ []byte) (bool, *store.Flow, error) {
			return true, nil, nil
		},
	}
	ctl := &fakeCTLClient{
		completePassFunc: func(_ context.Context, _ *ctlclient.CompletePassRequest) (*ctlclient.PassDetail, error) {
			return &ctlclient.PassDetail{PassID: "pass-002"}, nil
		},
	}
	orderStore := &fakeOrderStore{
		getFunc: func(_ context.Context, _ string) (*store.TradeOrder, error) {
			return newOrderWithSource(store.OrderSourceDianshi), nil
		},
	}

	deps := newDeps(orderStore, flow, ctl, &fakeOrderUpdater{})
	// 显式不注入 ActivityStore——灰度场景或回滚情形下，dianshi 订单的 jifei 反向回调
	// 仍应能正常发货，只是 participation 缺录、由运维补登。
	deps.ActivityStore = nil

	h := makeHandler(deps)
	para := defaultPara()
	para.BillingActivityID = "16552"
	resp, err := h(context.Background(), paraJSON(t, para))
	if err != nil {
		t.Fatalf("handler err=%v", err)
	}
	if resp.ReturnCode != 0 {
		t.Fatalf("expect success returnCode=0 even when ActivityStore is nil, got %d (msg=%q)",
			resp.ReturnCode, resp.ReturnMessage)
	}
}

func TestRunMainFlow_DianshiCallbackWithoutTradeOrderInsertsParticipation(t *testing.T) {
	flow := &fakeFlowStore{
		tryAcquireFunc: func(_ context.Context, _, _, _ string, _ []byte) (bool, *store.Flow, error) {
			return true, nil, nil
		},
	}
	ctl := &fakeCTLClient{
		completePassFunc: func(_ context.Context, _ *ctlclient.CompletePassRequest) (*ctlclient.PassDetail, error) {
			return &ctlclient.PassDetail{PassID: "pass-003"}, nil
		},
	}
	orderStore := &fakeOrderStore{
		getFunc: func(_ context.Context, _ string) (*store.TradeOrder, error) {
			// do_goods_and_pay 同步回调早于 placeorder 插入 trade_order。
			return nil, store.ErrTradeOrderNotFound
		},
	}
	act := &fakeActivityStoreCR{getMapping: &store.BundleActivity{
		ActivityID: 165523570799387,
		ActID:      142062575174494,
	}}

	deps := newDeps(orderStore, flow, ctl, &fakeOrderUpdater{})
	deps.ActivityStore = act
	deps.DB = newActivityTxTestDB(t)

	h := makeHandler(deps)
	para := map[string]interface{}{
		"dealName":          "20260821019013005816971",
		"bigDealId":         "20260821019013005816961",
		"billingActivityId": "16552",
		"appId":             1472039146,
		"uin":               "450850000019",
		"subProductCode":    "sp_lighthouse_lightvela_bundle_intl",
		"goodsDetail": map[string]interface{}{
			"bundleId":       "bundle_cruise_01",
			"externalUserId": "usr_bb753c9a0c8cc53a3e9df172",
			"dianshiActId":   142123551192174,
			"timeSpan":       1,
			"timeUnit":       "m",
			"goodsNum":       1,
		},
	}
	paraRaw, err := json.Marshal(para)
	if err != nil {
		t.Fatalf("marshal SG callback para: %v", err)
	}
	resp, err := h(context.Background(), paraRaw)
	if err != nil {
		t.Fatalf("handler err=%v", err)
	}
	if resp.ReturnCode != 0 {
		t.Fatalf("expect success returnCode=0, got %d", resp.ReturnCode)
	}
	if act.getCalls.Load() != 1 || act.insertCalls.Load() != 1 {
		t.Fatalf("activity store calls get/insert=%d/%d want 1/1", act.getCalls.Load(), act.insertCalls.Load())
	}
	got := act.lastParticipation
	if got == nil {
		t.Fatal("participation row is nil")
	}
	if got.Uin != "450850000019" || got.AppID != "1472039146" || got.ExternalUserID != "usr_bb753c9a0c8cc53a3e9df172" {
		t.Errorf("participation identity=%q/%q/%q", got.Uin, got.AppID, got.ExternalUserID)
	}
	if got.ActivityID != 165523570799387 || got.ActID != 142123551192174 || got.BundleID != "bundle_cruise_01" {
		t.Errorf("participation activity=%d/%d/%q", got.ActivityID, got.ActID, got.BundleID)
	}
	if got.DealName != "20260821019013005816971" || got.BigDealNo != "20260821019013005816961" {
		t.Errorf("participation deal=%q/%q", got.DealName, got.BigDealNo)
	}
}

func TestInsertDianshiParticipation_RequestScopedCampaignSkipsMappingLookup(t *testing.T) {
	act := &fakeActivityStoreCR{getErr: errors.New("trade_bundle_activity must not be queried")}
	deps := Deps{ActivityStore: act, DB: newActivityTxTestDB(t)}
	para := &callbackPara{
		DealName:          "deal-request-scoped",
		BigDealID:         "big-request-scoped",
		BillingActivityID: "16552",
		AppID:             1472039146,
		Uin:               "450850002074",
		BundleID:          "bundle_launch_ai_01",
		GoodsDetail: map[string]interface{}{
			"externalUserId":      "usr_e7dffa50f167a72ae0a9a0d6",
			"dianshi_activity_id": float64(165523570799387),
			"dianshiActId":        float64(142163399386388),
		},
	}

	if err := insertDianshiParticipation(context.Background(), deps, para, "pass-request-scoped"); err != nil {
		t.Fatalf("insertDianshiParticipation: %v", err)
	}
	if act.getCalls.Load() != 0 || act.insertCalls.Load() != 1 {
		t.Fatalf("activity store calls get/insert=%d/%d want 0/1", act.getCalls.Load(), act.insertCalls.Load())
	}
	if got := act.lastParticipation; got == nil || got.ActivityID != 165523570799387 || got.ActID != 142163399386388 {
		t.Fatalf("unexpected participation: %+v", got)
	}
}

func TestIsMySQLDuplicateError(t *testing.T) {
	tests := []struct {
		name string
		err  error
		want bool
	}{
		{"nil", nil, false},
		{"random error", errors.New("connection refused"), false},
		{"errno 1062 message", errors.New("Error 1062: Duplicate entry 'foo' for key 'PRIMARY'"), true},
		{"plain duplicate phrase", errors.New("Duplicate entry"), true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := isMySQLDuplicateError(tt.err)
			if got != tt.want {
				t.Errorf("isMySQLDuplicateError(%v)=%v want %v", tt.err, got, tt.want)
			}
		})
	}
}

// 编译期断言：jsonRawMessage 用作 fixture 时的协议契约——para 包 marshal 后 source
// 列不会出现在 callbackPara 里，与 jifei 协议层无关（source 仅 trade 内部字段）。
func TestCallbackPara_HasNoSourceField(t *testing.T) {
	p := defaultPara()
	b, err := json.Marshal(p)
	if err != nil {
		t.Fatal(err)
	}
	if cs := []byte(`"source"`); contains(b, cs) {
		t.Errorf("callbackPara should NOT carry source field (jifei wire protocol agnostic), body=%s", string(b))
	}
}

func contains(b, sub []byte) bool {
	if len(sub) == 0 {
		return true
	}
	for i := 0; i+len(sub) <= len(b); i++ {
		ok := true
		for j := 0; j < len(sub); j++ {
			if b[i+j] != sub[j] {
				ok = false
				break
			}
		}
		if ok {
			return true
		}
	}
	return false
}
