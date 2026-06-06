package runtimepool

import (
	"context"
	"testing"

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

type recordingWarmRuntimeStore struct {
	reserveCalls int
	listCalls    int
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

func (s *recordingWarmRuntimeStore) MarkWarmRuntimeItemState(context.Context, string, string, string) error {
	return nil
}

func (s *recordingWarmRuntimeStore) ListWarmRuntimeItems(context.Context, wrapper.WarmRuntimeListRequest) ([]wrapper.WarmRuntimeItem, error) {
	s.listCalls++
	return nil, nil
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
