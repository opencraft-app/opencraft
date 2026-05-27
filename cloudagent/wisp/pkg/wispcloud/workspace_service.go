package wispcloud

import (
	"context"
	"errors"
	"fmt"
	"time"
)

const defaultWorkspaceLeaseTTL = 15 * time.Minute

var ErrWorkspaceLeaseHeld = errors.New("workspace lease held")

type WorkspaceLeaseHeldError struct {
	WorkspaceID string
	RuntimeID   string
	LeaseID     string
	ExpiresAt   time.Time
}

func (e WorkspaceLeaseHeldError) Error() string {
	return fmt.Sprintf("workspace %s is already leased by runtime %s until %s", e.WorkspaceID, e.RuntimeID, e.ExpiresAt.Format(time.RFC3339Nano))
}

func (e WorkspaceLeaseHeldError) Is(target error) bool {
	return target == ErrWorkspaceLeaseHeld
}

type WorkspaceService interface {
	EnsureWorkspace(ctx context.Context, rec WorkspaceRecord) error
	AcquireLease(ctx context.Context, req WorkspaceLeaseRequest) (WorkspaceLease, error)
	HeartbeatLease(ctx context.Context, lease WorkspaceLease, ttl time.Duration) (WorkspaceLease, error)
	MarkLeaseReleasing(ctx context.Context, lease WorkspaceLease) error
	ReleaseLease(ctx context.Context, lease WorkspaceLease) error
	GetLease(ctx context.Context, workspaceID string) (WorkspaceLease, bool, error)
}

type WorkspaceRecord struct {
	WorkspaceID         string
	Backend             string
	ProviderWorkspaceID string
	State               string
	CreatedAt           time.Time
	UpdatedAt           time.Time
}

type WorkspaceLeaseRequest struct {
	WorkspaceID string
	RuntimeID   string
	Provider    string
	TTL         time.Duration
}

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
