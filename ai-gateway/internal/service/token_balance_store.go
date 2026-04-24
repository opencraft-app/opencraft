package service

import (
	"context"
	"errors"
	"log/slog"
	"sync"

	"git.woa.com/wisp/mono/ai-gateway/internal/model"
	"git.woa.com/wisp/mono/ai-gateway/internal/pkg/redisclient"
	"git.woa.com/wisp/mono/ai-gateway/internal/repository"
	"github.com/google/uuid"
)

// TokenBalanceStore 提供 token 余额的 Redis 主控 + DB 兜底。
//
// Redis 为实时数据源（零锁、无 TOCTOU），DB 为最终持久化。
// 所有变更实时写 Redis，异步写回 DB（Write-Behind）。
// Redis 故障时自动降级到 DB（兜底）。
type TokenBalanceStore struct {
	redis    *redisclient.Client
	subRepo  repository.SubscriptionRepo
	syncChan chan tokenDelta
	syncWg   sync.WaitGroup
}

// tokenDelta 描述一次余额变更，用于异步写回 DB。
type tokenDelta struct {
	SubID   uuid.UUID
	Balance int64 // 变更后的最新余额
}

// NewTokenBalanceStore 创建余额存储，启动异步写回协程。
func NewTokenBalanceStore(redisClient *redisclient.Client, subRepo repository.SubscriptionRepo) *TokenBalanceStore {
	t := &TokenBalanceStore{
		redis:    redisClient,
		subRepo:  subRepo,
		syncChan: make(chan tokenDelta, 2000),
	}
	t.syncWg.Add(1)
	go t.writeBehind()
	return t
}

// writeBehind 异步将余额变化写回 DB。
// 每条消息直接 UPDATE，不重新读取（允许最终一致）。
func (t *TokenBalanceStore) writeBehind() {
	defer t.syncWg.Done()
	for delta := range t.syncChan {
		if err := t.subRepo.SetTokenBalance(delta.SubID, delta.Balance); err != nil {
			slog.Error("token 余额写回 DB 失败", "sub_id", delta.SubID, "balance", delta.Balance, "error", err)
		}
	}
}

// Stop 停止写回协程，等待所有待处理消息 flush 完成。
func (t *TokenBalanceStore) Stop() {
	close(t.syncChan)
	t.syncWg.Wait()
	slog.Info("TokenBalanceStore 写回协程已停止")
}

// syncDelta 发送一条变更到写回队列。
func (t *TokenBalanceStore) syncDelta(subID uuid.UUID, balance int64) {
	select {
	case t.syncChan <- tokenDelta{SubID: subID, Balance: balance}:
	default:
		// 队列满，跳过此次写回，下次变更会追上
		// 这意味着 DB 数据可能暂时落后，但 Redis 是实时的
		slog.Warn("token 写回队列满，跳过本次写回", "sub_id", subID)
	}
}

func (t *TokenBalanceStore) ensureInitialized(ctx context.Context, subID uuid.UUID) error {
	if t.redis == nil {
		return nil
	}
	initialized, err := t.redis.IsTokenBalanceInitialized(ctx, subID.String())
	if err != nil {
		return err
	}
	if initialized {
		return nil
	}
	return t.SyncFromDB(ctx, subID)
}

// Deduct atomically deducts tokens.
// Redis 优先，失败则降级到 DB。
func (t *TokenBalanceStore) Deduct(ctx context.Context, subID uuid.UUID, amount int64) error {
	if t.redis != nil {
		if err := t.ensureInitialized(ctx, subID); err != nil {
			slog.Warn("Redis 余额初始化失败，降级到 DB", "sub_id", subID, "error", err)
		} else {
			_, err := t.redis.DeductTokensAtomically(ctx, subID.String(), amount)
			if err == nil {
				balance, _ := t.redis.GetTokenBalance(ctx, subID.String())
				t.syncDelta(subID, balance)
				return nil
			}
			if errors.Is(err, redisclient.ErrTokenInsufficientBalance) {
				return model.ErrQuotaExceeded
			}
			slog.Warn("Redis DeductTokens 失败，降级到 DB", "sub_id", subID, "error", err)
		}
	}
	return t.subRepo.DeductTokens(subID, amount)
}

// Refund atomically refunds tokens.
func (t *TokenBalanceStore) Refund(ctx context.Context, subID uuid.UUID, amount int64) error {
	if t.redis != nil {
		if err := t.ensureInitialized(ctx, subID); err != nil {
			slog.Warn("Redis 余额初始化失败，降级到 DB", "sub_id", subID, "error", err)
		} else {
			_, err := t.redis.RefundTokensAtomically(ctx, subID.String(), amount)
			if err == nil {
				balance, _ := t.redis.GetTokenBalance(ctx, subID.String())
				t.syncDelta(subID, balance)
				return nil
			}
			slog.Warn("Redis RefundTokens 失败，降级到 DB", "sub_id", subID, "error", err)
		}
	}
	return t.subRepo.RefundTokens(subID, amount)
}

// DeductToZero deducts up to `amount`, capping at current balance.
// Returns the actual amount deducted.
func (t *TokenBalanceStore) DeductToZero(ctx context.Context, subID uuid.UUID, amount int64) (int64, error) {
	if t.redis != nil {
		if err := t.ensureInitialized(ctx, subID); err != nil {
			slog.Warn("Redis 余额初始化失败，降级到 DB", "sub_id", subID, "error", err)
		} else {
			actual, err := t.redis.DeductTokensToZeroAtomically(ctx, subID.String(), amount)
			if err == nil {
				balance, _ := t.redis.GetTokenBalance(ctx, subID.String())
				t.syncDelta(subID, balance)
				return actual, nil
			}
			slog.Warn("Redis DeductToZero 失败，降级到 DB", "sub_id", subID, "error", err)
		}
	}
	return t.subRepo.DeductTokensToZero(subID, amount)
}

// SyncFromDB 从 DB 同步余额到 Redis（服务启动时调用）。
// 用于将已有订阅的余额加载到 Redis。
func (t *TokenBalanceStore) SyncFromDB(ctx context.Context, subID uuid.UUID) error {
	if t.redis == nil {
		return nil
	}
	sub, err := t.subRepo.GetByID(subID)
	if err != nil {
		return err
	}
	if err := t.redis.SetTokenBalance(ctx, subID.String(), sub.TokenBalance); err != nil {
		return err
	}
	slog.Debug("订阅余额同步到 Redis", "sub_id", subID, "balance", sub.TokenBalance)
	return nil
}
