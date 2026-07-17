package gateway

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

func (s *MySQLStore) ListAPIKeyBindingsByUser(ctx context.Context, userID string) ([]APIKeyBinding, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT external_key_id, external_key, external_key_hash, purpose, set_id, user_id, upstream_key, upstream_key_id, created_at
		FROM llmgateway_api_key_bindings
		WHERE user_id = ?
		ORDER BY created_at DESC, external_key_id
	`, strings.TrimSpace(userID))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	bindings := []APIKeyBinding{}
	for rows.Next() {
		binding, err := scanAPIKeyBinding(rows)
		if err != nil {
			return nil, err
		}
		bindings = append(bindings, binding)
	}
	return bindings, rows.Err()
}

func (s *MySQLStore) ListAPIKeyBindingsBySet(ctx context.Context, setID string) ([]APIKeyBinding, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT external_key_id, external_key, external_key_hash, purpose, set_id, user_id, upstream_key, upstream_key_id, created_at
		FROM llmgateway_api_key_bindings
		WHERE set_id = ?
		ORDER BY created_at DESC, external_key_id
	`, strings.TrimSpace(setID))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	bindings := []APIKeyBinding{}
	for rows.Next() {
		binding, err := scanAPIKeyBinding(rows)
		if err != nil {
			return nil, err
		}
		bindings = append(bindings, binding)
	}
	return bindings, rows.Err()
}

func (s *MySQLStore) ListUserLLMSettings(ctx context.Context) ([]UserLLMSettings, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT external_user_id, routing_mode, byok_group, byok_upstream_key,
			byok_upstream_key_id, providers_json, last_synced_at, last_sync_error,
			created_at, updated_at
		FROM llmgateway_user_llm_settings
		ORDER BY updated_at DESC, external_user_id
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	settings := []UserLLMSettings{}
	for rows.Next() {
		item, err := scanUserLLMSettings(rows)
		if err != nil {
			return nil, err
		}
		settings = append(settings, item)
	}
	return settings, rows.Err()
}

func (s *MySQLStore) EnqueueBYOKSyncTask(ctx context.Context, task BYOKSyncTask) (BYOKSyncTask, error) {
	task.ExternalUserID = strings.TrimSpace(task.ExternalUserID)
	if task.ExternalUserID == "" {
		return BYOKSyncTask{}, fmt.Errorf("external user id is required")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return BYOKSyncTask{}, err
	}
	defer tx.Rollback()
	if err := rejectDeletingTenantWriteTx(ctx, tx, task.ExternalUserID); err != nil {
		return BYOKSyncTask{}, err
	}
	saved, err := enqueueBYOKSyncTaskTx(ctx, tx, task, time.Now().UTC())
	if err != nil {
		return BYOKSyncTask{}, err
	}
	return saved, tx.Commit()
}

func (s *MySQLStore) GetBYOKSyncTask(ctx context.Context, externalUserID string) (BYOKSyncTask, bool, error) {
	row := s.db.QueryRowContext(ctx, `
		SELECT external_user_id, set_id, status, requested_version, processing_version,
			applied_version, attempts, lease_owner, lease_until, next_run_at,
			last_started_at, last_finished_at, last_error, created_at, updated_at
		FROM llmgateway_byok_sync_tasks WHERE external_user_id = ?
	`, strings.TrimSpace(externalUserID))
	task, err := scanBYOKSyncTask(row)
	if errors.Is(err, sql.ErrNoRows) {
		return BYOKSyncTask{}, false, nil
	}
	if err != nil {
		return BYOKSyncTask{}, false, err
	}
	return task, true, nil
}

func (s *MySQLStore) ListBYOKSyncTasks(ctx context.Context, opts BYOKSyncTaskListOptions) ([]BYOKSyncTask, error) {
	now := opts.Now
	if now.IsZero() {
		now = time.Now().UTC()
	}
	query := `
		SELECT external_user_id, set_id, status, requested_version, processing_version,
			applied_version, attempts, lease_owner, lease_until, next_run_at,
			last_started_at, last_finished_at, last_error, created_at, updated_at
		FROM llmgateway_byok_sync_tasks`
	args := []any{}
	clauses := []string{}
	if strings.TrimSpace(opts.Status) != "" {
		clauses = append(clauses, "status = ?")
		args = append(args, strings.TrimSpace(opts.Status))
	}
	if len(opts.ExcludeSetIDs) > 0 {
		placeholders := make([]string, 0, len(opts.ExcludeSetIDs))
		for _, setID := range opts.ExcludeSetIDs {
			placeholders = append(placeholders, "?")
			args = append(args, strings.TrimSpace(setID))
		}
		clauses = append(clauses, "set_id NOT IN ("+strings.Join(placeholders, ",")+")")
	}
	clauses = append(clauses, `(
		(status IN (?, ?) AND (next_run_at IS NULL OR next_run_at <= ?))
		OR (status = ? AND (lease_until IS NULL OR lease_until <= ?))
	)`)
	args = append(args, BYOKSyncTaskStatusPending, BYOKSyncTaskStatusError, now, BYOKSyncTaskStatusRunning, now)
	if len(clauses) > 0 {
		query += " WHERE " + strings.Join(clauses, " AND ")
	}
	query += " ORDER BY COALESCE(next_run_at, created_at), external_user_id"
	if opts.Limit > 0 {
		query += " LIMIT ?"
		args = append(args, opts.Limit)
	}
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	tasks := []BYOKSyncTask{}
	for rows.Next() {
		task, err := scanBYOKSyncTask(rows)
		if err != nil {
			return nil, err
		}
		tasks = append(tasks, task)
	}
	return tasks, rows.Err()
}

func (s *MySQLStore) GetBYOKSyncTaskStats(ctx context.Context, now time.Time) (BYOKSyncQueueStats, error) {
	if now.IsZero() {
		now = time.Now().UTC()
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT status, COUNT(*), MIN(COALESCE(next_run_at, created_at))
		FROM llmgateway_byok_sync_tasks
		GROUP BY status
	`)
	if err != nil {
		return BYOKSyncQueueStats{}, err
	}
	defer rows.Close()
	stats := BYOKSyncQueueStats{LastCalculatedAt: now}
	for rows.Next() {
		var status string
		var count int
		var oldest sql.NullTime
		if err := rows.Scan(&status, &count, &oldest); err != nil {
			return BYOKSyncQueueStats{}, err
		}
		switch status {
		case BYOKSyncTaskStatusPending:
			stats.Pending = count
			if oldest.Valid {
				stats.OldestPendingAt = oldest.Time
				stats.OldestPendingAgeSeconds = nonNegativeSeconds(now.Sub(oldest.Time))
			}
		case BYOKSyncTaskStatusRunning:
			stats.Running = count
		case BYOKSyncTaskStatusError:
			stats.Error = count
			if oldest.Valid {
				stats.OldestErrorAt = oldest.Time
				stats.OldestErrorAgeSeconds = nonNegativeSeconds(now.Sub(oldest.Time))
			}
		case BYOKSyncTaskStatusSucceeded:
			stats.Succeeded = count
		}
	}
	if err := rows.Err(); err != nil {
		return BYOKSyncQueueStats{}, err
	}
	if err := s.db.QueryRowContext(ctx, `
		SELECT COUNT(*)
		FROM llmgateway_byok_sync_tasks
		WHERE status = ? AND lease_until IS NOT NULL AND lease_until <= ?
	`, BYOKSyncTaskStatusRunning, now).Scan(&stats.ExpiredRunningLeases); err != nil {
		return BYOKSyncQueueStats{}, err
	}
	var lastSuccess, lastFailure sql.NullTime
	if err := s.db.QueryRowContext(ctx, `
		SELECT
			MAX(CASE WHEN applied_version > 0 AND last_error = '' THEN last_finished_at END),
			MAX(CASE WHEN last_error <> '' THEN last_finished_at END)
		FROM llmgateway_byok_sync_tasks
	`).Scan(&lastSuccess, &lastFailure); err != nil {
		return BYOKSyncQueueStats{}, err
	}
	if lastSuccess.Valid {
		stats.LastSuccessAt = lastSuccess.Time.UTC()
	}
	if lastFailure.Valid {
		stats.LastFailureAt = lastFailure.Time.UTC()
	}
	stats.TotalOpen = stats.Pending + stats.Running + stats.Error
	return stats, nil
}

func (s *MySQLStore) TryAcquireBYOKSyncTask(ctx context.Context, externalUserID string, owner string, ttl time.Duration, now time.Time) (BYOKSyncTask, bool, error) {
	externalUserID = strings.TrimSpace(externalUserID)
	owner = strings.TrimSpace(owner)
	if externalUserID == "" || owner == "" {
		return BYOKSyncTask{}, false, fmt.Errorf("external user id and owner are required")
	}
	if now.IsZero() {
		now = time.Now().UTC()
	}
	res, err := s.db.ExecContext(ctx, `
		UPDATE llmgateway_byok_sync_tasks
		SET status = ?, lease_owner = ?, lease_until = ?, processing_version = requested_version,
			last_started_at = ?, updated_at = ?
		WHERE external_user_id = ?
			AND (next_run_at IS NULL OR next_run_at <= ?)
			AND NOT (status = ? AND applied_version >= requested_version)
			AND (status IN (?, ?) OR (status = ? AND (lease_until IS NULL OR lease_until <= ? OR lease_owner = ?)))
	`, BYOKSyncTaskStatusRunning, owner, now.Add(ttl), now, now, externalUserID, now,
		BYOKSyncTaskStatusSucceeded, BYOKSyncTaskStatusPending, BYOKSyncTaskStatusError,
		BYOKSyncTaskStatusRunning, now, owner)
	if err != nil {
		return BYOKSyncTask{}, false, err
	}
	affected, err := res.RowsAffected()
	if err != nil {
		return BYOKSyncTask{}, false, err
	}
	task, ok, err := s.GetBYOKSyncTask(ctx, externalUserID)
	if err != nil || !ok {
		return task, false, err
	}
	return task, affected > 0 && task.LeaseOwner == owner && task.Status == BYOKSyncTaskStatusRunning, nil
}

func (s *MySQLStore) RenewBYOKSyncTaskLease(ctx context.Context, task BYOKSyncTask, ttl time.Duration, now time.Time) (bool, error) {
	if strings.TrimSpace(task.ExternalUserID) == "" || strings.TrimSpace(task.LeaseOwner) == "" || ttl <= 0 {
		return false, fmt.Errorf("byok sync task renewal requires user, owner and ttl")
	}
	if now.IsZero() {
		now = time.Now().UTC()
	}
	result, err := s.db.ExecContext(ctx, `
		UPDATE llmgateway_byok_sync_tasks
		SET lease_until = ?, updated_at = ?
		WHERE external_user_id = ? AND status = ? AND lease_owner = ?
			AND processing_version = ? AND lease_until > ?
	`, now.Add(ttl), now, task.ExternalUserID, BYOKSyncTaskStatusRunning, task.LeaseOwner, task.ProcessingVersion, now)
	if err != nil {
		return false, err
	}
	affected, err := result.RowsAffected()
	return affected == 1, err
}

func (s *MySQLStore) ReleaseBYOKSyncTaskLease(ctx context.Context, task BYOKSyncTask, now time.Time) (bool, error) {
	if now.IsZero() {
		now = time.Now().UTC()
	}
	result, err := s.db.ExecContext(ctx, `
		UPDATE llmgateway_byok_sync_tasks
		SET status = ?, lease_owner = '', lease_until = NULL, next_run_at = ?, updated_at = ?
		WHERE external_user_id = ? AND status = ? AND lease_owner = ? AND processing_version = ?
	`, BYOKSyncTaskStatusPending, now, now, task.ExternalUserID, BYOKSyncTaskStatusRunning, task.LeaseOwner, task.ProcessingVersion)
	if err != nil {
		return false, err
	}
	affected, err := result.RowsAffected()
	return affected == 1, err
}

func (s *MySQLStore) CompleteBYOKSyncTask(ctx context.Context, task BYOKSyncTask, success bool, message string, now time.Time) (BYOKSyncTask, error) {
	task.ExternalUserID = strings.TrimSpace(task.ExternalUserID)
	if task.ExternalUserID == "" {
		return BYOKSyncTask{}, fmt.Errorf("external user id is required")
	}
	if now.IsZero() {
		now = time.Now().UTC()
	}
	var result sql.Result
	var err error
	if success {
		result, err = s.db.ExecContext(ctx, `
			UPDATE llmgateway_byok_sync_tasks
			SET status = CASE WHEN requested_version > ? THEN ? ELSE ? END,
				applied_version = ?,
				lease_owner = '',
				lease_until = NULL,
				next_run_at = CASE WHEN requested_version > ? THEN ? ELSE NULL END,
				last_finished_at = ?,
				last_error = '',
				updated_at = ?
			WHERE external_user_id = ? AND processing_version = ? AND status = ?
				AND lease_owner = ? AND lease_until > ?
		`, task.ProcessingVersion, BYOKSyncTaskStatusPending, BYOKSyncTaskStatusSucceeded,
			task.ProcessingVersion, task.ProcessingVersion, now, now, now, task.ExternalUserID, task.ProcessingVersion,
			BYOKSyncTaskStatusRunning, task.LeaseOwner, now)
		if err != nil {
			return BYOKSyncTask{}, err
		}
	} else {
		nextRun := now.Add(byokSyncBackoff(task.Attempts + 1))
		result, err = s.db.ExecContext(ctx, `
			UPDATE llmgateway_byok_sync_tasks
			SET status = CASE WHEN requested_version > ? THEN ? ELSE ? END,
				attempts = attempts + 1,
				lease_owner = '',
				lease_until = NULL,
				next_run_at = CASE WHEN requested_version > ? THEN ? ELSE ? END,
				last_finished_at = ?,
				last_error = ?,
				updated_at = ?
			WHERE external_user_id = ? AND processing_version = ? AND status = ?
				AND lease_owner = ? AND lease_until > ?
		`, task.ProcessingVersion, BYOKSyncTaskStatusPending, BYOKSyncTaskStatusError,
			task.ProcessingVersion, now, nextRun, now, message, now, task.ExternalUserID, task.ProcessingVersion,
			BYOKSyncTaskStatusRunning, task.LeaseOwner, now)
		if err != nil {
			return BYOKSyncTask{}, err
		}
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return BYOKSyncTask{}, err
	}
	if affected != 1 {
		return BYOKSyncTask{}, ErrBYOKSyncTaskLeaseLost
	}
	saved, ok, err := s.GetBYOKSyncTask(ctx, task.ExternalUserID)
	if err != nil {
		return BYOKSyncTask{}, err
	}
	if !ok {
		return BYOKSyncTask{}, fmt.Errorf("byok sync task for user %q not found after complete", task.ExternalUserID)
	}
	return saved, nil
}

func (s *MySQLStore) RequeueFailedBYOKSyncTasks(ctx context.Context, limit int, now time.Time) (int, error) {
	if now.IsZero() {
		now = time.Now().UTC()
	}
	if limit <= 0 {
		limit = defaultBYOKSyncBatchSize
	}
	result, err := s.db.ExecContext(ctx, `
		UPDATE llmgateway_byok_sync_tasks
		SET status = ?, next_run_at = ?, updated_at = ?
		WHERE status = ?
		ORDER BY COALESCE(next_run_at, created_at), external_user_id
		LIMIT ?
	`, BYOKSyncTaskStatusPending, now, now, BYOKSyncTaskStatusError, limit)
	if err != nil {
		return 0, err
	}
	affected, err := result.RowsAffected()
	return int(affected), err
}

func (s *MySQLStore) SaveChannelBundleRevision(ctx context.Context, revision ChannelBundleRevision) error {
	if strings.TrimSpace(revision.BundleID) == "" || strings.TrimSpace(revision.RevisionID) == "" {
		return fmt.Errorf("channel bundle revision id and bundle id are required")
	}
	specJSON, err := marshalChannelBundleSpecForStorage(revision.Spec)
	if err != nil {
		return err
	}
	if revision.CreatedAt.IsZero() {
		revision.CreatedAt = time.Now().UTC()
	}
	if revision.Version <= 0 {
		if err := s.db.QueryRowContext(ctx, `
			SELECT COALESCE(MAX(version), 0) + 1
			FROM llmgateway_channel_bundle_revisions
			WHERE bundle_id = ?
		`, revision.BundleID).Scan(&revision.Version); err != nil {
			return err
		}
	}
	_, err = s.db.ExecContext(ctx, `
		INSERT INTO llmgateway_channel_bundle_revisions (
			revision_id, bundle_id, version, name, description, source_set_id,
			spec_json, fingerprint, created_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON DUPLICATE KEY UPDATE revision_id = revision_id
	`, revision.RevisionID, revision.BundleID, revision.Version, revision.Name, revision.Description,
		revision.SourceSetID, specJSON, revision.Fingerprint, revision.CreatedAt)
	return err
}

func (s *MySQLStore) GetChannelBundleRevision(ctx context.Context, bundleID string, revisionID string) (ChannelBundleRevision, bool, error) {
	row := s.db.QueryRowContext(ctx, `
		SELECT revision_id, bundle_id, version, name, description, source_set_id,
			spec_json, fingerprint, created_at
		FROM llmgateway_channel_bundle_revisions
		WHERE bundle_id = ? AND revision_id = ?
	`, bundleID, revisionID)
	revision, err := scanChannelBundleRevision(row)
	if errors.Is(err, sql.ErrNoRows) {
		return ChannelBundleRevision{}, false, nil
	}
	if err != nil {
		return ChannelBundleRevision{}, false, err
	}
	return revision, true, nil
}

func (s *MySQLStore) ListChannelBundleRevisions(ctx context.Context, bundleID string) ([]ChannelBundleRevision, error) {
	query := `
		SELECT revision_id, bundle_id, version, name, description, source_set_id,
			spec_json, fingerprint, created_at
		FROM llmgateway_channel_bundle_revisions`
	args := []any{}
	if strings.TrimSpace(bundleID) != "" {
		query += ` WHERE bundle_id = ?`
		args = append(args, strings.TrimSpace(bundleID))
	}
	query += ` ORDER BY bundle_id, version DESC, revision_id DESC`
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	revisions := []ChannelBundleRevision{}
	for rows.Next() {
		revision, err := scanChannelBundleRevision(rows)
		if err != nil {
			return nil, err
		}
		revisions = append(revisions, revision)
	}
	return revisions, rows.Err()
}

func (s *MySQLStore) SaveChannelBundleRelease(ctx context.Context, run ChannelBundleReleaseRun) error {
	if strings.TrimSpace(run.ID) == "" || strings.TrimSpace(run.BundleID) == "" {
		return fmt.Errorf("channel bundle release id and bundle id are required")
	}
	itemsJSON, err := json.Marshal(run.Items)
	if err != nil {
		return err
	}
	if run.CreatedAt.IsZero() {
		run.CreatedAt = time.Now().UTC()
	}
	_, err = s.db.ExecContext(ctx, `
		INSERT INTO llmgateway_channel_bundle_releases (
			id, bundle_id, revision_id, fingerprint, status, force_drift, stop_on_failure,
			triggered_by, last_error, items_json, created_at, started_at, finished_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON DUPLICATE KEY UPDATE
			status = VALUES(status),
			force_drift = VALUES(force_drift),
			stop_on_failure = VALUES(stop_on_failure),
			triggered_by = VALUES(triggered_by),
			last_error = VALUES(last_error),
			items_json = VALUES(items_json),
			started_at = VALUES(started_at),
			finished_at = VALUES(finished_at)
	`, run.ID, run.BundleID, run.RevisionID, run.Fingerprint, run.Status, run.ForceDrift, run.StopOnFailure,
		run.TriggeredBy, run.LastError, string(itemsJSON), run.CreatedAt, nullableTime(run.StartedAt), nullableTime(run.FinishedAt))
	return err
}

func (s *MySQLStore) GetChannelBundleRelease(ctx context.Context, id string) (ChannelBundleReleaseRun, bool, error) {
	row := s.db.QueryRowContext(ctx, `
		SELECT id, bundle_id, revision_id, fingerprint, status, force_drift, stop_on_failure,
			triggered_by, last_error, items_json, created_at, started_at, finished_at
		FROM llmgateway_channel_bundle_releases
		WHERE id = ?
	`, strings.TrimSpace(id))
	run, err := scanChannelBundleReleaseRun(row)
	if errors.Is(err, sql.ErrNoRows) {
		return ChannelBundleReleaseRun{}, false, nil
	}
	if err != nil {
		return ChannelBundleReleaseRun{}, false, err
	}
	return run, true, nil
}

func (s *MySQLStore) ListChannelBundleReleases(ctx context.Context, bundleID string) ([]ChannelBundleReleaseRun, error) {
	query := `
		SELECT id, bundle_id, revision_id, fingerprint, status, force_drift, stop_on_failure,
			triggered_by, last_error, items_json, created_at, started_at, finished_at
		FROM llmgateway_channel_bundle_releases`
	args := []any{}
	if strings.TrimSpace(bundleID) != "" {
		query += ` WHERE bundle_id = ?`
		args = append(args, strings.TrimSpace(bundleID))
	}
	query += ` ORDER BY created_at DESC, id DESC`
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	runs := []ChannelBundleReleaseRun{}
	for rows.Next() {
		run, err := scanChannelBundleReleaseRun(rows)
		if err != nil {
			return nil, err
		}
		runs = append(runs, run)
	}
	return runs, rows.Err()
}

func (s *MySQLStore) TryAcquireChannelBundleLock(ctx context.Context, bundleID string, owner string, purpose string, ttl time.Duration, now time.Time) (ChannelBundleLock, bool, error) {
	bundleID = strings.TrimSpace(bundleID)
	owner = strings.TrimSpace(owner)
	purpose = strings.TrimSpace(purpose)
	if bundleID == "" || owner == "" {
		return ChannelBundleLock{}, false, fmt.Errorf("channel bundle lock bundle id and owner are required")
	}
	if ttl <= 0 {
		ttl = 30 * time.Minute
	}
	if now.IsZero() {
		now = time.Now().UTC()
	}
	now = now.UTC()
	leaseUntil := now.Add(ttl)

	result, err := s.db.ExecContext(ctx, `
		UPDATE llmgateway_channel_bundle_locks
		SET owner = ?, purpose = ?, lease_until = ?, updated_at = ?
		WHERE bundle_id = ? AND (lease_until <= ? OR owner = ?)
	`, owner, purpose, leaseUntil, now, bundleID, now, owner)
	if err != nil {
		return ChannelBundleLock{}, false, err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return ChannelBundleLock{}, false, err
	}
	if affected > 0 {
		return ChannelBundleLock{BundleID: bundleID, Owner: owner, Purpose: purpose, LeaseUntil: leaseUntil, UpdatedAt: now}, true, nil
	}

	_, err = s.db.ExecContext(ctx, `
		INSERT INTO llmgateway_channel_bundle_locks (
			bundle_id, owner, purpose, lease_until, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?)
	`, bundleID, owner, purpose, leaseUntil, now, now)
	if err == nil {
		return ChannelBundleLock{BundleID: bundleID, Owner: owner, Purpose: purpose, LeaseUntil: leaseUntil, CreatedAt: now, UpdatedAt: now}, true, nil
	}
	if !isMySQLDuplicateKeyError(err) {
		return ChannelBundleLock{}, false, err
	}
	lock, ok, getErr := s.getChannelBundleLock(ctx, bundleID)
	if getErr != nil {
		return ChannelBundleLock{}, false, getErr
	}
	return lock, ok && lock.Owner == owner && lock.LeaseUntil.After(now), nil
}

func (s *MySQLStore) ReleaseChannelBundleLock(ctx context.Context, bundleID string, owner string) error {
	bundleID = strings.TrimSpace(bundleID)
	owner = strings.TrimSpace(owner)
	if bundleID == "" || owner == "" {
		return nil
	}
	_, err := s.db.ExecContext(ctx, `
		DELETE FROM llmgateway_channel_bundle_locks
		WHERE bundle_id = ? AND owner = ?
	`, bundleID, owner)
	return err
}

func (s *MySQLStore) getChannelBundleLock(ctx context.Context, bundleID string) (ChannelBundleLock, bool, error) {
	row := s.db.QueryRowContext(ctx, `
		SELECT bundle_id, owner, purpose, lease_until, created_at, updated_at
		FROM llmgateway_channel_bundle_locks
		WHERE bundle_id = ?
	`, strings.TrimSpace(bundleID))
	var lock ChannelBundleLock
	if err := row.Scan(&lock.BundleID, &lock.Owner, &lock.Purpose, &lock.LeaseUntil, &lock.CreatedAt, &lock.UpdatedAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ChannelBundleLock{}, false, nil
		}
		return ChannelBundleLock{}, false, err
	}
	lock.LeaseUntil = lock.LeaseUntil.UTC()
	lock.CreatedAt = lock.CreatedAt.UTC()
	lock.UpdatedAt = lock.UpdatedAt.UTC()
	return lock, true, nil
}

func (s *MySQLStore) SaveWorkerJob(ctx context.Context, job WorkerJob) error {
	if strings.TrimSpace(job.Name) == "" {
		return fmt.Errorf("job name is required")
	}
	now := time.Now().UTC()
	if existing, ok, err := s.GetWorkerJob(ctx, job.Name); err != nil {
		return err
	} else if ok {
		job.CreatedAt = existing.CreatedAt
		if job.Kind == "" {
			job.Kind = existing.Kind
		}
		if job.IntervalSeconds == 0 {
			job.IntervalSeconds = existing.IntervalSeconds
		}
		if job.Status == "" {
			job.Status = existing.Status
		}
	} else if job.CreatedAt.IsZero() {
		job.CreatedAt = now
	}
	if job.Status == "" {
		job.Status = WorkerJobStatusIdle
	}
	job.UpdatedAt = now
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO llmgateway_worker_jobs (
			name, kind, enabled, interval_seconds, status, lease_owner, lease_until,
			last_started_at, last_finished_at, last_success_at, next_run_at,
			scan_cursor, last_error, failure_count, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON DUPLICATE KEY UPDATE
			kind = VALUES(kind),
			enabled = VALUES(enabled),
			interval_seconds = VALUES(interval_seconds),
			status = VALUES(status),
			lease_owner = VALUES(lease_owner),
			lease_until = VALUES(lease_until),
			last_started_at = VALUES(last_started_at),
			last_finished_at = VALUES(last_finished_at),
			last_success_at = VALUES(last_success_at),
			next_run_at = VALUES(next_run_at),
			scan_cursor = VALUES(scan_cursor),
			last_error = VALUES(last_error),
			failure_count = VALUES(failure_count),
			updated_at = VALUES(updated_at)
	`, job.Name, job.Kind, job.Enabled, job.IntervalSeconds, job.Status, job.LeaseOwner, nullableTime(job.LeaseUntil),
		nullableTime(job.LastStartedAt), nullableTime(job.LastFinishedAt), nullableTime(job.LastSuccessAt), nullableTime(job.NextRunAt),
		job.Cursor, job.LastError, job.FailureCount, job.CreatedAt, job.UpdatedAt)
	return err
}

func (s *MySQLStore) GetWorkerJob(ctx context.Context, name string) (WorkerJob, bool, error) {
	row := s.db.QueryRowContext(ctx, `
		SELECT name, kind, enabled, interval_seconds, status, lease_owner, lease_until,
			last_started_at, last_finished_at, last_success_at, next_run_at,
			COALESCE(scan_cursor, ''), last_error, failure_count, created_at, updated_at
		FROM llmgateway_worker_jobs
		WHERE name = ?
	`, strings.TrimSpace(name))
	job, err := scanWorkerJob(row)
	if errors.Is(err, sql.ErrNoRows) {
		return WorkerJob{}, false, nil
	}
	if err != nil {
		return WorkerJob{}, false, err
	}
	return job, true, nil
}

func (s *MySQLStore) ListWorkerJobs(ctx context.Context, opts WorkerJobListOptions) ([]WorkerJob, error) {
	query := `
		SELECT name, kind, enabled, interval_seconds, status, lease_owner, lease_until,
			last_started_at, last_finished_at, last_success_at, next_run_at,
			COALESCE(scan_cursor, ''), last_error, failure_count, created_at, updated_at
		FROM llmgateway_worker_jobs`
	if opts.EnabledOnly {
		query += ` WHERE enabled = TRUE`
	}
	query += ` ORDER BY name`
	rows, err := s.db.QueryContext(ctx, query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	jobs := []WorkerJob{}
	for rows.Next() {
		job, err := scanWorkerJob(rows)
		if err != nil {
			return nil, err
		}
		jobs = append(jobs, job)
	}
	return jobs, rows.Err()
}

func (s *MySQLStore) TryAcquireWorkerJobLease(ctx context.Context, name string, owner string, ttl time.Duration, _ time.Time) (WorkerJob, bool, error) {
	name = strings.TrimSpace(name)
	owner = strings.TrimSpace(owner)
	if name == "" || owner == "" {
		return WorkerJob{}, false, fmt.Errorf("job name and owner are required")
	}
	if ttl <= 0 {
		ttl = time.Minute
	}
	result, err := s.db.ExecContext(ctx, `
		UPDATE llmgateway_worker_jobs
		SET lease_owner = ?,
			lease_until = TIMESTAMPADD(MICROSECOND, ?, UTC_TIMESTAMP(6)),
			status = ?, last_started_at = UTC_TIMESTAMP(6), updated_at = UTC_TIMESTAMP(6)
		WHERE name = ? AND enabled = TRUE
			AND (lease_until IS NULL OR lease_until <= UTC_TIMESTAMP(6) OR lease_owner = ?)
	`, owner, ttl.Microseconds(), WorkerJobStatusRunning, name, owner)
	if err != nil {
		return WorkerJob{}, false, err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return WorkerJob{}, false, err
	}
	job, ok, err := s.GetWorkerJob(ctx, name)
	if err != nil || !ok || affected == 0 {
		return job, false, err
	}
	return job, true, nil
}

func (s *MySQLStore) RenewWorkerJobLease(ctx context.Context, name string, owner string, ttl time.Duration, _ time.Time) (bool, error) {
	name = strings.TrimSpace(name)
	owner = strings.TrimSpace(owner)
	if name == "" || owner == "" {
		return false, fmt.Errorf("job name and owner are required")
	}
	if ttl <= 0 {
		return false, fmt.Errorf("job lease ttl must be positive")
	}
	result, err := s.db.ExecContext(ctx, `
		UPDATE llmgateway_worker_jobs
		SET lease_until = TIMESTAMPADD(MICROSECOND, ?, UTC_TIMESTAMP(6)),
			updated_at = UTC_TIMESTAMP(6)
		WHERE name = ? AND status = ? AND lease_owner = ?
			AND lease_until > UTC_TIMESTAMP(6)
	`, ttl.Microseconds(), name, WorkerJobStatusRunning, owner)
	if err != nil {
		return false, err
	}
	affected, err := result.RowsAffected()
	return affected == 1, err
}

func (s *MySQLStore) CompleteWorkerJobRun(ctx context.Context, job WorkerJob, run WorkerJobRun) (bool, error) {
	if strings.TrimSpace(job.Name) == "" || strings.TrimSpace(run.ID) == "" || run.JobName != job.Name || strings.TrimSpace(run.Owner) == "" {
		return false, fmt.Errorf("job, run id, and owner are required")
	}
	if run.FinishedAt.IsZero() {
		run.FinishedAt = time.Now().UTC()
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return false, err
	}
	successAt := any(nil)
	if run.Status == WorkerJobStatusSuccess {
		successAt = run.FinishedAt
	}
	incrementFailure := 0
	if run.Status == WorkerJobStatusError {
		incrementFailure = 1
	}
	result, err := tx.ExecContext(ctx, `
		UPDATE llmgateway_worker_jobs
		SET status = ?, scan_cursor = ?, next_run_at = ?,
			lease_owner = '', lease_until = NULL,
			last_finished_at = ?,
			last_success_at = COALESCE(?, last_success_at),
			last_error = ?, failure_count = failure_count + ?,
			updated_at = UTC_TIMESTAMP(6)
		WHERE name = ? AND status = ? AND lease_owner = ?
	`, run.Status, job.Cursor, nullableTime(job.NextRunAt), run.FinishedAt, successAt,
		run.Error, incrementFailure, job.Name, WorkerJobStatusRunning, run.Owner)
	if err != nil {
		_ = tx.Rollback()
		return false, err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		_ = tx.Rollback()
		return false, err
	}
	if affected != 1 {
		_ = tx.Rollback()
		return false, nil
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO llmgateway_worker_job_runs (
			id, job_name, owner, status, started_at, finished_at, error, detail
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
	`, run.ID, run.JobName, run.Owner, run.Status, run.StartedAt, run.FinishedAt, run.Error, run.Detail); err != nil {
		_ = tx.Rollback()
		return false, err
	}
	if err := tx.Commit(); err != nil {
		return false, err
	}
	return true, nil
}

func (s *MySQLStore) SaveWorkerJobRun(ctx context.Context, run WorkerJobRun) error {
	if strings.TrimSpace(run.ID) == "" || strings.TrimSpace(run.JobName) == "" {
		return fmt.Errorf("job run id and name are required")
	}
	if run.StartedAt.IsZero() {
		run.StartedAt = time.Now().UTC()
	}
	if run.FinishedAt.IsZero() {
		run.FinishedAt = time.Now().UTC()
	}
	return retryMySQLTransientLock(ctx, func() error {
		tx, err := s.db.BeginTx(ctx, nil)
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO llmgateway_worker_job_runs (
				id, job_name, owner, status, started_at, finished_at, error, detail
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			ON DUPLICATE KEY UPDATE
				owner = VALUES(owner),
				status = VALUES(status),
				finished_at = VALUES(finished_at),
				error = VALUES(error),
				detail = VALUES(detail)
		`, run.ID, run.JobName, run.Owner, run.Status, run.StartedAt, nullableTime(run.FinishedAt), run.Error, run.Detail); err != nil {
			_ = tx.Rollback()
			return err
		}
		successAt := any(nil)
		if run.Status == WorkerJobStatusSuccess {
			successAt = run.FinishedAt
		}
		incrementFailure := 0
		if run.Status == WorkerJobStatusError {
			incrementFailure = 1
		}
		if _, err := tx.ExecContext(ctx, `
			UPDATE llmgateway_worker_jobs
			SET status = ?,
				lease_owner = '',
				lease_until = NULL,
				last_finished_at = ?,
				last_success_at = COALESCE(?, last_success_at),
				last_error = ?,
				failure_count = failure_count + ?,
				updated_at = ?
			WHERE name = ?
		`, run.Status, run.FinishedAt, successAt, run.Error, incrementFailure, time.Now().UTC(), run.JobName); err != nil {
			_ = tx.Rollback()
			return err
		}
		return tx.Commit()
	})
}

func (s *MySQLStore) ListWorkerJobRuns(ctx context.Context, opts WorkerJobRunListOptions) ([]WorkerJobRun, error) {
	query := `
		SELECT id, job_name, owner, status, started_at, finished_at, error, detail
		FROM llmgateway_worker_job_runs`
	args := []any{}
	if strings.TrimSpace(opts.JobName) != "" {
		query += ` WHERE job_name = ?`
		args = append(args, strings.TrimSpace(opts.JobName))
	}
	query += ` ORDER BY started_at DESC, id DESC`
	if opts.Limit > 0 {
		query += ` LIMIT ?`
		args = append(args, opts.Limit)
	}
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	runs := []WorkerJobRun{}
	for rows.Next() {
		run, err := scanWorkerJobRun(rows)
		if err != nil {
			return nil, err
		}
		runs = append(runs, run)
	}
	return runs, rows.Err()
}

func scanChannelBundleRevision(row scanner) (ChannelBundleRevision, error) {
	var revision ChannelBundleRevision
	var rawSpec string
	err := row.Scan(
		&revision.RevisionID,
		&revision.BundleID,
		&revision.Version,
		&revision.Name,
		&revision.Description,
		&revision.SourceSetID,
		&rawSpec,
		&revision.Fingerprint,
		&revision.CreatedAt,
	)
	if err != nil {
		return ChannelBundleRevision{}, err
	}
	if rawSpec != "" {
		spec, err := unmarshalChannelBundleSpecFromStorage(rawSpec)
		if err != nil {
			return ChannelBundleRevision{}, err
		}
		revision.Spec = spec
	}
	revision.CreatedAt = revision.CreatedAt.UTC()
	return revision, nil
}

func scanChannelBundleReleaseRun(row scanner) (ChannelBundleReleaseRun, error) {
	var run ChannelBundleReleaseRun
	var rawItems string
	var startedAt sql.NullTime
	var finishedAt sql.NullTime
	err := row.Scan(
		&run.ID,
		&run.BundleID,
		&run.RevisionID,
		&run.Fingerprint,
		&run.Status,
		&run.ForceDrift,
		&run.StopOnFailure,
		&run.TriggeredBy,
		&run.LastError,
		&rawItems,
		&run.CreatedAt,
		&startedAt,
		&finishedAt,
	)
	if err != nil {
		return ChannelBundleReleaseRun{}, err
	}
	if rawItems != "" {
		if err := json.Unmarshal([]byte(rawItems), &run.Items); err != nil {
			return ChannelBundleReleaseRun{}, err
		}
	}
	if startedAt.Valid {
		run.StartedAt = startedAt.Time.UTC()
	}
	if finishedAt.Valid {
		run.FinishedAt = finishedAt.Time.UTC()
	}
	run.CreatedAt = run.CreatedAt.UTC()
	return run, nil
}

func scanWorkerJob(row scanner) (WorkerJob, error) {
	var job WorkerJob
	var leaseUntil sql.NullTime
	var lastStartedAt sql.NullTime
	var lastFinishedAt sql.NullTime
	var lastSuccessAt sql.NullTime
	var nextRunAt sql.NullTime
	err := row.Scan(
		&job.Name,
		&job.Kind,
		&job.Enabled,
		&job.IntervalSeconds,
		&job.Status,
		&job.LeaseOwner,
		&leaseUntil,
		&lastStartedAt,
		&lastFinishedAt,
		&lastSuccessAt,
		&nextRunAt,
		&job.Cursor,
		&job.LastError,
		&job.FailureCount,
		&job.CreatedAt,
		&job.UpdatedAt,
	)
	if err != nil {
		return WorkerJob{}, err
	}
	if leaseUntil.Valid {
		job.LeaseUntil = leaseUntil.Time.UTC()
	}
	if lastStartedAt.Valid {
		job.LastStartedAt = lastStartedAt.Time.UTC()
	}
	if lastFinishedAt.Valid {
		job.LastFinishedAt = lastFinishedAt.Time.UTC()
	}
	if lastSuccessAt.Valid {
		job.LastSuccessAt = lastSuccessAt.Time.UTC()
	}
	if nextRunAt.Valid {
		job.NextRunAt = nextRunAt.Time.UTC()
	}
	job.CreatedAt = job.CreatedAt.UTC()
	job.UpdatedAt = job.UpdatedAt.UTC()
	return job, nil
}

func scanWorkerJobRun(row scanner) (WorkerJobRun, error) {
	var run WorkerJobRun
	var finishedAt sql.NullTime
	err := row.Scan(
		&run.ID,
		&run.JobName,
		&run.Owner,
		&run.Status,
		&run.StartedAt,
		&finishedAt,
		&run.Error,
		&run.Detail,
	)
	if err != nil {
		return WorkerJobRun{}, err
	}
	if finishedAt.Valid {
		run.FinishedAt = finishedAt.Time.UTC()
	}
	run.StartedAt = run.StartedAt.UTC()
	return run, nil
}
