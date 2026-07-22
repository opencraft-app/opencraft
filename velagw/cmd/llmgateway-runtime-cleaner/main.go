package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"os/signal"
	"syscall"

	"git.woa.com/wisp/mono2/llmgateway/internal/app"
	"git.woa.com/wisp/mono2/llmgateway/internal/runtimecleanup"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()
	if err := run(ctx); err != nil {
		log.Printf("llmgateway runtime cleanup failed: %v", err)
		os.Exit(1)
	}
}

func run(ctx context.Context) error {
	_, shutdown, err := app.SetupProcessTelemetry(ctx, "llmgateway-runtime-cleaner", os.Stdout)
	if err != nil {
		return fmt.Errorf("setup telemetry: %w", err)
	}
	defer func() {
		if shutdownErr := shutdown(context.Background()); shutdownErr != nil {
			log.Printf("shutdown llmgateway telemetry: %v", shutdownErr)
		}
	}()
	cfg, err := runtimecleanup.LoadConfigFromEnv(os.Getenv)
	if err != nil {
		return fmt.Errorf("load runtime cleanup config: %w", err)
	}
	if err := runtimecleanup.Run(ctx, cfg); err != nil {
		return fmt.Errorf("clean set runtime: %w", err)
	}
	log.Printf("llmgateway runtime cleanup completed set=%s cleanup=%s attempt=%d", cfg.Target.SetID, cfg.Target.CleanupID, cfg.Target.Attempt)
	return nil
}
