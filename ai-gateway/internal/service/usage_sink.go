package service

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"time"

	"git.woa.com/wisp/mono/ai-gateway/internal/model"
	"git.woa.com/wisp/mono/ai-gateway/internal/repository"
)

var (
	ErrUsageSinkClosed = errors.New("usage sink closed")
	ErrUsageQueueFull  = errors.New("usage queue full")
)

type UsageSink interface {
	Enqueue(log model.UsageLog) error
	Shutdown(ctx context.Context) error
}

type UsageBatchWriter struct {
	repo          repository.UsageRepo
	queue         chan model.UsageLog
	flushInterval time.Duration
	batchSize     int

	wg sync.WaitGroup
	mu sync.RWMutex

	closed bool
}

func NewUsageBatchWriter(repo repository.UsageRepo, queueSize, batchSize int, flushInterval time.Duration) *UsageBatchWriter {
	if queueSize <= 0 {
		queueSize = 4096
	}
	if batchSize <= 0 {
		batchSize = 128
	}
	if flushInterval <= 0 {
		flushInterval = 200 * time.Millisecond
	}

	w := &UsageBatchWriter{
		repo:          repo,
		queue:         make(chan model.UsageLog, queueSize),
		flushInterval: flushInterval,
		batchSize:     batchSize,
	}
	w.wg.Add(1)
	go w.run()
	return w
}

func (w *UsageBatchWriter) Enqueue(log model.UsageLog) error {
	w.mu.RLock()
	defer w.mu.RUnlock()
	if w.closed {
		return ErrUsageSinkClosed
	}

	select {
	case w.queue <- log:
		return nil
	default:
		return ErrUsageQueueFull
	}
}

func (w *UsageBatchWriter) Shutdown(ctx context.Context) error {
	w.mu.Lock()
	if w.closed {
		w.mu.Unlock()
		return nil
	}
	w.closed = true
	close(w.queue)
	w.mu.Unlock()

	done := make(chan struct{})
	go func() {
		defer close(done)
		w.wg.Wait()
	}()

	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (w *UsageBatchWriter) run() {
	defer w.wg.Done()

	timer := time.NewTimer(w.flushInterval)
	defer timer.Stop()

	batch := make([]model.UsageLog, 0, w.batchSize)
	flush := func() {
		if len(batch) == 0 {
			return
		}
		if err := w.repo.BatchCreate(batch); err != nil {
			slog.Error("usage batch flush failed", "batch_size", len(batch), "error", err)
		}
		batch = batch[:0]
	}

	resetTimer := func() {
		if !timer.Stop() {
			select {
			case <-timer.C:
			default:
			}
		}
		timer.Reset(w.flushInterval)
	}

	for {
		select {
		case logEntry, ok := <-w.queue:
			if !ok {
				flush()
				return
			}
			batch = append(batch, logEntry)
			if len(batch) >= w.batchSize {
				flush()
				resetTimer()
			}
		case <-timer.C:
			flush()
			timer.Reset(w.flushInterval)
		}
	}
}
