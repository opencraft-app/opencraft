package telemetry

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"go.opentelemetry.io/otel/propagation"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"go.opentelemetry.io/otel/trace"
)

func TestSetupExportsOTLPHTTPWhenExplicitlyConfigured(t *testing.T) {
	requests := make(chan []byte, 1)
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/v1/traces" {
			t.Errorf("OTLP path = %q, want /v1/traces", request.URL.Path)
		}
		if contentType := request.Header.Get("Content-Type"); contentType != "application/x-protobuf" {
			t.Errorf("OTLP content type = %q", contentType)
		}
		body, err := io.ReadAll(request.Body)
		if err != nil {
			t.Errorf("read OTLP request: %v", err)
		}
		requests <- body
		writer.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	t.Setenv("OTEL_EXPORTER_OTLP_ENDPOINT", server.URL)
	t.Setenv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "")
	t.Setenv("OTEL_SDK_DISABLED", "false")
	t.Setenv("OTEL_TRACES_EXPORTER", "")
	t.Setenv("OTEL_SERVICE_NAME", "hypernode-test")
	t.Setenv("OTEL_RESOURCE_ATTRIBUTES", "")

	manager, err := Setup(context.Background(), "fallback-name")
	if err != nil {
		t.Fatalf("setup telemetry: %v", err)
	}
	if !manager.Enabled() {
		t.Fatal("explicit OTLP endpoint did not enable telemetry")
	}
	handle, _ := manager.StartSpan("integration", map[string]any{"test.value": 1}, "")
	manager.EndSpan(handle, "ok", nil)
	shutdownContext, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := manager.Shutdown(shutdownContext); err != nil {
		t.Fatalf("shutdown telemetry: %v", err)
	}
	select {
	case body := <-requests:
		if len(body) == 0 {
			t.Fatal("OTLP request body is empty")
		}
	case <-time.After(time.Second):
		t.Fatal("OTLP exporter did not send a trace request")
	}
}

func TestDisabledManagerIsNoOp(t *testing.T) {
	manager := Disabled()
	handle, traceparent := manager.StartSpan("ignored", map[string]any{"value": 1}, "")
	if handle != "" || traceparent != "" || manager.Enabled() {
		t.Fatalf("disabled manager unexpectedly started a span: handle=%q traceparent=%q", handle, traceparent)
	}
	manager.AddEvent(handle, "ignored", nil)
	manager.EndSpan(handle, "ok", nil)
	if err := manager.Shutdown(context.Background()); err != nil {
		t.Fatalf("disabled shutdown failed: %v", err)
	}
}

func TestSpanHandlesPropagateW3CContextAndRedactSensitiveAttributes(t *testing.T) {
	recorder := tracetest.NewSpanRecorder()
	provider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(recorder))
	manager := &Manager{
		enabled:    true,
		tracer:     provider.Tracer("test"),
		provider:   provider,
		active:     make(map[string]trace.Span),
		propagator: propagation.TraceContext{},
	}

	parentHandle, traceparent := manager.StartSpan("parent", map[string]any{
		"server.address": "example.test",
		"authorization":  "Bearer must-not-leak",
		"request.body":   "must-not-leak",
	}, "")
	childHandle, _ := manager.StartSpan("child", map[string]any{
		"network.io.bytes": 17,
	}, traceparent)
	manager.AddEvent(childHandle, "network.read.first", map[string]any{
		"network.io.bytes": 17,
	})
	manager.EndSpan(childHandle, "ok", map[string]any{"network.io.read_count": 1})
	manager.EndSpan(parentHandle, "ok", nil)

	ended := recorder.Ended()
	if len(ended) != 2 {
		t.Fatalf("ended spans = %d, want 2", len(ended))
	}
	var parent, child sdktrace.ReadOnlySpan
	for _, span := range ended {
		switch span.Name() {
		case "parent":
			parent = span
		case "child":
			child = span
		}
	}
	if parent == nil || child == nil {
		t.Fatalf("missing parent or child span: %#v", ended)
	}
	if parent.SpanContext().TraceID() != child.SpanContext().TraceID() {
		t.Fatalf("child trace id %s does not match parent %s", child.SpanContext().TraceID(), parent.SpanContext().TraceID())
	}
	if child.Parent().SpanID() != parent.SpanContext().SpanID() {
		t.Fatalf("child parent span id %s does not match %s", child.Parent().SpanID(), parent.SpanContext().SpanID())
	}
	for _, value := range parent.Attributes() {
		if string(value.Key) == "authorization" || string(value.Key) == "request.body" {
			t.Fatalf("sensitive attribute escaped filtering: %s", value.Key)
		}
	}
	if len(child.Events()) != 1 || child.Events()[0].Name != "network.read.first" {
		t.Fatalf("child events = %#v", child.Events())
	}
}
