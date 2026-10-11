//go:build darwin || linux

package app

import (
	"context"
	"errors"
	"testing"

	"velachat/agent/internal/runtimecatalog"
)

func TestRuntimeSnapshotFuturePublishesEmptyTerminalSnapshot(t *testing.T) {
	future := newRuntimeSnapshotFuture()
	catalog, err := runtimecatalog.New(nil)
	if err != nil {
		t.Fatal(err)
	}
	want := catalog.Snapshot(context.Background())
	future.Publish(want)
	got, err := future.Wait(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if got != want {
		t.Fatalf("Wait() = %p, want %p", got, want)
	}
}

func TestRuntimeSnapshotFutureWaitHonorsCancellation(t *testing.T) {
	future := newRuntimeSnapshotFuture()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := future.Wait(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("Wait() error = %v", err)
	}
}
