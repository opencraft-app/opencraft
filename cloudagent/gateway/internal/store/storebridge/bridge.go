// Package storebridge provides adapters that bridge the internal/store
// implementations (Redis, MySQL) to the wrapper package's interface types.
//
// This exists because the wrapper package defines interfaces using its own
// types (e.g., wrapper.RuntimeOwnershipLease), and the store implementations
// define equivalent but distinct types. The bridge performs zero-cost
// type conversions.
package storebridge

import (
	"context"
	"errors"
	"time"

	redisstore "cloudagent/gateway/internal/store/redis"
	"cloudagent/gateway/internal/wrapper"
)

// RedisRuntimeOwnership adapts redis.LockStore to wrapper.RuntimeOwnershipStore.
type RedisRuntimeOwnership struct {
	store *redisstore.LockStore
}

func NewRedisRuntimeOwnership(store *redisstore.LockStore) *RedisRuntimeOwnership {
	return &RedisRuntimeOwnership{store: store}
}

var _ wrapper.RuntimeOwnershipStore = (*RedisRuntimeOwnership)(nil)

func (a *RedisRuntimeOwnership) AcquireRuntimeOwnership(ctx context.Context, req wrapper.RuntimeOwnershipRequest) (wrapper.RuntimeOwnershipLease, error) {
	lease, err := a.store.AcquireRuntimeOwnership(ctx, redisstore.RuntimeOwnershipRequest{
		SessionID:      req.SessionID,
		Generation:     req.Generation,
		RunID:          req.RunID,
		OwnerID:        req.OwnerID,
		Operation:      req.Operation,
		TTL:            req.TTL,
		AllowSameOwner: req.AllowSameOwner,
	})
	if err != nil {
		// Convert error type if needed
		var held redisstore.RuntimeOwnershipHeldError
		if errors.As(err, &held) {
			return wrapper.RuntimeOwnershipLease{}, wrapper.RuntimeOwnershipHeldError{
				SessionID:  held.SessionID,
				Generation: held.Generation,
				RunID:      held.RunID,
				OwnerID:    held.OwnerID,
				Operation:  held.Operation,
				ExpiresAt:  held.ExpiresAt,
			}
		}
		return wrapper.RuntimeOwnershipLease{}, err
	}
	return wrapper.RuntimeOwnershipLease{
		SessionID:    lease.SessionID,
		Generation:   lease.Generation,
		RunID:        lease.RunID,
		OwnerID:      lease.OwnerID,
		Operation:    lease.Operation,
		FencingToken: lease.FencingToken,
		ExpiresAt:    lease.ExpiresAt,
	}, nil
}

func (a *RedisRuntimeOwnership) RenewRuntimeOwnership(ctx context.Context, lease wrapper.RuntimeOwnershipLease, ttl time.Duration) error {
	err := a.store.RenewRuntimeOwnership(ctx, redisstore.RuntimeOwnershipLease{
		SessionID:    lease.SessionID,
		Generation:   lease.Generation,
		RunID:        lease.RunID,
		OwnerID:      lease.OwnerID,
		Operation:    lease.Operation,
		FencingToken: lease.FencingToken,
		ExpiresAt:    lease.ExpiresAt,
	}, ttl)
	if err != nil {
		var held redisstore.RuntimeOwnershipHeldError
		if errors.As(err, &held) {
			return wrapper.RuntimeOwnershipHeldError{
				SessionID:  held.SessionID,
				Generation: held.Generation,
				RunID:      held.RunID,
				OwnerID:    held.OwnerID,
				Operation:  held.Operation,
				ExpiresAt:  held.ExpiresAt,
			}
		}
		return err
	}
	return nil
}

func (a *RedisRuntimeOwnership) ReleaseRuntimeOwnership(ctx context.Context, lease wrapper.RuntimeOwnershipLease) error {
	return a.store.ReleaseRuntimeOwnership(ctx, redisstore.RuntimeOwnershipLease{
		SessionID:    lease.SessionID,
		Generation:   lease.Generation,
		RunID:        lease.RunID,
		OwnerID:      lease.OwnerID,
		Operation:    lease.Operation,
		FencingToken: lease.FencingToken,
		ExpiresAt:    lease.ExpiresAt,
	})
}

func (a *RedisRuntimeOwnership) RuntimeOwnershipHeld(ctx context.Context, lease wrapper.RuntimeOwnershipLease) (bool, error) {
	return a.store.RuntimeOwnershipHeld(ctx, redisstore.RuntimeOwnershipLease{
		SessionID:    lease.SessionID,
		Generation:   lease.Generation,
		RunID:        lease.RunID,
		OwnerID:      lease.OwnerID,
		Operation:    lease.Operation,
		FencingToken: lease.FencingToken,
		ExpiresAt:    lease.ExpiresAt,
	})
}

// RedisWorkspaceService adapts redis.LockStore to the lease-related part
// of wrapper.WorkspaceService. Note: EnsureWorkspace and other persistence
// methods still need the SQLite/MySQL Store.
type RedisWorkspaceService struct {
	store    *redisstore.LockStore
	fallback wrapper.WorkspaceService // for EnsureWorkspace, LoadWorkspace etc.
}

func NewRedisWorkspaceService(store *redisstore.LockStore, fallback wrapper.WorkspaceService) *RedisWorkspaceService {
	return &RedisWorkspaceService{store: store, fallback: fallback}
}

var _ wrapper.WorkspaceService = (*RedisWorkspaceService)(nil)

func (a *RedisWorkspaceService) EnsureWorkspace(ctx context.Context, rec wrapper.WorkspaceRecord) error {
	if a.fallback != nil {
		return a.fallback.EnsureWorkspace(ctx, rec)
	}
	return nil
}

func (a *RedisWorkspaceService) AcquireLease(ctx context.Context, req wrapper.WorkspaceLeaseRequest) (wrapper.WorkspaceLease, error) {
	lease, err := a.store.AcquireLease(ctx, redisstore.WorkspaceLeaseRequest{
		WorkspaceID: req.WorkspaceID,
		RuntimeID:   req.RuntimeID,
		Provider:    req.Provider,
		TTL:         req.TTL,
	})
	if err != nil {
		var held redisstore.WorkspaceLeaseHeldError
		if errors.As(err, &held) {
			return wrapper.WorkspaceLease{}, wrapper.WorkspaceLeaseHeldError{
				WorkspaceID: held.WorkspaceID,
				RuntimeID:   held.RuntimeID,
				LeaseID:     held.LeaseID,
				ExpiresAt:   held.ExpiresAt,
			}
		}
		return wrapper.WorkspaceLease{}, err
	}
	return wrapper.WorkspaceLease{
		WorkspaceID:  lease.WorkspaceID,
		RuntimeID:    lease.RuntimeID,
		LeaseID:      lease.LeaseID,
		FencingToken: lease.FencingToken,
		State:        lease.State,
		ExpiresAt:    lease.ExpiresAt,
		HeartbeatAt:  lease.HeartbeatAt,
		CreatedAt:    lease.CreatedAt,
		UpdatedAt:    lease.UpdatedAt,
	}, nil
}

func (a *RedisWorkspaceService) RenewLease(ctx context.Context, lease wrapper.WorkspaceLease, ttl time.Duration) (wrapper.WorkspaceLease, error) {
	renewed, err := a.store.RenewLease(ctx, redisstore.WorkspaceLease{
		WorkspaceID:  lease.WorkspaceID,
		RuntimeID:    lease.RuntimeID,
		LeaseID:      lease.LeaseID,
		FencingToken: lease.FencingToken,
		State:        lease.State,
		ExpiresAt:    lease.ExpiresAt,
		HeartbeatAt:  lease.HeartbeatAt,
		CreatedAt:    lease.CreatedAt,
		UpdatedAt:    lease.UpdatedAt,
	}, ttl)
	if err != nil {
		var held redisstore.WorkspaceLeaseHeldError
		if errors.As(err, &held) {
			return wrapper.WorkspaceLease{}, wrapper.WorkspaceLeaseHeldError{
				WorkspaceID: held.WorkspaceID,
				RuntimeID:   held.RuntimeID,
				LeaseID:     held.LeaseID,
				ExpiresAt:   held.ExpiresAt,
			}
		}
		return wrapper.WorkspaceLease{}, err
	}
	return wrapper.WorkspaceLease{
		WorkspaceID:  renewed.WorkspaceID,
		RuntimeID:    renewed.RuntimeID,
		LeaseID:      renewed.LeaseID,
		FencingToken: renewed.FencingToken,
		State:        renewed.State,
		ExpiresAt:    renewed.ExpiresAt,
		HeartbeatAt:  renewed.HeartbeatAt,
		CreatedAt:    renewed.CreatedAt,
		UpdatedAt:    renewed.UpdatedAt,
	}, nil
}

func (a *RedisWorkspaceService) ReleaseLease(ctx context.Context, lease wrapper.WorkspaceLease) error {
	return a.store.ReleaseLease(ctx, redisstore.WorkspaceLease{
		WorkspaceID:  lease.WorkspaceID,
		RuntimeID:    lease.RuntimeID,
		LeaseID:      lease.LeaseID,
		FencingToken: lease.FencingToken,
		State:        lease.State,
		ExpiresAt:    lease.ExpiresAt,
	})
}

func (a *RedisWorkspaceService) GetLease(ctx context.Context, workspaceID string) (wrapper.WorkspaceLease, bool, error) {
	lease, ok, err := a.store.GetLease(ctx, workspaceID)
	if err != nil || !ok {
		return wrapper.WorkspaceLease{}, ok, err
	}
	return wrapper.WorkspaceLease{
		WorkspaceID:  lease.WorkspaceID,
		RuntimeID:    lease.RuntimeID,
		LeaseID:      lease.LeaseID,
		FencingToken: lease.FencingToken,
		State:        lease.State,
		ExpiresAt:    lease.ExpiresAt,
		HeartbeatAt:  lease.HeartbeatAt,
		CreatedAt:    lease.CreatedAt,
		UpdatedAt:    lease.UpdatedAt,
	}, true, nil
}

// RedisRuntimeEnsureLocker adapts redis.LockStore to wrapper.RuntimeEnsureLocker.
type RedisRuntimeEnsureLocker struct {
	store *redisstore.LockStore
}

func NewRedisRuntimeEnsureLocker(store *redisstore.LockStore) *RedisRuntimeEnsureLocker {
	return &RedisRuntimeEnsureLocker{store: store}
}

var _ wrapper.RuntimeEnsureLocker = (*RedisRuntimeEnsureLocker)(nil)

func (a *RedisRuntimeEnsureLocker) AcquireRuntimeEnsureLock(ctx context.Context, key string, ttl time.Duration) (wrapper.RuntimeEnsureLease, error) {
	lease, err := a.store.AcquireRuntimeEnsureLock(ctx, key, ttl)
	if err != nil {
		return nil, err
	}
	return lease, nil
}
