package workersapi

import (
	"net/http"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"github.com/rivet-dev/rivet/infra/cells/internal/workersapi/objectrouter"
)

type apiMetrics struct {
	handler         http.Handler
	dispatch        *prometheus.CounterVec
	objectRequests  *prometheus.CounterVec
	objectDuration  *prometheus.HistogramVec
	routingRequests *prometheus.CounterVec
	routingDuration *prometheus.HistogramVec
	routingInflight *prometheus.GaugeVec
	registrySeconds *prometheus.HistogramVec
	routeRevision   *prometheus.GaugeVec
	objectInflight  *prometheus.GaugeVec
	indeterminate   *prometheus.CounterVec
}

func newAPIMetrics(namespace string, router *objectrouter.Router[actorBinding]) *apiMetrics {
	registry := prometheus.NewRegistry()
	metrics := &apiMetrics{
		dispatch: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "worker_dispatch_requests_total",
			Help: "Stateless Worker dispatches by selected pool and bounded result.",
		}, []string{"namespace", "pool", "result"}),
		objectRequests: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "object_router_requests_total",
			Help: "Durable Object fetches by bounded source, target Cell, and result.",
		}, []string{"namespace", "source_cell", "target_cell", "result"}),
		objectDuration: prometheus.NewHistogramVec(prometheus.HistogramOpts{
			Name:    "object_router_request_duration_seconds",
			Help:    "End-to-end Durable Object fetch duration by bounded source and target Cell.",
			Buckets: []float64{0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60},
		}, []string{"namespace", "source_cell", "target_cell"}),
		routingRequests: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "workers_api_routing_requests_total",
			Help: "User fetch requests handled by the regional routing plane.",
		}, []string{"namespace", "plane", "result"}),
		routingDuration: prometheus.NewHistogramVec(prometheus.HistogramOpts{
			Name:    "workers_api_routing_request_duration_seconds",
			Help:    "End-to-end user fetch duration through the regional routing plane.",
			Buckets: []float64{0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60},
		}, []string{"namespace", "plane"}),
		routingInflight: prometheus.NewGaugeVec(prometheus.GaugeOpts{
			Name: "workers_api_routing_requests_in_flight",
			Help: "User fetch requests currently held by this regional Router replica.",
		}, []string{"namespace", "plane"}),
		registrySeconds: prometheus.NewHistogramVec(prometheus.HistogramOpts{
			Name:    "object_router_registry_seconds",
			Help:    "Registry operation latency on Object Router cache misses and lifecycle changes.",
			Buckets: []float64{0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5},
		}, []string{"namespace", "operation", "result"}),
		routeRevision: prometheus.NewGaugeVec(prometheus.GaugeOpts{
			Name: "object_router_route_revision",
			Help: "Highest Cell serving-route revision used by this Router replica.",
		}, []string{"pool", "cell"}),
		objectInflight: prometheus.NewGaugeVec(prometheus.GaugeOpts{
			Name: "object_router_inflight",
			Help: "Durable Object fetches currently proxied to each target Cell.",
		}, []string{"namespace", "target_cell"}),
		indeterminate: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "object_router_indeterminate_total",
			Help: "Object requests whose response was lost after execution may have begun.",
		}, []string{"namespace", "target_cell"}),
	}
	registry.MustRegister(
		metrics.dispatch, metrics.objectRequests, metrics.objectDuration, metrics.routingRequests,
		metrics.routingDuration, metrics.routingInflight, metrics.registrySeconds,
		metrics.routeRevision, metrics.objectInflight, metrics.indeterminate,
		prometheus.NewProcessCollector(prometheus.ProcessCollectorOpts{}),
	)
	// Keep every metric family discoverable immediately after a replica starts.
	// These bounded zero-valued series are operational sentinels, not traffic.
	metrics.dispatch.WithLabelValues(namespace, "unassigned", "success").Add(0)
	metrics.objectRequests.WithLabelValues(namespace, "unassigned", "unassigned", "success").Add(0)
	metrics.objectDuration.WithLabelValues(namespace, "unassigned", "unassigned")
	for _, plane := range []string{"stateless", "object"} {
		metrics.routingRequests.WithLabelValues(namespace, plane, "success").Add(0)
		metrics.routingDuration.WithLabelValues(namespace, plane)
		metrics.routingInflight.WithLabelValues(namespace, plane).Set(0)
	}
	metrics.registrySeconds.WithLabelValues(namespace, "resolve", "success")
	metrics.routeRevision.WithLabelValues("unassigned", "unassigned").Set(0)
	metrics.objectInflight.WithLabelValues(namespace, "unassigned").Set(0)
	metrics.indeterminate.WithLabelValues(namespace, "unassigned").Add(0)
	for _, result := range []string{"hit", "miss", "overloaded"} {
		result := result
		registry.MustRegister(prometheus.NewCounterFunc(prometheus.CounterOpts{
			Name:        "object_router_cache_requests_total",
			Help:        "Bounded Object placement cache outcomes for this Router replica.",
			ConstLabels: prometheus.Labels{"namespace": namespace, "result": result},
		}, func() float64 {
			stats := router.Stats()
			switch result {
			case "hit":
				return float64(stats.CacheHits)
			case "miss":
				return float64(stats.CacheMisses)
			default:
				return float64(stats.Overloaded)
			}
		}))
	}
	registry.MustRegister(
		prometheus.NewGaugeFunc(prometheus.GaugeOpts{
			Name:        "object_router_cache_entries",
			Help:        "Current bounded Object placement cache entries on this Router replica.",
			ConstLabels: prometheus.Labels{"namespace": namespace},
		}, func() float64 { return float64(router.Stats().Entries) }),
		prometheus.NewGaugeFunc(prometheus.GaugeOpts{
			Name:        "object_router_placement_misses_inflight",
			Help:        "Distinct process-local Object placement misses currently executing.",
			ConstLabels: prometheus.Labels{"namespace": namespace},
		}, func() float64 { return float64(router.Stats().Inflight) }),
	)
	metrics.handler = promhttp.HandlerFor(registry, promhttp.HandlerOpts{})
	return metrics
}

func (metrics *apiMetrics) beginRouting(namespace, plane string) func(int, string) {
	started := time.Now()
	inflight := metrics.routingInflight.WithLabelValues(namespace, plane)
	inflight.Inc()
	return func(status int, code string) {
		inflight.Dec()
		metrics.routingRequests.WithLabelValues(namespace, plane, metricResult(status, code)).Inc()
		metrics.routingDuration.WithLabelValues(namespace, plane).Observe(time.Since(started).Seconds())
	}
}

func (metrics *apiMetrics) observeRegistry(namespace, operation string, started time.Time, err *upstreamError) {
	result := "success"
	if err != nil {
		result = "error"
	}
	metrics.registrySeconds.WithLabelValues(namespace, operation, result).Observe(time.Since(started).Seconds())
}

func metricResult(status int, code string) string {
	if code == "indeterminate_result" {
		return "indeterminate"
	}
	if status >= 200 && status < 400 {
		return "success"
	}
	if status >= 400 && status < 500 {
		return "client_error"
	}
	return "server_error"
}

func metricPool(value string) string {
	if value == "" {
		return "unassigned"
	}
	return value
}

func metricCell(value string) string {
	if value == "" {
		return "unassigned"
	}
	return value
}

func (metrics *apiMetrics) setRouteRevision(pool, cell string, revision int64) {
	if revision > 0 {
		metrics.routeRevision.WithLabelValues(metricPool(pool), metricCell(cell)).Set(float64(revision))
	}
}

func (metrics *apiMetrics) serveHTTP(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet {
		writer.Header().Set("Allow", http.MethodGet)
		http.Error(writer, http.StatusText(http.StatusMethodNotAllowed), http.StatusMethodNotAllowed)
		return
	}
	metrics.handler.ServeHTTP(writer, request)
}
