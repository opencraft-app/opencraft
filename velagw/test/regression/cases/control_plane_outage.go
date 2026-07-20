package cases

import (
	"context"
	"fmt"
	"strings"
	"time"

	"git.woa.com/wisp/mono2/llmgateway/test/regression/clients"
	"git.woa.com/wisp/mono2/llmgateway/test/regression/framework"
)

const CaseControlPlaneOutage = "existing_keys_survive_control_plane_outage_and_backlog_converges_once"

type ControlPlaneOutageControl interface {
	QueueWorkerJob(context.Context, string) (clients.WorkerJobRun, error)
	WorkerJob(context.Context, string) (clients.WorkerJob, error)
	WorkerJobRuns(context.Context, string, time.Time, int) ([]clients.WorkerJobRun, error)
}

type ControlPlaneOutageCluster interface {
	GetDeployment(context.Context, string, string) (clients.Deployment, error)
	ScaleDeployment(context.Context, string, string, int) (clients.Deployment, clients.Deployment, error)
	GetCronJob(context.Context, string, string) (clients.CronJob, error)
	SetCronJobSuspended(context.Context, string, string, bool) error
	ListActiveCronJobJobs(context.Context, string, string) ([]clients.Job, error)
}

type ControlPlaneOutageDependencies struct {
	Control ControlPlaneOutageControl
	Cluster ControlPlaneOutageCluster
	Traffic TrafficPlane
}

func NewControlPlaneOutageCases(cfg Config, deps ControlPlaneOutageDependencies) []framework.Case {
	cfg = withControlPlaneOutageDefaults(withConfigDefaults(cfg))
	return []framework.Case{framework.CaseFunc{
		CaseID: CaseControlPlaneOutage, DependsOn: []string{CaseKeyStreamsChat},
		Requires: []framework.Capability{
			framework.CapabilityKubernetesAPI,
			framework.CapabilityClusterPodNetwork,
			framework.CapabilityDisruptiveKubernetes,
		},
		RunFunc: func(ctx context.Context, run *framework.RunContext) (framework.Observations, error) {
			return controlPlaneOutage(ctx, run, cfg, deps)
		},
	}}
}

func ControlPlaneOutageGate() framework.Scenario {
	return framework.Scenario{Name: "control_plane_outage_gate", Cases: []string{
		CasePlatformReady, CaseChannelDelivery, CaseTenantOnboarded, CaseTenantAPIKey,
		CaseModelEffective, CaseKeyCompletesChat, CaseKeyStreamsChat, CaseControlPlaneOutage,
	}}
}

type deploymentReplicaBaseline struct {
	name     string
	replicas int
}

type controlPlaneRestorer struct {
	cfg               Config
	cluster           ControlPlaneOutageCluster
	control           deploymentReplicaBaseline
	workers           []deploymentReplicaBaseline
	managerSuspended  bool
	managerWasChanged bool
}

func controlPlaneOutage(ctx context.Context, run *framework.RunContext, cfg Config, deps ControlPlaneOutageDependencies) (framework.Observations, error) {
	cfg = withControlPlaneOutageDefaults(cfg)
	if deps.Control == nil || deps.Cluster == nil || deps.Traffic == nil {
		return nil, fmt.Errorf("control plane outage dependencies are required")
	}
	restorer, err := captureControlPlaneBaseline(ctx, cfg, deps.Cluster)
	if err != nil {
		return nil, err
	}
	restoreAll := func(cleanupCtx context.Context) error { return restorer.restoreAll(cleanupCtx) }
	defer func() {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), cfg.ControlPlaneOutageRecoveryTimeout)
		defer cancel()
		_ = restoreAll(cleanupCtx)
	}()
	run.DeferSafetyCleanup("restore central control plane replicas and Set Manager", restoreAll)

	if err := restorer.suspendManager(ctx); err != nil {
		return nil, err
	}
	if err := waitForManagerIdle(ctx, cfg, deps.Cluster); err != nil {
		return nil, err
	}
	for _, worker := range restorer.workers {
		if err := scaleAndWaitDeployment(ctx, cfg, deps.Cluster, worker.name, 0); err != nil {
			return nil, err
		}
	}
	if err := waitForWorkerJobLeaseRelease(ctx, cfg, deps.Control); err != nil {
		return nil, err
	}
	queued, err := deps.Control.QueueWorkerJob(ctx, cfg.ControlPlaneOutageBacklogJob)
	if err != nil {
		return nil, fmt.Errorf("queue outage backlog job: %w", err)
	}
	queuedAt := queued.StartedAt.UTC()
	if queuedAt.IsZero() {
		queuedAt = time.Now().UTC()
	}
	if err := scaleAndWaitDeployment(ctx, cfg, deps.Cluster, restorer.control.name, 0); err != nil {
		return nil, err
	}

	samples, failures := sampleTrafficForOutage(ctx, run, cfg, deps.Traffic)
	if failures > 0 || samples < cfg.ControlPlaneOutageMinSamples {
		return nil, fmt.Errorf("control plane outage traffic samples=%d failures=%d, require at least %d successful samples", samples, failures, cfg.ControlPlaneOutageMinSamples)
	}
	if err := restorer.restoreDeployments(ctx); err != nil {
		return nil, err
	}
	runCount, owner, err := waitForQueuedWorkerJob(ctx, cfg, deps.Control, queuedAt)
	if err != nil {
		return nil, err
	}
	if err := restorer.restoreManager(ctx); err != nil {
		return nil, err
	}
	if _, err := deps.Traffic.Chat(ctx, cfg.TrafficURL, runSecret(run, stateAPIKey), cfg.Model, cfg.Marker); err != nil {
		return nil, fmt.Errorf("traffic failed after control plane recovery: %w", err)
	}
	return framework.Observations{
		"outage_duration_seconds": int(cfg.ControlPlaneOutageDuration.Seconds()),
		"successful_samples":      samples, "failed_samples": failures,
		"worker_run_count": runCount, "worker_run_owner": owner,
	}, nil
}

func waitForWorkerJobLeaseRelease(ctx context.Context, cfg Config, control ControlPlaneOutageControl) error {
	deadline := time.Now().Add(cfg.ControlPlaneOutageRecoveryTimeout)
	for {
		job, err := control.WorkerJob(ctx, cfg.ControlPlaneOutageBacklogJob)
		if err != nil {
			return err
		}
		if strings.TrimSpace(job.LeaseOwner) == "" || !job.LeaseUntil.After(time.Now().UTC()) {
			return nil
		}
		if !time.Now().Before(deadline) {
			return fmt.Errorf("worker job %q lease was not released before outage", cfg.ControlPlaneOutageBacklogJob)
		}
		if err := wait(ctx, cfg.DisruptionPollInterval); err != nil {
			return err
		}
	}
}

func captureControlPlaneBaseline(ctx context.Context, cfg Config, cluster ControlPlaneOutageCluster) (*controlPlaneRestorer, error) {
	control, err := cluster.GetDeployment(ctx, cfg.Namespace, cfg.ControlPlaneOutageControlDeployment)
	if err != nil {
		return nil, fmt.Errorf("read control deployment: %w", err)
	}
	if control.Spec.Replicas <= 0 {
		return nil, fmt.Errorf("control deployment has no replicas")
	}
	result := &controlPlaneRestorer{cfg: cfg, cluster: cluster, control: deploymentReplicaBaseline{name: cfg.ControlPlaneOutageControlDeployment, replicas: control.Spec.Replicas}}
	for _, name := range cfg.ControlPlaneOutageWorkerDeployments {
		deployment, getErr := cluster.GetDeployment(ctx, cfg.Namespace, name)
		if getErr != nil {
			return nil, fmt.Errorf("read worker deployment %q: %w", name, getErr)
		}
		result.workers = append(result.workers, deploymentReplicaBaseline{name: name, replicas: deployment.Spec.Replicas})
	}
	cron, err := cluster.GetCronJob(ctx, cfg.Namespace, cfg.ManagerCronJob)
	if err != nil {
		return nil, fmt.Errorf("read set-manager CronJob: %w", err)
	}
	result.managerSuspended = cron.Spec.Suspend != nil && *cron.Spec.Suspend
	return result, nil
}

func (r *controlPlaneRestorer) suspendManager(ctx context.Context) error {
	if r.managerSuspended {
		return nil
	}
	if err := r.cluster.SetCronJobSuspended(ctx, r.cfg.Namespace, r.cfg.ManagerCronJob, true); err != nil {
		return fmt.Errorf("suspend set-manager CronJob: %w", err)
	}
	r.managerWasChanged = true
	return nil
}

func (r *controlPlaneRestorer) restoreDeployments(ctx context.Context) error {
	if err := restoreDeploymentIfNeeded(ctx, r.cfg, r.cluster, r.control); err != nil {
		return err
	}
	for _, worker := range r.workers {
		if err := restoreDeploymentIfNeeded(ctx, r.cfg, r.cluster, worker); err != nil {
			return err
		}
	}
	return nil
}

func (r *controlPlaneRestorer) restoreManager(ctx context.Context) error {
	if !r.managerWasChanged {
		return nil
	}
	cron, err := r.cluster.GetCronJob(ctx, r.cfg.Namespace, r.cfg.ManagerCronJob)
	if err != nil {
		return err
	}
	if cron.Spec.Suspend != nil && !*cron.Spec.Suspend {
		return nil
	}
	return r.cluster.SetCronJobSuspended(ctx, r.cfg.Namespace, r.cfg.ManagerCronJob, false)
}

func (r *controlPlaneRestorer) restoreAll(ctx context.Context) error {
	if err := r.restoreDeployments(ctx); err != nil {
		return err
	}
	return r.restoreManager(ctx)
}

func restoreDeploymentIfNeeded(ctx context.Context, cfg Config, cluster ControlPlaneOutageCluster, baseline deploymentReplicaBaseline) error {
	current, err := cluster.GetDeployment(ctx, cfg.Namespace, baseline.name)
	if err != nil {
		return err
	}
	if current.Spec.Replicas == baseline.replicas && current.Status.ReadyReplicas == baseline.replicas {
		return nil
	}
	return scaleAndWaitDeployment(ctx, cfg, cluster, baseline.name, baseline.replicas)
}

func scaleAndWaitDeployment(ctx context.Context, cfg Config, cluster ControlPlaneOutageCluster, name string, replicas int) error {
	if _, _, err := cluster.ScaleDeployment(ctx, cfg.Namespace, name, replicas); err != nil {
		return fmt.Errorf("scale deployment %q to %d: %w", name, replicas, err)
	}
	deadline := time.Now().Add(cfg.ControlPlaneOutageRecoveryTimeout)
	for {
		deployment, err := cluster.GetDeployment(ctx, cfg.Namespace, name)
		if err != nil {
			return err
		}
		if deployment.Spec.Replicas == replicas && deployment.Status.ReadyReplicas == replicas {
			return nil
		}
		if !time.Now().Before(deadline) {
			return fmt.Errorf("deployment %q did not reach %d ready replicas", name, replicas)
		}
		if err := wait(ctx, cfg.DisruptionPollInterval); err != nil {
			return err
		}
	}
}

func waitForManagerIdle(ctx context.Context, cfg Config, cluster ControlPlaneOutageCluster) error {
	deadline := time.Now().Add(cfg.ControlPlaneOutageRecoveryTimeout)
	for {
		cron, err := cluster.GetCronJob(ctx, cfg.Namespace, cfg.ManagerCronJob)
		if err != nil {
			return err
		}
		jobs, err := cluster.ListActiveCronJobJobs(ctx, cfg.Namespace, cfg.ManagerCronJob)
		if err != nil {
			return err
		}
		suspended := cron.Spec.Suspend != nil && *cron.Spec.Suspend
		if suspended && len(cron.Status.Active) == 0 && len(jobs) == 0 {
			return nil
		}
		if !time.Now().Before(deadline) {
			return fmt.Errorf("set-manager did not become idle before outage")
		}
		if err := wait(ctx, cfg.DisruptionPollInterval); err != nil {
			return err
		}
	}
}

func sampleTrafficForOutage(ctx context.Context, run *framework.RunContext, cfg Config, traffic TrafficPlane) (int, int) {
	deadline := time.Now().Add(cfg.ControlPlaneOutageDuration)
	samples, failures := 0, 0
	for time.Now().Before(deadline) {
		_, err := traffic.Chat(ctx, cfg.TrafficURL, runSecret(run, stateAPIKey), cfg.Model, cfg.Marker)
		samples++
		if err != nil {
			failures++
		}
		if err := wait(ctx, cfg.ControlPlaneOutageTrafficInterval); err != nil {
			failures++
			break
		}
	}
	return samples, failures
}

func waitForQueuedWorkerJob(ctx context.Context, cfg Config, control ControlPlaneOutageControl, queuedAt time.Time) (int, string, error) {
	deadline := time.Now().Add(cfg.ControlPlaneOutageRecoveryTimeout)
	for {
		job, err := control.WorkerJob(ctx, cfg.ControlPlaneOutageBacklogJob)
		if err != nil {
			return 0, "", err
		}
		runs, err := control.WorkerJobRuns(ctx, cfg.ControlPlaneOutageBacklogJob, queuedAt, 10)
		if err != nil {
			return 0, "", err
		}
		if len(runs) > 1 {
			return len(runs), "", fmt.Errorf("expected exactly one worker run after recovery, got %d", len(runs))
		}
		if len(runs) == 1 {
			run := runs[0]
			if run.Status != "success" || strings.TrimSpace(run.Owner) == "" {
				return 1, run.Owner, fmt.Errorf("recovered worker run status=%q owner=%q", run.Status, run.Owner)
			}
			if job.LeaseOwner != "" || !job.LeaseUntil.IsZero() {
				return 1, run.Owner, fmt.Errorf("worker job lease was not released")
			}
			if job.LastSuccessAt.Before(queuedAt) || !job.NextRunAt.After(time.Now().UTC()) {
				return 1, run.Owner, fmt.Errorf("worker job did not advance success and next-run watermarks")
			}
			return 1, run.Owner, nil
		}
		if !time.Now().Before(deadline) {
			return 0, "", fmt.Errorf("queued worker job did not complete before recovery timeout")
		}
		if err := wait(ctx, cfg.DisruptionPollInterval); err != nil {
			return 0, "", err
		}
	}
}

func withControlPlaneOutageDefaults(cfg Config) Config {
	if cfg.ControlPlaneOutageControlDeployment == "" {
		cfg.ControlPlaneOutageControlDeployment = "llmgateway-control"
	}
	if len(cfg.ControlPlaneOutageWorkerDeployments) == 0 {
		cfg.ControlPlaneOutageWorkerDeployments = []string{
			"llmgateway-worker-admin", "llmgateway-worker-byok", "llmgateway-worker-core",
			"llmgateway-worker-maintenance", "llmgateway-worker-observer",
		}
	}
	if cfg.ControlPlaneOutageBacklogJob == "" {
		cfg.ControlPlaneOutageBacklogJob = "refresh_set_capacity"
	}
	if cfg.ControlPlaneOutageDuration <= 0 {
		cfg.ControlPlaneOutageDuration = 90 * time.Second
	}
	if cfg.ControlPlaneOutageTrafficInterval <= 0 {
		cfg.ControlPlaneOutageTrafficInterval = time.Second
	}
	if cfg.ControlPlaneOutageMinSamples <= 0 {
		cfg.ControlPlaneOutageMinSamples = 60
	}
	if cfg.ControlPlaneOutageRecoveryTimeout <= 0 {
		cfg.ControlPlaneOutageRecoveryTimeout = 5 * time.Minute
	}
	if cfg.DisruptionPollInterval <= 0 {
		cfg.DisruptionPollInterval = 200 * time.Millisecond
	}
	return cfg
}
