package observability

import (
	"context"
	"errors"
	"time"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	otellog "go.opentelemetry.io/otel/log"
	logglobal "go.opentelemetry.io/otel/log/global"
	"go.opentelemetry.io/otel/trace"
)

type Event struct {
	Name       string
	Severity   otellog.Severity
	Body       string
	Attributes []attribute.KeyValue
}

func SanitizeEvent(event Event, sanitizer *Sanitizer) Event {
	if sanitizer == nil {
		sanitizer = NewSanitizer(SanitizerConfig{})
	}
	event.Name = sanitizer.Text(event.Name)
	event.Body = sanitizer.Text(event.Body)
	for index, item := range event.Attributes {
		switch item.Value.Type() {
		case attribute.STRING:
			event.Attributes[index] = attribute.String(string(item.Key), sanitizer.Text(item.Value.AsString()))
		case attribute.STRINGSLICE:
			values := item.Value.AsStringSlice()
			for valueIndex := range values {
				values[valueIndex] = sanitizer.Text(values[valueIndex])
			}
			event.Attributes[index] = attribute.StringSlice(string(item.Key), values)
		}
	}
	return event
}

func EmitEvent(ctx context.Context, scope string, event Event) {
	if event.Name == "" {
		return
	}
	now := time.Now().UTC()
	var record otellog.Record
	record.SetTimestamp(now)
	record.SetObservedTimestamp(now)
	record.SetEventName(event.Name)
	record.SetSeverity(event.Severity)
	record.SetSeverityText(severityText(event.Severity))
	if event.Body != "" {
		record.SetBody(otellog.StringValue(event.Body))
	}
	for _, value := range event.Attributes {
		if converted, ok := attributeToLog(value); ok {
			record.AddAttributes(converted)
		}
	}
	logglobal.GetLoggerProvider().Logger(scope).Emit(ctx, record)
}

func FinishSpan(span trace.Span, err error, errorType string, sanitizer *Sanitizer) {
	if span == nil {
		return
	}
	if err != nil {
		if sanitizer == nil {
			sanitizer = NewSanitizer(SanitizerConfig{})
		}
		message := sanitizer.Text(err.Error())
		if errorType == "" {
			errorType = "operation_failed"
		}
		safeErr := errors.New(message)
		span.SetAttributes(attribute.String("error.type", errorType))
		span.RecordError(safeErr, trace.WithAttributes(attribute.String("error.type", errorType)))
		span.SetStatus(codes.Error, message)
	}
	span.End()
}

func severityText(value otellog.Severity) string {
	switch {
	case value >= otellog.SeverityFatal:
		return "FATAL"
	case value >= otellog.SeverityError:
		return "ERROR"
	case value >= otellog.SeverityWarn:
		return "WARN"
	case value >= otellog.SeverityInfo:
		return "INFO"
	case value >= otellog.SeverityDebug:
		return "DEBUG"
	default:
		return "TRACE"
	}
}

func attributeToLog(value attribute.KeyValue) (otellog.KeyValue, bool) {
	if !value.Valid() {
		return otellog.KeyValue{}, false
	}
	key := string(value.Key)
	switch value.Value.Type() {
	case attribute.BOOL:
		return otellog.Bool(key, value.Value.AsBool()), true
	case attribute.INT64:
		return otellog.Int64(key, value.Value.AsInt64()), true
	case attribute.FLOAT64:
		return otellog.Float64(key, value.Value.AsFloat64()), true
	case attribute.STRING:
		return otellog.String(key, value.Value.AsString()), true
	case attribute.BOOLSLICE:
		items := value.Value.AsBoolSlice()
		values := make([]otellog.Value, 0, len(items))
		for _, item := range items {
			values = append(values, otellog.BoolValue(item))
		}
		return otellog.Slice(key, values...), true
	case attribute.INT64SLICE:
		items := value.Value.AsInt64Slice()
		values := make([]otellog.Value, 0, len(items))
		for _, item := range items {
			values = append(values, otellog.Int64Value(item))
		}
		return otellog.Slice(key, values...), true
	case attribute.FLOAT64SLICE:
		items := value.Value.AsFloat64Slice()
		values := make([]otellog.Value, 0, len(items))
		for _, item := range items {
			values = append(values, otellog.Float64Value(item))
		}
		return otellog.Slice(key, values...), true
	case attribute.STRINGSLICE:
		items := value.Value.AsStringSlice()
		values := make([]otellog.Value, 0, len(items))
		for _, item := range items {
			values = append(values, otellog.StringValue(item))
		}
		return otellog.Slice(key, values...), true
	default:
		return otellog.KeyValue{}, false
	}
}
