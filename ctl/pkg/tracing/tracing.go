// Package tracing ...
package tracing

import (
	"context"
	"fmt"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/propagation"
	traceresource "go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.7.0"

	"ctl/pkg/config"
)

const (
	tenantidAttribute = "tps.tenant.id"
	tenantidHeader    = "X-Tps-Tenantid"
)

var tp *sdktrace.TracerProvider

// Init ...
func Init(config *config.TracingConfig, serviceName string) error {
	res, err := traceresource.New(context.Background(),
		traceresource.WithAttributes(
			semconv.ServiceNameKey.String(serviceName),
			semconv.ServiceNamespaceKey.String(config.ServiceNamespace),
			attribute.String(tenantidAttribute, config.TenantId),
		),
	)
	if err != nil {
		return fmt.Errorf("traceresource.New error: %w", err)
	}

	exporter, err := genSpanExporter(config)
	if err != nil {
		return fmt.Errorf("genSpanExporter error: %w", err)
	}

	tp = sdktrace.NewTracerProvider(
		sdktrace.WithSampler(sdktrace.AlwaysSample()),
		sdktrace.WithResource(res),
		sdktrace.WithSpanProcessor(genSpanProcessor(config, exporter)),
		sdktrace.WithIDGenerator(&traceIdGenerator{}),
	)
	otel.SetTracerProvider(tp)
	otel.SetTextMapPropagator(propagation.TraceContext{})

	return nil
}

// Shutdown ...
func Shutdown() error {
	if tp != nil {
		err := tp.Shutdown(context.Background())
		if err != nil {
			return fmt.Errorf("tp.Shutdown error: %w", err)
		}
	}

	return nil
}

func genSpanExporter(config *config.TracingConfig) (sdktrace.SpanExporter, error) {
	switch config.Protocol {
	case "grpc":
		return otlptracegrpc.New(context.Background(),
			otlptracegrpc.WithInsecure(),
			otlptracegrpc.WithEndpoint(config.GrpcEndpoint),
			otlptracegrpc.WithHeaders(map[string]string{tenantidHeader: config.TenantId}),
		)
	case "http":
		return otlptracehttp.New(context.Background(),
			otlptracehttp.WithInsecure(),
			otlptracehttp.WithEndpoint(config.HttpEndpoint),
			otlptracehttp.WithHeaders(map[string]string{tenantidHeader: config.TenantId}),
		)
	}

	return nil, fmt.Errorf("unsupport tracing protocol %s", config.Protocol)
}

func genSpanProcessor(config *config.TracingConfig, exporter sdktrace.SpanExporter) sdktrace.SpanProcessor {
	if config.Async {
		return sdktrace.NewBatchSpanProcessor(exporter)
	}
	return sdktrace.NewSimpleSpanProcessor(exporter)
}
