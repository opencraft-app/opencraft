package main

import (
	"fmt"
	"sync"
	"time"
)

type loadStats struct {
	mu      sync.Mutex
	windows map[int]*windowStats
}

type windowStats struct {
	Phase         int              `json:"phase"`
	NormalTotal   int64            `json:"normal_total"`
	NormalSuccess int64            `json:"normal_success"`
	SSETotal      int64            `json:"sse_total"`
	SSESuccess    int64            `json:"sse_success"`
	ShortestSSE   time.Duration    `json:"shortest_sse"`
	LongestSSE    time.Duration    `json:"longest_sse"`
	Errors        map[string]int64 `json:"errors,omitempty"`
}

func newLoadStats() *loadStats {
	return &loadStats{windows: make(map[int]*windowStats)}
}

func (s *loadStats) recordNormal(phase int, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	w := s.mutableWindow(phase)
	w.NormalTotal++
	if err == nil {
		w.NormalSuccess++
		return
	}
	w.Errors[err.Error()]++
}

func (s *loadStats) recordSSE(phase int, duration time.Duration, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	w := s.mutableWindow(phase)
	w.SSETotal++
	if w.ShortestSSE == 0 || duration < w.ShortestSSE {
		w.ShortestSSE = duration
	}
	if duration > w.LongestSSE {
		w.LongestSSE = duration
	}
	if err == nil {
		w.SSESuccess++
		return
	}
	w.Errors[err.Error()]++
}

func (s *loadStats) window(phase int) windowStats {
	s.mu.Lock()
	defer s.mu.Unlock()
	w := s.mutableWindow(phase)
	copy := *w
	copy.Errors = make(map[string]int64, len(w.Errors))
	for key, value := range w.Errors {
		copy.Errors[key] = value
	}
	return copy
}

func (s *loadStats) mutableWindow(phase int) *windowStats {
	if existing := s.windows[phase]; existing != nil {
		return existing
	}
	w := &windowStats{Phase: phase, Errors: make(map[string]int64)}
	s.windows[phase] = w
	return w
}

func (w windowStats) validate(normalSuccessRate, sseSuccessRate float64, minimumSSEDuration time.Duration) error {
	if w.NormalTotal == 0 {
		return fmt.Errorf("phase %d produced no normal requests", w.Phase)
	}
	if w.SSETotal == 0 {
		return fmt.Errorf("phase %d produced no SSE requests", w.Phase)
	}
	if actual := float64(w.NormalSuccess) / float64(w.NormalTotal); actual < normalSuccessRate {
		return fmt.Errorf("phase %d normal success rate %.5f is below %.5f", w.Phase, actual, normalSuccessRate)
	}
	if actual := float64(w.SSESuccess) / float64(w.SSETotal); actual < sseSuccessRate {
		return fmt.Errorf("phase %d SSE success rate %.5f is below %.5f", w.Phase, actual, sseSuccessRate)
	}
	if w.ShortestSSE < minimumSSEDuration {
		return fmt.Errorf("phase %d shortest SSE duration %s is below %s", w.Phase, w.ShortestSSE, minimumSSEDuration)
	}
	return nil
}
