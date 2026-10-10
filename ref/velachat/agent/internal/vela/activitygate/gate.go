package activitygate

import (
	"context"
	"errors"
	"sync"
)

var (
	ErrInvalid  = errors.New("Vela activity gate 配置无效")
	ErrDraining = errors.New("Vela activity gate 正在排空")
)

type Kind string

const (
	AgentTurn       Kind = "agent_turn"
	TerminalSession Kind = "terminal_session"
	TATTask         Kind = "tat_task"
)

type Gate struct {
	mu         sync.Mutex
	active     map[Kind]int
	total      int
	draining   bool
	generation uint64
	ready      chan struct{}
}

type Lease struct {
	once sync.Once
	gate *Gate
	kind Kind
}

type DrainPermit struct {
	once       sync.Once
	gate       *Gate
	generation uint64
}

type Snapshot struct {
	Draining bool
	Active   map[Kind]int
	Total    int
}

func New() *Gate {
	return &Gate{active: make(map[Kind]int)}
}

func (gate *Gate) Acquire(ctx context.Context, kind Kind) (*Lease, error) {
	if gate == nil || ctx == nil || !validKind(kind) {
		return nil, ErrInvalid
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	gate.mu.Lock()
	defer gate.mu.Unlock()
	if gate.draining {
		return nil, ErrDraining
	}
	gate.active[kind]++
	gate.total++
	return &Lease{gate: gate, kind: kind}, nil
}

func (lease *Lease) Release() {
	if lease == nil {
		return
	}
	lease.once.Do(func() {
		gate := lease.gate
		if gate == nil {
			return
		}
		gate.mu.Lock()
		if gate.active[lease.kind] > 0 {
			gate.active[lease.kind]--
			gate.total--
			if gate.active[lease.kind] == 0 {
				delete(gate.active, lease.kind)
			}
		}
		if gate.draining && gate.total == 0 && gate.ready != nil {
			close(gate.ready)
			gate.ready = nil
		}
		gate.mu.Unlock()
	})
}

func (gate *Gate) Drain(ctx context.Context) (*DrainPermit, error) {
	if gate == nil || ctx == nil {
		return nil, ErrInvalid
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	gate.mu.Lock()
	if gate.draining {
		gate.mu.Unlock()
		return nil, ErrDraining
	}
	gate.draining = true
	gate.generation++
	generation := gate.generation
	if gate.total == 0 {
		gate.mu.Unlock()
		return &DrainPermit{gate: gate, generation: generation}, nil
	}
	ready := make(chan struct{})
	gate.ready = ready
	gate.mu.Unlock()

	select {
	case <-ctx.Done():
		gate.cancelDrain(generation)
		return nil, ctx.Err()
	case <-ready:
		return &DrainPermit{gate: gate, generation: generation}, nil
	}
}

func (permit *DrainPermit) Release() {
	if permit == nil {
		return
	}
	permit.once.Do(func() {
		permit.gate.cancelDrain(permit.generation)
	})
}

func (gate *Gate) Snapshot() Snapshot {
	if gate == nil {
		return Snapshot{}
	}
	gate.mu.Lock()
	defer gate.mu.Unlock()
	active := make(map[Kind]int, len(gate.active))
	for kind, count := range gate.active {
		active[kind] = count
	}
	return Snapshot{Draining: gate.draining, Active: active, Total: gate.total}
}

func (gate *Gate) cancelDrain(generation uint64) {
	if gate == nil {
		return
	}
	gate.mu.Lock()
	defer gate.mu.Unlock()
	if gate.draining && gate.generation == generation {
		gate.draining = false
		gate.ready = nil
	}
}

func validKind(kind Kind) bool {
	switch kind {
	case AgentTurn, TerminalSession, TATTask:
		return true
	default:
		return false
	}
}
