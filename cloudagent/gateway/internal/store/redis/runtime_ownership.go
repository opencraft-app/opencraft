package redis

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	goredis "github.com/redis/go-redis/v9"
)

// RuntimeOwnershipRequest mirrors wrapper.RuntimeOwnershipRequest.
type RuntimeOwnershipRequest struct {
	SessionID      string
	Generation     int64
	RunID          string
	OwnerID        string
	Operation      string
	TTL            time.Duration
	AllowSameOwner bool
}

// RuntimeOwnershipLease mirrors wrapper.RuntimeOwnershipLease.
type RuntimeOwnershipLease struct {
	SessionID    string
	Generation   int64
	RunID        string
	OwnerID      string
	Operation    string
	FencingToken int64
	ExpiresAt    time.Time
}

// RuntimeOwnershipHeldError mirrors wrapper.RuntimeOwnershipHeldError.
type RuntimeOwnershipHeldError struct {
	SessionID  string
	Generation int64
	RunID      string
	OwnerID    string
	Operation  string
	ExpiresAt  time.Time
}

func (e RuntimeOwnershipHeldError) Error() string {
	if e.SessionID == "" {
		return "runtime ownership held"
	}
	return fmt.Sprintf("runtime ownership for session %s is held by %s run %s until %s",
		e.SessionID, e.OwnerID, e.RunID, e.ExpiresAt.Format(time.RFC3339Nano))
}

func (e RuntimeOwnershipHeldError) Is(target error) bool {
	_, ok := target.(RuntimeOwnershipHeldError)
	return ok
}

const defaultOwnershipTTL = 10 * time.Minute

func normalizeOwnershipTTL(ttl time.Duration) time.Duration {
	if ttl <= 0 {
		return defaultOwnershipTTL
	}
	return ttl
}

// AcquireRuntimeOwnership implements RuntimeOwnershipStore.
func (s *LockStore) AcquireRuntimeOwnership(ctx context.Context, req RuntimeOwnershipRequest) (RuntimeOwnershipLease, error) {
	if req.SessionID == "" {
		return RuntimeOwnershipLease{}, errors.New("runtime ownership session id is required")
	}
	if req.Generation <= 0 {
		return RuntimeOwnershipLease{}, errors.New("runtime ownership generation is required")
	}
	if req.RunID == "" {
		return RuntimeOwnershipLease{}, errors.New("runtime ownership run id is required")
	}
	if req.OwnerID == "" {
		return RuntimeOwnershipLease{}, errors.New("runtime ownership owner id is required")
	}
	if req.Operation == "" {
		req.Operation = "run"
	}

	ttl := normalizeOwnershipTTL(req.TTL)
	now := time.Now().UTC()
	expiresAt := now.Add(ttl)
	allowSame := "0"
	if req.AllowSameOwner {
		allowSame = "1"
	}

	key := s.keyspace.runtimeOwnership(req.SessionID)
	result, err := s.client.Eval(ctx, acquireRuntimeOwnershipScript, []string{key},
		formatInt64(req.Generation),
		req.RunID,
		req.OwnerID,
		req.Operation,
		formatTime(now),
		formatTime(expiresAt),
		allowSame,
		formatInt64(ttlMs(graceTTL(ttl))),
	).Text()
	if err != nil && !errors.Is(err, goredis.Nil) {
		return RuntimeOwnershipLease{}, fmt.Errorf("redis acquire runtime ownership: %w", err)
	}

	if strings.HasPrefix(result, "OK:") {
		token := parseInt64(strings.TrimPrefix(result, "OK:"))
		return RuntimeOwnershipLease{
			SessionID:    req.SessionID,
			Generation:   req.Generation,
			RunID:        req.RunID,
			OwnerID:      req.OwnerID,
			Operation:    req.Operation,
			FencingToken: token,
			ExpiresAt:    expiresAt,
		}, nil
	}

	if strings.HasPrefix(result, "HELD:") {
		held := parseHeldJSON(strings.TrimPrefix(result, "HELD:"))
		return RuntimeOwnershipLease{}, RuntimeOwnershipHeldError{
			SessionID:  held.SessionID,
			Generation: held.Generation,
			RunID:      held.RunID,
			OwnerID:    held.OwnerID,
			Operation:  held.Operation,
			ExpiresAt:  held.ExpiresAt,
		}
	}

	return RuntimeOwnershipLease{}, fmt.Errorf("redis acquire runtime ownership: unexpected result %q", result)
}

// RenewRuntimeOwnership implements RuntimeOwnershipStore.
func (s *LockStore) RenewRuntimeOwnership(ctx context.Context, lease RuntimeOwnershipLease, ttl time.Duration) error {
	if lease.SessionID == "" {
		return nil
	}
	ttl = normalizeOwnershipTTL(ttl)
	now := time.Now().UTC()
	expiresAt := now.Add(ttl)

	key := s.keyspace.runtimeOwnership(lease.SessionID)
	result, err := s.client.Eval(ctx, renewRuntimeOwnershipScript, []string{key},
		formatInt64(lease.Generation),
		lease.RunID,
		lease.OwnerID,
		formatInt64(lease.FencingToken),
		formatTime(expiresAt),
		formatTime(now),
		formatInt64(ttlMs(graceTTL(ttl))),
	).Text()
	if err != nil && !errors.Is(err, goredis.Nil) {
		return fmt.Errorf("redis renew runtime ownership: %w", err)
	}
	if result == "OK" {
		return nil
	}
	return RuntimeOwnershipHeldError{
		SessionID:  lease.SessionID,
		Generation: lease.Generation,
		RunID:      lease.RunID,
		OwnerID:    lease.OwnerID,
		Operation:  lease.Operation,
	}
}

// ReleaseRuntimeOwnership implements RuntimeOwnershipStore.
func (s *LockStore) ReleaseRuntimeOwnership(ctx context.Context, lease RuntimeOwnershipLease) error {
	if lease.SessionID == "" {
		return nil
	}
	now := time.Now().UTC()
	key := s.keyspace.runtimeOwnership(lease.SessionID)
	_, err := s.client.Eval(ctx, releaseRuntimeOwnershipScript, []string{key},
		formatInt64(lease.Generation),
		lease.RunID,
		lease.OwnerID,
		formatInt64(lease.FencingToken),
		formatTime(now),
	).Text()
	if err != nil && !errors.Is(err, goredis.Nil) {
		return fmt.Errorf("redis release runtime ownership: %w", err)
	}
	return nil
}

// RuntimeOwnershipHeld implements RuntimeOwnershipStore.
func (s *LockStore) RuntimeOwnershipHeld(ctx context.Context, lease RuntimeOwnershipLease) (bool, error) {
	if lease.SessionID == "" {
		return true, nil
	}
	now := time.Now().UTC()
	key := s.keyspace.runtimeOwnership(lease.SessionID)
	result, err := s.client.Eval(ctx, checkRuntimeOwnershipScript, []string{key},
		formatInt64(lease.Generation),
		lease.RunID,
		lease.OwnerID,
		formatInt64(lease.FencingToken),
		formatTime(now),
	).Text()
	if err != nil && !errors.Is(err, goredis.Nil) {
		return false, fmt.Errorf("redis check runtime ownership: %w", err)
	}
	return result == "HELD", nil
}

type heldInfo struct {
	SessionID  string `json:"session_id"`
	Generation int64  `json:"generation"`
	RunID      string `json:"run_id"`
	OwnerID    string `json:"owner_id"`
	Operation  string `json:"operation"`
	ExpiresAt  string `json:"expires_at"`
}

func parseHeldJSON(raw string) RuntimeOwnershipLease {
	var info heldInfo
	_ = json.Unmarshal([]byte(raw), &info)
	return RuntimeOwnershipLease{
		SessionID:  info.SessionID,
		Generation: info.Generation,
		RunID:      info.RunID,
		OwnerID:    info.OwnerID,
		Operation:  info.Operation,
		ExpiresAt:  parseTime(info.ExpiresAt),
	}
}
