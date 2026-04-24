package serverstate

import "sync/atomic"

// DrainState tracks whether the process is draining and should stop accepting new traffic.
type DrainState struct {
	draining atomic.Bool
}

var defaultDrainState = NewDrainState()

func NewDrainState() *DrainState {
	return &DrainState{}
}

func DefaultDrainState() *DrainState {
	return defaultDrainState
}

func (s *DrainState) SetDraining(draining bool) {
	s.draining.Store(draining)
}

func (s *DrainState) IsDraining() bool {
	return s.draining.Load()
}
