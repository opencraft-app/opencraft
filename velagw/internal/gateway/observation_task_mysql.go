package gateway

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"
)

const tenantObservationTaskColumns = `external_user_id, set_id, status, priority,
	requested_version, processing_version, applied_version, attempts,
	lease_owner, lease_until, next_run_at, last_started_at, last_finished_at,
	last_error, created_at, updated_at`

func (s *MySQLStore) ListTenantObservationSeedTenants(ctx context.Context, afterUserID string, limit int) ([]Tenant, error) {
	if limit <= 0 {
		limit = 1000
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT external_user_id, backend, set_id, status, source, display_name, created_at, updated_at
		FROM llmgateway_tenants
		WHERE backend = ? AND status = ? AND external_user_id > ?
		ORDER BY external_user_id
		LIMIT ?
	`, UserBackendNew, TenantStatusActive, strings.TrimSpace(afterUserID), limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	tenants := []Tenant{}
	for rows.Next() {
		var tenant Tenant
		if err := rows.Scan(&tenant.ExternalUserID, &tenant.Backend, &tenant.SetID, &tenant.Status, &tenant.Source, &tenant.DisplayName, &tenant.CreatedAt, &tenant.UpdatedAt); err != nil {
			return nil, err
		}
		tenants = append(tenants, tenant)
	}
	return tenants, rows.Err()
}

func (s *MySQLStore) EnqueueTenantObservationTask(ctx context.Context, task TenantObservationTask) (TenantObservationTask, error) {
	task.ExternalUserID = strings.TrimSpace(task.ExternalUserID)
	if task.ExternalUserID == "" {
		return TenantObservationTask{}, fmt.Errorf("external user id is required")
	}
	now := time.Now().UTC()
	if task.Priority <= 0 {
		task.Priority = TenantObservationPriorityPeriodic
	}
	if task.NextRunAt.IsZero() {
		task.NextRunAt = now
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return TenantObservationTask{}, err
	}
	defer tx.Rollback()
	if err := rejectDeletingTenantWriteTx(ctx, tx, task.ExternalUserID); err != nil {
		return TenantObservationTask{}, err
	}
	_, err = tx.ExecContext(ctx, `
		INSERT INTO llmgateway_tenant_observation_tasks (
			external_user_id, set_id, status, priority, requested_version,
			processing_version, applied_version, attempts, lease_owner, lease_until,
			next_run_at, last_started_at, last_finished_at, last_error, created_at, updated_at
		) VALUES (?, ?, ?, ?, 1, 0, 0, 0, '', NULL, ?, NULL, NULL, '', ?, ?)
		ON DUPLICATE KEY UPDATE
			set_id = VALUES(set_id),
			priority = GREATEST(priority, VALUES(priority)),
			status = CASE
				WHEN status = ? AND lease_until IS NOT NULL AND lease_until > ? THEN status
				ELSE ?
			END,
			requested_version = requested_version + 1,
			next_run_at = CASE
				WHEN status = ? AND lease_until IS NOT NULL AND lease_until > ? THEN next_run_at
				ELSE VALUES(next_run_at)
			END,
			lease_owner = CASE WHEN status = ? AND lease_until IS NOT NULL AND lease_until > ? THEN lease_owner ELSE '' END,
			lease_until = CASE WHEN status = ? AND lease_until IS NOT NULL AND lease_until > ? THEN lease_until ELSE NULL END,
			last_error = '',
			updated_at = VALUES(updated_at)
	`, task.ExternalUserID, task.SetID, TenantObservationTaskStatusPending, task.Priority, task.NextRunAt, now, now,
		TenantObservationTaskStatusRunning, now, TenantObservationTaskStatusPending,
		TenantObservationTaskStatusRunning, now,
		TenantObservationTaskStatusRunning, now,
		TenantObservationTaskStatusRunning, now)
	if err != nil {
		return TenantObservationTask{}, err
	}
	saved, err := scanTenantObservationTask(tx.QueryRowContext(ctx, `SELECT `+tenantObservationTaskColumns+`
		FROM llmgateway_tenant_observation_tasks WHERE external_user_id = ?`, task.ExternalUserID))
	if err != nil {
		return TenantObservationTask{}, err
	}
	if err := tx.Commit(); err != nil {
		return TenantObservationTask{}, err
	}
	return saved, nil
}

func (s *MySQLStore) SeedTenantObservationTask(ctx context.Context, task TenantObservationTask) (TenantObservationTask, error) {
	task.ExternalUserID = strings.TrimSpace(task.ExternalUserID)
	if task.ExternalUserID == "" {
		return TenantObservationTask{}, fmt.Errorf("external user id is required")
	}
	now := time.Now().UTC()
	if task.Priority <= 0 {
		task.Priority = TenantObservationPriorityPeriodic
	}
	if task.NextRunAt.IsZero() {
		task.NextRunAt = now
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return TenantObservationTask{}, err
	}
	defer tx.Rollback()
	if err := rejectDeletingTenantWriteTx(ctx, tx, task.ExternalUserID); err != nil {
		return TenantObservationTask{}, err
	}
	_, err = tx.ExecContext(ctx, `
		INSERT IGNORE INTO llmgateway_tenant_observation_tasks (
			external_user_id, set_id, status, priority, requested_version,
			processing_version, applied_version, attempts, lease_owner, lease_until,
			next_run_at, last_started_at, last_finished_at, last_error, created_at, updated_at
		) VALUES (?, ?, ?, ?, 1, 0, 0, 0, '', NULL, ?, NULL, NULL, '', ?, ?)
	`, task.ExternalUserID, task.SetID, TenantObservationTaskStatusPending, task.Priority, task.NextRunAt, now, now)
	if err != nil {
		return TenantObservationTask{}, err
	}
	saved, err := scanTenantObservationTask(tx.QueryRowContext(ctx, `SELECT `+tenantObservationTaskColumns+`
		FROM llmgateway_tenant_observation_tasks WHERE external_user_id = ?`, task.ExternalUserID))
	if err != nil {
		return TenantObservationTask{}, err
	}
	if err := tx.Commit(); err != nil {
		return TenantObservationTask{}, err
	}
	return saved, nil
}

func (s *MySQLStore) GetTenantObservationTask(ctx context.Context, externalUserID string) (TenantObservationTask, bool, error) {
	row := s.db.QueryRowContext(ctx, `SELECT `+tenantObservationTaskColumns+`
		FROM llmgateway_tenant_observation_tasks WHERE external_user_id = ?`, strings.TrimSpace(externalUserID))
	task, err := scanTenantObservationTask(row)
	if errors.Is(err, sql.ErrNoRows) {
		return TenantObservationTask{}, false, nil
	}
	if err != nil {
		return TenantObservationTask{}, false, err
	}
	return task, true, nil
}

func (s *MySQLStore) ListTenantObservationTasks(ctx context.Context, opts TenantObservationTaskListOptions) ([]TenantObservationTask, error) {
	now := opts.Now
	if now.IsZero() {
		now = time.Now().UTC()
	}
	query := `SELECT ` + tenantObservationTaskColumns + `
		FROM llmgateway_tenant_observation_tasks
		WHERE (
			(status IN (?, ?, ?) AND (next_run_at IS NULL OR next_run_at <= ?))
			OR (status = ? AND (lease_until IS NULL OR lease_until <= ?))
		)`
	args := []any{TenantObservationTaskStatusPending, TenantObservationTaskStatusError, TenantObservationTaskStatusBlocked, now, TenantObservationTaskStatusRunning, now}
	if len(opts.ExcludeSetIDs) > 0 {
		placeholders := make([]string, 0, len(opts.ExcludeSetIDs))
		for _, setID := range opts.ExcludeSetIDs {
			placeholders = append(placeholders, "?")
			args = append(args, strings.TrimSpace(setID))
		}
		query += " AND set_id NOT IN (" + strings.Join(placeholders, ",") + ")"
	}
	query += " ORDER BY priority DESC, COALESCE(next_run_at, created_at), external_user_id"
	if opts.Limit > 0 {
		query += " LIMIT ?"
		args = append(args, opts.Limit)
	}
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	tasks := []TenantObservationTask{}
	for rows.Next() {
		task, err := scanTenantObservationTask(rows)
		if err != nil {
			return nil, err
		}
		tasks = append(tasks, task)
	}
	return tasks, rows.Err()
}

func (s *MySQLStore) GetTenantObservationTaskStats(ctx context.Context, now time.Time) (TenantObservationQueueStats, error) {
	if now.IsZero() {
		now = time.Now().UTC()
	}
	stats := TenantObservationQueueStats{LastCalculatedAt: now}
	rows, err := s.db.QueryContext(ctx, `SELECT status, COUNT(*) FROM llmgateway_tenant_observation_tasks GROUP BY status`)
	if err != nil {
		return stats, err
	}
	for rows.Next() {
		var status string
		var count int
		if err := rows.Scan(&status, &count); err != nil {
			rows.Close()
			return stats, err
		}
		switch status {
		case TenantObservationTaskStatusPending:
			stats.Pending = count
		case TenantObservationTaskStatusRunning:
			stats.Running = count
		case TenantObservationTaskStatusError:
			stats.Error = count
		case TenantObservationTaskStatusBlocked:
			stats.Blocked = count
		}
	}
	if err := rows.Close(); err != nil {
		return stats, err
	}
	var oldest sql.NullTime
	if err := s.db.QueryRowContext(ctx, `
		SELECT COUNT(*), MIN(COALESCE(next_run_at, created_at))
		FROM llmgateway_tenant_observation_tasks
		WHERE status IN (?, ?, ?) AND (next_run_at IS NULL OR next_run_at <= ?)
	`, TenantObservationTaskStatusPending, TenantObservationTaskStatusError, TenantObservationTaskStatusBlocked, now).Scan(&stats.Due, &oldest); err != nil {
		return stats, err
	}
	if oldest.Valid {
		stats.OldestDueAt = oldest.Time.UTC()
		stats.OldestDueAgeSeconds = nonNegativeSeconds(now.Sub(stats.OldestDueAt))
	}
	if err := s.db.QueryRowContext(ctx, `
		SELECT COUNT(*) FROM llmgateway_tenant_observation_tasks
		WHERE status = ? AND (lease_until IS NULL OR lease_until <= ?)
	`, TenantObservationTaskStatusRunning, now).Scan(&stats.ExpiredRunningLeases); err != nil {
		return stats, err
	}
	var lastSuccess, lastFailure sql.NullTime
	if err := s.db.QueryRowContext(ctx, `
		SELECT
			MAX(CASE WHEN applied_version > 0 AND last_error = '' THEN last_finished_at END),
			MAX(CASE WHEN status = ? THEN last_finished_at END)
		FROM llmgateway_tenant_observation_tasks
	`, TenantObservationTaskStatusError).Scan(&lastSuccess, &lastFailure); err != nil {
		return stats, err
	}
	if lastSuccess.Valid {
		stats.LastSuccessAt = lastSuccess.Time.UTC()
	}
	if lastFailure.Valid {
		stats.LastFailureAt = lastFailure.Time.UTC()
	}
	return stats, nil
}

func (s *MySQLStore) TryAcquireTenantObservationTask(ctx context.Context, externalUserID string, owner string, ttl time.Duration, now time.Time) (TenantObservationTask, bool, error) {
	externalUserID = strings.TrimSpace(externalUserID)
	owner = strings.TrimSpace(owner)
	if externalUserID == "" || owner == "" || ttl <= 0 {
		return TenantObservationTask{}, false, fmt.Errorf("tenant observation task acquire requires user, owner and ttl")
	}
	if now.IsZero() {
		now = time.Now().UTC()
	}
	result, err := s.db.ExecContext(ctx, `
		UPDATE llmgateway_tenant_observation_tasks
		SET status = ?, lease_owner = ?, lease_until = ?, processing_version = requested_version,
			last_started_at = ?, updated_at = ?
		WHERE external_user_id = ?
			AND ((status IN (?, ?, ?) AND (next_run_at IS NULL OR next_run_at <= ?))
				OR (status = ? AND (lease_until IS NULL OR lease_until <= ? OR lease_owner = ?)))
	`, TenantObservationTaskStatusRunning, owner, now.Add(ttl), now, now, externalUserID,
		TenantObservationTaskStatusPending, TenantObservationTaskStatusError, TenantObservationTaskStatusBlocked, now,
		TenantObservationTaskStatusRunning, now, owner)
	if err != nil {
		return TenantObservationTask{}, false, err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return TenantObservationTask{}, false, err
	}
	task, ok, err := s.GetTenantObservationTask(ctx, externalUserID)
	if err != nil || !ok {
		return task, false, err
	}
	return task, affected == 1 && task.LeaseOwner == owner && task.Status == TenantObservationTaskStatusRunning, nil
}

func (s *MySQLStore) RenewTenantObservationTaskLease(ctx context.Context, task TenantObservationTask, ttl time.Duration, now time.Time) (bool, error) {
	if now.IsZero() {
		now = time.Now().UTC()
	}
	result, err := s.db.ExecContext(ctx, `
		UPDATE llmgateway_tenant_observation_tasks
		SET lease_until = ?, updated_at = ?
		WHERE external_user_id = ? AND status = ? AND lease_owner = ?
			AND processing_version = ? AND lease_until > ?
	`, now.Add(ttl), now, task.ExternalUserID, TenantObservationTaskStatusRunning, task.LeaseOwner, task.ProcessingVersion, now)
	if err != nil {
		return false, err
	}
	affected, err := result.RowsAffected()
	return affected == 1, err
}

func (s *MySQLStore) ReleaseTenantObservationTaskLease(ctx context.Context, task TenantObservationTask, now time.Time) (bool, error) {
	if now.IsZero() {
		now = time.Now().UTC()
	}
	result, err := s.db.ExecContext(ctx, `
		UPDATE llmgateway_tenant_observation_tasks
		SET status = ?, lease_owner = '', lease_until = NULL, next_run_at = ?, updated_at = ?
		WHERE external_user_id = ? AND status = ? AND lease_owner = ? AND processing_version = ?
	`, TenantObservationTaskStatusPending, now, now, task.ExternalUserID, TenantObservationTaskStatusRunning, task.LeaseOwner, task.ProcessingVersion)
	if err != nil {
		return false, err
	}
	affected, err := result.RowsAffected()
	return affected == 1, err
}

func (s *MySQLStore) CompleteTenantObservationTask(ctx context.Context, task TenantObservationTask, completion TenantObservationTaskCompletion, now time.Time) (TenantObservationTask, error) {
	if now.IsZero() {
		now = time.Now().UTC()
	}
	desiredStatus := TenantObservationTaskStatusError
	if completion.Succeeded {
		desiredStatus = TenantObservationTaskStatusPending
	} else if completion.Blocked {
		desiredStatus = TenantObservationTaskStatusBlocked
	}
	if completion.NextRunAt.IsZero() {
		completion.NextRunAt = now.Add(tenantObservationBackoff(task.Attempts + 1))
	}
	result, err := s.db.ExecContext(ctx, `
		UPDATE llmgateway_tenant_observation_tasks
		SET status = CASE WHEN requested_version > ? THEN ? ELSE ? END,
			applied_version = CASE WHEN ? THEN ? ELSE applied_version END,
			attempts = CASE
				WHEN requested_version > ? THEN attempts
				WHEN ? THEN 0
				WHEN ? THEN attempts
				ELSE attempts + 1
			END,
			priority = CASE
				WHEN requested_version > ? THEN priority
				WHEN ? OR ? THEN ?
				ELSE priority
			END,
			lease_owner = '', lease_until = NULL,
			next_run_at = CASE WHEN requested_version > ? THEN ? ELSE ? END,
			last_finished_at = ?,
			last_error = CASE WHEN requested_version > ? OR ? THEN '' ELSE ? END,
			updated_at = ?
		WHERE external_user_id = ? AND processing_version = ? AND status = ?
			AND lease_owner = ? AND lease_until > ?
	`, task.ProcessingVersion, TenantObservationTaskStatusPending, desiredStatus,
		completion.Succeeded, task.ProcessingVersion,
		task.ProcessingVersion, completion.Succeeded, completion.Blocked,
		task.ProcessingVersion, completion.Succeeded, completion.Blocked, TenantObservationPriorityPeriodic,
		task.ProcessingVersion, now, completion.NextRunAt,
		now, task.ProcessingVersion, completion.Succeeded, completion.Message, now,
		task.ExternalUserID, task.ProcessingVersion, TenantObservationTaskStatusRunning, task.LeaseOwner, now)
	if err != nil {
		return TenantObservationTask{}, err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return TenantObservationTask{}, err
	}
	if affected != 1 {
		return TenantObservationTask{}, ErrTenantObservationTaskLeaseLost
	}
	saved, ok, err := s.GetTenantObservationTask(ctx, task.ExternalUserID)
	if err != nil {
		return TenantObservationTask{}, err
	}
	if !ok {
		return TenantObservationTask{}, fmt.Errorf("tenant observation task for user %q not found after completion", task.ExternalUserID)
	}
	return saved, nil
}

func scanTenantObservationTask(row scanner) (TenantObservationTask, error) {
	var task TenantObservationTask
	var leaseUntil, nextRunAt, lastStartedAt, lastFinishedAt sql.NullTime
	err := row.Scan(
		&task.ExternalUserID, &task.SetID, &task.Status, &task.Priority,
		&task.RequestedVersion, &task.ProcessingVersion, &task.AppliedVersion, &task.Attempts,
		&task.LeaseOwner, &leaseUntil, &nextRunAt, &lastStartedAt, &lastFinishedAt,
		&task.LastError, &task.CreatedAt, &task.UpdatedAt,
	)
	if err != nil {
		return TenantObservationTask{}, err
	}
	if leaseUntil.Valid {
		task.LeaseUntil = leaseUntil.Time.UTC()
	}
	if nextRunAt.Valid {
		task.NextRunAt = nextRunAt.Time.UTC()
	}
	if lastStartedAt.Valid {
		task.LastStartedAt = lastStartedAt.Time.UTC()
	}
	if lastFinishedAt.Valid {
		task.LastFinishedAt = lastFinishedAt.Time.UTC()
	}
	task.CreatedAt = task.CreatedAt.UTC()
	task.UpdatedAt = task.UpdatedAt.UTC()
	return task, nil
}
