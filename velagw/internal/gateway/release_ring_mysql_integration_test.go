//go:build integration

package gateway

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestMySQLReleaseRingRolloutPersistsSnapshot(t *testing.T) {
	store := newIsolatedMySQLStore(t)
	defer store.Close()
	for _, set := range []Set{
		{ID: "set-a", BaseURL: "http://set-a", Status: SetStatusActive, ObservedUserCount: 50},
		{ID: "set-b", BaseURL: "http://set-b", Status: SetStatusActive, ObservedUserCount: 10},
	} {
		if err := store.SaveSet(t.Context(), set); err != nil {
			t.Fatal(err)
		}
	}
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
	loaded, ok, err := svc.GetReleaseRollout(t.Context(), rollout.ID)
	if err != nil || !ok {
		t.Fatalf("get rollout ok=%v err=%v", ok, err)
	}
	if len(loaded.Batch.Runs) != 2 || loaded.Batch.Runs[0].SetID != "set-b" || loaded.Batch.Runs[0].TargetReleaseID != "release-v2" {
		t.Fatalf("loaded rollout=%+v", loaded)
	}
	set, ok, err := store.GetSet(t.Context(), "set-a")
	if err != nil || !ok || set.ReleaseRingID != "stable" || set.CurrentReleaseID != "release-v1" || set.TargetReleaseID != "release-v2" {
		t.Fatalf("set=%+v ok=%v err=%v", set, ok, err)
	}
	request := SetProvisionRequest{
		ID: "request-a", Source: "prod", Namespace: "llmgateway", Fleet: "prod", SetID: "set-c",
		ReleaseRingID: "stable", ReleaseID: "release-v2", ReleaseImage: testNewReleaseImage,
		Status: SetProvisionStatusPending,
	}
	if err := store.SaveSetProvisionRequest(t.Context(), request); err != nil {
		t.Fatal(err)
	}
	loadedRequest, ok, err := store.GetSetProvisionRequest(t.Context(), request.ID)
	if err != nil || !ok || loadedRequest.ReleaseRingID != "stable" || loadedRequest.ReleaseID != "release-v2" || loadedRequest.ReleaseImage != testNewReleaseImage {
		t.Fatalf("request=%+v ok=%v err=%v", loadedRequest, ok, err)
	}
}

func TestMySQLSetUpgradeSwitchPersistsReleaseRuntime(t *testing.T) {
	store := newIsolatedMySQLStore(t)
	defer store.Close()
	now := time.Date(2026, 7, 17, 14, 0, 0, 0, time.UTC)
	if err := store.SaveSet(t.Context(), Set{ID: "set-switch", Status: SetStatusActive}); err != nil {
		t.Fatal(err)
	}
	if _, created, err := store.InitializeSetRuntime(t.Context(), "set-switch", 1, testOldReleaseImage, "http://set-switch-g1:3000", now); err != nil || !created {
		t.Fatalf("initialize runtime created=%v err=%v", created, err)
	}
	svc := NewService(store, nil, Options{})
	svc.now = func() time.Time { return now }
	batch, err := svc.CreateSetUpgradeBatch(t.Context(), CreateSetUpgradeBatchInput{
		SetIDs: []string{"set-switch"}, TargetImage: testNewReleaseImage,
		Source: "kro", Namespace: "llmgateway", Fleet: "fleet", MaxParallel: 1, TargetReleaseID: "release-v2",
	})
	if err != nil {
		t.Fatal(err)
	}
	run, acquired, err := store.TryAcquireSetUpgradeRun(t.Context(), batch.Runs[0].ID, "manager-a", time.Minute, now)
	if err != nil || !acquired {
		t.Fatalf("claim acquired=%v err=%v", acquired, err)
	}
	run, err = store.CompleteSetUpgradeMaster(t.Context(), run, true, "", now.Add(time.Second))
	if err != nil {
		t.Fatal(err)
	}
	run, err = store.CompleteSetUpgradeCompatibility(t.Context(), run, true, "", now.Add(2*time.Second))
	if err != nil {
		t.Fatal(err)
	}
	run, err = store.PrepareSetUpgradeRuntime(t.Context(), run, SetRuntime{
		SetID: "set-switch", Generation: 2, ReleaseID: "release-v2", Image: testNewReleaseImage,
		TrafficBaseURL: "http://set-switch-g2:3000", Status: SetRuntimeStatusPreparing,
	}, now.Add(3*time.Second))
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 3; i++ {
		run, err = store.RecordSetUpgradeProbe(t.Context(), run, true, "", now.Add(time.Duration(4+i)*time.Second))
		if err != nil {
			t.Fatal(err)
		}
	}
	run, snapshot, err := store.SwitchSetUpgradeRuntime(t.Context(), run, now.Add(7*time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if run.Status != SetUpgradeRunStatusSwitching || snapshot.RuntimeGeneration != 2 {
		t.Fatalf("run=%+v snapshot=%+v", run, snapshot)
	}
	runtime, ok, err := store.GetSetRuntime(t.Context(), "set-switch", 2)
	if err != nil || !ok || runtime.ReleaseID != "release-v2" {
		t.Fatalf("runtime=%+v ok=%v err=%v", runtime, ok, err)
	}
}

func TestMySQLReleaseCampaignPersistsAndSerializesFleetCreation(t *testing.T) {
	store := newIsolatedMySQLStore(t)
	defer store.Close()
	if err := store.SaveSet(t.Context(), Set{
		ID: "set-canary", BaseURL: "http://set-canary", Status: SetStatusActive,
		CurrentReleaseID: "release-v1", ActiveRuntimeGeneration: 1,
	}); err != nil {
		t.Fatal(err)
	}
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
		ID: "canary", Name: "Canary", ServingReleaseID: "release-v1", SetIDs: []string{"set-canary"}, SoakDuration: time.Minute,
	}); err != nil {
		t.Fatal(err)
	}

	errs := make(chan error, 2)
	var wg sync.WaitGroup
	for range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := svc.CreateReleaseCampaign(context.Background(), CreateReleaseCampaignInput{TargetReleaseID: "release-v2"})
			errs <- err
		}()
	}
	wg.Wait()
	close(errs)
	succeeded := 0
	rejected := 0
	for err := range errs {
		switch {
		case err == nil:
			succeeded++
		case strings.Contains(err.Error(), "already has active release campaign"):
			rejected++
		default:
			t.Fatalf("unexpected create error: %v", err)
		}
	}
	if succeeded != 1 || rejected != 1 {
		t.Fatalf("succeeded=%d rejected=%d", succeeded, rejected)
	}

	store.db.SetMaxOpenConns(1)
	ctx, cancel := context.WithTimeout(t.Context(), 3*time.Second)
	defer cancel()
	campaigns, err := svc.ListReleaseCampaigns(ctx, 10)
	if err != nil || len(campaigns) != 1 || len(campaigns[0].Rings) != 1 {
		t.Fatalf("campaigns=%+v err=%v", campaigns, err)
	}
	if advanced, err := svc.ReconcileReleaseCampaigns(ctx, 10); err != nil || advanced != 1 {
		t.Fatalf("advanced=%d err=%v", advanced, err)
	}
	loaded, ok, err := svc.GetReleaseCampaign(ctx, campaigns[0].ID)
	if err != nil || !ok || loaded.Status != ReleaseCampaignStatusRunning || loaded.CurrentRolloutID == "" {
		t.Fatalf("loaded=%+v ok=%v err=%v", loaded, ok, err)
	}
}
