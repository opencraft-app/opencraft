package redis

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
)

// Config holds Redis connection settings.
type Config struct {
	Addr      string
	Password  string
	DB        int
	PoolSize  int
	KeyPrefix string
}

// LockStore implements RuntimeOwnershipStore, WorkspaceLeaseStore, and
// RuntimeEnsureLocker using Redis with Lua scripts for atomicity.
type LockStore struct {
	client   *redis.Client
	keyspace redisKeyspace
}

// New creates a LockStore connected to the given Redis instance.
func New(cfg Config) (*LockStore, error) {
	if cfg.Addr == "" {
		return nil, errors.New("redis addr is required")
	}
	if cfg.KeyPrefix == "" {
		cfg.KeyPrefix = "gw:"
	}
	poolSize := cfg.PoolSize
	if poolSize <= 0 {
		poolSize = 20
	}
	client := redis.NewClient(&redis.Options{
		Addr:     cfg.Addr,
		Password: cfg.Password,
		DB:       cfg.DB,
		PoolSize: poolSize,
	})
	return &LockStore{client: client, keyspace: newRedisKeyspace(cfg.KeyPrefix)}, nil
}

// Ping verifies the Redis connection is alive.
func (s *LockStore) Ping(ctx context.Context) error {
	return s.client.Ping(ctx).Err()
}

// Close shuts down the Redis client.
func (s *LockStore) Close() error {
	return s.client.Close()
}

func (s *LockStore) key(parts ...string) string {
	return s.keyspace.key(parts...)
}

func randomID() string {
	b := make([]byte, 12)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func parseInt64(s string) int64 {
	v, _ := strconv.ParseInt(s, 10, 64)
	return v
}

func formatInt64(v int64) string {
	return strconv.FormatInt(v, 10)
}

func formatTime(t time.Time) string {
	if t.IsZero() {
		return ""
	}
	return t.Format(time.RFC3339Nano)
}

func parseTime(s string) time.Time {
	if s == "" {
		return time.Time{}
	}
	t, _ := time.Parse(time.RFC3339Nano, s)
	return t
}

func ttlMs(ttl time.Duration) int64 {
	ms := ttl.Milliseconds()
	if ms <= 0 {
		ms = 1
	}
	return ms
}

// graceTTL adds extra time beyond the lease TTL so Redis auto-cleans
// keys after the lease is definitely expired, while still allowing
// readers to inspect the expired state.
func graceTTL(ttl time.Duration) time.Duration {
	grace := ttl + 5*time.Minute
	if grace < time.Minute {
		grace = time.Minute
	}
	return grace
}

var _ fmt.Stringer = (*LockStore)(nil)

func (s *LockStore) String() string {
	return "redis:" + s.client.Options().Addr
}
