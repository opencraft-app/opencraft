package gateway

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"
)

func TestReleaseCampaignAdvancesRingsOnlyAfterSoakGate(t *testing.T) {
	store := NewMemoryStore()
	now := time.Date(2026, 7, 17, 8, 0, 0, 0, time.UTC)
	svc := NewService(store, nil, Options{})
	svc.now = func() time.Time { return now }
	svc.releaseHealthGate = func(_ context.Context, _ ReleaseRollout) error { return nil }

	for _, input := range []CreateNewAPIReleaseInput{
		{ID: "release-v1", Version: "v1", Image: testOldReleaseImage, Status: NewAPIReleaseStatusStable},
		{ID: "release-v2", Version: "v2", Image: testNewReleaseImage, Status: NewAPIReleaseStatusVerified},
	} {
		if _, err := svc.CreateNewAPIRelease(t.Context(), input); err != nil {
			t.Fatal(err)
		}
	}
	for index, ringID := range []string{"canary", "early", "stable"} {
		setID := "set-" + ringID
		mustSaveSet(t, store, Set{
			ID: setID, Status: SetStatusActive, CurrentReleaseID: "release-v1",
			ActiveRuntimeGeneration: 1, AdminHealthStatus: SetAdminHealthHealthy,
			AdmissionStatus: SetAdmissionStatusPassed,
		})
		if _, err := svc.UpsertReleaseRing(t.Context(), UpsertReleaseRingInput{
			ID: ringID, Name: ringID, Ordinal: index * 10, ServingReleaseID: "release-v1",
			SetIDs: []string{setID}, SoakDuration: time.Minute,
		}); err != nil {
			t.Fatal(err)
		}
	}

	campaign, err := svc.CreateReleaseCampaign(t.Context(), CreateReleaseCampaignInput{TargetReleaseID: "release-v2"})
	if err != nil {
		t.Fatal(err)
	}
	if campaign.Status != ReleaseCampaignStatusPending || len(campaign.Rings) != 3 {
		t.Fatalf("campaign=%+v", campaign)
	}
	if advanced, err := svc.ReconcileReleaseCampaigns(t.Context(), 10); err != nil || advanced != 1 {
		t.Fatalf("first reconcile advanced=%d err=%v", advanced, err)
	}
	campaign = mustGetReleaseCampaign(t, svc, campaign.ID)
	if campaign.Status != ReleaseCampaignStatusRunning || campaign.CurrentRingID != "canary" || campaign.CurrentRolloutID == "" {
		t.Fatalf("running campaign=%+v", campaign)
	}
	assertReleaseRolloutRings(t, svc, []string{"canary"})

	markReleaseRolloutRunsCompleted(t, store, campaign.CurrentRolloutID, "release-v2", now)
	if advanced, err := svc.ReconcileReleaseCampaigns(t.Context(), 10); err != nil || advanced != 1 {
		t.Fatalf("soak reconcile advanced=%d err=%v", advanced, err)
	}
	campaign = mustGetReleaseCampaign(t, svc, campaign.ID)
	if campaign.Status != ReleaseCampaignStatusSoaking || campaign.CurrentRingID != "canary" {
		t.Fatalf("soaking campaign=%+v", campaign)
	}
	assertReleaseRolloutRings(t, svc, []string{"canary"})

	now = now.Add(time.Minute)
	if advanced, err := svc.ReconcileReleaseRolloutSoaks(t.Context(), 10); err != nil || advanced != 1 {
		t.Fatalf("gate advanced=%d err=%v", advanced, err)
	}
	if advanced, err := svc.ReconcileReleaseCampaigns(t.Context(), 10); err != nil || advanced != 1 {
		t.Fatalf("next ring advanced=%d err=%v", advanced, err)
	}
	campaign = mustGetReleaseCampaign(t, svc, campaign.ID)
	if campaign.Status != ReleaseCampaignStatusRunning || campaign.CurrentRingID != "early" || campaign.CompletedRings != 1 {
		t.Fatalf("early campaign=%+v", campaign)
	}
	assertReleaseRolloutRings(t, svc, []string{"canary", "early"})
}

func TestReleaseCampaignGateFailurePausesAndResumeRestartsSoak(t *testing.T) {
	store := NewMemoryStore()
	now := time.Date(2026, 7, 17, 9, 0, 0, 0, time.UTC)
	svc := NewService(store, nil, Options{})
	svc.now = func() time.Time { return now }
	gateErr := errors.New("set error rate is above threshold")
	svc.releaseHealthGate = func(_ context.Context, _ ReleaseRollout) error { return gateErr }
	for _, input := range []CreateNewAPIReleaseInput{
		{ID: "release-v1", Version: "v1", Image: testOldReleaseImage, Status: NewAPIReleaseStatusStable},
		{ID: "release-v2", Version: "v2", Image: testNewReleaseImage, Status: NewAPIReleaseStatusVerified},
	} {
		if _, err := svc.CreateNewAPIRelease(t.Context(), input); err != nil {
			t.Fatal(err)
		}
	}
	mustSaveSet(t, store, Set{
		ID: "set-canary", Status: SetStatusActive, CurrentReleaseID: "release-v1", ActiveRuntimeGeneration: 1,
		AdminHealthStatus: SetAdminHealthHealthy, AdmissionStatus: SetAdmissionStatusPassed,
	})
	if _, err := svc.UpsertReleaseRing(t.Context(), UpsertReleaseRingInput{
		ID: "canary", Name: "Canary", ServingReleaseID: "release-v1", SetIDs: []string{"set-canary"},
		SoakDuration: time.Minute,
	}); err != nil {
		t.Fatal(err)
	}
	campaign, err := svc.CreateReleaseCampaign(t.Context(), CreateReleaseCampaignInput{TargetReleaseID: "release-v2"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.ReconcileReleaseCampaigns(t.Context(), 10); err != nil {
		t.Fatal(err)
	}
	campaign = mustGetReleaseCampaign(t, svc, campaign.ID)
	markReleaseRolloutRunsCompleted(t, store, campaign.CurrentRolloutID, "release-v2", now)
	if _, err := svc.ReconcileReleaseCampaigns(t.Context(), 10); err != nil {
		t.Fatal(err)
	}
	now = now.Add(time.Minute)
	if advanced, err := svc.ReconcileReleaseRolloutSoaks(t.Context(), 10); !errors.Is(err, gateErr) || advanced != 1 {
		t.Fatalf("failed gate advanced=%d err=%v", advanced, err)
	}
	if _, err := svc.ReconcileReleaseCampaigns(t.Context(), 10); err != nil {
		t.Fatal(err)
	}
	campaign = mustGetReleaseCampaign(t, svc, campaign.ID)
	if campaign.Status != ReleaseCampaignStatusPaused || campaign.LastError != gateErr.Error() {
		t.Fatalf("paused campaign=%+v", campaign)
	}

	svc.releaseHealthGate = func(_ context.Context, _ ReleaseRollout) error { return nil }
	resumed, err := svc.ResumeReleaseCampaign(t.Context(), campaign.ID)
	if err != nil {
		t.Fatal(err)
	}
	if resumed.Status != ReleaseCampaignStatusSoaking {
		t.Fatalf("resumed campaign=%+v", resumed)
	}
	rollout, ok, err := svc.GetReleaseRollout(t.Context(), resumed.CurrentRolloutID)
	if err != nil || !ok || rollout.Status != ReleaseRolloutStatusSoaking || !rollout.SoakDeadline.Equal(now.Add(time.Minute)) {
		t.Fatalf("resumed rollout=%+v ok=%v err=%v", rollout, ok, err)
	}
	if advanced, err := svc.ReconcileReleaseRolloutSoaks(t.Context(), 10); err != nil || advanced != 0 {
		t.Fatalf("early gate advanced=%d err=%v", advanced, err)
	}
	now = now.Add(time.Minute)
	if advanced, err := svc.ReconcileReleaseRolloutSoaks(t.Context(), 10); err != nil || advanced != 1 {
		t.Fatalf("resumed gate advanced=%d err=%v", advanced, err)
	}
	if _, err := svc.ReconcileReleaseCampaigns(t.Context(), 10); err != nil {
		t.Fatal(err)
	}
	campaign = mustGetReleaseCampaign(t, svc, campaign.ID)
	if campaign.Status != ReleaseCampaignStatusCompleted || campaign.CompletedRings != 1 {
		t.Fatalf("completed campaign=%+v", campaign)
	}
}

func TestPausedReleaseCampaignStopsNewSetUpgradeClaims(t *testing.T) {
	store, svc, campaign := newSingleRingCampaign(t, 2)
	if _, err := svc.ReconcileReleaseCampaigns(t.Context(), 10); err != nil {
		t.Fatal(err)
	}
	campaign = mustGetReleaseCampaign(t, svc, campaign.ID)
	rollout, ok, err := svc.GetReleaseRollout(t.Context(), campaign.CurrentRolloutID)
	if err != nil || !ok {
		t.Fatalf("rollout ok=%v err=%v", ok, err)
	}
	paused, err := svc.PauseReleaseCampaign(t.Context(), campaign.ID)
	if err != nil || paused.Status != ReleaseCampaignStatusPaused {
		t.Fatalf("paused=%+v err=%v", paused, err)
	}
	if _, acquired, err := store.TryAcquireSetUpgradeRun(t.Context(), rollout.Batch.Runs[0].ID, "manager", time.Minute, svc.nowUTC()); err != nil || acquired {
		t.Fatalf("paused claim acquired=%v err=%v", acquired, err)
	}
	resumed, err := svc.ResumeReleaseCampaign(t.Context(), campaign.ID)
	if err != nil || resumed.Status != ReleaseCampaignStatusRunning {
		t.Fatalf("resumed=%+v err=%v", resumed, err)
	}
	if _, acquired, err := store.TryAcquireSetUpgradeRun(t.Context(), rollout.Batch.Runs[0].ID, "manager", time.Minute, svc.nowUTC()); err != nil || !acquired {
		t.Fatalf("resumed claim acquired=%v err=%v", acquired, err)
	}
}

func TestReleaseCampaignWorkerJobStartsPendingCampaign(t *testing.T) {
	_, svc, campaign := newSingleRingCampaign(t, 1)
	run, err := svc.RunWorkerJobNow(t.Context(), WorkerJobReconcileReleaseCampaigns)
	if err != nil || run.Status != WorkerJobStatusSuccess {
		t.Fatalf("run=%+v err=%v", run, err)
	}
	campaign = mustGetReleaseCampaign(t, svc, campaign.ID)
	if campaign.Status != ReleaseCampaignStatusRunning || campaign.CurrentRolloutID == "" {
		t.Fatalf("campaign=%+v", campaign)
	}
}

func TestPendingReleaseCampaignCanPauseAndResumeBeforeFirstRollout(t *testing.T) {
	_, svc, campaign := newSingleRingCampaign(t, 1)
	paused, err := svc.PauseReleaseCampaign(t.Context(), campaign.ID)
	if err != nil || paused.Status != ReleaseCampaignStatusPaused || paused.CurrentRolloutID != "" {
		t.Fatalf("paused=%+v err=%v", paused, err)
	}
	resumed, err := svc.ResumeReleaseCampaign(t.Context(), campaign.ID)
	if err != nil || resumed.Status != ReleaseCampaignStatusPending || resumed.Rings[0].Status != ReleaseCampaignRingStatusPending {
		t.Fatalf("resumed=%+v err=%v", resumed, err)
	}
	if _, err := svc.ReconcileReleaseCampaigns(t.Context(), 10); err != nil {
		t.Fatal(err)
	}
	running := mustGetReleaseCampaign(t, svc, campaign.ID)
	if running.Status != ReleaseCampaignStatusRunning || running.CurrentRolloutID == "" {
		t.Fatalf("running=%+v", running)
	}
}

func TestReleaseCampaignMetricsExposeOperatorState(t *testing.T) {
	_, svc, campaign := newSingleRingCampaign(t, 1)
	paused, err := svc.PauseReleaseCampaign(t.Context(), campaign.ID)
	if err != nil {
		t.Fatal(err)
	}
	metrics := svc.PrometheusMetrics()
	for _, want := range []string{
		`llmgateway_release_campaign_state{campaign_id="` + paused.ID + `",fleet="prod",target_release_id="release-v2",status="paused"} 1`,
		`llmgateway_release_campaign_ring_state{campaign_id="` + paused.ID + `",ring_id="canary",status="paused"} 1`,
	} {
		if !strings.Contains(metrics, want) {
			t.Fatalf("metrics missing %q:\n%s", want, metrics)
		}
	}
}

func TestReleaseCampaignPauseEmitsCommittedOTELTransition(t *testing.T) {
	_, svc, campaign := newSingleRingCampaign(t, 1)
	emitter, events := captureTelemetryEvents()
	svc.telemetryEmitter = emitter
	if _, err := svc.PauseReleaseCampaign(t.Context(), campaign.ID); err != nil {
		t.Fatal(err)
	}
	if len(*events) != 2 {
		t.Fatalf("events=%+v", *events)
	}
	requireTelemetryString(t, (*events)[0].event, "llmgateway.entity.type", "release_campaign")
	requireTelemetryString(t, (*events)[0].event, "llmgateway.state.to", ReleaseCampaignStatusPaused)
	requireTelemetryString(t, (*events)[0].event, "llmgateway.run.id", campaign.ID)
	requireTelemetryString(t, (*events)[1].event, "llmgateway.entity.type", "release_campaign_ring")
	requireTelemetryString(t, (*events)[1].event, "llmgateway.ring.id", "canary")
}

func TestReleaseCampaignAndSoakListsPrioritizeActiveWork(t *testing.T) {
	store := NewMemoryStore()
	now := time.Now().UTC()
	active := ReleaseCampaign{ID: "active", Fleet: "prod", Status: ReleaseCampaignStatusRunning, CreatedAt: now.Add(-time.Hour)}
	completed := ReleaseCampaign{ID: "completed", Fleet: "other", Status: ReleaseCampaignStatusCompleted, CreatedAt: now}
	if err := store.CreateReleaseCampaign(t.Context(), active, nil); err != nil {
		t.Fatal(err)
	}
	if err := store.CreateReleaseCampaign(t.Context(), completed, nil); err != nil {
		t.Fatal(err)
	}
	campaigns, err := store.ListReleaseCampaigns(t.Context(), 1)
	if err != nil || len(campaigns) != 1 || campaigns[0].ID != active.ID {
		t.Fatalf("campaigns=%+v err=%v", campaigns, err)
	}
	if err := store.SaveReleaseRollout(t.Context(), ReleaseRollout{ID: "soaking", Status: ReleaseRolloutStatusSoaking, CreatedAt: now.Add(-time.Hour)}); err != nil {
		t.Fatal(err)
	}
	for index := 0; index < 60; index++ {
		if err := store.SaveReleaseRollout(t.Context(), ReleaseRollout{ID: fmt.Sprintf("completed-%d", index), Status: ReleaseRolloutStatusCompleted, CreatedAt: now.Add(time.Duration(index) * time.Second)}); err != nil {
			t.Fatal(err)
		}
	}
	rollouts, err := store.ListReleaseRollouts(t.Context(), "", 50)
	if err != nil || len(rollouts) != 50 || rollouts[0].ID != "soaking" {
		t.Fatalf("first rollout=%+v count=%d err=%v", rollouts[0], len(rollouts), err)
	}
}

func TestReleaseCampaignRecoversUnboundRolloutAfterWorkerRestart(t *testing.T) {
	store, svc, campaign := newSingleRingCampaign(t, 1)
	rollout, err := svc.CreateReleaseRollout(t.Context(), CreateReleaseRolloutInput{
		RingID: "canary", TargetReleaseID: "release-v2", CampaignID: campaign.ID, CampaignSequence: 1,
	})
	if err != nil {
		t.Fatal(err)
	}
	restarted := NewService(store, nil, Options{})
	if advanced, err := restarted.ReconcileReleaseCampaigns(t.Context(), 10); err != nil || advanced != 1 {
		t.Fatalf("advanced=%d err=%v", advanced, err)
	}
	loaded := mustGetReleaseCampaign(t, restarted, campaign.ID)
	if loaded.CurrentRolloutID != rollout.ID || loaded.Rings[0].RolloutID != rollout.ID || loaded.Status != ReleaseCampaignStatusRunning {
		t.Fatalf("loaded=%+v", loaded)
	}
	rollouts, err := restarted.ListReleaseRollouts(t.Context(), "", 10)
	if err != nil || len(rollouts) != 1 {
		t.Fatalf("rollouts=%+v err=%v", rollouts, err)
	}
}

func TestReleaseCampaignResumesWhenRingCompletedBeforeCampaignProjection(t *testing.T) {
	store, svc, campaign := newSingleRingCampaign(t, 1)
	now := time.Date(2026, 7, 17, 12, 0, 0, 0, time.UTC)
	svc.now = func() time.Time { return now }
	svc.releaseHealthGate = func(context.Context, ReleaseRollout) error { return nil }
	if _, err := svc.ReconcileReleaseCampaigns(t.Context(), 10); err != nil {
		t.Fatal(err)
	}
	campaign = mustGetReleaseCampaign(t, svc, campaign.ID)
	markReleaseRolloutRunsCompleted(t, store, campaign.CurrentRolloutID, "release-v2", now)
	if _, err := svc.ReconcileReleaseCampaigns(t.Context(), 10); err != nil {
		t.Fatal(err)
	}
	now = now.Add(time.Minute)
	if _, err := svc.ReconcileReleaseRolloutSoaks(t.Context(), 10); err != nil {
		t.Fatal(err)
	}
	paused, err := svc.PauseReleaseCampaign(t.Context(), campaign.ID)
	if err != nil || paused.Status != ReleaseCampaignStatusPaused {
		t.Fatalf("paused=%+v err=%v", paused, err)
	}
	resumed, err := svc.ResumeReleaseCampaign(t.Context(), campaign.ID)
	if err != nil || resumed.Status != ReleaseCampaignStatusPending || resumed.CompletedRings != 1 {
		t.Fatalf("resumed=%+v err=%v", resumed, err)
	}
	if _, err := svc.ReconcileReleaseCampaigns(t.Context(), 10); err != nil {
		t.Fatal(err)
	}
	completed := mustGetReleaseCampaign(t, svc, campaign.ID)
	if completed.Status != ReleaseCampaignStatusCompleted {
		t.Fatalf("completed=%+v", completed)
	}
}

func newSingleRingCampaign(t *testing.T, setCount int) (*MemoryStore, *Service, ReleaseCampaign) {
	t.Helper()
	store := NewMemoryStore()
	svc := NewService(store, nil, Options{})
	for _, input := range []CreateNewAPIReleaseInput{
		{ID: "release-v1", Version: "v1", Image: testOldReleaseImage, Status: NewAPIReleaseStatusStable},
		{ID: "release-v2", Version: "v2", Image: testNewReleaseImage, Status: NewAPIReleaseStatusVerified},
	} {
		if _, err := svc.CreateNewAPIRelease(t.Context(), input); err != nil {
			t.Fatal(err)
		}
	}
	setIDs := make([]string, 0, setCount)
	for index := 0; index < setCount; index++ {
		setID := fmt.Sprintf("set-%d", index+1)
		setIDs = append(setIDs, setID)
		mustSaveSet(t, store, Set{ID: setID, Status: SetStatusActive, CurrentReleaseID: "release-v1", ActiveRuntimeGeneration: 1})
	}
	if _, err := svc.UpsertReleaseRing(t.Context(), UpsertReleaseRingInput{
		ID: "canary", Name: "Canary", ServingReleaseID: "release-v1", SetIDs: setIDs, SoakDuration: time.Minute,
	}); err != nil {
		t.Fatal(err)
	}
	campaign, err := svc.CreateReleaseCampaign(t.Context(), CreateReleaseCampaignInput{TargetReleaseID: "release-v2"})
	if err != nil {
		t.Fatal(err)
	}
	return store, svc, campaign
}

func mustGetReleaseCampaign(t *testing.T, svc *Service, id string) ReleaseCampaign {
	t.Helper()
	campaign, ok, err := svc.GetReleaseCampaign(t.Context(), id)
	if err != nil || !ok {
		t.Fatalf("get campaign ok=%v err=%v", ok, err)
	}
	return campaign
}

func assertReleaseRolloutRings(t *testing.T, svc *Service, want []string) {
	t.Helper()
	rollouts, err := svc.ListReleaseRollouts(t.Context(), "", 50)
	if err != nil {
		t.Fatal(err)
	}
	got := make([]string, 0, len(rollouts))
	for index := len(rollouts) - 1; index >= 0; index-- {
		got = append(got, rollouts[index].RingID)
	}
	if len(got) != len(want) {
		t.Fatalf("rollout rings=%v want=%v", got, want)
	}
	for index := range want {
		if got[index] != want[index] {
			t.Fatalf("rollout rings=%v want=%v", got, want)
		}
	}
}

func markReleaseRolloutRunsCompleted(t *testing.T, store *MemoryStore, rolloutID, releaseID string, now time.Time) {
	t.Helper()
	store.mu.Lock()
	defer store.mu.Unlock()
	rollout, ok := store.releaseRollouts[rolloutID]
	if !ok {
		t.Fatalf("rollout %q not found", rolloutID)
	}
	batch := store.setUpgradeBatches[rollout.BatchID]
	for id, run := range store.setUpgradeRuns {
		if run.BatchID != batch.ID {
			continue
		}
		run.Status = SetUpgradeRunStatusCompleted
		run.UpdatedAt = now
		store.setUpgradeRuns[id] = run
		set := store.sets[run.SetID]
		set.CurrentReleaseID = releaseID
		set.TargetReleaseID = ""
		set.AdminHealthStatus = SetAdminHealthHealthy
		set.AdmissionStatus = SetAdmissionStatusPassed
		store.sets[set.ID] = set
	}
}
