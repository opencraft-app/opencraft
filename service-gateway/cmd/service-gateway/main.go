package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/prometheus/client_golang/prometheus"

	"github.com/openclaw/openclaw/mono/service-gateway/internal/accesslog"
	"github.com/openclaw/openclaw/mono/service-gateway/internal/gateway"
	"github.com/openclaw/openclaw/mono/service-gateway/internal/metrics"
)

func main() {
	addr := getenv("SERVICE_GATEWAY_ADDR", ":8085")
	configFile := getenv("SERVICE_GATEWAY_CONFIG_FILE", "/etc/service-gateway/config.yaml")
	adminUsername := getenv("SERVICE_GATEWAY_ADMIN_BASIC_AUTH_USER", "")
	adminPassword := getenv("SERVICE_GATEWAY_ADMIN_BASIC_AUTH_PASSWORD", "")
	adminRealm := getenv("SERVICE_GATEWAY_ADMIN_BASIC_AUTH_REALM", "Lightclaw Admin")
	adminBridgeCookieSecret := getenv("SERVICE_GATEWAY_ADMIN_BRIDGE_COOKIE_SECRET", "")
	adminBridgeCookieHosts := splitCSV(getenv("SERVICE_GATEWAY_ADMIN_BRIDGE_COOKIE_HOSTS", "admin.lightclaw.tech"))

	cfg, err := gateway.LoadConfigFile(configFile)
	if err != nil {
		log.Fatalf("load gateway config: %v", err)
	}

	reg := prometheus.NewRegistry()
	gatewayMetrics := metrics.NewGatewayMetrics(reg)
	mux := http.NewServeMux()
	mux.Handle("/metrics", gatewayMetrics.Handler())
	opts := []gateway.Option{
		gateway.WithAccessLogger(accesslog.NewStdoutLogger(os.Stdout)),
		gateway.WithMetrics(gatewayMetrics),
		gateway.WithAdminBasicAuth(adminUsername, adminPassword),
		gateway.WithAdminBasicAuthRealm(adminRealm),
	}
	if adminBridgeCookieSecret != "" {
		opts = append(opts, gateway.WithAdminBridgeCookie(gateway.AdminBridgeCookieConfig{
			Secret: adminBridgeCookieSecret,
			Hosts:  adminBridgeCookieHosts,
			Secure: true,
		}))
	}
	handlerWithMetrics, err := gateway.NewHandler(
		cfg,
		opts...,
	)
	if err != nil {
		log.Fatalf("build gateway handler with metrics: %v", err)
	}
	mux.Handle("/", handlerWithMetrics)

	server := &http.Server{
		Addr:              addr,
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()

		if err := server.Shutdown(shutdownCtx); err != nil {
			log.Printf("shutdown http server: %v", err)
		}
	}()

	log.Printf(
		"service-gateway listening on %s using %s (routes=%d allowed_origins=%d)",
		addr,
		configFile,
		len(cfg.Routes),
		len(cfg.AllowedOrigins),
	)
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatalf("listen: %v", err)
	}
}

func getenv(key string, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

func splitCSV(raw string) []string {
	parts := strings.Split(raw, ",")
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		out = append(out, part)
	}
	return out
}
