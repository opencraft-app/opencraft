package observability

import (
	"bufio"
	"fmt"
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

type APIMetrics struct {
	gatherer      prometheus.Gatherer
	requests      *prometheus.CounterVec
	requestDur    *prometheus.HistogramVec
	sandboxCreate *prometheus.CounterVec
}

func NewAPIMetrics(reg prometheus.Registerer) *APIMetrics {
	m := &APIMetrics{
		gatherer: asGatherer(reg),
		requests: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "sandbox_api_http_requests_total",
			Help: "Total HTTP requests handled by sandbox-api.",
		}, []string{"method", "route", "status"}),
		requestDur: prometheus.NewHistogramVec(prometheus.HistogramOpts{
			Name:    "sandbox_api_http_request_duration_seconds",
			Help:    "HTTP request latency for sandbox-api.",
			Buckets: prometheus.DefBuckets,
		}, []string{"method", "route", "status"}),
		sandboxCreate: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "sandbox_api_sandbox_create_total",
			Help: "Total sandbox create attempts by pool and result.",
		}, []string{"pool", "result"}),
	}
	reg.MustRegister(m.requests, m.requestDur, m.sandboxCreate)
	return m
}

func (m *APIMetrics) Middleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		start := time.Now()
		c.Next()

		route := c.FullPath()
		if route == "" {
			route = c.Request.URL.Path
		}
		status := strconv.Itoa(c.Writer.Status())
		m.requests.WithLabelValues(c.Request.Method, route, status).Inc()
		m.requestDur.WithLabelValues(c.Request.Method, route, status).Observe(time.Since(start).Seconds())
	}
}

func (m *APIMetrics) ObserveSandboxCreate(pool, result string) {
	if pool == "" {
		pool = "unknown"
	}
	if result == "" {
		result = "unknown"
	}
	m.sandboxCreate.WithLabelValues(pool, result).Inc()
}

func (m *APIMetrics) Handler() http.Handler {
	return promhttp.HandlerFor(m.gatherer, promhttp.HandlerOpts{})
}

type WorkerMetrics struct {
	gatherer       prometheus.Gatherer
	refillCreated  *prometheus.CounterVec
	refillFailures *prometheus.CounterVec
	poolPaused     *prometheus.CounterVec
	inventory      *prometheus.GaugeVec
	verifyFailures *prometheus.CounterVec
}

func NewWorkerMetrics(reg prometheus.Registerer) *WorkerMetrics {
	m := &WorkerMetrics{
		gatherer: asGatherer(reg),
		refillCreated: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "sandbox_worker_refill_created_total",
			Help: "Total instances successfully created by worker refill loops.",
		}, []string{"pool"}),
		refillFailures: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "sandbox_worker_refill_failures_total",
			Help: "Total worker refill failures by pool and code.",
		}, []string{"pool", "code", "terminal"}),
		poolPaused: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "sandbox_worker_pool_paused_total",
			Help: "Total times a worker paused a pool due to refill issues.",
		}, []string{"pool", "reason"}),
		inventory: prometheus.NewGaugeVec(prometheus.GaugeOpts{
			Name: "sandbox_worker_inventory",
			Help: "Observed per-pool inventory by instance state.",
		}, []string{"pool", "state"}),
		verifyFailures: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "sandbox_worker_verify_failures_total",
			Help: "Total verify failures observed by worker loops.",
		}, []string{"pool", "phase"}),
	}
	reg.MustRegister(m.refillCreated, m.refillFailures, m.poolPaused, m.inventory, m.verifyFailures)
	return m
}

func (m *WorkerMetrics) ObserveRefillCreated(pool string, count int) {
	if count <= 0 {
		return
	}
	m.refillCreated.WithLabelValues(pool).Add(float64(count))
}

func (m *WorkerMetrics) ObserveRefillFailure(pool, code string, terminal bool) {
	if pool == "" {
		pool = "unknown"
	}
	if code == "" {
		code = "unknown"
	}
	m.refillFailures.WithLabelValues(pool, code, strconv.FormatBool(terminal)).Inc()
}

func (m *WorkerMetrics) ObservePoolPaused(pool, reason string) {
	if pool == "" {
		pool = "unknown"
	}
	if reason == "" {
		reason = "unknown"
	}
	m.poolPaused.WithLabelValues(pool, reason).Inc()
}

func (m *WorkerMetrics) SetInventory(pool, state string, count int) {
	if pool == "" || state == "" {
		return
	}
	m.inventory.WithLabelValues(pool, state).Set(float64(count))
}

func (m *WorkerMetrics) ObserveVerifyFailure(pool, phase string) {
	if pool == "" {
		pool = "unknown"
	}
	if phase == "" {
		phase = "unknown"
	}
	m.verifyFailures.WithLabelValues(pool, phase).Inc()
}

func (m *WorkerMetrics) Handler() http.Handler {
	return promhttp.HandlerFor(m.gatherer, promhttp.HandlerOpts{})
}

type statusCapturingResponseWriter struct {
	http.ResponseWriter
	status int
}

func (w *statusCapturingResponseWriter) WriteHeader(code int) {
	w.status = code
	w.ResponseWriter.WriteHeader(code)
}

func (w *statusCapturingResponseWriter) Flush() {
	if f, ok := w.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

func (w *statusCapturingResponseWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	h, ok := w.ResponseWriter.(http.Hijacker)
	if !ok {
		return nil, nil, fmt.Errorf("response writer does not implement http.Hijacker")
	}
	return h.Hijack()
}

func (w *statusCapturingResponseWriter) Push(target string, opts *http.PushOptions) error {
	p, ok := w.ResponseWriter.(http.Pusher)
	if !ok {
		return http.ErrNotSupported
	}
	return p.Push(target, opts)
}

func (w *statusCapturingResponseWriter) ReadFrom(r io.Reader) (int64, error) {
	if rf, ok := w.ResponseWriter.(io.ReaderFrom); ok {
		return rf.ReadFrom(r)
	}
	return io.Copy(w.ResponseWriter, r)
}

func (w *statusCapturingResponseWriter) Unwrap() http.ResponseWriter {
	return w.ResponseWriter
}

func classifyPath(path string) string {
	switch {
	case path == "/health":
		return "health"
	case path == "/ready":
		return "ready"
	case path == "/metrics":
		return "metrics"
	case path == "/":
		return "root"
	case path == "":
		return "unknown"
	default:
		return "proxy"
	}
}

func asGatherer(reg prometheus.Registerer) prometheus.Gatherer {
	if g, ok := reg.(prometheus.Gatherer); ok {
		return g
	}
	return prometheus.DefaultGatherer
}

type IngressProxyMetrics struct {
	gatherer          prometheus.Gatherer
	requests          *prometheus.CounterVec
	requestDur        *prometheus.HistogramVec
	upstreamErrors    *prometheus.CounterVec
	routeLookupErrors *prometheus.CounterVec
	connectionBlocked *prometheus.CounterVec
	inflightRequests  *prometheus.GaugeVec
	proxyPoolSize     *prometheus.GaugeVec
	poolCurrentConns  *prometheus.GaugeVec
	poolTotalConns    *prometheus.CounterVec
	poolCloseTotal    *prometheus.CounterVec
	poolResetConns    *prometheus.CounterVec
	downstreamAccepted *prometheus.CounterVec
	downstreamClosed   *prometheus.CounterVec
	downstreamCurrent  *prometheus.GaugeVec
	downstreamForced   *prometheus.CounterVec
}

type IngressProxyLayerMetrics struct {
	parent *IngressProxyMetrics
	layer  string
}

func NewIngressProxyMetrics(reg prometheus.Registerer) *IngressProxyMetrics {
	m := &IngressProxyMetrics{
		gatherer: asGatherer(reg),
		requests: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "sandbox_ingressproxy_http_requests_total",
			Help: "Total HTTP requests handled by sandbox ingressproxy layers.",
		}, []string{"layer", "method", "path_class", "status"}),
		requestDur: prometheus.NewHistogramVec(prometheus.HistogramOpts{
			Name:    "sandbox_ingressproxy_http_request_duration_seconds",
			Help:    "HTTP request latency for sandbox ingressproxy layers.",
			Buckets: prometheus.DefBuckets,
		}, []string{"layer", "method", "path_class", "status"}),
		upstreamErrors: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "sandbox_ingressproxy_upstream_errors_total",
			Help: "Total upstream transport errors observed by sandbox ingressproxy layers.",
		}, []string{"layer", "class"}),
		routeLookupErrors: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "sandbox_ingressproxy_route_lookup_failures_total",
			Help: "Total route lookup failures observed by sandbox ingressproxy layers.",
		}, []string{"layer", "class"}),
		connectionBlocked: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "sandbox_ingressproxy_connection_blocked_total",
			Help: "Total ingressproxy requests blocked by in-flight connection limits.",
		}, []string{"layer", "target_kind"}),
		inflightRequests: prometheus.NewGaugeVec(prometheus.GaugeOpts{
			Name: "sandbox_ingressproxy_inflight_requests",
			Help: "Current in-flight requests tracked by ingressproxy limiters.",
		}, []string{"layer", "target_kind"}),
		proxyPoolSize: prometheus.NewGaugeVec(prometheus.GaugeOpts{
			Name: "sandbox_ingressproxy_proxy_pool_size",
			Help: "Current reverse proxy pool size per ingressproxy layer.",
		}, []string{"layer"}),
		poolCurrentConns: prometheus.NewGaugeVec(prometheus.GaugeOpts{
			Name: "sandbox_ingressproxy_pool_current_connections",
			Help: "Current active upstream connections per ingressproxy layer.",
		}, []string{"layer"}),
		poolTotalConns: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "sandbox_ingressproxy_pool_total_connections",
			Help: "Total upstream connections established per ingressproxy layer.",
		}, []string{"layer"}),
		poolCloseTotal: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "sandbox_ingressproxy_pool_close_total",
			Help: "Total proxy pool close operations per ingressproxy layer.",
		}, []string{"layer"}),
		poolResetConns: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "sandbox_ingressproxy_pool_reset_connections_total",
			Help: "Total active upstream connections reset per ingressproxy layer.",
		}, []string{"layer"}),
		downstreamAccepted: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "sandbox_ingressproxy_downstream_connections_accepted_total",
			Help: "Total downstream client connections accepted per ingressproxy layer.",
		}, []string{"layer"}),
		downstreamClosed: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "sandbox_ingressproxy_downstream_connections_closed_total",
			Help: "Total downstream client connections closed per ingressproxy layer.",
		}, []string{"layer"}),
		downstreamCurrent: prometheus.NewGaugeVec(prometheus.GaugeOpts{
			Name: "sandbox_ingressproxy_downstream_connections_current",
			Help: "Current downstream client connections per ingressproxy layer.",
		}, []string{"layer"}),
		downstreamForced: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "sandbox_ingressproxy_downstream_connections_forced_closed_total",
			Help: "Total downstream client connections forcibly closed per ingressproxy layer.",
		}, []string{"layer"}),
	}
	reg.MustRegister(
		m.requests,
		m.requestDur,
		m.upstreamErrors,
		m.routeLookupErrors,
		m.connectionBlocked,
		m.inflightRequests,
		m.proxyPoolSize,
		m.poolCurrentConns,
		m.poolTotalConns,
		m.poolCloseTotal,
		m.poolResetConns,
		m.downstreamAccepted,
		m.downstreamClosed,
		m.downstreamCurrent,
		m.downstreamForced,
	)
	return m
}

func (m *IngressProxyMetrics) Layer(name string) *IngressProxyLayerMetrics {
	if strings.TrimSpace(name) == "" {
		name = "unknown"
	}
	return &IngressProxyLayerMetrics{parent: m, layer: name}
}

func (m *IngressProxyMetrics) Handler() http.Handler {
	return promhttp.HandlerFor(m.gatherer, promhttp.HandlerOpts{})
}

func (m *IngressProxyLayerMetrics) Wrap(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusCapturingResponseWriter{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(rec, r)

		pathClass := classifyPath(r.URL.Path)
		status := strconv.Itoa(rec.status)
		m.parent.requests.WithLabelValues(m.layer, r.Method, pathClass, status).Inc()
		m.parent.requestDur.WithLabelValues(m.layer, r.Method, pathClass, status).Observe(time.Since(start).Seconds())
	})
}

func (m *IngressProxyLayerMetrics) ObserveUpstreamError(class string) {
	if class == "" {
		class = "unknown"
	}
	m.parent.upstreamErrors.WithLabelValues(m.layer, class).Inc()
}

func (m *IngressProxyLayerMetrics) ObserveRouteLookupFailure(class string) {
	if class == "" {
		class = "unknown"
	}
	m.parent.routeLookupErrors.WithLabelValues(m.layer, class).Inc()
}

func (m *IngressProxyLayerMetrics) ObserveConnectionBlocked(targetKind string) {
	if targetKind == "" {
		targetKind = "unknown"
	}
	m.parent.connectionBlocked.WithLabelValues(m.layer, targetKind).Inc()
}

func (m *IngressProxyLayerMetrics) AddInFlight(targetKind string, delta int) {
	if targetKind == "" {
		targetKind = "unknown"
	}
	m.parent.inflightRequests.WithLabelValues(m.layer, targetKind).Add(float64(delta))
}

func (m *IngressProxyLayerMetrics) SetPoolSize(size int) {
	if size < 0 {
		size = 0
	}
	m.parent.proxyPoolSize.WithLabelValues(m.layer).Set(float64(size))
}

func (m *IngressProxyLayerMetrics) SetCurrentConnections(count int64) {
	if count < 0 {
		count = 0
	}
	m.parent.poolCurrentConns.WithLabelValues(m.layer).Set(float64(count))
}

func (m *IngressProxyLayerMetrics) AddTotalConnections(delta uint64) {
	if delta == 0 {
		return
	}
	m.parent.poolTotalConns.WithLabelValues(m.layer).Add(float64(delta))
}

func (m *IngressProxyLayerMetrics) ObserveCloseIdleConnections() {
	m.parent.poolCloseTotal.WithLabelValues(m.layer).Inc()
}

func (m *IngressProxyLayerMetrics) ObserveResetConnections(delta uint64) {
	if delta == 0 {
		return
	}
	m.parent.poolResetConns.WithLabelValues(m.layer).Add(float64(delta))
}

func (m *IngressProxyLayerMetrics) AddDownstreamAccepted(delta uint64) {
	if delta == 0 {
		return
	}
	m.parent.downstreamAccepted.WithLabelValues(m.layer).Add(float64(delta))
}

func (m *IngressProxyLayerMetrics) AddDownstreamClosed(delta uint64) {
	if delta == 0 {
		return
	}
	m.parent.downstreamClosed.WithLabelValues(m.layer).Add(float64(delta))
}

func (m *IngressProxyLayerMetrics) SetDownstreamCurrent(count int64) {
	if count < 0 {
		count = 0
	}
	m.parent.downstreamCurrent.WithLabelValues(m.layer).Set(float64(count))
}

func (m *IngressProxyLayerMetrics) ObserveDownstreamForceClosed(delta uint64) {
	if delta == 0 {
		return
	}
	m.parent.downstreamForced.WithLabelValues(m.layer).Add(float64(delta))
}
