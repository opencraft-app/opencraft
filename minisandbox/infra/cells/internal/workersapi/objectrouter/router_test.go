package objectrouter

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type testBackend struct {
	resolve func(context.Context, Key) (string, error)
	refresh func(context.Context, string) (string, error)
}

func (backend testBackend) ResolveUncached(ctx context.Context, key Key) (string, error) {
	return backend.resolve(ctx, key)
}

func (backend testBackend) Refresh(ctx context.Context, value string) (string, error) {
	if backend.refresh == nil {
		return value, nil
	}
	return backend.refresh(ctx, value)
}

func TestRouterBoundsCacheAndFallsBackToBackend(t *testing.T) {
	var calls atomic.Int64
	backend := testBackend{resolve: func(_ context.Context, key Key) (string, error) {
		calls.Add(1)
		return key.ObjectID, nil
	}}
	router := New[string](backend, 1, time.Hour, 4)
	first := Key{Worker: "worker", Class: "Counter", ObjectID: "first"}
	second := Key{Worker: "worker", Class: "Counter", ObjectID: "second"}
	for _, key := range []Key{first, first, second, first} {
		value, err := router.Resolve(context.Background(), key)
		if err != nil || value != key.ObjectID {
			t.Fatalf("Resolve(%+v) = %q, %v", key, value, err)
		}
	}
	if got := calls.Load(); got != 3 {
		t.Fatalf("backend calls = %d, want 3", got)
	}
	if router.Len() != 1 {
		t.Fatalf("cache length = %d, want 1", router.Len())
	}
	router.DeleteWorker("worker")
	if router.Len() != 0 {
		t.Fatal("DeleteWorker retained a routing entry")
	}
}

func TestRouterBoundsDistinctMissesAndCoalescesSameKey(t *testing.T) {
	started := make(chan struct{})
	release := make(chan struct{})
	var once sync.Once
	backend := testBackend{resolve: func(_ context.Context, key Key) (string, error) {
		once.Do(func() { close(started) })
		<-release
		return key.ObjectID, nil
	}}
	router := New[string](backend, 4, time.Hour, 1)
	first := Key{Worker: "worker", Class: "Counter", ObjectID: "first"}
	second := Key{Worker: "worker", Class: "Counter", ObjectID: "second"}
	leader := make(chan error, 1)
	go func() {
		_, err := router.Resolve(context.Background(), first)
		leader <- err
	}()
	<-started

	if _, err := router.Resolve(context.Background(), second); !errors.Is(err, ErrOverloaded) {
		t.Fatalf("distinct miss error = %v, want ErrOverloaded", err)
	}
	waiterContext, cancel := context.WithTimeout(context.Background(), time.Millisecond)
	defer cancel()
	if _, err := router.Resolve(waiterContext, first); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("same-key waiter error = %v, want deadline", err)
	}
	close(release)
	if err := <-leader; err != nil {
		t.Fatalf("leader failed: %v", err)
	}
}
