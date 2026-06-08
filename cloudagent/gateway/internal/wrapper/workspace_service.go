package wrapper

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
	RenewLease(ctx context.Context, lease WorkspaceLease, ttl time.Duration) (WorkspaceLease, error)
	ReleaseLease(ctx context.Context, lease WorkspaceLease) error
	GetLease(ctx context.Context, workspaceID string) (WorkspaceLease, bool, error)
}

type RuntimeResourceLedger interface {
	UpsertRuntimeResource(ctx context.Context, rec RuntimeResourceRecord) error
	MarkRuntimeResourceState(ctx context.Context, sessionID string, generation int64, state string, lastError string) error
	LoadRuntimeResource(ctx context.Context, sessionID string, generation int64) (RuntimeResourceRecord, bool, error)
	ListStaleRuntimeResources(ctx context.Context, now time.Time, limit int) ([]RuntimeResourceRecord, error)
}

type WorkspaceRecord struct {
	WorkspaceID           string
	Backend               string
	ProviderWorkspaceID   string
	State                 string
	OwnerSessionID        string
	WorkspaceVersion      string
	ProviderRegion        string
	WispName              string
	WispSMHSpaceID        string
	WispOwnsSMHSpace      bool
	WorkspaceWispName     string
	WorkspaceRuntimeID    string
	WispPackageURL        string
	WispJFSPrefix         string
	WispRootUpperSize     string
	CleanupState          string
	LastCleanupError      string
	CleanupRetryAfter     time.Time
	DeleteState           string
	LastDeleteError       string
	DeleteRetryAfter      time.Time
	OuterCleanupPending   bool
	LastOuterCleanupError string
}

type RuntimeResourceRecord struct {
	SessionID      string
	Generation     int64
	RuntimeID      string
	OwnerID        string
	SandboxBackend string
	State          string
	OuterSandboxID string
	InnerSandboxID string
	CreatedAt      time.Time
	UpdatedAt      time.Time
	ExpiresAt      time.Time
	LastError      string
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
