package gateway

import (
	"context"
	"encoding/json"
	"fmt"
	"hash/fnv"
	"strings"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
)

const (
	defaultKeyRouteCacheTTL      = time.Minute
	defaultKeyRouteCacheCapacity = 100_000
	defaultRedisRouteTimeout     = 500 * time.Millisecond
)

type APIKeyRouteCache interface {
	Get(context.Context, string) (APIKeyBinding, bool, error)
	Set(context.Context, string, APIKeyBinding) error
	Delete(context.Context, string) error
	GetRoute(context.Context, TrafficRouteLookup) (TrafficRouteSnapshot, bool, error)
	SetRoute(context.Context, TrafficRouteSnapshot) error
	DeleteRoute(context.Context, TrafficRouteLookup) error
	GetSetRuntime(context.Context, string) (SetRuntimeRouteSnapshot, bool, error)
	SetSetRuntime(context.Context, SetRuntimeRouteSnapshot) (bool, error)
}

type MemoryAPIKeyRouteCache struct {
	mu       sync.RWMutex
	ttl      time.Duration
	capacity int
	entries  map[string]apiKeyRouteCacheEntry
	routes   map[string]trafficRouteCacheEntry
	runtimes map[string]SetRuntimeRouteSnapshot
	now      func() time.Time
}

type apiKeyRouteCacheEntry struct {
	binding   APIKeyBinding
	expiresAt time.Time
}

type trafficRouteCacheEntry struct {
	snapshot  TrafficRouteSnapshot
	expiresAt time.Time
}

func NewMemoryAPIKeyRouteCache(ttl time.Duration, capacity int) *MemoryAPIKeyRouteCache {
	if ttl <= 0 {
		ttl = defaultKeyRouteCacheTTL
	}
	if capacity <= 0 {
		capacity = defaultKeyRouteCacheCapacity
	}
	return &MemoryAPIKeyRouteCache{
		ttl:      ttl,
		capacity: capacity,
		entries:  map[string]apiKeyRouteCacheEntry{},
		routes:   map[string]trafficRouteCacheEntry{},
		runtimes: map[string]SetRuntimeRouteSnapshot{},
		now:      time.Now,
	}
}

func (c *MemoryAPIKeyRouteCache) GetSetRuntime(_ context.Context, setID string) (SetRuntimeRouteSnapshot, bool, error) {
	if c == nil || strings.TrimSpace(setID) == "" {
		return SetRuntimeRouteSnapshot{}, false, nil
	}
	c.mu.RLock()
	snapshot, ok := c.runtimes[setID]
	c.mu.RUnlock()
	return snapshot, ok, nil
}

func (c *MemoryAPIKeyRouteCache) SetSetRuntime(_ context.Context, snapshot SetRuntimeRouteSnapshot) (bool, error) {
	if c == nil {
		return false, nil
	}
	if strings.TrimSpace(snapshot.SetID) == "" || snapshot.RouteRevision <= 0 {
		return false, fmt.Errorf("set runtime requires set_id and positive route_revision")
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	current, ok := c.runtimes[snapshot.SetID]
	if ok && current.RouteRevision >= snapshot.RouteRevision {
		return current.RouteRevision == snapshot.RouteRevision && setRuntimeSnapshotsEqual(current, snapshot), nil
	}
	c.runtimes[snapshot.SetID] = snapshot
	return true, nil
}

func (c *MemoryAPIKeyRouteCache) Get(_ context.Context, externalKeyHash string) (APIKeyBinding, bool, error) {
	if c == nil || externalKeyHash == "" {
		return APIKeyBinding{}, false, nil
	}
	now := c.nowUTC()
	c.mu.RLock()
	entry, ok := c.entries[externalKeyHash]
	c.mu.RUnlock()
	if !ok {
		return APIKeyBinding{}, false, nil
	}
	if !entry.expiresAt.After(now) {
		_ = c.Delete(context.Background(), externalKeyHash)
		return APIKeyBinding{}, false, nil
	}
	return entry.binding, true, nil
}

func (c *MemoryAPIKeyRouteCache) Set(_ context.Context, externalKeyHash string, binding APIKeyBinding) error {
	if c == nil || externalKeyHash == "" {
		return nil
	}
	binding.ExternalKey = ""
	binding.ExternalKeyHash = externalKeyHash

	c.mu.Lock()
	defer c.mu.Unlock()
	c.evictIfNeededLocked()
	c.entries[externalKeyHash] = apiKeyRouteCacheEntry{
		binding:   binding,
		expiresAt: c.nowUTC().Add(c.ttl),
	}
	return nil
}

func (c *MemoryAPIKeyRouteCache) Delete(_ context.Context, externalKeyHash string) error {
	if c == nil || externalKeyHash == "" {
		return nil
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.entries, externalKeyHash)
	delete(c.routes, memoryRouteKey(TrafficRouteLookup{ExternalKeyHash: externalKeyHash, Legacy: true}))
	return nil
}

func (c *MemoryAPIKeyRouteCache) GetRoute(_ context.Context, lookup TrafficRouteLookup) (TrafficRouteSnapshot, bool, error) {
	if c == nil {
		return TrafficRouteSnapshot{}, false, nil
	}
	now := c.nowUTC()
	key := memoryRouteKey(lookup)
	c.mu.RLock()
	entry, ok := c.routes[key]
	c.mu.RUnlock()
	if !ok {
		return TrafficRouteSnapshot{}, false, nil
	}
	if !entry.expiresAt.IsZero() && !entry.expiresAt.After(now) {
		_ = c.DeleteRoute(context.Background(), lookup)
		return TrafficRouteSnapshot{}, false, nil
	}
	if lookup.SecretHash != "" && lookup.SecretHash != entry.snapshot.SecretHash {
		return TrafficRouteSnapshot{}, false, nil
	}
	return entry.snapshot, true, nil
}

func (c *MemoryAPIKeyRouteCache) SetRoute(_ context.Context, snapshot TrafficRouteSnapshot) error {
	if c == nil {
		return nil
	}
	lookup := TrafficRouteLookup{
		ExternalKeyHash: snapshot.ExternalKeyHash,
		ExternalKeyID:   snapshot.ExternalKeyID,
		KeyShard:        snapshot.KeyShard,
		Legacy:          snapshot.ExternalKeyID == "",
	}
	if lookup.KeyShard == "" && lookup.ExternalKeyID != "" {
		lookup.KeyShard = keyShardForExternalKeyID(lookup.ExternalKeyID)
		snapshot.KeyShard = lookup.KeyShard
	}
	if snapshot.UpdatedAt.IsZero() {
		snapshot.UpdatedAt = c.nowUTC()
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.evictIfNeededLocked()
	c.routes[memoryRouteKey(lookup)] = trafficRouteCacheEntry{
		snapshot:  snapshot,
		expiresAt: time.Time{},
	}
	return nil
}

func (c *MemoryAPIKeyRouteCache) DeleteRoute(_ context.Context, lookup TrafficRouteLookup) error {
	if c == nil {
		return nil
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.routes, memoryRouteKey(lookup))
	return nil
}

func (c *MemoryAPIKeyRouteCache) DeleteRoutes(ctx context.Context, lookups []TrafficRouteLookup) error {
	for _, lookup := range lookups {
		if err := c.DeleteRoute(ctx, lookup); err != nil {
			return err
		}
	}
	return nil
}

func (c *MemoryAPIKeyRouteCache) evictIfNeededLocked() {
	if len(c.entries) < c.capacity {
		return
	}
	now := c.nowUTC()
	for key, entry := range c.entries {
		if !entry.expiresAt.After(now) {
			delete(c.entries, key)
		}
	}
	for key, entry := range c.routes {
		if !entry.expiresAt.IsZero() && !entry.expiresAt.After(now) {
			delete(c.routes, key)
		}
	}
	if len(c.entries) < c.capacity {
		return
	}
	for key := range c.entries {
		delete(c.entries, key)
		return
	}
}

func (c *MemoryAPIKeyRouteCache) nowUTC() time.Time {
	if c.now == nil {
		return time.Now().UTC()
	}
	return c.now().UTC()
}

type RedisAPIKeyRouteCache struct {
	client    redis.UniversalClient
	ttl       time.Duration
	namespace string
}

var setRuntimeRouteCASScript = redis.NewScript(`
local current = redis.call('GET', KEYS[1])
if current then
  local decoded = cjson.decode(current)
  local current_revision = tonumber(decoded.route_revision) or 0
  local incoming_revision = tonumber(ARGV[1]) or 0
  if current_revision > incoming_revision then
    return 0
  end
  if current_revision == incoming_revision then
    if current == ARGV[2] then
      return 1
    end
    return 0
  end
end
redis.call('SET', KEYS[1], ARGV[2])
return 1
`)

type apiKeyRouteCacheValue struct {
	ExternalKeyHash string    `json:"external_key_hash"`
	ExternalKeyID   string    `json:"external_key_id"`
	SetID           string    `json:"set_id"`
	UserID          string    `json:"user_id"`
	UpstreamKey     string    `json:"upstream_key"`
	UpstreamKeyID   int       `json:"upstream_key_id"`
	CreatedAt       time.Time `json:"created_at"`
}

func NewRedisAPIKeyRouteCache(client redis.UniversalClient, ttl time.Duration, namespace string) *RedisAPIKeyRouteCache {
	if ttl <= 0 {
		ttl = defaultKeyRouteCacheTTL
	}
	if namespace == "" {
		namespace = "llmgateway"
	}
	return &RedisAPIKeyRouteCache{client: client, ttl: ttl, namespace: namespace}
}

func NewRedisAPIKeyRouteCacheFromURL(ctx context.Context, rawURL string, ttl time.Duration, namespace string) (*RedisAPIKeyRouteCache, error) {
	options, err := redis.ParseURL(rawURL)
	if err != nil {
		return nil, err
	}
	if options.DialTimeout <= 0 {
		options.DialTimeout = defaultRedisRouteTimeout
	}
	if options.ReadTimeout <= 0 {
		options.ReadTimeout = defaultRedisRouteTimeout
	}
	if options.WriteTimeout <= 0 {
		options.WriteTimeout = defaultRedisRouteTimeout
	}
	if options.PoolTimeout <= 0 {
		options.PoolTimeout = defaultRedisRouteTimeout
	}
	client := redis.NewClient(options)
	if err := client.Ping(ctx).Err(); err != nil {
		_ = client.Close()
		return nil, err
	}
	return NewRedisAPIKeyRouteCache(client, ttl, namespace), nil
}

func (c *RedisAPIKeyRouteCache) Get(ctx context.Context, externalKeyHash string) (APIKeyBinding, bool, error) {
	if c == nil || c.client == nil || externalKeyHash == "" {
		return APIKeyBinding{}, false, nil
	}
	raw, err := c.client.Get(ctx, c.key(externalKeyHash)).Bytes()
	if err == redis.Nil {
		return APIKeyBinding{}, false, nil
	}
	if err != nil {
		return APIKeyBinding{}, false, err
	}
	var value apiKeyRouteCacheValue
	if err := json.Unmarshal(raw, &value); err != nil {
		return APIKeyBinding{}, false, err
	}
	return APIKeyBinding{
		ExternalKeyHash: value.ExternalKeyHash,
		ExternalKeyID:   value.ExternalKeyID,
		SetID:           value.SetID,
		UserID:          value.UserID,
		UpstreamKey:     value.UpstreamKey,
		UpstreamKeyID:   value.UpstreamKeyID,
		CreatedAt:       value.CreatedAt,
	}, true, nil
}

func (c *RedisAPIKeyRouteCache) Set(ctx context.Context, externalKeyHash string, binding APIKeyBinding) error {
	if c == nil || c.client == nil || externalKeyHash == "" {
		return nil
	}
	value := apiKeyRouteCacheValue{
		ExternalKeyHash: externalKeyHash,
		ExternalKeyID:   binding.ExternalKeyID,
		SetID:           binding.SetID,
		UserID:          binding.UserID,
		UpstreamKey:     binding.UpstreamKey,
		UpstreamKeyID:   binding.UpstreamKeyID,
		CreatedAt:       binding.CreatedAt,
	}
	raw, err := json.Marshal(value)
	if err != nil {
		return err
	}
	return c.client.Set(ctx, c.key(externalKeyHash), raw, c.ttl).Err()
}

func (c *RedisAPIKeyRouteCache) Delete(ctx context.Context, externalKeyHash string) error {
	if c == nil || c.client == nil || externalKeyHash == "" {
		return nil
	}
	return c.client.Del(ctx, c.key(externalKeyHash)).Err()
}

func (c *RedisAPIKeyRouteCache) GetRoute(ctx context.Context, lookup TrafficRouteLookup) (TrafficRouteSnapshot, bool, error) {
	if c == nil || c.client == nil {
		return TrafficRouteSnapshot{}, false, nil
	}
	raw, err := c.client.Get(ctx, c.lookupRouteKey(lookup)).Bytes()
	if err == redis.Nil {
		return TrafficRouteSnapshot{}, false, nil
	}
	if err != nil {
		return TrafficRouteSnapshot{}, false, err
	}
	var snapshot TrafficRouteSnapshot
	if err := json.Unmarshal(raw, &snapshot); err != nil {
		return TrafficRouteSnapshot{}, false, err
	}
	if lookup.SecretHash != "" && lookup.SecretHash != snapshot.SecretHash {
		return TrafficRouteSnapshot{}, false, nil
	}
	return snapshot, true, nil
}

func (c *RedisAPIKeyRouteCache) SetRoute(ctx context.Context, snapshot TrafficRouteSnapshot) error {
	if c == nil || c.client == nil {
		return nil
	}
	if snapshot.ExternalKeyID != "" && snapshot.KeyShard == "" {
		snapshot.KeyShard = keyShardForExternalKeyID(snapshot.ExternalKeyID)
	}
	if snapshot.UpdatedAt.IsZero() {
		snapshot.UpdatedAt = time.Now().UTC()
	}
	raw, err := json.Marshal(snapshot)
	if err != nil {
		return err
	}
	return c.client.Set(ctx, c.snapshotRouteKey(snapshot), raw, 0).Err()
}

func (c *RedisAPIKeyRouteCache) DeleteRoute(ctx context.Context, lookup TrafficRouteLookup) error {
	if c == nil || c.client == nil {
		return nil
	}
	return c.client.Del(ctx, c.lookupRouteKey(lookup)).Err()
}

func (c *RedisAPIKeyRouteCache) DeleteRoutes(ctx context.Context, lookups []TrafficRouteLookup) error {
	if c == nil || c.client == nil || len(lookups) == 0 {
		return nil
	}
	pipe := c.client.Pipeline()
	seen := make(map[string]struct{}, len(lookups))
	for _, lookup := range lookups {
		key := c.lookupRouteKey(lookup)
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		pipe.Del(ctx, key)
	}
	_, err := pipe.Exec(ctx)
	return err
}

func (c *RedisAPIKeyRouteCache) GetSetRuntime(ctx context.Context, setID string) (SetRuntimeRouteSnapshot, bool, error) {
	if c == nil || c.client == nil || strings.TrimSpace(setID) == "" {
		return SetRuntimeRouteSnapshot{}, false, nil
	}
	raw, err := c.client.Get(ctx, c.setRuntimeKey(setID)).Bytes()
	if err == redis.Nil {
		return SetRuntimeRouteSnapshot{}, false, nil
	}
	if err != nil {
		return SetRuntimeRouteSnapshot{}, false, err
	}
	var snapshot SetRuntimeRouteSnapshot
	if err := json.Unmarshal(raw, &snapshot); err != nil {
		return SetRuntimeRouteSnapshot{}, false, err
	}
	return snapshot, true, nil
}

func (c *RedisAPIKeyRouteCache) SetSetRuntime(ctx context.Context, snapshot SetRuntimeRouteSnapshot) (bool, error) {
	if c == nil || c.client == nil {
		return false, nil
	}
	if strings.TrimSpace(snapshot.SetID) == "" || snapshot.RouteRevision <= 0 {
		return false, fmt.Errorf("set runtime requires set_id and positive route_revision")
	}
	raw, err := json.Marshal(snapshot)
	if err != nil {
		return false, err
	}
	applied, err := setRuntimeRouteCASScript.Run(ctx, c.client, []string{c.setRuntimeKey(snapshot.SetID)}, snapshot.RouteRevision, raw).Int()
	if err != nil {
		return false, err
	}
	return applied == 1, nil
}

func (c *RedisAPIKeyRouteCache) Close() error {
	if c == nil || c.client == nil {
		return nil
	}
	return c.client.Close()
}

func (c *RedisAPIKeyRouteCache) key(externalKeyHash string) string {
	return fmt.Sprintf("%s:key-route:%s", c.namespace, externalKeyHash)
}

func (c *RedisAPIKeyRouteCache) lookupRouteKey(lookup TrafficRouteLookup) string {
	if lookup.ExternalKeyID != "" {
		shard := lookup.KeyShard
		if shard == "" {
			shard = keyShardForExternalKeyID(lookup.ExternalKeyID)
		}
		return c.routeKey(shard, lookup.ExternalKeyID)
	}
	return c.legacyRouteKey(lookup.ExternalKeyHash)
}

func (c *RedisAPIKeyRouteCache) snapshotRouteKey(snapshot TrafficRouteSnapshot) string {
	if snapshot.ExternalKeyID != "" {
		shard := snapshot.KeyShard
		if shard == "" {
			shard = keyShardForExternalKeyID(snapshot.ExternalKeyID)
		}
		return c.routeKey(shard, snapshot.ExternalKeyID)
	}
	return c.legacyRouteKey(snapshot.ExternalKeyHash)
}

func (c *RedisAPIKeyRouteCache) routeKey(keyShard string, externalKeyID string) string {
	return fmt.Sprintf("%s:route:{%s}:key:%s", c.namespace, keyShard, externalKeyID)
}

func (c *RedisAPIKeyRouteCache) legacyRouteKey(externalKeyHash string) string {
	return fmt.Sprintf("%s:route:{legacy}:hash:%s", c.namespace, externalKeyHash)
}

func (c *RedisAPIKeyRouteCache) setRuntimeKey(setID string) string {
	return fmt.Sprintf("%s:set-runtime:{%s}", c.namespace, setID)
}

func setRuntimeSnapshotsEqual(left, right SetRuntimeRouteSnapshot) bool {
	return left.SetID == right.SetID &&
		left.RuntimeGeneration == right.RuntimeGeneration &&
		left.RouteRevision == right.RouteRevision &&
		left.TrafficBaseURL == right.TrafficBaseURL &&
		left.Enabled == right.Enabled &&
		left.SwitchedAt.Equal(right.SwitchedAt)
}

func memoryRouteKey(lookup TrafficRouteLookup) string {
	if lookup.ExternalKeyID != "" {
		shard := lookup.KeyShard
		if shard == "" {
			shard = keyShardForExternalKeyID(lookup.ExternalKeyID)
		}
		return shard + "\x00" + lookup.ExternalKeyID
	}
	return "legacy\x00" + lookup.ExternalKeyHash
}

func keyShardForExternalKeyID(externalKeyID string) string {
	hasher := fnv.New32a()
	_, _ = hasher.Write([]byte(externalKeyID))
	return fmt.Sprintf("ks-%03d", int(hasher.Sum32()%256))
}

func hashExternalKeySecret(secret string) string {
	return hashExternalKey("llmgateway-key-secret:" + secret)
}

func parseTrafficRouteLookup(externalKey string) TrafficRouteLookup {
	externalKey = strings.TrimSpace(externalKey)
	lookup := TrafficRouteLookup{ExternalKeyHash: hashExternalKey(externalKey), Legacy: true}
	const prefix = "sk-lgw-v1-"
	if !strings.HasPrefix(externalKey, prefix) {
		return lookup
	}
	parts := strings.SplitN(strings.TrimPrefix(externalKey, prefix), ".", 3)
	if len(parts) != 3 || parts[0] == "" || parts[1] == "" || parts[2] == "" {
		return lookup
	}
	return TrafficRouteLookup{
		ExternalKeyHash: lookup.ExternalKeyHash,
		ExternalKeyID:   parts[1],
		SecretHash:      hashExternalKeySecret(parts[2]),
		KeyShard:        parts[0],
		Legacy:          false,
	}
}

func formatRoutableExternalKey(externalKeyID string, secret string) string {
	return fmt.Sprintf("sk-lgw-v1-%s.%s.%s", keyShardForExternalKeyID(externalKeyID), externalKeyID, secret)
}
