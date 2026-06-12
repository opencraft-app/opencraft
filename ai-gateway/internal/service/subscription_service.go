package service

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"git.woa.com/wisp/mono/ai-gateway/internal/model"
	"git.woa.com/wisp/mono/ai-gateway/internal/pkg/timex"
	"git.woa.com/wisp/mono/ai-gateway/internal/repository"
	"github.com/google/uuid"
	"gorm.io/gorm"
)

const daysPerMonth = 30

type SubscriptionService struct {
	subRepo    repository.SubscriptionRepo
	planRepo   repository.PlanRepo
	apiKeySvc  *ApiKeyService
	tokenStore *TokenBalanceStore // optional; nil during early init or in tests
}

func NewSubscriptionService(subRepo repository.SubscriptionRepo, planRepo repository.PlanRepo, apiKeySvc *ApiKeyService) *SubscriptionService {
	return &SubscriptionService{
		subRepo:   subRepo,
		planRepo:  planRepo,
		apiKeySvc: apiKeySvc,
	}
}

// SetTokenBalanceStore wires the token-balance store after construction.
// This is needed because TokenBalanceStore depends on subRepo, and
// SubscriptionService also depends on subRepo — wiring is two-phase to avoid
// a constructor cycle.
func (s *SubscriptionService) SetTokenBalanceStore(store *TokenBalanceStore) {
	s.tokenStore = store
}

// CalcTokenBalance 是 v0.1 "一次性折算" 模型下的总配额计算函数（Deprecated）。
//
// v0.2.4 月度刷新模型下不再被 Subscribe 调用，仅保留供老旧调用方（如
// passsync backfill 在过渡期）和测试参考。新代码应使用 CalcInitialTokenBalance。
//
// "days" 单位按 plan.PeriodValue / 30 折算月数后乘以 MonthlyTokens（取整）。
// "months" 直接乘以 PeriodValue。未知单位返回错误。
//
// Deprecated: use CalcInitialTokenBalance — see .tmp/aigateway-monthly-token-refresh-design.md §3.3.
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

// CalcInitialTokenBalance returns the initial token balance for a freshly-created
// subscription under the v0.2.4 monthly-refresh model: a single month's quota
// (plan.MonthlyTokens). Subsequent months are credited by the scheduler's
// RefreshDueBalances job at each b3 same-day-of-month anchor (Q2=b3 + Q3=c1).
//
// Returns 0 for "unlimited" plans (MonthlyTokens <= 0; see middleware/billing.go).
func CalcInitialTokenBalance(plan *model.Plan) int64 {
	if plan.MonthlyTokens <= 0 {
		return 0
	}
	return plan.MonthlyTokens
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
//
// periodStart 为 nil 时使用当前时间；非 nil 时使用指定起始时间（支持历史日期补录）。
//
// periodValue / periodUnit (v0.2.4 bundle ↔ plan 解耦 — Q9=i1)：调用方传入实际购买时长。
//   - 同算法约束：与 ctl/pkg/logic/pass.CalcExpiredTime 走同一份 timex.AddPeriod，
//     输入相同 (start, value, unit) → 输出 PeriodEnd 完全相同，无双源不一致。
//   - 兜底（Q10=j1 向后兼容）：periodValue == 0 或 periodUnit == "" 时回退到
//     plan.PeriodValue / plan.PeriodUnit；其他不识别的 unit 也走 plan 兜底。
//
// v0.2.4 改造：新订阅的 token_balance 仅发一个月份额（CalcInitialTokenBalance），
// LastRefreshedAt 同步初始化为 start，让 scheduler 按 b3 同号日规则在 +1m 时
// 触发首次刷新。详见 .tmp/aigateway-monthly-token-refresh-design.md §3.3 / §6.5.2。
func (s *SubscriptionService) Subscribe(
	userID, planID uuid.UUID,
	periodStart *time.Time,
	periodValue int,
	periodUnit string,
) (*model.Subscription, error) {
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

	// 月度模型：初始就发一个月份额
	balance := CalcInitialTokenBalance(plan)

	// 计算 PeriodEnd — Q9=i1 ai-gateway 真源 + Q10=j1 plan 兜底
	pv, pu := normalizePeriodForSubscribe(periodValue, periodUnit, plan)
	periodEnd, err := calcPeriodEndFromValueUnit(start, pv, pu)
	if err != nil {
		return nil, fmt.Errorf("calc period end: %w", err)
	}

	startUTC := start.UTC()
	sub := &model.Subscription{
		UserID:          userID,
		PlanID:          plan.ID,
		Status:          model.SubscriptionStatusActive,
		TokenBalance:    balance,
		PeriodStart:     start,
		PeriodEnd:       periodEnd,
		LastRefreshedAt: &startUTC,
	}

	if err := s.subRepo.Create(sub); err != nil {
		return nil, fmt.Errorf("create subscription: %w", err)
	}

	return sub, nil
}

// normalizePeriodForSubscribe applies the Q10=j1 fallback policy:
//   - non-zero / non-empty input → use it after canonicalisation
//   - zero or unrecognised → fall back to plan.PeriodValue / plan.PeriodUnit
//
// Returns (canonicalisedValue, canonicalisedUnit). Always returns a non-empty
// unit; downstream calcPeriodEndFromValueUnit still validates it.
func normalizePeriodForSubscribe(value int, unit string, plan *model.Plan) (int, string) {
	canonical := timex.NormalisePeriodUnit(unit)
	if value > 0 && canonical != "" {
		return value, canonical
	}
	// Fallback to plan defaults; canonicalise plan unit too in case it was stored
	// with a non-canonical short form ("m" / "M").
	planCanonical := timex.NormalisePeriodUnit(plan.PeriodUnit)
	if planCanonical == "" {
		// plan.PeriodUnit unrecognised — keep raw so the caller sees the same
		// "unsupported period_unit" error that v0.1 raised.
		planCanonical = plan.PeriodUnit
	}
	return plan.PeriodValue, planCanonical
}

// calcPeriodEndFromValueUnit returns start + (value, unit) using timex.AddPeriod.
// Returns an error for unrecognised units to preserve v0.1 contract: callers
// can detect "bad plan_unit / bad request unit" early.
func calcPeriodEndFromValueUnit(start time.Time, value int, unit string) (time.Time, error) {
	canonical := timex.NormalisePeriodUnit(unit)
	if canonical == "" {
		return time.Time{}, fmt.Errorf("unsupported period_unit: %q", unit)
	}
	if value <= 0 {
		return time.Time{}, fmt.Errorf("invalid period_value: %d", value)
	}
	return timex.AddPeriod(start, value, canonical), nil
}

// DB returns the underlying DB for transaction support.
func (s *SubscriptionService) DB() *gorm.DB { return s.subRepo.DB() }

// ExtendSubscription 续费链路：CAS 推进当前 user active 订阅的 PeriodEnd 到
// newPeriodEnd（仅当当前 < newPeriodEnd 才更新；天然幂等）。不动 token_balance：
// 月度刷新 scheduler 会按 b3 同号日自动按月回血，无需 R-D 链路操心 token 叠加/覆盖。
//
// 返回 (sub, wasUpdated, err)：
//   - wasUpdated=true → 本次实际写入了 PeriodEnd（原值与 newPeriodEnd 不同，含向后延期与向前缩短两种）
//   - wasUpdated=false + err=nil → 等值幂等 no-op（PeriodEnd 已与 newPeriodEnd 相等）
//   - err=ErrSubscriptionNotFound → user 没有 active 订阅（调用方应失败重试或告警）
//
// 调用方：
//   - ctl renew.go RenewPass active 同步分支 / renewPassTask 异步收尾（续费，newPeriodEnd 向后）
//   - ctl isolatePassTask 退费分支（退费隔离，newPeriodEnd = jifei 给的较早 newDeadline，向前缩短）
//
// 设计原则（用户拍板 2026-05-24）：pass.expired_time 是真源，ai-gateway 跟车对齐，
// 保证两侧天级一致；详见 .tmp/aigateway-monthly-token-refresh-design.md §5.2 / §8 stage 4 R-MR-4。
func (s *SubscriptionService) ExtendSubscription(
	ctx context.Context,
	userID uuid.UUID,
	newPeriodEnd time.Time,
) (*model.Subscription, bool, error) {
	affected, sub, err := s.subRepo.ExtendActivePeriodEnd(userID, newPeriodEnd)
	if err != nil {
		return nil, false, fmt.Errorf("extend active period_end: %w", err)
	}
	wasUpdated := affected > 0
	if wasUpdated && s.apiKeySvc != nil {
		// PeriodEnd 推进改变了订阅有效期，同步失效该用户的 API Key 缓存
		// （避免 cache hit 时还按旧 PeriodEnd 判活）。
		_ = s.apiKeySvc.InvalidateCacheByUserID(userID)
	}
	return sub, wasUpdated, nil
}

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

// refreshBatchSize 控制 RefreshDueBalances 单批 SQL 粗筛拉取的候选数。
// scheduler 1h 跑一次 + 每批 1000 条，足够覆盖任何单环境 active 订阅量级。
const refreshBatchSize = 1000

// RefreshDueBalances 双段式月度刷新（v0.2.4 月度模型 + b3 同号日 Q2 拍板）：
//
//  1. SQL 粗筛（repo.ListRefreshCandidates）：last_refreshed_at <= NOW - 28d 的
//     active 订阅；28d 是月最短长度（2 月）的下界，保证不漏召回。
//  2. Go 精筛（本函数）：对每个候选用 timex.AddMonthsNatural 推进 anchor 锚点，
//     把 anchor 推进到「最近的过去同号日 <= NOW」。如果至少推进了一次（stepped），
//     说明确实跨过了一个或多个同号日，触发刷新；否则是 false positive（28d 下界
//     召回但还没真正到下一个同号日，例如 1/15 起的订阅在 2/12 不应该刷）跳过。
//  3. 写库（repo.RefreshByIDs）：把 token_balance 重置为 plan.MonthlyTokens
//     （Q3=c1 覆盖重置），last_refreshed_at 推进到刚算出的 anchor。
//  4. Redis 失效（tokenStore.InvalidateRedisCache）：删除 Redis token key 让下次
//     扣减时按需从 DB 重新初始化，避免 DB 月度刷新被旧 Redis 缓存覆盖回去。
//
// 「锚点推进」语义实现 scheduler 断刷自愈：scheduler 故障停跑数月恢复后，单次
// tick 会把 anchor 一次性推进到当前轨道（例如 PeriodStart=1/15 + 80 天没跑，
// 4/10 恢复时 anchor 推进到 3/15，token_balance 仍只刷一份额，不会因为停跑给
// 用户白发多个月配额）。
//
// 详见 .tmp/aigateway-monthly-token-refresh-design.md §3.2 / §3.3。
//
// 返回本轮真正刷新的订阅条数（不含 false positive）。
func (s *SubscriptionService) RefreshDueBalances(ctx context.Context) (int64, error) {
	var totalAffected int64
	now := time.Now().UTC()

	for {
		candidates, err := s.subRepo.ListRefreshCandidates(refreshBatchSize)
		if err != nil {
			return totalAffected, fmt.Errorf("list refresh candidates: %w", err)
		}
		if len(candidates) == 0 {
			break
		}

		toRefresh := make([]repository.SubscriptionRefreshItem, 0, len(candidates))
		refreshedIDs := make([]uuid.UUID, 0, len(candidates))

		for _, c := range candidates {
			anchor := c.LastRefreshedAt
			stepped := false
			// 推进锚点到「最近的过去同号日 <= NOW」。
			// 上限 1024 步是防御性兜底（对应 ~85 年 — 单个订阅历史不可能这么久），
			// 即使有时钟错乱或 DB 数据异常也不会死循环。
			for i := 0; i < 1024; i++ {
				next := timex.AddMonthsNatural(anchor, 1)
				if next.After(now) {
					break
				}
				anchor = next
				stepped = true
			}
			if !stepped {
				// false positive — 28d 召回但实际还没到下一个同号日。
				continue
			}
			toRefresh = append(toRefresh, repository.SubscriptionRefreshItem{
				ID:              c.ID,
				NewRefreshedAt:  anchor,
				NewTokenBalance: c.MonthlyTokens, // Q3=c1 覆盖重置
			})
			refreshedIDs = append(refreshedIDs, c.ID)
		}

		if len(toRefresh) == 0 {
			// 整批都是 false positive — 因为粗筛 ORDER BY anchor ASC，后续候选
			// 的 anchor 只会更晚，更不可能 stepped，直接结束本轮 scheduler tick。
			break
		}

		affected, err := s.subRepo.RefreshByIDs(toRefresh)
		if err != nil {
			return totalAffected, fmt.Errorf("refresh by ids: %w", err)
		}
		totalAffected += affected

		// Redis 缓存失效（best effort — 失败不阻断刷新主流程）
		if s.tokenStore != nil {
			for _, id := range refreshedIDs {
				if err := s.tokenStore.InvalidateRedisCache(ctx, id); err != nil {
					slog.Warn("invalidate redis cache after refresh failed",
						"sub_id", id, "error", err)
				}
			}
		}

		// 本批召回数 < batchSize，说明库里没更多候选了，提前结束分页。
		if len(candidates) < refreshBatchSize {
			break
		}
	}
	return totalAffected, nil
}
