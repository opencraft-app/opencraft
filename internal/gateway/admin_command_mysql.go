package gateway

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"
)

const adminCommandSelectColumns = `
	id, dedupe_key, set_id, external_user_id, kind, payload_json, status, attempts,
	lease_owner, lease_until, next_run_at, result_json, last_error, created_at, updated_at`

func (s *MySQLStore) EnqueueAdminCommand(ctx context.Context, command AdminCommand) (AdminCommand, bool, error) {
	command.ID = strings.TrimSpace(command.ID)
	command.DedupeKey = strings.TrimSpace(command.DedupeKey)
	if command.ID == "" || command.DedupeKey == "" || command.SetID == "" || command.Kind == "" {
		return AdminCommand{}, false, fmt.Errorf("admin command requires id, dedupe_key, set_id and kind")
	}
	now := time.Now().UTC()
	if command.Status == "" {
		command.Status = AdminCommandStatusPending
	}
	if command.NextRunAt.IsZero() {
		command.NextRunAt = now
	}
	if command.CreatedAt.IsZero() {
		command.CreatedAt = now
	}
	command.UpdatedAt = now
	result, err := s.db.ExecContext(ctx, `
		INSERT IGNORE INTO llmgateway_admin_commands (
			id, dedupe_key, set_id, external_user_id, kind, payload_json, status, attempts,
			lease_owner, lease_until, next_run_at, result_json, last_error, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', NULL, ?, '', '', ?, ?)
	`, command.ID, command.DedupeKey, command.SetID, command.ExternalUserID, command.Kind,
		command.Payload, command.Status, command.Attempts, nullableTime(command.NextRunAt), command.CreatedAt, command.UpdatedAt)
	if err != nil {
		return AdminCommand{}, false, err
	}
	rows, err := result.RowsAffected()
	if err != nil {
		return AdminCommand{}, false, err
	}
	row := s.db.QueryRowContext(ctx, `SELECT `+adminCommandSelectColumns+` FROM llmgateway_admin_commands WHERE dedupe_key = ?`, command.DedupeKey)
	saved, err := scanAdminCommand(row)
	return saved, rows > 0, err
}

func (s *MySQLStore) GetAdminCommand(ctx context.Context, id string) (AdminCommand, bool, error) {
	command, err := scanAdminCommand(s.db.QueryRowContext(ctx, `SELECT `+adminCommandSelectColumns+` FROM llmgateway_admin_commands WHERE id = ?`, strings.TrimSpace(id)))
	if errors.Is(err, sql.ErrNoRows) {
		return AdminCommand{}, false, nil
	}
	return command, err == nil, err
}

func (s *MySQLStore) ListAdminCommands(ctx context.Context, opts AdminCommandListOptions) ([]AdminCommand, error) {
	query := `SELECT ` + adminCommandSelectColumns + ` FROM llmgateway_admin_commands WHERE 1=1`
	args := []any{}
	if len(opts.Statuses) > 0 {
		query += ` AND status IN (` + strings.TrimRight(strings.Repeat("?,", len(opts.Statuses)), ",") + `)`
		for _, status := range opts.Statuses {
			args = append(args, status)
		}
	}
	now := opts.Now
	if now.IsZero() {
		now = time.Now().UTC()
	}
	query += ` AND (next_run_at IS NULL OR next_run_at <= ?) ORDER BY COALESCE(next_run_at, created_at), created_at`
	args = append(args, now)
	limit := opts.Limit
	if limit <= 0 || limit > 1000 {
		limit = 100
	}
	query += ` LIMIT ?`
	args = append(args, limit)
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	commands := make([]AdminCommand, 0)
	for rows.Next() {
		command, err := scanAdminCommand(rows)
		if err != nil {
			return nil, err
		}
		commands = append(commands, command)
	}
	return commands, rows.Err()
}

func (s *MySQLStore) TryAcquireAdminCommand(ctx context.Context, id, owner string, ttl time.Duration, now time.Time) (AdminCommand, bool, error) {
	if strings.TrimSpace(owner) == "" || ttl <= 0 {
		return AdminCommand{}, false, fmt.Errorf("admin command lease requires owner and ttl")
	}
	result, err := s.db.ExecContext(ctx, `
		UPDATE llmgateway_admin_commands
		SET status = ?, attempts = attempts + 1, lease_owner = ?, lease_until = ?, updated_at = ?
		WHERE id = ?
		  AND ((status IN (?, ?)) OR (status = ? AND (lease_until IS NULL OR lease_until <= ?)))
		  AND (next_run_at IS NULL OR next_run_at <= ?)
	`, AdminCommandStatusRunning, owner, now.Add(ttl), now, strings.TrimSpace(id),
		AdminCommandStatusPending, AdminCommandStatusError, AdminCommandStatusRunning, now, now)
	if err != nil {
		return AdminCommand{}, false, err
	}
	rows, err := result.RowsAffected()
	if err != nil || rows == 0 {
		return AdminCommand{}, false, err
	}
	command, ok, err := s.GetAdminCommand(ctx, id)
	return command, ok, err
}

func (s *MySQLStore) ReleaseAdminCommand(ctx context.Context, command AdminCommand, now time.Time) (bool, error) {
	result, err := s.db.ExecContext(ctx, `
		UPDATE llmgateway_admin_commands
		SET status = ?, lease_owner = '', lease_until = NULL, next_run_at = ?, updated_at = ?
		WHERE id = ? AND status = ? AND lease_owner = ?
	`, AdminCommandStatusPending, now, now, command.ID, AdminCommandStatusRunning, command.LeaseOwner)
	if err != nil {
		return false, err
	}
	rows, err := result.RowsAffected()
	return rows > 0, err
}

func (s *MySQLStore) CompleteAdminCommand(ctx context.Context, command AdminCommand, status, resultJSON, lastError string, nextRunAt, now time.Time) (AdminCommand, error) {
	result, err := s.db.ExecContext(ctx, `
		UPDATE llmgateway_admin_commands
		SET status = ?, result_json = ?, last_error = ?, next_run_at = ?,
			lease_owner = '', lease_until = NULL, updated_at = ?
		WHERE id = ? AND status = ? AND lease_owner = ?
	`, status, resultJSON, lastError, nullableTime(nextRunAt), now, command.ID, AdminCommandStatusRunning, command.LeaseOwner)
	if err != nil {
		return AdminCommand{}, err
	}
	rows, err := result.RowsAffected()
	if err != nil {
		return AdminCommand{}, err
	}
	if rows == 0 {
		return AdminCommand{}, fmt.Errorf("admin command %q lease lost", command.ID)
	}
	completed, ok, err := s.GetAdminCommand(ctx, command.ID)
	if err != nil {
		return AdminCommand{}, err
	}
	if !ok {
		return AdminCommand{}, fmt.Errorf("admin command %q not found", command.ID)
	}
	return completed, nil
}

func scanAdminCommand(row scanner) (AdminCommand, error) {
	var command AdminCommand
	var leaseUntil, nextRunAt sql.NullTime
	err := row.Scan(
		&command.ID, &command.DedupeKey, &command.SetID, &command.ExternalUserID,
		&command.Kind, &command.Payload, &command.Status, &command.Attempts,
		&command.LeaseOwner, &leaseUntil, &nextRunAt, &command.Result, &command.LastError,
		&command.CreatedAt, &command.UpdatedAt,
	)
	if leaseUntil.Valid {
		command.LeaseUntil = leaseUntil.Time.UTC()
	}
	if nextRunAt.Valid {
		command.NextRunAt = nextRunAt.Time.UTC()
	}
	command.CreatedAt = command.CreatedAt.UTC()
	command.UpdatedAt = command.UpdatedAt.UTC()
	return command, err
}
