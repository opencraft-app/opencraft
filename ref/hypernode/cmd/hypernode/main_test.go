package main

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"
)

func TestRunServicesWaitsForAllShutdownFlushes(t *testing.T) {
	ctx, stop := context.WithCancel(context.Background())
	var flushed atomic.Bool
	done := make(chan struct{})
	err := runServices(stop, map[string]func() error{
		"failed": func() error { return errors.New("listener failed") },
		"flusher": func() error {
			<-ctx.Done()
			time.Sleep(10 * time.Millisecond)
			flushed.Store(true)
			close(done)
			return nil
		},
	})
	if err == nil || err.Error() != "failed: listener failed" {
		t.Fatalf("unexpected service error: %v", err)
	}
	if !flushed.Load() {
		t.Fatal("runServices returned before the remaining service flushed")
	}
	select {
	case <-done:
	default:
		t.Fatal("flusher did not finish")
	}
}
