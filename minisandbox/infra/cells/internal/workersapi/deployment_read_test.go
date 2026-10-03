package workersapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type deploymentReadResult struct {
	value registryWorker
	err   *upstreamError
}
type deploymentHTTPRead struct {
	reply    chan deploymentReadResult
	finished chan struct{}
}
type deploymentReadHarness struct {
	api      *API
	ctx      context.Context
	requests chan *deploymentHTTPRead
	reads    atomic.Int64
}

func newDeploymentReadHarness(t *testing.T, capacity int) *deploymentReadHarness {
	return newDeploymentReadHarnessWithWatch(t, capacity, false)
}

func newDeploymentReadHarnessWithWatch(t *testing.T, capacity int, watch bool) *deploymentReadHarness {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	h := &deploymentReadHarness{ctx: ctx, requests: make(chan *deploymentHTTPRead, 128)}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		call := &deploymentHTTPRead{reply: make(chan deploymentReadResult, 1), finished: make(chan struct{})}
		defer close(call.finished)
		h.reads.Add(1)
		h.requests <- call
		select {
		case result := <-call.reply:
			if result.err != nil {
				writeJSON(w, result.err.Status, map[string]any{"code": result.err.Code})
			} else {
				writeJSON(w, 200, result.value)
			}
		case <-r.Context().Done():
		}
	}))
	registry, _ := url.Parse(server.URL)
	h.api = &API{registry: registry, namespace: "default", client: server.Client(),
		deployments: newDeploymentCache(capacity), deploymentReads: newDeploymentReadGroup(capacity, 4*time.Second)}
	// Watch HTTP has separate integration coverage. Explicit cursor transitions
	// order the read and invalidation events here without timing assumptions.
	if !watch {
		h.api.deploymentWatchOnce.Do(func() {})
	}
	h.api.deployments.ObserveCursor(initialDeploymentCursor)
	t.Cleanup(func() { cancel(); h.api.Close(); server.Close() })
	return h
}
func (h *deploymentReadHarness) start(ctx context.Context, worker string) <-chan deploymentReadResult {
	result := make(chan deploymentReadResult, 1)
	go func() { value, err := h.api.activeWorker(ctx, worker); result <- deploymentReadResult{value, err} }()
	return result
}
func awaitDeploymentEvent[T any](t *testing.T, ctx context.Context, event <-chan T) T {
	t.Helper()
	select {
	case value := <-event:
		return value
	case <-ctx.Done():
		t.Fatal("Deployment read event deadline exceeded")
		var zero T
		return zero
	}
}
func awaitDeploymentStats(t *testing.T, ctx context.Context, group *deploymentReadGroup, inflight, waiters int) deploymentReadStats {
	t.Helper()
	for {
		stats, changed := group.Snapshot()
		if stats.Inflight == inflight && stats.Waiters == waiters {
			return stats
		}
		awaitDeploymentEvent(t, ctx, changed)
	}
}
func successfulDeployment(t *testing.T, ctx context.Context, event <-chan deploymentReadResult, version string) {
	t.Helper()
	r := awaitDeploymentEvent(t, ctx, event)
	if r.err != nil || len(r.value.Deployment.Versions) != 1 || r.value.Deployment.Versions[0].VersionID != version {
		t.Fatalf("unexpected Deployment result: %+v", r)
	}
}

func TestDeploymentReadCoalescesColdFill(t *testing.T) {
	const count = 32
	h := newDeploymentReadHarness(t, 64)
	results := make([]<-chan deploymentReadResult, count)
	for i := range results {
		results[i] = h.start(h.ctx, "counter")
	}
	stats := awaitDeploymentStats(t, h.ctx, h.api.deploymentReads, 1, count)
	request := awaitDeploymentEvent(t, h.ctx, h.requests)
	if h.reads.Load() != 1 || stats.Shared != count-1 {
		t.Fatalf("reads=%d stats=%+v", h.reads.Load(), stats)
	}
	request.reply <- deploymentReadResult{value: cachedWorker("counter", initialDeploymentCursor, testVersionOne)}
	for _, result := range results {
		successfulDeployment(t, h.ctx, result, testVersionOne)
	}
	awaitDeploymentStats(t, h.ctx, h.api.deploymentReads, 0, 0)
	successfulDeployment(t, h.ctx, h.start(h.ctx, "counter"), testVersionOne)
	if h.reads.Load() != 1 {
		t.Fatal("warm request reached Registry")
	}
	t.Logf("AFTER: %d concurrent same-generation cold requests made %d Registry HTTP read", count, h.reads.Load())
}

func TestDeploymentReadCallerCancellationDoesNotCancelOthers(t *testing.T) {
	for _, cancelLeader := range []bool{true, false} {
		t.Run(map[bool]string{true: "leader", false: "follower"}[cancelLeader], func(t *testing.T) {
			h := newDeploymentReadHarness(t, 4)
			leaderCtx, cancelLeaderContext := context.WithCancel(h.ctx)
			defer cancelLeaderContext()
			followerCtx, cancelFollowerContext := context.WithCancel(h.ctx)
			defer cancelFollowerContext()
			leader := h.start(leaderCtx, "counter")
			request := awaitDeploymentEvent(t, h.ctx, h.requests)
			follower := h.start(followerCtx, "counter")
			awaitDeploymentStats(t, h.ctx, h.api.deploymentReads, 1, 2)
			cancelled, survivor := follower, leader
			if cancelLeader {
				cancelLeaderContext()
				cancelled, survivor = leader, follower
			} else {
				cancelFollowerContext()
			}
			result := awaitDeploymentEvent(t, h.ctx, cancelled)
			if result.err == nil || result.err.Code != "request_cancelled" {
				t.Fatalf("cancelled caller: %+v", result)
			}
			awaitDeploymentStats(t, h.ctx, h.api.deploymentReads, 1, 1)
			request.reply <- deploymentReadResult{value: cachedWorker("counter", initialDeploymentCursor, testVersionOne)}
			successfulDeployment(t, h.ctx, survivor, testVersionOne)
			if h.reads.Load() != 1 {
				t.Fatal("survivor spawned another GET")
			}
		})
	}
}

func TestDeploymentReadAllCallersLeaveAndAPICloseCancelHTTP(t *testing.T) {
	for _, shutdown := range []bool{false, true} {
		t.Run(map[bool]string{true: "api-close", false: "all-callers-leave"}[shutdown], func(t *testing.T) {
			h := newDeploymentReadHarness(t, 4)
			ctx, cancel := context.WithCancel(h.ctx)
			defer cancel()
			first := h.start(ctx, "counter")
			request := awaitDeploymentEvent(t, h.ctx, h.requests)
			second := h.start(ctx, "counter")
			awaitDeploymentStats(t, h.ctx, h.api.deploymentReads, 1, 2)
			if shutdown {
				h.api.Close()
			} else {
				cancel()
			}
			for _, result := range []<-chan deploymentReadResult{first, second} {
				if r := awaitDeploymentEvent(t, h.ctx, result); r.err == nil {
					t.Fatal("cancelled read returned success")
				}
			}
			awaitDeploymentEvent(t, h.ctx, request.finished)
			awaitDeploymentStats(t, h.ctx, h.api.deploymentReads, 0, 0)
			if shutdown {
				r := awaitDeploymentEvent(t, h.ctx, h.start(h.ctx, "counter"))
				if r.err == nil || h.reads.Load() != 1 {
					t.Fatal("closed API admitted another read")
				}
			}
		})
	}
}

func TestDeploymentReadNewGenerationDoesNotJoinLateRead(t *testing.T) {
	h := newDeploymentReadHarness(t, 4)
	old := h.start(h.ctx, "counter")
	oldRequest := awaitDeploymentEvent(t, h.ctx, h.requests)
	newCursor := "c_22222222222222222222222222222222"
	h.api.deployments.ObserveCursor(newCursor)
	current := h.start(h.ctx, "counter")
	newRequest := awaitDeploymentEvent(t, h.ctx, h.requests)
	awaitDeploymentStats(t, h.ctx, h.api.deploymentReads, 2, 2)
	newRequest.reply <- deploymentReadResult{value: cachedWorker("counter", newCursor, testVersionTwo)}
	successfulDeployment(t, h.ctx, current, testVersionTwo)
	oldRequest.reply <- deploymentReadResult{value: cachedWorker("counter", initialDeploymentCursor, testVersionOne)}
	successfulDeployment(t, h.ctx, old, testVersionOne)
	successfulDeployment(t, h.ctx, h.start(h.ctx, "counter"), testVersionTwo)
	if h.reads.Load() != 2 {
		t.Fatal("late response replaced current cache")
	}
}

func TestDeploymentReadErrorAndDisconnectedCacheDoNotPopulate(t *testing.T) {
	for _, disconnected := range []bool{false, true} {
		t.Run(map[bool]string{true: "disconnected", false: "http-error"}[disconnected], func(t *testing.T) {
			h := newDeploymentReadHarness(t, 4)
			first := h.start(h.ctx, "counter")
			request := awaitDeploymentEvent(t, h.ctx, h.requests)
			if disconnected {
				h.api.deployments.Invalidate()
				request.reply <- deploymentReadResult{value: cachedWorker("counter", initialDeploymentCursor, testVersionOne)}
				successfulDeployment(t, h.ctx, first, testVersionOne)
			} else {
				request.reply <- deploymentReadResult{err: &upstreamError{Status: 503, Code: "unavailable"}}
				if r := awaitDeploymentEvent(t, h.ctx, first); r.err == nil {
					t.Fatal("Registry error became success")
				}
			}
			awaitDeploymentStats(t, h.ctx, h.api.deploymentReads, 0, 0)
			if h.api.deployments.Len() != 0 {
				t.Fatal("failed or stale response populated cache")
			}
			second := h.start(h.ctx, "counter")
			request = awaitDeploymentEvent(t, h.ctx, h.requests)
			request.reply <- deploymentReadResult{value: cachedWorker("counter", initialDeploymentCursor, testVersionOne)}
			successfulDeployment(t, h.ctx, second, testVersionOne)
			if h.reads.Load() != 2 {
				t.Fatal("error cached or retried transparently")
			}
			if disconnected && h.api.deployments.Len() != 0 {
				t.Fatal("unsynchronized read enabled cache")
			}
		})
	}
}

func TestDeploymentReadWaiterCapacityIsBounded(t *testing.T) {
	h := newDeploymentReadHarness(t, 2)
	first := h.start(h.ctx, "counter")
	request := awaitDeploymentEvent(t, h.ctx, h.requests)
	second := h.start(h.ctx, "counter")
	awaitDeploymentStats(t, h.ctx, h.api.deploymentReads, 1, 2)
	for _, worker := range []string{"counter", "other-worker"} {
		r := awaitDeploymentEvent(t, h.ctx, h.start(h.ctx, worker))
		if r.err == nil || r.err.Code != "overloaded" || !r.err.Retryable {
			t.Fatalf("capacity did not fail closed: %+v", r)
		}
	}
	request.reply <- deploymentReadResult{value: cachedWorker("counter", initialDeploymentCursor, testVersionOne)}
	successfulDeployment(t, h.ctx, first, testVersionOne)
	successfulDeployment(t, h.ctx, second, testVersionOne)
	stats := awaitDeploymentStats(t, h.ctx, h.api.deploymentReads, 0, 0)
	if stats.Overloaded != 2 || h.reads.Load() != 1 {
		t.Fatalf("stats=%+v reads=%d", stats, h.reads.Load())
	}
}

func TestDeploymentReadAbandonedWorkRetainsDistinctCapacity(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	group := newDeploymentReadGroup(1, 4*time.Second)
	defer group.Close()
	callerCtx, cancelCaller := context.WithCancel(ctx)
	defer cancelCaller()
	started, cancelled, release := make(chan struct{}), make(chan struct{}), make(chan struct{})
	var releaseOnce sync.Once
	defer releaseOnce.Do(func() { close(release) })
	result := make(chan deploymentReadResult, 1)
	go func() {
		value, err := group.Do(callerCtx, deploymentReadKey{worker: "one"}, func(shared context.Context) (registryWorker, *upstreamError) {
			close(started)
			<-shared.Done()
			close(cancelled)
			// Transport cleanup can finish after observing cancellation.
			<-release
			return registryWorker{}, deploymentReadCancelled()
		})
		result <- deploymentReadResult{value, err}
	}()
	awaitDeploymentEvent(t, ctx, started)
	cancelCaller()
	awaitDeploymentEvent(t, ctx, result)
	awaitDeploymentEvent(t, ctx, cancelled)
	awaitDeploymentStats(t, ctx, group, 1, 0)
	for _, worker := range []string{"one", "two"} {
		_, err := group.Do(ctx, deploymentReadKey{worker: worker}, func(context.Context) (registryWorker, *upstreamError) {
			t.Error("abandoned work released capacity early")
			return registryWorker{}, nil
		})
		if err == nil || err.Code != "overloaded" {
			t.Fatalf("abandoned-read response: %v", err)
		}
	}
	releaseOnce.Do(func() { close(release) })
	awaitDeploymentStats(t, ctx, group, 0, 0)
}

func TestDeploymentReadSharedDeadlineCancelsHTTP(t *testing.T) {
	h := newDeploymentReadHarness(t, 4)
	h.api.deploymentReads.Close()
	h.api.deploymentReads = newDeploymentReadGroup(4, 50*time.Millisecond)
	result := h.start(h.ctx, "counter")
	request := awaitDeploymentEvent(t, h.ctx, h.requests)
	r := awaitDeploymentEvent(t, h.ctx, result)
	if r.err == nil || r.err.Code != "upstream_timeout" {
		t.Fatalf("shared deadline did not bound the read: %+v", r)
	}
	awaitDeploymentEvent(t, h.ctx, request.finished)
	awaitDeploymentStats(t, h.ctx, h.api.deploymentReads, 0, 0)
}

func TestDeploymentReadMetricsHaveBoundedLabels(t *testing.T) {
	h := newDeploymentReadHarness(t, 4)
	router := newObjectRouter(h.api, 4, time.Minute, 4)
	metrics := newAPIMetrics("default", router, h.api.deploymentReads)
	first := h.start(h.ctx, "private-worker-identity")
	request := awaitDeploymentEvent(t, h.ctx, h.requests)
	second := h.start(h.ctx, "private-worker-identity")
	awaitDeploymentStats(t, h.ctx, h.api.deploymentReads, 1, 2)
	response := httptest.NewRecorder()
	metrics.handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	for _, expected := range []string{
		`workers_api_deployment_reads_total{namespace="default",result="registry"} 1`,
		`workers_api_deployment_reads_total{namespace="default",result="shared"} 1`,
		`workers_api_deployment_read_group{namespace="default",state="waiters"} 2`,
		`workers_api_deployment_read_group{namespace="default",state="inflight"} 1`,
	} {
		if !strings.Contains(response.Body.String(), expected) {
			t.Fatalf("metrics omitted %s", expected)
		}
	}
	if strings.Contains(response.Body.String(), "private-worker-identity") {
		t.Fatal("metrics leaked Worker identity")
	}
	request.reply <- deploymentReadResult{value: cachedWorker("private-worker-identity", initialDeploymentCursor, testVersionOne)}
	successfulDeployment(t, h.ctx, first, testVersionOne)
	successfulDeployment(t, h.ctx, second, testVersionOne)
}

func TestDeploymentReadAPICloseOwnsWatchAndReadLifetime(t *testing.T) {
	h := newDeploymentReadHarnessWithWatch(t, 4, true)
	result := h.start(h.ctx, "counter")
	// Both real HTTP operations remain blocked until the API lifetime ends.
	first := awaitDeploymentEvent(t, h.ctx, h.requests)
	second := awaitDeploymentEvent(t, h.ctx, h.requests)
	h.api.Close()
	if r := awaitDeploymentEvent(t, h.ctx, result); r.err == nil {
		t.Fatal("closed API completed a blocked read")
	}
	awaitDeploymentEvent(t, h.ctx, first.finished)
	awaitDeploymentEvent(t, h.ctx, second.finished)
	awaitDeploymentStats(t, h.ctx, h.api.deploymentReads, 0, 0)
}

func TestDeploymentReadUnsynchronizedCallsRemainIndependent(t *testing.T) {
	h := newDeploymentReadHarness(t, 4)
	h.api.deployments.Invalidate()
	first := h.start(h.ctx, "counter")
	oldRequest := awaitDeploymentEvent(t, h.ctx, h.requests)
	second := h.start(h.ctx, "counter")
	awaitDeploymentStats(t, h.ctx, h.api.deploymentReads, 2, 2)
	stats, _ := h.api.deploymentReads.Snapshot()
	if stats.Shared != 0 {
		t.Fatal("unsynchronized request joined an earlier Registry snapshot")
	}
	newRequest := awaitDeploymentEvent(t, h.ctx, h.requests)
	oldRequest.reply <- deploymentReadResult{value: cachedWorker("counter", initialDeploymentCursor, testVersionOne)}
	newRequest.reply <- deploymentReadResult{value: cachedWorker("counter", initialDeploymentCursor, testVersionTwo)}
	successfulDeployment(t, h.ctx, first, testVersionOne)
	successfulDeployment(t, h.ctx, second, testVersionTwo)
	if h.api.deployments.Len() != 0 {
		t.Fatal("unsynchronized reads populated cache")
	}
}

func TestDeploymentReadExpiredCallerRetainsTimeoutError(t *testing.T) {
	h := newDeploymentReadHarness(t, 4)
	ctx, cancel := context.WithDeadline(h.ctx, time.Now().Add(-time.Second))
	defer cancel()
	r := awaitDeploymentEvent(t, h.ctx, h.start(ctx, "counter"))
	if r.err == nil || r.err.Status != 504 || r.err.Code != "upstream_timeout" || h.reads.Load() != 0 {
		t.Fatalf("caller deadline changed error semantics or started HTTP: %+v", r)
	}
}
