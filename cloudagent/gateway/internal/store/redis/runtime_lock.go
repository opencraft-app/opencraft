package redis

import (
	"context"
	"errors"
	"fmt"
	"time"

	goredis "github.com/redis/go-redis/v9"
)

// RuntimeEnsureLease represents a held ensure-ready lock.
type RuntimeEnsureLease struct {
	store    *LockStore
	key      string
	holderID string
}

// Release drops the ensure-ready lock.
func (l *RuntimeEnsureLease) Release(ctx context.Context) error {
	result, err := l.store.client.Eval(ctx, releaseRuntimeLockScript, []string{l.key}, l.holderID).Text()
	if err != nil && !errors.Is(err, goredis.Nil) {
		return fmt.Errorf("redis release runtime lock: %w", err)
	}
	_ = result
	return nil
}

// AcquireRuntimeEnsureLock implements RuntimeEnsureLocker.
// It attempts to acquire a distributed mutex for ensure-ready operations.
// If the lock is already held, it retries with backoff until ctx is cancelled.
func (s *LockStore) AcquireRuntimeEnsureLock(ctx context.Context, lockKey string, ttl time.Duration) (*RuntimeEnsureLease, error) {
	if lockKey == "" {
		return nil, errors.New("lock key is required")
	}
	if ttl <= 0 {
		ttl = 30 * time.Second
	}
	holderID := randomID()
	key := s.keyspace.runtimeEnsureLock(lockKey)

	// Retry loop with backoff
	backoff := 50 * time.Millisecond
	maxBackoff := 2 * time.Second
	for {
		result, err := s.client.Eval(ctx, acquireRuntimeLockScript, []string{key},
			holderID,
			formatInt64(ttlMs(ttl)),
		).Text()
		if err != nil && !errors.Is(err, goredis.Nil) {
			return nil, fmt.Errorf("redis acquire runtime lock: %w", err)
		}
		if result == "OK" {
			return &RuntimeEnsureLease{store: s, key: key, holderID: holderID}, nil
		}

		// Lock is held, wait and retry
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(backoff):
			backoff = backoff * 2
			if backoff > maxBackoff {
				backoff = maxBackoff
			}
		}
	}
}
