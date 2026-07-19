package cases

import (
	"context"
	"fmt"
	"net"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"git.woa.com/wisp/mono2/llmgateway/test/regression/clients"
	"git.woa.com/wisp/mono2/llmgateway/test/regression/framework"
)

const rolloutLeaseName = clients.RegressionRolloutLease

type RolloutCluster interface {
	GetDeployment(context.Context, string, string) (clients.Deployment, error)
	ListReplicaSets(context.Context, string, string) ([]clients.ReplicaSet, error)
	GetPDB(context.Context, string, string) (clients.PodDisruptionBudget, error)
	ListPods(context.Context, string, string) ([]clients.Pod, error)
	AcquireLease(context.Context, string, string, string, time.Duration) (clients.Lease, error)
	RenewLease(context.Context, string, string, string, time.Duration) (clients.Lease, error)
	ReleaseLease(context.Context, string, string, string) error
	PatchTrafficRollout(context.Context, string, string, string, bool, string) (clients.Deployment, error)
}

type RolloutDependencies struct {
	Traffic TrafficPlane
	Cluster RolloutCluster
}

type KubernetesInfrastructure struct {
	Cluster RolloutCluster
}

func (k KubernetesInfrastructure) Preflight(ctx context.Context, cfg Config) (framework.Observations, error) {
	deployment, err := k.Cluster.GetDeployment(ctx, cfg.Namespace, cfg.TrafficDeployment)
	if err != nil {
		return nil, err
	}
	pdb, err := k.Cluster.GetPDB(ctx, cfg.Namespace, cfg.TrafficDeployment)
	if err != nil {
		return nil, err
	}
	pods, err := k.Cluster.ListPods(ctx, cfg.Namespace, "app=llmgateway-traffic")
	if err != nil {
		return nil, err
	}
	if err := validateTrafficRuntime(deployment, pdb, pods); err != nil {
		return nil, err
	}
	return framework.Observations{
		"replicas": deployment.Spec.Replicas, "ready_pods": readyPodCount(pods),
		"termination_grace_seconds": deployment.Spec.Template.Spec.TerminationGracePeriodSeconds,
	}, nil
}

func NewRolloutCases(cfg Config, deps RolloutDependencies) []framework.Case {
	cfg = withRolloutDefaults(withConfigDefaults(cfg))
	return []framework.Case{
		framework.CaseFunc{
			CaseID: CaseActiveRollout, DependsOn: []string{CaseKeyStreamsChat},
			Requires: []framework.Capability{framework.CapabilityKubernetesAPI, framework.CapabilityClusterPodNetwork},
			RunFunc: func(ctx context.Context, run *framework.RunContext) (framework.Observations, error) {
				return activeRequestsSurviveRollout(ctx, run, cfg, deps)
			},
		},
		framework.CaseFunc{
			CaseID: CasePlatformHealthy, DependsOn: []string{CaseActiveRollout},
			Requires: []framework.Capability{framework.CapabilityKubernetesAPI, framework.CapabilityClusterPodNetwork},
			RunFunc: func(ctx context.Context, run *framework.RunContext) (framework.Observations, error) {
				return platformHealthyAfterRollout(ctx, run, cfg, deps.Cluster)
			},
		},
	}
}

func PreprodReleaseGate() framework.Scenario {
	return framework.Scenario{Name: "preprod_release_gate", Cases: []string{
		CasePlatformReady, CaseChannelDelivery, CaseTenantOnboarded, CaseTenantAPIKey,
		CaseModelEffective, CaseKeyCompletesChat, CaseKeyStreamsChat, CaseActiveRollout, CasePlatformHealthy,
	}}
}

func activeRequestsSurviveRollout(ctx context.Context, run *framework.RunContext, cfg Config, deps RolloutDependencies) (framework.Observations, error) {
	if deps.Traffic == nil || deps.Cluster == nil {
		return nil, fmt.Errorf("traffic and rollout cluster dependencies are required")
	}
	rolloutCtx, cancel := context.WithTimeout(ctx, cfg.RolloutTimeout)
	defer cancel()
	if _, err := deps.Cluster.AcquireLease(rolloutCtx, cfg.Namespace, rolloutLeaseName, run.RunID, cfg.LeaseTTL); err != nil {
		return nil, err
	}
	defer func() {
		releaseCtx, releaseCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer releaseCancel()
		_ = deps.Cluster.ReleaseLease(releaseCtx, cfg.Namespace, rolloutLeaseName, run.RunID)
	}()
	renewErr := startLeaseRenewal(rolloutCtx, deps.Cluster, cfg, run.RunID)

	baseline, err := deps.Cluster.GetDeployment(rolloutCtx, cfg.Namespace, cfg.TrafficDeployment)
	if err != nil {
		return nil, err
	}
	pdb, err := deps.Cluster.GetPDB(rolloutCtx, cfg.Namespace, cfg.TrafficDeployment)
	if err != nil {
		return nil, err
	}
	pods, err := deps.Cluster.ListPods(rolloutCtx, cfg.Namespace, "app=llmgateway-traffic")
	if err != nil {
		return nil, err
	}
	if err := validateTrafficRuntime(baseline, pdb, pods); err != nil {
		return nil, err
	}
	port, err := trafficContainerPort(baseline)
	if err != nil {
		return nil, err
	}
	baselineUIDs := make(map[string]struct{}, len(pods))
	baselineReplicaSets, err := deps.Cluster.ListReplicaSets(rolloutCtx, cfg.Namespace, "app=llmgateway-traffic")
	if err != nil {
		return nil, err
	}
	baselineReplicaSetUIDs := make(map[string]struct{}, len(baselineReplicaSets))
	for _, replicaSet := range baselineReplicaSets {
		baselineReplicaSetUIDs[replicaSet.Metadata.UID] = struct{}{}
	}
	baselineRestarts := map[string]int{}
	for _, pod := range pods {
		baselineUIDs[pod.Metadata.UID] = struct{}{}
		baselineRestarts[pod.Metadata.UID] = pod.RestartCount()
	}

	sampler := newNormalSampler(deps.Traffic, cfg, runSecret(run, stateAPIKey))
	samplerCtx, stopSampler := context.WithCancel(rolloutCtx)
	defer stopSampler()
	sampler.start(samplerCtx)
	if err := sampler.waitForPhase(rolloutCtx, samplePhaseBefore, cfg.MinPreSamples); err != nil {
		return nil, err
	}

	type pinnedState struct {
		lastEventUnixNano   atomic.Int64
		terminationUnixNano atomic.Int64
	}
	pinnedStates := make(map[string]*pinnedState, len(pods))
	serviceFirst := make(chan struct{})
	streamOutcomes := make(chan namedStreamResult, len(pods)+1)
	startStream := func(name, baseURL string, first chan struct{}, pinned *pinnedState) {
		go func() {
			var once sync.Once
			result, streamErr := deps.Traffic.Stream(rolloutCtx, baseURL, runSecret(run, stateAPIKey), cfg.LongStreamModel, cfg.Marker, func(event clients.StreamEvent) {
				once.Do(func() { close(first) })
				if pinned != nil && !event.At.IsZero() {
					pinned.lastEventUnixNano.Store(event.At.UTC().UnixNano())
				}
			})
			streamOutcomes <- namedStreamResult{name: name, result: result, err: streamErr}
		}()
	}
	startStream("service", cfg.TrafficURL, serviceFirst, nil)
	if err := waitForStreamStart(rolloutCtx, serviceFirst, streamOutcomes, renewErr); err != nil {
		return nil, err
	}
	if err := waitForStreamHeadroom(rolloutCtx, cfg.PinnedStreamHeadroom, streamOutcomes, renewErr); err != nil {
		return nil, err
	}
	pinnedFirstEvents := make([]<-chan struct{}, 0, len(pods))
	for _, pod := range pods {
		state := &pinnedState{}
		pinnedStates[pod.Metadata.UID] = state
		first := make(chan struct{})
		directURL := (&url.URL{Scheme: "http", Host: net.JoinHostPort(pod.Status.PodIP, strconv.Itoa(port))}).String()
		startStream("pinned:"+pod.Metadata.UID, directURL, first, state)
		pinnedFirstEvents = append(pinnedFirstEvents, first)
	}
	for _, first := range pinnedFirstEvents {
		if err := waitForStreamStart(rolloutCtx, first, streamOutcomes, renewErr); err != nil {
			return nil, err
		}
	}

	annotationsExist := baseline.Spec.Template.Metadata.Annotations != nil
	patched, err := deps.Cluster.PatchTrafficRollout(rolloutCtx, cfg.Namespace, cfg.TrafficDeployment, baseline.Metadata.ResourceVersion, annotationsExist, run.RunID)
	if err != nil {
		return nil, err
	}
	expectedGeneration := patched.Metadata.Generation
	expectedFingerprint, err := patched.TemplateFingerprint()
	if err != nil {
		return nil, err
	}
	if patched.TemplateAnnotation(clients.RegressionRunAnnotation) != run.RunID {
		return nil, fmt.Errorf("traffic Deployment rollout patch returned unexpected generation or annotation")
	}
	if expectedGeneration != baseline.Metadata.Generation+1 {
		return nil, fmt.Errorf("traffic Deployment changed outside regression run")
	}
	sampler.setPhase(samplePhaseRollout)
	rolloutStarted := time.Now()

	results := map[string]clients.StreamResult{}
	allBaselineGone := false
	deploymentReady := false
	expectedStreamResults := len(pods) + 1
	for len(results) < expectedStreamResults || !allBaselineGone || !deploymentReady {
		select {
		case outcome := <-streamOutcomes:
			if outcome.err != nil {
				return nil, outcome.err
			}
			results[outcome.name] = outcome.result
		case err := <-renewErr:
			if err != nil {
				return nil, err
			}
		default:
		}
		current, err := deps.Cluster.GetDeployment(rolloutCtx, cfg.Namespace, cfg.TrafficDeployment)
		if err != nil {
			return nil, err
		}
		fingerprint, err := current.TemplateFingerprint()
		if err != nil {
			return nil, err
		}
		if current.Metadata.Generation != expectedGeneration || fingerprint != expectedFingerprint || current.TemplateAnnotation(clients.RegressionRunAnnotation) != run.RunID {
			return nil, fmt.Errorf("traffic Deployment changed outside regression run")
		}
		currentPods, err := deps.Cluster.ListPods(rolloutCtx, cfg.Namespace, "app=llmgateway-traffic")
		if err != nil {
			return nil, err
		}
		allBaselineGone = true
		for _, pod := range currentPods {
			if state := pinnedStates[pod.Metadata.UID]; state != nil {
				if startedAt := podTerminationStartedAt(pod); !startedAt.IsZero() {
					state.terminationUnixNano.CompareAndSwap(0, startedAt.UnixNano())
				}
			}
			if _, exists := baselineUIDs[pod.Metadata.UID]; exists {
				allBaselineGone = false
			}
		}
		deploymentReady = current.Status.ObservedGeneration >= expectedGeneration && current.Status.ReadyReplicas == current.Spec.Replicas && current.Status.UpdatedReplicas == current.Spec.Replicas && current.Status.AvailableReplicas == current.Spec.Replicas
		if len(results) < expectedStreamResults || !allBaselineGone || !deploymentReady {
			if err := wait(rolloutCtx, cfg.RolloutPollInterval); err != nil {
				return nil, err
			}
		}
	}
	rolloutDuration := time.Since(rolloutStarted)
	newReplicaSet, err := rolloutReplicaSet(rolloutCtx, deps.Cluster, cfg, baseline.Metadata.UID, run.RunID, baselineReplicaSetUIDs, baseline.Spec.Replicas)
	if err != nil {
		return nil, err
	}
	provingPodUID := ""
	for podUID, state := range pinnedStates {
		terminationUnixNano := state.terminationUnixNano.Load()
		if terminationUnixNano > 0 && state.lastEventUnixNano.Load() > terminationUnixNano {
			provingPodUID = podUID
			break
		}
	}
	if provingPodUID == "" {
		return nil, fmt.Errorf("pinned SSE did not receive an event after its Pod entered Terminating")
	}
	pinnedRequests := 0
	for name, result := range results {
		if result.RequestCount != 1 || !result.Done || !result.MarkerFound || result.Duration < cfg.SSEDuration-cfg.SSETolerance {
			return nil, fmt.Errorf("%s SSE did not satisfy the long stream contract", name)
		}
		if strings.HasPrefix(name, "pinned:") {
			pinnedRequests += result.RequestCount
		}
	}
	if rolloutSamples := sampler.stats().rollout; rolloutSamples < cfg.MinRolloutSamples {
		return nil, fmt.Errorf("rollout completed with %d normal samples, require at least %d", rolloutSamples, cfg.MinRolloutSamples)
	}
	sampler.setPhase(samplePhaseAfter)
	if err := sampler.waitForPhase(rolloutCtx, samplePhaseAfter, cfg.MinPostSamples); err != nil {
		return nil, err
	}
	stopSampler()
	if err := sampler.waitStopped(rolloutCtx); err != nil {
		return nil, err
	}
	stats := sampler.stats()
	if stats.errors != 0 {
		return nil, fmt.Errorf("normal requests had %d errors during rollout", stats.errors)
	}
	run.Set("rollout_expected_generation", expectedGeneration)
	run.Set("rollout_expected_fingerprint", expectedFingerprint)
	run.Set("rollout_baseline_restarts", baselineRestarts)
	return framework.Observations{
		"normal_before": stats.before, "normal_during_rollout": stats.rollout, "normal_after": stats.after, "normal_errors": stats.errors,
		"service_stream_requests": results["service"].RequestCount, "pinned_stream_requests": pinnedRequests, "pinned_stream_count": len(pinnedStates),
		"service_stream_duration_ms": results["service"].Duration.Milliseconds(), "pinned_stream_duration_ms": results["pinned:"+provingPodUID].Duration.Milliseconds(),
		"pinned_pod_uid": provingPodUID, "rollout_replicaset_uid": newReplicaSet.Metadata.UID, "rollout_duration_ms": rolloutDuration.Milliseconds(),
	}, nil
}

func podTerminationStartedAt(pod clients.Pod) time.Time {
	if pod.Metadata.DeletionTimestamp == nil {
		return time.Time{}
	}
	startedAt := pod.Metadata.DeletionTimestamp.UTC()
	if grace := pod.Metadata.DeletionGracePeriodSeconds; grace != nil && *grace > 0 {
		startedAt = startedAt.Add(-time.Duration(*grace) * time.Second)
	}
	return startedAt
}

func rolloutReplicaSet(ctx context.Context, cluster RolloutCluster, cfg Config, deploymentUID, runID string, baseline map[string]struct{}, expectedReplicas int) (clients.ReplicaSet, error) {
	for {
		replicaSets, err := cluster.ListReplicaSets(ctx, cfg.Namespace, "app=llmgateway-traffic")
		if err != nil {
			return clients.ReplicaSet{}, err
		}
		matches := make([]clients.ReplicaSet, 0, 1)
		for _, replicaSet := range replicaSets {
			if _, existed := baseline[replicaSet.Metadata.UID]; existed || replicaSet.Spec.Template.Metadata.Annotations[clients.RegressionRunAnnotation] != runID {
				continue
			}
			if deploymentUID != "" && !ownedByDeployment(replicaSet, deploymentUID) {
				continue
			}
			matches = append(matches, replicaSet)
		}
		if len(matches) > 1 {
			return clients.ReplicaSet{}, fmt.Errorf("rollout produced %d attributable ReplicaSets, require exactly one", len(matches))
		}
		if len(matches) == 1 && matches[0].Status.ReadyReplicas == expectedReplicas && matches[0].Status.AvailableReplicas == expectedReplicas {
			return matches[0], nil
		}
		if err := wait(ctx, cfg.RolloutPollInterval); err != nil {
			return clients.ReplicaSet{}, err
		}
	}
}

func ownedByDeployment(replicaSet clients.ReplicaSet, deploymentUID string) bool {
	for _, owner := range replicaSet.Metadata.OwnerReferences {
		if owner.Kind == "Deployment" && owner.UID == deploymentUID {
			return true
		}
	}
	return false
}

func platformHealthyAfterRollout(ctx context.Context, run *framework.RunContext, cfg Config, cluster RolloutCluster) (framework.Observations, error) {
	deployment, err := cluster.GetDeployment(ctx, cfg.Namespace, cfg.TrafficDeployment)
	if err != nil {
		return nil, err
	}
	expectedGenerationValue, generationOK := run.Get("rollout_expected_generation")
	expectedGeneration, generationTypeOK := expectedGenerationValue.(int64)
	expectedFingerprintValue, fingerprintOK := run.Get("rollout_expected_fingerprint")
	expectedFingerprint, fingerprintTypeOK := expectedFingerprintValue.(string)
	currentFingerprint, fingerprintErr := deployment.TemplateFingerprint()
	if !generationOK || !generationTypeOK || !fingerprintOK || !fingerprintTypeOK || fingerprintErr != nil || deployment.Metadata.Generation != expectedGeneration || deployment.Status.ObservedGeneration < expectedGeneration || currentFingerprint != expectedFingerprint {
		return nil, fmt.Errorf("traffic Deployment changed after regression rollout")
	}
	pdb, err := cluster.GetPDB(ctx, cfg.Namespace, cfg.TrafficDeployment)
	if err != nil {
		return nil, err
	}
	pods, err := cluster.ListPods(ctx, cfg.Namespace, "app=llmgateway-traffic")
	if err != nil {
		return nil, err
	}
	if deployment.TemplateAnnotation(clients.RegressionRunAnnotation) != run.RunID || deployment.Status.ReadyReplicas != deployment.Spec.Replicas || deployment.Status.UpdatedReplicas != deployment.Spec.Replicas || deployment.Status.AvailableReplicas != deployment.Spec.Replicas {
		return nil, fmt.Errorf("traffic Deployment did not return to the expected healthy state")
	}
	if pdb.Status.CurrentHealthy < pdb.Status.DesiredHealthy || pdb.Status.ExpectedPods != deployment.Spec.Replicas || len(pods) != deployment.Spec.Replicas {
		return nil, fmt.Errorf("traffic PDB is not healthy after rollout")
	}
	for _, pod := range pods {
		if !pod.IsReady() || pod.Metadata.DeletionTimestamp != nil || pod.RestartCount() != 0 {
			return nil, fmt.Errorf("traffic Pod %q is not clean after rollout", pod.Metadata.Name)
		}
	}
	return framework.Observations{"ready_replicas": deployment.Status.ReadyReplicas, "healthy_pods": len(pods), "disruptions_allowed": pdb.Status.DisruptionsAllowed}, nil
}

func validateTrafficRuntime(deployment clients.Deployment, pdb clients.PodDisruptionBudget, pods []clients.Pod) error {
	if deployment.Spec.Replicas < 2 || deployment.Spec.Template.Metadata.Labels["app"] != "llmgateway-traffic" {
		return fmt.Errorf("traffic Deployment must have at least two replicas and the stable app label")
	}
	if deployment.Spec.ProgressDeadlineSeconds != 900 || deployment.Spec.Strategy.Type != "RollingUpdate" || !intOrStringEquals(deployment.Spec.Strategy.RollingUpdate.MaxSurge, 1) || !intOrStringEquals(deployment.Spec.Strategy.RollingUpdate.MaxUnavailable, 0) {
		return fmt.Errorf("traffic rolling strategy must use progressDeadlineSeconds=900, maxSurge=1 and maxUnavailable=0")
	}
	if deployment.Spec.Template.Spec.TerminationGracePeriodSeconds < 330 {
		return fmt.Errorf("traffic termination grace period is below 330 seconds")
	}
	container, ok := trafficContainer(deployment)
	if !ok || container.ReadinessProbe.FailureThreshold != 1 || envValue(container, "LLMGATEWAY_DRAIN_WAIT") != "45s" || envValue(container, "LLMGATEWAY_SHUTDOWN_TIMEOUT") != "240s" {
		return fmt.Errorf("traffic drain, shutdown or readiness settings do not match the rollout contract")
	}
	if !intOrStringEquals(pdb.Spec.MinAvailable, 1) || pdb.Status.ExpectedPods != deployment.Spec.Replicas || pdb.Status.CurrentHealthy < pdb.Status.DesiredHealthy {
		return fmt.Errorf("traffic PDB is not healthy")
	}
	if len(pods) != deployment.Spec.Replicas || readyPodCount(pods) != deployment.Spec.Replicas {
		return fmt.Errorf("traffic baseline must contain exactly %d clean ready Pods", deployment.Spec.Replicas)
	}
	return nil
}

func intOrStringEquals(value any, expected int) bool {
	switch typed := value.(type) {
	case int:
		return typed == expected
	case int32:
		return int(typed) == expected
	case int64:
		return int(typed) == expected
	case float64:
		return typed == float64(expected)
	case string:
		parsed, err := strconv.Atoi(typed)
		return err == nil && parsed == expected
	default:
		return false
	}
}

func trafficContainer(deployment clients.Deployment) (clients.Container, bool) {
	for _, container := range deployment.Spec.Template.Spec.Containers {
		if container.Name == "traffic" {
			return container, true
		}
	}
	return clients.Container{}, false
}

func trafficContainerPort(deployment clients.Deployment) (int, error) {
	container, ok := trafficContainer(deployment)
	if !ok {
		return 0, fmt.Errorf("traffic container not found")
	}
	for _, port := range container.Ports {
		if port.Name == "http" && port.ContainerPort > 0 {
			return port.ContainerPort, nil
		}
	}
	return 0, fmt.Errorf("traffic HTTP container port not found")
}

func envValue(container clients.Container, name string) string {
	for _, item := range container.Env {
		if item.Name == name {
			return item.Value
		}
	}
	return ""
}

func readyPodCount(pods []clients.Pod) int {
	count := 0
	for _, pod := range pods {
		if pod.IsReady() && pod.Metadata.DeletionTimestamp == nil {
			count++
		}
	}
	return count
}

func selectBaselinePod(pods []clients.Pod) (clients.Pod, error) {
	for _, pod := range pods {
		if pod.IsReady() && pod.Metadata.DeletionTimestamp == nil && pod.Status.PodIP != "" {
			return pod, nil
		}
	}
	return clients.Pod{}, fmt.Errorf("no ready traffic Pod with an IP is available")
}

func startLeaseRenewal(ctx context.Context, cluster RolloutCluster, cfg Config, holder string) <-chan error {
	result := make(chan error, 1)
	interval := cfg.LeaseTTL / 3
	if interval <= 0 {
		interval = time.Second
	}
	go func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				lease, err := cluster.RenewLease(ctx, cfg.Namespace, rolloutLeaseName, holder, cfg.LeaseTTL)
				if err != nil {
					result <- err
					return
				}
				if lease.Spec.HolderIdentity != holder {
					result <- fmt.Errorf("rollout Lease holder changed")
					return
				}
			}
		}
	}()
	return result
}

type namedStreamResult struct {
	name   string
	result clients.StreamResult
	err    error
}

func waitForStreamStart(ctx context.Context, first <-chan struct{}, outcomes <-chan namedStreamResult, renewErr <-chan error) error {
	select {
	case <-ctx.Done():
		return ctx.Err()
	case outcome := <-outcomes:
		if outcome.err != nil {
			return outcome.err
		}
		return fmt.Errorf("%s SSE ended before rollout started", outcome.name)
	case err := <-renewErr:
		return err
	case <-first:
		return nil
	}
}

func waitForStreamHeadroom(ctx context.Context, duration time.Duration, outcomes <-chan namedStreamResult, renewErr <-chan error) error {
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case outcome := <-outcomes:
		if outcome.err != nil {
			return outcome.err
		}
		return fmt.Errorf("%s SSE ended before pinned stream started", outcome.name)
	case err := <-renewErr:
		return err
	case <-timer.C:
		return nil
	}
}

type samplePhase int32

const (
	samplePhaseBefore samplePhase = iota
	samplePhaseRollout
	samplePhaseAfter
)

type sampleStats struct {
	before  int
	rollout int
	after   int
	errors  int
}

type normalSampler struct {
	traffic TrafficPlane
	cfg     Config
	key     framework.Secret
	phase   atomic.Int32
	mu      sync.RWMutex
	values  sampleStats
	done    chan struct{}
}

func newNormalSampler(traffic TrafficPlane, cfg Config, key framework.Secret) *normalSampler {
	return &normalSampler{traffic: traffic, cfg: cfg, key: key, done: make(chan struct{})}
}

func (s *normalSampler) start(ctx context.Context) {
	go func() {
		defer close(s.done)
		for {
			_, err := s.traffic.Chat(ctx, s.cfg.TrafficURL, s.key, s.cfg.Model, s.cfg.Marker)
			if err != nil && ctx.Err() != nil {
				return
			}
			s.record(samplePhase(s.phase.Load()), err)
			if err := wait(ctx, s.cfg.RequestInterval); err != nil {
				return
			}
		}
	}()
}

func (s *normalSampler) waitStopped(ctx context.Context) error {
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-s.done:
		return nil
	}
}

func (s *normalSampler) setPhase(phase samplePhase) { s.phase.Store(int32(phase)) }

func (s *normalSampler) record(phase samplePhase, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err != nil {
		s.values.errors++
	}
	switch phase {
	case samplePhaseBefore:
		s.values.before++
	case samplePhaseRollout:
		s.values.rollout++
	case samplePhaseAfter:
		s.values.after++
	}
}

func (s *normalSampler) stats() sampleStats {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.values
}

func (s *normalSampler) waitForPhase(ctx context.Context, phase samplePhase, minimum int) error {
	for {
		stats := s.stats()
		count := stats.before
		if phase == samplePhaseRollout {
			count = stats.rollout
		} else if phase == samplePhaseAfter {
			count = stats.after
		}
		if count >= minimum {
			return nil
		}
		if err := wait(ctx, s.cfg.RequestInterval); err != nil {
			return err
		}
	}
}

func withRolloutDefaults(cfg Config) Config {
	if cfg.LongStreamModel == "" {
		cfg.LongStreamModel = "llmgw-regression-long"
	}
	if cfg.SSEDuration <= 0 {
		cfg.SSEDuration = 3 * time.Minute
	}
	if cfg.SSETolerance <= 0 {
		cfg.SSETolerance = 5 * time.Second
	}
	if cfg.PinnedStreamHeadroom <= 0 {
		cfg.PinnedStreamHeadroom = 30 * time.Second
	}
	if cfg.RequestInterval <= 0 {
		cfg.RequestInterval = time.Second
	}
	if cfg.RolloutPollInterval <= 0 {
		cfg.RolloutPollInterval = time.Second
	}
	if cfg.RolloutTimeout <= 0 {
		cfg.RolloutTimeout = 15 * time.Minute
	}
	if cfg.LeaseTTL <= 0 {
		cfg.LeaseTTL = 90 * time.Second
	}
	if cfg.MinPreSamples <= 0 {
		cfg.MinPreSamples = 10
	}
	if cfg.MinRolloutSamples <= 0 {
		cfg.MinRolloutSamples = 120
	}
	if cfg.MinPostSamples <= 0 {
		cfg.MinPostSamples = 10
	}
	return cfg
}
