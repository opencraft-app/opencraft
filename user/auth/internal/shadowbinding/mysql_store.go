package shadowbinding

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"
)

func nullableString(value string) any {
	if value == "" {
		return nil
	}
	return value
}

type MySQLStore struct{ db *sql.DB }

func NewMySQLStore(db *sql.DB) *MySQLStore { return &MySQLStore{db: db} }

func (s *MySQLStore) SavePendingBinding(ctx context.Context, userID string, shadowUserName string, now time.Time) (Binding, error) {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO shadow_bindings (user_id, shadow_user_name, status, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?)
		ON DUPLICATE KEY UPDATE
				shadow_user_name = VALUES(shadow_user_name),
				status = VALUES(status),
				last_error_code = NULL,
				last_error_message = NULL,
				basic_auth_status = NULL,
				basic_auth_synced_at = NULL,
				basic_auth_source_attempt_id = NULL,
				basic_auth_identity_hash = NULL,
				basic_auth_phone_hash = NULL,
				basic_auth_last_error_code = NULL,
				basic_auth_last_error_message = NULL,
				updated_at = VALUES(updated_at)
		`, userID, shadowUserName, StatusPending, now, now)
	if err != nil {
		return Binding{}, fmt.Errorf("save pending shadow binding: %w", err)
	}
	return s.GetBindingByUserID(ctx, userID)
}

func (s *MySQLStore) GetBindingByUserID(ctx context.Context, userID string) (Binding, error) {
	row := s.db.QueryRowContext(ctx, `
			SELECT user_id, shadow_user_name, COALESCE(uin, 0), COALESCE(owner_uin, 0), COALESCE(app_id, 0), status,
			       COALESCE(last_error_code, ''), COALESCE(last_error_message, ''),
			       COALESCE(basic_auth_status, ''), basic_auth_synced_at,
			       COALESCE(basic_auth_source_attempt_id, ''), COALESCE(basic_auth_identity_hash, ''), COALESCE(basic_auth_phone_hash, ''),
			       COALESCE(basic_auth_last_error_code, ''), COALESCE(basic_auth_last_error_message, ''),
			       created_at, updated_at
			FROM shadow_bindings
			WHERE user_id = ?
		`, userID)
	return scanBinding(row, "get shadow binding")
}

func (s *MySQLStore) GetBindingByShadowUserName(ctx context.Context, shadowUserName string) (Binding, error) {
	row := s.db.QueryRowContext(ctx, `
			SELECT user_id, shadow_user_name, COALESCE(uin, 0), COALESCE(owner_uin, 0), COALESCE(app_id, 0), status,
			       COALESCE(last_error_code, ''), COALESCE(last_error_message, ''),
			       COALESCE(basic_auth_status, ''), basic_auth_synced_at,
			       COALESCE(basic_auth_source_attempt_id, ''), COALESCE(basic_auth_identity_hash, ''), COALESCE(basic_auth_phone_hash, ''),
			       COALESCE(basic_auth_last_error_code, ''), COALESCE(basic_auth_last_error_message, ''),
			       created_at, updated_at
			FROM shadow_bindings
			WHERE shadow_user_name = ?
			ORDER BY status = ? ASC, updated_at DESC
			LIMIT 1
		`, shadowUserName, StatusDisabled)
	return scanBinding(row, "get shadow binding by shadow username")
}

func (s *MySQLStore) ListAdminBindings(ctx context.Context, search string, limit int, offset int) ([]Binding, int, error) {
	pattern := "%"
	if trimmed := strings.TrimSpace(search); trimmed != "" {
		pattern = "%" + trimmed + "%"
	}
	if limit < 1 {
		limit = 20
	}
	if limit > 100 {
		limit = 100
	}
	if offset < 0 {
		offset = 0
	}

	where := `(user_id LIKE ? OR shadow_user_name LIKE ?
		OR CAST(COALESCE(uin, 0) AS CHAR) LIKE ?
		OR CAST(COALESCE(owner_uin, 0) AS CHAR) LIKE ?
		OR CAST(COALESCE(app_id, 0) AS CHAR) LIKE ?)`
	args := []any{pattern, pattern, pattern, pattern, pattern}

	var total int
	if err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM shadow_bindings WHERE `+where, args...).Scan(&total); err != nil {
		return nil, 0, fmt.Errorf("count admin shadow bindings: %w", err)
	}

	rows, err := s.db.QueryContext(ctx, `
		SELECT user_id, shadow_user_name, COALESCE(uin, 0), COALESCE(owner_uin, 0), COALESCE(app_id, 0), status,
		       COALESCE(last_error_code, ''), COALESCE(last_error_message, ''),
		       COALESCE(basic_auth_status, ''), basic_auth_synced_at,
		       COALESCE(basic_auth_source_attempt_id, ''), COALESCE(basic_auth_identity_hash, ''), COALESCE(basic_auth_phone_hash, ''),
		       COALESCE(basic_auth_last_error_code, ''), COALESCE(basic_auth_last_error_message, ''),
		       created_at, updated_at
		FROM shadow_bindings
		WHERE `+where+`
		ORDER BY created_at DESC, user_id ASC
		LIMIT ? OFFSET ?
	`, append(args, limit, offset)...)
	if err != nil {
		return nil, 0, fmt.Errorf("list admin shadow bindings: %w", err)
	}
	defer rows.Close()

	bindings := make([]Binding, 0, limit)
	for rows.Next() {
		binding, err := scanBinding(rows, "scan admin shadow binding")
		if err != nil {
			return nil, 0, err
		}
		bindings = append(bindings, binding)
	}
	if err := rows.Err(); err != nil {
		return nil, 0, fmt.Errorf("iterate admin shadow bindings: %w", err)
	}
	return bindings, total, nil
}

type bindingScanner interface {
	Scan(dest ...any) error
}

func scanBinding(row bindingScanner, operation string) (Binding, error) {
	var binding Binding
	var basicAuthSyncedAt sql.NullTime
	if err := row.Scan(&binding.UserID, &binding.ShadowUserName, &binding.Uin, &binding.OwnerUin, &binding.AppID, &binding.Status, &binding.LastErrorCode, &binding.LastErrorMessage, &binding.BasicAuthStatus, &basicAuthSyncedAt, &binding.BasicAuthSourceAttemptID, &binding.BasicAuthIdentityHash, &binding.BasicAuthPhoneHash, &binding.BasicAuthLastErrorCode, &binding.BasicAuthLastErrorMessage, &binding.CreatedAt, &binding.UpdatedAt); errors.Is(err, sql.ErrNoRows) {
		return Binding{}, ErrNotFound
	} else if err != nil {
		return Binding{}, fmt.Errorf("%s: %w", operation, err)
	}
	if basicAuthSyncedAt.Valid {
		binding.BasicAuthSyncedAt = &basicAuthSyncedAt.Time
	}
	return binding, nil
}

func (s *MySQLStore) UpsertAdminBinding(ctx context.Context, requested Binding, now time.Time) (Binding, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Binding{}, fmt.Errorf("begin admin shadow binding upsert: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	existing, err := scanBinding(tx.QueryRowContext(ctx, `
		SELECT user_id, shadow_user_name, COALESCE(uin, 0), COALESCE(owner_uin, 0), COALESCE(app_id, 0), status,
		       COALESCE(last_error_code, ''), COALESCE(last_error_message, ''),
		       COALESCE(basic_auth_status, ''), basic_auth_synced_at,
		       COALESCE(basic_auth_source_attempt_id, ''), COALESCE(basic_auth_identity_hash, ''), COALESCE(basic_auth_phone_hash, ''),
		       COALESCE(basic_auth_last_error_code, ''), COALESCE(basic_auth_last_error_message, ''),
		       created_at, updated_at
		FROM shadow_bindings
		WHERE user_id = ?
		FOR UPDATE
	`, requested.UserID), "lock shadow binding for admin upsert")
	if err == nil && existing.Status != StatusDisabled {
		if sameBindingIdentity(existing, requested) && existing.Status == StatusActive {
			return existing, nil
		}
		return Binding{}, ErrBindingConflict
	}
	if err != nil && !errors.Is(err, ErrNotFound) {
		return Binding{}, err
	}
	hasExisting := err == nil

	var conflictUserID string
	conflictErr := tx.QueryRowContext(ctx, `
		SELECT user_id
		FROM shadow_bindings
		WHERE uin = ? AND user_id <> ? AND status <> ?
		LIMIT 1
		FOR UPDATE
	`, requested.Uin, requested.UserID, StatusDisabled).Scan(&conflictUserID)
	if conflictErr == nil {
		return Binding{}, ErrBindingConflict
	}
	if !errors.Is(conflictErr, sql.ErrNoRows) {
		return Binding{}, fmt.Errorf("check admin shadow binding uin conflict: %w", conflictErr)
	}
	conflictErr = tx.QueryRowContext(ctx, `
		SELECT user_id
		FROM shadow_bindings
		WHERE shadow_user_name = ? AND user_id <> ? AND status <> ?
		LIMIT 1
		FOR UPDATE
	`, requested.ShadowUserName, requested.UserID, StatusDisabled).Scan(&conflictUserID)
	if conflictErr == nil {
		return Binding{}, ErrBindingConflict
	}
	if !errors.Is(conflictErr, sql.ErrNoRows) {
		return Binding{}, fmt.Errorf("check admin shadow binding username conflict: %w", conflictErr)
	}

	if hasExisting {
		_, err = tx.ExecContext(ctx, `
			UPDATE shadow_bindings
			SET shadow_user_name = ?, uin = ?, owner_uin = ?, app_id = ?, status = ?,
			    last_error_code = NULL, last_error_message = NULL,
			    basic_auth_status = NULL, basic_auth_synced_at = NULL,
			    basic_auth_source_attempt_id = NULL, basic_auth_identity_hash = NULL, basic_auth_phone_hash = NULL,
			    basic_auth_last_error_code = NULL, basic_auth_last_error_message = NULL,
			    updated_at = ?
			WHERE user_id = ?
		`, requested.ShadowUserName, requested.Uin, requested.OwnerUin, requested.AppID, StatusActive, now, requested.UserID)
	} else {
		_, err = tx.ExecContext(ctx, `
			INSERT INTO shadow_bindings (user_id, shadow_user_name, uin, owner_uin, app_id, status, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		`, requested.UserID, requested.ShadowUserName, requested.Uin, requested.OwnerUin, requested.AppID, StatusActive, now, now)
	}
	if err != nil {
		return Binding{}, fmt.Errorf("save admin shadow binding: %w", err)
	}

	updated, err := scanBinding(tx.QueryRowContext(ctx, `
		SELECT user_id, shadow_user_name, COALESCE(uin, 0), COALESCE(owner_uin, 0), COALESCE(app_id, 0), status,
		       COALESCE(last_error_code, ''), COALESCE(last_error_message, ''),
		       COALESCE(basic_auth_status, ''), basic_auth_synced_at,
		       COALESCE(basic_auth_source_attempt_id, ''), COALESCE(basic_auth_identity_hash, ''), COALESCE(basic_auth_phone_hash, ''),
		       COALESCE(basic_auth_last_error_code, ''), COALESCE(basic_auth_last_error_message, ''),
		       created_at, updated_at
		FROM shadow_bindings
		WHERE user_id = ?
	`, requested.UserID), "get saved admin shadow binding")
	if err != nil {
		return Binding{}, err
	}
	if err := tx.Commit(); err != nil {
		return Binding{}, fmt.Errorf("commit admin shadow binding upsert: %w", err)
	}
	return updated, nil
}

func (s *MySQLStore) DisableAdminBinding(ctx context.Context, userID string, now time.Time) (Binding, error) {
	res, err := s.db.ExecContext(ctx, `
		UPDATE shadow_bindings
		SET status = ?, last_error_code = NULL, last_error_message = NULL, updated_at = ?
		WHERE user_id = ? AND status <> ?
	`, StatusDisabled, now, userID, StatusDisabled)
	if err != nil {
		return Binding{}, fmt.Errorf("disable admin shadow binding: %w", err)
	}
	if affected, _ := res.RowsAffected(); affected == 0 {
		binding, getErr := s.GetBindingByUserID(ctx, userID)
		if getErr != nil {
			return Binding{}, getErr
		}
		if binding.Status != StatusDisabled {
			return Binding{}, ErrBindingConflict
		}
		return binding, nil
	}
	return s.GetBindingByUserID(ctx, userID)
}

func (s *MySQLStore) MarkBindingActive(ctx context.Context, userID string, uin, ownerUin, appID int64, now time.Time) (Binding, error) {
	res, err := s.db.ExecContext(ctx, `
		UPDATE shadow_bindings
		SET uin = ?, owner_uin = ?, app_id = ?, status = ?, last_error_code = NULL, last_error_message = NULL, updated_at = ?
		WHERE user_id = ?
	`, uin, ownerUin, appID, StatusActive, now, userID)
	if err != nil {
		return Binding{}, fmt.Errorf("mark shadow binding active: %w", err)
	}
	if affected, _ := res.RowsAffected(); affected == 0 {
		return Binding{}, ErrNotFound
	}
	return s.GetBindingByUserID(ctx, userID)
}

func (s *MySQLStore) SetBindingAppIDIfMissing(ctx context.Context, userID string, uin, ownerUin, appID int64, now time.Time) (Binding, error) {
	res, err := s.db.ExecContext(ctx, `
		UPDATE shadow_bindings
		SET app_id = ?, updated_at = ?
		WHERE user_id = ? AND uin = ? AND owner_uin = ? AND COALESCE(app_id, 0) = 0
	`, appID, now, userID, uin, ownerUin)
	if err != nil {
		return Binding{}, fmt.Errorf("set shadow binding app id: %w", err)
	}
	if affected, _ := res.RowsAffected(); affected == 0 {
		binding, getErr := s.GetBindingByUserID(ctx, userID)
		if getErr != nil {
			return Binding{}, getErr
		}
		if binding.Uin != uin || binding.OwnerUin != ownerUin || binding.AppID != appID {
			return Binding{}, fmt.Errorf("shadow binding identity changed while setting app id")
		}
		return binding, nil
	}
	return s.GetBindingByUserID(ctx, userID)
}

func (s *MySQLStore) MarkBindingRegistered(ctx context.Context, userID string, uin, ownerUin, appID int64, now time.Time) (Binding, error) {
	res, err := s.db.ExecContext(ctx, `
		UPDATE shadow_bindings
		SET uin = ?, owner_uin = ?, app_id = ?, status = ?, last_error_code = NULL, last_error_message = NULL, updated_at = ?
		WHERE user_id = ?
	`, uin, ownerUin, appID, StatusPending, now, userID)
	if err != nil {
		return Binding{}, fmt.Errorf("mark shadow binding registered: %w", err)
	}
	if affected, _ := res.RowsAffected(); affected == 0 {
		return Binding{}, ErrNotFound
	}
	return s.GetBindingByUserID(ctx, userID)
}

func (s *MySQLStore) MarkBindingFailed(ctx context.Context, userID string, code string, message string, now time.Time) (Binding, error) {
	res, err := s.db.ExecContext(ctx, `
		UPDATE shadow_bindings
		SET status = ?, last_error_code = ?, last_error_message = ?, updated_at = ?
		WHERE user_id = ?
	`, StatusFailed, code, message, now, userID)
	if err != nil {
		return Binding{}, fmt.Errorf("mark shadow binding failed: %w", err)
	}
	if affected, _ := res.RowsAffected(); affected == 0 {
		return Binding{}, ErrNotFound
	}
	return s.GetBindingByUserID(ctx, userID)
}

func (s *MySQLStore) MarkBasicAuthSucceeded(ctx context.Context, userID string, sourceAttemptID string, identityHash string, phoneHash string, now time.Time) (Binding, error) {
	res, err := s.db.ExecContext(ctx, `
		UPDATE shadow_bindings
		SET basic_auth_status = ?, basic_auth_synced_at = ?, basic_auth_source_attempt_id = ?, basic_auth_identity_hash = ?, basic_auth_phone_hash = ?, basic_auth_last_error_code = NULL, basic_auth_last_error_message = NULL, updated_at = ?
		WHERE user_id = ?
	`, BasicAuthStatusSucceeded, now, nullableString(sourceAttemptID), nullableString(identityHash), nullableString(phoneHash), now, userID)
	if err != nil {
		return Binding{}, fmt.Errorf("mark shadow basic auth succeeded: %w", err)
	}
	if affected, _ := res.RowsAffected(); affected == 0 {
		return Binding{}, ErrNotFound
	}
	return s.GetBindingByUserID(ctx, userID)
}

func (s *MySQLStore) MarkBasicAuthFailed(ctx context.Context, userID string, code string, message string, now time.Time) (Binding, error) {
	res, err := s.db.ExecContext(ctx, `
		UPDATE shadow_bindings
		SET basic_auth_status = ?, basic_auth_source_attempt_id = NULL, basic_auth_identity_hash = NULL, basic_auth_phone_hash = NULL, basic_auth_last_error_code = ?, basic_auth_last_error_message = ?, updated_at = ?
		WHERE user_id = ?
	`, BasicAuthStatusFailed, code, message, now, userID)
	if err != nil {
		return Binding{}, fmt.Errorf("mark shadow basic auth failed: %w", err)
	}
	if affected, _ := res.RowsAffected(); affected == 0 {
		return Binding{}, ErrNotFound
	}
	return s.GetBindingByUserID(ctx, userID)
}

func (s *MySQLStore) IssueAuthCode(ctx context.Context, userID string, purpose string, ttl time.Duration, now time.Time) (AuthCode, error) {
	code, err := newAuthCode()
	if err != nil {
		return AuthCode{}, err
	}
	record := AuthCode{Code: code, UserID: userID, Purpose: purpose, ExpiresAt: now.Add(ttl), CreatedAt: now}
	_, err = s.db.ExecContext(ctx, `
		INSERT INTO shadow_auth_codes (code, user_id, purpose, expires_at, created_at)
		VALUES (?, ?, ?, ?, ?)
	`, record.Code, record.UserID, record.Purpose, record.ExpiresAt, record.CreatedAt)
	if err != nil {
		return AuthCode{}, fmt.Errorf("issue shadow auth code: %w", err)
	}
	return record, nil
}

func (s *MySQLStore) ConsumeAuthCode(ctx context.Context, code string, now time.Time) (AuthCode, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return AuthCode{}, fmt.Errorf("begin consume auth code: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	row := tx.QueryRowContext(ctx, `
		SELECT code, user_id, purpose, expires_at, consumed_at, created_at
		FROM shadow_auth_codes
		WHERE code = ?
		FOR UPDATE
	`, code)
	var record AuthCode
	var consumedAt sql.NullTime
	if err := row.Scan(&record.Code, &record.UserID, &record.Purpose, &record.ExpiresAt, &consumedAt, &record.CreatedAt); errors.Is(err, sql.ErrNoRows) {
		return AuthCode{}, ErrNotFound
	} else if err != nil {
		return AuthCode{}, fmt.Errorf("query shadow auth code: %w", err)
	}
	if consumedAt.Valid || !record.ExpiresAt.After(now) {
		return AuthCode{}, ErrNotFound
	}
	if _, err := tx.ExecContext(ctx, `UPDATE shadow_auth_codes SET consumed_at = ? WHERE code = ?`, now, code); err != nil {
		return AuthCode{}, fmt.Errorf("consume shadow auth code: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return AuthCode{}, fmt.Errorf("commit consume auth code: %w", err)
	}
	record.ConsumedAt = &now
	return record, nil
}
