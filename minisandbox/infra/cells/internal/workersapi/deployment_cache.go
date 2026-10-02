package workersapi

import (
	"container/list"
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"sync"
	"time"
)

const (
	initialDeploymentCursor = "c_00000000000000000000000000000000"
	deploymentCursorSchema  = "rivet-worker-deployment-cursor/v1"
)

type deploymentCache struct {
	mu         sync.Mutex
	entries    map[string]*list.Element
	recency    *list.List
	capacity   int
	synced     bool
	cursor     string
	generation uint64
}

type deploymentCacheEntry struct {
	worker string
	value  registryWorker
}

func newDeploymentCache(capacity int) *deploymentCache {
	return &deploymentCache{
		entries: make(map[string]*list.Element, capacity), recency: list.New(),
		capacity: capacity, cursor: initialDeploymentCursor,
	}
}

func (cache *deploymentCache) Get(worker string) (registryWorker, bool) {
	cache.mu.Lock()
	defer cache.mu.Unlock()
	if !cache.synced {
		return registryWorker{}, false
	}
	element, ok := cache.entries[worker]
	if !ok {
		return registryWorker{}, false
	}
	cache.recency.MoveToFront(element)
	return element.Value.(*deploymentCacheEntry).value, true
}

func (cache *deploymentCache) Fence() (uint64, string, bool) {
	cache.mu.Lock()
	defer cache.mu.Unlock()
	return cache.generation, cache.cursor, cache.synced
}

// PutIfCurrent prevents a Registry response racing an invalidation from
// repopulating the cache with the Deployment that existed before the cursor
// changed. The Worker and cursor are read in the same Registry transaction.
func (cache *deploymentCache) PutIfCurrent(worker string, value registryWorker, generation uint64, cursor string) bool {
	cache.mu.Lock()
	defer cache.mu.Unlock()
	if !cache.synced || cache.generation != generation || cache.cursor != cursor || value.DeploymentCursor != cursor {
		return false
	}
	if element, ok := cache.entries[worker]; ok {
		element.Value.(*deploymentCacheEntry).value = value
		cache.recency.MoveToFront(element)
		return true
	}
	element := cache.recency.PushFront(&deploymentCacheEntry{worker: worker, value: value})
	cache.entries[worker] = element
	for len(cache.entries) > cache.capacity {
		cache.remove(cache.recency.Back())
	}
	return true
}

// ObserveCursor is called only after a successful Registry watch response. A
// changed cursor invalidates the whole namespace cache; the number of active
// Workers is bounded, so this is cheaper and safer than maintaining a lossy
// per-Worker event log.
func (cache *deploymentCache) ObserveCursor(cursor string) bool {
	cache.mu.Lock()
	defer cache.mu.Unlock()
	if !deploymentCursorPattern.MatchString(cursor) {
		cache.invalidateLocked()
		cache.synced = false
		return false
	}
	if !cache.synced || cache.cursor != cursor {
		cache.clearLocked()
		cache.generation++
	}
	cache.cursor = cursor
	cache.synced = true
	return true
}

// ApplyCursor fences the publishing replica immediately. It does not turn a
// disconnected cache back on: only the Registry watch may establish sync.
func (cache *deploymentCache) ApplyCursor(cursor string) {
	cache.mu.Lock()
	defer cache.mu.Unlock()
	cache.clearLocked()
	cache.generation++
	if cache.synced && deploymentCursorPattern.MatchString(cursor) {
		cache.cursor = cursor
		return
	}
	cache.synced = false
}

func (cache *deploymentCache) Invalidate() {
	cache.mu.Lock()
	defer cache.mu.Unlock()
	cache.invalidateLocked()
}

func (cache *deploymentCache) invalidateLocked() {
	cache.clearLocked()
	cache.generation++
	cache.synced = false
}

func (cache *deploymentCache) clearLocked() {
	cache.entries = make(map[string]*list.Element, cache.capacity)
	cache.recency.Init()
}

func (cache *deploymentCache) remove(element *list.Element) {
	if element == nil {
		return
	}
	delete(cache.entries, element.Value.(*deploymentCacheEntry).worker)
	cache.recency.Remove(element)
}

func (cache *deploymentCache) Len() int {
	cache.mu.Lock()
	defer cache.mu.Unlock()
	return len(cache.entries)
}

func (a *API) startDeploymentWatcher() {
	a.deploymentWatchOnce.Do(func() {
		ctx, cancel := context.WithCancel(context.Background())
		a.deploymentWatchCancel = cancel
		go a.watchDeployments(ctx)
	})
}

func (a *API) activeWorker(ctx context.Context, worker string) (registryWorker, *upstreamError) {
	a.startDeploymentWatcher()
	if current, ok := a.deployments.Get(worker); ok {
		return current, nil
	}
	generation, cursor, synced := a.deployments.Fence()
	current, upstream := a.registryWorker(ctx, worker)
	if upstream != nil {
		return registryWorker{}, upstream
	}
	if !deploymentCursorPattern.MatchString(current.DeploymentCursor) {
		return registryWorker{}, invalidDeploymentUpstream()
	}
	if synced {
		a.deployments.PutIfCurrent(worker, current, generation, cursor)
	}
	return current, nil
}

func (a *API) watchDeployments(ctx context.Context) {
	after := initialDeploymentCursor
	delay := 100 * time.Millisecond
	for ctx.Err() == nil {
		cursor, upstream := a.watchDeploymentCursor(ctx, after)
		if upstream == nil && a.deployments.ObserveCursor(cursor) {
			after = cursor
			delay = 100 * time.Millisecond
			continue
		}
		a.deployments.Invalidate()
		if upstream != nil && ctx.Err() == nil {
			slog.WarnContext(ctx, "Worker deployment watch unavailable", "code", upstream.Code)
		}
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			if !timer.Stop() {
				<-timer.C
			}
			return
		case <-timer.C:
		}
		if delay < 5*time.Second {
			delay *= 2
			if delay > 5*time.Second {
				delay = 5 * time.Second
			}
		}
	}
}

func (a *API) watchDeploymentCursor(ctx context.Context, after string) (string, *upstreamError) {
	target := a.registryURL(fmt.Sprintf("/internal/v1/namespaces/%s/deployment-cursor", url.PathEscape(a.namespace)))
	target.RawQuery = url.Values{"after": []string{after}}.Encode()
	var result registryDeploymentCursor
	if upstream := a.requestJSON(ctx, http.MethodGet, target, nil, &result); upstream != nil {
		return "", upstream
	}
	if result.Schema != deploymentCursorSchema || result.Namespace != a.namespace || !deploymentCursorPattern.MatchString(result.Cursor) {
		return "", &upstreamError{Status: http.StatusBadGateway, Code: "invalid_upstream_response", Message: "The code service returned an invalid Deployment cursor", Retryable: true}
	}
	return result.Cursor, nil
}
