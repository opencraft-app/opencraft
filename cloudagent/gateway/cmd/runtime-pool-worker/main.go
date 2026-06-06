package main

import (
	"context"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"syscall"

	"cloudagent/gateway/internal/runtimepool"
	"cloudagent/gateway/internal/wrapper"
	tempclient "go.temporal.io/sdk/client"
)

func main() {
	dataDir := os.Getenv("GATEWAY_DATA_DIR")
	if dataDir == "" {
		dataDir = filepath.Join(os.TempDir(), "gateway-data")
	}
	store, err := wrapper.NewStore(dataDir)
	if err != nil {
		log.Fatalf("init store: %v", err)
	}
	poolStore, err := wrapper.OpenWarmRuntimePoolStoreFromEnv(context.Background())
	if err != nil {
		log.Fatalf("init warm runtime pool store: %v", err)
	}
	if poolStore == nil {
		poolStore = store
	}
	worker, err := wrapper.NewAgentSidecarWorkerFromEnvWithServices(store, poolStore)
	if err != nil {
		log.Fatalf("init agent sidecar worker: %v", err)
	}
	cfg := runtimepool.ConfigFromEnv()
	input := runtimepool.ReconcileInput{
		DesiredReady:        envInt("GATEWAY_RUNTIME_WARM_POOL_DESIRED_READY", 1),
		RecheckDelaySeconds: envInt("GATEWAY_RUNTIME_WARM_POOL_RECHECK_SECONDS", 15),
		CreateRequest: wrapper.WarmRuntimeCreateRequest{
			OwnerID:          "temporal-runtime-pool-worker",
			SandboxBackend:   os.Getenv("GATEWAY_RUNTIME_WARM_POOL_SANDBOX_BACKEND"),
			OuterRuntime:     os.Getenv("GATEWAY_AGENT_OUTER_RUNTIME"),
			AgentVersion:     os.Getenv("GATEWAY_RUNTIME_WARM_POOL_AGENT_VERSION"),
			WorkspaceVersion: os.Getenv("GATEWAY_RUNTIME_WARM_POOL_WORKSPACE_VERSION"),
		},
	}
	poolKey, err := worker.WarmRuntimePoolKey(input.CreateRequest)
	if err != nil {
		log.Fatalf("resolve warm runtime pool key: %v", err)
	}
	input.PoolKey = poolKey
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	temporalClient, err := runtimepool.Dial(ctx, cfg)
	if err != nil {
		log.Fatalf("dial temporal: %v", err)
	}
	defer temporalClient.Close()
	workflowID := envDefault("GATEWAY_RUNTIME_WARM_POOL_WORKFLOW_ID", "cloudagent-runtime-pool-"+poolKey)
	_, err = temporalClient.ExecuteWorkflow(ctx, tempclient.StartWorkflowOptions{
		ID:        workflowID,
		TaskQueue: envDefault("TEMPORAL_TASK_QUEUE", runtimepool.DefaultTaskQueue),
	}, runtimepool.WarmRuntimePoolWorkflow, input)
	if err != nil {
		log.Printf("start warm runtime pool workflow: %v", err)
	}
	log.Printf("runtime pool worker starting task_queue=%s pool_key=%s desired_ready=%d", envDefault("TEMPORAL_TASK_QUEUE", runtimepool.DefaultTaskQueue), poolKey, input.DesiredReady)
	if err := runtimepool.Run(ctx, cfg, &runtimepool.Activities{Store: poolStore, Worker: worker}); err != nil {
		log.Fatalf("run runtime pool worker: %v", err)
	}
}

func envDefault(key string, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

func envInt(key string, fallback int) int {
	value := os.Getenv(key)
	if value == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(value)
	if err != nil || parsed <= 0 {
		return fallback
	}
	return parsed
}
