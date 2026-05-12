package audit

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"time"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/exporters/otlp/otlplog/otlploghttp"
	otellog "go.opentelemetry.io/otel/log"
	sdklog "go.opentelemetry.io/otel/sdk/log"
	"go.opentelemetry.io/otel/sdk/resource"

	"github.com/openclaw/openclaw/mono/cloudladdergateway/internal/config"
	"github.com/openclaw/openclaw/mono/shared/cloudladdertransport"
)

type Auditor interface {
	Record(context.Context, Event)
}

type Event struct {
	Timestamp         time.Time     `json:"timestamp"`
	RequestID         string        `json:"request_id"`
	Caller            string        `json:"caller"`
	Operation         string        `json:"operation"`
	Method            string        `json:"method"`
	Path              string        `json:"path"`
	Query             string        `json:"query,omitempty"`
	UpstreamURL       string        `json:"upstream_url,omitempty"`
	StatusCode        int           `json:"status_code"`
	Duration          time.Duration `json:"-"`
	DurationMS        int64         `json:"duration_ms"`
	Error             string        `json:"error,omitempty"`
	RequestBodyBytes  int           `json:"request_body_bytes"`
	RequestBodySHA256 string        `json:"request_body_sha256,omitempty"`
	ResponseBodyBytes int           `json:"response_body_bytes"`
	WebhookCount      int           `json:"webhook_count"`
}

type ShutdownFunc func(context.Context) error

type multiAuditor struct {
	sinks []Auditor
}

func New(ctx context.Context, cfg config.AuditConfig, stdout io.Writer) (Auditor, ShutdownFunc, error) {
	if stdout == nil {
		stdout = os.Stdout
	}
	sinks := []Auditor{}
	shutdowns := []ShutdownFunc{}
	if cfg.Stdout {
		sinks = append(sinks, stdoutAuditor{writer: stdout})
	}
	if cfg.OTLP.Enabled {
		otelSink, shutdown, err := newOTLPAuditor(ctx, cfg)
		if err != nil {
			return nil, nil, err
		}
		sinks = append(sinks, otelSink)
		shutdowns = append(shutdowns, shutdown)
	}
	if len(sinks) == 0 {
		sinks = append(sinks, noopAuditor{})
	}
	return multiAuditor{sinks: sinks}, func(ctx context.Context) error {
		var outErr error
		for _, shutdown := range shutdowns {
			if err := shutdown(ctx); err != nil && outErr == nil {
				outErr = err
			}
		}
		return outErr
	}, nil
}

func (m multiAuditor) Record(ctx context.Context, event Event) {
	event = normalizeEvent(event)
	for _, sink := range m.sinks {
		sink.Record(ctx, event)
	}
}

type noopAuditor struct{}

func (noopAuditor) Record(context.Context, Event) {}

type stdoutAuditor struct {
	writer io.Writer
}

func (a stdoutAuditor) Record(_ context.Context, event Event) {
	event = normalizeEvent(event)
	payload, err := json.Marshal(event)
	if err != nil {
		fmt.Fprintf(a.writer, "cloudladdergateway audit marshal failed: %v\n", err)
		return
	}
	fmt.Fprintf(a.writer, "%s\n", payload)
}

type otlpAuditor struct {
	logger otellog.Logger
}

func newOTLPAuditor(ctx context.Context, cfg config.AuditConfig) (Auditor, ShutdownFunc, error) {
	options := []otlploghttp.Option{}
	if cfg.OTLP.EndpointURL != "" {
		options = append(options, otlploghttp.WithEndpointURL(cfg.OTLP.EndpointURL))
	}
	if cfg.OTLP.Endpoint != "" {
		options = append(options, otlploghttp.WithEndpoint(cfg.OTLP.Endpoint))
	}
	if cfg.OTLP.Insecure {
		options = append(options, otlploghttp.WithInsecure())
	}
	if len(cfg.OTLP.Headers) > 0 {
		options = append(options, otlploghttp.WithHeaders(cfg.OTLP.Headers))
	}
	if timeout, err := config.ParseDuration(cfg.OTLP.Timeout, 10*time.Second); err != nil {
		return nil, nil, err
	} else {
		options = append(options, otlploghttp.WithTimeout(timeout))
	}

	exporter, err := otlploghttp.New(ctx, options...)
	if err != nil {
		return nil, nil, err
	}
	res, err := resource.New(ctx, resource.WithAttributes(attribute.String("service.name", serviceName(cfg))))
	if err != nil {
		return nil, nil, err
	}
	provider := sdklog.NewLoggerProvider(
		sdklog.WithResource(res),
		sdklog.WithProcessor(sdklog.NewBatchProcessor(exporter)),
	)
	return otlpAuditor{logger: provider.Logger("cloudladdergateway/audit")}, provider.Shutdown, nil
}

func (a otlpAuditor) Record(ctx context.Context, event Event) {
	event = normalizeEvent(event)
	var record otellog.Record
	record.SetTimestamp(event.Timestamp)
	record.SetObservedTimestamp(time.Now())
	record.SetEventName("cloudladdergateway.audit")
	record.SetBody(otellog.StringValue("cloudladdergateway audit"))
	if event.Error != "" || event.StatusCode >= 500 {
		record.SetSeverity(otellog.SeverityError)
		record.SetSeverityText("ERROR")
	} else {
		record.SetSeverity(otellog.SeverityInfo)
		record.SetSeverityText("INFO")
	}
	record.AddAttributes(
		otellog.String("request.id", event.RequestID),
		otellog.String("caller", event.Caller),
		otellog.String("operation", event.Operation),
		otellog.String("http.request.method", event.Method),
		otellog.String("url.path", event.Path),
		otellog.String("url.query", event.Query),
		otellog.String("upstream.url", event.UpstreamURL),
		otellog.Int("http.response.status_code", event.StatusCode),
		otellog.Int64("duration.ms", event.DurationMS),
		otellog.String("error.message", event.Error),
		otellog.Int("request.body.bytes", event.RequestBodyBytes),
		otellog.String("request.body.sha256", event.RequestBodySHA256),
		otellog.Int("response.body.bytes", event.ResponseBodyBytes),
		otellog.Int("webhook.count", event.WebhookCount),
	)
	a.logger.Emit(ctx, record)
}

func normalizeEvent(event Event) Event {
	if event.Timestamp.IsZero() {
		event.Timestamp = time.Now()
	}
	if event.DurationMS == 0 && event.Duration > 0 {
		event.DurationMS = event.Duration.Milliseconds()
	}
	return event
}

func BodySHA256(body []byte) string {
	return cloudladdertransport.BodySHA256(body)
}

func serviceName(cfg config.AuditConfig) string {
	if cfg.ServiceName != "" {
		return cfg.ServiceName
	}
	return "cloudladdergateway"
}
