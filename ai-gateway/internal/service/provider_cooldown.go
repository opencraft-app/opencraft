package service

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"git.woa.com/wisp/mono/ai-gateway/internal/pkg/redisclient"
	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"
)

type ProviderCooldownConfig struct {
	Default429TTLS int `json:"default_429_ttl_s" yaml:"default_429_ttl_s"`
	Max429TTLS     int `json:"max_429_ttl_s" yaml:"max_429_ttl_s"`
}

type GatewayConfig struct {
	MaxInflightBudget      int   `json:"max_inflight_budget" yaml:"max_inflight_budget"`
	StreamRequestWeight    int64 `json:"stream_request_weight" yaml:"stream_request_weight"`
	NonStreamRequestWeight int64 `json:"non_stream_request_weight" yaml:"non_stream_request_weight"`
	OverloadStatusCode     int   `json:"overload_status_code" yaml:"overload_status_code"`
}

type ProviderCooldownStore struct {
	redis  *redisclient.Client
	config ProviderCooldownConfig
	mu     sync.Mutex
	local  map[string]time.Time
}

func NewProviderCooldownStore(redisClient *redisclient.Client, cfg ProviderCooldownConfig) *ProviderCooldownStore {
	return &ProviderCooldownStore{
		redis:  redisClient,
		config: cfg,
		local:  make(map[string]time.Time),
	}
}

func (s *ProviderCooldownStore) Mark429Cooldown(ctx context.Context, providerID uuid.UUID, modelName string, retryAfter string) time.Duration {
	ttl := s.resolveTTL(retryAfter)
	key := providerModelCooldownKey(providerID, modelName)

	if s.redis != nil {
		_ = s.redis.Set(ctx, key, "1", ttl)
		return ttl
	}

	s.mu.Lock()
	s.local[key] = time.Now().Add(ttl)
	s.mu.Unlock()
	return ttl
}

func (s *ProviderCooldownStore) Is429CoolingDown(ctx context.Context, providerID uuid.UUID, modelName string) (bool, error) {
	key := providerModelCooldownKey(providerID, modelName)
	if s.redis != nil {
		_, err := s.redis.Get(ctx, key)
		if err == nil {
			return true, nil
		}
		if errors.Is(err, redis.Nil) {
			return false, nil
		}
		return false, err
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	expiry, ok := s.local[key]
	if !ok {
		return false, nil
	}
	if time.Now().After(expiry) {
		delete(s.local, key)
		return false, nil
	}
	return true, nil
}

func (s *ProviderCooldownStore) Clear429Cooldown(ctx context.Context, providerID uuid.UUID, modelName string) error {
	key := providerModelCooldownKey(providerID, modelName)
	if s.redis != nil {
		return s.redis.Del(ctx, key)
	}
	s.mu.Lock()
	delete(s.local, key)
	s.mu.Unlock()
	return nil
}

func providerModelCooldownKey(providerID uuid.UUID, modelName string) string {
	return fmt.Sprintf("cooldown:provider:%s:model:%s:429", providerID.String(), strings.ToLower(strings.TrimSpace(modelName)))
}

func (s *ProviderCooldownStore) resolveTTL(retryAfter string) time.Duration {
	ttl := time.Duration(s.config.Default429TTLS) * time.Second
	if ttl <= 0 {
		ttl = 15 * time.Second
	}

	if retryAfter = strings.TrimSpace(retryAfter); retryAfter != "" {
		if secs, err := strconv.Atoi(retryAfter); err == nil && secs > 0 {
			ttl = time.Duration(secs) * time.Second
		} else if ts, err := httpDateToTime(retryAfter); err == nil {
			if remaining := time.Until(ts); remaining > 0 {
				ttl = remaining
			}
		}
	}

	maxTTL := time.Duration(s.config.Max429TTLS) * time.Second
	if maxTTL > 0 && ttl > maxTTL {
		return maxTTL
	}
	return ttl
}

func httpDateToTime(v string) (time.Time, error) {
	return http.ParseTime(v)
}
