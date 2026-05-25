package wrapper

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"
)

var _ WorkspaceService = (*Store)(nil)

func (s *Store) EnsureWorkspace(ctx context.Context, rec WorkspaceRecord) error {
	if s == nil {
		return nil
	}
	if rec.WorkspaceID == "" {
		return errors.New("workspace id is required")
	}
	if rec.Backend == "" {
		rec.Backend = "smh"
	}
	if rec.ProviderWorkspaceID == "" {
		rec.ProviderWorkspaceID = rec.WorkspaceID
	}
	if rec.State == "" {
		rec.State = "active"
	}
	now := time.Now().UTC()
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.ExecContext(ctx, `
INSERT INTO workspaces (workspace_id, backend, provider_workspace_id, state, fencing_token, created_at, updated_at)
VALUES (?, ?, ?, ?, 0, ?, ?)
ON CONFLICT(workspace_id) DO UPDATE SET
	backend = excluded.backend,
	provider_workspace_id = excluded.provider_workspace_id,
	state = excluded.state,
	updated_at = excluded.updated_at,
	deleted_at = NULL`,
		rec.WorkspaceID, rec.Backend, rec.ProviderWorkspaceID, rec.State, now.Format(time.RFC3339Nano), now.Format(time.RFC3339Nano))
	return err
}

func (s *Store) AcquireLease(ctx context.Context, req WorkspaceLeaseRequest) (WorkspaceLease, error) {
	if s == nil {
		return WorkspaceLease{}, errors.New("store is nil")
	}
	if req.WorkspaceID == "" {
		return WorkspaceLease{}, errors.New("workspace id is required")
	}
	if req.RuntimeID == "" {
		return WorkspaceLease{}, errors.New("runtime id is required")
	}
	if req.Provider == "" {
		req.Provider = "ags"
	}
	if req.TTL <= 0 {
		req.TTL = defaultWorkspaceLeaseTTL
	}
	now := time.Now().UTC()
	expiresAt := now.Add(req.TTL)

	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return WorkspaceLease{}, err
	}
	defer tx.Rollback()
	if err := ensureWorkspaceExistsTx(ctx, tx, req.WorkspaceID, now); err != nil {
		return WorkspaceLease{}, err
	}
	current, ok, err := loadWorkspaceLeaseTx(ctx, tx, req.WorkspaceID)
	if err != nil {
		return WorkspaceLease{}, err
	}
	if ok && current.State == "active" && current.ExpiresAt.After(now) {
		return WorkspaceLease{}, WorkspaceLeaseHeldError{
			WorkspaceID: req.WorkspaceID,
			RuntimeID:   current.RuntimeID,
			LeaseID:     current.LeaseID,
			ExpiresAt:   current.ExpiresAt,
		}
	}
	if ok && current.State == "active" && !current.ExpiresAt.After(now) {
		if _, err := tx.ExecContext(ctx, `UPDATE workspace_leases SET state = 'expired', updated_at = ? WHERE workspace_id = ?`,
			now.Format(time.RFC3339Nano), req.WorkspaceID); err != nil {
			return WorkspaceLease{}, err
		}
	}
	if _, err := tx.ExecContext(ctx, `UPDATE workspaces SET fencing_token = fencing_token + 1, updated_at = ? WHERE workspace_id = ?`,
		now.Format(time.RFC3339Nano), req.WorkspaceID); err != nil {
		return WorkspaceLease{}, err
	}
	var token int64
	if err := tx.QueryRowContext(ctx, `SELECT fencing_token FROM workspaces WHERE workspace_id = ?`, req.WorkspaceID).Scan(&token); err != nil {
		return WorkspaceLease{}, err
	}
	lease := WorkspaceLease{
		WorkspaceID:  req.WorkspaceID,
		RuntimeID:    req.RuntimeID,
		LeaseID:      "lease_" + randomHex(12),
		FencingToken: token,
		State:        "active",
		ExpiresAt:    expiresAt,
		HeartbeatAt:  now,
		CreatedAt:    now,
		UpdatedAt:    now,
	}
	if _, err := tx.ExecContext(ctx, `
INSERT INTO workspace_runtimes (runtime_id, workspace_id, provider, state, lease_id, fencing_token, created_at, updated_at)
VALUES (?, ?, ?, 'active', ?, ?, ?, ?)
ON CONFLICT(runtime_id) DO UPDATE SET
	workspace_id = excluded.workspace_id,
	provider = excluded.provider,
	state = 'active',
	lease_id = excluded.lease_id,
	fencing_token = excluded.fencing_token,
	updated_at = excluded.updated_at,
	released_at = NULL`,
		req.RuntimeID, req.WorkspaceID, req.Provider, lease.LeaseID, lease.FencingToken, now.Format(time.RFC3339Nano), now.Format(time.RFC3339Nano)); err != nil {
		return WorkspaceLease{}, err
	}
	if _, err := tx.ExecContext(ctx, `
INSERT INTO workspace_leases (workspace_id, lease_id, runtime_id, fencing_token, state, expires_at, heartbeat_at, created_at, updated_at)
VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?)
ON CONFLICT(workspace_id) DO UPDATE SET
	lease_id = excluded.lease_id,
	runtime_id = excluded.runtime_id,
	fencing_token = excluded.fencing_token,
	state = 'active',
	expires_at = excluded.expires_at,
	heartbeat_at = excluded.heartbeat_at,
	created_at = excluded.created_at,
	updated_at = excluded.updated_at`,
		lease.WorkspaceID, lease.LeaseID, lease.RuntimeID, lease.FencingToken,
		lease.ExpiresAt.Format(time.RFC3339Nano), lease.HeartbeatAt.Format(time.RFC3339Nano), lease.CreatedAt.Format(time.RFC3339Nano), lease.UpdatedAt.Format(time.RFC3339Nano)); err != nil {
		return WorkspaceLease{}, err
	}
	if err := tx.Commit(); err != nil {
		return WorkspaceLease{}, err
	}
	return lease, nil
}

func (s *Store) ReleaseLease(ctx context.Context, lease WorkspaceLease) error {
	if s == nil || lease.LeaseID == "" {
		return nil
	}
	now := time.Now().UTC()
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, `
UPDATE workspace_leases
SET state = 'released', expires_at = ?, updated_at = ?
WHERE workspace_id = ? AND lease_id = ? AND runtime_id = ? AND fencing_token = ?`,
		now.Format(time.RFC3339Nano), now.Format(time.RFC3339Nano),
		lease.WorkspaceID, lease.LeaseID, lease.RuntimeID, lease.FencingToken); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `
UPDATE workspace_runtimes
SET state = 'released', released_at = ?, updated_at = ?
WHERE runtime_id = ?`,
		now.Format(time.RFC3339Nano), now.Format(time.RFC3339Nano), lease.RuntimeID); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) GetLease(ctx context.Context, workspaceID string) (WorkspaceLease, bool, error) {
	if s == nil {
		return WorkspaceLease{}, false, nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return loadWorkspaceLease(ctx, s.db, workspaceID)
}

func ensureWorkspaceExistsTx(ctx context.Context, tx *sql.Tx, workspaceID string, now time.Time) error {
	_, err := tx.ExecContext(ctx, `
INSERT INTO workspaces (workspace_id, backend, provider_workspace_id, state, fencing_token, created_at, updated_at)
VALUES (?, 'workspace', ?, 'active', 0, ?, ?)
ON CONFLICT(workspace_id) DO UPDATE SET
	updated_at = excluded.updated_at,
	deleted_at = NULL`,
		workspaceID, workspaceID, now.Format(time.RFC3339Nano), now.Format(time.RFC3339Nano))
	return err
}

func loadWorkspaceLease(ctx context.Context, db *sql.DB, workspaceID string) (WorkspaceLease, bool, error) {
	return scanWorkspaceLease(db.QueryRowContext(ctx, `
SELECT workspace_id, lease_id, runtime_id, fencing_token, state, expires_at, heartbeat_at, created_at, updated_at
FROM workspace_leases WHERE workspace_id = ?`, workspaceID))
}

func loadWorkspaceLeaseTx(ctx context.Context, tx *sql.Tx, workspaceID string) (WorkspaceLease, bool, error) {
	return scanWorkspaceLease(tx.QueryRowContext(ctx, `
SELECT workspace_id, lease_id, runtime_id, fencing_token, state, expires_at, heartbeat_at, created_at, updated_at
FROM workspace_leases WHERE workspace_id = ?`, workspaceID))
}

func scanWorkspaceLease(row *sql.Row) (WorkspaceLease, bool, error) {
	var lease WorkspaceLease
	var expiresAt, heartbeatAt, createdAt, updatedAt string
	err := row.Scan(&lease.WorkspaceID, &lease.LeaseID, &lease.RuntimeID, &lease.FencingToken, &lease.State, &expiresAt, &heartbeatAt, &createdAt, &updatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return WorkspaceLease{}, false, nil
	}
	if err != nil {
		return WorkspaceLease{}, false, err
	}
	for label, value := range map[string]string{
		"expires_at":   expiresAt,
		"heartbeat_at": heartbeatAt,
		"created_at":   createdAt,
		"updated_at":   updatedAt,
	} {
		parsed, err := time.Parse(time.RFC3339Nano, value)
		if err != nil {
			return WorkspaceLease{}, false, fmt.Errorf("parse workspace lease %s: %w", label, err)
		}
		switch label {
		case "expires_at":
			lease.ExpiresAt = parsed
		case "heartbeat_at":
			lease.HeartbeatAt = parsed
		case "created_at":
			lease.CreatedAt = parsed
		case "updated_at":
			lease.UpdatedAt = parsed
		}
	}
	return lease, true, nil
}
