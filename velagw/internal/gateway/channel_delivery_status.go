package gateway

import (
	"context"
	"time"
)

func (s *Service) GetChannelBundleDeliveryStatus(ctx context.Context, bundleID string) (ChannelBundleDeliveryStatus, error) {
	bundle, ok, err := s.store.GetChannelBundle(ctx, bundleID)
	if err != nil {
		return ChannelBundleDeliveryStatus{}, err
	}
	if !ok {
		return ChannelBundleDeliveryStatus{}, ErrChannelBundleNotFound
	}
	sets, err := s.store.ListSets(ctx)
	if err != nil {
		return ChannelBundleDeliveryStatus{}, err
	}
	states, err := s.store.ListChannelBundleSyncStates(ctx, bundle.ID)
	if err != nil {
		return ChannelBundleDeliveryStatus{}, err
	}
	stateBySet := make(map[string]ChannelBundleSyncState, len(states))
	for _, state := range states {
		stateBySet[state.SetID] = state
	}

	var staleAfterSeconds *int
	job, found, err := s.store.GetWorkerJob(ctx, WorkerJobCheckChannelDrift)
	if err != nil {
		return ChannelBundleDeliveryStatus{}, err
	}
	if found && job.Enabled && job.IntervalSeconds > 0 {
		seconds := job.IntervalSeconds * 2
		staleAfterSeconds = &seconds
	}

	result := ChannelBundleDeliveryStatus{
		BundleID:          bundle.ID,
		Status:            ChannelDeliveryStatusEmpty,
		StaleAfterSeconds: staleAfterSeconds,
		Sets:              make([]ChannelBundleDeliverySetStatus, 0),
	}
	for _, set := range sets {
		if set.Status != SetStatusActive || !set.Setup {
			continue
		}
		result.EligibleSets++
		item := ChannelBundleDeliverySetStatus{SetID: set.ID, SetName: set.Name}
		state, exists := stateBySet[set.ID]
		if !exists || state.LastCheckedAt.IsZero() {
			item.Status = ChannelDeliveryStatusUnchecked
			result.Counts.Unchecked++
			result.Sets = append(result.Sets, item)
			continue
		}

		result.CheckedSets++
		checkedAt := state.LastCheckedAt
		item.LastCheckedAt = &checkedAt
		item.LastError = state.LastError
		item.DiffJSON = state.DiffJSON
		if result.CoverageCheckedAt == nil || state.LastCheckedAt.Before(*result.CoverageCheckedAt) {
			coverageCheckedAt := state.LastCheckedAt
			result.CoverageCheckedAt = &coverageCheckedAt
		}

		wrongRevision := state.DesiredFingerprint != bundle.Fingerprint || state.LastCheckedAt.Before(bundle.UpdatedAt)
		timedOut := staleAfterSeconds != nil && s.now().Sub(state.LastCheckedAt) > time.Duration(*staleAfterSeconds)*time.Second
		if wrongRevision || timedOut {
			item.Status = ChannelDeliveryStatusStale
			result.Counts.Stale++
			if wrongRevision {
				item.DiffJSON = ""
			}
			result.Sets = append(result.Sets, item)
			continue
		}

		switch state.Status {
		case ChannelSyncStatusSynced:
			item.Status = ChannelDeliveryStatusSynced
			result.Counts.Synced++
		case ChannelSyncStatusPending:
			item.Status = ChannelDeliveryStatusPending
			result.Counts.Pending++
		case ChannelSyncStatusDrift, ChannelSyncStatusConflict:
			item.Status = ChannelDeliveryStatusDrift
			result.Counts.Drift++
		case ChannelSyncStatusError:
			item.Status = ChannelDeliveryStatusError
			result.Counts.Error++
		default:
			item.Status = ChannelDeliveryStatusUnchecked
			result.Counts.Unchecked++
		}
		result.Sets = append(result.Sets, item)
	}

	result.HasStaleResults = result.Counts.Unchecked > 0 || result.Counts.Stale > 0
	result.Status = aggregateChannelDeliveryStatus(result)
	return result, nil
}

func aggregateChannelDeliveryStatus(status ChannelBundleDeliveryStatus) string {
	if status.EligibleSets == 0 {
		return ChannelDeliveryStatusEmpty
	}
	if status.Counts.Error > 0 {
		return ChannelDeliveryStatusError
	}
	if status.Counts.Unchecked > 0 {
		return ChannelDeliveryStatusUnchecked
	}
	if status.Counts.Stale > 0 {
		return ChannelDeliveryStatusStale
	}
	if status.Counts.Drift > 0 {
		return ChannelDeliveryStatusDrift
	}
	if status.Counts.Pending > 0 {
		return ChannelDeliveryStatusPending
	}
	return ChannelDeliveryStatusSynced
}
