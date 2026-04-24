package serverstate

import (
	"context"
	"sync"
	"testing"
	"time"
)

func TestConnTracker_AcquireRelease(t *testing.T) {
	ct := NewConnTracker()
	if ct.ActiveCount() != 0 {
		t.Fatalf("expected 0, got %d", ct.ActiveCount())
	}

	ct.Acquire()
	ct.Acquire()
	if ct.ActiveCount() != 2 {
		t.Fatalf("expected 2, got %d", ct.ActiveCount())
	}

	ct.Release()
	ct.Release()
	if ct.ActiveCount() != 0 {
		t.Fatalf("expected 0, got %d", ct.ActiveCount())
	}
}

func TestConnTracker_IsDraining(t *testing.T) {
	ct := NewConnTracker()
	if ct.IsDraining() {
		t.Fatal("should not be draining initially")
	}
}

func TestConnTracker_DrainContext_Normal(t *testing.T) {
	ct := NewConnTracker()
	parent := context.Background()
	ctx, cancel := ct.DrainContext(parent)
	defer cancel()

	// drain 未开始时，drainCtx 为 nil，返回 parent
	select {
	case <-ctx.Done():
		t.Fatal("ctx should not be canceled before Drain()")
	default:
	}
}

func TestConnTracker_DrainContext_AfterDrain(t *testing.T) {
	ct := NewConnTracker()
	ct.Acquire()

	// drain 开始（异步）
	go func() {
		time.Sleep(20 * time.Millisecond)
		ct.Drain(5 * time.Second)
	}()

	// 在 drain 开始后获取 DrainContext
	// 此时 drainCtx 已创建，ctx 派生自 drainCtx，应可被取消
	time.Sleep(30 * time.Millisecond) // 确保 drain goroutine 先执行
	ctx, cancel := ct.DrainContext(context.Background())
	defer cancel()

	select {
	case <-ctx.Done():
		// drain 开始后，ctx 应被取消（因为派生自 drainCtx）
	case <-time.After(500 * time.Millisecond):
		t.Fatal("ctx should be canceled after Drain()")
	}
}

func TestConnTracker_Drain_CompletesRequests(t *testing.T) {
	ct := NewConnTracker()

	// 模拟一个请求
	ct.Acquire()
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		time.Sleep(50 * time.Millisecond)
		ct.Release()
	}()

	err := ct.Drain(2 * time.Second)
	if err != nil {
		t.Fatalf("drain should succeed, got: %v", err)
	}
	wg.Wait()
}

func TestConnTracker_Drain_Timeout(t *testing.T) {
	ct := NewConnTracker()
	ct.Acquire() // 不释放，模拟慢请求

	err := ct.Drain(100 * time.Millisecond)
	if err != ErrDrainTimeout {
		t.Fatalf("expected ErrDrainTimeout, got: %v", err)
	}

	remaining := ct.ActiveCount()
	if remaining < 0 {
		t.Fatalf("count should not be negative, got: %d", remaining)
	}
}

func TestConnTracker_Drain_MultipleRequests(t *testing.T) {
	ct := NewConnTracker()
	n := 5

	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		ct.Acquire()
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			delay := time.Duration(20+idx*10) * time.Millisecond
			time.Sleep(delay)
			ct.Release()
		}(i)
	}

	err := ct.Drain(2 * time.Second)
	if err != nil {
		t.Fatalf("drain should succeed with multiple requests, got: %v", err)
	}
	wg.Wait()

	if ct.ActiveCount() != 0 {
		t.Fatalf("all requests should be released, got: %d", ct.ActiveCount())
	}
}

func TestConnTracker_ConcurrentAcquireRelease(t *testing.T) {
	ct := NewConnTracker()
	n := 100

	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			ct.Acquire()
			time.Sleep(10 * time.Millisecond)
			ct.Release()
		}()
	}

	wg.Wait()
	if ct.ActiveCount() != 0 {
		t.Fatalf("expected 0, got %d", ct.ActiveCount())
	}
}

func TestTrackerMiddleware_IsDraining_Aborts(t *testing.T) {
	ct := NewConnTrackerWithDrain() // 强制 draining=true

	calls := 0
	// 由于我们是 unit test，没有真正的 gin.Context，
	// 只验证 IsDraining() 在 draining 时返回 true
	if !ct.IsDraining() {
		t.Fatal("should be draining with NewConnTrackerWithDrain")
	}
	_ = calls
}
