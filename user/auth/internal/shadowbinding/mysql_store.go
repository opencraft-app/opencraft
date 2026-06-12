package shadowbinding

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"
)

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
			       COALESCE(basic_auth_last_error_code, ''), COALESCE(basic_auth_last_error_message, ''),
			       created_at, updated_at
			FROM shadow_bindings
			WHERE shadow_user_name = ?
		`, shadowUserName)
	return scanBinding(row, "get shadow binding by shadow username")
}

func scanBinding(row *sql.Row, operation string) (Binding, error) {
	var binding Binding
	var basicAuthSyncedAt sql.NullTime
	if err := row.Scan(&binding.UserID, &binding.ShadowUserName, &binding.Uin, &binding.OwnerUin, &binding.AppID, &binding.Status, &binding.LastErrorCode, &binding.LastErrorMessage, &binding.BasicAuthStatus, &basicAuthSyncedAt, &binding.BasicAuthLastErrorCode, &binding.BasicAuthLastErrorMessage, &binding.CreatedAt, &binding.UpdatedAt); errors.Is(err, sql.ErrNoRows) {
		return Binding{}, ErrNotFound
	} else if err != nil {
		return Binding{}, fmt.Errorf("%s: %w", operation, err)
	}
	if basicAuthSyncedAt.Valid {
		binding.BasicAuthSyncedAt = &basicAuthSyncedAt.Time
	}
	return binding, nil
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

func (s *MySQLStore) MarkBasicAuthSucceeded(ctx context.Context, userID string, now time.Time) (Binding, error) {
	res, err := s.db.ExecContext(ctx, `
		UPDATE shadow_bindings
		SET basic_auth_status = ?, basic_auth_synced_at = ?, basic_auth_last_error_code = NULL, basic_auth_last_error_message = NULL, updated_at = ?
		WHERE user_id = ?
	`, BasicAuthStatusSucceeded, now, now, userID)
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
		SET basic_auth_status = ?, basic_auth_last_error_code = ?, basic_auth_last_error_message = ?, updated_at = ?
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
