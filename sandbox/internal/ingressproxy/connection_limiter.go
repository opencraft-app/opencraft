package ingressproxy

import (
	"sync"
	"sync/atomic"
)

type ConnectionLimiter struct {
	counters sync.Map
}

func NewConnectionLimiter() *ConnectionLimiter {
	return &ConnectionLimiter{}
}

func (l *ConnectionLimiter) getCounter(key string) *atomic.Int64 {
	if v, ok := l.counters.Load(key); ok {
		return v.(*atomic.Int64)
	}
	counter := &atomic.Int64{}
	actual, _ := l.counters.LoadOrStore(key, counter)
	return actual.(*atomic.Int64)
}

func (l *ConnectionLimiter) TryAcquire(key string, maxLimit int) (int64, bool) {
	if l == nil || key == "" {
		return 0, true
	}
	counter := l.getCounter(key)
	for {
		current := counter.Load()
		if maxLimit >= 0 && current >= int64(maxLimit) {
			return current, false
		}
		if counter.CompareAndSwap(current, current+1) {
			return current + 1, true
		}
	}
}

func (l *ConnectionLimiter) Release(key string) int64 {
	if l == nil || key == "" {
		return 0
	}
	v, ok := l.counters.Load(key)
	if !ok {
		return 0
	}
	counter := v.(*atomic.Int64)
	for {
		current := counter.Load()
		if current <= 0 {
			return 0
		}
		if counter.CompareAndSwap(current, current-1) {
			next := current - 1
			if next == 0 {
				l.counters.Delete(key)
			}
			return next
		}
	}
}

func (l *ConnectionLimiter) Count(key string) int64 {
	if l == nil || key == "" {
		return 0
	}
	if v, ok := l.counters.Load(key); ok {
		return v.(*atomic.Int64).Load()
	}
	return 0
}
