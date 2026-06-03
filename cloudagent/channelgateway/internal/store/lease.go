package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"
)

var ErrLeaseHeld = errors.New("channel lease is held")

type LeaseHeldError struct {
	ChannelAccountID string
	OwnerID          string
	ExpiresAt        time.Time
}

func (e LeaseHeldError) Error() string {
	return fmt.Sprintf("channel lease for %s is held by %s until %s", e.ChannelAccountID, e.OwnerID, e.ExpiresAt.Format(time.RFC3339Nano))
}

func (s *Store) AcquireChannelLease(ctx context.Context, channelAccountID, ownerID string, ttl time.Duration) (ChannelLease, error) {
	if s == nil || s.db == nil {
		return ChannelLease{}, errors.New("store is nil")
	}
	if channelAccountID == "" {
		return ChannelLease{}, errors.New("channel account id is required")
	}
	if ownerID == "" {
		return ChannelLease{}, errors.New("owner id is required")
	}
	if ttl <= 0 {
		ttl = 90 * time.Second
	}
	now := time.Now().UTC()
	expires := now.Add(ttl)
	s.mu.Lock()
	defer s.mu.Unlock()
	result, err := s.db.ExecContext(ctx, `
INSERT INTO channel_leases (
	channel_account_id, owner_id, fencing_token, state, expires_at, heartbeat_at, created_at, updated_at
) VALUES (?, ?, 1, 'active', ?, ?, ?, ?)
ON CONFLICT(channel_account_id) DO UPDATE SET
	owner_id = excluded.owner_id,
	fencing_token = channel_leases.fencing_token + 1,
	state = 'active',
	expires_at = excluded.expires_at,
	heartbeat_at = excluded.heartbeat_at,
	updated_at = excluded.updated_at
WHERE channel_leases.state <> 'active'
	OR channel_leases.expires_at <= ?
	OR channel_leases.owner_id = ?`,
		channelAccountID, ownerID, expires.Format(time.RFC3339Nano), now.Format(time.RFC3339Nano),
		now.Format(time.RFC3339Nano), now.Format(time.RFC3339Nano), now.Format(time.RFC3339Nano), ownerID)
	if err != nil {
		return ChannelLease{}, err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return ChannelLease{}, err
	}
	if affected == 0 {
		held, ok, err := s.loadChannelLeaseLocked(ctx, channelAccountID)
		if err != nil {
			return ChannelLease{}, err
		}
		if !ok {
			return ChannelLease{}, ErrLeaseHeld
		}
		return ChannelLease{}, LeaseHeldError{ChannelAccountID: channelAccountID, OwnerID: held.OwnerID, ExpiresAt: held.ExpiresAt}
	}
	lease, ok, err := s.loadChannelLeaseLocked(ctx, channelAccountID)
	if err != nil {
		return ChannelLease{}, err
	}
	if !ok {
		return ChannelLease{}, fmt.Errorf("channel lease %s was not stored", channelAccountID)
	}
	return lease, nil
}

func (s *Store) RenewChannelLease(ctx context.Context, lease ChannelLease, ttl time.Duration) (ChannelLease, error) {
	if s == nil || s.db == nil || lease.ChannelAccountID == "" {
		return lease, nil
	}
	if ttl <= 0 {
		ttl = 90 * time.Second
	}
	now := time.Now().UTC()
	expires := now.Add(ttl)
	s.mu.Lock()
	defer s.mu.Unlock()
	result, err := s.db.ExecContext(ctx, `
UPDATE channel_leases
SET expires_at = ?, heartbeat_at = ?, updated_at = ?
WHERE channel_account_id = ? AND owner_id = ? AND fencing_token = ? AND state = 'active'`,
		expires.Format(time.RFC3339Nano), now.Format(time.RFC3339Nano), now.Format(time.RFC3339Nano),
		lease.ChannelAccountID, lease.OwnerID, lease.FencingToken)
	if err != nil {
		return ChannelLease{}, err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return ChannelLease{}, err
	}
	if affected == 0 {
		return ChannelLease{}, ErrLeaseHeld
	}
	lease.ExpiresAt = expires
	return lease, nil
}

func (s *Store) ReleaseChannelLease(ctx context.Context, lease ChannelLease) error {
	if s == nil || s.db == nil || lease.ChannelAccountID == "" {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.ExecContext(ctx, `
UPDATE channel_leases
SET state = 'released', updated_at = ?
WHERE channel_account_id = ? AND owner_id = ? AND fencing_token = ?`,
		nowText(), lease.ChannelAccountID, lease.OwnerID, lease.FencingToken)
	return err
}

func (s *Store) loadChannelLeaseLocked(ctx context.Context, channelAccountID string) (ChannelLease, bool, error) {
	var lease ChannelLease
	var expiresAt string
	err := s.db.QueryRowContext(ctx, `
SELECT channel_account_id, owner_id, fencing_token, expires_at
FROM channel_leases
WHERE channel_account_id = ?`, channelAccountID).Scan(
		&lease.ChannelAccountID, &lease.OwnerID, &lease.FencingToken, &expiresAt,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return ChannelLease{}, false, nil
	}
	if err != nil {
		return ChannelLease{}, false, err
	}
	parsed, err := parseTime(expiresAt)
	if err != nil {
		return ChannelLease{}, false, err
	}
	lease.ExpiresAt = parsed
	return lease, true, nil
}
