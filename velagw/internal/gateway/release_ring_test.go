package gateway

import (
	"context"
	"sync"
	"testing"
	"time"
)

const (
	testOldReleaseImage = "example.com/new-api@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	testNewReleaseImage = "example.com/new-api@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
)

func TestReleaseRingRolloutSnapshotsOnlyRingSetsInWatermarkOrder(t *testing.T) {
	store := NewMemoryStore()
	for _, set := range []Set{
		{ID: "set-canary", Status: SetStatusActive, ObservedUserCount: 1, ActiveRuntimeGeneration: 1},
		{ID: "set-stable-busy", Status: SetStatusActive, ObservedUserCount: 800, ActiveRuntimeGeneration: 2},
		{ID: "set-stable-idle", Status: SetStatusActive, ObservedUserCount: 20, ActiveRuntimeGeneration: 3},
	} {
		mustSaveSet(t, store, set)
	}
	svc := NewService(store, nil, Options{})
	oldRelease, err := svc.CreateNewAPIRelease(t.Context(), CreateNewAPIReleaseInput{
		ID: "release-v1", Version: "v1", Image: testOldReleaseImage, Status: NewAPIReleaseStatusStable,
	})
	if err != nil {
		t.Fatal(err)
	}
	newRelease, err := svc.CreateNewAPIRelease(t.Context(), CreateNewAPIReleaseInput{
		ID: "release-v2", Version: "v2", Image: testNewReleaseImage, Status: NewAPIReleaseStatusVerified,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.UpsertReleaseRing(t.Context(), UpsertReleaseRingInput{
		ID: "canary", Name: "Canary", Ordinal: 0, ServingReleaseID: oldRelease.ID,
		AdmissionEnabled: false, SetIDs: []string{"set-canary"},
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.UpsertReleaseRing(t.Context(), UpsertReleaseRingInput{
		ID: "stable", Name: "Stable", Ordinal: 20, ServingReleaseID: oldRelease.ID,
		AdmissionEnabled: true, SetIDs: []string{"set-stable-busy", "set-stable-idle"},
	}); err != nil {
		t.Fatal(err)
	}

	rollout, err := svc.CreateReleaseRollout(t.Context(), CreateReleaseRolloutInput{
		RingID: "stable", TargetReleaseID: newRelease.ID, DrainTimeout: 15 * time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	if rollout.Status != ReleaseRolloutStatusRunning || rollout.Batch.MaxParallel != 1 || !rollout.Batch.StopOnFailure {
		t.Fatalf("rollout=%+v", rollout)
	}
	if len(rollout.Batch.Runs) != 2 {
		t.Fatalf("runs=%+v", rollout.Batch.Runs)
	}
	if got := rollout.Batch.Runs[0].SetID; got != "set-stable-idle" {
		t.Fatalf("first set=%q, want lowest watermark set", got)
	}
	if got := rollout.Batch.Runs[1].SetID; got != "set-stable-busy" {
		t.Fatalf("second set=%q", got)
	}
	for index, run := range rollout.Batch.Runs {
		if run.Sequence != index+1 || run.TargetReleaseID != newRelease.ID || run.FromReleaseID != oldRelease.ID {
			t.Fatalf("run[%d]=%+v", index, run)
		}
	}
	canary, _, err := store.GetSet(t.Context(), "set-canary")
	if err != nil {
		t.Fatal(err)
	}
	if canary.TargetReleaseID != "" || canary.CurrentReleaseID != oldRelease.ID {
		t.Fatalf("canary was modified by stable rollout: %+v", canary)
	}
}

func TestReleaseRingRolloutIsStrictlyOneByOne(t *testing.T) {
	store := NewMemoryStore()
	now := time.Date(2026, 7, 16, 10, 0, 0, 0, time.UTC)
	for _, id := range []string{"set-a", "set-b"} {
		mustSaveSet(t, store, Set{ID: id, Status: SetStatusActive, CurrentReleaseID: "release-v1"})
	}
	svc := NewService(store, nil, Options{})
	svc.now = func() time.Time { return now }
	for _, input := range []CreateNewAPIReleaseInput{
		{ID: "release-v1", Version: "v1", Image: testOldReleaseImage, Status: NewAPIReleaseStatusStable},
		{ID: "release-v2", Version: "v2", Image: testNewReleaseImage, Status: NewAPIReleaseStatusVerified},
	} {
		if _, err := svc.CreateNewAPIRelease(t.Context(), input); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := svc.UpsertReleaseRing(t.Context(), UpsertReleaseRingInput{
		ID: "stable", Name: "Stable", ServingReleaseID: "release-v1", AdmissionEnabled: true,
		SetIDs: []string{"set-a", "set-b"},
	}); err != nil {
		t.Fatal(err)
	}
	rollout, err := svc.CreateReleaseRollout(t.Context(), CreateReleaseRolloutInput{
		RingID: "stable", TargetReleaseID: "release-v2",
	})
	if err != nil {
		t.Fatal(err)
	}
	first := rollout.Batch.Runs[0]
	second := rollout.Batch.Runs[1]
	if _, ok, err := store.TryAcquireSetUpgradeRun(t.Context(), first.ID, "manager-a", time.Minute, now); err != nil || !ok {
		t.Fatalf("first claim ok=%v err=%v", ok, err)
	}
	if _, ok, err := store.TryAcquireSetUpgradeRun(t.Context(), second.ID, "manager-b", time.Minute, now); err != nil || ok {
		t.Fatalf("second claim ok=%v err=%v, want one-by-one refusal", ok, err)
	}
}

func TestConcurrentReleaseRolloutCreationHasSingleWinner(t *testing.T) {
	store := NewMemoryStore()
	mustSaveSet(t, store, Set{ID: "set-a", Status: SetStatusActive})
	svc := NewService(store, nil, Options{})
	for _, input := range []CreateNewAPIReleaseInput{
		{ID: "release-v1", Version: "v1", Image: testOldReleaseImage, Status: NewAPIReleaseStatusStable},
		{ID: "release-v2", Version: "v2", Image: testNewReleaseImage, Status: NewAPIReleaseStatusVerified},
	} {
		if _, err := svc.CreateNewAPIRelease(t.Context(), input); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := svc.UpsertReleaseRing(t.Context(), UpsertReleaseRingInput{
		ID: "stable", Name: "Stable", ServingReleaseID: "release-v1", SetIDs: []string{"set-a"},
	}); err != nil {
		t.Fatal(err)
	}
	start := make(chan struct{})
	errors := make(chan error, 2)
	var wg sync.WaitGroup
	for range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			_, err := svc.CreateReleaseRollout(t.Context(), CreateReleaseRolloutInput{
				RingID: "stable", TargetReleaseID: "release-v2",
			})
			errors <- err
		}()
	}
	close(start)
	wg.Wait()
	close(errors)
	succeeded := 0
	for err := range errors {
		if err == nil {
			succeeded++
		}
	}
	if succeeded != 1 {
		t.Fatalf("successful rollout creations=%d, want 1", succeeded)
	}
	rollouts, err := svc.ListReleaseRollouts(t.Context(), "stable", 10)
	if err != nil || len(rollouts) != 1 {
		t.Fatalf("rollouts=%+v err=%v", rollouts, err)
	}
}

func TestNewAPIReleaseIsImmutableAndMustUseDigest(t *testing.T) {
	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	if _, err := svc.CreateNewAPIRelease(t.Context(), CreateNewAPIReleaseInput{
		ID: "release-v1", Version: "v1", Image: "example.com/new-api:latest",
	}); err == nil {
		t.Fatal("expected mutable tag to be rejected")
	}
	if _, err := svc.CreateNewAPIRelease(t.Context(), CreateNewAPIReleaseInput{
		ID: "release-v1", Version: "v1", Image: testOldReleaseImage,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.CreateNewAPIRelease(t.Context(), CreateNewAPIReleaseInput{
		ID: "release-v1", Version: "v1-mutated", Image: testNewReleaseImage,
	}); err == nil {
		t.Fatal("expected immutable release mutation to be rejected")
	}
}

func TestCompletedSetUpgradeEnforcesSoakBeforeConvergingRing(t *testing.T) {
	store := NewMemoryStore()
	now := time.Date(2026, 7, 16, 12, 0, 0, 0, time.UTC)
	mustSaveSet(t, store, Set{
		ID: "set-a", Status: SetStatusActive, CurrentReleaseID: "release-v1",
		ActiveRuntimeGeneration: 1, RouteRevision: 1,
	})
	if err := store.SaveSetRuntime(t.Context(), SetRuntime{
		SetID: "set-a", Generation: 1, ReleaseID: "release-v1", Image: testOldReleaseImage,
		TrafficBaseURL: "http://set-a-g1:3000", Status: SetRuntimeStatusActive,
	}); err != nil {
		t.Fatal(err)
	}
	svc := NewService(store, nil, Options{})
	svc.now = func() time.Time { return now }
	for _, input := range []CreateNewAPIReleaseInput{
		{ID: "release-v1", Version: "v1", Image: testOldReleaseImage, Status: NewAPIReleaseStatusStable},
		{ID: "release-v2", Version: "v2", Image: testNewReleaseImage, Status: NewAPIReleaseStatusVerified},
	} {
		if _, err := svc.CreateNewAPIRelease(t.Context(), input); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := svc.UpsertReleaseRing(t.Context(), UpsertReleaseRingInput{
		ID: "stable", Name: "Stable", ServingReleaseID: "release-v1", SetIDs: []string{"set-a"},
		SoakDuration: 30 * time.Minute,
	}); err != nil {
		t.Fatal(err)
	}
	rollout, err := svc.CreateReleaseRollout(t.Context(), CreateReleaseRolloutInput{
		RingID: "stable", TargetReleaseID: "release-v2", DrainTimeout: time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	run, ok, err := store.TryAcquireSetUpgradeRun(t.Context(), rollout.Batch.Runs[0].ID, "manager", time.Minute, now)
	if err != nil || !ok {
		t.Fatalf("claim ok=%v err=%v", ok, err)
	}
	run = advanceUpgradeToPreparing(t, store, run, now)
	run, err = store.PrepareSetUpgradeRuntime(t.Context(), run, SetRuntime{
		SetID: "set-a", Generation: 2, Image: testNewReleaseImage, TrafficBaseURL: "http://set-a-g2:3000",
	}, now.Add(4*time.Millisecond))
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 3; i++ {
		run, err = store.RecordSetUpgradeProbe(t.Context(), run, true, "", now.Add(time.Duration(5+i)*time.Millisecond))
		if err != nil {
			t.Fatal(err)
		}
	}
	run, _, err = store.SwitchSetUpgradeRuntime(t.Context(), run, now.Add(10*time.Millisecond))
	if err != nil {
		t.Fatal(err)
	}
	run, ok, err = store.ConfirmSetRuntimeRoutePublished(t.Context(), "set-a", 2, now.Add(11*time.Millisecond))
	if err != nil || !ok {
		t.Fatalf("confirm ok=%v err=%v", ok, err)
	}
	if _, err := store.AdvanceSetUpgradeAfterDrain(t.Context(), run, run.DrainDeadline); err != nil {
		t.Fatal(err)
	}
	got, ok, err := svc.GetReleaseRollout(t.Context(), rollout.ID)
	if err != nil || !ok || got.Status != ReleaseRolloutStatusSoaking {
		t.Fatalf("rollout=%+v ok=%v err=%v", got, ok, err)
	}
	if !got.SoakStartedAt.Equal(now) || !got.SoakDeadline.Equal(now.Add(30*time.Minute)) {
		t.Fatalf("soak window=%s..%s", got.SoakStartedAt, got.SoakDeadline)
	}
	ring, _, _ := store.GetReleaseRing(t.Context(), "stable")
	if ring.Status != ReleaseRingStatusSoaking || ring.ServingReleaseID != "release-v1" || ring.TargetReleaseID != "release-v2" {
		t.Fatalf("ring skipped soak: %+v", ring)
	}
	set, _, _ := store.GetSet(t.Context(), "set-a")
	if set.CurrentReleaseID != "release-v2" || set.TargetReleaseID != "" {
		t.Fatalf("set release did not converge: %+v", set)
	}

	svc.releaseHealthGate = func(_ context.Context, candidate ReleaseRollout) error {
		if candidate.ID != rollout.ID {
			t.Fatalf("gate rollout=%q", candidate.ID)
		}
		return nil
	}
	now = now.Add(30 * time.Minute)
	advanced, err := svc.ReconcileReleaseRolloutSoaks(t.Context(), 10)
	if err != nil || advanced != 1 {
		t.Fatalf("advanced=%d err=%v", advanced, err)
	}
	got, ok, err = svc.GetReleaseRollout(t.Context(), rollout.ID)
	if err != nil || !ok || got.Status != ReleaseRolloutStatusCompleted {
		t.Fatalf("completed rollout=%+v ok=%v err=%v", got, ok, err)
	}
	ring, _, _ = store.GetReleaseRing(t.Context(), "stable")
	if ring.Status != ReleaseRingStatusSteady || ring.ServingReleaseID != "release-v2" || ring.TargetReleaseID != "" {
		t.Fatalf("ring did not converge after soak: %+v", ring)
	}
}
