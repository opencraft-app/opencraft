package command

import (
	"context"
	"errors"
	"testing"
	"time"

	"chatserver/internal/apperror"
	ratelimitport "chatserver/internal/ports/ratelimit"
)

type countingLimiter struct {
	calls    int
	decision ratelimitport.Decision
	err      error
}

func (l *countingLimiter) Allow(
	_ context.Context,
	_ ratelimitport.Request,
) (ratelimitport.Decision, error) {
	l.calls++
	return l.decision, l.err
}

func TestRateLimitGateSkipsChargeForIdempotencyHit(t *testing.T) {
	limiter := &countingLimiter{
		decision: ratelimitport.Decision{Allowed: false},
	}
	gate, err := NewRateLimitGate(limiter)
	if err != nil {
		t.Fatalf("NewRateLimitGate() error = %v", err)
	}

	if err := gate.Check(context.Background(), ratelimitport.Request{}, true); err != nil {
		t.Fatalf("Check(idempotency hit) error = %v", err)
	}
	if limiter.calls != 0 {
		t.Fatalf("limiter calls = %d, want 0", limiter.calls)
	}
}

func TestRateLimitGateReturnsStableErrorAndRetryAfter(t *testing.T) {
	limiter := &countingLimiter{
		decision: ratelimitport.Decision{
			Allowed:    false,
			RetryAfter: 7 * time.Second,
		},
	}
	gate, err := NewRateLimitGate(limiter)
	if err != nil {
		t.Fatalf("NewRateLimitGate() error = %v", err)
	}

	err = gate.Check(context.Background(), ratelimitport.Request{}, false)

	if got := apperror.CodeOf(err); got != "rate_limited" {
		t.Fatalf("Check() code = %q, want rate_limited", got)
	}
	var retryable interface {
		RetryAfter() time.Duration
	}
	if !errors.As(err, &retryable) {
		t.Fatal("rate limit error does not expose RetryAfter")
	}
	if got := retryable.RetryAfter(); got != 7*time.Second {
		t.Fatalf("RetryAfter() = %v, want 7s", got)
	}
}
