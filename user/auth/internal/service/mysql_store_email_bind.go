package service

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"
)

func (s *MySQLStore) RequestEmailBind(ctx context.Context, token string, email string, tokenHash string, now time.Time, tokenTTL time.Duration, cooldown time.Duration) (time.Duration, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, fmt.Errorf("begin tx: %w", err)
	}
	defer rollback(tx)

	userID, err := currentSessionUserIDTx(ctx, tx, strings.TrimSpace(token), now)
	if err != nil {
		return 0, err
	}

	var existingCooldownUntil time.Time
	err = tx.QueryRowContext(ctx, `
		SELECT cooldown_until
		FROM email_bind_tokens
		WHERE user_id = ?
		FOR UPDATE
	`, userID).Scan(&existingCooldownUntil)
	if err == nil && existingCooldownUntil.After(now) {
		return 0, &Error{
			Code:       "email_bind_cooldown",
			Message:    "验证邮件发送过于频繁，请稍后再试。",
			Status:     429,
			RetryAfter: existingCooldownUntil.Sub(now),
		}
	}
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return 0, fmt.Errorf("query email bind cooldown: %w", err)
	}

	if _, found, err := findUserByEmailTx(ctx, tx, email); err != nil {
		return 0, fmt.Errorf("check email availability: %w", err)
	} else if found {
		return 0, newError("email_in_use", "该邮箱已被其他账号使用。", 409)
	}

	expiresAt := now.Add(tokenTTL)
	cooldownUntil := now.Add(cooldown)
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO email_bind_tokens (
			user_id,
			email,
			token_hash,
			expires_at,
			cooldown_until,
			created_at,
			updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?)
		ON DUPLICATE KEY UPDATE
			email = VALUES(email),
			token_hash = VALUES(token_hash),
			expires_at = VALUES(expires_at),
			cooldown_until = VALUES(cooldown_until),
			updated_at = VALUES(updated_at)
	`, userID, email, tokenHash, expiresAt, cooldownUntil, now, now); err != nil {
		return 0, fmt.Errorf("upsert email bind token: %w", err)
	}

	if err := tx.Commit(); err != nil {
		return 0, fmt.Errorf("commit email bind request: %w", err)
	}
	return cooldown, nil
}

func (s *MySQLStore) ConfirmEmailBind(ctx context.Context, tokenHash string, now time.Time) (User, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return User{}, fmt.Errorf("begin tx: %w", err)
	}
	defer rollback(tx)

	var userID string
	var email string
	var expiresAt time.Time
	err = tx.QueryRowContext(ctx, `
		SELECT user_id, email, expires_at
		FROM email_bind_tokens
		WHERE token_hash = ?
		FOR UPDATE
	`, tokenHash).Scan(&userID, &email, &expiresAt)
	if errors.Is(err, sql.ErrNoRows) {
		return User{}, newError("invalid_email_bind_token", "绑定链接无效或已过期。", 400)
	}
	if err != nil {
		return User{}, fmt.Errorf("query email bind token: %w", err)
	}
	if expiresAt.Before(now) {
		if _, deleteErr := tx.ExecContext(ctx, `DELETE FROM email_bind_tokens WHERE token_hash = ?`, tokenHash); deleteErr != nil {
			return User{}, fmt.Errorf("delete expired email bind token: %w", deleteErr)
		}
		if commitErr := tx.Commit(); commitErr != nil {
			return User{}, fmt.Errorf("commit expired email bind cleanup: %w", commitErr)
		}
		return User{}, newError("email_bind_expired", "绑定链接已过期，请重新发送验证邮件。", 400)
	}

	existingUser, found, lookupErr := findUserByEmailTx(ctx, tx, email)
	if lookupErr != nil {
		return User{}, fmt.Errorf("check email availability: %w", lookupErr)
	}
	if found && existingUser.ID != userID {
		return User{}, newError("email_in_use", "该邮箱已被其他账号使用。", 409)
	}

	if _, err := tx.ExecContext(ctx, `
		UPDATE users
		SET email = ?, email_verified = TRUE, updated_at = ?
		WHERE id = ?
	`, email, now, userID); err != nil {
		if isMySQLDuplicate(err) {
			return User{}, newError("email_in_use", "该邮箱已被其他账号使用。", 409)
		}
		return User{}, fmt.Errorf("update user email: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM email_bind_tokens WHERE user_id = ?`, userID); err != nil {
		return User{}, fmt.Errorf("delete email bind token: %w", err)
	}

	user, err := s.loadUserByIDTx(ctx, tx, userID)
	if err != nil {
		return User{}, err
	}
	if err := tx.Commit(); err != nil {
		return User{}, fmt.Errorf("commit email bind confirm: %w", err)
	}
	return user, nil
}
