package observability

import (
	"context"

	otellog "go.opentelemetry.io/otel/log"
	sdklog "go.opentelemetry.io/otel/sdk/log"
	logsv1 "go.opentelemetry.io/proto/otlp/logs/v1"
)

type otlpLogExporter struct {
	writer    *jsonLineWriter
	sanitizer *Sanitizer
}

func newOTLPLogExporter(writer *jsonLineWriter, sanitizers ...*Sanitizer) *otlpLogExporter {
	return &otlpLogExporter{writer: writer, sanitizer: firstSanitizer(sanitizers)}
}

func (e *otlpLogExporter) Export(ctx context.Context, records []sdklog.Record) error {
	for index := range records {
		if err := ctx.Err(); err != nil {
			return err
		}
		if err := e.writer.WriteProto(otlpLogsData(&records[index], e.sanitizer)); err != nil {
			return err
		}
	}
	return nil
}

func (e *otlpLogExporter) Shutdown(context.Context) error   { return nil }
func (e *otlpLogExporter) ForceFlush(context.Context) error { return nil }

func otlpLogsData(record *sdklog.Record, sanitizer *Sanitizer) *logsv1.LogsData {
	attributes := make([]otellog.KeyValue, 0, record.AttributesLen())
	record.WalkAttributes(func(value otellog.KeyValue) bool {
		attributes = append(attributes, value)
		return true
	})
	traceID := record.TraceID()
	spanID := record.SpanID()
	converted := &logsv1.LogRecord{
		TimeUnixNano:           uint64(record.Timestamp().UnixNano()),
		ObservedTimeUnixNano:   uint64(record.ObservedTimestamp().UnixNano()),
		SeverityNumber:         logsv1.SeverityNumber(record.Severity()),
		SeverityText:           sanitizer.Text(record.SeverityText()),
		Body:                   otlpLogValue(record.Body(), sanitizer),
		Attributes:             otlpLogKeyValues(attributes, sanitizer),
		DroppedAttributesCount: uint32(record.DroppedAttributes()),
		Flags:                  uint32(record.TraceFlags()),
		EventName:              sanitizer.Text(record.EventName()),
	}
	if traceID.IsValid() {
		converted.TraceId = append([]byte(nil), traceID[:]...)
	}
	if spanID.IsValid() {
		converted.SpanId = append([]byte(nil), spanID[:]...)
	}
	scope := record.InstrumentationScope()
	resource := record.Resource()
	resourceSchemaURL := ""
	if resource != nil {
		resourceSchemaURL = resource.SchemaURL()
	}
	return &logsv1.LogsData{ResourceLogs: []*logsv1.ResourceLogs{{
		Resource:  otlpResource(resource, sanitizer),
		SchemaUrl: resourceSchemaURL,
		ScopeLogs: []*logsv1.ScopeLogs{{
			Scope:      otlpScope(scope, sanitizer),
			SchemaUrl:  scope.SchemaURL,
			LogRecords: []*logsv1.LogRecord{converted},
		}},
	}}}
}
