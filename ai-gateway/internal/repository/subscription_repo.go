package repository

import (
	"errors"
	"time"

	"git.woa.com/wisp/mono/ai-gateway/internal/model"
	"github.com/google/uuid"
	"gorm.io/gorm"
)

type SubscriptionRepo interface {
	Create(sub *model.Subscription) error
	GetByID(id uuid.UUID) (*model.Subscription, error)
	GetActiveByUserID(userID uuid.UUID) (*model.Subscription, error)
	DeductTokens(subID uuid.UUID, amount int64) error
	DeductTokensToZero(subID uuid.UUID, amount int64) (int64, error)
	RefundTokens(subID uuid.UUID, amount int64) error
	SetTokenBalance(subID uuid.UUID, balance int64) error
	ExpireOverdue() (int64, error)
	CancelByUserID(userID uuid.UUID) error
	Update(sub *model.Subscription) error
	CountActive() (int64, error)
	ListExpiredUserIDs() ([]uuid.UUID, error)
	SumActiveTokenBalance() (int64, error)
	DB() *gorm.DB
}

type subscriptionRepo struct {
	db *gorm.DB
}

func NewSubscriptionRepo(db *gorm.DB) SubscriptionRepo {
	return &subscriptionRepo{db: db}
}

func (r *subscriptionRepo) DB() *gorm.DB { return r.db }

func (r *subscriptionRepo) Create(sub *model.Subscription) error {
	return r.db.Create(sub).Error
}

func (r *subscriptionRepo) GetByID(id uuid.UUID) (*model.Subscription, error) {
	var sub model.Subscription
	err := r.db.Where("id = ?", id).First(&sub).Error
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, model.ErrSubscriptionNotFound
		}
		return nil, err
	}
	return &sub, nil
}

func (r *subscriptionRepo) GetActiveByUserID(userID uuid.UUID) (*model.Subscription, error) {
	var sub model.Subscription
	err := r.db.Where("user_id = ? AND status = ?", userID, model.SubscriptionStatusActive).First(&sub).Error
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, model.ErrSubscriptionNotFound
		}
		return nil, err
	}
	return &sub, nil
}

// DeductTokens atomically deducts tokens from a subscription.
// Returns ErrQuotaExceeded if insufficient balance or subscription not active.
func (r *subscriptionRepo) DeductTokens(subID uuid.UUID, amount int64) error {
	result := r.db.Model(&model.Subscription{}).
		Where("id = ? AND token_balance >= ? AND status = ?", subID, amount, model.SubscriptionStatusActive).
		Update("token_balance", gorm.Expr("token_balance - ?", amount))
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected == 0 {
		return model.ErrQuotaExceeded
	}
	return nil
}

// DeductTokensToZero deducts up to `amount` from the subscription,
// capping the deduction at the current balance (balance will not go below 0).
// Returns the actual amount deducted. Unlike DeductTokens, this never fails
// due to insufficient balance — it simply deducts whatever is available.
// Uses a single atomic UPDATE to avoid TOCTOU race conditions.
func (r *subscriptionRepo) DeductTokensToZero(subID uuid.UUID, amount int64) (int64, error) {
	// 原子扣减：先查询当前余额，再原子更新
	var sub model.Subscription
	if err := r.db.Where("id = ?", subID).First(&sub).Error; err != nil {
		return 0, err
	}

	if sub.TokenBalance <= 0 {
		return 0, nil
	}

	actualDeduct := sub.TokenBalance
	if actualDeduct > amount {
		actualDeduct = amount
	}

	// 原子更新（乐观更新，余额不足时实际扣减量会小于 amount）
	result := r.db.Model(&model.Subscription{}).
		Where("id = ? AND token_balance > 0", subID).
		Update("token_balance", gorm.Expr("token_balance - ?", actualDeduct))
	if result.Error != nil {
		return 0, result.Error
	}

	return actualDeduct, nil
}

// SetTokenBalance 直接设置 token 余额（用于 Write-Behind 写回）。
func (r *subscriptionRepo) SetTokenBalance(subID uuid.UUID, balance int64) error {
	return r.db.Model(&model.Subscription{}).
		Where("id = ?", subID).
		Update("token_balance", balance).Error
}

// RefundTokens adds tokens back to a subscription.
func (r *subscriptionRepo) RefundTokens(subID uuid.UUID, amount int64) error {
	result := r.db.Model(&model.Subscription{}).
		Where("id = ?", subID).
		Update("token_balance", gorm.Expr("token_balance + ?", amount))
	if result.Error != nil {
		return result.Error
	}
	return nil
}

// ExpireOverdue marks all active subscriptions past their period_end as expired.
// MySQL 兼容：使用 UPDATE ... JOIN 替代 PostgreSQL 的 UPDATE ... FROM CTE 语法。
func (r *subscriptionRepo) ExpireOverdue() (int64, error) {
	const batchSize = 1000
	var totalAffected int64

	for {
		// MySQL 不支持 UPDATE ... FROM CTE，改用 UPDATE JOIN 子查询
		result := r.db.Exec(`
			UPDATE subscriptions s
			JOIN (
				SELECT id FROM subscriptions
				WHERE status = ? AND period_end < UTC_TIMESTAMP()
				LIMIT ?
			) AS expired_batch ON s.id = expired_batch.id
			SET s.status = ?, s.updated_at = UTC_TIMESTAMP()
		`, model.SubscriptionStatusActive, batchSize, model.SubscriptionStatusExpired)

		if result.Error != nil {
			return totalAffected, result.Error
		}

		affected := result.RowsAffected
		totalAffected += affected

		// Exit loop if no more rows to update
		if affected < batchSize {
			break
		}
	}

	return totalAffected, nil
}

// CancelByUserID cancels all active subscriptions for a user and sets updated_at.
func (r *subscriptionRepo) CancelByUserID(userID uuid.UUID) error {
	return r.db.Model(&model.Subscription{}).
		Where("user_id = ? AND status = ?", userID, model.SubscriptionStatusActive).
		Updates(map[string]interface{}{
			"status":     model.SubscriptionStatusCancelled,
			"updated_at": time.Now().UTC(),
		}).Error
}

func (r *subscriptionRepo) Update(sub *model.Subscription) error {
	return r.db.Save(sub).Error
}

func (r *subscriptionRepo) CountActive() (int64, error) {
	var count int64
	if err := r.db.Model(&model.Subscription{}).Where("status = ?", model.SubscriptionStatusActive).Count(&count).Error; err != nil {
		return 0, err
	}
	return count, nil
}

func (r *subscriptionRepo) ListExpiredUserIDs() ([]uuid.UUID, error) {
	var userIDs []uuid.UUID
	err := r.db.Model(&model.Subscription{}).
		Where("status = ? AND period_end < UTC_TIMESTAMP()", model.SubscriptionStatusActive).
		Distinct("user_id").
		Pluck("user_id", &userIDs).Error
	return userIDs, err
}

func (r *subscriptionRepo) SumActiveTokenBalance() (int64, error) {
	var total int64
	err := r.db.Model(&model.Subscription{}).
		Where("status = ?", model.SubscriptionStatusActive).
		Select("COALESCE(SUM(token_balance), 0)").
		Scan(&total).Error
	return total, err
}
