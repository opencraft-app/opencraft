// Package tracing ...
package tracing

import (
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"

	"ctl/pkg/context"
)

const (
	SpanAttributeKeyAction     = "action"
	SpanAttributeKeyErrorCode  = "error_code"
	SpanAttributeKeyRequestId  = "request_id"
	SpanAttributeKeyTaskName   = "task_name"
	SpanAttributeKeyTaskState  = "task_state"
	SpanAttributeKeyBypassName = "bypass_name"
)

// Span ...
type Span struct {
	trace.Span
}

// EndWithError ...
func (s *Span) EndWithError(err error) {
	if err != nil {
		s.RecordError(err)
		s.SetStatus(codes.Error, err.Error())
	}

	s.End()
}

// StartTrace ...
func StartTrace(ctx context.Context, spanName string, opts ...trace.SpanStartOption) (context.Context, *Span) {
	c, span := otel.Tracer("").Start(ctx, spanName, opts...)
	span.SetAttributes(attribute.String(SpanAttributeKeyRequestId, ctx.GetRequestId()))

	return ctx.WithContext(c), &Span{span}
}

// StartTraceForFramework adapts tracing start to taskflow-style callback signatures.
func StartTraceForFramework(ctx context.Context,
	spanName string, opts ...trace.SpanStartOption) (context.Context, trace.Span) {
	return StartTrace(ctx, spanName, opts...)
}
