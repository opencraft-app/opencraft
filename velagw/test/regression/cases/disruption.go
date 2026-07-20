package cases

import (
	"context"
	"crypto/sha256"
	"fmt"
	"net"
	"net/url"
	"strconv"
	"strings"
	"time"

	"git.woa.com/wisp/mono2/llmgateway/test/regression/clients"
	"git.woa.com/wisp/mono2/llmgateway/test/regression/framework"
)

const (
	CaseGreenProbeRollback = "green_probe_failure_is_contained_and_retry_completes"
	CasePostSwitchRollback = "post_switch_failure_rolls_back_and_retry_completes"
	CaseManagerTakeover    = "set_manager_lease_takeover_completes_each_critical_stage_exactly_once"
)

type DisruptionControl interface {
	ListCampaignSets(context.Context) ([]clients.ManagedSet, error)
	CreateSetUpgrade(context.Context, clients.SetUpgradeInput) (clients.SetUpgradeBatch, error)
	SetUpgrade(context.Context, string) (clients.SetUpgradeBatch, error)
	RetrySetUpgradeRun(context.Context, string) (clients.SetUpgradeRun, error)
}

type DisruptionCluster interface {
	ListPods(context.Context, string, string) ([]clients.Pod, error)
	GetCronJob(context.Context, string, string) (clients.CronJob, error)
	ListActiveCronJobJobs(context.Context, string, string) ([]clients.Job, error)
	SetCronJobSuspended(context.Context, string, string, bool) error
	CreateSetManagerJob(context.Context, string, string, string, string, string, string, string) error
	GetJob(context.Context, string, string) (clients.Job, error)
	DeleteControlledJob(context.Context, string, string) error
}

type PacerFaults interface {
	Apply(context.Context, []string, framework.Secret, clients.PacerFaultPolicy) error
}

type DisruptionDependencies struct {
	Control    DisruptionControl
	Cluster    DisruptionCluster
	Faults     PacerFaults
	FaultToken framework.Secret
}

type ManagerTakeoverDependencies struct {
	Control DisruptionControl
	Cluster DisruptionCluster
	Traffic TrafficPlane
}

func NewDisruptionCases(cfg Config, deps DisruptionDependencies) []framework.Case {
	cfg = withDisruptionDefaults(withConfigDefaults(cfg))
	requires := []framework.Capability{
		framework.CapabilityKubernetesAPI,
		framework.CapabilityClusterPodNetwork,
		framework.CapabilityDisruptiveKubernetes,
	}
	return []framework.Case{
		framework.CaseFunc{
			CaseID: CaseGreenProbeRollback, DependsOn: []string{CaseKeyStreamsChat}, Requires: requires,
			RunFunc: func(ctx context.Context, run *framework.RunContext) (framework.Observations, error) {
				return greenProbeFailureContained(ctx, run, cfg, deps)
			},
		},
		framework.CaseFunc{
			CaseID: CasePostSwitchRollback, DependsOn: []string{CaseGreenProbeRollback}, Requires: requires,
			RunFunc: func(ctx context.Context, run *framework.RunContext) (framework.Observations, error) {
				return postSwitchFailureRolledBack(ctx, run, cfg, deps)
			},
		},
	}
}

func SetUpgradeRollbackGate() framework.Scenario {
	return framework.Scenario{Name: "set_upgrade_rollback_gate", Cases: []string{
		CasePlatformReady, CaseChannelDelivery, CaseTenantOnboarded, CaseTenantAPIKey,
		CaseModelEffective, CaseKeyCompletesChat, CaseKeyStreamsChat,
		CaseGreenProbeRollback, CasePostSwitchRollback,
	}}
}

func NewManagerTakeoverCases(cfg Config, deps ManagerTakeoverDependencies) []framework.Case {
	cfg = withDisruptionDefaults(withConfigDefaults(cfg))
	return []framework.Case{framework.CaseFunc{
		CaseID: CaseManagerTakeover, DependsOn: []string{CaseKeyStreamsChat},
		Requires: []framework.Capability{
			framework.CapabilityKubernetesAPI,
			framework.CapabilityClusterPodNetwork,
			framework.CapabilityDisruptiveKubernetes,
		},
		RunFunc: func(ctx context.Context, run *framework.RunContext) (framework.Observations, error) {
			return setManagerLeaseTakeover(ctx, run, cfg, deps)
		},
	}}
}

func SetManagerTakeoverGate() framework.Scenario {
	return framework.Scenario{Name: "set_manager_takeover_gate", Cases: []string{
		CasePlatformReady, CaseChannelDelivery, CaseTenantOnboarded, CaseTenantAPIKey,
		CaseModelEffective, CaseKeyCompletesChat, CaseKeyStreamsChat, CaseManagerTakeover,
	}}
}

func setManagerLeaseTakeover(ctx context.Context, run *framework.RunContext, cfg Config, deps ManagerTakeoverDependencies) (framework.Observations, error) {
	if deps.Control == nil || deps.Cluster == nil || deps.Traffic == nil {
		return nil, fmt.Errorf("manager takeover control, cluster and traffic dependencies are required")
	}
	if len(cfg.TargetSets) != 1 {
		return nil, fmt.Errorf("manager takeover regression requires exactly one isolated target Set")
	}
	restoreCron, err := suspendSetManagerCronJob(ctx, cfg, deps.Cluster)
	if err != nil {
		return nil, err
	}
	defer func() {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		_ = restoreCron(cleanupCtx)
	}()
	run.DeferSafetyCleanup("resume set-manager CronJob", func(cleanupCtx context.Context) error {
		return restoreCron(cleanupCtx)
	})

	stages := []string{"preparing", "switching", "draining"}
	jobCounter := 0
	leaseOwners := make(map[string]string, len(stages))
	for _, stage := range stages {
		baseline, err := getTargetSet(ctx, deps.Control, cfg.TargetSets[0])
		if err != nil {
			return nil, err
		}
		batch, err := createRegressionUpgrade(ctx, cfg, deps.Control)
		if err != nil {
			return nil, err
		}
		run.TrackResource(framework.ResourceRef{Kind: "set_upgrade", ID: batch.ID, SetID: baseline.ID})
		held, jobName, err := driveUpgradeToHeldStage(ctx, run, cfg, deps, batch.ID, stage, &jobCounter)
		if err != nil {
			return nil, err
		}
		leaseOwners[stage] = held.LeaseOwner
		defer func(name string) {
			cleanupCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			_ = deps.Cluster.DeleteControlledJob(cleanupCtx, cfg.Namespace, name)
		}(jobName)
		if err := deps.Cluster.DeleteControlledJob(ctx, cfg.Namespace, jobName); err != nil {
			return nil, err
		}
		if err := waitForUpgradeLeaseExpiry(ctx, cfg, deps.Control, batch.ID, held.LeaseOwner); err != nil {
			return nil, err
		}
		chat, err := deps.Traffic.Chat(ctx, cfg.TrafficURL, runSecret(run, stateAPIKey), cfg.Model, cfg.Marker)
		if err != nil {
			return nil, fmt.Errorf("traffic failed while %s lease was unowned: %w", stage, err)
		}
		if chat.StatusCode < 200 || chat.StatusCode >= 300 {
			return nil, fmt.Errorf("traffic returned %d while %s lease was unowned", chat.StatusCode, stage)
		}
		completed, replacementJob, err := driveUpgrade(ctx, run, cfg, DisruptionDependencies{
			Control: deps.Control, Cluster: deps.Cluster,
		}, batch.ID, nil, func(current clients.SetUpgradeRun) bool {
			return current.Status == "completed"
		}, &jobCounter)
		if err != nil {
			return nil, err
		}
		if replacementJob == "" || completed.LeaseOwner != replacementJob {
			return nil, fmt.Errorf("uncontrolled replacement manager %q completed %s lease; expected %q", completed.LeaseOwner, stage, replacementJob)
		}
		after, err := getTargetSet(ctx, deps.Control, baseline.ID)
		if err != nil {
			return nil, err
		}
		if err := validateSuccessfulGenerationTransition(baseline, after); err != nil {
			return nil, fmt.Errorf("%s takeover: %w", stage, err)
		}
	}
	return framework.Observations{
		"set_id": cfg.TargetSets[0], "completed_stages": len(stages),
		"stages": stages, "terminated_lease_owners": leaseOwners, "manager_jobs": jobCounter,
	}, nil
}

func driveUpgradeToHeldStage(ctx context.Context, run *framework.RunContext, cfg Config, deps ManagerTakeoverDependencies, batchID, stage string, jobCounter *int) (clients.SetUpgradeRun, string, error) {
	deadline := time.Now().Add(cfg.DisruptionTimeout)
	jobName := ""
	returningHeldJob := false
	defer func() {
		if jobName == "" || returningHeldJob {
			return
		}
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		_ = deps.Cluster.DeleteControlledJob(cleanupCtx, cfg.Namespace, jobName)
	}()
	for time.Now().Before(deadline) {
		batch, err := deps.Control.SetUpgrade(ctx, batchID)
		if err != nil {
			return clients.SetUpgradeRun{}, "", err
		}
		if len(batch.Runs) != 1 {
			return clients.SetUpgradeRun{}, "", fmt.Errorf("Set upgrade batch %q must contain exactly one run", batchID)
		}
		current := batch.Runs[0]
		if current.Status == stage && current.LeaseOwner != "" && current.LeaseUntil.After(time.Now()) {
			if jobName == "" || current.LeaseOwner != jobName {
				return clients.SetUpgradeRun{}, "", fmt.Errorf("upgrade hold stage %q was claimed by uncontrolled manager %q; expected %q", stage, current.LeaseOwner, jobName)
			}
			returningHeldJob = true
			return current, jobName, nil
		}
		if current.Status == "failed" || current.Status == "rolled_back" || current.Status == "completed" {
			return clients.SetUpgradeRun{}, "", fmt.Errorf("Set upgrade reached %q before hold stage %q: %s", current.Status, stage, current.LastError)
		}
		needJob := jobName == ""
		if jobName != "" {
			job, jobErr := deps.Cluster.GetJob(ctx, cfg.Namespace, jobName)
			if jobErr != nil {
				return clients.SetUpgradeRun{}, "", jobErr
			}
			needJob = job.Status.Succeeded > 0 || job.Status.Failed > 0
		}
		if needJob {
			if jobName != "" {
				if err := deps.Cluster.DeleteControlledJob(ctx, cfg.Namespace, jobName); err != nil {
					return clients.SetUpgradeRun{}, "", err
				}
			}
			(*jobCounter)++
			jobName = regressionJobName(run.RunID, "hold-"+stage, *jobCounter)
			if err := deps.Cluster.CreateSetManagerJob(ctx, cfg.Namespace, cfg.ManagerCronJob, jobName, cfg.ManagerImage, cfg.UpgradeProbeModel, stage, run.RunID); err != nil {
				return clients.SetUpgradeRun{}, "", err
			}
			created := jobName
			run.DeferSafetyCleanup("delete controlled set-manager Job "+created, func(cleanupCtx context.Context) error {
				return deps.Cluster.DeleteControlledJob(cleanupCtx, cfg.Namespace, created)
			})
		}
		if err := wait(ctx, cfg.DisruptionPollInterval); err != nil {
			return clients.SetUpgradeRun{}, "", err
		}
	}
	return clients.SetUpgradeRun{}, "", fmt.Errorf("Set upgrade %q did not reach held stage %q before timeout", batchID, stage)
}

func waitForUpgradeLeaseExpiry(ctx context.Context, cfg Config, control DisruptionControl, batchID, previousOwner string) error {
	deadline := time.Now().Add(cfg.DisruptionTimeout)
	for time.Now().Before(deadline) {
		batch, err := control.SetUpgrade(ctx, batchID)
		if err != nil {
			return err
		}
		if len(batch.Runs) != 1 {
			return fmt.Errorf("Set upgrade batch %q must contain exactly one run", batchID)
		}
		run := batch.Runs[0]
		if run.LeaseOwner == previousOwner && !run.LeaseUntil.After(time.Now()) {
			return nil
		}
		if err := wait(ctx, cfg.DisruptionPollInterval); err != nil {
			return err
		}
	}
	return fmt.Errorf("Set upgrade %q lease owned by %q did not expire before timeout", batchID, previousOwner)
}

func greenProbeFailureContained(ctx context.Context, run *framework.RunContext, cfg Config, deps DisruptionDependencies) (framework.Observations, error) {
	baseline, pacerURLs, cleanup, err := prepareDisruption(ctx, run, cfg, deps)
	if err != nil {
		return nil, err
	}
	defer cleanup()

	batch, err := createRegressionUpgrade(ctx, cfg, deps.Control)
	if err != nil {
		return nil, err
	}
	run.TrackResource(framework.ResourceRef{Kind: "set_upgrade", ID: batch.ID, SetID: baseline.ID})
	jobCounter := 0
	faultEnabled := false
	failed, _, err := driveUpgrade(ctx, run, cfg, deps, batch.ID, func(current clients.SetUpgradeRun) error {
		if current.Status != "probing" || current.ConsecutiveProbeSuccesses < 1 || faultEnabled {
			return nil
		}
		faultEnabled = true
		return deps.Faults.Apply(ctx, pacerURLs, deps.FaultToken, probeFailurePolicy(cfg))
	}, func(current clients.SetUpgradeRun) bool {
		return current.Status == "failed"
	}, &jobCounter)
	if err != nil {
		return nil, err
	}
	if !faultEnabled || failed.Status != "failed" || failed.ConsecutiveProbeFailures < 3 {
		return nil, fmt.Errorf("green probe fault did not produce a contained failed upgrade")
	}
	afterFailure, err := getTargetSet(ctx, deps.Control, baseline.ID)
	if err != nil {
		return nil, err
	}
	if afterFailure.ActiveRuntimeGeneration != baseline.ActiveRuntimeGeneration || afterFailure.RouteRevision != baseline.RouteRevision {
		return nil, fmt.Errorf("green probe failure changed active generation or route revision")
	}
	if err := deps.Faults.Apply(ctx, pacerURLs, deps.FaultToken, clients.PacerFaultPolicy{}); err != nil {
		return nil, err
	}
	faultEnabled = false
	if _, err := deps.Control.RetrySetUpgradeRun(ctx, failed.ID); err != nil {
		return nil, err
	}
	recovered, _, err := driveUpgrade(ctx, run, cfg, deps, batch.ID, nil, func(current clients.SetUpgradeRun) bool {
		return current.Status == "completed"
	}, &jobCounter)
	if err != nil {
		return nil, err
	}
	afterRecovery, err := getTargetSet(ctx, deps.Control, baseline.ID)
	if err != nil {
		return nil, err
	}
	if err := validateSuccessfulGenerationTransition(baseline, afterRecovery); err != nil {
		return nil, err
	}
	return framework.Observations{
		"set_id": baseline.ID, "failure_status": failed.Status, "recovery_status": recovered.Status,
		"from_generation": baseline.ActiveRuntimeGeneration, "to_generation": afterRecovery.ActiveRuntimeGeneration,
		"manager_jobs": jobCounter,
	}, nil
}

func postSwitchFailureRolledBack(ctx context.Context, run *framework.RunContext, cfg Config, deps DisruptionDependencies) (framework.Observations, error) {
	baseline, pacerURLs, cleanup, err := prepareDisruption(ctx, run, cfg, deps)
	if err != nil {
		return nil, err
	}
	defer cleanup()

	batch, err := createRegressionUpgrade(ctx, cfg, deps.Control)
	if err != nil {
		return nil, err
	}
	run.TrackResource(framework.ResourceRef{Kind: "set_upgrade", ID: batch.ID, SetID: baseline.ID})
	jobCounter := 0
	faultEnabled := false
	rolledBack, _, err := driveUpgrade(ctx, run, cfg, deps, batch.ID, func(current clients.SetUpgradeRun) error {
		if current.Status != "draining" || faultEnabled {
			return nil
		}
		faultEnabled = true
		return deps.Faults.Apply(ctx, pacerURLs, deps.FaultToken, probeFailurePolicy(cfg))
	}, func(current clients.SetUpgradeRun) bool {
		return current.Status == "rolled_back"
	}, &jobCounter)
	if err != nil {
		return nil, err
	}
	if !faultEnabled || rolledBack.Status != "rolled_back" || rolledBack.ConsecutiveProbeFailures < 3 {
		return nil, fmt.Errorf("post-switch probe fault did not roll back the upgrade")
	}
	afterRollback, err := getTargetSet(ctx, deps.Control, baseline.ID)
	if err != nil {
		return nil, err
	}
	if afterRollback.ActiveRuntimeGeneration != baseline.ActiveRuntimeGeneration {
		return nil, fmt.Errorf("rollback did not restore generation %d", baseline.ActiveRuntimeGeneration)
	}
	if afterRollback.RouteRevision <= baseline.RouteRevision {
		return nil, fmt.Errorf("rollback did not publish a newer route revision")
	}
	if err := deps.Faults.Apply(ctx, pacerURLs, deps.FaultToken, clients.PacerFaultPolicy{}); err != nil {
		return nil, err
	}
	faultEnabled = false
	recoveryBatch, err := createRegressionUpgrade(ctx, cfg, deps.Control)
	if err != nil {
		return nil, err
	}
	run.TrackResource(framework.ResourceRef{Kind: "set_upgrade", ID: recoveryBatch.ID, SetID: baseline.ID})
	recovered, _, err := driveUpgrade(ctx, run, cfg, deps, recoveryBatch.ID, nil, func(current clients.SetUpgradeRun) bool {
		return current.Status == "completed"
	}, &jobCounter)
	if err != nil {
		return nil, err
	}
	afterRecovery, err := getTargetSet(ctx, deps.Control, baseline.ID)
	if err != nil {
		return nil, err
	}
	if err := validateSuccessfulGenerationTransition(baseline, afterRecovery); err != nil {
		return nil, err
	}
	return framework.Observations{
		"set_id": baseline.ID, "failure_status": rolledBack.Status, "recovery_status": recovered.Status,
		"from_generation": baseline.ActiveRuntimeGeneration, "to_generation": afterRecovery.ActiveRuntimeGeneration,
		"rollback_route_revision": afterRollback.RouteRevision, "manager_jobs": jobCounter,
	}, nil
}

func prepareDisruption(ctx context.Context, run *framework.RunContext, cfg Config, deps DisruptionDependencies) (clients.ManagedSet, []string, func(), error) {
	if deps.Control == nil || deps.Cluster == nil || deps.Faults == nil || deps.FaultToken.Empty() {
		return clients.ManagedSet{}, nil, func() {}, fmt.Errorf("disruption control, cluster, pacer faults and token are required")
	}
	if len(cfg.TargetSets) != 1 {
		return clients.ManagedSet{}, nil, func() {}, fmt.Errorf("destructive upgrade regression requires exactly one isolated target Set")
	}
	baseline, err := getTargetSet(ctx, deps.Control, cfg.TargetSets[0])
	if err != nil {
		return clients.ManagedSet{}, nil, func() {}, err
	}
	pods, err := deps.Cluster.ListPods(ctx, cfg.Namespace, "app=llmgateway-regression-pacer")
	if err != nil {
		return clients.ManagedSet{}, nil, func() {}, err
	}
	pacerURLs := make([]string, 0, len(pods))
	for _, pod := range pods {
		if pod.IsReady() && strings.TrimSpace(pod.Status.PodIP) != "" {
			pacerURLs = append(pacerURLs, (&url.URL{Scheme: "http", Host: net.JoinHostPort(pod.Status.PodIP, strconv.Itoa(18082))}).String())
		}
	}
	if len(pacerURLs) == 0 {
		return clients.ManagedSet{}, nil, func() {}, fmt.Errorf("no ready regression pacer Pod is available")
	}
	restoreCron, err := suspendSetManagerCronJob(ctx, cfg, deps.Cluster)
	if err != nil {
		return clients.ManagedSet{}, nil, func() {}, err
	}
	cleanup := func() {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		_ = deps.Faults.Apply(cleanupCtx, pacerURLs, deps.FaultToken, clients.PacerFaultPolicy{})
	}
	run.DeferSafetyCleanup("disable regression pacer fault", func(cleanupCtx context.Context) error {
		return deps.Faults.Apply(cleanupCtx, pacerURLs, deps.FaultToken, clients.PacerFaultPolicy{})
	})
	run.DeferSafetyCleanup("resume set-manager CronJob", func(cleanupCtx context.Context) error {
		return restoreCron(cleanupCtx)
	})
	return baseline, pacerURLs, cleanup, nil
}

func createRegressionUpgrade(ctx context.Context, cfg Config, control DisruptionControl) (clients.SetUpgradeBatch, error) {
	batch, err := control.CreateSetUpgrade(ctx, clients.SetUpgradeInput{
		SetID: cfg.TargetSets[0], TargetImage: cfg.TargetImage, Source: cfg.UpgradeSource,
		Namespace: cfg.Namespace, Fleet: cfg.UpgradeFleet,
		DrainTimeout: cfg.UpgradeDrainTimeout, RollbackWindow: cfg.UpgradeRollbackWindow,
	})
	if err != nil {
		return clients.SetUpgradeBatch{}, err
	}
	if batch.ID == "" || len(batch.Runs) != 1 || batch.Runs[0].SetID != cfg.TargetSets[0] {
		return clients.SetUpgradeBatch{}, fmt.Errorf("created Set upgrade batch is incomplete")
	}
	return batch, nil
}

func driveUpgrade(ctx context.Context, run *framework.RunContext, cfg Config, deps DisruptionDependencies, batchID string, observe func(clients.SetUpgradeRun) error, done func(clients.SetUpgradeRun) bool, jobCounter *int) (clients.SetUpgradeRun, string, error) {
	deadline := time.Now().Add(cfg.DisruptionTimeout)
	jobName := ""
	defer func() {
		if jobName == "" {
			return
		}
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		_ = deps.Cluster.DeleteControlledJob(cleanupCtx, cfg.Namespace, jobName)
	}()
	for time.Now().Before(deadline) {
		batch, err := deps.Control.SetUpgrade(ctx, batchID)
		if err != nil {
			return clients.SetUpgradeRun{}, jobName, err
		}
		if len(batch.Runs) != 1 {
			return clients.SetUpgradeRun{}, jobName, fmt.Errorf("Set upgrade batch %q must contain exactly one run", batchID)
		}
		current := batch.Runs[0]
		if observe != nil {
			if err := observe(current); err != nil {
				return clients.SetUpgradeRun{}, jobName, err
			}
		}
		if done(current) {
			return current, jobName, nil
		}
		if current.Status == "failed" || current.Status == "rolled_back" || current.Status == "completed" {
			return clients.SetUpgradeRun{}, jobName, fmt.Errorf("Set upgrade reached unexpected terminal status %q: %s", current.Status, current.LastError)
		}
		needJob := jobName == ""
		if jobName != "" {
			job, jobErr := deps.Cluster.GetJob(ctx, cfg.Namespace, jobName)
			if jobErr != nil {
				return clients.SetUpgradeRun{}, jobName, jobErr
			}
			needJob = job.Status.Succeeded > 0 || job.Status.Failed > 0
		}
		if needJob {
			if jobName != "" {
				if err := deps.Cluster.DeleteControlledJob(ctx, cfg.Namespace, jobName); err != nil {
					return clients.SetUpgradeRun{}, jobName, err
				}
			}
			*jobCounter++
			jobName = regressionJobName(run.RunID, "upgrade", *jobCounter)
			if err := deps.Cluster.CreateSetManagerJob(ctx, cfg.Namespace, cfg.ManagerCronJob, jobName, cfg.ManagerImage, cfg.UpgradeProbeModel, "", run.RunID); err != nil {
				return clients.SetUpgradeRun{}, jobName, err
			}
			created := jobName
			run.DeferSafetyCleanup("delete controlled set-manager Job "+created, func(cleanupCtx context.Context) error {
				return deps.Cluster.DeleteControlledJob(cleanupCtx, cfg.Namespace, created)
			})
		}
		if err := wait(ctx, cfg.DisruptionPollInterval); err != nil {
			return clients.SetUpgradeRun{}, jobName, err
		}
	}
	return clients.SetUpgradeRun{}, jobName, fmt.Errorf("Set upgrade %q did not reach the expected state before timeout", batchID)
}

func probeFailurePolicy(cfg Config) clients.PacerFaultPolicy {
	return clients.PacerFaultPolicy{Enabled: true, Model: cfg.UpgradeProbeModel, StatusCode: 503, Message: "regression upgrade probe failure"}
}

func getTargetSet(ctx context.Context, control DisruptionControl, setID string) (clients.ManagedSet, error) {
	sets, err := control.ListCampaignSets(ctx)
	if err != nil {
		return clients.ManagedSet{}, err
	}
	set, ok := managedSetByID(sets, setID)
	if !ok {
		return clients.ManagedSet{}, fmt.Errorf("target Set %q is not managed", setID)
	}
	return set, nil
}

func validateSuccessfulGenerationTransition(before, after clients.ManagedSet) error {
	if after.ActiveRuntimeGeneration != before.ActiveRuntimeGeneration+1 {
		return fmt.Errorf("Set %q generation changed from %d to %d; expected exactly one generation", before.ID, before.ActiveRuntimeGeneration, after.ActiveRuntimeGeneration)
	}
	if after.RouteRevision <= before.RouteRevision {
		return fmt.Errorf("Set %q route revision did not advance", before.ID)
	}
	return nil
}

func regressionJobName(runID, purpose string, sequence int) string {
	identity := runID
	if len(identity) > 32 {
		digest := sha256.Sum256([]byte(identity))
		identity = identity[:23] + "-" + fmt.Sprintf("%x", digest[:4])
	}
	name := fmt.Sprintf("llmgw-reg-%s-%s-%02d", identity, purpose, sequence)
	if len(name) <= 63 {
		return name
	}
	reserved := len("llmgw-reg--") + len(identity) + len(fmt.Sprintf("-%02d", sequence))
	maxPurpose := 63 - reserved
	if maxPurpose < 1 {
		maxPurpose = 1
	}
	if len(purpose) > maxPurpose {
		purpose = strings.TrimRight(purpose[:maxPurpose], "-")
	}
	return fmt.Sprintf("llmgw-reg-%s-%s-%02d", identity, purpose, sequence)
}

func withDisruptionDefaults(cfg Config) Config {
	if cfg.UpgradeSource == "" {
		cfg.UpgradeSource = "prod"
	}
	if cfg.UpgradeFleet == "" {
		cfg.UpgradeFleet = "prod"
	}
	if cfg.ManagerCronJob == "" {
		cfg.ManagerCronJob = "llmgateway-set-manager"
	}
	if cfg.UpgradeProbeModel == "" {
		cfg.UpgradeProbeModel = "llmgw-regression-upgrade-probe"
	}
	if cfg.DisruptionTimeout <= 0 {
		cfg.DisruptionTimeout = 20 * time.Minute
	}
	if cfg.UpgradeDrainTimeout <= 0 {
		cfg.UpgradeDrainTimeout = 15 * time.Second
	}
	if cfg.UpgradeRollbackWindow <= 0 {
		cfg.UpgradeRollbackWindow = 60 * time.Second
	}
	if cfg.DisruptionPollInterval <= 0 {
		cfg.DisruptionPollInterval = 200 * time.Millisecond
	}
	return cfg
}

func suspendSetManagerCronJob(ctx context.Context, cfg Config, cluster DisruptionCluster) (func(context.Context) error, error) {
	cron, err := cluster.GetCronJob(ctx, cfg.Namespace, cfg.ManagerCronJob)
	if err != nil {
		return nil, fmt.Errorf("read set-manager CronJob: %w", err)
	}
	wasSuspended := cron.Spec.Suspend != nil && *cron.Spec.Suspend
	if !wasSuspended {
		if err := cluster.SetCronJobSuspended(ctx, cfg.Namespace, cfg.ManagerCronJob, true); err != nil {
			return nil, fmt.Errorf("suspend set-manager CronJob: %w", err)
		}
	}
	deadline := time.Now().Add(cfg.DisruptionTimeout)
	for {
		current, getErr := cluster.GetCronJob(ctx, cfg.Namespace, cfg.ManagerCronJob)
		if getErr != nil {
			return nil, fmt.Errorf("wait for set-manager CronJob suspension: %w", getErr)
		}
		suspended := current.Spec.Suspend != nil && *current.Spec.Suspend
		if !suspended {
			if patchErr := cluster.SetCronJobSuspended(ctx, cfg.Namespace, cfg.ManagerCronJob, true); patchErr != nil {
				return nil, fmt.Errorf("reassert set-manager CronJob suspension: %w", patchErr)
			}
		}
		activeJobs, listErr := cluster.ListActiveCronJobJobs(ctx, cfg.Namespace, cfg.ManagerCronJob)
		if listErr != nil {
			return nil, fmt.Errorf("list active set-manager Jobs: %w", listErr)
		}
		if suspended && len(current.Status.Active) == 0 && len(activeJobs) == 0 {
			break
		}
		if !time.Now().Before(deadline) {
			return nil, fmt.Errorf("set-manager CronJob still has active Jobs after suspension timeout: status=%d listed=%d", len(current.Status.Active), len(activeJobs))
		}
		if waitErr := wait(ctx, cfg.DisruptionPollInterval); waitErr != nil {
			return nil, waitErr
		}
	}
	return func(restoreCtx context.Context) error {
		if wasSuspended {
			return nil
		}
		return cluster.SetCronJobSuspended(restoreCtx, cfg.Namespace, cfg.ManagerCronJob, false)
	}, nil
}
