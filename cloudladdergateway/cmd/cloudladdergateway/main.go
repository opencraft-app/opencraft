package main

import (
	"context"
	"flag"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/openclaw/openclaw/mono/cloudladdergateway/gen/cloudladdergateway/v1/gatewayv1connect"
	"github.com/openclaw/openclaw/mono/cloudladdergateway/internal/audit"
	"github.com/openclaw/openclaw/mono/cloudladdergateway/internal/auth"
	"github.com/openclaw/openclaw/mono/cloudladdergateway/internal/config"
	"github.com/openclaw/openclaw/mono/cloudladdergateway/internal/proxy"
	"github.com/openclaw/openclaw/mono/cloudladdergateway/internal/server"
)

func main() {
	configPath := flag.String("config", envOrDefault("CLOUDLADDERGATEWAY_CONFIG", "config.example.yaml"), "config yaml path")
	flag.Parse()

	cfg, err := config.Load(*configPath)
	if err != nil {
		log.Fatalf("load config: %v", err)
	}
	authenticator, err := auth.New(cfg)
	if err != nil {
		log.Fatalf("build authenticator: %v", err)
	}
	auditor, shutdownAudit, err := audit.New(context.Background(), cfg.Audit, os.Stdout)
	if err != nil {
		log.Fatalf("build audit pipeline: %v", err)
	}
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := shutdownAudit(ctx); err != nil {
			log.Printf("shutdown audit pipeline: %v", err)
		}
	}()

	engine, err := proxy.NewEngine(cfg, proxy.WithAuditor(auditor))
	if err != nil {
		log.Fatalf("build proxy engine: %v", err)
	}

	uinRoutes := map[string][]config.UinRoute{}
	for _, route := range cfg.Routes {
		if len(route.UinRoutes) > 0 {
			uinRoutes[route.ID] = route.UinRoutes
			for _, rule := range route.UinRoutes {
				log.Printf("uin route: %s uin=%s -> %s", route.ID, rule.Uin, rule.RouteID)
			}
		}
	}

	mux := http.NewServeMux()
	connectPath, connectHandler := gatewayv1connect.NewCloudLadderGatewayServiceHandler(server.NewConnectService(engine, authenticator))
	mux.Handle(connectPath, connectHandler)
	mux.Handle("/", server.NewGinRouterWithUinRoutes(engine, authenticator, cfg.MaxBodyBytes, uinRoutes, cfg.External...))

	httpServer := &http.Server{
		Addr:    cfg.Addr,
		Handler: mux,
	}
	errCh := make(chan error, 1)
	go func() {
		log.Printf("cloudladdergateway listening on %s routes=%d connect_path=%s", cfg.Addr, len(cfg.Routes), connectPath)
		errCh <- httpServer.ListenAndServe()
	}()

	signalCh := make(chan os.Signal, 1)
	signal.Notify(signalCh, syscall.SIGINT, syscall.SIGTERM)
	select {
	case sig := <-signalCh:
		log.Printf("received signal %s, shutting down", sig)
		if err := httpServer.Close(); err != nil {
			log.Printf("close server: %v", err)
		}
	case err := <-errCh:
		if err != nil && err != http.ErrServerClosed {
			log.Fatalf("server failed: %v", err)
		}
	}
}

func envOrDefault(key string, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}
