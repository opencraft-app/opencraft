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
	_, err := s.db.ExecContext(ctx, `
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
	deleted_at = NULL`,
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
