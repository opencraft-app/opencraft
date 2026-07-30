package gateway

import (
	"context"
	"testing"
	"time"
)

func TestChannelBundleDeliveryStatusAggregatesEligibleSetEvidence(t *testing.T) {
	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	ctx := context.Background()

	for _, set := range []Set{
		{ID: "set-a", Name: "Set A", Status: SetStatusActive, Setup: true},
		{ID: "set-b", Name: "Set B", Status: SetStatusActive, Setup: true},
		{ID: "set-c", Name: "Set C", Status: SetStatusActive, Setup: true},
		{ID: "set-d", Name: "Set D", Status: SetStatusActive, Setup: true},
		{ID: "set-disabled", Status: SetStatusDisabled, Setup: true},
		{ID: "set-unready", Status: SetStatusActive, Setup: false},
	} {
		mustSaveSet(t, store, set)
	}
	if err := store.SaveChannelBundle(ctx, ChannelBundle{
		ID: "golden", Name: "Golden", Fingerprint: "fp-current", Spec: ChannelBundleSpec{Version: 1, Kind: ChannelBundleKind},
	}); err != nil {
		t.Fatal(err)
	}
	bundle, ok, err := store.GetChannelBundle(ctx, "golden")
	if err != nil || !ok {
		t.Fatalf("get bundle ok=%v err=%v", ok, err)
	}
	now := bundle.UpdatedAt.Add(30 * time.Minute)
	svc.now = func() time.Time { return now }
	if err := store.SaveWorkerJob(ctx, WorkerJob{Name: WorkerJobCheckChannelDrift, Enabled: true, IntervalSeconds: 300}); err != nil {
		t.Fatal(err)
	}
	states := []ChannelBundleSyncState{
		{BundleID: "golden", SetID: "set-a", Status: ChannelSyncStatusSynced, DesiredFingerprint: "fp-current", LastCheckedAt: now.Add(-time.Minute)},
		{BundleID: "golden", SetID: "set-b", Status: ChannelSyncStatusPending, DesiredFingerprint: "fp-current"},
		{BundleID: "golden", SetID: "set-c", Status: ChannelSyncStatusDrift, DesiredFingerprint: "fp-old", DiffJSON: `{"changed":1}`, LastCheckedAt: now.Add(-time.Minute)},
		{BundleID: "golden", SetID: "set-d", Status: ChannelSyncStatusError, DesiredFingerprint: "fp-current", LastError: "remote unavailable", LastCheckedAt: now.Add(-2 * time.Minute)},
		{BundleID: "golden", SetID: "set-disabled", Status: ChannelSyncStatusError, DesiredFingerprint: "fp-current", LastCheckedAt: now},
	}
	for _, state := range states {
		if err := store.SaveChannelBundleSyncState(ctx, state); err != nil {
			t.Fatal(err)
		}
	}

	status, err := svc.GetChannelBundleDeliveryStatus(ctx, "golden")
	if err != nil {
		t.Fatal(err)
	}
	if status.Status != ChannelDeliveryStatusError {
		t.Fatalf("aggregate status = %q, want error", status.Status)
	}
	if status.EligibleSets != 4 || status.CheckedSets != 3 {
		t.Fatalf("eligible=%d checked=%d, want 4/3", status.EligibleSets, status.CheckedSets)
	}
	if status.StaleAfterSeconds == nil || *status.StaleAfterSeconds != 600 {
		t.Fatalf("stale_after_seconds = %v, want 600", status.StaleAfterSeconds)
	}
	if status.Counts.Synced != 1 || status.Counts.Unchecked != 1 || status.Counts.Stale != 1 || status.Counts.Error != 1 {
		t.Fatalf("unexpected counts: %+v", status.Counts)
	}
	if got := deliverySetByID(t, status, "set-b"); got.Status != ChannelDeliveryStatusUnchecked {
		t.Fatalf("zero timestamp pending status = %q, want unchecked", got.Status)
	}
	stale := deliverySetByID(t, status, "set-c")
	if stale.Status != ChannelDeliveryStatusStale || stale.DiffJSON != "" {
		t.Fatalf("old fingerprint state = %+v, want stale with hidden diff", stale)
	}
	if !status.HasStaleResults || status.CoverageCheckedAt == nil || !status.CoverageCheckedAt.Equal(now.Add(-2*time.Minute)) {
		t.Fatalf("freshness = stale:%v coverage:%v", status.HasStaleResults, status.CoverageCheckedAt)
	}
}

func TestChannelBundleDeliveryStatusWithoutDriftJobDoesNotAgeEvidence(t *testing.T) {
	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	ctx := context.Background()
	mustSaveSet(t, store, Set{ID: "set-a", Name: "Set A", Status: SetStatusActive, Setup: true})
	if err := store.SaveChannelBundle(ctx, ChannelBundle{ID: "golden", Name: "Golden", Fingerprint: "fp", Spec: ChannelBundleSpec{Version: 1, Kind: ChannelBundleKind}}); err != nil {
		t.Fatal(err)
	}
	bundle, _, _ := store.GetChannelBundle(ctx, "golden")
	now := bundle.UpdatedAt.Add(24 * time.Hour)
	svc.now = func() time.Time { return now }
	if err := store.SaveChannelBundleSyncState(ctx, ChannelBundleSyncState{
		BundleID: "golden", SetID: "set-a", Status: ChannelSyncStatusSynced, DesiredFingerprint: "fp", LastCheckedAt: bundle.UpdatedAt.Add(time.Minute),
	}); err != nil {
		t.Fatal(err)
	}

	status, err := svc.GetChannelBundleDeliveryStatus(ctx, "golden")
	if err != nil {
		t.Fatal(err)
	}
	if status.StaleAfterSeconds != nil || status.Status != ChannelDeliveryStatusSynced || status.HasStaleResults {
		t.Fatalf("unexpected status without enabled drift job: %+v", status)
	}
}

func TestChannelBundleDeliveryStatusReturnsEmptyForNoEligibleSets(t *testing.T) {
	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	if err := store.SaveChannelBundle(context.Background(), ChannelBundle{ID: "golden", Name: "Golden", Spec: ChannelBundleSpec{Version: 1, Kind: ChannelBundleKind}}); err != nil {
		t.Fatal(err)
	}

	status, err := svc.GetChannelBundleDeliveryStatus(context.Background(), "golden")
	if err != nil {
		t.Fatal(err)
	}
	if status.Status != ChannelDeliveryStatusEmpty || status.EligibleSets != 0 || status.CoverageCheckedAt != nil {
		t.Fatalf("unexpected empty status: %+v", status)
	}
}

func deliverySetByID(t *testing.T, status ChannelBundleDeliveryStatus, setID string) ChannelBundleDeliverySetStatus {
	t.Helper()
	for _, set := range status.Sets {
		if set.SetID == setID {
			return set
		}
	}
	t.Fatalf("delivery status missing set %q", setID)
	return ChannelBundleDeliverySetStatus{}
}
