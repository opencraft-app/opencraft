package wrapper

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

var _ RuntimeEnsureLocker = (*Store)(nil)

type sqliteRuntimeEnsureLease struct {
	store    *Store
	key      string
	holderID string
}

func (s *Store) AcquireRuntimeEnsureLock(ctx context.Context, key string, ttl time.Duration) (RuntimeEnsureLease, error) {
	if s == nil {
		return nil, errors.New("store is nil")
	}
	if key == "" {
		return nil, errors.New("runtime ensure lock key is required")
	}
	if ttl <= 0 {
		ttl = defaultRuntimeEnsureLockTTL
	}
	holderID := "runtime_lock_" + randomHex(12)
	for {
		acquired, err := s.tryAcquireRuntimeEnsureLock(ctx, key, holderID, ttl)
		if err != nil {
			return nil, err
		}
		if acquired {
			return sqliteRuntimeEnsureLease{store: s, key: key, holderID: holderID}, nil
		}
		timer := time.NewTimer(100 * time.Millisecond)
		select {
		case <-ctx.Done():
			timer.Stop()
			return nil, ctx.Err()
		case <-timer.C:
		}
	}
}

func (s *Store) tryAcquireRuntimeEnsureLock(ctx context.Context, key, holderID string, ttl time.Duration) (bool, error) {
	now := time.Now().UTC()
	expiresAt := now.Add(ttl)
	nowText := now.Format(time.RFC3339Nano)
	expiresText := expiresAt.Format(time.RFC3339Nano)

	s.mu.Lock()
	defer s.mu.Unlock()
	result, err := s.db.ExecContext(ctx, `
INSERT INTO runtime_locks (lock_key, holder_id, expires_at, acquired_at, updated_at)
VALUES (?, ?, ?, ?, ?)
ON CONFLICT(lock_key) DO UPDATE SET
	holder_id = excluded.holder_id,
	expires_at = excluded.expires_at,
	acquired_at = excluded.acquired_at,
	updated_at = excluded.updated_at
WHERE runtime_locks.expires_at <= ? OR runtime_locks.holder_id = ?`,
		key, holderID, expiresText, nowText, nowText, nowText, holderID)
	if err != nil {
		return false, err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return false, err
	}
	return affected > 0, nil
}

func (l sqliteRuntimeEnsureLease) Release(ctx context.Context) error {
	if l.store == nil || l.key == "" || l.holderID == "" {
		return nil
	}
	l.store.mu.Lock()
	defer l.store.mu.Unlock()
	_, err := l.store.db.ExecContext(ctx, `DELETE FROM runtime_locks WHERE lock_key = ? AND holder_id = ?`, l.key, l.holderID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	return err
}
