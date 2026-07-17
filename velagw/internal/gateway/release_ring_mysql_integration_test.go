//go:build integration

package gateway

import "testing"

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
