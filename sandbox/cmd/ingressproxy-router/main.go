package main

import (
	"context"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"cvm-mock-e2b/internal/ingressproxy"
	"cvm-mock-e2b/internal/logging"
	"cvm-mock-e2b/internal/observability"
	"cvm-mock-e2b/internal/serverstate"
	"github.com/prometheus/client_golang/prometheus"
)

const (
	drainingWait     = 15 * time.Second
	shutdownTimeout  = 30 * time.Minute
	forceCloseWindow = 15 * time.Second
)

func main() {
	cleanup, err := logging.Init("ingressproxy-router")
	if err != nil {
		log.Fatalf("init logging: %v", err)
	}
	defer cleanup()

	addr := getenv("PROXY_ADDR", ":8084")
	metricsAddr := getenv("PROXY_METRICS_ADDR", ":9094")
	shardCount := getenvInt("INGRESSPROXY_SHARD_COUNT", 4)
	enableIPBackdoor := getenvBool("PROXY_ENABLE_IP_BACKDOOR", false)
	serviceTemplate := getenv("INGRESSPROXY_SHARD_SERVICE_TEMPLATE", "http://ingressproxy-g%d.sandbox.svc.cluster.local")
	proxyMetrics := observability.NewIngressProxyMetrics(prometheus.NewRegistry())
	layerMetrics := proxyMetrics.Layer("router")
	pool := ingressproxy.NewProxyPool(ingressproxy.ProxyPoolOptions{Observer: layerMetrics})
	drain := serverstate.NewDrainState()

	handler, err := ingressproxy.NewRouterHandler(ingressproxy.RouterConfig{
		ShardCount:       shardCount,
		EnableIPBackdoor: enableIPBackdoor,
		Proxies:          pool,
		Observer:         layerMetrics,
		ShardServiceURLFn: func(shard int) (*url.URL, error) {
			return url.Parse(fmt.Sprintf(serviceTemplate, shard))
		},
	})
	if err != nil {
		log.Fatalf("init ingressproxy router: %v", err)
	}
	mux := http.NewServeMux()
	mux.Handle("/health", ingressproxy.HealthHandler())
	mux.Handle("/ready", ingressproxy.ReadyHandler(drain))
	mux.Handle("/drain", ingressproxy.DrainHandler(drain))
	mux.Handle("/", layerMetrics.Wrap(handler))

	srv := &http.Server{
		Addr:              addr,
		Handler:           mux,
		ReadHeaderTimeout: 15 * time.Second,
	}
	metricsSrv := startMetricsServer("ingressproxy-router", metricsAddr, proxyMetrics.Handler())
	baseListener, err := net.Listen("tcp", addr)
	if err != nil {
		log.Fatalf("ingressproxy router listen error: %v", err)
	}
	trackedListener := ingressproxy.NewTrackedListener(baseListener, layerMetrics)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()

	errCh := make(chan error, 2)
	go func() {
		log.Printf("ingressproxy router listening on %s with %d shards", addr, shardCount)
		if err := srv.Serve(trackedListener); err != nil && err != http.ErrServerClosed {
			errCh <- fmt.Errorf("router serve: %w", err)
		}
	}()

	select {
	case err := <-errCh:
		log.Fatalf("ingressproxy router error: %v", err)
	case <-ctx.Done():
	}

	if drain.BeginDraining() {
		log.Printf("ingressproxy router draining for %s", drainingWait)
		time.Sleep(drainingWait)
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil && err != http.ErrServerClosed {
		log.Printf("ingressproxy router shutdown error: %v", err)
	}
	if !trackedListener.WaitForZero(shutdownCtx) {
		log.Printf("ingressproxy router downstream connections still active after graceful shutdown current=%d", trackedListener.Current())
		forceCtx, forceCancel := context.WithTimeout(context.Background(), forceCloseWindow)
		defer forceCancel()
		if err := trackedListener.CloseActive(); err != nil {
			log.Printf("ingressproxy router force close downstream error: %v", err)
		}
		if !trackedListener.WaitForZero(forceCtx) {
			log.Printf("ingressproxy router downstream connections still active after force close current=%d", trackedListener.Current())
		}
	}
	if metricsSrv != nil {
		metricsCtx, metricsCancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer metricsCancel()
		if err := metricsSrv.Shutdown(metricsCtx); err != nil && err != http.ErrServerClosed {
			log.Printf("ingressproxy router metrics shutdown error: %v", err)
		}
	}
}

func startMetricsServer(service, addr string, handler http.Handler) *http.Server {
	if strings.TrimSpace(addr) == "" {
		log.Printf("%s metrics listener disabled", service)
		return nil
	}

	srv := &http.Server{
		Addr:              addr,
		Handler:           http.NewServeMux(),
		ReadHeaderTimeout: 15 * time.Second,
	}
	mux := srv.Handler.(*http.ServeMux)
	mux.Handle("/metrics", handler)

	go func() {
		log.Printf("%s metrics listening on %s", service, addr)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("%s metrics error: %v", service, err)
		}
	}()

	return srv
}

func getenv(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func getenvInt(k string, def int) int {
	v := strings.TrimSpace(os.Getenv(k))
	if v == "" {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return def
	}
	return n
}

func getenvBool(k string, def bool) bool {
	v := strings.TrimSpace(os.Getenv(k))
	if v == "" {
		return def
	}
	b, err := strconv.ParseBool(v)
	if err != nil {
		return def
	}
	return b
}
