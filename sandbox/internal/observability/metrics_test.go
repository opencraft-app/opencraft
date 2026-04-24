package observability

import (
	"bufio"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/prometheus/client_golang/prometheus"
)

func TestAPIMetrics_ExposeHTTPAndSandboxCreateMetrics(t *testing.T) {
	gin.SetMode(gin.TestMode)

	reg := prometheus.NewRegistry()
	m := NewAPIMetrics(reg)

	r := gin.New()
	r.Use(m.Middleware())
	r.GET("/health", func(c *gin.Context) {
		m.ObserveSandboxCreate("pool-bj8", "success")
		c.Status(http.StatusOK)
	})
	r.GET("/metrics", gin.WrapH(m.Handler()))

	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	r.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d", rr.Code)
	}

	metrics := httptest.NewRecorder()
	metricsReq := httptest.NewRequest(http.MethodGet, "/metrics", nil)
	r.ServeHTTP(metrics, metricsReq)
	if metrics.Code != http.StatusOK {
		t.Fatalf("expected metrics status 200, got %d", metrics.Code)
	}

	body := metrics.Body.String()
	if !strings.Contains(body, "sandbox_api_http_requests_total") {
		t.Fatalf("expected request counter in metrics output, got %q", body)
	}
	if !strings.Contains(body, "sandbox_api_sandbox_create_total") {
		t.Fatalf("expected sandbox create counter in metrics output, got %q", body)
	}
	if !strings.Contains(body, `pool="pool-bj8"`) {
		t.Fatalf("expected pool label in metrics output, got %q", body)
	}
}

func TestWorkerMetrics_ExposeInventoryAndRefillMetrics(t *testing.T) {
	reg := prometheus.NewRegistry()
	m := NewWorkerMetrics(reg)

	m.ObserveRefillCreated("pool-bj8", 2)
	m.ObserveRefillFailure("pool-c0", "InvalidZone.MismatchRegion", true)
	m.SetInventory("pool-bj8", "clean", 3)
	m.SetInventory("pool-bj8", "creating", 1)

	metrics := httptest.NewRecorder()
	metricsReq := httptest.NewRequest(http.MethodGet, "/metrics", nil)
	m.Handler().ServeHTTP(metrics, metricsReq)
	if metrics.Code != http.StatusOK {
		t.Fatalf("expected metrics status 200, got %d", metrics.Code)
	}

	body := metrics.Body.String()
	if !strings.Contains(body, "sandbox_worker_refill_created_total") {
		t.Fatalf("expected worker refill created counter in metrics output, got %q", body)
	}
	if !strings.Contains(body, "sandbox_worker_refill_failures_total") {
		t.Fatalf("expected worker refill failure counter in metrics output, got %q", body)
	}
	if !strings.Contains(body, "sandbox_worker_inventory") {
		t.Fatalf("expected worker inventory gauge in metrics output, got %q", body)
	}
	if !strings.Contains(body, `pool="pool-bj8"`) {
		t.Fatalf("expected pool label in metrics output, got %q", body)
	}
}

func TestIngressProxyMetrics_ExposeRequestPoolAndLimiterMetrics(t *testing.T) {
	reg := prometheus.NewRegistry()
	m := NewIngressProxyMetrics(reg)
	layer := m.Layer("shard")

	handler := layer.Wrap(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusCreated)
		_, _ = io.WriteString(w, "ok")
	}))

	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	handler.ServeHTTP(rr, req)
	if rr.Code != http.StatusCreated {
		t.Fatalf("expected status 201, got %d", rr.Code)
	}

	layer.ObserveUpstreamError("timeout")
	layer.ObserveRouteLookupFailure("timeout")
	layer.ObserveConnectionBlocked("sandbox")
	layer.AddInFlight("sandbox", 1)
	layer.SetPoolSize(7)
	layer.SetCurrentConnections(4)
	layer.AddTotalConnections(9)
	layer.ObserveCloseIdleConnections()
	layer.ObserveResetConnections(3)
	layer.AddDownstreamAccepted(2)
	layer.AddDownstreamClosed(1)
	layer.SetDownstreamCurrent(1)
	layer.ObserveDownstreamForceClosed(1)

	metrics := httptest.NewRecorder()
	metricsReq := httptest.NewRequest(http.MethodGet, "/metrics", nil)
	m.Handler().ServeHTTP(metrics, metricsReq)
	if metrics.Code != http.StatusOK {
		t.Fatalf("expected metrics status 200, got %d", metrics.Code)
	}

	body := metrics.Body.String()
	if !strings.Contains(body, "sandbox_ingressproxy_http_requests_total") {
		t.Fatalf("expected ingressproxy request counter in metrics output, got %q", body)
	}
	if !strings.Contains(body, "sandbox_ingressproxy_upstream_errors_total") {
		t.Fatalf("expected ingressproxy upstream error counter in metrics output, got %q", body)
	}
	if !strings.Contains(body, "sandbox_ingressproxy_route_lookup_failures_total") {
		t.Fatalf("expected ingressproxy route lookup failure counter in metrics output, got %q", body)
	}
	if !strings.Contains(body, "sandbox_ingressproxy_connection_blocked_total") {
		t.Fatalf("expected ingressproxy connection blocked counter in metrics output, got %q", body)
	}
	if !strings.Contains(body, "sandbox_ingressproxy_inflight_requests") {
		t.Fatalf("expected ingressproxy inflight gauge in metrics output, got %q", body)
	}
	if !strings.Contains(body, "sandbox_ingressproxy_proxy_pool_size") {
		t.Fatalf("expected ingressproxy pool size gauge in metrics output, got %q", body)
	}
	if !strings.Contains(body, "sandbox_ingressproxy_pool_current_connections") {
		t.Fatalf("expected ingressproxy current connection gauge in metrics output, got %q", body)
	}
	if !strings.Contains(body, "sandbox_ingressproxy_pool_total_connections") {
		t.Fatalf("expected ingressproxy total connection counter in metrics output, got %q", body)
	}
	if !strings.Contains(body, "sandbox_ingressproxy_pool_close_total") {
		t.Fatalf("expected ingressproxy pool close counter in metrics output, got %q", body)
	}
	if !strings.Contains(body, "sandbox_ingressproxy_pool_reset_connections_total") {
		t.Fatalf("expected ingressproxy pool reset counter in metrics output, got %q", body)
	}
	if !strings.Contains(body, "sandbox_ingressproxy_downstream_connections_accepted_total") {
		t.Fatalf("expected ingressproxy downstream accepted counter in metrics output, got %q", body)
	}
	if !strings.Contains(body, "sandbox_ingressproxy_downstream_connections_closed_total") {
		t.Fatalf("expected ingressproxy downstream closed counter in metrics output, got %q", body)
	}
	if !strings.Contains(body, "sandbox_ingressproxy_downstream_connections_current") {
		t.Fatalf("expected ingressproxy downstream current gauge in metrics output, got %q", body)
	}
	if !strings.Contains(body, "sandbox_ingressproxy_downstream_connections_forced_closed_total") {
		t.Fatalf("expected ingressproxy downstream forced close counter in metrics output, got %q", body)
	}
	if !strings.Contains(body, `layer="shard"`) {
		t.Fatalf("expected layer label in metrics output, got %q", body)
	}
}

type flushRecorder struct {
	*httptest.ResponseRecorder
	flushed bool
}

func (r *flushRecorder) Flush() {
	r.flushed = true
	r.ResponseRecorder.Flush()
}

type hijackableRecorder struct {
	*flushRecorder
}

func (r *hijackableRecorder) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	serverConn, clientConn := net.Pipe()
	rw := bufio.NewReadWriter(bufio.NewReader(serverConn), bufio.NewWriter(serverConn))
	return clientConn, rw, nil
}

func TestStatusCapturingResponseWriterPreservesFlusher(t *testing.T) {
	rec := &flushRecorder{ResponseRecorder: httptest.NewRecorder()}
	w := &statusCapturingResponseWriter{ResponseWriter: rec, status: http.StatusOK}

	w.Flush()

	if !rec.flushed {
		t.Fatalf("expected flush to be forwarded to wrapped writer")
	}
}

func TestStatusCapturingResponseWriterPreservesHijacker(t *testing.T) {
	rec := &hijackableRecorder{flushRecorder: &flushRecorder{ResponseRecorder: httptest.NewRecorder()}}
	w := &statusCapturingResponseWriter{ResponseWriter: rec, status: http.StatusOK}

	conn, _, err := w.Hijack()
	if err != nil {
		t.Fatalf("expected hijack to succeed: %v", err)
	}
	_ = conn.Close()
}
