package cases

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"time"

	"git.woa.com/wisp/mono2/llmgateway/test/regression/clients"
	"git.woa.com/wisp/mono2/llmgateway/test/regression/framework"
)

type SetRuntimeFailureCluster interface {
	LeaseCluster
	ListPods(context.Context, string, string) ([]clients.Pod, error)
	GetDeployment(context.Context, string, string) (clients.Deployment, error)
	GetPDB(context.Context, string, string) (clients.PodDisruptionBudget, error)
	GetNode(context.Context, string) (clients.Node, error)
	DeletePodNow(context.Context, string, string) error
}

type SetRuntimeFailureDependencies struct {
	Cluster SetRuntimeFailureCluster
	Traffic TrafficPlane
}

func NewSetRuntimeFailureCases(cfg Config, deps SetRuntimeFailureDependencies) []framework.Case {
	cfg = withRolloutDefaults(withConfigDefaults(cfg))
	return []framework.Case{framework.CaseFunc{
		CaseID:    CaseSetPodFailure,
		DependsOn: []string{CaseKeyStreamsChat},
		Requires:  []framework.Capability{framework.CapabilityKubernetesAPI, framework.CapabilityClusterPodNetwork, framework.CapabilityDisruptiveKubernetes},
		RunFunc: func(ctx context.Context, run *framework.RunContext) (framework.Observations, error) {
			return setRuntimeSurvivesPodFailure(ctx, run, cfg, deps)
		},
	}}
}

func SetTrafficPodFailureGate() framework.Scenario {
	return framework.Scenario{Name: "set_traffic_pod_failure_gate", Cases: []string{
		CasePlatformReady, CaseChannelDelivery, CaseTenantOnboarded, CaseTenantAPIKey,
		CaseModelEffective, CaseKeyCompletesChat, CaseKeyStreamsChat, CaseSetPodFailure,
	}}
}

func setRuntimeSurvivesPodFailure(ctx context.Context, run *framework.RunContext, cfg Config, deps SetRuntimeFailureDependencies) (framework.Observations, error) {
	if deps.Cluster == nil || deps.Traffic == nil {
		return nil, fmt.Errorf("cluster and traffic dependencies are required")
	}
	if len(cfg.TargetSets) != 1 {
		return nil, fmt.Errorf("Set traffic Pod failure gate requires exactly one target Set")
	}
	testCtx, cancel := context.WithTimeout(ctx, cfg.RolloutTimeout)
	defer cancel()
	if _, err := deps.Cluster.AcquireLease(testCtx, cfg.Namespace, rolloutLeaseName, run.RunID, cfg.LeaseTTL); err != nil {
		return nil, err
	}
	defer func() {
		releaseCtx, releaseCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer releaseCancel()
		_ = deps.Cluster.ReleaseLease(releaseCtx, cfg.Namespace, rolloutLeaseName, run.RunID)
	}()
	renewErr := startLeaseRenewal(testCtx, deps.Cluster, cfg, run.RunID)
	checkLease := func() error {
		select {
		case err := <-renewErr:
			return err
		default:
			return nil
		}
	}

	setID := cfg.TargetSets[0]
	selector := "llmgateway.io/set=" + setID + ",llmgateway.io/newapi-role=traffic"
	pods, err := deps.Cluster.ListPods(testCtx, cfg.Namespace, selector)
	if err != nil {
		return nil, err
	}
	ready, appName, generation, err := validateSetTrafficFailureBaseline(pods)
	if err != nil {
		return nil, err
	}
	deployment, err := deps.Cluster.GetDeployment(testCtx, cfg.Namespace, appName)
	if err != nil {
		return nil, err
	}
	pdb, err := deps.Cluster.GetPDB(testCtx, cfg.Namespace, appName)
	if err != nil {
		return nil, err
	}
	if err := validateSetTrafficHAContract(deployment, pdb); err != nil {
		return nil, err
	}
	baselineZones, err := setTrafficZones(testCtx, deps.Cluster, ready)
	if err != nil {
		return nil, err
	}

	key := runSecret(run, stateAPIKey)
	sampler := newContinuitySampler(deps.Traffic, cfg, key)
	samplerCtx, stopSampler := context.WithCancel(testCtx)
	sampler.start(samplerCtx)
	defer stopSampler()
	if err := sampler.waitForSamples(testCtx, cfg.MinPreSamples); err != nil {
		return nil, err
	}

	sourceIP := make(chan string, 1)
	pinnedOutcome := make(chan error, 1)
	pinnedCtx, stopPinned := context.WithCancel(testCtx)
	defer stopPinned()
	go func() {
		var once sync.Once
		_, streamErr := deps.Traffic.Stream(pinnedCtx, cfg.TrafficURL, key, cfg.LongStreamModel, cfg.Marker, func(event clients.StreamEvent) {
			if event.SourceIP != "" {
				once.Do(func() { sourceIP <- event.SourceIP })
			}
		})
		pinnedOutcome <- streamErr
	}()
	var victim clients.Pod
	select {
	case <-testCtx.Done():
		return nil, testCtx.Err()
	case streamErr := <-pinnedOutcome:
		if streamErr == nil {
			return nil, fmt.Errorf("pinned SSE completed before Pod failure was injected")
		}
		return nil, fmt.Errorf("pinned SSE ended before Pod failure was injected: %w", streamErr)
	case leaseErr := <-renewErr:
		return nil, leaseErr
	case observedIP := <-sourceIP:
		var found bool
		for _, pod := range ready {
			if pod.Status.PodIP == observedIP {
				victim, found = pod, true
				break
			}
		}
		if !found {
			return nil, fmt.Errorf("pinned SSE source IP %s does not match a ready Set traffic Pod", observedIP)
		}
	}

	baselineSamples := sampler.stats().total
	baselineUIDs := make(map[string]struct{}, len(ready))
	for _, pod := range ready {
		baselineUIDs[pod.Metadata.UID] = struct{}{}
	}
	if err := deps.Cluster.DeletePodNow(testCtx, cfg.Namespace, victim.Metadata.Name); err != nil {
		return nil, fmt.Errorf("force delete Set traffic Pod: %w", err)
	}
	replacement, err := waitForReplacementPod(testCtx, deps.Cluster, cfg, selector, baselineUIDs)
	if err != nil {
		return nil, err
	}
	if err := checkLease(); err != nil {
		return nil, err
	}
	restoredPods, err := deps.Cluster.ListPods(testCtx, cfg.Namespace, selector)
	if err != nil {
		return nil, err
	}
	restoredReady, _, _, err := validateSetTrafficFailureBaseline(restoredPods)
	if err != nil {
		return nil, err
	}
	restoredZones, err := setTrafficZones(testCtx, deps.Cluster, restoredReady)
	if err != nil {
		return nil, err
	}
	if err := waitForSetTrafficHAStatus(testCtx, deps.Cluster, cfg, appName); err != nil {
		return nil, err
	}
	if err := sampler.waitForSamples(testCtx, baselineSamples+cfg.MinPostSamples); err != nil {
		return nil, err
	}

	// A hard Pod loss may terminate the pinned TCP connection. The user-visible
	// contract is that reconnecting through the stable traffic endpoint completes.
	reconnected, err := deps.Traffic.Stream(testCtx, cfg.TrafficURL, key, cfg.LongStreamModel, cfg.Marker, nil)
	if err != nil {
		return nil, fmt.Errorf("SSE reconnect after Set traffic Pod failure: %w", err)
	}
	if err := checkLease(); err != nil {
		return nil, err
	}
	if !reconnected.Done || !reconnected.MarkerFound {
		return nil, fmt.Errorf("SSE reconnect after Set traffic Pod failure did not complete")
	}

	stopPinned()
	pinnedInterrupted := false
	select {
	case streamErr := <-pinnedOutcome:
		pinnedInterrupted = streamErr != nil
	case <-time.After(2 * cfg.RolloutPollInterval):
	}
	stopSampler()
	if err := sampler.waitStopped(testCtx); err != nil {
		return nil, err
	}
	stats := sampler.stats()
	if stats.maxConsecutiveErrors > 1 {
		return nil, fmt.Errorf("ordinary requests failed %d consecutive times during Set Pod replacement", stats.maxConsecutiveErrors)
	}
	if stats.successes < cfg.MinPreSamples+cfg.MinPostSamples {
		return nil, fmt.Errorf("insufficient successful requests during Set Pod replacement: %d", stats.successes)
	}

	return framework.Observations{
		"set_id": setID, "runtime_generation": generation,
		"victim_pod_uid": victim.Metadata.UID, "replacement_pod_uid": replacement.Metadata.UID,
		"baseline_ready_pods": len(ready), "restored_ready_pods": 2,
		"ordinary_requests": stats.total, "ordinary_errors": stats.errors,
		"max_consecutive_errors":    stats.maxConsecutiveErrors,
		"pinned_stream_interrupted": pinnedInterrupted, "reconnected_stream_done": reconnected.Done,
		"baseline_zone_count": len(baselineZones), "restored_zone_count": len(restoredZones),
		"zone_spread_contract": "topology.kubernetes.io/zone/DoNotSchedule",
	}, nil
}

func setTrafficZones(ctx context.Context, cluster SetRuntimeFailureCluster, pods []clients.Pod) (map[string]struct{}, error) {
	zones := make(map[string]struct{}, len(pods))
	for _, pod := range pods {
		node, err := cluster.GetNode(ctx, pod.Spec.NodeName)
		if err != nil {
			return nil, fmt.Errorf("read zone for Set traffic Pod %s: %w", pod.Metadata.Name, err)
		}
		zone := strings.TrimSpace(node.Metadata.Labels["topology.kubernetes.io/zone"])
		if zone == "" {
			return nil, fmt.Errorf("node %s has no topology.kubernetes.io/zone label", pod.Spec.NodeName)
		}
		zones[zone] = struct{}{}
	}
	if len(zones) != 2 {
		return nil, fmt.Errorf("Set traffic replicas must run in exactly 2 availability zones")
	}
	return zones, nil
}

func validateSetTrafficFailureBaseline(pods []clients.Pod) ([]clients.Pod, string, string, error) {
	ready := make([]clients.Pod, 0, len(pods))
	appName := ""
	generation := ""
	nodes := map[string]struct{}{}
	for _, pod := range pods {
		if pod.Metadata.DeletionTimestamp != nil || !pod.IsReady() {
			continue
		}
		podApp := strings.TrimSpace(pod.Metadata.Labels["app.kubernetes.io/name"])
		podGeneration := strings.TrimSpace(pod.Metadata.Labels["llmgateway.io/runtime-generation"])
		if podApp == "" || podGeneration == "" || strings.TrimSpace(pod.Spec.NodeName) == "" || strings.TrimSpace(pod.Status.PodIP) == "" {
			return nil, "", "", fmt.Errorf("Set traffic Pod is missing runtime, node or network identity")
		}
		if appName != "" && (appName != podApp || generation != podGeneration) {
			return nil, "", "", fmt.Errorf("Set traffic failure gate cannot run while multiple runtime generations are serving")
		}
		appName, generation = podApp, podGeneration
		nodes[pod.Spec.NodeName] = struct{}{}
		ready = append(ready, pod)
	}
	if len(ready) != 2 {
		return nil, "", "", fmt.Errorf("Set traffic failure baseline must contain exactly 2 clean ready Pods")
	}
	if len(nodes) != 2 {
		return nil, "", "", fmt.Errorf("Set traffic replicas must run on distinct Kubernetes nodes")
	}
	return ready, appName, generation, nil
}

func validateSetTrafficHAContract(deployment clients.Deployment, pdb clients.PodDisruptionBudget) error {
	if deployment.Spec.Replicas < 2 || deployment.Status.ReadyReplicas < 2 {
		return fmt.Errorf("Set traffic Deployment must have at least 2 ready replicas")
	}
	spreadOK := false
	for _, constraint := range deployment.Spec.Template.Spec.TopologySpreadConstraints {
		if constraint.TopologyKey == "topology.kubernetes.io/zone" && constraint.MaxSkew == 1 && constraint.WhenUnsatisfiable == "DoNotSchedule" {
			spreadOK = true
			break
		}
	}
	if !spreadOK {
		return fmt.Errorf("Set traffic Deployment must enforce cross-zone topology spread")
	}
	if fmt.Sprint(pdb.Spec.MinAvailable) != "1" {
		return fmt.Errorf("Set traffic PodDisruptionBudget must use minAvailable=1")
	}
	if pdb.Status.ExpectedPods < 2 || pdb.Status.CurrentHealthy < 2 || pdb.Status.DisruptionsAllowed < 1 {
		return fmt.Errorf("Set traffic PodDisruptionBudget is not healthy for a Pod disruption")
	}
	return nil
}

func waitForSetTrafficHAStatus(ctx context.Context, cluster SetRuntimeFailureCluster, cfg Config, appName string) error {
	for {
		deployment, deploymentErr := cluster.GetDeployment(ctx, cfg.Namespace, appName)
		pdb, pdbErr := cluster.GetPDB(ctx, cfg.Namespace, appName)
		if deploymentErr == nil && pdbErr == nil && validateSetTrafficHAContract(deployment, pdb) == nil {
			return nil
		}
		if err := wait(ctx, cfg.RolloutPollInterval); err != nil {
			return fmt.Errorf("wait for restored Set traffic HA status: %w", err)
		}
	}
}

func waitForReplacementPod(ctx context.Context, cluster SetRuntimeFailureCluster, cfg Config, selector string, baselineUIDs map[string]struct{}) (clients.Pod, error) {
	for {
		pods, err := cluster.ListPods(ctx, cfg.Namespace, selector)
		if err != nil {
			return clients.Pod{}, err
		}
		ready, _, _, baselineErr := validateSetTrafficFailureBaseline(pods)
		if baselineErr == nil {
			for _, pod := range ready {
				if _, existed := baselineUIDs[pod.Metadata.UID]; !existed {
					return pod, nil
				}
			}
		}
		if err := wait(ctx, cfg.RolloutPollInterval); err != nil {
			return clients.Pod{}, fmt.Errorf("wait for replacement Set traffic Pod: %w", err)
		}
	}
}

type continuityStats struct {
	total, successes, errors, consecutiveErrors, maxConsecutiveErrors int
}

type continuitySampler struct {
	traffic TrafficPlane
	cfg     Config
	key     framework.Secret
	mu      sync.RWMutex
	values  continuityStats
	done    chan struct{}
}

func newContinuitySampler(traffic TrafficPlane, cfg Config, key framework.Secret) *continuitySampler {
	return &continuitySampler{traffic: traffic, cfg: cfg, key: key, done: make(chan struct{})}
}

func (s *continuitySampler) start(ctx context.Context) {
	go func() {
		defer close(s.done)
		for {
			_, err := s.traffic.Chat(ctx, s.cfg.TrafficURL, s.key, s.cfg.Model, s.cfg.Marker)
			if err != nil && ctx.Err() != nil {
				return
			}
			s.record(err)
			if err := wait(ctx, s.cfg.RequestInterval); err != nil {
				return
			}
		}
	}()
}

func (s *continuitySampler) record(err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.values.total++
	if err == nil {
		s.values.successes++
		s.values.consecutiveErrors = 0
		return
	}
	s.values.errors++
	s.values.consecutiveErrors++
	if s.values.consecutiveErrors > s.values.maxConsecutiveErrors {
		s.values.maxConsecutiveErrors = s.values.consecutiveErrors
	}
}

func (s *continuitySampler) stats() continuityStats {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.values
}

func (s *continuitySampler) waitForSamples(ctx context.Context, minimum int) error {
	for s.stats().total < minimum {
		if err := wait(ctx, s.cfg.RequestInterval); err != nil {
			return err
		}
	}
	return nil
}

func (s *continuitySampler) waitStopped(ctx context.Context) error {
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-s.done:
		return nil
	}
}
