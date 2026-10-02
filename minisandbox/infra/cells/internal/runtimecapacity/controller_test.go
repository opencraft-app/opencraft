package runtimecapacity

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sort"
	"strings"
	"testing"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	policyv1 "k8s.io/api/policy/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	dynamicfake "k8s.io/client-go/dynamic/fake"
	kubefake "k8s.io/client-go/kubernetes/fake"
	k8stesting "k8s.io/client-go/testing"

	"github.com/rivet-dev/rivet/infra/cells/internal/runtimecapacity/admission"
)

func TestScaleUpFollowsStatefulSetDesiredReplicas(t *testing.T) {
	controller, dynamicClient, now := fixture(t, 4, 3, false)
	result, err := controller.ReconcileOnce(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if result.Action != "scale-up-to-4" {
		t.Fatalf("unexpected action: %#v", result)
	}
	machineSet, err := dynamicClient.Resource(machineSetResource).Get(
		context.Background(), "np-runtime0", metav1.GetOptions{},
	)
	if err != nil {
		t.Fatal(err)
	}
	replicas, _, _ := unstructured.NestedInt64(machineSet.Object, "spec", "replicas")
	if replicas != 4 {
		t.Fatalf("MachineSet replicas = %d, want 4", replicas)
	}
	_ = now
}

func TestMachineInventoryFailsClosedOnUnexpectedContinuation(t *testing.T) {
	controller, dynamicClient, _ := fixture(t, 3, 3, false)
	dynamicClient.PrependReactor("list", "machines", func(action k8stesting.Action) (bool, runtime.Object, error) {
		list := &unstructured.UnstructuredList{}
		list.SetGroupVersionKind(schema.GroupVersionKind{Group: machineResource.Group, Version: machineResource.Version, Kind: "MachineList"})
		list.SetContinue("unexpected-next-page")
		return true, list, nil
	})
	_, err := controller.ReconcileOnce(context.Background())
	if err == nil || !strings.Contains(err.Error(), "exceeds bounded list") {
		t.Fatalf("partial Machine inventory did not fail closed: %v", err)
	}
}

func TestTargetedRepairRejectsMachineSetWithoutNewestDeletionPolicy(t *testing.T) {
	controller, dynamicClient, _ := fixture(t, 4, 3, false)
	controller.Config.TargetedRepairEnabled = true
	machineSet, err := dynamicClient.Resource(machineSetResource).Get(context.Background(), "np-runtime0", metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if err := unstructured.SetNestedField(machineSet.Object, "Random", "spec", "deletePolicy"); err != nil {
		t.Fatal(err)
	}
	if _, err := dynamicClient.Resource(machineSetResource).Update(context.Background(), machineSet, metav1.UpdateOptions{}); err != nil {
		t.Fatal(err)
	}
	if _, err := controller.ReconcileOnce(context.Background()); err == nil || !strings.Contains(err.Error(), "identity or capacity bounds mismatch") {
		t.Fatalf("unsafe MachineSet deletion policy did not fail closed: %v", err)
	}
}

func TestExactNormalScaleDownDoesNotDependOnMachineSetDeletionPolicy(t *testing.T) {
	controller, dynamicClient, _ := fixture(t, 4, 3, false)
	machineSet, err := dynamicClient.Resource(machineSetResource).Get(context.Background(), "np-runtime0", metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if err := unstructured.SetNestedField(machineSet.Object, "Random", "spec", "deletePolicy"); err != nil {
		t.Fatal(err)
	}
	if _, err := dynamicClient.Resource(machineSetResource).Update(context.Background(), machineSet, metav1.UpdateOptions{}); err != nil {
		t.Fatal(err)
	}
	result, err := controller.ReconcileOnce(context.Background())
	if err != nil || result.Action != "scale-up-to-4" {
		t.Fatalf("exact provider path incorrectly relied on deletePolicy: result=%#v err=%v", result, err)
	}
}

func TestScaleDownCordonsEmptyNewestMachineAndRemovesOnlyOne(t *testing.T) {
	controller, dynamicClient, now := fixture(t, 3, 4, false)
	first, err := controller.ReconcileOnce(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if first.Action != "observe-scale-down" {
		t.Fatalf("unexpected first action: %#v", first)
	}
	*now = now.Add(31 * time.Second)
	second, err := controller.ReconcileOnce(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if second.Action != "prepare-exact-scale-down-to-3" || second.Candidate != "np-runtime0-4" {
		t.Fatalf("unexpected second action: %#v", second)
	}
	node, err := controller.Kubernetes.CoreV1().Nodes().Get(context.Background(), "runtime-4", metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if node.Spec.Unschedulable || node.Annotations[DrainAnnotation] != "machine-4" || drainTaintIndex(node.Spec.Taints, "machine-4") < 0 {
		t.Fatalf("newest node was not fenced: %#v", node)
	}
	third, err := controller.ReconcileOnce(context.Background())
	if err != nil || third.Action != "arm-exact-scale-down" {
		t.Fatalf("unexpected issued transition: result=%#v err=%v", third, err)
	}
	fourth, err := controller.ReconcileOnce(context.Background())
	if err != nil || fourth.Action != "request-exact-scale-down" {
		t.Fatalf("unexpected provider request: result=%#v err=%v", fourth, err)
	}
	provider := controller.ExactScaleDown.(*fakeExactScaleDownProvider)
	if len(provider.requests) != 1 || provider.requests[0] != (ExactScaleDownRequest{
		ClusterID: "cls-test", MachineName: "np-runtime0-4", MachineUID: "machine-4",
		NodeName: "runtime-4", NodeUID: "node-4", MachineSetName: "np-runtime0",
		MachineSetUID: "machineset-1", FromReplicas: 4, ToReplicas: 3,
	}) {
		t.Fatalf("provider did not receive the exact owned Machine: %#v", provider.requests)
	}
	fifth, err := controller.ReconcileOnce(context.Background())
	if err != nil || fifth.Action != "complete-exact-scale-down-to-3" {
		t.Fatalf("unexpected provider convergence: result=%#v err=%v", fifth, err)
	}
	machineSet, err := dynamicClient.Resource(machineSetResource).Get(context.Background(), "np-runtime0", metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	replicas, _, _ := unstructured.NestedInt64(machineSet.Object, "spec", "replicas")
	if replicas != 3 {
		t.Fatalf("MachineSet replicas = %d, want 3", replicas)
	}
	rawReceipt := machineSet.GetAnnotations()[DownscaleReceiptAnnotation]
	var receipt downscaleReceipt
	if rawReceipt == "" || json.Unmarshal([]byte(rawReceipt), &receipt) != nil ||
		receipt.Version != downscaleReceiptVersion || receipt.Outcome != downscaleOutcomeAcknowledged ||
		receipt.Intent.RequestID != "request-1" ||
		receipt.Intent.MachineUID != "machine-4" || receipt.Intent.FromReplicas != 4 || receipt.Intent.ToReplicas != 3 ||
		receipt.CompletedAt.IsZero() {
		t.Fatalf("exact scale-down receipt is incomplete: %q", rawReceipt)
	}
}

func TestScaleDownObservationSurvivesMonotonicHostContraction(t *testing.T) {
	controller, _, now := fixture(t, 5, 7, false)
	first, err := controller.ReconcileOnce(context.Background())
	if err != nil || first.Action != "observe-scale-down" {
		t.Fatalf("initial observation failed: result=%#v err=%v", first, err)
	}
	*now = now.Add(15 * time.Second)
	statefulSet, err := controller.Kubernetes.AppsV1().StatefulSets(controller.Config.Namespace).Get(
		context.Background(), controller.Config.StatefulSetName, metav1.GetOptions{},
	)
	if err != nil {
		t.Fatal(err)
	}
	replicas := int32(4)
	statefulSet.Spec.Replicas = &replicas
	statefulSet.Status.ReadyReplicas = replicas
	if _, err := controller.Kubernetes.AppsV1().StatefulSets(controller.Config.Namespace).Update(
		context.Background(), statefulSet, metav1.UpdateOptions{},
	); err != nil {
		t.Fatal(err)
	}
	if result, err := controller.ReconcileOnce(context.Background()); err != nil || result.Action != "" {
		t.Fatalf("monotonic Host contraction restarted observation: result=%#v err=%v", result, err)
	}
	*now = now.Add(16 * time.Second)
	result, err := controller.ReconcileOnce(context.Background())
	if err != nil || result.Action != "prepare-exact-scale-down-to-6" {
		t.Fatalf("preserved observation did not authorize one exact deletion: result=%#v err=%v", result, err)
	}
}

func TestRestartRestoresFenceCreatedBeforeDurableIntent(t *testing.T) {
	controller, dynamicClient, _ := fixture(t, 3, 4, false)
	node, err := controller.Kubernetes.CoreV1().Nodes().Get(
		context.Background(), "runtime-4", metav1.GetOptions{},
	)
	if err != nil {
		t.Fatal(err)
	}
	if err := controller.cordonOwnedNode(context.Background(), node, "machine-4"); err != nil {
		t.Fatal(err)
	}

	// A fresh controller has lost the in-memory stabilization state. Because no
	// MachineSet intent exists, the provider request was never armed or issued.
	restarted := *controller
	restarted.downscaleDesired = 0
	restarted.downscaleCurrent = 0
	restarted.downscaleSince = time.Time{}
	result, err := restarted.ReconcileOnce(context.Background())
	if err != nil || result.Action != "restore-orphaned-scale-down-fence" || result.Candidate != "runtime-4" {
		t.Fatalf("restart did not restore the orphaned fence: result=%#v err=%v", result, err)
	}
	node, err = restarted.Kubernetes.CoreV1().Nodes().Get(
		context.Background(), "runtime-4", metav1.GetOptions{},
	)
	if err != nil {
		t.Fatal(err)
	}
	if node.Annotations[DrainAnnotation] != "" || drainTaintIndex(node.Spec.Taints, "machine-4") >= 0 {
		t.Fatalf("restart retained an orphaned scale-down fence: %#v", node)
	}
	machineSet, err := dynamicClient.Resource(machineSetResource).Get(
		context.Background(), "np-runtime0", metav1.GetOptions{},
	)
	if err != nil {
		t.Fatal(err)
	}
	if machineSet.GetAnnotations()[DownscaleIntentAnnotation] != "" {
		t.Fatalf("orphan recovery invented a durable intent")
	}
	replicas, _, _ := unstructured.NestedInt64(machineSet.Object, "spec", "replicas")
	if replicas != 4 {
		t.Fatalf("orphan recovery changed MachineSet replicas to %d", replicas)
	}
	if requests := restarted.ExactScaleDown.(*fakeExactScaleDownProvider).requests; len(requests) != 0 {
		t.Fatalf("orphan recovery contacted the provider: %#v", requests)
	}
	if result, err = restarted.ReconcileOnce(context.Background()); err != nil || result.Action != "observe-scale-down" {
		t.Fatalf("scale-down stabilization did not restart: result=%#v err=%v", result, err)
	}
}

func TestStaleNoIntentSnapshotCannotClearCommittedScaleDownFence(t *testing.T) {
	controller, dynamicClient, now := fixture(t, 3, 4, false)
	ctx := context.Background()
	stale, err := dynamicClient.Resource(machineSetResource).Get(ctx, "np-runtime0", metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := controller.ReconcileOnce(ctx); err != nil {
		t.Fatal(err)
	}
	*now = now.Add(31 * time.Second)
	if _, err := controller.ReconcileOnce(ctx); err != nil {
		t.Fatal(err)
	}
	committed, err := dynamicClient.Resource(machineSetResource).Get(ctx, "np-runtime0", metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	// The fake tracker does not advance resourceVersion on mutation. Emulate
	// the API server's committed version before delivering one stale GET.
	committed.SetResourceVersion("2")
	if _, err := dynamicClient.Resource(machineSetResource).Update(ctx, committed, metav1.UpdateOptions{}); err != nil {
		t.Fatal(err)
	}
	delivered := false
	dynamicClient.PrependReactor("get", "machinesets", func(action k8stesting.Action) (bool, runtime.Object, error) {
		if delivered {
			return false, nil, nil
		}
		delivered = true
		return true, stale.DeepCopy(), nil
	})
	if _, err := controller.ReconcileOnce(ctx); err == nil || !strings.Contains(err.Error(), "confirm no exact scale-down intent") {
		t.Fatalf("stale no-intent snapshot did not fail closed: %v", err)
	}
	node, err := controller.Kubernetes.CoreV1().Nodes().Get(ctx, "runtime-4", metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if node.Annotations[DrainAnnotation] != "machine-4" || drainTaintIndex(node.Spec.Taints, "machine-4") < 0 {
		t.Fatalf("stale snapshot cleared the committed fence: %#v", node)
	}
	if requests := controller.ExactScaleDown.(*fakeExactScaleDownProvider).requests; len(requests) != 0 {
		t.Fatalf("stale snapshot reached provider: %#v", requests)
	}
	if result, err := controller.ReconcileOnce(ctx); err != nil || result.Action != "arm-exact-scale-down" {
		t.Fatalf("committed intent did not remain recoverable: result=%#v err=%v", result, err)
	}
}

func TestOrphanRecoveryProofFailurePreservesPlacementFence(t *testing.T) {
	controller, dynamicClient, _ := fixture(t, 3, 4, false)
	ctx := context.Background()
	node, err := controller.Kubernetes.CoreV1().Nodes().Get(ctx, "runtime-4", metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if err := controller.cordonOwnedNode(ctx, node, "machine-4"); err != nil {
		t.Fatal(err)
	}
	dynamicClient.PrependReactor("patch", "machinesets", func(action k8stesting.Action) (bool, runtime.Object, error) {
		return true, nil, fmt.Errorf("injected API proof failure")
	})
	if _, err := controller.ReconcileOnce(ctx); err == nil || !strings.Contains(err.Error(), "injected API proof failure") {
		t.Fatalf("proof failure was not surfaced: %v", err)
	}
	node, err = controller.Kubernetes.CoreV1().Nodes().Get(ctx, "runtime-4", metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if node.Annotations[DrainAnnotation] != "machine-4" || drainTaintIndex(node.Spec.Taints, "machine-4") < 0 {
		t.Fatalf("unconfirmed recovery cleared the fence: %#v", node)
	}
	if requests := controller.ExactScaleDown.(*fakeExactScaleDownProvider).requests; len(requests) != 0 {
		t.Fatalf("unconfirmed recovery reached provider: %#v", requests)
	}
}

func TestMissingExactScaleDownFenceRecovery(t *testing.T) {
	for _, scenario := range []struct {
		name      string
		armed     bool
		attempts  int
		requestID string
		nodeUID   types.UID
		owner     string
		wantAbort bool
	}{
		{name: "prepared", wantAbort: true},
		{name: "armed but not attempted", armed: true, wantAbort: true},
		{name: "ambiguous attempt", armed: true, attempts: 1},
		{name: "accepted request", armed: true, attempts: 1, requestID: "request-original"},
		{name: "replacement Node", nodeUID: "node-replaced"},
		{name: "different fence owner", owner: "machine-other"},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			controller, dynamicClient, now := fixture(t, 3, 4, false)
			ctx := context.Background()
			if _, err := controller.ReconcileOnce(ctx); err != nil {
				t.Fatal(err)
			}
			*now = now.Add(31 * time.Second)
			if _, err := controller.ReconcileOnce(ctx); err != nil {
				t.Fatal(err)
			}
			if scenario.armed {
				if _, err := controller.ReconcileOnce(ctx); err != nil {
					t.Fatal(err)
				}
			}
			machineSet, err := dynamicClient.Resource(machineSetResource).Get(ctx, "np-runtime0", metav1.GetOptions{})
			if err != nil {
				t.Fatal(err)
			}
			raw := machineSet.GetAnnotations()[DownscaleIntentAnnotation]
			if scenario.attempts > 0 || scenario.requestID != "" {
				var intent downscaleIntent
				if err := json.Unmarshal([]byte(raw), &intent); err != nil {
					t.Fatal(err)
				}
				intent.Attempts = scenario.attempts
				intent.RequestID = scenario.requestID
				if err := controller.persistDownscaleIntent(ctx, machineSet, raw, intent); err != nil {
					t.Fatal(err)
				}
				machineSet, err = dynamicClient.Resource(machineSetResource).Get(ctx, "np-runtime0", metav1.GetOptions{})
				if err != nil {
					t.Fatal(err)
				}
				raw = machineSet.GetAnnotations()[DownscaleIntentAnnotation]
			}
			node, err := controller.Kubernetes.CoreV1().Nodes().Get(ctx, "runtime-4", metav1.GetOptions{})
			if err != nil {
				t.Fatal(err)
			}
			delete(node.Annotations, DrainAnnotation)
			node.Spec.Taints = nil
			if scenario.nodeUID != "" {
				node.UID = scenario.nodeUID
			}
			if scenario.owner != "" {
				node.Annotations[DrainAnnotation] = scenario.owner
				node.Spec.Taints = []corev1.Taint{{Key: DrainTaintKey, Value: scenario.owner, Effect: corev1.TaintEffectNoSchedule}}
			}
			if _, err := controller.Kubernetes.CoreV1().Nodes().Update(ctx, node, metav1.UpdateOptions{}); err != nil {
				t.Fatal(err)
			}
			result, reconcileErr := controller.ReconcileOnce(ctx)
			latest, err := dynamicClient.Resource(machineSetResource).Get(ctx, "np-runtime0", metav1.GetOptions{})
			if err != nil {
				t.Fatal(err)
			}
			provider := controller.ExactScaleDown.(*fakeExactScaleDownProvider)
			if len(provider.requests) != 0 {
				t.Fatalf("missing fence reached provider: %#v", provider.requests)
			}
			if !scenario.wantAbort {
				if reconcileErr == nil || !strings.Contains(reconcileErr.Error(), "ownership fence changed") || latest.GetAnnotations()[DownscaleIntentAnnotation] != raw {
					t.Fatalf("unsafe recovery did not preserve the intent: result=%#v err=%v", result, reconcileErr)
				}
				return
			}
			if reconcileErr != nil || result.Action != "abort-unfenced-exact-scale-down" || latest.GetAnnotations()[DownscaleIntentAnnotation] != "" {
				t.Fatalf("pre-provider intent was not safely cancelled: result=%#v err=%v", result, reconcileErr)
			}
			if result, err := controller.ReconcileOnce(ctx); err != nil || result.Action != "observe-scale-down" {
				t.Fatalf("recovery skipped fresh stabilization: result=%#v err=%v", result, err)
			}
			*now = now.Add(31 * time.Second)
			for _, want := range []string{"prepare-exact-scale-down-to-3", "arm-exact-scale-down", "request-exact-scale-down", "complete-exact-scale-down-to-3"} {
				if result, err := controller.ReconcileOnce(ctx); err != nil || result.Action != want {
					t.Fatalf("fresh recovery transition %s failed: result=%#v err=%v", want, result, err)
				}
			}
			if len(provider.requests) != 1 {
				t.Fatalf("recovery did not delete exactly one Machine: %#v", provider.requests)
			}
		})
	}
}

func TestExactScaleDownConvergesOneMachineAtATimeFromSevenToThree(t *testing.T) {
	controller, dynamicClient, now := fixture(t, 3, 7, false)
	provider := controller.ExactScaleDown.(*fakeExactScaleDownProvider)
	if result, err := controller.ReconcileOnce(context.Background()); err != nil || result.Action != "observe-scale-down" {
		t.Fatalf("initial observation failed: result=%#v err=%v", result, err)
	}
	*now = now.Add(31 * time.Second)
	for from := int64(7); from > 3; from-- {
		to := from - 1
		wantCandidate := fmt.Sprintf("np-runtime0-%d", from)
		for _, want := range []string{
			fmt.Sprintf("prepare-exact-scale-down-to-%d", to),
			"arm-exact-scale-down",
			"request-exact-scale-down",
			fmt.Sprintf("complete-exact-scale-down-to-%d", to),
		} {
			result, err := controller.ReconcileOnce(context.Background())
			if err != nil || result.Action != want || (strings.HasPrefix(want, "prepare-") && result.Candidate != wantCandidate) {
				t.Fatalf("%d->%d transition %s failed: result=%#v err=%v", from, to, want, result, err)
			}
		}
	}
	if len(provider.requests) != 4 {
		t.Fatalf("provider requests = %d, want 4", len(provider.requests))
	}
	machineSet, err := dynamicClient.Resource(machineSetResource).Get(context.Background(), "np-runtime0", metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	replicas, _, _ := unstructured.NestedInt64(machineSet.Object, "spec", "replicas")
	if replicas != 3 {
		t.Fatalf("MachineSet replicas = %d, want 3", replicas)
	}
}

func TestNormalScaleDownNeverUsesGenericMachineSetReplicaPatch(t *testing.T) {
	controller, dynamicClient, now := fixture(t, 3, 4, false)
	if _, err := controller.ReconcileOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	*now = now.Add(31 * time.Second)
	for range 3 {
		if _, err := controller.ReconcileOnce(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	for _, action := range dynamicClient.Actions() {
		patch, ok := action.(k8stesting.PatchAction)
		if ok && action.GetResource().Resource == "machinesets" && strings.Contains(string(patch.GetPatch()), `"/spec/replicas"`) {
			t.Fatalf("normal scale-down used ambiguous MachineSet contraction: %s", patch.GetPatch())
		}
	}
}

func TestExactScaleDownResponseLossConvergesAfterControllerRestart(t *testing.T) {
	controller, dynamicClient, now := fixture(t, 3, 4, false)
	baseProvider := controller.ExactScaleDown.(*fakeExactScaleDownProvider)
	provider := &fakeExactScaleDownProvider{handle: func(request ExactScaleDownRequest) (ExactScaleDownResponse, error) {
		if err := baseProvider.apply(request); err != nil {
			return ExactScaleDownResponse{}, err
		}
		return ExactScaleDownResponse{}, io.ErrUnexpectedEOF
	}}
	controller.ExactScaleDown = provider
	if _, err := controller.ReconcileOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	*now = now.Add(31 * time.Second)
	if result, err := controller.ReconcileOnce(context.Background()); err != nil || result.Action != "prepare-exact-scale-down-to-3" {
		t.Fatalf("prepare failed: result=%#v err=%v", result, err)
	}
	if result, err := controller.ReconcileOnce(context.Background()); err != nil || result.Action != "arm-exact-scale-down" {
		t.Fatalf("arm failed: result=%#v err=%v", result, err)
	}
	if _, err := controller.ReconcileOnce(context.Background()); err == nil || !strings.Contains(err.Error(), "unexpected EOF") {
		t.Fatalf("response loss was not surfaced: %v", err)
	}

	controller = &Controller{
		Kubernetes: controller.Kubernetes, Dynamic: dynamicClient, ExactScaleDown: provider,
		Config: controller.Config, Now: controller.Now,
	}
	result, err := controller.ReconcileOnce(context.Background())
	if err != nil || result.Action != "complete-exact-scale-down-to-3" {
		t.Fatalf("restart did not reconcile ambiguous success: result=%#v err=%v", result, err)
	}
	if len(provider.requests) != 1 {
		t.Fatalf("ambiguous success was unnecessarily reissued: %#v", provider.requests)
	}
	machineSet, err := dynamicClient.Resource(machineSetResource).Get(context.Background(), "np-runtime0", metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	var receipt downscaleReceipt
	rawReceipt := machineSet.GetAnnotations()[DownscaleReceiptAnnotation]
	if rawReceipt == "" || json.Unmarshal([]byte(rawReceipt), &receipt) != nil ||
		receipt.Version != downscaleReceiptVersion ||
		receipt.Outcome != downscaleOutcomeAmbiguousExactConvergence ||
		receipt.Intent.RequestID != "" || receipt.Intent.Attempts != 1 {
		t.Fatalf("ambiguous success receipt is incomplete: %q", rawReceipt)
	}
}

func TestAmbiguousExactScaleDownWithoutObservedMutationIsNeverRetried(t *testing.T) {
	controller, _, now := fixture(t, 3, 4, false)
	provider := &fakeExactScaleDownProvider{err: io.ErrUnexpectedEOF}
	controller.ExactScaleDown = provider
	if _, err := controller.ReconcileOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	*now = now.Add(31 * time.Second)
	for _, want := range []string{"prepare-exact-scale-down-to-3", "arm-exact-scale-down"} {
		result, err := controller.ReconcileOnce(context.Background())
		if err != nil || result.Action != want {
			t.Fatalf("transition %s failed: result=%#v err=%v", want, result, err)
		}
	}
	if _, err := controller.ReconcileOnce(context.Background()); err == nil || !strings.Contains(err.Error(), "unexpected EOF") {
		t.Fatalf("ambiguous response loss was not surfaced: %v", err)
	}
	*now = now.Add(time.Minute)
	controller = &Controller{
		Kubernetes: controller.Kubernetes, Dynamic: controller.Dynamic, ExactScaleDown: provider,
		Config: controller.Config, Now: controller.Now,
	}
	result, err := controller.ReconcileOnce(context.Background())
	if err != nil || result.Action != "await-ambiguous-exact-scale-down" {
		t.Fatalf("ambiguous operation did not fail closed: result=%#v err=%v", result, err)
	}
	if len(provider.requests) != 1 {
		t.Fatalf("ambiguous destructive operation was submitted %d times", len(provider.requests))
	}
}

func TestAcceptedExactScaleDownIsNeverSubmittedTwiceWhileProviderConverges(t *testing.T) {
	controller, _, now := fixture(t, 3, 4, false)
	provider := &fakeExactScaleDownProvider{}
	controller.ExactScaleDown = provider
	if _, err := controller.ReconcileOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	*now = now.Add(31 * time.Second)
	for _, want := range []string{"prepare-exact-scale-down-to-3", "arm-exact-scale-down", "request-exact-scale-down"} {
		result, err := controller.ReconcileOnce(context.Background())
		if err != nil || result.Action != want {
			t.Fatalf("transition %s failed: result=%#v err=%v", want, result, err)
		}
	}
	*now = now.Add(time.Minute)
	result, err := controller.ReconcileOnce(context.Background())
	if err != nil || result.Action != "await-accepted-exact-scale-down" {
		t.Fatalf("accepted request was not observed safely: result=%#v err=%v", result, err)
	}
	if len(provider.requests) != 1 {
		t.Fatalf("accepted provider operation was submitted %d times", len(provider.requests))
	}
}

func TestPreparedExactScaleDownAbortsForConcurrentHPAIncrease(t *testing.T) {
	controller, _, now := fixture(t, 3, 4, false)
	provider := controller.ExactScaleDown.(*fakeExactScaleDownProvider)
	if _, err := controller.ReconcileOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	*now = now.Add(31 * time.Second)
	if result, err := controller.ReconcileOnce(context.Background()); err != nil || result.Action != "prepare-exact-scale-down-to-3" {
		t.Fatalf("prepare failed: result=%#v err=%v", result, err)
	}
	statefulSet, err := controller.Kubernetes.AppsV1().StatefulSets(controller.Config.Namespace).Get(
		context.Background(), controller.Config.StatefulSetName, metav1.GetOptions{},
	)
	if err != nil {
		t.Fatal(err)
	}
	replicas := int32(4)
	statefulSet.Spec.Replicas = &replicas
	if _, err := controller.Kubernetes.AppsV1().StatefulSets(controller.Config.Namespace).Update(
		context.Background(), statefulSet, metav1.UpdateOptions{},
	); err != nil {
		t.Fatal(err)
	}
	result, err := controller.ReconcileOnce(context.Background())
	if err != nil || result.Action != "abort-prepared-exact-scale-down" {
		t.Fatalf("HPA increase did not abort prepared scale-down: result=%#v err=%v", result, err)
	}
	node, err := controller.Kubernetes.CoreV1().Nodes().Get(context.Background(), "runtime-4", metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if node.Annotations[DrainAnnotation] != "" || drainTaintIndex(node.Spec.Taints, "machine-4") >= 0 {
		t.Fatalf("aborted operation retained its placement fence: %#v", node)
	}
	if len(provider.requests) != 0 {
		t.Fatalf("aborted prepared operation reached provider: %#v", provider.requests)
	}
}

func TestPreparedExactScaleDownRefreshesForConcurrentHostContraction(t *testing.T) {
	controller, _, now := fixture(t, 5, 7, false)
	provider := controller.ExactScaleDown.(*fakeExactScaleDownProvider)
	if _, err := controller.ReconcileOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	*now = now.Add(31 * time.Second)
	if result, err := controller.ReconcileOnce(context.Background()); err != nil || result.Action != "prepare-exact-scale-down-to-6" {
		t.Fatalf("prepare failed: result=%#v err=%v", result, err)
	}
	setRuntimeHostReplicas(t, controller, 4)
	if result, err := controller.ReconcileOnce(context.Background()); err != nil || result.Action != "refresh-prepared-exact-scale-down" {
		t.Fatalf("Host contraction did not refresh prepared intent: result=%#v err=%v", result, err)
	}
	if result, err := controller.ReconcileOnce(context.Background()); err != nil || result.Action != "arm-exact-scale-down" {
		t.Fatalf("refreshed prepared intent did not arm: result=%#v err=%v", result, err)
	}
	if len(provider.requests) != 0 {
		t.Fatalf("prepared refresh contacted provider: %#v", provider.requests)
	}
}

func TestArmedExactScaleDownAbortsBeforeProviderForConcurrentHPAIncrease(t *testing.T) {
	controller, _, now := fixture(t, 3, 7, false)
	provider := controller.ExactScaleDown.(*fakeExactScaleDownProvider)
	if _, err := controller.ReconcileOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	*now = now.Add(31 * time.Second)
	for _, want := range []string{"prepare-exact-scale-down-to-6", "arm-exact-scale-down"} {
		result, err := controller.ReconcileOnce(context.Background())
		if err != nil || result.Action != want {
			t.Fatalf("transition %s failed: result=%#v err=%v", want, result, err)
		}
	}
	statefulSet, err := controller.Kubernetes.AppsV1().StatefulSets(controller.Config.Namespace).Get(
		context.Background(), controller.Config.StatefulSetName, metav1.GetOptions{},
	)
	if err != nil {
		t.Fatal(err)
	}
	replicas := int32(4)
	statefulSet.Spec.Replicas = &replicas
	if _, err := controller.Kubernetes.AppsV1().StatefulSets(controller.Config.Namespace).Update(
		context.Background(), statefulSet, metav1.UpdateOptions{},
	); err != nil {
		t.Fatal(err)
	}
	result, err := controller.ReconcileOnce(context.Background())
	if err != nil || result.Action != "abort-armed-exact-scale-down" {
		t.Fatalf("HPA increase did not abort armed scale-down: result=%#v err=%v", result, err)
	}
	if len(provider.requests) != 0 {
		t.Fatalf("aborted armed operation reached provider: %#v", provider.requests)
	}
}

func TestArmedExactScaleDownRefreshesForConcurrentHostContraction(t *testing.T) {
	controller, _, now := fixture(t, 5, 7, false)
	provider := controller.ExactScaleDown.(*fakeExactScaleDownProvider)
	if _, err := controller.ReconcileOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	*now = now.Add(31 * time.Second)
	for _, want := range []string{"prepare-exact-scale-down-to-6", "arm-exact-scale-down"} {
		result, err := controller.ReconcileOnce(context.Background())
		if err != nil || result.Action != want {
			t.Fatalf("transition %s failed: result=%#v err=%v", want, result, err)
		}
	}
	setRuntimeHostReplicas(t, controller, 4)
	if result, err := controller.ReconcileOnce(context.Background()); err != nil || result.Action != "refresh-armed-exact-scale-down" {
		t.Fatalf("Host contraction did not refresh armed intent: result=%#v err=%v", result, err)
	}
	if result, err := controller.ReconcileOnce(context.Background()); err != nil || result.Action != "request-exact-scale-down" {
		t.Fatalf("refreshed armed intent did not reach provider: result=%#v err=%v", result, err)
	}
	if len(provider.requests) != 1 {
		t.Fatalf("refreshed armed intent submitted %d provider requests", len(provider.requests))
	}
}

func TestIssuedExactScaleDownAcceptsNodeFirstProviderConvergence(t *testing.T) {
	controller, dynamicClient, now := fixture(t, 5, 7, false)
	if _, err := controller.ReconcileOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	*now = now.Add(31 * time.Second)
	for _, want := range []string{"prepare-exact-scale-down-to-6", "arm-exact-scale-down"} {
		result, err := controller.ReconcileOnce(context.Background())
		if err != nil || result.Action != want {
			t.Fatalf("transition %s failed: result=%#v err=%v", want, result, err)
		}
	}
	provider := controller.ExactScaleDown.(*fakeExactScaleDownProvider)
	provider.apply = func(request ExactScaleDownRequest) error {
		if err := controller.Kubernetes.CoreV1().Nodes().Delete(
			context.Background(), request.NodeName, metav1.DeleteOptions{},
		); err != nil {
			return err
		}
		machineSet, err := dynamicClient.Resource(machineSetResource).Get(
			context.Background(), request.MachineSetName, metav1.GetOptions{},
		)
		if err != nil {
			return err
		}
		if err := unstructured.SetNestedField(machineSet.Object, request.ToReplicas, "spec", "replicas"); err != nil {
			return err
		}
		if err := unstructured.SetNestedField(machineSet.Object, request.ToReplicas, "status", "replicas"); err != nil {
			return err
		}
		if err := unstructured.SetNestedField(machineSet.Object, request.ToReplicas, "status", "readyReplicas"); err != nil {
			return err
		}
		_, err = dynamicClient.Resource(machineSetResource).Update(context.Background(), machineSet, metav1.UpdateOptions{})
		return err
	}
	if result, err := controller.ReconcileOnce(context.Background()); err != nil || result.Action != "request-exact-scale-down" {
		t.Fatalf("provider request failed: result=%#v err=%v", result, err)
	}
	result, err := controller.ReconcileOnce(context.Background())
	if err != nil || result.Action != "await-exact-scale-down-deletion" {
		t.Fatalf("Node-first convergence was not observed safely: result=%#v err=%v", result, err)
	}
	assertMachineExists(t, dynamicClient, "np-runtime0-7", true)
}

func TestExactScaleDownRejectsMachineUIDReplacement(t *testing.T) {
	controller, dynamicClient, now := fixture(t, 3, 4, false)
	provider := controller.ExactScaleDown.(*fakeExactScaleDownProvider)
	if _, err := controller.ReconcileOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	*now = now.Add(31 * time.Second)
	if _, err := controller.ReconcileOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	machine, err := dynamicClient.Resource(machineResource).Get(context.Background(), "np-runtime0-4", metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	machine.SetUID(types.UID("replacement-machine"))
	if _, err := dynamicClient.Resource(machineResource).Update(context.Background(), machine, metav1.UpdateOptions{}); err != nil {
		t.Fatal(err)
	}
	if _, err := controller.ReconcileOnce(context.Background()); err == nil || !strings.Contains(err.Error(), "Machine UID changed") {
		t.Fatalf("Machine replacement did not fail closed: %v", err)
	}
	if len(provider.requests) != 0 {
		t.Fatalf("replaced Machine reached provider: %#v", provider.requests)
	}
}

func TestScaleDownWithoutProviderFailsBeforePlacementMutation(t *testing.T) {
	controller, _, now := fixture(t, 3, 4, false)
	controller.ExactScaleDown = nil
	if _, err := controller.ReconcileOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	*now = now.Add(31 * time.Second)
	if _, err := controller.ReconcileOnce(context.Background()); err == nil || !strings.Contains(err.Error(), "exact provider scale-down is unavailable") {
		t.Fatalf("missing provider did not fail closed: %v", err)
	}
	node, err := controller.Kubernetes.CoreV1().Nodes().Get(context.Background(), "runtime-4", metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if node.Annotations[DrainAnnotation] != "" || drainTaintIndex(node.Spec.Taints, "machine-4") >= 0 {
		t.Fatalf("missing provider mutated placement: %#v", node)
	}
}

func TestScaleDownIntentPersistenceFailureRestoresPlacement(t *testing.T) {
	controller, dynamicClient, now := fixture(t, 3, 4, false)
	if _, err := controller.ReconcileOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	*now = now.Add(31 * time.Second)
	dynamicClient.PrependReactor("patch", "machinesets", func(action k8stesting.Action) (bool, runtime.Object, error) {
		return true, nil, fmt.Errorf("injected intent persistence failure")
	})
	if _, err := controller.ReconcileOnce(context.Background()); err == nil || !strings.Contains(err.Error(), "injected intent persistence failure") {
		t.Fatalf("intent persistence failure was not surfaced: %v", err)
	}
	node, err := controller.Kubernetes.CoreV1().Nodes().Get(context.Background(), "runtime-4", metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if node.Annotations[DrainAnnotation] != "" || drainTaintIndex(node.Spec.Taints, "machine-4") >= 0 {
		t.Fatalf("failed intent persistence stranded a placement fence: %#v", node)
	}
}

func TestHPAIncreaseAfterPlacementFenceRestoresNodeBeforeIntent(t *testing.T) {
	controller, _, now := fixture(t, 3, 4, false)
	if _, err := controller.ReconcileOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	*now = now.Add(31 * time.Second)
	kube := controller.Kubernetes.(*kubefake.Clientset)
	kube.PrependReactor("patch", "nodes", func(action k8stesting.Action) (bool, runtime.Object, error) {
		patch := action.(k8stesting.PatchAction).GetPatch()
		if !strings.Contains(string(patch), escapeJSONPointer(DrainAnnotation)) || !strings.Contains(string(patch), `"op":"add"`) {
			return false, nil, nil
		}
		resource := appsv1.SchemeGroupVersion.WithResource("statefulsets")
		object, err := kube.Tracker().Get(resource, controller.Config.Namespace, controller.Config.StatefulSetName)
		if err != nil {
			return true, nil, err
		}
		statefulSet := object.(*appsv1.StatefulSet).DeepCopy()
		replicas := int32(4)
		statefulSet.Spec.Replicas = &replicas
		if err := kube.Tracker().Update(resource, statefulSet, controller.Config.Namespace); err != nil {
			return true, nil, err
		}
		return false, nil, nil
	})
	if result, err := controller.ReconcileOnce(context.Background()); err != nil || result.Action != "" {
		t.Fatalf("concurrent HPA increase did not abort cleanly: result=%#v err=%v", result, err)
	}
	node, err := controller.Kubernetes.CoreV1().Nodes().Get(context.Background(), "runtime-4", metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if node.Annotations[DrainAnnotation] != "" || drainTaintIndex(node.Spec.Taints, "machine-4") >= 0 {
		t.Fatalf("concurrent HPA increase stranded a placement fence: %#v", node)
	}
}

func TestScaleDownSelectsDrainedEmptyMachineWhenNewestNodeHasWorkload(t *testing.T) {
	controller, dynamicClient, now := fixture(t, 3, 4, true)
	if _, err := controller.ReconcileOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	*now = now.Add(31 * time.Second)
	result, err := controller.ReconcileOnce(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if result.Action != "prepare-exact-scale-down-to-3" || result.Candidate != "np-runtime0-3" {
		t.Fatalf("scale-down did not select the newest empty Machine: %#v", result)
	}
	machineSet, err := dynamicClient.Resource(machineSetResource).Get(context.Background(), "np-runtime0", metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	replicas, _, _ := unstructured.NestedInt64(machineSet.Object, "spec", "replicas")
	if replicas != 4 {
		t.Fatalf("prepared exact scale-down changed MachineSet replicas to %d", replicas)
	}
	busy, err := controller.Kubernetes.CoreV1().Nodes().Get(context.Background(), "runtime-4", metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if busy.Spec.Unschedulable || busy.Annotations[DrainAnnotation] != "" || drainTaintIndex(busy.Spec.Taints, "machine-4") >= 0 {
		t.Fatalf("busy newest node was modified: %#v", busy)
	}
	empty, err := controller.Kubernetes.CoreV1().Nodes().Get(context.Background(), "runtime-3", metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if empty.Annotations[DrainAnnotation] != "machine-3" || drainTaintIndex(empty.Spec.Taints, "machine-3") < 0 {
		t.Fatalf("selected empty node was not fenced: %#v", empty)
	}
}

func TestScaleDownFailsClosedWhenNoMachineIsEmpty(t *testing.T) {
	controller, dynamicClient, now := fixture(t, 3, 4, true)
	for index := 1; index <= 3; index++ {
		_, err := controller.Kubernetes.CoreV1().Pods("default").Create(context.Background(), &corev1.Pod{
			ObjectMeta: metav1.ObjectMeta{Name: fmt.Sprintf("workload-%d", index), Namespace: "default"},
			Spec:       corev1.PodSpec{NodeName: fmt.Sprintf("runtime-%d", index)},
			Status:     corev1.PodStatus{Phase: corev1.PodRunning},
		}, metav1.CreateOptions{})
		if err != nil {
			t.Fatal(err)
		}
	}
	if _, err := controller.ReconcileOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	*now = now.Add(31 * time.Second)
	if _, err := controller.ReconcileOnce(context.Background()); err == nil || !strings.Contains(err.Error(), "no empty runtime Machine") {
		t.Fatalf("expected all busy Machines to block scale-down, got %v", err)
	}
	machineSet, err := dynamicClient.Resource(machineSetResource).Get(context.Background(), "np-runtime0", metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	replicas, _, _ := unstructured.NestedInt64(machineSet.Object, "spec", "replicas")
	if replicas != 4 {
		t.Fatalf("busy-node failure changed MachineSet replicas to %d", replicas)
	}
}

func TestQualificationHoldSuppressesOnlyScaleDown(t *testing.T) {
	controller, dynamicClient, _ := fixture(t, 3, 4, false)
	machineSet, err := dynamicClient.Resource(machineSetResource).Get(context.Background(), "np-runtime0", metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	machineSet.SetAnnotations(map[string]string{QualificationHoldAnnotation: "qualification-attempt"})
	if _, err := dynamicClient.Resource(machineSetResource).Update(context.Background(), machineSet, metav1.UpdateOptions{}); err != nil {
		t.Fatal(err)
	}
	result, err := controller.ReconcileOnce(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if result.Action != "qualification-holds-scale-down" {
		t.Fatalf("qualification hold did not suppress contraction: %#v", result)
	}
	machineSet, err = dynamicClient.Resource(machineSetResource).Get(context.Background(), "np-runtime0", metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	replicas, _, _ := unstructured.NestedInt64(machineSet.Object, "spec", "replicas")
	if replicas != 4 {
		t.Fatalf("qualification hold changed MachineSet replicas to %d", replicas)
	}

	statefulSet, err := controller.Kubernetes.AppsV1().StatefulSets(controller.Config.Namespace).Get(context.Background(), controller.Config.StatefulSetName, metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	five := int32(5)
	statefulSet.Spec.Replicas = &five
	if _, err := controller.Kubernetes.AppsV1().StatefulSets(controller.Config.Namespace).Update(context.Background(), statefulSet, metav1.UpdateOptions{}); err != nil {
		t.Fatal(err)
	}
	result, err = controller.ReconcileOnce(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if result.Action != "scale-up-to-5" {
		t.Fatalf("qualification hold incorrectly blocked demand scale-up: %#v", result)
	}
}

func TestQuarantinedNodeAddsOnlyOneRepairSurge(t *testing.T) {
	controller, dynamicClient, _ := fixture(t, 4, 4, false)
	setQuarantined(t, controller, "runtime-4", "machine-4")
	result, err := controller.ReconcileOnce(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if result.Action != "scale-up-to-5" {
		t.Fatalf("unexpected repair action: %#v", result)
	}
	machineSet, err := dynamicClient.Resource(machineSetResource).Get(context.Background(), "np-runtime0", metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	replicas, _, _ := unstructured.NestedInt64(machineSet.Object, "spec", "replicas")
	if replicas != 5 {
		t.Fatalf("repair surge replicas = %d, want 5", replicas)
	}
}

func TestSteadyBaselineTopologySkewQuarantinesNewestNodeInOverrepresentedZone(t *testing.T) {
	controller, _, _ := fixture(t, 3, 3, false)
	controller.Config.TargetedRepairEnabled = true
	controller.Config.RequiredZones = 3
	for _, name := range []string{"runtime-1", "runtime-2"} {
		node, err := controller.Kubernetes.CoreV1().Nodes().Get(context.Background(), name, metav1.GetOptions{})
		if err != nil {
			t.Fatal(err)
		}
		node.Labels[corev1.LabelTopologyZone] = "zone-a"
		if _, err := controller.Kubernetes.CoreV1().Nodes().Update(context.Background(), node, metav1.UpdateOptions{}); err != nil {
			t.Fatal(err)
		}
	}
	node, err := controller.Kubernetes.CoreV1().Nodes().Get(context.Background(), "runtime-3", metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	node.Labels[corev1.LabelTopologyZone] = "zone-b"
	if _, err := controller.Kubernetes.CoreV1().Nodes().Update(context.Background(), node, metav1.UpdateOptions{}); err != nil {
		t.Fatal(err)
	}

	result, err := controller.ReconcileOnce(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if result.Action != "quarantine-runtime-topology-skew" || result.Candidate != "np-runtime0-2" {
		t.Fatalf("unexpected topology repair: %#v", result)
	}
	node, err = controller.Kubernetes.CoreV1().Nodes().Get(context.Background(), "runtime-2", metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	state, err := admission.DecodeState(node.Annotations[admission.StateAnnotation])
	if err != nil {
		t.Fatal(err)
	}
	if state.Phase != admission.PhaseQuarantined || node.Labels[admission.AdmittedLabel] != "" ||
		!hasExactTaint(node.Spec.Taints, admission.PendingTaintKey, "pending", corev1.TaintEffectNoSchedule) {
		t.Fatalf("topology repair target was not fenced: node=%#v state=%#v", node, state)
	}
}

func TestBalancedSteadyBaselineDoesNotStartTopologyRepair(t *testing.T) {
	controller, _, _ := fixture(t, 3, 3, false)
	controller.Config.TargetedRepairEnabled = true
	controller.Config.RequiredZones = 3
	result, err := controller.ReconcileOnce(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if result.Action != "" {
		t.Fatalf("balanced topology started a repair: %#v", result)
	}
}

func TestFinalContractionDrainsOverrepresentedZoneInsteadOfDeletingEmptyBalanceNode(t *testing.T) {
	controller, _, now := fixture(t, 3, 4, false)
	controller.Config.RequiredZones = 3
	zones := map[string]string{
		"runtime-1": "zone-a",
		"runtime-2": "zone-a",
		"runtime-3": "zone-b",
		"runtime-4": "zone-c",
	}
	for name, zone := range zones {
		node, err := controller.Kubernetes.CoreV1().Nodes().Get(context.Background(), name, metav1.GetOptions{})
		if err != nil {
			t.Fatal(err)
		}
		node.Labels[corev1.LabelTopologyZone] = zone
		if _, err := controller.Kubernetes.CoreV1().Nodes().Update(context.Background(), node, metav1.UpdateOptions{}); err != nil {
			t.Fatal(err)
		}
	}
	// The balancing Machine in zone-c is newest and empty. The three existing
	// Hosts still occupy zone-a/zone-a/zone-b, so deleting runtime-4 would leave
	// only two balanced Host slots and trigger the observed add/delete loop.
	addReadyRuntimeHosts(t, controller, []string{"runtime-1", "runtime-2", "runtime-3"})

	first, err := controller.ReconcileOnce(context.Background())
	if err != nil || first.Action != "observe-scale-down" {
		t.Fatalf("unexpected first contraction action: result=%#v err=%v", first, err)
	}
	*now = now.Add(31 * time.Second)
	second, err := controller.ReconcileOnce(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if second.Action != "quarantine-runtime-topology-contraction" || second.Candidate != "np-runtime0-2" {
		t.Fatalf("unsafe empty balance Node was selected: %#v", second)
	}
	for _, name := range []string{"runtime-2", "runtime-4"} {
		node, err := controller.Kubernetes.CoreV1().Nodes().Get(context.Background(), name, metav1.GetOptions{})
		if err != nil {
			t.Fatal(err)
		}
		state, err := admission.DecodeState(node.Annotations[admission.StateAnnotation])
		if err != nil {
			t.Fatal(err)
		}
		want := admission.PhaseAdmitted
		if name == "runtime-2" {
			want = admission.PhaseQuarantined
		}
		if state.Phase != want {
			t.Fatalf("Node %s phase = %s, want %s", name, state.Phase, want)
		}
		if name == "runtime-2" && !strings.HasPrefix(state.AttemptUID, "topology-contraction-") {
			t.Fatalf("topology contraction identity is missing: %#v", state)
		}
	}
	third, err := controller.ReconcileOnce(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if third.Action != "start-quarantined-host-drain" || third.Candidate != "np-runtime0-2" {
		t.Fatalf("topology contraction did not enter the exact drain protocol with targeted repair disabled: %#v", third)
	}
}

func TestTopologyContractionSurvivesFurtherHPADecreaseOneExactMachineAtATime(t *testing.T) {
	controller, dynamicClient, _ := fixture(t, 3, 5, false)
	controller.Config.RequiredZones = 3
	setQuarantined(t, controller, "runtime-2", "machine-2")
	node, err := controller.Kubernetes.CoreV1().Nodes().Get(context.Background(), "runtime-2", metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	state, err := admission.DecodeState(node.Annotations[admission.StateAnnotation])
	if err != nil {
		t.Fatal(err)
	}
	state.AttemptUID = "topology-contraction-machine-2-attempt"
	raw, err := admission.EncodeState(state)
	if err != nil {
		t.Fatal(err)
	}
	node.Annotations[admission.StateAnnotation] = raw
	if _, err := controller.Kubernetes.CoreV1().Nodes().Update(context.Background(), node, metav1.UpdateOptions{}); err != nil {
		t.Fatal(err)
	}
	addReadyRuntimeHosts(t, controller, []string{"runtime-1", "runtime-3", "runtime-4"})

	result, err := controller.ReconcileOnce(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if result.Action != "prepare-exact-topology-contraction-to-4" || result.Candidate != "np-runtime0-2" {
		t.Fatalf("continued HPA decrease did not preserve one exact contraction: %#v", result)
	}
	assertMachineExists(t, dynamicClient, "np-runtime0-2", true)
	machineSet, err := dynamicClient.Resource(machineSetResource).Get(context.Background(), "np-runtime0", metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	var intent downscaleIntent
	if raw := machineSet.GetAnnotations()[DownscaleIntentAnnotation]; raw == "" || json.Unmarshal([]byte(raw), &intent) != nil {
		t.Fatalf("topology contraction did not persist an exact intent: %q", raw)
	}
	if intent.MachineUID != "machine-2" || intent.DesiredHosts != 3 || intent.FromReplicas != 5 || intent.ToReplicas != 4 {
		t.Fatalf("topology contraction intent widened its deletion: %#v", intent)
	}
	next, err := controller.ReconcileOnce(context.Background())
	if err != nil || next.Action != "arm-exact-scale-down" {
		t.Fatalf("topology contraction did not enter the existing provider protocol: result=%#v err=%v", next, err)
	}
}

func TestTopologyCapacityAddsNodesWhenZoneSkewBlocksDesiredHosts(t *testing.T) {
	controller, dynamicClient, _ := fixture(t, 10, 10, false)
	controller.Config.RequiredZones = 3
	nodes, err := controller.Kubernetes.CoreV1().Nodes().List(context.Background(), metav1.ListOptions{})
	if err != nil {
		t.Fatal(err)
	}
	zones := []string{
		"zone-a", "zone-a", "zone-a", "zone-a", "zone-a",
		"zone-b",
		"zone-c", "zone-c", "zone-c", "zone-c",
	}
	if len(nodes.Items) != len(zones) {
		t.Fatalf("fixture Nodes = %d, want %d", len(nodes.Items), len(zones))
	}
	for index := range nodes.Items {
		node := nodes.Items[index].DeepCopy()
		node.Labels[corev1.LabelTopologyZone] = zones[index]
		if _, err := controller.Kubernetes.CoreV1().Nodes().Update(context.Background(), node, metav1.UpdateOptions{}); err != nil {
			t.Fatal(err)
		}
	}
	statefulSet, err := controller.Kubernetes.AppsV1().StatefulSets(controller.Config.Namespace).Get(
		context.Background(), controller.Config.StatefulSetName, metav1.GetOptions{},
	)
	if err != nil {
		t.Fatal(err)
	}
	statefulSet.Status.ReadyReplicas = 5
	if _, err := controller.Kubernetes.AppsV1().StatefulSets(controller.Config.Namespace).UpdateStatus(
		context.Background(), statefulSet, metav1.UpdateOptions{},
	); err != nil {
		t.Fatal(err)
	}

	result, err := controller.ReconcileOnce(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if result.Action != "scale-up-to-11" {
		t.Fatalf("unexpected topology capacity action: %#v", result)
	}
	machineSet, err := dynamicClient.Resource(machineSetResource).Get(context.Background(), "np-runtime0", metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	replicas, _, _ := unstructured.NestedInt64(machineSet.Object, "spec", "replicas")
	if replicas != 11 {
		t.Fatalf("topology capacity replicas = %d, want 11", replicas)
	}
}

func TestTopologyCapacityWaitsForCurrentMachineTargetBeforeAddingMore(t *testing.T) {
	controller, dynamicClient, _ := fixture(t, 10, 10, false)
	controller.Config.RequiredZones = 3
	machineSet, err := dynamicClient.Resource(machineSetResource).Get(context.Background(), "np-runtime0", metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if err := unstructured.SetNestedField(machineSet.Object, int64(9), "status", "replicas"); err != nil {
		t.Fatal(err)
	}
	if _, err := dynamicClient.Resource(machineSetResource).Update(context.Background(), machineSet, metav1.UpdateOptions{}); err != nil {
		t.Fatal(err)
	}

	result, err := controller.ReconcileOnce(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if result.Action != "" {
		t.Fatalf("in-flight Machine target triggered another topology step: %#v", result)
	}
	machineSet, err = dynamicClient.Resource(machineSetResource).Get(context.Background(), "np-runtime0", metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	replicas, _, _ := unstructured.NestedInt64(machineSet.Object, "spec", "replicas")
	if replicas != 10 {
		t.Fatalf("in-flight topology target changed to %d", replicas)
	}
}

func TestTopologyCapacityWaitsForReadyReplicasBeforeAddingMore(t *testing.T) {
	controller, dynamicClient, _ := fixture(t, 10, 10, false)
	controller.Config.RequiredZones = 3
	nodes, err := controller.Kubernetes.CoreV1().Nodes().List(context.Background(), metav1.ListOptions{})
	if err != nil {
		t.Fatal(err)
	}
	zones := []string{
		"zone-a", "zone-a", "zone-a", "zone-a", "zone-a",
		"zone-b",
		"zone-c", "zone-c", "zone-c", "zone-c",
	}
	for index := range nodes.Items {
		node := nodes.Items[index].DeepCopy()
		node.Labels[corev1.LabelTopologyZone] = zones[index]
		if _, err := controller.Kubernetes.CoreV1().Nodes().Update(context.Background(), node, metav1.UpdateOptions{}); err != nil {
			t.Fatal(err)
		}
	}
	machineSet, err := dynamicClient.Resource(machineSetResource).Get(context.Background(), "np-runtime0", metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if err := unstructured.SetNestedField(machineSet.Object, int64(4), "status", "readyReplicas"); err != nil {
		t.Fatal(err)
	}
	if _, err := dynamicClient.Resource(machineSetResource).Update(context.Background(), machineSet, metav1.UpdateOptions{}); err != nil {
		t.Fatal(err)
	}

	result, err := controller.ReconcileOnce(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if result.Action != "await-runtime-provider-convergence" {
		t.Fatalf("partially Ready Machine target triggered another topology step: %#v", result)
	}
	machineSet, err = dynamicClient.Resource(machineSetResource).Get(context.Background(), "np-runtime0", metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	replicas, _, _ := unstructured.NestedInt64(machineSet.Object, "spec", "replicas")
	if replicas != 10 {
		t.Fatalf("partially Ready topology target changed to %d", replicas)
	}
}

func TestTopologyCapacityWaitsForAdmissionBeforeAddingMore(t *testing.T) {
	controller, dynamicClient, _ := fixture(t, 10, 10, false)
	controller.Config.RequiredZones = 3
	nodes, err := controller.Kubernetes.CoreV1().Nodes().List(context.Background(), metav1.ListOptions{})
	if err != nil {
		t.Fatal(err)
	}
	zones := []string{
		"zone-a", "zone-a", "zone-a", "zone-a", "zone-a",
		"zone-b",
		"zone-c", "zone-c", "zone-c", "zone-c",
	}
	for index := range nodes.Items {
		node := nodes.Items[index].DeepCopy()
		node.Labels[corev1.LabelTopologyZone] = zones[index]
		if index == 0 {
			delete(node.Annotations, admission.StateAnnotation)
			delete(node.Labels, admission.AdmittedLabel)
			node.Spec.Taints = append(node.Spec.Taints, corev1.Taint{
				Key: admission.PendingTaintKey, Value: "pending", Effect: corev1.TaintEffectNoSchedule,
			})
		}
		if _, err := controller.Kubernetes.CoreV1().Nodes().Update(context.Background(), node, metav1.UpdateOptions{}); err != nil {
			t.Fatal(err)
		}
	}

	result, err := controller.ReconcileOnce(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if result.Action != "await-runtime-admission-convergence" {
		t.Fatalf("in-flight admission triggered another topology step: %#v", result)
	}
	machineSet, err := dynamicClient.Resource(machineSetResource).Get(context.Background(), "np-runtime0", metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	replicas, _, _ := unstructured.NestedInt64(machineSet.Object, "spec", "replicas")
	if replicas != 10 {
		t.Fatalf("in-flight admission changed topology target to %d", replicas)
	}
}

func TestTopologyCapacityExtendsIncompletePreparedAdmissionFrontier(t *testing.T) {
	controller, dynamicClient, _ := fixture(t, 8, 8, false)
	controller.Config.RequiredZones = 3
	setPrepared(t, controller, "runtime-7")
	setPrepared(t, controller, "runtime-8")

	result, err := controller.ReconcileOnce(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if result.Action != "scale-up-to-9" {
		t.Fatalf("incomplete prepared frontier did not request one balancing Machine: %#v", result)
	}
	machineSet, err := dynamicClient.Resource(machineSetResource).Get(context.Background(), "np-runtime0", metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	replicas, _, _ := unstructured.NestedInt64(machineSet.Object, "spec", "replicas")
	if replicas != 9 {
		t.Fatalf("prepared frontier target = %d, want 9", replicas)
	}
}

func TestTopologyCapacityDoesNotDeadlockOnSettledButUnavailableAdmittedNode(t *testing.T) {
	controller, dynamicClient, _ := fixture(t, 8, 8, false)
	controller.Config.RequiredZones = 3
	setPrepared(t, controller, "runtime-7")
	setPrepared(t, controller, "runtime-8")

	node, err := controller.Kubernetes.CoreV1().Nodes().Get(context.Background(), "runtime-1", metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	node.Status.Conditions = []corev1.NodeCondition{{Type: corev1.NodeReady, Status: corev1.ConditionFalse}}
	if _, err := controller.Kubernetes.CoreV1().Nodes().Update(context.Background(), node, metav1.UpdateOptions{}); err != nil {
		t.Fatal(err)
	}

	result, err := controller.ReconcileOnce(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if result.Action != "scale-up-to-9" {
		t.Fatalf("settled unavailable admitted Node deadlocked topology compensation: %#v", result)
	}
	machineSet, err := dynamicClient.Resource(machineSetResource).Get(context.Background(), "np-runtime0", metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	replicas, _, _ := unstructured.NestedInt64(machineSet.Object, "spec", "replicas")
	if replicas != 9 {
		t.Fatalf("settled unavailable topology target = %d, want 9", replicas)
	}
}

func TestTopologyCapacityRepairsLargePreparedFrontierInBoundedBatch(t *testing.T) {
	controller, dynamicClient, _ := fixture(t, 30, 30, false)
	controller.Config.RequiredZones = 3
	controller.Config.MaxReplicas = 60
	machineSet, err := dynamicClient.Resource(machineSetResource).Get(context.Background(), "np-runtime0", metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if err := unstructured.SetNestedField(machineSet.Object, int64(60), "spec", "scaling", "maxReplicas"); err != nil {
		t.Fatal(err)
	}
	if _, err := dynamicClient.Resource(machineSetResource).Update(context.Background(), machineSet, metav1.UpdateOptions{}); err != nil {
		t.Fatal(err)
	}
	nodes, err := controller.Kubernetes.CoreV1().Nodes().List(context.Background(), metav1.ListOptions{})
	if err != nil {
		t.Fatal(err)
	}
	sort.Slice(nodes.Items, func(i, j int) bool { return nodes.Items[i].Name < nodes.Items[j].Name })
	for index := range nodes.Items {
		node := nodes.Items[index].DeepCopy()
		if index < 9 {
			node.Labels[corev1.LabelTopologyZone] = fmt.Sprintf("zone-%d", index%3)
		} else {
			node.Labels[corev1.LabelTopologyZone] = fmt.Sprintf("zone-%d", (index-9)%2)
		}
		if _, err := controller.Kubernetes.CoreV1().Nodes().Update(context.Background(), node, metav1.UpdateOptions{}); err != nil {
			t.Fatal(err)
		}
		if index >= 9 {
			setPrepared(t, controller, node.Name)
		}
	}

	result, err := controller.ReconcileOnce(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if result.Action != "scale-up-to-37" {
		t.Fatalf("large frontier deficit was not batched: %#v", result)
	}
	machineSet, err = dynamicClient.Resource(machineSetResource).Get(context.Background(), "np-runtime0", metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	replicas, _, _ := unstructured.NestedInt64(machineSet.Object, "spec", "replicas")
	if replicas != 37 {
		t.Fatalf("batched topology target = %d, want 37", replicas)
	}
}

func TestTopologyCapacityDoesNotOvershootCompletePreparedAdmissionFrontier(t *testing.T) {
	controller, dynamicClient, _ := fixture(t, 8, 9, false)
	controller.Config.RequiredZones = 3
	for _, name := range []string{"runtime-7", "runtime-8", "runtime-9"} {
		setPrepared(t, controller, name)
	}

	result, err := controller.ReconcileOnce(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if result.Action != "await-runtime-admission-convergence" {
		t.Fatalf("complete prepared frontier did not wait for admission: %#v", result)
	}
	machineSet, err := dynamicClient.Resource(machineSetResource).Get(context.Background(), "np-runtime0", metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	replicas, _, _ := unstructured.NestedInt64(machineSet.Object, "spec", "replicas")
	if replicas != 9 {
		t.Fatalf("complete prepared frontier was overprovisioned to %d", replicas)
	}
}

func TestTopologyCapacityTargetModelsHardThreeZoneSpread(t *testing.T) {
	makeTargets := func(counts ...int) []quarantinedTarget {
		var targets []quarantinedTarget
		for zone, count := range counts {
			for index := 0; index < count; index++ {
				targets = append(targets, quarantinedTarget{node: &corev1.Node{ObjectMeta: metav1.ObjectMeta{
					Name:   fmt.Sprintf("node-%d-%d", zone, index),
					Labels: map[string]string{corev1.LabelTopologyZone: fmt.Sprintf("zone-%d", zone)},
				}}})
			}
		}
		return targets
	}
	for _, test := range []struct {
		name    string
		counts  []int
		desired int64
		want    int64
	}{
		{name: "balanced", counts: []int{4, 3, 3}, desired: 10, want: 10},
		{name: "observed-cloud-skew", counts: []int{5, 1, 4}, desired: 10, want: 12},
		{name: "missing-zone", counts: []int{5, 5}, desired: 10, want: 13},
	} {
		t.Run(test.name, func(t *testing.T) {
			got, err := topologyCapacityTarget(makeTargets(test.counts...), test.desired, 3)
			if err != nil {
				t.Fatal(err)
			}
			if got != test.want {
				t.Fatalf("topology target = %d, want %d", got, test.want)
			}
		})
	}
}

func TestBalancedRuntimeCapacityCountsOnlySchedulableTopology(t *testing.T) {
	var targets []quarantinedTarget
	for zone, count := range map[string]int{"zone-a": 5, "zone-b": 1, "zone-c": 4} {
		for index := 0; index < count; index++ {
			targets = append(targets, quarantinedTarget{node: &corev1.Node{ObjectMeta: metav1.ObjectMeta{
				Name: fmt.Sprintf("%s-%d", zone, index), Labels: map[string]string{corev1.LabelTopologyZone: zone},
			}}})
		}
	}
	got, err := balancedRuntimeCapacity(targets, 3)
	if err != nil {
		t.Fatal(err)
	}
	if got != 5 {
		t.Fatalf("balanced runtime capacity = %d, want 5", got)
	}
}

func TestTopologyRepairIsDisabledWithoutExplicitZoneContract(t *testing.T) {
	controller, _, _ := fixture(t, 3, 3, false)
	controller.Config.TargetedRepairEnabled = true
	for _, name := range []string{"runtime-1", "runtime-2", "runtime-3"} {
		node, err := controller.Kubernetes.CoreV1().Nodes().Get(context.Background(), name, metav1.GetOptions{})
		if err != nil {
			t.Fatal(err)
		}
		node.Labels[corev1.LabelTopologyZone] = "zone-a"
		if _, err := controller.Kubernetes.CoreV1().Nodes().Update(context.Background(), node, metav1.UpdateOptions{}); err != nil {
			t.Fatal(err)
		}
	}
	result, err := controller.ReconcileOnce(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if result.Action != "" {
		t.Fatalf("disabled topology repair changed capacity: %#v", result)
	}
}

func TestSuspectNodePrewarmsAndRetainsOneRepairSurge(t *testing.T) {
	controller, dynamicClient, _ := fixture(t, 4, 4, false)
	setSuspect(t, controller, "runtime-4", "machine-4")
	first, err := controller.ReconcileOnce(context.Background())
	if err != nil || first.Action != "scale-up-to-5" {
		t.Fatalf("suspect Node did not prewarm one replacement: result=%#v err=%v", first, err)
	}
	second, err := controller.ReconcileOnce(context.Background())
	if err != nil || second.Action != "suspect-awaits-recovery-or-quarantine" {
		t.Fatalf("suspect Node released repair surge too early: result=%#v err=%v", second, err)
	}
	machineSet, err := dynamicClient.Resource(machineSetResource).Get(context.Background(), "np-runtime0", metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	replicas, _, _ := unstructured.NestedInt64(machineSet.Object, "spec", "replicas")
	if replicas != 5 {
		t.Fatalf("suspect repair surge replicas = %d, want 5", replicas)
	}
}

func TestQuarantineBlocksUnsafeGenericMachineSetContraction(t *testing.T) {
	controller, dynamicClient, _ := fixture(t, 3, 4, false)
	setQuarantined(t, controller, "runtime-3", "machine-3")
	result, err := controller.ReconcileOnce(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if result.Action != "quarantine-awaits-targeted-repair" {
		t.Fatalf("unsafe repair was not blocked: %#v", result)
	}
	machineSet, err := dynamicClient.Resource(machineSetResource).Get(context.Background(), "np-runtime0", metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	replicas, _, _ := unstructured.NestedInt64(machineSet.Object, "spec", "replicas")
	if replicas != 4 {
		t.Fatalf("quarantine contracted an ambiguous MachineSet to %d", replicas)
	}
}

func TestScaleUpRestoresOnlyOwnedDrainTaint(t *testing.T) {
	controller, _, _ := fixture(t, 4, 3, false)
	node, err := controller.Kubernetes.CoreV1().Nodes().Get(context.Background(), "runtime-3", metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	node.Spec.Unschedulable = true // independent operator fence
	node.Annotations[DrainAnnotation] = "machine-3"
	node.Spec.Taints = append(node.Spec.Taints,
		corev1.Taint{Key: DrainTaintKey, Value: "machine-3", Effect: corev1.TaintEffectNoSchedule},
		corev1.Taint{Key: "operator.example/maintenance", Value: "true", Effect: corev1.TaintEffectNoSchedule},
	)
	if _, err := controller.Kubernetes.CoreV1().Nodes().Update(context.Background(), node, metav1.UpdateOptions{}); err != nil {
		t.Fatal(err)
	}
	if _, err := controller.ReconcileOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	node, err = controller.Kubernetes.CoreV1().Nodes().Get(context.Background(), node.Name, metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if !node.Spec.Unschedulable || node.Annotations[DrainAnnotation] != "" || drainTaintIndex(node.Spec.Taints, "machine-3") >= 0 {
		t.Fatalf("scale-up did not remove exactly its own drain: %#v", node)
	}
	if len(node.Spec.Taints) != 1 || node.Spec.Taints[0].Key != "operator.example/maintenance" {
		t.Fatalf("scale-up removed a foreign taint: %#v", node.Spec.Taints)
	}
}

func TestTargetedRepairDeletesOnlyExactQuarantinedMachineAfterSurgeReady(t *testing.T) {
	controller, dynamicClient, _ := fixture(t, 4, 5, false)
	controller.Config.TargetedRepairEnabled = true
	setQuarantined(t, controller, "runtime-4", "machine-4")
	addReadyRuntimeHosts(t, controller, []string{"runtime-1", "runtime-2", "runtime-3", "runtime-5"})
	result, err := controller.ReconcileOnce(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if result.Action != "delete-exact-quarantined-machine" || result.Candidate != "np-runtime0-4" {
		t.Fatalf("unexpected targeted repair: %#v", result)
	}
	machines, err := dynamicClient.Resource(machineResource).List(context.Background(), metav1.ListOptions{})
	if err != nil {
		t.Fatal(err)
	}
	for index := range machines.Items {
		if machines.Items[index].GetName() == "np-runtime0-4" {
			t.Fatal("exact quarantined Machine still exists")
		}
	}
	machineSet, err := dynamicClient.Resource(machineSetResource).Get(context.Background(), "np-runtime0", metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	replicas, _, _ := unstructured.NestedInt64(machineSet.Object, "spec", "replicas")
	if replicas != 4 {
		t.Fatalf("MachineSet did not release repair surge: replicas=%d", replicas)
	}
}

func TestTargetedRepairRejectsExtraLiveRuntimeHost(t *testing.T) {
	controller, dynamicClient, _ := fixture(t, 4, 5, false)
	controller.Config.TargetedRepairEnabled = true
	setQuarantined(t, controller, "runtime-4", "machine-4")
	addReadyRuntimeHosts(t, controller, []string{"runtime-1", "runtime-2", "runtime-3", "runtime-5"})
	controllerRef := true
	if _, err := controller.Kubernetes.CoreV1().Pods(controller.Config.Namespace).Create(context.Background(), &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Name: "unexpected-runtime-host", Namespace: controller.Config.Namespace,
			UID: types.UID("unexpected-runtime-host-uid"),
			Labels: map[string]string{
				"fleet.actor.dev/cell-name": controller.Config.CellName,
				"fleet.actor.dev/component": "workerd-host",
			},
			OwnerReferences: []metav1.OwnerReference{{
				Kind: "StatefulSet", Name: controller.Config.StatefulSetName,
				UID: types.UID("runtime-statefulset-1"), Controller: &controllerRef,
			}},
		},
		Spec:   corev1.PodSpec{NodeName: "runtime-5"},
		Status: corev1.PodStatus{Phase: corev1.PodPending},
	}, metav1.CreateOptions{}); err != nil {
		t.Fatal(err)
	}

	result, err := controller.ReconcileOnce(context.Background())
	if err != nil || result.Action != "wait-replacement-runtime-hosts" {
		t.Fatalf("extra live Host did not fail closed: result=%#v err=%v", result, err)
	}
	assertMachineExists(t, dynamicClient, "np-runtime0-4", true)
}

func TestConcurrentHPAIncreaseKeepsRepairSurgeAfterExactDelete(t *testing.T) {
	controller, dynamicClient, _ := fixture(t, 4, 5, false)
	controller.Config.TargetedRepairEnabled = true
	setQuarantined(t, controller, "runtime-4", "machine-4")
	addReadyRuntimeHosts(t, controller, []string{"runtime-1", "runtime-2", "runtime-3", "runtime-5"})
	dynamicClient.PrependReactor("delete", "machines", func(action k8stesting.Action) (bool, runtime.Object, error) {
		statefulSet, err := controller.Kubernetes.AppsV1().StatefulSets(controller.Config.Namespace).Get(
			context.Background(), controller.Config.StatefulSetName, metav1.GetOptions{},
		)
		if err != nil {
			return true, nil, err
		}
		replicas := int32(5)
		statefulSet.Spec.Replicas = &replicas
		if _, err := controller.Kubernetes.AppsV1().StatefulSets(controller.Config.Namespace).Update(
			context.Background(), statefulSet, metav1.UpdateOptions{},
		); err != nil {
			return true, nil, err
		}
		return false, nil, nil
	})
	result, err := controller.ReconcileOnce(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if result.Action != "delete-exact-quarantined-machine" {
		t.Fatalf("exact unusable Machine was not deleted: %#v", result)
	}
	machineSet, err := dynamicClient.Resource(machineSetResource).Get(context.Background(), "np-runtime0", metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	replicas, _, _ := unstructured.NestedInt64(machineSet.Object, "spec", "replicas")
	if replicas != 5 {
		t.Fatalf("concurrent HPA increase lost repair capacity: replicas=%d", replicas)
	}
}

func TestTargetedRepairDrainsEvictsAndWaitsForReadyReplacement(t *testing.T) {
	controller, dynamicClient, _ := fixture(t, 4, 5, false)
	controller.Config.TargetedRepairEnabled = true
	setQuarantined(t, controller, "runtime-4", "machine-4")

	draining := false
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Header.Get("x-rivet-workerd-token") != controller.Config.RuntimeAuthToken {
			http.NotFound(response, request)
			return
		}
		switch {
		case request.Method == http.MethodGet && request.URL.Path == "/v1/sqlite/stats":
			fmt.Fprintf(response, `{"host_active_actors":0,"host_max_active_actors":32,"host_draining":%t,"host_accepting_actors":%t,"bridge_active_actors":0,"quiescent":true,"workerd_admission":{"in_flight":0,"queued":0,"max_in_flight":16,"max_queued":16}}`, draining, !draining)
		case request.Method == http.MethodPost && request.URL.Path == "/v1/sqlite/drain":
			draining = true
			response.Header().Set("content-type", "application/json")
			fmt.Fprint(response, `{}`)
		default:
			http.NotFound(response, request)
		}
	}))
	t.Cleanup(server.Close)
	parsed, err := url.Parse(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	_, port, err := net.SplitHostPort(parsed.Host)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := fmt.Sscan(port, &controller.Config.ManagementPort); err != nil {
		t.Fatal(err)
	}
	addReadyRuntimeHosts(t, controller, []string{"runtime-1", "runtime-2", "runtime-3", "runtime-4"})
	targetPod, err := controller.Kubernetes.CoreV1().Pods(controller.Config.Namespace).Get(context.Background(), "runtime-host-4", metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	targetPod.Status.PodIP = "127.0.0.1"
	if _, err := controller.Kubernetes.CoreV1().Pods(controller.Config.Namespace).UpdateStatus(context.Background(), targetPod, metav1.UpdateOptions{}); err != nil {
		t.Fatal(err)
	}

	first, err := controller.ReconcileOnce(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if first.Action != "start-quarantined-host-drain" || draining {
		t.Fatalf("quarantined Host did not persist its drain identity first: %#v draining=%t", first, draining)
	}
	assertMachineExists(t, dynamicClient, "np-runtime0-4", true)

	// A new process must resume the exact persisted Node/Machine/attempt timer.
	controller = &Controller{
		Kubernetes: controller.Kubernetes, Dynamic: controller.Dynamic, HTTPClient: controller.HTTPClient,
		Config: controller.Config, Now: controller.Now,
	}
	second, err := controller.ReconcileOnce(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if second.Action != "fence-quarantined-host-placement" || !draining {
		t.Fatalf("quarantined Host was not fenced after restart: %#v draining=%t", second, draining)
	}
	assertMachineExists(t, dynamicClient, "np-runtime0-4", true)

	third, err := controller.ReconcileOnce(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if third.Action != "evict-quiescent-quarantined-host" {
		t.Fatalf("quiescent Host was not evicted: %#v", third)
	}
	assertExactEviction(t, controller, "runtime-host-4", "runtime-host-4-uid")
	assertMachineExists(t, dynamicClient, "np-runtime0-4", true)

	if err := controller.Kubernetes.CoreV1().Pods(controller.Config.Namespace).Delete(context.Background(), "runtime-host-4", metav1.DeleteOptions{}); err != nil {
		t.Fatal(err)
	}
	fourth, err := controller.ReconcileOnce(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if fourth.Action != "wait-replacement-runtime-hosts" {
		t.Fatalf("repair did not wait for replacement Host readiness: %#v", fourth)
	}
	assertMachineExists(t, dynamicClient, "np-runtime0-4", true)

	addReadyRuntimeHost(t, controller, "runtime-5")
	fifth, err := controller.ReconcileOnce(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if fifth.Action != "delete-exact-quarantined-machine" {
		t.Fatalf("repair did not delete exact Machine after replacement readiness: %#v", fifth)
	}
	assertMachineExists(t, dynamicClient, "np-runtime0-4", false)
}

func TestTargetedRepairRejectsForeignWorkloadBeforeHostDrain(t *testing.T) {
	controller, _, _ := fixture(t, 4, 5, false)
	controller.Config.TargetedRepairEnabled = true
	setQuarantined(t, controller, "runtime-4", "machine-4")
	addReadyRuntimeHosts(t, controller, []string{"runtime-1", "runtime-2", "runtime-3", "runtime-4"})
	if _, err := controller.Kubernetes.CoreV1().Pods("default").Create(context.Background(), &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Name: "foreign", Namespace: "default"},
		Spec:       corev1.PodSpec{NodeName: "runtime-4"},
		Status:     corev1.PodStatus{Phase: corev1.PodRunning},
	}, metav1.CreateOptions{}); err != nil {
		t.Fatal(err)
	}
	if _, err := controller.ReconcileOnce(context.Background()); err == nil || !strings.Contains(err.Error(), "foreign workload") {
		t.Fatalf("foreign workload did not fail closed: %v", err)
	}
}

func TestTargetedRepairUnreachableHostFailsClosedAfterTimeout(t *testing.T) {
	controller, dynamicClient, now := fixture(t, 4, 5, false)
	controller.Config.TargetedRepairEnabled = true
	controller.Config.ManagementPort = 1
	setQuarantined(t, controller, "runtime-4", "machine-4")
	addReadyRuntimeHosts(t, controller, []string{"runtime-1", "runtime-2", "runtime-3", "runtime-4"})
	targetPod, err := controller.Kubernetes.CoreV1().Pods(controller.Config.Namespace).Get(context.Background(), "runtime-host-4", metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	targetPod.Status.PodIP = "127.0.0.1"
	if _, err := controller.Kubernetes.CoreV1().Pods(controller.Config.Namespace).UpdateStatus(context.Background(), targetPod, metav1.UpdateOptions{}); err != nil {
		t.Fatal(err)
	}

	first, err := controller.ReconcileOnce(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if first.Action != "start-quarantined-host-drain" {
		t.Fatalf("unreachable Host did not persist a bounded drain start: %#v", first)
	}
	second, err := controller.ReconcileOnce(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if second.Action != "wait-quarantined-host-management" {
		t.Fatalf("unreachable Host was not held before timeout: %#v", second)
	}
	*now = now.Add(controller.Config.RepairDrainTimeout + time.Second)
	third, err := controller.ReconcileOnce(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if third.Action != "quarantined-host-management-timeout" {
		t.Fatalf("unreachable Host did not remain fail closed after timeout: %#v", third)
	}
	if _, err := controller.Kubernetes.CoreV1().Pods(controller.Config.Namespace).Get(
		context.Background(), "runtime-host-4", metav1.GetOptions{},
	); err != nil {
		t.Fatalf("unreachable Host was evicted without quiescence proof: %v", err)
	}
	assertMachineExists(t, dynamicClient, "np-runtime0-4", true)
}

func TestTargetedRepairNeverEvictsLiveActorAfterTimeout(t *testing.T) {
	controller, dynamicClient, now := fixture(t, 4, 5, false)
	controller.Config.TargetedRepairEnabled = true
	setQuarantined(t, controller, "runtime-4", "machine-4")
	addReadyRuntimeHosts(t, controller, []string{"runtime-1", "runtime-2", "runtime-3", "runtime-4"})
	targetPod, err := controller.Kubernetes.CoreV1().Pods(controller.Config.Namespace).Get(context.Background(), "runtime-host-4", metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	targetPod.Status.PodIP = "127.0.0.1"
	if _, err := controller.Kubernetes.CoreV1().Pods(controller.Config.Namespace).UpdateStatus(context.Background(), targetPod, metav1.UpdateOptions{}); err != nil {
		t.Fatal(err)
	}
	controller.HTTPClient = &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		return &http.Response{
			StatusCode: http.StatusOK,
			Body: io.NopCloser(strings.NewReader(
				`{"host_active_actors":1,"host_max_active_actors":32,"host_draining":true,"host_accepting_actors":false,"bridge_active_actors":1,"quiescent":false,"workerd_admission":{"in_flight":0,"queued":0,"max_in_flight":16,"max_queued":16}}`,
			)),
			Header: make(http.Header),
		}, nil
	})}
	first, err := controller.ReconcileOnce(context.Background())
	if err != nil || first.Action != "start-quarantined-host-drain" {
		t.Fatalf("persist live Actor drain identity: result=%#v err=%v", first, err)
	}
	*now = now.Add(controller.Config.RepairDrainTimeout + time.Second)
	second, err := controller.ReconcileOnce(context.Background())
	if err != nil || second.Action != "quarantined-host-quiescence-timeout" {
		t.Fatalf("live Actor timeout did not fail closed: result=%#v err=%v", second, err)
	}
	if _, err := controller.Kubernetes.CoreV1().Pods(controller.Config.Namespace).Get(
		context.Background(), "runtime-host-4", metav1.GetOptions{},
	); err != nil {
		t.Fatalf("live Actor Host was evicted after timeout: %v", err)
	}
	assertMachineExists(t, dynamicClient, "np-runtime0-4", true)
}

func TestTargetedRepairHonorsPodDisruptionBudget(t *testing.T) {
	controller, dynamicClient, _ := fixture(t, 4, 5, false)
	controller.Config.TargetedRepairEnabled = true
	setQuarantined(t, controller, "runtime-4", "machine-4")
	addReadyRuntimeHosts(t, controller, []string{"runtime-1", "runtime-2", "runtime-3", "runtime-4"})
	targetPod, err := controller.Kubernetes.CoreV1().Pods(controller.Config.Namespace).Get(context.Background(), "runtime-host-4", metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	targetPod.Status.PodIP = "127.0.0.1"
	if _, err := controller.Kubernetes.CoreV1().Pods(controller.Config.Namespace).UpdateStatus(context.Background(), targetPod, metav1.UpdateOptions{}); err != nil {
		t.Fatal(err)
	}
	controller.HTTPClient = &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		return &http.Response{
			StatusCode: http.StatusOK,
			Body: io.NopCloser(strings.NewReader(
				`{"host_active_actors":0,"host_max_active_actors":32,"host_draining":true,"host_accepting_actors":false,"bridge_active_actors":0,"quiescent":true,"workerd_admission":{"in_flight":0,"queued":0,"max_in_flight":16,"max_queued":16}}`,
			)),
			Header: make(http.Header),
		}, nil
	})}
	controller.Kubernetes.(*kubefake.Clientset).PrependReactor("create", "pods", func(action k8stesting.Action) (bool, runtime.Object, error) {
		if action.GetSubresource() == "eviction" {
			return true, nil, apierrors.NewTooManyRequests("disruption budget blocks eviction", 1)
		}
		return false, nil, nil
	})
	first, err := controller.ReconcileOnce(context.Background())
	if err != nil || first.Action != "start-quarantined-host-drain" {
		t.Fatalf("persist PDB test drain identity: result=%#v err=%v", first, err)
	}
	if _, err := controller.ReconcileOnce(context.Background()); err == nil || !strings.Contains(err.Error(), "evict exact quarantined runtime Host") {
		t.Fatalf("PDB refusal did not stop repair: %v", err)
	}
	assertMachineExists(t, dynamicClient, "np-runtime0-4", true)
}

func TestExactMachineDeleteAllowsResourceVersionChurn(t *testing.T) {
	controller, dynamicClient, _ := fixture(t, 4, 5, false)
	setQuarantined(t, controller, "runtime-4", "machine-4")
	inventory, err := controller.capacityInventory(context.Background(), "machineset-1")
	if err != nil || len(inventory.quarantined) != 1 {
		t.Fatalf("capture quarantined identity: inventory=%#v err=%v", inventory, err)
	}
	target := inventory.quarantined[0]
	node, err := controller.Kubernetes.CoreV1().Nodes().Get(context.Background(), "runtime-4", metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	node.ResourceVersion = "heartbeat-churn"
	if _, err := controller.Kubernetes.CoreV1().Nodes().Update(context.Background(), node, metav1.UpdateOptions{}); err != nil {
		t.Fatal(err)
	}
	machine, err := dynamicClient.Resource(machineResource).Get(context.Background(), "np-runtime0-4", metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	machine.SetResourceVersion("provider-churn")
	if _, err := dynamicClient.Resource(machineResource).Update(context.Background(), machine, metav1.UpdateOptions{}); err != nil {
		t.Fatal(err)
	}
	if err := controller.deleteExactQuarantinedMachine(context.Background(), target); err != nil {
		t.Fatalf("resourceVersion churn blocked UID-preconditioned deletion: %v", err)
	}
	assertMachineExists(t, dynamicClient, "np-runtime0-4", false)
}

func TestExactMachineDeleteRejectsReplacementIdentity(t *testing.T) {
	t.Run("Machine UID", func(t *testing.T) {
		controller, dynamicClient, _ := fixture(t, 4, 5, false)
		setQuarantined(t, controller, "runtime-4", "machine-4")
		inventory, err := controller.capacityInventory(context.Background(), "machineset-1")
		if err != nil {
			t.Fatal(err)
		}
		target := inventory.quarantined[0]
		if err := dynamicClient.Resource(machineResource).Delete(context.Background(), target.machine.GetName(), metav1.DeleteOptions{}); err != nil {
			t.Fatal(err)
		}
		replacement := target.machine.DeepCopy()
		replacement.SetResourceVersion("")
		replacement.SetUID(types.UID("replacement-machine-uid"))
		if _, err := dynamicClient.Resource(machineResource).Create(context.Background(), replacement, metav1.CreateOptions{}); err != nil {
			t.Fatal(err)
		}
		if err := controller.deleteExactQuarantinedMachine(context.Background(), target); err == nil || !strings.Contains(err.Error(), "Machine changed") {
			t.Fatalf("replacement Machine inherited destructive action: %v", err)
		}
		assertMachineExists(t, dynamicClient, target.machine.GetName(), true)
	})

	t.Run("Node UID", func(t *testing.T) {
		controller, dynamicClient, _ := fixture(t, 4, 5, false)
		setQuarantined(t, controller, "runtime-4", "machine-4")
		inventory, err := controller.capacityInventory(context.Background(), "machineset-1")
		if err != nil {
			t.Fatal(err)
		}
		target := inventory.quarantined[0]
		if err := controller.Kubernetes.CoreV1().Nodes().Delete(context.Background(), target.node.Name, metav1.DeleteOptions{}); err != nil {
			t.Fatal(err)
		}
		replacement := target.node.DeepCopy()
		replacement.ResourceVersion = ""
		replacement.UID = types.UID("replacement-node-uid")
		if _, err := controller.Kubernetes.CoreV1().Nodes().Create(context.Background(), replacement, metav1.CreateOptions{}); err != nil {
			t.Fatal(err)
		}
		if err := controller.deleteExactQuarantinedMachine(context.Background(), target); err == nil || !strings.Contains(err.Error(), "Node changed") {
			t.Fatalf("replacement Node inherited destructive action: %v", err)
		}
		assertMachineExists(t, dynamicClient, target.machine.GetName(), true)
	})
}

func TestCapacityTruthExcludesUnadmittedNotReadyAndDrainingNodes(t *testing.T) {
	controller, dynamicClient, now := fixture(t, 3, 4, false)
	setBlocked(t, controller, "runtime-4", "machine-4", "ImagePullBackOff")
	node, err := controller.Kubernetes.CoreV1().Nodes().Get(context.Background(), "runtime-3", metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	node.Status.Conditions = []corev1.NodeCondition{{Type: corev1.NodeReady, Status: corev1.ConditionFalse}}
	if _, err := controller.Kubernetes.CoreV1().Nodes().UpdateStatus(context.Background(), node, metav1.UpdateOptions{}); err != nil {
		t.Fatal(err)
	}
	node, err = controller.Kubernetes.CoreV1().Nodes().Get(context.Background(), "runtime-2", metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	// An independent operator fence is unusable capacity but is not owned by the
	// exact scale-down protocol, so restart recovery must leave it untouched.
	node.Spec.Unschedulable = true
	if _, err := controller.Kubernetes.CoreV1().Nodes().Update(context.Background(), node, metav1.UpdateOptions{}); err != nil {
		t.Fatal(err)
	}

	first, err := controller.ReconcileOnce(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if first.UsableNodes != 1 || first.Action != "observe-scale-down" {
		t.Fatalf("unexpected initial capacity truth: %#v", first)
	}
	*now = now.Add(31 * time.Second)
	second, err := controller.ReconcileOnce(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if second.UsableNodes != 1 || second.Action != "await-usable-capacity" {
		t.Fatalf("unusable Nodes did not close contraction: %#v", second)
	}
	machineSet, err := dynamicClient.Resource(machineSetResource).Get(context.Background(), "np-runtime0", metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	replicas, _, _ := unstructured.NestedInt64(machineSet.Object, "spec", "replicas")
	if replicas != 4 {
		t.Fatalf("capacity controller contracted through unusable Nodes: replicas=%d", replicas)
	}
}

func TestFleetWideImagePullFailureNeverRequestsRepairSurge(t *testing.T) {
	controller, dynamicClient, _ := fixture(t, 3, 3, false)
	for index := 1; index <= 3; index++ {
		setBlocked(t, controller, "runtime-"+string(rune('0'+index)), "machine-"+string(rune('0'+index)), "ImagePullBackOff")
	}
	result, err := controller.ReconcileOnce(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if result.UsableNodes != 0 || result.Action != "await-usable-capacity" {
		t.Fatalf("fleet-wide registry failure was attributed to Machines: %#v", result)
	}
	machineSet, err := dynamicClient.Resource(machineSetResource).Get(context.Background(), "np-runtime0", metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	replicas, _, _ := unstructured.NestedInt64(machineSet.Object, "spec", "replicas")
	if replicas != 3 {
		t.Fatalf("fleet-wide registry failure triggered replacement surge: replicas=%d", replicas)
	}
}

func setBlocked(t *testing.T, controller *Controller, nodeName, machineUID, reason string) {
	t.Helper()
	node, err := controller.Kubernetes.CoreV1().Nodes().Get(context.Background(), nodeName, metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 9, 3, 13, 0, 0, 0, time.UTC)
	state := admission.State{
		Phase: admission.PhaseBlocked,
		Identity: admission.Identity{
			NodeUID: string(node.UID), ProviderID: node.Spec.ProviderID, MachineUID: machineUID,
			MachineSetUID: "machineset-1", ProfileDigest: admission.ProfileDigest(),
			RuntimeImage: "registry.invalid/runtime@sha256:" + strings.Repeat("a", 64),
		},
		AttemptUID: "blocked-" + machineUID, Attempt: 1, StartedAt: now, TransitionAt: now,
		RetryAt: now.Add(time.Minute), Reason: reason,
	}
	raw, err := admission.EncodeState(state)
	if err != nil {
		t.Fatal(err)
	}
	node.Annotations[admission.StateAnnotation] = raw
	delete(node.Labels, admission.AdmittedLabel)
	node.Spec.Taints = append(node.Spec.Taints, corev1.Taint{
		Key: admission.PendingTaintKey, Value: "pending", Effect: corev1.TaintEffectNoSchedule,
	})
	if _, err := controller.Kubernetes.CoreV1().Nodes().Update(context.Background(), node, metav1.UpdateOptions{}); err != nil {
		t.Fatal(err)
	}
}

func setQuarantined(t *testing.T, controller *Controller, nodeName, machineUID string) {
	t.Helper()
	node, err := controller.Kubernetes.CoreV1().Nodes().Get(context.Background(), nodeName, metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 9, 3, 13, 0, 0, 0, time.UTC)
	state := admission.State{
		Phase: admission.PhaseQuarantined,
		Identity: admission.Identity{
			NodeUID: string(node.UID), ProviderID: "qcloud://" + nodeName, MachineUID: machineUID, MachineSetUID: "machineset-1",
			ProfileDigest: admission.ProfileDigest(), RuntimeImage: "registry.invalid/runtime@sha256:" + strings.Repeat("a", 64),
		},
		AttemptUID: "attempt", Attempt: 1, StartedAt: now, TransitionAt: now,
	}
	raw, err := admission.EncodeState(state)
	if err != nil {
		t.Fatal(err)
	}
	node.Annotations[admission.StateAnnotation] = raw
	delete(node.Labels, admission.AdmittedLabel)
	node.Spec.Taints = append(node.Spec.Taints, corev1.Taint{
		Key: admission.PendingTaintKey, Value: "pending", Effect: corev1.TaintEffectNoSchedule,
	})
	if _, err := controller.Kubernetes.CoreV1().Nodes().Update(context.Background(), node, metav1.UpdateOptions{}); err != nil {
		t.Fatal(err)
	}
}

func setSuspect(t *testing.T, controller *Controller, nodeName, machineUID string) {
	t.Helper()
	node, err := controller.Kubernetes.CoreV1().Nodes().Get(context.Background(), nodeName, metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 9, 3, 13, 0, 0, 0, time.UTC)
	state := admission.State{
		Phase: admission.PhaseSuspect,
		Identity: admission.Identity{
			NodeUID: string(node.UID), ProviderID: node.Spec.ProviderID, MachineUID: machineUID,
			MachineSetUID: "machineset-1", ProfileDigest: admission.ProfileDigest(),
			RuntimeImage: "registry.invalid/runtime@sha256:" + strings.Repeat("a", 64),
		},
		AttemptUID: "suspect-" + machineUID, Attempt: 1, StartedAt: now.Add(-time.Hour), TransitionAt: now,
		Fault: "persistent Node condition: NotReady", FaultSince: now,
	}
	raw, err := admission.EncodeState(state)
	if err != nil {
		t.Fatal(err)
	}
	node.Annotations[admission.StateAnnotation] = raw
	delete(node.Labels, admission.AdmittedLabel)
	node.Spec.Taints = append(node.Spec.Taints, corev1.Taint{
		Key: admission.PendingTaintKey, Value: "pending", Effect: corev1.TaintEffectNoSchedule,
	})
	if _, err := controller.Kubernetes.CoreV1().Nodes().Update(context.Background(), node, metav1.UpdateOptions{}); err != nil {
		t.Fatal(err)
	}
}

func setPrepared(t *testing.T, controller *Controller, name string) {
	t.Helper()
	node, err := controller.Kubernetes.CoreV1().Nodes().Get(context.Background(), name, metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	state, err := admission.DecodeState(node.Annotations[admission.StateAnnotation])
	if err != nil {
		t.Fatal(err)
	}
	state.Phase = admission.PhasePrepared
	state.AttemptUID = "prepared-" + name
	state.Attempt = 1
	state.StartedAt = state.TransitionAt
	state.Reason = "waiting for balanced topology admission frontier"
	raw, err := admission.EncodeState(state)
	if err != nil {
		t.Fatal(err)
	}
	node.Annotations[admission.StateAnnotation] = raw
	delete(node.Labels, admission.AdmittedLabel)
	node.Spec.Taints = append(node.Spec.Taints, corev1.Taint{
		Key: admission.PendingTaintKey, Value: "pending", Effect: corev1.TaintEffectNoSchedule,
	})
	if _, err := controller.Kubernetes.CoreV1().Nodes().Update(context.Background(), node, metav1.UpdateOptions{}); err != nil {
		t.Fatal(err)
	}
}

func setRuntimeHostReplicas(t *testing.T, controller *Controller, replicas int32) {
	t.Helper()
	statefulSet, err := controller.Kubernetes.AppsV1().StatefulSets(controller.Config.Namespace).Get(
		context.Background(), controller.Config.StatefulSetName, metav1.GetOptions{},
	)
	if err != nil {
		t.Fatal(err)
	}
	statefulSet.Spec.Replicas = &replicas
	statefulSet.Status.ReadyReplicas = replicas
	if _, err := controller.Kubernetes.AppsV1().StatefulSets(controller.Config.Namespace).Update(
		context.Background(), statefulSet, metav1.UpdateOptions{},
	); err != nil {
		t.Fatal(err)
	}
}

func fixture(t *testing.T, hostReplicas, nodeReplicas int64, busyNewest bool) (*Controller, *dynamicfake.FakeDynamicClient, *time.Time) {
	t.Helper()
	cell := "actor-bj-q01"
	base := time.Date(2026, 9, 3, 12, 0, 0, 0, time.UTC)
	statefulReplicas := int32(hostReplicas)
	statefulSet := &appsv1.StatefulSet{
		ObjectMeta: metav1.ObjectMeta{
			Name: "actor-bj-q01-runtime-hosts", Namespace: "actor-fdb-cell-system",
			UID:    types.UID("runtime-statefulset-1"),
			Labels: map[string]string{"fleet.actor.dev/cell-name": cell},
		},
		Spec:   appsv1.StatefulSetSpec{Replicas: &statefulReplicas},
		Status: appsv1.StatefulSetStatus{ReadyReplicas: int32(hostReplicas)},
	}
	objects := []runtime.Object{statefulSet}
	for index := int64(1); index <= nodeReplicas; index++ {
		controller := true
		nodeName := "runtime-" + string(rune('0'+index))
		nodeUID := types.UID("node-" + string(rune('0'+index)))
		machineUID := "machine-" + string(rune('0'+index))
		state := admission.State{
			Phase: admission.PhaseAdmitted,
			Identity: admission.Identity{
				NodeUID: string(nodeUID), ProviderID: "qcloud://" + nodeName, MachineUID: machineUID,
				MachineSetUID: "machineset-1", ProfileDigest: admission.ProfileDigest(),
				RuntimeImage: "registry.invalid/runtime@sha256:" + strings.Repeat("a", 64),
			},
			TransitionAt: base,
		}
		raw, err := admission.EncodeState(state)
		if err != nil {
			t.Fatal(err)
		}
		objects = append(objects, &corev1.Node{
			ObjectMeta: metav1.ObjectMeta{
				Name:            nodeName,
				UID:             nodeUID,
				ResourceVersion: "1",
				Labels: map[string]string{
					"node.tke.cloud.tencent.com/machineset": "np-runtime0",
					"fleet.actor.dev/cell-name":             cell,
					admission.AdmittedLabel:                 "true",
					corev1.LabelTopologyZone:                fmt.Sprintf("zone-%d", (index-1)%3),
				},
				Annotations: map[string]string{admission.StateAnnotation: raw},
			},
			Spec: corev1.NodeSpec{ProviderID: "qcloud://" + nodeName},
			Status: corev1.NodeStatus{Conditions: []corev1.NodeCondition{
				{Type: corev1.NodeReady, Status: corev1.ConditionTrue},
			}},
		})
		objects = append(objects, &corev1.Pod{
			ObjectMeta: metav1.ObjectMeta{
				Name: "daemon-" + string(rune('0'+index)), Namespace: "kube-system",
				OwnerReferences: []metav1.OwnerReference{{Kind: "DaemonSet", Controller: &controller}},
			},
			Spec:   corev1.PodSpec{NodeName: "runtime-" + string(rune('0'+index))},
			Status: corev1.PodStatus{Phase: corev1.PodRunning},
		})
	}
	if busyNewest {
		objects = append(objects, &corev1.Pod{
			ObjectMeta: metav1.ObjectMeta{Name: "workload", Namespace: "default"},
			Spec:       corev1.PodSpec{NodeName: "runtime-4"},
			Status:     corev1.PodStatus{Phase: corev1.PodRunning},
		})
	}
	kube := kubefake.NewSimpleClientset(objects...)

	machineSet := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "node.tke.cloud.tencent.com/v1beta1",
		"kind":       "MachineSet",
		"metadata": map[string]any{
			"name": "np-runtime0", "uid": "machineset-1", "resourceVersion": "1",
		},
		"spec": map[string]any{
			"replicas":     nodeReplicas,
			"deletePolicy": "Newest",
			"scaling":      map[string]any{"minReplicas": int64(3), "maxReplicas": int64(30)},
			"template": map[string]any{"spec": map[string]any{
				"metadata": map[string]any{"labels": map[string]any{
					"fleet.actor.dev/cell-name": cell, "fleet.actor.dev/runtime-pool": "true",
				}},
				"taints": []any{map[string]any{"key": admission.PendingTaintKey, "value": "pending", "effect": "NoSchedule"}},
			}},
		},
		"status": map[string]any{"replicas": nodeReplicas, "readyReplicas": nodeReplicas},
	}}
	dynamicObjects := []runtime.Object{machineSet}
	for index := int64(1); index <= nodeReplicas; index++ {
		dynamicObjects = append(dynamicObjects, &unstructured.Unstructured{Object: map[string]any{
			"apiVersion": "node.tke.cloud.tencent.com/v1beta1",
			"kind":       "Machine",
			"metadata": map[string]any{
				"name":              "np-runtime0-" + string(rune('0'+index)),
				"uid":               "machine-" + string(rune('0'+index)),
				"creationTimestamp": base.Add(time.Duration(index) * time.Minute).Format(time.RFC3339),
				"labels":            map[string]any{"node.tke.cloud.tencent.com/machineset": "np-runtime0"},
			},
			"status": map[string]any{"nodeRef": map[string]any{"name": "runtime-" + string(rune('0'+index))}},
		}})
	}
	scheme := runtime.NewScheme()
	dynamicClient := dynamicfake.NewSimpleDynamicClientWithCustomListKinds(scheme, map[schema.GroupVersionResource]string{
		machineSetResource: "MachineSetList",
		machineResource:    "MachineList",
	}, dynamicObjects...)
	now := base.Add(time.Hour)
	controller := &Controller{
		Kubernetes: kube,
		Dynamic:    dynamicClient,
		Config: ControllerConfig{
			Namespace: "actor-fdb-cell-system", CellName: cell,
			StatefulSetName: "actor-bj-q01-runtime-hosts",
			MachineSetName:  "np-runtime0", ProviderClusterID: "cls-test",
			MinReplicas: 3, MaxReplicas: 30,
			MaxRepairSurge:         1,
			RuntimeAuthToken:       strings.Repeat("a", 64),
			ManagementPort:         19083,
			RepairDrainTimeout:     10 * time.Minute,
			ScaleDownStabilization: 30 * time.Second,
		},
		Now: func() time.Time { return now },
	}
	controller.ExactScaleDown = &fakeExactScaleDownProvider{apply: func(request ExactScaleDownRequest) error {
		if err := dynamicClient.Resource(machineResource).Delete(
			context.Background(), request.MachineName, metav1.DeleteOptions{},
		); err != nil {
			return err
		}
		machineSet, err := dynamicClient.Resource(machineSetResource).Get(
			context.Background(), request.MachineSetName, metav1.GetOptions{},
		)
		if err != nil {
			return err
		}
		if err := controller.Kubernetes.CoreV1().Nodes().Delete(
			context.Background(), request.NodeName, metav1.DeleteOptions{},
		); err != nil {
			return err
		}
		if err := unstructured.SetNestedField(machineSet.Object, request.ToReplicas, "spec", "replicas"); err != nil {
			return err
		}
		if err := unstructured.SetNestedField(machineSet.Object, request.ToReplicas, "status", "replicas"); err != nil {
			return err
		}
		_, err = dynamicClient.Resource(machineSetResource).Update(context.Background(), machineSet, metav1.UpdateOptions{})
		return err
	}}
	return controller, dynamicClient, &now
}

type fakeExactScaleDownProvider struct {
	requests []ExactScaleDownRequest
	apply    func(ExactScaleDownRequest) error
	handle   func(ExactScaleDownRequest) (ExactScaleDownResponse, error)
	err      error
}

func (p *fakeExactScaleDownProvider) DeleteMachineAndScaleDown(
	_ context.Context, request ExactScaleDownRequest,
) (ExactScaleDownResponse, error) {
	p.requests = append(p.requests, request)
	if p.handle != nil {
		return p.handle(request)
	}
	if p.err != nil {
		return ExactScaleDownResponse{}, p.err
	}
	if p.apply != nil {
		if err := p.apply(request); err != nil {
			return ExactScaleDownResponse{}, err
		}
	}
	return ExactScaleDownResponse{RequestID: fmt.Sprintf("request-%d", len(p.requests))}, nil
}

func addReadyRuntimeHosts(t *testing.T, controller *Controller, nodes []string) {
	t.Helper()
	for _, node := range nodes {
		addReadyRuntimeHost(t, controller, node)
	}
}

func addReadyRuntimeHost(t *testing.T, controller *Controller, node string) {
	t.Helper()
	controllerRef := true
	name := "runtime-host-" + strings.TrimPrefix(node, "runtime-")
	if _, err := controller.Kubernetes.CoreV1().Pods(controller.Config.Namespace).Create(context.Background(), &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Name: name, Namespace: controller.Config.Namespace, UID: types.UID(name + "-uid"),
			Labels: map[string]string{
				"fleet.actor.dev/cell-name": controller.Config.CellName,
				"fleet.actor.dev/component": "workerd-host",
			},
			OwnerReferences: []metav1.OwnerReference{{
				Kind: "StatefulSet", Name: controller.Config.StatefulSetName,
				UID: types.UID("runtime-statefulset-1"), Controller: &controllerRef,
			}},
		},
		Spec: corev1.PodSpec{NodeName: node},
		Status: corev1.PodStatus{Phase: corev1.PodRunning, Conditions: []corev1.PodCondition{{
			Type: corev1.PodReady, Status: corev1.ConditionTrue,
		}}},
	}, metav1.CreateOptions{}); err != nil {
		t.Fatal(err)
	}
}

func assertMachineExists(t *testing.T, client *dynamicfake.FakeDynamicClient, name string, want bool) {
	t.Helper()
	_, err := client.Resource(machineResource).Get(context.Background(), name, metav1.GetOptions{})
	if (err == nil) != want {
		t.Fatalf("Machine %s existence=%t, want %t (error=%v)", name, err == nil, want, err)
	}
}

func assertExactEviction(t *testing.T, controller *Controller, name, uid string) {
	t.Helper()
	for _, action := range controller.Kubernetes.(*kubefake.Clientset).Actions() {
		create, ok := action.(k8stesting.CreateAction)
		if !ok || action.GetResource().Resource != "pods" || action.GetSubresource() != "eviction" {
			continue
		}
		eviction, ok := create.GetObject().(*policyv1.Eviction)
		if !ok || eviction.Name != name || eviction.DeleteOptions == nil || eviction.DeleteOptions.Preconditions == nil ||
			eviction.DeleteOptions.Preconditions.UID == nil || string(*eviction.DeleteOptions.Preconditions.UID) != uid {
			t.Fatalf("eviction is not bound to exact Pod identity: %#v", create.GetObject())
		}
		return
	}
	t.Fatal("exact Pod eviction was not issued")
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (function roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return function(request)
}
