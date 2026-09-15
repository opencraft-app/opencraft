package gateway

import (
	"context"
	"crypto/sha256"
	"fmt"
	"strings"
)

const maxPromotionalTokenAmount = int64(10_000_000_000)

// resolveAmountBasedSubscriptionPlan converts a trusted internal token grant
// into a stable, never-reset Plan owned by VelaGW. Callers do not manage Plan
// IDs; the existing Set plan reconciler materializes the template everywhere.
func (s *Service) resolveAmountBasedSubscriptionPlan(ctx context.Context, req ApplySubscriptionRequest) (ApplySubscriptionRequest, error) {
	req.PlanID = strings.TrimSpace(req.PlanID)
	if req.PlanID != "" && req.TokenAmount > 0 {
		return ApplySubscriptionRequest{}, fmt.Errorf("plan_id and token_amount cannot both be set")
	}
	if req.PlanID != "" {
		return req, nil
	}
	if req.TokenAmount <= 0 || req.TokenAmount > maxPromotionalTokenAmount {
		return ApplySubscriptionRequest{}, fmt.Errorf("token_amount must be between 1 and %d when plan_id is empty", maxPromotionalTokenAmount)
	}

	canonical := fmt.Sprintf("promotional-credit:v1:%d:never", req.TokenAmount)
	digest := sha256.Sum256([]byte(canonical))
	plan := Plan{
		ID:               fmt.Sprintf("promotional-credit-v1-%x", digest[:8]),
		Name:             fmt.Sprintf("System promotional credit %d tokens", req.TokenAmount),
		MonthlyTokens:    req.TokenAmount,
		QuotaResetPeriod: "never",
		IsActive:         true,
	}
	if err := s.RegisterPlan(ctx, plan); err != nil {
		return ApplySubscriptionRequest{}, fmt.Errorf("ensure promotional credit plan: %w", err)
	}
	req.PlanID = plan.ID
	req.TokenAmount = 0
	return req, nil
}
