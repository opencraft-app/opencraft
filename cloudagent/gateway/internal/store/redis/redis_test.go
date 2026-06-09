package redis

import (
	"context"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
)

func newTestStore(t *testing.T) (*LockStore, *miniredis.Miniredis) {
	t.Helper()
	mr := miniredis.RunT(t)
	store, err := New(Config{
		Addr:      mr.Addr(),
		KeyPrefix: "test:",
	})
	if err != nil {
		t.Fatalf("new redis store: %v", err)
	}
	t.Cleanup(func() { store.Close() })
	return store, mr
}

// ═══════════════════════════════════════════════════════════
// RuntimeOwnership Tests
// ═══════════════════════════════════════════════════════════

func TestRuntimeOwnership_AcquireAndRelease(t *testing.T) {
	store, _ := newTestStore(t)
	ctx := context.Background()

	lease, err := store.AcquireRuntimeOwnership(ctx, RuntimeOwnershipRequest{
		SessionID:  "session_1",
		Generation: 1,
		RunID:      "run_1",
		OwnerID:    "gateway_a",
		Operation:  "prompt",
		TTL:        5 * time.Minute,
	})
	if err != nil {
		t.Fatalf("acquire: %v", err)
	}
	if lease.SessionID != "session_1" {
		t.Errorf("session_id = %q, want session_1", lease.SessionID)
	}
	if lease.FencingToken != 1 {
		t.Errorf("fencing_token = %d, want 1", lease.FencingToken)
	}

	// Should be held
	held, err := store.RuntimeOwnershipHeld(ctx, lease)
	if err != nil {
		t.Fatalf("held check: %v", err)
	}
	if !held {
		t.Error("expected lease to be held")
	}

	// Release
	if err := store.ReleaseRuntimeOwnership(ctx, lease); err != nil {
		t.Fatalf("release: %v", err)
	}

	// Should no longer be held after release
	held, err = store.RuntimeOwnershipHeld(ctx, lease)
	if err != nil {
		t.Fatalf("held check after release: %v", err)
	}
	if held {
		t.Error("expected lease to not be held after release")
	}
}

func TestRuntimeOwnership_ConcurrentAcquire_SecondFails(t *testing.T) {
	store, _ := newTestStore(t)
	ctx := context.Background()

	// First acquires successfully
	_, err := store.AcquireRuntimeOwnership(ctx, RuntimeOwnershipRequest{
		SessionID:  "session_1",
		Generation: 1,
		RunID:      "run_1",
		OwnerID:    "gateway_a",
		Operation:  "prompt",
		TTL:        5 * time.Minute,
	})
	if err != nil {
		t.Fatalf("first acquire: %v", err)
	}

	// Second should fail
	_, err = store.AcquireRuntimeOwnership(ctx, RuntimeOwnershipRequest{
		SessionID:  "session_1",
		Generation: 2,
		RunID:      "run_2",
		OwnerID:    "gateway_b",
		Operation:  "prompt",
		TTL:        5 * time.Minute,
	})
	if err == nil {
		t.Fatal("expected second acquire to fail")
	}
	var held RuntimeOwnershipHeldError
	if !errorAs(err, &held) {
		t.Fatalf("expected RuntimeOwnershipHeldError, got %T: %v", err, err)
	}
	if held.OwnerID != "gateway_a" {
		t.Errorf("held.OwnerID = %q, want gateway_a", held.OwnerID)
	}
}

func TestRuntimeOwnership_ExpiredLease_CanBeStolen(t *testing.T) {
	store, mr := newTestStore(t)
	ctx := context.Background()

	// First acquires with short TTL
	_, err := store.AcquireRuntimeOwnership(ctx, RuntimeOwnershipRequest{
		SessionID:  "session_1",
		Generation: 1,
		RunID:      "run_1",
		OwnerID:    "gateway_a",
		Operation:  "prompt",
		TTL:        1 * time.Second,
	})
	if err != nil {
		t.Fatalf("first acquire: %v", err)
	}

	// Simulate expiry by setting expires_at to the past directly in Redis.
	// miniredis FastForward only affects key TTL, not the string value
	// our Lua script compares.
	pastTime := time.Now().UTC().Add(-10 * time.Second).Format(time.RFC3339Nano)
	key := "test:rt-own:session_1"
	mr.HSet(key, "expires_at", pastTime)

	// Second can now steal
	lease2, err := store.AcquireRuntimeOwnership(ctx, RuntimeOwnershipRequest{
		SessionID:  "session_1",
		Generation: 2,
		RunID:      "run_2",
		OwnerID:    "gateway_b",
		Operation:  "prompt",
		TTL:        5 * time.Minute,
	})
	if err != nil {
		t.Fatalf("second acquire after expiry: %v", err)
	}
	if lease2.OwnerID != "gateway_b" {
		t.Errorf("owner = %q, want gateway_b", lease2.OwnerID)
	}
	if lease2.FencingToken != 2 {
		t.Errorf("fencing_token = %d, want 2 (incremented)", lease2.FencingToken)
	}
}

func TestRuntimeOwnership_FencingToken_MonotonicallyIncreases(t *testing.T) {
	store, mr := newTestStore(t)
	ctx := context.Background()

	var lastToken int64
	for i := 0; i < 5; i++ {
		lease, err := store.AcquireRuntimeOwnership(ctx, RuntimeOwnershipRequest{
			SessionID:  "session_1",
			Generation: int64(i + 1),
			RunID:      randomID(),
			OwnerID:    "gateway_a",
			Operation:  "prompt",
			TTL:        1 * time.Second,
		})
		if err != nil {
			t.Fatalf("acquire %d: %v", i, err)
		}
		if lease.FencingToken <= lastToken {
			t.Errorf("iteration %d: token %d <= previous %d", i, lease.FencingToken, lastToken)
		}
		lastToken = lease.FencingToken
		// Simulate expiry by backdating expires_at
		key := "test:rt-own:session_1"
		pastTime := time.Now().UTC().Add(-10 * time.Second).Format(time.RFC3339Nano)
		mr.HSet(key, "expires_at", pastTime)
	}
}

func TestRuntimeOwnership_Renew_Success(t *testing.T) {
	store, _ := newTestStore(t)
	ctx := context.Background()

	lease, err := store.AcquireRuntimeOwnership(ctx, RuntimeOwnershipRequest{
		SessionID:  "session_1",
		Generation: 1,
		RunID:      "run_1",
		OwnerID:    "gateway_a",
		Operation:  "prompt",
		TTL:        5 * time.Minute,
	})
	if err != nil {
		t.Fatalf("acquire: %v", err)
	}

	// Renew should succeed
	err = store.RenewRuntimeOwnership(ctx, lease, 10*time.Minute)
	if err != nil {
		t.Fatalf("renew: %v", err)
	}

	// Should still be held
	held, err := store.RuntimeOwnershipHeld(ctx, lease)
	if err != nil {
		t.Fatalf("held check: %v", err)
	}
	if !held {
		t.Error("expected lease to be held after renewal")
	}
}

func TestRuntimeOwnership_Renew_FailsAfterStolen(t *testing.T) {
	store, mr := newTestStore(t)
	ctx := context.Background()

	lease1, err := store.AcquireRuntimeOwnership(ctx, RuntimeOwnershipRequest{
		SessionID:  "session_1",
		Generation: 1,
		RunID:      "run_1",
		OwnerID:    "gateway_a",
		Operation:  "prompt",
		TTL:        1 * time.Second,
	})
	if err != nil {
		t.Fatalf("acquire: %v", err)
	}

	// Simulate expiry by backdating expires_at
	key := "test:rt-own:session_1"
	pastTime := time.Now().UTC().Add(-10 * time.Second).Format(time.RFC3339Nano)
	mr.HSet(key, "expires_at", pastTime)

	// Now someone else steals
	_, err = store.AcquireRuntimeOwnership(ctx, RuntimeOwnershipRequest{
		SessionID:  "session_1",
		Generation: 2,
		RunID:      "run_2",
		OwnerID:    "gateway_b",
		Operation:  "prompt",
		TTL:        5 * time.Minute,
	})
	if err != nil {
		t.Fatalf("steal: %v", err)
	}

	// Original holder tries to renew — should fail
	err = store.RenewRuntimeOwnership(ctx, lease1, 5*time.Minute)
	if err == nil {
		t.Fatal("expected renew to fail after lease stolen")
	}
}

func TestRuntimeOwnership_SameOwner_Reentrant(t *testing.T) {
	store, _ := newTestStore(t)
	ctx := context.Background()

	_, err := store.AcquireRuntimeOwnership(ctx, RuntimeOwnershipRequest{
		SessionID:  "session_1",
		Generation: 1,
		RunID:      "run_1",
		OwnerID:    "gateway_a",
		Operation:  "prompt",
		TTL:        5 * time.Minute,
	})
	if err != nil {
		t.Fatalf("first acquire: %v", err)
	}

	// Same owner, AllowSameOwner=true → should succeed
	lease2, err := store.AcquireRuntimeOwnership(ctx, RuntimeOwnershipRequest{
		SessionID:      "session_1",
		Generation:     1,
		RunID:          "run_2",
		OwnerID:        "gateway_a",
		Operation:      "ensure_ready",
		TTL:            5 * time.Minute,
		AllowSameOwner: true,
	})
	if err != nil {
		t.Fatalf("reentrant acquire: %v", err)
	}
	if lease2.FencingToken != 2 {
		t.Errorf("fencing_token = %d, want 2", lease2.FencingToken)
	}
}

func TestRuntimeOwnership_DifferentOwner_ReentrantDenied(t *testing.T) {
	store, _ := newTestStore(t)
	ctx := context.Background()

	_, err := store.AcquireRuntimeOwnership(ctx, RuntimeOwnershipRequest{
		SessionID:  "session_1",
		Generation: 1,
		RunID:      "run_1",
		OwnerID:    "gateway_a",
		Operation:  "prompt",
		TTL:        5 * time.Minute,
	})
	if err != nil {
		t.Fatalf("first acquire: %v", err)
	}

	// Different owner, AllowSameOwner=true → still denied
	_, err = store.AcquireRuntimeOwnership(ctx, RuntimeOwnershipRequest{
		SessionID:      "session_1",
		Generation:     2,
		RunID:          "run_2",
		OwnerID:        "gateway_b",
		Operation:      "ensure_ready",
		TTL:            5 * time.Minute,
		AllowSameOwner: true,
	})
	if err == nil {
		t.Fatal("expected different owner reentrant to be denied")
	}
}

func TestRuntimeOwnership_ConcurrentGoroutines(t *testing.T) {
	store, _ := newTestStore(t)
	ctx := context.Background()

	const goroutines = 20
	var winners int64
	var wg sync.WaitGroup
	wg.Add(goroutines)

	for i := 0; i < goroutines; i++ {
		go func(id int) {
			defer wg.Done()
			_, err := store.AcquireRuntimeOwnership(ctx, RuntimeOwnershipRequest{
				SessionID:  "session_race",
				Generation: int64(id + 1),
				RunID:      randomID(),
				OwnerID:    randomID(),
				Operation:  "prompt",
				TTL:        5 * time.Minute,
			})
			if err == nil {
				atomic.AddInt64(&winners, 1)
			}
		}(i)
	}
	wg.Wait()

	// Exactly one should win
	if winners != 1 {
		t.Errorf("expected exactly 1 winner, got %d", winners)
	}
}

// ═══════════════════════════════════════════════════════════
// WorkspaceLease Tests
// ═══════════════════════════════════════════════════════════

func TestWorkspaceLease_AcquireRenewRelease(t *testing.T) {
	store, _ := newTestStore(t)
	ctx := context.Background()

	lease, err := store.AcquireLease(ctx, WorkspaceLeaseRequest{
		WorkspaceID: "ws_1",
		RuntimeID:   "rt_1",
		TTL:         5 * time.Minute,
	})
	if err != nil {
		t.Fatalf("acquire: %v", err)
	}
	if lease.WorkspaceID != "ws_1" {
		t.Errorf("workspace_id = %q, want ws_1", lease.WorkspaceID)
	}
	if lease.FencingToken != 1 {
		t.Errorf("fencing_token = %d, want 1", lease.FencingToken)
	}
	if lease.State != "active" {
		t.Errorf("state = %q, want active", lease.State)
	}

	// Renew
	renewed, err := store.RenewLease(ctx, lease, 10*time.Minute)
	if err != nil {
		t.Fatalf("renew: %v", err)
	}
	if renewed.ExpiresAt.Before(lease.ExpiresAt) {
		t.Error("renewed expiry should be after original")
	}

	// Get
	got, ok, err := store.GetLease(ctx, "ws_1")
	if err != nil || !ok {
		t.Fatalf("get: ok=%v err=%v", ok, err)
	}
	if got.RuntimeID != "rt_1" {
		t.Errorf("got runtime_id = %q, want rt_1", got.RuntimeID)
	}

	// Release
	if err := store.ReleaseLease(ctx, renewed); err != nil {
		t.Fatalf("release: %v", err)
	}

	// After release, state should be released
	got, ok, err = store.GetLease(ctx, "ws_1")
	if err != nil || !ok {
		t.Fatalf("get after release: ok=%v err=%v", ok, err)
	}
	if got.State != "released" {
		t.Errorf("state after release = %q, want released", got.State)
	}
}

func TestWorkspaceLease_KeysShareRedisClusterHashTag(t *testing.T) {
	store, _ := newTestStore(t)

	keys := store.keyspace.workspaceAcquireLeaseKeys("workspace_abc")
	leaseKey := keys[0]
	fenceKey := keys[1]
	if redisClusterHashTag(leaseKey) == "" {
		t.Fatalf("lease key missing hash tag: %s", leaseKey)
	}
	if redisClusterHashTag(leaseKey) != redisClusterHashTag(fenceKey) {
		t.Fatalf("workspace lease keys must share a Redis Cluster hash tag: lease=%s fence=%s", leaseKey, fenceKey)
	}

	escaped := store.keyspace.workspaceLease("workspace_{bad}_id")
	if strings.Contains(redisClusterHashTag(escaped), "{") || strings.Contains(redisClusterHashTag(escaped), "}") {
		t.Fatalf("workspace id braces must be escaped inside Redis hash tag: %s", escaped)
	}
}

func TestWorkspaceLease_ConcurrentAcquire_SecondFails(t *testing.T) {
	store, _ := newTestStore(t)
	ctx := context.Background()

	_, err := store.AcquireLease(ctx, WorkspaceLeaseRequest{
		WorkspaceID: "ws_1",
		RuntimeID:   "rt_1",
		TTL:         5 * time.Minute,
	})
	if err != nil {
		t.Fatalf("first: %v", err)
	}

	_, err = store.AcquireLease(ctx, WorkspaceLeaseRequest{
		WorkspaceID: "ws_1",
		RuntimeID:   "rt_2",
		TTL:         5 * time.Minute,
	})
	if err == nil {
		t.Fatal("expected second acquire to fail")
	}
	var held WorkspaceLeaseHeldError
	if !errorAs(err, &held) {
		t.Fatalf("expected WorkspaceLeaseHeldError, got %T: %v", err, err)
	}
	if held.RuntimeID != "rt_1" {
		t.Errorf("held.RuntimeID = %q, want rt_1", held.RuntimeID)
	}
}

func TestWorkspaceLease_ExpiredLease_CanBeReacquired(t *testing.T) {
	store, mr := newTestStore(t)
	ctx := context.Background()

	_, err := store.AcquireLease(ctx, WorkspaceLeaseRequest{
		WorkspaceID: "ws_1",
		RuntimeID:   "rt_1",
		TTL:         1 * time.Second,
	})
	if err != nil {
		t.Fatalf("first: %v", err)
	}

	// Simulate expiry by backdating expires_at
	key := store.keyspace.workspaceLease("ws_1")
	pastTime := time.Now().UTC().Add(-10 * time.Second).Format(time.RFC3339Nano)
	mr.HSet(key, "expires_at", pastTime)

	lease2, err := store.AcquireLease(ctx, WorkspaceLeaseRequest{
		WorkspaceID: "ws_1",
		RuntimeID:   "rt_2",
		TTL:         5 * time.Minute,
	})
	if err != nil {
		t.Fatalf("second after expiry: %v", err)
	}
	if lease2.RuntimeID != "rt_2" {
		t.Errorf("runtime_id = %q, want rt_2", lease2.RuntimeID)
	}
	if lease2.FencingToken != 2 {
		t.Errorf("fencing_token = %d, want 2", lease2.FencingToken)
	}
}

func redisClusterHashTag(key string) string {
	start := strings.IndexByte(key, '{')
	if start < 0 {
		return ""
	}
	end := strings.IndexByte(key[start+1:], '}')
	if end < 0 {
		return ""
	}
	return key[start+1 : start+1+end]
}

func TestWorkspaceLease_Renew_FailsWrongIdentity(t *testing.T) {
	store, _ := newTestStore(t)
	ctx := context.Background()

	lease, err := store.AcquireLease(ctx, WorkspaceLeaseRequest{
		WorkspaceID: "ws_1",
		RuntimeID:   "rt_1",
		TTL:         5 * time.Minute,
	})
	if err != nil {
		t.Fatalf("acquire: %v", err)
	}

	// Try renewing with wrong fencing token
	badLease := lease
	badLease.FencingToken = 999
	_, err = store.RenewLease(ctx, badLease, 5*time.Minute)
	if err == nil {
		t.Fatal("expected renew with wrong token to fail")
	}
}

func TestWorkspaceLease_GetLease_NotFound(t *testing.T) {
	store, _ := newTestStore(t)
	ctx := context.Background()

	_, ok, err := store.GetLease(ctx, "nonexistent")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if ok {
		t.Error("expected not found")
	}
}

// ═══════════════════════════════════════════════════════════
// RuntimeEnsureLock Tests
// ═══════════════════════════════════════════════════════════

func TestRuntimeEnsureLock_AcquireAndRelease(t *testing.T) {
	store, _ := newTestStore(t)
	ctx := context.Background()

	lease, err := store.AcquireRuntimeEnsureLock(ctx, "ensure_session_1", 5*time.Second)
	if err != nil {
		t.Fatalf("acquire: %v", err)
	}

	// Release
	if err := lease.Release(ctx); err != nil {
		t.Fatalf("release: %v", err)
	}
}

func TestRuntimeEnsureLock_SecondBlocks_ThenSucceeds(t *testing.T) {
	store, mr := newTestStore(t)
	ctx := context.Background()

	// First acquires
	lease1, err := store.AcquireRuntimeEnsureLock(ctx, "ensure_session_1", 1*time.Second)
	if err != nil {
		t.Fatalf("first acquire: %v", err)
	}

	// Second tries to acquire — will block briefly then succeed after TTL expires
	done := make(chan error, 1)
	go func() {
		// Fast forward in a bit to allow the lock to expire
		time.AfterFunc(50*time.Millisecond, func() {
			mr.FastForward(2 * time.Second)
		})
		_, err := store.AcquireRuntimeEnsureLock(ctx, "ensure_session_1", 5*time.Second)
		done <- err
	}()

	// Wait for second to complete
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("second acquire: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("second acquire timed out")
	}

	_ = lease1 // first lease is now expired/overridden
}

func TestRuntimeEnsureLock_CtxTimeout(t *testing.T) {
	store, _ := newTestStore(t)
	ctx := context.Background()

	// First holds the lock
	_, err := store.AcquireRuntimeEnsureLock(ctx, "ensure_session_1", 30*time.Second)
	if err != nil {
		t.Fatalf("first: %v", err)
	}

	// Second with tight timeout should fail
	shortCtx, cancel := context.WithTimeout(ctx, 200*time.Millisecond)
	defer cancel()

	_, err = store.AcquireRuntimeEnsureLock(shortCtx, "ensure_session_1", 30*time.Second)
	if err == nil {
		t.Fatal("expected timeout error")
	}
	if err != context.DeadlineExceeded {
		t.Errorf("expected DeadlineExceeded, got %v", err)
	}
}

// ═══════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════

func errorAs[T error](err error, target *T) bool {
	if err == nil {
		return false
	}
	// Try direct type assertion first (errors.As may not work with generics in all cases)
	if v, ok := err.(T); ok {
		*target = v
		return true
	}
	// Also try the underlying error
	type wrapper interface {
		Unwrap() error
	}
	if w, ok := err.(wrapper); ok {
		if v, ok := w.Unwrap().(T); ok {
			*target = v
			return true
		}
	}
	return false
}
