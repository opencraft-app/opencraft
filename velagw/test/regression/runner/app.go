package runner

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"regexp"
	"strings"
	"time"

	"git.woa.com/wisp/mono2/llmgateway/test/regression/cases"
	"git.woa.com/wisp/mono2/llmgateway/test/regression/clients"
	"git.woa.com/wisp/mono2/llmgateway/test/regression/framework"
)

var runIDPattern = regexp.MustCompile(`^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$`)

const (
	AdminTokenEnv    = "LLMGATEWAY_REGRESSION_ADMIN_TOKEN"
	InternalTokenEnv = "LLMGATEWAY_REGRESSION_INTERNAL_TOKEN"
)

type Credentials struct {
	AdminToken    string
	InternalToken string
}

type Execution struct {
	Report       framework.Report
	JSON         []byte
	JUnit        []byte
	ReportHash   string
	ReportStored bool
}

func CredentialsFromEnvironment() (Credentials, error) {
	result := Credentials{
		AdminToken:    strings.TrimSpace(os.Getenv(AdminTokenEnv)),
		InternalToken: strings.TrimSpace(os.Getenv(InternalTokenEnv)),
	}
	if result.AdminToken == "" || result.InternalToken == "" {
		return Credentials{}, fmt.Errorf("%s and %s are required", AdminTokenEnv, InternalTokenEnv)
	}
	return result, nil
}

func Cleanup(ctx context.Context, cfg Config, credentials Credentials, runID string) (string, error) {
	if len(runID) > 48 || !runIDPattern.MatchString(runID) {
		return "", fmt.Errorf("run ID must be a lowercase Kubernetes label of at most 48 characters")
	}
	if strings.TrimSpace(cfg.Target.ControlURL) == "" {
		return "", fmt.Errorf("target.controlURL is required")
	}
	if strings.TrimSpace(credentials.AdminToken) == "" {
		return "", fmt.Errorf("regression admin credential is required")
	}
	sanitizer := framework.NewSanitizer()
	control := clients.NewControlClient(
		cfg.Target.ControlURL,
		sanitizer.Secret(credentials.AdminToken), sanitizer.Secret(credentials.InternalToken),
		&http.Client{Timeout: 120 * time.Second}, sanitizer,
	)
	userID := cases.RegressionUserID(runID)
	if err := control.DeleteTenant(ctx, userID, "regression-cleanup:"+runID, cfg.Rollout.CleanupTimeout.Duration); err != nil {
		return userID, sanitizer.Error(err)
	}
	return userID, nil
}

func Execute(ctx context.Context, cfg Config, credentials Credentials, kube *clients.KubernetesClient, runID string) (Execution, error) {
	inCluster := kube != nil
	if err := cfg.Validate(inCluster); err != nil {
		return Execution{}, err
	}
	if strings.TrimSpace(credentials.AdminToken) == "" || strings.TrimSpace(credentials.InternalToken) == "" {
		return Execution{}, fmt.Errorf("regression credentials are required")
	}
	if strings.TrimSpace(runID) == "" {
		return Execution{}, fmt.Errorf("run ID is required")
	}
	if len(runID) > 48 || !runIDPattern.MatchString(runID) {
		return Execution{}, fmt.Errorf("run ID must be a lowercase Kubernetes label of at most 48 characters")
	}

	sanitizer := framework.NewSanitizer()
	adminToken := sanitizer.Secret(credentials.AdminToken)
	internalToken := sanitizer.Secret(credentials.InternalToken)
	controlHTTP := &http.Client{Timeout: 120 * time.Second}
	trafficHTTP := &http.Client{Transport: &http.Transport{
		MaxIdleConns: 256, MaxIdleConnsPerHost: 128, IdleConnTimeout: 90 * time.Second,
	}}
	control := clients.NewControlClient(cfg.Target.ControlURL, adminToken, internalToken, controlHTTP, sanitizer)
	traffic := clients.NewTrafficClient(trafficHTTP, sanitizer)
	caseConfig := toCaseConfig(cfg)
	infrastructure := cases.CombinedInfrastructure{cases.HTTPInfrastructure{}}
	capabilities := []framework.Capability{}
	if kube != nil {
		infrastructure = append(infrastructure, cases.KubernetesInfrastructure{Cluster: kube})
		capabilities = append(capabilities, framework.CapabilityKubernetesAPI, framework.CapabilityClusterPodNetwork)
		if isDisruptiveScenario(cfg.Scenario) {
			capabilities = append(capabilities, framework.CapabilityDisruptiveKubernetes)
		}
	}
	allCases := cases.NewControlCases(caseConfig, cases.Dependencies{
		Control: control, Traffic: traffic, Infrastructure: infrastructure,
	})
	if kube != nil {
		allCases = append(allCases, cases.NewRolloutCases(caseConfig, cases.RolloutDependencies{Traffic: traffic, Cluster: kube})...)
		allCases = append(allCases, cases.NewCampaignCases(caseConfig, cases.CampaignDependencies{Control: control, Traffic: traffic})...)
		faults := clients.NewPacerFaultClient(trafficHTTP, sanitizer)
		allCases = append(allCases, cases.NewDisruptionCases(caseConfig, cases.DisruptionDependencies{
			Control: control, Cluster: kube, Faults: faults, FaultToken: internalToken,
		})...)
		allCases = append(allCases, cases.NewManagerTakeoverCases(caseConfig, cases.ManagerTakeoverDependencies{
			Control: control, Cluster: kube, Traffic: traffic,
		})...)
		allCases = append(allCases, cases.NewControlPlaneOutageCases(caseConfig, cases.ControlPlaneOutageDependencies{
			Control: control, Cluster: kube, Traffic: traffic,
		})...)
		allCases = append(allCases, cases.NewSetRuntimeFailureCases(caseConfig, cases.SetRuntimeFailureDependencies{
			Cluster: kube, Traffic: traffic,
		})...)
	}
	scenario, err := scenarioForName(cfg.Scenario)
	if err != nil {
		return Execution{}, err
	}
	run := framework.NewRunContext(runID, sanitizer)
	report, runErr := framework.NewRunner(allCases, capabilities).Run(ctx, scenario, run)
	jsonReport, jsonErr := report.JSON(sanitizer)
	junitReport, junitErr := report.JUnit(sanitizer)
	execution := Execution{Report: report, JSON: jsonReport, JUnit: junitReport}
	resultErr := errors.Join(runErr, jsonErr, junitErr)
	if kube != nil && jsonErr == nil && junitErr == nil {
		reportCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		hash, storeErr := kube.CreateReportConfigMap(reportCtx, cfg.Target.Namespace, runID, jsonReport, junitReport)
		if storeErr != nil {
			resultErr = errors.Join(resultErr, fmt.Errorf("store regression report: %w", storeErr))
		} else {
			execution.ReportHash = hash
			execution.ReportStored = true
		}
	}
	return execution, resultErr
}

func scenarioForName(name string) (framework.Scenario, error) {
	switch name {
	case "tenant_onboarding_gate":
		return cases.TenantOnboardingGate(), nil
	case "model_delivery_gate":
		return cases.ModelDeliveryGate(), nil
	case "preprod_release_gate":
		return cases.PreprodReleaseGate(), nil
	case "fleet_release_campaign_gate":
		return cases.FleetCampaignGate(), nil
	case "set_upgrade_rollback_gate":
		return cases.SetUpgradeRollbackGate(), nil
	case "set_manager_takeover_gate":
		return cases.SetManagerTakeoverGate(), nil
	case "control_plane_outage_gate":
		return cases.ControlPlaneOutageGate(), nil
	case "set_traffic_pod_failure_gate":
		return cases.SetTrafficPodFailureGate(), nil
	default:
		return framework.Scenario{}, fmt.Errorf("unknown scenario %q", name)
	}
}

func toCaseConfig(cfg Config) cases.Config {
	managerCronJob := cfg.Disruption.ManagerCronJob
	if cfg.Scenario == "control_plane_outage_gate" {
		managerCronJob = cfg.ControlPlaneOutage.ManagerCronJob
	}
	return cases.Config{
		Namespace: cfg.Target.Namespace, TrafficDeployment: cfg.Target.TrafficDeployment,
		ControlURL: cfg.Target.ControlURL, TrafficURL: cfg.Target.TrafficURL, MockURL: cfg.Target.MockURL, PacerURL: cfg.Target.PacerURL,
		TargetSets: append([]string(nil), cfg.Target.TargetSets...), PlanID: cfg.Target.PlanID,
		ChannelBundleID: cfg.Target.ChannelBundleID, PricingBundleID: cfg.Target.PricingBundleID, Model: cfg.Target.Model,
		LongStreamModel: cfg.Target.LongStreamModel, Marker: cfg.Target.Marker,
		ConsistencyTimeout: cfg.Rollout.ConsistencyTimeout.Duration,
		CleanupTimeout:     cfg.Rollout.CleanupTimeout.Duration,
		SSEDuration:        cfg.Rollout.SSEDuration.Duration, SSETolerance: cfg.Rollout.SSETolerance.Duration,
		PinnedStreamHeadroom: cfg.Rollout.PinnedStreamHeadroom.Duration,
		RequestInterval:      cfg.Rollout.RequestInterval.Duration, RolloutPollInterval: cfg.Rollout.PollInterval.Duration,
		RolloutTimeout: cfg.Rollout.Timeout.Duration, LeaseTTL: cfg.Rollout.LeaseTTL.Duration,
		MinPreSamples: cfg.Rollout.MinPreSamples, MinRolloutSamples: cfg.Rollout.MinRolloutSamples,
		MinPostSamples:                      cfg.Rollout.MinPostSamples,
		TargetReleaseID:                     cfg.Campaign.TargetReleaseID,
		ExpectedReleaseRings:                append([]string(nil), cfg.Campaign.ExpectedRings...),
		CampaignTimeout:                     cfg.Campaign.Timeout.Duration,
		CampaignPollInterval:                cfg.Campaign.PollInterval.Duration,
		CampaignRequestInterval:             cfg.Campaign.RequestInterval.Duration,
		MinCampaignSamples:                  cfg.Campaign.MinSamples,
		TargetImage:                         cfg.Disruption.TargetImage,
		UpgradeSource:                       cfg.Disruption.Source,
		UpgradeFleet:                        cfg.Disruption.Fleet,
		ManagerCronJob:                      managerCronJob,
		ManagerImage:                        cfg.Disruption.ManagerImage,
		UpgradeProbeModel:                   cfg.Disruption.ProbeModel,
		DisruptionTimeout:                   cfg.Disruption.Timeout.Duration,
		UpgradeDrainTimeout:                 cfg.Disruption.DrainTimeout.Duration,
		UpgradeRollbackWindow:               cfg.Disruption.RollbackWindow.Duration,
		DisruptionPollInterval:              cfg.Disruption.PollInterval.Duration,
		ControlPlaneOutageControlDeployment: cfg.ControlPlaneOutage.ControlDeployment,
		ControlPlaneOutageWorkerDeployments: append([]string(nil), cfg.ControlPlaneOutage.WorkerDeployments...),
		ControlPlaneOutageBacklogJob:        cfg.ControlPlaneOutage.BacklogJob,
		ControlPlaneOutageDuration:          cfg.ControlPlaneOutage.OutageDuration.Duration,
		ControlPlaneOutageTrafficInterval:   cfg.ControlPlaneOutage.TrafficInterval.Duration,
		ControlPlaneOutageMinSamples:        cfg.ControlPlaneOutage.MinimumSamples,
		ControlPlaneOutageRecoveryTimeout:   cfg.ControlPlaneOutage.RecoveryTimeout.Duration,
	}
}
