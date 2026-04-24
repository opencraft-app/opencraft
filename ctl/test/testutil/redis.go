package testutil

import (
	"context"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/testcontainers/testcontainers-go"
	"github.com/testcontainers/testcontainers-go/wait"

	"ctl/pkg/resource"
)

// RedisContainer wraps a testcontainers Redis instance.
type RedisContainer struct {
	Container testcontainers.Container
	Addr      string
}

// StartRedisContainer starts a fresh Redis container.
func StartRedisContainer(t *testing.T) *RedisContainer {
	t.Helper()

	ctx := context.Background()
	req := testcontainers.ContainerRequest{
		Image:        "redis:7",
		ExposedPorts: []string{"6379/tcp"},
		WaitingFor:   wait.ForListeningPort("6379/tcp").WithStartupTimeout(60 * time.Second),
	}

	container, err := testcontainers.GenericContainer(ctx, testcontainers.GenericContainerRequest{
		ContainerRequest: req,
		Started:          true,
	})
	if err != nil {
		t.Fatalf("start redis container: %v", err)
	}

	host, err := container.Host(ctx)
	if err != nil {
		_ = container.Terminate(ctx)
		t.Fatalf("resolve redis host: %v", err)
	}

	port, err := container.MappedPort(ctx, "6379/tcp")
	if err != nil {
		_ = container.Terminate(ctx)
		t.Fatalf("resolve redis port: %v", err)
	}

	addr := fmt.Sprintf("%s:%s", host, port.Port())
	waitForRedis(t, addr)

	return &RedisContainer{
		Container: container,
		Addr:      addr,
	}
}

// Close terminates the Redis container.
func (c *RedisContainer) Close(t *testing.T) {
	t.Helper()
	if c == nil || c.Container == nil {
		return
	}
	if err := c.Container.Terminate(context.Background()); err != nil {
		t.Fatalf("terminate redis container: %v", err)
	}
}

func waitForRedis(t *testing.T, addr string) {
	t.Helper()

	deadline := time.Now().Add(60 * time.Second)
	for time.Now().Before(deadline) {
		client := redis.NewClient(&redis.Options{Addr: addr})
		err := client.Ping(context.Background()).Err()
		_ = client.Close()
		if err == nil {
			return
		}
		time.Sleep(1 * time.Second)
	}

	t.Fatalf("redis not ready before timeout")
}

var (
	sharedRedisMu        sync.Mutex
	sharedRedisContainer *RedisContainer
)

func acquireSharedRedisContainer(t *testing.T) *RedisContainer {
	t.Helper()

	sharedRedisMu.Lock()
	defer sharedRedisMu.Unlock()

	if sharedRedisContainer == nil {
		sharedRedisContainer = StartRedisContainer(t)
	}
	return sharedRedisContainer
}

// NewRedisClient returns a go-redis Client connected to a shared testcontainers Redis.
// It also injects the client into resource.RedisMainClient and resource.RedisMQClient.
func NewRedisClient(t *testing.T) *redis.Client {
	t.Helper()

	container := acquireSharedRedisContainer(t)
	client := redis.NewClient(&redis.Options{Addr: container.Addr})
	t.Cleanup(func() {
		_ = client.Close()
	})

	resource.RedisMainClient = client
	resource.RedisMQClient = client
	return client
}
