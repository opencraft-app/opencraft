package serverstate

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gin-gonic/gin"
)

var ErrDrainTimeout = errors.New("drain timeout: not all connections finished in time")

// ConnTracker 追踪所有活跃 HTTP 请求。
// 在 drain 阶段等待所有请求自然完成，实现真正的零中断优雅关闭。
//
// 机制：
//   - Acquire/Release 追踪活跃请求数
//   - Drain() 标记 draining=true 并创建 drainCtx，所有活跃请求共享此 ctx
//   - drainCancel() 被调用时，所有派生自 drainCtx 的请求 context 立即收到取消信号
//   - SSE scanner goroutine 阻塞在 resp.Body.Read() 时，context 取消会触发 transport 中断，goroutine 退出
type ConnTracker struct {
	wg       sync.WaitGroup
	count    atomic.Int64
	draining atomic.Bool

	mu          sync.RWMutex
	drainCtx    context.Context // 启动时创建，所有请求都可订阅该取消信号
	drainCancel context.CancelFunc
}

// NewConnTracker 创建新的连接追踪器。
func NewConnTracker() *ConnTracker {
	ctx, cancel := context.WithCancel(context.Background())
	return &ConnTracker{
		drainCtx:    ctx,
		drainCancel: cancel,
	}
}

// NewConnTrackerWithDrain 创建连接追踪器并预先进入 draining 状态。
// 用于测试或在 drain 已开始时注册新请求。
func NewConnTrackerWithDrain() *ConnTracker {
	ct := NewConnTracker()
	ct.draining.Store(true)
	ct.drainCancel()
	return ct
}

// Acquire 在每个请求进入时调用，注册到 WaitGroup 并增加计数。
// 线程安全，可并发调用。
func (t *ConnTracker) Acquire() {
	t.wg.Add(1)
	t.count.Add(1)
}

// Release 在每个请求处理完成时调用，从 WaitGroup 注销。
func (t *ConnTracker) Release() {
	t.wg.Done()
	t.count.Add(-1)
}

// IsDraining 返回当前是否处于 draining 状态。
func (t *ConnTracker) IsDraining() bool {
	return t.draining.Load()
}

// ActiveCount 返回当前活跃请求数。
func (t *ConnTracker) ActiveCount() int64 {
	return t.count.Load()
}

// DrainContext 为请求创建一个可被 drain 取消的 context。
//
// 正常阶段：drainCtx 尚未创建，返回 parent context。
// drain 阶段：所有请求共享同一个 drainCtx，drainCancel() 被调用时全部收到取消信号。
func (t *ConnTracker) DrainContext(parent context.Context) (context.Context, context.CancelFunc) {
	t.mu.RLock()
	defer t.mu.RUnlock()

	reqCtx, reqCancel := context.WithCancel(parent)
	go func() {
		select {
		case <-t.drainCtx.Done():
			reqCancel()
		case <-reqCtx.Done():
		}
	}()
	return reqCtx, reqCancel
}

// Drain 开始排空流程：
//
//  1. 标记 draining=true（/ready 立即返回 503，新请求被拦截）
//  2. 创建 drainCtx，所有活跃请求通过 DrainContext() 获取此 ctx
//  3. drainCancel 触发时，所有共享 drainCtx 的请求立即取消
//  4. 等待 WaitGroup 归零
//
// 超时返回 ErrDrainTimeout，此时所有请求的 context 已全部取消，
// HTTP Server 最终会强制关闭剩余连接。
func (t *ConnTracker) Drain(timeout time.Duration) error {
	t.draining.Store(true)

	active := t.count.Load()
	slog.Info("drain started", "active_connections", active)
	t.drainCancel() // 立即取消，所有 SSE scanner goroutine 退出
	slog.Info("drain cancel broadcast sent", "active_connections", active)

	// 等待所有活跃请求完成
	done := make(chan struct{})
	go func() {
		t.wg.Wait()
		close(done)
	}()

	select {
	case <-done:
		slog.Info("drain completed: all active requests finished",
			"remaining_connections", t.count.Load())
		return nil
	case <-time.After(timeout):
		remaining := t.count.Load()
		slog.Warn("drain timeout: forcing shutdown",
			"remaining_connections", remaining,
			"timeout", timeout.String(),
		)
		return ErrDrainTimeout
	}
}

// TrackerMiddleware 返回一个 Gin 中间件，在 draining 状态下返回 503。
//
// 在所有认证之前拦截，保证 drain 阶段新请求直接被拒绝，无需经过认证逻辑。
// 为每个请求创建派生自 drainCtx 的 context，使 drain 时可立即取消所有活跃请求。
func TrackerMiddleware(ct *ConnTracker) gin.HandlerFunc {
	return func(c *gin.Context) {
		if c.Request.URL.Path == "/health" || c.Request.URL.Path == "/ready" {
			c.Next()
			return
		}

		if ct.IsDraining() {
			c.AbortWithStatusJSON(http.StatusServiceUnavailable, gin.H{
				"error": "server is draining, please retry later",
			})
			return
		}

		// 获取 drain-aware context（共享同一个 drainCtx）
		ctx, cancel := ct.DrainContext(c.Request.Context())
		defer cancel()
		c.Request = c.Request.WithContext(ctx)

		ct.Acquire()
		defer ct.Release()

		c.Next()
	}
}
