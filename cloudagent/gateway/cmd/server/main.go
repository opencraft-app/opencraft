package main

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"syscall"
	"time"

	redisstore "cloudagent/gateway/internal/store/redis"
	"cloudagent/gateway/internal/store/storebridge"
	"cloudagent/gateway/internal/telemetry"
	"cloudagent/gateway/internal/wrapper"
	"go.opentelemetry.io/otel/attribute"
	otellog "go.opentelemetry.io/otel/log"
)

func main() {
	shutdownTelemetry, err := telemetry.Init(telemetry.Options{
		ServiceName: envDefault("OTEL_SERVICE_NAME", "cloudagent-gateway"),
		Attributes: []attribute.KeyValue{
			attribute.String("cloudagent.component", "gateway"),
		},
	})
	if err != nil {
		log.Fatalf("init telemetry: %v", err)
	}
	defer func() {
		if err := shutdownTelemetry(); err != nil {
			log.Printf("shutdown telemetry: %v", err)
		}
	}()

	dataDir := os.Getenv("GATEWAY_DATA_DIR")
	if dataDir == "" {
		dataDir = filepath.Join(os.TempDir(), "gateway-data")
	}
	addr := os.Getenv("GATEWAY_ADDR")
	if addr == "" {
		addr = ":8080"
	}
	store, err := wrapper.NewStore(dataDir)
	if err != nil {
		log.Fatalf("init store: %v", err)
	}

	// Determine workspace service: Redis-backed or SQLite-backed.
	var workspaceService wrapper.WorkspaceService = store
	redisLockStore := initRedisIfConfigured()
	if redisLockStore != nil {
		// Redis configured: use Redis for lease operations, but delegate
		// EnsureWorkspace (persistence) to the SQLite/MySQL store.
		workspaceService = storebridge.NewRedisWorkspaceService(redisLockStore, store)
	}

	var worker wrapper.Worker
	switch os.Getenv("GATEWAY_WORKER_MODE") {
	case "fake":
		worker = wrapper.FakeWorker{}
	case "agent_injected":
		agentSidecarWorker, err := wrapper.NewAgentSidecarWorkerFromEnvWithWorkspaceService(workspaceService)
		if err != nil {
			log.Fatalf("init agent sidecar worker: %v", err)
		}
		go func() {
			if err := agentSidecarWorker.CleanupStaleRuntimeResources(context.Background(), 100); err != nil {
				log.Printf("cleanup stale runtime resources: %v", err)
			}
		}()
		worker = agentSidecarWorker
	default:
		log.Fatalf("GATEWAY_WORKER_MODE must be set to fake or agent_injected")
	}
	server := wrapper.NewServer(store, worker)

	// If Redis is available, override lock/lease implementations on the ACP gateway.
	if redisLockStore != nil {
		server.SetExternalLockStores(wrapper.ExternalLockStores{
			RuntimeOwnership: storebridge.NewRedisRuntimeOwnership(redisLockStore),
			RuntimeLock:      storebridge.NewRedisRuntimeEnsureLocker(redisLockStore),
			WorkspaceService: workspaceService,
		})
		log.Printf("store: using Redis (%s) for distributed locks and leases", redisLockStore)
	} else {
		log.Printf("store: using SQLite for all storage (GATEWAY_REDIS_ADDR not configured)")
	}

	telemetry.Info(context.Background(), telemetry.Logger("cloudagent/gateway/cmd/server"), "gateway.listening",
		otellog.String("addr", addr),
		otellog.String("data_dir", dataDir),
		otellog.String("worker_mode", os.Getenv("GATEWAY_WORKER_MODE")),
		otellog.String("redis_addr", os.Getenv("GATEWAY_REDIS_ADDR")),
	)
	httpServer := &http.Server{
		Addr:    addr,
		Handler: server.Handler(),
	}
	errCh := make(chan error, 1)
	go func() {
		errCh <- httpServer.ListenAndServe()
	}()

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	defer signal.Stop(sigCh)

	select {
	case sig := <-sigCh:
		server.StartDraining()
		telemetry.Info(context.Background(), telemetry.Logger("cloudagent/gateway/cmd/server"), "gateway.draining",
			otellog.String("signal", sig.String()),
			otellog.String("addr", addr),
		)
		if delay := drainDelay(); delay > 0 {
			time.Sleep(delay)
		}
		ctx, cancel := context.WithTimeout(context.Background(), shutdownTimeout())
		defer cancel()
		if err := httpServer.Shutdown(ctx); err != nil {
			log.Printf("graceful shutdown failed: %v", err)
			if closeErr := httpServer.Close(); closeErr != nil {
				log.Printf("forced shutdown failed: %v", closeErr)
			}
		}
		if err := <-errCh; err != nil && err != http.ErrServerClosed {
			log.Fatal(err)
		}
	case err := <-errCh:
		if err != nil && err != http.ErrServerClosed {
			log.Fatal(err)
		}
	}
}

// initRedisIfConfigured creates a Redis lock store if GATEWAY_REDIS_ADDR is set.
// Returns nil if Redis is not configured (graceful fallback to SQLite).
func initRedisIfConfigured() *redisstore.LockStore {
	redisAddr := os.Getenv("GATEWAY_REDIS_ADDR")
	if redisAddr == "" {
		return nil
	}
	redisDB, _ := strconv.Atoi(os.Getenv("GATEWAY_REDIS_DB"))
	poolSize, _ := strconv.Atoi(envDefault("GATEWAY_REDIS_POOL_SIZE", "20"))

	store, err := redisstore.New(redisstore.Config{
		Addr:      redisAddr,
		Password:  os.Getenv("GATEWAY_REDIS_PASSWORD"),
		DB:        redisDB,
		PoolSize:  poolSize,
		KeyPrefix: envDefault("GATEWAY_REDIS_KEY_PREFIX", "gw:"),
	})
	if err != nil {
		log.Fatalf("init redis lock store: %v", err)
	}

	// Verify connectivity
	ctx := context.Background()
	if err := store.Ping(ctx); err != nil {
		log.Fatalf("redis ping failed: %v (addr=%s)", err, redisAddr)
	}
	fmt.Fprintf(os.Stderr, "redis: connected to %s\n", redisAddr)
	return store
}

func envDefault(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

func shutdownTimeout() time.Duration {
	value := os.Getenv("GATEWAY_SHUTDOWN_TIMEOUT_SECONDS")
	if value == "" {
		return 30 * time.Second
	}
	seconds, err := strconv.Atoi(value)
	if err != nil || seconds <= 0 {
		return 30 * time.Second
	}
	return time.Duration(seconds) * time.Second
}

func drainDelay() time.Duration {
	value := os.Getenv("GATEWAY_DRAIN_DELAY_SECONDS")
	if value == "" {
		return 5 * time.Second
	}
	seconds, err := strconv.Atoi(value)
	if err != nil || seconds < 0 {
		return 5 * time.Second
	}
	return time.Duration(seconds) * time.Second
}
