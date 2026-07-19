package gateway

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"time"
)

func (s *Service) CreateReleaseCampaign(ctx context.Context, input CreateReleaseCampaignInput) (ReleaseCampaign, error) {
	input.TargetReleaseID = strings.TrimSpace(input.TargetReleaseID)
	release, ok, err := s.store.GetNewAPIRelease(ctx, input.TargetReleaseID)
	if err != nil {
		return ReleaseCampaign{}, err
	}
	if !ok {
		return ReleaseCampaign{}, fmt.Errorf("release %q not found", input.TargetReleaseID)
	}
	if release.Status != NewAPIReleaseStatusVerified && release.Status != NewAPIReleaseStatusStable {
		return ReleaseCampaign{}, fmt.Errorf("release %q is not verified", release.ID)
	}
	rings, err := s.store.ListReleaseRings(ctx)
	if err != nil {
		return ReleaseCampaign{}, err
	}
	sets, err := s.store.ListSets(ctx)
	if err != nil {
		return ReleaseCampaign{}, err
	}
	needsUpgrade := map[string]bool{}
	for _, set := range sets {
		if set.CurrentReleaseID != release.ID {
			needsUpgrade[set.ReleaseRingID] = true
		}
	}
	selected := make([]ReleaseRing, 0)
	for _, ring := range rings {
		if ring.Source != release.Source || ring.Namespace != release.Namespace || ring.Fleet != release.Fleet || !needsUpgrade[ring.ID] {
			continue
		}
		if ring.Status != ReleaseRingStatusSteady {
			return ReleaseCampaign{}, fmt.Errorf("release ring %q is not steady", ring.ID)
		}
		selected = append(selected, ring)
	}
	if len(selected) == 0 {
		return ReleaseCampaign{}, fmt.Errorf("fleet %q has no release rings requiring upgrade", release.Fleet)
	}
	sort.Slice(selected, func(i, j int) bool {
		if selected[i].Ordinal != selected[j].Ordinal {
			return selected[i].Ordinal < selected[j].Ordinal
		}
		return selected[i].ID < selected[j].ID
	})
	now := s.nowUTC()
	campaign := ReleaseCampaign{
		ID: fmt.Sprintf("release-campaign-%d", now.UnixNano()), Source: release.Source,
		Namespace: release.Namespace, Fleet: release.Fleet, TargetReleaseID: release.ID,
		Status: ReleaseCampaignStatusPending, TotalRings: len(selected), CreatedAt: now, UpdatedAt: now,
	}
	steps := make([]ReleaseCampaignRing, 0, len(selected))
	for index, ring := range selected {
		steps = append(steps, ReleaseCampaignRing{
			CampaignID: campaign.ID, Sequence: index + 1, RingID: ring.ID,
			Status: ReleaseCampaignRingStatusPending, CreatedAt: now, UpdatedAt: now,
		})
	}
	if err := s.store.CreateReleaseCampaign(ctx, campaign, steps); err != nil {
		return ReleaseCampaign{}, err
	}
	s.emitReleaseCampaignTransition(ctx, ReleaseCampaign{}, campaign)
	for _, step := range steps {
		s.emitReleaseCampaignRingTransition(ctx, ReleaseCampaignRing{}, step)
	}
	campaign.Rings = steps
	return campaign, nil
}

func (s *Service) GetReleaseCampaign(ctx context.Context, id string) (ReleaseCampaign, bool, error) {
	return s.store.GetReleaseCampaign(ctx, strings.TrimSpace(id))
}

func (s *Service) ListReleaseCampaigns(ctx context.Context, limit int) ([]ReleaseCampaign, error) {
	return s.store.ListReleaseCampaigns(ctx, limit)
}

func (s *Service) PauseReleaseCampaign(ctx context.Context, id string) (ReleaseCampaign, error) {
	campaign, ok, err := s.store.GetReleaseCampaign(ctx, strings.TrimSpace(id))
	if err != nil {
		return ReleaseCampaign{}, err
	}
	if !ok {
		return ReleaseCampaign{}, fmt.Errorf("release campaign %q not found", id)
	}
	if campaign.Status == ReleaseCampaignStatusCompleted {
		return ReleaseCampaign{}, fmt.Errorf("release campaign %q is already completed", campaign.ID)
	}
	if campaign.Status == ReleaseCampaignStatusPaused {
		return campaign, nil
	}
	step, ok := currentReleaseCampaignRing(campaign)
	if !ok {
		return ReleaseCampaign{}, fmt.Errorf("release campaign %q has no current ring", campaign.ID)
	}
	now := s.nowUTC()
	previousCampaign, previousStep := campaign, step
	campaign.Status = ReleaseCampaignStatusPaused
	campaign.LastError = "paused by operator"
	campaign.CurrentRingID = step.RingID
	campaign.UpdatedAt = now
	step.Status = ReleaseCampaignRingStatusPaused
	step.LastError = campaign.LastError
	step.UpdatedAt = now
	if err := s.saveReleaseCampaignState(ctx, previousCampaign, campaign, previousStep, step); err != nil {
		return ReleaseCampaign{}, err
	}
	return s.mustGetReleaseCampaign(ctx, campaign.ID)
}

func (s *Service) ResumeReleaseCampaign(ctx context.Context, id string) (ReleaseCampaign, error) {
	campaign, ok, err := s.store.GetReleaseCampaign(ctx, strings.TrimSpace(id))
	if err != nil {
		return ReleaseCampaign{}, err
	}
	if !ok {
		return ReleaseCampaign{}, fmt.Errorf("release campaign %q not found", id)
	}
	if campaign.Status != ReleaseCampaignStatusPaused {
		return ReleaseCampaign{}, fmt.Errorf("release campaign %q is not paused", campaign.ID)
	}
	step, ok := currentReleaseCampaignRing(campaign)
	if !ok {
		return ReleaseCampaign{}, fmt.Errorf("release campaign %q has no resumable ring", campaign.ID)
	}
	if step.RolloutID == "" {
		now := s.nowUTC()
		previousCampaign, previousStep := campaign, step
		campaign.Status = ReleaseCampaignStatusPending
		campaign.LastError = ""
		campaign.CurrentRingID = ""
		campaign.CurrentRolloutID = ""
		campaign.UpdatedAt = now
		step.Status = ReleaseCampaignRingStatusPending
		step.LastError = ""
		step.UpdatedAt = now
		if err := s.saveReleaseCampaignState(ctx, previousCampaign, campaign, previousStep, step); err != nil {
			return ReleaseCampaign{}, err
		}
		return s.mustGetReleaseCampaign(ctx, campaign.ID)
	}
	rollout, ok, err := s.GetReleaseRollout(ctx, step.RolloutID)
	if err != nil {
		return ReleaseCampaign{}, err
	}
	if !ok {
		return ReleaseCampaign{}, fmt.Errorf("release rollout %q not found", step.RolloutID)
	}
	if rollout.FailedSets > 0 {
		return ReleaseCampaign{}, fmt.Errorf("release rollout %q still has failed or rolled-back Set runs", rollout.ID)
	}
	if rollout.Status == ReleaseRolloutStatusCompleted {
		now := s.nowUTC()
		previousCampaign, previousStep := campaign, step
		step.Status = ReleaseCampaignRingStatusCompleted
		step.LastError = ""
		step.UpdatedAt = now
		campaign.Status = ReleaseCampaignStatusPending
		campaign.CompletedRings = countCompletedCampaignRings(campaign.Rings, step)
		campaign.CurrentRingID = ""
		campaign.CurrentRolloutID = ""
		campaign.LastError = ""
		campaign.UpdatedAt = now
		if err := s.saveReleaseCampaignState(ctx, previousCampaign, campaign, previousStep, step); err != nil {
			return ReleaseCampaign{}, err
		}
		return s.mustGetReleaseCampaign(ctx, campaign.ID)
	}
	ring, ok, err := s.store.GetReleaseRing(ctx, step.RingID)
	if err != nil {
		return ReleaseCampaign{}, err
	}
	if !ok {
		return ReleaseCampaign{}, fmt.Errorf("release ring %q not found", step.RingID)
	}
	now := s.nowUTC()
	previousCampaign, previousStep := campaign, step
	switch rollout.Status {
	case ReleaseRolloutStatusPaused:
		if rollout.LastGateError == "" {
			return ReleaseCampaign{}, fmt.Errorf("release rollout %q is paused without a retryable health gate", rollout.ID)
		}
		rollout.Status = ReleaseRolloutStatusSoaking
		rollout.SoakStartedAt = now
		rollout.SoakDeadline = now.Add(ring.SoakDuration)
		rollout.LastGateCheckedAt = time.Time{}
		rollout.LastGateError = ""
		ring.Status = ReleaseRingStatusSoaking
		campaign.Status = ReleaseCampaignStatusSoaking
		step.Status = ReleaseCampaignRingStatusSoaking
	case ReleaseRolloutStatusRunning:
		ring.Status = ReleaseRingStatusRolling
		campaign.Status = ReleaseCampaignStatusRunning
		step.Status = ReleaseCampaignRingStatusRunning
	case ReleaseRolloutStatusSoaking:
		ring.Status = ReleaseRingStatusSoaking
		campaign.Status = ReleaseCampaignStatusSoaking
		step.Status = ReleaseCampaignRingStatusSoaking
	default:
		return ReleaseCampaign{}, fmt.Errorf("release rollout %q cannot resume from %q", rollout.ID, rollout.Status)
	}
	campaign.LastError = ""
	campaign.CurrentRingID = step.RingID
	campaign.CurrentRolloutID = rollout.ID
	campaign.UpdatedAt = now
	step.LastError = ""
	step.UpdatedAt = now
	rollout.UpdatedAt = now
	ring.UpdatedAt = now
	if err := s.store.ResumeReleaseCampaign(ctx, campaign, step, rollout, ring); err != nil {
		return ReleaseCampaign{}, err
	}
	s.emitReleaseCampaignTransition(ctx, previousCampaign, campaign)
	s.emitReleaseCampaignRingTransition(ctx, previousStep, step)
	return s.mustGetReleaseCampaign(ctx, campaign.ID)
}

func (s *Service) mustGetReleaseCampaign(ctx context.Context, id string) (ReleaseCampaign, error) {
	campaign, ok, err := s.store.GetReleaseCampaign(ctx, id)
	if err != nil {
		return ReleaseCampaign{}, err
	}
	if !ok {
		return ReleaseCampaign{}, fmt.Errorf("release campaign %q not found", id)
	}
	return campaign, nil
}

func (s *Service) ReconcileReleaseCampaigns(ctx context.Context, limit int) (int, error) {
	if limit <= 0 {
		limit = 25
	}
	campaigns, err := s.store.ListReleaseCampaigns(ctx, limit)
	if err != nil {
		return 0, err
	}
	advanced := 0
	var firstErr error
	for _, campaign := range campaigns {
		if campaign.Status == ReleaseCampaignStatusCompleted || campaign.Status == ReleaseCampaignStatusPaused {
			continue
		}
		changed, reconcileErr := s.reconcileReleaseCampaign(ctx, campaign)
		if changed {
			advanced++
		}
		if reconcileErr != nil && firstErr == nil {
			firstErr = reconcileErr
		}
	}
	return advanced, firstErr
}

func (s *Service) reconcileReleaseCampaign(ctx context.Context, campaign ReleaseCampaign) (bool, error) {
	step, found := currentReleaseCampaignRing(campaign)
	if !found {
		if campaign.CompletedRings == campaign.TotalRings {
			previousCampaign := campaign
			campaign.Status = ReleaseCampaignStatusCompleted
			campaign.CurrentRingID = ""
			campaign.CurrentRolloutID = ""
			campaign.LastError = ""
			campaign.UpdatedAt = s.nowUTC()
			return true, s.saveReleaseCampaignState(ctx, previousCampaign, campaign, ReleaseCampaignRing{}, ReleaseCampaignRing{})
		}
		return false, fmt.Errorf("release campaign %q has no current ring", campaign.ID)
	}
	if step.RolloutID == "" {
		return s.startReleaseCampaignRing(ctx, campaign, step)
	}
	rollout, ok, err := s.GetReleaseRollout(ctx, step.RolloutID)
	if err != nil {
		return false, err
	}
	if !ok {
		return false, fmt.Errorf("release rollout %q not found", step.RolloutID)
	}
	previousCampaign, previousStep := campaign, step
	now := s.nowUTC()
	campaign.CurrentRingID = step.RingID
	campaign.CurrentRolloutID = rollout.ID
	campaign.UpdatedAt = now
	step.UpdatedAt = now
	switch rollout.Status {
	case ReleaseRolloutStatusRunning:
		campaign.Status = ReleaseCampaignStatusRunning
		step.Status = ReleaseCampaignRingStatusRunning
	case ReleaseRolloutStatusSoaking:
		campaign.Status = ReleaseCampaignStatusSoaking
		step.Status = ReleaseCampaignRingStatusSoaking
	case ReleaseRolloutStatusPaused, ReleaseRolloutStatusFailed:
		campaign.Status = ReleaseCampaignStatusPaused
		campaign.LastError = firstNonEmpty(rollout.LastGateError, "release rollout paused")
		step.Status = ReleaseCampaignRingStatusPaused
		step.LastError = campaign.LastError
	case ReleaseRolloutStatusCompleted:
		step.Status = ReleaseCampaignRingStatusCompleted
		step.LastError = ""
		campaign.CompletedRings = countCompletedCampaignRings(campaign.Rings, step)
		campaign.CurrentRingID = ""
		campaign.CurrentRolloutID = ""
		campaign.LastError = ""
		if err := s.saveReleaseCampaignState(ctx, previousCampaign, campaign, previousStep, step); err != nil {
			return false, err
		}
		campaign, _, err = s.store.GetReleaseCampaign(ctx, campaign.ID)
		if err != nil {
			return false, err
		}
		next, hasNext := currentReleaseCampaignRing(campaign)
		if !hasNext {
			previousCampaign = campaign
			campaign.Status = ReleaseCampaignStatusCompleted
			campaign.UpdatedAt = now
			return true, s.saveReleaseCampaignState(ctx, previousCampaign, campaign, ReleaseCampaignRing{}, ReleaseCampaignRing{})
		}
		return s.startReleaseCampaignRing(ctx, campaign, next)
	default:
		return false, fmt.Errorf("release rollout %q has unsupported status %q", rollout.ID, rollout.Status)
	}
	return true, s.saveReleaseCampaignState(ctx, previousCampaign, campaign, previousStep, step)
}

func (s *Service) startReleaseCampaignRing(ctx context.Context, campaign ReleaseCampaign, step ReleaseCampaignRing) (bool, error) {
	if rollout, ok, err := s.findReleaseCampaignRollout(ctx, campaign.ID, step.Sequence); err != nil {
		return false, err
	} else if ok {
		return true, s.bindReleaseCampaignRollout(ctx, campaign, step, rollout)
	}
	rollout, err := s.CreateReleaseRollout(ctx, CreateReleaseRolloutInput{
		RingID: step.RingID, TargetReleaseID: campaign.TargetReleaseID,
		CampaignID: campaign.ID, CampaignSequence: step.Sequence,
	})
	if err != nil {
		previousCampaign, previousStep := campaign, step
		campaign.Status = ReleaseCampaignStatusPaused
		campaign.LastError = err.Error()
		campaign.CurrentRingID = step.RingID
		campaign.UpdatedAt = s.nowUTC()
		step.Status = ReleaseCampaignRingStatusPaused
		step.LastError = err.Error()
		step.UpdatedAt = campaign.UpdatedAt
		_ = s.saveReleaseCampaignState(context.WithoutCancel(ctx), previousCampaign, campaign, previousStep, step)
		return true, err
	}
	return true, s.bindReleaseCampaignRollout(ctx, campaign, step, rollout)
}

func (s *Service) bindReleaseCampaignRollout(ctx context.Context, campaign ReleaseCampaign, step ReleaseCampaignRing, rollout ReleaseRollout) error {
	previousCampaign, previousStep := campaign, step
	now := s.nowUTC()
	step.RolloutID = rollout.ID
	step.Status = ReleaseCampaignRingStatusRunning
	step.LastError = ""
	step.UpdatedAt = now
	campaign.Status = ReleaseCampaignStatusRunning
	campaign.CurrentRingID = step.RingID
	campaign.CurrentRolloutID = rollout.ID
	campaign.LastError = ""
	campaign.UpdatedAt = now
	return s.saveReleaseCampaignState(ctx, previousCampaign, campaign, previousStep, step)
}

func (s *Service) saveReleaseCampaignState(ctx context.Context, previousCampaign, campaign ReleaseCampaign, previousStep, step ReleaseCampaignRing) error {
	if err := s.store.SaveReleaseCampaign(ctx, campaign, step); err != nil {
		return err
	}
	s.emitReleaseCampaignTransition(ctx, previousCampaign, campaign)
	s.emitReleaseCampaignRingTransition(ctx, previousStep, step)
	return nil
}

func (s *Service) findReleaseCampaignRollout(ctx context.Context, campaignID string, sequence int) (ReleaseRollout, bool, error) {
	rollout, ok, err := s.store.GetReleaseRolloutByCampaignStep(ctx, campaignID, sequence)
	if err != nil {
		return ReleaseRollout{}, false, err
	}
	if !ok {
		return ReleaseRollout{}, false, nil
	}
	rollout, err = s.decorateReleaseRollout(ctx, rollout)
	return rollout, err == nil, err
}

func currentReleaseCampaignRing(campaign ReleaseCampaign) (ReleaseCampaignRing, bool) {
	for _, ring := range campaign.Rings {
		if ring.Status != ReleaseCampaignRingStatusCompleted {
			return ring, true
		}
	}
	return ReleaseCampaignRing{}, false
}

func countCompletedCampaignRings(rings []ReleaseCampaignRing, current ReleaseCampaignRing) int {
	count := 0
	for _, ring := range rings {
		if ring.Sequence == current.Sequence {
			ring = current
		}
		if ring.Status == ReleaseCampaignRingStatusCompleted {
			count++
		}
	}
	return count
}
