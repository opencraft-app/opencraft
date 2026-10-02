package admission

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	dynamicfake "k8s.io/client-go/dynamic/fake"
	kubefake "k8s.io/client-go/kubernetes/fake"
	k8stesting "k8s.io/client-go/testing"
)

func TestNodeRemainsFencedUntilExactProbeSucceeds(t *testing.T) {
	controller := admissionFixture(t)
	results, err := controller.ReconcileOnce(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 1 || results[0].Action != "create-probe" {
		t.Fatalf("unexpected first reconcile: %#v", results)
	}
	node := getNode(t, controller)
	if !hasPendingTaint(node.Spec.Taints) || node.Labels[AdmittedLabel] != "" || node.Labels[PhaseLabel] != "probing" {
		t.Fatalf("Node was not fail-closed while probing: %#v", node)
	}
	state, err := DecodeState(node.Annotations[StateAnnotation])
	if err != nil {
		t.Fatal(err)
	}
	probe, err := controller.Kubernetes.CoreV1().Pods(controller.Config.Namespace).Get(context.Background(), state.ProbePodName, metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if probe.Spec.NodeName != node.Name || probe.Spec.AutomountServiceAccountToken == nil || *probe.Spec.AutomountServiceAccountToken ||
		probe.Spec.Containers[0].ImagePullPolicy != corev1.PullAlways || len(probe.Spec.Volumes) != 0 {
		t.Fatalf("probe security or identity contract mismatch: %#v", probe.Spec)
	}
	probe.UID = types.UID("probe-uid")
	probe.Status.Phase = corev1.PodSucceeded
	if _, err := controller.Kubernetes.CoreV1().Pods(controller.Config.Namespace).Update(context.Background(), probe, metav1.UpdateOptions{}); err != nil {
		t.Fatal(err)
	}
	results, err = controller.ReconcileOnce(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if results[0].Action != "adopt-probe-identity" {
		t.Fatalf("probe UID was not durably adopted: %#v", results)
	}
	results, err = controller.ReconcileOnce(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if results[0].Action != "admit-node" {
		t.Fatalf("successful probe did not admit Node: %#v", results)
	}
	node = getNode(t, controller)
	if hasPendingTaint(node.Spec.Taints) || node.Labels[AdmittedLabel] != "true" || node.Labels[PhaseLabel] != "admitted" {
		t.Fatalf("successful admission did not atomically open scheduling: %#v", node)
	}
	machine := getMachine(t, controller)
	if hasUnstructuredPendingTaint(machine) {
		t.Fatalf("successful admission left the provider Machine source fenced: %#v", machine.Object)
	}
	state, err = DecodeState(node.Annotations[StateAnnotation])
	if err != nil || state.Phase != PhaseAdmitted || state.ProbePodUID != "probe-uid" {
		t.Fatalf("invalid admitted evidence: state=%#v err=%v", state, err)
	}
}

func TestMachineFenceMustRetireBeforeNodeAdmissionOpens(t *testing.T) {
	controller := admissionFixture(t)
	if _, err := controller.ReconcileOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	node := getNode(t, controller)
	state, err := DecodeState(node.Annotations[StateAnnotation])
	if err != nil {
		t.Fatal(err)
	}
	probe, err := controller.Kubernetes.CoreV1().Pods(controller.Config.Namespace).Get(context.Background(), state.ProbePodName, metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	probe.UID = types.UID("probe-uid")
	probe.Status.Phase = corev1.PodSucceeded
	if _, err := controller.Kubernetes.CoreV1().Pods(controller.Config.Namespace).Update(context.Background(), probe, metav1.UpdateOptions{}); err != nil {
		t.Fatal(err)
	}
	if _, err := controller.ReconcileOnce(context.Background()); err != nil { // adopt exact probe UID
		t.Fatal(err)
	}
	dynamicClient := controller.Dynamic.(*dynamicfake.FakeDynamicClient)
	dynamicClient.PrependReactor("patch", "machines", func(action k8stesting.Action) (bool, runtime.Object, error) {
		return true, nil, errors.New("injected Machine patch failure")
	})
	if _, err := controller.ReconcileOnce(context.Background()); err == nil || !strings.Contains(err.Error(), "injected Machine patch failure") {
		t.Fatalf("Machine source failure did not fail admission closed: %v", err)
	}
	node = getNode(t, controller)
	if node.Labels[AdmittedLabel] != "" || !hasPendingTaint(node.Spec.Taints) {
		t.Fatalf("Node opened before its provider Machine source converged: %#v", node)
	}
}

func TestProviderRestoredNodeTaintIsRemovedAfterMachineSourceConverges(t *testing.T) {
	controller := admissionFixture(t)
	admitFixtureNode(t, controller)
	node := getNode(t, controller)
	node.Spec.Taints = append(node.Spec.Taints, corev1.Taint{Key: PendingTaintKey, Value: "pending", Effect: corev1.TaintEffectNoSchedule})
	if _, err := controller.Kubernetes.CoreV1().Nodes().Update(context.Background(), node, metav1.UpdateOptions{}); err != nil {
		t.Fatal(err)
	}
	results, err := controller.ReconcileOnce(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if results[0].Action != "restore-admission-fields" || hasPendingTaint(getNode(t, controller).Spec.Taints) {
		t.Fatalf("provider-restored Node taint did not converge: %#v", results)
	}
	if hasUnstructuredPendingTaint(getMachine(t, controller)) {
		t.Fatal("admitted Machine source unexpectedly regained the birth taint")
	}
}

func TestMachineDisappearanceDuringAdmissionIsIdentityChurn(t *testing.T) {
	controller := admissionFixture(t)
	machine := getMachine(t, controller)
	identity := machineIdentity{Name: machine.GetName(), UID: string(machine.GetUID())}
	if err := controller.Dynamic.Resource(machineResource).Delete(
		context.Background(), machine.GetName(), metav1.DeleteOptions{},
	); err != nil {
		t.Fatal(err)
	}
	if _, err := controller.setMachinePendingTaint(context.Background(), identity, true); !errors.Is(err, errMachineCASChanged) {
		t.Fatalf("deleted Machine was not reported as retryable identity churn: %v", err)
	}
}

func TestPreparedNodeRestoresNodeAndMachineFence(t *testing.T) {
	controller := admissionFixture(t)
	node := getNode(t, controller)
	machine := getMachine(t, controller)
	identity := Identity{
		NodeUID: string(node.UID), ProviderID: node.Spec.ProviderID,
		MachineUID: string(machine.GetUID()), MachineSetUID: "machineset-uid",
		ProfileDigest: ProfileDigest(), RuntimeImage: testImage("a"),
	}
	state := State{
		Phase: PhasePrepared, Identity: identity, AttemptUID: "prepared-attempt", Attempt: 1,
		StartedAt: controller.now(), TransitionAt: controller.now(),
	}
	encoded, err := EncodeState(state)
	if err != nil {
		t.Fatal(err)
	}
	node.Annotations[StateAnnotation] = encoded
	node.Labels[PhaseLabel] = "prepared"
	node.Spec.Taints = []corev1.Taint{{Key: "rivet.dev/compute", Value: "true", Effect: corev1.TaintEffectNoSchedule}}
	if _, err := controller.Kubernetes.CoreV1().Nodes().Update(context.Background(), node, metav1.UpdateOptions{}); err != nil {
		t.Fatal(err)
	}
	if err := unstructured.SetNestedSlice(machine.Object, []any{
		map[string]any{"key": "rivet.dev/compute", "value": "true", "effect": "NoSchedule"},
	}, "spec", "taints"); err != nil {
		t.Fatal(err)
	}
	if _, err := controller.Dynamic.Resource(machineResource).Update(context.Background(), machine, metav1.UpdateOptions{}); err != nil {
		t.Fatal(err)
	}

	results, err := controller.ReconcileOnce(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 1 || results[0].Phase != PhasePrepared || results[0].Action != "restore-prepared-fence" {
		t.Fatalf("Prepared fence gap did not self-heal: %#v", results)
	}
	if !hasPendingTaint(getNode(t, controller).Spec.Taints) || !hasUnstructuredPendingTaint(getMachine(t, controller)) {
		t.Fatal("Prepared Node or concrete Machine remained schedulable")
	}
}

func TestMachineIdentityFailsClosedOnUnexpectedContinuation(t *testing.T) {
	controller := admissionFixture(t)
	dynamicClient := controller.Dynamic.(*dynamicfake.FakeDynamicClient)
	dynamicClient.PrependReactor("list", "machines", func(action k8stesting.Action) (bool, runtime.Object, error) {
		list := &unstructured.UnstructuredList{}
		list.SetGroupVersionKind(schema.GroupVersionKind{Group: machineResource.Group, Version: machineResource.Version, Kind: "MachineList"})
		list.SetContinue("unexpected-next-page")
		return true, list, nil
	})
	_, err := controller.ReconcileOnce(context.Background())
	if err == nil || !strings.Contains(err.Error(), "exceeds bounded list") {
		t.Fatalf("partial admission Machine inventory did not fail closed: %v", err)
	}
}

func TestLateProbeSuccessCannotAdmitDrainingNode(t *testing.T) {
	controller := admissionFixture(t)
	if _, err := controller.ReconcileOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	node := getNode(t, controller)
	state, err := DecodeState(node.Annotations[StateAnnotation])
	if err != nil {
		t.Fatal(err)
	}
	probe, err := controller.Kubernetes.CoreV1().Pods(controller.Config.Namespace).Get(context.Background(), state.ProbePodName, metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	probe.UID = types.UID("late-probe")
	probe.Status.Phase = corev1.PodSucceeded
	if _, err := controller.Kubernetes.CoreV1().Pods(controller.Config.Namespace).Update(context.Background(), probe, metav1.UpdateOptions{}); err != nil {
		t.Fatal(err)
	}
	node.Annotations[DrainAnnotation] = "machine-uid"
	if _, err := controller.Kubernetes.CoreV1().Nodes().Update(context.Background(), node, metav1.UpdateOptions{}); err != nil {
		t.Fatal(err)
	}
	results, err := controller.ReconcileOnce(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if results[0].Phase != PhaseCancelled || results[0].Action != "cancel-probe-for-drain" {
		t.Fatalf("drain did not cancel late admission: %#v", results)
	}
	node = getNode(t, controller)
	if node.Labels[AdmittedLabel] != "" || !hasPendingTaint(node.Spec.Taints) {
		t.Fatalf("draining Node escaped its admission fence: %#v", node)
	}
}

func TestRuntimeCandidateChangeFencesNodeUntilExactImageIsReprobed(t *testing.T) {
	controller := admissionFixture(t)
	admitFixtureNode(t, controller)
	controller.Config.BootstrapImage = testImage("b")
	results, err := controller.ReconcileOnce(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if results[0].Phase != PhaseProbing || results[0].Action != "create-probe" {
		t.Fatalf("runtime candidate change did not start a new exact probe: %#v", results)
	}
	node := getNode(t, controller)
	if node.Labels[AdmittedLabel] != "" || !hasPendingTaint(node.Spec.Taints) {
		t.Fatalf("Node remained schedulable while probing a new runtime candidate: %#v", node)
	}
	if machine := getMachine(t, controller); !hasUnstructuredPendingTaint(machine) {
		t.Fatalf("candidate change did not restore the provider Machine fence: %#v", machine.Object)
	}
	state, err := DecodeState(node.Annotations[StateAnnotation])
	if err != nil || state.Identity.RuntimeImage != testImage("b") || state.Attempt != 2 {
		t.Fatalf("runtime candidate did not create a distinct persisted attempt: state=%#v err=%v", state, err)
	}
	probe, err := controller.Kubernetes.CoreV1().Pods(controller.Config.Namespace).Get(context.Background(), state.ProbePodName, metav1.GetOptions{})
	if err != nil || probe.Spec.Containers[0].Image != testImage("b") {
		t.Fatalf("runtime candidate probe did not use the exact image: probe=%#v err=%v", probe, err)
	}
}

func TestFailedProbeBlocksWithoutCondemningNode(t *testing.T) {
	controller := admissionFixture(t)
	if _, err := controller.ReconcileOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	node := getNode(t, controller)
	state, err := DecodeState(node.Annotations[StateAnnotation])
	if err != nil {
		t.Fatal(err)
	}
	probe, err := controller.Kubernetes.CoreV1().Pods(controller.Config.Namespace).Get(context.Background(), state.ProbePodName, metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	probe.UID = types.UID("failed-probe")
	probe.Status.Phase = corev1.PodFailed
	probe.Status.ContainerStatuses = []corev1.ContainerStatus{{State: corev1.ContainerState{Terminated: &corev1.ContainerStateTerminated{ExitCode: 1, Reason: "Error"}}}}
	if _, err := controller.Kubernetes.CoreV1().Pods(controller.Config.Namespace).Update(context.Background(), probe, metav1.UpdateOptions{}); err != nil {
		t.Fatal(err)
	}
	if _, err := controller.ReconcileOnce(context.Background()); err != nil { // adopt Pod UID
		t.Fatal(err)
	}
	results, err := controller.ReconcileOnce(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if results[0].Phase != PhaseBlocked || results[0].Action != "block-failed-probe" {
		t.Fatalf("failed probe was incorrectly attributed: %#v", results)
	}
	node = getNode(t, controller)
	if !hasPendingTaint(node.Spec.Taints) || node.Labels[AdmittedLabel] != "" || node.Spec.Unschedulable {
		t.Fatalf("blocked probe mutated a foreign scheduling field: %#v", node)
	}
}

func TestPersistentNodePressureIsQuarantined(t *testing.T) {
	controller := admissionFixture(t)
	if _, err := controller.ReconcileOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	node := getNode(t, controller)
	state, err := DecodeState(node.Annotations[StateAnnotation])
	if err != nil {
		t.Fatal(err)
	}
	controller.Now = func() time.Time { return state.StartedAt.Add(controller.Config.ProbeTimeout) }
	node.Status.Conditions = append(node.Status.Conditions, corev1.NodeCondition{Type: corev1.NodeDiskPressure, Status: corev1.ConditionTrue})
	if _, err := controller.Kubernetes.CoreV1().Nodes().UpdateStatus(context.Background(), node, metav1.UpdateOptions{}); err != nil {
		t.Fatal(err)
	}
	results, err := controller.ReconcileOnce(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if results[0].Phase != PhaseQuarantined || results[0].Action != "quarantine-node-pressure" {
		t.Fatalf("persistent local pressure was not quarantined: %#v", results)
	}
}

func TestAdmittedNodeFaultMustPersistBeforeQuarantine(t *testing.T) {
	controller := admissionFixture(t)
	admitFixtureNode(t, controller)
	node := getNode(t, controller)
	node.Status.Conditions = []corev1.NodeCondition{{Type: corev1.NodeReady, Status: corev1.ConditionFalse}}
	if _, err := controller.Kubernetes.CoreV1().Nodes().UpdateStatus(context.Background(), node, metav1.UpdateOptions{}); err != nil {
		t.Fatal(err)
	}
	results, err := controller.ReconcileOnce(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if results[0].Phase != PhaseSuspect || results[0].Action != "fence-suspect-node" {
		t.Fatalf("admitted Node fault was not fenced as suspect: %#v", results)
	}
	node = getNode(t, controller)
	state, err := DecodeState(node.Annotations[StateAnnotation])
	if err != nil {
		t.Fatal(err)
	}
	if state.Fault != "persistent Node condition: NotReady" || state.FaultSince.IsZero() ||
		node.Labels[AdmittedLabel] != "" || !hasPendingTaint(node.Spec.Taints) {
		t.Fatalf("suspect evidence or scheduling fence is incomplete: state=%#v node=%#v", state, node)
	}
	restarted := &Controller{
		Kubernetes: controller.Kubernetes, Dynamic: controller.Dynamic, Config: controller.Config,
		Now: func() time.Time { return state.FaultSince.Add(controller.Config.ProbeTimeout - time.Second) },
	}
	results, err = restarted.ReconcileOnce(context.Background())
	if err != nil || results[0].Phase != PhaseSuspect || results[0].Action != "wait-suspect-node" {
		t.Fatalf("restart did not preserve the suspect persistence window: results=%#v err=%v", results, err)
	}
	restarted.Now = func() time.Time { return state.FaultSince.Add(controller.Config.ProbeTimeout) }
	results, err = restarted.ReconcileOnce(context.Background())
	if err != nil || results[0].Phase != PhaseQuarantined || results[0].Action != "quarantine-admitted-node-fault" {
		t.Fatalf("persistent admitted Node fault was not quarantined: results=%#v err=%v", results, err)
	}
}

func TestAdmittedNodeTransientFaultRestoresScheduling(t *testing.T) {
	controller := admissionFixture(t)
	admitFixtureNode(t, controller)
	node := getNode(t, controller)
	node.Status.Conditions = []corev1.NodeCondition{{Type: corev1.NodeReady, Status: corev1.ConditionFalse}}
	if _, err := controller.Kubernetes.CoreV1().Nodes().UpdateStatus(context.Background(), node, metav1.UpdateOptions{}); err != nil {
		t.Fatal(err)
	}
	if _, err := controller.ReconcileOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	node = getNode(t, controller)
	node.Status.Conditions = []corev1.NodeCondition{{Type: corev1.NodeReady, Status: corev1.ConditionTrue}}
	if _, err := controller.Kubernetes.CoreV1().Nodes().UpdateStatus(context.Background(), node, metav1.UpdateOptions{}); err != nil {
		t.Fatal(err)
	}
	results, err := controller.ReconcileOnce(context.Background())
	if err != nil || results[0].Phase != PhaseAdmitted || results[0].Action != "restore-admission-fields" {
		t.Fatalf("transient Node fault did not recover: results=%#v err=%v", results, err)
	}
	node = getNode(t, controller)
	state, err := DecodeState(node.Annotations[StateAnnotation])
	if err != nil || state.Fault != "" || !state.FaultSince.IsZero() || node.Labels[AdmittedLabel] != "true" || hasPendingTaint(node.Spec.Taints) {
		t.Fatalf("recovered Node retained suspect evidence: state=%#v node=%#v err=%v", state, node, err)
	}
}

func TestCorruptAdmissionEvidenceIsFencedAndReset(t *testing.T) {
	controller := admissionFixture(t)
	node := getNode(t, controller)
	node.Labels[AdmittedLabel] = "true"
	node.Annotations[StateAnnotation] = `{"phase":"Admitted","unexpected":true}`
	if _, err := controller.Kubernetes.CoreV1().Nodes().Update(context.Background(), node, metav1.UpdateOptions{}); err != nil {
		t.Fatal(err)
	}
	results, err := controller.ReconcileOnce(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if results[0].Action != "reset-invalid-evidence" || results[0].Phase != PhasePending {
		t.Fatalf("corrupt evidence was not reset: %#v", results)
	}
	node = getNode(t, controller)
	if node.Labels[AdmittedLabel] != "" || !hasPendingTaint(node.Spec.Taints) {
		t.Fatalf("corrupt evidence remained schedulable: %#v", node)
	}
	state, err := DecodeState(node.Annotations[StateAnnotation])
	if err != nil || state.Phase != PhasePending || !SameNode(state.Identity, Identity{
		NodeUID: string(node.UID), ProviderID: node.Spec.ProviderID, MachineUID: "machine-uid",
		MachineSetUID: "machineset-uid", ProfileDigest: ProfileDigest(), RuntimeImage: testImage("a"),
	}) {
		t.Fatalf("corrupt evidence did not converge to a fresh identity: state=%#v err=%v", state, err)
	}
}

func TestControllerRestartResumesExactPersistedProbe(t *testing.T) {
	controller := admissionFixture(t)
	if _, err := controller.ReconcileOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	node := getNode(t, controller)
	state, err := DecodeState(node.Annotations[StateAnnotation])
	if err != nil {
		t.Fatal(err)
	}
	probe, err := controller.Kubernetes.CoreV1().Pods(controller.Config.Namespace).Get(context.Background(), state.ProbePodName, metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	probe.UID = types.UID("probe-after-restart")
	probe.Status.Phase = corev1.PodSucceeded
	if _, err := controller.Kubernetes.CoreV1().Pods(controller.Config.Namespace).Update(context.Background(), probe, metav1.UpdateOptions{}); err != nil {
		t.Fatal(err)
	}
	restarted := &Controller{
		Kubernetes: controller.Kubernetes,
		Dynamic:    controller.Dynamic,
		Config:     controller.Config,
		Now:        controller.Now,
	}
	results, err := restarted.ReconcileOnce(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if results[0].Action != "adopt-probe-identity" {
		t.Fatalf("restarted controller did not resume persisted attempt: %#v", results)
	}
	results, err = restarted.ReconcileOnce(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if results[0].Action != "admit-node" || results[0].Phase != PhaseAdmitted {
		t.Fatalf("restarted controller did not complete admission: %#v", results)
	}
}

func TestReplacementNodeUIDCannotInheritLateProbeSuccess(t *testing.T) {
	controller := admissionFixture(t)
	if _, err := controller.ReconcileOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	oldNode := getNode(t, controller)
	oldState, err := DecodeState(oldNode.Annotations[StateAnnotation])
	if err != nil {
		t.Fatal(err)
	}
	oldProbe, err := controller.Kubernetes.CoreV1().Pods(controller.Config.Namespace).Get(context.Background(), oldState.ProbePodName, metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	oldProbe.UID = types.UID("late-old-probe")
	oldProbe.Status.Phase = corev1.PodSucceeded
	if _, err := controller.Kubernetes.CoreV1().Pods(controller.Config.Namespace).Update(context.Background(), oldProbe, metav1.UpdateOptions{}); err != nil {
		t.Fatal(err)
	}
	if err := controller.Kubernetes.CoreV1().Nodes().Delete(context.Background(), oldNode.Name, metav1.DeleteOptions{}); err != nil {
		t.Fatal(err)
	}
	replacement := oldNode.DeepCopy()
	replacement.UID = types.UID("replacement-node-uid")
	replacement.ResourceVersion = "1"
	if _, err := controller.Kubernetes.CoreV1().Nodes().Create(context.Background(), replacement, metav1.CreateOptions{}); err != nil {
		t.Fatal(err)
	}
	results, err := controller.ReconcileOnce(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if results[0].Action != "create-probe" || results[0].Phase != PhaseProbing {
		t.Fatalf("replacement Node inherited stale probe result: %#v", results)
	}
	newNode := getNode(t, controller)
	newState, err := DecodeState(newNode.Annotations[StateAnnotation])
	if err != nil {
		t.Fatal(err)
	}
	if newState.Identity.NodeUID != "replacement-node-uid" || newState.AttemptUID == oldState.AttemptUID || newNode.Labels[AdmittedLabel] != "" {
		t.Fatalf("replacement Node retained stale admission identity: %#v", newState)
	}
}

func TestBootstrapImageAdmitsBeforeStatefulSetExists(t *testing.T) {
	controller := admissionFixture(t)
	if err := controller.Kubernetes.AppsV1().StatefulSets(controller.Config.Namespace).Delete(context.Background(), controller.Config.StatefulSetName, metav1.DeleteOptions{}); err != nil {
		t.Fatal(err)
	}
	controller.Config.BootstrapImage = testImage("b")
	results, err := controller.ReconcileOnce(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if results[0].Action != "create-probe" {
		t.Fatalf("bootstrap admission did not start: %#v", results)
	}
	node := getNode(t, controller)
	state, err := DecodeState(node.Annotations[StateAnnotation])
	if err != nil {
		t.Fatal(err)
	}
	if state.Identity.RuntimeImage != testImage("b") {
		t.Fatalf("bootstrap probe used mutable or unexpected image: %q", state.Identity.RuntimeImage)
	}
}

func admitFixtureNode(t *testing.T, controller *Controller) {
	t.Helper()
	if _, err := controller.ReconcileOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	node := getNode(t, controller)
	state, err := DecodeState(node.Annotations[StateAnnotation])
	if err != nil {
		t.Fatal(err)
	}
	probe, err := controller.Kubernetes.CoreV1().Pods(controller.Config.Namespace).Get(context.Background(), state.ProbePodName, metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	probe.UID = types.UID("probe-uid")
	probe.Status.Phase = corev1.PodSucceeded
	if _, err := controller.Kubernetes.CoreV1().Pods(controller.Config.Namespace).Update(context.Background(), probe, metav1.UpdateOptions{}); err != nil {
		t.Fatal(err)
	}
	if _, err := controller.ReconcileOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := controller.ReconcileOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func getNode(t *testing.T, controller *Controller) *corev1.Node {
	t.Helper()
	node, err := controller.Kubernetes.CoreV1().Nodes().Get(context.Background(), "runtime-1", metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	return node
}

func getMachine(t *testing.T, controller *Controller) *unstructured.Unstructured {
	t.Helper()
	machine, err := controller.Dynamic.Resource(machineResource).Get(context.Background(), "np-runtime0-1", metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	return machine
}

func hasUnstructuredPendingTaint(machine *unstructured.Unstructured) bool {
	taints, _, _ := unstructured.NestedSlice(machine.Object, "spec", "taints")
	return unstructuredTaintExists(taints, PendingTaintKey, "pending", string(corev1.TaintEffectNoSchedule))
}

func admissionFixture(t *testing.T) *Controller {
	t.Helper()
	cell := "actor-bj-q01"
	now := time.Date(2026, 9, 4, 10, 0, 0, 0, time.UTC)
	replicas := int32(1)
	statefulSet := &appsv1.StatefulSet{
		ObjectMeta: metav1.ObjectMeta{Name: cell + "-runtime-hosts", Namespace: "actor-fdb-cell-system", Labels: map[string]string{"fleet.actor.dev/cell-name": cell}},
		Spec:       appsv1.StatefulSetSpec{Replicas: &replicas, Template: corev1.PodTemplateSpec{Spec: corev1.PodSpec{Containers: []corev1.Container{{Name: "workerd", Image: testImage("a")}}}}},
	}
	node := &corev1.Node{
		ObjectMeta: metav1.ObjectMeta{
			Name: "runtime-1", UID: types.UID("node-uid"), ResourceVersion: "1",
			Labels: map[string]string{
				"node.tke.cloud.tencent.com/machineset": "np-runtime0",
				"fleet.actor.dev/cell-name":             cell,
				"rivet.dev/compute":                     "true",
			},
			Annotations: map[string]string{},
		},
		Spec: corev1.NodeSpec{
			ProviderID: "qcloud://instance-1",
			Taints:     []corev1.Taint{{Key: "rivet.dev/compute", Value: "true", Effect: corev1.TaintEffectNoSchedule}},
		},
		Status: corev1.NodeStatus{Conditions: []corev1.NodeCondition{{Type: corev1.NodeReady, Status: corev1.ConditionTrue}}},
	}
	kube := kubefake.NewSimpleClientset(statefulSet, node)
	machineSet := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "node.tke.cloud.tencent.com/v1beta1", "kind": "MachineSet",
		"metadata": map[string]any{"name": "np-runtime0", "uid": "machineset-uid", "resourceVersion": "1"},
		"spec": map[string]any{"template": map[string]any{"spec": map[string]any{
			"metadata": map[string]any{"labels": map[string]any{
				"fleet.actor.dev/cell-name": cell, "fleet.actor.dev/runtime-pool": "true",
			}},
			"taints": []any{map[string]any{"key": PendingTaintKey, "value": "pending", "effect": "NoSchedule"}},
		}}},
	}}
	machine := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "node.tke.cloud.tencent.com/v1beta1", "kind": "Machine",
		"metadata": map[string]any{"name": "np-runtime0-1", "uid": "machine-uid", "resourceVersion": "1", "labels": map[string]any{"node.tke.cloud.tencent.com/machineset": "np-runtime0"}},
		"spec": map[string]any{"taints": []any{
			map[string]any{"key": "rivet.dev/compute", "value": "true", "effect": "NoSchedule"},
			map[string]any{"key": PendingTaintKey, "value": "pending", "effect": "NoSchedule"},
		}},
		"status": map[string]any{"nodeRef": map[string]any{"name": "runtime-1"}},
	}}
	scheme := runtime.NewScheme()
	dynamicClient := dynamicfake.NewSimpleDynamicClientWithCustomListKinds(scheme, map[schema.GroupVersionResource]string{
		machineSetResource: "MachineSetList", machineResource: "MachineList",
	}, machineSet, machine)
	return &Controller{
		Kubernetes: kube, Dynamic: dynamicClient,
		Config: ControllerConfig{
			Namespace: "actor-fdb-cell-system", CellName: cell, StatefulSetName: cell + "-runtime-hosts", MachineSetName: "np-runtime0",
			ImagePullSecret: "actor-fleet-tcr", ProbeTimeout: 5 * time.Minute, RetryBackoff: time.Minute, ReconcileInterval: time.Second,
		},
		Now: func() time.Time { return now },
	}
}

func TestStatefulSetCellIdentitySupportsStagedLabelMigration(t *testing.T) {
	cell := "actor-bj-q01"
	tests := []struct {
		name, metadataCell, templateCell string
		want                             bool
	}{
		{name: "both", metadataCell: cell, templateCell: cell, want: true},
		{name: "metadata only", metadataCell: cell, want: true},
		{name: "template only", templateCell: cell, want: true},
		{name: "missing", want: false},
		{name: "metadata conflict", metadataCell: "other", templateCell: cell, want: false},
		{name: "template conflict", metadataCell: cell, templateCell: "other", want: false},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			statefulSet := &appsv1.StatefulSet{ObjectMeta: metav1.ObjectMeta{Labels: map[string]string{}}, Spec: appsv1.StatefulSetSpec{Template: corev1.PodTemplateSpec{ObjectMeta: metav1.ObjectMeta{Labels: map[string]string{}}}}}
			if test.metadataCell != "" {
				statefulSet.Labels["fleet.actor.dev/cell-name"] = test.metadataCell
			}
			if test.templateCell != "" {
				statefulSet.Spec.Template.Labels["fleet.actor.dev/cell-name"] = test.templateCell
			}
			if got := StatefulSetMatchesCell(statefulSet, cell); got != test.want {
				t.Fatalf("StatefulSetMatchesCell()=%t, want %t", got, test.want)
			}
		})
	}
}

func TestConfiguredRuntimeImageOverridesLiveStatefulSetDuringUpgrade(t *testing.T) {
	controller := admissionFixture(t)
	candidate := testImage("b")
	controller.Config.BootstrapImage = candidate
	got, err := controller.currentRuntimeImage(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if got != candidate {
		t.Fatalf("currentRuntimeImage()=%q, want candidate %q", got, candidate)
	}
}

func TestStatelessDeploymentUsesIndependentAdmissionProfile(t *testing.T) {
	controller := statelessAdmissionFixture(t)
	ctx := context.Background()
	results, err := controller.ReconcileOnce(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 1 || results[0].Action != "create-probe" {
		t.Fatalf("unexpected stateless admission reconcile: %#v", results)
	}
	node := getNode(t, controller)
	if node.Labels["fleet.actor.dev/stateless-admitted"] != "" ||
		controller.pendingTaintIndex(node.Spec.Taints) < 0 || node.Annotations[StateAnnotation] != "" {
		t.Fatalf("stateless Node did not remain independently fenced: %#v", node)
	}
	state, err := DecodeState(node.Annotations["fleet.actor.dev/stateless-admission-state"])
	if err != nil {
		t.Fatal(err)
	}
	if state.Identity.ProfileDigest != ProfileDigestFor("workerd-stateless-node-v1") ||
		state.Identity.RuntimeImage != testImage("c") {
		t.Fatalf("stateless evidence is not profile/image bound: %#v", state.Identity)
	}
	probe, err := controller.Kubernetes.CoreV1().Pods(controller.Config.Namespace).Get(ctx, state.ProbePodName, metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	wantTolerations := map[string]string{
		"rivet.dev/stateless": "true",
		"startup-taint.cluster-autoscaler.kubernetes.io/stateless-admission": "pending",
	}
	for _, toleration := range probe.Spec.Tolerations {
		delete(wantTolerations, toleration.Key)
	}
	if len(wantTolerations) != 0 || probe.Labels["fleet.actor.dev/component"] != "stateless-node-admission-probe" {
		t.Fatalf("stateless probe contract differs: tolerations=%#v labels=%#v", probe.Spec.Tolerations, probe.Labels)
	}
	probe.UID = types.UID("stateless-probe-uid")
	probe.Status.Phase = corev1.PodSucceeded
	if _, err := controller.Kubernetes.CoreV1().Pods(controller.Config.Namespace).Update(ctx, probe, metav1.UpdateOptions{}); err != nil {
		t.Fatal(err)
	}
	if _, err := controller.ReconcileOnce(ctx); err != nil { // adopt exact probe UID
		t.Fatal(err)
	}
	if _, err := controller.ReconcileOnce(ctx); err != nil { // admit Node
		t.Fatal(err)
	}
	node = getNode(t, controller)
	if node.Labels["fleet.actor.dev/stateless-admitted"] != "true" || controller.pendingTaintIndex(node.Spec.Taints) >= 0 {
		t.Fatalf("stateless Node was not admitted after exact probe: %#v", node)
	}
}

func statelessAdmissionFixture(t *testing.T) *Controller {
	t.Helper()
	controller := admissionFixture(t)
	ctx := context.Background()
	cell := controller.Config.CellName
	deployment := &appsv1.Deployment{
		ObjectMeta: metav1.ObjectMeta{
			Name: cell + "-stateless-executor", Namespace: controller.Config.Namespace,
			Labels: map[string]string{"fleet.actor.dev/cell-name": cell},
		},
		Spec: appsv1.DeploymentSpec{Template: corev1.PodTemplateSpec{
			ObjectMeta: metav1.ObjectMeta{Labels: map[string]string{"fleet.actor.dev/cell-name": cell}},
			Spec:       corev1.PodSpec{Containers: []corev1.Container{{Name: "workerd", Image: testImage("c")}}},
		}},
	}
	if _, err := controller.Kubernetes.AppsV1().Deployments(controller.Config.Namespace).Create(ctx, deployment, metav1.CreateOptions{}); err != nil {
		t.Fatal(err)
	}
	controller.Config.StatefulSetName = ""
	controller.Config.WorkloadKind = "Deployment"
	controller.Config.WorkloadName = deployment.Name
	controller.Config.WorkloadContainer = "workerd"
	controller.Config.PoolLabelKey = "fleet.actor.dev/stateless-pool"
	controller.Config.PoolTaintKey = "rivet.dev/stateless"
	controller.Config.PoolTaintValue = "true"
	controller.Config.PendingTaintKey = "startup-taint.cluster-autoscaler.kubernetes.io/stateless-admission"
	controller.Config.AdmittedLabel = "fleet.actor.dev/stateless-admitted"
	controller.Config.PhaseLabel = "fleet.actor.dev/stateless-admission-phase"
	controller.Config.StateAnnotation = "fleet.actor.dev/stateless-admission-state"
	controller.Config.DrainAnnotation = "fleet.actor.dev/stateless-capacity-drain"
	controller.Config.ProfileVersion = "workerd-stateless-node-v1"
	controller.Config.ProbeComponent = "stateless-node-admission-probe"

	node := getNode(t, controller)
	delete(node.Labels, "rivet.dev/compute")
	node.Labels["rivet.dev/stateless"] = "true"
	node.Labels["fleet.actor.dev/stateless-admitted"] = "true"
	node.Spec.Taints = []corev1.Taint{
		{Key: "rivet.dev/stateless", Value: "true", Effect: corev1.TaintEffectNoSchedule},
		{Key: controller.Config.PendingTaintKey, Value: "pending", Effect: corev1.TaintEffectNoSchedule},
	}
	if _, err := controller.Kubernetes.CoreV1().Nodes().Update(ctx, node, metav1.UpdateOptions{}); err != nil {
		t.Fatal(err)
	}
	machineSet, err := controller.Dynamic.Resource(machineSetResource).Get(ctx, controller.Config.MachineSetName, metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	labels := map[string]any{
		"fleet.actor.dev/cell-name":          cell,
		"fleet.actor.dev/stateless-pool":     "true",
		"fleet.actor.dev/stateless-admitted": "true",
		"rivet.dev/stateless":                "true",
	}
	if err := unstructured.SetNestedMap(machineSet.Object, labels, "spec", "template", "spec", "metadata", "labels"); err != nil {
		t.Fatal(err)
	}
	if err := unstructured.SetNestedSlice(machineSet.Object, []any{
		map[string]any{"key": "rivet.dev/stateless", "value": "true", "effect": "NoSchedule"},
		map[string]any{"key": controller.Config.PendingTaintKey, "value": "pending", "effect": "NoSchedule"},
	}, "spec", "template", "spec", "taints"); err != nil {
		t.Fatal(err)
	}
	if _, err := controller.Dynamic.Resource(machineSetResource).Update(ctx, machineSet, metav1.UpdateOptions{}); err != nil {
		t.Fatal(err)
	}
	machine := getMachine(t, controller)
	if err := unstructured.SetNestedSlice(machine.Object, []any{
		map[string]any{"key": "rivet.dev/stateless", "value": "true", "effect": "NoSchedule"},
		map[string]any{"key": controller.Config.PendingTaintKey, "value": "pending", "effect": "NoSchedule"},
	}, "spec", "taints"); err != nil {
		t.Fatal(err)
	}
	if _, err := controller.Dynamic.Resource(machineResource).Update(ctx, machine, metav1.UpdateOptions{}); err != nil {
		t.Fatal(err)
	}
	return controller
}

func TestBalancedAdmissionPlanWaitsForEveryZoneAndOpensInRounds(t *testing.T) {
	if plan := balancedAdmissionPlan(
		map[string]int{"zone-a": 0, "zone-b": 0, "zone-c": 0},
		map[string][]string{"zone-a": {"a-1", "a-2"}, "zone-b": {"b-1"}, "zone-c": {"c-1", "c-2"}},
	); strings.Join(plan, ",") != "a-1,b-1,c-1" {
		t.Fatalf("unequal provider burst escaped common frontier: %v", plan)
	}

	plan := balancedAdmissionPlan(
		map[string]int{"zone-a": 1, "zone-b": 1, "zone-c": 1},
		map[string][]string{"zone-a": {"a-2", "a-3"}, "zone-b": {"b-2", "b-3"}, "zone-c": {"c-2", "c-3"}},
	)
	if got := strings.Join(plan, ","); got != "a-2,b-2,c-2,a-3,b-3,c-3" {
		t.Fatalf("balanced admission was not crash-safe round robin: %s", got)
	}
}

func TestBalancedAdmissionPlanMonotonicallyRepairsLegacySkew(t *testing.T) {
	plan := balancedAdmissionPlan(
		map[string]int{"zone-a": 4, "zone-b": 1, "zone-c": 3},
		map[string][]string{"zone-a": nil, "zone-b": {"b-2", "b-3", "b-4"}, "zone-c": {"c-4"}},
	)
	if got := strings.Join(plan, ","); got != "b-2,b-3,b-4,c-4" {
		t.Fatalf("legacy skew repair plan = %s", got)
	}
}

func TestPreparedFrontierRevalidatesSharedMachineInventoryOncePerBatch(t *testing.T) {
	controller := admissionFixture(t)
	controller.Config.RequiredZones = 3
	ctx := context.Background()
	image := testImage("a")
	zones := []string{"zone-a", "zone-b", "zone-c"}

	// Replace the one-node fixture with two prepared Nodes per zone.  A large
	// frontier has the same API shape; six keeps this regression test compact.
	if err := controller.Kubernetes.CoreV1().Nodes().Delete(ctx, "runtime-1", metav1.DeleteOptions{}); err != nil {
		t.Fatal(err)
	}
	if err := controller.Dynamic.Resource(machineResource).Delete(ctx, "np-runtime0-1", metav1.DeleteOptions{}); err != nil {
		t.Fatal(err)
	}
	for zoneIndex, zone := range zones {
		for ordinal := 0; ordinal < 2; ordinal++ {
			name := fmt.Sprintf("runtime-%d-%d", zoneIndex, ordinal)
			nodeUID := types.UID("node-" + name)
			machineUID := "machine-" + name
			providerID := "qcloud://" + name
			state := State{Phase: PhasePrepared, Identity: Identity{
				NodeUID: string(nodeUID), ProviderID: providerID, MachineUID: machineUID,
				MachineSetUID: "machineset-uid", ProfileDigest: ProfileDigest(), RuntimeImage: image,
			}, AttemptUID: "attempt-" + name, Attempt: 1, StartedAt: controller.Now(), TransitionAt: controller.Now()}
			encoded, err := EncodeState(state)
			if err != nil {
				t.Fatal(err)
			}
			node := &corev1.Node{ObjectMeta: metav1.ObjectMeta{
				Name: name, UID: nodeUID, ResourceVersion: "1",
				Labels: map[string]string{
					"node.tke.cloud.tencent.com/machineset": "np-runtime0", "fleet.actor.dev/cell-name": controller.Config.CellName,
					"rivet.dev/compute": "true", corev1.LabelTopologyZone: zone, PhaseLabel: "prepared",
				}, Annotations: map[string]string{StateAnnotation: encoded},
			}, Spec: corev1.NodeSpec{ProviderID: providerID, Taints: []corev1.Taint{
				{Key: "rivet.dev/compute", Value: "true", Effect: corev1.TaintEffectNoSchedule},
				{Key: PendingTaintKey, Value: "pending", Effect: corev1.TaintEffectNoSchedule},
			}}, Status: corev1.NodeStatus{Conditions: []corev1.NodeCondition{{Type: corev1.NodeReady, Status: corev1.ConditionTrue}}}}
			if _, err := controller.Kubernetes.CoreV1().Nodes().Create(ctx, node, metav1.CreateOptions{}); err != nil {
				t.Fatal(err)
			}
			machine := &unstructured.Unstructured{Object: map[string]any{
				"apiVersion": "node.tke.cloud.tencent.com/v1beta1", "kind": "Machine",
				"metadata": map[string]any{"name": "np-runtime0-" + name, "uid": machineUID, "resourceVersion": "1", "labels": map[string]any{"node.tke.cloud.tencent.com/machineset": "np-runtime0"}},
				"spec":     map[string]any{"taints": []any{map[string]any{"key": PendingTaintKey, "value": "pending", "effect": "NoSchedule"}}},
				"status":   map[string]any{"nodeRef": map[string]any{"name": name}},
			}}
			if _, err := controller.Dynamic.Resource(machineResource).Create(ctx, machine, metav1.CreateOptions{}); err != nil {
				t.Fatal(err)
			}
		}
	}
	dynamicClient := controller.Dynamic.(*dynamicfake.FakeDynamicClient)
	dynamicClient.ClearActions()
	results, err := controller.admitPreparedFrontier(ctx, "machineset-uid", image)
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 6 {
		t.Fatalf("admitted %d prepared Nodes, want 6", len(results))
	}
	machineLists := 0
	machineSetGets := 0
	for _, action := range dynamicClient.Actions() {
		if action.GetVerb() == "list" && action.GetResource().Resource == "machines" {
			machineLists++
		}
		if action.GetVerb() == "get" && action.GetResource().Resource == "machinesets" {
			machineSetGets++
		}
	}
	if machineLists != 2 || machineSetGets != 1 {
		t.Fatalf("frontier batch revalidation amplified shared reads: machine lists=%d MachineSet gets=%d", machineLists, machineSetGets)
	}
}
