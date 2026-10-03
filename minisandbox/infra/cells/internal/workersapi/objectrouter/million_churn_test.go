package objectrouter

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"runtime"
	"strconv"
	"sync/atomic"
	"testing"
	"time"
)

// This fixture measures the real cache, not Registry/FDB, HTTP, or Actor ownership.
// Its resolver retains no history and returns a fixed-size Object ID payload.
func TestRouterMillionKeyChurn(t *testing.T) {
	const capacity = 32_768
	const warmKeys = capacity * 4
	const totalKeys = 1_000_000
	// This is a fixture-specific growth bound, not an API RSS or product quota.
	const allowedGrowth = uint64(capacity*1024 + 8*1024*1024)
	var resolves atomic.Uint64
	var refreshes atomic.Uint64
	backend := testBackend{
		resolve: func(_ context.Context, key Key) (string, error) {
			resolves.Add(1)
			return key.ObjectID, nil
		},
		refresh: func(_ context.Context, value string) (string, error) {
			refreshes.Add(1)
			return value, nil
		},
	}
	router := New[string](backend, capacity, 10*time.Minute, 256)
	// Freeze the cache clock so expiry cannot hide incorrect eviction or retention.
	router.cache.now = func() time.Time { return time.Unix(1, 0) }
	keyAt := func(index int) Key {
		digest := sha256.Sum256([]byte(strconv.Itoa(index)))
		return Key{Worker: "million-churn", Class: "Counter", ObjectID: hex.EncodeToString(digest[:])}
	}
	heap := func() uint64 {
		runtime.GC()
		var memory runtime.MemStats
		runtime.ReadMemStats(&memory)
		runtime.KeepAlive(router)
		return memory.HeapAlloc
	}
	baseline := heap()
	var warmHeap uint64
	for index := 0; index < totalKeys; index++ {
		key := keyAt(index)
		value, err := router.Resolve(context.Background(), key)
		if err != nil || value != key.ObjectID {
			t.Fatalf("resolution %d returned an incorrect value or error: %v", index, err)
		}
		if (index+1)%capacity == 0 && router.Len() != capacity {
			t.Fatalf("cache length after %d distinct keys = %d, want %d", index+1, router.Len(), capacity)
		}
		if index+1 == warmKeys {
			warmHeap = heap()
			t.Logf("phase=warm keys=%d entries=%d heap_bytes=%d", warmKeys, router.Len(), warmHeap)
		}
	}
	fullHeap := heap()
	if fullHeap > warmHeap && fullHeap-warmHeap > allowedGrowth {
		t.Fatalf("retained heap grew by %d bytes after the cache was full, bound=%d", fullHeap-warmHeap, allowedGrowth)
	}
	stats := router.Stats()
	if stats.Entries != capacity || stats.Inflight != 0 || stats.Overloaded != 0 ||
		stats.CacheHits != 0 || stats.CacheMisses != totalKeys || resolves.Load() != totalKeys {
		t.Fatalf("million-key cache/miss state is incorrect: stats=%+v resolves=%d", stats, resolves.Load())
	}
	t.Logf("phase=million keys=%d entries=%d heap_bytes=%d baseline_heap_bytes=%d growth_bound_bytes=%d",
		totalKeys, stats.Entries, fullHeap, baseline, allowedGrowth)

	// An evicted key must resolve again, while a recent key must refresh its binding.
	for _, key := range []Key{keyAt(0), keyAt(totalKeys - 1)} {
		if value, err := router.Resolve(context.Background(), key); err != nil || value != key.ObjectID {
			t.Fatalf("post-churn resolution failed: %v", err)
		}
	}
	if resolves.Load() != totalKeys+1 || refreshes.Load() != 1 {
		t.Fatalf("eviction/hit behavior differs: resolves=%d refreshes=%d", resolves.Load(), refreshes.Load())
	}
	router.DeleteWorker("million-churn")
	if router.Len() != 0 || router.cache.recency.Len() != 0 || len(router.misses.inflight) != 0 {
		t.Fatal("exact Worker deletion retained cache entries, LRU nodes, or miss flights")
	}
	t.Logf("phase=deleted entries=%d heap_bytes=%d", router.Len(), heap())
	runtime.KeepAlive(router)
}
