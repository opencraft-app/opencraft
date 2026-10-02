package fleetcontroller

import (
	"context"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/types"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
)

const retirementTestHex64 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

func TestFDBVolumeRetirementBecomesEligibleAfterThirtyDayQuarantine(t *testing.T) {
	now := time.Date(2026, 9, 18, 1, 2, 3, 0, time.UTC)
	operation, retirement, pv := retirementTestObjects(now.Add(-30 * 24 * time.Hour))
	kubeClient := fake.NewClientBuilder().WithScheme(operatorTestScheme()).
		WithStatusSubresource(operation, retirement).
		WithObjects(operation, retirement, pv).Build()
	reconciler := FDBVolumeRetirementReconciler{Client: kubeClient, Now: func() time.Time { return now }}
	request := ctrl.Request{NamespacedName: types.NamespacedName{Name: retirement.GetName(), Namespace: retirement.GetNamespace()}}
	if _, err := reconciler.Reconcile(context.Background(), request); err != nil {
		t.Fatal(err)
	}
	updated := object(fdbVolumeRetirementGVK)
	if err := kubeClient.Get(context.Background(), request.NamespacedName, updated); err != nil {
		t.Fatal(err)
	}
	if got := nestedString(updated.Object, "status", "phase"); got != "Eligible" {
		t.Fatalf("retirement phase = %q, want Eligible", got)
	}
	if got := nestedString(updated.Object, "status", "cloudState"); got != "Unattached" {
		t.Fatalf("cloud state = %q", got)
	}
	if nestedString(updated.Object, "status", "scaleDownReceiptDigest") != "sha256:"+retirementTestHex64 {
		t.Fatal("eligible volume was not bound to the scale-down receipt")
	}
	stillRetained := &corev1.PersistentVolume{}
	if err := kubeClient.Get(context.Background(), types.NamespacedName{Name: pv.Name}, stillRetained); err != nil {
		t.Fatalf("ObserveOnly retirement deleted the PV: %v", err)
	}
	if stillRetained.Spec.PersistentVolumeReclaimPolicy != corev1.PersistentVolumeReclaimRetain {
		t.Fatal("ObserveOnly retirement changed the Retain policy")
	}
}

func TestFDBVolumeRetirementBlocksReusedPVCIdentity(t *testing.T) {
	now := time.Date(2026, 8, 19, 1, 2, 3, 0, time.UTC)
	operation, retirement, pv := retirementTestObjects(time.Time{})
	pvc := &corev1.PersistentVolumeClaim{ObjectMeta: metav1.ObjectMeta{
		Name: nestedString(retirement.Object, "spec", "pvcRef", "name"), Namespace: retirement.GetNamespace(), UID: types.UID("different-pvc-uid"),
	}}
	kubeClient := fake.NewClientBuilder().WithScheme(operatorTestScheme()).
		WithStatusSubresource(operation, retirement).
		WithObjects(operation, retirement, pv, pvc).Build()
	reconciler := FDBVolumeRetirementReconciler{Client: kubeClient, Now: func() time.Time { return now }}
	request := ctrl.Request{NamespacedName: types.NamespacedName{Name: retirement.GetName(), Namespace: retirement.GetNamespace()}}
	if _, err := reconciler.Reconcile(context.Background(), request); err != nil {
		t.Fatal(err)
	}
	updated := object(fdbVolumeRetirementGVK)
	if err := kubeClient.Get(context.Background(), request.NamespacedName, updated); err != nil {
		t.Fatal(err)
	}
	if nestedString(updated.Object, "status", "phase") != "Blocked" {
		t.Fatalf("reused PVC identity was not blocked: %#v", updated.Object["status"])
	}
	conditions, _, _ := unstructured.NestedSlice(updated.Object, "status", "conditions")
	if len(conditions) != 1 || nestedString(conditions[0].(map[string]any), "reason") != "PVCIdentityReused" {
		t.Fatalf("unexpected block condition: %#v", conditions)
	}
}

func retirementTestObjects(releasedAt time.Time) (*unstructured.Unstructured, *unstructured.Unstructured, *corev1.PersistentVolume) {
	operation := object(fdbScaleOperationGVK)
	operation.SetName("actor-bj-k01-fdb-12-9-deadbeef")
	operation.SetNamespace("actor-fdb-cells")
	operation.SetUID(types.UID("operation-uid"))
	operation.Object["status"] = map[string]any{
		"phase": "Succeeded", "receiptRef": "kubernetes://actor-fdb-cells/fdbscaleoperations/test", "receiptDigest": "sha256:" + retirementTestHex64,
	}
	retirement := object(fdbVolumeRetirementGVK)
	retirement.SetName("actor-bj-k01-fdb-12-9-deadbeef-123")
	retirement.SetNamespace("actor-fdb-cells")
	retirement.SetUID(types.UID("retirement-uid"))
	retirement.SetGeneration(1)
	retirement.Object["spec"] = map[string]any{
		"cellRef":                map[string]any{"name": "actor-bj-k01", "uid": "cell-uid"},
		"foundationDBClusterRef": map[string]any{"name": "actor-bj-k01", "uid": "fdb-uid"},
		"scaleOperationRef":      map[string]any{"name": operation.GetName(), "uid": string(operation.GetUID())},
		"processGroupID":         "storage-123", "pvcRef": map[string]any{"name": "pvc-123", "uid": "pvc-uid"},
		"pvRef": map[string]any{"name": "pv-123", "uid": "pv-uid"}, "cbsDiskID": "disk-test123",
		"csiDriver": "com.tencent.cloud.csi.cbs", "quarantineSeconds": int64(2592000), "gcMode": FDBVolumeGCObserveOnly,
	}
	if !releasedAt.IsZero() {
		retirement.Object["status"] = map[string]any{"phase": "Quarantined", "releasedAt": releasedAt.Format(time.RFC3339)}
	}
	pv := &corev1.PersistentVolume{
		ObjectMeta: metav1.ObjectMeta{Name: "pv-123", UID: types.UID("pv-uid"), Annotations: map[string]string{
			FDBVolumeProcessGroup: "storage-123", FDBVolumeCellUID: "cell-uid", FDBVolumeClusterUID: "fdb-uid", FDBVolumeCBSDiskID: "disk-test123",
		}},
		Spec: corev1.PersistentVolumeSpec{
			PersistentVolumeReclaimPolicy: corev1.PersistentVolumeReclaimRetain,
			PersistentVolumeSource:        corev1.PersistentVolumeSource{CSI: &corev1.CSIPersistentVolumeSource{Driver: "com.tencent.cloud.csi.cbs", VolumeHandle: "disk-test123"}},
		},
		Status: corev1.PersistentVolumeStatus{Phase: corev1.VolumeReleased},
	}
	return operation, retirement, pv
}
