package metrics

import (
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

var (
	numericSegmentPattern = regexp.MustCompile(`^\d+$`)
	uuidSegmentPattern    = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$`)
)

type GatewayMetrics struct {
	gatherer   prometheus.Gatherer
	requests   *prometheus.CounterVec
	requestDur *prometheus.HistogramVec
}

func NewGatewayMetrics(reg prometheus.Registerer) *GatewayMetrics {
	m := &GatewayMetrics{
		gatherer: asGatherer(reg),
		requests: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "service_gateway_http_requests_total",
			Help: "Total HTTP requests handled by service-gateway.",
		}, []string{"method", "route", "endpoint", "status"}),
		requestDur: prometheus.NewHistogramVec(prometheus.HistogramOpts{
			Name:    "service_gateway_http_request_duration_seconds",
			Help:    "HTTP request latency for service-gateway.",
			Buckets: prometheus.DefBuckets,
		}, []string{"method", "route", "endpoint", "status"}),
	}

	reg.MustRegister(m.requests, m.requestDur)
	return m
}

func (m *GatewayMetrics) Handler() http.Handler {
	return promhttp.HandlerFor(m.gatherer, promhttp.HandlerOpts{})
}

func (m *GatewayMetrics) ObserveRequest(method, route, endpoint string, status int, duration time.Duration) {
	if route == "" {
		route = "unmatched"
	}
	endpoint = NormalizeEndpoint(endpoint)
	code := strconv.Itoa(status)
	m.requests.WithLabelValues(method, route, endpoint, code).Inc()
	m.requestDur.WithLabelValues(method, route, endpoint, code).Observe(duration.Seconds())
}

func NormalizeEndpoint(path string) string {
	if path == "" {
		return "/"
	}

	parts := strings.Split(path, "/")
	for i, part := range parts {
		if part == "" {
			continue
		}
		switch {
		case numericSegmentPattern.MatchString(part):
			parts[i] = ":id"
		case uuidSegmentPattern.MatchString(part):
			parts[i] = ":id"
		case looksDynamicIdentifier(part):
			parts[i] = ":id"
		}
	}

	normalized := strings.Join(parts, "/")
	if normalized == "" {
		return "/"
	}
	return normalized
}

func looksDynamicIdentifier(segment string) bool {
	if len(segment) < 16 {
		return false
	}

	hasDigit := false
	for _, r := range segment {
		switch {
		case r >= '0' && r <= '9':
			hasDigit = true
		case r >= 'a' && r <= 'z':
		case r >= 'A' && r <= 'Z':
		case r == '-' || r == '_':
		default:
			return false
		}
	}
	return hasDigit
}

func asGatherer(reg prometheus.Registerer) prometheus.Gatherer {
	if g, ok := reg.(prometheus.Gatherer); ok {
		return g
	}
	return prometheus.DefaultGatherer
}
