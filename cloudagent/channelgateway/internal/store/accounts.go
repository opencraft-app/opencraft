package store

import (
	"context"
	"database/sql"
	"errors"
	"strings"
)

func (s *Store) UpsertChannelAccount(ctx context.Context, account ChannelAccount) error {
	if s == nil || s.db == nil {
		return errors.New("store is nil")
	}
	if strings.TrimSpace(account.ChannelAccountID) == "" {
		return errors.New("channel account id is required")
	}
	if strings.TrimSpace(account.ChannelType) == "" {
		return errors.New("channel type is required")
	}
	if strings.TrimSpace(account.AgentID) == "" {
		return errors.New("agent id is required")
	}
	if strings.TrimSpace(account.ConfigJSON) == "" {
		account.ConfigJSON = "{}"
	}
	if strings.TrimSpace(account.Status) == "" {
		account.Status = "active"
	}
	now := nowText()
	s.mu.Lock()
	defer s.mu.Unlock()
	query := `
INSERT INTO channel_accounts (
	channel_account_id, channel_type, tenant_id, project_id, agent_id, config_json, status, created_at, updated_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(channel_account_id) DO UPDATE SET
	channel_type = excluded.channel_type,
	tenant_id = excluded.tenant_id,
	project_id = excluded.project_id,
	agent_id = excluded.agent_id,
	config_json = excluded.config_json,
	status = excluded.status,
	updated_at = excluded.updated_at,
	deleted_at = NULL`
	if s.dialect == dialectMySQL {
		query = `
INSERT INTO channel_accounts (
	channel_account_id, channel_type, tenant_id, project_id, agent_id, config_json, status, created_at, updated_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
ON DUPLICATE KEY UPDATE
	channel_type = VALUES(channel_type),
	tenant_id = VALUES(tenant_id),
	project_id = VALUES(project_id),
	agent_id = VALUES(agent_id),
	config_json = VALUES(config_json),
	status = VALUES(status),
	updated_at = VALUES(updated_at),
	deleted_at = NULL`
	}
	_, err := s.db.ExecContext(ctx, query,
		account.ChannelAccountID, account.ChannelType, account.TenantID, account.ProjectID,
		account.AgentID, account.ConfigJSON, account.Status, now, now)
	return err
}

func (s *Store) LoadChannelAccount(ctx context.Context, id string) (ChannelAccount, bool, error) {
	if s == nil || s.db == nil {
		return ChannelAccount{}, false, errors.New("store is nil")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	var account ChannelAccount
	err := s.db.QueryRowContext(ctx, `
SELECT channel_account_id, channel_type, tenant_id, project_id, agent_id, config_json, status
FROM channel_accounts
WHERE channel_account_id = ? AND deleted_at IS NULL`, id).Scan(
		&account.ChannelAccountID, &account.ChannelType, &account.TenantID,
		&account.ProjectID, &account.AgentID, &account.ConfigJSON, &account.Status,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return ChannelAccount{}, false, nil
	}
	if err != nil {
		return ChannelAccount{}, false, err
	}
	return account, true, nil
}

func (s *Store) ListActiveChannelAccounts(ctx context.Context, channelType string) ([]ChannelAccount, error) {
	if s == nil || s.db == nil {
		return nil, errors.New("store is nil")
	}
	channelType = strings.TrimSpace(channelType)
	if channelType == "" {
		return nil, errors.New("channel type is required")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	rows, err := s.db.QueryContext(ctx, `
SELECT channel_account_id, channel_type, tenant_id, project_id, agent_id, config_json, status
FROM channel_accounts
WHERE channel_type = ? AND status = 'active' AND deleted_at IS NULL
ORDER BY channel_account_id`, channelType)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var accounts []ChannelAccount
	for rows.Next() {
		var account ChannelAccount
		if err := rows.Scan(
			&account.ChannelAccountID, &account.ChannelType, &account.TenantID,
			&account.ProjectID, &account.AgentID, &account.ConfigJSON, &account.Status,
		); err != nil {
			return nil, err
		}
		accounts = append(accounts, account)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return accounts, nil
}
