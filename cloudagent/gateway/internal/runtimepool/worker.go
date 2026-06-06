package runtimepool

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"

	"cloudagent/gateway/internal/wrapper"
	"go.temporal.io/sdk/client"
	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/worker"
	"go.temporal.io/sdk/workflow"
)

const (
	DefaultTaskQueue = "cloudagent-runtime-pool"
)

type TemporalConfig struct {
	Address       string
	Namespace     string
	TaskQueue     string
	TLS           bool
	TLSServerName string
	AuthToken     string
}

type ReconcileInput struct {
	PoolKey             string
	DesiredReady        int
	RecheckDelaySeconds int
	MaxIterations       int
	CreateRequest       wrapper.WarmRuntimeCreateRequest
}

type ReconcileStatus struct {
	PoolKey       string
	ReadyCount    int
	CreatingCount int
	CreatedCount  int
	FailedCount   int
}

type Activities struct {
	Store  wrapper.WarmRuntimePoolStore
	Worker *wrapper.AgentSidecarWorker
}

func ConfigFromEnv() TemporalConfig {
	return TemporalConfig{
		Address:       strings.TrimSpace(os.Getenv("TEMPORAL_ADDRESS")),
		Namespace:     firstNonEmptyEnv("TEMPORAL_NAMESPACE", "default"),
		TaskQueue:     firstNonEmptyEnv("TEMPORAL_TASK_QUEUE", DefaultTaskQueue),
		TLS:           envFlag("TEMPORAL_TLS"),
		TLSServerName: strings.TrimSpace(os.Getenv("TEMPORAL_TLS_SERVER_NAME")),
		AuthToken:     strings.TrimSpace(os.Getenv("TEMPORAL_AUTH_TOKEN")),
	}
}

func Dial(ctx context.Context, cfg TemporalConfig) (client.Client, error) {
	if cfg.Address == "" {
		return nil, errors.New("TEMPORAL_ADDRESS is required")
	}
	if cfg.Namespace == "" {
		cfg.Namespace = "default"
	}
	opts := client.Options{
		HostPort:  cfg.Address,
		Namespace: cfg.Namespace,
	}
	if cfg.TLS {
		opts.ConnectionOptions.TLS = &tls.Config{MinVersion: tls.VersionTLS12, ServerName: cfg.TLSServerName}
	}
	if cfg.AuthToken != "" {
		opts.Credentials = client.NewAPIKeyStaticCredentials(cfg.AuthToken)
	}
	return client.DialContext(ctx, opts)
}

func Register(w worker.Worker, activities *Activities) {
	w.RegisterWorkflow(WarmRuntimePoolWorkflow)
	w.RegisterActivity(activities.EnsureWarmRuntimePool)
}

func Run(ctx context.Context, cfg TemporalConfig, activities *Activities) error {
	c, err := Dial(ctx, cfg)
	if err != nil {
		return err
	}
	defer c.Close()
	taskQueue := firstNonEmpty(cfg.TaskQueue, DefaultTaskQueue)
	w := worker.New(c, taskQueue, worker.Options{})
	Register(w, activities)
	return w.Run(worker.InterruptCh())
}

func WarmRuntimePoolWorkflow(ctx workflow.Context, input ReconcileInput) (ReconcileStatus, error) {
	if input.DesiredReady <= 0 {
		input.DesiredReady = 1
	}
	if input.RecheckDelaySeconds <= 0 {
		input.RecheckDelaySeconds = 15
	}
	if input.MaxIterations <= 0 {
		input.MaxIterations = 100
	}
	activityCtx := workflow.WithActivityOptions(ctx, workflow.ActivityOptions{
		StartToCloseTimeout: 30 * time.Minute,
		RetryPolicy: &temporal.RetryPolicy{
			InitialInterval:    time.Second,
			BackoffCoefficient: 2,
			MaximumInterval:    time.Minute,
			MaximumAttempts:    3,
		},
	})
	var last ReconcileStatus
	for i := 0; i < input.MaxIterations; i++ {
		if err := workflow.ExecuteActivity(activityCtx, "EnsureWarmRuntimePool", input).Get(activityCtx, &last); err != nil {
			return last, err
		}
		if err := workflow.Sleep(ctx, time.Duration(input.RecheckDelaySeconds)*time.Second); err != nil {
			return last, err
		}
	}
	return last, workflow.NewContinueAsNewError(ctx, WarmRuntimePoolWorkflow, input)
}

func (a *Activities) EnsureWarmRuntimePool(ctx context.Context, input ReconcileInput) (ReconcileStatus, error) {
	if a == nil || a.Store == nil || a.Worker == nil {
		return ReconcileStatus{}, errors.New("runtime pool activities require store and worker")
	}
	if input.DesiredReady <= 0 {
		input.DesiredReady = 1
	}
	poolKey := strings.TrimSpace(input.PoolKey)
	if poolKey == "" {
		key, err := a.Worker.WarmRuntimePoolKey(input.CreateRequest)
		if err != nil {
			return ReconcileStatus{}, err
		}
		poolKey = key
		input.CreateRequest.PoolKey = key
	}
	ready, err := a.Store.ListWarmRuntimeItems(ctx, wrapper.WarmRuntimeListRequest{PoolKey: poolKey, State: "ready", Limit: 1000})
	if err != nil {
		return ReconcileStatus{}, err
	}
	creating, err := a.Store.ListWarmRuntimeItems(ctx, wrapper.WarmRuntimeListRequest{PoolKey: poolKey, State: "creating", Limit: 1000})
	if err != nil {
		return ReconcileStatus{}, err
	}
	status := ReconcileStatus{
		PoolKey:       poolKey,
		ReadyCount:    len(ready),
		CreatingCount: len(creating),
	}
	for {
		reserved, ok, err := a.Store.ReserveWarmRuntimeItem(ctx, wrapper.WarmRuntimeReserveRequest{
			PoolKey:      poolKey,
			OwnerID:      "runtime-pool-worker",
			DesiredReady: input.DesiredReady,
		})
		if err != nil {
			return status, err
		}
		if !ok {
			break
		}
		createReq := input.CreateRequest
		createReq.PoolKey = poolKey
		createReq.ItemID = reserved.ItemID
		if _, err := a.Worker.CreateWarmRuntimePoolItem(ctx, createReq); err != nil {
			status.FailedCount++
			return status, fmt.Errorf("create warm runtime item: %w", err)
		}
		status.CreatedCount++
		status.ReadyCount++
		if status.ReadyCount+status.CreatingCount >= input.DesiredReady {
			break
		}
	}
	return status, nil
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func firstNonEmptyEnv(key string, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return fallback
}

func envFlag(key string) bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv(key))) {
	case "1", "true", "yes", "on":
		return true
	default:
		return false
	}
}
