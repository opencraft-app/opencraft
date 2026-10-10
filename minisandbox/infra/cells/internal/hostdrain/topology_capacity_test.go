package hostdrain

import (
	"context"
	"fmt"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/rivet-dev/rivet/infra/cells/internal/runtimecapacity/admission"
	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	dynamicfake "k8s.io/client-go/dynamic/fake"
	"k8s.io/client-go/kubernetes/fake"
	ktesting "k8s.io/client-go/testing"
)

func capacityObjects(t *testing.T) (*Controller, *appsv1.StatefulSet, *corev1.NodeList, []*unstructured.Unstructured, []runtime.Object) {
	t.Helper()
	const image = "registry.example/actor-fleet/rivet-runtime@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	workload := &appsv1.StatefulSet{ObjectMeta: metav1.ObjectMeta{Name: "runtime", Namespace: "cell", UID: "workload-uid"}}
	selector := &metav1.LabelSelector{MatchLabels: map[string]string{"app": "runtime"}}
	workload.Spec.Template = corev1.PodTemplateSpec{
		ObjectMeta: metav1.ObjectMeta{Labels: selector.MatchLabels},
		Spec: corev1.PodSpec{
			Containers: []corev1.Container{{Name: "workerd", Image: image, Resources: corev1.ResourceRequirements{Requests: corev1.ResourceList{corev1.ResourceCPU: resource.MustParse("1"), corev1.ResourceMemory: resource.MustParse("512Mi")}}}},
			Affinity: &corev1.Affinity{
				NodeAffinity: &corev1.NodeAffinity{RequiredDuringSchedulingIgnoredDuringExecution: &corev1.NodeSelector{NodeSelectorTerms: []corev1.NodeSelectorTerm{{MatchExpressions: []corev1.NodeSelectorRequirement{
					{Key: admission.AdmittedLabel, Operator: corev1.NodeSelectorOpIn, Values: []string{"true"}},
					{Key: runtimeMachineSetLabel, Operator: corev1.NodeSelectorOpIn, Values: []string{"np-runtime0"}},
				}}}}},
				PodAntiAffinity: &corev1.PodAntiAffinity{RequiredDuringSchedulingIgnoredDuringExecution: []corev1.PodAffinityTerm{{TopologyKey: corev1.LabelHostname, LabelSelector: selector}}},
			},
			Tolerations:               []corev1.Toleration{{Key: "rivet.dev/compute", Operator: corev1.TolerationOpEqual, Value: "true", Effect: corev1.TaintEffectNoSchedule}},
			TopologySpreadConstraints: []corev1.TopologySpreadConstraint{{TopologyKey: corev1.LabelTopologyZone, MaxSkew: 1, WhenUnsatisfiable: corev1.DoNotSchedule, LabelSelector: selector}},
		},
	}
	machineSet := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "node.tke.cloud.tencent.com/v1beta1", "kind": "MachineSet",
		"metadata": map[string]any{"name": "np-runtime0", "uid": "machineset-uid", "labels": map[string]any{"fleet.actor.dev/cell-name": "cell"}},
	}}
	machines := []*unstructured.Unstructured{machineSet}
	nodes := &corev1.NodeList{}
	var pods []runtime.Object
	for zoneIndex, zone := range []string{"zone-a", "zone-b", "zone-c"} {
		for slot := 0; slot < 2; slot++ {
			name := fmt.Sprintf("node-%s-%d", zone, slot)
			machine := &unstructured.Unstructured{Object: map[string]any{
				"apiVersion": "node.tke.cloud.tencent.com/v1beta1", "kind": "Machine",
				"metadata": map[string]any{"name": "machine-" + name, "uid": "machine-uid-" + name, "labels": map[string]any{runtimeMachineSetLabel: "np-runtime0"}},
				"status":   map[string]any{"nodeRef": map[string]any{"name": name}},
			}}
			machines = append(machines, machine)
			node := corev1.Node{
				ObjectMeta: metav1.ObjectMeta{Name: name, UID: types.UID("uid-" + name), Labels: map[string]string{runtimeMachineSetLabel: "np-runtime0", admission.AdmittedLabel: "true", "fleet.actor.dev/cell-name": "cell", corev1.LabelTopologyZone: zone, corev1.LabelHostname: name}},
				Spec:       corev1.NodeSpec{ProviderID: "provider-" + name, Taints: []corev1.Taint{{Key: "rivet.dev/compute", Value: "true", Effect: corev1.TaintEffectNoSchedule}}},
				Status:     corev1.NodeStatus{Conditions: []corev1.NodeCondition{{Type: corev1.NodeReady, Status: corev1.ConditionTrue}}, Allocatable: corev1.ResourceList{corev1.ResourceCPU: resource.MustParse("4"), corev1.ResourceMemory: resource.MustParse("4Gi"), corev1.ResourcePods: resource.MustParse("20")}},
			}
			encoded, err := admission.EncodeState(admission.State{Phase: admission.PhaseAdmitted, TransitionAt: time.Now().UTC(), Identity: admission.Identity{
				NodeUID: string(node.UID), ProviderID: node.Spec.ProviderID, MachineUID: string(machine.GetUID()), MachineSetUID: string(machineSet.GetUID()), ProfileDigest: admission.ProfileDigest(), RuntimeImage: image,
			}})
			if err != nil {
				t.Fatal(err)
			}
			node.Annotations = map[string]string{admission.StateAnnotation: encoded}
			nodes.Items = append(nodes.Items, node)
			if slot == 0 {
				pods = append(pods, &corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: fmt.Sprintf("runtime-%d", zoneIndex), Namespace: "cell", UID: types.UID("host-" + name), Labels: selector.MatchLabels, OwnerReferences: hostOwnerReferences(workload)}, Spec: corev1.PodSpec{NodeName: name}, Status: corev1.PodStatus{Phase: corev1.PodRunning}})
			}
		}
	}
	controller := &Controller{Config: ControllerConfig{Namespace: "cell", CellName: "cell", TopologyKey: corev1.LabelTopologyZone, RequiredZones: 3, MachineSetName: "np-runtime0", TopologyRepairEnabled: true}}
	resetCapacityClients(controller, machines, pods)
	return controller, workload, nodes, machines, pods
}

func resetCapacityClients(controller *Controller, machines []*unstructured.Unstructured, pods []runtime.Object) {
	objects := make([]runtime.Object, len(machines))
	for index, machine := range machines {
		objects[index] = machine
	}
	controller.Dynamic = dynamicfake.NewSimpleDynamicClientWithCustomListKinds(runtime.NewScheme(), map[schema.GroupVersionResource]string{
		{Group: "node.tke.cloud.tencent.com", Version: "v1beta1", Resource: "machines"}: "MachineList",
	}, objects...)
	controller.Kubernetes = fake.NewSimpleClientset(pods...)
}

func TestRepairCapacityRequiresExactCurrentAdmissionAndFreeDedicatedNode(t *testing.T) {
	controller, workload, nodes, _, _ := capacityObjects(t)
	zones, err := controller.rebalanceZones(context.Background(), workload, nodes)
	if err != nil || !reflect.DeepEqual(zones, []string{"zone-a", "zone-b", "zone-c"}) {
		t.Fatalf("spare zones=%v err=%v", zones, err)
	}
	for _, test := range []struct {
		name   string
		mutate func(*corev1.Node)
	}{
		{"Node replaced", func(n *corev1.Node) { n.UID = "replacement" }},
		{"provider changed", func(n *corev1.Node) { n.Spec.ProviderID = "replacement-provider" }},
		{"draining", func(n *corev1.Node) { n.Annotations[admission.DrainAnnotation] = "owned-drain" }},
		{"unschedulable", func(n *corev1.Node) { n.Spec.Unschedulable = true }},
		{"not Ready", func(n *corev1.Node) { n.Status.Conditions = nil }},
		{"pressure", func(n *corev1.Node) {
			n.Status.Conditions = append(n.Status.Conditions, corev1.NodeCondition{Type: corev1.NodeMemoryPressure, Status: corev1.ConditionTrue})
		}},
		{"pending taint", func(n *corev1.Node) {
			n.Spec.Taints = append(n.Spec.Taints, corev1.Taint{Key: admission.PendingTaintKey, Effect: corev1.TaintEffectNoSchedule})
		}},
		{"stale image", func(n *corev1.Node) {
			n.Annotations[admission.StateAnnotation] = strings.Replace(n.Annotations[admission.StateAnnotation], strings.Repeat("a", 64), strings.Repeat("b", 64), 1)
		}},
		{"missing proof", func(n *corev1.Node) { n.Annotations = nil }},
		{"different Cell", func(n *corev1.Node) { n.Labels["fleet.actor.dev/cell-name"] = "another" }},
	} {
		t.Run(test.name, func(t *testing.T) {
			copy := nodes.DeepCopy()
			test.mutate(&copy.Items[1])
			zones, err := controller.rebalanceZones(context.Background(), workload, copy)
			if err != nil || !reflect.DeepEqual(zones, []string{"zone-b", "zone-c"}) {
				t.Fatalf("unsafe spare zones=%v err=%v", zones, err)
			}
		})
	}
}

func TestRepairCapacityRejectsChangedMachineAndMachineSetIdentities(t *testing.T) {
	for _, which := range []string{"Machine", "MachineSet", "duplicate Node"} {
		t.Run(which, func(t *testing.T) {
			controller, workload, nodes, machines, pods := capacityObjects(t)
			if which == "Machine" {
				machines[2].SetUID("replacement-machine")
			}
			if which == "MachineSet" {
				machines[0].SetUID("replacement-machineset")
			}
			if which == "duplicate Node" {
				copy := machines[2].DeepCopy()
				copy.SetName("duplicate-machine")
				machines = append(machines, copy)
			}
			resetCapacityClients(controller, machines, pods)
			zones, err := controller.rebalanceZones(context.Background(), workload, nodes)
			if which == "duplicate Node" {
				if err == nil {
					t.Fatal("ambiguous Machine inventory accepted")
				}
				return
			}
			expected := []string{"zone-b", "zone-c"}
			if which == "MachineSet" {
				expected = []string{}
			}
			if err != nil || !reflect.DeepEqual(zones, expected) {
				t.Fatalf("zones=%v err=%v", zones, err)
			}
		})
	}
}

func TestRepairCapacityAccountsForDaemonSetRequestsAndRejectsArbitraryOccupants(t *testing.T) {
	for _, which := range []string{"small daemon", "large daemon", "arbitrary Pod", "Pod slots full"} {
		t.Run(which, func(t *testing.T) {
			controller, workload, nodes, machines, pods := capacityObjects(t)
			controlled := true
			pod := &corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: "daemon", Namespace: "system", OwnerReferences: []metav1.OwnerReference{{Kind: "DaemonSet", Controller: &controlled}}},
				Spec: corev1.PodSpec{NodeName: nodes.Items[1].Name, Containers: []corev1.Container{{Resources: corev1.ResourceRequirements{Requests: corev1.ResourceList{corev1.ResourceCPU: resource.MustParse("500m")}}}}}, Status: corev1.PodStatus{Phase: corev1.PodRunning}}
			if which == "large daemon" {
				pod.Spec.Containers[0].Resources.Requests[corev1.ResourceCPU] = resource.MustParse("4")
			}
			if which == "arbitrary Pod" {
				pod.OwnerReferences = nil
			}
			if which == "Pod slots full" {
				nodes.Items[1].Status.Allocatable[corev1.ResourcePods] = resource.MustParse("1")
			}
			pods = append(pods, pod)
			resetCapacityClients(controller, machines, pods)
			zones, err := controller.rebalanceZones(context.Background(), workload, nodes)
			expected := []string{"zone-b", "zone-c"}
			if which == "small daemon" {
				expected = []string{"zone-a", "zone-b", "zone-c"}
			}
			if err != nil || !reflect.DeepEqual(zones, expected) {
				t.Fatalf("zones=%v err=%v", zones, err)
			}
		})
	}
}

func TestRepairTemplateUnknownHardConstraintsFailClosed(t *testing.T) {
	for _, mutate := range []func(*corev1.PodTemplateSpec){
		func(p *corev1.PodTemplateSpec) { p.Spec.Tolerations = nil },
		func(p *corev1.PodTemplateSpec) { p.Spec.SchedulerName = "custom" },
		func(p *corev1.PodTemplateSpec) {
			p.Spec.Affinity.NodeAffinity.RequiredDuringSchedulingIgnoredDuringExecution.NodeSelectorTerms = append(p.Spec.Affinity.NodeAffinity.RequiredDuringSchedulingIgnoredDuringExecution.NodeSelectorTerms, corev1.NodeSelectorTerm{})
		},
		func(p *corev1.PodTemplateSpec) {
			p.Spec.Affinity.PodAntiAffinity.RequiredDuringSchedulingIgnoredDuringExecution[0].TopologyKey = corev1.LabelTopologyZone
		},
		func(p *corev1.PodTemplateSpec) {
			p.Spec.Volumes = append(p.Spec.Volumes, corev1.Volume{VolumeSource: corev1.VolumeSource{PersistentVolumeClaim: &corev1.PersistentVolumeClaimVolumeSource{ClaimName: "disk"}}})
		},
		func(p *corev1.PodTemplateSpec) { p.Spec.Containers[0].Ports = []corev1.ContainerPort{{HostPort: 8080}} },
	} {
		controller, workload, nodes, _, _ := capacityObjects(t)
		mutate(&workload.Spec.Template)
		if _, err := controller.rebalanceZones(context.Background(), workload, nodes); err == nil {
			t.Fatal("unsupported scheduler contract accepted")
		}
	}
}

func TestConservativeRequestsIncludeResizeInitAndOverhead(t *testing.T) {
	pod := &corev1.Pod{Spec: corev1.PodSpec{
		Containers:     []corev1.Container{{Name: "app", Resources: corev1.ResourceRequirements{Requests: corev1.ResourceList{corev1.ResourceCPU: resource.MustParse("1")}}}},
		InitContainers: []corev1.Container{{Name: "init", Resources: corev1.ResourceRequirements{Requests: corev1.ResourceList{corev1.ResourceCPU: resource.MustParse("1")}}}},
		Overhead:       corev1.ResourceList{corev1.ResourceCPU: resource.MustParse("100m")},
	}, Status: corev1.PodStatus{ContainerStatuses: []corev1.ContainerStatus{{Name: "app", AllocatedResources: corev1.ResourceList{corev1.ResourceCPU: resource.MustParse("2")}}}}}
	requests := conservativePodRequests(pod)
	cpu := requests[corev1.ResourceCPU]
	if cpu.MilliValue() != 3100 {
		t.Fatalf("CPU request=%s", cpu.String())
	}
}

func TestRepairCapacityRejectsPartialInventoriesAndUnavailableAPI(t *testing.T) {
	for _, which := range []string{"partial Machines", "partial Pods", "failed Pods"} {
		t.Run(which, func(t *testing.T) {
			controller, workload, nodes, _, _ := capacityObjects(t)
			if which == "partial Machines" {
				controller.Dynamic.(*dynamicfake.FakeDynamicClient).PrependReactor("list", "machines", func(a ktesting.Action) (bool, runtime.Object, error) {
					return true, &unstructured.UnstructuredList{Object: map[string]any{"metadata": map[string]any{"continue": "another-page"}}}, nil
				})
			} else {
				controller.Kubernetes.(*fake.Clientset).PrependReactor("list", "pods", func(a ktesting.Action) (bool, runtime.Object, error) {
					if which == "failed Pods" {
						return true, nil, fmt.Errorf("API unavailable")
					}
					return true, &corev1.PodList{ListMeta: metav1.ListMeta{Continue: "another-page"}}, nil
				})
			}
			if _, err := controller.rebalanceZones(context.Background(), workload, nodes); err == nil {
				t.Fatal("incomplete capacity proof accepted")
			}
		})
	}
}

func TestRepairCapacityRespectsEligibleZoneSpread(t *testing.T) {
	controller, workload, nodes, machines, pods := capacityObjects(t)
	for index := 0; index < 3; index++ {
		pods = append(pods, &corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: fmt.Sprintf("extra-%d", index), Namespace: "cell", Labels: map[string]string{"app": "runtime"}}, Spec: corev1.PodSpec{NodeName: nodes.Items[0].Name}})
	}
	resetCapacityClients(controller, machines, pods)
	zones, err := controller.rebalanceZones(context.Background(), workload, nodes)
	if err != nil || !reflect.DeepEqual(zones, []string{"zone-b", "zone-c"}) {
		t.Fatalf("skewed zone was offered as repair destination: %v %v", zones, err)
	}
}
