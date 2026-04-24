package main

import (
	"context"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"cvm-mock-e2b/internal/ingressproxy"
	"cvm-mock-e2b/internal/logging"
	"cvm-mock-e2b/internal/observability"
	"cvm-mock-e2b/internal/route"
	"cvm-mock-e2b/internal/serverstate"
	"github.com/prometheus/client_golang/prometheus"
)

const (
	drainingWait     = 15 * time.Second
	shutdownTimeout  = 30 * time.Minute
	forceCloseWindow = 15 * time.Second
)

type routeAdapter struct {
	store route.Store
}

func (r routeAdapter) Get(ctx context.Context, sandboxID string) (ingressproxy.Rule, error) {
	rule, err := r.store.Get(ctx, sandboxID)
	if err != nil {
		return ingressproxy.Rule{}, err
	}
	return ingressproxy.Rule{
		InstanceID: rule.InstanceID,
		Address:    rule.Address,
	}, nil
}

func main() {
	cleanup, err := logging.Init("ingressproxy-shard")
	if err != nil {
		log.Fatalf("init logging: %v", err)
	}
	defer cleanup()

	addr := getenv("PROXY_ADDR", ":8085")
	metricsAddr := getenv("PROXY_METRICS_ADDR", ":9095")
	enableIPBackdoor := getenvBool("PROXY_ENABLE_IP_BACKDOOR", true)
	maxConnectionsPerTarget := getenvInt("INGRESSPROXY_MAX_CONNECTIONS_PER_TARGET", 128)
	routes := mustRouteStore()
	proxyMetrics := observability.NewIngressProxyMetrics(prometheus.NewRegistry())
	layerMetrics := proxyMetrics.Layer("shard")
	pool := ingressproxy.NewProxyPool(ingressproxy.ProxyPoolOptions{Observer: layerMetrics})
	drain := serverstate.NewDrainState()

	handler, err := ingressproxy.NewShardHandler(ingressproxy.ShardConfig{
		Routes:               routeAdapter{store: routes},
		EnableIPBackdoor:     enableIPBackdoor,
		Proxies:              pool,
		ConnectionLimiter:    ingressproxy.NewConnectionLimiter(),
		MaxConnectionsPerKey: maxConnectionsPerTarget,
		Observer:             layerMetrics,
	})
	if err != nil {
		log.Fatalf("init ingressproxy shard: %v", err)
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
	metricsSrv := startMetricsServer("ingressproxy-shard", metricsAddr, proxyMetrics.Handler())
	baseListener, err := net.Listen("tcp", addr)
	if err != nil {
		log.Fatalf("ingressproxy shard listen error: %v", err)
	}
	trackedListener := ingressproxy.NewTrackedListener(baseListener, layerMetrics)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()

	errCh := make(chan error, 2)
	go func() {
		log.Printf("ingressproxy shard listening on %s", addr)
		if err := srv.Serve(trackedListener); err != nil && err != http.ErrServerClosed {
			errCh <- err
		}
	}()

	select {
	case err := <-errCh:
		log.Fatalf("ingressproxy shard error: %v", err)
	case <-ctx.Done():
	}

	if drain.BeginDraining() {
		log.Printf("ingressproxy shard draining for %s", drainingWait)
		time.Sleep(drainingWait)
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil && err != http.ErrServerClosed {
		log.Printf("ingressproxy shard shutdown error: %v", err)
	}
	if !trackedListener.WaitForZero(shutdownCtx) {
		log.Printf("ingressproxy shard downstream connections still active after graceful shutdown current=%d", trackedListener.Current())
		forceCtx, forceCancel := context.WithTimeout(context.Background(), forceCloseWindow)
		defer forceCancel()
		if err := trackedListener.CloseActive(); err != nil {
			log.Printf("ingressproxy shard force close downstream error: %v", err)
		}
		if !trackedListener.WaitForZero(forceCtx) {
			log.Printf("ingressproxy shard downstream connections still active after force close current=%d", trackedListener.Current())
		}
	}
	if metricsSrv != nil {
		metricsCtx, metricsCancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer metricsCancel()
		if err := metricsSrv.Shutdown(metricsCtx); err != nil && err != http.ErrServerClosed {
			log.Printf("ingressproxy shard metrics shutdown error: %v", err)
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

func mustRouteStore() route.Store {
	addr := getenv("REDIS_ADDR", "127.0.0.1:6379")
	password := getenv("REDIS_PASSWORD", "")
	db := getenv("REDIS_DB", "0")
	prefix := getenv("REDIS_ROUTE_PREFIX", "route:sandbox:")

	dbNum, err := strconv.Atoi(db)
	if err != nil {
		log.Fatalf("invalid REDIS_DB: %v", err)
	}
	st, err := route.NewRedisStore(addr, password, dbNum, prefix)
	if err != nil {
		log.Fatalf("init redis route store: %v", err)
	}
	return st
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
