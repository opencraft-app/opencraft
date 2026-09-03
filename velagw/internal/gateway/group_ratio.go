package gateway

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"strings"

	"git.woa.com/wisp/mono2/llmgateway/internal/newapi"
	"git.woa.com/wisp/mono2/llmgateway/internal/observability"
	"go.opentelemetry.io/otel/attribute"
)

const (
	newAPIGroupRatioOptionKey = "GroupRatio"
	byokGroupPrefix           = "byok_"
)

func isBYOKGroup(group string) bool {
	return strings.HasPrefix(strings.ToLower(strings.TrimSpace(group)), byokGroupPrefix)
}

func decodeGroupRatios(value any) (map[string]float64, error) {
	var raw []byte
	if text, ok := value.(string); ok {
		raw = []byte(strings.TrimSpace(text))
	} else {
		var err error
		raw, err = json.Marshal(value)
		if err != nil {
			return nil, err
		}
	}
	if len(raw) == 0 {
		return map[string]float64{}, nil
	}
	ratios := map[string]float64{}
	if err := json.Unmarshal(raw, &ratios); err != nil {
		return nil, err
	}
	return ratios, nil
}

func withoutBYOKGroupRatios(ratios map[string]float64) map[string]float64 {
	result := make(map[string]float64, len(ratios))
	for group, ratio := range ratios {
		if !isBYOKGroup(group) {
			result[group] = ratio
		}
	}
	return result
}

func groupRatioPayload(entries []GroupRatioDesired) ([]byte, error) {
	ratios := make(map[string]float64, len(entries))
	for _, entry := range entries {
		group := strings.TrimSpace(entry.GroupName)
		if group == "" {
			return nil, fmt.Errorf("GroupRatio contains an empty group")
		}
		if _, exists := ratios[group]; exists {
			return nil, fmt.Errorf("GroupRatio contains duplicate group %q", group)
		}
		ratios[group] = entry.Ratio
	}
	return json.Marshal(ratios)
}

func groupRatioFingerprint(entries []GroupRatioDesired) (string, error) {
	payload, err := groupRatioPayload(entries)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(payload)
	return fmt.Sprintf("%x", sum[:]), nil
}

func (s *Service) reconcileSetGroupRatios(ctx context.Context, set Set) (GroupRatioApplyState, error) {
	return s.reconcileSetGroupRatiosWithAuth(ctx, set, nil)
}

func (s *Service) reconcileSetGroupRatiosWithAuth(ctx context.Context, set Set, auth *newapi.AdminAuth) (GroupRatioApplyState, error) {
	var result GroupRatioApplyState
	ctx, span := s.startTelemetrySpan(ctx, observability.ScopeConfigConsistency, "llmgateway.group_ratio.sync",
		attribute.String("llmgateway.set.id", set.ID),
	)
	var operationErr error
	defer func() { observability.FinishSpan(span, operationErr, "group_ratio_sync_failed", s.telemetrySanitizer) }()
	err := s.withSetOperationLease(ctx, set.ID, SetOperationGroupRatioWrite, 1, func(opCtx context.Context) error {
		snapshot, err := s.store.GetGroupRatioSnapshot(opCtx, set.ID)
		if err != nil {
			return err
		}
		recordFailure := func(applyErr error) {
			previous := snapshot.State
			var completeErr error
			result, completeErr = s.store.CompleteGroupRatioApply(opCtx, GroupRatioApplyCompletion{
				SetID: set.ID, Version: snapshot.State.DesiredVersion, Error: applyErr.Error(), AppliedAt: s.nowUTC(),
			})
			if completeErr == nil {
				s.emitGroupRatioTransition(opCtx, previous, result)
				s.emitOperationFailure(opCtx, observability.ScopeConfigConsistency, "llmgateway.config.operation_failed", "group_ratio_sync_failed",
					attribute.String("llmgateway.set.id", set.ID),
					attribute.Int64("llmgateway.group_ratio.desired_version", snapshot.State.DesiredVersion),
				)
			}
		}
		if !groupRatioSnapshotHasPlatform(snapshot) {
			if err := s.bootstrapPlatformGroupRatios(opCtx, set.ID); err != nil {
				recordFailure(err)
				return err
			}
			snapshot, err = s.store.GetGroupRatioSnapshot(opCtx, set.ID)
			if err != nil {
				return err
			}
		}
		payload, err := groupRatioPayload(snapshot.Entries)
		if err != nil {
			recordFailure(err)
			return err
		}
		sum := sha256.Sum256(payload)
		fingerprint := fmt.Sprintf("%x", sum[:])
		state := snapshot.State
		if state.AppliedVersion == state.DesiredVersion && state.AppliedFingerprint == fingerprint {
			state.Status = GroupRatioApplyStatusSynced
			result = state
			return nil
		}

		client := s.newAPIClient(set.BaseURL)
		var updateErr error
		if auth != nil {
			updateErr = client.UpdateOptionWithAuth(opCtx, *auth, newAPIGroupRatioOptionKey, string(payload))
		} else {
			updateErr = s.updateSetOption(opCtx, client, set, newAPIGroupRatioOptionKey, string(payload))
		}
		if updateErr != nil {
			recordFailure(updateErr)
			return updateErr
		}
		previous := state
		result, err = s.store.CompleteGroupRatioApply(opCtx, GroupRatioApplyCompletion{
			SetID: set.ID, Version: state.DesiredVersion, Fingerprint: fingerprint, AppliedAt: s.nowUTC(),
		})
		if err == nil {
			s.emitGroupRatioTransition(opCtx, previous, result)
		}
		return err
	})
	operationErr = err
	return result, err
}

func (s *Service) emitGroupRatioTransition(ctx context.Context, previous, current GroupRatioApplyState) {
	s.emitCommittedTransition(ctx, observability.ScopeConfigConsistency, "llmgateway.config.state_changed",
		"group_ratio_apply", current.SetID, previous.Status, current.Status,
		attribute.String("llmgateway.set.id", current.SetID),
		attribute.Int64("llmgateway.group_ratio.desired_version", current.DesiredVersion),
		attribute.Int64("llmgateway.group_ratio.applied_version", current.AppliedVersion),
		attribute.String("llmgateway.group_ratio.desired_fingerprint", current.DesiredFingerprint),
		attribute.String("llmgateway.group_ratio.applied_fingerprint", current.AppliedFingerprint),
	)
}

func groupRatioSnapshotHasPlatform(snapshot GroupRatioSnapshot) bool {
	for _, entry := range snapshot.Entries {
		if entry.SourceType == GroupRatioSourcePlatform {
			return true
		}
	}
	return false
}

func (s *Service) bootstrapPlatformGroupRatios(ctx context.Context, setID string) error {
	bundles, err := s.store.ListChannelBundles(ctx)
	if err != nil {
		return err
	}
	var desired map[string]float64
	var canonical string
	for _, bundle := range bundles {
		state, ok, err := s.store.GetChannelBundleSyncState(ctx, bundle.ID, setID)
		if err != nil {
			return err
		}
		if !ok || strings.TrimSpace(state.AppliedFingerprint) == "" {
			continue
		}
		spec, ok, err := s.channelBundleSpecAtFingerprint(ctx, bundle, state.AppliedFingerprint)
		if err != nil {
			return err
		}
		if !ok {
			continue
		}
		ratios, ok, err := platformGroupRatiosFromSpec(spec)
		if err != nil {
			return fmt.Errorf("resolve platform GroupRatio from bundle %s: %w", bundle.ID, err)
		}
		if !ok || len(ratios) == 0 {
			continue
		}
		candidate := comparableChannelBundleOptionValue(ratios)
		if desired == nil {
			desired = ratios
			canonical = candidate
			continue
		}
		if canonical != candidate {
			return fmt.Errorf("platform GroupRatio truth conflicts across applied channel bundles for Set %q", setID)
		}
	}
	if len(desired) == 0 {
		return fmt.Errorf("platform GroupRatio truth for Set %q is missing", setID)
	}
	payload, err := json.Marshal(desired)
	if err != nil {
		return err
	}
	sum := sha256.Sum256(payload)
	_, err = s.store.ReplacePlatformGroupRatios(ctx, setID, fmt.Sprintf("stable:%x", sum[:8]), desired)
	return err
}

func (s *Service) channelBundleSpecAtFingerprint(ctx context.Context, bundle ChannelBundle, fingerprint string) (ChannelBundleSpec, bool, error) {
	if bundle.Fingerprint == fingerprint {
		return bundle.Spec, true, nil
	}
	revisions, err := s.store.ListChannelBundleRevisions(ctx, bundle.ID)
	if err != nil {
		return ChannelBundleSpec{}, false, err
	}
	for _, revision := range revisions {
		if revision.Fingerprint == fingerprint {
			return revision.Spec, true, nil
		}
	}
	return ChannelBundleSpec{}, false, nil
}

func platformGroupRatiosFromSpec(spec ChannelBundleSpec) (map[string]float64, bool, error) {
	var result map[string]float64
	for _, option := range spec.Options {
		if option.Key != newAPIGroupRatioOptionKey {
			continue
		}
		if result != nil {
			return nil, false, fmt.Errorf("multiple GroupRatio options are not allowed")
		}
		ratios, err := decodeGroupRatios(option.Value)
		if err != nil {
			return nil, false, err
		}
		result = withoutBYOKGroupRatios(ratios)
	}
	return result, result != nil, nil
}
