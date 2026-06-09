package wrapper

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"
)

var _ WorkspaceService = (*Store)(nil)
var _ RuntimeResourceLedger = (*Store)(nil)

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
	wispOwnsSMHSpace := 0
	if rec.WispOwnsSMHSpace {
		wispOwnsSMHSpace = 1
	}
	outerCleanupPending := 0
	if rec.OuterCleanupPending {
		outerCleanupPending = 1
	}
	cleanupRetryAfter := formatOptionalWorkspaceTime(rec.CleanupRetryAfter)
	deleteRetryAfter := formatOptionalWorkspaceTime(rec.DeleteRetryAfter)
	now := time.Now().UTC()
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.ExecContext(ctx, `
	INSERT INTO workspaces (
		workspace_id, backend, provider_workspace_id, state, fencing_token,
		owner_session_id, workspace_version, provider_region, wisp_name, wisp_smh_space_id,
		wisp_owns_smh_space, workspace_wisp_name, workspace_runtime_id,
		wisp_package_url, wisp_jfs_prefix, wisp_root_upper_size,
		cleanup_state, last_cleanup_error, cleanup_retry_after,
		delete_state, last_delete_error, delete_retry_after,
		outer_cleanup_pending, last_outer_cleanup_error,
		created_at, updated_at
	)
	VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	ON CONFLICT(workspace_id) DO UPDATE SET
		backend = excluded.backend,
		provider_workspace_id = excluded.provider_workspace_id,
		state = excluded.state,
		owner_session_id = excluded.owner_session_id,
		workspace_version = excluded.workspace_version,
		provider_region = excluded.provider_region,
		wisp_name = excluded.wisp_name,
		wisp_smh_space_id = excluded.wisp_smh_space_id,
		wisp_owns_smh_space = excluded.wisp_owns_smh_space,
		workspace_wisp_name = excluded.workspace_wisp_name,
		workspace_runtime_id = excluded.workspace_runtime_id,
		wisp_package_url = excluded.wisp_package_url,
		wisp_jfs_prefix = excluded.wisp_jfs_prefix,
		wisp_root_upper_size = excluded.wisp_root_upper_size,
		cleanup_state = excluded.cleanup_state,
		last_cleanup_error = excluded.last_cleanup_error,
		cleanup_retry_after = excluded.cleanup_retry_after,
		delete_state = excluded.delete_state,
		last_delete_error = excluded.last_delete_error,
		delete_retry_after = excluded.delete_retry_after,
		outer_cleanup_pending = excluded.outer_cleanup_pending,
		last_outer_cleanup_error = excluded.last_outer_cleanup_error,
		updated_at = excluded.updated_at,
		deleted_at = NULL`,
		rec.WorkspaceID, rec.Backend, rec.ProviderWorkspaceID, rec.State,
		rec.OwnerSessionID, rec.WorkspaceVersion, rec.ProviderRegion, rec.WispName, rec.WispSMHSpaceID,
		wispOwnsSMHSpace, rec.WorkspaceWispName, rec.WorkspaceRuntimeID,
		rec.WispPackageURL, rec.WispJFSPrefix, rec.WispRootUpperSize,
		rec.CleanupState, rec.LastCleanupError, cleanupRetryAfter,
		rec.DeleteState, rec.LastDeleteError, deleteRetryAfter,
		outerCleanupPending, rec.LastOuterCleanupError,
		now.Format(time.RFC3339Nano), now.Format(time.RFC3339Nano))
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

func (s *Store) RenewLease(ctx context.Context, lease WorkspaceLease, ttl time.Duration) (WorkspaceLease, error) {
	if s == nil {
		return WorkspaceLease{}, errors.New("store is nil")
	}
	if lease.WorkspaceID == "" || lease.RuntimeID == "" || lease.LeaseID == "" || lease.FencingToken == 0 {
		return WorkspaceLease{}, errors.New("workspace lease identity is incomplete")
	}
	if ttl <= 0 {
		ttl = defaultWorkspaceLeaseTTL
	}
	now := time.Now().UTC()
	expiresAt := now.Add(ttl)
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return WorkspaceLease{}, err
	}
	defer tx.Rollback()
	result, err := tx.ExecContext(ctx, `
	UPDATE workspace_leases
	SET expires_at = ?, heartbeat_at = ?, updated_at = ?
	WHERE workspace_id = ? AND lease_id = ? AND runtime_id = ? AND fencing_token = ? AND state = 'active'`,
		expiresAt.Format(time.RFC3339Nano), now.Format(time.RFC3339Nano), now.Format(time.RFC3339Nano),
		lease.WorkspaceID, lease.LeaseID, lease.RuntimeID, lease.FencingToken)
	if err != nil {
		return WorkspaceLease{}, err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return WorkspaceLease{}, err
	}
	if affected == 0 {
		return WorkspaceLease{}, WorkspaceLeaseHeldError{
			WorkspaceID: lease.WorkspaceID,
			RuntimeID:   lease.RuntimeID,
			LeaseID:     lease.LeaseID,
			ExpiresAt:   lease.ExpiresAt,
		}
	}
	if _, err := tx.ExecContext(ctx, `
	UPDATE workspace_runtimes
	SET updated_at = ?, lease_id = ?, fencing_token = ?, state = 'active'
	WHERE runtime_id = ?`,
		now.Format(time.RFC3339Nano), lease.LeaseID, lease.FencingToken, lease.RuntimeID); err != nil {
		return WorkspaceLease{}, err
	}
	if err := tx.Commit(); err != nil {
		return WorkspaceLease{}, err
	}
	lease.ExpiresAt = expiresAt
	lease.HeartbeatAt = now
	lease.UpdatedAt = now
	lease.State = "active"
	return lease, nil
}

func (s *Store) GetLease(ctx context.Context, workspaceID string) (WorkspaceLease, bool, error) {
	if s == nil {
		return WorkspaceLease{}, false, nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return loadWorkspaceLease(ctx, s.db, workspaceID)
}

func (s *Store) UpsertRuntimeResource(ctx context.Context, rec RuntimeResourceRecord) error {
	if s == nil {
		return nil
	}
	if rec.SessionID == "" {
		return errors.New("session id is required")
	}
	if rec.Generation <= 0 {
		return errors.New("generation is required")
	}
	if rec.State == "" {
		rec.State = "creating"
	}
	now := time.Now().UTC()
	createdAt := rec.CreatedAt
	if createdAt.IsZero() {
		createdAt = now
	}
	updatedAt := rec.UpdatedAt
	if updatedAt.IsZero() {
		updatedAt = now
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.ExecContext(ctx, `
INSERT INTO runtime_resources (
	session_id, generation, runtime_id, owner_id, sandbox_backend, state,
	outer_sandbox_id, inner_sandbox_id, last_error, expires_at, created_at, updated_at
)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(session_id, generation) DO UPDATE SET
	runtime_id = COALESCE(NULLIF(excluded.runtime_id, ''), runtime_resources.runtime_id),
	owner_id = COALESCE(NULLIF(excluded.owner_id, ''), runtime_resources.owner_id),
	sandbox_backend = COALESCE(NULLIF(excluded.sandbox_backend, ''), runtime_resources.sandbox_backend),
	state = excluded.state,
	outer_sandbox_id = COALESCE(NULLIF(excluded.outer_sandbox_id, ''), runtime_resources.outer_sandbox_id),
	inner_sandbox_id = COALESCE(NULLIF(excluded.inner_sandbox_id, ''), runtime_resources.inner_sandbox_id),
	last_error = excluded.last_error,
	expires_at = COALESCE(NULLIF(excluded.expires_at, ''), runtime_resources.expires_at),
	updated_at = excluded.updated_at`,
		rec.SessionID, rec.Generation, rec.RuntimeID, rec.OwnerID, rec.SandboxBackend, rec.State,
		rec.OuterSandboxID, rec.InnerSandboxID, rec.LastError, formatOptionalWorkspaceTime(rec.ExpiresAt),
		createdAt.Format(time.RFC3339Nano), updatedAt.Format(time.RFC3339Nano))
	return err
}

func (s *Store) MarkRuntimeResourceState(ctx context.Context, sessionID string, generation int64, state string, lastError string) error {
	if s == nil {
		return nil
	}
	if sessionID == "" {
		return errors.New("session id is required")
	}
	if generation <= 0 {
		return errors.New("generation is required")
	}
	if state == "" {
		return errors.New("state is required")
	}
	now := time.Now().UTC()
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.ExecContext(ctx, `
UPDATE runtime_resources
SET state = ?, last_error = ?, updated_at = ?
WHERE session_id = ? AND generation = ?`,
		state, lastError, now.Format(time.RFC3339Nano), sessionID, generation)
	return err
}

func (s *Store) LoadRuntimeResource(ctx context.Context, sessionID string, generation int64) (RuntimeResourceRecord, bool, error) {
	if s == nil || sessionID == "" || generation <= 0 {
		return RuntimeResourceRecord{}, false, nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return scanRuntimeResource(s.db.QueryRowContext(ctx, `
SELECT session_id, generation, runtime_id, owner_id, sandbox_backend, state,
       outer_sandbox_id, inner_sandbox_id, last_error, expires_at, created_at, updated_at
FROM runtime_resources
WHERE session_id = ? AND generation = ?`, sessionID, generation))
}

func (s *Store) ListStaleRuntimeResources(ctx context.Context, now time.Time, limit int) ([]RuntimeResourceRecord, error) {
	if s == nil {
		return nil, nil
	}
	if now.IsZero() {
		now = time.Now().UTC()
	}
	if limit <= 0 {
		limit = 100
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	rows, err := s.db.QueryContext(ctx, `
SELECT session_id, generation, runtime_id, owner_id, sandbox_backend, state,
       outer_sandbox_id, inner_sandbox_id, last_error, expires_at, created_at, updated_at
FROM runtime_resources
WHERE state IN ('creating', 'failed')
  AND expires_at IS NOT NULL
  AND expires_at <> ''
  AND expires_at <= ?
ORDER BY updated_at ASC
LIMIT ?`, now.UTC().Format(time.RFC3339Nano), limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var records []RuntimeResourceRecord
	for rows.Next() {
		rec, err := scanRuntimeResourceRows(rows)
		if err != nil {
			return nil, err
		}
		records = append(records, rec)
	}
	return records, rows.Err()
}

func (s *Store) LoadWorkspace(ctx context.Context, workspaceID string) (WorkspaceRecord, bool, error) {
	if s == nil {
		return WorkspaceRecord{}, false, nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return scanWorkspaceRecord(s.db.QueryRowContext(ctx, `
	SELECT workspace_id, backend, provider_workspace_id, state,
	       owner_session_id, workspace_version, provider_region, wisp_name, wisp_smh_space_id,
	       wisp_owns_smh_space, workspace_wisp_name, workspace_runtime_id,
	       wisp_package_url, wisp_jfs_prefix, wisp_root_upper_size,
	       cleanup_state, last_cleanup_error, cleanup_retry_after,
	       delete_state, last_delete_error, delete_retry_after,
	       outer_cleanup_pending, last_outer_cleanup_error
	FROM workspaces WHERE workspace_id = ?`, workspaceID))
}

func (s *Store) LoadWorkspaceForSession(ctx context.Context, sessionID string) (WorkspaceRecord, bool, error) {
	if s == nil || sessionID == "" {
		return WorkspaceRecord{}, false, nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return scanWorkspaceRecord(s.db.QueryRowContext(ctx, `
	SELECT workspace_id, backend, provider_workspace_id, state,
	       owner_session_id, workspace_version, provider_region, wisp_name, wisp_smh_space_id,
	       wisp_owns_smh_space, workspace_wisp_name, workspace_runtime_id,
	       wisp_package_url, wisp_jfs_prefix, wisp_root_upper_size,
	       cleanup_state, last_cleanup_error, cleanup_retry_after,
	       delete_state, last_delete_error, delete_retry_after,
	       outer_cleanup_pending, last_outer_cleanup_error
	FROM workspaces
	WHERE owner_session_id = ? AND deleted_at IS NULL
	ORDER BY updated_at DESC
	LIMIT 1`, sessionID))
}

func (s *Store) UpdateWorkspaceLifecycle(ctx context.Context, workspaceID, state, cleanupState, cleanupError, deleteState, deleteError string, outerCleanupPending bool) error {
	if s == nil {
		return nil
	}
	if workspaceID == "" {
		return errors.New("workspace id is required")
	}
	now := time.Now().UTC()
	outerPending := 0
	if outerCleanupPending {
		outerPending = 1
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.ExecContext(ctx, `
	UPDATE workspaces
	SET state = COALESCE(NULLIF(?, ''), state),
		cleanup_state = COALESCE(NULLIF(?, ''), cleanup_state),
		last_cleanup_error = ?,
		delete_state = COALESCE(NULLIF(?, ''), delete_state),
		last_delete_error = ?,
		outer_cleanup_pending = ?,
		updated_at = ?,
		deleted_at = CASE WHEN ? = 'deleted' THEN ? ELSE deleted_at END
	WHERE workspace_id = ?`,
		state, cleanupState, cleanupError, deleteState, deleteError, outerPending,
		now.Format(time.RFC3339Nano), state, now.Format(time.RFC3339Nano), workspaceID)
	return err
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

func formatOptionalWorkspaceTime(value time.Time) string {
	if value.IsZero() {
		return ""
	}
	return value.UTC().Format(time.RFC3339Nano)
}

func parseOptionalWorkspaceTime(label, value string) (time.Time, error) {
	if value == "" {
		return time.Time{}, nil
	}
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		return time.Time{}, fmt.Errorf("parse workspace %s: %w", label, err)
	}
	return parsed, nil
}

func scanWorkspaceRecord(row *sql.Row) (WorkspaceRecord, bool, error) {
	var rec WorkspaceRecord
	var wispOwns, outerPending int
	var cleanupRetryAfter, deleteRetryAfter string
	err := row.Scan(
		&rec.WorkspaceID, &rec.Backend, &rec.ProviderWorkspaceID, &rec.State,
		&rec.OwnerSessionID, &rec.WorkspaceVersion, &rec.ProviderRegion, &rec.WispName, &rec.WispSMHSpaceID,
		&wispOwns, &rec.WorkspaceWispName, &rec.WorkspaceRuntimeID,
		&rec.WispPackageURL, &rec.WispJFSPrefix, &rec.WispRootUpperSize,
		&rec.CleanupState, &rec.LastCleanupError, &cleanupRetryAfter,
		&rec.DeleteState, &rec.LastDeleteError, &deleteRetryAfter,
		&outerPending, &rec.LastOuterCleanupError,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return WorkspaceRecord{}, false, nil
	}
	if err != nil {
		return WorkspaceRecord{}, false, err
	}
	rec.WispOwnsSMHSpace = wispOwns != 0
	rec.OuterCleanupPending = outerPending != 0
	var parseErr error
	if rec.CleanupRetryAfter, parseErr = parseOptionalWorkspaceTime("cleanup_retry_after", cleanupRetryAfter); parseErr != nil {
		return WorkspaceRecord{}, false, parseErr
	}
	if rec.DeleteRetryAfter, parseErr = parseOptionalWorkspaceTime("delete_retry_after", deleteRetryAfter); parseErr != nil {
		return WorkspaceRecord{}, false, parseErr
	}
	return rec, true, nil
}

func scanRuntimeResource(row *sql.Row) (RuntimeResourceRecord, bool, error) {
	var rec RuntimeResourceRecord
	var expiresAt, createdAt, updatedAt string
	err := row.Scan(
		&rec.SessionID,
		&rec.Generation,
		&rec.RuntimeID,
		&rec.OwnerID,
		&rec.SandboxBackend,
		&rec.State,
		&rec.OuterSandboxID,
		&rec.InnerSandboxID,
		&rec.LastError,
		&expiresAt,
		&createdAt,
		&updatedAt,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return RuntimeResourceRecord{}, false, nil
	}
	if err != nil {
		return RuntimeResourceRecord{}, false, err
	}
	var parseErr error
	if rec.ExpiresAt, parseErr = parseOptionalWorkspaceTime("runtime resource expires_at", expiresAt); parseErr != nil {
		return RuntimeResourceRecord{}, false, parseErr
	}
	if rec.CreatedAt, parseErr = parseOptionalWorkspaceTime("runtime resource created_at", createdAt); parseErr != nil {
		return RuntimeResourceRecord{}, false, parseErr
	}
	if rec.UpdatedAt, parseErr = parseOptionalWorkspaceTime("runtime resource updated_at", updatedAt); parseErr != nil {
		return RuntimeResourceRecord{}, false, parseErr
	}
	return rec, true, nil
}

type runtimeResourceScanner interface {
	Scan(dest ...any) error
}

func scanRuntimeResourceRows(row runtimeResourceScanner) (RuntimeResourceRecord, error) {
	var rec RuntimeResourceRecord
	var expiresAt, createdAt, updatedAt string
	if err := row.Scan(
		&rec.SessionID,
		&rec.Generation,
		&rec.RuntimeID,
		&rec.OwnerID,
		&rec.SandboxBackend,
		&rec.State,
		&rec.OuterSandboxID,
		&rec.InnerSandboxID,
		&rec.LastError,
		&expiresAt,
		&createdAt,
		&updatedAt,
	); err != nil {
		return RuntimeResourceRecord{}, err
	}
	var parseErr error
	if rec.ExpiresAt, parseErr = parseOptionalWorkspaceTime("runtime resource expires_at", expiresAt); parseErr != nil {
		return RuntimeResourceRecord{}, parseErr
	}
	if rec.CreatedAt, parseErr = parseOptionalWorkspaceTime("runtime resource created_at", createdAt); parseErr != nil {
		return RuntimeResourceRecord{}, parseErr
	}
	if rec.UpdatedAt, parseErr = parseOptionalWorkspaceTime("runtime resource updated_at", updatedAt); parseErr != nil {
		return RuntimeResourceRecord{}, parseErr
	}
	return rec, nil
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
