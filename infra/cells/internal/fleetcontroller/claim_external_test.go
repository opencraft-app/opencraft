package fleetcontroller

import (
	"context"
	"errors"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/types"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
)

type staticExternalObserver struct {
	observation ExternalCellObservation
	err         error
	desired     []string
}

func (o *staticExternalObserver) Observe(context.Context, *corev1.Secret, *unstructured.Unstructured) (ExternalCellObservation, error) {
	return o.observation, o.err
}

func (o *staticExternalObserver) SetDesiredState(_ context.Context, _ *corev1.Secret, _ *unstructured.Unstructured, desired string) error {
	o.desired = append(o.desired, desired)
	return nil
}

func TestExternalClaimAdoptionBindsExactQualifiedCell(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 9, 10, 14, 0, 0, 0, time.UTC)
	claim, registration, secret, spoke := externalFixtures(now)
	scheme := operatorTestScheme()
	addUnstructuredTypes(scheme, claimGVK, registrationGVK, cellGVK)
	kube := fake.NewClientBuilder().WithScheme(scheme).
		WithStatusSubresource(object(claimGVK), object(cellGVK)).
		WithObjects(claim, registration, secret).Build()
	observer := &staticExternalObserver{observation: ExternalCellObservation{Cell: spoke, ClusterUID: "cluster-uid-a"}}
	reconciler := ExternalClaimReconciler{Client: kube, Reader: kube, Observer: observer, Now: func() time.Time { return now }, CredentialNamespace: claim.GetNamespace()}
	request := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: claim.GetNamespace(), Name: claim.GetName()}}

	if _, err := reconciler.Reconcile(ctx, request); err != nil {
		t.Fatal(err)
	}
	assignFakeLogicalUID(t, ctx, kube, claim.GetNamespace(), spoke.GetName())
	for i := 0; i < 2; i++ {
		if _, err := reconciler.Reconcile(ctx, request); err != nil {
			t.Fatal(err)
		}
	}
	gotClaim := getObject(t, ctx, kube, claimGVK, claim.GetName(), claim.GetNamespace())
	if nestedString(gotClaim.Object, "status", "phase") != "Bound" {
		t.Fatalf("Claim was not Bound: %#v", gotClaim.Object["status"])
	}
	logical := getObject(t, ctx, kube, cellGVK, spoke.GetName(), claim.GetNamespace())
	if nestedString(gotClaim.Object, "status", "cellRef", "uid") != string(logical.GetUID()) ||
		nestedString(gotClaim.Object, "status", "spokeCellRef", "uid") != string(spoke.GetUID()) {
		t.Fatalf("Claim did not retain both logical and spoke UIDs: %#v", gotClaim.Object["status"])
	}
	if nestedString(logical.Object, "status", "spokeCellRef", "uid") != string(spoke.GetUID()) || !nestedBool(logical.Object, "status", "readyForPlacement") {
		t.Fatalf("logical Cell did not mirror the exact spoke status: %#v", logical.Object["status"])
	}
	if nestedString(logical.Object, "spec", "managementCluster") != "actor-bj-c01" || nestedString(spoke.Object, "spec", "managementCluster") != "cls-physical-a" {
		t.Fatalf("logical and physical cluster identities were conflated: logical=%q spoke=%q", nestedString(logical.Object, "spec", "managementCluster"), nestedString(spoke.Object, "spec", "managementCluster"))
	}
	if got := nestedString(gotClaim.Object, "status", "providerRef"); got != externalProviderRef(registration) {
		t.Fatalf("providerRef = %q", got)
	}
}

func TestExternalClaimAdoptionFailsClosedAfterSpokeLoss(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 9, 10, 14, 0, 0, 0, time.UTC)
	claim, registration, secret, spoke := externalFixtures(now)
	scheme := operatorTestScheme()
	addUnstructuredTypes(scheme, claimGVK, registrationGVK, cellGVK)
	kube := fake.NewClientBuilder().WithScheme(scheme).
		WithStatusSubresource(object(claimGVK), object(cellGVK)).
		WithObjects(claim, registration, secret).Build()
	observer := &staticExternalObserver{observation: ExternalCellObservation{Cell: spoke, ClusterUID: "cluster-uid-a"}}
	reconciler := ExternalClaimReconciler{Client: kube, Reader: kube, Observer: observer, Now: func() time.Time { return now }, CredentialNamespace: claim.GetNamespace()}
	request := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: claim.GetNamespace(), Name: claim.GetName()}}
	if _, err := reconciler.Reconcile(ctx, request); err != nil {
		t.Fatal(err)
	}
	assignFakeLogicalUID(t, ctx, kube, claim.GetNamespace(), spoke.GetName())
	for i := 0; i < 2; i++ {
		if _, err := reconciler.Reconcile(ctx, request); err != nil {
			t.Fatal(err)
		}
	}
	observer.err = errors.New("synthetic network partition")
	if _, err := reconciler.Reconcile(ctx, request); err != nil {
		t.Fatal(err)
	}
	gotClaim := getObject(t, ctx, kube, claimGVK, claim.GetName(), claim.GetNamespace())
	if nestedString(gotClaim.Object, "status", "phase") != "Bound" {
		t.Fatalf("temporary loss destroyed durable binding: %#v", gotClaim.Object["status"])
	}
	logical := getObject(t, ctx, kube, cellGVK, spoke.GetName(), claim.GetNamespace())
	if nestedBool(logical.Object, "status", "readyForPlacement") || nestedString(logical.Object, "status", "capacityRisk") != "AdmissionClosed" {
		t.Fatalf("lost spoke remained routable: %#v", logical.Object["status"])
	}
}

func assignFakeLogicalUID(t *testing.T, ctx context.Context, kube client.Client, namespace, name string) {
	t.Helper()
	logical := getObject(t, ctx, kube, cellGVK, name, namespace)
	logical.SetUID(types.UID("logical-cell-uid-a"))
	if err := kube.Update(ctx, logical); err != nil {
		t.Fatal(err)
	}
}

func TestExternalClaimAdoptionRejectsStaleOrWrongIdentity(t *testing.T) {
	now := time.Date(2026, 9, 10, 14, 0, 0, 0, time.UTC)
	claim, registration, _, spoke := externalFixtures(now)
	if externalObservationReady(spoke, now.Add(3*time.Minute), 2*time.Minute) {
		t.Fatal("stale spoke was considered ready")
	}
	observation := ExternalCellObservation{Cell: spoke, ClusterUID: "recreated-cluster-uid"}
	if err := validateExternalObservation(claim, registration, observation); err == nil {
		t.Fatal("recreated cluster UID crossed the adoption fence")
	}
}

func TestExternalClaimAdoptionRequiresReviewedQualificationDigest(t *testing.T) {
	now := time.Date(2026, 9, 10, 14, 0, 0, 0, time.UTC)
	claim, registration, _, _ := externalFixtures(now)
	delete(registration.Object["spec"].(map[string]any)["evidence"].(map[string]any), "qualificationChainReceiptDigest")
	if err := validateExternalRegistration(claim, registration); err == nil {
		t.Fatal("Registration without reviewed qualification digest was accepted")
	}
}

func externalFixtures(now time.Time) (*unstructured.Unstructured, *unstructured.Unstructured, *corev1.Secret, *unstructured.Unstructured) {
	claim := object(claimGVK)
	claim.SetName("claim-a")
	claim.SetNamespace("actor-fleet-system")
	claim.SetUID(types.UID("claim-uid-a"))
	claim.SetGeneration(1)
	claim.Object["spec"] = map[string]any{
		"poolRef": map[string]any{"name": "pool-a", "uid": "pool-uid-a"}, "className": "class-a", "region": "ap-beijing",
		"managementClusters": []any{"actor-bj-c01"}, "reason": "MinimumCells",
	}
	claim.Object["status"] = map[string]any{}
	registration := object(registrationGVK)
	registration.SetName("actor-bj-a01")
	registration.SetNamespace(claim.GetNamespace())
	registration.SetUID(types.UID("registration-uid-a"))
	registration.SetLabels(map[string]string{claimUIDAnnotation: string(claim.GetUID())})
	registration.Object["spec"] = map[string]any{
		"provider":            externalProviderName,
		"claimRef":            map[string]any{"name": claim.GetName(), "uid": string(claim.GetUID())},
		"poolRef":             map[string]any{"name": "pool-a", "uid": "pool-uid-a"},
		"spokeClusterRef":     map[string]any{"name": "actor-bj-a01", "uid": "cluster-uid-a"},
		"spokeCellRef":        map[string]any{"name": "actor-bj-a01", "namespace": "actor-fdb-cell-system", "uid": "spoke-cell-uid-a"},
		"credentialSecretRef": map[string]any{"namespace": claim.GetNamespace(), "name": "actor-cell-provider-actor-bj-a01", "uid": "secret-uid-a", "key": "kubeconfig"},
		"evidence": map[string]any{
			"profileDigest": "sha256:" + repeat("a", 64), "releaseDigest": "sha256:" + repeat("b", 64),
			"convergenceReceiptDigest":        "sha256:" + repeat("c", 64),
			"qualificationChainReceiptDigest": "sha256:" + repeat("e", 64),
			"activationReceiptDigest":         "sha256:" + repeat("d", 64),
		},
		"datacenterName": "actor-bj-a01", "registeredAt": now.Format(time.RFC3339),
	}
	immutable := true
	secret := &corev1.Secret{ObjectMeta: metav1.ObjectMeta{Name: "actor-cell-provider-actor-bj-a01", Namespace: claim.GetNamespace(), UID: types.UID("secret-uid-a")}, Immutable: &immutable, Data: map[string][]byte{"kubeconfig": []byte("fixture")}}
	spoke := object(cellGVK)
	spoke.SetName("actor-bj-a01")
	spoke.SetNamespace("actor-fdb-cell-system")
	spoke.SetUID(types.UID("spoke-cell-uid-a"))
	spoke.SetGeneration(4)
	spoke.Object["spec"] = map[string]any{
		"cellId": "actor-bj-a01", "className": "class-a", "region": "ap-beijing", "managementCluster": "cls-physical-a", "desiredState": "Ready",
		"foundationDB": map[string]any{"exclusive": true, "clusterRef": map[string]any{"name": "fdb", "namespace": "actor-fdb-cell-system"}},
		"cos":          map[string]any{"coldBucket": "cold", "backupBucket": "backup"},
		"retirement":   map[string]any{"generation": int64(1), "requestId": "initial", "proofRequired": true, "rollbackRetentionSeconds": int64(604800)},
	}
	spoke.Object["status"] = map[string]any{
		"observedGeneration": int64(4), "phase": "Ready", "readyForPlacement": true, "capacityRisk": "Normal", "reportObservedAt": now.Format(time.RFC3339),
		"profileDigest": "sha256:" + repeat("a", 64), "scaleOutEpoch": int64(0), "placementCount": int64(0), "pendingReservations": int64(0),
	}
	return claim, registration, secret, spoke
}

func repeat(value string, count int) string {
	result := ""
	for i := 0; i < count; i++ {
		result += value
	}
	return result
}
