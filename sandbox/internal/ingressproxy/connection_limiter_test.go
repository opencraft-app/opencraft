package ingressproxy

import (
	"sync"
	"testing"
)

func TestConnectionLimiterTryAcquireAndRelease(t *testing.T) {
	t.Parallel()

	limiter := NewConnectionLimiter()

	count, ok := limiter.TryAcquire("sandbox-a", 2)
	if !ok || count != 1 {
		t.Fatalf("first acquire mismatch: ok=%v count=%d", ok, count)
	}
	count, ok = limiter.TryAcquire("sandbox-a", 2)
	if !ok || count != 2 {
		t.Fatalf("second acquire mismatch: ok=%v count=%d", ok, count)
	}
	count, ok = limiter.TryAcquire("sandbox-a", 2)
	if ok || count != 2 {
		t.Fatalf("expected limit rejection: ok=%v count=%d", ok, count)
	}

	if got := limiter.Release("sandbox-a"); got != 1 {
		t.Fatalf("release count mismatch: got %d want 1", got)
	}
	if got := limiter.Count("sandbox-a"); got != 1 {
		t.Fatalf("count mismatch after release: got %d want 1", got)
	}
}

func TestConnectionLimiterNegativeLimitMeansUnlimited(t *testing.T) {
	t.Parallel()

	limiter := NewConnectionLimiter()
	for i := range 100 {
		count, ok := limiter.TryAcquire("sandbox-a", -1)
		if !ok || count != int64(i+1) {
			t.Fatalf("unexpected acquire result at %d: ok=%v count=%d", i, ok, count)
		}
	}
}

func TestConnectionLimiterConcurrentAcquireRespectsLimit(t *testing.T) {
	t.Parallel()

	limiter := NewConnectionLimiter()
	const limit = 32
	const workers = 128

	var wg sync.WaitGroup
	results := make(chan bool, workers)

	for range workers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, ok := limiter.TryAcquire("sandbox-a", limit)
			results <- ok
		}()
	}

	wg.Wait()
	close(results)

	success := 0
	for ok := range results {
		if ok {
			success++
		}
	}
	if success != limit {
		t.Fatalf("expected %d successful acquires, got %d", limit, success)
	}
	if got := limiter.Count("sandbox-a"); got != limit {
		t.Fatalf("count mismatch after concurrent acquires: got %d want %d", got, limit)
	}
}
