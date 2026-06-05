package redis

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	goredis "github.com/redis/go-redis/v9"
)

// WorkspaceLeaseRequest mirrors wrapper.WorkspaceLeaseRequest.
type WorkspaceLeaseRequest struct {
	WorkspaceID string
	RuntimeID   string
	Provider    string
	TTL         time.Duration
}

// WorkspaceLease mirrors wrapper.WorkspaceLease.
type WorkspaceLease struct {
	WorkspaceID  string
	RuntimeID    string
	LeaseID      string
	FencingToken int64
	State        string
	ExpiresAt    time.Time
	HeartbeatAt  time.Time
	CreatedAt    time.Time
	UpdatedAt    time.Time
}

// WorkspaceLeaseHeldError mirrors wrapper.WorkspaceLeaseHeldError.
type WorkspaceLeaseHeldError struct {
	WorkspaceID string
	RuntimeID   string
	LeaseID     string
	ExpiresAt   time.Time
}

func (e WorkspaceLeaseHeldError) Error() string {
	return fmt.Sprintf("workspace %s is already leased by runtime %s until %s",
		e.WorkspaceID, e.RuntimeID, e.ExpiresAt.Format(time.RFC3339Nano))
}

func (e WorkspaceLeaseHeldError) Is(target error) bool {
	_, ok := target.(WorkspaceLeaseHeldError)
	return ok
}

const defaultWorkspaceLeaseTTL = 15 * time.Minute

// acquireWorkspaceLeaseScript atomically acquires a workspace lease.
//
// KEYS[1] = gw:ws:{workspace_id}:lease
// KEYS[2] = gw:ws:{workspace_id}:fence
// ARGV[1] = runtime_id
// ARGV[2] = lease_id
// ARGV[3] = now (RFC3339Nano)
// ARGV[4] = expires_at (RFC3339Nano)
// ARGV[5] = grace_ttl_ms
//
// Returns: "OK:<fencing_token>" or "HELD:<runtime_id>:<lease_id>:<expires_at>"
const acquireWorkspaceLeaseScript = `
local lease_key = KEYS[1]
local fence_key = KEYS[2]
local new_runtime = ARGV[1]
local new_lease_id = ARGV[2]
local now = ARGV[3]
local new_expires = ARGV[4]
local grace_ms = tonumber(ARGV[5])

local cur_state = redis.call('HGET', lease_key, 'state')
if cur_state == 'active' then
  local cur_expires = redis.call('HGET', lease_key, 'expires_at')
  if cur_expires > now then
    local cur_runtime = redis.call('HGET', lease_key, 'runtime_id')
    local cur_lease = redis.call('HGET', lease_key, 'lease_id')
    return 'HELD:' .. cur_runtime .. ':' .. cur_lease .. ':' .. cur_expires
  end
end

-- Increment global fencing token
local token = redis.call('INCR', fence_key)

redis.call('HMSET', lease_key,
  'runtime_id', new_runtime,
  'lease_id', new_lease_id,
  'fencing_token', tostring(token),
  'state', 'active',
  'expires_at', new_expires,
  'heartbeat_at', now,
  'created_at', now,
  'updated_at', now)
redis.call('PEXPIRE', lease_key, grace_ms)
return 'OK:' .. token
`

// renewWorkspaceLeaseScript extends the TTL of an active workspace lease.
//
// KEYS[1] = gw:ws:{workspace_id}:lease
// ARGV[1] = runtime_id
// ARGV[2] = lease_id
// ARGV[3] = fencing_token
// ARGV[4] = now (RFC3339Nano)
// ARGV[5] = new_expires_at (RFC3339Nano)
// ARGV[6] = grace_ttl_ms
//
// Returns: "OK" or "LOST"
const renewWorkspaceLeaseScript = `
local key = KEYS[1]
local rt = ARGV[1]
local lid = ARGV[2]
local fence = ARGV[3]
local now = ARGV[4]
local new_expires = ARGV[5]
local grace_ms = tonumber(ARGV[6])

local cur_rt = redis.call('HGET', key, 'runtime_id')
local cur_lid = redis.call('HGET', key, 'lease_id')
local cur_fence = redis.call('HGET', key, 'fencing_token')
local cur_state = redis.call('HGET', key, 'state')

if cur_state ~= 'active' or cur_rt ~= rt or cur_lid ~= lid or cur_fence ~= fence then
  return 'LOST'
end

redis.call('HMSET', key, 'expires_at', new_expires, 'heartbeat_at', now, 'updated_at', now)
redis.call('PEXPIRE', key, grace_ms)
return 'OK'
`

// releaseWorkspaceLeaseScript marks a workspace lease as released.
//
// KEYS[1] = gw:ws:{workspace_id}:lease
// ARGV[1] = runtime_id
// ARGV[2] = lease_id
// ARGV[3] = fencing_token
// ARGV[4] = now (RFC3339Nano)
//
// Returns: "OK" or "MISS"
const releaseWorkspaceLeaseScript = `
local key = KEYS[1]
local rt = ARGV[1]
local lid = ARGV[2]
local fence = ARGV[3]
local now = ARGV[4]

local cur_rt = redis.call('HGET', key, 'runtime_id')
local cur_lid = redis.call('HGET', key, 'lease_id')
local cur_fence = redis.call('HGET', key, 'fencing_token')

if cur_rt ~= rt or cur_lid ~= lid or cur_fence ~= fence then
  return 'MISS'
end

redis.call('HMSET', key, 'state', 'released', 'expires_at', now, 'updated_at', now)
redis.call('PEXPIRE', key, 60000)
return 'OK'
`

// AcquireLease implements WorkspaceLeaseStore (wrapper.WorkspaceService partial).
func (s *LockStore) AcquireLease(ctx context.Context, req WorkspaceLeaseRequest) (WorkspaceLease, error) {
	if req.WorkspaceID == "" {
		return WorkspaceLease{}, errors.New("workspace id is required")
	}
	if req.RuntimeID == "" {
		return WorkspaceLease{}, errors.New("runtime id is required")
	}
	ttl := req.TTL
	if ttl <= 0 {
		ttl = defaultWorkspaceLeaseTTL
	}
	now := time.Now().UTC()
	expiresAt := now.Add(ttl)
	leaseID := "lease_" + randomID()

	result, err := s.client.Eval(ctx, acquireWorkspaceLeaseScript,
		s.keyspace.workspaceAcquireLeaseKeys(req.WorkspaceID),
		req.RuntimeID,
		leaseID,
		formatTime(now),
		formatTime(expiresAt),
		formatInt64(ttlMs(graceTTL(ttl))),
	).Text()
	if err != nil && !errors.Is(err, goredis.Nil) {
		return WorkspaceLease{}, fmt.Errorf("redis acquire workspace lease: %w", err)
	}

	if strings.HasPrefix(result, "OK:") {
		token := parseInt64(strings.TrimPrefix(result, "OK:"))
		return WorkspaceLease{
			WorkspaceID:  req.WorkspaceID,
			RuntimeID:    req.RuntimeID,
			LeaseID:      leaseID,
			FencingToken: token,
			State:        "active",
			ExpiresAt:    expiresAt,
			HeartbeatAt:  now,
			CreatedAt:    now,
			UpdatedAt:    now,
		}, nil
	}

	if strings.HasPrefix(result, "HELD:") {
		parts := strings.SplitN(strings.TrimPrefix(result, "HELD:"), ":", 3)
		var heldRT, heldLease string
		var heldExpires time.Time
		if len(parts) >= 1 {
			heldRT = parts[0]
		}
		if len(parts) >= 2 {
			heldLease = parts[1]
		}
		if len(parts) >= 3 {
			heldExpires = parseTime(parts[2])
		}
		return WorkspaceLease{}, WorkspaceLeaseHeldError{
			WorkspaceID: req.WorkspaceID,
			RuntimeID:   heldRT,
			LeaseID:     heldLease,
			ExpiresAt:   heldExpires,
		}
	}

	return WorkspaceLease{}, fmt.Errorf("redis acquire workspace lease: unexpected result %q", result)
}

// RenewLease implements WorkspaceLeaseStore.
func (s *LockStore) RenewLease(ctx context.Context, lease WorkspaceLease, ttl time.Duration) (WorkspaceLease, error) {
	if lease.WorkspaceID == "" || lease.RuntimeID == "" || lease.LeaseID == "" || lease.FencingToken == 0 {
		return WorkspaceLease{}, errors.New("workspace lease identity is incomplete")
	}
	if ttl <= 0 {
		ttl = defaultWorkspaceLeaseTTL
	}
	now := time.Now().UTC()
	expiresAt := now.Add(ttl)

	key := s.keyspace.workspaceLease(lease.WorkspaceID)
	result, err := s.client.Eval(ctx, renewWorkspaceLeaseScript, []string{key},
		lease.RuntimeID,
		lease.LeaseID,
		formatInt64(lease.FencingToken),
		formatTime(now),
		formatTime(expiresAt),
		formatInt64(ttlMs(graceTTL(ttl))),
	).Text()
	if err != nil && !errors.Is(err, goredis.Nil) {
		return WorkspaceLease{}, fmt.Errorf("redis renew workspace lease: %w", err)
	}
	if result == "OK" {
		lease.ExpiresAt = expiresAt
		lease.HeartbeatAt = now
		lease.UpdatedAt = now
		return lease, nil
	}
	return WorkspaceLease{}, WorkspaceLeaseHeldError{
		WorkspaceID: lease.WorkspaceID,
		RuntimeID:   lease.RuntimeID,
		LeaseID:     lease.LeaseID,
		ExpiresAt:   lease.ExpiresAt,
	}
}

// ReleaseLease implements WorkspaceLeaseStore.
func (s *LockStore) ReleaseLease(ctx context.Context, lease WorkspaceLease) error {
	if lease.LeaseID == "" {
		return nil
	}
	now := time.Now().UTC()
	key := s.keyspace.workspaceLease(lease.WorkspaceID)
	_, err := s.client.Eval(ctx, releaseWorkspaceLeaseScript, []string{key},
		lease.RuntimeID,
		lease.LeaseID,
		formatInt64(lease.FencingToken),
		formatTime(now),
	).Text()
	if err != nil && !errors.Is(err, goredis.Nil) {
		return fmt.Errorf("redis release workspace lease: %w", err)
	}
	return nil
}

// GetLease implements WorkspaceLeaseStore.
func (s *LockStore) GetLease(ctx context.Context, workspaceID string) (WorkspaceLease, bool, error) {
	if workspaceID == "" {
		return WorkspaceLease{}, false, nil
	}
	key := s.keyspace.workspaceLease(workspaceID)
	result, err := s.client.HGetAll(ctx, key).Result()
	if err != nil {
		return WorkspaceLease{}, false, fmt.Errorf("redis get workspace lease: %w", err)
	}
	if len(result) == 0 {
		return WorkspaceLease{}, false, nil
	}
	lease := WorkspaceLease{
		WorkspaceID:  workspaceID,
		RuntimeID:    result["runtime_id"],
		LeaseID:      result["lease_id"],
		FencingToken: parseInt64(result["fencing_token"]),
		State:        result["state"],
		ExpiresAt:    parseTime(result["expires_at"]),
		HeartbeatAt:  parseTime(result["heartbeat_at"]),
		CreatedAt:    parseTime(result["created_at"]),
		UpdatedAt:    parseTime(result["updated_at"]),
	}
	return lease, true, nil
}
