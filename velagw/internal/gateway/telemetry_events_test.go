package gateway

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"git.woa.com/wisp/mono2/llmgateway/internal/observability"
	"go.opentelemetry.io/otel/attribute"
	otellog "go.opentelemetry.io/otel/log"
)

type capturedTelemetryEvent struct {
	scope string
	event observability.Event
}

func TestSetAdmissionEmitsFinalCommittedStateAndSafeFailure(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		writeTestJSON(t, w, map[string]any{"success": true, "data": map[string]any{"status": true, "root_init": true}})
	}))
	defer upstream.Close()
	store := NewMemoryStore()
	if err := store.SaveSet(t.Context(), Set{
		ID: "set-a", BaseURL: upstream.URL, Status: SetStatusActive, Setup: true,
		AdminUserID: 1, AdminAccessToken: "admin-secret", AdmissionStatus: SetAdmissionStatusPending,
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.SavePlan(t.Context(), Plan{ID: "missing-plan", Name: "Missing", IsActive: true}); err != nil {
		t.Fatal(err)
	}
	emitter, events := captureTelemetryEvents()
	svc := NewService(store, upstream.Client().Transport, Options{TelemetryEmitter: emitter})

	if _, err := svc.CheckSetAdmission(t.Context(), "set-a"); err == nil {
		t.Fatal("expected admission failure")
	}
	if len(*events) != 2 {
		t.Fatalf("events = %d, want state transition and failed operation: %+v", len(*events), *events)
	}
	stateEvent := (*events)[0].event
	if stateEvent.Name != "llmgateway.set.state_changed" {
		t.Fatalf("first event = %q", stateEvent.Name)
	}
	requireTelemetryString(t, stateEvent, "llmgateway.entity.type", "set_admission")
	requireTelemetryString(t, stateEvent, "llmgateway.state.from", SetAdmissionStatusPending)
	requireTelemetryString(t, stateEvent, "llmgateway.state.to", SetAdmissionStatusFailed)
	failureEvent := (*events)[1].event
	if failureEvent.Name != "llmgateway.set.operation_failed" {
		t.Fatalf("second event = %q", failureEvent.Name)
	}
	requireTelemetryString(t, failureEvent, "error.type", "set_admission_failed")
	if failureEvent.Body != "" {
		t.Fatalf("failure event leaked free-form body: %q", failureEvent.Body)
	}
}

func captureTelemetryEvents() (TelemetryEventEmitter, *[]capturedTelemetryEvent) {
	events := []capturedTelemetryEvent{}
	return func(_ context.Context, scope string, event observability.Event) {
		events = append(events, capturedTelemetryEvent{scope: scope, event: event})
	}, &events
}

func telemetryAttributeValue(event observability.Event, key string) (attribute.Value, bool) {
	for _, item := range event.Attributes {
		if string(item.Key) == key {
			return item.Value, true
		}
	}
	return attribute.Value{}, false
}

func requireTelemetryString(t *testing.T, event observability.Event, key, want string) {
	t.Helper()
	value, ok := telemetryAttributeValue(event, key)
	if !ok {
		t.Fatalf("telemetry attribute %q is missing from %+v", key, event.Attributes)
	}
	if got := value.AsString(); got != want {
		t.Fatalf("telemetry attribute %q = %q, want %q", key, got, want)
	}
}

func TestRuntimeHAProjectionEmitsOneCommittedTransition(t *testing.T) {
	store := NewMemoryStore()
	mustSaveSet(t, store, Set{
		ID: "set-ha", BaseURL: "http://set-ha", Status: SetStatusActive,
		RuntimeHAStatus: SetRuntimeHAHealthy, RuntimeHADesiredReplicas: 2,
		RuntimeHAReadyReplicas: 2, RuntimeHAPDBHealthy: true,
	})
	emitter, events := captureTelemetryEvents()
	svc := NewService(store, nil, Options{TelemetryEmitter: emitter})
	fact := SetReconcileFact{
		SetID: "set-ha", RuntimeHAStatus: SetRuntimeHADegraded,
		RuntimeHADesiredReplicas: 2, RuntimeHAReadyReplicas: 1,
		RuntimeHAPDBHealthy: false, RuntimeHATopologyKey: "topology.kubernetes.io/zone",
		RuntimeHAError: "ready replicas 1 below desired 2",
	}

	if err := svc.projectSetRuntimeConfig(t.Context(), fact); err != nil {
		t.Fatal(err)
	}
	if len(*events) != 1 {
		t.Fatalf("events = %d, want one runtime HA transition: %+v", len(*events), *events)
	}
	got := (*events)[0]
	if got.scope != observability.ScopeSetLifecycle || got.event.Name != "llmgateway.set.state_changed" {
		t.Fatalf("unexpected telemetry event: %+v", got)
	}
	if got.event.Severity != otellog.SeverityWarn {
		t.Fatalf("severity = %v, want WARN", got.event.Severity)
	}
	requireTelemetryString(t, got.event, "llmgateway.entity.type", "set_runtime_ha")
	requireTelemetryString(t, got.event, "llmgateway.entity.id", "set-ha")
	requireTelemetryString(t, got.event, "llmgateway.set.id", "set-ha")
	requireTelemetryString(t, got.event, "llmgateway.state.from", SetRuntimeHAHealthy)
	requireTelemetryString(t, got.event, "llmgateway.state.to", SetRuntimeHADegraded)

	if err := svc.projectSetRuntimeConfig(t.Context(), fact); err != nil {
		t.Fatal(err)
	}
	if len(*events) != 1 {
		t.Fatalf("unchanged runtime HA state emitted telemetry: %+v", *events)
	}
}

func TestSetProvisionStatusEmitsCommittedTransitionOnlyAfterChange(t *testing.T) {
	store := NewMemoryStore()
	if err := store.SaveSetProvisionRequest(t.Context(), SetProvisionRequest{
		ID: "request-a", SetID: "set-a", ShardRef: "shard-a", Status: SetProvisionStatusPending,
	}); err != nil {
		t.Fatal(err)
	}
	emitter, events := captureTelemetryEvents()
	svc := NewService(store, nil, Options{TelemetryEmitter: emitter})

	if _, err := svc.UpdateSetProvisionRequestStatus(t.Context(), "request-a", SetProvisionStatusProvisioning, ""); err != nil {
		t.Fatal(err)
	}
	if len(*events) != 1 {
		t.Fatalf("events = %d, want 1", len(*events))
	}
	got := (*events)[0]
	if got.scope != observability.ScopeSetLifecycle || got.event.Name != "llmgateway.set.state_changed" {
		t.Fatalf("unexpected telemetry event: %+v", got)
	}
	requireTelemetryString(t, got.event, "llmgateway.entity.type", "set_provision_request")
	requireTelemetryString(t, got.event, "llmgateway.entity.id", "request-a")
	requireTelemetryString(t, got.event, "llmgateway.set.id", "set-a")
	requireTelemetryString(t, got.event, "llmgateway.shard.id", "shard-a")
	requireTelemetryString(t, got.event, "llmgateway.state.from", SetProvisionStatusPending)
	requireTelemetryString(t, got.event, "llmgateway.state.to", SetProvisionStatusProvisioning)

	if _, err := svc.UpdateSetProvisionRequestStatus(t.Context(), "request-a", SetProvisionStatusProvisioning, ""); err != nil {
		t.Fatal(err)
	}
	if len(*events) != 1 {
		t.Fatalf("no-op status update emitted telemetry: %+v", *events)
	}
}

func TestSubscriptionAndKeyEventsIncludeInternalUserID(t *testing.T) {
	// The existing subscription fixture exercises the real new-api API contract.
	fixture := newSubscriptionFixture(t)
	defer fixture.server.Close()
	store := NewMemoryStore()
	emitter, events := captureTelemetryEvents()
	svc := NewService(store, fixture.server.Client().Transport, Options{
		TelemetryEmitter:    emitter,
		TelemetryCorrelator: observability.NewCorrelator("hash-secret", "hash-key-1"),
	})
	fixture.registerBootstrappedSet(t, svc, store)
	if err := store.SavePlanMapping(t.Context(), PlanMapping{
		ID: "plan-pro", Name: "Pro", MonthlyTokens: 1000, PeriodValue: 1, PeriodUnit: "months",
		IsActive: true, UpstreamPlanIDs: map[string]int{"set-a": 7},
	}); err != nil {
		t.Fatal(err)
	}

	if _, err := svc.ApplySubscription(t.Context(), ApplySubscriptionRequest{
		IdempotencyKey: "trade:telemetry", UserID: "internal-user-42", PlanID: "plan-pro",
	}); err != nil {
		t.Fatal(err)
	}

	found := false
	idempotencyStates := []string{}
	for _, captured := range *events {
		if captured.event.Name == "llmgateway.subscription_idempotency.state_changed" {
			to, _ := telemetryAttributeValue(captured.event, "llmgateway.state.to")
			idempotencyStates = append(idempotencyStates, to.AsString())
			requireTelemetryString(t, captured.event, "llmgateway.user.id", "internal-user-42")
			hash, ok := telemetryAttributeValue(captured.event, "llmgateway.subscription.idempotency_hash")
			if !ok || len(hash.AsString()) != 24 || hash.AsString() == "trade:telemetry" {
				t.Fatalf("unsafe idempotency correlation hash: %v", hash)
			}
		}
		if captured.event.Name != "llmgateway.entitlement.changed" {
			continue
		}
		found = true
		if captured.scope != observability.ScopeTenantEntitlement {
			t.Fatalf("scope = %q", captured.scope)
		}
		requireTelemetryString(t, captured.event, "llmgateway.user.id", "internal-user-42")
		requireTelemetryString(t, captured.event, "llmgateway.plan.id", "plan-pro")
		requireTelemetryString(t, captured.event, "llmgateway.outcome", "success")
	}
	if !found {
		t.Fatalf("missing entitlement event: %+v", *events)
	}
	if len(idempotencyStates) != 2 || idempotencyStates[0] != "processing" || idempotencyStates[1] != "succeeded" {
		t.Fatalf("idempotency transitions = %v, want processing then succeeded", idempotencyStates)
	}
}

func TestKeyIssueAndRevokeEmitCommittedEvents(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method + " " + r.URL.Path {
		case "POST /api/user/login":
			writeTestJSON(t, w, map[string]any{"success": true, "data": map[string]any{"id": 42, "username": "sgw-user-42"}})
		case "GET /api/user/token":
			writeTestJSON(t, w, map[string]any{"success": true, "data": "access-secret"})
		case "POST /api/token/":
			writeTestJSON(t, w, map[string]any{"success": true})
		case "GET /api/token/search":
			writeTestJSON(t, w, map[string]any{"success": true, "data": map[string]any{"items": []map[string]any{{"id": 7, "name": r.URL.Query().Get("keyword")}}}})
		case "POST /api/token/7/key":
			writeTestJSON(t, w, map[string]any{"success": true, "data": map[string]any{"key": "sk-upstream-secret"}})
		case "DELETE /api/token/7":
			writeTestJSON(t, w, map[string]any{"success": true})
		default:
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
	}))
	defer upstream.Close()
	store := NewMemoryStore()
	if err := store.SaveSet(t.Context(), Set{
		ID: "set-a", BaseURL: upstream.URL, Status: SetStatusActive, Setup: true,
		AdminUserID: 1, AdminAccessToken: "admin-secret", AdmissionStatus: SetAdmissionStatusPassed,
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveUserBinding(t.Context(), UserBinding{
		ExternalUserID: "internal-user-42", SetID: "set-a", UpstreamUserID: 42,
		Username: "sgw-user-42", Password: "password-secret", ProvisionStatus: BindingProvisionStatusUserReady,
	}); err != nil {
		t.Fatal(err)
	}
	emitter, events := captureTelemetryEvents()
	svc := NewService(store, upstream.Client().Transport, Options{TelemetryEmitter: emitter})

	key, err := svc.CreateExternalKey(t.Context(), "internal-user-42")
	if err != nil {
		t.Fatal(err)
	}
	if err := svc.RevokeExternalKey(t.Context(), key.ExternalKeyID); err != nil {
		t.Fatal(err)
	}
	keyEvents := make([]capturedTelemetryEvent, 0, 2)
	for _, event := range *events {
		if event.event.Name == "llmgateway.key.changed" {
			keyEvents = append(keyEvents, event)
		}
	}
	if len(keyEvents) != 2 {
		t.Fatalf("key events = %d, want issue and revoke: %+v", len(keyEvents), *events)
	}
	for index, wantState := range []string{"issued", "revoked"} {
		got := keyEvents[index]
		if got.event.Name != "llmgateway.key.changed" {
			t.Fatalf("event %d = %q", index, got.event.Name)
		}
		requireTelemetryString(t, got.event, "llmgateway.user.id", "internal-user-42")
		requireTelemetryString(t, got.event, "llmgateway.external_key.id", key.ExternalKeyID)
		requireTelemetryString(t, got.event, "llmgateway.state.to", wantState)
	}
}

func TestChannelBundleRevisionEventContainsFingerprintButNotProviderKey(t *testing.T) {
	store := NewMemoryStore()
	emitter, events := captureTelemetryEvents()
	svc := NewService(store, nil, Options{TelemetryEmitter: emitter})

	bundle, err := svc.UpsertChannelBundle(t.Context(), ChannelBundle{
		ID: "golden", Name: "Golden", Spec: ChannelBundleSpec{Channels: []ChannelBundleChannel{{
			ID: "provider", Name: "Provider", Type: 1, Key: "sk-provider-secret-12345678",
			BaseURL: "https://provider.example.com", Models: "auto", Group: "default",
		}}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(*events) != 1 {
		t.Fatalf("events = %d, want 1", len(*events))
	}
	got := (*events)[0]
	if got.scope != observability.ScopeConfigConsistency || got.event.Name != "llmgateway.config.state_changed" {
		t.Fatalf("unexpected telemetry event: %+v", got)
	}
	requireTelemetryString(t, got.event, "llmgateway.entity.type", "channel_bundle_revision")
	requireTelemetryString(t, got.event, "llmgateway.channel_bundle.id", "golden")
	requireTelemetryString(t, got.event, "llmgateway.channel_bundle.revision.fingerprint", bundle.Fingerprint)
	for _, item := range got.event.Attributes {
		if item.Value.Type() == attribute.STRING && item.Value.AsString() == "sk-provider-secret-12345678" {
			t.Fatalf("provider key leaked into telemetry: %+v", got.event.Attributes)
		}
	}
}

func TestChannelBundleReleaseEmitsRunAndItemTransitions(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "Bearer sk-should-never-appear", http.StatusBadGateway)
	}))
	defer upstream.Close()
	store := NewMemoryStore()
	if err := store.SaveSet(t.Context(), Set{
		ID: "set-a", BaseURL: upstream.URL, Status: SetStatusActive, Setup: true,
		AdminUserID: 1, AdminAccessToken: "admin-secret", AdmissionStatus: SetAdmissionStatusPassed,
	}); err != nil {
		t.Fatal(err)
	}
	emitter, events := captureTelemetryEvents()
	svc := NewService(store, upstream.Client().Transport, Options{TelemetryEmitter: emitter})
	if _, err := svc.UpsertChannelBundle(t.Context(), ChannelBundle{
		ID: "golden", Name: "Golden", Spec: ChannelBundleSpec{Channels: []ChannelBundleChannel{{
			ID: "provider", Name: "Provider", Type: 1, Key: "sk-provider-secret",
			BaseURL: "https://provider.example.com", Models: "auto", Group: "default",
		}}},
	}); err != nil {
		t.Fatal(err)
	}
	*events = nil

	run, err := svc.CreateChannelBundleRelease(t.Context(), ChannelBundleReleaseInput{
		BundleID: "golden", SetIDs: []string{"set-a"}, StopOnFailure: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if run.Status != ChannelBundleReleaseStatusError {
		t.Fatalf("release status = %q, want error", run.Status)
	}
	var runFinished, itemFinished bool
	for _, captured := range *events {
		if captured.event.Name != "llmgateway.config.state_changed" {
			continue
		}
		entity, _ := telemetryAttributeValue(captured.event, "llmgateway.entity.type")
		to, _ := telemetryAttributeValue(captured.event, "llmgateway.state.to")
		switch entity.AsString() {
		case "channel_bundle_release":
			runFinished = runFinished || to.AsString() == ChannelBundleReleaseStatusError
		case "channel_bundle_release_item":
			itemFinished = itemFinished || to.AsString() == ChannelBundleReleaseStatusError
		}
		for _, item := range captured.event.Attributes {
			if item.Value.Type() == attribute.STRING && item.Value.AsString() == "sk-should-never-appear" {
				t.Fatal("release telemetry leaked upstream response")
			}
		}
	}
	if !runFinished || !itemFinished {
		t.Fatalf("missing release transitions: %+v", *events)
	}
}
