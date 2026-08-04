package app

import (
	"context"
	"sync"

	"velachat/agent/internal/runtimecatalog"
)

type runtimeSnapshotFuture struct {
	ready    chan struct{}
	once     sync.Once
	snapshot *runtimecatalog.Snapshot
}

func newRuntimeSnapshotFuture() *runtimeSnapshotFuture {
	return &runtimeSnapshotFuture{ready: make(chan struct{})}
}

func (future *runtimeSnapshotFuture) Publish(snapshot *runtimecatalog.Snapshot) {
	if future == nil {
		return
	}
	future.once.Do(func() {
		if snapshot == nil {
			catalog, err := runtimecatalog.New(nil)
			if err == nil {
				snapshot = catalog.Snapshot(context.Background())
			}
		}
		future.snapshot = snapshot
		close(future.ready)
	})
}

func (future *runtimeSnapshotFuture) Wait(
	ctx context.Context,
) (*runtimecatalog.Snapshot, error) {
	if future == nil {
		return nil, ErrInvalidConfig
	}
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-future.ready:
		if future.snapshot == nil {
			return nil, ErrInvalidConfig
		}
		return future.snapshot, nil
	}
}
