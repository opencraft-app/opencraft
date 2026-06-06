package runtimepool

import (
	"context"
	"testing"
	"time"

	"cloudagent/gateway/internal/wrapper"
)

func TestWorkflowIDForPoolIncludesPoolFingerprint(t *testing.T) {
	first := WorkflowIDForPool("cloudagent-runtime-pool-devcloud-dep-v6", "runtime_pool.v1.first")
	second := WorkflowIDForPool("cloudagent-runtime-pool-devcloud-dep-v6", "runtime_pool.v1.second")
	if first == second {
		t.Fatalf("workflow ids must differ when pool keys differ")
	}
	if first == "cloudagent-runtime-pool-devcloud-dep-v6" {
		t.Fatalf("workflow id must not reuse the bare configured id")
	}
	if got := WorkflowIDForPool("base", ""); got != "base" {
		t.Fatalf("empty pool key workflow id = %q, want base", got)
	}
}

func TestEnsureWarmRuntimePoolSkipsUnexpectedPoolKey(t *testing.T) {
	store := &recordingWarmRuntimeStore{}
	activity := &Activities{Store: store, ExpectedPoolKey: "runtime_pool.v1.current"}
	status, err := activity.EnsureWarmRuntimePool(context.Background(), ReconcileInput{
		PoolKey:      "runtime_pool.v1.stale",
		DesiredReady: 5,
	})
	if err != nil {
		t.Fatalf("ensure stale pool: %v", err)
	}
	if status.PoolKey != "runtime_pool.v1.stale" {
		t.Fatalf("status pool key = %q", status.PoolKey)
	}
	if store.reserveCalls != 0 || store.listCalls != 0 {
		t.Fatalf("stale workflow should not touch store, reserve=%d list=%d", store.reserveCalls, store.listCalls)
	}
}

func TestEnsureWarmRuntimePoolExpiresStaleCreatingItems(t *testing.T) {
	stale := wrapper.WarmRuntimeItem{
		ItemID:    "warm_stale",
		PoolKey:   "runtime_pool.v1.current",
		State:     "creating",
		UpdatedAt: time.Now().Add(-10 * time.Minute),
	}
	active := wrapper.WarmRuntimeItem{
		ItemID:    "warm_active",
		PoolKey:   "runtime_pool.v1.current",
		State:     "creating",
		UpdatedAt: time.Now(),
	}
	store := &recordingWarmRuntimeStore{itemsByState: map[string][]wrapper.WarmRuntimeItem{
		"creating": {stale, active},
	}}
	activity := &Activities{Store: store, ExpectedPoolKey: "runtime_pool.v1.current"}
	status, err := activity.EnsureWarmRuntimePool(context.Background(), ReconcileInput{
		PoolKey:                "runtime_pool.v1.current",
		DesiredReady:           5,
		CreatingTimeoutSeconds: 60,
	})
	if err != nil {
		t.Fatalf("ensure pool: %v", err)
	}
	if status.CreatingCount != 1 || status.StaleCreatingCount != 1 || status.FailedCount != 1 {
		t.Fatalf("status = %+v, want one active creating and one stale failed", status)
	}
	if got := store.markedStates["warm_stale"]; got != "failed" {
		t.Fatalf("stale item marked state = %q, want failed", got)
	}
	if _, ok := store.markedStates["warm_active"]; ok {
		t.Fatalf("active item must not be marked stale")
	}
	if store.reserveCalls != 1 {
		t.Fatalf("reserve calls = %d, want 1", store.reserveCalls)
	}
}

type recordingWarmRuntimeStore struct {
	reserveCalls int
	listCalls    int
	itemsByState map[string][]wrapper.WarmRuntimeItem
	markedStates map[string]string
}

func (s *recordingWarmRuntimeStore) ReserveWarmRuntimeItem(context.Context, wrapper.WarmRuntimeReserveRequest) (wrapper.WarmRuntimeItem, bool, error) {
	s.reserveCalls++
	return wrapper.WarmRuntimeItem{}, false, nil
}

func (s *recordingWarmRuntimeStore) UpsertWarmRuntimeItem(context.Context, wrapper.WarmRuntimeItem) error {
	return nil
}

func (s *recordingWarmRuntimeStore) MarkWarmRuntimeItemReady(context.Context, string, wrapper.WarmRuntimeHost) error {
	return nil
}

func (s *recordingWarmRuntimeStore) MarkWarmRuntimeItemState(_ context.Context, itemID string, state string, _ string) error {
	if s.markedStates == nil {
		s.markedStates = map[string]string{}
	}
	s.markedStates[itemID] = state
	return nil
}

func (s *recordingWarmRuntimeStore) ListWarmRuntimeItems(_ context.Context, req wrapper.WarmRuntimeListRequest) ([]wrapper.WarmRuntimeItem, error) {
	s.listCalls++
	if s.itemsByState == nil {
		return nil, nil
	}
	return append([]wrapper.WarmRuntimeItem(nil), s.itemsByState[req.State]...), nil
}

func (s *recordingWarmRuntimeStore) ClaimWarmRuntime(context.Context, wrapper.WarmRuntimeClaimRequest) (wrapper.WarmRuntimeClaim, error) {
	return wrapper.WarmRuntimeClaim{}, wrapper.ErrWarmRuntimePoolMiss
}

func (s *recordingWarmRuntimeStore) ConsumeWarmRuntime(context.Context, wrapper.WarmRuntimeClaim) error {
	return nil
}

func (s *recordingWarmRuntimeStore) DiscardWarmRuntime(context.Context, wrapper.WarmRuntimeClaim, string) error {
	return nil
}
