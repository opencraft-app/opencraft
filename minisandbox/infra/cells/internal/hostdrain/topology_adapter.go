package hostdrain

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	policyv1 "k8s.io/api/policy/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
)

const EvictionCancellationAnnotation = "fleet.actor.dev/host-eviction-cancelled"

func (c *Controller) pendingCancellation(ctx context.Context, workload *appsv1.StatefulSet, state State) (*Decision, error) {
	if state.Phase != PhaseRebalanceCancelling {
		return nil, nil
	}
	snapshot := Snapshot{Now: c.now(), WorkloadUID: string(workload.UID)}
	if workload.Spec.Replicas != nil {
		snapshot.Replicas = *workload.Spec.Replicas
	}
	pod, err := c.Kubernetes.CoreV1().Pods(c.Config.Namespace).Get(ctx, state.TargetName, metav1.GetOptions{})
	if err != nil && !apierrors.IsNotFound(err) {
		return nil, fmt.Errorf("read eviction cancellation target: %w", err)
	}
	if err == nil {
		if err := validateHostOwner(pod, workload); err != nil {
			return nil, err
		}
		if evictionCancellationObserved(state, pod) {
			return nil, nil
		}
		snapshot.Hosts = []Host{{Name: pod.Name, UID: string(pod.UID), ResourceVersion: pod.ResourceVersion, Terminating: pod.DeletionTimestamp != nil}}
	}
	decision := Decide(state, snapshot)
	return &decision, nil
}

// cancellationToken is proof of our metadata CAS, not of an arbitrary observed
// RV change. Eviction itself may first change RV by writing DisruptionTarget.
func cancellationToken(state State) string {
	if state.RepairWorkloadUID == "" || state.TargetUID == "" || state.Epoch < 1 || state.EvictionResourceVersion == "" {
		return ""
	}
	payload, _ := json.Marshal([]any{
		state.RepairWorkloadUID, state.TargetUID, state.Epoch, state.EvictionResourceVersion,
	})
	digest := sha256.Sum256(payload)
	return hex.EncodeToString(digest[:])
}

func evictionCancellationObserved(state State, pod *corev1.Pod) bool {
	token := cancellationToken(state)
	return token != "" && pod != nil && pod.DeletionTimestamp == nil &&
		pod.Name == state.TargetName && string(pod.UID) == state.TargetUID &&
		pod.ResourceVersion != "" && pod.ResourceVersion != state.EvictionResourceVersion &&
		pod.Annotations[EvictionCancellationAnnotation] == token
}

func validateHostOwner(pod *corev1.Pod, workload *appsv1.StatefulSet) error {
	if pod == nil || workload == nil || workload.UID == "" || pod.UID == "" || pod.Namespace != workload.Namespace {
		return fmt.Errorf("Host workload or Pod identity is incomplete")
	}
	owner := metav1.GetControllerOf(pod)
	if owner == nil || owner.APIVersion != "apps/v1" || owner.Kind != "StatefulSet" ||
		owner.Name != workload.Name || owner.UID != workload.UID {
		return fmt.Errorf("Host %s controller owner does not match workload UID", pod.Name)
	}
	if _, err := statefulOrdinal(workload.Name, pod.Name); err != nil {
		return err
	}
	return nil
}

func validateHostStats(stats hostStats) error {
	if stats.HostActiveActors == nil || stats.HostMaxActiveActors == nil || stats.HostDraining == nil ||
		stats.HostAcceptingActors == nil || stats.WorkerdAdmission == nil {
		return fmt.Errorf("Host returned incomplete drain evidence")
	}
	if *stats.HostActiveActors < 0 || *stats.HostMaxActiveActors <= 0 ||
		*stats.HostActiveActors > *stats.HostMaxActiveActors || stats.BridgeActiveActors < 0 ||
		stats.WorkerdAdmission.MaxInFlight <= 0 || stats.WorkerdAdmission.InFlight < 0 ||
		stats.WorkerdAdmission.InFlight > stats.WorkerdAdmission.MaxInFlight || stats.WorkerdAdmission.Queued < 0 {
		return fmt.Errorf("Host returned invalid drain counters")
	}
	return nil
}

// checkActionState re-reads durable ownership after persisting a decision. A
// concurrent reconciler, release hold or recreated workload cannot authorize an
// old action. Cross-object observation is not a transaction: Pod UID/RV CAS is
// still mandatory at the actual destructive boundary.
func (c *Controller) checkActionState(ctx context.Context, original *appsv1.StatefulSet, expected State) (*appsv1.StatefulSet, error) {
	live, err := c.Kubernetes.AppsV1().StatefulSets(c.Config.Namespace).Get(ctx, original.Name, metav1.GetOptions{})
	if err != nil {
		return nil, fmt.Errorf("re-read action workload: %w", err)
	}
	if original.UID == "" || live.UID != original.UID || live.ResourceVersion == "" || live.DeletionTimestamp != nil {
		return nil, fmt.Errorf("action workload identity changed or is terminating")
	}
	state, err := decodeState(live.Annotations[StateAnnotation])
	if err != nil {
		return nil, err
	}
	if state != expected || (expected.RepairWorkloadUID != "" && expected.RepairWorkloadUID != string(live.UID)) {
		return nil, fmt.Errorf("persisted action authority changed")
	}
	hold, err := decodeReleaseHold(live.Annotations[ReleaseHoldAnnotation], string(live.UID))
	if err != nil {
		return nil, err
	}
	if hold != nil {
		return nil, fmt.Errorf("runtime release hold blocks Host action")
	}
	return live, nil
}

func (c *Controller) actionPod(ctx context.Context, workload *appsv1.StatefulSet, action Action, state State) (*corev1.Pod, error) {
	if action.TargetName != state.TargetName || action.TargetUID != state.TargetUID {
		return nil, fmt.Errorf("action does not name the persisted target")
	}
	pod, err := c.Kubernetes.CoreV1().Pods(c.Config.Namespace).Get(ctx, action.TargetName, metav1.GetOptions{})
	if err != nil {
		return nil, fmt.Errorf("get Host action target: %w", err)
	}
	if err := validateHostOwner(pod, workload); err != nil {
		return nil, err
	}
	if string(pod.UID) != action.TargetUID || pod.ResourceVersion == "" || pod.DeletionTimestamp != nil {
		return nil, fmt.Errorf("Host action identity changed or is terminating")
	}
	return pod, nil
}

func (c *Controller) applyAction(ctx context.Context, original *appsv1.StatefulSet, action Action, authorized State) error {
	live, err := c.checkActionState(ctx, original, authorized)
	if err != nil {
		return err
	}
	// Cancellation requires only exact Kubernetes identity/CAS. A failed Host
	// management listener must not prevent invalidating an in-flight eviction.
	if action.Kind == ActionCancelEviction {
		pod, err := c.actionPod(ctx, live, action, authorized)
		if err != nil {
			return err
		}
		return c.cancelEviction(ctx, pod, action, authorized)
	}
	snapshot, err := c.snapshot(ctx, live)
	if err != nil {
		return fmt.Errorf("refresh Host action evidence: %w", err)
	}
	decision := Decide(authorized, snapshot)
	if decision.Action != action {
		return fmt.Errorf("fresh evidence no longer authorizes Host action: %s", decision.Reason)
	}
	latest, err := c.checkActionState(ctx, live, authorized)
	if err != nil {
		return err
	}
	if latest.ResourceVersion != live.ResourceVersion {
		return fmt.Errorf("workload changed during action observation")
	}
	switch action.Kind {
	case ActionSetReplicas:
		return c.setReplicas(ctx, latest, authorized, action.Replicas)
	case ActionSetDraining, ActionEvictHost:
		pod, err := c.actionPod(ctx, latest, action, authorized)
		if err != nil {
			return err
		}
		if action.Kind == ActionEvictHost {
			return c.evictHost(ctx, pod, authorized)
		}
		if !podReady(pod) {
			return fmt.Errorf("Host is not Ready for placement mutation")
		}
		if !action.Draining && authorized.EvictionResourceVersion != "" && !evictionCancellationObserved(authorized, pod) {
			return fmt.Errorf("cannot restore placement without exact eviction cancellation proof")
		}
		return c.setHostDraining(ctx, pod, action.Draining)
	default:
		return fmt.Errorf("unsupported Host drain action %q", action.Kind)
	}
}

func (c *Controller) evictHost(ctx context.Context, pod *corev1.Pod, state State) error {
	if state.Phase != PhaseRebalanceEvicting || state.RepairWorkloadUID == "" || state.EvictionResourceVersion == "" ||
		pod.Name != state.TargetName || string(pod.UID) != state.TargetUID ||
		pod.ResourceVersion != state.EvictionResourceVersion || pod.DeletionTimestamp != nil || !podReady(pod) {
		return fmt.Errorf("eviction does not match exact persisted Pod authority")
	}
	if err := c.checkEvictionDeadline(state); err != nil {
		return err
	}
	stats, err := c.readHostStats(ctx, pod)
	if err != nil {
		return err
	}
	if err := validateHostStats(stats); err != nil {
		return err
	}
	if !*stats.HostDraining || *stats.HostAcceptingActors || !stats.Quiescent || *stats.HostActiveActors != 0 ||
		stats.BridgeActiveActors != 0 || stats.WorkerdAdmission.InFlight != 0 || stats.WorkerdAdmission.Queued != 0 {
		return fmt.Errorf("eviction requires exact fresh fenced quiescence")
	}
	if err := c.checkEvictionDeadline(state); err != nil {
		return err
	}
	uid, rv := pod.UID, state.EvictionResourceVersion
	eviction := &policyv1.Eviction{
		ObjectMeta:    metav1.ObjectMeta{Name: pod.Name, Namespace: pod.Namespace},
		DeleteOptions: &metav1.DeleteOptions{Preconditions: &metav1.Preconditions{UID: &uid, ResourceVersion: &rv}},
	}
	// Keep the configured termination grace and let the API enforce the PDB.
	// 429, conflict and indeterminate responses never fall back to Pod Delete.
	callCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if err := c.Kubernetes.CoreV1().Pods(pod.Namespace).EvictV1(callCtx, eviction); err != nil {
		return fmt.Errorf("request exact Host eviction: %w", err)
	}
	return nil
}

func (c *Controller) checkEvictionDeadline(state State) error {
	timeout := c.Config.DrainTimeout
	if timeout <= 0 {
		timeout = 10 * time.Minute
	}
	now := c.now()
	if state.StartedAt.IsZero() || now.Before(state.StartedAt) || now.Sub(state.StartedAt) >= timeout {
		return fmt.Errorf("eviction deadline expired or start time is invalid")
	}
	return nil
}

func (c *Controller) cancelEviction(ctx context.Context, pod *corev1.Pod, action Action, state State) error {
	if state.Phase != PhaseRebalanceCancelling || cancellationToken(state) == "" ||
		pod.Name != state.TargetName || string(pod.UID) != state.TargetUID || pod.ResourceVersion == "" ||
		pod.ResourceVersion != action.ResourceVersion || pod.DeletionTimestamp != nil {
		return fmt.Errorf("eviction cancellation lacks exact persisted authority")
	}
	if evictionCancellationObserved(state, pod) {
		return nil
	}
	operations := []map[string]any{
		{"op": "test", "path": "/metadata/uid", "value": string(pod.UID)},
		{"op": "test", "path": "/metadata/resourceVersion", "value": pod.ResourceVersion},
	}
	token := cancellationToken(state)
	if pod.Annotations == nil {
		operations = append(operations, map[string]any{"op": "add", "path": "/metadata/annotations", "value": map[string]string{EvictionCancellationAnnotation: token}})
	} else {
		operations = append(operations, map[string]any{"op": "add", "path": "/metadata/annotations/" + escapeJSONPointer(EvictionCancellationAnnotation), "value": token})
	}
	payload, _ := json.Marshal(operations)
	callCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if _, err := c.Kubernetes.CoreV1().Pods(pod.Namespace).Patch(callCtx, pod.Name, types.JSONPatchType, payload, metav1.PatchOptions{}); err != nil {
		return fmt.Errorf("CAS Host eviction cancellation: %w", err)
	}
	// Never unfence in this call. The next authoritative Pod GET must observe
	// our exact token. If deletion won or the response was lost, recovery uses
	// the persisted cancelling phase instead of guessing the outcome.
	return nil
}
