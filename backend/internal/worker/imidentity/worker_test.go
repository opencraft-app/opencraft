package imidentity

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"
)

type sequenceProcessor struct {
	mu      sync.Mutex
	results []bool
	err     error
	calls   int
	reached chan struct{}
	once    sync.Once
}

func (processor *sequenceProcessor) ProcessOne(
	context.Context,
) (bool, error) {
	processor.mu.Lock()
	defer processor.mu.Unlock()
	processor.calls++
	if processor.calls >= 3 && processor.reached != nil {
		processor.once.Do(func() { close(processor.reached) })
	}
	if processor.err != nil {
		return false, processor.err
	}
	index := processor.calls - 1
	if index < len(processor.results) {
		return processor.results[index], nil
	}
	return false, nil
}

func TestWorkerImmediatelyDrainsAvailableWorkThenWaits(t *testing.T) {
	processor := &sequenceProcessor{
		results: []bool{true, true, false},
		reached: make(chan struct{}),
	}
	worker, err := New(processor, Config{PollInterval: time.Hour})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- worker.Run(ctx) }()

	select {
	case <-processor.reached:
		cancel()
	case <-time.After(time.Second):
		t.Fatal("worker did not drain available work")
	}
	if err := <-done; err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	processor.mu.Lock()
	calls := processor.calls
	processor.mu.Unlock()
	if calls != 3 {
		t.Fatalf("ProcessOne() calls = %d, want 3", calls)
	}
}

func TestWorkerReturnsFatalRepositoryError(t *testing.T) {
	want := errors.New("database unavailable")
	worker, err := New(
		&sequenceProcessor{err: want},
		Config{PollInterval: time.Millisecond},
	)
	if err != nil {
		t.Fatal(err)
	}
	if err := worker.Run(context.Background()); !errors.Is(err, want) {
		t.Fatalf("Run() error = %v", err)
	}
}
