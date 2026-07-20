package app

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"git.woa.com/wisp/mono2/llmgateway/internal/gateway"
	"git.woa.com/wisp/mono2/llmgateway/internal/httpapi"
	"git.woa.com/wisp/mono2/llmgateway/internal/lifecycle"
	"git.woa.com/wisp/mono2/llmgateway/internal/observability"
	appruntime "git.woa.com/wisp/mono2/llmgateway/internal/runtime"
)

type Mode string

const (
	ModeAll     Mode = "all"
	ModeControl Mode = "control"
	ModeTraffic Mode = "traffic"
	ModeWorker  Mode = "worker"
)

func HandlerForMode(mode Mode, svc *gateway.Service, config httpapi.Config) http.Handler {
	if mode == ModeTraffic {
		return httpapi.NewTrafficServer(svc, config)
	}
	if mode == ModeControl {
		return httpapi.NewControlServer(svc, config)
	}
	return httpapi.NewServer(svc, config)
}

func Run(ctx context.Context, mode Mode) error {
	if ctx == nil {
		ctx = context.Background()
	}
	if mode == "" {
		mode = ModeAll
	}
	telemetrySanitizer, traceShutdown, err := SetupProcessTelemetry(ctx, telemetryServiceName(mode), os.Stdout)
	if err != nil {
		return err
	}

	port := getenv("PORT", defaultPort(mode))
	adminUsername := getenv("CLUSTER_ADMIN_USERNAME", "cluster-admin")
	adminPassword := getenv("CLUSTER_ADMIN_PASSWORD", "Qq373866172!")
	adminToken := os.Getenv("CLUSTER_ADMIN_TOKEN")
	internalToken := getenv("INTERNAL_SERVICE_TOKEN", adminToken)
	consoleDist := os.Getenv("LLMGATEWAY_CONSOLE_DIST")
	newAPIClientTimeout := envDuration("LLMGATEWAY_NEWAPI_CLIENT_TIMEOUT", 15*time.Second)
	trafficProbeTimeout := envDuration("LLMGATEWAY_TRAFFIC_PROBE_TIMEOUT", 2*time.Minute)
	trafficProbeBaseURL := strings.TrimRight(getenv("LLMGATEWAY_TRAFFIC_BASE_URL", defaultTrafficProbeBaseURL(mode, port)), "/")
	rootUsername := getenv("NEWAPI_SET_ROOT_USERNAME", "set-root")
	rootPassword := getenv("NEWAPI_SET_ROOT_PASSWORD", "Qq373866172!")
	drainWait := envDuration("LLMGATEWAY_DRAIN_WAIT", 10*time.Second)
	shutdownTimeout := envDuration("LLMGATEWAY_SHUTDOWN_TIMEOUT", 2*time.Minute)

	var store gateway.Store
	if mode == ModeTraffic {
		store = gateway.NewMemoryStore()
		log.Printf("llmgateway traffic using Redis route cache only; MySQL store disabled")
	} else {
		store, err = openStore(ctx)
		if err != nil {
			return err
		}
	}
	keyRouteCache, err := openKeyRouteCache(ctx, mode)
	if err != nil {
		_ = closeStore(store)
		return err
	}
	state := lifecycle.NewState()
	transport := newHTTPTransportFromEnv()
	trafficTransportManager, setRuntimeRouteRequired := trafficRuntimeRoutingFromEnv(mode)
	service := gateway.NewService(store, transport, gateway.Options{
		RootUsername:            rootUsername,
		RootPassword:            rootPassword,
		KeyRouteCache:           keyRouteCache,
		TrafficRouteCacheOnly:   mode == ModeTraffic,
		SetRuntimeRouteRequired: setRuntimeRouteRequired,
		TrafficTransportManager: trafficTransportManager,
		NewAPIClientTimeout:     newAPIClientTimeout,
		TelemetrySanitizer:      telemetrySanitizer,
		TelemetryCorrelator:     telemetryCorrelatorFromEnv(),
	})
	handler := HandlerForMode(mode, service, httpapi.Config{
		AdminUsername:                  adminUsername,
		AdminPassword:                  adminPassword,
		AdminToken:                     adminToken,
		InternalToken:                  internalToken,
		ConsoleDist:                    consoleDist,
		TrafficBaseURL:                 trafficProbeBaseURL,
		TrafficProbeClient:             &http.Client{Transport: transport},
		TrafficProbeTimeout:            trafficProbeTimeout,
		LegacySubscriptionClientCompat: envBool("LEGACY_SUBSCRIPTION_CLIENT_COMPAT"),
		Lifecycle:                      state,
		E2EHooks:                       envBool("LLMGATEWAY_E2E_HOOKS"),
	})

	addr := ":" + port
	listener, err := net.Listen("tcp", addr)
	if err != nil {
		service.CloseIdleConnections()
		_ = closeStore(store)
		return fmt.Errorf("listen %s: %w", addr, err)
	}
	server := &http.Server{
		Addr:              addr,
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       2 * time.Minute,
	}
	log.Printf("llmgateway %s listening on %s", mode, addr)
	return appruntime.Serve(ctx, server, listener, state, appruntime.Options{
		DrainWait:       drainWait,
		ShutdownTimeout: shutdownTimeout,
		Close: func() error {
			service.CloseIdleConnections()
			storeErr := closeStore(store)
			traceErr := traceShutdown(context.Background())
			if storeErr != nil {
				return storeErr
			}
			return traceErr
		},
	})
}

func trafficRuntimeRoutingFromEnv(mode Mode) (*gateway.TransportManager, bool) {
	if mode != ModeTraffic && mode != ModeAll {
		return nil, false
	}
	drainTimeout := envDuration("LLMGATEWAY_TRAFFIC_TRANSPORT_DRAIN_TIMEOUT", 330*time.Second)
	manager := gateway.NewTransportManager(func() http.RoundTripper {
		return newHTTPTransportFromEnv()
	}, drainTimeout)
	return manager, envBoolDefault("LLMGATEWAY_SET_RUNTIME_ROUTE_REQUIRED", false)
}

func defaultTrafficProbeBaseURL(mode Mode, port string) string {
	if mode == ModeAll {
		return "http://127.0.0.1:" + port
	}
	return "http://llmgateway-traffic"
}

func RunWorker(ctx context.Context) error {
	if ctx == nil {
		ctx = context.Background()
	}
	pool := strings.ToLower(strings.TrimSpace(getenv("LLMGATEWAY_WORKER_POOL", "core")))
	telemetrySanitizer, traceShutdown, err := SetupProcessTelemetry(ctx, "llmgateway-worker-"+pool, os.Stdout)
	if err != nil {
		return err
	}
	defer func() {
		if err := traceShutdown(context.Background()); err != nil {
			log.Printf("shutdown llmgateway tracing: %v", err)
		}
	}()
	store, err := openStore(ctx)
	if err != nil {
		return err
	}
	defer func() {
		if err := closeStore(store); err != nil {
			log.Printf("close llmgateway worker store: %v", err)
		}
	}()

	rootUsername := getenv("NEWAPI_SET_ROOT_USERNAME", "set-root")
	rootPassword := getenv("NEWAPI_SET_ROOT_PASSWORD", "Qq373866172!")
	newAPIClientTimeout := envDuration("LLMGATEWAY_NEWAPI_CLIENT_TIMEOUT", 15*time.Second)
	pollInterval := envDuration("LLMGATEWAY_WORKER_POLL_INTERVAL", 5*time.Second)
	leaseTTL := envDuration("LLMGATEWAY_WORKER_LEASE_TTL", time.Minute)
	if pollInterval <= 0 {
		pollInterval = 5 * time.Second
	}
	if leaseTTL < 15*time.Second {
		leaseTTL = 15 * time.Second
	}
	driftItemTimeout := envDuration("LLMGATEWAY_WORKER_CHANNEL_DRIFT_ITEM_TIMEOUT", 5*time.Second)
	if max := leaseTTL / 3; driftItemTimeout <= 0 || driftItemTimeout > max {
		driftItemTimeout = max
	}
	var keyRouteCache gateway.APIKeyRouteCache
	if workerPoolNeedsKeyRouteCache(pool) {
		if strings.TrimSpace(os.Getenv("LLMGATEWAY_KEY_ROUTE_CACHE_REDIS_URL")) == "" {
			return fmt.Errorf("LLMGATEWAY_KEY_ROUTE_CACHE_REDIS_URL is required for %s worker pool", pool)
		}
		keyRouteCache, err = openKeyRouteCache(ctx, ModeWorker)
		if err != nil {
			return fmt.Errorf("open %s worker route cache: %w", pool, err)
		}
	}
	service := gateway.NewService(store, newHTTPTransportFromEnv(), gateway.Options{
		RootUsername:               rootUsername,
		RootPassword:               rootPassword,
		KeyRouteCache:              keyRouteCache,
		NewAPIClientTimeout:        newAPIClientTimeout,
		WorkerSetCapacityEnabled:   envBoolDefault("LLMGATEWAY_SET_AUTOSCALER_ENABLED", false),
		WorkerSetCapacityPolicy:    setCapacityPolicyFromEnv(),
		WorkerBYOKSyncBatchSize:    envInt("LLMGATEWAY_WORKER_BYOK_SYNC_BATCH_SIZE", 1000),
		WorkerObservationSeedBatch: envInt("LLMGATEWAY_OBSERVER_SEED_BATCH_SIZE", 1000),
		WorkerChannelDriftBatch:    envInt("LLMGATEWAY_WORKER_CHANNEL_DRIFT_BATCH_SIZE", 10),
		WorkerChannelDriftTimeout:  driftItemTimeout,
		TelemetrySanitizer:         telemetrySanitizer,
		TelemetryCorrelator:        telemetryCorrelatorFromEnv(),
	})
	defer service.CloseIdleConnections()
	owner := getenv("LLMGATEWAY_WORKER_ID", defaultWorkerID())
	log.Printf("llmgateway worker started pool=%s owner=%s poll=%s lease=%s", pool, owner, pollInterval, leaseTTL)
	logJobRun := func(run gateway.WorkerJobRun) {
		if run.Status == gateway.WorkerJobStatusError {
			log.Printf("llmgateway worker job failed job=%s detail=%s error=%s", run.JobName, run.Detail, run.Error)
		} else {
			log.Printf("llmgateway worker job finished job=%s detail=%s", run.JobName, run.Detail)
		}
	}
	switch pool {
	case "core":
		return service.RunCoreWorkerScheduler(ctx, owner, pollInterval, leaseTTL, logJobRun)
	case "byok":
		return service.RunBYOKWorker(ctx, owner, gateway.BYOKWorkerOptions{
			PollInterval:   envDuration("LLMGATEWAY_BYOK_WORKER_POLL_INTERVAL", time.Second),
			LeaseTTL:       envDuration("LLMGATEWAY_BYOK_WORKER_LEASE_TTL", 5*time.Minute),
			MaxConcurrency: envInt("LLMGATEWAY_BYOK_WORKER_MAX_CONCURRENCY", 16),
			SetConcurrency: envInt("LLMGATEWAY_BYOK_WORKER_SET_CONCURRENCY", 4),
			CandidateBatch: envInt("LLMGATEWAY_BYOK_WORKER_CANDIDATE_BATCH", 64),
		}, func(result gateway.BYOKWorkerResult) {
			if result.Err != nil && !errors.Is(result.Err, context.Canceled) {
				log.Printf("llmgateway BYOK task failed set=%s duration=%s error=%s", result.SetID, result.Duration, result.Err)
			}
		})
	case "observer":
		return service.RunObserverWorker(ctx, owner, gateway.ObserverWorkerOptions{
			PollInterval:   envDuration("LLMGATEWAY_OBSERVER_WORKER_POLL_INTERVAL", time.Second),
			LeaseTTL:       envDuration("LLMGATEWAY_OBSERVER_WORKER_LEASE_TTL", 5*time.Minute),
			MaxConcurrency: envInt("LLMGATEWAY_OBSERVER_WORKER_MAX_CONCURRENCY", 16),
			SetConcurrency: envInt("LLMGATEWAY_OBSERVER_WORKER_SET_CONCURRENCY", 4),
			CandidateBatch: envInt("LLMGATEWAY_OBSERVER_WORKER_CANDIDATE_BATCH", 64),
			SeedPoll:       pollInterval,
			SeedLeaseTTL:   leaseTTL,
		}, func(result gateway.ObserverWorkerResult) {
			if result.Err != nil && !errors.Is(result.Err, context.Canceled) {
				log.Printf("llmgateway observation task failed set=%s duration=%s error=%s", result.SetID, result.Duration, result.Err)
			}
		}, logJobRun)
	case "maintenance":
		return service.RunMaintenanceWorker(
			ctx,
			owner,
			envDuration("LLMGATEWAY_MAINTENANCE_WORKER_POLL_INTERVAL", time.Second),
			envDuration("LLMGATEWAY_MAINTENANCE_WORKER_LEASE_TTL", 5*time.Minute),
			envInt("LLMGATEWAY_MAINTENANCE_WORKER_BATCH_SIZE", 1000),
		)
	case "admin":
		return service.RunAdminCommandWorker(
			ctx,
			owner,
			envDuration("LLMGATEWAY_ADMIN_WORKER_POLL_INTERVAL", time.Second),
			envDuration("LLMGATEWAY_ADMIN_WORKER_LEASE_TTL", 5*time.Minute),
		)
	default:
		return fmt.Errorf("unsupported LLMGATEWAY_WORKER_POOL %q; want core, byok, observer, maintenance or admin", pool)
	}
}

func workerPoolNeedsKeyRouteCache(pool string) bool {
	switch strings.ToLower(strings.TrimSpace(pool)) {
	case "admin", "byok", "core", "maintenance":
		return true
	default:
		return false
	}
}

func SetupProcessTelemetry(ctx context.Context, defaultServiceName string, writer io.Writer) (*observability.Sanitizer, func(context.Context) error, error) {
	sanitizer := telemetrySanitizerFromEnv()
	config, err := stdoutTraceConfigFromEnv(defaultServiceName, sanitizer, writer)
	if err != nil {
		return nil, nil, err
	}
	log.SetOutput(observability.NewSanitizingWriter(os.Stderr, sanitizer))
	shutdown, err := observability.SetupStdoutTracing(ctx, config)
	if err != nil {
		return nil, nil, err
	}
	if config.Enabled {
		log.Printf("llmgateway OTel stdout enabled service=%s", config.ServiceName)
	}
	return sanitizer, shutdown, nil
}

func telemetryServiceName(mode Mode) string {
	if mode == "" {
		mode = ModeAll
	}
	return "llmgateway-" + string(mode)
}

func stdoutTraceConfigFromEnv(defaultServiceName string, sanitizer *observability.Sanitizer, writer io.Writer) (observability.StdoutTraceConfig, error) {
	enabled, err := strictEnvBool("LLMGATEWAY_OTEL_STDOUT_ENABLE", false)
	if err != nil {
		return observability.StdoutTraceConfig{}, err
	}
	pretty, err := strictEnvBool("LLMGATEWAY_OTEL_STDOUT_PRETTY", false)
	if err != nil {
		return observability.StdoutTraceConfig{}, err
	}
	queueSize, err := strictEnvInt("LLMGATEWAY_OTEL_QUEUE_SIZE", 1024)
	if err != nil {
		return observability.StdoutTraceConfig{}, err
	}
	batchSize, err := strictEnvInt("LLMGATEWAY_OTEL_BATCH_SIZE", 64)
	if err != nil {
		return observability.StdoutTraceConfig{}, err
	}
	maxRecordBytes, err := strictEnvInt("LLMGATEWAY_OTEL_MAX_RECORD_BYTES", 32768)
	if err != nil {
		return observability.StdoutTraceConfig{}, err
	}
	batchTimeout, err := strictEnvDuration("LLMGATEWAY_OTEL_BATCH_TIMEOUT", time.Second)
	if err != nil {
		return observability.StdoutTraceConfig{}, err
	}
	exportTimeout, err := strictEnvDuration("LLMGATEWAY_OTEL_EXPORT_TIMEOUT", 5*time.Second)
	if err != nil {
		return observability.StdoutTraceConfig{}, err
	}
	shutdownTimeout, err := strictEnvDuration("LLMGATEWAY_OTEL_SHUTDOWN_TIMEOUT", 5*time.Second)
	if err != nil {
		return observability.StdoutTraceConfig{}, err
	}
	if queueSize <= 0 || batchSize <= 0 || batchSize > queueSize || maxRecordBytes <= 0 {
		return observability.StdoutTraceConfig{}, fmt.Errorf("invalid OTel queue/batch/record limits: queue=%d batch=%d max_record_bytes=%d", queueSize, batchSize, maxRecordBytes)
	}
	return observability.StdoutTraceConfig{
		Enabled: enabled, ServiceName: getenv("OTEL_SERVICE_NAME", defaultServiceName),
		ServiceVersion: getenv("OTEL_SERVICE_VERSION", "dev"),
		Environment:    getenv("LLMGATEWAY_ENVIRONMENT", getenv("ENVIRONMENT", "local")),
		PrettyPrint:    pretty, Writer: writer, QueueSize: queueSize, BatchSize: batchSize,
		BatchTimeout: batchTimeout, ExportTimeout: exportTimeout, ShutdownTimeout: shutdownTimeout,
		MaxRecordBytes: maxRecordBytes, Sanitizer: sanitizer,
		ClusterName: getenv("K8S_CLUSTER_NAME", ""), NamespaceName: getenv("K8S_NAMESPACE_NAME", getenv("POD_NAMESPACE", "")),
		PodName: getenv("K8S_POD_NAME", getenv("HOSTNAME", "")), PodUID: getenv("K8S_POD_UID", ""),
		ContainerName: getenv("K8S_CONTAINER_NAME", ""), CloudRegion: getenv("CLOUD_REGION", ""),
	}, nil
}

func telemetrySanitizerFromEnv() *observability.Sanitizer {
	keys := []string{
		"CLUSTER_ADMIN_PASSWORD", "CLUSTER_ADMIN_TOKEN", "INTERNAL_SERVICE_TOKEN",
		"NEWAPI_SET_ROOT_PASSWORD", "LLMGATEWAY_SQL_DSN", "LLMGATEWAY_KEY_ROUTE_CACHE_REDIS_URL",
		"LLMGATEWAY_ADMIN_TOKEN", "LLMGATEWAY_INTERNAL_TOKEN", "LLMGATEWAY_OTEL_HASH_KEY",
		"LLMGATEWAY_CLEANUP_LEASE_FINGERPRINT", "LLMGATEWAY_CLEANUP_CLAIM_TOKEN", "LLMGATEWAY_CLEANUP_CAPABILITY",
		"MYSQL_ADMIN_PASSWORD", "REDIS_PASSWORD", "REDIS_PASSWORD_ENCODED",
	}
	secrets := make([]string, 0, len(keys))
	for _, key := range keys {
		if value := strings.TrimSpace(os.Getenv(key)); value != "" {
			secrets = append(secrets, value)
		}
	}
	return observability.NewSanitizer(observability.SanitizerConfig{Secrets: secrets})
}

func telemetryCorrelatorFromEnv() *observability.Correlator {
	return observability.NewCorrelator(os.Getenv("LLMGATEWAY_OTEL_HASH_KEY"), os.Getenv("LLMGATEWAY_OTEL_HASH_KEY_ID"))
}

func strictEnvBool(key string, fallback bool) (bool, error) {
	raw := strings.ToLower(strings.TrimSpace(os.Getenv(key)))
	if raw == "" {
		return fallback, nil
	}
	switch raw {
	case "1", "true", "yes", "on":
		return true, nil
	case "0", "false", "no", "off":
		return false, nil
	default:
		return false, fmt.Errorf("invalid %s=%q", key, raw)
	}
}

func strictEnvInt(key string, fallback int) (int, error) {
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return fallback, nil
	}
	value, err := strconv.Atoi(raw)
	if err != nil {
		return 0, fmt.Errorf("invalid %s=%q: %w", key, raw, err)
	}
	return value, nil
}

func strictEnvDuration(key string, fallback time.Duration) (time.Duration, error) {
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return fallback, nil
	}
	value, err := time.ParseDuration(raw)
	if err != nil || value <= 0 {
		return 0, fmt.Errorf("invalid %s=%q", key, raw)
	}
	return value, nil
}

func newHTTPTransportFromEnv() *http.Transport {
	dialer := &net.Dialer{
		Timeout:   envDuration("LLMGATEWAY_UPSTREAM_DIAL_TIMEOUT", 30*time.Second),
		KeepAlive: envDuration("LLMGATEWAY_UPSTREAM_DIAL_KEEPALIVE", 30*time.Second),
	}
	return &http.Transport{
		Proxy:                 http.ProxyFromEnvironment,
		DialContext:           dialer.DialContext,
		ForceAttemptHTTP2:     true,
		MaxIdleConns:          envInt("LLMGATEWAY_UPSTREAM_MAX_IDLE_CONNS", 500),
		MaxIdleConnsPerHost:   envInt("LLMGATEWAY_UPSTREAM_MAX_IDLE_CONNS_PER_HOST", 100),
		MaxConnsPerHost:       envInt("LLMGATEWAY_UPSTREAM_MAX_CONNS_PER_HOST", 0),
		IdleConnTimeout:       envDuration("LLMGATEWAY_UPSTREAM_IDLE_CONN_TIMEOUT", 90*time.Second),
		TLSHandshakeTimeout:   envDuration("LLMGATEWAY_UPSTREAM_TLS_HANDSHAKE_TIMEOUT", 10*time.Second),
		ExpectContinueTimeout: envDuration("LLMGATEWAY_UPSTREAM_EXPECT_CONTINUE_TIMEOUT", time.Second),
		ResponseHeaderTimeout: envDuration("LLMGATEWAY_UPSTREAM_RESPONSE_HEADER_TIMEOUT", 0),
	}
}

func defaultWorkerID() string {
	host, err := os.Hostname()
	if err != nil || strings.TrimSpace(host) == "" {
		host = "worker"
	}
	return fmt.Sprintf("%s-%d", host, os.Getpid())
}

func defaultPort(mode Mode) string {
	return "18080"
}

func sqlStartupTimeout() time.Duration {
	return envDuration("LLMGATEWAY_SQL_STARTUP_TIMEOUT", 5*time.Minute)
}

func openStore(ctx context.Context) (gateway.Store, error) {
	dsn := strings.TrimSpace(os.Getenv("LLMGATEWAY_SQL_DSN"))
	if dsn == "" {
		log.Printf("llmgateway using in-memory store")
		return gateway.NewMemoryStore(), nil
	}
	dbCtx, cancel := context.WithTimeout(ctx, sqlStartupTimeout())
	defer cancel()
	store, err := gateway.NewMySQLStoreWithOptions(dbCtx, dsn, gateway.MySQLStoreOptions{
		MaxOpenConns:    envInt("LLMGATEWAY_SQL_MAX_OPEN_CONNS", 32),
		MaxIdleConns:    envInt("LLMGATEWAY_SQL_MAX_IDLE_CONNS", 8),
		ConnMaxLifetime: envDuration("LLMGATEWAY_SQL_CONN_MAX_LIFETIME", 5*time.Minute),
		ConnMaxIdleTime: envDuration("LLMGATEWAY_SQL_CONN_MAX_IDLE_TIME", 2*time.Minute),
	})
	if err != nil {
		return nil, fmt.Errorf("open llmgateway mysql store: %w", err)
	}
	log.Printf("llmgateway using MySQL store")
	return store, nil
}

func openKeyRouteCache(ctx context.Context, mode Mode) (gateway.APIKeyRouteCache, error) {
	if !envBoolDefault("LLMGATEWAY_KEY_ROUTE_CACHE_ENABLE", true) {
		if mode == ModeTraffic {
			return nil, fmt.Errorf("LLMGATEWAY_KEY_ROUTE_CACHE_ENABLE=false is not allowed in traffic mode")
		}
		log.Printf("llmgateway key route cache disabled")
		return nil, nil
	}
	ttl := envDuration("LLMGATEWAY_KEY_ROUTE_CACHE_TTL", time.Minute)
	capacity := envInt("LLMGATEWAY_KEY_ROUTE_CACHE_CAPACITY", 100000)
	if ttl <= 0 {
		log.Printf("llmgateway key route cache disabled: ttl=%s", ttl)
		return nil, nil
	}
	if redisURL := strings.TrimSpace(os.Getenv("LLMGATEWAY_KEY_ROUTE_CACHE_REDIS_URL")); redisURL != "" {
		cacheCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
		defer cancel()
		cache, err := gateway.NewRedisAPIKeyRouteCacheFromURL(cacheCtx, normalizeRedisURL(redisURL), ttl, getenv("LLMGATEWAY_KEY_ROUTE_CACHE_NAMESPACE", "llmgateway"))
		if err != nil {
			return nil, fmt.Errorf("open llmgateway key route Redis cache: %w", err)
		}
		log.Printf("llmgateway key route cache enabled: redis ttl=%s", ttl)
		return cache, nil
	}
	if mode == ModeTraffic {
		return nil, fmt.Errorf("LLMGATEWAY_KEY_ROUTE_CACHE_REDIS_URL is required in traffic mode")
	}
	if capacity <= 0 {
		log.Printf("llmgateway key route cache disabled: capacity=%d", capacity)
		return nil, nil
	}
	log.Printf("llmgateway key route cache enabled: ttl=%s capacity=%d", ttl, capacity)
	return gateway.NewMemoryAPIKeyRouteCache(ttl, capacity), nil
}

func normalizeRedisURL(raw string) string {
	if strings.Contains(raw, "://") {
		return raw
	}
	return "redis://" + raw
}

func getenv(key string, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

func envBool(key string) bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv(key))) {
	case "1", "true", "yes", "on":
		return true
	default:
		return false
	}
}

func envBoolDefault(key string, fallback bool) bool {
	raw := strings.ToLower(strings.TrimSpace(os.Getenv(key)))
	if raw == "" {
		return fallback
	}
	switch raw {
	case "1", "true", "yes", "on":
		return true
	case "0", "false", "no", "off":
		return false
	default:
		log.Printf("invalid %s=%q, using %t", key, raw, fallback)
		return fallback
	}
}

func envInt(key string, fallback int) int {
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return fallback
	}
	value, err := strconv.Atoi(raw)
	if err != nil {
		log.Printf("invalid %s=%q, using %d", key, raw, fallback)
		return fallback
	}
	return value
}

func envFloat(key string, fallback float64) float64 {
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return fallback
	}
	value, err := strconv.ParseFloat(raw, 64)
	if err != nil {
		log.Printf("invalid %s=%q, using %.4f", key, raw, fallback)
		return fallback
	}
	return value
}

func envStringList(key string, fallback []string) []string {
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return fallback
	}
	parts := strings.Split(raw, ",")
	values := make([]string, 0, len(parts))
	for _, part := range parts {
		value := strings.TrimSpace(part)
		if value != "" {
			values = append(values, value)
		}
	}
	if len(values) == 0 {
		return fallback
	}
	return values
}

func setCapacityPolicyFromEnv() gateway.SetCapacityPolicy {
	redisDBStart := envInt("LLMGATEWAY_SET_AUTOSCALER_REDIS_DB_START", 0)
	redisDBLimit := envInt("LLMGATEWAY_SET_AUTOSCALER_REDIS_DB_LIMIT", 256)
	return gateway.SetCapacityPolicy{
		Source:             getenv("LLMGATEWAY_SET_AUTOSCALER_SOURCE", getenv("LLMGATEWAY_SOURCE", "prod")),
		Namespace:          getenv("LLMGATEWAY_SET_AUTOSCALER_NAMESPACE", getenv("POD_NAMESPACE", "llmgateway")),
		Fleet:              getenv("LLMGATEWAY_SET_AUTOSCALER_FLEET", getenv("LLMGATEWAY_FLEET", "prod")),
		ShardRefs:          envStringList("LLMGATEWAY_SET_AUTOSCALER_SHARD_REFS", nil),
		MaxUsersPerSet:     envInt("LLMGATEWAY_SET_AUTOSCALER_MAX_USERS_PER_SET", 10000),
		TargetUtilization:  envFloat("LLMGATEWAY_SET_AUTOSCALER_TARGET_UTILIZATION", 0.70),
		MinReadyFreeUsers:  envInt("LLMGATEWAY_SET_AUTOSCALER_MIN_READY_FREE_USERS", 3000),
		MinWarmSets:        envInt("LLMGATEWAY_SET_AUTOSCALER_MIN_WARM_SETS", 0),
		MaxScaleUpPerCycle: envInt("LLMGATEWAY_SET_AUTOSCALER_MAX_SCALE_UP_PER_CYCLE", 1),
		SetIDPrefix:        getenv("LLMGATEWAY_SET_AUTOSCALER_SET_ID_PREFIX", "set-auto"),
		RedisDBStart:       &redisDBStart,
		RedisDBLimit:       &redisDBLimit,
	}
}

func envDuration(key string, fallback time.Duration) time.Duration {
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return fallback
	}
	value, err := time.ParseDuration(raw)
	if err != nil || value < 0 {
		log.Printf("invalid %s=%q, using %s", key, raw, fallback)
		return fallback
	}
	return value
}

func closeStore(store gateway.Store) error {
	if closer, ok := store.(interface{ Close() error }); ok {
		return closer.Close()
	}
	return nil
}
