package runner

import (
	"strings"
	"testing"
	"time"
)

func TestParseConfigUsesHumanDurationsAndRequiresStableTargets(t *testing.T) {
	cfg, err := ParseConfig(strings.NewReader(`
scenario: preprod_release_gate
target:
  namespace: llmgateway
  trafficDeployment: llmgateway-traffic
  controlURL: http://llmgateway-control
  trafficURL: http://llmgateway-traffic
  mockURL: http://cloud-mockllm:8080
  pacerURL: http://llmgateway-regression-pacer:18082
  targetSets: [set-a, set-b]
  planID: regression-monthly
  channelBundleID: regression-mock-channel
  model: llmgw-regression-chat
  longStreamModel: llmgw-regression-long
  marker: regression-marker
rollout:
  sseDuration: 3m
  requestInterval: 1s
  timeout: 15m
`))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Rollout.SSEDuration.Duration != 3*time.Minute || cfg.Rollout.PinnedStreamHeadroom.Duration != 30*time.Second || cfg.Rollout.Timeout.Duration != 15*time.Minute {
		t.Fatalf("rollout = %+v", cfg.Rollout)
	}
	if len(cfg.Target.TargetSets) != 2 || cfg.Target.PlanID != "regression-monthly" {
		t.Fatalf("target = %+v", cfg.Target)
	}
}

func TestParseConfigRejectsSecretFields(t *testing.T) {
	_, err := ParseConfig(strings.NewReader(`
scenario: model_delivery_gate
adminToken: must-not-be-in-yaml
target:
  namespace: llmgateway
  controlURL: http://control
  trafficURL: http://traffic
  pacerURL: http://pacer
  targetSets: [set-a]
  planID: plan
  channelBundleID: bundle
  model: model
  marker: marker
`))
	if err == nil || !strings.Contains(err.Error(), "field adminToken not found") {
		t.Fatalf("parse error = %v", err)
	}
}

func TestConfigRejectsRolloutOutsideCluster(t *testing.T) {
	cfg := validConfig()
	err := cfg.Validate(false)
	if err == nil || err.Error() != "scenario preprod_release_gate requires an in-cluster Kubernetes Job" {
		t.Fatalf("validate error = %v", err)
	}
}

func TestConfigRejectsPinnedStreamWithoutCompletionHeadroom(t *testing.T) {
	cfg := validConfig()
	cfg.Rollout.SSEDuration.Duration = time.Minute
	cfg.Rollout.SSETolerance.Duration = 5 * time.Second
	cfg.Rollout.PinnedStreamHeadroom.Duration = time.Minute
	err := cfg.Validate(true)
	if err == nil || err.Error() != "rollout.pinnedStreamHeadroom must be shorter than sseDuration minus sseTolerance" {
		t.Fatalf("validate error = %v", err)
	}
}

func TestFleetCampaignConfigRequiresReleaseTopologyAndCluster(t *testing.T) {
	cfg := validConfig()
	cfg.Scenario = "fleet_release_campaign_gate"
	if err := cfg.Validate(true); err == nil || !strings.Contains(err.Error(), "campaign.targetReleaseID") {
		t.Fatalf("missing target release error = %v", err)
	}
	cfg.Campaign.TargetReleaseID = "release-v2"
	cfg.Campaign.ExpectedRings = []string{"canary", "stable"}
	if err := cfg.Validate(false); err == nil || !strings.Contains(err.Error(), "requires an in-cluster Kubernetes Job") {
		t.Fatalf("outside cluster error = %v", err)
	}
	if err := cfg.Validate(true); err != nil {
		t.Fatal(err)
	}
}

func TestDisruptiveScenariosRequireOneSetAndPinnedTargetImage(t *testing.T) {
	for _, scenario := range []string{"set_upgrade_rollback_gate", "set_manager_takeover_gate"} {
		cfg := validConfig()
		cfg.Scenario = scenario
		if err := cfg.Validate(true); err == nil || !strings.Contains(err.Error(), "disruption.targetImage") {
			t.Fatalf("%s missing image error = %v", scenario, err)
		}
		cfg.Disruption.TargetImage = "registry/new-api:latest"
		if err := cfg.Validate(true); err == nil || !strings.Contains(err.Error(), "sha256") {
			t.Fatalf("%s mutable image error = %v", scenario, err)
		}
		cfg.Disruption.TargetImage = "registry/new-api@sha256:" + strings.Repeat("a", 64)
		if err := cfg.Validate(true); err == nil || !strings.Contains(err.Error(), "managerImage") {
			t.Fatalf("%s missing manager image error = %v", scenario, err)
		}
		cfg.Disruption.ManagerImage = "registry/llmgateway@sha256:" + strings.Repeat("b", 64)
		cfg.Target.TargetSets = []string{"set-a", "set-b"}
		if err := cfg.Validate(true); err == nil || !strings.Contains(err.Error(), "exactly one") {
			t.Fatalf("%s multiple sets error = %v", scenario, err)
		}
		cfg.Target.TargetSets = []string{"set-a"}
		if err := cfg.Validate(false); err == nil || !strings.Contains(err.Error(), "in-cluster") {
			t.Fatalf("%s outside cluster error = %v", scenario, err)
		}
		if err := cfg.Validate(true); err != nil {
			t.Fatalf("%s valid config: %v", scenario, err)
		}
		withDefaults := cfg
		applyDefaults(&withDefaults)
		if withDefaults.Disruption.PollInterval.Duration != 200*time.Millisecond {
			t.Fatalf("%s disruption poll interval = %s", scenario, withDefaults.Disruption.PollInterval.Duration)
		}
	}
}

func validConfig() Config {
	return Config{
		Scenario: "preprod_release_gate",
		Target: TargetConfig{
			Namespace: "llmgateway", TrafficDeployment: "llmgateway-traffic",
			ControlURL: "http://control", TrafficURL: "http://traffic", MockURL: "http://mock", PacerURL: "http://pacer",
			TargetSets: []string{"set-a"}, PlanID: "plan", ChannelBundleID: "bundle",
			Model: "model", LongStreamModel: "long-model", Marker: "marker",
		},
	}
}

func TestControlPlaneOutageConfigDefaultsAndRejectsOverlappingDeployments(t *testing.T) {
	cfg := validConfig()
	cfg.Scenario = "control_plane_outage_gate"
	applyDefaults(&cfg)
	if cfg.ControlPlaneOutage.OutageDuration.Duration != 90*time.Second || cfg.ControlPlaneOutage.MinimumSamples != 60 {
		t.Fatalf("defaults = %+v", cfg.ControlPlaneOutage)
	}
	if err := cfg.Validate(true); err != nil {
		t.Fatal(err)
	}
	cfg.ControlPlaneOutage.WorkerDeployments = append(cfg.ControlPlaneOutage.WorkerDeployments, cfg.ControlPlaneOutage.ControlDeployment)
	if err := cfg.Validate(true); err == nil || !strings.Contains(err.Error(), "must be unique") {
		t.Fatalf("error = %v", err)
	}
}
