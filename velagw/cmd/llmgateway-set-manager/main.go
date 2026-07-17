package main

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"git.woa.com/wisp/mono2/llmgateway/internal/app"
	"git.woa.com/wisp/mono2/llmgateway/internal/setmanager"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()
	if err := run(ctx); err != nil {
		log.Printf("llmgateway set manager failed: %v", err)
		os.Exit(1)
	}
}

func run(ctx context.Context) error {
	_, shutdown, err := app.SetupProcessTelemetry(ctx, "llmgateway-set-manager", os.Stdout)
	if err != nil {
		return fmt.Errorf("setup telemetry: %w", err)
	}
	defer func() {
		if shutdownErr := shutdown(context.Background()); shutdownErr != nil {
			log.Printf("shutdown llmgateway telemetry: %v", shutdownErr)
		}
	}()

	cfg := setmanager.LoadConfigFromEnv()
	kube, err := setmanager.NewInClusterKubeClient()
	if err != nil {
		return fmt.Errorf("create kubernetes client: %w", err)
	}
	control := setmanager.ControlClient{
		BaseURL:    cfg.ControlURL,
		AdminToken: cfg.AdminToken,
		HTTPClient: &http.Client{Timeout: 30 * time.Second},
	}
	if err := setmanager.RunOnce(ctx, cfg, control, kube); err != nil {
		return fmt.Errorf("run set manager: %w", err)
	}
	log.Printf("llmgateway set manager completed")
	return nil
}
