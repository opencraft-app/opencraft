package worker

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"git.woa.com/wisp/mono/trade/internal/store"
)

// fakeFlowStore 是 reconcile worker 单元测试用的内存假存储。
//
// 仅实现 reconcile 路径需要的 List + MarkCompleted + MarkFailed 三个方法；
// TryAcquireSlot / GetFlow 留 nop 实现以满足接口，本测试不依赖。
type fakeFlowStore struct {
	mu              sync.Mutex
	listResp        []*store.Flow
	listErr         error
	markCompleted   []string // dealName 列表
	markCompletedErr map[string]error
	markFailed      []string
	markFailedErr   map[string]error
	listCalls       int
}

func (f *fakeFlowStore) TryAcquireSlot(ctx context.Context, dealName, flowType, appID string, requestBody []byte) (bool, *store.Flow, error) {
	return false, nil, errors.New("not used in worker tests")
}

func (f *fakeFlowStore) MarkCompleted(ctx context.Context, dealName, flowType, appID string, responseBody []byte) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if e, ok := f.markCompletedErr[dealName]; ok {
		return e
	}
	f.markCompleted = append(f.markCompleted, dealName)
	return nil
}

func (f *fakeFlowStore) MarkFailed(ctx context.Context, dealName, flowType, appID string, responseBody []byte) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if e, ok := f.markFailedErr[dealName]; ok {
		return e
	}
	f.markFailed = append(f.markFailed, dealName)
	return nil
}

func (f *fakeFlowStore) GetFlow(ctx context.Context, dealName, flowType, appID string) (*store.Flow, error) {
	return nil, store.ErrFlowNotFound
}

func (f *fakeFlowStore) ListInProgressBefore(ctx context.Context, cutoff time.Time, limit int) ([]*store.Flow, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.listCalls++
	if f.listErr != nil {
		return nil, f.listErr
	}
	// 拷贝防止外部修改影响后续轮次
	out := make([]*store.Flow, len(f.listResp))
	copy(out, f.listResp)
	return out, nil
}

// fakeProber 用于驱动 ResourceProber 行为；按 dealName 路由到不同分支。
type fakeProber struct {
	mu       sync.Mutex
	exists   map[string]bool  // 默认 false
	errs     map[string]error // 优先于 exists 返回
	calls    int32
}

func (p *fakeProber) ProbeResource(ctx context.Context, dealName string) (bool, error) {
	atomic.AddInt32(&p.calls, 1)
	p.mu.Lock()
	defer p.mu.Unlock()
	if e, ok := p.errs[dealName]; ok {
		return false, e
	}
	return p.exists[dealName], nil
}

// silentLogger 抑制测试日志噪音，但保留可断言的输出。
func silentLogger() (*log.Logger, *bytes.Buffer) {
	buf := &bytes.Buffer{}
	return log.New(buf, "", 0), buf
}

func discardLogger() *log.Logger {
	return log.New(io.Discard, "", 0)
}

// ============================================================================
// 单元测试 — 配置默认值
// ============================================================================

func TestNew_DefaultsApplied(t *testing.T) {
	w := New(&fakeFlowStore{}, Config{})
	if w.interval != DefaultInterval {
		t.Errorf("interval = %v, want %v", w.interval, DefaultInterval)
	}
	if w.staleThreshold != DefaultStaleThreshold {
		t.Errorf("staleThreshold = %v, want %v", w.staleThreshold, DefaultStaleThreshold)
	}
	if w.batchLimit != DefaultBatchLimit {
		t.Errorf("batchLimit = %d, want %d", w.batchLimit, DefaultBatchLimit)
	}
	if w.now == nil {
		t.Error("now func should not be nil")
	}
	if w.logger == nil {
		t.Error("logger should not be nil")
	}
}

func TestNew_OverridesApplied(t *testing.T) {
	customNow := func() time.Time { return time.Unix(0, 0) }
	customLogger := log.New(io.Discard, "test", 0)
	prober := &fakeProber{}
	w := New(&fakeFlowStore{}, Config{
		Interval:       2 * time.Second,
		StaleThreshold: 7 * time.Minute,
		BatchLimit:     50,
		Now:            customNow,
		Logger:         customLogger,
		Prober:         prober,
	})
	if w.interval != 2*time.Second {
		t.Errorf("interval not overridden")
	}
	if w.staleThreshold != 7*time.Minute {
		t.Errorf("staleThreshold not overridden")
	}
	if w.batchLimit != 50 {
		t.Errorf("batchLimit not overridden")
	}
	if w.cfg.Prober != prober {
		t.Errorf("prober not stored")
	}
}

// ============================================================================
// 单元测试 — runOnce 行为
// ============================================================================

func TestRunOnce_NoOrphans(t *testing.T) {
	fs := &fakeFlowStore{listResp: nil}
	w := New(fs, Config{Logger: discardLogger()})
	w.runOnce(context.Background())

	if fs.listCalls != 1 {
		t.Errorf("ListInProgressBefore called %d times, want 1", fs.listCalls)
	}
	if len(fs.markCompleted) != 0 || len(fs.markFailed) != 0 {
		t.Errorf("no orphans should not trigger any mark")
	}
}

func TestRunOnce_ListFails_LogsAndContinues(t *testing.T) {
	fs := &fakeFlowStore{listErr: errors.New("db down")}
	logger, buf := silentLogger()
	w := New(fs, Config{Logger: logger})
	w.runOnce(context.Background())

	if !strings.Contains(buf.String(), "list orphans failed") {
		t.Errorf("expected list-failure log, got %q", buf.String())
	}
}

func TestRunOnce_ProberNil_OnlyLogs(t *testing.T) {
	flow := &store.Flow{
		DealName:    "deal-xyz",
		FlowType:    store.FlowTypeCreateResource,
		AppID:       "10001",
		Status:      store.FlowStatusInProgress,
		CreatedTime: time.Now().Add(-1 * time.Hour),
	}
	fs := &fakeFlowStore{listResp: []*store.Flow{flow}}
	logger, buf := silentLogger()
	w := New(fs, Config{Logger: logger}) // Prober 为 nil

	w.runOnce(context.Background())

	if len(fs.markCompleted) != 0 || len(fs.markFailed) != 0 {
		t.Errorf("Prober=nil 不应升级状态; completed=%v failed=%v", fs.markCompleted, fs.markFailed)
	}
	if !strings.Contains(buf.String(), "manual intervention required") {
		t.Errorf("expected manual-intervention log; got %q", buf.String())
	}
	if !strings.Contains(buf.String(), "deal-xyz") {
		t.Errorf("expected deal_name in log; got %q", buf.String())
	}
}

func TestRunOnce_ProberExists_PromotesToCompleted(t *testing.T) {
	flow := &store.Flow{
		DealName:    "deal-promote-ok",
		FlowType:    store.FlowTypeCreateResource,
		AppID:       "10002",
		Status:      store.FlowStatusInProgress,
		CreatedTime: time.Now().Add(-45 * time.Minute),
	}
	fs := &fakeFlowStore{listResp: []*store.Flow{flow}}
	prober := &fakeProber{exists: map[string]bool{"deal-promote-ok": true}}
	w := New(fs, Config{Logger: discardLogger(), Prober: prober})

	w.runOnce(context.Background())

	if len(fs.markCompleted) != 1 || fs.markCompleted[0] != "deal-promote-ok" {
		t.Errorf("expected MarkCompleted[deal-promote-ok], got %v", fs.markCompleted)
	}
	if len(fs.markFailed) != 0 {
		t.Errorf("should not call MarkFailed; got %v", fs.markFailed)
	}
	if atomic.LoadInt32(&prober.calls) != 1 {
		t.Errorf("Prober called %d times, want 1", prober.calls)
	}
}

func TestRunOnce_ProberMissing_PromotesToFailed(t *testing.T) {
	flow := &store.Flow{
		DealName:    "deal-promote-fail",
		FlowType:    store.FlowTypeCreateResource,
		AppID:       "10003",
		CreatedTime: time.Now().Add(-45 * time.Minute),
	}
	fs := &fakeFlowStore{listResp: []*store.Flow{flow}}
	prober := &fakeProber{exists: map[string]bool{}} // false
	w := New(fs, Config{Logger: discardLogger(), Prober: prober})

	w.runOnce(context.Background())

	if len(fs.markFailed) != 1 || fs.markFailed[0] != "deal-promote-fail" {
		t.Errorf("expected MarkFailed[deal-promote-fail], got %v", fs.markFailed)
	}
	if len(fs.markCompleted) != 0 {
		t.Errorf("should not call MarkCompleted")
	}
}

func TestRunOnce_ProberError_SkipsRecord(t *testing.T) {
	flow := &store.Flow{DealName: "deal-probe-err", FlowType: store.FlowTypeCreateResource, AppID: "1"}
	fs := &fakeFlowStore{listResp: []*store.Flow{flow}}
	prober := &fakeProber{errs: map[string]error{"deal-probe-err": errors.New("ctl 5xx")}}
	logger, buf := silentLogger()
	w := New(fs, Config{Logger: logger, Prober: prober})

	w.runOnce(context.Background())

	if len(fs.markCompleted) != 0 || len(fs.markFailed) != 0 {
		t.Errorf("prober error should not trigger any mark; completed=%v failed=%v",
			fs.markCompleted, fs.markFailed)
	}
	if !strings.Contains(buf.String(), "probe failed") {
		t.Errorf("expected probe-failed log; got %q", buf.String())
	}
}

func TestRunOnce_MarkCompletedFails_LogsAndContinues(t *testing.T) {
	flows := []*store.Flow{
		{DealName: "ok-1", FlowType: store.FlowTypeCreateResource, AppID: "1"},
		{DealName: "fail-1", FlowType: store.FlowTypeCreateResource, AppID: "1"},
		{DealName: "ok-2", FlowType: store.FlowTypeCreateResource, AppID: "1"},
	}
	fs := &fakeFlowStore{
		listResp:         flows,
		markCompletedErr: map[string]error{"fail-1": errors.New("update failed")},
	}
	prober := &fakeProber{exists: map[string]bool{"ok-1": true, "fail-1": true, "ok-2": true}}
	logger, buf := silentLogger()
	w := New(fs, Config{Logger: logger, Prober: prober})

	w.runOnce(context.Background())

	// fail-1 升级失败但不应卡死后续 ok-2
	if len(fs.markCompleted) != 2 {
		t.Errorf("expected 2 successful MarkCompleted, got %v", fs.markCompleted)
	}
	if !strings.Contains(buf.String(), "MarkCompleted failed") {
		t.Errorf("expected MarkCompleted failure log; got %q", buf.String())
	}
}

func TestRunOnce_ContextCancelMidLoop_StopsEarly(t *testing.T) {
	// 准备 5 条记录，预期 ctx 在第 1 条之后被 cancel，剩下 4 条不应被处理
	flows := []*store.Flow{
		{DealName: "f1", FlowType: store.FlowTypeCreateResource, AppID: "1"},
		{DealName: "f2", FlowType: store.FlowTypeCreateResource, AppID: "1"},
		{DealName: "f3", FlowType: store.FlowTypeCreateResource, AppID: "1"},
		{DealName: "f4", FlowType: store.FlowTypeCreateResource, AppID: "1"},
		{DealName: "f5", FlowType: store.FlowTypeCreateResource, AppID: "1"},
	}
	fs := &fakeFlowStore{listResp: flows}
	ctx, cancel := context.WithCancel(context.Background())

	// prober 在第一条调用后 cancel ctx
	probedFirst := false
	prober := &fakeProber{exists: map[string]bool{"f1": true, "f2": true, "f3": true, "f4": true, "f5": true}}
	wrap := proberFunc(func(ctx context.Context, dealName string) (bool, error) {
		exists, err := prober.ProbeResource(ctx, dealName)
		if !probedFirst {
			probedFirst = true
			cancel()
		}
		return exists, err
	})
	w := New(fs, Config{Logger: discardLogger(), Prober: wrap})

	w.runOnce(ctx)

	// 期望 markCompleted 至多 1 条（第一条），其余应被 ctx.Done 短路
	if got := len(fs.markCompleted); got > 1 {
		t.Errorf("expected at most 1 MarkCompleted before ctx cancel, got %d (%v)", got, fs.markCompleted)
	}
}

// ============================================================================
// 单元测试 — Run 启动 / 停机
// ============================================================================

func TestRun_RunsOnceImmediately_ThenStopsOnCancel(t *testing.T) {
	fs := &fakeFlowStore{listResp: nil}
	w := New(fs, Config{
		Interval: 1 * time.Hour, // 远超测试时长，确保只有"立即第一次"被触发
		Logger:   discardLogger(),
	})

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		w.Run(ctx)
		close(done)
	}()

	// 留时间给"立即跑一次"完成
	deadline := time.After(500 * time.Millisecond)
	for {
		fs.mu.Lock()
		calls := fs.listCalls
		fs.mu.Unlock()
		if calls >= 1 {
			break
		}
		select {
		case <-deadline:
			t.Fatalf("Run did not invoke runOnce immediately within 500ms")
		case <-time.After(10 * time.Millisecond):
		}
	}

	cancel()
	select {
	case <-done:
		// ok
	case <-time.After(2 * time.Second):
		t.Fatal("Run did not exit within 2s after ctx cancel")
	}
}

func TestRun_PeriodicTrigger(t *testing.T) {
	fs := &fakeFlowStore{listResp: nil}
	w := New(fs, Config{
		Interval: 30 * time.Millisecond,
		Logger:   discardLogger(),
	})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go w.Run(ctx)

	// 等 ~120ms：应至少触发 3 次（立即一次 + 30ms*3）
	time.Sleep(120 * time.Millisecond)
	cancel()

	fs.mu.Lock()
	calls := fs.listCalls
	fs.mu.Unlock()

	if calls < 3 {
		t.Errorf("expected >= 3 List calls within 120ms@30ms-interval, got %d", calls)
	}
}

func TestRun_NilStore_NoPanic(t *testing.T) {
	w := New(nil, Config{Logger: discardLogger()})
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("Run panicked with nil store: %v", r)
		}
	}()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	w.Run(ctx) // 应直接返回不 panic
}

// ============================================================================
// 关键不变量集中断言（避免回归）
// ============================================================================

func TestInvariant_ReconcileNeverWritesResponseBody(t *testing.T) {
	// 设计稿严格约束：reconcile 不主动构造退款响应体（避免越权决策）
	// 验证方式：观察 fakeFlowStore 收到的 responseBody 参数全部为 nil

	flow := &store.Flow{DealName: "deal-x", FlowType: store.FlowTypeCreateResource, AppID: "1"}

	type recorded struct {
		method string
		body   []byte
	}
	var rec []recorded
	fs := &recordingFlowStore{onMark: func(method string, body []byte) {
		rec = append(rec, recorded{method, append([]byte(nil), body...)})
	}, listResp: []*store.Flow{flow}}

	// 路径 A：exists → MarkCompleted
	probeA := proberFunc(func(ctx context.Context, dealName string) (bool, error) { return true, nil })
	wA := New(fs, Config{Logger: discardLogger(), Prober: probeA})
	wA.runOnce(context.Background())

	// 路径 B：missing → MarkFailed
	probeB := proberFunc(func(ctx context.Context, dealName string) (bool, error) { return false, nil })
	wB := New(fs, Config{Logger: discardLogger(), Prober: probeB})
	wB.runOnce(context.Background())

	if len(rec) != 2 {
		t.Fatalf("expected 2 mark calls; got %d (%+v)", len(rec), rec)
	}
	for _, r := range rec {
		if len(r.body) != 0 {
			t.Errorf("invariant violated: %s wrote responseBody=%q (must be nil)", r.method, r.body)
		}
	}
}

// proberFunc 是 ResourceProber 的函数适配器，便于内联定义 prober 行为。
type proberFunc func(ctx context.Context, dealName string) (bool, error)

func (f proberFunc) ProbeResource(ctx context.Context, dealName string) (bool, error) {
	return f(ctx, dealName)
}

// recordingFlowStore 记录 MarkCompleted/MarkFailed 的 body 参数用于不变量断言。
type recordingFlowStore struct {
	mu       sync.Mutex
	onMark   func(method string, body []byte)
	listResp []*store.Flow
}

func (r *recordingFlowStore) TryAcquireSlot(ctx context.Context, dealName, flowType, appID string, requestBody []byte) (bool, *store.Flow, error) {
	return false, nil, errors.New("not used")
}

func (r *recordingFlowStore) MarkCompleted(ctx context.Context, dealName, flowType, appID string, responseBody []byte) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.onMark != nil {
		r.onMark("MarkCompleted", responseBody)
	}
	return nil
}

func (r *recordingFlowStore) MarkFailed(ctx context.Context, dealName, flowType, appID string, responseBody []byte) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.onMark != nil {
		r.onMark("MarkFailed", responseBody)
	}
	return nil
}

func (r *recordingFlowStore) GetFlow(ctx context.Context, dealName, flowType, appID string) (*store.Flow, error) {
	return nil, store.ErrFlowNotFound
}

func (r *recordingFlowStore) ListInProgressBefore(ctx context.Context, cutoff time.Time, limit int) ([]*store.Flow, error) {
	return r.listResp, nil
}

// ============================================================================
// 单元测试 — 时序：cutoff 计算
// ============================================================================

func TestRunOnce_CutoffComputedFromNow(t *testing.T) {
	fixed := time.Date(2026, 5, 9, 12, 0, 0, 0, time.UTC)
	wantCutoff := fixed.Add(-DefaultStaleThreshold)

	var capturedCutoff time.Time
	fs := &cutoffCapturingStore{capture: func(c time.Time) { capturedCutoff = c }}

	w := New(fs, Config{
		Logger: discardLogger(),
		Now:    func() time.Time { return fixed },
	})
	w.runOnce(context.Background())

	if !capturedCutoff.Equal(wantCutoff) {
		t.Errorf("cutoff = %v, want %v", capturedCutoff, wantCutoff)
	}
}

type cutoffCapturingStore struct {
	capture func(time.Time)
}

func (c *cutoffCapturingStore) TryAcquireSlot(ctx context.Context, dealName, flowType, appID string, requestBody []byte) (bool, *store.Flow, error) {
	return false, nil, errors.New("not used")
}
func (c *cutoffCapturingStore) MarkCompleted(ctx context.Context, dealName, flowType, appID string, responseBody []byte) error {
	return nil
}
func (c *cutoffCapturingStore) MarkFailed(ctx context.Context, dealName, flowType, appID string, responseBody []byte) error {
	return nil
}
func (c *cutoffCapturingStore) GetFlow(ctx context.Context, dealName, flowType, appID string) (*store.Flow, error) {
	return nil, store.ErrFlowNotFound
}
func (c *cutoffCapturingStore) ListInProgressBefore(ctx context.Context, cutoff time.Time, limit int) ([]*store.Flow, error) {
	if c.capture != nil {
		c.capture(cutoff)
	}
	return nil, nil
}

// ============================================================================
// 编译期断言：Worker 接受任何 store.FlowStore 实现
// ============================================================================

func TestCompileTime_FakeStoreImplementsInterface(t *testing.T) {
	var _ store.FlowStore = (*fakeFlowStore)(nil)
	var _ store.FlowStore = (*recordingFlowStore)(nil)
	var _ store.FlowStore = (*cutoffCapturingStore)(nil)
}

// 占位避免 "declared and not used" 编译错误（防 fmt 在某些 build 下被剔除）
var _ = fmt.Sprint
