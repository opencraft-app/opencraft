package main

import (
	"context"
	"errors"
	"log"
	"os/signal"
	"syscall"

	"git.woa.com/wisp/mono/credit/internal/config"
	"git.woa.com/wisp/mono/credit/internal/lifecycle"
	"git.woa.com/wisp/mono/credit/internal/llmgateway"
	"git.woa.com/wisp/mono/credit/internal/service"
	"git.woa.com/wisp/mono/credit/internal/store"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("load config: %v", err)
	}
	st, err := store.NewMySQLStore(cfg.MySQLDSN)
	if err != nil {
		log.Fatalf("init mysql store: %v", err)
	}
	defer st.Close()

	llm := llmgateway.NewClient(cfg.LLMGatewayBaseURL, cfg.LLMGatewayInternalToken)
	svc := service.New(st, llm, service.Options{})
	worker := lifecycle.NewWorker(st, svc, lifecycle.WorkerOptions{
		PollInterval:  cfg.LifecycleWorkerPollInterval,
		LeaseDuration: cfg.LifecycleWorkerLeaseDuration,
		BatchSize:     cfg.LifecycleWorkerBatchSize,
	})
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	log.Printf("credit lifecycle worker started")
	if err := worker.Run(ctx); err != nil && !errors.Is(err, context.Canceled) {
		log.Fatalf("credit lifecycle worker: %v", err)
	}
}
