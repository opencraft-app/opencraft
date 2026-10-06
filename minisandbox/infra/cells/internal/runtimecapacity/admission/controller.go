package admission

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
)

var (
	machineSetResource   = schema.GroupVersionResource{Group: "node.tke.cloud.tencent.com", Version: "v1beta1", Resource: "machinesets"}
	machineResource      = schema.GroupVersionResource{Group: "node.tke.cloud.tencent.com", Version: "v1beta1", Resource: "machines"}
	immutableImage       = regexp.MustCompile(`^[^[:space:]]+@sha256:[0-9a-f]{64}$`)
	errNodeCASChanged    = errors.New("runtime admission Node CAS changed")
	errMachineCASChanged = errors.New("runtime admission Machine CAS changed")
)

type machineIdentity struct {
	Name string
	UID  string
}

type ControllerConfig struct {
	Namespace string
	CellName  string
	// StatefulSetName is the legacy durable workload identity. New profiles
	// should set WorkloadKind, WorkloadName, and WorkloadContainer explicitly.
	StatefulSetName   string
	WorkloadKind      string
	WorkloadName      string
	WorkloadContainer string
	MachineSetName    string
	PoolLabelKey      string
	PoolTaintKey      string
	PoolTaintValue    string
	PendingTaintKey   string
	AdmittedLabel     string
	PhaseLabel        string
	StateAnnotation   string
	DrainAnnotation   string
	ProfileVersion    string
	ProbeComponent    string
	BootstrapImage    string
	ImagePullSecret   string
	// InjectedImagePullSecrets permits only explicitly qualified platform additions.
	// Empty retains the legacy single-primary-secret contract.
	InjectedImagePullSecrets []string
	ProbeTimeout             time.Duration
	RetryBackoff             time.Duration
	ReconcileInterval        time.Duration
	RequiredZones            int
}

type Controller struct {
	Kubernetes kubernetes.Interface
	Dynamic    dynamic.Interface
	Config     ControllerConfig
	Now        func() time.Time
	Logf       func(string, ...any)
}

type ReconcileResult struct {
	Node   string
	Phase  Phase
	Action string
}

func (c *Controller) Run(ctx context.Context) {
	interval := c.Config.ReconcileInterval
	if interval <= 0 {
		interval = 5 * time.Second
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		results, err := c.ReconcileOnce(ctx)
		if err != nil {
			c.logf("runtime node admission reconcile failed: %v", err)
		} else {
			for _, result := range results {
				if result.Action != "" {
					c.logf("runtime node admission node=%s phase=%s action=%s", result.Node, result.Phase, result.Action)
				}
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (c *Controller) ReconcileOnce(ctx context.Context) ([]ReconcileResult, error) {
	if err := c.validate(); err != nil {
		return nil, err
	}
	runtimeImage, err := c.currentRuntimeImage(ctx)
	if err != nil {
		return nil, err
	}
	machineSet, err := c.Dynamic.Resource(machineSetResource).Get(ctx, c.Config.MachineSetName, metav1.GetOptions{})
	if err != nil {
		return nil, fmt.Errorf("get runtime MachineSet: %w", err)
	}
	if err := c.validateMachineSet(machineSet); err != nil {
		return nil, err
	}
	machines, err := c.machineIdentities(ctx)
	if err != nil {
		return nil, err
	}
	nodes, err := c.Kubernetes.CoreV1().Nodes().List(ctx, metav1.ListOptions{
		LabelSelector: "node.tke.cloud.tencent.com/machineset=" + c.Config.MachineSetName,
	})
	if err != nil {
		return nil, fmt.Errorf("list runtime Nodes: %w", err)
	}
	sort.Slice(nodes.Items, func(i, j int) bool { return nodes.Items[i].Name < nodes.Items[j].Name })
	results := make([]ReconcileResult, 0, len(nodes.Items))
	for index := range nodes.Items {
		node := &nodes.Items[index]
		result, err := c.reconcileObservedNode(ctx, node, machines[node.Name], string(machineSet.GetUID()), runtimeImage)
		if err != nil {
			return results, err
		}
		results = append(results, result)
	}
	if c.Config.RequiredZones > 0 {
		admitted, err := c.admitPreparedFrontier(ctx, string(machineSet.GetUID()), runtimeImage)
		results = append(results, admitted...)
		if err != nil {
			return results, err
		}
	}
	return results, nil
}

func (c *Controller) reconcileObservedNode(
	ctx context.Context,
	observed *corev1.Node,
	machine machineIdentity,
	machineSetUID string,
	runtimeImage string,
) (ReconcileResult, error) {
	node := observed.DeepCopy()
	var lastErr error
	for attempt := 0; attempt < 3; attempt++ {
		if attempt > 0 {
			latest, err := c.Kubernetes.CoreV1().Nodes().Get(ctx, observed.Name, metav1.GetOptions{})
			if err != nil {
				if apierrors.IsNotFound(err) {
					return ReconcileResult{
						Node: observed.Name, Phase: PhaseCancelled, Action: "node-disappeared-during-admission-reconcile",
					}, nil
				}
				return ReconcileResult{Node: observed.Name}, fmt.Errorf("re-read runtime Node after CAS change: %w", err)
			}
			node = latest
			machines, err := c.machineIdentities(ctx)
			if err != nil {
				return ReconcileResult{Node: observed.Name}, err
			}
			machine = machines[node.Name]
		}
		if node.Labels["fleet.actor.dev/cell-name"] != c.Config.CellName ||
			node.Labels["node.tke.cloud.tencent.com/machineset"] != c.Config.MachineSetName {
			return ReconcileResult{Node: node.Name}, fmt.Errorf("runtime Node %s identity mismatch", node.Name)
		}
		if machine.UID == "" {
			if _, _, err := c.ensurePendingFence(ctx, node, nil, machineIdentity{}); err != nil {
				if errors.Is(err, errNodeCASChanged) {
					lastErr = err
					continue
				}
				return ReconcileResult{Node: node.Name}, err
			}
			return ReconcileResult{Node: node.Name, Phase: PhasePending, Action: "wait-for-machine-identity"}, nil
		}
		identity := Identity{
			NodeUID: string(node.UID), ProviderID: node.Spec.ProviderID, MachineUID: machine.UID,
			MachineSetUID: machineSetUID, ProfileDigest: c.profileDigest(), RuntimeImage: runtimeImage,
		}
		result, err := c.reconcileNode(ctx, node, identity, machine)
		if errors.Is(err, errNodeCASChanged) || errors.Is(err, errMachineCASChanged) {
			lastErr = err
			continue
		}
		return result, err
	}
	return ReconcileResult{Node: observed.Name}, lastErr
}

func (c *Controller) currentRuntimeImage(ctx context.Context) (string, error) {
	var template corev1.PodTemplateSpec
	var labels map[string]string
	var err error
	switch c.workloadKind() {
	case "StatefulSet":
		var workload *appsv1.StatefulSet
		workload, err = c.Kubernetes.AppsV1().StatefulSets(c.Config.Namespace).Get(ctx, c.workloadName(), metav1.GetOptions{})
		if err == nil {
			template, labels = workload.Spec.Template, workload.Labels
		}
	case "Deployment":
		var workload *appsv1.Deployment
		workload, err = c.Kubernetes.AppsV1().Deployments(c.Config.Namespace).Get(ctx, c.workloadName(), metav1.GetOptions{})
		if err == nil {
			template, labels = workload.Spec.Template, workload.Labels
		}
	default:
		return "", fmt.Errorf("unsupported runtime admission workload kind %q", c.workloadKind())
	}
	if apierrors.IsNotFound(err) {
		if c.Config.BootstrapImage == "" {
			return "", fmt.Errorf("runtime admission workload is absent and no bootstrap image is configured")
		}
		return c.Config.BootstrapImage, nil
	}
	if err != nil {
		return "", fmt.Errorf("get runtime admission workload: %w", err)
	}
	if !workloadMatchesCell(labels, template.Labels, c.Config.CellName) {
		return "", fmt.Errorf("runtime admission workload Cell identity mismatch")
	}
	// The admission controller's configured immutable image is the desired
	// release candidate. During an upgrade the live StatefulSet necessarily
	// still references the previous image until every Node has proved the
	// candidate, so preferring the live image here creates a circular gate.
	if c.Config.BootstrapImage != "" {
		return c.Config.BootstrapImage, nil
	}
	return workloadImage(template.Spec.Containers, c.workloadContainer(), c.workloadKind())
}

// StatefulSetMatchesCell accepts a staged declarative migration where either
// the object label or Pod-template label predates the other. An explicitly
// conflicting label always fails closed, and at least one label must bind the
// object to the configured Cell.
func StatefulSetMatchesCell(statefulSet *appsv1.StatefulSet, cell string) bool {
	return workloadMatchesCell(statefulSet.Labels, statefulSet.Spec.Template.Labels, cell)
}

func workloadMatchesCell(metadataLabels, templateLabels map[string]string, cell string) bool {
	metadataCell := metadataLabels["fleet.actor.dev/cell-name"]
	templateCell := templateLabels["fleet.actor.dev/cell-name"]
	return (metadataCell == "" || metadataCell == cell) &&
		(templateCell == "" || templateCell == cell) &&
		(metadataCell == cell || templateCell == cell)
}

func (c *Controller) reconcileNode(ctx context.Context, node *corev1.Node, identity Identity, machine machineIdentity) (ReconcileResult, error) {
	result := ReconcileResult{Node: node.Name}
	state, err := DecodeState(node.Annotations[c.stateAnnotation()])
	if err != nil {
		attempt, attemptErr := newAttemptUID()
		if attemptErr != nil {
			return result, attemptErr
		}
		now := c.now()
		state = State{
			Phase: PhasePending, Identity: identity, AttemptUID: attempt, Attempt: 1,
			StartedAt: now, TransitionAt: now, Reason: "discarded invalid admission evidence",
		}
		if _, _, fenceErr := c.ensurePendingFence(ctx, node, &state, machine); fenceErr != nil {
			return result, fmt.Errorf("Node %s has invalid admission state and could not be fenced: %v: %w", node.Name, err, fenceErr)
		}
		result.Phase = PhasePending
		result.Action = "reset-invalid-evidence"
		return result, nil
	}
	if node.DeletionTimestamp != nil || node.Annotations[c.drainAnnotation()] != "" {
		if state.Phase != "" && state.Phase != PhaseAdmitted && state.Phase != PhaseCancelled {
			if err := c.deleteExactProbe(ctx, state); err != nil {
				return result, err
			}
			state.Phase = PhaseCancelled
			state.TransitionAt = c.now()
			state.Reason = "node entered drain or deletion"
			if _, err := c.patchState(ctx, node, state); err != nil {
				return result, err
			}
			result.Action = "cancel-probe-for-drain"
		}
		result.Phase = state.Phase
		return result, nil
	}

	if (state.Phase == PhaseAdmitted || state.Phase == PhaseSuspect) && SameAttempt(state.Identity, identity) {
		fault := nodeLocalFault(node)
		if fault != "" {
			if state.Phase != PhaseSuspect || state.Fault != fault || state.FaultSince.IsZero() {
				state.Phase = PhaseSuspect
				state.Fault = fault
				state.FaultSince = c.now()
				state.TransitionAt = c.now()
				state.Reason = fault
				if _, _, err := c.ensurePendingFence(ctx, node, &state, machine); err != nil {
					return result, err
				}
				result.Phase = PhaseSuspect
				result.Action = "fence-suspect-node"
				return result, nil
			}
			if c.now().Sub(state.FaultSince) >= c.Config.ProbeTimeout {
				state.Phase = PhaseQuarantined
				state.TransitionAt = c.now()
				if _, err := c.patchState(ctx, node, state); err != nil {
					return result, err
				}
				result.Phase = PhaseQuarantined
				result.Action = "quarantine-admitted-node-fault"
				return result, nil
			}
			result.Phase = PhaseSuspect
			result.Action = "wait-suspect-node"
			return result, nil
		}
		if state.Phase == PhaseSuspect || state.Fault != "" || !state.FaultSince.IsZero() {
			state.Phase = PhaseAdmitted
			state.Fault = ""
			state.FaultSince = time.Time{}
			state.Reason = ""
			state.TransitionAt = c.now()
		}
		updated, changed, err := c.completeAdmission(ctx, node, state, machine)
		if err != nil {
			return result, err
		}
		result.Phase = PhaseAdmitted
		if changed {
			result.Action = "restore-admission-fields"
			_ = updated
		}
		return result, nil
	}
	if state.Phase == PhasePrepared && SameAttempt(state.Identity, identity) {
		// Prepared is still a fail-closed phase. Recover crashes and legacy
		// states that persisted the phase but lost either the Node fence or its
		// concrete Machine source taint before considering the balanced
		// admission frontier.
		var fenceChanged bool
		node, fenceChanged, err = c.ensurePendingFence(ctx, node, nil, machine)
		if err != nil {
			return result, err
		}
		if fenceChanged {
			result.Action = "restore-prepared-fence"
		}
		if !nodeLocallyReady(node) {
			if fault := nodeLocalFault(node); fault != "" && c.now().Sub(state.StartedAt) >= c.Config.ProbeTimeout {
				state.Phase = PhaseQuarantined
				state.TransitionAt = c.now()
				state.Reason = fault
				if _, err := c.patchState(ctx, node, state); err != nil {
					return result, err
				}
				result.Phase = PhaseQuarantined
				result.Action = "quarantine-prepared-node-pressure"
				return result, nil
			}
			result.Phase = PhasePrepared
			result.Action = "wait-prepared-node-ready"
			return result, nil
		}
		result.Phase = PhasePrepared
		return result, nil
	}

	if state.Phase == PhaseBlocked && SameAttempt(state.Identity, identity) && c.now().Before(state.RetryAt) {
		result.Phase = PhaseBlocked
		return result, nil
	}
	if state.Phase == PhaseQuarantined && SameAttempt(state.Identity, identity) {
		result.Phase = PhaseQuarantined
		return result, nil
	}

	if state.Phase == "" || !SameAttempt(state.Identity, identity) || state.Phase == PhaseCancelled || state.Phase == PhaseBlocked {
		if state.ProbePodName != "" {
			if err := c.deleteExactProbe(ctx, state); err != nil {
				return result, err
			}
		}
		attempt, err := newAttemptUID()
		if err != nil {
			return result, err
		}
		attemptNumber := state.Attempt + 1
		if !SameNode(state.Identity, identity) {
			attemptNumber = 1
		}
		state = State{
			Phase: PhasePending, Identity: identity, AttemptUID: attempt, Attempt: attemptNumber,
			StartedAt: c.now(), TransitionAt: c.now(),
		}
		var changed bool
		node, changed, err = c.ensurePendingFence(ctx, node, &state, machine)
		if err != nil {
			return result, err
		}
		result.Phase = PhasePending
		if changed {
			result.Action = "fence-node"
		}
	}

	if !nodeLocallyReady(node) {
		if fault := nodeLocalFault(node); fault != "" && c.now().Sub(state.StartedAt) >= c.Config.ProbeTimeout {
			if err := c.deleteExactProbe(ctx, state); err != nil {
				return result, err
			}
			state.Phase = PhaseQuarantined
			state.TransitionAt = c.now()
			state.Reason = fault
			if _, err := c.patchState(ctx, node, state); err != nil {
				return result, err
			}
			result.Phase = PhaseQuarantined
			result.Action = "quarantine-node-pressure"
			return result, nil
		}
		result.Phase = PhasePending
		if result.Action == "" {
			result.Action = "wait-for-node-ready"
		}
		return result, nil
	}

	probeName := probeName(state.AttemptUID)
	probe, err := c.Kubernetes.CoreV1().Pods(c.Config.Namespace).Get(ctx, probeName, metav1.GetOptions{})
	if apierrors.IsNotFound(err) {
		probe, err = c.Kubernetes.CoreV1().Pods(c.Config.Namespace).Create(ctx, c.probePod(node, state, probeName), metav1.CreateOptions{})
		if err != nil {
			return result, fmt.Errorf("create admission probe for Node %s: %w", node.Name, err)
		}
		state.Phase = PhaseProbing
		state.ProbePodName = probe.Name
		state.ProbePodUID = string(probe.UID)
		state.TransitionAt = c.now()
		if _, err := c.patchState(ctx, node, state); err != nil {
			return result, err
		}
		result.Phase = PhaseProbing
		result.Action = "create-probe"
		return result, nil
	}
	if err != nil {
		return result, fmt.Errorf("get admission probe for Node %s: %w", node.Name, err)
	}
	if err := c.validateProbe(probe, node, state); err != nil {
		return result, err
	}
	if state.ProbePodUID == "" {
		state.Phase = PhaseProbing
		state.ProbePodName = probe.Name
		state.ProbePodUID = string(probe.UID)
		state.TransitionAt = c.now()
		if _, err := c.patchState(ctx, node, state); err != nil {
			return result, err
		}
		result.Phase = PhaseProbing
		result.Action = "adopt-probe-identity"
		return result, nil
	}

	switch probe.Status.Phase {
	case corev1.PodSucceeded:
		if err := c.validateCurrentIdentity(ctx, node, state.Identity); err != nil {
			return result, err
		}
		if c.Config.RequiredZones > 0 {
			state.Phase = PhasePrepared
			state.TransitionAt = c.now()
			state.RetryAt = time.Time{}
			state.Reason = "waiting for balanced topology admission frontier"
			if _, err := c.patchState(ctx, node, state); err != nil {
				return result, err
			}
			if err := c.deleteExactProbe(ctx, state); err != nil {
				c.logf("prepared Node %s retained completed probe: %v", node.Name, err)
			}
			result.Phase = PhasePrepared
			result.Action = "prepare-node"
			break
		}
		state.Phase = PhaseAdmitted
		state.TransitionAt = c.now()
		state.RetryAt = time.Time{}
		state.Reason = ""
		if _, _, err := c.completeAdmission(ctx, node, state, machine); err != nil {
			return result, err
		}
		if err := c.deleteExactProbe(ctx, state); err != nil {
			c.logf("admitted Node %s retained completed probe: %v", node.Name, err)
		}
		result.Phase = PhaseAdmitted
		result.Action = "admit-node"
	case corev1.PodFailed:
		// A failed executable or DNS check is not attributable to the Node:
		// the image, registry, or cluster DNS may be broken fleet-wide. Retry
		// without authorizing Machine replacement.
		state.Phase = PhaseBlocked
		state.TransitionAt = c.now()
		state.RetryAt = c.now().Add(c.Config.RetryBackoff)
		state.Reason = boundedReason(probeFailureReason(probe))
		if _, err := c.patchState(ctx, node, state); err != nil {
			return result, err
		}
		result.Phase = PhaseBlocked
		result.Action = "block-failed-probe"
	default:
		if c.now().Sub(state.StartedAt) >= c.Config.ProbeTimeout {
			state.Phase = PhaseBlocked
			state.TransitionAt = c.now()
			state.RetryAt = c.now().Add(c.Config.RetryBackoff)
			state.Reason = boundedReason(probeWaitingReason(probe))
			if _, err := c.patchState(ctx, node, state); err != nil {
				return result, err
			}
			result.Phase = PhaseBlocked
			result.Action = "backoff-probe"
		} else {
			result.Phase = PhaseProbing
		}
	}
	return result, nil
}

// admitPreparedFrontier opens scheduling in topology-safe rounds. A provider
// may return ZoneEquality Machines at different times. Admitting each one as
// soon as its local probe succeeds lets early zones permanently capture Pods;
// instead, only the common prepared/admitted frontier across all zones opens.
// Each patch is still independently UID/resourceVersion fenced. Applying one
// Node per zone per round keeps intermediate crash states within maxSkew=1
// when the starting state is balanced, and monotonically repairs legacy skew.
func (c *Controller) admitPreparedFrontier(ctx context.Context, machineSetUID, runtimeImage string) ([]ReconcileResult, error) {
	nodes, err := c.Kubernetes.CoreV1().Nodes().List(ctx, metav1.ListOptions{
		LabelSelector: "node.tke.cloud.tencent.com/machineset=" + c.Config.MachineSetName,
	})
	if err != nil {
		return nil, fmt.Errorf("list prepared runtime Nodes: %w", err)
	}
	machines, err := c.machineIdentities(ctx)
	if err != nil {
		return nil, err
	}
	admitted := make(map[string]int)
	prepared := make(map[string][]string)
	for index := range nodes.Items {
		node := &nodes.Items[index]
		zone := node.Labels[corev1.LabelTopologyZone]
		if zone == "" {
			continue
		}
		if _, exists := admitted[zone]; !exists {
			admitted[zone] = 0
		}
		state, decodeErr := DecodeState(node.Annotations[c.stateAnnotation()])
		if decodeErr != nil {
			return nil, fmt.Errorf("runtime Node %s has invalid admission state: %w", node.Name, decodeErr)
		}
		machine := machines[node.Name]
		identity := Identity{
			NodeUID: string(node.UID), ProviderID: node.Spec.ProviderID, MachineUID: machine.UID,
			MachineSetUID: machineSetUID, ProfileDigest: c.profileDigest(), RuntimeImage: runtimeImage,
		}
		if state.Phase == PhaseAdmitted && SameAttempt(state.Identity, identity) &&
			node.Labels[c.admittedLabel()] == "true" && !c.hasPendingTaint(node.Spec.Taints) && nodeLocallyReady(node) {
			admitted[zone]++
			continue
		}
		if state.Phase == PhasePrepared && SameAttempt(state.Identity, identity) &&
			node.Labels[c.admittedLabel()] == "" && c.hasPendingTaint(node.Spec.Taints) &&
			node.DeletionTimestamp == nil && node.Annotations[c.drainAnnotation()] == "" && nodeLocallyReady(node) {
			prepared[zone] = append(prepared[zone], node.Name)
		}
	}
	if len(admitted) < c.Config.RequiredZones {
		return nil, nil
	}
	if len(admitted) > c.Config.RequiredZones {
		return nil, fmt.Errorf("runtime admission topology has %d zones, expected %d", len(admitted), c.Config.RequiredZones)
	}
	for zone := range prepared {
		sort.Strings(prepared[zone])
	}
	plan := balancedAdmissionPlan(admitted, prepared)
	results := make([]ReconcileResult, 0, len(plan))
	// Revalidate batch-wide identity once at the admission boundary.  The old
	// path called validateCurrentIdentity for every prepared Node; that helper
	// re-read the MachineSet, StatefulSet and the complete Machine inventory on
	// each call.  A balanced scale-out of hundreds of Nodes therefore produced
	// O(nodes^2) API traffic and held a ready frontier closed for minutes.  The
	// MachineSet UID/config, immutable runtime image and Machine snapshot are
	// common to this plan.  Individual Nodes are still re-read below and
	// completeAdmission retains its resourceVersion-fenced patches.
	liveMachineSet, err := c.Dynamic.Resource(machineSetResource).Get(ctx, c.Config.MachineSetName, metav1.GetOptions{})
	if err != nil {
		return results, fmt.Errorf("re-read runtime MachineSet before frontier admission: %w", err)
	}
	if err := c.validateMachineSet(liveMachineSet); err != nil {
		return results, err
	}
	if string(liveMachineSet.GetUID()) != machineSetUID {
		return results, fmt.Errorf("runtime MachineSet changed before frontier admission")
	}
	liveRuntimeImage, err := c.currentRuntimeImage(ctx)
	if err != nil {
		return results, err
	}
	if liveRuntimeImage != runtimeImage {
		return results, fmt.Errorf("runtime image changed before frontier admission")
	}
	machines, err = c.machineIdentities(ctx)
	if err != nil {
		return results, err
	}
	for _, name := range plan {
		node, getErr := c.Kubernetes.CoreV1().Nodes().Get(ctx, name, metav1.GetOptions{})
		if getErr != nil {
			return results, fmt.Errorf("re-read prepared runtime Node %s: %w", name, getErr)
		}
		state, decodeErr := DecodeState(node.Annotations[c.stateAnnotation()])
		if decodeErr != nil || state.Phase != PhasePrepared {
			return results, fmt.Errorf("prepared runtime Node %s changed admission phase", name)
		}
		identity := state.Identity
		if identity.NodeUID != string(node.UID) || identity.ProviderID != node.Spec.ProviderID ||
			identity.MachineSetUID != machineSetUID || identity.ProfileDigest != c.profileDigest() ||
			identity.RuntimeImage != runtimeImage {
			return results, fmt.Errorf("runtime Node %s changed before frontier admission", node.Name)
		}
		state.Phase = PhaseAdmitted
		state.TransitionAt = c.now()
		state.Reason = ""
		machine := machines[name]
		if machine.UID == "" || machine.UID != identity.MachineUID {
			return results, fmt.Errorf("runtime Machine identity changed before Node %s admission", node.Name)
		}
		if _, _, err := c.completeAdmission(ctx, node, state, machine); err != nil {
			return results, err
		}
		results = append(results, ReconcileResult{Node: name, Phase: PhaseAdmitted, Action: "admit-balanced-frontier"})
	}
	return results, nil
}

// balancedAdmissionPlan returns Node names in round-robin zone order up to
// the common capacity frontier. It intentionally leaves surplus fast-zone
// Nodes fenced. Existing skew is never increased and is repaired as lagging
// zones produce prepared Nodes.
func balancedAdmissionPlan(admitted map[string]int, prepared map[string][]string) []string {
	zones := make([]string, 0, len(admitted))
	frontier := -1
	for zone, count := range admitted {
		zones = append(zones, zone)
		total := count + len(prepared[zone])
		if frontier < 0 || total < frontier {
			frontier = total
		}
	}
	sort.Strings(zones)
	current := make(map[string]int, len(admitted))
	used := make(map[string]int, len(admitted))
	for zone, count := range admitted {
		current[zone] = count
	}
	plan := make([]string, 0)
	for level := 1; level <= frontier; level++ {
		for _, zone := range zones {
			if current[zone] >= level {
				continue
			}
			plan = append(plan, prepared[zone][used[zone]])
			used[zone]++
			current[zone]++
		}
	}
	return plan
}

func (c *Controller) validateCurrentIdentity(ctx context.Context, node *corev1.Node, identity Identity) error {
	if identity.NodeUID != string(node.UID) || identity.ProviderID != node.Spec.ProviderID ||
		identity.ProfileDigest != c.profileDigest() {
		return fmt.Errorf("runtime Node %s changed before admission", node.Name)
	}
	machineSet, err := c.Dynamic.Resource(machineSetResource).Get(ctx, c.Config.MachineSetName, metav1.GetOptions{})
	if err != nil {
		return fmt.Errorf("re-read runtime MachineSet before admission: %w", err)
	}
	if err := c.validateMachineSet(machineSet); err != nil {
		return err
	}
	if identity.MachineSetUID != string(machineSet.GetUID()) {
		return fmt.Errorf("runtime MachineSet changed before Node admission")
	}
	machines, err := c.machineIdentities(ctx)
	if err != nil {
		return err
	}
	machine := machines[node.Name]
	if machine.UID == "" || machine.UID != identity.MachineUID {
		return fmt.Errorf("runtime Machine identity changed before Node %s admission", node.Name)
	}
	runtimeImage, err := c.currentRuntimeImage(ctx)
	if err != nil {
		return err
	}
	if runtimeImage != identity.RuntimeImage {
		return fmt.Errorf("runtime image changed before Node %s admission", node.Name)
	}
	return nil
}

func (c *Controller) validateMachineSet(machineSet *unstructured.Unstructured) error {
	cell, _, _ := unstructured.NestedString(machineSet.Object, "spec", "template", "spec", "metadata", "labels", "fleet.actor.dev/cell-name")
	pool, _, _ := unstructured.NestedString(machineSet.Object, "spec", "template", "spec", "metadata", "labels", c.poolLabelKey())
	if machineSet.GetUID() == "" || cell != c.Config.CellName || pool != "true" {
		return fmt.Errorf("runtime MachineSet identity mismatch")
	}
	taints, found, err := unstructured.NestedSlice(machineSet.Object, "spec", "template", "spec", "taints")
	if err != nil || !found || !unstructuredTaintExists(taints, c.pendingTaintKey(), "pending", string(corev1.TaintEffectNoSchedule)) {
		return fmt.Errorf("runtime MachineSet has no default-deny admission taint")
	}
	return nil
}

func unstructuredTaintExists(taints []any, key, value, effect string) bool {
	for _, raw := range taints {
		taint, ok := raw.(map[string]any)
		if ok && taint["key"] == key && taint["value"] == value && taint["effect"] == effect {
			return true
		}
	}
	return false
}

func (c *Controller) machineIdentities(ctx context.Context) (map[string]machineIdentity, error) {
	machines, err := c.Dynamic.Resource(machineResource).List(ctx, metav1.ListOptions{
		LabelSelector: "node.tke.cloud.tencent.com/machineset=" + c.Config.MachineSetName,
		// Match kubectl's bounded-list path. TKE's aggregated Native-node API
		// can return a provider 500 for an unbounded LIST after deletion.
		Limit: 500,
	})
	if err != nil {
		return nil, fmt.Errorf("list runtime Machines for admission: %w", err)
	}
	if machines.GetContinue() != "" {
		return nil, fmt.Errorf("runtime Machine admission inventory exceeds bounded list of 500")
	}
	result := make(map[string]machineIdentity, len(machines.Items))
	for index := range machines.Items {
		machine := &machines.Items[index]
		nodeName, found, err := unstructured.NestedString(machine.Object, "status", "nodeRef", "name")
		if err != nil || !found || nodeName == "" || machine.GetUID() == "" {
			continue
		}
		if _, duplicate := result[nodeName]; duplicate {
			return nil, fmt.Errorf("multiple runtime Machines claim Node %s", nodeName)
		}
		result[nodeName] = machineIdentity{Name: machine.GetName(), UID: string(machine.GetUID())}
	}
	return result, nil
}

func runtimeImage(statefulSet *appsv1.StatefulSet) (string, error) {
	return workloadImage(statefulSet.Spec.Template.Spec.Containers, "workerd", "StatefulSet")
}

func workloadImage(containers []corev1.Container, containerName, workloadKind string) (string, error) {
	for index := range containers {
		container := &containers[index]
		if container.Name != containerName {
			continue
		}
		if !immutableImage.MatchString(container.Image) {
			return "", fmt.Errorf("runtime admission %s %s image is not an immutable digest", workloadKind, containerName)
		}
		return container.Image, nil
	}
	return "", fmt.Errorf("runtime admission %s has no %s container", workloadKind, containerName)
}

func nodeLocallyReady(node *corev1.Node) bool {
	conditions := make(map[corev1.NodeConditionType]corev1.ConditionStatus, len(node.Status.Conditions))
	for _, condition := range node.Status.Conditions {
		conditions[condition.Type] = condition.Status
	}
	if conditions[corev1.NodeReady] != corev1.ConditionTrue {
		return false
	}
	for _, condition := range []corev1.NodeConditionType{
		corev1.NodeDiskPressure, corev1.NodeMemoryPressure, corev1.NodePIDPressure, corev1.NodeNetworkUnavailable,
	} {
		if conditions[condition] == corev1.ConditionTrue {
			return false
		}
	}
	return true
}

func nodeLocalFault(node *corev1.Node) string {
	ready := corev1.ConditionUnknown
	foundReady := false
	for _, condition := range node.Status.Conditions {
		if condition.Type == corev1.NodeReady {
			ready = condition.Status
			foundReady = true
		}
		if condition.Status != corev1.ConditionTrue {
			continue
		}
		switch condition.Type {
		case corev1.NodeDiskPressure, corev1.NodeMemoryPressure, corev1.NodePIDPressure, corev1.NodeNetworkUnavailable:
			return "persistent Node condition: " + string(condition.Type)
		}
	}
	if !foundReady || ready != corev1.ConditionTrue {
		return "persistent Node condition: NotReady"
	}
	return ""
}

func (c *Controller) probePod(node *corev1.Node, state State, name string) *corev1.Pod {
	falseValue := false
	zero := int64(0)
	labels := map[string]string{
		"fleet.actor.dev/cell-name": c.Config.CellName,
		"fleet.actor.dev/component": c.probeComponent(),
	}
	annotations := map[string]string{
		"fleet.actor.dev/runtime-admission-attempt":  state.AttemptUID,
		"fleet.actor.dev/runtime-admission-node-uid": state.Identity.NodeUID,
		"fleet.actor.dev/runtime-admission-profile":  state.Identity.ProfileDigest,
	}
	pod := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: c.Config.Namespace, Labels: labels, Annotations: annotations},
		Spec: corev1.PodSpec{
			AutomountServiceAccountToken:  &falseValue,
			NodeName:                      node.Name,
			RestartPolicy:                 corev1.RestartPolicyNever,
			TerminationGracePeriodSeconds: &zero,
			EnableServiceLinks:            &falseValue,
			SecurityContext: &corev1.PodSecurityContext{
				RunAsNonRoot: boolPointer(true), RunAsUser: int64Pointer(4059), RunAsGroup: int64Pointer(4059),
				SeccompProfile: &corev1.SeccompProfile{Type: corev1.SeccompProfileTypeRuntimeDefault},
			},
			Tolerations: []corev1.Toleration{
				{Key: c.poolTaintKey(), Operator: corev1.TolerationOpEqual, Value: c.poolTaintValue(), Effect: corev1.TaintEffectNoSchedule},
				{Key: c.pendingTaintKey(), Operator: corev1.TolerationOpEqual, Value: "pending", Effect: corev1.TaintEffectNoSchedule},
			},
			Containers: []corev1.Container{{
				Name: "validate", Image: state.Identity.RuntimeImage, ImagePullPolicy: corev1.PullAlways,
				Command: []string{"/bin/bash", "-ec"},
				Args:    []string{"/opt/actor/bin/workerd --version >/dev/null\ngetent hosts kubernetes.default.svc >/dev/null\ntest -r /opt/actor/share/source-revision\ntest -r /opt/actor/share/source-manifest-sha256\n"},
				Resources: corev1.ResourceRequirements{
					Requests: corev1.ResourceList{corev1.ResourceCPU: resourceQuantity("10m"), corev1.ResourceMemory: resourceQuantity("16Mi")},
					Limits:   corev1.ResourceList{corev1.ResourceCPU: resourceQuantity("200m"), corev1.ResourceMemory: resourceQuantity("128Mi")},
				},
				SecurityContext: &corev1.SecurityContext{
					AllowPrivilegeEscalation: boolPointer(false), ReadOnlyRootFilesystem: boolPointer(true),
					Capabilities: &corev1.Capabilities{Drop: []corev1.Capability{"ALL"}},
				},
			}},
		},
	}
	if c.Config.ImagePullSecret != "" {
		pod.Spec.ImagePullSecrets = []corev1.LocalObjectReference{{Name: c.Config.ImagePullSecret}}
	}
	return pod
}

// resourceQuantity keeps probe construction deterministic without accepting
// arbitrary resource expressions from a runtime profile.
func resourceQuantity(value string) (result resource.Quantity) {
	return resource.MustParse(value)
}

func (c *Controller) validateProbe(probe *corev1.Pod, node *corev1.Node, state State) error {
	if probe.Name != probeName(state.AttemptUID) || probe.Namespace == "" || probe.Spec.NodeName != node.Name ||
		probe.Labels["fleet.actor.dev/cell-name"] != c.Config.CellName || probe.Labels["fleet.actor.dev/component"] != c.probeComponent() ||
		probe.Annotations["fleet.actor.dev/runtime-admission-attempt"] != state.AttemptUID ||
		probe.Annotations["fleet.actor.dev/runtime-admission-node-uid"] != string(node.UID) ||
		probe.Annotations["fleet.actor.dev/runtime-admission-profile"] != state.Identity.ProfileDigest ||
		len(probe.Spec.Containers) != 1 || probe.Spec.Containers[0].Image != state.Identity.RuntimeImage ||
		probe.Spec.Containers[0].ImagePullPolicy != corev1.PullAlways || probe.Spec.AutomountServiceAccountToken == nil ||
		*probe.Spec.AutomountServiceAccountToken || probe.Spec.RestartPolicy != corev1.RestartPolicyNever ||
		probe.Spec.HostNetwork || probe.Spec.HostPID || probe.Spec.HostIPC || len(probe.Spec.Volumes) != 0 {
		return fmt.Errorf("runtime admission probe %s identity or security contract mismatch", probe.Name)
	}
	container := &probe.Spec.Containers[0]
	if container.Name != "validate" || len(container.Command) != 2 || container.Command[0] != "/bin/bash" || container.Command[1] != "-ec" ||
		len(container.Args) != 1 || container.Args[0] != "/opt/actor/bin/workerd --version >/dev/null\ngetent hosts kubernetes.default.svc >/dev/null\ntest -r /opt/actor/share/source-revision\ntest -r /opt/actor/share/source-manifest-sha256\n" ||
		container.SecurityContext == nil || container.SecurityContext.AllowPrivilegeEscalation == nil || *container.SecurityContext.AllowPrivilegeEscalation ||
		container.SecurityContext.ReadOnlyRootFilesystem == nil || !*container.SecurityContext.ReadOnlyRootFilesystem ||
		container.SecurityContext.Capabilities == nil || len(container.SecurityContext.Capabilities.Drop) != 1 ||
		container.SecurityContext.Capabilities.Drop[0] != corev1.Capability("ALL") {
		return fmt.Errorf("runtime admission probe %s executable contract mismatch", probe.Name)
	}
	if c.Config.ImagePullSecret != "" {
		allowed := map[string]bool{c.Config.ImagePullSecret: true}
		for _, name := range c.Config.InjectedImagePullSecrets {
			if name == "" || allowed[name] {
				return fmt.Errorf("runtime admission injected pull credential configuration invalid")
			}
			allowed[name] = true
		}
		seen := make(map[string]bool, len(probe.Spec.ImagePullSecrets))
		for _, ref := range probe.Spec.ImagePullSecrets {
			if !allowed[ref.Name] || seen[ref.Name] {
				return fmt.Errorf("runtime admission probe %s pull credential contract mismatch", probe.Name)
			}
			seen[ref.Name] = true
		}
		if !seen[c.Config.ImagePullSecret] {
			return fmt.Errorf("runtime admission probe %s primary pull credential missing", probe.Name)
		}
	}
	if state.ProbePodUID != "" && state.ProbePodUID != string(probe.UID) {
		return fmt.Errorf("runtime admission probe %s UID changed", probe.Name)
	}
	return nil
}

func (c *Controller) ensurePendingFence(ctx context.Context, node *corev1.Node, state *State, machine machineIdentity) (*corev1.Node, bool, error) {
	operations := []map[string]any{
		{"op": "test", "path": "/metadata/uid", "value": string(node.UID)},
		{"op": "test", "path": "/metadata/resourceVersion", "value": node.ResourceVersion},
	}
	changed := false
	if node.Labels[c.admittedLabel()] != "" {
		operations = append(operations, map[string]any{"op": "remove", "path": "/metadata/labels/" + escapeJSONPointer(c.admittedLabel())})
		changed = true
	}
	if !c.hasPendingTaint(node.Spec.Taints) {
		taint := corev1.Taint{Key: c.pendingTaintKey(), Value: "pending", Effect: corev1.TaintEffectNoSchedule}
		if node.Spec.Taints == nil {
			operations = append(operations, map[string]any{"op": "add", "path": "/spec/taints", "value": []corev1.Taint{taint}})
		} else {
			operations = append(operations, map[string]any{"op": "add", "path": "/spec/taints/-", "value": taint})
		}
		changed = true
	}
	if state != nil {
		encoded, err := EncodeState(*state)
		if err != nil {
			return nil, false, err
		}
		operations = append(operations, annotationOperation(node, c.stateAnnotation(), encoded))
		operations = append(operations, labelOperation(node, c.phaseLabel(), strings.ToLower(string(state.Phase))))
		changed = true
	}
	if !changed {
		machineChanged, err := c.setMachinePendingTaint(ctx, machine, true)
		return node, machineChanged, err
	}
	updated, err := c.patchNode(ctx, node, operations)
	if err != nil {
		return updated, true, err
	}
	_, err = c.setMachinePendingTaint(ctx, machine, true)
	return updated, true, err
}

func (c *Controller) completeAdmission(ctx context.Context, node *corev1.Node, state State, machine machineIdentity) (*corev1.Node, bool, error) {
	if node.DeletionTimestamp != nil || node.Annotations[c.drainAnnotation()] != "" {
		return node, false, fmt.Errorf("refuse to admit draining or deleting Node %s", node.Name)
	}
	// TKE continuously reconciles Node taints from the concrete Machine, not
	// only from the MachineSet birth template. Retire the pending taint at that
	// source before opening the Node. A crash between these two writes leaves
	// the Node fenced; doing them in the opposite order creates a periodic
	// admit/re-fence loop and prevents capacity from ever becoming stable.
	machineChanged, err := c.setMachinePendingTaint(ctx, machine, false)
	if err != nil {
		return node, false, err
	}
	encoded, err := EncodeState(state)
	if err != nil {
		return nil, false, err
	}
	operations := []map[string]any{
		{"op": "test", "path": "/metadata/uid", "value": string(node.UID)},
		{"op": "test", "path": "/metadata/resourceVersion", "value": node.ResourceVersion},
	}
	changed := false
	if node.Annotations[c.stateAnnotation()] != encoded {
		operations = append(operations, annotationOperation(node, c.stateAnnotation(), encoded))
		changed = true
	}
	if node.Labels[c.admittedLabel()] != "true" {
		operations = append(operations, labelOperation(node, c.admittedLabel(), "true"))
		changed = true
	}
	if node.Labels[c.phaseLabel()] != "admitted" {
		operations = append(operations, labelOperation(node, c.phaseLabel(), "admitted"))
		changed = true
	}
	if index := c.pendingTaintIndex(node.Spec.Taints); index >= 0 {
		path := fmt.Sprintf("/spec/taints/%d", index)
		operations = append(operations,
			map[string]any{"op": "test", "path": path, "value": node.Spec.Taints[index]},
			map[string]any{"op": "remove", "path": path},
		)
		changed = true
	}
	if !changed {
		return node, machineChanged, nil
	}
	updated, err := c.patchNode(ctx, node, operations)
	return updated, true, err
}

func (c *Controller) setMachinePendingTaint(ctx context.Context, identity machineIdentity, present bool) (bool, error) {
	if identity.Name == "" || identity.UID == "" {
		// Before TKE publishes the NodeRef/Machine UID, the birth taint on the
		// MachineSet and Node is the only safe source of truth. Admission may
		// never open on an incomplete concrete-Machine identity.
		if present && identity.Name == "" && identity.UID == "" {
			return false, nil
		}
		return false, fmt.Errorf("runtime Machine admission identity is incomplete")
	}
	machine, err := c.Dynamic.Resource(machineResource).Get(ctx, identity.Name, metav1.GetOptions{})
	if err != nil {
		if apierrors.IsNotFound(err) {
			// Capacity contraction can delete the exact Machine between the
			// inventory snapshot and this admission-side CAS. Treat that as
			// identity churn so the caller re-reads the Node/Machine pair; it
			// must never be reported as a failed admission or recreated here.
			return false, fmt.Errorf("%w: runtime Machine %s disappeared", errMachineCASChanged, identity.Name)
		}
		return false, fmt.Errorf("get runtime Machine %s for admission fence: %w", identity.Name, err)
	}
	if string(machine.GetUID()) != identity.UID {
		return false, fmt.Errorf("%w: runtime Machine %s UID changed", errMachineCASChanged, identity.Name)
	}
	owner, _, _ := unstructured.NestedString(machine.Object, "metadata", "labels", "node.tke.cloud.tencent.com/machineset")
	if owner != c.Config.MachineSetName {
		return false, fmt.Errorf("runtime Machine %s MachineSet identity mismatch", identity.Name)
	}
	taints, found, err := unstructured.NestedSlice(machine.Object, "spec", "taints")
	if err != nil {
		return false, fmt.Errorf("read runtime Machine %s taints: %w", identity.Name, err)
	}
	indexes := make([]int, 0, 1)
	for index, raw := range taints {
		taint, ok := raw.(map[string]any)
		if ok && taint["key"] == c.pendingTaintKey() && taint["value"] == "pending" && taint["effect"] == string(corev1.TaintEffectNoSchedule) {
			indexes = append(indexes, index)
		}
	}
	if len(indexes) > 1 {
		return false, fmt.Errorf("runtime Machine %s has duplicate admission taints", identity.Name)
	}
	if present == (len(indexes) == 1) {
		return false, nil
	}
	operations := []map[string]any{
		{"op": "test", "path": "/metadata/uid", "value": identity.UID},
		{"op": "test", "path": "/metadata/resourceVersion", "value": machine.GetResourceVersion()},
	}
	if present {
		taint := map[string]any{"key": c.pendingTaintKey(), "value": "pending", "effect": string(corev1.TaintEffectNoSchedule)}
		if !found || taints == nil {
			operations = append(operations, map[string]any{"op": "add", "path": "/spec/taints", "value": []any{taint}})
		} else {
			operations = append(operations, map[string]any{"op": "add", "path": "/spec/taints/-", "value": taint})
		}
	} else {
		index := indexes[0]
		path := fmt.Sprintf("/spec/taints/%d", index)
		operations = append(operations,
			map[string]any{"op": "test", "path": path, "value": taints[index]},
			map[string]any{"op": "remove", "path": path},
		)
	}
	payload, err := json.Marshal(operations)
	if err != nil {
		return false, err
	}
	_, err = c.Dynamic.Resource(machineResource).Patch(ctx, identity.Name, types.JSONPatchType, payload, metav1.PatchOptions{})
	if err != nil {
		latest, getErr := c.Dynamic.Resource(machineResource).Get(ctx, identity.Name, metav1.GetOptions{})
		if getErr == nil && (latest.GetUID() != machine.GetUID() || latest.GetResourceVersion() != machine.GetResourceVersion()) {
			return false, fmt.Errorf("%w: runtime Machine %s changed", errMachineCASChanged, identity.Name)
		}
		return false, fmt.Errorf("CAS patch runtime Machine %s admission taint: %w", identity.Name, err)
	}
	return true, nil
}

func (c *Controller) patchState(ctx context.Context, node *corev1.Node, state State) (*corev1.Node, error) {
	encoded, err := EncodeState(state)
	if err != nil {
		return nil, err
	}
	operations := []map[string]any{
		{"op": "test", "path": "/metadata/uid", "value": string(node.UID)},
		{"op": "test", "path": "/metadata/resourceVersion", "value": node.ResourceVersion},
		annotationOperation(node, c.stateAnnotation(), encoded),
		labelOperation(node, c.phaseLabel(), strings.ToLower(string(state.Phase))),
	}
	return c.patchNode(ctx, node, operations)
}

func (c *Controller) patchNode(ctx context.Context, node *corev1.Node, operations []map[string]any) (*corev1.Node, error) {
	payload, err := json.Marshal(operations)
	if err != nil {
		return nil, err
	}
	updated, err := c.Kubernetes.CoreV1().Nodes().Patch(ctx, node.Name, types.JSONPatchType, payload, metav1.PatchOptions{})
	if err != nil {
		latest, getErr := c.Kubernetes.CoreV1().Nodes().Get(ctx, node.Name, metav1.GetOptions{})
		if getErr == nil && (latest.UID != node.UID || latest.ResourceVersion != node.ResourceVersion) {
			return nil, fmt.Errorf("%w: Node %s changed from uid=%s resourceVersion=%s to uid=%s resourceVersion=%s",
				errNodeCASChanged, node.Name, node.UID, node.ResourceVersion, latest.UID, latest.ResourceVersion)
		}
		if status, ok := err.(apierrors.APIStatus); ok {
			return nil, fmt.Errorf("CAS patch runtime admission for Node %s failed with %s: %s: %w",
				node.Name, status.Status().Reason, status.Status().Message, err)
		}
		return nil, fmt.Errorf("CAS patch runtime admission for Node %s: %w", node.Name, err)
	}
	return updated, nil
}

func (c *Controller) deleteExactProbe(ctx context.Context, state State) error {
	if state.ProbePodName == "" {
		return nil
	}
	options := metav1.DeleteOptions{}
	if state.ProbePodUID != "" {
		uid := types.UID(state.ProbePodUID)
		options.Preconditions = &metav1.Preconditions{UID: &uid}
	}
	err := c.Kubernetes.CoreV1().Pods(c.Config.Namespace).Delete(ctx, state.ProbePodName, options)
	if err != nil && !apierrors.IsNotFound(err) {
		return fmt.Errorf("delete exact runtime admission probe: %w", err)
	}
	return nil
}

func annotationOperation(node *corev1.Node, key, value string) map[string]any {
	if len(node.Annotations) == 0 {
		return map[string]any{"op": "add", "path": "/metadata/annotations", "value": map[string]string{key: value}}
	}
	return map[string]any{"op": "add", "path": "/metadata/annotations/" + escapeJSONPointer(key), "value": value}
}

func labelOperation(node *corev1.Node, key, value string) map[string]any {
	if len(node.Labels) == 0 {
		return map[string]any{"op": "add", "path": "/metadata/labels", "value": map[string]string{key: value}}
	}
	return map[string]any{"op": "add", "path": "/metadata/labels/" + escapeJSONPointer(key), "value": value}
}

func hasPendingTaint(taints []corev1.Taint) bool { return pendingTaintIndex(taints) >= 0 }

func (c *Controller) hasPendingTaint(taints []corev1.Taint) bool {
	return c.pendingTaintIndex(taints) >= 0
}

func pendingTaintIndex(taints []corev1.Taint) int {
	for index := range taints {
		if taints[index].Key == PendingTaintKey && taints[index].Value == "pending" && taints[index].Effect == corev1.TaintEffectNoSchedule {
			return index
		}
	}
	return -1
}

func (c *Controller) pendingTaintIndex(taints []corev1.Taint) int {
	for index := range taints {
		if taints[index].Key == c.pendingTaintKey() && taints[index].Value == "pending" && taints[index].Effect == corev1.TaintEffectNoSchedule {
			return index
		}
	}
	return -1
}

func probeName(attemptUID string) string {
	digest := sha256.Sum256([]byte(attemptUID))
	return "runtime-admit-" + hex.EncodeToString(digest[:8])
}

func newAttemptUID() (string, error) {
	value := make([]byte, 16)
	if _, err := rand.Read(value); err != nil {
		return "", fmt.Errorf("create runtime admission attempt identity: %w", err)
	}
	return hex.EncodeToString(value), nil
}

func probeFailureReason(pod *corev1.Pod) string {
	for _, status := range pod.Status.ContainerStatuses {
		if status.State.Terminated != nil {
			return fmt.Sprintf("probe exited %d: %s", status.State.Terminated.ExitCode, status.State.Terminated.Reason)
		}
	}
	return "probe Pod failed"
}

func probeWaitingReason(pod *corev1.Pod) string {
	for _, status := range pod.Status.ContainerStatuses {
		if status.State.Waiting != nil {
			return status.State.Waiting.Reason + ": " + status.State.Waiting.Message
		}
	}
	return "probe did not complete before its bounded deadline"
}

func boundedReason(reason string) string {
	reason = strings.TrimSpace(reason)
	if len(reason) > 512 {
		return reason[:512]
	}
	return reason
}

func (c *Controller) now() time.Time {
	if c.Now != nil {
		return c.Now().UTC()
	}
	return time.Now().UTC()
}

func (c *Controller) validate() error {
	if c.Kubernetes == nil || c.Dynamic == nil {
		return fmt.Errorf("Kubernetes and dynamic clients are required")
	}
	if c.Config.Namespace == "" || c.Config.CellName == "" || c.workloadName() == "" || c.Config.MachineSetName == "" {
		return fmt.Errorf("runtime node admission identities are required")
	}
	if c.workloadKind() != "StatefulSet" && c.workloadKind() != "Deployment" {
		return fmt.Errorf("runtime node admission workload kind must be StatefulSet or Deployment")
	}
	for name, value := range map[string]string{
		"workload container": c.workloadContainer(), "pool label": c.poolLabelKey(),
		"pool taint": c.poolTaintKey(), "pending taint": c.pendingTaintKey(),
		"admitted label": c.admittedLabel(), "phase label": c.phaseLabel(),
		"state annotation": c.stateAnnotation(), "drain annotation": c.drainAnnotation(),
		"profile version": c.profileVersion(), "probe component": c.probeComponent(),
	} {
		if value == "" {
			return fmt.Errorf("runtime node admission %s is required", name)
		}
	}
	if c.Config.BootstrapImage != "" && !immutableImage.MatchString(c.Config.BootstrapImage) {
		return fmt.Errorf("runtime node admission bootstrap image is not an immutable digest")
	}
	if c.Config.ProbeTimeout <= 0 || c.Config.RetryBackoff <= 0 {
		return fmt.Errorf("runtime node admission timeouts must be positive")
	}
	if c.Config.RequiredZones < 0 || c.Config.RequiredZones == 1 {
		return fmt.Errorf("runtime node admission required zones must be zero or at least two")
	}
	return nil
}

func (c *Controller) workloadKind() string {
	if c.Config.WorkloadKind != "" {
		return c.Config.WorkloadKind
	}
	return "StatefulSet"
}

func (c *Controller) workloadName() string {
	if c.Config.WorkloadName != "" {
		return c.Config.WorkloadName
	}
	return c.Config.StatefulSetName
}

func (c *Controller) workloadContainer() string {
	if c.Config.WorkloadContainer != "" {
		return c.Config.WorkloadContainer
	}
	return "workerd"
}

func (c *Controller) poolLabelKey() string {
	if c.Config.PoolLabelKey != "" {
		return c.Config.PoolLabelKey
	}
	return "fleet.actor.dev/runtime-pool"
}

func (c *Controller) poolTaintKey() string {
	if c.Config.PoolTaintKey != "" {
		return c.Config.PoolTaintKey
	}
	return "rivet.dev/compute"
}

func (c *Controller) poolTaintValue() string {
	if c.Config.PoolTaintValue != "" {
		return c.Config.PoolTaintValue
	}
	return "true"
}

func (c *Controller) pendingTaintKey() string {
	if c.Config.PendingTaintKey != "" {
		return c.Config.PendingTaintKey
	}
	return PendingTaintKey
}

func (c *Controller) admittedLabel() string {
	if c.Config.AdmittedLabel != "" {
		return c.Config.AdmittedLabel
	}
	return AdmittedLabel
}

func (c *Controller) phaseLabel() string {
	if c.Config.PhaseLabel != "" {
		return c.Config.PhaseLabel
	}
	return PhaseLabel
}

func (c *Controller) stateAnnotation() string {
	if c.Config.StateAnnotation != "" {
		return c.Config.StateAnnotation
	}
	return StateAnnotation
}

func (c *Controller) drainAnnotation() string {
	if c.Config.DrainAnnotation != "" {
		return c.Config.DrainAnnotation
	}
	return DrainAnnotation
}

func (c *Controller) profileVersion() string {
	if c.Config.ProfileVersion != "" {
		return c.Config.ProfileVersion
	}
	return ProfileVersion
}

func (c *Controller) profileDigest() string { return ProfileDigestFor(c.profileVersion()) }

func (c *Controller) probeComponent() string {
	if c.Config.ProbeComponent != "" {
		return c.Config.ProbeComponent
	}
	return ProbeComponent
}

func (c *Controller) logf(format string, arguments ...any) {
	if c.Logf != nil {
		c.Logf(format, arguments...)
	}
}

func escapeJSONPointer(value string) string {
	return strings.ReplaceAll(strings.ReplaceAll(value, "~", "~0"), "/", "~1")
}

func boolPointer(value bool) *bool    { return &value }
func int64Pointer(value int64) *int64 { return &value }
