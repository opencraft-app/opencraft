package observability

import (
	"bytes"
	"context"
	"errors"
	"log"
	"strings"
	"testing"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	otellog "go.opentelemetry.io/otel/log"
	sdklog "go.opentelemetry.io/otel/sdk/log"
	sdkresource "go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	oteltrace "go.opentelemetry.io/otel/trace"
	commonv1 "go.opentelemetry.io/proto/otlp/common/v1"
	logsv1 "go.opentelemetry.io/proto/otlp/logs/v1"
	tracev1 "go.opentelemetry.io/proto/otlp/trace/v1"
	"google.golang.org/protobuf/encoding/protojson"
)

func TestSetupStdoutTelemetryEmitsCorrelatedTraceAndEvent(t *testing.T) {
	var output bytes.Buffer
	shutdown, err := SetupStdoutTracing(context.Background(), StdoutTraceConfig{
		Enabled:        true,
		ServiceName:    "llmgateway-control",
		ServiceVersion: "test-version",
		Environment:    "test",
		Writer:         &output,
		QueueSize:      16,
		BatchSize:      4,
		BatchTimeout:   time.Millisecond,
		ExportTimeout:  time.Second,
		MaxRecordBytes: 32 * 1024,
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, span := otel.Tracer(ScopeSetLifecycle).Start(context.Background(), "llmgateway.set.reconcile")
	EmitEvent(ctx, ScopeSetLifecycle, Event{
		Name:       "llmgateway.set.state_changed",
		Severity:   otellog.SeverityInfo,
		Body:       "set became ready",
		Attributes: []attribute.KeyValue{attribute.String("llmgateway.set.id", "set-a")},
	})
	span.End()
	if err := shutdown(context.Background()); err != nil {
		t.Fatal(err)
	}

	lines := nonEmptyLines(output.String())
	if len(lines) != 2 {
		t.Fatalf("lines = %d, want one span and one log\n%s", len(lines), output.String())
	}
	if !strings.Contains(output.String(), `"eventName":"llmgateway.set.state_changed"`) {
		t.Fatalf("missing OTel event name:\n%s", output.String())
	}
	if !strings.Contains(output.String(), `"service.version"`) || !strings.Contains(output.String(), "test-version") {
		t.Fatalf("missing service version resource:\n%s", output.String())
	}
}

func TestFinishSpanSanitizesStatusAndException(t *testing.T) {
	var output bytes.Buffer
	writer := newJSONLineWriter(&output, 32*1024, nil)
	sanitizer := NewSanitizer(SanitizerConfig{Secrets: []string{"admin-secret"}})
	provider := sdktrace.NewTracerProvider(sdktrace.WithSyncer(newOTLPTraceExporter(writer, sanitizer)))
	_, span := provider.Tracer(ScopeTenantEntitlement).Start(context.Background(), "llmgateway.subscription.apply")
	FinishSpan(span, errors.New("Authorization: Bearer sk-sensitive admin-secret"), "upstream_rejected", sanitizer)
	if err := provider.Shutdown(context.Background()); err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{"sk-sensitive", "admin-secret"} {
		if strings.Contains(output.String(), secret) {
			t.Fatalf("span leaked %q:\n%s", secret, output.String())
		}
	}
	if !strings.Contains(output.String(), "upstream_rejected") {
		t.Fatalf("missing stable error type:\n%s", output.String())
	}
}

func TestSanitizingWriterProtectsStandardLogger(t *testing.T) {
	var output bytes.Buffer
	writer := NewSanitizingWriter(&output, NewSanitizer(SanitizerConfig{Secrets: []string{"mysql-secret"}}))
	logger := log.New(writer, "", 0)
	logger.Printf("connect failed password=plain mysql-secret")
	if strings.Contains(output.String(), "plain") || strings.Contains(output.String(), "mysql-secret") {
		t.Fatalf("stderr writer leaked secret: %s", output.String())
	}
}

func TestOTLPJSONTraceExporterWritesOneCanonicalEnvelopePerSpan(t *testing.T) {
	var output bytes.Buffer
	writer := newJSONLineWriter(&output, 32*1024, nil)
	exporter := newOTLPTraceExporter(writer)
	resource := sdkresource.NewWithAttributes("",
		attribute.String("service.name", "llmgateway-control"),
		attribute.String("service.namespace", "llmgateway"),
	)
	provider := sdktrace.NewTracerProvider(
		sdktrace.WithResource(resource),
		sdktrace.WithSyncer(exporter),
		sdktrace.WithSampler(sdktrace.AlwaysSample()),
	)
	ctx, span := provider.Tracer(ScopeSetLifecycle).Start(context.Background(), "llmgateway.set.admission_check")
	span.SetAttributes(attribute.String("llmgateway.set.id", "set-a"))
	span.AddEvent("gate", oteltrace.WithAttributes(attribute.String("llmgateway.admission.gate", "set_plan_ready")))
	_ = ctx
	span.End()
	if err := provider.Shutdown(context.Background()); err != nil {
		t.Fatal(err)
	}

	lines := nonEmptyLines(output.String())
	if len(lines) != 1 {
		t.Fatalf("lines = %d, want 1\n%s", len(lines), output.String())
	}
	if strings.Contains(lines[0], `"ResourceSpans"`) || !strings.Contains(lines[0], `"resourceSpans"`) {
		t.Fatalf("trace payload does not use protobuf lowerCamel JSON mapping: %s", lines[0])
	}
	var request tracev1.TracesData
	if err := protojson.Unmarshal([]byte(lines[0]), &request); err != nil {
		t.Fatalf("decode OTLP trace payload: %v\n%s", err, lines[0])
	}
	spans := request.GetResourceSpans()[0].GetScopeSpans()[0].GetSpans()
	if len(spans) != 1 || spans[0].GetName() != "llmgateway.set.admission_check" {
		t.Fatalf("spans = %+v", spans)
	}
	if got := otlpAttributeString(spans[0].GetAttributes(), "llmgateway.set.id"); got != "set-a" {
		t.Fatalf("set id = %q", got)
	}
}

func TestOTLPJSONLogExporterWritesEventNameUserAndTraceContext(t *testing.T) {
	var output bytes.Buffer
	writer := newJSONLineWriter(&output, 32*1024, nil)
	traceExporter := newOTLPTraceExporter(writer)
	logExporter := newOTLPLogExporter(writer)
	resource := sdkresource.NewWithAttributes("", attribute.String("service.name", "llmgateway-control"))
	traceProvider := sdktrace.NewTracerProvider(
		sdktrace.WithResource(resource),
		sdktrace.WithSyncer(traceExporter),
		sdktrace.WithSampler(sdktrace.AlwaysSample()),
	)
	logProvider := sdklog.NewLoggerProvider(
		sdklog.WithResource(resource),
		sdklog.WithProcessor(sdklog.NewSimpleProcessor(logExporter)),
	)
	ctx, span := traceProvider.Tracer(ScopeTenantEntitlement).Start(context.Background(), "llmgateway.subscription.apply")
	var record otellog.Record
	record.SetTimestamp(time.Unix(1_700_000_000, 123).UTC())
	record.SetObservedTimestamp(time.Unix(1_700_000_000, 456).UTC())
	record.SetEventName("llmgateway.entitlement.changed")
	record.SetSeverity(otellog.SeverityInfo)
	record.SetSeverityText("INFO")
	record.SetBody(otellog.StringValue("subscription applied"))
	record.AddAttributes(
		otellog.String("llmgateway.user.id", "user-1001"),
		otellog.String("llmgateway.set.id", "set-a"),
	)
	logProvider.Logger(ScopeTenantEntitlement).Emit(ctx, record)
	span.End()
	if err := logProvider.Shutdown(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := traceProvider.Shutdown(context.Background()); err != nil {
		t.Fatal(err)
	}

	var logRequest logsv1.LogsData
	found := false
	for _, line := range nonEmptyLines(output.String()) {
		if !strings.Contains(line, `"resourceLogs"`) {
			continue
		}
		if err := protojson.Unmarshal([]byte(line), &logRequest); err != nil {
			t.Fatalf("decode OTLP log payload: %v\n%s", err, line)
		}
		found = true
	}
	if !found {
		t.Fatalf("no OTLP log payload in output:\n%s", output.String())
	}
	logs := logRequest.GetResourceLogs()[0].GetScopeLogs()[0].GetLogRecords()
	if len(logs) != 1 {
		t.Fatalf("log records = %d", len(logs))
	}
	got := logs[0]
	if got.GetEventName() != "llmgateway.entitlement.changed" {
		t.Fatalf("event name = %q", got.GetEventName())
	}
	if got.GetTraceId() == nil || got.GetSpanId() == nil {
		t.Fatalf("missing trace correlation: trace=%x span=%x", got.GetTraceId(), got.GetSpanId())
	}
	if value := otlpAttributeString(got.GetAttributes(), "llmgateway.user.id"); value != "user-1001" {
		t.Fatalf("user id = %q", value)
	}
}

func TestSanitizeTelemetryTextRemovesSecretsAndBoundsOutput(t *testing.T) {
	sanitizer := NewSanitizer(SanitizerConfig{Secrets: []string{"admin-secret-123", "redis-secret-456"}, MaxTextBytes: 96})
	raw := "Authorization: Bearer sk-live-sensitive admin-secret-123 redis-secret-456 password=plain-value https://db-user:db-pass@example.com/path?token=query-secret " + strings.Repeat("x", 200)
	got := sanitizer.Text(raw)
	for _, secret := range []string{"sk-live-sensitive", "admin-secret-123", "redis-secret-456", "plain-value", "db-user", "db-pass", "query-secret"} {
		if strings.Contains(got, secret) {
			t.Fatalf("sanitized text leaked %q: %s", secret, got)
		}
	}
	if len(got) > 96 {
		t.Fatalf("sanitized text length = %d, want <= 96", len(got))
	}
}

func TestCorrelatorUsesPurposeScopedHMACAndOmitsWhenUnconfigured(t *testing.T) {
	correlator := NewCorrelator("hash-secret", "key-2026-07")
	first, keyID, ok := correlator.Hash("subscription-idempotency", "trade:deal-1")
	if !ok || keyID != "key-2026-07" || len(first) != 24 {
		t.Fatalf("hash=%q key_id=%q ok=%v", first, keyID, ok)
	}
	second, _, _ := correlator.Hash("external-key", "trade:deal-1")
	if first == second {
		t.Fatal("correlation hashes must be purpose scoped")
	}
	if _, _, ok := NewCorrelator("", "").Hash("purpose", "secret"); ok {
		t.Fatal("unconfigured correlator must omit hashes")
	}
}

func nonEmptyLines(raw string) []string {
	var result []string
	for _, line := range strings.Split(raw, "\n") {
		if strings.TrimSpace(line) != "" {
			result = append(result, line)
		}
	}
	return result
}

func otlpAttributeString(attrs []*commonv1.KeyValue, key string) string {
	for _, attr := range attrs {
		if attr.GetKey() == key {
			return attr.GetValue().GetStringValue()
		}
	}
	return ""
}
