package gateway

import (
	"context"
	"fmt"
)

func (s *Service) ReconcileReleaseRolloutSoaks(ctx context.Context, limit int) (int, error) {
	if limit <= 0 {
		limit = 50
	}
	rollouts, err := s.store.ListReleaseRollouts(ctx, "", limit)
	if err != nil {
		return 0, err
	}
	advanced := 0
	var firstErr error
	for _, candidate := range rollouts {
		rollout, ok, getErr := s.GetReleaseRollout(ctx, candidate.ID)
		if getErr != nil {
			if firstErr == nil {
				firstErr = getErr
			}
			continue
		}
		if !ok || rollout.Status != ReleaseRolloutStatusSoaking || rollout.SoakDeadline.After(s.nowUTC()) {
			continue
		}
		if gateErr := s.runReleaseHealthGate(ctx, rollout); gateErr != nil {
			if err := s.finishReleaseRolloutSoak(ctx, rollout, gateErr); err != nil && firstErr == nil {
				firstErr = err
			} else if firstErr == nil {
				firstErr = gateErr
			}
			advanced++
			continue
		}
		if err := s.finishReleaseRolloutSoak(ctx, rollout, nil); err != nil {
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		advanced++
	}
	return advanced, firstErr
}

func (s *Service) runReleaseHealthGate(ctx context.Context, rollout ReleaseRollout) error {
	if s.releaseHealthGate != nil {
		return s.releaseHealthGate(ctx, rollout)
	}
	for _, run := range rollout.Batch.Runs {
		set, ok, err := s.store.GetSet(ctx, run.SetID)
		if err != nil {
			return err
		}
		if !ok {
			return fmt.Errorf("set %q not found", run.SetID)
		}
		if set.Status != SetStatusActive || set.CurrentReleaseID != rollout.TargetReleaseID || set.TargetReleaseID != "" {
			return fmt.Errorf("set %q release state is not stable", set.ID)
		}
		if set.AdminWritesPaused {
			return fmt.Errorf("set %q admin writes are paused", set.ID)
		}
		if set.AdminHealthStatus != SetAdminHealthHealthy {
			return fmt.Errorf("set %q admin health is %q", set.ID, set.AdminHealthStatus)
		}
		result, err := s.CheckSetAdmission(ctx, set.ID)
		if err != nil {
			return fmt.Errorf("set %q admission gate failed: %w", set.ID, err)
		}
		if result.Status != SetAdmissionStatusPassed {
			return fmt.Errorf("set %q admission gate is %q", set.ID, result.Status)
		}
	}
	return nil
}

func (s *Service) finishReleaseRolloutSoak(ctx context.Context, rollout ReleaseRollout, gateErr error) error {
	ring, ok, err := s.store.GetReleaseRing(ctx, rollout.RingID)
	if err != nil {
		return err
	}
	if !ok {
		return fmt.Errorf("release ring %q not found", rollout.RingID)
	}
	now := s.nowUTC()
	rollout.LastGateCheckedAt = now
	rollout.UpdatedAt = now
	ring.UpdatedAt = now
	if gateErr != nil {
		rollout.Status = ReleaseRolloutStatusPaused
		rollout.LastGateError = gateErr.Error()
		ring.Status = ReleaseRingStatusDegraded
		return s.store.SaveReleaseRolloutAndRing(ctx, rollout, ring)
	}
	rollout.Status = ReleaseRolloutStatusCompleted
	rollout.LastGateError = ""
	ring.Status = ReleaseRingStatusSteady
	ring.ServingReleaseID = rollout.TargetReleaseID
	ring.TargetReleaseID = ""
	return s.store.SaveReleaseRolloutAndRing(ctx, rollout, ring)
}
