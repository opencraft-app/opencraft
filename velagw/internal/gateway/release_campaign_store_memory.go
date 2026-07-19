package gateway

import (
	"context"
	"fmt"
	"sort"
)

func releaseCampaignRingKey(campaignID string, sequence int) string {
	return fmt.Sprintf("%s\x00%08d", campaignID, sequence)
}

func releaseCampaignTerminal(status string) bool {
	return status == ReleaseCampaignStatusCompleted
}

func (s *MemoryStore) CreateReleaseCampaign(_ context.Context, campaign ReleaseCampaign, rings []ReleaseCampaignRing) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, existing := range s.releaseCampaigns {
		if existing.Source == campaign.Source && existing.Namespace == campaign.Namespace && existing.Fleet == campaign.Fleet &&
			!releaseCampaignTerminal(existing.Status) {
			return fmt.Errorf("fleet %q already has active release campaign %q", campaign.Fleet, existing.ID)
		}
	}
	if _, exists := s.releaseCampaigns[campaign.ID]; exists {
		return fmt.Errorf("release campaign %q already exists", campaign.ID)
	}
	campaign.Rings = nil
	s.releaseCampaigns[campaign.ID] = campaign
	for _, ring := range rings {
		s.releaseCampaignRings[releaseCampaignRingKey(ring.CampaignID, ring.Sequence)] = ring
	}
	return nil
}

func (s *MemoryStore) GetReleaseCampaign(_ context.Context, id string) (ReleaseCampaign, bool, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	campaign, ok := s.releaseCampaigns[id]
	if !ok {
		return ReleaseCampaign{}, false, nil
	}
	campaign.Rings = s.releaseCampaignRingsLocked(id)
	return campaign, true, nil
}

func (s *MemoryStore) ListReleaseCampaigns(_ context.Context, limit int) ([]ReleaseCampaign, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	result := make([]ReleaseCampaign, 0, len(s.releaseCampaigns))
	for _, campaign := range s.releaseCampaigns {
		campaign.Rings = s.releaseCampaignRingsLocked(campaign.ID)
		result = append(result, campaign)
	}
	sort.Slice(result, func(i, j int) bool {
		iTerminal := releaseCampaignTerminal(result[i].Status)
		jTerminal := releaseCampaignTerminal(result[j].Status)
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

func (s *MemoryStore) SaveReleaseCampaign(_ context.Context, campaign ReleaseCampaign, ring ReleaseCampaignRing) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	existing, ok := s.releaseCampaigns[campaign.ID]
	if !ok {
		return fmt.Errorf("release campaign %q not found", campaign.ID)
	}
	if ring.CampaignID != "" {
		key := releaseCampaignRingKey(ring.CampaignID, ring.Sequence)
		if _, ok := s.releaseCampaignRings[key]; !ok {
			return fmt.Errorf("release campaign ring %q/%d not found", ring.CampaignID, ring.Sequence)
		}
	}
	campaign.CreatedAt = existing.CreatedAt
	campaign.Rings = nil
	s.releaseCampaigns[campaign.ID] = campaign
	if ring.CampaignID != "" {
		key := releaseCampaignRingKey(ring.CampaignID, ring.Sequence)
		s.releaseCampaignRings[key] = ring
	}
	return nil
}

func (s *MemoryStore) ResumeReleaseCampaign(_ context.Context, campaign ReleaseCampaign, step ReleaseCampaignRing, rollout ReleaseRollout, ring ReleaseRing) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	existingCampaign, campaignOK := s.releaseCampaigns[campaign.ID]
	existingStep, stepOK := s.releaseCampaignRings[releaseCampaignRingKey(step.CampaignID, step.Sequence)]
	existingRollout, rolloutOK := s.releaseRollouts[rollout.ID]
	existingRing, ringOK := s.releaseRings[ring.ID]
	if !campaignOK || !stepOK || !rolloutOK || !ringOK {
		return fmt.Errorf("release campaign resume state changed")
	}
	campaign.CreatedAt = existingCampaign.CreatedAt
	campaign.Rings = nil
	step.CreatedAt = existingStep.CreatedAt
	rollout.CreatedAt = existingRollout.CreatedAt
	rollout.Batch = SetUpgradeBatch{}
	ring.CreatedAt = existingRing.CreatedAt
	s.releaseCampaigns[campaign.ID] = campaign
	s.releaseCampaignRings[releaseCampaignRingKey(step.CampaignID, step.Sequence)] = step
	s.releaseRollouts[rollout.ID] = rollout
	s.releaseRings[ring.ID] = ring
	return nil
}

func (s *MemoryStore) releaseCampaignRingsLocked(campaignID string) []ReleaseCampaignRing {
	result := make([]ReleaseCampaignRing, 0)
	for _, ring := range s.releaseCampaignRings {
		if ring.CampaignID == campaignID {
			result = append(result, ring)
		}
	}
	sort.Slice(result, func(i, j int) bool { return result[i].Sequence < result[j].Sequence })
	return result
}
