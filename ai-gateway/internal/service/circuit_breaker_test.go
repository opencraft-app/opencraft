package service

import (
	"testing"
	"time"

	"github.com/google/uuid"
)

// newTestConfigStore 创建用于测试的 RuntimeConfigStore（内存 mock）。
func newTestConfigStore(failureThreshold int, cooldownDurationS int) *RuntimeConfigStore {
	return &RuntimeConfigStore{
		config: RoutingConfig{
			FailureThreshold:  failureThreshold,
			CooldownDurationS: cooldownDurationS,
		},
	}
}

func TestCircuitBreaker_InitialState(t *testing.T) {
	cb := NewCircuitBreaker(newTestConfigStore(5, 30))
	pid := uuid.New()

	if cb.IsOpen(pid) {
		t.Error("新提供商的断路器不应该是打开的")
	}
	if cb.GetState(pid) != CircuitClosed {
		t.Errorf("期望 closed，得到 %s", cb.GetState(pid))
	}
}

func TestCircuitBreaker_OpensAfterThreshold(t *testing.T) {
	cb := NewCircuitBreaker(newTestConfigStore(3, 30))
	pid := uuid.New()

	// 3 次失败后应打开
	cb.RecordFailure(pid)
	cb.RecordFailure(pid)
	if cb.IsOpen(pid) {
		t.Error("2 次失败后不应打开")
	}

	cb.RecordFailure(pid)
	if !cb.IsOpen(pid) {
		t.Error("3 次失败后应打开")
	}
	if cb.GetState(pid) != CircuitOpen {
		t.Errorf("期望 open，得到 %s", cb.GetState(pid))
	}
}

func TestCircuitBreaker_ResetOnSuccess(t *testing.T) {
	cb := NewCircuitBreaker(newTestConfigStore(3, 30))
	pid := uuid.New()

	cb.RecordFailure(pid)
	cb.RecordFailure(pid)
	cb.RecordSuccess(pid)

	// 成功后计数应重置
	cb.RecordFailure(pid)
	cb.RecordFailure(pid)
	if cb.IsOpen(pid) {
		t.Error("重置后 2 次失败不应打开")
	}
}

func TestCircuitBreaker_HalfOpenAfterCooldown(t *testing.T) {
	cb := NewCircuitBreaker(newTestConfigStore(2, 1)) // 1 秒冷却
	pid := uuid.New()

	cb.RecordFailure(pid)
	cb.RecordFailure(pid)
	if !cb.IsOpen(pid) {
		t.Error("应该打开")
	}

	// 等待冷却（1 秒）
	time.Sleep(1100 * time.Millisecond)

	// 冷却后应进入半开（IsOpen 返回 false 允许试探）
	if cb.IsOpen(pid) {
		t.Error("冷却后应允许试探请求")
	}
	if cb.GetState(pid) != CircuitHalfOpen {
		t.Errorf("期望 half_open，得到 %s", cb.GetState(pid))
	}
}

func TestCircuitBreaker_HalfOpenSuccess(t *testing.T) {
	cb := NewCircuitBreaker(newTestConfigStore(2, 1)) // 1 秒冷却
	pid := uuid.New()

	cb.RecordFailure(pid)
	cb.RecordFailure(pid)
	time.Sleep(1100 * time.Millisecond)

	// 试探成功 → 关闭
	cb.IsOpen(pid) // 触发半开
	cb.RecordSuccess(pid)

	if cb.GetState(pid) != CircuitClosed {
		t.Errorf("试探成功后应关闭，得到 %s", cb.GetState(pid))
	}
}

func TestCircuitBreaker_MultipleProviders(t *testing.T) {
	cb := NewCircuitBreaker(newTestConfigStore(2, 30))
	pid1 := uuid.New()
	pid2 := uuid.New()

	cb.RecordFailure(pid1)
	cb.RecordFailure(pid1)

	if !cb.IsOpen(pid1) {
		t.Error("pid1 应打开")
	}
	if cb.IsOpen(pid2) {
		t.Error("pid2 不应受影响")
	}
}
