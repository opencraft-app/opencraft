// Package command 提供应用写命令共用的横切门禁。
package command

import (
	"context"
	"errors"
	"time"

	"chatserver/internal/apperror"
	ratelimitport "chatserver/internal/ports/ratelimit"
)

// ErrRateLimiterRequired 表示应用没有配置限流器。
var ErrRateLimiterRequired = errors.New("应用限流器不能为空")

// RateLimitGate 在新副作用前执行应用级限流。
type RateLimitGate struct {
	limiter ratelimitport.Limiter
}

// NewRateLimitGate 创建应用限流门禁。
func NewRateLimitGate(limiter ratelimitport.Limiter) (*RateLimitGate, error) {
	if limiter == nil {
		return nil, ErrRateLimiterRequired
	}
	return &RateLimitGate{limiter: limiter}, nil
}

// Check 检查应用限流。稳定幂等响应已命中时不重复消费额度。
func (gate *RateLimitGate) Check(
	ctx context.Context,
	request ratelimitport.Request,
	idempotencyHit bool,
) error {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if idempotencyHit {
		return nil
	}
	if gate == nil || gate.limiter == nil {
		return ErrRateLimiterRequired
	}

	decision, err := gate.limiter.Allow(ctx, request)
	if err != nil {
		return err
	}
	if decision.Allowed {
		return nil
	}
	return rateLimitError{
		err: apperror.New(
			"rate_limited",
			"请求过于频繁，请稍后重试",
			nil,
		),
		retryAfter: decision.RetryAfter,
	}
}

type rateLimitError struct {
	err        error
	retryAfter time.Duration
}

func (err rateLimitError) Error() string {
	return err.err.Error()
}

func (err rateLimitError) Unwrap() error {
	return err.err
}

func (err rateLimitError) RetryAfter() time.Duration {
	return err.retryAfter
}
