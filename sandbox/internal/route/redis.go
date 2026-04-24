package route

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"strings"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
)

// RedisStore stores route rules in Redis.
type RedisStore struct {
	mu     sync.RWMutex
	client *redis.Client
	addr   string
	pass   string
	db     int
	cliCmd string

	prefix string
	ttl    time.Duration
}

// NewRedisStore builds a Redis-backed route store and validates connectivity.
func NewRedisStore(addr, password string, db int, prefix string) (*RedisStore, error) {
	if addr == "" {
		return nil, fmt.Errorf("redis addr required")
	}
	if prefix == "" {
		prefix = "route:sandbox:"
	}
	s := &RedisStore{
		addr:   addr,
		pass:   password,
		db:     db,
		cliCmd: fmt.Sprintf("redis-cli -u redis://:%s@%s/%d", password, addr, db),
		prefix: prefix,
	}
	log.Printf("[route] redis connect addr=%s db=%d prefix=%s cmd=%s", addr, db, prefix, s.cliCmd)

	const (
		initialTimeout = 6 * time.Second
		retryCount     = 10
		retryInterval  = 2 * time.Second
	)
	if err := s.reconnectWithRetry(initialTimeout, retryCount, retryInterval, "bootstrap", nil); err != nil {
		return nil, err
	}
	go s.healthLoop(10 * time.Second)
	return s, nil
}

func (s *RedisStore) key(sandboxID string) string {
	return s.prefix + sandboxID
}

// Get fetches a route rule by sandbox ID.
func (s *RedisStore) Get(ctx context.Context, sandboxID string) (Rule, error) {
	val, err := s.clientRef().Get(ctx, s.key(sandboxID)).Result()
	if err == redis.Nil {
		return Rule{}, ErrRouteNotFound
	}
	if err != nil && s.shouldReconnect(err) {
		if rerr := s.reconnectWithRetry(4*time.Second, 2, time.Second, "get", err); rerr == nil {
			val, err = s.clientRef().Get(ctx, s.key(sandboxID)).Result()
		}
	}
	if err == redis.Nil {
		return Rule{}, ErrRouteNotFound
	}
	if err != nil {
		return Rule{}, err
	}
	var rule Rule
	if err := json.Unmarshal([]byte(val), &rule); err != nil {
		return Rule{}, err
	}
	return rule, nil
}

// Set upserts a route rule.
func (s *RedisStore) Set(ctx context.Context, rule Rule) error {
	if rule.UpdatedAt.IsZero() {
		rule.UpdatedAt = time.Now().UTC()
	}
	payload, err := json.Marshal(rule)
	if err != nil {
		return err
	}
	client := s.clientRef()
	if s.ttl > 0 {
		err = client.Set(ctx, s.key(rule.SandboxID), payload, s.ttl).Err()
	} else {
		err = client.Set(ctx, s.key(rule.SandboxID), payload, 0).Err()
	}
	if err != nil && s.shouldReconnect(err) {
		if rerr := s.reconnectWithRetry(4*time.Second, 2, time.Second, "set", err); rerr == nil {
			client = s.clientRef()
			if s.ttl > 0 {
				return client.Set(ctx, s.key(rule.SandboxID), payload, s.ttl).Err()
			}
			return client.Set(ctx, s.key(rule.SandboxID), payload, 0).Err()
		}
	}
	return err
}

// Delete removes a route rule by sandbox ID.
func (s *RedisStore) Delete(ctx context.Context, sandboxID string) error {
	client := s.clientRef()
	err := client.Del(ctx, s.key(sandboxID)).Err()
	if err != nil && s.shouldReconnect(err) {
		if rerr := s.reconnectWithRetry(4*time.Second, 2, time.Second, "delete", err); rerr == nil {
			return s.clientRef().Del(ctx, s.key(sandboxID)).Err()
		}
	}
	return err
}

func (s *RedisStore) healthLoop(interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for range ticker.C {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		err := s.clientRef().Ping(ctx).Err()
		cancel()
		if err == nil {
			continue
		}
		log.Printf("[route] redis health check failed addr=%s db=%d err=%v cmd=%s", s.addr, s.db, err, s.cliCmd)
		_ = s.reconnectWithRetry(4*time.Second, 2, time.Second, "health-check", err)
	}
}

func (s *RedisStore) reconnectWithRetry(timeout time.Duration, retries int, interval time.Duration, reason string, cause error) error {
	var lastErr error
	for attempt := 1; attempt <= retries+1; attempt++ {
		client := redis.NewClient(&redis.Options{
			Addr:     s.addr,
			Password: s.pass,
			DB:       s.db,
		})
		ctx, cancel := context.WithTimeout(context.Background(), timeout)
		lastErr = client.Ping(ctx).Err()
		cancel()
		if lastErr == nil {
			s.swapClient(client)
			if attempt > 1 || cause != nil {
				log.Printf("[route] redis reconnected reason=%s attempt=%d/%d addr=%s db=%d", reason, attempt, retries+1, s.addr, s.db)
			}
			return nil
		}
		_ = client.Close()
		log.Printf("[route] redis reconnect failed reason=%s attempt=%d/%d addr=%s db=%d err=%v cause=%v cmd=%s", reason, attempt, retries+1, s.addr, s.db, lastErr, cause, s.cliCmd)
		if attempt <= retries {
			time.Sleep(interval)
		}
	}
	return fmt.Errorf("redis reconnect failed after %d attempts: %w", retries+1, lastErr)
}

func (s *RedisStore) clientRef() *redis.Client {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.client
}

func (s *RedisStore) swapClient(next *redis.Client) {
	s.mu.Lock()
	prev := s.client
	s.client = next
	s.mu.Unlock()
	if prev != nil {
		_ = prev.Close()
	}
}

func (s *RedisStore) shouldReconnect(err error) bool {
	if err == nil || err == redis.Nil {
		return false
	}
	msg := strings.ToLower(err.Error())
	if strings.Contains(msg, "closed network connection") ||
		strings.Contains(msg, "connection refused") ||
		strings.Contains(msg, "i/o timeout") ||
		strings.Contains(msg, "broken pipe") ||
		strings.Contains(msg, "eof") ||
		strings.Contains(msg, "timeout") {
		return true
	}
	return false
}
