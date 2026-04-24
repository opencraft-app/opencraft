package service

import (
	"context"
	"errors"
	"testing"
	"time"

	"git.woa.com/wisp/mono/ai-gateway/internal/model"
)

type usageSinkTestRepo struct {
	*mockUsageRepo
	batchCalls  int
	createCalls int
	batchErr    error
}

func newUsageSinkTestRepo() *usageSinkTestRepo {
	return &usageSinkTestRepo{mockUsageRepo: newMockUsageRepo()}
}

func (r *usageSinkTestRepo) Create(log *model.UsageLog) error {
	r.createCalls++
	return r.mockUsageRepo.Create(log)
}

func (r *usageSinkTestRepo) BatchCreate(logs []model.UsageLog) error {
	r.batchCalls++
	if r.batchErr != nil {
		return r.batchErr
	}
	return r.mockUsageRepo.BatchCreate(logs)
}

func TestUsageBatchWriterFlushesByBatchSize(t *testing.T) {
	repo := newUsageSinkTestRepo()
	sink := NewUsageBatchWriter(repo, 16, 2, time.Hour)

	if err := sink.Enqueue(model.UsageLog{RequestID: "req-1"}); err != nil {
		t.Fatalf("enqueue first log: %v", err)
	}
	if err := sink.Enqueue(model.UsageLog{RequestID: "req-2"}); err != nil {
		t.Fatalf("enqueue second log: %v", err)
	}

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if repo.batchCalls == 1 && len(repo.logs) == 2 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}

	if repo.batchCalls != 1 {
		t.Fatalf("expected 1 batch flush, got %d", repo.batchCalls)
	}
	if repo.createCalls != 0 {
		t.Fatalf("expected 0 direct creates, got %d", repo.createCalls)
	}
	if len(repo.logs) != 2 {
		t.Fatalf("expected 2 logs flushed, got %d", len(repo.logs))
	}

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := sink.Shutdown(ctx); err != nil {
		t.Fatalf("shutdown: %v", err)
	}
}

func TestUsageBatchWriterFlushesOnShutdown(t *testing.T) {
	repo := newUsageSinkTestRepo()
	sink := NewUsageBatchWriter(repo, 16, 10, time.Hour)

	if err := sink.Enqueue(model.UsageLog{RequestID: "req-1"}); err != nil {
		t.Fatalf("enqueue: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := sink.Shutdown(ctx); err != nil {
		t.Fatalf("shutdown: %v", err)
	}

	if repo.batchCalls != 1 {
		t.Fatalf("expected 1 batch flush on shutdown, got %d", repo.batchCalls)
	}
	if len(repo.logs) != 1 {
		t.Fatalf("expected 1 flushed log, got %d", len(repo.logs))
	}
}

func TestUsageBatchWriterReturnsQueueFull(t *testing.T) {
	repo := newUsageSinkTestRepo()
	sink := NewUsageBatchWriter(repo, 1, 100, time.Hour)

	if err := sink.Enqueue(model.UsageLog{RequestID: "req-1"}); err != nil {
		t.Fatalf("enqueue first log: %v", err)
	}
	if err := sink.Enqueue(model.UsageLog{RequestID: "req-2"}); !errors.Is(err, ErrUsageQueueFull) {
		t.Fatalf("expected ErrUsageQueueFull, got %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := sink.Shutdown(ctx); err != nil {
		t.Fatalf("shutdown: %v", err)
	}
}
