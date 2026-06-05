package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
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
	metricsAddr := getenv("SERVICE_GATEWAY_METRICS_ADDR", ":9090")
	configFile := getenv("SERVICE_GATEWAY_CONFIG_FILE", "/etc/service-gateway/config.yaml")
	adminUsername := getenv("SERVICE_GATEWAY_ADMIN_BASIC_AUTH_USER", "")
	adminPassword := getenv("SERVICE_GATEWAY_ADMIN_BASIC_AUTH_PASSWORD", "")
	adminRealm := getenv("SERVICE_GATEWAY_ADMIN_BASIC_AUTH_REALM", "Lightclaw Admin")
	adminBridgeCookieSecret := getenv("SERVICE_GATEWAY_ADMIN_BRIDGE_COOKIE_SECRET", "")
	adminBridgeCookieHosts := splitCSV(getenv("SERVICE_GATEWAY_ADMIN_BRIDGE_COOKIE_HOSTS", "admin.lightclaw.tech"))
	realnameWallEnabled := getenvBool("SERVICE_GATEWAY_REALNAME_WALL_ENABLED", true)

	cfg, err := gateway.LoadConfigFile(configFile)
	if err != nil {
		log.Fatalf("load gateway config: %v", err)
	}

	reg := prometheus.NewRegistry()
	gatewayMetrics := metrics.NewGatewayMetrics(reg)
	opts := []gateway.Option{
		gateway.WithAccessLogger(accesslog.NewStdoutLogger(os.Stdout)),
		gateway.WithMetrics(gatewayMetrics),
		gateway.WithAdminBasicAuth(adminUsername, adminPassword),
		gateway.WithAdminBasicAuthRealm(adminRealm),
		gateway.WithRealnameWallEnabled(realnameWallEnabled),
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

	server := newHTTPServer(addr, buildPublicMux(handlerWithMetrics))
	metricsServer := newHTTPServer(metricsAddr, buildMetricsMux(gatewayMetrics.Handler()))

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	go func() {
		log.Printf("service-gateway metrics listening on %s", metricsAddr)
		if err := metricsServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("listen metrics: %v", err)
		}
	}()

	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()

		if err := server.Shutdown(shutdownCtx); err != nil {
			log.Printf("shutdown http server: %v", err)
		}
		if err := metricsServer.Shutdown(shutdownCtx); err != nil {
			log.Printf("shutdown metrics server: %v", err)
		}
	}()

	log.Printf(
		"service-gateway listening on %s using %s (routes=%d allowed_origins=%d realname_wall_enabled=%t)",
		addr,
		configFile,
		len(cfg.Routes),
		len(cfg.AllowedOrigins),
		realnameWallEnabled,
	)
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatalf("listen: %v", err)
	}
}

func buildPublicMux(handler http.Handler) *http.ServeMux {
	mux := http.NewServeMux()
	mux.Handle("/", handler)
	return mux
}

func buildMetricsMux(handler http.Handler) *http.ServeMux {
	mux := http.NewServeMux()
	mux.Handle("/metrics", handler)
	return mux
}

func newHTTPServer(addr string, handler http.Handler) *http.Server {
	return &http.Server{
		Addr:              addr,
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       60 * time.Second,
	}
}

func getenv(key string, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

func getenvBool(key string, fallback bool) bool {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}
	parsed, err := strconv.ParseBool(value)
	if err != nil {
		log.Printf("invalid boolean env %s=%q; using fallback %t", key, value, fallback)
		return fallback
	}
	return parsed
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
