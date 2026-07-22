package gateway

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestRunAcquiredTenantObservationTaskSchedulesActiveTenant(t *testing.T) {
	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	now := time.Date(2026, 7, 13, 12, 0, 0, 0, time.UTC)
	svc.now = func() time.Time { return now }
	if err := store.SaveTenant(t.Context(), Tenant{ExternalUserID: "user-1", Backend: UserBackendPending, Status: TenantStatusActive}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.EnqueueTenantObservationTask(t.Context(), TenantObservationTask{ExternalUserID: "user-1", NextRunAt: now}); err != nil {
		t.Fatal(err)
	}
	task, acquired, err := store.TryAcquireTenantObservationTask(t.Context(), "user-1", "observer-a", time.Minute, now)
	if err != nil || !acquired {
		t.Fatalf("acquire = %v, %v", acquired, err)
	}
	err = svc.runAcquiredTenantObservationTask(t.Context(), task, time.Minute, func(context.Context, string) (TenantObservation, error) {
		return TenantObservation{ExternalUserID: "user-1", HasActiveSubscription: true}, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	completed, _, _ := store.GetTenantObservationTask(t.Context(), "user-1")
	if completed.Status != TenantObservationTaskStatusPending || completed.AppliedVersion != 1 {
		t.Fatalf("unexpected completed task: %+v", completed)
	}
	delay := completed.NextRunAt.Sub(now)
	if delay < time.Hour || delay >= 66*time.Minute {
		t.Fatalf("active refresh delay = %s, want [1h, 1h6m)", delay)
	}
}

func TestRunAcquiredTenantObservationTaskBlocksUnavailableSet(t *testing.T) {
	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	now := time.Date(2026, 7, 13, 12, 0, 0, 0, time.UTC)
	svc.now = func() time.Time { return now }
	if err := store.SaveTenant(t.Context(), Tenant{ExternalUserID: "user-1", Backend: UserBackendNew, SetID: "set-a", Status: TenantStatusActive}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveSet(t.Context(), Set{ID: "set-a", Status: SetStatusDisabled}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.EnqueueTenantObservationTask(t.Context(), TenantObservationTask{ExternalUserID: "user-1", SetID: "set-a", NextRunAt: now}); err != nil {
		t.Fatal(err)
	}
	task, acquired, err := store.TryAcquireTenantObservationTask(t.Context(), "user-1", "observer-a", time.Minute, now)
	if err != nil || !acquired {
		t.Fatalf("acquire = %v, %v", acquired, err)
	}
	called := false
	err = svc.runAcquiredTenantObservationTask(t.Context(), task, time.Minute, func(context.Context, string) (TenantObservation, error) {
		called = true
		return TenantObservation{}, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if called {
		t.Fatal("observer called new-api for an unavailable Set")
	}
	completed, _, _ := store.GetTenantObservationTask(t.Context(), "user-1")
	if completed.Status != TenantObservationTaskStatusBlocked || completed.NextRunAt.Sub(now) < 5*time.Minute {
		t.Fatalf("unexpected blocked task: %+v", completed)
	}
}

func TestRunAcquiredTenantObservationTaskReleasesLeaseOnShutdown(t *testing.T) {
	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	now := time.Now().UTC()
	if err := store.SaveTenant(t.Context(), Tenant{ExternalUserID: "user-1", Backend: UserBackendPending, Status: TenantStatusActive}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.EnqueueTenantObservationTask(t.Context(), TenantObservationTask{ExternalUserID: "user-1", NextRunAt: now}); err != nil {
		t.Fatal(err)
	}
	task, acquired, err := store.TryAcquireTenantObservationTask(t.Context(), "user-1", "observer-a", time.Minute, now)
	if err != nil || !acquired {
		t.Fatalf("acquire = %v, %v", acquired, err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if err := svc.runAcquiredTenantObservationTask(ctx, task, time.Minute, func(ctx context.Context, _ string) (TenantObservation, error) {
		return TenantObservation{}, ctx.Err()
	}); !errors.Is(err, context.Canceled) {
		t.Fatalf("shutdown error = %v, want canceled", err)
	}
	released, _, _ := store.GetTenantObservationTask(t.Context(), "user-1")
	if released.Status != TenantObservationTaskStatusPending || released.LeaseOwner != "" || released.NextRunAt.After(time.Now().UTC()) {
		t.Fatalf("shutdown did not release task: %+v", released)
	}
}

func TestObserverWorkerSkipsSaturatedSetCandidatePage(t *testing.T) {
	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	mustSaveSet(t, store, readySetForOperationLease("set-a"))
	mustSaveSet(t, store, readySetForOperationLease("set-b"))
	now := time.Now().UTC().Add(-time.Minute)
	for _, task := range []TenantObservationTask{
		{ExternalUserID: "user-a-1", SetID: "set-a", NextRunAt: now},
		{ExternalUserID: "user-a-2", SetID: "set-a", NextRunAt: now.Add(time.Nanosecond)},
		{ExternalUserID: "user-b-1", SetID: "set-b", NextRunAt: now.Add(2 * time.Nanosecond)},
	} {
		if err := store.SaveTenant(t.Context(), Tenant{ExternalUserID: task.ExternalUserID, Backend: UserBackendPending, Status: TenantStatusActive}); err != nil {
			t.Fatal(err)
		}
		if _, err := store.EnqueueTenantObservationTask(t.Context(), task); err != nil {
			t.Fatal(err)
		}
	}

	ctx, cancel := context.WithCancel(t.Context())
	release := make(chan struct{})
	started := make(chan string, 2)
	done := make(chan error, 1)
	go func() {
		done <- svc.runObserverWorker(ctx, "observer-a", ObserverWorkerOptions{
			PollInterval: time.Millisecond, LeaseTTL: time.Minute, MaxConcurrency: 2, SetConcurrency: 1, CandidateBatch: 1,
		}, func(ctx context.Context, userID string) (TenantObservation, error) {
			started <- userID
			select {
			case <-release:
				return TenantObservation{ExternalUserID: userID}, nil
			case <-ctx.Done():
				return TenantObservation{}, ctx.Err()
			}
		}, nil)
	}()
	t.Cleanup(func() {
		close(release)
		cancel()
		select {
		case err := <-done:
			if err != nil {
				t.Errorf("worker stop: %v", err)
			}
		case <-time.After(time.Second):
			t.Error("observer worker did not stop")
		}
	})

	seen := map[string]bool{}
	deadline := time.After(500 * time.Millisecond)
	for len(seen) < 2 {
		select {
		case userID := <-started:
			seen[userID] = true
		case <-deadline:
			t.Fatalf("started users = %v; saturated set-a candidate page blocked set-b", seen)
		}
	}
	if !seen["user-a-1"] || !seen["user-b-1"] {
		t.Fatalf("started users = %v, want one task from each Set", seen)
	}
}
