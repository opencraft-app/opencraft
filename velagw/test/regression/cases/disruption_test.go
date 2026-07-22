package cases

import (
	"context"
	"fmt"
	"reflect"
	"strings"
	"testing"
	"time"

	"git.woa.com/wisp/mono2/llmgateway/test/regression/clients"
	"git.woa.com/wisp/mono2/llmgateway/test/regression/framework"
)

func TestGreenProbeFailureIsContainedThenRetryCompletes(t *testing.T) {
	control := newScriptedUpgradeControl([]clients.SetUpgradeBatch{
		upgradeState("probing", 1, 0), upgradeState("failed", 0, 3),
		upgradeState("probing", 1, 0), upgradeState("switching", 3, 0),
		upgradeState("draining", 0, 0), upgradeState("completed", 0, 0),
	})
	cluster := &fakeDisruptionCluster{}
	faults := &fakePacerFaults{}
	cfg := disruptionTestConfig()
	run := framework.NewRunContext("green-failure", framework.NewSanitizer())

	observations, err := greenProbeFailureContained(t.Context(), run, cfg, DisruptionDependencies{
		Control: control, Cluster: cluster, Faults: faults, FaultToken: run.Sanitizer.Secret("internal"),
	})
	if err != nil {
		t.Fatal(err)
	}
	if faults.enabled != 1 || faults.disabled < 1 || control.retries != 1 || cluster.jobs < 2 {
		t.Fatalf("faults=%+v retries=%d jobs=%d", faults, control.retries, cluster.jobs)
	}
	if observations["failure_status"] != "failed" || observations["recovery_status"] != "completed" {
		t.Fatalf("observations = %+v", observations)
	}
	if !cluster.suspended {
		t.Fatal("set-manager CronJob resumed between rollback gate cases")
	}
}

func TestPostSwitchFailureRollsBackThenRetryCompletes(t *testing.T) {
	control := newScriptedUpgradeControl([]clients.SetUpgradeBatch{
		upgradeState("draining", 0, 0), upgradeState("rollback_switching", 0, 3),
		upgradeState("rollback_draining", 0, 3), upgradeState("rolled_back", 0, 3),
		upgradeState("probing", 1, 0), upgradeState("switching", 3, 0),
		upgradeState("draining", 0, 0), upgradeState("completed", 0, 0),
	})
	cluster := &fakeDisruptionCluster{}
	faults := &fakePacerFaults{}
	cfg := disruptionTestConfig()
	run := framework.NewRunContext("post-switch-failure", framework.NewSanitizer())

	observations, err := postSwitchFailureRolledBack(t.Context(), run, cfg, DisruptionDependencies{
		Control: control, Cluster: cluster, Faults: faults, FaultToken: run.Sanitizer.Secret("internal"),
	})
	if err != nil {
		t.Fatal(err)
	}
	if faults.enabled != 1 || faults.disabled < 1 || control.retries != 0 || control.creates != 2 {
		t.Fatalf("faults=%+v retries=%d creates=%d", faults, control.retries, control.creates)
	}
	if observations["failure_status"] != "rolled_back" || observations["recovery_status"] != "completed" {
		t.Fatalf("observations = %+v", observations)
	}
}

func TestSetManagerLeaseTakeoverCompletesEveryCriticalStageExactlyOnce(t *testing.T) {
	control := newTakeoverControl()
	cluster := &fakeTakeoverCluster{control: control}
	traffic := &fakeTraffic{}
	cfg := disruptionTestConfig()
	run := framework.NewRunContext("manager-takeover", framework.NewSanitizer())
	run.Set(stateAPIKey, run.Sanitizer.Secret("sk-takeover"))

	observations, err := setManagerLeaseTakeover(t.Context(), run, cfg, ManagerTakeoverDependencies{
		Control: control, Cluster: cluster, Traffic: traffic,
	})
	if err != nil {
		t.Fatal(err)
	}
	if observations["completed_stages"] != 3 || control.sets[0].ActiveRuntimeGeneration != 10 {
		t.Fatalf("observations=%+v set=%+v", observations, control.sets[0])
	}
	if cluster.holds != 3 || cluster.takeovers != 3 || traffic.chatCalls < 3 {
		t.Fatalf("holds=%d takeovers=%d chat=%d", cluster.holds, cluster.takeovers, traffic.chatCalls)
	}
	if want := []string{cfg.Marker, cfg.Marker, cfg.Marker}; !reflect.DeepEqual(traffic.chatMarkers, want) {
		t.Fatalf("chat markers = %v, want %v", traffic.chatMarkers, want)
	}
}

func TestSetManagerLeaseTakeoverRejectsAnUncontrolledLeaseOwner(t *testing.T) {
	control := newTakeoverControl()
	cluster := &fakeTakeoverCluster{control: control, unexpectedOwner: true}
	traffic := &fakeTraffic{}
	cfg := disruptionTestConfig()
	run := framework.NewRunContext("manager-takeover-owner", framework.NewSanitizer())
	run.Set(stateAPIKey, run.Sanitizer.Secret("sk-takeover"))

	_, err := setManagerLeaseTakeover(t.Context(), run, cfg, ManagerTakeoverDependencies{
		Control: control, Cluster: cluster, Traffic: traffic,
	})
	if err == nil || !strings.Contains(err.Error(), "uncontrolled manager") {
		t.Fatalf("error=%v", err)
	}
}

func TestSetManagerLeaseTakeoverRejectsAnUncontrolledReplacement(t *testing.T) {
	control := newTakeoverControl()
	cluster := &fakeTakeoverCluster{control: control, unexpectedTakeoverOwner: true}
	traffic := &fakeTraffic{}
	cfg := disruptionTestConfig()
	run := framework.NewRunContext("manager-takeover-replacement", framework.NewSanitizer())
	run.Set(stateAPIKey, run.Sanitizer.Secret("sk-takeover"))

	_, err := setManagerLeaseTakeover(t.Context(), run, cfg, ManagerTakeoverDependencies{
		Control: control, Cluster: cluster, Traffic: traffic,
	})
	if err == nil || !strings.Contains(err.Error(), "uncontrolled replacement manager") {
		t.Fatalf("error=%v", err)
	}
}

func TestSetManagerSuspensionRestoresOriginalState(t *testing.T) {
	cfg := disruptionTestConfig()
	cluster := &fakeDisruptionCluster{suspended: true}
	restore, err := suspendSetManagerCronJob(t.Context(), cfg, cluster)
	if err != nil {
		t.Fatal(err)
	}
	if err := restore(t.Context()); err != nil {
		t.Fatal(err)
	}
	if !cluster.suspended || len(cluster.suspendWrites) != 0 {
		t.Fatalf("pre-suspended CronJob changed: suspended=%v writes=%v", cluster.suspended, cluster.suspendWrites)
	}

	cluster = &fakeDisruptionCluster{}
	restore, err = suspendSetManagerCronJob(t.Context(), cfg, cluster)
	if err != nil {
		t.Fatal(err)
	}
	if err := restore(t.Context()); err != nil {
		t.Fatal(err)
	}
	if cluster.suspended || !reflect.DeepEqual(cluster.suspendWrites, []bool{true, false}) {
		t.Fatalf("active CronJob was not restored: suspended=%v writes=%v", cluster.suspended, cluster.suspendWrites)
	}
}

func TestSetManagerSuspensionWaitsForExistingCronJobRun(t *testing.T) {
	cfg := disruptionTestConfig()
	cluster := &fakeDisruptionCluster{activeJobReads: 2}
	restore, err := suspendSetManagerCronJob(t.Context(), cfg, cluster)
	if err != nil {
		t.Fatal(err)
	}
	if cluster.activeJobLists < 3 {
		t.Fatalf("active Job lists = %d, existing CronJob-owned Job was not observed", cluster.activeJobLists)
	}
	if err := restore(t.Context()); err != nil {
		t.Fatal(err)
	}
}

type scriptedUpgradeControl struct {
	states  []clients.SetUpgradeBatch
	current clients.SetUpgradeBatch
	retries int
	creates int
	sets    []clients.ManagedSet
}

func newScriptedUpgradeControl(states []clients.SetUpgradeBatch) *scriptedUpgradeControl {
	return &scriptedUpgradeControl{states: states, sets: []clients.ManagedSet{{
		ID: "set-a", Status: "active", ActiveRuntimeGeneration: 7, RouteRevision: 11,
	}}}
}

func (f *scriptedUpgradeControl) ListCampaignSets(context.Context) ([]clients.ManagedSet, error) {
	return append([]clients.ManagedSet(nil), f.sets...), nil
}

func (f *scriptedUpgradeControl) CreateSetUpgrade(context.Context, clients.SetUpgradeInput) (clients.SetUpgradeBatch, error) {
	f.creates++
	f.current = clients.SetUpgradeBatch{ID: "batch-1", Status: "pending", Runs: []clients.SetUpgradeRun{{
		ID: "run-1", SetID: "set-a", Status: "pending", FromGeneration: 7, ToGeneration: 8,
	}}}
	return f.current, nil
}

func (f *scriptedUpgradeControl) SetUpgrade(context.Context, string) (clients.SetUpgradeBatch, error) {
	if len(f.states) == 0 {
		return f.current, nil
	}
	f.current = f.states[0]
	f.states = f.states[1:]
	if f.current.Runs[0].Status == "rolled_back" {
		f.sets[0].RouteRevision += 2
	}
	if f.current.Runs[0].Status == "completed" {
		f.sets[0].ActiveRuntimeGeneration++
		f.sets[0].RouteRevision++
	}
	return f.current, nil
}

func (f *scriptedUpgradeControl) RetrySetUpgradeRun(context.Context, string) (clients.SetUpgradeRun, error) {
	f.retries++
	return clients.SetUpgradeRun{ID: "run-1", SetID: "set-a", Status: "pending", FromGeneration: 7, ToGeneration: 8}, nil
}

func upgradeState(status string, successes, failures int) clients.SetUpgradeBatch {
	batchStatus := "running"
	if status == "failed" {
		batchStatus = "failed"
	}
	if status == "completed" || status == "rolled_back" {
		batchStatus = "completed"
	}
	return clients.SetUpgradeBatch{ID: "batch-1", Status: batchStatus, Runs: []clients.SetUpgradeRun{{
		ID: "run-1", SetID: "set-a", Status: status, FromGeneration: 7, ToGeneration: 8,
		ConsecutiveProbeSuccesses: successes, ConsecutiveProbeFailures: failures,
	}}}
}

type fakeDisruptionCluster struct {
	jobs            int
	deletions       int
	suspended       bool
	suspendWrites   []bool
	activeCronReads int
	activeJobReads  int
	activeJobLists  int
	cronReads       int
}

func (f *fakeDisruptionCluster) ListPods(context.Context, string, string) ([]clients.Pod, error) {
	return []clients.Pod{{Status: clients.PodStatus{Phase: "Running", PodIP: "10.0.0.1", Ready: true}}}, nil
}
func (f *fakeDisruptionCluster) GetCronJob(context.Context, string, string) (clients.CronJob, error) {
	var cron clients.CronJob
	f.cronReads++
	cron.Spec.Suspend = &f.suspended
	if f.activeCronReads > 0 {
		f.activeCronReads--
		cron.Status.Active = []clients.OwnerReference{{Name: "existing-manager"}}
	}
	return cron, nil
}
func (f *fakeDisruptionCluster) SetCronJobSuspended(_ context.Context, _, _ string, value bool) error {
	f.suspended = value
	f.suspendWrites = append(f.suspendWrites, value)
	return nil
}
func (f *fakeDisruptionCluster) ListActiveCronJobJobs(context.Context, string, string) ([]clients.Job, error) {
	f.activeJobLists++
	if f.activeJobReads <= 0 {
		return nil, nil
	}
	f.activeJobReads--
	return []clients.Job{{Metadata: clients.ObjectMeta{Name: "existing-manager"}}}, nil
}
func (f *fakeDisruptionCluster) CreateSetManagerJob(context.Context, string, string, string, string, string, string, string) error {
	f.jobs++
	return nil
}
func (f *fakeDisruptionCluster) GetJob(context.Context, string, string) (clients.Job, error) {
	var job clients.Job
	job.Status.Succeeded = 1
	return job, nil
}
func (f *fakeDisruptionCluster) DeleteControlledJob(context.Context, string, string) error {
	f.deletions++
	return nil
}

type fakePacerFaults struct{ enabled, disabled int }

func (f *fakePacerFaults) Apply(_ context.Context, _ []string, _ framework.Secret, policy clients.PacerFaultPolicy) error {
	if policy.Enabled {
		f.enabled++
	} else {
		f.disabled++
	}
	return nil
}

type takeoverControl struct {
	sets    []clients.ManagedSet
	batch   clients.SetUpgradeBatch
	counter int
}

func newTakeoverControl() *takeoverControl {
	return &takeoverControl{sets: []clients.ManagedSet{{
		ID: "set-a", Status: "active", ActiveRuntimeGeneration: 7, RouteRevision: 11,
	}}}
}

func (f *takeoverControl) ListCampaignSets(context.Context) ([]clients.ManagedSet, error) {
	return append([]clients.ManagedSet(nil), f.sets...), nil
}

func (f *takeoverControl) CreateSetUpgrade(context.Context, clients.SetUpgradeInput) (clients.SetUpgradeBatch, error) {
	f.counter++
	f.batch = clients.SetUpgradeBatch{ID: fmt.Sprintf("batch-%d", f.counter), Status: "pending", Runs: []clients.SetUpgradeRun{{
		ID: fmt.Sprintf("run-%d", f.counter), SetID: "set-a", Status: "pending",
		FromGeneration: f.sets[0].ActiveRuntimeGeneration, ToGeneration: f.sets[0].ActiveRuntimeGeneration + 1,
	}}}
	return f.batch, nil
}

func (f *takeoverControl) SetUpgrade(context.Context, string) (clients.SetUpgradeBatch, error) {
	return f.batch, nil
}

func (f *takeoverControl) RetrySetUpgradeRun(context.Context, string) (clients.SetUpgradeRun, error) {
	return clients.SetUpgradeRun{}, nil
}

type fakeTakeoverCluster struct {
	control                 *takeoverControl
	holds                   int
	takeovers               int
	suspended               bool
	unexpectedOwner         bool
	unexpectedTakeoverOwner bool
}

func (f *fakeTakeoverCluster) ListPods(context.Context, string, string) ([]clients.Pod, error) {
	return nil, nil
}

func (f *fakeTakeoverCluster) GetCronJob(context.Context, string, string) (clients.CronJob, error) {
	var cron clients.CronJob
	cron.Spec.Suspend = &f.suspended
	return cron, nil
}

func (f *fakeTakeoverCluster) SetCronJobSuspended(_ context.Context, _, _ string, suspended bool) error {
	f.suspended = suspended
	return nil
}

func (f *fakeTakeoverCluster) ListActiveCronJobJobs(context.Context, string, string) ([]clients.Job, error) {
	return nil, nil
}

func (f *fakeTakeoverCluster) CreateSetManagerJob(_ context.Context, _, _, jobName, _, _, holdStatus, _ string) error {
	run := &f.control.batch.Runs[0]
	if holdStatus != "" {
		f.holds++
		run.Status = holdStatus
		run.LeaseOwner = jobName
		if f.unexpectedOwner {
			run.LeaseOwner = "ordinary-cron-manager"
		}
		run.LeaseUntil = time.Now().Add(time.Minute)
		return nil
	}
	f.takeovers++
	run.Status = "completed"
	run.LeaseOwner = jobName
	if f.unexpectedTakeoverOwner {
		run.LeaseOwner = "ordinary-cron-manager"
	}
	f.control.sets[0].ActiveRuntimeGeneration++
	f.control.sets[0].RouteRevision++
	return nil
}

func (f *fakeTakeoverCluster) GetJob(context.Context, string, string) (clients.Job, error) {
	return clients.Job{}, nil
}

func (f *fakeTakeoverCluster) DeleteControlledJob(context.Context, string, string) error {
	f.control.batch.Runs[0].LeaseUntil = time.Now().Add(-time.Second)
	return nil
}

func disruptionTestConfig() Config {
	cfg := testConfig()
	cfg.Namespace = "llmgateway"
	cfg.TargetSets = []string{"set-a"}
	cfg.TargetImage = "registry/new-api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	cfg.UpgradeSource = "prod"
	cfg.UpgradeFleet = "prod"
	cfg.ManagerCronJob = "llmgateway-set-manager"
	cfg.UpgradeProbeModel = "llmgw-regression-upgrade-probe"
	cfg.DisruptionTimeout = 100 * time.Millisecond
	cfg.CampaignPollInterval = time.Millisecond
	cfg.UpgradeDrainTimeout = time.Millisecond
	cfg.UpgradeRollbackWindow = 10 * time.Millisecond
	return cfg
}
