package gateway

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"
)

func (s *Service) GetUserState(ctx context.Context, externalUserID string) (UserState, error) {
	externalUserID = strings.TrimSpace(externalUserID)
	if externalUserID == "" {
		return UserState{}, fmt.Errorf("user_id is required")
	}
	assignment, err := s.GetUserAssignment(ctx, externalUserID)
	if err != nil {
		return UserState{}, err
	}
	state := UserState{
		UserID:       externalUserID,
		Backend:      assignment.Backend,
		SetID:        assignment.SetID,
		CreditStatus: "unavailable",
		Source:       assignment.Backend,
	}
	if binding, ok, err := s.store.GetUserBinding(ctx, externalUserID); err != nil {
		return UserState{}, err
	} else if ok {
		state.SetID = firstNonEmpty(state.SetID, binding.SetID)
		state.UpstreamUserID = binding.UpstreamUserID
		state.Username = binding.Username
		state.LastAppliedPlanID = binding.LastPlanID
	}

	switch assignment.Backend {
	case UserBackendNew:
		return s.fillNewUserState(ctx, externalUserID, state)
	case UserBackendPending:
		state.Source = UserBackendPending
		return state, nil
	default:
		return UserState{}, fmt.Errorf("invalid user backend %q", assignment.Backend)
	}
}

func (s *Service) ObserveTenant(ctx context.Context, externalUserID string) (TenantObservation, error) {
	state, err := s.GetUserState(ctx, externalUserID)
	if err != nil {
		return TenantObservation{}, err
	}
	if _, err := s.EnsureTenant(ctx, Tenant{
		ExternalUserID: state.UserID,
		Backend:        state.Backend,
		SetID:          state.SetID,
		Source:         state.Source,
	}); err != nil {
		return TenantObservation{}, err
	}
	observation := tenantObservationFromState(state, s.nowUTC())
	if err := s.store.SaveTenantObservation(ctx, observation); err != nil {
		return TenantObservation{}, err
	}
	if saved, ok, err := s.store.GetTenantObservation(ctx, observation.ExternalUserID); err != nil {
		return TenantObservation{}, err
	} else if ok {
		return saved, nil
	}
	return observation, nil
}

func tenantObservationFromState(state UserState, observedAt time.Time) TenantObservation {
	return TenantObservation{
		ExternalUserID:        state.UserID,
		Backend:               state.Backend,
		SetID:                 state.SetID,
		UpstreamUserID:        state.UpstreamUserID,
		Username:              state.Username,
		CurrentPlanID:         state.CurrentPlanID,
		LastAppliedPlanID:     state.LastAppliedPlanID,
		SubscriptionStatus:    state.SubscriptionStatus,
		HasActiveSubscription: state.HasActiveSubscription,
		TokenBalance:          state.TokenBalance,
		CreditAvailable:       state.CreditAvailable,
		CreditStatus:          state.CreditStatus,
		CreditError:           state.CreditError,
		Unlimited:             state.Unlimited,
		PeriodStart:           state.PeriodStart,
		PeriodEnd:             state.PeriodEnd,
		Source:                state.Source,
		ObservedAt:            observedAt,
	}
}

func (s *Service) fillNewUserState(ctx context.Context, externalUserID string, state UserState) (UserState, error) {
	state.Source = "new-api"
	sub, err := s.GetActiveSubscription(ctx, externalUserID)
	if errors.Is(err, ErrSubscriptionNotFound) {
		state.CreditStatus = "not_found"
		return state, nil
	}
	if err != nil {
		return UserState{}, err
	}
	state.CurrentPlanID = sub.PlanID
	state.SubscriptionStatus = sub.Status
	state.HasActiveSubscription = sub.Status == "active"
	state.TokenBalance = sub.TokenBalance
	state.CreditAvailable = sub.TokenBalance
	state.CreditStatus = "ok"
	state.Unlimited = sub.Unlimited
	state.PeriodStart = sub.PeriodStart
	state.PeriodEnd = sub.PeriodEnd
	return state, nil
}
