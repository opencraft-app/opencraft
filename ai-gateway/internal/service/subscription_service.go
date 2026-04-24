package service

import (
	"fmt"
	"time"

	"git.woa.com/wisp/mono/ai-gateway/internal/model"
	"git.woa.com/wisp/mono/ai-gateway/internal/repository"
	"github.com/google/uuid"
	"gorm.io/gorm"
)

const daysPerMonth = 30

type SubscriptionService struct {
	subRepo   repository.SubscriptionRepo
	planRepo  repository.PlanRepo
	apiKeySvc *ApiKeyService
}

func NewSubscriptionService(subRepo repository.SubscriptionRepo, planRepo repository.PlanRepo, apiKeySvc *ApiKeyService) *SubscriptionService {
	return &SubscriptionService{
		subRepo:   subRepo,
		planRepo:  planRepo,
		apiKeySvc: apiKeySvc,
	}
}

// CalcTokenBalance 根据套餐配置计算订阅总 token 配额。
// "days" 单位按 plan.PeriodValue / 30 折算月数后乘以 MonthlyTokens（取整）。
// "months" 直接乘以 PeriodValue。未知单位返回错误。
func CalcTokenBalance(plan *model.Plan) (int64, error) {
	switch plan.PeriodUnit {
	case "days":
		return plan.MonthlyTokens * int64(plan.PeriodValue) / daysPerMonth, nil
	case "months":
		return plan.MonthlyTokens * int64(plan.PeriodValue), nil
	default:
		return 0, fmt.Errorf("unsupported period_unit: %q", plan.PeriodUnit)
	}
}

// CalcPeriodEnd 根据套餐配置计算订阅到期时间。
// 未知 period_unit 返回错误。
func CalcPeriodEnd(start time.Time, plan *model.Plan) (time.Time, error) {
	switch plan.PeriodUnit {
	case "days":
		return start.AddDate(0, 0, plan.PeriodValue), nil
	case "months":
		return start.AddDate(0, plan.PeriodValue, 0), nil
	default:
		return time.Time{}, fmt.Errorf("unsupported period_unit: %q", plan.PeriodUnit)
	}
}

// Subscribe 创建新订阅，同时取消当前用户所有活跃订阅。
// periodStart 为 nil 时使用当前时间；非 nil 时使用指定起始时间（支持历史日期补录）。
func (s *SubscriptionService) Subscribe(userID, planID uuid.UUID, periodStart *time.Time) (*model.Subscription, error) {
	// 获取套餐信息
	plan, err := s.planRepo.GetByID(planID)
	if err != nil {
		return nil, fmt.Errorf("get plan: %w", err)
	}

	// 取消用户当前活跃订阅（用户可能尚无活跃订阅，忽略 not found）
	if err := s.subRepo.CancelByUserID(userID); err != nil && err != model.ErrSubscriptionNotFound {
		return nil, fmt.Errorf("cancel existing subscription: %w", err)
	}

	// 清理旧订阅的 API Key 缓存
	if s.apiKeySvc != nil {
		_ = s.apiKeySvc.InvalidateCacheByUserID(userID)
	}

	// 确定订阅起始时间
	var start time.Time
	if periodStart != nil {
		start = *periodStart
	} else {
		start = time.Now()
	}

	// 计算 token 配额和到期时间
	balance, err := CalcTokenBalance(plan)
	if err != nil {
		return nil, fmt.Errorf("calc token balance: %w", err)
	}
	if balance < 0 {
		balance = 0
	}

	periodEnd, err := CalcPeriodEnd(start, plan)
	if err != nil {
		return nil, fmt.Errorf("calc period end: %w", err)
	}

	sub := &model.Subscription{
		UserID:       userID,
		PlanID:       plan.ID,
		Status:       model.SubscriptionStatusActive,
		TokenBalance: balance,
		PeriodStart:  start,
		PeriodEnd:    periodEnd,
	}

	if err := s.subRepo.Create(sub); err != nil {
		return nil, fmt.Errorf("create subscription: %w", err)
	}

	return sub, nil
}

// DB returns the underlying DB for transaction support.
func (s *SubscriptionService) DB() *gorm.DB { return s.subRepo.DB() }

// ExpireOverdue marks expired subscriptions and invalidates their API key cache.
func (s *SubscriptionService) ExpireOverdue() (int64, error) {
	count, err := s.subRepo.ExpireOverdue()
	if err != nil || count == 0 {
		return count, err
	}

	if s.apiKeySvc != nil {
		userIDs, err := s.subRepo.ListExpiredUserIDs()
		if err != nil {
			return count, err
		}
		for _, userID := range userIDs {
			_ = s.apiKeySvc.InvalidateCacheByUserID(userID)
		}
	}

	return count, nil
}

// GetActiveByUserID returns the active subscription for a user.
func (s *SubscriptionService) GetActiveByUserID(userID uuid.UUID) (*model.Subscription, error) {
	return s.subRepo.GetActiveByUserID(userID)
}

// GetByID returns a subscription by ID.
func (s *SubscriptionService) GetByID(id uuid.UUID) (*model.Subscription, error) {
	return s.subRepo.GetByID(id)
}

// Update updates a subscription.
func (s *SubscriptionService) Update(sub *model.Subscription) error {
	if err := s.subRepo.Update(sub); err != nil {
		return err
	}
	// 清理该用户的 API Key 缓存
	if s.apiKeySvc != nil {
		_ = s.apiKeySvc.InvalidateCacheByUserID(sub.UserID)
	}
	return nil
}

// Cancel cancels the active subscription for a user and invalidates API key cache.
func (s *SubscriptionService) Cancel(userID uuid.UUID) (*model.Subscription, error) {
	sub, err := s.subRepo.GetActiveByUserID(userID)
	if err != nil {
		return nil, err
	}
	if err := s.subRepo.CancelByUserID(userID); err != nil {
		return nil, err
	}
	if s.apiKeySvc != nil {
		_ = s.apiKeySvc.InvalidateCacheByUserID(userID)
	}
	sub.Status = model.SubscriptionStatusCancelled
	return sub, nil
}

// CountActive returns the number of active subscriptions.
func (s *SubscriptionService) CountActive() (int64, error) {
	return s.subRepo.CountActive()
}

// SumActiveTokenBalance returns the total token balance of all active subscriptions.
func (s *SubscriptionService) SumActiveTokenBalance() (int64, error) {
	return s.subRepo.SumActiveTokenBalance()
}
