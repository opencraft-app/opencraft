package runtimecapacity

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
	"time"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	policyv1 "k8s.io/api/policy/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/fields"
	"k8s.io/apimachinery/pkg/types"
)

const repairDrainStateSchema = "rivet-runtime-machine-repair-drain/v1"

type repairDrainState struct {
	Schema     string    `json:"schema"`
	NodeUID    string    `json:"node_uid"`
	MachineUID string    `json:"machine_uid"`
	AttemptUID string    `json:"attempt_uid"`
	StartedAt  time.Time `json:"started_at"`
}

type repairHostStats struct {
	HostActiveActors    *int64                       `json:"host_active_actors"`
	HostMaxActiveActors *int64                       `json:"host_max_active_actors"`
	HostDraining        *bool                        `json:"host_draining"`
	HostAcceptingActors *bool                        `json:"host_accepting_actors"`
	BridgeActiveActors  int64                        `json:"bridge_active_actors"`
	Quiescent           bool                         `json:"quiescent"`
	WorkerdAdmission    *repairWorkerdAdmissionStats `json:"workerd_admission"`
}

type repairWorkerdAdmissionStats struct {
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

// prepareQuarantinedHost is the complete workload-side boundary of an exact
// Machine repair. It never changes StatefulSet replicas. It first prevents new
// Actor placement through the Host's authenticated management endpoint, waits
// for durable Actors and in-flight requests to reach exact quiescence, and then
// submits a UID-preconditioned, PDB-respecting Pod eviction. Failure to prove
// quiescence never turns into a forced eviction: the Node stays fenced and its
// bounded repair surge stays alive for operator-visible recovery.
func (c *Controller) prepareQuarantinedHost(
	ctx context.Context,
	statefulSet *appsv1.StatefulSet,
	target quarantinedTarget,
) (bool, string, error) {
	pods, err := c.Kubernetes.CoreV1().Pods("").List(ctx, metav1.ListOptions{
		FieldSelector: fields.OneTermEqualSelector("spec.nodeName", target.node.Name).String(),
	})
	if err != nil {
		return false, "", fmt.Errorf("list runtime Host on quarantined Node: %w", err)
	}
	var host *corev1.Pod
	for index := range pods.Items {
		pod := &pods.Items[index]
		if pod.Spec.NodeName != target.node.Name {
			continue
		}
		if pod.Status.Phase == corev1.PodSucceeded || pod.Status.Phase == corev1.PodFailed ||
			pod.Annotations[corev1.MirrorPodAnnotationKey] != "" || ownedByDaemonSet(pod) {
			continue
		}
		if !exactRuntimeHostPod(pod, statefulSet, c.Config.CellName) {
			return false, "", fmt.Errorf("quarantined runtime Node %s owns foreign workload Pod %s/%s", target.node.Name, pod.Namespace, pod.Name)
		}
		if host != nil {
			return false, "", fmt.Errorf("quarantined runtime Node %s owns multiple runtime Hosts", target.node.Name)
		}
		host = pod.DeepCopy()
	}
	if host == nil {
		return true, "", nil
	}
	drainStartedAt, created, err := c.ensureRepairDrainState(ctx, target)
	if err != nil {
		return false, "", err
	}
	if created {
		return false, "start-quarantined-host-drain", nil
	}
	forceAfter := drainStartedAt.Add(c.Config.RepairDrainTimeout)
	if host.DeletionTimestamp != nil {
		if !c.now().Before(forceAfter) {
			return false, "quarantined-host-termination-timeout", nil
		}
		return false, "wait-quarantined-host-eviction", nil
	}

	stats, statsErr := c.readRepairHostStats(ctx, host)
	if statsErr != nil {
		if !c.now().Before(forceAfter) {
			return false, "quarantined-host-management-timeout", nil
		}
		return false, "wait-quarantined-host-management", nil
	}
	if err := validateRepairHostStats(stats); err != nil {
		return false, "", fmt.Errorf("validate quarantined Host stats: %w", err)
	}
	if !*stats.HostDraining || *stats.HostAcceptingActors {
		if err := c.setRepairHostDraining(ctx, host); err != nil {
			return false, "", err
		}
		return false, "fence-quarantined-host-placement", nil
	}
	if !stats.Quiescent || *stats.HostActiveActors != 0 || stats.BridgeActiveActors != 0 ||
		stats.WorkerdAdmission.InFlight != 0 || stats.WorkerdAdmission.Queued != 0 {
		if !c.now().Before(forceAfter) {
			return false, "quarantined-host-quiescence-timeout", nil
		}
		return false, "wait-quarantined-host-quiescence", nil
	}
	if err := c.evictExactRuntimeHost(ctx, host); err != nil {
		return false, "", err
	}
	return false, "evict-quiescent-quarantined-host", nil
}

func (c *Controller) ensureRepairDrainState(ctx context.Context, target quarantinedTarget) (time.Time, bool, error) {
	if raw := target.node.Annotations[RepairDrainStateAnnotation]; raw != "" {
		var state repairDrainState
		decoder := json.NewDecoder(strings.NewReader(raw))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&state); err != nil {
			return time.Time{}, false, fmt.Errorf("decode runtime Machine repair drain state: %w", err)
		}
		var trailing any
		if err := decoder.Decode(&trailing); err != io.EOF {
			return time.Time{}, false, fmt.Errorf("runtime Machine repair drain state contains trailing data")
		}
		if state.Schema != repairDrainStateSchema || state.NodeUID != string(target.node.UID) ||
			state.MachineUID != string(target.machine.GetUID()) || state.AttemptUID != target.state.AttemptUID ||
			state.StartedAt.IsZero() || state.StartedAt.After(c.now().Add(time.Minute)) {
			return time.Time{}, false, fmt.Errorf("runtime Machine repair drain identity is invalid")
		}
		return state.StartedAt.UTC(), false, nil
	}
	state := repairDrainState{
		Schema: repairDrainStateSchema, NodeUID: string(target.node.UID), MachineUID: string(target.machine.GetUID()),
		AttemptUID: target.state.AttemptUID, StartedAt: c.now(),
	}
	encoded, err := json.Marshal(state)
	if err != nil {
		return time.Time{}, false, err
	}
	operations := []map[string]any{
		{"op": "test", "path": "/metadata/uid", "value": string(target.node.UID)},
		{"op": "test", "path": "/metadata/resourceVersion", "value": target.node.ResourceVersion},
	}
	if len(target.node.Annotations) == 0 {
		operations = append(operations, map[string]any{
			"op": "add", "path": "/metadata/annotations", "value": map[string]string{RepairDrainStateAnnotation: string(encoded)},
		})
	} else {
		operations = append(operations, map[string]any{
			"op": "add", "path": "/metadata/annotations/" + escapeJSONPointer(RepairDrainStateAnnotation), "value": string(encoded),
		})
	}
	payload, err := json.Marshal(operations)
	if err != nil {
		return time.Time{}, false, err
	}
	if _, err := c.Kubernetes.CoreV1().Nodes().Patch(ctx, target.node.Name, types.JSONPatchType, payload, metav1.PatchOptions{}); err != nil {
		return time.Time{}, false, fmt.Errorf("persist runtime Machine repair drain identity: %w", err)
	}
	return state.StartedAt, true, nil
}

func exactRuntimeHostPod(pod *corev1.Pod, statefulSet *appsv1.StatefulSet, cell string) bool {
	if pod.Namespace != statefulSet.Namespace || pod.Labels["fleet.actor.dev/cell-name"] != cell ||
		pod.Labels["fleet.actor.dev/component"] != "workerd-host" {
		return false
	}
	for _, owner := range pod.OwnerReferences {
		if owner.Controller != nil && *owner.Controller && owner.Kind == "StatefulSet" &&
			owner.Name == statefulSet.Name && owner.UID == statefulSet.UID {
			return true
		}
	}
	return false
}

func (c *Controller) readRepairHostStats(ctx context.Context, pod *corev1.Pod) (repairHostStats, error) {
	token, err := c.runtimeAuthToken()
	if err != nil {
		return repairHostStats{}, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, c.repairManagementURL(pod, "/v1/sqlite/stats"), nil)
	if err != nil {
		return repairHostStats{}, err
	}
	request.Header.Set("x-rivet-workerd-token", token)
	response, err := c.httpClient().Do(request)
	if err != nil {
		return repairHostStats{}, fmt.Errorf("read quarantined Host management stats: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return repairHostStats{}, fmt.Errorf("quarantined Host management returned HTTP %d", response.StatusCode)
	}
	payload, err := io.ReadAll(io.LimitReader(response.Body, 64*1024+1))
	if err != nil {
		return repairHostStats{}, err
	}
	if len(payload) > 64*1024 {
		return repairHostStats{}, fmt.Errorf("quarantined Host management stats exceeded 64 KiB")
	}
	var stats repairHostStats
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&stats); err != nil {
		return repairHostStats{}, err
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		return repairHostStats{}, fmt.Errorf("quarantined Host management stats contain trailing data")
	}
	return stats, nil
}

func validateRepairHostStats(stats repairHostStats) error {
	if stats.HostActiveActors == nil || stats.HostMaxActiveActors == nil || stats.HostDraining == nil ||
		stats.HostAcceptingActors == nil || stats.WorkerdAdmission == nil {
		return fmt.Errorf("required counters are missing")
	}
	if *stats.HostActiveActors < 0 || *stats.HostMaxActiveActors <= 0 || *stats.HostActiveActors > *stats.HostMaxActiveActors ||
		stats.BridgeActiveActors < 0 || stats.WorkerdAdmission.InFlight < 0 || stats.WorkerdAdmission.Queued < 0 ||
		stats.WorkerdAdmission.PeakInFlight < 0 || stats.WorkerdAdmission.PeakQueued < 0 ||
		stats.WorkerdAdmission.QueuedTotal < 0 || stats.WorkerdAdmission.RejectedTotal < 0 ||
		stats.WorkerdAdmission.TimedOutTotal < 0 || stats.WorkerdAdmission.MaxInFlight <= 0 ||
		stats.WorkerdAdmission.MaxQueued < 0 || stats.WorkerdAdmission.QueueTimeoutMS < 0 ||
		stats.WorkerdAdmission.InFlight > stats.WorkerdAdmission.MaxInFlight ||
		stats.WorkerdAdmission.Queued > stats.WorkerdAdmission.MaxQueued {
		return fmt.Errorf("capacity counters are invalid")
	}
	return nil
}

func (c *Controller) setRepairHostDraining(ctx context.Context, pod *corev1.Pod) error {
	token, err := c.runtimeAuthToken()
	if err != nil {
		return err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, c.repairManagementURL(pod, "/v1/sqlite/drain"), strings.NewReader(`{"draining":true}`))
	if err != nil {
		return err
	}
	request.Header.Set("content-type", "application/json")
	request.Header.Set("x-rivet-workerd-token", token)
	response, err := c.httpClient().Do(request)
	if err != nil {
		return fmt.Errorf("fence quarantined Host placement: %w", err)
	}
	defer response.Body.Close()
	message, _ := io.ReadAll(io.LimitReader(response.Body, 4*1024+1))
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("fence quarantined Host placement returned HTTP %d: %s", response.StatusCode, strings.TrimSpace(string(message)))
	}
	return nil
}

func (c *Controller) runtimeAuthToken() (string, error) {
	token := c.Config.RuntimeAuthToken
	if len(token) != 64 {
		return "", fmt.Errorf("runtime Host authentication token has invalid length")
	}
	for _, character := range token {
		if !strings.ContainsRune("0123456789abcdef", character) {
			return "", fmt.Errorf("runtime Host authentication token is not lowercase hexadecimal")
		}
	}
	return token, nil
}

func (c *Controller) repairManagementURL(pod *corev1.Pod, path string) string {
	if net.ParseIP(pod.Status.PodIP) == nil {
		return "http://invalid.invalid" + path
	}
	return "http://" + net.JoinHostPort(pod.Status.PodIP, strconv.Itoa(c.Config.ManagementPort)) + path
}

func (c *Controller) evictExactRuntimeHost(ctx context.Context, pod *corev1.Pod) error {
	uid := pod.UID
	eviction := &policyv1.Eviction{
		ObjectMeta:    metav1.ObjectMeta{Name: pod.Name, Namespace: pod.Namespace},
		DeleteOptions: &metav1.DeleteOptions{Preconditions: &metav1.Preconditions{UID: &uid}},
	}
	if err := c.Kubernetes.PolicyV1().Evictions(pod.Namespace).Evict(ctx, eviction); err != nil && !apierrors.IsNotFound(err) {
		return fmt.Errorf("evict exact quarantined runtime Host %s/%s: %w", pod.Namespace, pod.Name, err)
	}
	return nil
}

func (c *Controller) httpClient() *http.Client {
	if c.HTTPClient != nil {
		return c.HTTPClient
	}
	return &http.Client{Timeout: 3 * time.Second}
}

func exactQuarantinedTarget(current []quarantinedTarget, expected quarantinedTarget) (quarantinedTarget, bool) {
	for _, target := range current {
		if target.node.UID == expected.node.UID && target.machine.GetUID() == expected.machine.GetUID() {
			return target, true
		}
	}
	return quarantinedTarget{}, false
}

func (c *Controller) requireReplacementHostsReady(
	ctx context.Context,
	statefulSet *appsv1.StatefulSet,
	desiredHosts int64,
	usableNodeUIDs map[string]string,
) error {
	pods, err := c.Kubernetes.CoreV1().Pods(c.Config.Namespace).List(ctx, metav1.ListOptions{
		LabelSelector: "fleet.actor.dev/cell-name=" + c.Config.CellName + ",fleet.actor.dev/component=workerd-host",
	})
	if err != nil {
		return fmt.Errorf("list replacement runtime Hosts: %w", err)
	}
	var ready int64
	var live int64
	seenNodes := make(map[string]struct{}, desiredHosts)
	for index := range pods.Items {
		pod := &pods.Items[index]
		if pod.DeletionTimestamp != nil || pod.Status.Phase == corev1.PodSucceeded || pod.Status.Phase == corev1.PodFailed {
			continue
		}
		live++
		if !exactRuntimeHostPod(pod, statefulSet, c.Config.CellName) {
			return fmt.Errorf("runtime Host %s/%s has unexpected ownership", pod.Namespace, pod.Name)
		}
		_, usable := usableNodeUIDs[pod.Spec.NodeName]
		if !usable || pod.Spec.NodeName == "" {
			return fmt.Errorf("runtime Host %s/%s is not bound to exact admitted capacity", pod.Namespace, pod.Name)
		}
		if _, duplicate := seenNodes[pod.Spec.NodeName]; duplicate {
			return fmt.Errorf("multiple runtime Hosts are bound to admitted Node %s", pod.Spec.NodeName)
		}
		seenNodes[pod.Spec.NodeName] = struct{}{}
		if podReady(pod) {
			ready++
		}
	}
	if live != desiredHosts || ready != desiredHosts {
		return fmt.Errorf("runtime Host inventory live=%d ready=%d does not match desired capacity %d", live, ready, desiredHosts)
	}
	return nil
}

func podReady(pod *corev1.Pod) bool {
	if pod.Status.Phase != corev1.PodRunning {
		return false
	}
	for _, condition := range pod.Status.Conditions {
		if condition.Type == corev1.PodReady {
			return condition.Status == corev1.ConditionTrue
		}
	}
	return false
}
