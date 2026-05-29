package wrapper

import (
	"context"
	"errors"
	"time"
)

const defaultRuntimeEnsureLockTTL = 5 * time.Minute

type RuntimeEnsureLocker interface {
	AcquireRuntimeEnsureLock(ctx context.Context, key string, ttl time.Duration) (RuntimeEnsureLease, error)
}

type RuntimeEnsureLease interface {
	Release(ctx context.Context) error
}

type noopRuntimeEnsureLease struct{}

func (noopRuntimeEnsureLease) Release(context.Context) error {
	return nil
}

func acquireRuntimeEnsureLease(ctx context.Context, locker RuntimeEnsureLocker, key string, ttl time.Duration) (RuntimeEnsureLease, error) {
	if locker == nil {
		return noopRuntimeEnsureLease{}, nil
	}
	if key == "" {
		return nil, errors.New("runtime ensure lock key is required")
	}
	if ttl <= 0 {
		ttl = defaultRuntimeEnsureLockTTL
	}
	return locker.AcquireRuntimeEnsureLock(ctx, key, ttl)
}
