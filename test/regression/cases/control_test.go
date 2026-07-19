package cases

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"git.woa.com/wisp/mono2/llmgateway/test/regression/clients"
	"git.woa.com/wisp/mono2/llmgateway/test/regression/framework"
)

func TestTenantOnboardingGateProvesChannelPlanTenantKeyAndChat(t *testing.T) {
	control := newFakeControl()
	traffic := &fakeTraffic{}
	infra := &fakeInfrastructure{}
	cfg := testConfig()
	run := framework.NewRunContext("run-123", framework.NewSanitizer())
	runner := framework.NewRunner(NewControlCases(cfg, Dependencies{Control: control, Traffic: traffic, Infrastructure: infra}), nil)

	report, err := runner.Run(t.Context(), TenantOnboardingGate(), run)
	if err != nil {
		t.Fatal(err)
	}
	if report.Status != framework.RunStatusPassed {
		t.Fatalf("report = %+v", report)
	}
	wantCalls := []string{
		"list_sets", "plan_sets", "bundle:regression-mock-channel", "bundle:golden-channels", "apply_bundle:set-a", "delivery_status",
		"list_sets",
		"assign:reg-run-123-tenant:set-a", "ensure:reg-run-123-tenant", "apply_subscription:reg-run-123-tenant:regression-monthly",
		"tenant_detail:reg-run-123-tenant", "create_key:reg-run-123-tenant", "delete_tenant:reg-run-123-tenant",
	}
	if !reflect.DeepEqual(control.calls, wantCalls) {
		t.Fatalf("control calls = %#v", control.calls)
	}
	if infra.calls != 1 {
		t.Fatalf("infrastructure preflight calls = %d", infra.calls)
	}
	if traffic.chatCalls != 2 || traffic.lastKey != "sk-regression-secret" {
		t.Fatalf("traffic = %+v", traffic)
	}
}

func TestModelConfigurationEffectiveWaitsForTrafficCache(t *testing.T) {
	control := newFakeControl()
	traffic := &fakeTraffic{chatErrors: []error{
		errors.New("model price not configured"),
		errors.New("model price not configured"),
	}}
	cfg := testConfig()
	cfg.ConsistencyTimeout = 100 * time.Millisecond
	cfg.PollInterval = time.Millisecond
	runner := framework.NewRunner(NewControlCases(cfg, Dependencies{Control: control, Traffic: traffic, Infrastructure: &fakeInfrastructure{}}), nil)

	report, err := runner.Run(t.Context(), TenantOnboardingGate(), framework.NewRunContext("run-cache", framework.NewSanitizer()))
	if err != nil {
		t.Fatal(err)
	}
	if traffic.chatCalls != 4 {
		t.Fatalf("chat calls = %d, want 2 readiness attempts + success + strict chat", traffic.chatCalls)
	}
	var effective framework.CaseResult
	for _, result := range report.Cases {
		if result.ID == "model_configuration_is_effective_on_traffic" {
			effective = result
			break
		}
	}
	if effective.Status != framework.CaseStatusPassed || effective.Observations["attempts"] != 3 {
		t.Fatalf("effective case = %+v", effective)
	}
}

func TestModelConfigurationEffectiveReportsLastTrafficErrorOnTimeout(t *testing.T) {
	control := newFakeControl()
	traffic := &fakeTraffic{chatErr: errors.New("model price not configured")}
	cfg := testConfig()
	cfg.ConsistencyTimeout = 5 * time.Millisecond
	cfg.PollInterval = time.Millisecond
	runner := framework.NewRunner(NewControlCases(cfg, Dependencies{Control: control, Traffic: traffic, Infrastructure: &fakeInfrastructure{}}), nil)

	report, err := runner.Run(t.Context(), TenantOnboardingGate(), framework.NewRunContext("run-cache-timeout", framework.NewSanitizer()))
	if err == nil || !strings.Contains(err.Error(), "model price not configured") {
		t.Fatalf("err = %v", err)
	}
	if report.Cases[4].ID != "model_configuration_is_effective_on_traffic" || report.Cases[4].Status != framework.CaseStatusFailed {
		t.Fatalf("cases = %+v", report.Cases)
	}
}

func TestPreflightAllowsOnlyRegressionBundleInitialSyncAdmissionFailure(t *testing.T) {
	control := newFakeControl()
	control.initialAdmissionStatus = "failed"
	control.initialAdmissionError = `channel bundle "regression-mock-channel" initial sync has not completed on set "set-a"`
	runner := framework.NewRunner(NewControlCases(testConfig(), Dependencies{Control: control, Traffic: &fakeTraffic{}, Infrastructure: &fakeInfrastructure{}}), nil)

	if _, err := runner.Run(t.Context(), TenantOnboardingGate(), framework.NewRunContext("run-bootstrap", framework.NewSanitizer())); err != nil {
		t.Fatal(err)
	}
}

func TestPreflightRejectsUnrelatedSetAdmissionFailure(t *testing.T) {
	control := newFakeControl()
	control.initialAdmissionStatus = "failed"
	control.initialAdmissionError = "admin endpoint is unhealthy"
	runner := framework.NewRunner(NewControlCases(testConfig(), Dependencies{Control: control, Traffic: &fakeTraffic{}, Infrastructure: &fakeInfrastructure{}}), nil)

	report, err := runner.Run(t.Context(), TenantOnboardingGate(), framework.NewRunContext("run-bad-admission", framework.NewSanitizer()))
	if err == nil || report.Cases[0].Status != framework.CaseStatusFailed || control.hasCallPrefix("apply_bundle:") {
		t.Fatalf("report=%+v err=%v calls=%v", report, err, control.calls)
	}
}

func TestTargetSetsAdmittedWaitsForRegressionBundleAdmissionRefresh(t *testing.T) {
	sets := []clients.ManagedSet{{
		ID:              "set-a",
		AdmissionStatus: "failed",
		AdmissionError:  `channel bundle "regression-mock-channel" initial sync has not completed on set "set-a"`,
	}}

	admitted, err := targetSetsAdmitted(sets, []string{"set-a"}, "regression-mock-channel")
	if err != nil || admitted {
		t.Fatalf("admitted=%v err=%v", admitted, err)
	}
}

func TestTargetSetsAdmittedRejectsUnrelatedFailure(t *testing.T) {
	sets := []clients.ManagedSet{{ID: "set-a", AdmissionStatus: "failed", AdmissionError: "admin endpoint is unhealthy"}}

	admitted, err := targetSetsAdmitted(sets, []string{"set-a"}, "regression-mock-channel")
	if err == nil || admitted {
		t.Fatalf("admitted=%v err=%v", admitted, err)
	}
}

func TestPreflightRejectsBundleWithGlobalOptionsBeforeCreatingTenant(t *testing.T) {
	control := newFakeControl()
	control.bundle.Spec.Options = append(control.bundle.Spec.Options, clients.ChannelBundleOption{Key: "RetryTimes", Value: 3})
	run := framework.NewRunContext("run-options", framework.NewSanitizer())
	runner := framework.NewRunner(NewControlCases(testConfig(), Dependencies{Control: control, Traffic: &fakeTraffic{}, Infrastructure: &fakeInfrastructure{}}), nil)

	report, err := runner.Run(t.Context(), TenantOnboardingGate(), run)
	if err == nil {
		t.Fatal("Run() error = nil")
	}
	if report.Cases[0].Status != framework.CaseStatusFailed || control.hasCallPrefix("assign:") {
		t.Fatalf("report=%+v calls=%v", report, control.calls)
	}
}

func TestRegressionPricingSnapshotAllowsOtherGoldenOptions(t *testing.T) {
	err := validateRegressionPricingSnapshot([]clients.ChannelBundleOption{
		{Key: "RetryTimes", Value: 3},
		{Key: "CompletionRatio", Value: `{"model-a":1}`},
		{Key: "ModelRatio", Value: `{"model-a":1}`},
	}, "model-a")
	if err != nil {
		t.Fatalf("golden pricing snapshot rejected unrelated managed options: %v", err)
	}
}

func TestPreflightRejectsLongStreamMappingThatBypassesPacerModel(t *testing.T) {
	control := newFakeControl()
	control.bundle.Spec.Channels[0].ModelMapping = `{"llmgw-regression-chat":"llmgw-mock-chat","llmgw-regression-long":"llmgw-mock-chat"}`
	run := framework.NewRunContext("run-long-mapping", framework.NewSanitizer())
	runner := framework.NewRunner(NewControlCases(testConfig(), Dependencies{Control: control, Traffic: &fakeTraffic{}, Infrastructure: &fakeInfrastructure{}}), nil)

	report, err := runner.Run(t.Context(), TenantOnboardingGate(), run)
	if err == nil {
		t.Fatal("Run() error = nil")
	}
	if report.Cases[0].Status != framework.CaseStatusFailed || control.hasCallPrefix("assign:") {
		t.Fatalf("report=%+v calls=%v", report, control.calls)
	}
}

func TestTenantOnboardingFailsAndPreservesWhenSubscriptionMovesOutsideTargetSets(t *testing.T) {
	control := newFakeControl()
	control.detail.Binding.SetID = "set-b"
	control.detail.Assignment.SetID = "set-b"
	run := framework.NewRunContext("run-drift", framework.NewSanitizer())
	runner := framework.NewRunner(NewControlCases(testConfig(), Dependencies{Control: control, Traffic: &fakeTraffic{}, Infrastructure: &fakeInfrastructure{}}), nil)

	report, err := runner.Run(t.Context(), TenantOnboardingGate(), run)
	if err == nil {
		t.Fatal("Run() error = nil")
	}
	if control.hasCallPrefix("delete_tenant:") {
		t.Fatal("failed run must preserve tenant")
	}
	if len(report.RetainedResources) != 1 || report.RetainedResources[0].Kind != "tenant" {
		t.Fatalf("retained = %+v", report.RetainedResources)
	}
}

func TestTenantAssignmentUnknownOutcomeIsReportedAsRetained(t *testing.T) {
	control := newFakeControl()
	control.assignErr = errors.New("assignment response lost")
	run := framework.NewRunContext("run-unknown-assignment", framework.NewSanitizer())
	runner := framework.NewRunner(NewControlCases(testConfig(), Dependencies{Control: control, Traffic: &fakeTraffic{}, Infrastructure: &fakeInfrastructure{}}), nil)

	report, err := runner.Run(t.Context(), TenantOnboardingGate(), run)
	if err == nil {
		t.Fatal("Run() error = nil")
	}
	if len(report.RetainedResources) != 1 || report.RetainedResources[0].ID != RegressionUserID("run-unknown-assignment") {
		t.Fatalf("retained = %+v", report.RetainedResources)
	}
}

func TestModelDeliveryGateIncludesStrictBasicStream(t *testing.T) {
	control := newFakeControl()
	traffic := &fakeTraffic{}
	runner := framework.NewRunner(NewControlCases(testConfig(), Dependencies{Control: control, Traffic: traffic, Infrastructure: &fakeInfrastructure{}}), nil)

	if _, err := runner.Run(t.Context(), ModelDeliveryGate(), framework.NewRunContext("run-stream", framework.NewSanitizer())); err != nil {
		t.Fatal(err)
	}
	if traffic.streamCalls != 1 {
		t.Fatalf("stream calls = %d", traffic.streamCalls)
	}
}

func TestChannelDeliveryOnlyRequiresSelectedTargetSets(t *testing.T) {
	status := clients.ChannelDeliveryStatus{
		Status: "drift",
		Sets: []clients.ChannelDeliverySetStatus{
			{SetID: "set-a", Status: "synced"},
			{SetID: "unrelated-set", Status: "drift"},
		},
	}
	if !deliveryCoversTargets(status, []string{"set-a"}) {
		t.Fatal("unrelated Set drift must not fail a targeted regression")
	}
}

func TestRegressionUserIDIsDeterministicAndBounded(t *testing.T) {
	got := RegressionUserID("RUN/With Spaces/And-A-Very-Long-Identifier-That-Must-Be-Truncated")
	if got != RegressionUserID("RUN/With Spaces/And-A-Very-Long-Identifier-That-Must-Be-Truncated") || len(got) > 51 {
		t.Fatalf("user ID = %q", got)
	}
}

type fakeControl struct {
	calls                  []string
	bundle                 clients.ChannelBundle
	pricingBundle          clients.ChannelBundle
	detail                 clients.TenantDetail
	subscription           clients.Subscription
	assignErr              error
	initialAdmissionStatus string
	initialAdmissionError  string
}

func newFakeControl() *fakeControl {
	var detail clients.TenantDetail
	detail.Tenant.ExternalUserID = "reg-run-123-tenant"
	detail.Binding.SetID = "set-a"
	detail.Binding.UpstreamUserID = 42
	detail.Assignment.SetID = "set-a"
	detail.Assignment.Backend = "new"
	return &fakeControl{
		bundle: clients.ChannelBundle{
			ID: "regression-mock-channel", Fingerprint: "fp-1",
			Spec: clients.ChannelBundleSpec{Channels: []clients.ChannelBundleChannel{{
				ID: "regression", Type: 1, BaseURL: "http://llmgateway-regression-pacer:18082",
				Models: "llmgw-regression-chat,llmgw-regression-long,llmgw-regression-upgrade-probe", Group: "default",
				ModelMapping: `{"llmgw-regression-chat":"llmgw-mock-chat","llmgw-regression-long":"llmgw-regression-long","llmgw-regression-upgrade-probe":"llmgw-regression-upgrade-probe"}`,
				Status:       "enabled", KeyHash: "key-hash",
			}}},
		},
		pricingBundle: clients.ChannelBundle{
			ID: "golden-channels", Fingerprint: "golden-fp",
			Spec: clients.ChannelBundleSpec{Options: []clients.ChannelBundleOption{
				{Key: "CompletionRatio", Value: `{"llmgw-regression-chat":1,"llmgw-regression-long":1,"llmgw-regression-upgrade-probe":1}`},
				{Key: "ModelRatio", Value: map[string]any{"llmgw-regression-chat": 1, "llmgw-regression-long": 1, "llmgw-regression-upgrade-probe": 1}},
			}},
		},
		detail:       detail,
		subscription: clients.Subscription{ID: "sub-1", UserID: "reg-run-123-tenant", PlanID: "regression-monthly", Status: "active", SetID: "set-a"},
	}
}

func (f *fakeControl) ListSets(context.Context) ([]clients.ManagedSet, error) {
	f.calls = append(f.calls, "list_sets")
	admissionStatus := "passed"
	admissionError := ""
	if !f.hasCallPrefix("apply_bundle:") && f.initialAdmissionStatus != "" {
		admissionStatus = f.initialAdmissionStatus
		admissionError = f.initialAdmissionError
	}
	return []clients.ManagedSet{{ID: "set-a", Status: "active", Setup: true, AdminUserID: 1, AdmissionStatus: admissionStatus, AdmissionError: admissionError, ProvisionStatus: "managed"}}, nil
}
func (f *fakeControl) PlanSetStates(context.Context, string) ([]clients.PlanSetState, error) {
	f.calls = append(f.calls, "plan_sets")
	return []clients.PlanSetState{{PlanID: "regression-monthly", SetID: "set-a", Status: "ready", UpstreamPlanID: 7}}, nil
}
func (f *fakeControl) ChannelBundle(_ context.Context, bundleID string) (clients.ChannelBundle, error) {
	f.calls = append(f.calls, "bundle:"+bundleID)
	if bundleID == f.pricingBundle.ID {
		return f.pricingBundle, nil
	}
	return f.bundle, nil
}
func (f *fakeControl) ApplyChannelBundle(_ context.Context, _, setID string) (clients.ChannelSyncState, error) {
	f.calls = append(f.calls, "apply_bundle:"+setID)
	return clients.ChannelSyncState{SetID: setID, Status: "synced", AppliedFingerprint: "fp-1"}, nil
}
func (f *fakeControl) ChannelDeliveryStatus(context.Context, string) (clients.ChannelDeliveryStatus, error) {
	f.calls = append(f.calls, "delivery_status")
	return clients.ChannelDeliveryStatus{Status: "synced", Sets: []clients.ChannelDeliverySetStatus{{SetID: "set-a", Status: "synced"}}}, nil
}
func (f *fakeControl) AssignTenant(_ context.Context, userID, setID string) error {
	f.calls = append(f.calls, "assign:"+userID+":"+setID)
	return f.assignErr
}
func (f *fakeControl) EnsureTenant(_ context.Context, userID string) error {
	f.calls = append(f.calls, "ensure:"+userID)
	return nil
}
func (f *fakeControl) ApplySubscription(_ context.Context, userID, planID, _ string) (clients.Subscription, error) {
	f.calls = append(f.calls, "apply_subscription:"+userID+":"+planID)
	result := f.subscription
	result.UserID = userID
	return result, nil
}
func (f *fakeControl) TenantDetail(_ context.Context, userID string) (clients.TenantDetail, error) {
	f.calls = append(f.calls, "tenant_detail:"+userID)
	result := f.detail
	result.Tenant.ExternalUserID = userID
	return result, nil
}
func (f *fakeControl) CreateKey(_ context.Context, userID string) (clients.APIKey, error) {
	f.calls = append(f.calls, "create_key:"+userID)
	return clients.APIKey{ExternalKey: "sk-regression-secret", ExternalKeyID: "key-id", SetID: "set-a"}, nil
}
func (f *fakeControl) DeleteTenant(_ context.Context, userID, _ string, _ time.Duration) error {
	f.calls = append(f.calls, "delete_tenant:"+userID)
	return nil
}
func (f *fakeControl) hasCallPrefix(prefix string) bool {
	for _, call := range f.calls {
		if len(call) >= len(prefix) && call[:len(prefix)] == prefix {
			return true
		}
	}
	return false
}

type fakeTraffic struct {
	chatCalls   int
	streamCalls int
	lastKey     string
	chatMarkers []string
	chatErr     error
	chatErrors  []error
}

func (f *fakeTraffic) Chat(_ context.Context, _ string, key framework.Secret, _, marker string) (clients.ChatResult, error) {
	f.chatCalls++
	f.lastKey = key.Reveal()
	f.chatMarkers = append(f.chatMarkers, marker)
	if len(f.chatErrors) > 0 {
		err := f.chatErrors[0]
		f.chatErrors = f.chatErrors[1:]
		return clients.ChatResult{}, err
	}
	if f.chatErr != nil {
		return clients.ChatResult{}, f.chatErr
	}
	return clients.ChatResult{StatusCode: 200, MarkerFound: true}, nil
}
func (f *fakeTraffic) Stream(context.Context, string, framework.Secret, string, string, func(clients.StreamEvent)) (clients.StreamResult, error) {
	f.streamCalls++
	return clients.StreamResult{StatusCode: 200, RequestCount: 1, EventCount: 1, MarkerFound: true, Done: true}, nil
}

type fakeInfrastructure struct {
	err   error
	calls int
}

func (f *fakeInfrastructure) Preflight(context.Context, Config) (framework.Observations, error) {
	f.calls++
	if f.err != nil {
		return nil, f.err
	}
	return framework.Observations{"replicas": 2}, nil
}

func testConfig() Config {
	return Config{
		ControlURL: "http://llmgateway-control", TrafficURL: "http://llmgateway-traffic",
		PacerURL: "http://llmgateway-regression-pacer:18082", TargetSets: []string{"set-a"},
		PlanID: "regression-monthly", ChannelBundleID: "regression-mock-channel", PricingBundleID: "golden-channels",
		Model: "llmgw-regression-chat", Marker: "regression-marker", CleanupTimeout: time.Minute,
		UpgradeProbeModel: "llmgw-regression-upgrade-probe",
	}
}
