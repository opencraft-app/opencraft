// Package objectrouter owns the bounded, disposable routing cache and the
// process-local single-flight table used by the regional Object Router.
//
// Neither structure is a correctness authority. Backend.Resolve must converge
// through durable Registry/Actor state when this cache is empty or when many
// Router replicas race on the same logical Object.
package objectrouter

import (
	"container/list"
	"context"
	"errors"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

var ErrOverloaded = errors.New("object router has too many concurrent placement misses")

type Key struct {
	Worker   string
	Class    string
	ObjectID string
}

func (key Key) cacheKey() string {
	return key.Worker + "\x00" + key.Class + "\x00" + key.ObjectID
}

type Backend[T any] interface {
	ResolveUncached(context.Context, Key) (T, error)
	Refresh(context.Context, T) (T, error)
}

type Router[T any] struct {
	backend  Backend[T]
	cache    *cache[T]
	misses   *missGroup[T]
	hits     atomic.Uint64
	missed   atomic.Uint64
	overload atomic.Uint64
}

type Stats struct {
	CacheHits   uint64
	CacheMisses uint64
	Overloaded  uint64
	Inflight    int64
	Entries     int
}

func New[T any](backend Backend[T], cacheCapacity int, cacheIdleTTL time.Duration, missCapacity int) *Router[T] {
	if backend == nil || cacheCapacity < 1 || cacheIdleTTL <= 0 || missCapacity < 1 {
		panic("invalid Object Router configuration")
	}
	return &Router[T]{
		backend: backend,
		cache:   newCache[T](cacheCapacity, cacheIdleTTL),
		misses:  newMissGroup[T](missCapacity),
	}
}

func (router *Router[T]) Resolve(ctx context.Context, key Key) (T, error) {
	cacheKey := key.cacheKey()
	// Empty Class is the retired default-Actor compatibility path. It must not
	// acquire persistent placement-cache semantics.
	if key.Class == "" {
		router.missed.Add(1)
		return router.backend.ResolveUncached(ctx, key)
	}
	if binding, ok := router.cache.Get(cacheKey); ok {
		router.hits.Add(1)
		return router.backend.Refresh(ctx, binding)
	}
	router.missed.Add(1)
	value, err := router.misses.Do(ctx, cacheKey, func() (T, error) {
		if binding, ok := router.cache.Get(cacheKey); ok {
			return router.backend.Refresh(ctx, binding)
		}
		binding, err := router.backend.ResolveUncached(ctx, key)
		if err != nil {
			var zero T
			return zero, err
		}
		return router.cache.Put(cacheKey, binding), nil
	})
	if errors.Is(err, ErrOverloaded) {
		router.overload.Add(1)
	}
	return value, err
}

func (router *Router[T]) Delete(key Key) {
	router.cache.Delete(key.cacheKey())
}

func (router *Router[T]) DeleteWorker(worker string) {
	router.cache.DeletePrefix(worker + "\x00")
}

func (router *Router[T]) Len() int { return router.cache.Len() }

func (router *Router[T]) Stats() Stats {
	return Stats{
		CacheHits: router.hits.Load(), CacheMisses: router.missed.Load(),
		Overloaded: router.overload.Load(), Inflight: router.misses.current.Load(),
		Entries: router.cache.Len(),
	}
}

type miss[T any] struct {
	done  chan struct{}
	value T
	err   error
}

type missGroup[T any] struct {
	mu       sync.Mutex
	capacity int
	inflight map[string]*miss[T]
	current  atomic.Int64
}

func newMissGroup[T any](capacity int) *missGroup[T] {
	return &missGroup[T]{capacity: capacity, inflight: make(map[string]*miss[T])}
}

func (group *missGroup[T]) Do(ctx context.Context, key string, work func() (T, error)) (T, error) {
	group.mu.Lock()
	if flight, ok := group.inflight[key]; ok {
		group.mu.Unlock()
		select {
		case <-ctx.Done():
			var zero T
			return zero, ctx.Err()
		case <-flight.done:
			return flight.value, flight.err
		}
	}
	if len(group.inflight) >= group.capacity {
		group.mu.Unlock()
		var zero T
		return zero, ErrOverloaded
	}
	flight := &miss[T]{done: make(chan struct{})}
	group.inflight[key] = flight
	group.current.Add(1)
	group.mu.Unlock()

	flight.value, flight.err = work()
	group.mu.Lock()
	delete(group.inflight, key)
	close(flight.done)
	group.current.Add(-1)
	group.mu.Unlock()
	return flight.value, flight.err
}

type cache[T any] struct {
	mu       sync.Mutex
	entries  map[string]*list.Element
	recency  *list.List
	capacity int
	idleTTL  time.Duration
	now      func() time.Time
}

type cacheEntry[T any] struct {
	key      string
	value    T
	lastUsed time.Time
}

func newCache[T any](capacity int, idleTTL time.Duration) *cache[T] {
	return &cache[T]{
		entries: make(map[string]*list.Element, capacity), recency: list.New(),
		capacity: capacity, idleTTL: idleTTL, now: time.Now,
	}
}

func (cache *cache[T]) Get(key string) (T, bool) {
	cache.mu.Lock()
	defer cache.mu.Unlock()
	element, ok := cache.entries[key]
	if !ok {
		var zero T
		return zero, false
	}
	entry := element.Value.(*cacheEntry[T])
	now := cache.now()
	if now.Sub(entry.lastUsed) >= cache.idleTTL {
		cache.remove(element)
		var zero T
		return zero, false
	}
	entry.lastUsed = now
	cache.recency.MoveToFront(element)
	return entry.value, true
}

func (cache *cache[T]) Put(key string, value T) T {
	cache.mu.Lock()
	defer cache.mu.Unlock()
	now := cache.now()
	cache.removeExpired(now)
	if element, ok := cache.entries[key]; ok {
		entry := element.Value.(*cacheEntry[T])
		entry.value = value
		entry.lastUsed = now
		cache.recency.MoveToFront(element)
		return value
	}
	element := cache.recency.PushFront(&cacheEntry[T]{key: key, value: value, lastUsed: now})
	cache.entries[key] = element
	for len(cache.entries) > cache.capacity {
		cache.remove(cache.recency.Back())
	}
	return value
}

func (cache *cache[T]) Delete(key string) {
	cache.mu.Lock()
	defer cache.mu.Unlock()
	if element, ok := cache.entries[key]; ok {
		cache.remove(element)
	}
}

func (cache *cache[T]) DeletePrefix(prefix string) {
	cache.mu.Lock()
	defer cache.mu.Unlock()
	for key, element := range cache.entries {
		if strings.HasPrefix(key, prefix) {
			cache.remove(element)
		}
	}
}

func (cache *cache[T]) Len() int {
	cache.mu.Lock()
	defer cache.mu.Unlock()
	cache.removeExpired(cache.now())
	return len(cache.entries)
}

func (cache *cache[T]) removeExpired(now time.Time) {
	for element := cache.recency.Back(); element != nil; element = cache.recency.Back() {
		entry := element.Value.(*cacheEntry[T])
		if now.Sub(entry.lastUsed) < cache.idleTTL {
			return
		}
		cache.remove(element)
	}
}

func (cache *cache[T]) remove(element *list.Element) {
	if element == nil {
		return
	}
	entry := element.Value.(*cacheEntry[T])
	delete(cache.entries, entry.key)
	cache.recency.Remove(element)
}
