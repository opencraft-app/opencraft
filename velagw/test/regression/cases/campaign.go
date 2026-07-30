package cases

import (
	"context"
	"fmt"
	"time"

	"git.woa.com/wisp/mono2/llmgateway/test/regression/clients"
	"git.woa.com/wisp/mono2/llmgateway/test/regression/framework"
)

const CaseFleetCampaign = "fleet_release_campaign_completes_in_ring_order"

type CampaignControl interface {
	ListCampaignSets(context.Context) ([]clients.ManagedSet, error)
	CreateReleaseCampaign(context.Context, string) (clients.ReleaseCampaign, error)
	ReleaseCampaign(context.Context, string) (clients.ReleaseCampaign, error)
	ReleaseRollout(context.Context, string) (clients.ReleaseRollout, error)
	ListReleaseRings(context.Context) ([]clients.ReleaseRing, error)
}

type CampaignDependencies struct {
	Control CampaignControl
	Traffic TrafficPlane
}

func NewCampaignCases(cfg Config, deps CampaignDependencies) []framework.Case {
	cfg = withConfigDefaults(cfg)
	return []framework.Case{framework.CaseFunc{
		CaseID: CaseFleetCampaign, DependsOn: []string{CaseKeyStreamsChat},
		Requires: []framework.Capability{framework.CapabilityKubernetesAPI, framework.CapabilityClusterPodNetwork},
		RunFunc: func(ctx context.Context, run *framework.RunContext) (framework.Observations, error) {
			return fleetReleaseCampaignCompleted(ctx, run, cfg, deps)
		},
	}}
}

func FleetCampaignGate() framework.Scenario {
	return framework.Scenario{Name: "fleet_release_campaign_gate", Cases: []string{
		CasePlatformReady, CaseChannelDelivery, CaseTenantOnboarded, CaseTenantAPIKey,
		CaseModelEffective, CaseKeyCompletesChat, CaseKeyStreamsChat, CaseFleetCampaign,
	}}
}

type campaignSetBaseline struct {
	RingID        string
	ReleaseID     string
	Generation    int64
	RouteRevision int64
}

func fleetReleaseCampaignCompleted(ctx context.Context, run *framework.RunContext, cfg Config, deps CampaignDependencies) (framework.Observations, error) {
	if deps.Control == nil || deps.Traffic == nil {
		return nil, fmt.Errorf("campaign control and traffic dependencies are required")
	}
	if cfg.TargetReleaseID == "" || len(cfg.ExpectedReleaseRings) == 0 {
		return nil, fmt.Errorf("target release and expected release rings are required")
	}
	sets, err := deps.Control.ListCampaignSets(ctx)
	if err != nil {
		return nil, err
	}
	baseline := make(map[string]campaignSetBaseline, len(cfg.TargetSets))
	for _, setID := range cfg.TargetSets {
		set, ok := managedSetByID(sets, setID)
		if !ok {
			return nil, fmt.Errorf("campaign target Set %q is not managed", setID)
		}
		if set.CurrentReleaseID == cfg.TargetReleaseID {
			return nil, fmt.Errorf("campaign target Set %q already serves release %q", setID, cfg.TargetReleaseID)
		}
		if !contains(cfg.ExpectedReleaseRings, set.ReleaseRingID) {
			return nil, fmt.Errorf("campaign target Set %q belongs to unexpected ring %q", setID, set.ReleaseRingID)
		}
		baseline[setID] = campaignSetBaseline{
			RingID: set.ReleaseRingID, ReleaseID: set.CurrentReleaseID,
			Generation: set.ActiveRuntimeGeneration, RouteRevision: set.RouteRevision,
		}
	}
	campaign, err := deps.Control.CreateReleaseCampaign(ctx, cfg.TargetReleaseID)
	if err != nil {
		return nil, err
	}
	if campaign.ID == "" || campaign.TargetReleaseID != cfg.TargetReleaseID {
		return nil, fmt.Errorf("created release campaign is incomplete")
	}
	run.TrackResource(framework.ResourceRef{Kind: "release_campaign", ID: campaign.ID})
	deadline := time.Now().Add(cfg.CampaignTimeout)
	samplerCfg := cfg
	samplerCfg.RequestInterval = cfg.CampaignRequestInterval
	sampler := newNormalSampler(deps.Traffic, samplerCfg, runSecret(run, stateAPIKey))
	sampler.setPhase(samplePhaseRollout)
	samplerCtx, stopSampler := context.WithCancel(ctx)
	defer stopSampler()
	sampler.start(samplerCtx)
	lastSequence := 0
	seenRuns := map[string]clients.SetUpgradeRun{}
	for {
		stats := sampler.stats()
		if stats.errors > 0 {
			return nil, fmt.Errorf("traffic failed during release campaign (%d failed samples)", stats.errors)
		}
		campaign, err = deps.Control.ReleaseCampaign(ctx, campaign.ID)
		if err != nil {
			return nil, err
		}
		sequence, validateErr := validateCampaignProgress(campaign, cfg.ExpectedReleaseRings)
		if validateErr != nil {
			return nil, validateErr
		}
		if sequence < lastSequence {
			return nil, fmt.Errorf("release campaign moved backward from ring sequence %d to %d", lastSequence, sequence)
		}
		lastSequence = sequence
		if campaign.CurrentRolloutID != "" {
			rollout, rolloutErr := deps.Control.ReleaseRollout(ctx, campaign.CurrentRolloutID)
			if rolloutErr != nil {
				return nil, rolloutErr
			}
			if err := validateCampaignRollout(campaign, rollout, sequence, baseline, seenRuns); err != nil {
				return nil, err
			}
		}
		if campaign.Status == "paused" || campaign.Status == "failed" {
			return nil, fmt.Errorf("release campaign %q stopped in %q: %s", campaign.ID, campaign.Status, campaign.LastError)
		}
		if campaign.Status == "completed" && stats.rollout >= cfg.MinCampaignSamples {
			break
		}
		if !time.Now().Before(deadline) {
			return nil, fmt.Errorf("release campaign %q did not complete before timeout", campaign.ID)
		}
		if err := wait(ctx, cfg.CampaignPollInterval); err != nil {
			return nil, err
		}
	}
	stopSampler()
	if err := sampler.waitStopped(ctx); err != nil && ctx.Err() == nil {
		return nil, err
	}
	trafficStats := sampler.stats()
	if trafficStats.errors > 0 {
		return nil, fmt.Errorf("traffic failed during release campaign (%d failed samples)", trafficStats.errors)
	}
	sets, err = deps.Control.ListCampaignSets(ctx)
	if err != nil {
		return nil, err
	}
	for setID, before := range baseline {
		if _, ok := seenRuns[setID]; !ok {
			return nil, fmt.Errorf("campaign target Set %q was never observed in a release rollout", setID)
		}
		set, ok := managedSetByID(sets, setID)
		if !ok || set.CurrentReleaseID != cfg.TargetReleaseID || set.TargetReleaseID != "" {
			return nil, fmt.Errorf("campaign target Set %q did not converge to release %q", setID, cfg.TargetReleaseID)
		}
		if set.ActiveRuntimeGeneration != before.Generation+1 || set.RouteRevision <= before.RouteRevision {
			return nil, fmt.Errorf("campaign target Set %q has invalid generation or route revision transition", setID)
		}
	}
	if err := validateFinalReleaseRings(ctx, deps.Control, cfg); err != nil {
		return nil, err
	}
	return framework.Observations{
		"campaign_id": campaign.ID, "target_release_id": cfg.TargetReleaseID,
		"completed_rings": campaign.CompletedRings, "upgraded_sets": len(baseline),
		"traffic_samples": trafficStats.rollout, "traffic_errors": trafficStats.errors,
	}, nil
}

func validateCampaignProgress(campaign clients.ReleaseCampaign, expected []string) (int, error) {
	if campaign.TotalRings != len(expected) || len(campaign.Rings) != len(expected) {
		return 0, fmt.Errorf("release campaign ring count does not match expected topology")
	}
	activeSequence, completed := 0, 0
	seenIncomplete := false
	for index, ring := range campaign.Rings {
		expectedSequence := index + 1
		if ring.Sequence != expectedSequence || ring.RingID != expected[index] {
			return 0, fmt.Errorf("release campaign rings are out of order at sequence %d", expectedSequence)
		}
		if ring.Status == "completed" {
			if seenIncomplete {
				return 0, fmt.Errorf("release campaign rings completed out of order")
			}
			completed++
			continue
		}
		seenIncomplete = true
		if ring.Status != "pending" {
			if activeSequence != 0 {
				return 0, fmt.Errorf("release campaign has multiple active rings")
			}
			activeSequence = ring.Sequence
		}
	}
	if completed != campaign.CompletedRings {
		return 0, fmt.Errorf("release campaign completed ring count is inconsistent")
	}
	if campaign.Status == "completed" {
		if completed != len(expected) || campaign.CurrentRingID != "" || campaign.CurrentRolloutID != "" {
			return 0, fmt.Errorf("completed release campaign still has active work")
		}
		return len(expected), nil
	}
	if activeSequence == 0 {
		activeSequence = completed + 1
	}
	if activeSequence != completed+1 || (campaign.CurrentRingID != "" && campaign.CurrentRingID != expected[activeSequence-1]) {
		return 0, fmt.Errorf("release campaign activated ring out of order")
	}
	return activeSequence, nil
}

func validateCampaignRollout(campaign clients.ReleaseCampaign, rollout clients.ReleaseRollout, sequence int, baseline map[string]campaignSetBaseline, seen map[string]clients.SetUpgradeRun) error {
	if rollout.ID != campaign.CurrentRolloutID || rollout.CampaignID != campaign.ID || rollout.CampaignSequence != sequence || rollout.TargetReleaseID != campaign.TargetReleaseID {
		return fmt.Errorf("release rollout does not belong to the current campaign ring")
	}
	active := 0
	for _, run := range rollout.Batch.Runs {
		if _, ok := baseline[run.SetID]; !ok {
			return fmt.Errorf("release rollout contains unexpected Set %q", run.SetID)
		}
		if run.ToGeneration != run.FromGeneration+1 {
			return fmt.Errorf("release rollout Set %q skipped runtime generation", run.SetID)
		}
		if run.Status != "pending" && run.Status != "completed" && run.Status != "failed" && run.Status != "rolled_back" {
			active++
		}
		seen[run.SetID] = run
	}
	if active > 1 {
		return fmt.Errorf("release rollout has %d active Sets; max_parallel=1 is required", active)
	}
	return nil
}

func validateFinalReleaseRings(ctx context.Context, control CampaignControl, cfg Config) error {
	rings, err := control.ListReleaseRings(ctx)
	if err != nil {
		return err
	}
	byID := make(map[string]clients.ReleaseRing, len(rings))
	for _, ring := range rings {
		byID[ring.ID] = ring
	}
	for _, ringID := range cfg.ExpectedReleaseRings {
		ring, ok := byID[ringID]
		if !ok || ring.Status != "steady" || ring.ServingReleaseID != cfg.TargetReleaseID || ring.TargetReleaseID != "" {
			return fmt.Errorf("release ring %q did not return to steady target release", ringID)
		}
		if ring.SetCount > 0 && ring.ReleaseDistribution[cfg.TargetReleaseID] != ring.SetCount {
			return fmt.Errorf("release ring %q still contains another release", ringID)
		}
	}
	return nil
}

func managedSetByID(sets []clients.ManagedSet, id string) (clients.ManagedSet, bool) {
	for _, set := range sets {
		if set.ID == id {
			return set, true
		}
	}
	return clients.ManagedSet{}, false
}
