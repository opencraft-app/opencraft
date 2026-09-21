package main

import (
	"context"
	"errors"
	"log"
	"os/signal"
	"syscall"

	"git.woa.com/wisp/mono/credit/internal/config"
	"git.woa.com/wisp/mono/credit/internal/llmgateway"
	"git.woa.com/wisp/mono/credit/internal/store"
	"git.woa.com/wisp/mono/credit/internal/tradeclient"
	"git.woa.com/wisp/mono/credit/internal/usage"
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

	worker := usage.NewWorker(
		st,
		llmgateway.NewClient(cfg.LLMGatewayBaseURL, cfg.LLMGatewayInternalToken),
		tradeclient.NewClient(cfg.TradeBaseURL, cfg.InternalServiceToken),
		usage.WorkerOptions{
			CreditTokenRatio: cfg.CreditTokenRatio,
			PollInterval:     cfg.UsageWorkerPollInterval,
			LeaseDuration:    cfg.UsageWorkerLeaseDuration,
			BatchSize:        cfg.UsageWorkerBatchSize,
		},
	)
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	log.Printf("credit usage worker started")
	if err := worker.Run(ctx); err != nil && !errors.Is(err, context.Canceled) {
		log.Fatalf("credit usage worker: %v", err)
	}
}
