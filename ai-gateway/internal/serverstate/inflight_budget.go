package serverstate

import "sync"

// InflightBudget tracks weighted in-flight capacity for proxy requests.
type InflightBudget struct {
	mu   sync.Mutex
	max  int64
	used int64
}

func NewInflightBudget(max int64) *InflightBudget {
	return &InflightBudget{max: max}
}

func (b *InflightBudget) TryAcquire(weight int64) (func(), bool) {
	if b == nil || b.max <= 0 || weight <= 0 {
		return func() {}, true
	}

	b.mu.Lock()
	defer b.mu.Unlock()
	if b.used+weight > b.max {
		return nil, false
	}
	b.used += weight

	released := false
	return func() {
		b.mu.Lock()
		defer b.mu.Unlock()
		if released {
			return
		}
		b.used -= weight
		if b.used < 0 {
			b.used = 0
		}
		released = true
	}, true
}

func (b *InflightBudget) Used() int64 {
	if b == nil {
		return 0
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.used
}
