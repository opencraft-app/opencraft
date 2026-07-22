package gateway

import (
	"context"
	"fmt"
	"sort"
)

func (s *MemoryStore) SaveNewAPIRelease(_ context.Context, release NewAPIRelease) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if existing, ok := s.newAPIReleases[release.ID]; ok {
		if existing.Source != release.Source || existing.Namespace != release.Namespace || existing.Fleet != release.Fleet ||
			existing.Version != release.Version || existing.Image != release.Image || existing.Compatibility != release.Compatibility || existing.Status != release.Status {
			return fmt.Errorf("new-api release %q is immutable", release.ID)
		}
		return nil
	}
	s.newAPIReleases[release.ID] = release
	return nil
}

func (s *MemoryStore) GetNewAPIRelease(_ context.Context, id string) (NewAPIRelease, bool, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	release, ok := s.newAPIReleases[id]
	return release, ok, nil
}

func (s *MemoryStore) ListNewAPIReleases(_ context.Context) ([]NewAPIRelease, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	result := make([]NewAPIRelease, 0, len(s.newAPIReleases))
	for _, release := range s.newAPIReleases {
		result = append(result, release)
	}
	sort.Slice(result, func(i, j int) bool { return result[i].CreatedAt.Before(result[j].CreatedAt) })
	return result, nil
}

func (s *MemoryStore) SaveReleaseRing(_ context.Context, ring ReleaseRing) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if existing, ok := s.releaseRings[ring.ID]; ok {
		ring.CreatedAt = existing.CreatedAt
	}
	s.releaseRings[ring.ID] = ring
	return nil
}

func (s *MemoryStore) GetReleaseRing(_ context.Context, id string) (ReleaseRing, bool, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	ring, ok := s.releaseRings[id]
	return ring, ok, nil
}

func (s *MemoryStore) ListReleaseRings(_ context.Context) ([]ReleaseRing, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	result := make([]ReleaseRing, 0, len(s.releaseRings))
	for _, ring := range s.releaseRings {
		result = append(result, ring)
	}
	sort.Slice(result, func(i, j int) bool {
		if result[i].Ordinal != result[j].Ordinal {
			return result[i].Ordinal < result[j].Ordinal
		}
		return result[i].ID < result[j].ID
	})
	return result, nil
}

func (s *MemoryStore) SaveReleaseRollout(_ context.Context, rollout ReleaseRollout) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if existing, ok := s.releaseRollouts[rollout.ID]; ok {
		rollout.CreatedAt = existing.CreatedAt
	}
	rollout.Batch = SetUpgradeBatch{}
	s.releaseRollouts[rollout.ID] = rollout
	return nil
}

func (s *MemoryStore) GetReleaseRollout(_ context.Context, id string) (ReleaseRollout, bool, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	rollout, ok := s.releaseRollouts[id]
	return rollout, ok, nil
}

func (s *MemoryStore) GetReleaseRolloutByCampaignStep(_ context.Context, campaignID string, sequence int) (ReleaseRollout, bool, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, rollout := range s.releaseRollouts {
		if rollout.CampaignID == campaignID && rollout.CampaignSequence == sequence {
			return rollout, true, nil
		}
	}
	return ReleaseRollout{}, false, nil
}

func (s *MemoryStore) ListReleaseRollouts(_ context.Context, ringID string, limit int) ([]ReleaseRollout, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	result := make([]ReleaseRollout, 0)
	for _, rollout := range s.releaseRollouts {
		if ringID == "" || rollout.RingID == ringID {
			result = append(result, rollout)
		}
	}
	sort.Slice(result, func(i, j int) bool {
		iTerminal := releaseRolloutTerminal(result[i].Status)
		jTerminal := releaseRolloutTerminal(result[j].Status)
		if iTerminal != jTerminal {
			return !iTerminal
		}
		return result[i].CreatedAt.After(result[j].CreatedAt)
	})
	if limit > 0 && len(result) > limit {
		result = result[:limit]
	}
	return result, nil
}

func releaseRolloutTerminal(status string) bool {
	return status == ReleaseRolloutStatusCompleted || status == ReleaseRolloutStatusFailed
}

func (s *MemoryStore) SaveReleaseRolloutAndRing(_ context.Context, rollout ReleaseRollout, ring ReleaseRing) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	existingRollout, rolloutOK := s.releaseRollouts[rollout.ID]
	existingRing, ringOK := s.releaseRings[ring.ID]
	if !rolloutOK || !ringOK {
		return fmt.Errorf("release rollout or ring not found")
	}
	rollout.CreatedAt = existingRollout.CreatedAt
	rollout.Batch = SetUpgradeBatch{}
	ring.CreatedAt = existingRing.CreatedAt
	s.releaseRollouts[rollout.ID] = rollout
	s.releaseRings[ring.ID] = ring
	return nil
}

func (s *MemoryStore) CreateReleaseRolloutPlan(_ context.Context, ring ReleaseRing, rollout ReleaseRollout, batch SetUpgradeBatch) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	currentRing, ok := s.releaseRings[ring.ID]
	if !ok {
		return fmt.Errorf("release ring %q not found", ring.ID)
	}
	if currentRing.Status != ReleaseRingStatusSteady {
		return fmt.Errorf("release ring %q is not steady", ring.ID)
	}
	for _, run := range batch.Runs {
		set, found := s.sets[run.SetID]
		if !found || set.Status != SetStatusActive || set.ReleaseRingID != ring.ID || set.TargetReleaseID != "" ||
			set.CurrentReleaseID != run.FromReleaseID || set.ActiveRuntimeGeneration != run.FromGeneration ||
			set.LifecycleGeneration != run.LifecycleGeneration || run.ToGeneration <= set.LastRuntimeGeneration {
			return fmt.Errorf("set %q changed while creating release rollout", run.SetID)
		}
		for _, existing := range s.setUpgradeRuns {
			if existing.SetID == run.SetID && !setUpgradeRunTerminal(existing.Status) {
				return ErrSetUpgradeAlreadyActive
			}
		}
	}
	storedBatch := batch
	storedBatch.Runs = nil
	s.setUpgradeBatches[batch.ID] = storedBatch
	for _, run := range batch.Runs {
		s.setUpgradeRuns[run.ID] = run
		set := s.sets[run.SetID]
		set.TargetReleaseID = run.TargetReleaseID
		set.LastRuntimeGeneration = run.ToGeneration
		set.UpdatedAt = rollout.UpdatedAt
		s.sets[run.SetID] = set
	}
	ring.CreatedAt = currentRing.CreatedAt
	s.releaseRings[ring.ID] = ring
	rollout.Batch = SetUpgradeBatch{}
	s.releaseRollouts[rollout.ID] = rollout
	return nil
}
