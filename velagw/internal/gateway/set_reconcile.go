package gateway

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"time"

	"git.woa.com/wisp/mono2/llmgateway/internal/newapi"
	"git.woa.com/wisp/mono2/llmgateway/internal/observability"
	"go.opentelemetry.io/otel/attribute"
)

const currentSetProjectionVersion = 1

func (s *Service) RecordSetReconcileFacts(ctx context.Context, input RecordSetReconcileFactsInput) (RecordSetReconcileFactsResult, error) {
	source, namespace, fleet, err := normalizeSetReconcileSource(input.Source, input.Namespace, input.Fleet)
	if err != nil {
		return RecordSetReconcileFactsResult{}, err
	}
	result := RecordSetReconcileFactsResult{Facts: make([]SetReconcileFact, 0, len(input.Sets))}
	for _, item := range input.Sets {
		fact, err := s.buildSetReconcileFact(ctx, source, namespace, fleet, item)
		if err != nil {
			return RecordSetReconcileFactsResult{}, err
		}
		if err := s.saveRuntimeLeaseFromSetFact(ctx, fact); err != nil {
			return RecordSetReconcileFactsResult{}, err
		}
		if err := s.store.SaveSetReconcileFact(ctx, fact); err != nil {
			return RecordSetReconcileFactsResult{}, err
		}
		if err := s.projectSetRuntimeConfig(ctx, fact); err != nil {
			return RecordSetReconcileFactsResult{}, err
		}
		result.Recorded++
		result.Facts = append(result.Facts, fact)
	}
	return result, nil
}

func (s *Service) projectSetRuntimeConfig(ctx context.Context, fact SetReconcileFact) error {
	set, ok, err := s.store.GetSet(ctx, fact.SetID)
	if err != nil || !ok {
		return err
	}
	previousRuntimeHAStatus := set.RuntimeHAStatus
	set.SQLMaxOpenConns = fact.SQLMaxOpenConns
	set.ShardID = fact.ShardRef
	set.SQLMaxIdleConns = fact.SQLMaxIdleConns
	set.SQLMaxLifetimeSeconds = fact.SQLMaxLifetimeSeconds
	set.TrafficSQLMaxOpenConns = fact.TrafficSQLMaxOpenConns
	set.TrafficSQLMaxIdleConns = fact.TrafficSQLMaxIdleConns
	set.TrafficSQLMaxLifetimeSeconds = fact.TrafficSQLMaxLifetimeSeconds
	set.SubscriptionWriteConcurrency = fact.SubscriptionWriteConcurrency
	set.RuntimeHAStatus = fact.RuntimeHAStatus
	set.RuntimeHADesiredReplicas = fact.RuntimeHADesiredReplicas
	set.RuntimeHAReadyReplicas = fact.RuntimeHAReadyReplicas
	set.RuntimeHAPDBHealthy = fact.RuntimeHAPDBHealthy
	set.RuntimeHATopologyKey = fact.RuntimeHATopologyKey
	set.RuntimeHAError = fact.RuntimeHAError
	set.RuntimeHACheckedAt = fact.RuntimeHACheckedAt
	if err := s.store.SaveSet(ctx, set); err != nil {
		return err
	}
	if fact.RuntimeHADesiredReplicas > 0 {
		s.emitCommittedTransition(ctx, observability.ScopeSetLifecycle, "llmgateway.set.state_changed",
			"set_runtime_ha", set.ID, previousRuntimeHAStatus, set.RuntimeHAStatus,
			attribute.String("llmgateway.set.id", set.ID),
			attribute.Int("llmgateway.runtime.ha.desired_replicas", set.RuntimeHADesiredReplicas),
			attribute.Int("llmgateway.runtime.ha.ready_replicas", set.RuntimeHAReadyReplicas),
			attribute.Bool("llmgateway.runtime.ha.pdb_ready", set.RuntimeHAPDBHealthy),
			attribute.String("llmgateway.runtime.ha.topology_key", set.RuntimeHATopologyKey),
		)
	}
	return nil
}

func (s *Service) ListSetReconcileFacts(ctx context.Context, opts SetReconcileFactListOptions) ([]SetReconcileFact, error) {
	opts.Source = strings.TrimSpace(opts.Source)
	opts.Namespace = strings.TrimSpace(opts.Namespace)
	opts.Fleet = strings.TrimSpace(opts.Fleet)
	opts.Status = strings.TrimSpace(opts.Status)
	return s.store.ListSetReconcileFacts(ctx, opts)
}

func (s *Service) ReconcileSetReconcileFacts(ctx context.Context, input ReconcileSetReconcileFactsInput) (ReconcileSetReconcileFactsResult, error) {
	limit := input.Limit
	if limit <= 0 {
		limit = 100
	}
	opts := SetReconcileFactListOptions{
		Source:    strings.TrimSpace(input.Source),
		Namespace: strings.TrimSpace(input.Namespace),
		Fleet:     strings.TrimSpace(input.Fleet),
		Status:    SetReconcileStatusPending,
		Limit:     limit,
	}
	facts, err := s.store.ListSetReconcileFacts(ctx, opts)
	if err != nil {
		return ReconcileSetReconcileFactsResult{}, err
	}
	if len(facts) < limit {
		failed, failedErr := s.store.ListSetReconcileFacts(ctx, SetReconcileFactListOptions{
			Source: opts.Source, Namespace: opts.Namespace, Fleet: opts.Fleet,
			Status: SetReconcileStatusError, Limit: limit - len(facts),
		})
		if failedErr != nil {
			return ReconcileSetReconcileFactsResult{}, failedErr
		}
		facts = append(facts, failed...)
	}
	if len(facts) < limit {
		stale, staleErr := s.store.ListSetReconcileFacts(ctx, SetReconcileFactListOptions{
			Source: opts.Source, Namespace: opts.Namespace, Fleet: opts.Fleet,
			Status: SetReconcileStatusManaged, ProjectionVersionBefore: currentSetProjectionVersion,
			Limit: limit - len(facts),
		})
		if staleErr != nil {
			return ReconcileSetReconcileFactsResult{}, staleErr
		}
		facts = append(facts, stale...)
	}
	result := ReconcileSetReconcileFactsResult{Scanned: len(facts), Facts: make([]SetReconcileFact, 0, len(facts))}
	for _, fact := range facts {
		reconciled := fact
		if fact.Status == SetReconcileStatusManaged {
			reconciled = s.repairManagedSetProjection(ctx, fact)
		} else {
			fact.Status = SetReconcileStatusPending
			reconciled = s.reconcileOneSetFact(ctx, fact)
		}
		if reconciled.Status == SetReconcileStatusManaged {
			result.Managed++
		} else {
			result.Failed++
		}
		result.Facts = append(result.Facts, reconciled)
	}
	return result, nil
}

func (s *Service) repairManagedSetProjection(ctx context.Context, fact SetReconcileFact) SetReconcileFact {
	fact.LastReconciledAt = s.nowUTC()
	fact.LastError = ""
	if err := s.projectSetRuntimeConfig(ctx, fact); err != nil {
		return s.saveFailedSetFact(ctx, fact, err)
	}
	if err := s.applyProvisionRequestProjectionForSetFact(ctx, fact); err != nil {
		return s.saveFailedSetFact(ctx, fact, err)
	}
	if fact.RuntimeGeneration > 0 {
		if _, _, err := s.store.InitializeSetRuntime(ctx, fact.SetID, fact.RuntimeGeneration, fact.RuntimeImage, fact.TrafficBaseURL, s.nowUTC()); err != nil {
			return s.saveFailedSetFact(ctx, fact, err)
		}
	}
	fact.ProjectionVersion = currentSetProjectionVersion
	fact.Status = SetReconcileStatusManaged
	if err := s.store.SaveSetReconcileFact(ctx, fact); err != nil {
		return s.saveFailedSetFact(ctx, fact, err)
	}
	return fact
}

func (s *Service) buildSetReconcileFact(ctx context.Context, source string, namespace string, fleet string, input SetReconcileFactInput) (SetReconcileFact, error) {
	input.SetID = strings.TrimSpace(input.SetID)
	input.Name = strings.TrimSpace(input.Name)
	input.BaseURL = strings.TrimRight(strings.TrimSpace(input.BaseURL), "/")
	input.TrafficBaseURL = strings.TrimRight(strings.TrimSpace(input.TrafficBaseURL), "/")
	input.RuntimeImage = strings.TrimSpace(input.RuntimeImage)
	input.ShardRef = strings.TrimSpace(input.ShardRef)
	input.DatabaseName = strings.TrimSpace(input.DatabaseName)
	input.RedisDB = strings.TrimSpace(input.RedisDB)
	if input.SetID == "" {
		return SetReconcileFact{}, fmt.Errorf("set_id is required")
	}
	if input.BaseURL == "" {
		return SetReconcileFact{}, fmt.Errorf("base_url is required")
	}
	if _, err := url.ParseRequestURI(input.BaseURL); err != nil {
		return SetReconcileFact{}, fmt.Errorf("invalid base_url for set %q: %w", input.SetID, err)
	}
	if input.TrafficBaseURL != "" {
		if _, err := url.ParseRequestURI(input.TrafficBaseURL); err != nil {
			return SetReconcileFact{}, fmt.Errorf("invalid traffic_base_url for set %q: %w", input.SetID, err)
		}
	}
	if input.RuntimeGeneration < 0 {
		return SetReconcileFact{}, fmt.Errorf("runtime_generation cannot be negative")
	}
	if input.RuntimeGeneration > 0 && (input.TrafficBaseURL == "" || input.RuntimeImage == "") {
		return SetReconcileFact{}, fmt.Errorf("runtime generation requires traffic_base_url and runtime_image")
	}
	if input.Name == "" {
		input.Name = input.SetID
	}
	now := s.nowUTC()
	desiredHash := setReconcileDesiredHash(source, namespace, fleet, input)
	fact := SetReconcileFact{
		Source:                       source,
		Namespace:                    namespace,
		Fleet:                        fleet,
		SetID:                        input.SetID,
		Name:                         input.Name,
		BaseURL:                      input.BaseURL,
		TrafficBaseURL:               input.TrafficBaseURL,
		RuntimeGeneration:            input.RuntimeGeneration,
		RuntimeImage:                 strings.TrimSpace(input.RuntimeImage),
		ShardRef:                     input.ShardRef,
		DatabaseName:                 input.DatabaseName,
		RedisDB:                      input.RedisDB,
		SQLMaxOpenConns:              input.SQLMaxOpenConns,
		SQLMaxIdleConns:              input.SQLMaxIdleConns,
		SQLMaxLifetimeSeconds:        input.SQLMaxLifetimeSeconds,
		TrafficSQLMaxOpenConns:       input.TrafficSQLMaxOpenConns,
		TrafficSQLMaxIdleConns:       input.TrafficSQLMaxIdleConns,
		TrafficSQLMaxLifetimeSeconds: input.TrafficSQLMaxLifetimeSeconds,
		SubscriptionWriteConcurrency: input.SubscriptionWriteConcurrency,
		RuntimeHAStatus:              strings.TrimSpace(input.RuntimeHAStatus),
		RuntimeHADesiredReplicas:     input.RuntimeHADesiredReplicas,
		RuntimeHAReadyReplicas:       input.RuntimeHAReadyReplicas,
		RuntimeHAPDBHealthy:          input.RuntimeHAPDBHealthy,
		RuntimeHATopologyKey:         strings.TrimSpace(input.RuntimeHATopologyKey),
		RuntimeHAError:               strings.TrimSpace(input.RuntimeHAError),
		RuntimeHACheckedAt:           input.RuntimeHACheckedAt,
		DesiredHash:                  desiredHash,
		Status:                       SetReconcileStatusPending,
		LastObservedAt:               now,
	}
	existing, ok, err := s.store.GetSetReconcileFact(ctx, source, namespace, fleet, input.SetID)
	if err != nil {
		return SetReconcileFact{}, err
	}
	if ok {
		fact.CreatedAt = existing.CreatedAt
		fact.LastReconciledAt = existing.LastReconciledAt
		fact.ProjectionVersion = existing.ProjectionVersion
		if existing.DesiredHash == desiredHash && existing.Status == SetReconcileStatusManaged {
			fact.Status = SetReconcileStatusManaged
			fact.LastError = existing.LastError
		}
	}
	return fact, nil
}

func (s *Service) saveRuntimeLeaseFromSetFact(ctx context.Context, fact SetReconcileFact) error {
	return s.store.SaveSetRuntimeLease(ctx, SetRuntimeLease{
		Source:       fact.Source,
		Namespace:    fact.Namespace,
		Fleet:        fact.Fleet,
		SetID:        fact.SetID,
		ShardRef:     fact.ShardRef,
		DatabaseName: fact.DatabaseName,
		RedisDB:      fact.RedisDB,
		CreatedAt:    fact.CreatedAt,
		UpdatedAt:    fact.UpdatedAt,
	})
}

func (s *Service) reconcileOneSetFact(ctx context.Context, fact SetReconcileFact) SetReconcileFact {
	fact.LastReconciledAt = s.nowUTC()
	fact.LastError = ""
	if set, ok, err := s.store.GetSet(ctx, fact.SetID); err != nil {
		return s.saveFailedSetFact(ctx, fact, err)
	} else if ok && set.Status == SetStatusDraining {
		fact.Status = SetReconcileStatusManaged
		if err := s.store.SaveSetReconcileFact(ctx, fact); err != nil {
			return s.saveFailedSetFact(ctx, fact, err)
		}
		return fact
	}
	if err := s.RegisterSet(ctx, RegisterSetInput{
		ID:                           fact.SetID,
		Name:                         fact.Name,
		BaseURL:                      fact.BaseURL,
		TrafficBaseURL:               fact.TrafficBaseURL,
		Status:                       SetStatusActive,
		ShardID:                      fact.ShardRef,
		SQLMaxOpenConns:              intPointer(fact.SQLMaxOpenConns),
		SQLMaxIdleConns:              intPointer(fact.SQLMaxIdleConns),
		SQLMaxLifetimeSeconds:        intPointer(fact.SQLMaxLifetimeSeconds),
		TrafficSQLMaxOpenConns:       intPointer(fact.TrafficSQLMaxOpenConns),
		TrafficSQLMaxIdleConns:       intPointer(fact.TrafficSQLMaxIdleConns),
		TrafficSQLMaxLifetimeSeconds: intPointer(fact.TrafficSQLMaxLifetimeSeconds),
		SubscriptionWriteConcurrency: intPointer(fact.SubscriptionWriteConcurrency),
	}); err != nil {
		return s.saveFailedSetFact(ctx, fact, err)
	}
	if err := s.projectSetRuntimeConfig(ctx, fact); err != nil {
		return s.saveFailedSetFact(ctx, fact, err)
	}
	if fact.RuntimeGeneration > 0 {
		if _, _, err := s.store.InitializeSetRuntime(ctx, fact.SetID, fact.RuntimeGeneration, fact.RuntimeImage, fact.TrafficBaseURL, s.nowUTC()); err != nil {
			return s.saveFailedSetFact(ctx, fact, err)
		}
		if _, _, err := s.PublishPendingSetRuntimeRoutes(ctx, 100); err != nil {
			return s.saveFailedSetFact(ctx, fact, err)
		}
	}
	if set, ok, err := s.store.GetSet(ctx, fact.SetID); err != nil {
		return s.saveFailedSetFact(ctx, fact, err)
	} else if ok && set.AdmissionStatus != SetAdmissionStatusPassed {
		set.AdmissionStatus = SetAdmissionStatusPending
		set.AdmissionError = ""
		set.AdmissionCheckedAt = time.Time{}
		if err := s.store.SaveSet(ctx, set); err != nil {
			return s.saveFailedSetFact(ctx, fact, err)
		}
	}
	if _, err := s.BootstrapSet(ctx, fact.SetID); err != nil {
		return s.saveFailedSetFact(ctx, fact, err)
	}
	if err := s.syncManagedSetDefaults(ctx, fact.SetID); err != nil {
		return s.saveFailedSetFact(ctx, fact, err)
	}
	set, ok, err := s.store.GetSet(ctx, fact.SetID)
	if err != nil {
		return s.saveFailedSetFact(ctx, fact, err)
	}
	if !ok {
		return s.saveFailedSetFact(ctx, fact, fmt.Errorf("set %q not found", fact.SetID))
	}
	if err := s.checkSetAdmission(ctx, set); err != nil {
		return s.saveFailedSetFact(ctx, fact, err)
	}
	fact.Status = SetReconcileStatusManaged
	fact.ProjectionVersion = currentSetProjectionVersion
	if err := s.store.SaveSetReconcileFact(ctx, fact); err != nil {
		fact.Status = SetReconcileStatusError
		fact.LastError = err.Error()
	}
	if fact.Status == SetReconcileStatusManaged {
		_ = s.markProvisionRequestConfiguredForSetFact(ctx, fact)
	}
	return fact
}

func (s *Service) syncManagedSetDefaults(ctx context.Context, setID string) error {
	bundles, err := s.desiredChannelBundles(ctx)
	if err != nil {
		return err
	}
	for _, bundle := range bundles {
		state, err := s.ApplyChannelBundleToSet(ctx, bundle.ID, setID, ChannelBundleApplyOptions{})
		if err != nil {
			return err
		}
		if state.Status != ChannelSyncStatusSynced {
			return fmt.Errorf("channel bundle %q sync to set %q ended with status %q", bundle.ID, setID, state.Status)
		}
	}
	return s.syncManagedSetPlans(ctx, setID)
}

func (s *Service) syncManagedSetPlans(ctx context.Context, setID string) error {
	set, ok, err := s.store.GetSet(ctx, setID)
	if err != nil {
		return err
	}
	if !ok {
		return fmt.Errorf("set %q not found", setID)
	}
	plans, err := s.store.ListPlans(ctx)
	if err != nil {
		return err
	}
	for _, plan := range plans {
		if !plan.IsActive {
			continue
		}
		state, ok, err := s.store.GetSetPlan(ctx, plan.ID, setID)
		if err != nil {
			return err
		}
		if !ok || state.Status != SetPlanStatusReady || state.UpstreamPlanID <= 0 ||
			state.AppliedFingerprint != plan.Fingerprint {
			if !ok {
				state = SetPlan{PlanID: plan.ID, SetID: setID, Status: SetPlanStatusPending}
			}
			if err := s.syncSetPlan(ctx, set, plan, state); err != nil {
				return err
			}
		}
	}
	return nil
}

func (s *Service) syncSetPlan(ctx context.Context, set Set, plan Plan, state SetPlan) error {
	sum := sha256.Sum256([]byte(strings.TrimSpace(plan.ID)))
	operation := fmt.Sprintf("%s_%x", SetOperationPlanSync, sum[:16])
	return s.withSetOperationLease(ctx, set.ID, operation, 1, func(leaseCtx context.Context) error {
		latest, ok, err := s.store.GetSetPlan(leaseCtx, plan.ID, set.ID)
		if err != nil {
			return err
		}
		if ok {
			state = latest
		}
		return s.syncSetPlanLocked(leaseCtx, set, plan, state)
	})
}

func (s *Service) syncSetPlanLocked(ctx context.Context, set Set, plan Plan, state SetPlan) error {
	state.PlanID = plan.ID
	state.SetID = set.ID
	if state.UpstreamPlanID > 0 && strings.TrimSpace(state.AppliedFingerprint) != "" {
		if state.Status != SetPlanStatusError {
			state.Status = SetPlanStatusReady
		}
	} else {
		state.Status = SetPlanStatusSyncing
	}
	state.Attempts++
	if state.Status != SetPlanStatusError {
		state.LastError = ""
	}
	if err := s.store.SaveSetPlan(ctx, state); err != nil {
		return err
	}
	client := s.newAPIClient(set.BaseURL)
	auth := adminAuthForSet(set)
	marker := managedPlanMarker(plan)
	upstreamPlans, err := client.AdminListSubscriptionPlans(ctx, auth)
	if err != nil {
		return s.failSetPlanSync(ctx, state, fmt.Errorf("list upstream plans: %w", err))
	}

	matches := matchingManagedPlans(upstreamPlans, marker)
	if len(matches) > 1 {
		return s.rejectSetPlanMapping(ctx, state,
			fmt.Errorf("duplicate managed plan marker %q in set %q", marker, set.ID))
	}
	if len(matches) == 1 {
		if err := validateManagedUpstreamPlan(plan, matches[0]); err != nil {
			return s.rejectSetPlanMapping(ctx, state, fmt.Errorf("verify upstream plan: %w", err))
		}
		if state.UpstreamPlanID > 0 && state.AppliedFingerprint == plan.Fingerprint &&
			state.UpstreamPlanID != matches[0].ID {
			return s.rejectSetPlanMapping(ctx, state,
				fmt.Errorf("managed plan identity changed from %d to %d", state.UpstreamPlanID, matches[0].ID))
		}
		return s.adoptManagedUpstreamPlan(ctx, state, plan, matches[0].ID)
	}

	if state.UpstreamPlanID > 0 && strings.TrimSpace(state.AppliedFingerprint) != "" {
		var mapped *newapi.AdminSubscriptionPlan
		for i := range upstreamPlans {
			if upstreamPlans[i].ID == state.UpstreamPlanID {
				mapped = &upstreamPlans[i]
				break
			}
		}
		if mapped == nil || strings.HasPrefix(strings.TrimSpace(mapped.Subtitle), "llmgateway plan:v3:") {
			return s.rejectSetPlanMapping(ctx, state,
				fmt.Errorf("managed upstream plan %d is missing or no longer matches marker %q", state.UpstreamPlanID, marker))
		}
	}

	result, createErr := client.AdminCreateSubscriptionPlan(ctx, auth, newapi.AdminCreateSubscriptionPlanRequest{
		Plan: desiredManagedUpstreamPlan(plan),
	})
	if result.ID > 0 {
		state.UpstreamPlanID = result.ID
	}

	confirmedPlans, confirmErr := client.AdminListSubscriptionPlans(ctx, auth)
	if confirmErr == nil {
		confirmedMatches := matchingManagedPlans(confirmedPlans, marker)
		if len(confirmedMatches) > 1 {
			return s.rejectSetPlanMapping(ctx, state,
				fmt.Errorf("duplicate managed plan marker %q after create in set %q", marker, set.ID))
		}
		if len(confirmedMatches) == 1 {
			if err := validateManagedUpstreamPlan(plan, confirmedMatches[0]); err != nil {
				return s.rejectSetPlanMapping(ctx, state, fmt.Errorf("verify created upstream plan: %w", err))
			}
			if result.ID > 0 && result.ID != confirmedMatches[0].ID {
				return s.rejectSetPlanMapping(ctx, state,
					fmt.Errorf("created upstream plan id %d resolved to %d", result.ID, confirmedMatches[0].ID))
			}
			return s.adoptManagedUpstreamPlan(ctx, state, plan, confirmedMatches[0].ID)
		}
	}
	if createErr != nil {
		if confirmErr != nil {
			createErr = errors.Join(createErr, fmt.Errorf("confirm create: %w", confirmErr))
		}
		return s.failSetPlanSync(ctx, state,
			fmt.Errorf("create upstream plan %q in set %q: %w", plan.ID, set.ID, createErr))
	}
	if confirmErr != nil {
		return s.failSetPlanSync(ctx, state,
			fmt.Errorf("confirm upstream plan %q in set %q: %w", plan.ID, set.ID, confirmErr))
	}
	return s.failSetPlanSync(ctx, state,
		fmt.Errorf("created upstream plan %q in set %q was not visible during confirmation", plan.ID, set.ID))
}

func managedPlanMarker(plan Plan) string {
	planIDHash := sha256.Sum256([]byte(strings.TrimSpace(plan.ID)))
	return fmt.Sprintf("llmgateway plan:v3:%x:%s", planIDHash, strings.TrimSpace(plan.Fingerprint))
}

func desiredManagedUpstreamPlan(plan Plan) newapi.AdminSubscriptionPlan {
	return newapi.AdminSubscriptionPlan{
		Title:                   plan.Name,
		Subtitle:                managedPlanMarker(plan),
		PriceAmount:             0,
		Currency:                "USD",
		DurationUnit:            "year",
		DurationValue:           100,
		Enabled:                 true,
		TotalAmount:             plan.MonthlyTokens,
		AllowBalancePay:         true,
		QuotaResetPeriod:        plan.QuotaResetPeriod,
		QuotaResetCustomSeconds: plan.QuotaResetCustomSeconds,
	}
}

func matchingManagedPlans(plans []newapi.AdminSubscriptionPlan, marker string) []newapi.AdminSubscriptionPlan {
	matches := make([]newapi.AdminSubscriptionPlan, 0, 1)
	for _, upstreamPlan := range plans {
		if upstreamPlan.ID > 0 && strings.TrimSpace(upstreamPlan.Subtitle) == marker {
			matches = append(matches, upstreamPlan)
		}
	}
	return matches
}

func validateManagedUpstreamPlan(plan Plan, upstream newapi.AdminSubscriptionPlan) error {
	if upstream.ID <= 0 {
		return fmt.Errorf("upstream plan id is empty")
	}
	if strings.TrimSpace(upstream.Subtitle) != managedPlanMarker(plan) {
		return fmt.Errorf("marker does not match")
	}
	if !upstream.Enabled {
		return fmt.Errorf("upstream plan is disabled")
	}
	if upstream.DurationUnit != "year" || upstream.DurationValue != 100 {
		return fmt.Errorf("duration is %d %q, want 100 years", upstream.DurationValue, upstream.DurationUnit)
	}
	if upstream.TotalAmount != plan.MonthlyTokens {
		return fmt.Errorf("total amount is %d, want %d", upstream.TotalAmount, plan.MonthlyTokens)
	}
	if upstream.QuotaResetPeriod != plan.QuotaResetPeriod {
		return fmt.Errorf("quota reset period is %q, want %q", upstream.QuotaResetPeriod, plan.QuotaResetPeriod)
	}
	if upstream.QuotaResetCustomSeconds != plan.QuotaResetCustomSeconds {
		return fmt.Errorf("quota reset custom seconds is %d, want %d",
			upstream.QuotaResetCustomSeconds, plan.QuotaResetCustomSeconds)
	}
	return nil
}

func (s *Service) adoptManagedUpstreamPlan(ctx context.Context, state SetPlan, plan Plan, upstreamPlanID int) error {
	state.UpstreamPlanID = upstreamPlanID
	state.AppliedFingerprint = plan.Fingerprint
	state.Status = SetPlanStatusReady
	state.LastError = ""
	state.SyncedAt = s.nowUTC()
	return s.store.SaveSetPlan(ctx, state)
}

func (s *Service) rejectSetPlanMapping(ctx context.Context, state SetPlan, cause error) error {
	state.Status = SetPlanStatusError
	state.LastError = cause.Error()
	if err := s.store.SaveSetPlan(ctx, state); err != nil {
		return errors.Join(cause, err)
	}
	return cause
}

func (s *Service) failSetPlanSync(ctx context.Context, state SetPlan, cause error) error {
	if state.Status != SetPlanStatusError && state.UpstreamPlanID > 0 && state.AppliedFingerprint != "" {
		state.Status = SetPlanStatusReady
	} else {
		state.Status = SetPlanStatusError
	}
	state.LastError = cause.Error()
	if err := s.store.SaveSetPlan(ctx, state); err != nil {
		return errors.Join(cause, err)
	}
	return cause
}

func (s *Service) syncPlansJob(ctx context.Context) (int, int, error) {
	states, err := s.store.ListSetPlans(ctx, SetPlanListOptions{})
	if err != nil {
		return 0, 0, err
	}
	synced, failed := 0, 0
	var firstErr error
	for _, state := range states {
		plan, ok, err := s.store.GetPlan(ctx, state.PlanID)
		if err == nil && !ok {
			err = fmt.Errorf("plan %q not found", state.PlanID)
		}
		set, setOK, setErr := s.store.GetSet(ctx, state.SetID)
		if err == nil && setErr != nil {
			err = setErr
		}
		if err == nil && !setOK {
			err = fmt.Errorf("set %q not found", state.SetID)
		}
		if err == nil && (!plan.IsActive || set.Status != SetStatusActive || !set.Setup || set.AdminUserID <= 0 || set.AdminAccessToken == "") {
			continue
		}
		if err == nil && state.Status == SetPlanStatusReady && state.UpstreamPlanID > 0 &&
			state.AppliedFingerprint == plan.Fingerprint && !state.SyncedAt.IsZero() {
			continue
		}
		if err == nil {
			err = s.syncSetPlan(ctx, set, plan, state)
		}
		if err != nil {
			failed++
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		synced++
	}
	return synced, failed, firstErr
}

func (s *Service) markProvisionRequestConfiguredForSetFact(ctx context.Context, fact SetReconcileFact) error {
	if err := s.advanceNativeProvisionRequestForManagedFact(ctx, fact); err != nil {
		return err
	}
	requests, err := s.store.ListSetProvisionRequests(ctx, SetProvisionRequestListOptions{
		Source:    fact.Source,
		Namespace: fact.Namespace,
		Fleet:     fact.Fleet,
	})
	if err != nil {
		return err
	}
	for _, request := range requests {
		if request.SetID != fact.SetID {
			continue
		}
		if err := s.applyProvisionRequestCapacityToSet(ctx, request); err != nil {
			return err
		}
		if request.RuntimeBackend == SetRuntimeBackendVelaGWSet || !isOpenSetProvisionStatus(request.Status) {
			continue
		}
		request.Status = SetProvisionStatusConfigured
		request.LastError = ""
		request.LastStatusAt = s.nowUTC()
		if err := s.store.SaveSetProvisionRequest(ctx, request); err != nil {
			return err
		}
	}
	return nil
}

func (s *Service) applyProvisionRequestProjectionForSetFact(ctx context.Context, fact SetReconcileFact) error {
	requests, err := s.store.ListSetProvisionRequests(ctx, SetProvisionRequestListOptions{
		Source: fact.Source, Namespace: fact.Namespace, Fleet: fact.Fleet, SetID: fact.SetID,
	})
	if err != nil {
		return err
	}
	for _, request := range requests {
		if request.SetID == fact.SetID {
			return s.applyProvisionRequestCapacityToSet(ctx, request)
		}
	}
	return nil
}

func (s *Service) applyProvisionRequestCapacityToSet(ctx context.Context, request SetProvisionRequest) error {
	set, ok, err := s.store.GetSet(ctx, request.SetID)
	if err != nil {
		return err
	}
	if !ok {
		return fmt.Errorf("set %q not found", request.SetID)
	}
	changed := false
	if request.MaxUsersPerSet > 0 && set.MaxUsers == 0 {
		set.MaxUsers = request.MaxUsersPerSet
		changed = true
	}
	if request.ShardRef != "" && set.ShardID == "" {
		set.ShardID = request.ShardRef
		changed = true
	}
	if request.ReleaseRingID != "" && set.ReleaseRingID == "" {
		set.ReleaseRingID = request.ReleaseRingID
		changed = true
	}
	if request.ReleaseID != "" && set.CurrentReleaseID == "" {
		set.CurrentReleaseID = request.ReleaseID
		changed = true
	}
	if !changed {
		return nil
	}
	return s.store.SaveSet(ctx, set)
}

func (s *Service) saveFailedSetFact(ctx context.Context, fact SetReconcileFact, cause error) SetReconcileFact {
	fact.Status = SetReconcileStatusError
	fact.LastError = cause.Error()
	_ = s.store.SaveSetReconcileFact(ctx, fact)
	return fact
}

func normalizeSetReconcileSource(source string, namespace string, fleet string) (string, string, string, error) {
	source = strings.TrimSpace(source)
	namespace = strings.TrimSpace(namespace)
	fleet = strings.TrimSpace(fleet)
	if source == "" {
		source = "kro"
	}
	if namespace == "" {
		return "", "", "", fmt.Errorf("namespace is required")
	}
	if fleet == "" {
		return "", "", "", fmt.Errorf("fleet is required")
	}
	return source, namespace, fleet, nil
}

func setReconcileDesiredHash(source string, namespace string, fleet string, input SetReconcileFactInput) string {
	hash := sha256.Sum256([]byte(strings.Join([]string{
		source,
		namespace,
		fleet,
		strings.TrimSpace(input.SetID),
		strings.TrimSpace(input.Name),
		strings.TrimRight(strings.TrimSpace(input.BaseURL), "/"),
		strings.TrimRight(strings.TrimSpace(input.TrafficBaseURL), "/"),
		fmt.Sprintf("%d", input.RuntimeGeneration),
		strings.TrimSpace(input.RuntimeImage),
		strings.TrimSpace(input.ShardRef),
		strings.TrimSpace(input.DatabaseName),
		strings.TrimSpace(input.RedisDB),
	}, "\x00")))
	return hex.EncodeToString(hash[:])
}

func intPointer(value int) *int {
	return &value
}

func setReconcileFactKey(source string, namespace string, fleet string, setID string) string {
	return strings.Join([]string{source, namespace, fleet, setID}, "\x00")
}

func setReconcileFactMatchesOptions(fact SetReconcileFact, opts SetReconcileFactListOptions) bool {
	if opts.Source != "" && fact.Source != opts.Source {
		return false
	}
	if opts.Namespace != "" && fact.Namespace != opts.Namespace {
		return false
	}
	if opts.Fleet != "" && fact.Fleet != opts.Fleet {
		return false
	}
	if opts.Status != "" && fact.Status != opts.Status {
		return false
	}
	if opts.ProjectionVersionBefore > 0 && fact.ProjectionVersion >= opts.ProjectionVersionBefore {
		return false
	}
	return true
}
