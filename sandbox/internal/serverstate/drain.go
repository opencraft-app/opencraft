package serverstate

import "sync/atomic"

// DrainState tracks whether the process is draining and should stop accepting new traffic.
type DrainState struct {
	draining atomic.Bool
}

func NewDrainState() *DrainState {
	return &DrainState{}
}

// BeginDraining marks the process as draining and reports whether the state changed.
func (s *DrainState) BeginDraining() bool {
	return s.draining.CompareAndSwap(false, true)
}

func (s *DrainState) SetDraining(draining bool) {
	s.draining.Store(draining)
}

func (s *DrainState) IsDraining() bool {
	return s.draining.Load()
}
