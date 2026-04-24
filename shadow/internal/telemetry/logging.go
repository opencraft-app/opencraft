package telemetry

import (
	"context"
	"io"
	"os"
	"time"

	"go.opentelemetry.io/otel/attribute"
	stdoutlog "go.opentelemetry.io/otel/exporters/stdout/stdoutlog"
	otellog "go.opentelemetry.io/otel/log"
	logglobal "go.opentelemetry.io/otel/log/global"
	sdklog "go.opentelemetry.io/otel/sdk/log"
	"go.opentelemetry.io/otel/sdk/resource"
)

type Options struct {
	ServiceName string
	Platform    string
	Provider    string
	Writer      io.Writer
}

func Init(opts Options) (func() error, error) {
	if opts.ServiceName == "" {
		opts.ServiceName = "shadowd"
	}
	if opts.Writer == nil {
		opts.Writer = os.Stdout
	}

	res, err := resource.New(context.Background(),
		resource.WithAttributes(resourceAttributes(opts)...),
	)
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

	previous := logglobal.GetLoggerProvider()
	logglobal.SetLoggerProvider(provider)

	return func() error {
		defer logglobal.SetLoggerProvider(previous)

		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		return provider.Shutdown(ctx)
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

func resourceAttributes(opts Options) []attribute.KeyValue {
	attrs := []attribute.KeyValue{
		attribute.String("service.name", opts.ServiceName),
	}
	if opts.Platform != "" {
		attrs = append(attrs, attribute.String("shadow.platform", opts.Platform))
	}
	if opts.Provider != "" {
		attrs = append(attrs, attribute.String("shadow.provider", opts.Provider))
	}
	return attrs
}
