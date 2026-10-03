package hostdrain

import (
	"context"
	"encoding/hex"
	"fmt"
	"sort"
	"strings"

	"github.com/rivet-dev/rivet/infra/cells/internal/runtimecapacity/admission"
	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/labels"
	"k8s.io/apimachinery/pkg/runtime/schema"
)

const runtimeMachineSetLabel = "node.tke.cloud.tencent.com/machineset"

// This is a conservative admission check for our dedicated one-Host-per-node
// template, not a second scheduler. Unknown hard constraints reject repair.
// Kubernetes still owns actual replacement placement and the FSM must observe
// a strict topology improvement before authorizing the next contraction.
func (c *Controller) rebalanceZones(ctx context.Context, workload *appsv1.StatefulSet, nodes *corev1.NodeList) ([]string, error) {
	if c.Dynamic == nil || nodes == nil || c.Config.MachineSetName == "" {
		return nil, fmt.Errorf("repair capacity clients or identity missing")
	}
	template := workload.Spec.Template
	if err := supportedRepairTemplate(template, c.Config.MachineSetName, c.Config.TopologyKey); err != nil {
		return nil, err
	}
	image := ""
	for _, container := range template.Spec.Containers {
		if container.Name == "workerd" {
			image = container.Image
		}
	}
	_, digest, pinned := strings.Cut(image, "@sha256:")
	_, digestErr := hex.DecodeString(digest)
	if !pinned || len(digest) != 64 || digestErr != nil {
		return nil, fmt.Errorf("repair requires pinned workerd image")
	}
	gvr := schema.GroupVersionResource{Group: "node.tke.cloud.tencent.com", Version: "v1beta1", Resource: "machinesets"}
	machineSet, err := c.Dynamic.Resource(gvr).Get(ctx, c.Config.MachineSetName, metav1.GetOptions{})
	if err != nil {
		return nil, err
	}
	if machineSet.GetUID() == "" || machineSet.GetDeletionTimestamp() != nil || machineSet.GetLabels()["fleet.actor.dev/cell-name"] != c.Config.CellName {
		return nil, fmt.Errorf("repair MachineSet identity is incomplete")
	}
	gvr.Resource = "machines"
	machines, err := c.Dynamic.Resource(gvr).List(ctx, metav1.ListOptions{LabelSelector: runtimeMachineSetLabel + "=" + c.Config.MachineSetName, Limit: 500})
	if err != nil {
		return nil, err
	}
	if machines.GetContinue() != "" || len(machines.Items) > 500 {
		return nil, fmt.Errorf("repair Machine evidence exceeds bounded inventory")
	}
	machineByNode := map[string]*unstructured.Unstructured{}
	for index := range machines.Items {
		machine := &machines.Items[index]
		name, found, err := unstructured.NestedString(machine.Object, "status", "nodeRef", "name")
		if err != nil {
			return nil, err
		}
		if !found || name == "" {
			continue
		}
		if machineByNode[name] != nil {
			return nil, fmt.Errorf("multiple Machines claim one repair Node")
		}
		machineByNode[name] = machine
	}
	pods, err := c.Kubernetes.CoreV1().Pods("").List(ctx, metav1.ListOptions{Limit: 5000})
	if err != nil {
		return nil, err
	}
	if pods.Continue != "" || len(pods.Items) > 5000 {
		return nil, fmt.Errorf("repair Pod evidence exceeds bounded inventory")
	}
	byNode := map[string][]*corev1.Pod{}
	for index := range pods.Items {
		pod := &pods.Items[index]
		if pod.Status.Phase == corev1.PodSucceeded || pod.Status.Phase == corev1.PodFailed {
			continue
		}
		// Cross-zone hard Pod anti-affinity is outside this dedicated-node
		// contract. Do not silently ignore an existing Pod's constraints.
		if pod.Spec.Affinity != nil && pod.Spec.Affinity.PodAntiAffinity != nil {
			for _, term := range pod.Spec.Affinity.PodAntiAffinity.RequiredDuringSchedulingIgnoredDuringExecution {
				if term.TopologyKey != corev1.LabelHostname {
					return nil, fmt.Errorf("unsupported existing hard anti-affinity")
				}
			}
		}
		byNode[pod.Spec.NodeName] = append(byNode[pod.Spec.NodeName], pod)
	}
	spread := template.Spec.TopologySpreadConstraints[0]
	selector, err := metav1.LabelSelectorAsSelector(spread.LabelSelector)
	if err != nil {
		return nil, err
	}
	counts := map[string]int32{}
	for index := range nodes.Items {
		node := &nodes.Items[index]
		if !matchesRepairNode(template.Spec, node) {
			continue
		}
		zone := node.Labels[c.Config.TopologyKey]
		if zone == "" {
			return nil, fmt.Errorf("eligible repair Node has no zone")
		}
		if _, ok := counts[zone]; !ok {
			counts[zone] = 0
		}
		for _, pod := range byNode[node.Name] {
			if pod.Namespace == workload.Namespace && pod.DeletionTimestamp == nil && selector.Matches(labels.Set(pod.Labels)) {
				counts[zone]++
			}
		}
	}
	if len(counts) != c.Config.RequiredZones {
		return nil, fmt.Errorf("repair eligible zone inventory does not match policy")
	}
	minimum := int32(5001)
	for _, count := range counts {
		if count < minimum {
			minimum = count
		}
	}
	if spread.MinDomains != nil && int32(len(counts)) < *spread.MinDomains {
		minimum = 0
	}
	wanted := conservativePodRequests(&corev1.Pod{Spec: template.Spec})
	zones := map[string]bool{}
	for index := range nodes.Items {
		node := &nodes.Items[index]
		machine := machineByNode[node.Name]
		if !matchesRepairNode(template.Spec, node) || !admittedRepairNode(node, machine, machineSet, c.Config.CellName, image) {
			continue
		}
		zone := node.Labels[c.Config.TopologyKey]
		if counts[zone]+1-minimum > spread.MaxSkew {
			continue
		}
		available := node.Status.Allocatable.DeepCopy()
		if available == nil {
			continue
		}
		usable := true
		for _, pod := range byNode[node.Name] {
			// Empty dedicated capacity may contain normal DaemonSets, never
			// another Host, arbitrary tenant Pod, or a terminating workload.
			owner := metav1.GetControllerOf(pod)
			if owner == nil || owner.Kind != "DaemonSet" || pod.DeletionTimestamp != nil || len(pod.Spec.ResourceClaims) > 0 ||
				(pod.Spec.Affinity != nil && pod.Spec.Affinity.PodAntiAffinity != nil && len(pod.Spec.Affinity.PodAntiAffinity.RequiredDuringSchedulingIgnoredDuringExecution) > 0) {
				usable = false
				break
			}
			for name, quantity := range conservativePodRequests(pod) {
				remaining := available[name]
				remaining.Sub(quantity)
				available[name] = remaining
			}
		}
		if !usable {
			continue
		}
		for name, quantity := range wanted {
			remaining := available[name]
			if remaining.Cmp(quantity) < 0 {
				usable = false
				break
			}
		}
		if usable {
			zones[zone] = true
		}
	}
	result := make([]string, 0, len(zones))
	for zone := range zones {
		result = append(result, zone)
	}
	sort.Strings(result)
	return result, nil
}

func supportedRepairTemplate(template corev1.PodTemplateSpec, machineSet, topologyKey string) error {
	spec := template.Spec
	if (spec.SchedulerName != "" && spec.SchedulerName != "default-scheduler") || spec.NodeName != "" || len(spec.SchedulingGates) > 0 || len(spec.ResourceClaims) > 0 ||
		spec.Affinity == nil || spec.Affinity.NodeAffinity == nil || spec.Affinity.NodeAffinity.RequiredDuringSchedulingIgnoredDuringExecution == nil {
		return fmt.Errorf("unsupported repair scheduling contract")
	}
	terms := spec.Affinity.NodeAffinity.RequiredDuringSchedulingIgnoredDuringExecution.NodeSelectorTerms
	if len(terms) == 0 {
		return fmt.Errorf("repair requires hard admitted MachineSet affinity")
	}
	for _, term := range terms {
		admitted, pool := false, false
		if len(term.MatchFields) > 0 || len(term.MatchExpressions) == 0 {
			return fmt.Errorf("unsupported repair node affinity")
		}
		for _, expression := range term.MatchExpressions {
			if expression.Operator != corev1.NodeSelectorOpIn || len(expression.Values) == 0 {
				return fmt.Errorf("unsupported repair node affinity operator")
			}
			if expression.Key == admission.AdmittedLabel && len(expression.Values) == 1 && expression.Values[0] == "true" {
				admitted = true
			}
			if expression.Key == runtimeMachineSetLabel && len(expression.Values) == 1 && expression.Values[0] == machineSet {
				pool = true
			}
		}
		if !admitted || !pool {
			return fmt.Errorf("every affinity branch must bind admitted MachineSet")
		}
	}
	toleratesCompute := false
	for _, toleration := range spec.Tolerations {
		if toleration.Key == "rivet.dev/compute" && toleration.Value == "true" &&
			(toleration.Operator == corev1.TolerationOpEqual || toleration.Operator == "") && toleration.Effect == corev1.TaintEffectNoSchedule {
			toleratesCompute = true
		}
	}
	if !toleratesCompute {
		return fmt.Errorf("repair template must tolerate dedicated compute taint")
	}
	if spec.Affinity.PodAffinity != nil && len(spec.Affinity.PodAffinity.RequiredDuringSchedulingIgnoredDuringExecution) > 0 {
		return fmt.Errorf("unsupported repair Pod affinity")
	}
	if spec.Affinity.PodAntiAffinity == nil || len(spec.Affinity.PodAntiAffinity.RequiredDuringSchedulingIgnoredDuringExecution) != 1 {
		return fmt.Errorf("repair requires one hostname anti-affinity term")
	}
	term := spec.Affinity.PodAntiAffinity.RequiredDuringSchedulingIgnoredDuringExecution[0]
	if term.TopologyKey != corev1.LabelHostname || term.NamespaceSelector != nil || len(term.Namespaces) > 0 || len(term.MatchLabelKeys) > 0 || len(term.MismatchLabelKeys) > 0 {
		return fmt.Errorf("unsupported repair Pod anti-affinity")
	}
	selector, err := metav1.LabelSelectorAsSelector(term.LabelSelector)
	if err != nil || !selector.Matches(labels.Set(template.Labels)) {
		return fmt.Errorf("repair anti-affinity does not select Hosts")
	}
	if len(spec.TopologySpreadConstraints) != 1 {
		return fmt.Errorf("repair requires one hard zone spread")
	}
	spread := spec.TopologySpreadConstraints[0]
	if spread.TopologyKey != topologyKey || spread.WhenUnsatisfiable != corev1.DoNotSchedule || spread.MaxSkew < 1 || len(spread.MatchLabelKeys) > 0 ||
		(spread.NodeAffinityPolicy != nil && *spread.NodeAffinityPolicy != corev1.NodeInclusionPolicyHonor) ||
		(spread.NodeTaintsPolicy != nil && *spread.NodeTaintsPolicy != corev1.NodeInclusionPolicyIgnore) {
		return fmt.Errorf("unsupported repair zone spread")
	}
	selector, err = metav1.LabelSelectorAsSelector(spread.LabelSelector)
	if err != nil || !selector.Matches(labels.Set(template.Labels)) {
		return fmt.Errorf("repair spread does not select Hosts")
	}
	for _, volume := range spec.Volumes {
		if volume.PersistentVolumeClaim != nil || volume.Ephemeral != nil {
			return fmt.Errorf("repair cannot predict volume scheduling")
		}
	}
	for _, container := range append(append([]corev1.Container(nil), spec.Containers...), spec.InitContainers...) {
		for _, port := range container.Ports {
			if port.HostPort != 0 {
				return fmt.Errorf("repair cannot predict host port scheduling")
			}
		}
	}
	return nil
}

func matchesRepairNode(spec corev1.PodSpec, node *corev1.Node) bool {
	for key, value := range spec.NodeSelector {
		if node.Labels[key] != value {
			return false
		}
	}
	for _, term := range spec.Affinity.NodeAffinity.RequiredDuringSchedulingIgnoredDuringExecution.NodeSelectorTerms {
		matches := true
		for _, expression := range term.MatchExpressions {
			found := false
			for _, value := range expression.Values {
				found = found || node.Labels[expression.Key] == value
			}
			matches = matches && found
		}
		if matches {
			return true
		}
	}
	return false
}

func admittedRepairNode(node *corev1.Node, machine, machineSet *unstructured.Unstructured, cell, image string) bool {
	if node.UID == "" || node.Spec.ProviderID == "" || node.DeletionTimestamp != nil || node.Spec.Unschedulable || node.Labels["fleet.actor.dev/cell-name"] != cell ||
		node.Annotations[admission.DrainAnnotation] != "" || machine == nil || machine.GetUID() == "" || machine.GetDeletionTimestamp() != nil ||
		machine.GetLabels()[runtimeMachineSetLabel] != machineSet.GetName() {
		return false
	}
	ready := false
	for _, condition := range node.Status.Conditions {
		if condition.Type == corev1.NodeReady {
			ready = condition.Status == corev1.ConditionTrue
		}
		if condition.Status == corev1.ConditionTrue && (condition.Type == corev1.NodeMemoryPressure || condition.Type == corev1.NodeDiskPressure || condition.Type == corev1.NodePIDPressure || condition.Type == corev1.NodeNetworkUnavailable) {
			return false
		}
	}
	if !ready {
		return false
	}
	// The sole accepted taint is our compute dedication. Unknown NoSchedule,
	// NoExecute and even soft taints are conservatively not spare capacity.
	for _, taint := range node.Spec.Taints {
		if taint.Key != "rivet.dev/compute" || taint.Value != "true" || taint.Effect != corev1.TaintEffectNoSchedule {
			return false
		}
	}
	raw := node.Annotations[admission.StateAnnotation]
	if len(raw) > 16*1024 {
		return false
	}
	state, err := admission.DecodeState(raw)
	return err == nil && state.Phase == admission.PhaseAdmitted && state.Identity == (admission.Identity{
		NodeUID: string(node.UID), ProviderID: node.Spec.ProviderID, MachineUID: string(machine.GetUID()), MachineSetUID: string(machineSet.GetUID()), ProfileDigest: admission.ProfileDigest(), RuntimeImage: image,
	})
}

// Summing all init containers (including restartable init sidecars) deliberately
// overestimates simultaneous demand. Account for both desired and allocated
// container resources during resize, Pod-level requests and Pod overhead.
func conservativePodRequests(pod *corev1.Pod) corev1.ResourceList {
	result := corev1.ResourceList{}
	statuses := map[string]corev1.ContainerStatus{}
	for _, status := range append(append([]corev1.ContainerStatus(nil), pod.Status.ContainerStatuses...), pod.Status.InitContainerStatuses...) {
		statuses[status.Name] = status
	}
	for _, container := range append(append([]corev1.Container(nil), pod.Spec.Containers...), pod.Spec.InitContainers...) {
		requests := container.Resources.Requests.DeepCopy()
		if requests == nil {
			requests = corev1.ResourceList{}
		}
		status := statuses[container.Name]
		allocated := status.AllocatedResources.DeepCopy()
		if status.Resources != nil {
			for name, quantity := range status.Resources.Requests {
				if allocated == nil {
					allocated = corev1.ResourceList{}
				}
				old := allocated[name]
				if quantity.Cmp(old) > 0 {
					allocated[name] = quantity.DeepCopy()
				}
			}
		}
		for name, quantity := range allocated {
			old := requests[name]
			if quantity.Cmp(old) > 0 {
				requests[name] = quantity.DeepCopy()
			}
		}
		for name, quantity := range requests {
			total := result[name]
			total.Add(quantity)
			result[name] = total
		}
	}
	if pod.Spec.Resources != nil {
		for name, quantity := range pod.Spec.Resources.Requests {
			total := result[name]
			if quantity.Cmp(total) > 0 {
				result[name] = quantity.DeepCopy()
			}
		}
	}
	for name, quantity := range pod.Spec.Overhead {
		total := result[name]
		total.Add(quantity)
		result[name] = total
	}
	podCount := result[corev1.ResourcePods]
	podCount.Set(1)
	result[corev1.ResourcePods] = podCount
	return result
}
