package policy

import "sync"

// wakeBroadcaster coalesces edge-triggered host events while still waking every
// active transport. Subscribers must always re-drain their own authoritative
// queue; the notification itself carries no state.
type wakeBroadcaster struct {
	mu          sync.Mutex
	nextID      uint64
	subscribers map[uint64]chan struct{}
}

func newWakeBroadcaster() *wakeBroadcaster {
	return &wakeBroadcaster{subscribers: make(map[uint64]chan struct{})}
}

func (b *wakeBroadcaster) notify() {
	b.mu.Lock()
	defer b.mu.Unlock()
	for _, subscriber := range b.subscribers {
		select {
		case subscriber <- struct{}{}:
		default:
		}
	}
}

func (b *wakeBroadcaster) subscribe() (<-chan struct{}, func()) {
	b.mu.Lock()
	b.nextID++
	id := b.nextID
	channel := make(chan struct{}, 1)
	b.subscribers[id] = channel
	b.mu.Unlock()
	var once sync.Once
	return channel, func() {
		once.Do(func() {
			b.mu.Lock()
			delete(b.subscribers, id)
			b.mu.Unlock()
		})
	}
}
