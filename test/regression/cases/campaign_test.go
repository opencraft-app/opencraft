package cases

import (
	"context"
	"strings"
	"testing"
	"time"

	"git.woa.com/wisp/mono2/llmgateway/test/regression/clients"
	"git.woa.com/wisp/mono2/llmgateway/test/regression/framework"
)

func TestFleetCampaignCompletesRingsInOrderUnderTraffic(t *testing.T) {
	campaigns := &fakeCampaignControl{
		setsBefore: []clients.ManagedSet{
			{ID: "set-a", ReleaseRingID: "canary", CurrentReleaseID: "release-v1", ActiveRuntimeGeneration: 7, RouteRevision: 11},
			{ID: "set-b", ReleaseRingID: "stable", CurrentReleaseID: "release-v1", ActiveRuntimeGeneration: 4, RouteRevision: 8},
		},
		setsAfter: []clients.ManagedSet{
			{ID: "set-a", ReleaseRingID: "canary", CurrentReleaseID: "release-v2", ActiveRuntimeGeneration: 8, RouteRevision: 12},
			{ID: "set-b", ReleaseRingID: "stable", CurrentReleaseID: "release-v2", ActiveRuntimeGeneration: 5, RouteRevision: 9},
		},
		campaigns: []clients.ReleaseCampaign{
			campaignState("running", "canary", "rollout-canary", 0, "running", "pending"),
			campaignState("running", "stable", "rollout-stable", 1, "completed", "running"),
			campaignState("completed", "", "", 2, "completed", "completed"),
		},
		rollouts: map[string]clients.ReleaseRollout{
			"rollout-canary": campaignRollout("rollout-canary", "canary", 1, "set-a", 7, 8),
			"rollout-stable": campaignRollout("rollout-stable", "stable", 2, "set-b", 4, 5),
		},
		rings: []clients.ReleaseRing{
			{ID: "canary", Status: "steady", ServingReleaseID: "release-v2", ReleaseDistribution: map[string]int{"release-v2": 1}},
			{ID: "stable", Status: "steady", ServingReleaseID: "release-v2", ReleaseDistribution: map[string]int{"release-v2": 1}},
		},
	}
	traffic := &fakeTraffic{}
	cfg := campaignTestConfig()
	run := framework.NewRunContext("campaign-run", framework.NewSanitizer())
	run.Set(stateAPIKey, run.Sanitizer.Secret("sk-campaign"))

	observations, err := fleetReleaseCampaignCompleted(t.Context(), run, cfg, CampaignDependencies{Control: campaigns, Traffic: traffic})
	if err != nil {
		t.Fatal(err)
	}
	if traffic.chatCalls < cfg.MinCampaignSamples {
		t.Fatalf("traffic samples = %d", traffic.chatCalls)
	}
	if observations["completed_rings"] != 2 || observations["upgraded_sets"] != 2 || observations["traffic_errors"] != 0 {
		t.Fatalf("observations = %+v", observations)
	}
}

func TestFleetCampaignRejectsOutOfOrderRingActivation(t *testing.T) {
	campaigns := &fakeCampaignControl{
		setsBefore: []clients.ManagedSet{
			{ID: "set-a", ReleaseRingID: "canary", CurrentReleaseID: "release-v1", ActiveRuntimeGeneration: 1, RouteRevision: 1},
			{ID: "set-b", ReleaseRingID: "stable", CurrentReleaseID: "release-v1", ActiveRuntimeGeneration: 1, RouteRevision: 1},
		},
		campaigns: []clients.ReleaseCampaign{campaignState("running", "stable", "rollout-stable", 0, "pending", "running")},
		rollouts: map[string]clients.ReleaseRollout{
			"rollout-stable": campaignRollout("rollout-stable", "stable", 2, "set-b", 1, 2),
		},
	}
	run := framework.NewRunContext("campaign-order", framework.NewSanitizer())
	run.Set(stateAPIKey, run.Sanitizer.Secret("sk-campaign"))

	_, err := fleetReleaseCampaignCompleted(t.Context(), run, campaignTestConfig(), CampaignDependencies{Control: campaigns, Traffic: &fakeTraffic{}})
	if err == nil || !strings.Contains(err.Error(), "out of order") {
		t.Fatalf("err = %v", err)
	}
}

func campaignTestConfig() Config {
	cfg := testConfig()
	cfg.TargetSets = []string{"set-a", "set-b"}
	cfg.TargetReleaseID = "release-v2"
	cfg.ExpectedReleaseRings = []string{"canary", "stable"}
	cfg.CampaignTimeout = 100 * time.Millisecond
	cfg.CampaignPollInterval = time.Millisecond
	cfg.CampaignRequestInterval = time.Millisecond
	cfg.MinCampaignSamples = 2
	return cfg
}

func campaignState(status, currentRing, rolloutID string, completed int, canaryStatus, stableStatus string) clients.ReleaseCampaign {
	return clients.ReleaseCampaign{
		ID: "campaign-1", TargetReleaseID: "release-v2", Status: status,
		CurrentRingID: currentRing, CurrentRolloutID: rolloutID, TotalRings: 2, CompletedRings: completed,
		Rings: []clients.ReleaseCampaignRing{
			{Sequence: 1, RingID: "canary", Status: canaryStatus, RolloutID: func() string {
				if canaryStatus == "running" {
					return "rollout-canary"
				}
				return ""
			}()},
			{Sequence: 2, RingID: "stable", Status: stableStatus, RolloutID: func() string {
				if stableStatus == "running" {
					return "rollout-stable"
				}
				return ""
			}()},
		},
	}
}

func campaignRollout(id, ring string, sequence int, setID string, from, to int64) clients.ReleaseRollout {
	return clients.ReleaseRollout{
		ID: id, RingID: ring, TargetReleaseID: "release-v2", CampaignID: "campaign-1", CampaignSequence: sequence,
		Status: "running", TotalSets: 1, CurrentSetID: setID,
		Batch: clients.SetUpgradeBatch{Runs: []clients.SetUpgradeRun{{
			ID: id + "-run", SetID: setID, Status: "probing", FromGeneration: from, ToGeneration: to,
		}}},
	}
}

type fakeCampaignControl struct {
	setsBefore []clients.ManagedSet
	setsAfter  []clients.ManagedSet
	campaigns  []clients.ReleaseCampaign
	rollouts   map[string]clients.ReleaseRollout
	rings      []clients.ReleaseRing
	created    bool
	completed  bool
}

func (f *fakeCampaignControl) ListCampaignSets(context.Context) ([]clients.ManagedSet, error) {
	if f.completed {
		return append([]clients.ManagedSet(nil), f.setsAfter...), nil
	}
	return append([]clients.ManagedSet(nil), f.setsBefore...), nil
}

func (f *fakeCampaignControl) CreateReleaseCampaign(context.Context, string) (clients.ReleaseCampaign, error) {
	f.created = true
	return campaignState("pending", "", "", 0, "pending", "pending"), nil
}

func (f *fakeCampaignControl) ReleaseCampaign(context.Context, string) (clients.ReleaseCampaign, error) {
	if len(f.campaigns) == 0 {
		f.completed = true
		return campaignState("completed", "", "", 2, "completed", "completed"), nil
	}
	result := f.campaigns[0]
	f.campaigns = f.campaigns[1:]
	if result.Status == "completed" {
		f.completed = true
	}
	return result, nil
}

func (f *fakeCampaignControl) ReleaseRollout(_ context.Context, id string) (clients.ReleaseRollout, error) {
	return f.rollouts[id], nil
}

func (f *fakeCampaignControl) ListReleaseRings(context.Context) ([]clients.ReleaseRing, error) {
	return append([]clients.ReleaseRing(nil), f.rings...), nil
}
