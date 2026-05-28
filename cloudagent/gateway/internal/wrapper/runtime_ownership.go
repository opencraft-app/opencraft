package wrapper

import (
	"context"
	"errors"
	"fmt"
	"time"
)

const defaultRuntimeOwnershipTTL = 10 * time.Minute

var ErrRuntimeOwnershipHeld = errors.New("runtime ownership held")

// SessionRunLease is the gateway-level single-writer lease for one ACP session
// runtime group. In v1 it protects both outer and inner runtime hosts.
type SessionRunLease = RuntimeOwnershipLease

type SessionRunLeaseStore = RuntimeOwnershipStore

type RuntimeOwnershipStore interface {
	AcquireRuntimeOwnership(ctx context.Context, req RuntimeOwnershipRequest) (RuntimeOwnershipLease, error)
	RenewRuntimeOwnership(ctx context.Context, lease RuntimeOwnershipLease, ttl time.Duration) error
	ReleaseRuntimeOwnership(ctx context.Context, lease RuntimeOwnershipLease) error
	RuntimeOwnershipHeld(ctx context.Context, lease RuntimeOwnershipLease) (bool, error)
}

type RuntimeOwnershipRequest struct {
	SessionID      string
	Generation     int64
	RunID          string
	OwnerID        string
	Operation      string
	TTL            time.Duration
	AllowSameOwner bool
}

type RuntimeOwnershipLease struct {
	SessionID    string
	Generation   int64
	RunID        string
	OwnerID      string
	Operation    string
	FencingToken int64
	ExpiresAt    time.Time
}

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
		return ErrRuntimeOwnershipHeld.Error()
	}
	return fmt.Sprintf("runtime ownership for session %s is held by %s run %s until %s", e.SessionID, e.OwnerID, e.RunID, e.ExpiresAt.Format(time.RFC3339Nano))
}

func (e RuntimeOwnershipHeldError) Unwrap() error {
	return ErrRuntimeOwnershipHeld
}

func normalizeRuntimeOwnershipTTL(ttl time.Duration) time.Duration {
	if ttl <= 0 {
		return defaultRuntimeOwnershipTTL
	}
	return ttl
}
