package telemetry

import (
	"context"
	"io"
	"os"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	stdoutlog "go.opentelemetry.io/otel/exporters/stdout/stdoutlog"
	otellog "go.opentelemetry.io/otel/log"
	logglobal "go.opentelemetry.io/otel/log/global"
	"go.opentelemetry.io/otel/propagation"
	sdklog "go.opentelemetry.io/otel/sdk/log"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
)

type Options struct {
	ServiceName string
	Writer      io.Writer
	Attributes  []attribute.KeyValue
}

func Init(opts Options) (func() error, error) {
	if opts.ServiceName == "" {
		opts.ServiceName = "cloudagent-gateway"
	}
	if opts.Writer == nil {
		opts.Writer = os.Stdout
	}
	attrs := []attribute.KeyValue{
		attribute.String("service.name", opts.ServiceName),
	}
	attrs = append(attrs, opts.Attributes...)
	if namespace := os.Getenv("OTEL_SERVICE_NAMESPACE"); namespace != "" {
		attrs = append(attrs, attribute.String("service.namespace", namespace))
	}
	if env := os.Getenv("OTEL_RESOURCE_DEPLOYMENT_ENVIRONMENT"); env != "" {
		attrs = append(attrs, attribute.String("deployment.environment.name", env))
	}
	res, err := resource.New(context.Background(), resource.WithAttributes(attrs...))
	if err != nil {
		return nil, err
	}

	exporter, err := stdoutlog.New(stdoutlog.WithWriter(opts.Writer))
	if err != nil {
		return nil, err
	}
	provider := sdklog.NewLoggerProvider(
		sdklog.WithProcessor(sdklog.NewSimpleProcessor(exporter)),
		sdklog.WithResource(res),
	)
	tracerProvider := sdktrace.NewTracerProvider(sdktrace.WithResource(res))
	previousLoggerProvider := logglobal.GetLoggerProvider()
	previousTracerProvider := otel.GetTracerProvider()
	previousPropagator := otel.GetTextMapPropagator()
	logglobal.SetLoggerProvider(provider)
	otel.SetTracerProvider(tracerProvider)
	otel.SetTextMapPropagator(propagation.TraceContext{})

	return func() error {
		defer logglobal.SetLoggerProvider(previousLoggerProvider)
		defer otel.SetTracerProvider(previousTracerProvider)
		defer otel.SetTextMapPropagator(previousPropagator)
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := provider.Shutdown(ctx); err != nil {
			_ = tracerProvider.Shutdown(ctx)
			return err
		}
		return tracerProvider.Shutdown(ctx)
	}, nil
}

func Logger(name string) otellog.Logger {
	return logglobal.Logger(name)
}

func Info(ctx context.Context, logger otellog.Logger, msg string, attrs ...otellog.KeyValue) {
	emit(ctx, logger, otellog.SeverityInfo, msg, attrs...)
}

func Warn(ctx context.Context, logger otellog.Logger, msg string, attrs ...otellog.KeyValue) {
	emit(ctx, logger, otellog.SeverityWarn, msg, attrs...)
}

func Error(ctx context.Context, logger otellog.Logger, msg string, attrs ...otellog.KeyValue) {
	emit(ctx, logger, otellog.SeverityError, msg, attrs...)
}

func emit(ctx context.Context, logger otellog.Logger, severity otellog.Severity, msg string, attrs ...otellog.KeyValue) {
	var record otellog.Record
	now := time.Now()
	record.SetTimestamp(now)
	record.SetObservedTimestamp(now)
	record.SetSeverity(severity)
	record.SetSeverityText(severity.String())
	record.SetBody(otellog.StringValue(msg))
	record.AddAttributes(attrs...)
	logger.Emit(ctx, record)
}
