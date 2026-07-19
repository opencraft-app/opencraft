package runner

import (
	"fmt"
	"io"
	"regexp"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

var dnsLabel = regexp.MustCompile(`^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$`)

type Duration struct{ time.Duration }

func (d *Duration) UnmarshalYAML(node *yaml.Node) error {
	parsed, err := time.ParseDuration(strings.TrimSpace(node.Value))
	if err != nil {
		return err
	}
	d.Duration = parsed
	return nil
}

type Config struct {
	Scenario           string                   `yaml:"scenario"`
	Target             TargetConfig             `yaml:"target"`
	Rollout            RolloutConfig            `yaml:"rollout"`
	Campaign           CampaignConfig           `yaml:"campaign"`
	Disruption         DisruptionConfig         `yaml:"disruption"`
	ControlPlaneOutage ControlPlaneOutageConfig `yaml:"controlPlaneOutage"`
	Cleanup            CleanupConfig            `yaml:"cleanup"`
}

type ControlPlaneOutageConfig struct {
	ControlDeployment string   `yaml:"controlDeployment"`
	WorkerDeployments []string `yaml:"workerDeployments"`
	ManagerCronJob    string   `yaml:"managerCronJob"`
	BacklogJob        string   `yaml:"backlogJob"`
	OutageDuration    Duration `yaml:"outageDuration"`
	TrafficInterval   Duration `yaml:"trafficInterval"`
	MinimumSamples    int      `yaml:"minimumSamples"`
	RecoveryTimeout   Duration `yaml:"recoveryTimeout"`
}

type DisruptionConfig struct {
	TargetImage    string   `yaml:"targetImage"`
	Source         string   `yaml:"source"`
	Fleet          string   `yaml:"fleet"`
	ManagerCronJob string   `yaml:"managerCronJob"`
	ManagerImage   string   `yaml:"managerImage"`
	ProbeModel     string   `yaml:"probeModel"`
	Timeout        Duration `yaml:"timeout"`
	DrainTimeout   Duration `yaml:"drainTimeout"`
	RollbackWindow Duration `yaml:"rollbackWindow"`
	PollInterval   Duration `yaml:"pollInterval"`
}

type CampaignConfig struct {
	TargetReleaseID string   `yaml:"targetReleaseID"`
	ExpectedRings   []string `yaml:"expectedRings"`
	Timeout         Duration `yaml:"timeout"`
	PollInterval    Duration `yaml:"pollInterval"`
	RequestInterval Duration `yaml:"requestInterval"`
	MinSamples      int      `yaml:"minSamples"`
}

type TargetConfig struct {
	Namespace         string   `yaml:"namespace"`
	TrafficDeployment string   `yaml:"trafficDeployment"`
	ControlURL        string   `yaml:"controlURL"`
	TrafficURL        string   `yaml:"trafficURL"`
	MockURL           string   `yaml:"mockURL"`
	PacerURL          string   `yaml:"pacerURL"`
	TargetSets        []string `yaml:"targetSets"`
	PlanID            string   `yaml:"planID"`
	ChannelBundleID   string   `yaml:"channelBundleID"`
	PricingBundleID   string   `yaml:"pricingBundleID"`
	Model             string   `yaml:"model"`
	LongStreamModel   string   `yaml:"longStreamModel"`
	Marker            string   `yaml:"marker"`
}

type RolloutConfig struct {
	SSEDuration          Duration `yaml:"sseDuration"`
	SSETolerance         Duration `yaml:"sseTolerance"`
	PinnedStreamHeadroom Duration `yaml:"pinnedStreamHeadroom"`
	RequestInterval      Duration `yaml:"requestInterval"`
	PollInterval         Duration `yaml:"pollInterval"`
	Timeout              Duration `yaml:"timeout"`
	LeaseTTL             Duration `yaml:"leaseTTL"`
	MinPreSamples        int      `yaml:"minPreSamples"`
	MinRolloutSamples    int      `yaml:"minRolloutSamples"`
	MinPostSamples       int      `yaml:"minPostSamples"`
	ConsistencyTimeout   Duration `yaml:"consistencyTimeout"`
	CleanupTimeout       Duration `yaml:"cleanupTimeout"`
}

type CleanupConfig struct {
	PreserveOnFailure bool `yaml:"preserveOnFailure"`
}

func ParseConfig(reader io.Reader) (Config, error) {
	decoder := yaml.NewDecoder(reader)
	decoder.KnownFields(true)
	var cfg Config
	if err := decoder.Decode(&cfg); err != nil {
		return Config{}, fmt.Errorf("decode regression config: %w", err)
	}
	applyDefaults(&cfg)
	return cfg, nil
}

func (c Config) Validate(inCluster bool) error {
	applyDefaults(&c)
	if c.Scenario == "" {
		return fmt.Errorf("scenario is required")
	}
	if c.Scenario != "tenant_onboarding_gate" && c.Scenario != "model_delivery_gate" && c.Scenario != "preprod_release_gate" && c.Scenario != "fleet_release_campaign_gate" && c.Scenario != "set_upgrade_rollback_gate" && c.Scenario != "set_manager_takeover_gate" && c.Scenario != "control_plane_outage_gate" && c.Scenario != "set_traffic_pod_failure_gate" {
		return fmt.Errorf("unknown scenario %q", c.Scenario)
	}
	if requiresClusterScenario(c.Scenario) && !inCluster {
		return fmt.Errorf("scenario %s requires an in-cluster Kubernetes Job", c.Scenario)
	}
	required := map[string]string{
		"target.namespace": c.Target.Namespace, "target.controlURL": c.Target.ControlURL,
		"target.trafficURL": c.Target.TrafficURL, "target.mockURL": c.Target.MockURL, "target.pacerURL": c.Target.PacerURL,
		"target.planID": c.Target.PlanID, "target.channelBundleID": c.Target.ChannelBundleID,
		"target.model": c.Target.Model, "target.marker": c.Target.Marker,
	}
	for name, value := range required {
		if strings.TrimSpace(value) == "" {
			return fmt.Errorf("%s is required", name)
		}
	}
	if len(c.Target.TargetSets) == 0 {
		return fmt.Errorf("target.targetSets is required")
	}
	if !dnsLabel.MatchString(c.Target.Namespace) || len(c.Target.Namespace) > 63 {
		return fmt.Errorf("target.namespace must be a Kubernetes DNS label")
	}
	if c.Scenario == "preprod_release_gate" && c.Target.TrafficDeployment != "llmgateway-traffic" {
		return fmt.Errorf("target.trafficDeployment must be llmgateway-traffic")
	}
	if c.Scenario == "preprod_release_gate" && c.Rollout.PinnedStreamHeadroom.Duration >= c.Rollout.SSEDuration.Duration-c.Rollout.SSETolerance.Duration {
		return fmt.Errorf("rollout.pinnedStreamHeadroom must be shorter than sseDuration minus sseTolerance")
	}
	if c.Scenario == "fleet_release_campaign_gate" {
		if strings.TrimSpace(c.Campaign.TargetReleaseID) == "" {
			return fmt.Errorf("campaign.targetReleaseID is required")
		}
		if len(c.Campaign.ExpectedRings) == 0 {
			return fmt.Errorf("campaign.expectedRings is required")
		}
	}
	if isDisruptiveScenario(c.Scenario) {
		if c.Scenario == "control_plane_outage_gate" {
			return validateControlPlaneOutageConfig(c)
		}
		if len(c.Target.TargetSets) != 1 {
			return fmt.Errorf("disruptive regression requires exactly one isolated target Set")
		}
		if c.Scenario == "set_traffic_pod_failure_gate" {
			return nil
		}
		if strings.TrimSpace(c.Disruption.TargetImage) == "" {
			return fmt.Errorf("disruption.targetImage is required")
		}
		if !regexp.MustCompile(`@sha256:[0-9a-fA-F]{64}$`).MatchString(c.Disruption.TargetImage) {
			return fmt.Errorf("disruption.targetImage must be pinned by sha256 digest")
		}
		if !regexp.MustCompile(`@sha256:[0-9a-fA-F]{64}$`).MatchString(c.Disruption.ManagerImage) {
			return fmt.Errorf("disruption.managerImage must be pinned by sha256 digest")
		}
	}
	return nil
}

func validateControlPlaneOutageConfig(c Config) error {
	names := map[string]struct{}{}
	for _, name := range append([]string{c.ControlPlaneOutage.ControlDeployment}, c.ControlPlaneOutage.WorkerDeployments...) {
		name = strings.TrimSpace(name)
		if name == "" {
			return fmt.Errorf("controlPlaneOutage deployment names are required")
		}
		if _, exists := names[name]; exists {
			return fmt.Errorf("controlPlaneOutage deployment names must be unique")
		}
		names[name] = struct{}{}
	}
	if len(c.ControlPlaneOutage.WorkerDeployments) == 0 {
		return fmt.Errorf("controlPlaneOutage.workerDeployments is required")
	}
	if c.ControlPlaneOutage.OutageDuration.Duration/c.ControlPlaneOutage.TrafficInterval.Duration < time.Duration(c.ControlPlaneOutage.MinimumSamples) {
		return fmt.Errorf("controlPlaneOutage outage window cannot produce minimum samples")
	}
	return nil
}

func requiresClusterScenario(name string) bool {
	return name == "preprod_release_gate" || name == "fleet_release_campaign_gate" || isDisruptiveScenario(name)
}

func isDisruptiveScenario(name string) bool {
	return name == "set_upgrade_rollback_gate" || name == "set_manager_takeover_gate" || name == "control_plane_outage_gate" || name == "set_traffic_pod_failure_gate"
}

func applyDefaults(cfg *Config) {
	if cfg.Scenario == "" {
		cfg.Scenario = "preprod_release_gate"
	}
	if cfg.Target.Namespace == "" {
		cfg.Target.Namespace = "llmgateway"
	}
	if cfg.Target.TrafficDeployment == "" {
		cfg.Target.TrafficDeployment = "llmgateway-traffic"
	}
	if cfg.Target.LongStreamModel == "" {
		cfg.Target.LongStreamModel = "llmgw-regression-long"
	}
	if cfg.Target.PricingBundleID == "" {
		cfg.Target.PricingBundleID = "golden-channels"
	}
	if cfg.ControlPlaneOutage.ControlDeployment == "" {
		cfg.ControlPlaneOutage.ControlDeployment = "llmgateway-control"
	}
	if len(cfg.ControlPlaneOutage.WorkerDeployments) == 0 {
		cfg.ControlPlaneOutage.WorkerDeployments = []string{"llmgateway-worker-admin", "llmgateway-worker-byok", "llmgateway-worker-core", "llmgateway-worker-maintenance", "llmgateway-worker-observer"}
	}
	if cfg.ControlPlaneOutage.ManagerCronJob == "" {
		cfg.ControlPlaneOutage.ManagerCronJob = "llmgateway-set-manager"
	}
	if cfg.ControlPlaneOutage.BacklogJob == "" {
		cfg.ControlPlaneOutage.BacklogJob = "refresh_set_capacity"
	}
	if cfg.ControlPlaneOutage.OutageDuration.Duration == 0 {
		cfg.ControlPlaneOutage.OutageDuration.Duration = 90 * time.Second
	}
	if cfg.ControlPlaneOutage.TrafficInterval.Duration == 0 {
		cfg.ControlPlaneOutage.TrafficInterval.Duration = time.Second
	}
	if cfg.ControlPlaneOutage.MinimumSamples == 0 {
		cfg.ControlPlaneOutage.MinimumSamples = 60
	}
	if cfg.ControlPlaneOutage.RecoveryTimeout.Duration == 0 {
		cfg.ControlPlaneOutage.RecoveryTimeout.Duration = 5 * time.Minute
	}
	if cfg.Rollout.SSEDuration.Duration == 0 {
		cfg.Rollout.SSEDuration.Duration = 3 * time.Minute
	}
	if cfg.Rollout.SSETolerance.Duration == 0 {
		cfg.Rollout.SSETolerance.Duration = 5 * time.Second
	}
	if cfg.Rollout.PinnedStreamHeadroom.Duration == 0 {
		cfg.Rollout.PinnedStreamHeadroom.Duration = 30 * time.Second
	}
	if cfg.Rollout.RequestInterval.Duration == 0 {
		cfg.Rollout.RequestInterval.Duration = time.Second
	}
	if cfg.Rollout.PollInterval.Duration == 0 {
		cfg.Rollout.PollInterval.Duration = time.Second
	}
	if cfg.Rollout.Timeout.Duration == 0 {
		cfg.Rollout.Timeout.Duration = 15 * time.Minute
	}
	if cfg.Rollout.LeaseTTL.Duration == 0 {
		cfg.Rollout.LeaseTTL.Duration = 90 * time.Second
	}
	if cfg.Rollout.MinPreSamples == 0 {
		cfg.Rollout.MinPreSamples = 10
	}
	if cfg.Rollout.MinRolloutSamples == 0 {
		cfg.Rollout.MinRolloutSamples = 120
	}
	if cfg.Rollout.MinPostSamples == 0 {
		cfg.Rollout.MinPostSamples = 10
	}
	if cfg.Rollout.ConsistencyTimeout.Duration == 0 {
		cfg.Rollout.ConsistencyTimeout.Duration = 2 * time.Minute
	}
	if cfg.Rollout.CleanupTimeout.Duration == 0 {
		cfg.Rollout.CleanupTimeout.Duration = 3 * time.Minute
	}
	if cfg.Campaign.Timeout.Duration == 0 {
		cfg.Campaign.Timeout.Duration = 45 * time.Minute
	}
	if cfg.Campaign.PollInterval.Duration == 0 {
		cfg.Campaign.PollInterval.Duration = 2 * time.Second
	}
	if cfg.Campaign.RequestInterval.Duration == 0 {
		cfg.Campaign.RequestInterval.Duration = time.Second
	}
	if cfg.Campaign.MinSamples == 0 {
		cfg.Campaign.MinSamples = 30
	}
	if cfg.Disruption.Source == "" {
		cfg.Disruption.Source = "prod"
	}
	if cfg.Disruption.Fleet == "" {
		cfg.Disruption.Fleet = "prod"
	}
	if cfg.Disruption.ManagerCronJob == "" {
		cfg.Disruption.ManagerCronJob = "llmgateway-set-manager"
	}
	if cfg.Disruption.ProbeModel == "" {
		cfg.Disruption.ProbeModel = "llmgw-regression-upgrade-probe"
	}
	if cfg.Disruption.Timeout.Duration == 0 {
		cfg.Disruption.Timeout.Duration = 20 * time.Minute
	}
	if cfg.Disruption.DrainTimeout.Duration == 0 {
		cfg.Disruption.DrainTimeout.Duration = 15 * time.Second
	}
	if cfg.Disruption.RollbackWindow.Duration == 0 {
		cfg.Disruption.RollbackWindow.Duration = 60 * time.Second
	}
	if cfg.Disruption.PollInterval.Duration == 0 {
		cfg.Disruption.PollInterval.Duration = 200 * time.Millisecond
	}
	// Failed runs preserve their resources even when the field is omitted.
	cfg.Cleanup.PreserveOnFailure = true
}
