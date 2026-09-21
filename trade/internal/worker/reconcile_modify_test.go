package worker

import (
	"context"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"git.woa.com/wisp/mono/trade/internal/store"
)

// modify_resource 链路的 reconcile 分支。需求：TAPD 1010132091137784162 §7.1
//
// 行为与 renew 分支同范式（trade-side passive）：只按 age 分级告警，
// 永不 markFailed / markCompleted，不反查 ctl，不构造退款响应体。
// 变配没有回滚路径（扩盘不可逆），trade 单方面判失败会把一笔已支付、
// 实例可能已改到一半的单标成终态。

func newModifyOrphan(id int64, resourceID, appID string, createdAge time.Duration) *store.Flow {
	rid := resourceID
	return &store.Flow{
		ID:          id,
		DealName:    "modify-deal-" + resourceID,
		ResourceID:  &rid,
		Uin:         "100" + appID,
		FlowType:    store.FlowTypeModifyResource,
		AppID:       appID,
		Status:      store.FlowStatusInProgress,
		CreatedTime: time.Now().Add(-createdAge),
	}
}

func TestRunOnce_ModifyWithinThreshold_KeepsInProgress(t *testing.T) {
	flow := newModifyOrphan(9101, "lhpass-modify-1", "40001", 30*time.Minute)
	fs := &fakeFlowStore{listResp: []*store.Flow{flow}}
	prober := &fakeProber{}
	logger, buf := silentLogger()
	w := New(fs, Config{Logger: logger, Prober: prober})

	w.runOnce(context.Background())

	if len(fs.markCompleted) != 0 || len(fs.markFailed) != 0 ||
		len(fs.markCompletedIDs) != 0 || len(fs.markFailedIDs) != 0 {
		t.Errorf("modify reconcile 永不应调用 mark*; completed=%v failed=%v completedIDs=%v failedIDs=%v",
			fs.markCompleted, fs.markFailed, fs.markCompletedIDs, fs.markFailedIDs)
	}
	if atomic.LoadInt32(&prober.calls) != 0 || atomic.LoadInt32(&prober.isolateCalls) != 0 {
		t.Errorf("modify reconcile 不应调用 prober; ProbeResource=%d ProbeIsolate=%d",
			prober.calls, prober.isolateCalls)
	}
	output := buf.String()
	if !strings.Contains(output, "modify orphan still pending") {
		t.Errorf("expected 'modify orphan still pending' log; got %q", output)
	}
	if strings.Contains(output, "modify_resource_alert") {
		t.Errorf("age < 阈值不应触发 ALERT; got %q", output)
	}
}

func TestRunOnce_ModifyBeyondThreshold_AlertsButNoMark(t *testing.T) {
	flow := newModifyOrphan(9102, "lhpass-modify-stuck", "40002", ModifyStaleAlertThreshold+time.Hour)
	fs := &fakeFlowStore{listResp: []*store.Flow{flow}}
	logger, buf := silentLogger()
	w := New(fs, Config{Logger: logger})

	w.runOnce(context.Background())

	if len(fs.markCompleted) != 0 || len(fs.markFailed) != 0 ||
		len(fs.markCompletedIDs) != 0 || len(fs.markFailedIDs) != 0 {
		t.Fatalf("modify reconcile must never mark terminal; completed=%v failed=%v completedIDs=%v failedIDs=%v",
			fs.markCompleted, fs.markFailed, fs.markCompletedIDs, fs.markFailedIDs)
	}
	output := buf.String()
	for _, want := range []string{"ALERT", "modify_resource_alert", "lhpass-modify-stuck", "manual intervention"} {
		if !strings.Contains(output, want) {
			t.Errorf("ALERT log should contain %q; got %q", want, output)
		}
	}
}

// 边界：age 恰好等于阈值走 ALERT（>= 条件），用注入时钟避免运行时漂移。
func TestRunOnce_ModifyExactlyAtThreshold_Alerts(t *testing.T) {
	fixed := time.Date(2026, 9, 2, 12, 0, 0, 0, time.UTC)
	rid := "lhpass-modify-boundary"
	flow := &store.Flow{
		ID:          9103,
		DealName:    "modify-deal-boundary",
		ResourceID:  &rid,
		FlowType:    store.FlowTypeModifyResource,
		AppID:       "40003",
		Status:      store.FlowStatusInProgress,
		CreatedTime: fixed.Add(-ModifyStaleAlertThreshold),
	}
	fs := &fakeFlowStore{listResp: []*store.Flow{flow}}
	logger, buf := silentLogger()
	w := New(fs, Config{Logger: logger, Now: func() time.Time { return fixed }})

	w.runOnce(context.Background())

	if !strings.Contains(buf.String(), "modify_resource_alert") {
		t.Errorf("age == threshold 应走 ALERT 路径; got %q", buf.String())
	}
}
