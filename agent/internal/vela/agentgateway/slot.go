package agentgateway

import (
	"sync"

	"github.com/QuantumNous/new-api/research/raft-computer-1.0.13/go-client/internal/vela/im"
)

// TransportSlot tracks the currently authenticated IM launch without giving
// the local HTTP Gateway ownership of its lifecycle.
type TransportSlot struct {
	mu         sync.RWMutex
	transport  im.Transport
	generation uint64
}

type TransportBinding struct {
	slot       *TransportSlot
	generation uint64
	once       sync.Once
}

func NewTransportSlot() *TransportSlot {
	return &TransportSlot{}
}

func (s *TransportSlot) Bind(
	transport im.Transport,
) *TransportBinding {
	if s == nil || transport == nil {
		return &TransportBinding{}
	}
	s.mu.Lock()
	s.generation++
	generation := s.generation
	s.transport = transport
	s.mu.Unlock()
	return &TransportBinding{
		slot:       s,
		generation: generation,
	}
}

func (s *TransportSlot) Current() im.Transport {
	if s == nil {
		return nil
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.transport
}

func (b *TransportBinding) Release() {
	if b == nil {
		return
	}
	b.once.Do(func() {
		if b.slot == nil {
			return
		}
		b.slot.mu.Lock()
		if b.slot.generation == b.generation {
			b.slot.transport = nil
		}
		b.slot.mu.Unlock()
	})
}
