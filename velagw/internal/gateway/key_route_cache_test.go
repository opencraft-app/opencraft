package gateway

import (
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
)

func TestMemoryAPIKeyRouteCacheExpiresAndScrubsExternalKey(t *testing.T) {
	now := time.Date(2026, 6, 20, 12, 0, 0, 0, time.UTC)
	cache := NewMemoryAPIKeyRouteCache(time.Second, 10)
	cache.now = func() time.Time { return now }

	externalKeyHash := hashExternalKey("llmgw-ext")
	if err := cache.Set(t.Context(), externalKeyHash, APIKeyBinding{
		ExternalKey:   "llmgw-ext",
		ExternalKeyID: "key-abc",
		SetID:         "set-a",
		UserID:        "user-1",
		UpstreamKey:   "sk-upstream",
	}); err != nil {
		t.Fatal(err)
	}

	got, ok, err := cache.Get(t.Context(), externalKeyHash)
	if err != nil || !ok {
		t.Fatalf("cache miss before ttl: ok=%v err=%v", ok, err)
	}
	if got.ExternalKey != "" || got.ExternalKeyID != "key-abc" || got.UpstreamKey != "sk-upstream" {
		t.Fatalf("unexpected cached binding: %+v", got)
	}

	now = now.Add(2 * time.Second)
	if _, ok, err := cache.Get(t.Context(), externalKeyHash); err != nil || ok {
		t.Fatalf("cache hit after ttl: ok=%v err=%v", ok, err)
	}
}

func TestRedisAPIKeyRouteCacheRoundTripAndDelete(t *testing.T) {
	server, err := miniredis.Run()
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()

	client := redis.NewClient(&redis.Options{Addr: server.Addr()})
	defer client.Close()
	cache := NewRedisAPIKeyRouteCache(client, time.Minute, "test")
	externalKeyHash := hashExternalKey("llmgw-ext")

	if err := cache.Set(t.Context(), externalKeyHash, APIKeyBinding{
		ExternalKey:   "llmgw-ext",
		ExternalKeyID: "key-abc",
		SetID:         "set-a",
		UserID:        "user-1",
		UpstreamKey:   "sk-upstream",
		UpstreamKeyID: 7,
	}); err != nil {
		t.Fatal(err)
	}
	got, ok, err := cache.Get(t.Context(), externalKeyHash)
	if err != nil || !ok {
		t.Fatalf("redis cache miss: ok=%v err=%v", ok, err)
	}
	if got.ExternalKey != "" ||
		got.ExternalKeyHash != externalKeyHash ||
		got.ExternalKeyID != "key-abc" ||
		got.SetID != "set-a" ||
		got.UserID != "user-1" ||
		got.UpstreamKey != "sk-upstream" ||
		got.UpstreamKeyID != 7 {
		t.Fatalf("unexpected cached binding: %+v", got)
	}

	if err := cache.Delete(t.Context(), externalKeyHash); err != nil {
		t.Fatal(err)
	}
	if _, ok, err := cache.Get(t.Context(), externalKeyHash); err != nil || ok {
		t.Fatalf("redis cache hit after delete: ok=%v err=%v", ok, err)
	}
}

func TestRedisRouteSnapshotUsesKeyShardHashTag(t *testing.T) {
	server, err := miniredis.Run()
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()

	client := redis.NewClient(&redis.Options{Addr: server.Addr()})
	defer client.Close()
	cache := NewRedisAPIKeyRouteCache(client, time.Minute, "test")
	keyID := "key-route-123"
	shard := keyShardForExternalKeyID(keyID)
	snapshot := TrafficRouteSnapshot{
		ExternalKeyID:   keyID,
		ExternalKeyHash: hashExternalKey("sk-lgw-v1"),
		SecretHash:      hashExternalKeySecret("secret"),
		KeyShard:        shard,
		UserID:          "uin-1",
		SetID:           "set-a",
		SetBaseURL:      "http://newapi-a:3000",
		UpstreamKey:     "sk-upstream",
		Enabled:         true,
	}
	if err := cache.SetRoute(t.Context(), snapshot); err != nil {
		t.Fatal(err)
	}

	redisKey := cache.routeKey(shard, keyID)
	if !server.Exists(redisKey) {
		t.Fatalf("route snapshot was not written at %q", redisKey)
	}
	if want := "test:route:{" + shard + "}:key:" + keyID; redisKey != want {
		t.Fatalf("route redis key = %q, want %q", redisKey, want)
	}
	got, ok, err := cache.GetRoute(t.Context(), TrafficRouteLookup{
		ExternalKeyID: keyID,
		KeyShard:      shard,
		SecretHash:    snapshot.SecretHash,
	})
	if err != nil || !ok {
		t.Fatalf("route snapshot miss: ok=%v err=%v", ok, err)
	}
	if got.SetBaseURL != snapshot.SetBaseURL || got.UpstreamKey != snapshot.UpstreamKey || !got.Enabled {
		t.Fatalf("unexpected snapshot: %+v", got)
	}
}

func TestRedisRouteSnapshotDoesNotExpireWithKeyCacheTTL(t *testing.T) {
	server, err := miniredis.Run()
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()

	client := redis.NewClient(&redis.Options{Addr: server.Addr()})
	defer client.Close()
	cache := NewRedisAPIKeyRouteCache(client, time.Second, "test")
	keyID := "key-route-persistent"
	shard := keyShardForExternalKeyID(keyID)
	snapshot := TrafficRouteSnapshot{
		ExternalKeyID: keyID,
		SecretHash:    hashExternalKeySecret("secret"),
		KeyShard:      shard,
		UserID:        "uin-1",
		SetID:         "set-a",
		SetBaseURL:    "http://newapi-a:3000",
		UpstreamKey:   "sk-upstream",
		Enabled:       true,
	}
	if err := cache.SetRoute(t.Context(), snapshot); err != nil {
		t.Fatal(err)
	}

	server.FastForward(2 * time.Second)

	got, ok, err := cache.GetRoute(t.Context(), TrafficRouteLookup{
		ExternalKeyID: keyID,
		KeyShard:      shard,
		SecretHash:    snapshot.SecretHash,
	})
	if err != nil || !ok {
		t.Fatalf("route snapshot expired with cache ttl: ok=%v err=%v", ok, err)
	}
	if got.SetID != snapshot.SetID || got.UpstreamKey != snapshot.UpstreamKey {
		t.Fatalf("unexpected snapshot after ttl: %+v", got)
	}
}

func TestRedisRouteSnapshotBatchDeleteRemovesModernAndLegacyKeys(t *testing.T) {
	server, err := miniredis.Run()
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()

	client := redis.NewClient(&redis.Options{Addr: server.Addr()})
	defer client.Close()
	cache := NewRedisAPIKeyRouteCache(client, time.Minute, "test")
	modernLookup := TrafficRouteLookup{ExternalKeyID: "key-modern", KeyShard: keyShardForExternalKeyID("key-modern")}
	legacyLookup := TrafficRouteLookup{ExternalKeyHash: hashExternalKey("sk-legacy"), Legacy: true}
	if err := client.Set(t.Context(), cache.lookupRouteKey(modernLookup), "modern", 0).Err(); err != nil {
		t.Fatal(err)
	}
	if err := client.Set(t.Context(), cache.lookupRouteKey(legacyLookup), "legacy", 0).Err(); err != nil {
		t.Fatal(err)
	}

	if err := cache.DeleteRoutes(t.Context(), []TrafficRouteLookup{modernLookup, legacyLookup, modernLookup}); err != nil {
		t.Fatal(err)
	}
	if server.Exists(cache.lookupRouteKey(modernLookup)) || server.Exists(cache.lookupRouteKey(legacyLookup)) {
		t.Fatal("batch route deletion left cached keys behind")
	}
}

func TestMemorySetRuntimeRouteRejectsStaleRevision(t *testing.T) {
	cache := NewMemoryAPIKeyRouteCache(time.Minute, 10)
	newer := SetRuntimeRouteSnapshot{
		SetID:             "set-a",
		RuntimeGeneration: 13,
		RouteRevision:     21,
		TrafficBaseURL:    "http://set-a-g13:3000",
		Enabled:           true,
	}
	if applied, err := cache.SetSetRuntime(t.Context(), newer); err != nil || !applied {
		t.Fatalf("set newer runtime applied=%v err=%v", applied, err)
	}
	stale := newer
	stale.RuntimeGeneration = 12
	stale.RouteRevision = 20
	stale.TrafficBaseURL = "http://set-a-g12:3000"
	if applied, err := cache.SetSetRuntime(t.Context(), stale); err != nil || applied {
		t.Fatalf("set stale runtime applied=%v err=%v", applied, err)
	}

	got, ok, err := cache.GetSetRuntime(t.Context(), "set-a")
	if err != nil || !ok {
		t.Fatalf("get runtime ok=%v err=%v", ok, err)
	}
	if got.RouteRevision != newer.RouteRevision || got.TrafficBaseURL != newer.TrafficBaseURL {
		t.Fatalf("runtime was overwritten by stale revision: %+v", got)
	}
}

func TestRedisSetRuntimeRouteIsPersistentAndCASProtected(t *testing.T) {
	server, err := miniredis.Run()
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()

	client := redis.NewClient(&redis.Options{Addr: server.Addr()})
	defer client.Close()
	cache := NewRedisAPIKeyRouteCache(client, time.Second, "test")
	newer := SetRuntimeRouteSnapshot{
		SetID:             "set-a",
		RuntimeGeneration: 13,
		RouteRevision:     21,
		TrafficBaseURL:    "http://set-a-g13:3000",
		Enabled:           true,
	}
	if applied, err := cache.SetSetRuntime(t.Context(), newer); err != nil || !applied {
		t.Fatalf("set newer runtime applied=%v err=%v", applied, err)
	}
	if want := "test:set-runtime:{set-a}"; cache.setRuntimeKey("set-a") != want || !server.Exists(want) {
		t.Fatalf("runtime key=%q exists=%v, want %q", cache.setRuntimeKey("set-a"), server.Exists(want), want)
	}

	server.FastForward(2 * time.Second)
	stale := newer
	stale.RuntimeGeneration = 12
	stale.RouteRevision = 20
	stale.TrafficBaseURL = "http://set-a-g12:3000"
	if applied, err := cache.SetSetRuntime(t.Context(), stale); err != nil || applied {
		t.Fatalf("set stale runtime applied=%v err=%v", applied, err)
	}
	got, ok, err := cache.GetSetRuntime(t.Context(), "set-a")
	if err != nil || !ok {
		t.Fatalf("get runtime ok=%v err=%v", ok, err)
	}
	if got.RouteRevision != newer.RouteRevision || got.TrafficBaseURL != newer.TrafficBaseURL {
		t.Fatalf("runtime after ttl/stale write = %+v", got)
	}
}
