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

func TestControlPlaneOutagePreservesTrafficAndDrainsOneQueuedRun(t *testing.T) {
	cluster := newFakeControlPlaneOutageCluster()
	control := &fakeControlPlaneOutageControl{cluster: cluster}
	traffic := &fakeTraffic{}
	cfg := controlPlaneOutageTestConfig()
	run := framework.NewRunContext("control-plane-outage", framework.NewSanitizer())
	run.Set(stateAPIKey, run.Sanitizer.Secret("sk-outage"))

	observations, err := controlPlaneOutage(t.Context(), run, cfg, ControlPlaneOutageDependencies{
		Control: control, Cluster: cluster, Traffic: traffic,
	})
	if err != nil {
		t.Fatal(err)
	}
	wantOps := []string{
		"cron:true", "scale:worker-a:0", "scale:worker-b:0", "queue:refresh_set_capacity",
		"scale:control:0", "scale:control:2", "scale:worker-a:2", "scale:worker-b:3", "cron:false",
	}
	gotOps := append(append([]string{}, cluster.operations...), control.operations...)
	// Control operations are timestamped in the shared sequence by the fake.
	gotOps = cluster.sequence
	if !reflect.DeepEqual(gotOps, wantOps) {
		t.Fatalf("operations = %v, want %v", gotOps, wantOps)
	}
	if traffic.chatCalls < cfg.ControlPlaneOutageMinSamples+1 {
		t.Fatalf("chat calls = %d", traffic.chatCalls)
	}
	if control.preQueueLeaseReads < 2 {
		t.Fatalf("pre-queue lease reads = %d, want terminating owner then released lease", control.preQueueLeaseReads)
	}
	if observations["successful_samples"].(int) < cfg.ControlPlaneOutageMinSamples || observations["worker_run_count"] != 1 {
		t.Fatalf("observations = %+v", observations)
	}
}

func TestControlPlaneOutageRejectsDuplicateBacklogRunsAndRestoresResources(t *testing.T) {
	cluster := newFakeControlPlaneOutageCluster()
	control := &fakeControlPlaneOutageControl{cluster: cluster, duplicateRuns: true}
	traffic := &fakeTraffic{}
	cfg := controlPlaneOutageTestConfig()
	run := framework.NewRunContext("control-plane-duplicate", framework.NewSanitizer())
	run.Set(stateAPIKey, run.Sanitizer.Secret("sk-outage"))

	_, err := controlPlaneOutage(t.Context(), run, cfg, ControlPlaneOutageDependencies{
		Control: control, Cluster: cluster, Traffic: traffic,
	})
	if err == nil || !strings.Contains(err.Error(), "exactly one") {
		t.Fatalf("error = %v", err)
	}
	if cluster.deployments["control"] != 2 || cluster.deployments["worker-a"] != 2 || cluster.deployments["worker-b"] != 3 || cluster.cronSuspended {
		t.Fatalf("cluster was not restored: %+v suspended=%v", cluster.deployments, cluster.cronSuspended)
	}
}

type fakeControlPlaneOutageCluster struct {
	deployments   map[string]int
	cronSuspended bool
	operations    []string
	sequence      []string
}

func newFakeControlPlaneOutageCluster() *fakeControlPlaneOutageCluster {
	return &fakeControlPlaneOutageCluster{deployments: map[string]int{"control": 2, "worker-a": 2, "worker-b": 3}}
}

func (f *fakeControlPlaneOutageCluster) GetDeployment(_ context.Context, _, name string) (clients.Deployment, error) {
	var result clients.Deployment
	result.Metadata.Name = name
	result.Metadata.ResourceVersion = fmt.Sprintf("rv-%s-%d", name, f.deployments[name])
	result.Spec.Replicas = f.deployments[name]
	result.Status.ReadyReplicas = f.deployments[name]
	return result, nil
}

func (f *fakeControlPlaneOutageCluster) ScaleDeployment(ctx context.Context, namespace, name string, replicas int) (clients.Deployment, clients.Deployment, error) {
	before, err := f.GetDeployment(ctx, namespace, name)
	if err != nil {
		return clients.Deployment{}, clients.Deployment{}, err
	}
	f.deployments[name] = replicas
	f.operations = append(f.operations, fmt.Sprintf("scale:%s:%d", name, replicas))
	f.sequence = append(f.sequence, fmt.Sprintf("scale:%s:%d", name, replicas))
	after, _ := f.GetDeployment(ctx, namespace, name)
	return before, after, nil
}

func (f *fakeControlPlaneOutageCluster) GetCronJob(context.Context, string, string) (clients.CronJob, error) {
	var result clients.CronJob
	result.Spec.Suspend = &f.cronSuspended
	return result, nil
}

func (f *fakeControlPlaneOutageCluster) SetCronJobSuspended(_ context.Context, _, _ string, value bool) error {
	f.cronSuspended = value
	f.operations = append(f.operations, fmt.Sprintf("cron:%t", value))
	f.sequence = append(f.sequence, fmt.Sprintf("cron:%t", value))
	return nil
}

func (f *fakeControlPlaneOutageCluster) ListActiveCronJobJobs(context.Context, string, string) ([]clients.Job, error) {
	return nil, nil
}

type fakeControlPlaneOutageControl struct {
	cluster            *fakeControlPlaneOutageCluster
	operations         []string
	queuedAt           time.Time
	duplicateRuns      bool
	preQueueLeaseReads int
}

func (f *fakeControlPlaneOutageControl) QueueWorkerJob(_ context.Context, name string) (clients.WorkerJobRun, error) {
	f.queuedAt = time.Now().UTC()
	f.operations = append(f.operations, "queue:"+name)
	f.cluster.sequence = append(f.cluster.sequence, "queue:"+name)
	return clients.WorkerJobRun{ID: "queued", JobName: name, Status: "queued", StartedAt: f.queuedAt}, nil
}

func (f *fakeControlPlaneOutageControl) WorkerJob(_ context.Context, name string) (clients.WorkerJob, error) {
	if f.queuedAt.IsZero() {
		f.preQueueLeaseReads++
		if f.preQueueLeaseReads == 1 {
			return clients.WorkerJob{Name: name, LeaseOwner: "terminating-worker", LeaseUntil: time.Now().Add(time.Second)}, nil
		}
		return clients.WorkerJob{Name: name}, nil
	}
	return clients.WorkerJob{Name: name, Status: "success", LastSuccessAt: f.queuedAt.Add(time.Second), NextRunAt: f.queuedAt.Add(time.Hour)}, nil
}

func (f *fakeControlPlaneOutageControl) WorkerJobRuns(_ context.Context, name string, after time.Time, limit int) ([]clients.WorkerJobRun, error) {
	runs := []clients.WorkerJobRun{{ID: "run-1", JobName: name, Owner: "worker-a/job/run-1", Status: "success", StartedAt: after.Add(time.Millisecond)}}
	if f.duplicateRuns {
		runs = append(runs, clients.WorkerJobRun{ID: "run-2", JobName: name, Owner: "worker-b/job/run-2", Status: "success", StartedAt: after.Add(2 * time.Millisecond)})
	}
	return runs, nil
}

func controlPlaneOutageTestConfig() Config {
	cfg := testConfig()
	cfg.ControlPlaneOutageControlDeployment = "control"
	cfg.ControlPlaneOutageWorkerDeployments = []string{"worker-a", "worker-b"}
	cfg.ControlPlaneOutageBacklogJob = "refresh_set_capacity"
	cfg.ControlPlaneOutageDuration = 5 * time.Millisecond
	cfg.ControlPlaneOutageTrafficInterval = time.Millisecond
	cfg.ControlPlaneOutageMinSamples = 2
	cfg.ControlPlaneOutageRecoveryTimeout = 100 * time.Millisecond
	cfg.ManagerCronJob = "set-manager"
	return cfg
}
