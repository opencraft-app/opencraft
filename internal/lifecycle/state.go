package lifecycle

import "sync/atomic"

type State struct {
	draining atomic.Bool
}

func NewState() *State {
	return &State{}
}

func (s *State) BeginDraining() {
	if s != nil {
		s.draining.Store(true)
	}
}

func (s *State) IsDraining() bool {
	return s != nil && s.draining.Load()
}
