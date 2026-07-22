package observability

import (
	"context"

	"go.opentelemetry.io/otel/codes"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	tracev1 "go.opentelemetry.io/proto/otlp/trace/v1"
)

type otlpTraceExporter struct {
	writer    *jsonLineWriter
	sanitizer *Sanitizer
}

func newOTLPTraceExporter(writer *jsonLineWriter, sanitizers ...*Sanitizer) *otlpTraceExporter {
	return &otlpTraceExporter{writer: writer, sanitizer: firstSanitizer(sanitizers)}
}

func (e *otlpTraceExporter) ExportSpans(ctx context.Context, spans []sdktrace.ReadOnlySpan) error {
	for _, span := range spans {
		if err := ctx.Err(); err != nil {
			return err
		}
		if err := e.writer.WriteProto(otlpTraceData(span, e.sanitizer)); err != nil {
			return err
		}
	}
	return nil
}

func (e *otlpTraceExporter) Shutdown(context.Context) error { return nil }

func otlpTraceData(span sdktrace.ReadOnlySpan, sanitizer *Sanitizer) *tracev1.TracesData {
	sc := span.SpanContext()
	parent := span.Parent()
	traceID := sc.TraceID()
	spanID := sc.SpanID()
	converted := &tracev1.Span{
		TraceId:                append([]byte(nil), traceID[:]...),
		SpanId:                 append([]byte(nil), spanID[:]...),
		TraceState:             sc.TraceState().String(),
		Flags:                  uint32(sc.TraceFlags()),
		Name:                   sanitizer.Text(span.Name()),
		Kind:                   tracev1.Span_SpanKind(span.SpanKind()),
		StartTimeUnixNano:      uint64(span.StartTime().UnixNano()),
		EndTimeUnixNano:        uint64(span.EndTime().UnixNano()),
		Attributes:             otlpAttributes(span.Attributes(), sanitizer),
		DroppedAttributesCount: uint32(span.DroppedAttributes()),
		DroppedEventsCount:     uint32(span.DroppedEvents()),
		DroppedLinksCount:      uint32(span.DroppedLinks()),
		Status:                 otlpSpanStatus(span.Status(), sanitizer),
	}
	if parent.IsValid() {
		parentID := parent.SpanID()
		converted.ParentSpanId = append([]byte(nil), parentID[:]...)
	}
	for _, event := range span.Events() {
		converted.Events = append(converted.Events, &tracev1.Span_Event{
			TimeUnixNano:           uint64(event.Time.UnixNano()),
			Name:                   sanitizer.Text(event.Name),
			Attributes:             otlpAttributes(event.Attributes, sanitizer),
			DroppedAttributesCount: uint32(event.DroppedAttributeCount),
		})
	}
	for _, link := range span.Links() {
		linkContext := link.SpanContext
		traceID := linkContext.TraceID()
		spanID := linkContext.SpanID()
		converted.Links = append(converted.Links, &tracev1.Span_Link{
			TraceId:                append([]byte(nil), traceID[:]...),
			SpanId:                 append([]byte(nil), spanID[:]...),
			TraceState:             linkContext.TraceState().String(),
			Flags:                  uint32(linkContext.TraceFlags()),
			Attributes:             otlpAttributes(link.Attributes, sanitizer),
			DroppedAttributesCount: uint32(link.DroppedAttributeCount),
		})
	}
	scope := span.InstrumentationScope()
	return &tracev1.TracesData{ResourceSpans: []*tracev1.ResourceSpans{{
		Resource:  otlpResource(span.Resource(), sanitizer),
		SchemaUrl: span.Resource().SchemaURL(),
		ScopeSpans: []*tracev1.ScopeSpans{{
			Scope:     otlpScope(scope, sanitizer),
			SchemaUrl: scope.SchemaURL,
			Spans:     []*tracev1.Span{converted},
		}},
	}}}
}

func otlpSpanStatus(status sdktrace.Status, sanitizer *Sanitizer) *tracev1.Status {
	code := tracev1.Status_STATUS_CODE_UNSET
	switch status.Code {
	case codes.Ok:
		code = tracev1.Status_STATUS_CODE_OK
	case codes.Error:
		code = tracev1.Status_STATUS_CODE_ERROR
	}
	return &tracev1.Status{Code: code, Message: sanitizer.Text(status.Description)}
}

func firstSanitizer(values []*Sanitizer) *Sanitizer {
	for _, value := range values {
		if value != nil {
			return value
		}
	}
	return NewSanitizer(SanitizerConfig{})
}
