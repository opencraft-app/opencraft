// Package createresource 单测：source=dianshi 分支行为校验（设计稿 §5.6.1 step 4 / §10.1）。
//
// 覆盖：
//   - order.Source != 'dianshi' → ActivityStore 不被调用
//   - order.Source == 'dianshi' 但 ActivityStore 为 nil → 主流程不阻塞、按 jifei 路径返成功
//   - order == nil（trade_order 反查不到）→ 即便 ActivityStore 注入，也不会 NPE / 不会调 ActivityStore
//   - isMySQLDuplicateError helper：识别 1062 唯一键冲突
//
// 真实 INSERT participation 同事务路径需要 *sql.Tx，由 store/activity 包单测 + e2e 联调
// 覆盖；本单测仅校验 handler 主流程的"是否调 ActivityStore"分支契约。
package createresource

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"sync/atomic"
	"testing"

	"git.woa.com/wisp/mono/trade/internal/ctlclient"
	"git.woa.com/wisp/mono/trade/internal/store"
)

// fakeActivityStoreCR 是 store.ActivityStore 在 createresource 单测中的替身。
type fakeActivityStoreCR struct {
	getCalls   atomic.Int32
	getMapping *store.BundleActivity
	getErr     error
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

func (f *fakeActivityStoreCR) InsertUserParticipation(_ context.Context, _ *sql.Tx, _ *store.UserActivityParticipation) (int64, error) {
	// createresource handler 入口路径上不会到 INSERT（fake 不提供真实 *sql.DB），
	// 真正 INSERT 路径由 store/activity 包单测覆盖。
	return 0, errors.New("InsertUserParticipation not exercised at this layer")
}

var _ store.ActivityStore = (*fakeActivityStoreCR)(nil)

func newOrderWithSource(src string) *store.TradeOrder {
	o := defaultOrder()
	o.Source = src
	return o
}

func TestRunMainFlow_NonDianshi_DoesNotCallActivityStore(t *testing.T) {
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

func TestRunMainFlow_DianshiSource_NilActivityStore_DoesNotBlock(t *testing.T) {
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
	resp, err := h(context.Background(), paraJSON(t, defaultPara()))
	if err != nil {
		t.Fatalf("handler err=%v", err)
	}
	if resp.ReturnCode != 0 {
		t.Fatalf("expect success returnCode=0 even when ActivityStore is nil, got %d (msg=%q)",
			resp.ReturnCode, resp.ReturnMessage)
	}
}

func TestRunMainFlow_NoTradeOrder_SkipsActivityStore(t *testing.T) {
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
			// trade_order 反查不到（jifei 回调先于 trade_order 落库到达 / 数据丢失）
			return nil, store.ErrTradeOrderNotFound
		},
	}
	act := &fakeActivityStoreCR{}

	deps := newDeps(orderStore, flow, ctl, &fakeOrderUpdater{})
	deps.ActivityStore = act

	h := makeHandler(deps)
	resp, err := h(context.Background(), paraJSON(t, defaultPara()))
	if err != nil {
		t.Fatalf("handler err=%v", err)
	}
	if resp.ReturnCode != 0 {
		t.Fatalf("expect success returnCode=0, got %d", resp.ReturnCode)
	}
	if act.getCalls.Load() != 0 {
		t.Errorf("ActivityStore should NOT be called when order==nil, calls=%d", act.getCalls.Load())
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
