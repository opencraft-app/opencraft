package cache

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"

	"ctl/pkg/resource"
)

const (
	cacheKeyPrefix = "cache:"
)

type Cache interface {
	Set(key string, value any, expireSeconds int64) error
	Get(key string, result any) (bool, error)
}

type cache struct {
	client *redis.Client
}

func New() Cache {
	return &cache{
		client: resource.RedisMainClient,
	}
}

func (c *cache) Set(key string, value any, expireSeconds int64) error {
	fullKey := cacheKeyPrefix + key

	data, err := json.Marshal(value)
	if err != nil {
		return fmt.Errorf("json marshal error: %w", err)
	}

	ctx := context.Background()
	err = c.client.Set(ctx, fullKey, string(data), time.Duration(expireSeconds)*time.Second).Err()
	if err != nil {
		return fmt.Errorf("redis set error: %w", err)
	}

	return nil
}

func (c *cache) Get(key string, result any) (bool, error) {
	fullKey := cacheKeyPrefix + key

	ctx := context.Background()
	data, err := c.client.Get(ctx, fullKey).Result()
	if err != nil {
		if err == redis.Nil {
			return false, nil
		}
		return false, fmt.Errorf("redis get error: %w", err)
	}

	err = json.Unmarshal([]byte(data), result)
	if err != nil {
		return false, fmt.Errorf("json unmarshal error: %w", err)
	}

	return true, nil
}
