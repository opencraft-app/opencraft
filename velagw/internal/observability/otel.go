package observability

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	logglobal "go.opentelemetry.io/otel/log/global"
	"go.opentelemetry.io/otel/propagation"
	sdklog "go.opentelemetry.io/otel/sdk/log"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
)

const (
	defaultQueueSize       = 1024
	defaultBatchSize       = 64
	defaultBatchTimeout    = time.Second
	defaultExportTimeout   = 5 * time.Second
	defaultShutdownTimeout = 5 * time.Second
	defaultMaxRecordBytes  = 32 * 1024
)

type StdoutTraceConfig struct {
	Enabled         bool
	ServiceName     string
	ServiceVersion  string
	Environment     string
	PrettyPrint     bool
	Writer          io.Writer
	QueueSize       int
	BatchSize       int
	BatchTimeout    time.Duration
	ExportTimeout   time.Duration
	ShutdownTimeout time.Duration
	MaxRecordBytes  int
	ClusterName     string
	NamespaceName   string
	PodName         string
	PodUID          string
	ContainerName   string
	CloudRegion     string
	Sanitizer       *Sanitizer
	DropCounters    *DropCounters
}

func SetupStdoutTracing(ctx context.Context, config StdoutTraceConfig) (func(context.Context) error, error) {
	if !config.Enabled {
		return func(context.Context) error { return nil }, nil
	}
	if config.PrettyPrint {
		return nil, fmt.Errorf("pretty printed OTel stdout is not supported")
	}
	config = normalizeStdoutTraceConfig(config)
	res, err := resource.New(ctx, resource.WithAttributes(resourceAttributes(config)...))
	if err != nil {
		return nil, fmt.Errorf("create telemetry resource: %w", err)
	}
	writer := newJSONLineWriter(config.Writer, config.MaxRecordBytes, config.DropCounters)
	traceExporter := newOTLPTraceExporter(writer, config.Sanitizer)
	logExporter := newOTLPLogExporter(writer, config.Sanitizer)
	traceProcessor := sdktrace.NewBatchSpanProcessor(traceExporter,
		sdktrace.WithMaxQueueSize(config.QueueSize),
		sdktrace.WithMaxExportBatchSize(config.BatchSize),
		sdktrace.WithBatchTimeout(config.BatchTimeout),
		sdktrace.WithExportTimeout(config.ExportTimeout),
	)
	traceProvider := sdktrace.NewTracerProvider(
		sdktrace.WithResource(res),
		sdktrace.WithSampler(sdktrace.AlwaysSample()),
		sdktrace.WithSpanProcessor(traceProcessor),
	)
	logProcessor := sdklog.NewBatchProcessor(logExporter,
		sdklog.WithMaxQueueSize(config.QueueSize),
		sdklog.WithExportMaxBatchSize(config.BatchSize),
		sdklog.WithExportInterval(config.BatchTimeout),
		sdklog.WithExportTimeout(config.ExportTimeout),
	)
	logProvider := sdklog.NewLoggerProvider(
		sdklog.WithResource(res),
		sdklog.WithProcessor(logProcessor),
	)
	otel.SetTracerProvider(traceProvider)
	logglobal.SetLoggerProvider(logProvider)
	otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(
		propagation.TraceContext{},
		propagation.Baggage{},
	))

	return func(shutdownCtx context.Context) error {
		if _, ok := shutdownCtx.Deadline(); !ok {
			var cancel context.CancelFunc
			shutdownCtx, cancel = context.WithTimeout(shutdownCtx, config.ShutdownTimeout)
			defer cancel()
		}
		return errors.Join(logProvider.Shutdown(shutdownCtx), traceProvider.Shutdown(shutdownCtx))
	}, nil
}

func normalizeStdoutTraceConfig(config StdoutTraceConfig) StdoutTraceConfig {
	if config.ServiceName == "" {
		config.ServiceName = "llmgateway"
	}
	if config.ServiceVersion == "" {
		config.ServiceVersion = "dev"
	}
	if config.Environment == "" {
		config.Environment = "local"
	}
	if config.Writer == nil {
		config.Writer = os.Stdout
	}
	if config.QueueSize <= 0 {
		config.QueueSize = defaultQueueSize
	}
	if config.BatchSize <= 0 || config.BatchSize > config.QueueSize {
		config.BatchSize = min(defaultBatchSize, config.QueueSize)
	}
	if config.BatchTimeout <= 0 {
		config.BatchTimeout = defaultBatchTimeout
	}
	if config.ExportTimeout <= 0 {
		config.ExportTimeout = defaultExportTimeout
	}
	if config.ShutdownTimeout <= 0 {
		config.ShutdownTimeout = defaultShutdownTimeout
	}
	if config.MaxRecordBytes <= 0 {
		config.MaxRecordBytes = defaultMaxRecordBytes
	}
	if config.Sanitizer == nil {
		config.Sanitizer = NewSanitizer(SanitizerConfig{})
	}
	if config.DropCounters == nil {
		config.DropCounters = &DropCounters{}
	}
	return config
}

func resourceAttributes(config StdoutTraceConfig) []attribute.KeyValue {
	attributes := []attribute.KeyValue{
		attribute.String("service.name", config.ServiceName),
		attribute.String("service.namespace", "llmgateway"),
		attribute.String("service.version", config.ServiceVersion),
		attribute.String("deployment.environment.name", config.Environment),
	}
	optional := []struct {
		key   string
		value string
	}{
		{"k8s.cluster.name", config.ClusterName},
		{"k8s.namespace.name", config.NamespaceName},
		{"k8s.pod.name", config.PodName},
		{"k8s.pod.uid", config.PodUID},
		{"k8s.container.name", config.ContainerName},
		{"cloud.region", config.CloudRegion},
	}
	for _, item := range optional {
		if item.value != "" {
			attributes = append(attributes, attribute.String(item.key, item.value))
		}
	}
	return attributes
}
