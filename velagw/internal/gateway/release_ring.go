package gateway

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"time"
)

func releaseScopeDefaults(source, namespace, fleet string) (string, string, string) {
	if strings.TrimSpace(source) == "" {
		source = "prod"
	}
	if strings.TrimSpace(namespace) == "" {
		namespace = "llmgateway"
	}
	if strings.TrimSpace(fleet) == "" {
		fleet = "prod"
	}
	return strings.TrimSpace(source), strings.TrimSpace(namespace), strings.TrimSpace(fleet)
}

func (s *Service) CreateNewAPIRelease(ctx context.Context, input CreateNewAPIReleaseInput) (NewAPIRelease, error) {
	input.ID = strings.TrimSpace(input.ID)
	input.Version = strings.TrimSpace(input.Version)
	input.Image = strings.TrimSpace(input.Image)
	if input.ID == "" || input.Version == "" {
		return NewAPIRelease{}, fmt.Errorf("release id and version are required")
	}
	if !digestPinnedImagePattern.MatchString(input.Image) {
		return NewAPIRelease{}, fmt.Errorf("release image must be pinned by sha256 digest")
	}
	if input.Compatibility == "" {
		input.Compatibility = "expand_compatible"
	}
	if input.Status == "" {
		input.Status = NewAPIReleaseStatusDraft
	}
	switch input.Status {
	case NewAPIReleaseStatusDraft, NewAPIReleaseStatusVerified, NewAPIReleaseStatusStable, NewAPIReleaseStatusBlocked:
	default:
		return NewAPIRelease{}, fmt.Errorf("unsupported release status %q", input.Status)
	}
	source, namespace, fleet := releaseScopeDefaults(input.Source, input.Namespace, input.Fleet)
	now := s.nowUTC()
	release := NewAPIRelease{
		ID: input.ID, Source: source, Namespace: namespace, Fleet: fleet,
		Version: input.Version, Image: input.Image, Compatibility: strings.TrimSpace(input.Compatibility),
		Status: input.Status, CreatedAt: now, UpdatedAt: now,
	}
	if err := s.store.SaveNewAPIRelease(ctx, release); err != nil {
		return NewAPIRelease{}, err
	}
	return release, nil
}

func (s *Service) ListNewAPIReleases(ctx context.Context) ([]NewAPIRelease, error) {
	return s.store.ListNewAPIReleases(ctx)
}

func (s *Service) UpsertReleaseRing(ctx context.Context, input UpsertReleaseRingInput) (ReleaseRing, error) {
	input.ID = strings.TrimSpace(input.ID)
	input.Name = strings.TrimSpace(input.Name)
	input.ServingReleaseID = strings.TrimSpace(input.ServingReleaseID)
	if input.ID == "" || input.Name == "" || input.ServingReleaseID == "" {
		return ReleaseRing{}, fmt.Errorf("ring id, name and serving_release_id are required")
	}
	release, ok, err := s.store.GetNewAPIRelease(ctx, input.ServingReleaseID)
	if err != nil {
		return ReleaseRing{}, err
	}
	if !ok {
		return ReleaseRing{}, fmt.Errorf("release %q not found", input.ServingReleaseID)
	}
	source, namespace, fleet := releaseScopeDefaults(input.Source, input.Namespace, input.Fleet)
	if release.Source != source || release.Namespace != namespace || release.Fleet != fleet {
		return ReleaseRing{}, fmt.Errorf("release %q belongs to another fleet", release.ID)
	}
	if input.MaxParallel <= 0 {
		input.MaxParallel = 1
	}
	if input.MaxParallel != 1 {
		return ReleaseRing{}, fmt.Errorf("release ring currently requires max_parallel=1")
	}
	if input.SoakDuration <= 0 {
		input.SoakDuration = 30 * time.Minute
	}
	now := s.nowUTC()
	ring := ReleaseRing{
		ID: input.ID, Source: source, Namespace: namespace, Fleet: fleet, Name: input.Name,
		Ordinal: input.Ordinal, ServingReleaseID: input.ServingReleaseID, Status: ReleaseRingStatusSteady,
		AdmissionEnabled: input.AdmissionEnabled, MaxParallel: 1, SoakDuration: input.SoakDuration,
		SoakSeconds: int(input.SoakDuration / time.Second), CreatedAt: now, UpdatedAt: now,
	}
	if existing, found, getErr := s.store.GetReleaseRing(ctx, ring.ID); getErr != nil {
		return ReleaseRing{}, getErr
	} else if found {
		if existing.Status == ReleaseRingStatusRolling || existing.Status == ReleaseRingStatusSoaking {
			return ReleaseRing{}, fmt.Errorf("release ring %q is currently rolling", ring.ID)
		}
		ring.CreatedAt = existing.CreatedAt
	}
	for _, setID := range orderedUniqueSetIDs(input.SetIDs) {
		set, found, getErr := s.store.GetSet(ctx, setID)
		if getErr != nil {
			return ReleaseRing{}, getErr
		}
		if !found {
			return ReleaseRing{}, fmt.Errorf("set %q not found", setID)
		}
		if set.TargetReleaseID != "" {
			return ReleaseRing{}, fmt.Errorf("set %q has an active release target", setID)
		}
		set.ReleaseRingID = ring.ID
		if set.CurrentReleaseID == "" {
			set.CurrentReleaseID = ring.ServingReleaseID
		}
		if err := s.store.SaveSet(ctx, set); err != nil {
			return ReleaseRing{}, err
		}
	}
	if err := s.store.SaveReleaseRing(ctx, ring); err != nil {
		return ReleaseRing{}, err
	}
	return s.decorateReleaseRing(ctx, ring)
}

func (s *Service) ListReleaseRings(ctx context.Context) ([]ReleaseRing, error) {
	rings, err := s.store.ListReleaseRings(ctx)
	if err != nil {
		return nil, err
	}
	for index := range rings {
		rings[index], err = s.decorateReleaseRing(ctx, rings[index])
		if err != nil {
			return nil, err
		}
	}
	return rings, nil
}

func (s *Service) decorateReleaseRing(ctx context.Context, ring ReleaseRing) (ReleaseRing, error) {
	sets, err := s.store.ListSets(ctx)
	if err != nil {
		return ReleaseRing{}, err
	}
	ring.SetCount = 0
	ring.ReleaseDistribution = map[string]int{}
	for _, set := range sets {
		if set.ReleaseRingID != ring.ID {
			continue
		}
		ring.SetCount++
		ring.ReleaseDistribution[set.CurrentReleaseID]++
	}
	return ring, nil
}

func (s *Service) CreateReleaseRollout(ctx context.Context, input CreateReleaseRolloutInput) (ReleaseRollout, error) {
	input.RingID = strings.TrimSpace(input.RingID)
	input.TargetReleaseID = strings.TrimSpace(input.TargetReleaseID)
	ring, ok, err := s.store.GetReleaseRing(ctx, input.RingID)
	if err != nil {
		return ReleaseRollout{}, err
	}
	if !ok {
		return ReleaseRollout{}, fmt.Errorf("release ring %q not found", input.RingID)
	}
	if ring.Status != ReleaseRingStatusSteady {
		return ReleaseRollout{}, fmt.Errorf("release ring %q is not steady", ring.ID)
	}
	release, ok, err := s.store.GetNewAPIRelease(ctx, input.TargetReleaseID)
	if err != nil {
		return ReleaseRollout{}, err
	}
	if !ok {
		return ReleaseRollout{}, fmt.Errorf("release %q not found", input.TargetReleaseID)
	}
	if release.Status != NewAPIReleaseStatusVerified && release.Status != NewAPIReleaseStatusStable {
		return ReleaseRollout{}, fmt.Errorf("release %q is not verified", release.ID)
	}
	if release.Source != ring.Source || release.Namespace != ring.Namespace || release.Fleet != ring.Fleet {
		return ReleaseRollout{}, fmt.Errorf("release %q belongs to another fleet", release.ID)
	}
	sets, err := s.store.ListSets(ctx)
	if err != nil {
		return ReleaseRollout{}, err
	}
	selected := make([]Set, 0)
	for _, set := range sets {
		if set.ReleaseRingID == ring.ID && set.CurrentReleaseID != release.ID {
			if set.Status != SetStatusActive {
				return ReleaseRollout{}, fmt.Errorf("set %q is not active", set.ID)
			}
			selected = append(selected, set)
		}
	}
	if len(selected) == 0 {
		return ReleaseRollout{}, fmt.Errorf("release ring %q has no sets requiring upgrade", ring.ID)
	}
	sort.Slice(selected, func(i, j int) bool {
		if selected[i].ObservedUserCount != selected[j].ObservedUserCount {
			return selected[i].ObservedUserCount < selected[j].ObservedUserCount
		}
		return selected[i].ID < selected[j].ID
	})
	now := s.nowUTC()
	rolloutID := fmt.Sprintf("release-rollout-%d", now.UnixNano())
	setIDs := make([]string, 0, len(selected))
	for _, set := range selected {
		setIDs = append(setIDs, set.ID)
	}
	if input.DrainTimeout <= 0 {
		input.DrainTimeout = 330 * time.Second
	}
	if input.RollbackWindow <= 0 {
		input.RollbackWindow = 300 * time.Second
	}
	batch := SetUpgradeBatch{
		ID: fmt.Sprintf("set-upgrade-%d", now.UnixNano()), RolloutID: rolloutID, RingID: ring.ID,
		TargetReleaseID: release.ID, TargetImage: release.Image, Status: SetUpgradeBatchStatusPending,
		MaxParallel: 1, StopOnFailure: true, CreatedAt: now, UpdatedAt: now,
	}
	for index, set := range selected {
		lastGeneration := set.LastRuntimeGeneration
		if lastGeneration < set.ActiveRuntimeGeneration {
			lastGeneration = set.ActiveRuntimeGeneration
		}
		runtimes, err := s.store.ListSetRuntimes(ctx, set.ID)
		if err != nil {
			return ReleaseRollout{}, err
		}
		for _, runtime := range runtimes {
			if runtime.Generation > lastGeneration {
				lastGeneration = runtime.Generation
			}
		}
		batch.Runs = append(batch.Runs, SetUpgradeRun{
			ID: fmt.Sprintf("%s-%03d", batch.ID, index+1), BatchID: batch.ID, SetID: set.ID,
			Source: ring.Source, Namespace: ring.Namespace, Fleet: ring.Fleet, TargetImage: release.Image,
			FromReleaseID: set.CurrentReleaseID, TargetReleaseID: release.ID, Sequence: index + 1,
			FromGeneration: set.ActiveRuntimeGeneration, ToGeneration: lastGeneration + 1,
			LifecycleGeneration: set.LifecycleGeneration,
			Status:              SetUpgradeRunStatusPending, DrainTimeout: input.DrainTimeout, RollbackWindow: input.RollbackWindow,
			CreatedAt: now, UpdatedAt: now,
		})
	}
	ring.TargetReleaseID = release.ID
	ring.Status = ReleaseRingStatusRolling
	ring.UpdatedAt = now
	rollout := ReleaseRollout{
		ID: rolloutID, RingID: ring.ID, TargetReleaseID: release.ID, BatchID: batch.ID,
		CampaignID: strings.TrimSpace(input.CampaignID), CampaignSequence: input.CampaignSequence,
		Status: ReleaseRolloutStatusRunning, TotalSets: len(batch.Runs), Batch: batch,
		CreatedAt: now, UpdatedAt: now,
	}
	if err := s.store.CreateReleaseRolloutPlan(ctx, ring, rollout, batch); err != nil {
		return ReleaseRollout{}, err
	}
	for _, run := range batch.Runs {
		s.emitSetUpgradeTransition(ctx, SetUpgradeRun{}, run)
	}
	return rollout, nil
}

func (s *Service) GetReleaseRollout(ctx context.Context, id string) (ReleaseRollout, bool, error) {
	rollout, ok, err := s.store.GetReleaseRollout(ctx, strings.TrimSpace(id))
	if err != nil || !ok {
		return ReleaseRollout{}, ok, err
	}
	rollout, err = s.decorateReleaseRollout(ctx, rollout)
	return rollout, err == nil, err
}

func (s *Service) ListReleaseRollouts(ctx context.Context, ringID string, limit int) ([]ReleaseRollout, error) {
	rollouts, err := s.store.ListReleaseRollouts(ctx, strings.TrimSpace(ringID), limit)
	if err != nil {
		return nil, err
	}
	for index := range rollouts {
		rollouts[index], err = s.decorateReleaseRollout(ctx, rollouts[index])
		if err != nil {
			return nil, err
		}
	}
	return rollouts, nil
}

func (s *Service) decorateReleaseRollout(ctx context.Context, rollout ReleaseRollout) (ReleaseRollout, error) {
	previous := rollout
	batch, ok, err := s.store.GetSetUpgradeBatch(ctx, rollout.BatchID)
	if err != nil {
		return ReleaseRollout{}, err
	}
	if !ok {
		return ReleaseRollout{}, fmt.Errorf("upgrade batch %q not found", rollout.BatchID)
	}
	rollout.Batch = batch
	rollout.TotalSets = len(batch.Runs)
	rollout.CompletedSets = 0
	rollout.FailedSets = 0
	rollout.CurrentSetID = ""
	for _, run := range batch.Runs {
		switch run.Status {
		case SetUpgradeRunStatusCompleted:
			rollout.CompletedSets++
		case SetUpgradeRunStatusFailed, SetUpgradeRunStatusRolledBack:
			rollout.FailedSets++
		default:
			if run.Status != SetUpgradeRunStatusPending && rollout.CurrentSetID == "" {
				rollout.CurrentSetID = run.SetID
			}
		}
	}
	ring, found, err := s.store.GetReleaseRing(ctx, rollout.RingID)
	if err != nil {
		return ReleaseRollout{}, err
	}
	if !found {
		return ReleaseRollout{}, fmt.Errorf("release ring %q not found", rollout.RingID)
	}
	now := s.nowUTC()
	switch {
	case previous.Status == ReleaseRolloutStatusCompleted:
		rollout.Status = ReleaseRolloutStatusCompleted
	case previous.Status == ReleaseRolloutStatusPaused && previous.LastGateError != "":
		rollout.Status = ReleaseRolloutStatusPaused
		ring.Status = ReleaseRingStatusDegraded
	case rollout.FailedSets > 0:
		rollout.Status = ReleaseRolloutStatusPaused
		ring.Status = ReleaseRingStatusDegraded
	case rollout.TotalSets > 0 && rollout.CompletedSets == rollout.TotalSets:
		rollout.Status = ReleaseRolloutStatusSoaking
		if rollout.SoakStartedAt.IsZero() {
			rollout.SoakStartedAt = now
			rollout.SoakDeadline = now.Add(ring.SoakDuration)
			rollout.LastGateError = ""
		}
		ring.Status = ReleaseRingStatusSoaking
	default:
		rollout.Status = ReleaseRolloutStatusRunning
		ring.Status = ReleaseRingStatusRolling
	}
	changed := rollout.Status != previous.Status || rollout.CompletedSets != previous.CompletedSets ||
		rollout.FailedSets != previous.FailedSets || rollout.CurrentSetID != previous.CurrentSetID ||
		!rollout.SoakStartedAt.Equal(previous.SoakStartedAt) || !rollout.SoakDeadline.Equal(previous.SoakDeadline) ||
		ring.Status != releaseRingStatusForRollout(previous.Status)
	if changed {
		rollout.UpdatedAt = now
		ring.UpdatedAt = now
		if err := s.store.SaveReleaseRolloutAndRing(ctx, rollout, ring); err != nil {
			return ReleaseRollout{}, err
		}
	}
	return rollout, nil
}

func releaseRingStatusForRollout(status string) string {
	switch status {
	case ReleaseRolloutStatusCompleted:
		return ReleaseRingStatusSteady
	case ReleaseRolloutStatusSoaking:
		return ReleaseRingStatusSoaking
	case ReleaseRolloutStatusPaused, ReleaseRolloutStatusFailed:
		return ReleaseRingStatusDegraded
	default:
		return ReleaseRingStatusRolling
	}
}
