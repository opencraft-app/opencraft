package main

import (
	"context"
	stdlog "log"
	"net/http"
	"os/signal"
	"syscall"
	"time"

	otellog "go.opentelemetry.io/otel/log"
	"shadow/internal/app"
	"shadow/internal/config"
	"shadow/internal/telemetry"
)

func main() {
	cfg := config.Load()
	server, err := app.New(cfg)
	if err != nil {
		stdlog.Fatalf("build app: %v", err)
	}
	defer func() {
		if err := server.Close(); err != nil {
			stdlog.Printf("close app: %v", err)
		}
	}()

	httpServer := &http.Server{
		Addr:              cfg.HTTPAddr,
		Handler:           server.Handler(),
		ReadHeaderTimeout: 5 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = httpServer.Shutdown(shutdownCtx)
	}()

	telemetry.Info(context.Background(), telemetry.Logger("shadow/cmd/shadowd"), "shadow service listening",
		otellog.String("http_addr", cfg.HTTPAddr),
		otellog.String("provider", cfg.Provider),
		otellog.String("platform", cfg.ShadowPlatform),
		otellog.String("account_endpoint", cfg.AccountEndpoint),
		otellog.String("cam_endpoint", cfg.CAMEndpoint),
		otellog.String("sts_endpoint", cfg.STSEndpoint),
	)
	if err := httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		stdlog.Fatalf("listen: %v", err)
	}
}
