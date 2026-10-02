package hostdrain

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	autoscalingv2 "k8s.io/api/autoscaling/v2"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/kubernetes"
)

const (
	StateAnnotation        = "fleet.actor.dev/workerd-host-drain-state"
	ReleaseHoldAnnotation  = "fleet.actor.dev/runtime-release-hold"
	hostObservationWorkers = 32
)

type releaseHold struct {
	ID          string    `json:"id"`
	WorkloadUID string    `json:"workload_uid"`
	AcquiredAt  time.Time `json:"acquired_at"`
}

type ControllerConfig struct {
	Namespace              string
	CellName               string
	StatefulSetName        string
	HPAName                string
	PodSelector            string
	Token                  string
	ManagementPort         int
	MinReplicas            int32
	MaxRemainingUsagePct   int64
	MetricsFreshness       time.Duration
	ScaleDownStabilization time.Duration
	DrainTimeout           time.Duration
	ReconcileInterval      time.Duration
	TopologyKey            string
	RequiredZones          int
	TopologyMaxSkew        int
}

type Controller struct {
	Kubernetes kubernetes.Interface
	HTTPClient *http.Client
	Config     ControllerConfig
	Now        func() time.Time
	Logf       func(string, ...any)
}

type ReconcileResult struct {
	Decision Decision
	Applied  bool
}

type hostStats struct {
	HostActiveActors    *int64                 `json:"host_active_actors"`
	HostMaxActiveActors *int64                 `json:"host_max_active_actors"`
	HostDraining        *bool                  `json:"host_draining"`
	HostAcceptingActors *bool                  `json:"host_accepting_actors"`
	BridgeActiveActors  int64                  `json:"bridge_active_actors"`
	Quiescent           bool                   `json:"quiescent"`
	WorkerdAdmission    *workerdAdmissionStats `json:"workerd_admission"`
}

type workerdAdmissionStats struct {
	InFlight       int64 `json:"in_flight"`
	Queued         int64 `json:"queued"`
	PeakInFlight   int64 `json:"peak_in_flight"`
	PeakQueued     int64 `json:"peak_queued"`
	QueuedTotal    int64 `json:"queued_total"`
	RejectedTotal  int64 `json:"rejected_total"`
	TimedOutTotal  int64 `json:"timed_out_total"`
	MaxInFlight    int64 `json:"max_in_flight"`
	MaxQueued      int64 `json:"max_queued"`
	QueueTimeoutMS int64 `json:"queue_timeout_ms"`
}

func (c *Controller) Run(ctx context.Context) {
	interval := c.Config.ReconcileInterval
	if interval <= 0 {
		interval = 5 * time.Second
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		if result, err := c.ReconcileOnce(ctx); err != nil {
			c.logf("workerd Host drain reconcile failed: %v", err)
		} else if result.Decision.Reason != "" {
			c.logf("workerd Host drain phase=%s applied=%t: %s", result.Decision.State.Phase, result.Applied, result.Decision.Reason)
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (c *Controller) ReconcileOnce(ctx context.Context) (ReconcileResult, error) {
	if err := c.validate(); err != nil {
		return ReconcileResult{}, err
	}
	statefulSet, err := c.Kubernetes.AppsV1().StatefulSets(c.Config.Namespace).Get(
		ctx, c.Config.StatefulSetName, metav1.GetOptions{},
	)
	if err != nil {
		return ReconcileResult{}, fmt.Errorf("get runtime StatefulSet: %w", err)
	}
	state, err := decodeState(statefulSet.Annotations[StateAnnotation])
	if err != nil {
		return ReconcileResult{}, err
	}
	hold, err := decodeReleaseHold(statefulSet.Annotations[ReleaseHoldAnnotation], string(statefulSet.UID))
	if err != nil {
		return ReconcileResult{}, err
	}
	if hold != nil {
		if state.Phase != PhaseIdle {
			return ReconcileResult{}, fmt.Errorf(
				"runtime release hold %q overlaps Host drain phase %s", hold.ID, state.Phase,
			)
		}
		return ReconcileResult{Decision: Decision{
			State:  state,
			Action: Action{Kind: ActionNone},
			Reason: fmt.Sprintf("runtime release hold %q pauses Host scale-in", hold.ID),
		}}, nil
	}
	snapshot, err := c.snapshot(ctx, statefulSet)
	if err != nil {
		return ReconcileResult{}, err
	}
	decision := Decide(state, snapshot)
	if decision.State == state && decision.Action.Kind == ActionNone {
		return ReconcileResult{Decision: decision}, nil
	}
	if err := c.persistState(ctx, statefulSet, decision.State); err != nil {
		return ReconcileResult{Decision: decision}, fmt.Errorf("persist drain state: %w", err)
	}
	if decision.Action.Kind == ActionNone {
		return ReconcileResult{Decision: decision, Applied: true}, nil
	}
	if err := c.applyAction(ctx, statefulSet, decision.Action, state); err != nil {
		return ReconcileResult{Decision: decision}, err
	}
	return ReconcileResult{Decision: decision, Applied: true}, nil
}

func (c *Controller) snapshot(ctx context.Context, statefulSet *appsv1.StatefulSet) (Snapshot, error) {
	now := time.Now().UTC()
	if c.Now != nil {
		now = c.Now().UTC()
	}
	hpa, err := c.Kubernetes.AutoscalingV2().HorizontalPodAutoscalers(c.Config.Namespace).Get(
		ctx, c.Config.HPAName, metav1.GetOptions{},
	)
	if err != nil {
		return Snapshot{}, fmt.Errorf("get runtime HPA: %w", err)
	}
	pods, err := c.Kubernetes.CoreV1().Pods(c.Config.Namespace).List(
		ctx, metav1.ListOptions{LabelSelector: c.Config.PodSelector},
	)
	if err != nil {
		return Snapshot{}, fmt.Errorf("list runtime Hosts: %w", err)
	}
	nodeZones := make(map[string]string)
	if c.Config.RequiredZones > 0 {
		nodes, err := c.Kubernetes.CoreV1().Nodes().List(ctx, metav1.ListOptions{})
		if err != nil {
			return Snapshot{}, fmt.Errorf("list runtime Host Nodes: %w", err)
		}
		for index := range nodes.Items {
			node := &nodes.Items[index]
			nodeZones[node.Name] = node.Labels[c.Config.TopologyKey]
		}
	}
	hosts := make([]Host, len(pods.Items))
	readyIndexes := make([]int, 0, len(pods.Items))
	for index := range pods.Items {
		pod := &pods.Items[index]
		ordinal, err := statefulOrdinal(c.Config.StatefulSetName, pod.Name)
		if err != nil {
			return Snapshot{}, err
		}
		zone := ""
		if c.Config.RequiredZones > 0 && pod.Spec.NodeName != "" {
			zone = nodeZones[pod.Spec.NodeName]
		}
		// Kubernetes closes the management listener before removing the Pod
		// object. Preserve its identity for the pure state machine, but do not
		// turn the expected Terminating window into a failed HTTP observation.
		if pod.DeletionTimestamp != nil {
			hosts[index] = Host{
				Name: pod.Name, UID: string(pod.UID), Ordinal: ordinal, Zone: zone,
				Terminating: true, ObservedAt: now,
			}
			continue
		}
		// A Pending or otherwise unready StatefulSet Pod has no trustworthy
		// management observation yet. Keep its UID and ordinal in the snapshot
		// so the state machine sees the full desired topology, but do not try an
		// HTTP request to an empty/stale PodIP. The incomplete Host evidence
		// blocks scale-in fail-closed.
		if !podReady(pod) || net.ParseIP(pod.Status.PodIP) == nil {
			hosts[index] = Host{
				Name: pod.Name, UID: string(pod.UID), Ordinal: ordinal, Zone: zone,
				ObservedAt: now,
			}
			continue
		}
		hosts[index] = Host{Name: pod.Name, UID: string(pod.UID), Ordinal: ordinal, Zone: zone}
		readyIndexes = append(readyIndexes, index)
	}
	observationContext, cancelObservations := context.WithCancel(ctx)
	defer cancelObservations()
	jobs := make(chan int)
	errChannel := make(chan error, 1)
	workers := hostObservationWorkers
	if len(readyIndexes) < workers {
		workers = len(readyIndexes)
	}
	var wait sync.WaitGroup
	for worker := 0; worker < workers; worker++ {
		wait.Add(1)
		go func() {
			defer wait.Done()
			for index := range jobs {
				pod := &pods.Items[index]
				stats, err := c.readHostStats(observationContext, pod)
				if err == nil && (stats.HostActiveActors == nil || stats.HostMaxActiveActors == nil ||
					stats.HostDraining == nil || stats.HostAcceptingActors == nil || stats.WorkerdAdmission == nil) {
					err = fmt.Errorf("Host %s returned incomplete drain evidence", pod.Name)
				}
				if err != nil {
					select {
					case errChannel <- fmt.Errorf("read Host %s stats: %w", pod.Name, err):
						cancelObservations()
					default:
					}
					continue
				}
				hosts[index].Ready = true
				hosts[index].Draining = *stats.HostDraining
				hosts[index].Accepting = *stats.HostAcceptingActors
				hosts[index].Quiescent = stats.Quiescent
				hosts[index].ActiveActors = *stats.HostActiveActors
				hosts[index].Capacity = *stats.HostMaxActiveActors
				hosts[index].RequestCapacity = stats.WorkerdAdmission.MaxInFlight
				hosts[index].InFlight = stats.WorkerdAdmission.InFlight
				hosts[index].Queued = stats.WorkerdAdmission.Queued
				hosts[index].ObservedAt = now
			}
		}()
	}
sendObservations:
	for _, index := range readyIndexes {
		select {
		case jobs <- index:
		case <-observationContext.Done():
			break sendObservations
		}
	}
	close(jobs)
	wait.Wait()
	select {
	case err := <-errChannel:
		return Snapshot{}, err
	default:
	}
	replicas := int32(1)
	if statefulSet.Spec.Replicas != nil {
		replicas = *statefulSet.Spec.Replicas
	}
	var activeActors int64
	for _, host := range hosts {
		var ok bool
		activeActors, ok = checkedAdd(activeActors, host.ActiveActors)
		if !ok {
			return Snapshot{}, fmt.Errorf("aggregate Host active actors overflowed")
		}
	}
	demandRising, scaleUpPending, err := autoscalerScaleSignals(
		hpa, statefulSet, c.Config.MinReplicas, activeActors,
	)
	if err != nil {
		return Snapshot{}, fmt.Errorf("validate runtime HPA: %w", err)
	}
	return Snapshot{
		Now: now, WorkloadUID: string(statefulSet.UID), Replicas: replicas,
		ReadyReplicas: statefulSet.Status.ReadyReplicas, MinReplicas: c.Config.MinReplicas,
		MaxRemainingUsagePct:   c.Config.MaxRemainingUsagePct,
		MetricsFreshness:       c.Config.MetricsFreshness,
		ScaleDownStabilization: c.Config.ScaleDownStabilization,
		DrainTimeout:           c.Config.DrainTimeout,
		DemandRising:           demandRising,
		ScaleUpPending:         scaleUpPending,
		RequiredZones:          c.Config.RequiredZones,
		TopologyMaxSkew:        c.Config.TopologyMaxSkew,
		Hosts:                  hosts,
	}, nil
}

func autoscalerScaleSignals(hpa *autoscalingv2.HorizontalPodAutoscaler, statefulSet *appsv1.StatefulSet, minReplicas int32, activeActors int64) (bool, bool, error) {
	if hpa == nil || statefulSet == nil {
		return false, true, fmt.Errorf("HPA or StatefulSet is missing")
	}
	if hpa.Spec.ScaleTargetRef.APIVersion != "apps/v1" || hpa.Spec.ScaleTargetRef.Kind != "StatefulSet" ||
		hpa.Spec.ScaleTargetRef.Name != statefulSet.Name {
		return false, true, fmt.Errorf("HPA scale target does not match runtime StatefulSet")
	}
	if hpa.Spec.MinReplicas == nil || *hpa.Spec.MinReplicas != minReplicas {
		return false, true, fmt.Errorf("HPA minReplicas does not match Host drain baseline")
	}
	conditions := make(map[autoscalingv2.HorizontalPodAutoscalerConditionType]corev1.ConditionStatus, len(hpa.Status.Conditions))
	for _, condition := range hpa.Status.Conditions {
		conditions[condition.Type] = condition.Status
	}
	for _, required := range []autoscalingv2.HorizontalPodAutoscalerConditionType{
		autoscalingv2.AbleToScale, autoscalingv2.ScalingActive,
	} {
		if conditions[required] != corev1.ConditionTrue {
			return false, true, fmt.Errorf("HPA condition %s is not True", required)
		}
	}
	replicas := int32(1)
	if statefulSet.Spec.Replicas != nil {
		replicas = *statefulSet.Spec.Replicas
	}
	if replicas < minReplicas || hpa.Status.CurrentReplicas < 1 || hpa.Status.DesiredReplicas < minReplicas {
		return false, true, fmt.Errorf("HPA replica status is outside the configured envelope")
	}
	if activeActors < 0 {
		return false, true, fmt.Errorf("active actor count is negative")
	}
	if hpa.Spec.MaxReplicas < minReplicas {
		return false, true, fmt.Errorf("HPA maxReplicas is below the Host drain baseline")
	}
	if len(hpa.Spec.Metrics) != 1 || hpa.Spec.Metrics[0].Type != autoscalingv2.ExternalMetricSourceType ||
		hpa.Spec.Metrics[0].External == nil || hpa.Spec.Metrics[0].External.Target.Type != autoscalingv2.AverageValueMetricType ||
		hpa.Spec.Metrics[0].External.Target.AverageValue == nil {
		return false, true, fmt.Errorf("HPA must have exactly one External AverageValue metric")
	}
	targetMilli := hpa.Spec.Metrics[0].External.Target.AverageValue.MilliValue()
	if targetMilli <= 0 || targetMilli%1000 != 0 {
		return false, true, fmt.Errorf("HPA average target must be a positive whole actor count")
	}
	target := targetMilli / 1000
	recommended := minReplicas
	if activeActors > 0 {
		required := (activeActors-1)/target + 1
		if required > int64(hpa.Spec.MaxReplicas) {
			required = int64(hpa.Spec.MaxReplicas)
		}
		if required > int64(recommended) {
			recommended = int32(required)
		}
	}
	// With HPA scale-down disabled, status.desiredReplicas is policy-clamped
	// to the current replica count and cannot authorize a drain. Reconstruct
	// the raw capacity recommendation from the same immutable HPA target and
	// authoritative per-Host actor counters. HPA status remains an additional
	// one-way expansion fence, never an authorization to shrink.
	// currentReplicas and desiredReplicas advance together after HPA observes a
	// completed manual contraction.  While both still describe the larger old
	// shape, their values are stale rather than an expansion request.  A desired
	// value above the StatefulSet is authoritative only once HPA current has
	// caught up to (or fallen below) the live shape.  The independently rebuilt
	// recommendation remains authoritative throughout.
	hpaRequestsExpansion := hpa.Status.DesiredReplicas > replicas && hpa.Status.CurrentReplicas <= replicas
	demandRising := recommended > replicas || hpaRequestsExpansion
	// HPA status is observational and can lag a completed manual contraction by
	// one reconciliation cycle.  currentReplicas > replicas therefore describes
	// the Host that just disappeared; it is not evidence of pending expansion.
	// The inverse is fail-closed because Kubernetes has not yet supplied all of
	// the replicas requested by the StatefulSet.  An explicit HPA desire above
	// the current shape remains an unconditional expansion fence.
	scaleUpPending := hpa.Status.CurrentReplicas < replicas || recommended >= replicas || hpaRequestsExpansion
	return demandRising, scaleUpPending, nil
}

func (c *Controller) readHostStats(ctx context.Context, pod *corev1.Pod) (hostStats, error) {
	address, err := managementAddress(pod.Status.PodIP, c.Config.ManagementPort, "/v1/sqlite/stats")
	if err != nil {
		return hostStats{}, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, address, nil)
	if err != nil {
		return hostStats{}, err
	}
	request.Header.Set("x-rivet-workerd-token", c.Config.Token)
	response, err := c.httpClient().Do(request)
	if err != nil {
		return hostStats{}, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return hostStats{}, fmt.Errorf("management endpoint returned HTTP %d", response.StatusCode)
	}
	payload, err := io.ReadAll(io.LimitReader(response.Body, 64*1024+1))
	if err != nil {
		return hostStats{}, fmt.Errorf("read management stats: %w", err)
	}
	if len(payload) > 64*1024 {
		return hostStats{}, fmt.Errorf("management stats exceeded 64 KiB")
	}
	var stats hostStats
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&stats); err != nil {
		return hostStats{}, fmt.Errorf("decode management stats: %w", err)
	}
	if err := requireJSONEOF(decoder); err != nil {
		return hostStats{}, fmt.Errorf("decode management stats: %w", err)
	}
	return stats, nil
}

func requireJSONEOF(decoder *json.Decoder) error {
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		if err == nil {
			return fmt.Errorf("unexpected trailing JSON value")
		}
		return fmt.Errorf("unexpected trailing data: %w", err)
	}
	return nil
}

func (c *Controller) applyAction(ctx context.Context, statefulSet *appsv1.StatefulSet, action Action, previous State) error {
	switch action.Kind {
	case ActionSetDraining:
		pod, err := c.Kubernetes.CoreV1().Pods(c.Config.Namespace).Get(ctx, action.TargetName, metav1.GetOptions{})
		if err != nil {
			return fmt.Errorf("get drain target: %w", err)
		}
		if string(pod.UID) != action.TargetUID {
			return fmt.Errorf("drain target UID changed before action")
		}
		return c.setHostDraining(ctx, pod, action.Draining)
	case ActionSetReplicas:
		return c.setReplicas(ctx, statefulSet.Name, statefulSet.UID, previous.FromReplicas, action.Replicas)
	default:
		return fmt.Errorf("unsupported Host drain action %q", action.Kind)
	}
}

func (c *Controller) setHostDraining(ctx context.Context, pod *corev1.Pod, draining bool) error {
	address, err := managementAddress(pod.Status.PodIP, c.Config.ManagementPort, "/v1/sqlite/drain")
	if err != nil {
		return err
	}
	body, _ := json.Marshal(map[string]bool{"draining": draining})
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, address, bytes.NewReader(body))
	if err != nil {
		return err
	}
	request.Header.Set("content-type", "application/json")
	request.Header.Set("x-rivet-workerd-token", c.Config.Token)
	response, err := c.httpClient().Do(request)
	if err != nil {
		return fmt.Errorf("set Host draining=%t: %w", draining, err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		message, _ := io.ReadAll(io.LimitReader(response.Body, 4*1024))
		return fmt.Errorf("set Host draining=%t returned HTTP %d: %s", draining, response.StatusCode, strings.TrimSpace(string(message)))
	}
	return nil
}

func (c *Controller) persistState(ctx context.Context, statefulSet *appsv1.StatefulSet, state State) error {
	encoded, err := json.Marshal(state)
	if err != nil {
		return err
	}
	path := "/metadata/annotations/" + escapeJSONPointer(StateAnnotation)
	operations := []map[string]any{{"op": "test", "path": "/metadata/resourceVersion", "value": statefulSet.ResourceVersion}}
	if statefulSet.Annotations == nil {
		operations = append(operations, map[string]any{"op": "add", "path": "/metadata/annotations", "value": map[string]string{StateAnnotation: string(encoded)}})
	} else {
		operations = append(operations, map[string]any{"op": "add", "path": path, "value": string(encoded)})
	}
	payload, _ := json.Marshal(operations)
	_, err = c.Kubernetes.AppsV1().StatefulSets(c.Config.Namespace).Patch(
		ctx, statefulSet.Name, types.JSONPatchType, payload, metav1.PatchOptions{},
	)
	return err
}

func (c *Controller) setReplicas(ctx context.Context, name string, uid types.UID, from, to int32) error {
	operations := []map[string]any{
		{"op": "test", "path": "/metadata/uid", "value": string(uid)},
		{"op": "test", "path": "/spec/replicas", "value": from},
		{"op": "replace", "path": "/spec/replicas", "value": to},
	}
	payload, _ := json.Marshal(operations)
	_, err := c.Kubernetes.AppsV1().StatefulSets(c.Config.Namespace).Patch(
		ctx, name, types.JSONPatchType, payload, metav1.PatchOptions{},
	)
	if err != nil {
		return fmt.Errorf("scale StatefulSet from %d to %d: %w", from, to, err)
	}
	return nil
}

func (c *Controller) validate() error {
	if c.Kubernetes == nil || c.Config.Namespace == "" || c.Config.CellName == "" ||
		c.Config.StatefulSetName == "" || c.Config.HPAName == "" || c.Config.PodSelector == "" {
		return fmt.Errorf("Host drain controller Kubernetes identity is incomplete")
	}
	if len(c.Config.Token) < 16 {
		return fmt.Errorf("Host drain controller token is missing or too short")
	}
	if c.Config.ManagementPort < 1 || c.Config.ManagementPort > 65535 {
		return fmt.Errorf("Host drain management port is invalid")
	}
	if c.Config.MinReplicas < 1 {
		return fmt.Errorf("Host drain minReplicas must be positive")
	}
	if c.Config.MaxRemainingUsagePct < 1 || c.Config.MaxRemainingUsagePct > 100 {
		return fmt.Errorf("Host drain max remaining usage must be between 1 and 100 percent")
	}
	if c.Config.TopologyKey != "" || c.Config.RequiredZones != 0 || c.Config.TopologyMaxSkew != 0 {
		if c.Config.TopologyKey == "" || c.Config.RequiredZones < 1 || c.Config.TopologyMaxSkew < 1 {
			return fmt.Errorf("Host drain topology policy is incomplete")
		}
	}
	return nil
}

func decodeState(raw string) (State, error) {
	if raw == "" {
		return State{Phase: PhaseIdle}, nil
	}
	var state State
	decoder := json.NewDecoder(io.LimitReader(strings.NewReader(raw), 16*1024))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&state); err != nil {
		return State{}, fmt.Errorf("decode %s: %w", StateAnnotation, err)
	}
	if err := validateState(state); err != nil {
		return State{}, fmt.Errorf("validate %s: %w", StateAnnotation, err)
	}
	return state, nil
}

func decodeReleaseHold(raw, workloadUID string) (*releaseHold, error) {
	if raw == "" {
		return nil, nil
	}
	var hold releaseHold
	decoder := json.NewDecoder(io.LimitReader(strings.NewReader(raw), 4*1024))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&hold); err != nil {
		return nil, fmt.Errorf("decode %s: %w", ReleaseHoldAnnotation, err)
	}
	if err := requireJSONEOF(decoder); err != nil {
		return nil, fmt.Errorf("decode %s: %w", ReleaseHoldAnnotation, err)
	}
	if len(hold.ID) < 16 || len(hold.ID) > 128 {
		return nil, fmt.Errorf("validate %s: release ID length is invalid", ReleaseHoldAnnotation)
	}
	for _, character := range hold.ID {
		if !((character >= 'a' && character <= 'z') || (character >= '0' && character <= '9') || character == '-') {
			return nil, fmt.Errorf("validate %s: release ID contains an invalid character", ReleaseHoldAnnotation)
		}
	}
	if workloadUID == "" || hold.WorkloadUID != workloadUID {
		return nil, fmt.Errorf("validate %s: workload UID mismatch", ReleaseHoldAnnotation)
	}
	if hold.AcquiredAt.IsZero() {
		return nil, fmt.Errorf("validate %s: acquired_at is missing", ReleaseHoldAnnotation)
	}
	return &hold, nil
}

func statefulOrdinal(statefulSet, pod string) (int32, error) {
	prefix := statefulSet + "-"
	if !strings.HasPrefix(pod, prefix) {
		return 0, fmt.Errorf("Pod %q is not owned by StatefulSet %q", pod, statefulSet)
	}
	ordinal, err := strconv.ParseInt(strings.TrimPrefix(pod, prefix), 10, 32)
	if err != nil || ordinal < 0 {
		return 0, fmt.Errorf("Pod %q has an invalid StatefulSet ordinal", pod)
	}
	return int32(ordinal), nil
}

func managementAddress(podIP string, port int, path string) (string, error) {
	if net.ParseIP(podIP) == nil {
		return "", fmt.Errorf("Host Pod IP %q is invalid", podIP)
	}
	return "http://" + net.JoinHostPort(podIP, strconv.Itoa(port)) + path, nil
}

func podReady(pod *corev1.Pod) bool {
	for _, condition := range pod.Status.Conditions {
		if condition.Type == corev1.PodReady {
			return condition.Status == corev1.ConditionTrue
		}
	}
	return false
}

func escapeJSONPointer(value string) string {
	return strings.ReplaceAll(strings.ReplaceAll(value, "~", "~0"), "/", "~1")
}

func (c *Controller) httpClient() *http.Client {
	if c.HTTPClient != nil {
		return c.HTTPClient
	}
	return &http.Client{Timeout: 2 * time.Second}
}

func (c *Controller) logf(format string, values ...any) {
	if c.Logf != nil {
		c.Logf(format, values...)
	}
}
