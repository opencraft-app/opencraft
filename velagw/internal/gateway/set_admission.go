package gateway

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"git.woa.com/wisp/mono2/llmgateway/internal/observability"
	"go.opentelemetry.io/otel/attribute"
)

type SetAdmissionResult struct {
	SetID  string `json:"set_id"`
	Status string `json:"status"`
	Error  string `json:"error,omitempty"`
}

func (s *Service) CheckSetAdmission(ctx context.Context, setID string) (result SetAdmissionResult, err error) {
	setID = strings.TrimSpace(setID)
	ctx, span := s.startTelemetrySpan(ctx, observability.ScopeSetLifecycle, "llmgateway.set.admission_check",
		attribute.String("llmgateway.set.id", setID),
	)
	defer func() { observability.FinishSpan(span, err, "set_admission_failed", s.telemetrySanitizer) }()
	set, ok, err := s.store.GetSet(ctx, strings.TrimSpace(setID))
	if err != nil {
		return SetAdmissionResult{}, err
	}
	if !ok {
		return SetAdmissionResult{}, fmt.Errorf("set %q not found", setID)
	}
	managed, err := s.setProvisionRuntimeManaged(ctx, set.ID)
	if err != nil {
		return SetAdmissionResult{}, err
	}
	if !managed {
		err := fmt.Errorf("set %q runtime is not managed", set.ID)
		s.emitOperationFailure(ctx, observability.ScopeSetLifecycle, "llmgateway.set.operation_failed", "set_runtime_not_managed",
			attribute.String("llmgateway.set.id", set.ID),
			attribute.String("llmgateway.operation", "set_admission_check"),
		)
		return SetAdmissionResult{SetID: set.ID, Status: firstNonEmpty(set.AdmissionStatus, SetAdmissionStatusPending), Error: err.Error()}, err
	}
	previousStatus := firstNonEmpty(set.AdmissionStatus, SetAdmissionStatusPending)
	// A periodic recheck must not revoke the last stable admission decision.
	// New Sets may expose "checking", while previously passed Sets keep serving
	// and accepting users until the new result is committed.
	if set.AdmissionStatus != SetAdmissionStatusPassed {
		set.AdmissionStatus = SetAdmissionStatusChecking
		set.AdmissionError = ""
		set.AdmissionCheckedAt = s.nowUTC()
		_ = s.store.SaveSet(ctx, set)
	}

	checkErr := s.checkSetAdmission(ctx, set)
	set.AdmissionCheckedAt = s.nowUTC()
	if checkErr != nil {
		set.AdmissionStatus = SetAdmissionStatusFailed
		set.AdmissionError = checkErr.Error()
	} else {
		set.AdmissionStatus = SetAdmissionStatusPassed
		set.AdmissionError = ""
	}
	if err := s.store.SaveSet(ctx, set); err != nil {
		return SetAdmissionResult{}, err
	}
	s.emitCommittedTransition(ctx, observability.ScopeSetLifecycle, "llmgateway.set.state_changed",
		"set_admission", set.ID, previousStatus, set.AdmissionStatus,
		attribute.String("llmgateway.set.id", set.ID),
	)
	if checkErr != nil {
		s.emitOperationFailure(ctx, observability.ScopeSetLifecycle, "llmgateway.set.operation_failed", "set_admission_failed",
			attribute.String("llmgateway.set.id", set.ID),
			attribute.String("llmgateway.operation", "set_admission_check"),
		)
	}
	return SetAdmissionResult{SetID: set.ID, Status: set.AdmissionStatus, Error: set.AdmissionError}, checkErr
}

func (s *Service) setProvisionRuntimeManaged(ctx context.Context, setID string) (bool, error) {
	requests, err := s.store.ListSetProvisionRequests(ctx, SetProvisionRequestListOptions{SetID: setID, Limit: 1})
	if err != nil {
		return false, err
	}
	if len(requests) == 0 {
		// Manually registered Sets have no provision request and retain the
		// historical admission behavior.
		return true, nil
	}
	return requests[0].Status == SetProvisionStatusManaged, nil
}

func (s *Service) checkSetAdmission(ctx context.Context, set Set) error {
	if set.Status != SetStatusActive {
		return fmt.Errorf("set is not active")
	}
	if !set.Setup || set.AdminUserID == 0 || set.AdminAccessToken == "" {
		return fmt.Errorf("set is not bootstrapped")
	}
	setup, err := s.newAPIClient(set.BaseURL).GetSetup(ctx)
	if err != nil {
		return fmt.Errorf("check remote setup: %w", err)
	}
	if !setup.Status && !setup.RootInit {
		return fmt.Errorf("remote set setup is not completed")
	}
	plans, err := s.store.ListPlans(ctx)
	if err != nil {
		return err
	}
	for _, plan := range plans {
		if !plan.IsActive {
			continue
		}
		state, ok, err := s.store.GetSetPlan(ctx, plan.ID, set.ID)
		if err != nil {
			return err
		}
		if !ok || state.Status != SetPlanStatusReady || state.UpstreamPlanID <= 0 ||
			state.AppliedFingerprint == "" {
			return fmt.Errorf("plan %q is not ready on set %q", plan.ID, set.ID)
		}
	}
	bundles, err := s.desiredChannelBundles(ctx)
	if err != nil {
		return err
	}
	for _, bundle := range bundles {
		state, ok, err := s.store.GetChannelBundleSyncState(ctx, bundle.ID, set.ID)
		if err != nil {
			return err
		}
		if !ok || strings.TrimSpace(state.AppliedFingerprint) == "" {
			return fmt.Errorf("channel bundle %q initial sync has not completed on set %q", bundle.ID, set.ID)
		}
		switch state.Status {
		case ChannelSyncStatusSynced, ChannelSyncStatusPending:
			// A pending desired revision must not invalidate the last stable applied revision.
		default:
			return fmt.Errorf("channel bundle %q is unsafe on set %q: status=%s", bundle.ID, set.ID, state.Status)
		}
		applied, err := s.appliedChannelBundleRevision(ctx, bundle, state.AppliedFingerprint)
		if err != nil {
			return err
		}
		if err := validateChannelBundlePricing(applied); err != nil {
			return fmt.Errorf("channel bundle %q applied pricing incomplete: %w", bundle.ID, err)
		}
	}
	return nil
}

func (s *Service) appliedChannelBundleRevision(ctx context.Context, current ChannelBundle, fingerprint string) (ChannelBundle, error) {
	fingerprint = strings.TrimSpace(fingerprint)
	if fingerprint == current.Fingerprint {
		return current, nil
	}
	revisions, err := s.store.ListChannelBundleRevisions(ctx, current.ID)
	if err != nil {
		return ChannelBundle{}, err
	}
	for _, revision := range revisions {
		if revision.Fingerprint != fingerprint {
			continue
		}
		return ChannelBundle{
			ID: revision.BundleID, Name: revision.Name, Description: revision.Description,
			SourceSetID: revision.SourceSetID, Spec: revision.Spec, Fingerprint: revision.Fingerprint,
		}, nil
	}
	return ChannelBundle{}, fmt.Errorf("channel bundle %q applied revision %q is unavailable", current.ID, fingerprint)
}

func validateChannelBundlePricing(bundle ChannelBundle) error {
	modelRatio := channelBundleOptionMap(bundle.Spec.Options, "ModelRatio")
	completionRatio := channelBundleOptionMap(bundle.Spec.Options, "CompletionRatio")
	for _, channel := range bundle.Spec.Channels {
		if channel.Status == ChannelSpecStatusDisabled {
			continue
		}
		for _, model := range splitAdmissionModels(channel.Models) {
			if _, ok := modelRatio[model]; !ok {
				return fmt.Errorf("model %q missing ModelRatio", model)
			}
			if _, ok := completionRatio[model]; !ok {
				return fmt.Errorf("model %q missing CompletionRatio", model)
			}
		}
	}
	return nil
}

func channelBundleOptionMap(options []ChannelBundleOption, key string) map[string]any {
	for _, option := range options {
		if option.Key != key {
			continue
		}
		return admissionOptionMap(option.Value)
	}
	return map[string]any{}
}

func admissionOptionMap(value any) map[string]any {
	switch typed := value.(type) {
	case map[string]any:
		return typed
	case string:
		values := map[string]any{}
		if err := json.Unmarshal([]byte(typed), &values); err != nil {
			return map[string]any{}
		}
		return values
	default:
		raw, err := json.Marshal(typed)
		if err != nil {
			return map[string]any{}
		}
		values := map[string]any{}
		if err := json.Unmarshal(raw, &values); err != nil {
			return map[string]any{}
		}
		return values
	}
}

func splitAdmissionModels(raw string) []string {
	parts := strings.Split(raw, ",")
	models := make([]string, 0, len(parts))
	seen := map[string]bool{}
	for _, part := range parts {
		model := strings.TrimSpace(part)
		if model == "" || seen[model] {
			continue
		}
		seen[model] = true
		models = append(models, model)
	}
	return models
}
