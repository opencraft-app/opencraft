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

func (s *MySQLStore) SaveBYOKSyncIntent(ctx context.Context, intent BYOKSyncIntent) (BYOKSyncTask, error) {
	var result BYOKSyncTask
	err := retryMySQLTransientLock(ctx, func() error {
		task, err := s.saveBYOKSyncIntentOnce(ctx, intent)
		if err == nil {
			result = task
		}
		return err
	})
	return result, err
}

func (s *MySQLStore) saveBYOKSyncIntentOnce(ctx context.Context, intent BYOKSyncIntent) (BYOKSyncTask, error) {
	userID := strings.TrimSpace(intent.Settings.ExternalUserID)
	setID := strings.TrimSpace(intent.Task.SetID)
	groupName := strings.TrimSpace(intent.GroupName)
	if userID == "" || strings.TrimSpace(intent.Task.ExternalUserID) != userID || setID == "" {
		return BYOKSyncTask{}, fmt.Errorf("BYOK sync intent requires matching user settings, task, and Set")
	}
	if intent.Enabled && !isBYOKGroup(groupName) {
		return BYOKSyncTask{}, fmt.Errorf("BYOK group %q must use reserved %s prefix", groupName, byokGroupPrefix)
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return BYOKSyncTask{}, err
	}
	defer tx.Rollback()
	if err := rejectDeletingTenantWriteTx(ctx, tx, userID); err != nil {
		return BYOKSyncTask{}, err
	}
	now := time.Now().UTC()
	existing, exists, err := getBYOKGroupRatioDesiredForUpdate(ctx, tx, userID)
	if err != nil {
		return BYOKSyncTask{}, err
	}
	affected := map[string]bool{}
	changed := false
	if intent.Enabled {
		collision, collisionExists, err := getGroupRatioDesiredForUpdate(ctx, tx, setID, groupName)
		if err != nil {
			return BYOKSyncTask{}, err
		}
		if collisionExists && collision.ExternalUserID != userID {
			return BYOKSyncTask{}, fmt.Errorf("GroupRatio group %q already belongs to %q", groupName, collision.SourceID)
		}
		if exists && (existing.SetID != setID || existing.GroupName != groupName) {
			if _, err := tx.ExecContext(ctx, `DELETE FROM llmgateway_group_ratio_desired WHERE external_user_id = ?`, userID); err != nil {
				return BYOKSyncTask{}, err
			}
			affected[existing.SetID] = true
			changed = true
		}
		createdAt := now
		if exists && !existing.CreatedAt.IsZero() {
			createdAt = existing.CreatedAt
		}
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO llmgateway_group_ratio_desired (
				set_id, group_name, ratio, source_type, source_id, external_user_id, created_at, updated_at
			) VALUES (?, ?, 0, ?, ?, ?, ?, ?)
			ON DUPLICATE KEY UPDATE
				ratio = 0,
				source_type = VALUES(source_type),
				source_id = VALUES(source_id),
				external_user_id = VALUES(external_user_id),
				updated_at = VALUES(updated_at)
		`, setID, groupName, GroupRatioSourceBYOK, userID, userID, createdAt, now); err != nil {
			return BYOKSyncTask{}, err
		}
		if !exists || existing.SetID != setID || existing.GroupName != groupName || existing.Ratio != 0 {
			changed = true
		}
		if changed {
			affected[setID] = true
		}
	} else if exists {
		if _, err := tx.ExecContext(ctx, `DELETE FROM llmgateway_group_ratio_desired WHERE external_user_id = ?`, userID); err != nil {
			return BYOKSyncTask{}, err
		}
		affected[existing.SetID] = true
		changed = true
	}

	if err := saveUserLLMSettingsTx(ctx, tx, intent.Settings, now); err != nil {
		return BYOKSyncTask{}, err
	}
	task, err := enqueueBYOKSyncTaskTx(ctx, tx, intent.Task, now)
	if err != nil {
		return BYOKSyncTask{}, err
	}
	if changed {
		affectedSetIDs := make([]string, 0, len(affected))
		for affectedSetID := range affected {
			affectedSetIDs = append(affectedSetIDs, affectedSetID)
		}
		sort.Strings(affectedSetIDs)
		for _, affectedSetID := range affectedSetIDs {
			if _, err := markGroupRatioDesiredChangedTx(ctx, tx, affectedSetID, now); err != nil {
				return BYOKSyncTask{}, err
			}
		}
	}
	if err := tx.Commit(); err != nil {
		return BYOKSyncTask{}, err
	}
	return task, nil
}

func (s *MySQLStore) ReplacePlatformGroupRatios(ctx context.Context, setID string, sourceID string, ratios map[string]float64) (GroupRatioApplyState, error) {
	var result GroupRatioApplyState
	err := retryMySQLTransientLock(ctx, func() error {
		state, err := s.replacePlatformGroupRatiosOnce(ctx, setID, sourceID, ratios)
		if err == nil {
			result = state
		}
		return err
	})
	return result, err
}

func (s *MySQLStore) replacePlatformGroupRatiosOnce(ctx context.Context, setID string, sourceID string, ratios map[string]float64) (GroupRatioApplyState, error) {
	setID = strings.TrimSpace(setID)
	sourceID = strings.TrimSpace(sourceID)
	if setID == "" || sourceID == "" {
		return GroupRatioApplyState{}, fmt.Errorf("platform GroupRatio requires Set and source")
	}
	for group := range ratios {
		if strings.TrimSpace(group) == "" || isBYOKGroup(group) {
			return GroupRatioApplyState{}, fmt.Errorf("platform GroupRatio contains invalid group %q", group)
		}
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return GroupRatioApplyState{}, err
	}
	defer tx.Rollback()
	currentEntries, err := listGroupRatioDesiredTx(ctx, tx, setID, GroupRatioSourcePlatform, true)
	if err != nil {
		return GroupRatioApplyState{}, err
	}
	current := make(map[string]float64, len(currentEntries))
	for _, entry := range currentEntries {
		current[entry.GroupName] = entry.Ratio
	}
	changed := comparableChannelBundleOptionValue(current) != comparableChannelBundleOptionValue(ratios)
	if _, err := tx.ExecContext(ctx, `DELETE FROM llmgateway_group_ratio_desired WHERE set_id = ? AND source_type = ?`, setID, GroupRatioSourcePlatform); err != nil {
		return GroupRatioApplyState{}, err
	}
	now := time.Now().UTC()
	for group, ratio := range ratios {
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO llmgateway_group_ratio_desired (
				set_id, group_name, ratio, source_type, source_id, external_user_id, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)
		`, setID, group, ratio, GroupRatioSourcePlatform, sourceID, now, now); err != nil {
			return GroupRatioApplyState{}, err
		}
	}
	state, stateExists, err := getGroupRatioApplyStateTx(ctx, tx, setID, true)
	if err != nil {
		return GroupRatioApplyState{}, err
	}
	if changed || !stateExists {
		state, err = markGroupRatioDesiredChangedTx(ctx, tx, setID, now)
		if err != nil {
			return GroupRatioApplyState{}, err
		}
	}
	if err := tx.Commit(); err != nil {
		return GroupRatioApplyState{}, err
	}
	return state, nil
}

func (s *MySQLStore) GetGroupRatioSnapshot(ctx context.Context, setID string) (GroupRatioSnapshot, error) {
	setID = strings.TrimSpace(setID)
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return GroupRatioSnapshot{}, err
	}
	defer tx.Rollback()
	state, _, err := getGroupRatioApplyStateTx(ctx, tx, setID, false)
	if err != nil {
		return GroupRatioSnapshot{}, err
	}
	entries, err := listGroupRatioDesiredTx(ctx, tx, setID, "", false)
	if err != nil {
		return GroupRatioSnapshot{}, err
	}
	if err := tx.Commit(); err != nil {
		return GroupRatioSnapshot{}, err
	}
	return GroupRatioSnapshot{State: state, Entries: entries}, nil
}

func (s *MySQLStore) GetGroupRatioApplyState(ctx context.Context, setID string) (GroupRatioApplyState, bool, error) {
	return scanGroupRatioApplyStateRow(s.db.QueryRowContext(ctx, `
		SELECT set_id, desired_version, applied_version, desired_fingerprint,
			applied_fingerprint, status, last_error, last_applied_at, created_at, updated_at
		FROM llmgateway_group_ratio_apply_states WHERE set_id = ?
	`, strings.TrimSpace(setID)))
}

func (s *MySQLStore) ListGroupRatioApplyStates(ctx context.Context, opts GroupRatioApplyStateListOptions) ([]GroupRatioApplyState, error) {
	query := `
		SELECT set_id, desired_version, applied_version, desired_fingerprint,
			applied_fingerprint, status, last_error, last_applied_at, created_at, updated_at
		FROM llmgateway_group_ratio_apply_states`
	clauses := []string{}
	args := []any{}
	if after := strings.TrimSpace(opts.AfterSetID); after != "" {
		clauses = append(clauses, "set_id > ?")
		args = append(args, after)
	}
	if len(opts.Statuses) > 0 {
		placeholders := make([]string, 0, len(opts.Statuses))
		for _, status := range opts.Statuses {
			placeholders = append(placeholders, "?")
			args = append(args, strings.TrimSpace(status))
		}
		clauses = append(clauses, "status IN ("+strings.Join(placeholders, ",")+")")
	}
	if len(clauses) > 0 {
		query += " WHERE " + strings.Join(clauses, " AND ")
	}
	query += " ORDER BY set_id"
	if opts.Limit > 0 {
		query += " LIMIT ?"
		args = append(args, opts.Limit)
	}
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	states := []GroupRatioApplyState{}
	for rows.Next() {
		state, _, err := scanGroupRatioApplyStateRow(rows)
		if err != nil {
			return nil, err
		}
		states = append(states, state)
	}
	return states, rows.Err()
}

func (s *MySQLStore) CompleteGroupRatioApply(ctx context.Context, completion GroupRatioApplyCompletion) (GroupRatioApplyState, error) {
	var result GroupRatioApplyState
	err := retryMySQLTransientLock(ctx, func() error {
		state, err := s.completeGroupRatioApplyOnce(ctx, completion)
		if err == nil {
			result = state
		}
		return err
	})
	return result, err
}

func (s *MySQLStore) completeGroupRatioApplyOnce(ctx context.Context, completion GroupRatioApplyCompletion) (GroupRatioApplyState, error) {
	setID := strings.TrimSpace(completion.SetID)
	if setID == "" || completion.Version < 0 {
		return GroupRatioApplyState{}, fmt.Errorf("GroupRatio apply completion requires Set and version")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return GroupRatioApplyState{}, err
	}
	defer tx.Rollback()
	state, ok, err := getGroupRatioApplyStateTx(ctx, tx, setID, true)
	if err != nil {
		return GroupRatioApplyState{}, err
	}
	if !ok {
		return GroupRatioApplyState{}, fmt.Errorf("GroupRatio apply state for Set %q not found", setID)
	}
	now := completion.AppliedAt.UTC()
	if now.IsZero() {
		now = time.Now().UTC()
	}
	if completion.Error != "" {
		state.LastError = completion.Error
		if state.DesiredVersion == completion.Version {
			state.Status = GroupRatioApplyStatusError
		} else {
			state.Status = GroupRatioApplyStatusPending
		}
	} else {
		state.AppliedVersion = completion.Version
		state.AppliedFingerprint = completion.Fingerprint
		state.LastAppliedAt = now
		state.LastError = ""
		if state.DesiredVersion == completion.Version {
			state.DesiredFingerprint = completion.Fingerprint
		}
		if state.DesiredVersion == completion.Version && state.DesiredFingerprint == completion.Fingerprint {
			state.Status = GroupRatioApplyStatusSynced
		} else {
			state.Status = GroupRatioApplyStatusPending
		}
	}
	state.UpdatedAt = now
	if _, err := tx.ExecContext(ctx, `
		UPDATE llmgateway_group_ratio_apply_states SET
			desired_fingerprint = ?, applied_version = ?, applied_fingerprint = ?, status = ?, last_error = ?,
			last_applied_at = ?, updated_at = ?
		WHERE set_id = ?
	`, state.DesiredFingerprint, state.AppliedVersion, state.AppliedFingerprint, state.Status, state.LastError,
		nullableTime(state.LastAppliedAt), state.UpdatedAt, state.SetID); err != nil {
		return GroupRatioApplyState{}, err
	}
	if err := tx.Commit(); err != nil {
		return GroupRatioApplyState{}, err
	}
	return state, nil
}

func saveUserLLMSettingsTx(ctx context.Context, tx *sql.Tx, settings UserLLMSettings, now time.Time) error {
	rawProviders, err := json.Marshal(settings.Providers)
	if err != nil {
		return err
	}
	if settings.CreatedAt.IsZero() {
		settings.CreatedAt = now
	}
	settings.UpdatedAt = now
	return execOne(ctx, tx, `
		INSERT INTO llmgateway_user_llm_settings (
			external_user_id, routing_mode, byok_group, byok_upstream_key,
			byok_upstream_key_id, providers_json, last_synced_at, last_sync_error,
			created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON DUPLICATE KEY UPDATE
			routing_mode = VALUES(routing_mode), byok_group = VALUES(byok_group),
			byok_upstream_key = VALUES(byok_upstream_key), byok_upstream_key_id = VALUES(byok_upstream_key_id),
			providers_json = VALUES(providers_json), last_synced_at = VALUES(last_synced_at),
			last_sync_error = VALUES(last_sync_error), updated_at = VALUES(updated_at)
	`, settings.ExternalUserID, settings.Routing.Mode, settings.BYOKGroup, settings.BYOKUpstreamKey,
		settings.BYOKUpstreamKeyID, string(rawProviders), nullableTime(settings.LastSyncedAt), settings.LastSyncError,
		settings.CreatedAt, settings.UpdatedAt)
}

func enqueueBYOKSyncTaskTx(ctx context.Context, tx *sql.Tx, task BYOKSyncTask, now time.Time) (BYOKSyncTask, error) {
	if task.CreatedAt.IsZero() {
		task.CreatedAt = now
	}
	if task.NextRunAt.IsZero() {
		task.NextRunAt = now
	}
	if task.Status == "" {
		task.Status = BYOKSyncTaskStatusPending
	}
	if err := execOne(ctx, tx, `
		INSERT INTO llmgateway_byok_sync_tasks (
			external_user_id, set_id, status, requested_version, processing_version,
			applied_version, attempts, lease_owner, lease_until, next_run_at,
			last_started_at, last_finished_at, last_error, created_at, updated_at
		) VALUES (?, ?, ?, 1, 0, 0, 0, '', NULL, ?, NULL, NULL, '', ?, ?)
		ON DUPLICATE KEY UPDATE
			set_id = VALUES(set_id),
			status = CASE WHEN status = ? AND lease_until IS NOT NULL AND lease_until > ? THEN status ELSE ? END,
			requested_version = requested_version + 1,
			next_run_at = CASE WHEN status = ? AND lease_until IS NOT NULL AND lease_until > ? THEN next_run_at ELSE VALUES(next_run_at) END,
			last_error = '', updated_at = VALUES(updated_at)
	`, task.ExternalUserID, task.SetID, task.Status, task.NextRunAt, task.CreatedAt, now,
		BYOKSyncTaskStatusRunning, now, BYOKSyncTaskStatusPending,
		BYOKSyncTaskStatusRunning, now); err != nil {
		return BYOKSyncTask{}, err
	}
	return scanBYOKSyncTask(tx.QueryRowContext(ctx, `
		SELECT external_user_id, set_id, status, requested_version, processing_version,
			applied_version, attempts, lease_owner, lease_until, next_run_at,
			last_started_at, last_finished_at, last_error, created_at, updated_at
		FROM llmgateway_byok_sync_tasks WHERE external_user_id = ?
	`, task.ExternalUserID))
}

func markGroupRatioDesiredChangedTx(ctx context.Context, tx *sql.Tx, setID string, now time.Time) (GroupRatioApplyState, error) {
	if err := execOne(ctx, tx, `
		INSERT INTO llmgateway_group_ratio_apply_states (
			set_id, desired_version, applied_version, desired_fingerprint, applied_fingerprint,
			status, last_error, last_applied_at, created_at, updated_at
		) VALUES (?, 1, 0, ?, '', ?, '', NULL, ?, ?)
		ON DUPLICATE KEY UPDATE
			desired_version = desired_version + 1,
			desired_fingerprint = VALUES(desired_fingerprint),
			status = VALUES(status), last_error = '', updated_at = VALUES(updated_at)
	`, setID, "", GroupRatioApplyStatusPending, now, now); err != nil {
		return GroupRatioApplyState{}, err
	}
	state, _, err := getGroupRatioApplyStateTx(ctx, tx, setID, false)
	return state, err
}

func getBYOKGroupRatioDesiredForUpdate(ctx context.Context, tx *sql.Tx, userID string) (GroupRatioDesired, bool, error) {
	return scanGroupRatioDesiredRow(tx.QueryRowContext(ctx, `
		SELECT set_id, group_name, ratio, source_type, source_id, external_user_id, created_at, updated_at
		FROM llmgateway_group_ratio_desired WHERE external_user_id = ? FOR UPDATE
	`, userID))
}

func getGroupRatioDesiredForUpdate(ctx context.Context, tx *sql.Tx, setID string, groupName string) (GroupRatioDesired, bool, error) {
	return scanGroupRatioDesiredRow(tx.QueryRowContext(ctx, `
		SELECT set_id, group_name, ratio, source_type, source_id, external_user_id, created_at, updated_at
		FROM llmgateway_group_ratio_desired WHERE set_id = ? AND group_name = ? FOR UPDATE
	`, setID, groupName))
}

func listGroupRatioDesiredTx(ctx context.Context, tx *sql.Tx, setID string, sourceType string, forUpdate bool) ([]GroupRatioDesired, error) {
	query := `
		SELECT set_id, group_name, ratio, source_type, source_id, external_user_id, created_at, updated_at
		FROM llmgateway_group_ratio_desired WHERE set_id = ?`
	args := []any{setID}
	if sourceType != "" {
		query += " AND source_type = ?"
		args = append(args, sourceType)
	}
	query += " ORDER BY group_name"
	if forUpdate {
		query += " FOR UPDATE"
	}
	rows, err := tx.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	entries := []GroupRatioDesired{}
	for rows.Next() {
		entry, _, err := scanGroupRatioDesiredRow(rows)
		if err != nil {
			return nil, err
		}
		entries = append(entries, entry)
	}
	return entries, rows.Err()
}

func getGroupRatioApplyStateTx(ctx context.Context, tx *sql.Tx, setID string, forUpdate bool) (GroupRatioApplyState, bool, error) {
	query := `
		SELECT set_id, desired_version, applied_version, desired_fingerprint,
			applied_fingerprint, status, last_error, last_applied_at, created_at, updated_at
		FROM llmgateway_group_ratio_apply_states WHERE set_id = ?`
	if forUpdate {
		query += " FOR UPDATE"
	}
	return scanGroupRatioApplyStateRow(tx.QueryRowContext(ctx, query, setID))
}

type sqlRowScanner interface {
	Scan(...any) error
}

func scanGroupRatioDesiredRow(row sqlRowScanner) (GroupRatioDesired, bool, error) {
	var entry GroupRatioDesired
	var externalUserID sql.NullString
	err := row.Scan(&entry.SetID, &entry.GroupName, &entry.Ratio, &entry.SourceType, &entry.SourceID,
		&externalUserID, &entry.CreatedAt, &entry.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return GroupRatioDesired{}, false, nil
	}
	if err != nil {
		return GroupRatioDesired{}, false, err
	}
	entry.ExternalUserID = externalUserID.String
	return entry, true, nil
}

func scanGroupRatioApplyStateRow(row sqlRowScanner) (GroupRatioApplyState, bool, error) {
	var state GroupRatioApplyState
	var lastAppliedAt sql.NullTime
	err := row.Scan(&state.SetID, &state.DesiredVersion, &state.AppliedVersion, &state.DesiredFingerprint,
		&state.AppliedFingerprint, &state.Status, &state.LastError, &lastAppliedAt, &state.CreatedAt, &state.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return GroupRatioApplyState{}, false, nil
	}
	if err != nil {
		return GroupRatioApplyState{}, false, err
	}
	if lastAppliedAt.Valid {
		state.LastAppliedAt = lastAppliedAt.Time.UTC()
	}
	return state, true, nil
}

func execOne(ctx context.Context, tx *sql.Tx, query string, args ...any) error {
	_, err := tx.ExecContext(ctx, query, args...)
	return err
}
