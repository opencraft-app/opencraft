package gateway

import (
	"context"
	"fmt"
	"strings"
)

func (s *Service) GetUserCredit(ctx context.Context, externalUserID string) (UserCredit, error) {
	externalUserID = strings.TrimSpace(externalUserID)
	if externalUserID == "" {
		return UserCredit{}, fmt.Errorf("user_id is required")
	}
	assignment, err := s.GetUserAssignment(ctx, externalUserID)
	if err != nil {
		return UserCredit{}, err
	}
	switch assignment.Backend {
	case UserBackendNew:
		return s.getNewUserCredit(ctx, externalUserID, assignment)
	case UserBackendPending:
		return UserCredit{}, ErrTenantPending
	default:
		return UserCredit{}, fmt.Errorf("invalid user backend %q", assignment.Backend)
	}
}

func (s *Service) getNewUserCredit(ctx context.Context, externalUserID string, assignment UserAssignment) (UserCredit, error) {
	sub, err := s.GetActiveSubscription(ctx, externalUserID)
	if err != nil {
		return UserCredit{}, err
	}
	setID := assignment.SetID
	if setID == "" {
		if binding, ok, err := s.store.GetUserBinding(ctx, externalUserID); err != nil {
			return UserCredit{}, err
		} else if ok {
			setID = binding.SetID
		}
	}
	return UserCredit{
		UserID:          externalUserID,
		Backend:         UserBackendNew,
		SetID:           setID,
		PlanID:          sub.PlanID,
		TokenBalance:    sub.TokenBalance,
		CreditAvailable: sub.TokenBalance,
		Unlimited:       sub.Unlimited,
		PeriodStart:     sub.PeriodStart,
		PeriodEnd:       sub.PeriodEnd,
		Source:          "new-api",
	}, nil
}

func firstNonEmpty(value string, fallback string) string {
	if strings.TrimSpace(value) != "" {
		return value
	}
	return fallback
}
