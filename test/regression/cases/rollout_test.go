package cases

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"git.woa.com/wisp/mono2/llmgateway/test/regression/clients"
	"git.woa.com/wisp/mono2/llmgateway/test/regression/framework"
)

func TestActiveRequestsSurviveTrafficRolloutProvesPinnedAndServiceStreams(t *testing.T) {
	cluster := newFakeRolloutCluster()
	traffic := newFakeRolloutTraffic(cluster)
	cfg := rolloutTestConfig()
	run := rolloutRunContext()
	cases := NewRolloutCases(cfg, RolloutDependencies{Traffic: traffic, Cluster: cluster})

	observations, err := cases[0].Run(t.Context(), run)
	if err != nil {
		t.Fatal(err)
	}
	if cluster.patchCalls != 1 || cluster.releaseCalls != 1 {
		t.Fatalf("patch=%d release=%d", cluster.patchCalls, cluster.releaseCalls)
	}
	if !traffic.pinnedObservedAfterTermination.Load() || traffic.serviceStreams.Load() != 1 || traffic.pinnedStreams.Load() != 2 {
		t.Fatalf("streams: service=%d pinned=%d after_termination=%t", traffic.serviceStreams.Load(), traffic.pinnedStreams.Load(), traffic.pinnedObservedAfterTermination.Load())
	}
	if observations["normal_errors"] != 0 || observations["pinned_stream_requests"] != 2 || observations["pinned_stream_count"] != 2 || observations["service_stream_requests"] != 1 {
		t.Fatalf("observations = %+v", observations)
	}
	if observations["rollout_replicaset_uid"] != "rs-new" {
		t.Fatalf("observations = %+v", observations)
	}
	if traffic.streamStartGap() < cfg.PinnedStreamHeadroom {
		t.Fatalf("stream start gap = %s, want at least %s", traffic.streamStartGap(), cfg.PinnedStreamHeadroom)
	}

	health, err := cases[1].Run(t.Context(), run)
	if err != nil {
		t.Fatal(err)
	}
	if health["ready_replicas"] != 2 {
		t.Fatalf("health = %+v", health)
	}
}

func TestActiveRequestsStartsEveryPinnedStreamBeforeWaitingForFirstEvent(t *testing.T) {
	cluster := newFakeRolloutCluster()
	traffic := newFakeRolloutTraffic(cluster)
	traffic.pinnedStartGate = make(chan struct{})
	cfg := rolloutTestConfig()
	cfg.RolloutTimeout = 250 * time.Millisecond

	ctx, cancel := context.WithTimeout(t.Context(), cfg.RolloutTimeout)
	defer cancel()
	_, err := NewRolloutCases(cfg, RolloutDependencies{Traffic: traffic, Cluster: cluster})[0].Run(ctx, rolloutRunContext())
	if err != nil {
		t.Fatal(err)
	}
	if traffic.pinnedStartCalls.Load() != 2 {
		t.Fatalf("pinned starts = %d, want 2", traffic.pinnedStartCalls.Load())
	}
}

func TestTrafficRolloutRequiresBasicStreamingGate(t *testing.T) {
	rolloutCases := NewRolloutCases(rolloutTestConfig(), RolloutDependencies{})
	dependencies := rolloutCases[0].Dependencies()
	if len(dependencies) != 1 || dependencies[0] != CaseKeyStreamsChat {
		t.Fatalf("rollout dependencies = %v, want [%s]", dependencies, CaseKeyStreamsChat)
	}
}

func TestActiveRequestsRolloutFailsOnExternalGenerationChange(t *testing.T) {
	cluster := newFakeRolloutCluster()
	cluster.externalGeneration = true
	traffic := newFakeRolloutTraffic(cluster)
	_, err := NewRolloutCases(rolloutTestConfig(), RolloutDependencies{Traffic: traffic, Cluster: cluster})[0].Run(t.Context(), rolloutRunContext())
	if err == nil || err.Error() != "traffic Deployment changed outside regression run" {
		t.Fatalf("rollout error = %v", err)
	}
}

func TestFinalHealthRejectsDeploymentChangeAfterRollout(t *testing.T) {
	cluster := newFakeRolloutCluster()
	traffic := newFakeRolloutTraffic(cluster)
	run := rolloutRunContext()
	rolloutCases := NewRolloutCases(rolloutTestConfig(), RolloutDependencies{Traffic: traffic, Cluster: cluster})
	if _, err := rolloutCases[0].Run(t.Context(), run); err != nil {
		t.Fatal(err)
	}
	cluster.mu.Lock()
	cluster.externalGeneration = true
	cluster.mu.Unlock()
	if _, err := rolloutCases[1].Run(t.Context(), run); err == nil || err.Error() != "traffic Deployment changed after regression rollout" {
		t.Fatalf("health error = %v", err)
	}
}

func TestTrafficRuntimeRejectsUnsafeRollingStrategy(t *testing.T) {
	cluster := newFakeRolloutCluster()
	deployment, _ := cluster.GetDeployment(t.Context(), "llmgateway", "llmgateway-traffic")
	pdb, _ := cluster.GetPDB(t.Context(), "llmgateway", "llmgateway-traffic")
	pods, _ := cluster.ListPods(t.Context(), "llmgateway", "app=llmgateway-traffic")
	deployment.Spec.Strategy.RollingUpdate.MaxUnavailable = 1

	err := validateTrafficRuntime(deployment, pdb, pods)
	if err == nil || err.Error() != "traffic rolling strategy must use progressDeadlineSeconds=900, maxSurge=1 and maxUnavailable=0" {
		t.Fatalf("validate error = %v", err)
	}
}

func TestTrafficRuntimeRejectsResidualBaselinePod(t *testing.T) {
	cluster := newFakeRolloutCluster()
	deployment, _ := cluster.GetDeployment(t.Context(), "llmgateway", "llmgateway-traffic")
	pdb, _ := cluster.GetPDB(t.Context(), "llmgateway", "llmgateway-traffic")
	pods, _ := cluster.ListPods(t.Context(), "llmgateway", "app=llmgateway-traffic")
	pods = append(pods, clients.Pod{Metadata: clients.ObjectMeta{Name: "residual-pod", UID: "residual"}, Status: clients.PodStatus{Phase: "Failed"}})

	err := validateTrafficRuntime(deployment, pdb, pods)
	if err == nil || err.Error() != "traffic baseline must contain exactly 2 clean ready Pods" {
		t.Fatalf("validate error = %v", err)
	}
}

func TestNormalSamplerDoesNotCountIntentionalShutdownAsTrafficError(t *testing.T) {
	traffic := &cancelBlockingTraffic{started: make(chan struct{})}
	cfg := rolloutTestConfig()
	sampler := newNormalSampler(traffic, cfg, framework.Secret{})
	ctx, cancel := context.WithCancel(t.Context())
	sampler.start(ctx)
	<-traffic.started
	cancel()
	if err := sampler.waitStopped(t.Context()); err != nil {
		t.Fatal(err)
	}
	if sampler.stats().errors != 0 {
		t.Fatalf("stats = %+v", sampler.stats())
	}
}

func rolloutTestConfig() Config {
	cfg := testConfig()
	cfg.Namespace = "llmgateway"
	cfg.TrafficDeployment = "llmgateway-traffic"
	cfg.LongStreamModel = "llmgw-regression-long"
	cfg.SSEDuration = 30 * time.Millisecond
	cfg.SSETolerance = 5 * time.Millisecond
	cfg.PinnedStreamHeadroom = 5 * time.Millisecond
	cfg.RequestInterval = time.Millisecond
	cfg.RolloutPollInterval = time.Millisecond
	cfg.RolloutTimeout = time.Second
	cfg.LeaseTTL = 90 * time.Millisecond
	cfg.MinPreSamples = 2
	cfg.MinRolloutSamples = 2
	cfg.MinPostSamples = 2
	return cfg
}

func rolloutRunContext() *framework.RunContext {
	run := framework.NewRunContext("run-rollout", framework.NewSanitizer())
	run.Set(stateAPIKey, run.Sanitizer.Secret("sk-rollout"))
	run.Set(stateAPIKeyID, "key-rollout")
	return run
}

type fakeRolloutCluster struct {
	mu                 sync.Mutex
	patched            bool
	streamDone         bool
	externalGeneration bool
	patchCalls         int
	releaseCalls       int
	terminating        chan struct{}
}

func newFakeRolloutCluster() *fakeRolloutCluster {
	return &fakeRolloutCluster{terminating: make(chan struct{})}
}

func (f *fakeRolloutCluster) GetDeployment(context.Context, string, string) (clients.Deployment, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.deploymentLocked(), nil
}

func (f *fakeRolloutCluster) GetPDB(context.Context, string, string) (clients.PodDisruptionBudget, error) {
	var pdb clients.PodDisruptionBudget
	pdb.Metadata = clients.ObjectMeta{Name: "llmgateway-traffic"}
	pdb.Spec.MinAvailable = 1
	pdb.Status = clients.PDBStatus{CurrentHealthy: 2, DesiredHealthy: 1, DisruptionsAllowed: 1, ExpectedPods: 2}
	return pdb, nil
}

func (f *fakeRolloutCluster) ListReplicaSets(context.Context, string, string) ([]clients.ReplicaSet, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	baseline := readyReplicaSet("rs-old", "run-before")
	if !f.patched {
		return []clients.ReplicaSet{baseline}, nil
	}
	return []clients.ReplicaSet{baseline, readyReplicaSet("rs-new", "run-rollout")}, nil
}

func (f *fakeRolloutCluster) ListPods(context.Context, string, string) ([]clients.Pod, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if !f.patched {
		return []clients.Pod{readyPod("pod-a", "uid-a", "10.0.0.1"), readyPod("pod-b", "uid-b", "10.0.0.2")}, nil
	}
	if f.streamDone {
		return []clients.Pod{readyPod("pod-new-a", "uid-new-a", "10.0.0.3"), readyPod("pod-new-b", "uid-new-b", "10.0.0.4")}, nil
	}
	podA := readyPod("pod-a", "uid-a", "10.0.0.1")
	now := time.Now().UTC()
	gracePeriodSeconds := int64(330)
	deletionDeadline := now.Add(time.Duration(gracePeriodSeconds) * time.Second)
	podA.Metadata.DeletionTimestamp = &deletionDeadline
	podA.Metadata.DeletionGracePeriodSeconds = &gracePeriodSeconds
	select {
	case <-f.terminating:
	default:
		close(f.terminating)
	}
	return []clients.Pod{podA, readyPod("pod-b", "uid-b", "10.0.0.2"), readyPod("pod-new-a", "uid-new-a", "10.0.0.3")}, nil
}

func (f *fakeRolloutCluster) AcquireLease(context.Context, string, string, string, time.Duration) (clients.Lease, error) {
	return clients.Lease{Spec: clients.LeaseSpec{HolderIdentity: "run-rollout"}}, nil
}
func (f *fakeRolloutCluster) RenewLease(context.Context, string, string, string, time.Duration) (clients.Lease, error) {
	return clients.Lease{Spec: clients.LeaseSpec{HolderIdentity: "run-rollout"}}, nil
}
func (f *fakeRolloutCluster) ReleaseLease(context.Context, string, string, string) error {
	f.mu.Lock()
	f.releaseCalls++
	f.mu.Unlock()
	return nil
}
func (f *fakeRolloutCluster) PatchTrafficRollout(_ context.Context, _, _, resourceVersion string, _ bool, _ string) (clients.Deployment, error) {
	if resourceVersion != "1" {
		return clients.Deployment{}, fmt.Errorf("unexpected resourceVersion %s", resourceVersion)
	}
	f.mu.Lock()
	f.patched = true
	f.patchCalls++
	result := f.deploymentLocked()
	f.mu.Unlock()
	return result, nil
}

func (f *fakeRolloutCluster) deploymentLocked() clients.Deployment {
	var result clients.Deployment
	result.Metadata.Name = "llmgateway-traffic"
	result.Metadata.ResourceVersion = "1"
	result.Metadata.Generation = 1
	result.Metadata.UID = "deployment-uid"
	result.Spec.Replicas = 2
	result.Spec.ProgressDeadlineSeconds = 900
	result.Spec.Strategy.Type = "RollingUpdate"
	result.Spec.Strategy.RollingUpdate.MaxSurge = 1
	result.Spec.Strategy.RollingUpdate.MaxUnavailable = 0
	result.Spec.Template.Metadata.Labels = map[string]string{"app": "llmgateway-traffic"}
	result.Spec.Template.Metadata.Annotations = map[string]string{}
	result.Spec.Template.Spec.TerminationGracePeriodSeconds = 330
	container := clients.Container{Name: "traffic"}
	container.Ports = append(container.Ports, clients.ContainerPort{Name: "http", ContainerPort: 18080})
	container.ReadinessProbe.FailureThreshold = 1
	container.Env = append(container.Env,
		clients.EnvVar{Name: "LLMGATEWAY_DRAIN_WAIT", Value: "45s"},
		clients.EnvVar{Name: "LLMGATEWAY_SHUTDOWN_TIMEOUT", Value: "240s"},
	)
	result.Spec.Template.Spec.Containers = []clients.Container{container}
	if f.patched {
		result.Metadata.ResourceVersion = "2"
		result.Metadata.Generation = 2
		result.Spec.Template.Metadata.Annotations[clients.RegressionRunAnnotation] = "run-rollout"
		if f.externalGeneration {
			result.Metadata.Generation = 3
			result.Spec.Template.Metadata.Annotations["external"] = "changed"
		}
	}
	if f.streamDone {
		result.Status.ObservedGeneration = result.Metadata.Generation
		result.Status.ReadyReplicas = 2
		result.Status.UpdatedReplicas = 2
		result.Status.AvailableReplicas = 2
	}
	return result
}

func readyPod(name, uid, ip string) clients.Pod {
	return clients.Pod{Metadata: clients.ObjectMeta{Name: name, UID: uid}, Status: clients.PodStatus{PodIP: ip, Ready: true, Phase: "Running"}}
}

func readyReplicaSet(uid, runID string) clients.ReplicaSet {
	var result clients.ReplicaSet
	result.Metadata = clients.ObjectMeta{
		Name: uid, UID: uid,
		OwnerReferences: []clients.OwnerReference{{Kind: "Deployment", UID: "deployment-uid"}},
	}
	result.Spec.Replicas = 2
	result.Spec.Template.Metadata.Annotations = map[string]string{clients.RegressionRunAnnotation: runID}
	result.Status.ReadyReplicas = 2
	result.Status.AvailableReplicas = 2
	return result
}

type fakeRolloutTraffic struct {
	cluster                        *fakeRolloutCluster
	serviceStreams                 atomic.Int32
	pinnedStreams                  atomic.Int32
	pinnedObservedAfterTermination atomic.Bool
	mu                             sync.Mutex
	serviceStarted                 time.Time
	pinnedStarted                  time.Time
	pinnedStartGate                chan struct{}
	pinnedStartCalls               atomic.Int32
	pinnedStartGateOnce            sync.Once
}

type cancelBlockingTraffic struct{ started chan struct{} }

func (f *cancelBlockingTraffic) Chat(ctx context.Context, _ string, _ framework.Secret, _, _ string) (clients.ChatResult, error) {
	close(f.started)
	<-ctx.Done()
	return clients.ChatResult{}, ctx.Err()
}

func (f *cancelBlockingTraffic) Stream(context.Context, string, framework.Secret, string, string, func(clients.StreamEvent)) (clients.StreamResult, error) {
	return clients.StreamResult{}, nil
}

func newFakeRolloutTraffic(cluster *fakeRolloutCluster) *fakeRolloutTraffic {
	return &fakeRolloutTraffic{cluster: cluster}
}

func (f *fakeRolloutTraffic) Chat(context.Context, string, framework.Secret, string, string) (clients.ChatResult, error) {
	return clients.ChatResult{StatusCode: 200, MarkerFound: true}, nil
}

func (f *fakeRolloutTraffic) Stream(ctx context.Context, baseURL string, _ framework.Secret, _, _ string, onEvent func(clients.StreamEvent)) (clients.StreamResult, error) {
	result := clients.StreamResult{StatusCode: 200, RequestCount: 1, MarkerFound: true, Done: true, StartedAt: time.Now().UTC()}
	f.mu.Lock()
	pinned := strings.HasPrefix(baseURL, "http://10.0.0.")
	if pinned {
		f.pinnedStarted = result.StartedAt
	} else {
		f.serviceStarted = result.StartedAt
	}
	f.mu.Unlock()
	if pinned && f.pinnedStartGate != nil {
		if f.pinnedStartCalls.Add(1) == 2 {
			f.pinnedStartGateOnce.Do(func() { close(f.pinnedStartGate) })
		}
		select {
		case <-ctx.Done():
			return clients.StreamResult{}, ctx.Err()
		case <-f.pinnedStartGate:
		}
	}
	if onEvent != nil {
		onEvent(clients.StreamEvent{At: time.Now().UTC(), Payload: []byte(`{"first":true}`)})
	}
	if pinned {
		f.pinnedStreams.Add(1)
		<-f.cluster.terminating
		f.pinnedObservedAfterTermination.Store(true)
		if onEvent != nil {
			onEvent(clients.StreamEvent{At: time.Now().UTC(), Payload: []byte(`{"after_terminating":true}`)})
		}
	} else {
		f.serviceStreams.Add(1)
		<-f.cluster.terminating
	}
	time.Sleep(15 * time.Millisecond)
	result.EventCount = 2
	result.FinishedAt = time.Now().UTC()
	result.Duration = 30 * time.Millisecond
	f.cluster.mu.Lock()
	if f.pinnedObservedAfterTermination.Load() && f.serviceStreams.Load() > 0 {
		f.cluster.streamDone = true
	}
	f.cluster.mu.Unlock()
	return result, nil
}

func (f *fakeRolloutTraffic) streamStartGap() time.Duration {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.pinnedStarted.Sub(f.serviceStarted)
}
