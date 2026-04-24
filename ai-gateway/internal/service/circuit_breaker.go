package service

import (
	"context"
	"encoding/json"
	"log/slog"
	"sync"
	"time"

	"git.woa.com/wisp/mono/ai-gateway/internal/pkg/redisclient"
	"github.com/google/uuid"
)

// 断路器状态
const (
	CircuitClosed   = "closed"    // 正常
	CircuitOpen     = "open"      // 断开（熔断）
	CircuitHalfOpen = "half_open" // 半开（试探）
)

const circuitBreakerChannel = "circuit_breaker:events"

// circuitEvent 描述一次断路器状态变更事件（用于 Redis Pub/Sub 广播）。
type circuitEvent struct {
	InstanceID       string `json:"instance_id"`        // 来源实例 ID，过滤自身消息
	ProviderID       string `json:"provider_id"`
	NewState         string `json:"new_state"`
	ConsecutiveFails int    `json:"consecutive_fails"`
	LastFailTime     int64  `json:"last_fail_time_ms"`
}

// DistributedCircuitBreaker 多实例共享的分布式断路器。
// - 本地维护内存状态，保证热路径（IsOpen）零网络开销
// - 状态变更通过 Redis Pub/Sub 广播到所有实例
// - 每个实例收到广播后同步更新本地状态（自身消息会被过滤）
type DistributedCircuitBreaker struct {
	mu         sync.RWMutex
	local      *CircuitBreaker   // 组合本地断路器
	redis      *redisclient.Client
	ctx        context.Context
	cancel     context.CancelFunc
	subscribed bool
	instanceID string // 实例唯一标识，用于过滤自身广播消息
}

// CircuitBreaker 轻量级断路器，按提供商隔离。
// 连续失败达到阈值后打开，冷却期后半开允许一次试探。
type CircuitBreaker struct {
	mu          sync.RWMutex
	breakers    map[uuid.UUID]*providerBreaker
	configStore *RuntimeConfigStore
}

type providerBreaker struct {
	state            string
	consecutiveFails int
	lastFailTime     time.Time
}

// NewDistributedCircuitBreaker 创建分布式断路器，启动 Redis 订阅监听。
// 如果 redisClient 为 nil，退化为纯内存模式（单机）。
func NewDistributedCircuitBreaker(redisClient *redisclient.Client, configStore *RuntimeConfigStore) *DistributedCircuitBreaker {
	ctx, cancel := context.WithCancel(context.Background())
	cb := &DistributedCircuitBreaker{
		local: &CircuitBreaker{
			breakers:    make(map[uuid.UUID]*providerBreaker),
			configStore: configStore,
		},
		redis:      redisClient,
		ctx:        ctx,
		cancel:     cancel,
		instanceID: uuid.NewString(),
	}

	if redisClient != nil {
		go cb.subscribe()
	}

	return cb
}

// subscribe 订阅 Redis 频道，接收来自其他实例的断路器事件。
func (cb *DistributedCircuitBreaker) subscribe() {
	pubsub := cb.redis.Subscribe(cb.ctx, circuitBreakerChannel)
	defer pubsub.Close()

	ch := pubsub.Channel()
	if ch == nil {
		slog.Warn("circuit breaker: failed to subscribe to Redis channel")
		return
	}
	for {
		select {
		case <-cb.ctx.Done():
			return
		case msg, ok := <-ch:
			if !ok {
				return
			}
			var ev circuitEvent
			if err := json.Unmarshal([]byte(msg.Payload), &ev); err != nil {
				slog.Warn("circuit breaker: failed to unmarshal event", "error", err)
				continue
			}
			// 过滤自身消息，避免 Pub/Sub 延迟导致的状态覆盖
			if ev.InstanceID == cb.instanceID {
				continue
			}
			providerID, err := uuid.Parse(ev.ProviderID)
			if err != nil {
				continue
			}
			cb.applyRemoteEvent(providerID, ev.NewState, ev.ConsecutiveFails, ev.LastFailTime)
		}
	}
}

// applyRemoteEvent 将来自其他实例的事件应用到本地状态。
func (cb *DistributedCircuitBreaker) applyRemoteEvent(providerID uuid.UUID, state string, consecutiveFails int, lastFailTimeMs int64) {
	cb.local.mu.Lock()
	defer cb.local.mu.Unlock()

	b, exists := cb.local.breakers[providerID]
	if !exists {
		b = &providerBreaker{state: CircuitClosed}
		cb.local.breakers[providerID] = b
	}

	// 优先采用更严重的故障状态，避免状态回退
	shouldUpdate := false
	if state == CircuitOpen {
		shouldUpdate = b.state != CircuitOpen
	} else if state == CircuitHalfOpen {
		shouldUpdate = b.state == CircuitClosed
	} else if state == CircuitClosed {
		shouldUpdate = b.state != CircuitClosed
	}

	if shouldUpdate {
		b.state = state
		b.consecutiveFails = consecutiveFails
		b.lastFailTime = time.UnixMilli(lastFailTimeMs)
	}
}

// broadcast 向 Redis 发布状态变更事件。
func (cb *DistributedCircuitBreaker) broadcast(providerID uuid.UUID, state string, consecutiveFails int) {
	if cb.redis == nil {
		return
	}
	ev := circuitEvent{
		InstanceID:       cb.instanceID,
		ProviderID:       providerID.String(),
		NewState:        state,
		ConsecutiveFails: consecutiveFails,
		LastFailTime:     time.Now().UnixMilli(),
	}
	data, _ := json.Marshal(ev)
	// 使用独立 context，避免 subscribe 的 ctx 被 cancel 后广播失败
	if err := cb.redis.Publish(context.Background(), circuitBreakerChannel, data).Err(); err != nil {
		slog.Warn("circuit breaker: failed to broadcast event", "error", err)
	}
}

// Stop 取消订阅，停止协程。
func (cb *DistributedCircuitBreaker) Stop() {
	if cb.cancel != nil {
		cb.cancel()
	}
}

// IsOpen 检查指定提供商的断路器是否打开。
func (cb *DistributedCircuitBreaker) IsOpen(providerID uuid.UUID) bool {
	return cb.local.IsOpen(providerID)
}

// RecordSuccess 记录成功请求，重置断路器，并将状态变更广播到其他实例。返回本次调用后的状态。
func (cb *DistributedCircuitBreaker) RecordSuccess(providerID uuid.UUID) string {
	oldState := cb.local.GetState(providerID)
	state := cb.local.RecordSuccess(providerID)
	if state != oldState {
		cb.broadcast(providerID, state, 0)
	}
	return state
}

// RecordFailure 记录失败请求。连续失败达到阈值后打开断路器，并将状态变更广播到其他实例。返回本次调用后的状态和连续失败计数。
func (cb *DistributedCircuitBreaker) RecordFailure(providerID uuid.UUID) (string, int) {
	oldState := cb.local.GetState(providerID)
	state, consecutiveFails := cb.local.RecordFailure(providerID)
	if state != oldState {
		cb.broadcast(providerID, state, consecutiveFails)
	}
	return state, consecutiveFails
}

// GetState 返回指定提供商的断路器状态（用于监控）。
func (cb *DistributedCircuitBreaker) GetState(providerID uuid.UUID) string {
	return cb.local.GetState(providerID)
}

// ----- 本地 CircuitBreaker（内部实现） -----

// NewCircuitBreaker 创建断路器实例（纯内存，单实例使用）。
func NewCircuitBreaker(configStore *RuntimeConfigStore) *CircuitBreaker {
	return &CircuitBreaker{
		breakers:    make(map[uuid.UUID]*providerBreaker),
		configStore: configStore,
	}
}

// IsOpen 检查指定提供商的断路器是否打开。
// 如果处于半开状态则允许通过（试探请求）。
func (cb *CircuitBreaker) IsOpen(providerID uuid.UUID) bool {
	cb.mu.Lock()
	defer cb.mu.Unlock()

	b, exists := cb.breakers[providerID]
	if !exists {
		return false
	}

	if b.state == CircuitClosed {
		return false
	}

	if b.state == CircuitOpen {
		// 检查是否已过冷却期 → 半开（状态转换必须在持有写锁时完成以避免竞态）
		if time.Since(b.lastFailTime) >= time.Duration(cb.configStore.Get().CooldownDurationS)*time.Second {
			b.state = CircuitHalfOpen
			return false // 允许试探
		}
		return true // 仍在熔断
	}

	// half_open: 允许通过
	return false
}

// RecordSuccess 记录成功请求，重置断路器。
// 返回本次调用后的状态。
func (cb *CircuitBreaker) RecordSuccess(providerID uuid.UUID) string {
	cb.mu.Lock()
	defer cb.mu.Unlock()

	b, exists := cb.breakers[providerID]
	if !exists {
		return CircuitClosed
	}

	b.state = CircuitClosed
	b.consecutiveFails = 0
	return b.state
}

// RecordFailure 记录失败请求。连续失败达到阈值后打开断路器。
// 返回本次调用后的状态和连续失败计数。
func (cb *CircuitBreaker) RecordFailure(providerID uuid.UUID) (string, int) {
	cb.mu.Lock()
	defer cb.mu.Unlock()

	b, exists := cb.breakers[providerID]
	if !exists {
		b = &providerBreaker{state: CircuitClosed}
		cb.breakers[providerID] = b
	}

	b.consecutiveFails++
	b.lastFailTime = time.Now()

	if b.consecutiveFails >= cb.configStore.Get().FailureThreshold {
		b.state = CircuitOpen
	}
	return b.state, b.consecutiveFails
}

// GetState 返回指定提供商的断路器状态（用于监控）。
func (cb *CircuitBreaker) GetState(providerID uuid.UUID) string {
	cb.mu.RLock()
	defer cb.mu.RUnlock()

	b, exists := cb.breakers[providerID]
	if !exists {
		return CircuitClosed
	}
	return b.state
}
