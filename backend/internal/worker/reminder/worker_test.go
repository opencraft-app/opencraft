package reminder

import (
	"context"
	"sync"
	"testing"
	"time"
)

type fakeProcessor struct {
	mu      sync.Mutex
	results []bool
	calls   int
}

func (processor *fakeProcessor) ProcessOne(context.Context) (bool, error) {
	processor.mu.Lock()
	defer processor.mu.Unlock()
	processor.calls++
	if len(processor.results) == 0 {
		return false, nil
	}
	value := processor.results[0]
	processor.results = processor.results[1:]
	return value, nil
}

func TestWorkerDrainsDueRemindersAndStopsWithContext(t *testing.T) {
	processor := &fakeProcessor{results: []bool{true, true, false}}
	worker, err := New(processor, Config{PollInterval: time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- worker.Run(ctx) }()
	deadline := time.After(time.Second)
	for {
		processor.mu.Lock()
		calls := processor.calls
		processor.mu.Unlock()
		if calls >= 3 {
			break
		}
		select {
		case <-deadline:
			t.Fatal("worker did not drain reminders")
		default:
			time.Sleep(time.Millisecond)
		}
	}
	cancel()
	if err := <-done; err != nil {
		t.Fatalf("Run() error = %v", err)
	}
}
