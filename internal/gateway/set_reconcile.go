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
)

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
	set.SQLMaxOpenConns = fact.SQLMaxOpenConns
	set.ShardID = fact.ShardRef
	set.SQLMaxIdleConns = fact.SQLMaxIdleConns
	set.SQLMaxLifetimeSeconds = fact.SQLMaxLifetimeSeconds
	set.TrafficSQLMaxOpenConns = fact.TrafficSQLMaxOpenConns
	set.TrafficSQLMaxIdleConns = fact.TrafficSQLMaxIdleConns
	set.TrafficSQLMaxLifetimeSeconds = fact.TrafficSQLMaxLifetimeSeconds
	set.SubscriptionWriteConcurrency = fact.SubscriptionWriteConcurrency
	return s.store.SaveSet(ctx, set)
}

func (s *Service) ListSetReconcileFacts(ctx context.Context, opts SetReconcileFactListOptions) ([]SetReconcileFact, error) {
	opts.Source = strings.TrimSpace(opts.Source)
	opts.Namespace = strings.TrimSpace(opts.Namespace)
	opts.Fleet = strings.TrimSpace(opts.Fleet)
	opts.Status = strings.TrimSpace(opts.Status)
	return s.store.ListSetReconcileFacts(ctx, opts)
}

func (s *Service) ReconcileSetReconcileFacts(ctx context.Context, input ReconcileSetReconcileFactsInput) (ReconcileSetReconcileFactsResult, error) {
	opts := SetReconcileFactListOptions{
		Source:    strings.TrimSpace(input.Source),
		Namespace: strings.TrimSpace(input.Namespace),
		Fleet:     strings.TrimSpace(input.Fleet),
		Status:    SetReconcileStatusPending,
		Limit:     input.Limit,
	}
	facts, err := s.store.ListSetReconcileFacts(ctx, opts)
	if err != nil {
		return ReconcileSetReconcileFactsResult{}, err
	}
	result := ReconcileSetReconcileFactsResult{Scanned: len(facts), Facts: make([]SetReconcileFact, 0, len(facts))}
	for _, fact := range facts {
		reconciled := s.reconcileOneSetFact(ctx, fact)
		if reconciled.Status == SetReconcileStatusManaged {
			result.Managed++
		} else {
			result.Failed++
		}
		result.Facts = append(result.Facts, reconciled)
	}
	return result, nil
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
	bundles, err := s.store.ListChannelBundles(ctx)
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
		if !ok || state.Status != SetPlanStatusReady || state.UpstreamPlanID <= 0 {
			if !ok {
				state = SetPlan{PlanID: plan.ID, SetID: setID, Status: SetPlanStatusPending}
			}
			if err := s.syncSetPlan(ctx, set, plan, state); err != nil {
				return err
			}
		}
		periods, err := s.store.ListPlanPeriods(ctx, plan.ID)
		if err != nil {
			return err
		}
		for _, period := range periods {
			periodState, ok, err := s.store.GetSetPlanPeriod(ctx, plan.ID, period.PeriodValue, period.PeriodUnit, setID)
			if err != nil {
				return err
			}
			if ok && periodState.Status == SetPlanStatusReady && periodState.UpstreamPlanID > 0 {
				continue
			}
			if !ok {
				periodState = SetPlanPeriod{PlanID: plan.ID, PeriodValue: period.PeriodValue, PeriodUnit: period.PeriodUnit, SetID: setID, Status: SetPlanStatusPending}
			}
			if err := s.syncSetPlanPeriod(ctx, set, plan, periodState); err != nil {
				return err
			}
		}
	}
	return nil
}

func (s *Service) syncSetPlan(ctx context.Context, set Set, plan Plan, state SetPlan) error {
	state.PlanID = plan.ID
	state.SetID = set.ID
	state.Status = SetPlanStatusSyncing
	state.Attempts++
	state.LastError = ""
	if err := s.store.SaveSetPlan(ctx, state); err != nil {
		return err
	}
	client := s.newAPIClient(set.BaseURL)
	auth := adminAuthForSet(set)
	marker := managedPlanMarker(plan.ID)
	upstreamPlans, err := client.AdminListSubscriptionPlans(ctx, auth)
	if err != nil {
		return s.failSetPlanSync(ctx, state, fmt.Errorf("list upstream plans: %w", err))
	}
	for _, upstreamPlan := range upstreamPlans {
		if upstreamPlan.ID > 0 && strings.TrimSpace(upstreamPlan.Subtitle) == marker {
			state.UpstreamPlanID = upstreamPlan.ID
			state.Status = SetPlanStatusReady
			state.SyncedAt = s.nowUTC()
			return s.store.SaveSetPlan(ctx, state)
		}
	}

	result, err := client.AdminCreateSubscriptionPlan(ctx, auth, newapi.AdminCreateSubscriptionPlanRequest{
		Plan: newapi.AdminSubscriptionPlan{
			Title:            plan.Name,
			Subtitle:         marker,
			PriceAmount:      0,
			Currency:         "USD",
			DurationUnit:     newAPISubscriptionDurationUnit(plan.PeriodUnit),
			DurationValue:    firstPositive(plan.PeriodValue, 1),
			Enabled:          true,
			TotalAmount:      plan.MonthlyTokens,
			AllowBalancePay:  true,
			QuotaResetPeriod: "never",
		},
	})
	if err != nil {
		return s.failSetPlanSync(ctx, state, fmt.Errorf("create upstream plan %q in set %q: %w", plan.ID, set.ID, err))
	}
	state.UpstreamPlanID = result.ID
	state.Status = SetPlanStatusReady
	state.LastError = ""
	state.SyncedAt = s.nowUTC()
	if err := s.store.SaveSetPlan(ctx, state); err != nil {
		return fmt.Errorf("save set plan %q for set %q: %w", plan.ID, set.ID, err)
	}
	return nil
}

func managedPlanMarker(planID string) string {
	return "llmgateway plan:" + strings.TrimSpace(planID)
}

func managedPlanPeriodMarker(planID string, periodValue int, periodUnit string) string {
	return fmt.Sprintf("llmgateway plan:%s:%d:%s", strings.TrimSpace(planID), periodValue, normalizePeriodUnit(periodUnit))
}

func (s *Service) syncSetPlanPeriod(ctx context.Context, set Set, plan Plan, state SetPlanPeriod) error {
	state.Status = SetPlanStatusSyncing
	state.Attempts++
	state.LastError = ""
	if err := s.store.SaveSetPlanPeriod(ctx, state); err != nil {
		return err
	}
	client := s.newAPIClient(set.BaseURL)
	auth := adminAuthForSet(set)
	marker := managedPlanPeriodMarker(plan.ID, state.PeriodValue, state.PeriodUnit)
	upstreamPlans, err := client.AdminListSubscriptionPlans(ctx, auth)
	if err != nil {
		return s.failSetPlanPeriodSync(ctx, state, fmt.Errorf("list upstream plans: %w", err))
	}
	for _, upstreamPlan := range upstreamPlans {
		if upstreamPlan.ID > 0 && strings.TrimSpace(upstreamPlan.Subtitle) == marker {
			state.UpstreamPlanID, state.Status, state.SyncedAt = upstreamPlan.ID, SetPlanStatusReady, s.nowUTC()
			return s.store.SaveSetPlanPeriod(ctx, state)
		}
	}
	result, err := client.AdminCreateSubscriptionPlan(ctx, auth, newapi.AdminCreateSubscriptionPlanRequest{Plan: newapi.AdminSubscriptionPlan{
		Title: plan.Name, Subtitle: marker, PriceAmount: 0, Currency: "USD",
		DurationUnit: newAPISubscriptionDurationUnit(state.PeriodUnit), DurationValue: state.PeriodValue,
		Enabled: true, TotalAmount: plan.MonthlyTokens, AllowBalancePay: true, QuotaResetPeriod: "never",
	}})
	if err != nil {
		return s.failSetPlanPeriodSync(ctx, state, fmt.Errorf("create upstream period plan %q in set %q: %w", plan.ID, set.ID, err))
	}
	state.UpstreamPlanID, state.Status, state.LastError, state.SyncedAt = result.ID, SetPlanStatusReady, "", s.nowUTC()
	return s.store.SaveSetPlanPeriod(ctx, state)
}

func (s *Service) failSetPlanPeriodSync(ctx context.Context, state SetPlanPeriod, cause error) error {
	state.Status, state.LastError = SetPlanStatusError, cause.Error()
	if err := s.store.SaveSetPlanPeriod(ctx, state); err != nil {
		return errors.Join(cause, err)
	}
	return cause
}

func (s *Service) failSetPlanSync(ctx context.Context, state SetPlan, cause error) error {
	state.Status = SetPlanStatusError
	state.LastError = cause.Error()
	if err := s.store.SaveSetPlan(ctx, state); err != nil {
		return errors.Join(cause, err)
	}
	return cause
}

func (s *Service) syncPlansJob(ctx context.Context) (int, int, error) {
	states, err := s.store.ListSetPlans(ctx, SetPlanListOptions{
		Statuses: []string{SetPlanStatusPending, SetPlanStatusError},
	})
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
	periodStates, periodErr := s.store.ListSetPlanPeriods(ctx, SetPlanPeriodListOptions{Statuses: []string{SetPlanStatusPending, SetPlanStatusError}})
	if periodErr != nil {
		if firstErr == nil {
			firstErr = periodErr
		}
		return synced, failed, firstErr
	}
	for _, state := range periodStates {
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
		if err == nil {
			err = s.syncSetPlanPeriod(ctx, set, plan, state)
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

func newAPISubscriptionDurationUnit(unit string) string {
	switch strings.ToLower(strings.TrimSpace(unit)) {
	case "day", "days", "d":
		return "day"
	case "year", "years", "y":
		return "year"
	default:
		return "month"
	}
}

func firstPositive(value int, fallback int) int {
	if value > 0 {
		return value
	}
	return fallback
}

func (s *Service) markProvisionRequestConfiguredForSetFact(ctx context.Context, fact SetReconcileFact) error {
	requests, err := s.store.ListSetProvisionRequests(ctx, SetProvisionRequestListOptions{
		Source:    fact.Source,
		Namespace: fact.Namespace,
		Fleet:     fact.Fleet,
	})
	if err != nil {
		return err
	}
	for _, request := range requests {
		if request.SetID != fact.SetID || !isOpenSetProvisionStatus(request.Status) {
			continue
		}
		if err := s.applyProvisionRequestCapacityToSet(ctx, request); err != nil {
			return err
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
	return true
}
