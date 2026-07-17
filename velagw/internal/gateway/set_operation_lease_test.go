package gateway

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestSetOperationLeaseEnforcesConfiguredConcurrency(t *testing.T) {
	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	set := readySetForOperationLease("set-a")
	set.SubscriptionWriteConcurrency = 2
	mustSaveSet(t, store, set)

	start := make(chan struct{})
	release := make(chan struct{})
	var current atomic.Int32
	var maximum atomic.Int32
	var wg sync.WaitGroup
	errCh := make(chan error, 5)
	for i := 0; i < 5; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			errCh <- svc.withSetSubscriptionWriteLease(context.Background(), set, func(context.Context) error {
				now := current.Add(1)
				for old := maximum.Load(); now > old && !maximum.CompareAndSwap(old, now); old = maximum.Load() {
				}
				<-release
				current.Add(-1)
				return nil
			})
		}()
	}
	close(start)
	time.Sleep(100 * time.Millisecond)
	if got := maximum.Load(); got != 2 {
		t.Fatalf("maximum concurrent operations = %d, want 2", got)
	}
	close(release)
	wg.Wait()
	close(errCh)
	for err := range errCh {
		if err != nil {
			t.Fatal(err)
		}
	}
}

func TestSetOperationLeaseWaitHonorsContextCancellation(t *testing.T) {
	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	mustSaveSet(t, store, readySetForOperationLease("set-a"))
	now := time.Now().UTC()
	if _, ok, err := store.TryAcquireSetOperationLease(t.Context(), "set-a", SetOperationSubscriptionWrite, "holder", 1, time.Minute, now); err != nil || !ok {
		t.Fatalf("acquire holder ok=%v err=%v", ok, err)
	}

	ctx, cancel := context.WithTimeout(t.Context(), 50*time.Millisecond)
	defer cancel()
	err := svc.withSetSubscriptionWriteLease(ctx, Set{ID: "set-a", SubscriptionWriteConcurrency: 1}, func(context.Context) error {
		t.Fatal("cancelled waiter entered operation")
		return nil
	})
	if err == nil || ctx.Err() == nil {
		t.Fatalf("err=%v context=%v", err, ctx.Err())
	}
}

func TestSetOperationLeaseAllowsGroupRatioBootstrapBeforeAdmission(t *testing.T) {
	store := NewMemoryStore()
	set := readySetForOperationLease("set-pending")
	set.AdmissionStatus = SetAdmissionStatusPending
	mustSaveSet(t, store, set)
	now := time.Now().UTC()

	lease, acquired, err := store.TryAcquireSetOperationLease(t.Context(), set.ID, SetOperationGroupRatioWrite, "group-ratio", 1, time.Minute, now)
	if err != nil || !acquired {
		t.Fatalf("group ratio bootstrap lease acquired=%v err=%v", acquired, err)
	}
	if renewed, err := store.RenewSetOperationLease(t.Context(), lease, time.Minute, now.Add(10*time.Second)); err != nil || !renewed {
		t.Fatalf("group ratio bootstrap lease renewed=%v err=%v", renewed, err)
	}
	if _, acquired, err := store.TryAcquireSetOperationLease(t.Context(), set.ID, SetOperationSubscriptionWrite, "subscription", 1, time.Minute, now); err != nil || acquired {
		t.Fatalf("subscription lease before admission acquired=%v err=%v", acquired, err)
	}
}

func TestSetOperationLeaseUsesSafeLegacyFallback(t *testing.T) {
	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	mustSaveSet(t, store, readySetForOperationLease("legacy-set"))
	start := make(chan struct{})
	release := make(chan struct{})
	var current atomic.Int32
	var maximum atomic.Int32
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			_ = svc.withSetSubscriptionWriteLease(context.Background(), Set{ID: "legacy-set"}, func(context.Context) error {
				now := current.Add(1)
				for old := maximum.Load(); now > old && !maximum.CompareAndSwap(old, now); old = maximum.Load() {
				}
				<-release
				current.Add(-1)
				return nil
			})
		}()
	}
	close(start)
	time.Sleep(100 * time.Millisecond)
	if got := maximum.Load(); got != 4 {
		t.Fatalf("legacy maximum = %d, want 4", got)
	}
	close(release)
	wg.Wait()
}

func readySetForOperationLease(id string) Set {
	return Set{
		ID:               id,
		BaseURL:          "http://" + id,
		Status:           SetStatusActive,
		Setup:            true,
		AdminUserID:      1,
		AdminAccessToken: "admin-token",
		AdmissionStatus:  SetAdmissionStatusPassed,
	}
}
