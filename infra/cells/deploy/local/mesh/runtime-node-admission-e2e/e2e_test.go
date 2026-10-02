package runtimenodeadmissione2e

import (
	"context"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/tools/clientcmd"
	"k8s.io/client-go/util/retry"

	"github.com/rivet-dev/rivet/infra/cells/internal/runtimecapacity"
	"github.com/rivet-dev/rivet/infra/cells/internal/runtimecapacity/admission"
)

var (
	machineSetResource = schema.GroupVersionResource{Group: "node.tke.cloud.tencent.com", Version: "v1beta1", Resource: "machinesets"}
	machineResource    = schema.GroupVersionResource{Group: "node.tke.cloud.tencent.com", Version: "v1beta1", Resource: "machines"}
)

const runtimeImage = "registry.invalid/runtime@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

type fixture struct {
	t          *testing.T
	ctx        context.Context
	kube       kubernetes.Interface
	dynamic    dynamic.Interface
	namespace  string
	cell       string
	machineSet string
	base       time.Time
}

func TestRuntimeNodeAdmissionK3S(t *testing.T) {
	if os.Getenv("RUNTIME_ADMISSION_K3S_E2E") != "1" {
		t.Skip("run through run.sh against its isolated k3d cluster")
	}
	config, err := clientcmd.BuildConfigFromFlags("", os.Getenv("KUBECONFIG"))
	if err != nil {
		t.Fatal(err)
	}
	kube, err := kubernetes.NewForConfig(config)
	if err != nil {
		t.Fatal(err)
	}
	dynamicClient, err := dynamic.NewForConfig(config)
	if err != nil {
		t.Fatal(err)
	}
	suffix := fmt.Sprintf("%d", time.Now().UnixNano())
	f := &fixture{
		t: t, ctx: context.Background(), kube: kube, dynamic: dynamicClient,
		namespace: "runtime-admission-" + suffix, cell: "cell-" + suffix,
		machineSet: "runtime-" + suffix, base: time.Date(2026, 9, 4, 12, 0, 0, 0, time.UTC),
	}
	f.install()
	defer f.cleanup()

	t.Run("restart and replacement identity", f.restartAndReplacement)
	t.Run("fleet-wide registry failure", f.registryFailure)
}

func (f *fixture) install() {
	_, err := f.kube.CoreV1().Namespaces().Create(f.ctx, &corev1.Namespace{
		ObjectMeta: metav1.ObjectMeta{Name: f.namespace},
	}, metav1.CreateOptions{})
	if err != nil {
		f.t.Fatal(err)
	}
	machineSet := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "node.tke.cloud.tencent.com/v1beta1", "kind": "MachineSet",
		"metadata": map[string]any{"name": f.machineSet},
		"spec": map[string]any{
			"replicas":     int64(3),
			"deletePolicy": "Newest",
			"scaling":      map[string]any{"minReplicas": int64(3), "maxReplicas": int64(6)},
			"template": map[string]any{"spec": map[string]any{
				"metadata": map[string]any{"labels": map[string]any{
					"fleet.actor.dev/cell-name": f.cell, "fleet.actor.dev/runtime-pool": "true",
				}},
				"taints": []any{map[string]any{"key": admission.PendingTaintKey, "value": "pending", "effect": "NoSchedule"}},
			}},
		},
	}}
	if _, err := f.dynamic.Resource(machineSetResource).Create(f.ctx, machineSet, metav1.CreateOptions{}); err != nil {
		f.t.Fatal(err)
	}
	zero := int32(0)
	_, err = f.kube.AppsV1().StatefulSets(f.namespace).Create(f.ctx, &appsv1.StatefulSet{
		ObjectMeta: metav1.ObjectMeta{Name: f.cell + "-runtime-hosts", Namespace: f.namespace, Labels: map[string]string{"fleet.actor.dev/cell-name": f.cell}},
		Spec: appsv1.StatefulSetSpec{
			Replicas: &zero, ServiceName: "unused",
			Selector: &metav1.LabelSelector{MatchLabels: map[string]string{"app": "workerd"}},
			Template: corev1.PodTemplateSpec{
				ObjectMeta: metav1.ObjectMeta{Labels: map[string]string{"app": "workerd"}},
				Spec: corev1.PodSpec{
					NodeSelector: map[string]string{"runtime-admission-e2e.invalid/never": "true"},
					Containers:   []corev1.Container{{Name: "workerd", Image: runtimeImage}},
				},
			},
		},
	}, metav1.CreateOptions{})
	if err != nil {
		f.t.Fatal(err)
	}
}

func (f *fixture) controller(now time.Time) *admission.Controller {
	return &admission.Controller{
		Kubernetes: f.kube,
		Dynamic:    f.dynamic,
		Config: admission.ControllerConfig{
			Namespace: f.namespace, CellName: f.cell, StatefulSetName: f.cell + "-runtime-hosts", MachineSetName: f.machineSet,
			ImagePullSecret: "unused", ProbeTimeout: 5 * time.Minute, RetryBackoff: time.Minute, ReconcileInterval: time.Second,
		},
		Now: func() time.Time { return now },
	}
}

func (f *fixture) createPair(index int, stale map[string]string) *corev1.Node {
	name := fmt.Sprintf("%s-node-%d", f.machineSet, index)
	labels := map[string]string{
		"node.tke.cloud.tencent.com/machineset": f.machineSet,
		"fleet.actor.dev/cell-name":             f.cell,
		"rivet.dev/compute":                     "true",
	}
	for key, value := range stale {
		if key == admission.AdmittedLabel {
			labels[key] = value
		}
	}
	node, err := f.kube.CoreV1().Nodes().Create(f.ctx, &corev1.Node{
		ObjectMeta: metav1.ObjectMeta{Name: name, Labels: labels, Annotations: stale},
		Spec: corev1.NodeSpec{
			ProviderID: "qcloud://" + name,
			Taints: []corev1.Taint{
				{Key: "rivet.dev/compute", Value: "true", Effect: corev1.TaintEffectNoSchedule},
				{Key: admission.PendingTaintKey, Value: "pending", Effect: corev1.TaintEffectNoSchedule},
			},
		},
	}, metav1.CreateOptions{})
	if err != nil {
		f.t.Fatal(err)
	}
	node = f.markNodeReady(node.Name)
	machine := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "node.tke.cloud.tencent.com/v1beta1", "kind": "Machine",
		"metadata": map[string]any{
			"name":   fmt.Sprintf("%s-machine-%d", f.machineSet, index),
			"labels": map[string]any{"node.t.k8s.io/instance-id": name, "node.tke.cloud.tencent.com/machineset": f.machineSet},
		},
		"status": map[string]any{"nodeRef": map[string]any{"name": name}},
	}}
	created, err := f.dynamic.Resource(machineResource).Create(f.ctx, machine, metav1.CreateOptions{})
	if err != nil {
		f.t.Fatal(err)
	}
	created.Object["status"] = machine.Object["status"]
	if _, err := f.dynamic.Resource(machineResource).UpdateStatus(f.ctx, created, metav1.UpdateOptions{}); err != nil {
		f.t.Fatal(err)
	}
	return node
}

func (f *fixture) restartAndReplacement(t *testing.T) {
	f.t = t
	node := f.createPair(1, nil)
	controller := f.controller(f.base)
	results, err := controller.ReconcileOnce(f.ctx)
	if err != nil || len(results) != 1 || (results[0].Action != "create-probe" && results[0].Action != "adopt-probe-identity") {
		t.Fatalf("create probe: results=%#v err=%v", results, err)
	}
	state := f.state(node.Name)
	if state.Phase != admission.PhaseProbing || state.Identity.NodeUID != string(node.UID) || state.ProbePodName == "" {
		t.Fatalf("initial Node did not retain one exact fenced probe: %#v", state)
	}
	probe := f.probe(state.ProbePodName)
	probe.Status.Phase = corev1.PodSucceeded
	if _, err := f.kube.CoreV1().Pods(f.namespace).UpdateStatus(f.ctx, probe, metav1.UpdateOptions{}); err != nil {
		t.Fatal(err)
	}
	restarted := f.controller(f.base)
	results, err = restarted.ReconcileOnce(f.ctx)
	if err != nil || results[0].Action != "admit-node" {
		t.Fatalf("restart did not consume exact persisted probe: results=%#v err=%v", results, err)
	}
	admitted, err := f.kube.CoreV1().Nodes().Get(f.ctx, node.Name, metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	admitted.Status.Conditions = []corev1.NodeCondition{{Type: corev1.NodeReady, Status: corev1.ConditionFalse}}
	if _, err := f.kube.CoreV1().Nodes().UpdateStatus(f.ctx, admitted, metav1.UpdateOptions{}); err != nil {
		t.Fatal(err)
	}
	results, err = restarted.ReconcileOnce(f.ctx)
	if err != nil || results[0].Phase != admission.PhaseSuspect || results[0].Action != "fence-suspect-node" {
		t.Fatalf("admitted Node fault was not fenced: results=%#v err=%v", results, err)
	}
	f.markNodeReady(node.Name)
	results, err = restarted.ReconcileOnce(f.ctx)
	if err != nil || results[0].Phase != admission.PhaseAdmitted || results[0].Action != "restore-admission-fields" {
		t.Fatalf("transient admitted Node fault did not recover: results=%#v err=%v", results, err)
	}
	admitted, err = f.kube.CoreV1().Nodes().Get(f.ctx, node.Name, metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	stale := map[string]string{
		admission.StateAnnotation: admitted.Annotations[admission.StateAnnotation],
		admission.AdmittedLabel:   admitted.Labels[admission.AdmittedLabel],
	}
	oldUID := admitted.UID
	if err := f.kube.CoreV1().Nodes().Delete(f.ctx, node.Name, metav1.DeleteOptions{}); err != nil {
		t.Fatal(err)
	}
	f.waitNodeAbsent(node.Name)
	replacement := f.createNodeOnly(1, stale)
	if replacement.UID == oldUID {
		t.Fatal("replacement Node reused the deleted UID")
	}
	results, err = restarted.ReconcileOnce(f.ctx)
	if err != nil || (results[0].Action != "create-probe" && results[0].Action != "adopt-probe-identity") {
		t.Fatalf("replacement Node inherited stale evidence: results=%#v err=%v", results, err)
	}
	state = f.state(replacement.Name)
	if state.Identity.NodeUID != string(replacement.UID) || state.Phase != admission.PhaseProbing {
		t.Fatalf("replacement did not receive a fresh attempt: %#v", state)
	}
}

func (f *fixture) createNodeOnly(index int, stale map[string]string) *corev1.Node {
	name := fmt.Sprintf("%s-node-%d", f.machineSet, index)
	labels := map[string]string{
		"node.tke.cloud.tencent.com/machineset": f.machineSet,
		"fleet.actor.dev/cell-name":             f.cell,
		"rivet.dev/compute":                     "true",
	}
	if value := stale[admission.AdmittedLabel]; value != "" {
		labels[admission.AdmittedLabel] = value
	}
	annotations := map[string]string{}
	if value := stale[admission.StateAnnotation]; value != "" {
		annotations[admission.StateAnnotation] = value
	}
	node, err := f.kube.CoreV1().Nodes().Create(f.ctx, &corev1.Node{
		ObjectMeta: metav1.ObjectMeta{Name: name, Labels: labels, Annotations: annotations},
		Spec: corev1.NodeSpec{
			ProviderID: "qcloud://" + name,
			Taints: []corev1.Taint{
				{Key: "rivet.dev/compute", Value: "true", Effect: corev1.TaintEffectNoSchedule},
				{Key: admission.PendingTaintKey, Value: "pending", Effect: corev1.TaintEffectNoSchedule},
			},
		},
	}, metav1.CreateOptions{})
	if err != nil {
		f.t.Fatal(err)
	}
	node = f.markNodeReady(node.Name)
	return node
}

func (f *fixture) markNodeReady(name string) *corev1.Node {
	var updated *corev1.Node
	err := retry.RetryOnConflict(retry.DefaultBackoff, func() error {
		node, err := f.kube.CoreV1().Nodes().Get(f.ctx, name, metav1.GetOptions{})
		if err != nil {
			return err
		}
		node.Status.Conditions = []corev1.NodeCondition{{Type: corev1.NodeReady, Status: corev1.ConditionTrue}}
		updated, err = f.kube.CoreV1().Nodes().UpdateStatus(f.ctx, node, metav1.UpdateOptions{})
		return err
	})
	if err != nil {
		f.t.Fatal(err)
	}
	return updated
}

func (f *fixture) registryFailure(t *testing.T) {
	f.t = t
	for index := 2; index <= 3; index++ {
		f.createPair(index, nil)
	}
	controller := f.controller(f.base)
	if _, err := controller.ReconcileOnce(f.ctx); err != nil {
		t.Fatal(err)
	}
	nodes, err := f.kube.CoreV1().Nodes().List(f.ctx, metav1.ListOptions{LabelSelector: "node.tke.cloud.tencent.com/machineset=" + f.machineSet})
	if err != nil {
		t.Fatal(err)
	}
	for index := range nodes.Items {
		state := f.state(nodes.Items[index].Name)
		probe := f.probe(state.ProbePodName)
		probe.Status.Phase = corev1.PodPending
		probe.Status.ContainerStatuses = []corev1.ContainerStatus{{
			Name: "validate", State: corev1.ContainerState{Waiting: &corev1.ContainerStateWaiting{Reason: "ImagePullBackOff"}},
		}}
		if _, err := f.kube.CoreV1().Pods(f.namespace).UpdateStatus(f.ctx, probe, metav1.UpdateOptions{}); err != nil {
			t.Fatal(err)
		}
	}
	controller = f.controller(f.base.Add(6 * time.Minute))
	if _, err := controller.ReconcileOnce(f.ctx); err != nil {
		t.Fatal(err)
	}
	for index := range nodes.Items {
		state := f.state(nodes.Items[index].Name)
		if state.Phase != admission.PhaseBlocked || !strings.Contains(state.Reason, "ImagePullBackOff") {
			t.Fatalf("registry failure was attributed to Node %s: %#v", nodes.Items[index].Name, state)
		}
	}
	statefulSet, err := f.kube.AppsV1().StatefulSets(f.namespace).Get(f.ctx, f.cell+"-runtime-hosts", metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	three := int32(3)
	statefulSet.Spec.Replicas = &three
	if _, err := f.kube.AppsV1().StatefulSets(f.namespace).Update(f.ctx, statefulSet, metav1.UpdateOptions{}); err != nil {
		t.Fatal(err)
	}
	capacity := &runtimecapacity.Controller{
		Kubernetes: f.kube, Dynamic: f.dynamic,
		Config: runtimecapacity.ControllerConfig{
			Namespace: f.namespace, CellName: f.cell, StatefulSetName: f.cell + "-runtime-hosts", MachineSetName: f.machineSet,
			MinReplicas: 3, MaxReplicas: 6, MaxRepairSurge: 1, ScaleDownStabilization: time.Second,
		},
		Now: func() time.Time { return f.base.Add(10 * time.Minute) },
	}
	result, err := capacity.ReconcileOnce(f.ctx)
	if err != nil {
		t.Fatal(err)
	}
	if result.UsableNodes != 0 || result.Action != "await-usable-capacity" {
		t.Fatalf("global registry fault escaped fail-closed capacity: %#v", result)
	}
	machineSet, err := f.dynamic.Resource(machineSetResource).Get(f.ctx, f.machineSet, metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	replicas, _, _ := unstructured.NestedInt64(machineSet.Object, "spec", "replicas")
	if replicas != 3 {
		t.Fatalf("global registry fault requested replacement capacity: %d", replicas)
	}
}

func (f *fixture) state(nodeName string) admission.State {
	node, err := f.kube.CoreV1().Nodes().Get(f.ctx, nodeName, metav1.GetOptions{})
	if err != nil {
		f.t.Fatal(err)
	}
	state, err := admission.DecodeState(node.Annotations[admission.StateAnnotation])
	if err != nil {
		f.t.Fatal(err)
	}
	return state
}

func (f *fixture) probe(name string) *corev1.Pod {
	probe, err := f.kube.CoreV1().Pods(f.namespace).Get(f.ctx, name, metav1.GetOptions{})
	if err != nil {
		f.t.Fatal(err)
	}
	return probe
}

func (f *fixture) waitNodeAbsent(name string) {
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		_, err := f.kube.CoreV1().Nodes().Get(f.ctx, name, metav1.GetOptions{})
		if err != nil {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	f.t.Fatalf("Node %s was not deleted", name)
}

func (f *fixture) cleanup() {
	nodes, _ := f.kube.CoreV1().Nodes().List(f.ctx, metav1.ListOptions{LabelSelector: "node.tke.cloud.tencent.com/machineset=" + f.machineSet})
	for index := range nodes.Items {
		_ = f.kube.CoreV1().Nodes().Delete(f.ctx, nodes.Items[index].Name, metav1.DeleteOptions{})
	}
	_ = f.dynamic.Resource(machineResource).DeleteCollection(f.ctx, metav1.DeleteOptions{}, metav1.ListOptions{LabelSelector: "node.tke.cloud.tencent.com/machineset=" + f.machineSet})
	_ = f.dynamic.Resource(machineSetResource).Delete(f.ctx, f.machineSet, metav1.DeleteOptions{})
	_ = f.kube.CoreV1().Namespaces().Delete(f.ctx, f.namespace, metav1.DeleteOptions{})
}
