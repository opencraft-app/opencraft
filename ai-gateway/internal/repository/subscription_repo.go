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
	// ListRefreshCandidates 粗筛同号日（b3）刷新候选：last_refreshed_at <= NOW - 28d
	// 的 active 订阅。28d 是月最短长度（2 月）的下界，保证不漏召回；多召回的
	// false positive（28~31d 但实际还没到同号日）由 Service 层用
	// timex.AddMonthsNatural 精筛剔除。详见 .tmp/aigateway-monthly-token-refresh-design.md §3.2。
	ListRefreshCandidates(limit int) ([]SubscriptionRefreshCandidate, error)
	// RefreshByIDs 把指定订阅的 token_balance 重置为 NewTokenBalance，
	// last_refreshed_at 推进到 NewRefreshedAt（由 Service 层用 AddMonthsNatural 算出）。
	// 返回实际更新的行数。
	RefreshByIDs(items []SubscriptionRefreshItem) (int64, error)
	// ExtendActivePeriodEnd 把指定 user 当前 active 订阅的 period_end **强制对齐**到
	// newPeriodEnd（无 only-forward 限制，等于 newPeriodEnd 时 no-op，否则覆盖；
	// 既支持续费向后延期，也支持退费向前缩短）。不动 token_balance：月度刷新模型下
	// scheduler 按 b3 同号日自然回血。返回 (affected, sub_after, err)：
	//   - affected=1 → 实际写入了新 period_end（与原值不同）
	//   - affected=0 + err=nil → 等值幂等 no-op（period_end 已经等于 newPeriodEnd）
	//   - err=ErrSubscriptionNotFound → 用户没有 active 订阅
	// 设计原则（用户拍板 2026-05-24）：pass.expired_time 是 ctl 真源，ai-gateway
	// 必须无条件对齐 — 续费/退费都要保证两侧天级一致。
	// 详见 .tmp/aigateway-monthly-token-refresh-design.md §5.1 R-MR-4。
	ExtendActivePeriodEnd(userID uuid.UUID, newPeriodEnd time.Time) (int64, *model.Subscription, error)
	DB() *gorm.DB
}

// SubscriptionRefreshCandidate is a row returned by ListRefreshCandidates.
// It carries just enough state for the Service layer to decide whether the
// candidate is actually due (Go-side same-day-of-month precise filter) and,
// if so, what new anchor / token balance to write.
type SubscriptionRefreshCandidate struct {
	ID              uuid.UUID
	LastRefreshedAt time.Time
	PeriodEnd       time.Time
	MonthlyTokens   int64
}

// SubscriptionRefreshItem is the input to RefreshByIDs — the precise refresh
// decision computed by the Service layer for a single subscription.
type SubscriptionRefreshItem struct {
	ID              uuid.UUID
	NewRefreshedAt  time.Time
	NewTokenBalance int64
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

// ListRefreshCandidates 粗筛 b3 同号日刷新候选。
//
// SQL 粗筛规则：active + 未过期 + plan.monthly_tokens > 0 +
// COALESCE(last_refreshed_at, period_start) <= NOW - 28d。
// ORDER BY anchor ASC + LIMIT，便于分批；当 batch 全部是 false positive 时
// Service 层会停止下一批拉取（避免无效 SELECT）。
func (r *subscriptionRepo) ListRefreshCandidates(limit int) ([]SubscriptionRefreshCandidate, error) {
	type row struct {
		ID              uuid.UUID
		LastRefreshedAt time.Time
		PeriodEnd       time.Time
		MonthlyTokens   int64
	}
	var rows []row
	err := r.db.Raw(`
		SELECT s.id AS id,
		       COALESCE(s.last_refreshed_at, s.period_start) AS last_refreshed_at,
		       s.period_end AS period_end,
		       p.monthly_tokens AS monthly_tokens
		FROM subscriptions s
		JOIN plans p ON s.plan_id = p.id
		WHERE s.status = ?
		  AND s.period_end > UTC_TIMESTAMP()
		  AND p.monthly_tokens > 0
		  AND COALESCE(s.last_refreshed_at, s.period_start) <= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 28 DAY)
		ORDER BY COALESCE(s.last_refreshed_at, s.period_start) ASC
		LIMIT ?`,
		model.SubscriptionStatusActive, limit).Scan(&rows).Error
	if err != nil {
		return nil, err
	}
	out := make([]SubscriptionRefreshCandidate, len(rows))
	for i, rr := range rows {
		out[i] = SubscriptionRefreshCandidate{
			ID:              rr.ID,
			LastRefreshedAt: rr.LastRefreshedAt,
			PeriodEnd:       rr.PeriodEnd,
			MonthlyTokens:   rr.MonthlyTokens,
		}
	}
	return out, nil
}

// RefreshByIDs 批量更新 token_balance + last_refreshed_at。
//
// 实现：单事务 + 逐行 UPDATE（每行的 NewTokenBalance / NewRefreshedAt 不同，
// CASE WHEN 写法可读性差且 binding 复杂，逐行 UPDATE 在 batchSize=1000 量级下
// 性能可接受 — scheduler 1h 跑一次，不是热路径）。
func (r *subscriptionRepo) RefreshByIDs(items []SubscriptionRefreshItem) (int64, error) {
	if len(items) == 0 {
		return 0, nil
	}
	var total int64
	err := r.db.Transaction(func(tx *gorm.DB) error {
		for _, it := range items {
			res := tx.Model(&model.Subscription{}).
				Where("id = ? AND status = ?", it.ID, model.SubscriptionStatusActive).
				Updates(map[string]interface{}{
					"token_balance":     it.NewTokenBalance,
					"last_refreshed_at": it.NewRefreshedAt.UTC(),
					"updated_at":        time.Now().UTC(),
				})
			if res.Error != nil {
				return res.Error
			}
			total += res.RowsAffected
		}
		return nil
	})
	return total, err
}

// ExtendActivePeriodEnd 把指定 user 当前 active 订阅的 period_end **强制对齐**到
// newPeriodEnd（不再受 only-forward CAS 限制；既支持续费向后延期，也支持退费向
// 前缩短，统一覆盖到 newPeriodEnd 这个值）。
//
// 语义升级（用户拍板 2026-05-24）：原来 only-forward 的 "period_end < ?" 守门会
// 让退费场景下 jifei 给的较早 newDeadline 永远写不进来，导致 ctl 与 ai-gateway
// 不一致 — 统一对齐到 ctl pass.expired_time 是真源，ai-gateway 跟车，无论方向。
//
// affected 语义：
//   - 1 → 实际写入了新 period_end（与原值不相等）
//   - 0 + err=nil → 等值幂等 no-op（period_end 已等于 newPeriodEnd，秒级精度）
//
// Does NOT touch token_balance: under the monthly-refresh model, scheduler
// continues to credit MonthlyTokens at each b3 same-day-of-month anchor.
//
// Returns (rowsAffected, subAfter, err). subAfter 是 UPDATE 后的最新状态（无论
// 是否真的写入），便于 caller 把最新 PeriodEnd 透传给上游。
func (r *subscriptionRepo) ExtendActivePeriodEnd(userID uuid.UUID, newPeriodEnd time.Time) (int64, *model.Subscription, error) {
	newPeriodEndUTC := newPeriodEnd.UTC()
	// "对齐"语义：仅当当前 period_end != newPeriodEnd 才更新。等值即 no-op，
	// 让 affected=0 这个信号继续表达"无变化"（caller 据此决定是否需要联动失效
	// API key 缓存）。
	res := r.db.Model(&model.Subscription{}).
		Where("user_id = ? AND status = ? AND period_end <> ?",
			userID, model.SubscriptionStatusActive, newPeriodEndUTC).
		Updates(map[string]interface{}{
			"period_end": newPeriodEndUTC,
			"updated_at": time.Now().UTC(),
		})
	if res.Error != nil {
		return 0, nil, res.Error
	}
	// 总是读回 active sub，让 caller 拿到最新值（含 idempotent no-op 与 not-found 两个分支）
	sub, err := r.GetActiveByUserID(userID)
	if err != nil {
		// model.ErrSubscriptionNotFound is a meaningful signal — bubble up.
		return res.RowsAffected, nil, err
	}
	return res.RowsAffected, sub, nil
}
