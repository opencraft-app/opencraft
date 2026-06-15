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
// 实现 reconcile 路径需要的方法：
//   - List（兜底扫描）
//   - MarkCompleted / MarkFailed（createResource 链路）
//   - MarkCompletedByID / MarkFailedByID（isolate 链路 + Sub-5）
//
// TryAcquireSlot / TryAcquireSlotForIsolate / GetFlow / GetByID / DeleteByID
// 留 not-used 实现以满足接口，本测试不依赖。
type fakeFlowStore struct {
	mu               sync.Mutex
	listResp         []*store.Flow
	listErr          error
	markCompleted    []string // createResource 链路 dealName 列表
	markCompletedErr map[string]error
	markFailed       []string
	markFailedErr    map[string]error
	// Sub-5 isolate 链路：按 PK 反查
	markCompletedIDs   []int64
	markCompletedIDErr map[int64]error
	markFailedIDs      []int64
	markFailedIDErr    map[int64]error
	listCalls          int
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

// MarkCompletedWithResourceID — v1.7.28 BUG-18 新增方法的 fake；
// reconcile worker 不调用本方法（reconcile 走的是 MarkCompleted 老路径，没有 resource_id 上下文），
// 这里 noop 即可，仅为满足接口实现。
func (f *fakeFlowStore) MarkCompletedWithResourceID(_ context.Context, _, _, _, _ string, _ []byte) error {
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

// Sub-4 新增方法（部分仍 not-used，部分 Sub-5 起用）：
func (f *fakeFlowStore) TryAcquireSlotForIsolate(_ context.Context, _, _, _, _ string, _ []byte, _ *string) (bool, *store.Flow, error) {
	return false, nil, errors.New("TryAcquireSlotForIsolate not used in worker tests")
}

// MarkCompletedByID — Sub-5 isolate 链路 reconcile 真实调用，记录 ID 列表。
func (f *fakeFlowStore) MarkCompletedByID(_ context.Context, id int64, _ []byte) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if e, ok := f.markCompletedIDErr[id]; ok {
		return e
	}
	f.markCompletedIDs = append(f.markCompletedIDs, id)
	return nil
}

// MarkFailedByID — Sub-5 reconcile 不应升级 isolate 行为 failed；保留实现仅为
// 在测试中对 invariant"isolate 链路 reconcile 永不升级 failed"做断言。
func (f *fakeFlowStore) MarkFailedByID(_ context.Context, id int64, _ []byte) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if e, ok := f.markFailedIDErr[id]; ok {
		return e
	}
	f.markFailedIDs = append(f.markFailedIDs, id)
	return nil
}

func (f *fakeFlowStore) DeleteByID(_ context.Context, _ int64) error {
	return errors.New("DeleteByID not used in worker tests")
}
func (f *fakeFlowStore) GetByID(_ context.Context, _ int64) (*store.Flow, error) {
	return nil, store.ErrFlowNotFound
}

// fakeProber 用于驱动 ResourceProber 行为。
//
//   - createResource 链路按 dealName 路由（exists / errs）
//   - isolate 链路按 resourceID 路由（isolated / isolateErrs）
//   - destroy 链路按 resourceID 路由（destroyed / destroyErrs，D-9）
type fakeProber struct {
	mu sync.Mutex
	// createResource 链路
	exists map[string]bool  // 默认 false
	errs   map[string]error // 优先于 exists 返回
	// isolate 链路（Sub-5）
	isolated    map[string]bool
	isolateErrs map[string]error
	// destroy 链路（D-9）
	destroyed    map[string]bool
	destroyErrs  map[string]error
	calls        int32 // ProbeResource 调用计数
	isolateCalls int32 // ProbeIsolate 调用计数
	destroyCalls int32 // ProbeDestroy 调用计数
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

func (p *fakeProber) ProbeIsolate(ctx context.Context, resourceID string) (bool, error) {
	atomic.AddInt32(&p.isolateCalls, 1)
	p.mu.Lock()
	defer p.mu.Unlock()
	if e, ok := p.isolateErrs[resourceID]; ok {
		return false, e
	}
	return p.isolated[resourceID], nil
}

func (p *fakeProber) ProbeDestroy(ctx context.Context, resourceID string) (bool, error) {
	atomic.AddInt32(&p.destroyCalls, 1)
	p.mu.Lock()
	defer p.mu.Unlock()
	if e, ok := p.destroyErrs[resourceID]; ok {
		return false, e
	}
	return p.destroyed[resourceID], nil
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
//
// Sub-5：仅有 createResource 兜底场景的测试在用 proberFunc；isolate 路径
// 直接用 fakeProber。本类型 ProbeIsolate / ProbeDestroy 默认返 (false, nil)，对应"未配置"。
type proberFunc func(ctx context.Context, dealName string) (bool, error)

func (f proberFunc) ProbeResource(ctx context.Context, dealName string) (bool, error) {
	return f(ctx, dealName)
}

func (proberFunc) ProbeIsolate(_ context.Context, _ string) (bool, error) {
	return false, nil
}

func (proberFunc) ProbeDestroy(_ context.Context, _ string) (bool, error) {
	return false, nil
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

// MarkCompletedWithResourceID — v1.7.28 BUG-18 新方法的 fake；reconcile 不走本路径，noop。
func (r *recordingFlowStore) MarkCompletedWithResourceID(_ context.Context, _, _, _, _ string, _ []byte) error {
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

// Sub-4 新增方法 — recordingFlowStore 不行使 isolate 链路。
func (r *recordingFlowStore) TryAcquireSlotForIsolate(_ context.Context, _, _, _, _ string, _ []byte, _ *string) (bool, *store.Flow, error) {
	return false, nil, errors.New("not used")
}
func (r *recordingFlowStore) MarkCompletedByID(_ context.Context, _ int64, _ []byte) error {
	return errors.New("not used")
}
func (r *recordingFlowStore) MarkFailedByID(_ context.Context, _ int64, _ []byte) error {
	return errors.New("not used")
}
func (r *recordingFlowStore) DeleteByID(_ context.Context, _ int64) error {
	return errors.New("not used")
}
func (r *recordingFlowStore) GetByID(_ context.Context, _ int64) (*store.Flow, error) {
	return nil, store.ErrFlowNotFound
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
func (c *cutoffCapturingStore) MarkCompletedWithResourceID(_ context.Context, _, _, _, _ string, _ []byte) error {
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

// Sub-4 新增方法 — cutoffCapturingStore 不行使 isolate 链路。
func (c *cutoffCapturingStore) TryAcquireSlotForIsolate(_ context.Context, _, _, _, _ string, _ []byte, _ *string) (bool, *store.Flow, error) {
	return false, nil, errors.New("not used")
}
func (c *cutoffCapturingStore) MarkCompletedByID(_ context.Context, _ int64, _ []byte) error {
	return errors.New("not used")
}
func (c *cutoffCapturingStore) MarkFailedByID(_ context.Context, _ int64, _ []byte) error {
	return errors.New("not used")
}
func (c *cutoffCapturingStore) DeleteByID(_ context.Context, _ int64) error {
	return errors.New("not used")
}
func (c *cutoffCapturingStore) GetByID(_ context.Context, _ int64) (*store.Flow, error) {
	return nil, store.ErrFlowNotFound
}

// ============================================================================
// 编译期断言：Worker 接受任何 store.FlowStore 实现
// ============================================================================

func TestCompileTime_FakeStoreImplementsInterface(t *testing.T) {
	var _ store.FlowStore = (*fakeFlowStore)(nil)
	var _ store.FlowStore = (*recordingFlowStore)(nil)
	var _ store.FlowStore = (*cutoffCapturingStore)(nil)
}

// ============================================================================
// Sub-5 单元测试 — isolate 链路兜底（trade-pass-isolate-design.md §11 Q11 修订版）
// ============================================================================

// helper：构造 isolate 链路的 in_progress 孤儿记录
func newIsolateOrphan(id int64, resourceID, appID string) *store.Flow {
	rid := resourceID
	return &store.Flow{
		ID:          id,
		DealName:    "", // isolate 链路：DB NULL ↔ struct ""
		ResourceID:  &rid,
		Uin:         "100" + appID,
		FlowType:    store.FlowTypeIsolateResource,
		AppID:       appID,
		Status:      store.FlowStatusInProgress,
		CreatedTime: time.Now().Add(-45 * time.Minute),
	}
}

// 用例 1：isolate flow + ProbeIsolate=true → MarkCompletedByID 被调；
// 不调 MarkFailed*，不调 createResource 路径的 MarkCompleted/MarkFailed。
func TestRunOnce_IsolateProbed_PromotesToCompletedByID(t *testing.T) {
	flow := newIsolateOrphan(7001, "lhpass-bj-iso-1", "20001")
	fs := &fakeFlowStore{listResp: []*store.Flow{flow}}
	prober := &fakeProber{
		isolated: map[string]bool{"lhpass-bj-iso-1": true},
	}
	w := New(fs, Config{Logger: discardLogger(), Prober: prober})

	w.runOnce(context.Background())

	if got := fs.markCompletedIDs; len(got) != 1 || got[0] != 7001 {
		t.Errorf("expected MarkCompletedByID(7001), got %v", got)
	}
	if len(fs.markFailedIDs) != 0 {
		t.Errorf("isolate 链路 reconcile 永不应升级 failed; got markFailedIDs=%v", fs.markFailedIDs)
	}
	if len(fs.markCompleted) != 0 || len(fs.markFailed) != 0 {
		t.Errorf("isolate 链路不应触发 createResource 路径; completed=%v failed=%v",
			fs.markCompleted, fs.markFailed)
	}
	if atomic.LoadInt32(&prober.isolateCalls) != 1 {
		t.Errorf("ProbeIsolate called %d times, want 1", prober.isolateCalls)
	}
	if atomic.LoadInt32(&prober.calls) != 0 {
		t.Errorf("ProbeResource (createResource path) should not be called for isolate orphan; got %d", prober.calls)
	}
}

// 用例 2：isolate flow + ProbeIsolate=false → 仅日志，不调 mark*；
// 严格保证 §11 Q11 修订版"isolate 链路 reconcile 不升级 failed"。
func TestRunOnce_IsolateNotYetIsolated_KeepsInProgress(t *testing.T) {
	flow := newIsolateOrphan(7002, "lhpass-bj-iso-pending", "20002")
	fs := &fakeFlowStore{listResp: []*store.Flow{flow}}
	prober := &fakeProber{isolated: map[string]bool{}} // 默认 false
	logger, buf := silentLogger()
	w := New(fs, Config{Logger: logger, Prober: prober})

	w.runOnce(context.Background())

	if len(fs.markCompletedIDs) != 0 {
		t.Errorf("isolated=false 不应升级 completed; got %v", fs.markCompletedIDs)
	}
	if len(fs.markFailedIDs) != 0 {
		t.Errorf("isolate 链路 reconcile 永不应升级 failed; got %v", fs.markFailedIDs)
	}
	if !strings.Contains(buf.String(), "still pending") {
		t.Errorf("expected still-pending log; got %q", buf.String())
	}
	if !strings.Contains(buf.String(), "lhpass-bj-iso-pending") {
		t.Errorf("expected resource_id in log; got %q", buf.String())
	}
}

// 用例 3：isolate flow + ProbeIsolate err → 跳过本轮，不调 mark*。
func TestRunOnce_IsolateProbeError_SkipsRecord(t *testing.T) {
	flow := newIsolateOrphan(7003, "lhpass-bj-iso-err", "20003")
	fs := &fakeFlowStore{listResp: []*store.Flow{flow}}
	prober := &fakeProber{
		isolateErrs: map[string]error{"lhpass-bj-iso-err": errors.New("ctl 5xx")},
	}
	logger, buf := silentLogger()
	w := New(fs, Config{Logger: logger, Prober: prober})

	w.runOnce(context.Background())

	if len(fs.markCompletedIDs) != 0 || len(fs.markFailedIDs) != 0 {
		t.Errorf("probe err 不应触发任何 mark; completedIDs=%v failedIDs=%v",
			fs.markCompletedIDs, fs.markFailedIDs)
	}
	if !strings.Contains(buf.String(), "probe isolate failed") {
		t.Errorf("expected probe-isolate-failed log; got %q", buf.String())
	}
}

// 用例 4：isolate flow 的 ResourceID 为 nil（数据异常防御）→ 仅日志，不调 prober。
func TestRunOnce_IsolateNilResourceID_LogsOnly(t *testing.T) {
	flow := &store.Flow{
		ID:          7004,
		DealName:    "",
		ResourceID:  nil, // 异常数据
		FlowType:    store.FlowTypeIsolateResource,
		AppID:       "20004",
		Status:      store.FlowStatusInProgress,
		CreatedTime: time.Now().Add(-1 * time.Hour),
	}
	fs := &fakeFlowStore{listResp: []*store.Flow{flow}}
	prober := &fakeProber{} // 不应被调用
	logger, buf := silentLogger()
	w := New(fs, Config{Logger: logger, Prober: prober})

	w.runOnce(context.Background())

	if atomic.LoadInt32(&prober.isolateCalls) != 0 {
		t.Errorf("ResourceID=nil 不应触发 ProbeIsolate; got %d calls", prober.isolateCalls)
	}
	if !strings.Contains(buf.String(), "data corruption") {
		t.Errorf("expected data-corruption log; got %q", buf.String())
	}
}

// 用例 5：未知 flow_type → 仅日志，不调 prober。
func TestRunOnce_UnknownFlowType_LogsOnly(t *testing.T) {
	flow := &store.Flow{
		ID:       7005,
		FlowType: "future_flow_type",
		AppID:    "20005",
	}
	fs := &fakeFlowStore{listResp: []*store.Flow{flow}}
	prober := &fakeProber{}
	logger, buf := silentLogger()
	w := New(fs, Config{Logger: logger, Prober: prober})

	w.runOnce(context.Background())

	if atomic.LoadInt32(&prober.calls) != 0 || atomic.LoadInt32(&prober.isolateCalls) != 0 {
		t.Errorf("unknown flow_type 不应触发任何 probe")
	}
	if !strings.Contains(buf.String(), "unknown flow_type") {
		t.Errorf("expected unknown-flow-type log; got %q", buf.String())
	}
}

// 用例 6：混合批量 — createResource + isolate 在同一轮处理，互不干扰。
func TestRunOnce_MixedFlowTypes_RoutedIndependently(t *testing.T) {
	cr := &store.Flow{
		DealName: "deal-cr-1", FlowType: store.FlowTypeCreateResource, AppID: "30001",
	}
	iso := newIsolateOrphan(7100, "lhpass-iso-mix", "30002")
	fs := &fakeFlowStore{listResp: []*store.Flow{cr, iso}}
	prober := &fakeProber{
		exists:   map[string]bool{"deal-cr-1": true},
		isolated: map[string]bool{"lhpass-iso-mix": true},
	}
	w := New(fs, Config{Logger: discardLogger(), Prober: prober})

	w.runOnce(context.Background())

	if len(fs.markCompleted) != 1 || fs.markCompleted[0] != "deal-cr-1" {
		t.Errorf("createResource 路径应 MarkCompleted[deal-cr-1]; got %v", fs.markCompleted)
	}
	if len(fs.markCompletedIDs) != 1 || fs.markCompletedIDs[0] != 7100 {
		t.Errorf("isolate 路径应 MarkCompletedByID(7100); got %v", fs.markCompletedIDs)
	}
	if len(fs.markFailed) != 0 || len(fs.markFailedIDs) != 0 {
		t.Errorf("混合批不应升级 failed; failed=%v failedIDs=%v", fs.markFailed, fs.markFailedIDs)
	}
}

// 不变量集中断言：isolate 链路 reconcile 永不升级 failed。
//
// 设计稿：trade-pass-isolate-design.md §11 Q11 修订版（父 task unbounded 重投至 all-success，
// 永远 result=completed）→ reconcile 兜底必须与该语义对齐。
func TestInvariant_IsolateReconcileNeverPromotesFailed(t *testing.T) {
	flows := []*store.Flow{
		newIsolateOrphan(8001, "iso-true", "1"),  // ProbeIsolate=true → MarkCompletedByID
		newIsolateOrphan(8002, "iso-false", "1"), // ProbeIsolate=false → 仅日志
		newIsolateOrphan(8003, "iso-err", "1"),   // ProbeIsolate err → skip
	}
	fs := &fakeFlowStore{listResp: flows}
	prober := &fakeProber{
		isolated:    map[string]bool{"iso-true": true},
		isolateErrs: map[string]error{"iso-err": errors.New("ctl down")},
	}
	w := New(fs, Config{Logger: discardLogger(), Prober: prober})

	w.runOnce(context.Background())

	if len(fs.markFailedIDs) != 0 {
		t.Fatalf("invariant violated: isolate reconcile 升级了 failed: %v", fs.markFailedIDs)
	}
	if len(fs.markFailed) != 0 {
		t.Fatalf("invariant violated: isolate reconcile 调用了 createResource 路径的 MarkFailed: %v", fs.markFailed)
	}
	if len(fs.markCompletedIDs) != 1 || fs.markCompletedIDs[0] != 8001 {
		t.Errorf("expected exactly MarkCompletedByID[8001]; got %v", fs.markCompletedIDs)
	}
}

// ============================================================================
// D-9 单元测试 — destroyResource 链路兜底（trade-pass-destroy-design.md §3.4 / §6.4）
// 与 isolate Q11 修订版同范式：永远向 completed 收敛，永不升级 failed
// ============================================================================

// helper：构造 destroy 链路的 in_progress 孤儿记录
func newDestroyOrphan(id int64, resourceID, appID string) *store.Flow {
	rid := resourceID
	return &store.Flow{
		ID:          id,
		DealName:    "", // destroy 链路：DB NULL ↔ struct ""（与 isolate 同 schema）
		ResourceID:  &rid,
		Uin:         "100" + appID,
		FlowType:    store.FlowTypeDestroyResource,
		AppID:       appID,
		Status:      store.FlowStatusInProgress,
		CreatedTime: time.Now().Add(-45 * time.Minute),
	}
}

// 用例 D1：destroy flow + ProbeDestroy=true → MarkCompletedByID 被调；
// 不调 MarkFailed*，不调 createResource / isolate 路径。
func TestRunOnce_DestroyProbed_PromotesToCompletedByID(t *testing.T) {
	flow := newDestroyOrphan(9001, "lhpass-bj-des-1", "40001")
	fs := &fakeFlowStore{listResp: []*store.Flow{flow}}
	prober := &fakeProber{
		destroyed: map[string]bool{"lhpass-bj-des-1": true},
	}
	w := New(fs, Config{Logger: discardLogger(), Prober: prober})

	w.runOnce(context.Background())

	if got := fs.markCompletedIDs; len(got) != 1 || got[0] != 9001 {
		t.Errorf("expected MarkCompletedByID(9001), got %v", got)
	}
	if len(fs.markFailedIDs) != 0 {
		t.Errorf("destroy 链路 reconcile 永不应升级 failed; got markFailedIDs=%v", fs.markFailedIDs)
	}
	if len(fs.markCompleted) != 0 || len(fs.markFailed) != 0 {
		t.Errorf("destroy 链路不应触发 createResource 路径; completed=%v failed=%v",
			fs.markCompleted, fs.markFailed)
	}
	if atomic.LoadInt32(&prober.destroyCalls) != 1 {
		t.Errorf("ProbeDestroy called %d times, want 1", prober.destroyCalls)
	}
	if atomic.LoadInt32(&prober.calls) != 0 || atomic.LoadInt32(&prober.isolateCalls) != 0 {
		t.Errorf("destroy orphan 不应触发 ProbeResource / ProbeIsolate; res=%d iso=%d",
			prober.calls, prober.isolateCalls)
	}
}

// 用例 D2：destroy flow + ProbeDestroy=false → 仅日志，不调 mark*；
// 严格保证 D-9"destroy 链路 reconcile 不升级 failed"（与 isolate Q11 同语义）。
func TestRunOnce_DestroyNotYetDestroyed_KeepsInProgress(t *testing.T) {
	flow := newDestroyOrphan(9002, "lhpass-bj-des-pending", "40002")
	fs := &fakeFlowStore{listResp: []*store.Flow{flow}}
	prober := &fakeProber{destroyed: map[string]bool{}} // 默认 false
	logger, buf := silentLogger()
	w := New(fs, Config{Logger: logger, Prober: prober})

	w.runOnce(context.Background())

	if len(fs.markCompletedIDs) != 0 {
		t.Errorf("destroyed=false 不应升级 completed; got %v", fs.markCompletedIDs)
	}
	if len(fs.markFailedIDs) != 0 {
		t.Errorf("destroy 链路 reconcile 永不应升级 failed; got %v", fs.markFailedIDs)
	}
	if !strings.Contains(buf.String(), "destroy orphan still pending") {
		t.Errorf("expected destroy still-pending log; got %q", buf.String())
	}
	if !strings.Contains(buf.String(), "lhpass-bj-des-pending") {
		t.Errorf("expected resource_id in log; got %q", buf.String())
	}
}

// 用例 D3：destroy flow + ProbeDestroy err → 跳过本轮，不调 mark*。
func TestRunOnce_DestroyProbeError_SkipsRecord(t *testing.T) {
	flow := newDestroyOrphan(9003, "lhpass-bj-des-err", "40003")
	fs := &fakeFlowStore{listResp: []*store.Flow{flow}}
	prober := &fakeProber{
		destroyErrs: map[string]error{"lhpass-bj-des-err": errors.New("ctl 5xx")},
	}
	logger, buf := silentLogger()
	w := New(fs, Config{Logger: logger, Prober: prober})

	w.runOnce(context.Background())

	if len(fs.markCompletedIDs) != 0 || len(fs.markFailedIDs) != 0 {
		t.Errorf("probe err 不应触发任何 mark; completedIDs=%v failedIDs=%v",
			fs.markCompletedIDs, fs.markFailedIDs)
	}
	if !strings.Contains(buf.String(), "probe destroy failed") {
		t.Errorf("expected probe-destroy-failed log; got %q", buf.String())
	}
}

// 用例 D4：destroy flow 的 ResourceID 为 nil（数据异常防御）→ 仅日志，不调 prober。
func TestRunOnce_DestroyNilResourceID_LogsOnly(t *testing.T) {
	flow := &store.Flow{
		ID:          9004,
		DealName:    "",
		ResourceID:  nil, // 异常数据
		FlowType:    store.FlowTypeDestroyResource,
		AppID:       "40004",
		Status:      store.FlowStatusInProgress,
		CreatedTime: time.Now().Add(-1 * time.Hour),
	}
	fs := &fakeFlowStore{listResp: []*store.Flow{flow}}
	prober := &fakeProber{} // 不应被调用
	logger, buf := silentLogger()
	w := New(fs, Config{Logger: logger, Prober: prober})

	w.runOnce(context.Background())

	if atomic.LoadInt32(&prober.destroyCalls) != 0 {
		t.Errorf("ResourceID=nil 不应触发 ProbeDestroy; got %d calls", prober.destroyCalls)
	}
	if !strings.Contains(buf.String(), "destroy orphan id=9004") || !strings.Contains(buf.String(), "data corruption") {
		t.Errorf("expected destroy data-corruption log; got %q", buf.String())
	}
}

// 不变量集中断言：destroy 链路 reconcile 永不升级 failed。
//
// 设计稿：trade-pass-destroy-design.md §6.4 与 ctl DestroyPass 父 task "永不放弃"对齐
// → reconcile 兜底必须与该语义对齐（与 isolate Q11 同范式）。
func TestInvariant_DestroyReconcileNeverPromotesFailed(t *testing.T) {
	flows := []*store.Flow{
		newDestroyOrphan(9101, "des-true", "1"),  // ProbeDestroy=true → MarkCompletedByID
		newDestroyOrphan(9102, "des-false", "1"), // ProbeDestroy=false → 仅日志
		newDestroyOrphan(9103, "des-err", "1"),   // ProbeDestroy err → skip
	}
	fs := &fakeFlowStore{listResp: flows}
	prober := &fakeProber{
		destroyed:   map[string]bool{"des-true": true},
		destroyErrs: map[string]error{"des-err": errors.New("ctl down")},
	}
	w := New(fs, Config{Logger: discardLogger(), Prober: prober})

	w.runOnce(context.Background())

	if len(fs.markFailedIDs) != 0 {
		t.Fatalf("invariant violated: destroy reconcile 升级了 failed: %v", fs.markFailedIDs)
	}
	if len(fs.markFailed) != 0 {
		t.Fatalf("invariant violated: destroy reconcile 调用了 createResource 路径的 MarkFailed: %v", fs.markFailed)
	}
	if len(fs.markCompletedIDs) != 1 || fs.markCompletedIDs[0] != 9101 {
		t.Errorf("expected exactly MarkCompletedByID[9101]; got %v", fs.markCompletedIDs)
	}
}

// 占位避免 "declared and not used" 编译错误（防 fmt 在某些 build 下被剔除）
var _ = fmt.Sprint

// ============================================================================
// R-C-6 单元测试 — renewResource 链路兜底（trade-pass-renew-design.md §3.4 / §12 Q13=a）
// ============================================================================
//
// 关键约束（与 isolate Sub-5 对偶）：
//   - trade-side passive：不反查 ctl，不依赖 prober
//   - 永不主动 markFailed（避免 trade=failed/pass=active 不一致）
//   - 永不构造退款响应体（续费已支付，无退款语义）
//   - 仅按 age 做日志分级：
//     * age < 12 月 → 普通 still-pending 日志
//     * age ≥ 12 月 → ALERT 级日志（renew_resource_alert 关键字便于运维筛选）

// helper：构造 renew 链路的 in_progress 孤儿记录。
//   - resource_id 必填（R-A migration 0003 schema 保证 NOT NULL）
//   - flow_type = renew_resource
//   - createdAge 控制相对当前时间的年龄（用于 age 阈值断言）
func newRenewOrphan(id int64, resourceID, appID string, createdAge time.Duration) *store.Flow {
	rid := resourceID
	return &store.Flow{
		ID:          id,
		DealName:    fmt.Sprintf("renew-deal-%d", id), // renew 链路 deal_name 非空（与 createResource 同语义）
		ResourceID:  &rid,
		Uin:         "100" + appID,
		FlowType:    store.FlowTypeRenewResource,
		AppID:       appID,
		Status:      store.FlowStatusInProgress,
		CreatedTime: time.Now().Add(-createdAge),
	}
}

// 用例 1：renew flow age < 12 月 → 普通 still-pending 日志，不调 mark*。
func TestRunOnce_RenewWithinThreshold_KeepsInProgress(t *testing.T) {
	flow := newRenewOrphan(9001, "lhpass-bj-renew-1", "30001", 90*24*time.Hour) // 90 天
	fs := &fakeFlowStore{listResp: []*store.Flow{flow}}
	prober := &fakeProber{} // 不应被调用
	logger, buf := silentLogger()
	w := New(fs, Config{Logger: logger, Prober: prober})

	w.runOnce(context.Background())

	if len(fs.markCompleted) != 0 || len(fs.markFailed) != 0 ||
		len(fs.markCompletedIDs) != 0 || len(fs.markFailedIDs) != 0 {
		t.Errorf("renew reconcile 永不应调用 mark*; completed=%v failed=%v completedIDs=%v failedIDs=%v",
			fs.markCompleted, fs.markFailed, fs.markCompletedIDs, fs.markFailedIDs)
	}
	if atomic.LoadInt32(&prober.calls) != 0 || atomic.LoadInt32(&prober.isolateCalls) != 0 {
		t.Errorf("renew reconcile 不应调用 prober (trade-side passive); ProbeResource=%d ProbeIsolate=%d",
			prober.calls, prober.isolateCalls)
	}
	if !strings.Contains(buf.String(), "renew orphan still pending") {
		t.Errorf("expected 'renew orphan still pending' log; got %q", buf.String())
	}
	if !strings.Contains(buf.String(), "lhpass-bj-renew-1") {
		t.Errorf("expected resource_id in log; got %q", buf.String())
	}
	if strings.Contains(buf.String(), "ALERT") || strings.Contains(buf.String(), "renew_resource_alert") {
		t.Errorf("age < 12 月不应触发 ALERT 日志; got %q", buf.String())
	}
}

// 用例 2：renew flow age ≥ 12 月 → ALERT 级日志（含 renew_resource_alert 关键字）+ 不调 mark*。
func TestRunOnce_RenewBeyondThreshold_AlertsButNoMark(t *testing.T) {
	// 13 月（>12 月阈值）
	flow := newRenewOrphan(9002, "lhpass-bj-renew-stuck", "30002", 13*30*24*time.Hour)
	fs := &fakeFlowStore{listResp: []*store.Flow{flow}}
	prober := &fakeProber{}
	logger, buf := silentLogger()
	w := New(fs, Config{Logger: logger, Prober: prober})

	w.runOnce(context.Background())

	// 严格不变量：永不 markFailed / markCompleted
	if len(fs.markCompleted) != 0 || len(fs.markFailed) != 0 ||
		len(fs.markCompletedIDs) != 0 || len(fs.markFailedIDs) != 0 {
		t.Errorf("Q13=a invariant violated: renew reconcile must never call mark*; got completed=%v failed=%v completedIDs=%v failedIDs=%v",
			fs.markCompleted, fs.markFailed, fs.markCompletedIDs, fs.markFailedIDs)
	}
	if atomic.LoadInt32(&prober.calls) != 0 || atomic.LoadInt32(&prober.isolateCalls) != 0 {
		t.Errorf("renew reconcile 不应调用 prober; ProbeResource=%d ProbeIsolate=%d",
			prober.calls, prober.isolateCalls)
	}
	output := buf.String()
	if !strings.Contains(output, "ALERT") {
		t.Errorf("age ≥ 12 月应触发 ALERT 关键字; got %q", output)
	}
	if !strings.Contains(output, "renew_resource_alert") {
		t.Errorf("age ≥ 12 月应触发 'renew_resource_alert' 关键字便于运维筛选; got %q", output)
	}
	if !strings.Contains(output, "lhpass-bj-renew-stuck") {
		t.Errorf("expected resource_id in ALERT log; got %q", output)
	}
	if !strings.Contains(output, "manual intervention") {
		t.Errorf("expected manual intervention hint in ALERT log; got %q", output)
	}
}

// 用例 3：边界 — age 恰好 ≥ RenewStaleAlertThreshold → ALERT 路径。
//
// 用 Now 注入精确时钟避免运行时漂移。
func TestRunOnce_RenewExactlyAtThreshold_AlertsAtBoundary(t *testing.T) {
	fixed := time.Date(2027, 5, 15, 12, 0, 0, 0, time.UTC)
	// CreatedTime = fixed - RenewStaleAlertThreshold（age 严格等于阈值）
	createdAt := fixed.Add(-RenewStaleAlertThreshold)
	rid := "lhpass-boundary"
	flow := &store.Flow{
		ID:          9003,
		DealName:    "renew-deal-boundary",
		ResourceID:  &rid,
		FlowType:    store.FlowTypeRenewResource,
		AppID:       "30003",
		Status:      store.FlowStatusInProgress,
		CreatedTime: createdAt,
	}
	fs := &fakeFlowStore{listResp: []*store.Flow{flow}}
	logger, buf := silentLogger()
	w := New(fs, Config{
		Logger: logger,
		Now:    func() time.Time { return fixed },
	})

	w.runOnce(context.Background())

	if !strings.Contains(buf.String(), "ALERT") {
		t.Errorf("age == threshold (boundary) 应走 ALERT 路径（>= 阈值条件）; got %q", buf.String())
	}
	if len(fs.markCompleted)+len(fs.markFailed)+len(fs.markCompletedIDs)+len(fs.markFailedIDs) != 0 {
		t.Errorf("边界 ALERT 路径仍不应调 mark*")
	}
}

// 用例 4：renew flow ResourceID=nil（schema 漂移防御）→ 仅日志，不动作。
func TestRunOnce_RenewNilResourceID_LogsOnly(t *testing.T) {
	flow := &store.Flow{
		ID:          9004,
		DealName:    "renew-deal-corrupted",
		ResourceID:  nil, // 异常数据
		FlowType:    store.FlowTypeRenewResource,
		AppID:       "30004",
		Status:      store.FlowStatusInProgress,
		CreatedTime: time.Now().Add(-30 * time.Minute),
	}
	fs := &fakeFlowStore{listResp: []*store.Flow{flow}}
	prober := &fakeProber{}
	logger, buf := silentLogger()
	w := New(fs, Config{Logger: logger, Prober: prober})

	w.runOnce(context.Background())

	if atomic.LoadInt32(&prober.calls) != 0 || atomic.LoadInt32(&prober.isolateCalls) != 0 {
		t.Errorf("ResourceID=nil 不应触发 prober")
	}
	if len(fs.markCompleted)+len(fs.markFailed)+len(fs.markCompletedIDs)+len(fs.markFailedIDs) != 0 {
		t.Errorf("ResourceID=nil 不应触发 mark*")
	}
	if !strings.Contains(buf.String(), "renew orphan id=9004") {
		t.Errorf("expected renew orphan log with id; got %q", buf.String())
	}
	if !strings.Contains(buf.String(), "data corruption") {
		t.Errorf("expected data-corruption log; got %q", buf.String())
	}
}

// 用例 5：Prober==nil 仍能正常处理 renew 链路（trade-side passive，无须 prober）。
//
// 关键不变量：renew 12 月告警必须**穿透 prober==nil 早返门**，否则告警会被静默吞掉。
func TestRunOnce_RenewWithoutProber_StillAlertsAtThreshold(t *testing.T) {
	// 14 月（远 > 12 月阈值）
	flow := newRenewOrphan(9005, "lhpass-bj-renew-no-prober", "30005", 14*30*24*time.Hour)
	fs := &fakeFlowStore{listResp: []*store.Flow{flow}}
	logger, buf := silentLogger()
	w := New(fs, Config{Logger: logger}) // Prober 故意不配置

	w.runOnce(context.Background())

	output := buf.String()
	if !strings.Contains(output, "ALERT") || !strings.Contains(output, "renew_resource_alert") {
		t.Errorf("Prober==nil 时 renew 12 月告警必须仍生效; got %q", output)
	}
	// 不能看到"prober not configured"通用日志（说明 renew 路径在 prober gate 之前已被独立处理）
	if strings.Contains(output, "prober not configured") {
		t.Errorf("renew 路径不应被 prober==nil 通用日志遮蔽; got %q", output)
	}
	if len(fs.markCompleted)+len(fs.markFailed)+len(fs.markCompletedIDs)+len(fs.markFailedIDs) != 0 {
		t.Errorf("Prober==nil renew 路径不应触发 mark*")
	}
}

// 用例 6：混合批 — createResource + isolateResource + renewResource 在同一轮独立处理。
func TestRunOnce_MixedAllThreeFlowTypes_RoutedIndependently(t *testing.T) {
	cr := &store.Flow{
		DealName: "deal-cr-mix-r6", FlowType: store.FlowTypeCreateResource, AppID: "40001",
	}
	iso := newIsolateOrphan(9100, "lhpass-iso-mix-r6", "40002")
	renew := newRenewOrphan(9101, "lhpass-renew-mix-r6", "40003", 60*24*time.Hour) // 60 天 < 12 月

	fs := &fakeFlowStore{listResp: []*store.Flow{cr, iso, renew}}
	prober := &fakeProber{
		exists:   map[string]bool{"deal-cr-mix-r6": true},
		isolated: map[string]bool{"lhpass-iso-mix-r6": true},
	}
	logger, buf := silentLogger()
	w := New(fs, Config{Logger: logger, Prober: prober})

	w.runOnce(context.Background())

	// createResource 路径正常 MarkCompleted
	if len(fs.markCompleted) != 1 || fs.markCompleted[0] != "deal-cr-mix-r6" {
		t.Errorf("createResource 路径应 MarkCompleted[deal-cr-mix-r6]; got %v", fs.markCompleted)
	}
	// isolate 路径正常 MarkCompletedByID
	if len(fs.markCompletedIDs) != 1 || fs.markCompletedIDs[0] != 9100 {
		t.Errorf("isolate 路径应 MarkCompletedByID(9100); got %v", fs.markCompletedIDs)
	}
	// renew 路径不调 mark*
	if len(fs.markFailed) != 0 || len(fs.markFailedIDs) != 0 {
		t.Errorf("混合批不应升级 failed; failed=%v failedIDs=%v", fs.markFailed, fs.markFailedIDs)
	}
	// renew 路径不调 prober
	if atomic.LoadInt32(&prober.calls) != 1 {
		t.Errorf("ProbeResource 应只为 createResource 调用 1 次（不含 renew）; got %d", prober.calls)
	}
	if atomic.LoadInt32(&prober.isolateCalls) != 1 {
		t.Errorf("ProbeIsolate 应只为 isolate 调用 1 次（不含 renew）; got %d", prober.isolateCalls)
	}
	// renew 路径有 still-pending 日志
	if !strings.Contains(buf.String(), "renew orphan still pending") {
		t.Errorf("renew 路径应有 still-pending 日志; got %q", buf.String())
	}
}

// 不变量集中断言（R-C-6）：renew 链路 reconcile 永不升级 failed / completed，
// 永不构造退款响应体。
//
// 设计稿：trade-pass-renew-design.md §3.4 / §12 Q13=a — trade-side passive，
// 续费已支付无退款语义，永远保持 in_progress 直到人工介入。
func TestInvariant_RenewReconcileNeverCallsMark(t *testing.T) {
	// 三种 age 形态都必须保持不变量
	flows := []*store.Flow{
		newRenewOrphan(9201, "renew-fresh", "1", 1*time.Hour),                // 极短
		newRenewOrphan(9202, "renew-mid", "1", 6*30*24*time.Hour),            // 6 月
		newRenewOrphan(9203, "renew-stuck", "1", 14*30*24*time.Hour),         // 14 月（>12 月）
		newRenewOrphan(9204, "renew-stale-extreme", "1", 24*30*24*time.Hour), // 24 月
	}
	fs := &fakeFlowStore{listResp: flows}
	w := New(fs, Config{Logger: discardLogger()}) // 故意不给 prober

	w.runOnce(context.Background())

	if len(fs.markFailed) != 0 || len(fs.markFailedIDs) != 0 {
		t.Fatalf("R-C-6 invariant violated: renew reconcile 升级了 failed: failed=%v failedIDs=%v",
			fs.markFailed, fs.markFailedIDs)
	}
	if len(fs.markCompleted) != 0 || len(fs.markCompletedIDs) != 0 {
		t.Fatalf("R-C-6 invariant violated: renew reconcile 升级了 completed: completed=%v completedIDs=%v",
			fs.markCompleted, fs.markCompletedIDs)
	}
}
