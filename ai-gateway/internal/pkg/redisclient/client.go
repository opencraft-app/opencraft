package redisclient

import (
	"context"
	"encoding/json"
	"time"

	"github.com/redis/go-redis/v9"
)

type Client struct {
	rdb *redis.Client
}

func NewClient(addr, password string) *Client {
	rdb := redis.NewClient(&redis.Options{
		Addr:     addr,
		Password: password,
	})
	return &Client{rdb: rdb}
}

// NewClientFromRedis wraps an existing redis.Client (useful for testing with miniredis).
func NewClientFromRedis(rdb *redis.Client) *Client {
	return &Client{rdb: rdb}
}

// IncrWithTTL atomically increments a key and sets TTL if it's a new key.
// Uses a Lua script for atomicity.
func (c *Client) IncrWithTTL(ctx context.Context, key string, ttl time.Duration) (int64, error) {
	script := redis.NewScript(`
		local current = redis.call("INCR", KEYS[1])
		if current == 1 then
			redis.call("PEXPIRE", KEYS[1], ARGV[1])
		end
		return current
	`)
	result, err := script.Run(ctx, c.rdb, []string{key}, ttl.Milliseconds()).Int64()
	if err != nil {
		return 0, err
	}
	return result, nil
}

// IncrBy atomically increments a key by delta (can be negative).
func (c *Client) IncrBy(ctx context.Context, key string, delta int64) (int64, error) {
	return c.rdb.IncrBy(ctx, key, delta).Result()
}

// Get retrieves a string value from Redis.
func (c *Client) Get(ctx context.Context, key string) (string, error) {
	return c.rdb.Get(ctx, key).Result()
}

// Set stores a value with TTL.
func (c *Client) Set(ctx context.Context, key string, value interface{}, ttl time.Duration) error {
	return c.rdb.Set(ctx, key, value, ttl).Err()
}

// SetJSON marshals value to JSON then stores with TTL.
func (c *Client) SetJSON(ctx context.Context, key string, value interface{}, ttl time.Duration) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	return c.rdb.Set(ctx, key, data, ttl).Err()
}

// GetJSON retrieves JSON value and unmarshals into dest.
func (c *Client) GetJSON(ctx context.Context, key string, dest interface{}) error {
	data, err := c.rdb.Get(ctx, key).Result()
	if err != nil {
		return err
	}
	return json.Unmarshal([]byte(data), dest)
}

// Del deletes one or more keys.
func (c *Client) Del(ctx context.Context, keys ...string) error {
	return c.rdb.Del(ctx, keys...).Err()
}

// Ping checks Redis connectivity.
func (c *Client) Ping(ctx context.Context) error {
	return c.rdb.Ping(ctx).Err()
}

// Publish publishes a message to a Redis channel.
// Returns the number of subscribers that received the message.
func (c *Client) Publish(ctx context.Context, channel string, message interface{}) *redis.IntCmd {
	return c.rdb.Publish(ctx, channel, message)
}

// Subscribe subscribes to one or more Redis channels.
// The context is used to cancel the subscription.
func (c *Client) Subscribe(ctx context.Context, channels ...string) *redis.PubSub {
	return c.rdb.Subscribe(ctx, channels...)
}

// Close closes the Redis connection.
func (c *Client) Close() error {
	return c.rdb.Close()
}
