package wrapper

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"
)

var _ RuntimeOwnershipStore = (*Store)(nil)

func (s *Store) AcquireRuntimeOwnership(ctx context.Context, req RuntimeOwnershipRequest) (RuntimeOwnershipLease, error) {
	if s == nil {
		return RuntimeOwnershipLease{}, errors.New("store is nil")
	}
	if req.SessionID == "" {
		return RuntimeOwnershipLease{}, errors.New("runtime ownership session id is required")
	}
	if req.Generation <= 0 {
		return RuntimeOwnershipLease{}, errors.New("runtime ownership generation is required")
	}
	if req.RunID == "" {
		return RuntimeOwnershipLease{}, errors.New("runtime ownership run id is required")
	}
	if req.OwnerID == "" {
		return RuntimeOwnershipLease{}, errors.New("runtime ownership owner id is required")
	}
	if req.Operation == "" {
		req.Operation = "run"
	}
	ttl := normalizeRuntimeOwnershipTTL(req.TTL)
	now := time.Now().UTC()
	expiresAt := now.Add(ttl)
	nowText := now.Format(time.RFC3339Nano)
	expiresText := expiresAt.Format(time.RFC3339Nano)

	allowSameOwner := 0
	if req.AllowSameOwner {
		allowSameOwner = 1
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	result, err := s.db.ExecContext(ctx, `
INSERT INTO runtime_ownerships (
	session_id, generation, run_id, owner_id, operation, fencing_token, state,
	expires_at, heartbeat_at, created_at, updated_at
)
VALUES (?, ?, ?, ?, ?, 1, 'active', ?, ?, ?, ?)
ON CONFLICT(session_id) DO UPDATE SET
	generation = excluded.generation,
	run_id = excluded.run_id,
	owner_id = excluded.owner_id,
	operation = excluded.operation,
	fencing_token = runtime_ownerships.fencing_token + 1,
	state = 'active',
	expires_at = excluded.expires_at,
	heartbeat_at = excluded.heartbeat_at,
	updated_at = excluded.updated_at
WHERE runtime_ownerships.state <> 'active'
	OR runtime_ownerships.expires_at <= ?
	OR (runtime_ownerships.owner_id = ? AND ? = 1)`,
		req.SessionID, req.Generation, req.RunID, req.OwnerID, req.Operation,
		expiresText, nowText, nowText, nowText, nowText, req.OwnerID, allowSameOwner)
	if err != nil {
		return RuntimeOwnershipLease{}, err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return RuntimeOwnershipLease{}, err
	}
	if affected == 0 {
		held, ok, loadErr := s.loadRuntimeOwnershipLocked(ctx, req.SessionID)
		if loadErr != nil {
			return RuntimeOwnershipLease{}, loadErr
		}
		if !ok {
			return RuntimeOwnershipLease{}, ErrRuntimeOwnershipHeld
		}
		return RuntimeOwnershipLease{}, RuntimeOwnershipHeldError{
			SessionID:  held.SessionID,
			Generation: held.Generation,
			RunID:      held.RunID,
			OwnerID:    held.OwnerID,
			Operation:  held.Operation,
			ExpiresAt:  held.ExpiresAt,
		}
	}
	lease, ok, err := s.loadRuntimeOwnershipLocked(ctx, req.SessionID)
	if err != nil {
		return RuntimeOwnershipLease{}, err
	}
	if !ok {
		return RuntimeOwnershipLease{}, fmt.Errorf("runtime ownership %s was not stored", req.SessionID)
	}
	return lease, nil
}

func (s *Store) RenewRuntimeOwnership(ctx context.Context, lease RuntimeOwnershipLease, ttl time.Duration) error {
	if s == nil || lease.SessionID == "" {
		return nil
	}
	ttl = normalizeRuntimeOwnershipTTL(ttl)
	now := time.Now().UTC()
	expiresAt := now.Add(ttl)
	s.mu.Lock()
	defer s.mu.Unlock()
	result, err := s.db.ExecContext(ctx, `
UPDATE runtime_ownerships
SET expires_at = ?, heartbeat_at = ?, updated_at = ?
WHERE session_id = ? AND generation = ? AND run_id = ? AND owner_id = ? AND fencing_token = ? AND state = 'active'`,
		expiresAt.Format(time.RFC3339Nano), now.Format(time.RFC3339Nano), now.Format(time.RFC3339Nano),
		lease.SessionID, lease.Generation, lease.RunID, lease.OwnerID, lease.FencingToken)
	if err != nil {
		return err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if affected == 0 {
		return RuntimeOwnershipHeldError{SessionID: lease.SessionID, Generation: lease.Generation, RunID: lease.RunID, OwnerID: lease.OwnerID, Operation: lease.Operation}
	}
	return nil
}

func (s *Store) ReleaseRuntimeOwnership(ctx context.Context, lease RuntimeOwnershipLease) error {
	if s == nil || lease.SessionID == "" {
		return nil
	}
	now := time.Now().UTC()
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.ExecContext(ctx, `
UPDATE runtime_ownerships
SET state = 'released', updated_at = ?
WHERE session_id = ? AND generation = ? AND run_id = ? AND owner_id = ? AND fencing_token = ?`,
		now.Format(time.RFC3339Nano), lease.SessionID, lease.Generation, lease.RunID, lease.OwnerID, lease.FencingToken)
	return err
}

func (s *Store) RuntimeOwnershipHeld(ctx context.Context, lease RuntimeOwnershipLease) (bool, error) {
	if s == nil || lease.SessionID == "" {
		return true, nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	var expiresAt string
	err := s.db.QueryRowContext(ctx, `
SELECT expires_at
FROM runtime_ownerships
WHERE session_id = ? AND generation = ? AND run_id = ? AND owner_id = ? AND fencing_token = ? AND state = 'active'`,
		lease.SessionID, lease.Generation, lease.RunID, lease.OwnerID, lease.FencingToken).Scan(&expiresAt)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	parsed, err := time.Parse(time.RFC3339Nano, expiresAt)
	if err != nil {
		return false, fmt.Errorf("parse runtime ownership expires_at: %w", err)
	}
	return parsed.After(time.Now().UTC()), nil
}

func (s *Store) loadRuntimeOwnershipLocked(ctx context.Context, sessionID string) (RuntimeOwnershipLease, bool, error) {
	var lease RuntimeOwnershipLease
	var expiresAt string
	err := s.db.QueryRowContext(ctx, `
SELECT session_id, generation, run_id, owner_id, operation, fencing_token, expires_at
FROM runtime_ownerships
WHERE session_id = ?`, sessionID).Scan(
		&lease.SessionID,
		&lease.Generation,
		&lease.RunID,
		&lease.OwnerID,
		&lease.Operation,
		&lease.FencingToken,
		&expiresAt,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return RuntimeOwnershipLease{}, false, nil
	}
	if err != nil {
		return RuntimeOwnershipLease{}, false, err
	}
	parsed, err := time.Parse(time.RFC3339Nano, expiresAt)
	if err != nil {
		return RuntimeOwnershipLease{}, false, fmt.Errorf("parse runtime ownership expires_at: %w", err)
	}
	lease.ExpiresAt = parsed
	return lease, true, nil
}
