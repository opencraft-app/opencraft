package cases

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"git.woa.com/wisp/mono2/llmgateway/test/regression/clients"
	"git.woa.com/wisp/mono2/llmgateway/test/regression/framework"
)

func TestSetRuntimePodFailureRestoresCapacityAndReconnectsStream(t *testing.T) {
	cluster := newFakeSetFailureCluster()
	traffic := &fakeSetFailureTraffic{deleted: cluster.deleted}
	cfg := rolloutTestConfig()
	cfg.TargetSets = []string{"set-a"}
	cfg.MinPreSamples = 2
	cfg.MinPostSamples = 2
	cfg.RequestInterval = time.Millisecond
	cfg.RolloutPollInterval = time.Millisecond
	cfg.RolloutTimeout = time.Second
	run := rolloutRunContext()

	observations, err := NewSetRuntimeFailureCases(cfg, SetRuntimeFailureDependencies{Cluster: cluster, Traffic: traffic})[0].Run(t.Context(), run)
	if err != nil {
		t.Fatal(err)
	}
	if cluster.deletedName != "pod-a" {
		t.Fatalf("deleted Pod = %q", cluster.deletedName)
	}
	if cluster.acquireCalls != 1 || cluster.releaseCalls != 1 {
		t.Fatalf("lease acquire=%d release=%d", cluster.acquireCalls, cluster.releaseCalls)
	}
	if observations["replacement_pod_uid"] != "uid-c" || observations["reconnected_stream_done"] != true {
		t.Fatalf("observations = %+v", observations)
	}
	if observations["max_consecutive_errors"] != 0 {
		t.Fatalf("observations = %+v", observations)
	}
}

func TestSetRuntimeFailureBaselineRejectsSingleReplica(t *testing.T) {
	pods := []clients.Pod{setFailurePod("pod-a", "uid-a", "node-a", "10.0.0.1")}
	_, _, _, err := validateSetTrafficFailureBaseline(pods)
	if err == nil || !strings.Contains(err.Error(), "exactly 2") {
		t.Fatalf("error = %v", err)
	}
}

func TestSetRuntimeHAContractRequiresZoneSpreadAndPDB(t *testing.T) {
	cluster := newFakeSetFailureCluster()
	deployment, _ := cluster.GetDeployment(t.Context(), "llmgateway", "prod-set-a-g1-newapi-traffic")
	pdb, _ := cluster.GetPDB(t.Context(), "llmgateway", "prod-set-a-g1-newapi-traffic")
	deployment.Spec.Template.Spec.TopologySpreadConstraints = nil
	if err := validateSetTrafficHAContract(deployment, pdb); err == nil || !strings.Contains(err.Error(), "cross-zone") {
		t.Fatalf("error = %v", err)
	}
}

func TestSetRuntimeHAContractRejectsUnhealthyPDBStatus(t *testing.T) {
	cluster := newFakeSetFailureCluster()
	deployment, _ := cluster.GetDeployment(t.Context(), "llmgateway", "prod-set-a-g1-newapi-traffic")
	pdb, _ := cluster.GetPDB(t.Context(), "llmgateway", "prod-set-a-g1-newapi-traffic")
	pdb.Status.DisruptionsAllowed = 0
	if err := validateSetTrafficHAContract(deployment, pdb); err == nil || !strings.Contains(err.Error(), "not healthy") {
		t.Fatalf("error = %v", err)
	}
}

type fakeSetFailureCluster struct {
	mu           sync.Mutex
	deleted      chan struct{}
	deletedName  string
	acquireCalls int
	releaseCalls int
}

func (f *fakeSetFailureCluster) AcquireLease(_ context.Context, _, _, holder string, _ time.Duration) (clients.Lease, error) {
	f.acquireCalls++
	return clients.Lease{Spec: clients.LeaseSpec{HolderIdentity: holder}}, nil
}

func (f *fakeSetFailureCluster) RenewLease(_ context.Context, _, _, holder string, _ time.Duration) (clients.Lease, error) {
	return clients.Lease{Spec: clients.LeaseSpec{HolderIdentity: holder}}, nil
}

func (f *fakeSetFailureCluster) ReleaseLease(context.Context, string, string, string) error {
	f.releaseCalls++
	return nil
}

func newFakeSetFailureCluster() *fakeSetFailureCluster {
	return &fakeSetFailureCluster{deleted: make(chan struct{})}
}

func (f *fakeSetFailureCluster) ListPods(context.Context, string, string) ([]clients.Pod, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.deletedName == "" {
		return []clients.Pod{
			setFailurePod("pod-a", "uid-a", "node-a", "10.0.0.1"),
			setFailurePod("pod-b", "uid-b", "node-b", "10.0.0.2"),
		}, nil
	}
	return []clients.Pod{
		setFailurePod("pod-b", "uid-b", "node-b", "10.0.0.2"),
		setFailurePod("pod-c", "uid-c", "node-c", "10.0.0.3"),
	}, nil
}

func (f *fakeSetFailureCluster) GetDeployment(context.Context, string, string) (clients.Deployment, error) {
	var deployment clients.Deployment
	deployment.Spec.Replicas = 2
	deployment.Status.ReadyReplicas = 2
	deployment.Spec.Template.Spec.TopologySpreadConstraints = []clients.TopologySpreadConstraint{{
		MaxSkew: 1, TopologyKey: "topology.kubernetes.io/zone", WhenUnsatisfiable: "DoNotSchedule",
	}}
	return deployment, nil
}

func (f *fakeSetFailureCluster) GetPDB(context.Context, string, string) (clients.PodDisruptionBudget, error) {
	var pdb clients.PodDisruptionBudget
	pdb.Spec.MinAvailable = float64(1)
	pdb.Status.ExpectedPods = 2
	pdb.Status.CurrentHealthy = 2
	pdb.Status.DisruptionsAllowed = 1
	return pdb, nil
}

func (f *fakeSetFailureCluster) GetNode(_ context.Context, name string) (clients.Node, error) {
	zone := "zone-a"
	if name == "node-b" {
		zone = "zone-b"
	}
	return clients.Node{Metadata: clients.ObjectMeta{Name: name, Labels: map[string]string{"topology.kubernetes.io/zone": zone}}}, nil
}

func (f *fakeSetFailureCluster) DeletePodNow(_ context.Context, _ string, name string) error {
	f.mu.Lock()
	f.deletedName = name
	f.mu.Unlock()
	close(f.deleted)
	return nil
}

func setFailurePod(name, uid, node, ip string) clients.Pod {
	pod := clients.Pod{Metadata: clients.ObjectMeta{
		Name: name, UID: uid, Labels: map[string]string{
			"app.kubernetes.io/name":           "prod-set-a-g1-newapi-traffic",
			"llmgateway.io/runtime-generation": "1",
		},
	}, Status: clients.PodStatus{Phase: "Running", PodIP: ip, ContainerStatuses: []clients.ContainerStatus{{Name: "newapi", Ready: true}}}}
	pod.Spec.NodeName = node
	return pod
}

type fakeSetFailureTraffic struct {
	deleted <-chan struct{}
}

func (f *fakeSetFailureTraffic) Chat(context.Context, string, framework.Secret, string, string) (clients.ChatResult, error) {
	return clients.ChatResult{StatusCode: 200, MarkerFound: true}, nil
}

func (f *fakeSetFailureTraffic) Stream(ctx context.Context, baseURL string, _ framework.Secret, _ string, _ string, onEvent func(clients.StreamEvent)) (clients.StreamResult, error) {
	if strings.Contains(baseURL, "10.0.0.1") {
		if onEvent != nil {
			onEvent(clients.StreamEvent{At: time.Now(), Payload: []byte(`{}`)})
		}
		select {
		case <-ctx.Done():
			return clients.StreamResult{}, ctx.Err()
		case <-f.deleted:
			return clients.StreamResult{}, errors.New("connection reset")
		}
	}
	return clients.StreamResult{StatusCode: 200, Done: true, MarkerFound: true}, nil
}
