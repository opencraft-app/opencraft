package wrapper

import (
	"net"
	"net/http"
	"strings"
	"time"

	"cloudagent/gateway/internal/telemetry"
	"github.com/felixge/httpsnoop"
	otellog "go.opentelemetry.io/otel/log"
)

var accessLogger = telemetry.Logger("cloudagent/gateway/http")

func withOTELAccessLog(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		startedAt := time.Now()
		metrics := httpsnoop.CaptureMetrics(next, w, r)
		statusCode := metrics.Code
		if statusCode == 0 {
			statusCode = http.StatusOK
		}

		attrs := []otellog.KeyValue{
			otellog.String("http.request.method", r.Method),
			otellog.String("url.path", r.URL.Path),
			otellog.String("http.route", routeForLog(r)),
			otellog.Int("http.response.status_code", statusCode),
			otellog.Int64("duration_ms", time.Since(startedAt).Milliseconds()),
			otellog.Int64("http.response.body.size", metrics.Written),
			otellog.String("network.protocol.name", "http"),
			otellog.String("network.protocol.version", r.Proto),
			otellog.String("client.address", clientAddress(r)),
			otellog.String("user_agent.original", r.UserAgent()),
		}
		if r.ContentLength >= 0 {
			attrs = append(attrs, otellog.Int64("http.request.body.size", r.ContentLength))
		}
		if requestID := strings.TrimSpace(r.Header.Get("X-Request-ID")); requestID != "" {
			attrs = append(attrs, otellog.String("cloudagent.request_id", requestID))
		}
		if tenantID := strings.TrimSpace(r.Header.Get("X-Tenant-ID")); tenantID != "" {
			attrs = append(attrs, otellog.String("cloudagent.tenant_id", tenantID))
		}
		if projectID := strings.TrimSpace(r.Header.Get("X-Project-ID")); projectID != "" {
			attrs = append(attrs, otellog.String("cloudagent.project_id", projectID))
		}
		if sandboxScope := strings.TrimSpace(r.Header.Get("X-Sandbox-Scope")); sandboxScope != "" {
			attrs = append(attrs, otellog.String("cloudagent.sandbox_scope", sandboxScope))
		}

		switch {
		case statusCode >= http.StatusInternalServerError:
			telemetry.Error(r.Context(), accessLogger, "gateway.http_request", attrs...)
		case statusCode >= http.StatusBadRequest:
			telemetry.Warn(r.Context(), accessLogger, "gateway.http_request", attrs...)
		default:
			telemetry.Info(r.Context(), accessLogger, "gateway.http_request", attrs...)
		}
	})
}

func routeForLog(r *http.Request) string {
	path := r.URL.Path
	switch {
	case path == "/healthz":
		return "GET /healthz"
	case path == "/readyz":
		return "GET /readyz"
	case path == "/v1/models":
		return "GET /v1/models"
	case path == "/v1/selfcheck":
		return "GET /v1/selfcheck"
	case path == "/v1/files":
		return "POST /v1/files"
	case strings.HasPrefix(path, "/v1/files/"):
		return "GET /v1/files/{file_id}/content"
	case path == "/v1/responses":
		return "POST /v1/responses"
	case strings.HasPrefix(path, "/v1/responses/"):
		return "GET /v1/responses/{response_id}"
	case path == "/v1/chat/completions":
		return "POST /v1/chat/completions"
	case strings.HasPrefix(path, "/v1/acp/sessions/"):
		return "/v1/acp/sessions/{session_id}/envd/{path}"
	case path == "/acp":
		return "/acp"
	case path == "/ws":
		return "/ws"
	default:
		return "unmatched"
	}
}

func clientAddress(r *http.Request) string {
	if forwardedFor := strings.TrimSpace(r.Header.Get("X-Forwarded-For")); forwardedFor != "" {
		first, _, _ := strings.Cut(forwardedFor, ",")
		return strings.TrimSpace(first)
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err == nil {
		return host
	}
	return r.RemoteAddr
}
