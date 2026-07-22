package app

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"git.woa.com/wisp/mono2/llmgateway/internal/gateway"
	"git.woa.com/wisp/mono2/llmgateway/internal/httpapi"
)

func TestStdoutTraceConfigFromEnvIncludesRuntimeIdentityAndBatchLimits(t *testing.T) {
	t.Setenv("LLMGATEWAY_OTEL_STDOUT_ENABLE", "true")
	t.Setenv("OTEL_SERVICE_VERSION", "git-deadbeef")
	t.Setenv("LLMGATEWAY_ENVIRONMENT", "prod")
	t.Setenv("LLMGATEWAY_OTEL_QUEUE_SIZE", "2048")
	t.Setenv("LLMGATEWAY_OTEL_BATCH_SIZE", "128")
	t.Setenv("LLMGATEWAY_OTEL_BATCH_TIMEOUT", "2s")
	t.Setenv("LLMGATEWAY_OTEL_MAX_RECORD_BYTES", "65536")
	t.Setenv("K8S_CLUSTER_NAME", "prod-beijing")
	t.Setenv("K8S_NAMESPACE_NAME", "llmgateway")
	t.Setenv("K8S_POD_NAME", "control-1")
	t.Setenv("K8S_POD_UID", "pod-uid")
	t.Setenv("K8S_CONTAINER_NAME", "control")
	t.Setenv("CLOUD_REGION", "ap-beijing")

	config, err := stdoutTraceConfigFromEnv("llmgateway-control", nil, io.Discard)
	if err != nil {
		t.Fatal(err)
	}
	if !config.Enabled || config.ServiceName != "llmgateway-control" || config.ServiceVersion != "git-deadbeef" {
		t.Fatalf("unexpected service config: %+v", config)
	}
	if config.QueueSize != 2048 || config.BatchSize != 128 || config.BatchTimeout != 2*time.Second || config.MaxRecordBytes != 65536 {
		t.Fatalf("unexpected batch config: %+v", config)
	}
	if config.ClusterName != "prod-beijing" || config.PodUID != "pod-uid" || config.CloudRegion != "ap-beijing" {
		t.Fatalf("unexpected resource identity: %+v", config)
	}
}

func TestSetupProcessTelemetryRejectsInvalidExplicitOTelValues(t *testing.T) {
	t.Setenv("LLMGATEWAY_OTEL_STDOUT_ENABLE", "true")
	t.Setenv("LLMGATEWAY_OTEL_QUEUE_SIZE", "not-a-number")
	_, _, err := SetupProcessTelemetry(context.Background(), "llmgateway-control", io.Discard)
	if err == nil {
		t.Fatal("expected invalid explicit queue size to fail startup")
	}
}

func TestHandlerForModeSelectsTrafficOnlySurface(t *testing.T) {
	svc := gateway.NewService(gateway.NewMemoryStore(), nil, gateway.Options{})
	handler := HandlerForMode(ModeTraffic, svc, httpapi.Config{AdminToken: "cluster-token"})

	adminReq := httptest.NewRequest(http.MethodGet, "/api/sets", nil)
	adminReq.Header.Set("Authorization", "Bearer cluster-token")
	adminRec := httptest.NewRecorder()
	handler.ServeHTTP(adminRec, adminReq)
	if adminRec.Code != http.StatusNotFound {
		t.Fatalf("traffic mode /api/sets status = %d, want 404", adminRec.Code)
	}

	readyReq := httptest.NewRequest(http.MethodGet, "/readyz", nil)
	readyRec := httptest.NewRecorder()
	handler.ServeHTTP(readyRec, readyReq)
	if readyRec.Code != http.StatusOK {
		t.Fatalf("traffic mode /readyz status = %d, want 200", readyRec.Code)
	}
}

func TestHandlerForModeKeepsFullControlSurfaceByDefault(t *testing.T) {
	svc := gateway.NewService(gateway.NewMemoryStore(), nil, gateway.Options{})
	handler := HandlerForMode(ModeAll, svc, httpapi.Config{AdminToken: "cluster-token"})

	req := httptest.NewRequest(http.MethodGet, "/api/sets", nil)
	req.Header.Set("Authorization", "Bearer cluster-token")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("all mode /api/sets status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
}

func TestHandlerForModeSelectsControlOnlySurface(t *testing.T) {
	svc := gateway.NewService(gateway.NewMemoryStore(), nil, gateway.Options{})
	handler := HandlerForMode(ModeControl, svc, httpapi.Config{AdminToken: "cluster-token"})

	adminReq := httptest.NewRequest(http.MethodGet, "/api/sets", nil)
	adminReq.Header.Set("Authorization", "Bearer cluster-token")
	adminRec := httptest.NewRecorder()
	handler.ServeHTTP(adminRec, adminReq)
	if adminRec.Code != http.StatusOK {
		t.Fatalf("control mode /api/sets status = %d, want 200; body=%s", adminRec.Code, adminRec.Body.String())
	}

	trafficReq := httptest.NewRequest(http.MethodGet, "/v1/models", nil)
	trafficReq.Header.Set("Authorization", "Bearer missing")
	trafficRec := httptest.NewRecorder()
	handler.ServeHTTP(trafficRec, trafficReq)
	if trafficRec.Code != http.StatusNotFound {
		t.Fatalf("control mode /v1/models status = %d, want 404", trafficRec.Code)
	}
}

func TestNewHTTPTransportFromEnvUsesGatewayProxyDefaults(t *testing.T) {
	t.Setenv("LLMGATEWAY_UPSTREAM_MAX_IDLE_CONNS", "")
	t.Setenv("LLMGATEWAY_UPSTREAM_MAX_IDLE_CONNS_PER_HOST", "")
	t.Setenv("LLMGATEWAY_UPSTREAM_IDLE_CONN_TIMEOUT", "")
	t.Setenv("LLMGATEWAY_UPSTREAM_RESPONSE_HEADER_TIMEOUT", "")
	t.Setenv("LLMGATEWAY_UPSTREAM_TLS_HANDSHAKE_TIMEOUT", "")
	t.Setenv("LLMGATEWAY_UPSTREAM_EXPECT_CONTINUE_TIMEOUT", "")

	transport := newHTTPTransportFromEnv()

	if transport.MaxIdleConns != 500 {
		t.Fatalf("MaxIdleConns = %d, want 500", transport.MaxIdleConns)
	}
	if transport.MaxIdleConnsPerHost != 100 {
		t.Fatalf("MaxIdleConnsPerHost = %d, want 100", transport.MaxIdleConnsPerHost)
	}
	if transport.IdleConnTimeout != 90*time.Second {
		t.Fatalf("IdleConnTimeout = %s, want 90s", transport.IdleConnTimeout)
	}
	if transport.ResponseHeaderTimeout != 0 {
		t.Fatalf("ResponseHeaderTimeout = %s, want no default timeout for streaming", transport.ResponseHeaderTimeout)
	}
	if !transport.ForceAttemptHTTP2 {
		t.Fatal("transport should enable HTTP/2 when upstream supports it")
	}
	if transport.Proxy == nil || transport.DialContext == nil {
		t.Fatal("transport should preserve proxy-from-env and dialer defaults")
	}
}

func TestNewHTTPTransportFromEnvCanTuneGatewayProxyTransport(t *testing.T) {
	t.Setenv("LLMGATEWAY_UPSTREAM_MAX_IDLE_CONNS", "123")
	t.Setenv("LLMGATEWAY_UPSTREAM_MAX_IDLE_CONNS_PER_HOST", "45")
	t.Setenv("LLMGATEWAY_UPSTREAM_MAX_CONNS_PER_HOST", "67")
	t.Setenv("LLMGATEWAY_UPSTREAM_IDLE_CONN_TIMEOUT", "12s")
	t.Setenv("LLMGATEWAY_UPSTREAM_RESPONSE_HEADER_TIMEOUT", "3s")
	t.Setenv("LLMGATEWAY_UPSTREAM_TLS_HANDSHAKE_TIMEOUT", "4s")
	t.Setenv("LLMGATEWAY_UPSTREAM_EXPECT_CONTINUE_TIMEOUT", "5s")

	transport := newHTTPTransportFromEnv()

	if transport.MaxIdleConns != 123 ||
		transport.MaxIdleConnsPerHost != 45 ||
		transport.MaxConnsPerHost != 67 ||
		transport.IdleConnTimeout != 12*time.Second ||
		transport.ResponseHeaderTimeout != 3*time.Second ||
		transport.TLSHandshakeTimeout != 4*time.Second ||
		transport.ExpectContinueTimeout != 5*time.Second {
		t.Fatalf("transport not tuned from env: %+v", transport)
	}
}

func TestTrafficRuntimeRoutingFromEnv(t *testing.T) {
	t.Setenv("LLMGATEWAY_SET_RUNTIME_ROUTE_REQUIRED", "true")
	t.Setenv("LLMGATEWAY_TRAFFIC_TRANSPORT_DRAIN_TIMEOUT", "15s")

	manager, required := trafficRuntimeRoutingFromEnv(ModeTraffic)
	if manager == nil || !required {
		t.Fatalf("traffic runtime routing manager=%v required=%v", manager, required)
	}
	defer manager.Close()
	if manager.DrainTimeout() != 15*time.Second {
		t.Fatalf("drain timeout=%s, want 15s", manager.DrainTimeout())
	}

	controlManager, controlRequired := trafficRuntimeRoutingFromEnv(ModeControl)
	if controlManager != nil || controlRequired {
		t.Fatalf("control runtime routing manager=%v required=%v", controlManager, controlRequired)
	}
}

func TestSQLStartupTimeout(t *testing.T) {
	t.Setenv("LLMGATEWAY_SQL_STARTUP_TIMEOUT", "")
	if got := sqlStartupTimeout(); got != 5*time.Minute {
		t.Fatalf("default SQL startup timeout = %s, want 5m", got)
	}
	t.Setenv("LLMGATEWAY_SQL_STARTUP_TIMEOUT", "10m")
	if got := sqlStartupTimeout(); got != 10*time.Minute {
		t.Fatalf("configured SQL startup timeout = %s, want 10m", got)
	}
}

func TestDefaultTrafficProbeBaseURLMatchesRuntimeTopology(t *testing.T) {
	if got := defaultTrafficProbeBaseURL(ModeControl, "18080"); got != "http://llmgateway-traffic" {
		t.Fatalf("control traffic probe base URL = %q", got)
	}
	if got := defaultTrafficProbeBaseURL(ModeAll, "19080"); got != "http://127.0.0.1:19080" {
		t.Fatalf("all-in-one traffic probe base URL = %q", got)
	}
}

func TestWorkerPoolRouteCacheRequirementIncludesEveryTrafficRouteWriter(t *testing.T) {
	for _, pool := range []string{"admin", "byok", "core", "maintenance"} {
		if !workerPoolNeedsKeyRouteCache(pool) {
			t.Fatalf("worker pool %q must initialize the shared route cache", pool)
		}
	}
	for _, pool := range []string{"observer"} {
		if workerPoolNeedsKeyRouteCache(pool) {
			t.Fatalf("worker pool %q does not write traffic routes", pool)
		}
	}
}

func TestSetCapacityPolicyFromEnvUsesSetAutoscalerPrefix(t *testing.T) {
	t.Setenv("LLMGATEWAY_SET_AUTOSCALER_SOURCE", "autoscaler")
	t.Setenv("LLMGATEWAY_SET_AUTOSCALER_NAMESPACE", "vela")
	t.Setenv("LLMGATEWAY_SET_AUTOSCALER_FLEET", "primary")
	t.Setenv("LLMGATEWAY_SET_AUTOSCALER_SHARD_REFS", "shard-a,shard-b")
	t.Setenv("LLMGATEWAY_SET_AUTOSCALER_MAX_USERS_PER_SET", "12000")
	t.Setenv("LLMGATEWAY_SET_AUTOSCALER_TARGET_UTILIZATION", "0.65")
	t.Setenv("LLMGATEWAY_SET_AUTOSCALER_MIN_READY_FREE_USERS", "4000")
	t.Setenv("LLMGATEWAY_SET_AUTOSCALER_MIN_WARM_SETS", "3")
	t.Setenv("LLMGATEWAY_SET_AUTOSCALER_MAX_SCALE_UP_PER_CYCLE", "2")
	t.Setenv("LLMGATEWAY_SET_AUTOSCALER_SET_ID_PREFIX", "autoset")
	t.Setenv("LLMGATEWAY_SET_AUTOSCALER_REDIS_DB_START", "8")
	t.Setenv("LLMGATEWAY_SET_AUTOSCALER_REDIS_DB_LIMIT", "64")
	t.Setenv("LLMGATEWAY_SET_AUTOSCALER_RUNTIME_BACKEND", "velagwset")
	t.Setenv("LLMGATEWAY_SET_AUTOSCALER_WRITER_EPOCH", "9")

	// Legacy capacity names must no longer influence the worker.
	t.Setenv("LLMGATEWAY_SET_MANAGER_MIN_WARM_SETS", "99")
	t.Setenv("LLMGATEWAY_SET_MANAGER_SHARD_REFS", "legacy-shard")

	policy := setCapacityPolicyFromEnv()
	if policy.Source != "autoscaler" || policy.Namespace != "vela" || policy.Fleet != "primary" {
		t.Fatalf("unexpected autoscaler target: %+v", policy)
	}
	if len(policy.ShardRefs) != 2 || policy.ShardRefs[0] != "shard-a" || policy.ShardRefs[1] != "shard-b" {
		t.Fatalf("unexpected shard refs: %+v", policy.ShardRefs)
	}
	if policy.MaxUsersPerSet != 12000 || policy.TargetUtilization != 0.65 || policy.MinReadyFreeUsers != 4000 || policy.MinWarmSets != 3 || policy.MaxScaleUpPerCycle != 2 {
		t.Fatalf("unexpected autoscaler watermarks: %+v", policy)
	}
	if policy.SetIDPrefix != "autoset" || policy.RedisDBStart == nil || *policy.RedisDBStart != 8 || policy.RedisDBLimit == nil || *policy.RedisDBLimit != 64 {
		t.Fatalf("unexpected autoscaler allocation policy: %+v", policy)
	}
	if policy.RuntimeBackend != gateway.SetRuntimeBackendVelaGWSet || policy.WriterEpoch != 9 {
		t.Fatalf("unexpected autoscaler writer: %+v", policy)
	}
}
