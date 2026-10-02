package fleetcontroller

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	clusterv1 "open-cluster-management.io/api/cluster/v1"
	workv1 "open-cluster-management.io/api/work/v1"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
)

func TestUnifiedMeshHarnessOCMUncertainBoundariesRemainSingleFlight(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 8, 21, 12, 0, 0, 0, time.UTC)
	namespace := "mesh-uncertain"
	_, profile := operatorTestObjects("Required")
	profile.SetName("profile")
	profile.Object["spec"].(map[string]any)["region"] = "ap-beijing"
	profile.Object["spec"].(map[string]any)["cos"] = map[string]any{"coldBucketPrefix": "cold-", "backupBucketPrefix": "backup-"}
	class := object(classGVK)
	class.SetName("class")
	class.Object["spec"] = map[string]any{"controllerName": ControllerName, "profileRef": map[string]any{"name": profile.GetName(), "digest": digestSpec(profile)}}
	claim := object(claimGVK)
	claim.SetName("claim-a")
	claim.SetNamespace(namespace)
	claim.SetUID(types.UID("claim-uid-a"))
	claim.SetGeneration(1)
	claim.Object["spec"] = map[string]any{
		"poolRef": map[string]any{"name": "pool", "uid": "pool-uid"}, "className": class.GetName(), "region": "ap-beijing",
		"managementClusters": []any{"tke-a", "tke-b"}, "reason": "MinimumCells",
	}
	claim.Object["status"] = map[string]any{}
	managedA := &clusterv1.ManagedCluster{}
	managedA.Name, managedA.UID, managedA.Generation = "tke-a", types.UID("tke-a-uid"), 1
	managedB := &clusterv1.ManagedCluster{}
	managedB.Name, managedB.UID, managedB.Generation = "tke-b", types.UID("tke-b-uid"), 1
	environmentA := fakeEnvironmentReport("tke-a", "tke-a-uid", now, 2, 1)
	environmentB := fakeEnvironmentReport("tke-b", "tke-b-uid", now, 8, 1)

	scheme := operatorTestScheme()
	if err := clusterv1.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	if err := workv1.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	addUnstructuredTypes(scheme, claimGVK, environmentReportGVK)
	base := fake.NewClientBuilder().WithScheme(scheme).
		WithStatusSubresource(object(claimGVK), object(cellGVK), &workv1.ManifestWork{}).
		WithObjects(profile, class, claim, managedA, managedB, environmentA, environmentB).Build()
	api := &fakeAPIServerClient{Client: base}
	faults := &ocmFaultClient{Client: api, timeoutWorkCreate: true, conflictBoundStatus: true}
	reconciler := ClaimReconciler{Client: faults, Now: func() time.Time { return now }}
	request := ctrl.Request{NamespacedName: types.NamespacedName{Name: claim.GetName(), Namespace: namespace}}

	for i := 0; i < 10; i++ {
		_, _ = reconciler.Reconcile(ctx, request)
	}
	updatedClaim := getObject(t, ctx, faults, claimGVK, claim.GetName(), namespace)
	providerRef := nestedString(updatedClaim.Object, "status", "providerRef")
	if providerRef == "" || nestedString(updatedClaim.Object, "status", "placementDecision", "targetClusterRef", "name") != "tke-b" {
		t.Fatalf("placement/provider identity was not persisted: %#v", updatedClaim.Object["status"])
	}
	works := &workv1.ManifestWorkList{}
	if err := faults.List(ctx, works); err != nil {
		t.Fatal(err)
	}
	if len(works.Items) != 1 || works.Items[0].Annotations[providerRefAnnotation] != providerRef {
		t.Fatalf("uncertain create materialized %#v ManifestWorks", works.Items)
	}
	if got := works.Items[0].Spec.ManifestConfigs[0].FeedbackScrapeType; got != workv1.FeedbackWatchType {
		t.Fatalf("Cell feedback scrape type = %q, want Watch", got)
	}

	// A becomes more attractive after the decision. The persisted target and
	// providerRef must not drift.
	environmentA = getObject(t, ctx, faults, environmentReportGVK, environmentA.GetName(), "")
	if err := unstructured.SetNestedField(environmentA.Object, int64(100), "spec", "capacity", "availableCellSlots"); err != nil {
		t.Fatal(err)
	}
	if err := faults.Update(ctx, environmentA); err != nil {
		t.Fatal(err)
	}
	logicalName := nestedString(updatedClaim.Object, "status", "placementDecision", "logicalCellName")
	logical := getObject(t, ctx, faults, cellGVK, logicalName, namespace)
	legacyWork := works.Items[0].DeepCopy()
	legacyWork.Spec.ManifestConfigs[0].FeedbackScrapeType = workv1.FeedbackPollType
	if err := faults.Update(ctx, legacyWork); err != nil {
		t.Fatalf("downgrade Work feedback fixture: %v", err)
	}
	changed, err := reconciler.reconcileWorkManifest(ctx, legacyWork, logical)
	if err != nil || !changed {
		t.Fatalf("migrate Poll feedback Work: changed=%v err=%v", changed, err)
	}
	migrated := &workv1.ManifestWork{}
	if err := faults.Get(ctx, types.NamespacedName{Namespace: legacyWork.Namespace, Name: legacyWork.Name}, migrated); err != nil {
		t.Fatal(err)
	}
	if migrated.Spec.ManifestConfigs[0].FeedbackScrapeType != workv1.FeedbackWatchType {
		t.Fatalf("legacy Work feedback scrape type was not migrated: %#v", migrated.Spec.ManifestConfigs)
	}
	logicalStatus := logical.DeepCopy()
	logicalStatus.Object["status"] = map[string]any{"phase": "Ready", "readyForPlacement": true, "capacityRisk": "Normal"}
	if err := faults.Status().Update(ctx, logicalStatus); err != nil {
		t.Fatal(err)
	}

	harness := fakeMeshHarness{Client: faults, Claim: reconciler}
	for i := 0; i < 10; i++ {
		harness.Ensure(t, ctx, updatedClaim)
	}
	updatedClaim = getObject(t, ctx, faults, claimGVK, claim.GetName(), namespace)
	logical = getObject(t, ctx, faults, cellGVK, logicalName, namespace)
	if nestedString(updatedClaim.Object, "status", "phase") != "Bound" || nestedString(updatedClaim.Object, "status", "cellRef", "uid") != string(logical.GetUID()) {
		t.Fatalf("Claim did not bind the exact logical Cell after a retryable status conflict: %#v", updatedClaim.Object["status"])
	}
	if nestedString(updatedClaim.Object, "status", "spokeCellRef", "uid") == "" || nestedString(updatedClaim.Object, "status", "providerRef") != providerRef {
		t.Fatalf("spoke identity/provider drifted: %#v", updatedClaim.Object["status"])
	}
	if err := faults.List(ctx, works); err != nil {
		t.Fatal(err)
	}
	if len(works.Items) != 1 {
		t.Fatalf("ten replayed reconciles created %d ManifestWorks", len(works.Items))
	}

	// A Bound Cell's UID is immutable, but its Kubernetes generation advances
	// when the lifecycle spec changes. Persist the newer generation as a
	// high-water mark, then prove delayed older feedback fails closed.
	oldGeneration := nestedInt64(updatedClaim.Object, "status", "spokeCellRef", "observedGeneration")
	workWithNewGeneration := works.Items[0].DeepCopy()
	for i := range workWithNewGeneration.Status.ResourceStatus.Manifests[0].StatusFeedbacks.Values {
		value := &workWithNewGeneration.Status.ResourceStatus.Manifests[0].StatusFeedbacks.Values[i]
		if value.Name == "cellGeneration" {
			generation := oldGeneration + 1
			value.Value = workv1.FieldValue{Type: workv1.Integer, Integer: &generation}
		}
	}
	if err := faults.Status().Update(ctx, workWithNewGeneration); err != nil {
		t.Fatalf("publish newer spoke generation: %v", err)
	}
	if _, err := reconciler.Reconcile(ctx, request); err != nil {
		t.Fatalf("accept newer spoke generation: %v", err)
	}
	updatedClaim = getObject(t, ctx, faults, claimGVK, claim.GetName(), namespace)
	if got := nestedInt64(updatedClaim.Object, "status", "spokeCellRef", "observedGeneration"); got != oldGeneration+1 {
		t.Fatalf("persisted spoke generation = %d, want %d", got, oldGeneration+1)
	}
	if got := findCondition(t, nestedConditions(updatedClaim.Object, "status", "conditions"), "ProviderReady").Reason; got != "GenerationAdvanced" {
		t.Fatalf("new generation condition reason = %q", got)
	}

	staleWork := &workv1.ManifestWork{}
	if err := faults.Get(ctx, types.NamespacedName{Namespace: works.Items[0].Namespace, Name: works.Items[0].Name}, staleWork); err != nil {
		t.Fatal(err)
	}
	for i := range staleWork.Status.ResourceStatus.Manifests[0].StatusFeedbacks.Values {
		value := &staleWork.Status.ResourceStatus.Manifests[0].StatusFeedbacks.Values[i]
		if value.Name == "cellGeneration" {
			value.Value = workv1.FieldValue{Type: workv1.Integer, Integer: &oldGeneration}
		}
	}
	if err := faults.Status().Update(ctx, staleWork); err != nil {
		t.Fatalf("publish delayed stale generation: %v", err)
	}
	if _, err := reconciler.Reconcile(ctx, request); err != nil {
		t.Fatalf("reject stale spoke generation: %v", err)
	}
	updatedClaim = getObject(t, ctx, faults, claimGVK, claim.GetName(), namespace)
	if got := nestedInt64(updatedClaim.Object, "status", "spokeCellRef", "observedGeneration"); got != oldGeneration+1 {
		t.Fatalf("stale feedback lowered generation fence to %d", got)
	}
	if got := findCondition(t, nestedConditions(updatedClaim.Object, "status", "conditions"), "ProviderReady").Reason; got != "IdentityConflict" {
		t.Fatalf("stale generation condition reason = %q", got)
	}
}

type ocmFaultClient struct {
	client.Client
	mu                  sync.Mutex
	timeoutWorkCreate   bool
	conflictBoundStatus bool
}

func (c *ocmFaultClient) Create(ctx context.Context, object client.Object, options ...client.CreateOption) error {
	if _, isWork := object.(*workv1.ManifestWork); isWork {
		c.mu.Lock()
		inject := c.timeoutWorkCreate
		c.timeoutWorkCreate = false
		c.mu.Unlock()
		if inject {
			if err := c.Client.Create(ctx, object, options...); err != nil {
				return err
			}
			return apierrors.NewTimeoutError("ManifestWork create result was lost", 1)
		}
	}
	return c.Client.Create(ctx, object, options...)
}

func (c *ocmFaultClient) Status() client.SubResourceWriter {
	return &ocmFaultStatusWriter{SubResourceWriter: c.Client.Status(), parent: c}
}

type ocmFaultStatusWriter struct {
	client.SubResourceWriter
	parent *ocmFaultClient
}

func (w *ocmFaultStatusWriter) Update(ctx context.Context, object client.Object, options ...client.SubResourceUpdateOption) error {
	if claim, ok := object.(*unstructured.Unstructured); ok && claim.GetKind() == "RivetCellClaim" && nestedString(claim.Object, "status", "phase") == "Bound" {
		w.parent.mu.Lock()
		inject := w.parent.conflictBoundStatus
		w.parent.conflictBoundStatus = false
		w.parent.mu.Unlock()
		if inject {
			return apierrors.NewConflict(schema.GroupResource{Group: Group, Resource: "rivetcellclaims"}, claim.GetName(), errors.New("scripted status conflict"))
		}
	}
	return w.SubResourceWriter.Update(ctx, object, options...)
}
