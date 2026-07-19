package gateway

import (
	"context"
	"strconv"
	"strings"

	"git.woa.com/wisp/mono2/llmgateway/internal/observability"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	otellog "go.opentelemetry.io/otel/log"
	"go.opentelemetry.io/otel/trace"
)

type TelemetryEventEmitter func(context.Context, string, observability.Event)

func (s *Service) startTelemetrySpan(ctx context.Context, scope, name string, attrs ...attribute.KeyValue) (context.Context, trace.Span) {
	return otel.Tracer(scope).Start(ctx, name, trace.WithAttributes(attrs...))
}

func (s *Service) emitTelemetryEvent(ctx context.Context, scope string, event observability.Event) {
	if s == nil || s.telemetryEmitter == nil {
		return
	}
	s.telemetryEmitter(ctx, scope, observability.SanitizeEvent(event, s.telemetrySanitizer))
}

func (s *Service) emitOperationFailure(ctx context.Context, scope, eventName, errorType string, attrs ...attribute.KeyValue) {
	base := []attribute.KeyValue{
		attribute.String("error.type", errorType),
		attribute.String("llmgateway.transition.time", s.nowUTC().Format(timeRFC3339Nano)),
		attribute.String("llmgateway.transition.writer", "llmgateway-control"),
		attribute.String("llmgateway.outcome", "failure"),
	}
	s.emitTelemetryEvent(ctx, scope, observability.Event{
		Name:       eventName,
		Severity:   otellog.SeverityError,
		Attributes: append(base, attrs...),
	})
}

func (s *Service) emitCommittedTransition(ctx context.Context, scope, eventName, entityType, entityID, from, to string, attrs ...attribute.KeyValue) {
	if from == to {
		return
	}
	base := []attribute.KeyValue{
		attribute.String("llmgateway.entity.type", entityType),
		attribute.String("llmgateway.entity.id", entityID),
		attribute.String("llmgateway.state.from", from),
		attribute.String("llmgateway.state.to", to),
		attribute.String("llmgateway.transition.time", s.nowUTC().Format(timeRFC3339Nano)),
		attribute.String("llmgateway.transition.writer", "llmgateway-control"),
		attribute.String("llmgateway.outcome", "success"),
	}
	s.emitTelemetryEvent(ctx, scope, observability.Event{
		Name:       eventName,
		Severity:   transitionSeverity(to),
		Attributes: append(base, attrs...),
	})
}

func transitionSeverity(to string) otellog.Severity {
	switch strings.ToLower(strings.TrimSpace(to)) {
	case "error", "failed", "failure", "unknown":
		return otellog.SeverityError
	case "blocked", "conflict", "degraded", "drift", "partial", "retry":
		return otellog.SeverityWarn
	default:
		return otellog.SeverityInfo
	}
}

func telemetryInt(value int) string {
	return strconv.Itoa(value)
}

func (s *Service) emitSetDecommissionTransition(ctx context.Context, previous, current SetDecommissionJob) {
	s.emitCommittedTransition(ctx, observability.ScopeSetLifecycle, "llmgateway.set.state_changed",
		"set_decommission_job", current.ID, previous.Status, current.Status,
		attribute.String("llmgateway.run.id", current.ID),
		attribute.String("llmgateway.set.id", current.SetID),
		attribute.Int("llmgateway.attempt", current.Attempt),
		attribute.Int64("llmgateway.transition.version", current.Version),
		attribute.Int64("llmgateway.runtime.generation", current.LifecycleGeneration),
	)
}

func (s *Service) emitSetUpgradeTransition(ctx context.Context, previous, current SetUpgradeRun) {
	s.emitCommittedTransition(ctx, observability.ScopeSetLifecycle, "llmgateway.set.state_changed",
		"set_upgrade_run", current.ID, previous.Status, current.Status,
		attribute.String("llmgateway.run.id", current.ID),
		attribute.String("llmgateway.set.id", current.SetID),
		attribute.Int64("llmgateway.runtime.from_generation", current.FromGeneration),
		attribute.Int64("llmgateway.runtime.to_generation", current.ToGeneration),
	)
}

func (s *Service) emitReleaseCampaignTransition(ctx context.Context, previous, current ReleaseCampaign) {
	s.emitCommittedTransition(ctx, observability.ScopeSetLifecycle, "llmgateway.release.state_changed",
		"release_campaign", current.ID, previous.Status, current.Status,
		attribute.String("llmgateway.run.id", current.ID),
		attribute.String("llmgateway.release.id", current.TargetReleaseID),
		attribute.String("llmgateway.fleet", current.Fleet),
		attribute.String("llmgateway.ring.id", current.CurrentRingID),
	)
}

func (s *Service) emitReleaseCampaignRingTransition(ctx context.Context, previous, current ReleaseCampaignRing) {
	if current.CampaignID == "" {
		return
	}
	s.emitCommittedTransition(ctx, observability.ScopeSetLifecycle, "llmgateway.release.state_changed",
		"release_campaign_ring", current.CampaignID+":"+current.RingID, previous.Status, current.Status,
		attribute.String("llmgateway.run.id", current.CampaignID),
		attribute.String("llmgateway.ring.id", current.RingID),
		attribute.Int("llmgateway.ring.sequence", current.Sequence),
		attribute.String("llmgateway.rollout.id", current.RolloutID),
	)
}

const timeRFC3339Nano = "2006-01-02T15:04:05.999999999Z07:00"
