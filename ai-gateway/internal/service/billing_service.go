package service

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"

	"git.woa.com/wisp/mono/ai-gateway/internal/model"
	"git.woa.com/wisp/mono/ai-gateway/internal/repository"
	"github.com/google/uuid"
)

// TokenBalanceOps 定义 token 余额操作接口（Redis 主控 + DB 兜底）。
type TokenBalanceOps interface {
	Deduct(ctx context.Context, subID uuid.UUID, amount int64) error
	Refund(ctx context.Context, subID uuid.UUID, amount int64) error
	DeductToZero(ctx context.Context, subID uuid.UUID, amount int64) (int64, error)
}

type BillingService struct {
	balanceOps         TokenBalanceOps
	provRepo           repository.ProviderRepo
	usageRepo          repository.UsageRepo
	defaultReservation int64
}

// NewBillingService 创建 BillingService。
// balanceOps 推荐使用 TokenBalanceStore（Redis 主控），也可传入仅有 SubscriptionRepo 的简单实现。
func NewBillingService(balanceOps TokenBalanceOps, provRepo repository.ProviderRepo, usageRepo repository.UsageRepo, defaultReservation int64) *BillingService {
	return &BillingService{
		balanceOps:         balanceOps,
		provRepo:           provRepo,
		usageRepo:          usageRepo,
		defaultReservation: defaultReservation,
	}
}

// GetMultiplier extracts the token multiplier for a model from the plan's token_multipliers JSONB.
// Returns 1.0 if no multiplier is defined for the model.
func GetMultiplier(plan *model.Plan, modelName string) float64 {
	if plan.TokenMultipliers == nil {
		return 1.0
	}
	var multipliers map[string]float64
	if err := json.Unmarshal(plan.TokenMultipliers, &multipliers); err != nil {
		return 1.0
	}
	if m, ok := multipliers[modelName]; ok {
		return m
	}
	return 1.0
}

// Reserve pre-deducts estimated tokens from the subscription.
// estimated = defaultReservation * multiplier
// For unlimited plans (MonthlyTokens == 0), reservation is skipped.
func (s *BillingService) Reserve(ctx context.Context, subID uuid.UUID, modelName string, plan *model.Plan) (int64, error) {
	// Unlimited plan — no reservation needed
	if plan.MonthlyTokens == 0 {
		return 0, nil
	}
	multiplier := GetMultiplier(plan, modelName)
	estimated := int64(float64(s.defaultReservation) * multiplier)
	if estimated <= 0 {
		estimated = s.defaultReservation
	}
	if err := s.balanceOps.Deduct(ctx, subID, estimated); err != nil {
		return 0, err
	}
	return estimated, nil
}

// RefundReservation refunds a previously reserved token amount.
// Non-positive amounts are ignored.
func (s *BillingService) RefundReservation(ctx context.Context, subID uuid.UUID, amount int64) error {
	if amount <= 0 {
		return nil
	}
	return s.balanceOps.Refund(ctx, subID, amount)
}

// Settle reconciles the actual token usage against the reservation.
// If actual < reserved: refund the difference.
// If actual > reserved: deduct more (best-effort, may fail if balance insufficient).
// For unlimited plans (MonthlyTokens == 0), settlement is skipped.
// Returns an error if any settlement step failed; callers should decide how to handle it.
func (s *BillingService) Settle(ctx context.Context, subID, providerID uuid.UUID, reserved, actualRaw int64, modelName string, plan *model.Plan) error {
	// Unlimited plan — no settlement needed
	if plan.MonthlyTokens == 0 {
		return nil
	}

	multiplier := GetMultiplier(plan, modelName)
	actual := int64(float64(actualRaw) * multiplier)

	var settlementErr error

	delta := reserved - actual
	if delta > 0 {
		// Refund excess reservation
		if err := s.balanceOps.Refund(ctx, subID, delta); err != nil {
			slog.Error("failed to refund tokens", "sub_id", subID, "delta", delta, "error", err)
			settlementErr = fmt.Errorf("refund tokens: %w", err)
		}
	} else if delta < 0 {
		// Deduct additional. If balance is insufficient, deduct all remaining (to zero).
		actualDeducted, err := s.balanceOps.DeductToZero(ctx, subID, -delta)
		if err != nil {
			slog.Error("failed to deduct extra tokens", "sub_id", subID, "delta", -delta, "error", err)
			settlementErr = fmt.Errorf("deduct extra tokens: %w", err)
		} else if actualDeducted < -delta {
			slog.Warn("partial token deduction due to insufficient balance",
				"sub_id", subID, "requested", -delta, "actual", actualDeducted)
		}
	}

	// NOTE: Provider used_quota is tracked separately via ProviderService.TrackUsage()
	// which also handles exhaustion detection. Do NOT duplicate IncrementUsedQuota here.

	return settlementErr
}

// LogUsage persists a usage record to the database.
func (s *BillingService) LogUsage(log *model.UsageLog) error {
	if err := s.usageRepo.Create(log); err != nil {
		slog.Error("failed to persist usage log", "request_id", log.RequestID, "error", err)
		return err
	}
	return nil
}
