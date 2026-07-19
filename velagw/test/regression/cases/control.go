package cases

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"
	"unicode"

	"git.woa.com/wisp/mono2/llmgateway/test/regression/clients"
	"git.woa.com/wisp/mono2/llmgateway/test/regression/framework"
)

const (
	CasePlatformReady    = "platform_is_ready_to_serve"
	CaseChannelDelivery  = "channel_config_reaches_target_sets"
	CaseTenantOnboarded  = "tenant_can_be_onboarded"
	CaseTenantAPIKey     = "tenant_can_receive_an_api_key"
	CaseModelEffective   = "model_configuration_is_effective_on_traffic"
	CaseKeyCompletesChat = "issued_key_can_complete_chat"
	CaseKeyStreamsChat   = "issued_key_can_stream_chat"
	CaseActiveRollout    = "active_requests_survive_traffic_rollout"
	CasePlatformHealthy  = "platform_returns_to_healthy_state"

	stateBundle      = "channel_bundle"
	stateTargetSetID = "target_set_id"
	stateUserID      = "external_user_id"
	stateAPIKey      = "external_api_key"
	stateAPIKeyID    = "external_api_key_id"
)

type Config struct {
	Namespace                           string
	TrafficDeployment                   string
	ControlURL                          string
	TrafficURL                          string
	MockURL                             string
	PacerURL                            string
	TargetSets                          []string
	PlanID                              string
	ChannelBundleID                     string
	PricingBundleID                     string
	Model                               string
	Marker                              string
	ConsistencyTimeout                  time.Duration
	PollInterval                        time.Duration
	CleanupTimeout                      time.Duration
	BasicStreamMinDuration              time.Duration
	LongStreamModel                     string
	SSEDuration                         time.Duration
	SSETolerance                        time.Duration
	PinnedStreamHeadroom                time.Duration
	RequestInterval                     time.Duration
	RolloutPollInterval                 time.Duration
	RolloutTimeout                      time.Duration
	LeaseTTL                            time.Duration
	MinPreSamples                       int
	MinRolloutSamples                   int
	MinPostSamples                      int
	TargetReleaseID                     string
	ExpectedReleaseRings                []string
	CampaignTimeout                     time.Duration
	CampaignPollInterval                time.Duration
	CampaignRequestInterval             time.Duration
	MinCampaignSamples                  int
	TargetImage                         string
	UpgradeSource                       string
	UpgradeFleet                        string
	ManagerCronJob                      string
	ManagerImage                        string
	UpgradeProbeModel                   string
	DisruptionTimeout                   time.Duration
	UpgradeDrainTimeout                 time.Duration
	UpgradeRollbackWindow               time.Duration
	DisruptionPollInterval              time.Duration
	ControlPlaneOutageControlDeployment string
	ControlPlaneOutageWorkerDeployments []string
	ControlPlaneOutageBacklogJob        string
	ControlPlaneOutageDuration          time.Duration
	ControlPlaneOutageTrafficInterval   time.Duration
	ControlPlaneOutageMinSamples        int
	ControlPlaneOutageRecoveryTimeout   time.Duration
}

type ControlPlane interface {
	ListSets(context.Context) ([]clients.ManagedSet, error)
	PlanSetStates(context.Context, string) ([]clients.PlanSetState, error)
	ChannelBundle(context.Context, string) (clients.ChannelBundle, error)
	ApplyChannelBundle(context.Context, string, string) (clients.ChannelSyncState, error)
	ChannelDeliveryStatus(context.Context, string) (clients.ChannelDeliveryStatus, error)
	AssignTenant(context.Context, string, string) error
	EnsureTenant(context.Context, string) error
	ApplySubscription(context.Context, string, string, string) (clients.Subscription, error)
	TenantDetail(context.Context, string) (clients.TenantDetail, error)
	CreateKey(context.Context, string) (clients.APIKey, error)
	DeleteTenant(context.Context, string, string, time.Duration) error
}

type TrafficPlane interface {
	Chat(context.Context, string, framework.Secret, string, string) (clients.ChatResult, error)
	Stream(context.Context, string, framework.Secret, string, string, func(clients.StreamEvent)) (clients.StreamResult, error)
}

type Infrastructure interface {
	Preflight(context.Context, Config) (framework.Observations, error)
}

type Dependencies struct {
	Control        ControlPlane
	Traffic        TrafficPlane
	Infrastructure Infrastructure
}

func NewControlCases(cfg Config, deps Dependencies) []framework.Case {
	cfg = withConfigDefaults(cfg)
	return []framework.Case{
		framework.CaseFunc{CaseID: CasePlatformReady, RunFunc: func(ctx context.Context, run *framework.RunContext) (framework.Observations, error) {
			return platformReady(ctx, run, cfg, deps)
		}},
		framework.CaseFunc{CaseID: CaseChannelDelivery, DependsOn: []string{CasePlatformReady}, RunFunc: func(ctx context.Context, run *framework.RunContext) (framework.Observations, error) {
			return channelDelivered(ctx, run, cfg, deps.Control)
		}},
		framework.CaseFunc{CaseID: CaseTenantOnboarded, DependsOn: []string{CaseChannelDelivery}, RunFunc: func(ctx context.Context, run *framework.RunContext) (framework.Observations, error) {
			return tenantOnboarded(ctx, run, cfg, deps.Control)
		}},
		framework.CaseFunc{CaseID: CaseTenantAPIKey, DependsOn: []string{CaseTenantOnboarded}, RunFunc: func(ctx context.Context, run *framework.RunContext) (framework.Observations, error) {
			return tenantAPIKey(ctx, run, deps.Control)
		}},
		framework.CaseFunc{CaseID: CaseModelEffective, DependsOn: []string{CaseTenantAPIKey}, RunFunc: func(ctx context.Context, run *framework.RunContext) (framework.Observations, error) {
			return modelConfigurationEffective(ctx, run, cfg, deps.Traffic)
		}},
		framework.CaseFunc{CaseID: CaseKeyCompletesChat, DependsOn: []string{CaseModelEffective}, RunFunc: func(ctx context.Context, run *framework.RunContext) (framework.Observations, error) {
			return keyCompletesChat(ctx, run, cfg, deps.Traffic)
		}},
		framework.CaseFunc{CaseID: CaseKeyStreamsChat, DependsOn: []string{CaseKeyCompletesChat}, RunFunc: func(ctx context.Context, run *framework.RunContext) (framework.Observations, error) {
			return keyStreamsChat(ctx, run, cfg, deps.Traffic)
		}},
	}
}

func TenantOnboardingGate() framework.Scenario {
	return framework.Scenario{Name: "tenant_onboarding_gate", Cases: []string{
		CasePlatformReady, CaseChannelDelivery, CaseTenantOnboarded, CaseTenantAPIKey, CaseModelEffective, CaseKeyCompletesChat,
	}}
}

func ModelDeliveryGate() framework.Scenario {
	return framework.Scenario{Name: "model_delivery_gate", Cases: []string{
		CasePlatformReady, CaseChannelDelivery, CaseTenantOnboarded, CaseTenantAPIKey, CaseModelEffective, CaseKeyCompletesChat, CaseKeyStreamsChat,
	}}
}

func platformReady(ctx context.Context, run *framework.RunContext, cfg Config, deps Dependencies) (framework.Observations, error) {
	if deps.Control == nil || deps.Traffic == nil || deps.Infrastructure == nil {
		return nil, fmt.Errorf("control, traffic and infrastructure dependencies are required")
	}
	if len(cfg.TargetSets) == 0 {
		return nil, fmt.Errorf("at least one target Set is required")
	}
	sets, err := deps.Control.ListSets(ctx)
	if err != nil {
		return nil, err
	}
	setByID := make(map[string]clients.ManagedSet, len(sets))
	for _, set := range sets {
		setByID[set.ID] = set
	}
	for _, setID := range cfg.TargetSets {
		set, ok := setByID[setID]
		if !ok {
			return nil, fmt.Errorf("target Set %q is not managed", setID)
		}
		if set.Status != "active" || !set.Setup || set.AdminUserID <= 0 {
			return nil, fmt.Errorf("target Set %q is not ready for configuration", setID)
		}
		if set.ProvisionStatus != "" && set.ProvisionStatus != "managed" {
			return nil, fmt.Errorf("target Set %q provision status is %q", setID, set.ProvisionStatus)
		}
	}
	planStates, err := deps.Control.PlanSetStates(ctx, cfg.PlanID)
	if err != nil {
		return nil, err
	}
	readyPlans := map[string]bool{}
	for _, state := range planStates {
		readyPlans[state.SetID] = state.Status == "ready" && state.UpstreamPlanID > 0
	}
	for _, setID := range cfg.TargetSets {
		if !readyPlans[setID] {
			return nil, fmt.Errorf("plan %q is not ready on Set %q", cfg.PlanID, setID)
		}
	}
	bundle, err := deps.Control.ChannelBundle(ctx, cfg.ChannelBundleID)
	if err != nil {
		return nil, err
	}
	if len(bundle.Spec.Options) != 0 {
		return nil, fmt.Errorf("regression channel bundle must not own global new-api options")
	}
	pricingBundle, err := deps.Control.ChannelBundle(ctx, cfg.PricingBundleID)
	if err != nil {
		return nil, err
	}
	pricedModels := []string{cfg.Model, cfg.LongStreamModel}
	if cfg.UpgradeProbeModel != "" {
		pricedModels = append(pricedModels, cfg.UpgradeProbeModel)
	}
	if err := validateRegressionPricingSnapshot(pricingBundle.Spec.Options, pricedModels...); err != nil {
		return nil, err
	}
	if len(bundle.Spec.Channels) != 1 || bundle.Fingerprint == "" {
		return nil, fmt.Errorf("regression channel bundle is incomplete")
	}
	for _, setID := range cfg.TargetSets {
		set := setByID[setID]
		if set.AdmissionStatus != "passed" && !isRegressionBundleInitialSyncFailure(set, bundle.ID) {
			return nil, fmt.Errorf("target Set %q admission is %q: %s", setID, set.AdmissionStatus, set.AdmissionError)
		}
	}
	for _, channel := range bundle.Spec.Channels {
		if channel.Type != 1 || channel.Status != "enabled" || channel.Group != "default" || channel.KeyHash == "" {
			return nil, fmt.Errorf("regression channel %q must be an enabled OpenAI-compatible channel with a key fingerprint", channel.ID)
		}
		if strings.TrimRight(channel.BaseURL, "/") != strings.TrimRight(cfg.PacerURL, "/") {
			return nil, fmt.Errorf("regression channel %q does not use the dedicated pacer", channel.ID)
		}
		if !containsCSV(channel.Models, cfg.Model) {
			return nil, fmt.Errorf("regression channel %q does not expose model %q", channel.ID, cfg.Model)
		}
		if !containsCSV(channel.Models, cfg.LongStreamModel) {
			return nil, fmt.Errorf("regression channel %q does not expose long stream model %q", channel.ID, cfg.LongStreamModel)
		}
		if cfg.UpgradeProbeModel != "" && !containsCSV(channel.Models, cfg.UpgradeProbeModel) {
			return nil, fmt.Errorf("regression channel %q does not expose upgrade probe model %q", channel.ID, cfg.UpgradeProbeModel)
		}
		var mappings map[string]string
		if json.Unmarshal([]byte(channel.ModelMapping), &mappings) != nil || strings.TrimSpace(mappings[cfg.Model]) == "" || strings.TrimSpace(mappings[cfg.LongStreamModel]) == "" {
			return nil, fmt.Errorf("regression channel %q model mapping is incomplete", channel.ID)
		}
		if mappings[cfg.LongStreamModel] != cfg.LongStreamModel {
			return nil, fmt.Errorf("regression channel %q must preserve long stream model %q for pacer routing", channel.ID, cfg.LongStreamModel)
		}
		if cfg.UpgradeProbeModel != "" && mappings[cfg.UpgradeProbeModel] != cfg.UpgradeProbeModel {
			return nil, fmt.Errorf("regression channel %q must preserve upgrade probe model %q for isolated fault injection", channel.ID, cfg.UpgradeProbeModel)
		}
	}
	infra, err := deps.Infrastructure.Preflight(ctx, cfg)
	if err != nil {
		return nil, err
	}
	run.Set(stateBundle, bundle)
	run.Set(stateTargetSetID, cfg.TargetSets[0])
	result := framework.Observations{"target_sets": append([]string(nil), cfg.TargetSets...), "plan_id": cfg.PlanID, "bundle_fingerprint": bundle.Fingerprint, "pricing_fingerprint": pricingBundle.Fingerprint}
	for key, value := range infra {
		result[key] = value
	}
	return result, nil
}

func validateRegressionPricingSnapshot(options []clients.ChannelBundleOption, models ...string) error {
	seen := make(map[string]bool, 2)
	for _, option := range options {
		if option.Key != "ModelRatio" && option.Key != "CompletionRatio" {
			continue
		}
		if seen[option.Key] {
			return fmt.Errorf("regression channel bundle contains duplicate option %q", option.Key)
		}
		seen[option.Key] = true
		values, err := regressionOptionMap(option.Value)
		if err != nil {
			return fmt.Errorf("regression channel bundle option %q is invalid: %w", option.Key, err)
		}
		for _, model := range models {
			if _, ok := values[model]; !ok {
				return fmt.Errorf("regression channel bundle option %q does not price model %q", option.Key, model)
			}
		}
	}
	for _, required := range []string{"ModelRatio", "CompletionRatio"} {
		if !seen[required] {
			return fmt.Errorf("golden pricing bundle is missing %s", required)
		}
	}
	return nil
}

func regressionOptionMap(value any) (map[string]any, error) {
	if values, ok := value.(map[string]any); ok {
		return values, nil
	}
	var raw []byte
	var err error
	if text, ok := value.(string); ok {
		raw = []byte(text)
	} else {
		raw, err = json.Marshal(value)
		if err != nil {
			return nil, err
		}
	}
	values := map[string]any{}
	if err := json.Unmarshal(raw, &values); err != nil {
		return nil, err
	}
	return values, nil
}

func channelDelivered(ctx context.Context, run *framework.RunContext, cfg Config, control ControlPlane) (framework.Observations, error) {
	bundleValue, ok := run.Get(stateBundle)
	if !ok {
		return nil, fmt.Errorf("preflight did not store channel bundle")
	}
	bundle := bundleValue.(clients.ChannelBundle)
	for _, setID := range cfg.TargetSets {
		state, err := control.ApplyChannelBundle(ctx, bundle.ID, setID)
		if err != nil {
			return nil, err
		}
		if state.Status != "synced" || state.AppliedFingerprint != bundle.Fingerprint {
			return nil, fmt.Errorf("channel bundle on Set %q is %q with fingerprint %q", setID, state.Status, state.AppliedFingerprint)
		}
	}
	deadline := time.Now().Add(cfg.ConsistencyTimeout)
	for {
		status, err := control.ChannelDeliveryStatus(ctx, bundle.ID)
		if err != nil {
			return nil, err
		}
		if deliveryCoversTargets(status, cfg.TargetSets) {
			sets, err := control.ListSets(ctx)
			if err != nil {
				return nil, err
			}
			admitted, err := targetSetsAdmitted(sets, cfg.TargetSets, bundle.ID)
			if err != nil {
				return nil, err
			}
			if admitted {
				return framework.Observations{"target_status": "synced", "fleet_status": status.Status, "checked_sets": len(cfg.TargetSets), "fingerprint": bundle.Fingerprint}, nil
			}
		}
		if time.Now().After(deadline) {
			return nil, fmt.Errorf("channel bundle delivery did not become synced before timeout")
		}
		if err := wait(ctx, cfg.PollInterval); err != nil {
			return nil, err
		}
	}
}

func isRegressionBundleInitialSyncFailure(set clients.ManagedSet, bundleID string) bool {
	expected := fmt.Sprintf("channel bundle %q initial sync has not completed on set %q", bundleID, set.ID)
	return set.AdmissionStatus == "failed" && strings.TrimSpace(set.AdmissionError) == expected
}

func targetSetsAdmitted(sets []clients.ManagedSet, targets []string, bundleID string) (bool, error) {
	byID := make(map[string]clients.ManagedSet, len(sets))
	for _, set := range sets {
		byID[set.ID] = set
	}
	ready := true
	for _, target := range targets {
		set, ok := byID[target]
		if !ok {
			return false, fmt.Errorf("target Set %q is no longer managed", target)
		}
		if isRegressionBundleInitialSyncFailure(set, bundleID) {
			ready = false
			continue
		}
		if set.AdmissionStatus == "failed" {
			return false, fmt.Errorf("target Set %q admission failed after channel delivery: %s", target, set.AdmissionError)
		}
		if set.AdmissionStatus != "passed" {
			ready = false
		}
	}
	return ready, nil
}

func tenantOnboarded(ctx context.Context, run *framework.RunContext, cfg Config, control ControlPlane) (framework.Observations, error) {
	setID := runString(run, stateTargetSetID)
	userID := regressionUserID(run.RunID)
	run.TrackResource(framework.ResourceRef{Kind: "tenant", ID: userID, SetID: setID})
	run.DeferCleanup("delete tenant "+userID, func(cleanupCtx context.Context) error {
		return control.DeleteTenant(cleanupCtx, userID, "regression-cleanup:"+run.RunID, cfg.CleanupTimeout)
	})
	if err := control.AssignTenant(ctx, userID, setID); err != nil {
		return nil, err
	}
	if err := control.EnsureTenant(ctx, userID); err != nil {
		return nil, err
	}
	subscription, err := control.ApplySubscription(ctx, userID, cfg.PlanID, "regression-subscription:"+run.RunID)
	if err != nil {
		return nil, err
	}
	detail, err := control.TenantDetail(ctx, userID)
	if err != nil {
		return nil, err
	}
	if !contains(cfg.TargetSets, detail.Binding.SetID) || detail.Assignment.SetID != detail.Binding.SetID {
		return nil, fmt.Errorf("tenant moved outside target Sets after subscription: binding=%q assignment=%q", detail.Binding.SetID, detail.Assignment.SetID)
	}
	if detail.Binding.UpstreamUserID <= 0 || subscription.Status != "active" || subscription.PlanID != cfg.PlanID {
		return nil, fmt.Errorf("tenant subscription or upstream user is incomplete")
	}
	run.Set(stateUserID, userID)
	run.Set(stateTargetSetID, detail.Binding.SetID)
	return framework.Observations{"user_id": userID, "set_id": detail.Binding.SetID, "plan_id": cfg.PlanID, "subscription_status": subscription.Status}, nil
}

func tenantAPIKey(ctx context.Context, run *framework.RunContext, control ControlPlane) (framework.Observations, error) {
	userID := runString(run, stateUserID)
	setID := runString(run, stateTargetSetID)
	key, err := control.CreateKey(ctx, userID)
	if err != nil {
		return nil, err
	}
	if key.ExternalKeyID != "" {
		run.TrackResource(framework.ResourceRef{Kind: "api_key", ID: key.ExternalKeyID, SetID: key.SetID})
	}
	if key.ExternalKey == "" || key.ExternalKeyID == "" || key.SetID != setID {
		return nil, fmt.Errorf("issued API key is incomplete or routed to the wrong Set")
	}
	secret := run.Sanitizer.Secret(key.ExternalKey)
	run.Set(stateAPIKey, secret)
	run.Set(stateAPIKeyID, key.ExternalKeyID)
	return framework.Observations{"external_key_id": key.ExternalKeyID, "external_key_hash_prefix": safePrefix(key.ExternalKeyHash, 12), "set_id": setID}, nil
}

func modelConfigurationEffective(ctx context.Context, run *framework.RunContext, cfg Config, traffic TrafficPlane) (framework.Observations, error) {
	started := time.Now()
	deadline := started.Add(cfg.ConsistencyTimeout)
	attempts := 0
	var lastErr error
	for {
		attempts++
		result, err := traffic.Chat(ctx, cfg.TrafficURL, runSecret(run, stateAPIKey), cfg.Model, cfg.Marker)
		if err == nil {
			return framework.Observations{
				"attempts": attempts, "waited_ms": time.Since(started).Milliseconds(),
				"status": result.StatusCode, "marker_found": result.MarkerFound,
			}, nil
		}
		lastErr = err
		if !time.Now().Before(deadline) {
			return nil, fmt.Errorf("model configuration did not become effective on traffic after %d attempts: %w", attempts, lastErr)
		}
		if err := wait(ctx, cfg.PollInterval); err != nil {
			return nil, err
		}
	}
}

func keyCompletesChat(ctx context.Context, run *framework.RunContext, cfg Config, traffic TrafficPlane) (framework.Observations, error) {
	result, err := traffic.Chat(ctx, cfg.TrafficURL, runSecret(run, stateAPIKey), cfg.Model, cfg.Marker)
	if err != nil {
		return nil, err
	}
	return framework.Observations{"status": result.StatusCode, "duration_ms": result.Duration.Milliseconds(), "marker_found": result.MarkerFound}, nil
}

func keyStreamsChat(ctx context.Context, run *framework.RunContext, cfg Config, traffic TrafficPlane) (framework.Observations, error) {
	result, err := traffic.Stream(ctx, cfg.TrafficURL, runSecret(run, stateAPIKey), cfg.Model, cfg.Marker, nil)
	if err != nil {
		return nil, err
	}
	if result.RequestCount != 1 || !result.Done || !result.MarkerFound || result.Duration < cfg.BasicStreamMinDuration {
		return nil, fmt.Errorf("basic SSE result did not satisfy the stream contract")
	}
	return framework.Observations{"status": result.StatusCode, "duration_ms": result.Duration.Milliseconds(), "events": result.EventCount, "request_count": result.RequestCount}, nil
}

func withConfigDefaults(cfg Config) Config {
	if cfg.LongStreamModel == "" {
		cfg.LongStreamModel = "llmgw-regression-long"
	}
	if cfg.PricingBundleID == "" {
		cfg.PricingBundleID = "golden-channels"
	}
	if cfg.ConsistencyTimeout <= 0 {
		cfg.ConsistencyTimeout = 2 * time.Minute
	}
	if cfg.PollInterval <= 0 {
		cfg.PollInterval = 2 * time.Second
	}
	if cfg.CleanupTimeout <= 0 {
		cfg.CleanupTimeout = 3 * time.Minute
	}
	if cfg.CampaignTimeout <= 0 {
		cfg.CampaignTimeout = 45 * time.Minute
	}
	if cfg.CampaignPollInterval <= 0 {
		cfg.CampaignPollInterval = 2 * time.Second
	}
	if cfg.CampaignRequestInterval <= 0 {
		cfg.CampaignRequestInterval = time.Second
	}
	if cfg.MinCampaignSamples <= 0 {
		cfg.MinCampaignSamples = 30
	}
	return cfg
}

func deliveryCoversTargets(status clients.ChannelDeliveryStatus, targets []string) bool {
	ready := map[string]bool{}
	for _, set := range status.Sets {
		ready[set.SetID] = set.Status == "synced"
	}
	for _, target := range targets {
		if !ready[target] {
			return false
		}
	}
	return true
}

func regressionUserID(runID string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(runID) {
		if unicode.IsLetter(r) || unicode.IsDigit(r) || r == '-' {
			b.WriteRune(r)
		} else {
			b.WriteByte('-')
		}
	}
	clean := strings.Trim(b.String(), "-")
	if len(clean) > 40 {
		clean = clean[:40]
	}
	return "reg-" + clean + "-tenant"
}

func RegressionUserID(runID string) string { return regressionUserID(runID) }

func runString(run *framework.RunContext, key string) string {
	value, _ := run.Get(key)
	result, _ := value.(string)
	return result
}

func runSecret(run *framework.RunContext, key string) framework.Secret {
	value, _ := run.Get(key)
	result, _ := value.(framework.Secret)
	return result
}

func contains(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

func containsCSV(value, target string) bool {
	for _, item := range strings.Split(value, ",") {
		if strings.TrimSpace(item) == target {
			return true
		}
	}
	return false
}

func safePrefix(value string, length int) string {
	if len(value) <= length {
		return value
	}
	return value[:length]
}

func wait(ctx context.Context, duration time.Duration) error {
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}
