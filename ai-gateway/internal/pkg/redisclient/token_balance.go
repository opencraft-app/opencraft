package redisclient

import (
	"context"
	"errors"
	"fmt"

	"github.com/redis/go-redis/v9"
)

// ErrTokenInsufficientBalance 是 token 余额不足时的错误。
var ErrTokenInsufficientBalance = errors.New("insufficient token balance")

const tokenBalanceKeyPrefix = "token:balance:"
const tokenBalanceInitKeyPrefix = "token:balance:init:"

// tokenBalanceScript 是 token 余额操作的 Lua 脚本集合。
// 每个脚本都是原子的，不存在 TOCTOU 问题。

// deductScript: 原子检查并扣减余额。
// KEYS[1] = balance key
// ARGV[1] = 扣减数量
// 返回: {code, newBalance}
// code=0: 成功，newBalance 为扣减后余额
// code=-1: 余额不足，newBalance 为当前余额
var deductScript = redis.NewScript(`
	local key = KEYS[1]
	local amount = tonumber(ARGV[1])
	local balance = tonumber(redis.call("GET", key) or "0")
	if balance < amount then
		return {-1, balance}
	end
	local newBalance = balance - amount
	redis.call("SET", key, newBalance)
	return {0, newBalance}
`)

// refundScript: 原子退还余额。
// KEYS[1] = balance key
// ARGV[1] = 退还数量
// 返回: newBalance
var refundScript = redis.NewScript(`
	local key = KEYS[1]
	local amount = tonumber(ARGV[1])
	local balance = tonumber(redis.call("GET", key) or "0")
	local newBalance = balance + amount
	redis.call("SET", key, newBalance)
	return newBalance
`)

// deductToZeroScript: 原子扣减至零，最多扣减 amount。
// KEYS[1] = balance key
// ARGV[1] = 期望扣减数量
// 返回: actualDeducted（实际扣减量，0 <= actual <= amount）
var deductToZeroScript = redis.NewScript(`
	local key = KEYS[1]
	local amount = tonumber(ARGV[1])
	local balance = tonumber(redis.call("GET", key) or "0")
	local deduct = math.min(balance, amount)
	if deduct > 0 then
		redis.call("SET", key, balance - deduct)
	end
	return deduct
`)

// DeductTokensAtomically atomically deducts tokens from a subscription.
// Returns (newBalance, error).
// If balance < amount, returns (currentBalance, ErrQuotaExceeded).
func (c *Client) DeductTokensAtomically(ctx context.Context, subID string, amount int64) (int64, error) {
	key := tokenBalanceKeyPrefix + subID
	raw, err := deductScript.Run(ctx, c.rdb, []string{key}, amount).Slice()
	if err != nil {
		return 0, fmt.Errorf("redis deduct script: %w", err)
	}
	if len(raw) < 2 {
		return 0, fmt.Errorf("redis deduct script: unexpected result length %d", len(raw))
	}
	code, ok := raw[0].(int64)
	if !ok {
		return 0, fmt.Errorf("redis deduct script: result[0] type %T", raw[0])
	}
	balance, ok := raw[1].(int64)
	if !ok {
		return 0, fmt.Errorf("redis deduct script: result[1] type %T", raw[1])
	}
	if code == -1 {
		return balance, ErrTokenInsufficientBalance
	}
	return balance, nil
}

// RefundTokensAtomically atomically adds tokens back to a subscription.
// Returns (newBalance, error).
func (c *Client) RefundTokensAtomically(ctx context.Context, subID string, amount int64) (int64, error) {
	key := tokenBalanceKeyPrefix + subID
	newBalance, err := refundScript.Run(ctx, c.rdb, []string{key}, amount).Int64()
	if err != nil {
		return 0, fmt.Errorf("redis refund script: %w", err)
	}
	return newBalance, nil
}

// DeductTokensToZeroAtomically atomically deducts up to `amount`,
// capping the deduction at the current balance (balance will not go below 0).
// Returns the actual amount deducted.
func (c *Client) DeductTokensToZeroAtomically(ctx context.Context, subID string, amount int64) (int64, error) {
	key := tokenBalanceKeyPrefix + subID
	actual, err := deductToZeroScript.Run(ctx, c.rdb, []string{key}, amount).Int64()
	if err != nil {
		return 0, fmt.Errorf("redis deduct-to-zero script: %w", err)
	}
	return actual, nil
}

// SetTokenBalance sets the token balance for a subscription.
// Used for initial sync from DB or explicit balance reset.
func (c *Client) SetTokenBalance(ctx context.Context, subID string, balance int64) error {
	key := tokenBalanceKeyPrefix + subID
	initKey := tokenBalanceInitKeyPrefix + subID
	pipe := c.rdb.TxPipeline()
	pipe.Set(ctx, key, balance, 0)
	pipe.Set(ctx, initKey, 1, 0)
	_, err := pipe.Exec(ctx)
	return err
}

// GetTokenBalance gets the current token balance from Redis.
// Returns 0 if key does not exist.
func (c *Client) GetTokenBalance(ctx context.Context, subID string) (int64, error) {
	key := tokenBalanceKeyPrefix + subID
	val, err := c.rdb.Get(ctx, key).Int64()
	if err == redis.Nil {
		return 0, nil
	}
	return val, err
}

// DelTokenBalance deletes the token balance key.
func (c *Client) DelTokenBalance(ctx context.Context, subID string) error {
	key := tokenBalanceKeyPrefix + subID
	initKey := tokenBalanceInitKeyPrefix + subID
	return c.rdb.Del(ctx, key, initKey).Err()
}

// IsTokenBalanceInitialized reports whether this subscription balance has been
// loaded into Redis at least once.
func (c *Client) IsTokenBalanceInitialized(ctx context.Context, subID string) (bool, error) {
	initKey := tokenBalanceInitKeyPrefix + subID
	exists, err := c.rdb.Exists(ctx, initKey).Result()
	if err != nil {
		return false, err
	}
	return exists > 0, nil
}
