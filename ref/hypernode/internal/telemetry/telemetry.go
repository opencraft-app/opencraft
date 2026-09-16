package telemetry

import (
	"context"
	"fmt"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/trace"
)

const (
	maxAttributes       = 32
	maxAttributeKeySize = 128
	maxAttributeValue   = 512
	maxEventNameSize    = 128
	maxSpanNameSize     = 128
)

// Manager is the deliberately small observability boundary shared by the Go
// host and QuickJS. It owns opaque span handles so JavaScript never needs an
// OpenTelemetry runtime or SDK of its own.
type Manager struct {
	enabled    bool
	tracer     trace.Tracer
	provider   *sdktrace.TracerProvider
	propagator propagation.TextMapPropagator

	next   atomic.Uint64
	mu     sync.Mutex
	active map[string]trace.Span
}

// Setup enables OTLP/HTTP tracing only when an endpoint was explicitly
// configured. This avoids OpenTelemetry's localhost exporter default from
// changing production behavior merely because the SDK is linked in.
func Setup(ctx context.Context, serviceName string) (*Manager, error) {
	if telemetryDisabled() || !otlpEndpointConfigured() {
		return Disabled(), nil
	}
	if configured := strings.TrimSpace(os.Getenv("OTEL_SERVICE_NAME")); configured != "" {
		serviceName = configured
	}
	exporter, err := otlptracehttp.New(ctx)
	if err != nil {
		return nil, fmt.Errorf("create OTLP/HTTP trace exporter: %w", err)
	}
	serviceResource, err := resource.New(ctx, resource.WithAttributes(
		attribute.String("service.name", serviceName),
		attribute.Int("process.pid", os.Getpid()),
	))
	if err != nil {
		return nil, fmt.Errorf("create telemetry resource: %w", err)
	}
	merged, err := resource.Merge(resource.Default(), serviceResource)
	if err != nil {
		return nil, fmt.Errorf("merge telemetry resource: %w", err)
	}
	provider := sdktrace.NewTracerProvider(
		sdktrace.WithBatcher(exporter),
		sdktrace.WithResource(merged),
	)
	propagator := propagation.NewCompositeTextMapPropagator(
		propagation.TraceContext{},
		propagation.Baggage{},
	)
	otel.SetTracerProvider(provider)
	otel.SetTextMapPropagator(propagator)
	return &Manager{
		enabled:    true,
		tracer:     provider.Tracer("hypernode/internal/telemetry"),
		provider:   provider,
		propagator: propagator,
		active:     make(map[string]trace.Span),
	}, nil
}

func Disabled() *Manager {
	return &Manager{
		active:     make(map[string]trace.Span),
		propagator: propagation.TraceContext{},
	}
}

func (m *Manager) Enabled() bool {
	return m != nil && m.enabled
}

// StartSpan returns an opaque handle and a W3C traceparent value. parent is
// optional and, when present, is interpreted using the standard propagator.
func (m *Manager) StartSpan(name string, attributes map[string]any, parent string) (string, string) {
	if !m.Enabled() {
		return "", ""
	}
	ctx := context.Background()
	if parent != "" {
		ctx = m.textMapPropagator().Extract(ctx, propagation.MapCarrier{"traceparent": parent})
	}
	ctx, span := m.tracer.Start(ctx, bounded(name, maxSpanNameSize),
		trace.WithAttributes(safeAttributes(attributes)...))
	handle := strconv.FormatUint(m.next.Add(1), 36)
	m.mu.Lock()
	m.active[handle] = span
	m.mu.Unlock()
	carrier := propagation.MapCarrier{}
	m.textMapPropagator().Inject(ctx, carrier)
	return handle, carrier.Get("traceparent")
}

func (m *Manager) textMapPropagator() propagation.TextMapPropagator {
	if m != nil && m.propagator != nil {
		return m.propagator
	}
	return propagation.TraceContext{}
}

func (m *Manager) AddEvent(handle, name string, attributes map[string]any) {
	span := m.span(handle)
	if span == nil {
		return
	}
	span.AddEvent(bounded(name, maxEventNameSize), trace.WithAttributes(safeAttributes(attributes)...))
}

func (m *Manager) EndSpan(handle, status string, attributes map[string]any) {
	if m == nil || handle == "" {
		return
	}
	m.mu.Lock()
	span := m.active[handle]
	delete(m.active, handle)
	m.mu.Unlock()
	if span == nil {
		return
	}
	if values := safeAttributes(attributes); len(values) > 0 {
		span.SetAttributes(values...)
	}
	switch strings.ToLower(status) {
	case "ok", "completed", "success":
		span.SetStatus(codes.Ok, "")
	case "error", "failed", "cancelled", "canceled":
		span.SetStatus(codes.Error, bounded(status, maxAttributeValue))
	}
	span.End()
}

func (m *Manager) Shutdown(ctx context.Context) error {
	if m == nil {
		return nil
	}
	m.mu.Lock()
	active := m.active
	m.active = make(map[string]trace.Span)
	m.mu.Unlock()
	for _, span := range active {
		span.SetStatus(codes.Error, "telemetry shutdown")
		span.End()
	}
	if m.provider == nil {
		return nil
	}
	return m.provider.Shutdown(ctx)
}

func (m *Manager) span(handle string) trace.Span {
	if m == nil || handle == "" {
		return nil
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.active[handle]
}

func otlpEndpointConfigured() bool {
	return strings.TrimSpace(os.Getenv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT")) != "" ||
		strings.TrimSpace(os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT")) != ""
}

func telemetryDisabled() bool {
	disabled, _ := strconv.ParseBool(os.Getenv("OTEL_SDK_DISABLED"))
	if disabled {
		return true
	}
	for _, exporter := range strings.Split(os.Getenv("OTEL_TRACES_EXPORTER"), ",") {
		if strings.EqualFold(strings.TrimSpace(exporter), "none") {
			return true
		}
	}
	return false
}

func safeAttributes(values map[string]any) []attribute.KeyValue {
	if len(values) == 0 {
		return nil
	}
	keys := make([]string, 0, len(values))
	for key := range values {
		if safeAttributeKey(key) {
			keys = append(keys, key)
		}
	}
	sort.Strings(keys)
	if len(keys) > maxAttributes {
		keys = keys[:maxAttributes]
	}
	result := make([]attribute.KeyValue, 0, len(keys))
	for _, key := range keys {
		name := attribute.Key(bounded(key, maxAttributeKeySize))
		switch value := values[key].(type) {
		case string:
			result = append(result, name.String(bounded(value, maxAttributeValue)))
		case bool:
			result = append(result, name.Bool(value))
		case int:
			result = append(result, name.Int(value))
		case int32:
			result = append(result, name.Int64(int64(value)))
		case int64:
			result = append(result, name.Int64(value))
		case uint:
			result = append(result, name.Int64(int64(value)))
		case uint32:
			result = append(result, name.Int64(int64(value)))
		case uint64:
			if value <= uint64(^uint64(0)>>1) {
				result = append(result, name.Int64(int64(value)))
			}
		case float32:
			result = append(result, name.Float64(float64(value)))
		case float64:
			result = append(result, name.Float64(value))
		case time.Duration:
			result = append(result, name.Int64(value.Milliseconds()))
		}
	}
	return result
}

func safeAttributeKey(key string) bool {
	normalized := strings.ToLower(strings.NewReplacer("-", "_", ".", "_").Replace(key))
	for _, forbidden := range []string{
		"authorization", "api_key", "apikey", "access_token", "refresh_token",
		"cookie", "header", "payload", "request_body", "response_body",
		"prompt", "message_text", "content",
	} {
		if strings.Contains(normalized, forbidden) {
			return false
		}
	}
	return strings.TrimSpace(key) != ""
}

func bounded(value string, limit int) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return "unknown"
	}
	if len(value) <= limit {
		return value
	}
	return value[:limit]
}
