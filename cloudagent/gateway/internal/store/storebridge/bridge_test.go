package storebridge

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"

	redisstore "cloudagent/gateway/internal/store/redis"
	"cloudagent/gateway/internal/wrapper"
)

func TestRedisWorkspaceServiceSatisfiesWorkspaceLeaseContract(t *testing.T) {
	ctx := context.Background()
	redisServer := miniredis.RunT(t)
	lockStore, err := redisstore.New(redisstore.Config{
		Addr:      redisServer.Addr(),
		KeyPrefix: "test:",
	})
	if err != nil {
		t.Fatalf("new redis store: %v", err)
	}
	t.Cleanup(func() { _ = lockStore.Close() })

	metadataStore, err := wrapper.NewStore(t.TempDir())
	if err != nil {
		t.Fatalf("new metadata store: %v", err)
	}
	service := NewRedisWorkspaceService(lockStore, metadataStore)

	rec := wrapper.WorkspaceRecord{
		WorkspaceID:         "workspace_bridge_contract",
		Backend:             "smh",
		ProviderWorkspaceID: "smh_space_bridge_contract",
		State:               "active",
		OwnerSessionID:      "session_bridge_contract",
	}
	if err := service.EnsureWorkspace(ctx, rec); err != nil {
		t.Fatalf("ensure workspace: %v", err)
	}
	if stored, ok, err := metadataStore.LoadWorkspace(ctx, rec.WorkspaceID); err != nil || !ok || stored.ProviderWorkspaceID != rec.ProviderWorkspaceID {
		t.Fatalf("workspace metadata should stay in fallback store: ok=%v stored=%#v err=%v", ok, stored, err)
	}

	first, err := service.AcquireLease(ctx, wrapper.WorkspaceLeaseRequest{
		WorkspaceID: rec.WorkspaceID,
		RuntimeID:   "runtime_a",
		TTL:         time.Minute,
	})
	if err != nil {
		t.Fatalf("first acquire: %v", err)
	}
	if first.FencingToken != 1 {
		t.Fatalf("first fencing token = %d, want 1", first.FencingToken)
	}

	if _, err := service.AcquireLease(ctx, wrapper.WorkspaceLeaseRequest{
		WorkspaceID: rec.WorkspaceID,
		RuntimeID:   "runtime_b",
		TTL:         time.Minute,
	}); !errors.Is(err, wrapper.ErrWorkspaceLeaseHeld) {
		t.Fatalf("second acquire should return wrapper lease-held error, got %T %v", err, err)
	}

	renewed, err := service.RenewLease(ctx, first, 2*time.Minute)
	if err != nil {
		t.Fatalf("renew: %v", err)
	}
	if !renewed.ExpiresAt.After(first.ExpiresAt) {
		t.Fatalf("renew should extend expiry: before=%s after=%s", first.ExpiresAt, renewed.ExpiresAt)
	}

	if err := service.ReleaseLease(ctx, renewed); err != nil {
		t.Fatalf("release: %v", err)
	}
	second, err := service.AcquireLease(ctx, wrapper.WorkspaceLeaseRequest{
		WorkspaceID: rec.WorkspaceID,
		RuntimeID:   "runtime_b",
		TTL:         time.Minute,
	})
	if err != nil {
		t.Fatalf("reacquire after release: %v", err)
	}
	if second.FencingToken <= renewed.FencingToken {
		t.Fatalf("fencing token must be monotonic across release/reacquire: first=%d second=%d", renewed.FencingToken, second.FencingToken)
	}
}

func TestRedisRuntimeOwnershipBridgeSatisfiesSingleWriterContract(t *testing.T) {
	ctx := context.Background()
	redisServer := miniredis.RunT(t)
	lockStore, err := redisstore.New(redisstore.Config{
		Addr:      redisServer.Addr(),
		KeyPrefix: "test:",
	})
	if err != nil {
		t.Fatalf("new redis store: %v", err)
	}
	t.Cleanup(func() { _ = lockStore.Close() })
	ownership := NewRedisRuntimeOwnership(lockStore)

	first, err := ownership.AcquireRuntimeOwnership(ctx, wrapper.RuntimeOwnershipRequest{
		SessionID:  "session_bridge_contract",
		Generation: 1,
		RunID:      "run_a",
		OwnerID:    "gateway_a",
		Operation:  "prompt",
		TTL:        time.Minute,
	})
	if err != nil {
		t.Fatalf("first ownership acquire: %v", err)
	}
	if _, err := ownership.AcquireRuntimeOwnership(ctx, wrapper.RuntimeOwnershipRequest{
		SessionID:  "session_bridge_contract",
		Generation: 1,
		RunID:      "run_b",
		OwnerID:    "gateway_b",
		Operation:  "prompt",
		TTL:        time.Minute,
	}); !errors.Is(err, wrapper.ErrRuntimeOwnershipHeld) {
		t.Fatalf("second ownership acquire should return wrapper held error, got %T %v", err, err)
	}
	if err := ownership.ReleaseRuntimeOwnership(ctx, first); err != nil {
		t.Fatalf("release ownership: %v", err)
	}
}
