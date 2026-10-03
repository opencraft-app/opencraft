package workersapi

import (
	"context"
	"net/http"
	"sync"
	"time"
)

// Deployment reads are shared only within one observed cache generation.
// The group owns the upstream context. No caller owns another caller's read.
type deploymentReadKey struct {
	worker     string
	generation uint64
	cursor     string
	synced     bool
	// Unsynchronized reads have no trusted generation and must stay independent.
	unsyncedRead *byte
}

type deploymentRead struct {
	ctx      context.Context
	cancel   context.CancelFunc
	done     chan struct{}
	waiters  int
	finished bool
	value    registryWorker
	err      *upstreamError
}

type deploymentReadStats struct {
	Inflight, Waiters                          int
	Started, RegistryReads, Shared, Overloaded uint64
}

type deploymentReadGroup struct {
	mu       sync.Mutex
	ctx      context.Context
	cancel   context.CancelFunc
	timeout  time.Duration
	capacity int
	reads    map[deploymentReadKey]*deploymentRead
	stats    deploymentReadStats
	changed  chan struct{}
}

func newDeploymentReadGroup(capacity int, timeout time.Duration) *deploymentReadGroup {
	ctx, cancel := context.WithCancel(context.Background())
	return &deploymentReadGroup{
		ctx: ctx, cancel: cancel, capacity: capacity, timeout: timeout,
		reads: make(map[deploymentReadKey]*deploymentRead), changed: make(chan struct{}),
	}
}

func (group *deploymentReadGroup) Do(ctx context.Context, key deploymentReadKey, read func(context.Context) (registryWorker, *upstreamError)) (registryWorker, *upstreamError) {
	group.mu.Lock()
	if ctx.Err() != nil || group.ctx.Err() != nil {
		group.mu.Unlock()
		return registryWorker{}, deploymentReadContextError(ctx)
	}
	flight := group.reads[key]
	// An abandoned read retains its slot until the HTTP operation terminates.
	// Cancellation storms cannot release slots early and spawn unbounded work.
	if group.stats.Waiters >= group.capacity || (flight == nil && len(group.reads) >= group.capacity) || (flight != nil && flight.ctx.Err() != nil) {
		group.stats.Overloaded++
		group.mu.Unlock()
		return registryWorker{}, &upstreamError{Status: http.StatusServiceUnavailable, Code: "overloaded", Message: "Deployment read capacity is exhausted", Retryable: true}
	}
	if flight == nil {
		shared, cancel := context.WithTimeout(group.ctx, group.timeout)
		flight = &deploymentRead{ctx: shared, cancel: cancel, done: make(chan struct{})}
		group.reads[key] = flight
		group.stats.Inflight++
		group.stats.Started++
		go group.run(key, flight, read)
	} else {
		group.stats.Shared++
	}
	flight.waiters++
	group.stats.Waiters++
	group.notifyLocked()
	group.mu.Unlock()
	defer group.leave(flight)
	select {
	case <-ctx.Done():
		return registryWorker{}, deploymentReadContextError(ctx)
	case <-group.ctx.Done():
		return registryWorker{}, deploymentReadCancelled()
	case <-flight.done:
		return flight.value, flight.err
	}
}

func (group *deploymentReadGroup) run(key deploymentReadKey, flight *deploymentRead, read func(context.Context) (registryWorker, *upstreamError)) {
	value, err := read(flight.ctx)
	group.mu.Lock()
	flight.value, flight.err, flight.finished = value, err, true
	delete(group.reads, key)
	group.stats.Inflight--
	flight.cancel()
	close(flight.done)
	group.notifyLocked()
	group.mu.Unlock()
}

func (group *deploymentReadGroup) leave(flight *deploymentRead) {
	group.mu.Lock()
	defer group.mu.Unlock()
	flight.waiters--
	group.stats.Waiters--
	if flight.waiters == 0 && !flight.finished {
		flight.cancel()
	}
	group.notifyLocked()
}

// Snapshot arms the notification under the same lock as the counters. Lifecycle
// observers can wait for a transition without polling or missing a wakeup.
func (group *deploymentReadGroup) Snapshot() (deploymentReadStats, <-chan struct{}) {
	group.mu.Lock()
	defer group.mu.Unlock()
	return group.stats, group.changed
}

func (group *deploymentReadGroup) notifyLocked() {
	close(group.changed)
	group.changed = make(chan struct{})
}

func (group *deploymentReadGroup) Close() { group.cancel() }

func (group *deploymentReadGroup) recordRegistryRead() {
	group.mu.Lock()
	group.stats.RegistryReads++
	group.mu.Unlock()
}

func deploymentReadCancelled() *upstreamError {
	return &upstreamError{Status: http.StatusServiceUnavailable, Code: "request_cancelled", Message: "Deployment read was cancelled", Retryable: true}
}

func deploymentReadContextError(ctx context.Context) *upstreamError {
	if ctx.Err() == context.DeadlineExceeded {
		return &upstreamError{Status: http.StatusGatewayTimeout, Code: "upstream_timeout", Message: "Deployment read timed out", Retryable: true}
	}
	return deploymentReadCancelled()
}
