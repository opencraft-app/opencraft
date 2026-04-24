package observability

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"
	"sync"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/exporters/stdout/stdouttrace"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.37.0"
)

var telemetryOnce sync.Once

// InitStdoutTracing configures a process-local OTel tracer provider that exports
// JSON spans to stdout. Repeated calls are idempotent.
func InitStdoutTracing(serviceName string) (func(context.Context) error, error) {
	serviceName = strings.TrimSpace(serviceName)
	if serviceName == "" {
		serviceName = "sandbox"
	}

	var (
		shutdown func(context.Context) error
		initErr  error
	)
	telemetryOnce.Do(func() {
		shutdown, initErr = initStdoutTracing(serviceName, os.Stdout)
	})
	if shutdown == nil {
		shutdown = func(context.Context) error { return nil }
	}
	return shutdown, initErr
}

func initStdoutTracing(serviceName string, w io.Writer) (func(context.Context) error, error) {
	exporter, err := stdouttrace.New(
		stdouttrace.WithWriter(w),
		stdouttrace.WithPrettyPrint(),
	)
	if err != nil {
		return nil, fmt.Errorf("create stdout trace exporter: %w", err)
	}
	res, err := resource.New(
		context.Background(),
		resource.WithAttributes(
			semconv.ServiceName(serviceName),
		),
	)
	if err != nil {
		return nil, fmt.Errorf("create otel resource: %w", err)
	}
	provider := sdktrace.NewTracerProvider(
		sdktrace.WithResource(res),
		sdktrace.WithSyncer(exporter),
	)
	otel.SetTracerProvider(provider)
	return provider.Shutdown, nil
}

// EmitEvent records a zero-duration span so operational control-plane events show
// up in the stdout exporter as structured JSON. explanationZH is a human-readable
// Chinese summary carried on every event for operators reading stdout directly.
func EmitEvent(ctx context.Context, name string, explanationZH string, attrs ...attribute.KeyValue) {
	tracer := otel.Tracer("sandbox/observability")
	_, span := tracer.Start(ctx, name)
	if explanationZH = strings.TrimSpace(explanationZH); explanationZH != "" {
		attrs = append([]attribute.KeyValue{attribute.String("explanation_zh", explanationZH)}, attrs...)
	}
	span.SetAttributes(attrs...)
	span.End()
}

func AttrJSON(key string, value any) attribute.KeyValue {
	payload, err := json.Marshal(value)
	if err != nil {
		return attribute.String(key, fmt.Sprintf("marshal_error:%v", err))
	}
	return attribute.String(key, string(payload))
}
