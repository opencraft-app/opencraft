package gateway

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"
)

type nullableTimeTarget struct{ dest *time.Time }

func (target nullableTimeTarget) Scan(value any) error {
	var nullable sql.NullTime
	if err := nullable.Scan(value); err != nil {
		return err
	}
	if nullable.Valid {
		*target.dest = nullable.Time
	} else {
		*target.dest = time.Time{}
	}
	return nil
}

func nullableTimeScanner(dest *time.Time) sql.Scanner { return nullableTimeTarget{dest: dest} }

func (s *MySQLStore) CreateTenantDeletionJob(ctx context.Context, job TenantDeletionJob, targets []TenantDeletionTarget) error {
	userIDsJSON, err := json.Marshal(job.UserIDs)
	if err != nil {
		return err
	}
	now := time.Now().UTC()
	if job.CreatedAt.IsZero() {
		job.CreatedAt = now
	}
	if job.SnapshotAt.IsZero() {
		job.SnapshotAt = now
	}
	job.UpdatedAt = now
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO llmgateway_tenant_deletion_jobs (
			id, status, selector_type, selector_value, selector_user_ids_json, snapshot_at,
			materialization_cursor, target_count, target_digest, claimed_count, success_count,
			failure_count, last_error, version, idempotency_key, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`, job.ID, job.Status, job.SelectorType, job.SelectorValue, userIDsJSON, job.SnapshotAt,
		job.MaterializationCursor, job.TargetCount, job.TargetDigest, job.ClaimedCount, job.SuccessCount,
		job.FailureCount, job.LastError, job.Version, job.IdempotencyKey, job.CreatedAt, job.UpdatedAt); err != nil {
		return err
	}
	for _, target := range targets {
		if target.Status == "" {
			target.Status = TenantDeletionTargetStatusPending
		}
		if target.CreatedAt.IsZero() {
			target.CreatedAt = now
		}
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO llmgateway_tenant_deletion_targets (
				job_id, external_user_id, set_id, status, attempts, lease_owner, lease_until,
				last_error, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`, job.ID, target.ExternalUserID, target.SetID, target.Status, target.Attempts,
			target.LeaseOwner, nullableTime(target.LeaseUntil), target.LastError, target.CreatedAt, now); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (s *MySQLStore) MaterializeTenantDeletionJob(ctx context.Context, jobID string, batchSize int, now time.Time) (TenantDeletionJob, error) {
	if batchSize <= 0 {
		return TenantDeletionJob{}, fmt.Errorf("batch size must be positive")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return TenantDeletionJob{}, err
	}
	defer tx.Rollback()
	job, ok, err := getTenantDeletionJobSQL(ctx, tx, jobID, true)
	if err != nil {
		return TenantDeletionJob{}, err
	}
	if !ok {
		return TenantDeletionJob{}, fmt.Errorf("tenant deletion job %q not found", jobID)
	}
	if job.Status != TenantDeletionStatusMaterializing {
		if err := tx.Commit(); err != nil {
			return TenantDeletionJob{}, err
		}
		return job, nil
	}
	tenantQuery, args, err := tenantDeletionCandidateQuery(job, batchSize+1)
	if err != nil {
		return TenantDeletionJob{}, err
	}
	rows, err := tx.QueryContext(ctx, tenantQuery, args...)
	if err != nil {
		return TenantDeletionJob{}, err
	}
	type candidate struct{ id, setID string }
	candidates := make([]candidate, 0, batchSize+1)
	for rows.Next() {
		var item candidate
		if err := rows.Scan(&item.id, &item.setID); err != nil {
			rows.Close()
			return TenantDeletionJob{}, err
		}
		candidates = append(candidates, item)
	}
	if err := rows.Close(); err != nil {
		return TenantDeletionJob{}, err
	}
	more := len(candidates) > batchSize
	if more {
		candidates = candidates[:batchSize]
	}
	for _, item := range candidates {
		if _, err := tx.ExecContext(ctx, `
			INSERT IGNORE INTO llmgateway_tenant_deletion_targets (
				job_id, external_user_id, set_id, status, attempts, lease_owner, lease_until,
				last_error, created_at, updated_at
			) VALUES (?, ?, ?, 'pending', 0, '', NULL, '', ?, ?)
		`, job.ID, item.id, item.setID, now, now); err != nil {
			return TenantDeletionJob{}, err
		}
		job.MaterializationCursor = item.id
	}
	if !more {
		targets, err := listTenantDeletionTargetsSQL(ctx, tx, job.ID, TenantDeletionTargetListOptions{})
		if err != nil {
			return TenantDeletionJob{}, err
		}
		job.TargetCount = len(targets)
		job.TargetDigest = tenantDeletionTargetDigest(targets)
		job.Status = TenantDeletionStatusPreviewed
	}
	job.Version++
	job.UpdatedAt = now
	if _, err := tx.ExecContext(ctx, `
		UPDATE llmgateway_tenant_deletion_jobs
		SET status = ?, materialization_cursor = ?, target_count = ?, target_digest = ?,
			version = ?, updated_at = ?
		WHERE id = ?
	`, job.Status, job.MaterializationCursor, job.TargetCount, job.TargetDigest,
		job.Version, job.UpdatedAt, job.ID); err != nil {
		return TenantDeletionJob{}, err
	}
	if err := tx.Commit(); err != nil {
		return TenantDeletionJob{}, err
	}
	return job, nil
}

func (s *MySQLStore) StartTenantDeletionJob(ctx context.Context, jobID string, input TenantDeletionStartInput, now time.Time) (TenantDeletionJob, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return TenantDeletionJob{}, err
	}
	defer tx.Rollback()
	job, ok, err := getTenantDeletionJobSQL(ctx, tx, jobID, true)
	if err != nil {
		return TenantDeletionJob{}, err
	}
	if !ok {
		return TenantDeletionJob{}, fmt.Errorf("tenant deletion job %q not found", jobID)
	}
	if job.IdempotencyKey != "" {
		if job.IdempotencyKey == input.IdempotencyKey && job.TargetCount == input.ExpectedTargetCount && job.TargetDigest == input.ExpectedTargetDigest {
			if err := tx.Commit(); err != nil {
				return TenantDeletionJob{}, err
			}
			return job, nil
		}
		return TenantDeletionJob{}, fmt.Errorf("tenant deletion job already started with another request")
	}
	var existingID string
	err = tx.QueryRowContext(ctx, `
		SELECT id FROM llmgateway_tenant_deletion_jobs
		WHERE idempotency_key = ? AND id <> ? LIMIT 1 FOR UPDATE
	`, input.IdempotencyKey, jobID).Scan(&existingID)
	if err == nil {
		return TenantDeletionJob{}, fmt.Errorf("idempotency key already used by tenant deletion job %q", existingID)
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return TenantDeletionJob{}, err
	}
	if job.Status != TenantDeletionStatusPreviewed {
		return TenantDeletionJob{}, fmt.Errorf("tenant deletion job %q is not previewed", jobID)
	}
	if job.TargetCount != input.ExpectedTargetCount || job.TargetDigest != input.ExpectedTargetDigest {
		return TenantDeletionJob{}, fmt.Errorf("tenant deletion preview changed")
	}
	job.Status = TenantDeletionStatusClaiming
	job.IdempotencyKey = input.IdempotencyKey
	job.Version++
	job.UpdatedAt = now
	if _, err := tx.ExecContext(ctx, `
		UPDATE llmgateway_tenant_deletion_jobs
		SET status = ?, idempotency_key = ?, version = ?, updated_at = ?
		WHERE id = ?
	`, job.Status, job.IdempotencyKey, job.Version, job.UpdatedAt, job.ID); err != nil {
		return TenantDeletionJob{}, err
	}
	if err := tx.Commit(); err != nil {
		return TenantDeletionJob{}, err
	}
	return job, nil
}

func (s *MySQLStore) ClaimTenantDeletionJob(ctx context.Context, jobID string, batchSize int, now time.Time) (TenantDeletionJob, error) {
	var result TenantDeletionJob
	err := retryMySQLTransientLock(ctx, func() error {
		job, err := s.claimTenantDeletionJobOnce(ctx, jobID, batchSize, now)
		if err == nil {
			result = job
		}
		return err
	})
	return result, err
}

func (s *MySQLStore) claimTenantDeletionJobOnce(ctx context.Context, jobID string, batchSize int, now time.Time) (TenantDeletionJob, error) {
	if batchSize <= 0 {
		return TenantDeletionJob{}, fmt.Errorf("batch size must be positive")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return TenantDeletionJob{}, err
	}
	defer tx.Rollback()
	job, ok, err := getTenantDeletionJobSQL(ctx, tx, jobID, true)
	if err != nil {
		return TenantDeletionJob{}, err
	}
	if !ok {
		return TenantDeletionJob{}, fmt.Errorf("tenant deletion job %q not found", jobID)
	}
	if job.Status != TenantDeletionStatusClaiming {
		if err := tx.Commit(); err != nil {
			return TenantDeletionJob{}, err
		}
		return job, nil
	}
	rows, err := tx.QueryContext(ctx, `
		SELECT targets.external_user_id, COALESCE(claims.job_id, '')
		FROM llmgateway_tenant_deletion_targets targets
		LEFT JOIN llmgateway_tenant_deletion_claims claims
			ON claims.external_user_id = targets.external_user_id
		WHERE targets.job_id = ? AND (claims.job_id IS NULL OR claims.job_id <> ?)
		ORDER BY targets.external_user_id LIMIT ?
	`, jobID, jobID, batchSize)
	if err != nil {
		return TenantDeletionJob{}, err
	}
	type claimCandidate struct{ userID, claimedBy string }
	candidates := make([]claimCandidate, 0, batchSize)
	for rows.Next() {
		var item claimCandidate
		if err := rows.Scan(&item.userID, &item.claimedBy); err != nil {
			rows.Close()
			return TenantDeletionJob{}, err
		}
		candidates = append(candidates, item)
	}
	if err := rows.Close(); err != nil {
		return TenantDeletionJob{}, err
	}
	for _, item := range candidates {
		if item.claimedBy == "" {
			continue
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM llmgateway_tenant_deletion_claims WHERE job_id = ?`, jobID); err != nil {
			return TenantDeletionJob{}, err
		}
		job.Status = TenantDeletionStatusError
		job.ClaimedCount = 0
		job.LastError = fmt.Sprintf("tenant %s already claimed by deletion job %s", item.userID, item.claimedBy)
		job.Version++
		job.UpdatedAt = now
		if _, err := tx.ExecContext(ctx, `
			UPDATE llmgateway_tenant_deletion_jobs
			SET status = ?, claimed_count = 0, last_error = ?, version = ?, updated_at = ? WHERE id = ?
		`, job.Status, job.LastError, job.Version, job.UpdatedAt, job.ID); err != nil {
			return TenantDeletionJob{}, err
		}
		if err := tx.Commit(); err != nil {
			return TenantDeletionJob{}, err
		}
		return job, fmt.Errorf("tenant %s is already claimed by deletion job %s", item.userID, item.claimedBy)
	}
	for _, item := range candidates {
		if _, err := tx.ExecContext(ctx, `
			INSERT IGNORE INTO llmgateway_tenant_deletion_claims (external_user_id, job_id, created_at)
			VALUES (?, ?, ?)
		`, item.userID, jobID, now); err != nil {
			return TenantDeletionJob{}, err
		}
		if _, err := tx.ExecContext(ctx, `
			UPDATE llmgateway_tenants SET status = 'deleting', updated_at = ?
			WHERE external_user_id = ? AND status <> 'deleted'
		`, now, item.userID); err != nil {
			return TenantDeletionJob{}, err
		}
	}
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM llmgateway_tenant_deletion_claims WHERE job_id = ?`, jobID).Scan(&job.ClaimedCount); err != nil {
		return TenantDeletionJob{}, err
	}
	if job.ClaimedCount == job.TargetCount {
		job.Status = TenantDeletionStatusQueued
	}
	job.Version++
	job.UpdatedAt = now
	if _, err := tx.ExecContext(ctx, `
		UPDATE llmgateway_tenant_deletion_jobs
		SET status = ?, claimed_count = ?, version = ?, updated_at = ? WHERE id = ?
	`, job.Status, job.ClaimedCount, job.Version, job.UpdatedAt, job.ID); err != nil {
		return TenantDeletionJob{}, err
	}
	if err := tx.Commit(); err != nil {
		return TenantDeletionJob{}, err
	}
	return job, nil
}

func (s *MySQLStore) AcquireTenantDeletionTarget(ctx context.Context, owner string, ttl time.Duration, now time.Time) (TenantDeletionTarget, bool, error) {
	var result TenantDeletionTarget
	var acquired bool
	err := retryMySQLTransientLock(ctx, func() error {
		target, ok, err := s.acquireTenantDeletionTargetOnce(ctx, owner, ttl, now)
		if err == nil {
			result = target
			acquired = ok
		}
		return err
	})
	return result, acquired, err
}

func (s *MySQLStore) acquireTenantDeletionTargetOnce(ctx context.Context, owner string, ttl time.Duration, now time.Time) (TenantDeletionTarget, bool, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return TenantDeletionTarget{}, false, err
	}
	defer tx.Rollback()
	var target TenantDeletionTarget
	var leaseUntil sql.NullTime
	err = tx.QueryRowContext(ctx, `
		SELECT targets.job_id, targets.external_user_id, targets.set_id, targets.status,
			targets.attempts, targets.lease_owner, targets.lease_until, targets.last_error,
			targets.created_at, targets.updated_at
		FROM llmgateway_tenant_deletion_targets targets
		JOIN llmgateway_tenant_deletion_jobs jobs ON jobs.id = targets.job_id
		JOIN llmgateway_tenant_deletion_claims claims
			ON claims.external_user_id = targets.external_user_id AND claims.job_id = targets.job_id
		WHERE jobs.status IN ('queued', 'running', 'partial')
			AND (
				targets.status = 'pending'
				OR (targets.status = 'error' AND targets.attempts < ? AND targets.updated_at <= ?)
				OR (targets.status = 'running' AND (targets.lease_until IS NULL OR targets.lease_until <= ?))
			)
		ORDER BY jobs.created_at, jobs.id, targets.external_user_id
		LIMIT 1 FOR UPDATE
	`, maxTenantDeletionAttempts, now.Add(-tenantDeletionRetryDelay), now).Scan(&target.JobID, &target.ExternalUserID, &target.SetID, &target.Status,
		&target.Attempts, &target.LeaseOwner, &leaseUntil, &target.LastError,
		&target.CreatedAt, &target.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return TenantDeletionTarget{}, false, nil
	}
	if err != nil {
		return TenantDeletionTarget{}, false, err
	}
	previousStatus := target.Status
	result, err := tx.ExecContext(ctx, `
		UPDATE llmgateway_tenants SET status = 'deleting', updated_at = ?
		WHERE external_user_id = ? AND status <> 'deleted'
	`, now, target.ExternalUserID)
	if err != nil {
		return TenantDeletionTarget{}, false, err
	}
	if affected, err := result.RowsAffected(); err != nil {
		return TenantDeletionTarget{}, false, err
	} else if affected == 0 {
		var status string
		if err := tx.QueryRowContext(ctx, `SELECT status FROM llmgateway_tenants WHERE external_user_id = ?`, target.ExternalUserID).Scan(&status); err != nil {
			return TenantDeletionTarget{}, false, err
		}
	}
	target.Status = TenantDeletionTargetStatusRunning
	target.Attempts++
	target.LeaseOwner = owner
	target.LeaseUntil = now.Add(ttl)
	target.LastError = ""
	target.UpdatedAt = now
	if _, err := tx.ExecContext(ctx, `
		UPDATE llmgateway_tenant_deletion_targets
		SET status = ?, attempts = ?, lease_owner = ?, lease_until = ?, last_error = '', updated_at = ?
		WHERE job_id = ? AND external_user_id = ?
	`, target.Status, target.Attempts, target.LeaseOwner, target.LeaseUntil, target.UpdatedAt,
		target.JobID, target.ExternalUserID); err != nil {
		return TenantDeletionTarget{}, false, err
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE llmgateway_tenant_deletion_jobs
		SET status = CASE WHEN GREATEST(failure_count - ?, 0) > 0 THEN 'partial' ELSE 'running' END,
			failure_count = GREATEST(failure_count - ?, 0),
			version = version + 1, updated_at = ? WHERE id = ?
	`, boolToInt(previousStatus == TenantDeletionTargetStatusError), boolToInt(previousStatus == TenantDeletionTargetStatusError), now, target.JobID); err != nil {
		return TenantDeletionTarget{}, false, err
	}
	if err := tx.Commit(); err != nil {
		return TenantDeletionTarget{}, false, err
	}
	return target, true, nil
}

func (s *MySQLStore) FailTenantDeletionTarget(ctx context.Context, target TenantDeletionTarget, lastError string, now time.Time) error {
	return retryMySQLTransientLock(ctx, func() error {
		return s.failTenantDeletionTargetOnce(ctx, target, lastError, now)
	})
}

func (s *MySQLStore) failTenantDeletionTargetOnce(ctx context.Context, target TenantDeletionTarget, lastError string, now time.Time) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	result, err := tx.ExecContext(ctx, `
		UPDATE llmgateway_tenant_deletion_targets
		SET status = 'error', lease_owner = '', lease_until = NULL, last_error = ?, updated_at = ?
		WHERE job_id = ? AND external_user_id = ? AND lease_owner = ? AND status = 'running'
	`, strings.TrimSpace(lastError), now, target.JobID, target.ExternalUserID, target.LeaseOwner)
	if err != nil {
		return err
	}
	if affected, err := result.RowsAffected(); err != nil || affected != 1 {
		if err != nil {
			return err
		}
		return fmt.Errorf("tenant deletion target lease was lost")
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE llmgateway_tenant_deletion_jobs
		SET status = 'partial',
			failure_count = failure_count + 1,
			last_error = ?, version = version + 1, updated_at = ?
		WHERE id = ?
	`, strings.TrimSpace(lastError), now, target.JobID); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *MySQLStore) PurgeTenantDeletionTarget(ctx context.Context, target TenantDeletionTarget, now time.Time) (TenantDeletionJob, error) {
	var result TenantDeletionJob
	err := retryMySQLTransientLock(ctx, func() error {
		job, err := s.purgeTenantDeletionTargetOnce(ctx, target, now)
		if err == nil {
			result = job
		}
		return err
	})
	return result, err
}

func (s *MySQLStore) purgeTenantDeletionTargetOnce(ctx context.Context, target TenantDeletionTarget, now time.Time) (TenantDeletionJob, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return TenantDeletionJob{}, err
	}
	defer tx.Rollback()
	var currentStatus, currentOwner, setID string
	if err := tx.QueryRowContext(ctx, `
		SELECT status, lease_owner, set_id FROM llmgateway_tenant_deletion_targets
		WHERE job_id = ? AND external_user_id = ? FOR UPDATE
	`, target.JobID, target.ExternalUserID).Scan(&currentStatus, &currentOwner, &setID); err != nil {
		return TenantDeletionJob{}, err
	}
	if currentStatus != TenantDeletionTargetStatusRunning || currentOwner != target.LeaseOwner {
		return TenantDeletionJob{}, fmt.Errorf("tenant deletion target lease was lost")
	}
	var bindingSetID string
	bindingExists := true
	if err := tx.QueryRowContext(ctx, `
		SELECT set_id FROM llmgateway_user_bindings WHERE external_user_id = ? FOR UPDATE
	`, target.ExternalUserID).Scan(&bindingSetID); errors.Is(err, sql.ErrNoRows) {
		bindingExists = false
	} else if err != nil {
		return TenantDeletionJob{}, err
	}
	deleteStatements := []string{
		`DELETE FROM llmgateway_api_key_bindings WHERE user_id = ?`,
		`DELETE FROM llmgateway_user_assignments WHERE external_user_id = ?`,
		`DELETE FROM llmgateway_user_llm_settings WHERE external_user_id = ?`,
		`DELETE FROM llmgateway_byok_sync_tasks WHERE external_user_id = ?`,
		`DELETE FROM llmgateway_tenant_observations WHERE external_user_id = ?`,
		`DELETE FROM llmgateway_tenant_observation_tasks WHERE external_user_id = ?`,
		`DELETE FROM llmgateway_subscription_period_overlays WHERE external_user_id = ?`,
		`DELETE FROM llmgateway_admin_commands WHERE external_user_id = ?`,
	}
	for _, statement := range deleteStatements {
		if _, err := tx.ExecContext(ctx, statement, target.ExternalUserID); err != nil {
			return TenantDeletionJob{}, err
		}
	}
	groupResult, err := tx.ExecContext(ctx, `DELETE FROM llmgateway_group_ratio_desired WHERE external_user_id = ?`, target.ExternalUserID)
	if err != nil {
		return TenantDeletionJob{}, err
	}
	if affected, err := groupResult.RowsAffected(); err != nil {
		return TenantDeletionJob{}, err
	} else if affected > 0 && setID != "" {
		if _, err := tx.ExecContext(ctx, `
			UPDATE llmgateway_group_ratio_apply_states
			SET desired_version = desired_version + 1, status = 'pending', updated_at = ? WHERE set_id = ?
		`, now, setID); err != nil {
			return TenantDeletionJob{}, err
		}
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM llmgateway_user_bindings WHERE external_user_id = ?`, target.ExternalUserID); err != nil {
		return TenantDeletionJob{}, err
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE llmgateway_tenants SET status = 'deleted', updated_at = ? WHERE external_user_id = ?
	`, now, target.ExternalUserID); err != nil {
		return TenantDeletionJob{}, err
	}
	if bindingExists && bindingSetID != "" {
		if _, err := tx.ExecContext(ctx, `
			UPDATE llmgateway_sets
			SET observed_user_count = GREATEST(observed_user_count - 1, 0), capacity_updated_at = ?, updated_at = ?
			WHERE id = ?
		`, now, now, bindingSetID); err != nil {
			return TenantDeletionJob{}, err
		}
	}
	targetResult, err := tx.ExecContext(ctx, `
		UPDATE llmgateway_tenant_deletion_targets
		SET status = 'succeeded', lease_owner = '', lease_until = NULL, last_error = '', updated_at = ?
		WHERE job_id = ? AND external_user_id = ? AND lease_owner = ? AND status = 'running'
	`, now, target.JobID, target.ExternalUserID, target.LeaseOwner)
	if err != nil {
		return TenantDeletionJob{}, err
	}
	if affected, err := targetResult.RowsAffected(); err != nil || affected != 1 {
		if err != nil {
			return TenantDeletionJob{}, err
		}
		return TenantDeletionJob{}, fmt.Errorf("tenant deletion target lease was lost")
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM llmgateway_tenant_deletion_claims WHERE external_user_id = ? AND job_id = ?`, target.ExternalUserID, target.JobID); err != nil {
		return TenantDeletionJob{}, err
	}
	if _, err := tx.ExecContext(ctx, tenantDeletionSuccessJobUpdateSQL(), now, target.JobID); err != nil {
		return TenantDeletionJob{}, err
	}
	job, ok, err := getTenantDeletionJobSQL(ctx, tx, target.JobID, false)
	if err != nil || !ok {
		return TenantDeletionJob{}, err
	}
	if err := tx.Commit(); err != nil {
		return TenantDeletionJob{}, err
	}
	return job, nil
}

func tenantDeletionSuccessJobUpdateSQL() string {
	return `
		UPDATE llmgateway_tenant_deletion_jobs
		SET status = CASE
				WHEN success_count + 1 >= target_count THEN 'succeeded'
				WHEN failure_count > 0 THEN 'partial'
				ELSE 'running'
			END,
			last_error = CASE WHEN success_count + 1 >= target_count THEN '' ELSE last_error END,
			success_count = success_count + 1,
			version = version + 1, updated_at = ?
		WHERE id = ?
	`
}

func boolToInt(value bool) int {
	if value {
		return 1
	}
	return 0
}

func tenantDeletionCandidateQuery(job TenantDeletionJob, limit int) (string, []any, error) {
	base := `
		SELECT external_user_id, set_id
		FROM llmgateway_tenants
		WHERE status <> 'deleted' AND created_at <= ? AND external_user_id > ?`
	args := []any{job.SnapshotAt, job.MaterializationCursor}
	switch job.SelectorType {
	case tenantDeletionSelectorUserIDs:
		if len(job.UserIDs) == 0 {
			base += " AND 1 = 0"
			break
		}
		placeholders := make([]string, len(job.UserIDs))
		for index, id := range job.UserIDs {
			placeholders[index] = "?"
			args = append(args, id)
		}
		base += " AND external_user_id IN (" + strings.Join(placeholders, ",") + ")"
	case tenantDeletionSelectorPrefix:
		base += " AND external_user_id LIKE ? ESCAPE '\\\\'"
		args = append(args, escapeLikePrefix(job.SelectorValue)+"%")
	case tenantDeletionSelectorSet:
		base += " AND set_id = ?"
		args = append(args, job.SelectorValue)
	default:
		return "", nil, fmt.Errorf("unknown tenant deletion selector %q", job.SelectorType)
	}
	base += " ORDER BY external_user_id LIMIT ?"
	args = append(args, limit)
	return base, args, nil
}

func escapeLikePrefix(value string) string {
	replacer := strings.NewReplacer("\\", "\\\\", "%", "\\%", "_", "\\_")
	return replacer.Replace(value)
}

func (s *MySQLStore) GetTenantDeletionJob(ctx context.Context, jobID string) (TenantDeletionJob, bool, error) {
	return getTenantDeletionJobSQL(ctx, s.db, jobID, false)
}

func getTenantDeletionJobSQL(ctx context.Context, queryer sqlQueryer, jobID string, forUpdate bool) (TenantDeletionJob, bool, error) {
	query := `
		SELECT id, status, selector_type, selector_value, selector_user_ids_json, snapshot_at,
			materialization_cursor, target_count, target_digest, claimed_count, success_count,
			failure_count, last_error, version, idempotency_key, created_at, updated_at
		FROM llmgateway_tenant_deletion_jobs WHERE id = ?`
	if forUpdate {
		query += " FOR UPDATE"
	}
	var job TenantDeletionJob
	var userIDsJSON []byte
	err := queryer.QueryRowContext(ctx, query, jobID).Scan(
		&job.ID, &job.Status, &job.SelectorType, &job.SelectorValue, &userIDsJSON, &job.SnapshotAt,
		&job.MaterializationCursor, &job.TargetCount, &job.TargetDigest, &job.ClaimedCount,
		&job.SuccessCount, &job.FailureCount, &job.LastError, &job.Version, &job.IdempotencyKey,
		&job.CreatedAt, &job.UpdatedAt,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return TenantDeletionJob{}, false, nil
	}
	if err != nil {
		return TenantDeletionJob{}, false, err
	}
	if len(userIDsJSON) > 0 {
		if err := json.Unmarshal(userIDsJSON, &job.UserIDs); err != nil {
			return TenantDeletionJob{}, false, err
		}
	}
	return job, true, nil
}

func (s *MySQLStore) ListTenantDeletionJobs(ctx context.Context, opts TenantDeletionJobListOptions) ([]TenantDeletionJob, error) {
	query := `
		SELECT id, status, selector_type, selector_value, selector_user_ids_json, snapshot_at,
			materialization_cursor, target_count, target_digest, claimed_count, success_count,
			failure_count, last_error, version, idempotency_key, created_at, updated_at
		FROM llmgateway_tenant_deletion_jobs`
	args := []any{}
	if opts.Status != "" {
		query += " WHERE status = ?"
		args = append(args, opts.Status)
	}
	query += " ORDER BY created_at DESC, id"
	if opts.Limit > 0 {
		query += " LIMIT ?"
		args = append(args, opts.Limit)
	}
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	jobs := []TenantDeletionJob{}
	for rows.Next() {
		var job TenantDeletionJob
		var userIDsJSON []byte
		if err := rows.Scan(&job.ID, &job.Status, &job.SelectorType, &job.SelectorValue, &userIDsJSON,
			&job.SnapshotAt, &job.MaterializationCursor, &job.TargetCount, &job.TargetDigest,
			&job.ClaimedCount, &job.SuccessCount, &job.FailureCount, &job.LastError, &job.Version,
			&job.IdempotencyKey, &job.CreatedAt, &job.UpdatedAt); err != nil {
			return nil, err
		}
		if len(userIDsJSON) > 0 {
			if err := json.Unmarshal(userIDsJSON, &job.UserIDs); err != nil {
				return nil, err
			}
		}
		jobs = append(jobs, job)
	}
	return jobs, rows.Err()
}

func (s *MySQLStore) ListTenantDeletionTargets(ctx context.Context, jobID string, opts TenantDeletionTargetListOptions) ([]TenantDeletionTarget, error) {
	return listTenantDeletionTargetsSQL(ctx, s.db, jobID, opts)
}

func listTenantDeletionTargetsSQL(ctx context.Context, queryer sqlRowsQueryer, jobID string, opts TenantDeletionTargetListOptions) ([]TenantDeletionTarget, error) {
	query := `
		SELECT job_id, external_user_id, set_id, status, attempts, lease_owner, lease_until,
			last_error, created_at, updated_at
		FROM llmgateway_tenant_deletion_targets WHERE job_id = ?`
	args := []any{jobID}
	if opts.Status != "" {
		query += " AND status = ?"
		args = append(args, opts.Status)
	}
	query += " ORDER BY external_user_id"
	if opts.Limit > 0 {
		query += " LIMIT ?"
		args = append(args, opts.Limit)
	}
	rows, err := queryer.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	targets := []TenantDeletionTarget{}
	for rows.Next() {
		var target TenantDeletionTarget
		var leaseUntil sql.NullTime
		if err := rows.Scan(&target.JobID, &target.ExternalUserID, &target.SetID, &target.Status,
			&target.Attempts, &target.LeaseOwner, &leaseUntil, &target.LastError,
			&target.CreatedAt, &target.UpdatedAt); err != nil {
			return nil, err
		}
		if leaseUntil.Valid {
			target.LeaseUntil = leaseUntil.Time.UTC()
		}
		targets = append(targets, target)
	}
	return targets, rows.Err()
}

type sqlQueryer interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

type sqlRowsQueryer interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
}

func (s *MySQLStore) GetSetDecommissionPreview(ctx context.Context, setID string, now time.Time) (SetDecommissionPreview, error) {
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return SetDecommissionPreview{}, err
	}
	defer tx.Rollback()
	preview, err := getSetDecommissionPreviewSQL(ctx, tx, setID, now, false)
	if err != nil {
		return SetDecommissionPreview{}, err
	}
	if err := tx.Commit(); err != nil {
		return SetDecommissionPreview{}, err
	}
	return preview, nil
}

func getSetDecommissionPreviewSQL(ctx context.Context, tx *sql.Tx, setID string, now time.Time, forUpdate bool) (SetDecommissionPreview, error) {
	query := "SELECT id, lifecycle_generation FROM llmgateway_sets WHERE id = ?"
	if forUpdate {
		query += " FOR UPDATE"
	}
	var set Set
	if err := tx.QueryRowContext(ctx, query, setID).Scan(&set.ID, &set.LifecycleGeneration); errors.Is(err, sql.ErrNoRows) {
		return SetDecommissionPreview{}, fmt.Errorf("set %q not found", setID)
	} else if err != nil {
		return SetDecommissionPreview{}, err
	}
	count := func(query string, args ...any) (int, error) {
		var value int
		if err := tx.QueryRowContext(ctx, query, args...).Scan(&value); err != nil {
			return 0, err
		}
		return value, nil
	}
	var blockers SetDecommissionBlockers
	queries := []struct {
		dest  *int
		query string
		args  []any
	}{
		{&blockers.Tenants, `SELECT COUNT(*) FROM llmgateway_tenants WHERE set_id = ? AND status <> 'deleted'`, []any{setID}},
		{&blockers.UserBindings, `SELECT COUNT(*) FROM llmgateway_user_bindings WHERE set_id = ?`, []any{setID}},
		{&blockers.APIKeys, `SELECT COUNT(*) FROM llmgateway_api_key_bindings WHERE set_id = ?`, []any{setID}},
		{&blockers.Assignments, `SELECT COUNT(*) FROM llmgateway_user_assignments WHERE set_id = ?`, []any{setID}},
		{&blockers.BYOKSettings, `
			SELECT COUNT(DISTINCT settings.external_user_id)
			FROM llmgateway_user_llm_settings settings
			LEFT JOIN llmgateway_tenants tenants ON tenants.external_user_id = settings.external_user_id
			LEFT JOIN llmgateway_user_bindings bindings ON bindings.external_user_id = settings.external_user_id
			WHERE tenants.set_id = ? OR bindings.set_id = ?
		`, []any{setID, setID}},
		{&blockers.BYOKTasks, `SELECT COUNT(*) FROM llmgateway_byok_sync_tasks WHERE set_id = ?`, []any{setID}},
		{&blockers.Observations, `SELECT COUNT(*) FROM llmgateway_tenant_observations WHERE set_id = ?`, []any{setID}},
		{&blockers.ObservationTasks, `SELECT COUNT(*) FROM llmgateway_tenant_observation_tasks WHERE set_id = ?`, []any{setID}},
		{&blockers.SubscriptionOverlays, `SELECT COUNT(*) FROM llmgateway_subscription_period_overlays WHERE set_id = ?`, []any{setID}},
		{&blockers.AdminCommands, `SELECT COUNT(*) FROM llmgateway_admin_commands WHERE set_id = ? AND status <> 'succeeded'`, []any{setID}},
		{&blockers.GroupRatioIntents, `SELECT COUNT(*) FROM llmgateway_group_ratio_desired WHERE set_id = ? AND external_user_id IS NOT NULL`, []any{setID}},
		{&blockers.DeletionTargets, `SELECT COUNT(*) FROM llmgateway_tenant_deletion_targets WHERE set_id = ? AND status NOT IN ('succeeded', 'abandoned')`, []any{setID}},
		{&blockers.ActiveOperationLeases, `SELECT COUNT(*) FROM llmgateway_set_operation_leases WHERE set_id = ? AND owner <> '' AND lease_until > ?`, []any{setID, now}},
		{&blockers.RuntimeLeases, `SELECT COUNT(*) FROM llmgateway_set_runtime_leases WHERE set_id = ?`, []any{setID}},
	}
	for _, item := range queries {
		value, err := count(item.query, item.args...)
		if err != nil {
			return SetDecommissionPreview{}, err
		}
		*item.dest = value
	}
	return SetDecommissionPreview{
		SetID: setID, Empty: blockers.Total() == 0, Blockers: blockers,
		Digest: setDecommissionDigest(set, blockers),
	}, nil
}

func (s *MySQLStore) StartSetDecommission(ctx context.Context, input SetDecommissionStartInput, jobID string, now time.Time) (SetDecommissionJob, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return SetDecommissionJob{}, err
	}
	defer tx.Rollback()
	if existing, ok, err := getSetDecommissionJobByIdempotencySQL(ctx, tx, input.IdempotencyKey); err != nil {
		return SetDecommissionJob{}, err
	} else if ok {
		if existing.SetID == input.SetID && existing.ExpectedDigest == input.ExpectedDigest &&
			existing.CascadeTenants == input.CascadeTenants && existing.AllowOrphan == input.AllowOrphan {
			if err := tx.Commit(); err != nil {
				return SetDecommissionJob{}, err
			}
			return existing, nil
		}
		return SetDecommissionJob{}, fmt.Errorf("idempotency key already used with another set decommission request")
	}
	preview, err := getSetDecommissionPreviewSQL(ctx, tx, input.SetID, now, true)
	if err != nil {
		return SetDecommissionJob{}, err
	}
	if preview.Digest != input.ExpectedDigest {
		return SetDecommissionJob{}, fmt.Errorf("set decommission preview changed")
	}
	if !preview.Empty && !input.CascadeTenants {
		return SetDecommissionJob{}, fmt.Errorf("set %q is not empty", input.SetID)
	}
	if input.AllowOrphan && !input.CascadeTenants {
		return SetDecommissionJob{}, fmt.Errorf("orphan cleanup requires cascade_tenants")
	}
	if input.CascadeTenants && (preview.Blockers.ActiveOperationLeases > 0 || preview.Blockers.DeletionTargets > 0) {
		return SetDecommissionJob{}, fmt.Errorf("set %q has conflicting operations", input.SetID)
	}
	if preview.Blockers.RuntimeLeases == 0 && !input.AllowOrphan {
		return SetDecommissionJob{}, fmt.Errorf("set %q requires exactly one complete runtime lease", input.SetID)
	}
	if preview.Blockers.RuntimeLeases > 1 || (preview.Blockers.RuntimeLeases == 1 && input.AllowOrphan) {
		return SetDecommissionJob{}, fmt.Errorf("set %q runtime lease does not match orphan cleanup mode", input.SetID)
	}
	var status string
	var generation int64
	if err := tx.QueryRowContext(ctx, `SELECT status, lifecycle_generation FROM llmgateway_sets WHERE id = ? FOR UPDATE`, input.SetID).Scan(&status, &generation); err != nil {
		return SetDecommissionJob{}, err
	}
	var activeUpgradeID string
	if err := tx.QueryRowContext(ctx, `
		SELECT id FROM llmgateway_set_upgrade_runs
		WHERE set_id=? AND status NOT IN ('completed','failed','rolled_back')
		LIMIT 1 FOR UPDATE
	`, input.SetID).Scan(&activeUpgradeID); err == nil {
		return SetDecommissionJob{}, fmt.Errorf("set %q has active upgrade %q", input.SetID, activeUpgradeID)
	} else if !errors.Is(err, sql.ErrNoRows) {
		return SetDecommissionJob{}, err
	}
	if status != SetStatusActive && status != SetStatusDisabled {
		return SetDecommissionJob{}, fmt.Errorf("set %q cannot be decommissioned from status %q", input.SetID, status)
	}
	if input.AllowOrphan && status != SetStatusDisabled {
		return SetDecommissionJob{}, fmt.Errorf("orphan set %q must be disabled before cleanup", input.SetID)
	}
	generation++
	result, err := tx.ExecContext(ctx, `
		UPDATE llmgateway_sets SET status = 'draining', lifecycle_generation = ?, updated_at = ?
		WHERE id = ? AND lifecycle_generation = ?
	`, generation, now, input.SetID, generation-1)
	if err != nil {
		return SetDecommissionJob{}, err
	}
	if affected, err := result.RowsAffected(); err != nil || affected != 1 {
		if err != nil {
			return SetDecommissionJob{}, err
		}
		return SetDecommissionJob{}, fmt.Errorf("set lifecycle changed while starting decommission")
	}
	jobStatus := SetDecommissionStatusPending
	if input.CascadeTenants && (!preview.Empty || input.AllowOrphan) {
		jobStatus = SetDecommissionStatusPurgingTenants
		if _, err := tx.ExecContext(ctx, `
			UPDATE llmgateway_tenants SET status = 'deleting', updated_at = ?
			WHERE set_id = ? AND status <> 'deleted'
		`, now, input.SetID); err != nil {
			return SetDecommissionJob{}, err
		}
	}
	job := SetDecommissionJob{
		ID: jobID, SetID: input.SetID, Status: jobStatus,
		PreviousSetStatus:   status,
		LifecycleGeneration: generation, ExpectedDigest: input.ExpectedDigest,
		IdempotencyKey: input.IdempotencyKey, CascadeTenants: input.CascadeTenants, AllowOrphan: input.AllowOrphan,
		Version: 1, CreatedAt: now, UpdatedAt: now,
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO llmgateway_set_decommission_jobs (
			id, set_id, status, previous_set_status, lifecycle_generation, expected_digest, idempotency_key,
			cascade_tenants, allow_orphan, attempt, claim_owner, claim_token, claim_lease_until, lease_fingerprint, capability_hash, job_uid,
			version, last_error, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, '', '', NULL, '', '', '', ?, '', ?, ?)
	`, job.ID, job.SetID, job.Status, job.PreviousSetStatus, job.LifecycleGeneration, job.ExpectedDigest,
		job.IdempotencyKey, job.CascadeTenants, job.AllowOrphan, job.Version, job.CreatedAt, job.UpdatedAt); err != nil {
		return SetDecommissionJob{}, err
	}
	if err := tx.Commit(); err != nil {
		return SetDecommissionJob{}, err
	}
	return job, nil
}

func (s *MySQLStore) GetSetDecommissionJob(ctx context.Context, jobID string) (SetDecommissionJob, bool, error) {
	return getSetDecommissionJobSQL(ctx, s.db, "id = ?", jobID)
}

func (s *MySQLStore) AcquireSetDecommissionCascade(ctx context.Context, owner string, ttl time.Duration, now time.Time) (SetDecommissionJob, bool, error) {
	if ttl <= 0 {
		ttl = 5 * time.Minute
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return SetDecommissionJob{}, false, err
	}
	defer tx.Rollback()
	var jobID string
	err = tx.QueryRowContext(ctx, `
		SELECT id FROM llmgateway_set_decommission_jobs
		WHERE status = 'purging_tenants'
			AND (claim_owner = '' OR claim_lease_until IS NULL OR claim_lease_until <= ?)
			AND (last_error = '' OR updated_at <= ?)
		ORDER BY created_at, id LIMIT 1 FOR UPDATE
	`, now, now.Add(-setCascadeRetryDelay)).Scan(&jobID)
	if errors.Is(err, sql.ErrNoRows) {
		return SetDecommissionJob{}, false, nil
	}
	if err != nil {
		return SetDecommissionJob{}, false, err
	}
	job, ok, err := getSetDecommissionJobSQL(ctx, tx, "id = ? FOR UPDATE", jobID)
	if err != nil || !ok {
		return SetDecommissionJob{}, false, err
	}
	var status string
	var generation int64
	if err := tx.QueryRowContext(ctx, `SELECT status, lifecycle_generation FROM llmgateway_sets WHERE id = ? FOR UPDATE`, job.SetID).Scan(&status, &generation); err != nil {
		return SetDecommissionJob{}, false, err
	}
	if status != SetStatusDraining || generation != job.LifecycleGeneration {
		message := fmt.Sprintf("set %q lifecycle changed", job.SetID)
		job.Status = SetDecommissionStatusError
		job.ClaimOwner = ""
		job.ClaimToken = ""
		job.ClaimLeaseUntil = time.Time{}
		job.LastError = message
		job.Version++
		job.UpdatedAt = now
		if _, updateErr := tx.ExecContext(ctx, `
			UPDATE llmgateway_set_decommission_jobs
			SET status = ?, claim_owner = '', claim_token = '', claim_lease_until = NULL,
				last_error = ?, version = ?, updated_at = ?
			WHERE id = ?
		`, job.Status, job.LastError, job.Version, job.UpdatedAt, job.ID); updateErr != nil {
			return SetDecommissionJob{}, false, updateErr
		}
		if commitErr := tx.Commit(); commitErr != nil {
			return SetDecommissionJob{}, false, commitErr
		}
		return SetDecommissionJob{}, false, fmt.Errorf("%s", message)
	}
	job.ClaimOwner = owner
	job.ClaimToken = randomSecret()
	job.ClaimLeaseUntil = now.Add(ttl)
	job.LastError = ""
	job.Version++
	job.UpdatedAt = now
	result, err := tx.ExecContext(ctx, `
		UPDATE llmgateway_set_decommission_jobs
		SET claim_owner = ?, claim_token = ?, claim_lease_until = ?, last_error = '', version = ?, updated_at = ?
		WHERE id = ? AND status = 'purging_tenants'
			AND (claim_owner = '' OR claim_lease_until IS NULL OR claim_lease_until <= ?)
	`, job.ClaimOwner, job.ClaimToken, job.ClaimLeaseUntil, job.Version, job.UpdatedAt, job.ID, now)
	if err != nil {
		return SetDecommissionJob{}, false, err
	}
	if affected, err := result.RowsAffected(); err != nil {
		return SetDecommissionJob{}, false, err
	} else if affected != 1 {
		return SetDecommissionJob{}, false, nil
	}
	if err := tx.Commit(); err != nil {
		return SetDecommissionJob{}, false, err
	}
	return job, true, nil
}

func (s *MySQLStore) CompleteSetDecommissionCascade(ctx context.Context, jobID, claimToken string, now time.Time) (SetDecommissionJob, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return SetDecommissionJob{}, err
	}
	defer tx.Rollback()
	job, ok, err := getSetDecommissionJobSQL(ctx, tx, "id = ? FOR UPDATE", jobID)
	if err != nil {
		return SetDecommissionJob{}, err
	}
	if !ok {
		return SetDecommissionJob{}, fmt.Errorf("set decommission job %q not found", jobID)
	}
	if job.Status != SetDecommissionStatusPurgingTenants || job.ClaimToken == "" || job.ClaimToken != claimToken ||
		!job.ClaimLeaseUntil.After(now) {
		return SetDecommissionJob{}, fmt.Errorf("set decommission cascade lease was lost")
	}
	var setStatus string
	var generation int64
	if err := tx.QueryRowContext(ctx, `SELECT status, lifecycle_generation FROM llmgateway_sets WHERE id = ? FOR UPDATE`, job.SetID).Scan(&setStatus, &generation); err != nil {
		return SetDecommissionJob{}, err
	}
	if setStatus != SetStatusDraining || generation != job.LifecycleGeneration {
		return SetDecommissionJob{}, fmt.Errorf("set %q lifecycle changed", job.SetID)
	}
	purgeStatements := []string{
		`DELETE FROM llmgateway_api_key_bindings WHERE set_id = ?`,
		`DELETE FROM llmgateway_user_assignments WHERE set_id = ?`,
		`DELETE FROM llmgateway_byok_sync_tasks WHERE set_id = ?`,
		`DELETE FROM llmgateway_tenant_observations WHERE set_id = ?`,
		`DELETE FROM llmgateway_tenant_observation_tasks WHERE set_id = ?`,
		`DELETE FROM llmgateway_subscription_period_overlays WHERE set_id = ?`,
		`DELETE FROM llmgateway_admin_commands WHERE set_id = ?`,
		`DELETE FROM llmgateway_group_ratio_desired WHERE set_id = ? AND external_user_id IS NOT NULL`,
	}
	for _, statement := range purgeStatements {
		if _, err := tx.ExecContext(ctx, statement, job.SetID); err != nil {
			return SetDecommissionJob{}, err
		}
	}
	if _, err := tx.ExecContext(ctx, `
		DELETE settings FROM llmgateway_user_llm_settings settings
		LEFT JOIN llmgateway_tenants tenants ON tenants.external_user_id = settings.external_user_id
		LEFT JOIN llmgateway_user_bindings bindings ON bindings.external_user_id = settings.external_user_id
		WHERE tenants.set_id = ? OR bindings.set_id = ?
	`, job.SetID, job.SetID); err != nil {
		return SetDecommissionJob{}, err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM llmgateway_user_bindings WHERE set_id = ?`, job.SetID); err != nil {
		return SetDecommissionJob{}, err
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE llmgateway_tenants SET status = 'deleted', updated_at = ? WHERE set_id = ?
	`, now, job.SetID); err != nil {
		return SetDecommissionJob{}, err
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE llmgateway_sets SET observed_user_count = 0, capacity_updated_at = ?, updated_at = ? WHERE id = ?
	`, now, now, job.SetID); err != nil {
		return SetDecommissionJob{}, err
	}
	preview, err := getSetDecommissionPreviewSQL(ctx, tx, job.SetID, now, true)
	if err != nil {
		return SetDecommissionJob{}, err
	}
	if !preview.Empty {
		return SetDecommissionJob{}, fmt.Errorf("set %q still has blockers after cascade purge", job.SetID)
	}
	if job.AllowOrphan {
		if preview.Blockers.RuntimeLeases != 0 {
			return SetDecommissionJob{}, fmt.Errorf("orphan set %q gained a runtime lease", job.SetID)
		}
		if err := cleanupSetControlProjectionSQL(ctx, tx, job, now, false); err != nil {
			return SetDecommissionJob{}, err
		}
		job.Status = SetDecommissionStatusSucceeded
	} else {
		if preview.Blockers.RuntimeLeases != 1 {
			return SetDecommissionJob{}, fmt.Errorf("set %q lost its runtime lease during cascade purge", job.SetID)
		}
		job.Status = SetDecommissionStatusPending
	}
	job.ClaimOwner = ""
	job.ClaimToken = ""
	job.ClaimLeaseUntil = time.Time{}
	job.LastError = ""
	job.Version++
	job.UpdatedAt = now
	if _, err := tx.ExecContext(ctx, `
		UPDATE llmgateway_set_decommission_jobs
		SET status = ?, claim_owner = '', claim_token = '', claim_lease_until = NULL,
			last_error = '', version = ?, updated_at = ? WHERE id = ?
	`, job.Status, job.Version, job.UpdatedAt, job.ID); err != nil {
		return SetDecommissionJob{}, err
	}
	if err := tx.Commit(); err != nil {
		return SetDecommissionJob{}, err
	}
	return job, nil
}

func (s *MySQLStore) FailSetDecommissionCascade(ctx context.Context, jobID, claimToken, lastError string, now time.Time) error {
	result, err := s.db.ExecContext(ctx, `
		UPDATE llmgateway_set_decommission_jobs
		SET claim_owner = '', claim_token = '', claim_lease_until = NULL,
			last_error = ?, version = version + 1, updated_at = ?
		WHERE id = ? AND status = 'purging_tenants' AND claim_token = ?
	`, strings.TrimSpace(lastError), now, jobID, claimToken)
	if err != nil {
		return err
	}
	if affected, err := result.RowsAffected(); err != nil || affected != 1 {
		if err != nil {
			return err
		}
		return fmt.Errorf("set decommission cascade lease was lost")
	}
	return nil
}

func cleanupSetControlProjectionSQL(ctx context.Context, tx *sql.Tx, job SetDecommissionJob, now time.Time, deleteRuntimeLease bool) error {
	statements := []struct {
		query string
		args  []any
	}{
		{`UPDATE llmgateway_set_provision_requests SET status = 'cancelled', last_status_at = ?, updated_at = ? WHERE set_id = ?`, []any{now, now, job.SetID}},
		{`DELETE FROM llmgateway_set_operation_leases WHERE set_id = ?`, []any{job.SetID}},
		{`DELETE FROM llmgateway_group_ratio_desired WHERE set_id = ?`, []any{job.SetID}},
		{`DELETE FROM llmgateway_group_ratio_apply_states WHERE set_id = ?`, []any{job.SetID}},
		{`DELETE FROM llmgateway_channel_sync_states WHERE set_id = ?`, []any{job.SetID}},
		{`DELETE FROM llmgateway_channel_bundle_sync_states WHERE set_id = ?`, []any{job.SetID}},
		{`DELETE FROM llmgateway_set_plans WHERE set_id = ?`, []any{job.SetID}},
		{`DELETE FROM llmgateway_set_reconcile_facts WHERE set_id = ?`, []any{job.SetID}},
		{`UPDATE llmgateway_channel_bundles SET source_set_id = '', updated_at = ? WHERE source_set_id = ?`, []any{now, job.SetID}},
	}
	if deleteRuntimeLease {
		statements = append(statements, struct {
			query string
			args  []any
		}{`DELETE FROM llmgateway_set_runtime_leases WHERE set_id = ?`, []any{job.SetID}})
	}
	for _, statement := range statements {
		if _, err := tx.ExecContext(ctx, statement.query, statement.args...); err != nil {
			return err
		}
	}
	result, err := tx.ExecContext(ctx, `
		DELETE FROM llmgateway_sets WHERE id = ? AND status = 'draining' AND lifecycle_generation = ?
	`, job.SetID, job.LifecycleGeneration)
	if err != nil {
		return err
	}
	if affected, err := result.RowsAffected(); err != nil || affected != 1 {
		if err != nil {
			return err
		}
		return fmt.Errorf("set %q lifecycle changed during finalization", job.SetID)
	}
	return nil
}

func (s *MySQLStore) ClaimSetDecommission(ctx context.Context, input SetDecommissionClaimInput, now time.Time) (SetDecommissionJob, SetRuntimeCleanupPayload, error) {
	if input.Owner == "" || input.CapabilityHash == "" {
		return SetDecommissionJob{}, SetRuntimeCleanupPayload{}, fmt.Errorf("claim owner and cleanup capability hash are required")
	}
	if input.LeaseTTL <= 0 {
		input.LeaseTTL = time.Minute
	}
	if input.ClaimToken == "" {
		input.ClaimToken = randomSecret()
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return SetDecommissionJob{}, SetRuntimeCleanupPayload{}, err
	}
	defer tx.Rollback()
	job, ok, err := getSetDecommissionJobSQL(ctx, tx, "id = ? FOR UPDATE", input.JobID)
	if err != nil {
		return SetDecommissionJob{}, SetRuntimeCleanupPayload{}, err
	}
	if !ok {
		return SetDecommissionJob{}, SetRuntimeCleanupPayload{}, fmt.Errorf("set decommission job %q not found", input.JobID)
	}
	if job.Status != SetDecommissionStatusPending && !(job.Status == SetDecommissionStatusRemovingRuntime && !job.ClaimLeaseUntil.After(now)) {
		return SetDecommissionJob{}, SetRuntimeCleanupPayload{}, fmt.Errorf("set decommission job %q cannot be claimed from status %q", job.ID, job.Status)
	}
	failInvariant := func(message string) (SetDecommissionJob, SetRuntimeCleanupPayload, error) {
		job.Status = SetDecommissionStatusError
		job.ClaimOwner = ""
		job.ClaimToken = ""
		job.ClaimLeaseUntil = time.Time{}
		job.LeaseFingerprint = ""
		job.CapabilityHash = ""
		job.LastError = message
		job.Version++
		job.UpdatedAt = now
		if _, updateErr := tx.ExecContext(ctx, `
			UPDATE llmgateway_set_decommission_jobs
			SET status = ?, claim_owner = '', claim_token = '', claim_lease_until = NULL,
				lease_fingerprint = '', capability_hash = '', version = ?, last_error = ?, updated_at = ?
			WHERE id = ?
		`, job.Status, job.Version, job.LastError, job.UpdatedAt, job.ID); updateErr != nil {
			return SetDecommissionJob{}, SetRuntimeCleanupPayload{}, updateErr
		}
		if commitErr := tx.Commit(); commitErr != nil {
			return SetDecommissionJob{}, SetRuntimeCleanupPayload{}, commitErr
		}
		return SetDecommissionJob{}, SetRuntimeCleanupPayload{}, fmt.Errorf("%s", message)
	}
	preview, err := getSetDecommissionPreviewSQL(ctx, tx, job.SetID, now, true)
	if err != nil {
		return SetDecommissionJob{}, SetRuntimeCleanupPayload{}, err
	}
	if !preview.Empty || preview.Blockers.RuntimeLeases != 1 {
		return failInvariant(fmt.Sprintf("set %q is no longer empty", job.SetID))
	}
	var status string
	var generation int64
	if err := tx.QueryRowContext(ctx, `SELECT status, lifecycle_generation FROM llmgateway_sets WHERE id = ?`, job.SetID).Scan(&status, &generation); err != nil {
		return SetDecommissionJob{}, SetRuntimeCleanupPayload{}, err
	}
	if status != SetStatusDraining || generation != job.LifecycleGeneration {
		return failInvariant(fmt.Sprintf("set %q lifecycle changed", job.SetID))
	}
	var lease SetRuntimeLease
	if err := tx.QueryRowContext(ctx, `
		SELECT source, namespace_name, fleet, set_id, shard_ref, database_name, redis_db, created_at, updated_at
		FROM llmgateway_set_runtime_leases WHERE set_id = ? FOR UPDATE
	`, job.SetID).Scan(&lease.Source, &lease.Namespace, &lease.Fleet, &lease.SetID, &lease.ShardRef,
		&lease.DatabaseName, &lease.RedisDB, &lease.CreatedAt, &lease.UpdatedAt); err != nil {
		return SetDecommissionJob{}, SetRuntimeCleanupPayload{}, err
	}
	job.Status = SetDecommissionStatusRemovingRuntime
	job.Attempt++
	job.ClaimOwner = input.Owner
	job.ClaimToken = input.ClaimToken
	job.ClaimLeaseUntil = now.Add(input.LeaseTTL)
	job.LeaseFingerprint = setRuntimeLeaseFingerprint(lease)
	job.CapabilityHash = input.CapabilityHash
	job.Version++
	job.UpdatedAt = now
	if _, err := tx.ExecContext(ctx, `
		UPDATE llmgateway_set_decommission_jobs SET status = ?, attempt = ?, claim_owner = ?, claim_token = ?,
			claim_lease_until = ?, lease_fingerprint = ?, capability_hash = ?, version = ?, last_error = '', updated_at = ?
		WHERE id = ?
	`, job.Status, job.Attempt, job.ClaimOwner, job.ClaimToken, job.ClaimLeaseUntil,
		job.LeaseFingerprint, job.CapabilityHash, job.Version, job.UpdatedAt, job.ID); err != nil {
		return SetDecommissionJob{}, SetRuntimeCleanupPayload{}, err
	}
	if err := tx.Commit(); err != nil {
		return SetDecommissionJob{}, SetRuntimeCleanupPayload{}, err
	}
	return job, setRuntimeCleanupPayload(job, lease), nil
}

func (s *MySQLStore) CancelSetDecommission(ctx context.Context, input SetDecommissionCancelInput, now time.Time) (SetDecommissionJob, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return SetDecommissionJob{}, err
	}
	defer tx.Rollback()
	job, ok, err := getSetDecommissionJobSQL(ctx, tx, "id = ? FOR UPDATE", input.JobID)
	if err != nil {
		return SetDecommissionJob{}, err
	}
	if !ok {
		return SetDecommissionJob{}, fmt.Errorf("set decommission job %q not found", input.JobID)
	}
	if job.Status == SetDecommissionStatusCancelled {
		return job, tx.Commit()
	}
	if job.Status != SetDecommissionStatusPending || job.Version != input.ExpectedVersion {
		return SetDecommissionJob{}, fmt.Errorf("set decommission job %q can only be cancelled before runtime removal", job.ID)
	}
	result, err := tx.ExecContext(ctx, `
		UPDATE llmgateway_sets SET status = ?, updated_at = ?
		WHERE id = ? AND status = 'draining' AND lifecycle_generation = ?
	`, job.PreviousSetStatus, now, job.SetID, job.LifecycleGeneration)
	if err != nil {
		return SetDecommissionJob{}, err
	}
	if affected, err := result.RowsAffected(); err != nil || affected != 1 {
		if err != nil {
			return SetDecommissionJob{}, err
		}
		return SetDecommissionJob{}, fmt.Errorf("set %q lifecycle changed", job.SetID)
	}
	job.Status = SetDecommissionStatusCancelled
	job.Version++
	job.UpdatedAt = now
	if _, err := tx.ExecContext(ctx, `UPDATE llmgateway_set_decommission_jobs SET status = ?, version = ?, updated_at = ? WHERE id = ?`, job.Status, job.Version, job.UpdatedAt, job.ID); err != nil {
		return SetDecommissionJob{}, err
	}
	return job, tx.Commit()
}

func (s *MySQLStore) RetrySetDecommission(ctx context.Context, input SetDecommissionRetryInput, now time.Time) (SetDecommissionJob, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return SetDecommissionJob{}, err
	}
	defer tx.Rollback()
	job, ok, err := getSetDecommissionJobSQL(ctx, tx, "id = ? FOR UPDATE", input.JobID)
	if err != nil {
		return SetDecommissionJob{}, err
	}
	if !ok {
		return SetDecommissionJob{}, fmt.Errorf("set decommission job %q not found", input.JobID)
	}
	if job.Status == SetDecommissionStatusPending {
		return job, tx.Commit()
	}
	if job.Status != SetDecommissionStatusError || job.Version != input.ExpectedVersion {
		return SetDecommissionJob{}, fmt.Errorf("set decommission job %q cannot be retried from status %q", job.ID, job.Status)
	}
	var status string
	var generation int64
	if err := tx.QueryRowContext(ctx, `SELECT status, lifecycle_generation FROM llmgateway_sets WHERE id = ? FOR UPDATE`, job.SetID).Scan(&status, &generation); err != nil {
		return SetDecommissionJob{}, err
	}
	if status != SetStatusDraining || generation != job.LifecycleGeneration {
		return SetDecommissionJob{}, fmt.Errorf("set %q lifecycle changed", job.SetID)
	}
	retryStatus := SetDecommissionStatusPending
	if job.CascadeTenants {
		preview, err := getSetDecommissionPreviewSQL(ctx, tx, job.SetID, now, true)
		if err != nil {
			return SetDecommissionJob{}, err
		}
		if !preview.Empty || job.AllowOrphan {
			retryStatus = SetDecommissionStatusPurgingTenants
			if _, err := tx.ExecContext(ctx, `
				UPDATE llmgateway_tenants SET status = 'deleting', updated_at = ?
				WHERE set_id = ? AND status <> 'deleted'
			`, now, job.SetID); err != nil {
				return SetDecommissionJob{}, err
			}
		}
	}
	job.Status = retryStatus
	job.ClaimOwner = ""
	job.ClaimToken = ""
	job.ClaimLeaseUntil = time.Time{}
	job.LeaseFingerprint = ""
	job.CapabilityHash = ""
	job.JobUID = ""
	job.LastError = ""
	job.Version++
	job.UpdatedAt = now
	if _, err := tx.ExecContext(ctx, `
		UPDATE llmgateway_set_decommission_jobs
		SET status = ?, claim_owner = '', claim_token = '', claim_lease_until = NULL,
			lease_fingerprint = '', capability_hash = '', job_uid = '', last_error = '', version = ?, updated_at = ?
		WHERE id = ?
	`, job.Status, job.Version, job.UpdatedAt, job.ID); err != nil {
		return SetDecommissionJob{}, err
	}
	return job, tx.Commit()
}

func (s *MySQLStore) FailSetDecommission(ctx context.Context, input SetDecommissionFailInput, now time.Time) (SetDecommissionJob, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return SetDecommissionJob{}, err
	}
	defer tx.Rollback()
	job, ok, err := getSetDecommissionJobSQL(ctx, tx, "id = ? FOR UPDATE", input.JobID)
	if err != nil {
		return SetDecommissionJob{}, err
	}
	if !ok {
		return SetDecommissionJob{}, fmt.Errorf("set decommission job %q not found", input.JobID)
	}
	if job.Status == SetDecommissionStatusError && job.Attempt == input.Attempt && job.JobUID == input.JobUID {
		return job, tx.Commit()
	}
	if job.Status != SetDecommissionStatusRemovingRuntime || job.Attempt != input.Attempt ||
		job.ClaimToken != input.ClaimToken || job.LeaseFingerprint != input.LeaseFingerprint || input.JobUID == "" {
		return SetDecommissionJob{}, fmt.Errorf("cleanup failure evidence does not match current set decommission attempt")
	}
	job.Status = SetDecommissionStatusError
	job.JobUID = input.JobUID
	job.LastError = strings.TrimSpace(input.LastError)
	job.CapabilityHash = ""
	job.Version++
	job.UpdatedAt = now
	if _, err := tx.ExecContext(ctx, `
		UPDATE llmgateway_set_decommission_jobs
		SET status = ?, job_uid = ?, last_error = ?, capability_hash = '', version = ?, updated_at = ?
		WHERE id = ?
	`, job.Status, job.JobUID, job.LastError, job.Version, job.UpdatedAt, job.ID); err != nil {
		return SetDecommissionJob{}, err
	}
	return job, tx.Commit()
}

func (s *MySQLStore) FinalizeSetDecommission(ctx context.Context, input SetDecommissionFinalizeInput, now time.Time) (SetDecommissionJob, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return SetDecommissionJob{}, err
	}
	defer tx.Rollback()
	job, ok, err := getSetDecommissionJobSQL(ctx, tx, "id = ? FOR UPDATE", input.JobID)
	if err != nil {
		return SetDecommissionJob{}, err
	}
	if !ok {
		return SetDecommissionJob{}, fmt.Errorf("set decommission job %q not found", input.JobID)
	}
	if job.Status == SetDecommissionStatusCleanupAckPending && job.Attempt == input.Attempt && job.JobUID == input.JobUID {
		return job, tx.Commit()
	}
	if job.Status != SetDecommissionStatusRemovingRuntime || job.Attempt != input.Attempt || job.ClaimToken != input.ClaimToken ||
		job.LeaseFingerprint != input.LeaseFingerprint || input.JobUID == "" {
		return SetDecommissionJob{}, fmt.Errorf("cleanup evidence does not match current set decommission attempt")
	}
	if err := cleanupSetControlProjectionSQL(ctx, tx, job, now, true); err != nil {
		return SetDecommissionJob{}, err
	}
	job.Status = SetDecommissionStatusCleanupAckPending
	job.JobUID = input.JobUID
	job.CapabilityHash = ""
	job.Version++
	job.UpdatedAt = now
	if _, err := tx.ExecContext(ctx, `
		UPDATE llmgateway_set_decommission_jobs SET status = ?, job_uid = ?, capability_hash = '', version = ?, updated_at = ? WHERE id = ?
	`, job.Status, job.JobUID, job.Version, job.UpdatedAt, job.ID); err != nil {
		return SetDecommissionJob{}, err
	}
	if err := tx.Commit(); err != nil {
		return SetDecommissionJob{}, err
	}
	return job, nil
}

func (s *MySQLStore) AcknowledgeSetDecommission(ctx context.Context, jobID string, attempt int, now time.Time) (SetDecommissionJob, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return SetDecommissionJob{}, err
	}
	defer tx.Rollback()
	job, ok, err := getSetDecommissionJobSQL(ctx, tx, "id = ? FOR UPDATE", jobID)
	if err != nil {
		return SetDecommissionJob{}, err
	}
	if !ok {
		return SetDecommissionJob{}, fmt.Errorf("set decommission job %q not found", jobID)
	}
	if job.Status == SetDecommissionStatusSucceeded && job.Attempt == attempt {
		return job, tx.Commit()
	}
	if job.Status != SetDecommissionStatusCleanupAckPending || job.Attempt != attempt {
		return SetDecommissionJob{}, fmt.Errorf("set decommission acknowledgement does not match current attempt")
	}
	job.Status = SetDecommissionStatusSucceeded
	job.Version++
	job.UpdatedAt = now
	if _, err := tx.ExecContext(ctx, `UPDATE llmgateway_set_decommission_jobs SET status = ?, version = ?, updated_at = ? WHERE id = ?`, job.Status, job.Version, job.UpdatedAt, job.ID); err != nil {
		return SetDecommissionJob{}, err
	}
	return job, tx.Commit()
}

func getSetDecommissionJobByIdempotencySQL(ctx context.Context, queryer sqlQueryer, key string) (SetDecommissionJob, bool, error) {
	return getSetDecommissionJobSQL(ctx, queryer, "idempotency_key = ?", key)
}

func getSetDecommissionJobSQL(ctx context.Context, queryer sqlQueryer, where string, arg any) (SetDecommissionJob, bool, error) {
	var job SetDecommissionJob
	err := queryer.QueryRowContext(ctx, `
		SELECT id, set_id, status, previous_set_status, lifecycle_generation, expected_digest, idempotency_key,
			cascade_tenants, allow_orphan, attempt, claim_owner, claim_token, claim_lease_until, lease_fingerprint, capability_hash, job_uid,
			version, last_error, created_at, updated_at
		FROM llmgateway_set_decommission_jobs WHERE `+where, arg).Scan(
		&job.ID, &job.SetID, &job.Status, &job.PreviousSetStatus, &job.LifecycleGeneration, &job.ExpectedDigest,
		&job.IdempotencyKey, &job.CascadeTenants, &job.AllowOrphan, &job.Attempt, &job.ClaimOwner, &job.ClaimToken, nullableTimeScanner(&job.ClaimLeaseUntil),
		&job.LeaseFingerprint, &job.CapabilityHash, &job.JobUID, &job.Version, &job.LastError, &job.CreatedAt, &job.UpdatedAt,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return SetDecommissionJob{}, false, nil
	}
	if err != nil {
		return SetDecommissionJob{}, false, err
	}
	return job, true, nil
}

func (s *MySQLStore) ListSetDecommissionJobs(ctx context.Context, opts SetDecommissionJobListOptions) ([]SetDecommissionJob, error) {
	query := `
		SELECT id, set_id, status, previous_set_status, lifecycle_generation, expected_digest, idempotency_key,
			cascade_tenants, allow_orphan, attempt, claim_owner, claim_token, claim_lease_until, lease_fingerprint, capability_hash, job_uid,
			version, last_error, created_at, updated_at
		FROM llmgateway_set_decommission_jobs`
	args := []any{}
	if opts.Status != "" {
		query += " WHERE status = ?"
		args = append(args, opts.Status)
	} else if opts.RuntimeOnly {
		query += " WHERE status IN ('pending', 'removing_runtime')"
	} else if opts.NonTerminal {
		query += " WHERE status NOT IN ('succeeded', 'cancelled')"
	}
	query += " ORDER BY created_at DESC, id"
	if opts.Limit > 0 {
		query += " LIMIT ?"
		args = append(args, opts.Limit)
	}
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	jobs := []SetDecommissionJob{}
	for rows.Next() {
		var job SetDecommissionJob
		if err := rows.Scan(&job.ID, &job.SetID, &job.Status, &job.PreviousSetStatus, &job.LifecycleGeneration,
			&job.ExpectedDigest, &job.IdempotencyKey, &job.CascadeTenants, &job.AllowOrphan, &job.Attempt, &job.ClaimOwner, &job.ClaimToken,
			nullableTimeScanner(&job.ClaimLeaseUntil), &job.LeaseFingerprint, &job.CapabilityHash, &job.JobUID,
			&job.Version, &job.LastError,
			&job.CreatedAt, &job.UpdatedAt); err != nil {
			return nil, err
		}
		jobs = append(jobs, job)
	}
	return jobs, rows.Err()
}

func sortTenantDeletionTargets(targets []TenantDeletionTarget) {
	sort.Slice(targets, func(i, j int) bool { return targets[i].ExternalUserID < targets[j].ExternalUserID })
}
