package fleetcontroller

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/rivet-dev/rivet/infra/cells/internal/cellreporter"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	clusterv1 "open-cluster-management.io/api/cluster/v1"
	workv1 "open-cluster-management.io/api/work/v1"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
)

// TestMeshHarnessCellCapacityAutoscaling keeps the fleet controllers real and fakes
// only the external systems that are not part of this repository: OCM work
// delivery, FoundationDB Operator convergence, and Cell Agent qualification.
//
// The test is deliberately stricter than the historical minCells test. A Claim
// is not success: the exact target Cell must become independently qualified and
// enter Pool admission. It then grows that Cell's FDB and TKE capacity from 9
// to 12 before proving that a stale qualification removes it again.
func TestMeshHarnessCellCapacityAutoscaling(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Second)
	namespace := "fake-cell-scaleout"
	poolName := "actor-beijing"
	className := "rivet-fdb-cos-kubernetes-v1"
	profileName := "rivet-fdb-cos-beijing-kubernetes-v1"
	sharedPrometheus := newMeshSharedPrometheus(t, map[string]map[string]string{
		"actor-bj-a01": {
			"actor:fdb_storage_headroom_bytes":       fmt.Sprint(192 << 30),
			"actor_fleet:cell_fdb_logical_bytes":     fmt.Sprint(3 << 30),
			"actor:fdb_storage_headroom_samples:6h":  "1200",
			"actor:fdb_write_utilization:ratio":      "0.55",
			"actor:fdb_data_movement_bytes":          "0",
			"actor:fdb_storage_headroom_eta_seconds": "+Inf",
		},
		"actor-bj-b01": {
			"actor:fdb_storage_headroom_bytes":       fmt.Sprint(192 << 30),
			"actor_fleet:cell_fdb_logical_bytes":     fmt.Sprint(3 << 30),
			"actor:fdb_storage_headroom_samples:6h":  "1200",
			"actor:fdb_write_utilization:ratio":      "0.10",
			"actor:fdb_data_movement_bytes":          "0",
			"actor:fdb_storage_headroom_eta_seconds": "+Inf",
		},
	})
	defer sharedPrometheus.Close()

	_, profile := operatorTestObjects("Required")
	profile.SetName(profileName)
	profile.Object["spec"].(map[string]any)["availabilityMode"] = "production-multi-zone"
	profile.Object["spec"].(map[string]any)["region"] = "ap-beijing"
	profile.Object["spec"].(map[string]any)["runtime"] = map[string]any{
		"minWorkerdHosts": int64(3),
	}
	profile.Object["spec"].(map[string]any)["cos"] = map[string]any{
		"coldBucketPrefix":   "fake-actor-cold-",
		"backupBucketPrefix": "fake-actor-backup-",
	}
	profile.Object["spec"].(map[string]any)["foundationDB"].(map[string]any)["autoscaling"] = map[string]any{
		"mode": FDBAutoscalingAutomatic, "minProcessCount": int64(9),
		"maxProcessCount": int64(30), "stepProcessCount": int64(3),
		"scaleUp": map[string]any{
			"headroomBytes": int64(80 << 30), "etaSeconds": int64(72 * 60 * 60),
			"sustainSeconds": int64(30 * 60), "cooldownSeconds": int64(2 * 60 * 60),
			"minimumSamples": int64(600),
		},
		"scaleDown": map[string]any{
			"headroomBytes": int64(160 << 30), "writeUtilizationPercent": int64(20),
			"sustainSeconds": int64(24 * 60 * 60), "cooldownSeconds": int64(7 * 24 * 60 * 60),
			"minimumSamples": int64(1200),
		},
		"volumeRetentionSeconds": int64(DefaultFDBVolumeRetention / time.Second),
		"volumeGCMode":           FDBVolumeGCObserveOnly,
	}
	profileDigest := digestSpec(profile)

	class := object(classGVK)
	class.SetName(className)
	class.Object["spec"] = map[string]any{
		"controllerName": ControllerName,
		"profileRef": map[string]any{
			"name": profileName, "digest": profileDigest,
		},
	}

	pool := object(poolGVK)
	pool.SetName(poolName)
	pool.SetNamespace(namespace)
	pool.SetUID(types.UID("pool-exact-uid"))
	pool.SetGeneration(1)
	pool.Object["spec"] = map[string]any{
		"className": className,
		"minCells":  int64(1),
		"maxCells":  int64(3),
		"placement": map[string]any{
			"region": "ap-beijing", "managementClusters": []any{"tke-a", "tke-b"},
		},
	}

	// Cell A starts as a fully qualified real member. The shared Prometheus
	// evidence, not pre-baked status, must close admission and mint epoch 1.
	source := object(cellGVK)
	source.SetName("actor-bj-a01")
	source.SetNamespace(namespace)
	source.SetUID(types.UID("source-cell-uid"))
	source.SetGeneration(1)
	source.SetLabels(map[string]string{PoolLabel: poolName})
	sourceConnection := "source:identity@10.0.0.10:4500"
	sourceFDBUID := "source-fdb-uid"
	sourceIdentity := databaseIdentityHash(sourceFDBUID, sourceConnection)
	source.Object["spec"] = map[string]any{
		"className": className, "region": "ap-beijing", "managementCluster": "tke-a",
		"desiredState": "Ready",
		"foundationDB": map[string]any{
			"exclusive": true, "clusterIdentityHash": sourceIdentity,
			"clusterRef": map[string]any{"name": source.GetName(), "namespace": namespace, "uid": sourceFDBUID},
		},
		"cos": map[string]any{
			"coldBucket": "fake-actor-cold-" + source.GetName(), "backupBucket": "fake-actor-backup-" + source.GetName(),
		},
		"retirement": map[string]any{"generation": int64(1), "proofRequired": true, "rollbackRetentionSeconds": int64(604800)},
	}
	source.Object["status"] = map[string]any{}
	sourceCluster := object(fdbClusterGVK)
	sourceCluster.SetName(source.GetName())
	sourceCluster.SetNamespace(namespace)
	sourceCluster.SetUID(types.UID(sourceFDBUID))
	sourceCluster.SetGeneration(1)
	sourceCluster.SetLabels(map[string]string{FDBCellUIDLabel: string(source.GetUID())})
	sourceCluster.Object["spec"] = map[string]any{"processCounts": map[string]any{"storage": int64(9)}}
	sourceCluster.Object["status"] = map[string]any{
		"generations":          map[string]any{"reconciled": int64(1)},
		"desiredProcessGroups": int64(9), "reconciledProcessGroups": int64(9),
		"runningVersion": "7.3.79", "configured": true, "connectionString": sourceConnection,
		"health": map[string]any{"available": true, "healthy": true, "fullReplication": true},
	}

	scheme := operatorTestScheme()
	if err := clusterv1.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	if err := workv1.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	addUnstructuredTypes(scheme, poolGVK, claimGVK, environmentReportGVK)
	managedA := &clusterv1.ManagedCluster{ObjectMeta: metav1.ObjectMeta{Name: "tke-a", UID: types.UID("tke-a-uid"), Generation: 1}}
	managedB := &clusterv1.ManagedCluster{ObjectMeta: metav1.ObjectMeta{Name: "tke-b", UID: types.UID("tke-b-uid"), Generation: 1}}
	environmentA := fakeEnvironmentReport("tke-a", "tke-a-uid", now, 1, 1)
	environmentB := fakeEnvironmentReport("tke-b", "tke-b-uid", now, 8, 0)
	machineSet := testTKEMachineSet(9, 9)
	machineSetLabels, _, _ := unstructured.NestedStringMap(machineSet.Object, "spec", "template", "spec", "metadata", "labels")
	machineSetLabels[FDBCellNameLabel] = "actor-bj-b01"
	if err := unstructured.SetNestedStringMap(machineSet.Object, machineSetLabels, "spec", "template", "spec", "metadata", "labels"); err != nil {
		t.Fatal(err)
	}
	baseClient := fake.NewClientBuilder().
		WithScheme(scheme).
		WithStatusSubresource(object(poolGVK), object(claimGVK), object(cellGVK), object(fdbClusterGVK), object(fdbScaleOperationGVK), &workv1.ManifestWork{}).
		WithObjects(profile, class, pool, source, sourceCluster, machineSet, managedA, managedB, environmentA, environmentB).
		Build()
	kubeClient := &fakeAPIServerClient{Client: baseClient}
	cellReconciler := CellReconciler{
		Client: kubeClient, ReportFreshness: 2 * time.Minute,
		Now: func() time.Time { return now }, WatchFDBClusters: true, ProcessLogicalCells: true,
	}
	sourceEvidence := collectMeshCapacity(t, ctx, sharedPrometheus.URL, source.GetName())
	fakeCellAgentReport(t, ctx, kubeClient, source, profileDigest, now, sourceEvidence)
	sourceRequest := ctrl.Request{NamespacedName: types.NamespacedName{Name: source.GetName(), Namespace: namespace}}
	mustReconcile(t, ctx, &cellReconciler, sourceRequest)
	mustReconcile(t, ctx, &cellReconciler, sourceRequest)
	source = getObject(t, ctx, kubeClient, cellGVK, source.GetName(), namespace)
	if got := nestedString(source.Object, "status", "capacityRisk"); got != "AdmissionClosed" {
		t.Fatalf("source capacity risk = %q, want AdmissionClosed", got)
	}
	if got := nestedInt64(source.Object, "status", "scaleOutEpoch"); got != 1 {
		t.Fatalf("source scaleOutEpoch = %d, want controller-minted epoch 1", got)
	}

	poolReconciler := PoolReconciler{
		Client: kubeClient, MaxClaimsPerReconcile: 1, Now: func() time.Time { return now },
	}
	request := ctrl.Request{NamespacedName: types.NamespacedName{Name: poolName, Namespace: namespace}}

	// The first pass publishes Pool status; the second is allowed to create the
	// immutable Claim. This is the real Pool reconciler path.
	mustReconcile(t, ctx, &poolReconciler, request)
	mustReconcile(t, ctx, &poolReconciler, request)
	claims := listObjects(t, ctx, kubeClient, claimGVK, namespace)
	if len(claims) != 1 {
		t.Fatalf("capacity epoch created %d Claims, want exactly 1", len(claims))
	}
	claim := claims[0].DeepCopy()
	if got := nestedString(claim.Object, "spec", "reason"); got != "CapacityPressure" {
		t.Fatalf("Claim reason = %q, want CapacityPressure", got)
	}
	if got := nestedInt64(claim.Object, "spec", "trigger", "scaleOutEpoch"); got != 1 {
		t.Fatalf("Claim scaleOutEpoch = %d, want 1", got)
	}

	provider := fakeMeshHarness{Client: kubeClient, Claim: ClaimReconciler{Client: kubeClient, Now: func() time.Time { return now }}}
	target := provider.Ensure(t, ctx, claim)
	sharedPrometheus.SetCell(target.GetName(), map[string]string{
		"actor:fdb_storage_headroom_bytes": fmt.Sprint(192 << 30), "actor:fdb_storage_headroom_samples:6h": "1200",
		"actor_fleet:cell_fdb_logical_bytes": fmt.Sprint(3 << 30),
		"actor:fdb_write_utilization:ratio":  "0.10", "actor:fdb_data_movement_bytes": "0", "actor:fdb_storage_headroom_eta_seconds": "+Inf",
	})
	machineSet = getObject(t, ctx, kubeClient, tkeMachineSetGVK, "np-fdbpool0", "")
	machineSetLabels, _, _ = unstructured.NestedStringMap(machineSet.Object, "spec", "template", "spec", "metadata", "labels")
	machineSetLabels[FDBCellNameLabel] = target.GetName()
	if err := unstructured.SetNestedStringMap(machineSet.Object, machineSetLabels, "spec", "template", "spec", "metadata", "labels"); err != nil {
		t.Fatal(err)
	}
	if err := kubeClient.Update(ctx, machineSet); err != nil {
		t.Fatal(err)
	}
	for _, topologyObject := range initialFDBMachineTopology(target, map[string]int{"zone-a": 3, "zone-b": 3, "zone-c": 3}) {
		if topologyObject.GetObjectKind().GroupVersionKind().Kind == "MachineSet" {
			continue
		}
		if err := kubeClient.Create(ctx, topologyObject); err != nil {
			t.Fatal(err)
		}
	}
	for _, topologyObject := range initialControlMachineTopology(target, map[string]int{"zone-a": 1, "zone-b": 1, "zone-c": 1}) {
		if err := kubeClient.Create(ctx, topologyObject); err != nil {
			t.Fatal(err)
		}
	}
	providerRef := claimStatusString(t, ctx, kubeClient, claim.GetName(), namespace, "providerRef")
	if providerRef == "" || claimStatusString(t, ctx, kubeClient, claim.GetName(), namespace, "phase") != "Provisioning" {
		t.Fatal("fake OCM provider did not persist target identity before provisioning")
	}
	provider.Ensure(t, ctx, claim)
	if got := len(listObjects(t, ctx, kubeClient, cellGVK, namespace)); got != 2 {
		t.Fatalf("provider retry produced %d total Cells, want source plus one target", got)
	}
	if got := claimStatusString(t, ctx, kubeClient, claim.GetName(), namespace, "providerRef"); got != providerRef {
		t.Fatalf("provider target changed across retry: %q != %q", got, providerRef)
	}

	cellRequest := ctrl.Request{NamespacedName: types.NamespacedName{Name: target.GetName(), Namespace: namespace}}
	// One pass adds retirement protection; another proves the target remains
	// fail-closed while FDB and qualification evidence are missing.
	mustReconcile(t, ctx, &cellReconciler, cellRequest)
	mustReconcile(t, ctx, &cellReconciler, cellRequest)
	assertCellAdmission(t, ctx, kubeClient, target.GetName(), namespace, false)
	provider.Ensure(t, ctx, claim)
	if got := claimStatusString(t, ctx, kubeClient, claim.GetName(), namespace, "phase"); got != "Provisioning" {
		t.Fatalf("Claim bound before Cell qualification: phase=%q", got)
	}

	// The real Fleet FDB provider creates the database. Only the upstream FDB
	// Operator's status transition is faked.
	fdbReconciler := FDBKubernetesReconciler{Client: kubeClient}
	mustReconcile(t, ctx, &fdbReconciler, cellRequest)
	cluster := getObject(t, ctx, kubeClient, fdbClusterGVK, target.GetName(), namespace)
	fakeFDBOperatorReady(t, ctx, kubeClient, cluster)
	mustReconcile(t, ctx, &fdbReconciler, cellRequest)
	target = getObject(t, ctx, kubeClient, cellGVK, target.GetName(), namespace)
	if nestedString(target.Object, "spec", "foundationDB", "clusterRef", "uid") == "" ||
		nestedString(target.Object, "spec", "foundationDB", "clusterIdentityHash") == "" {
		t.Fatal("Fleet FDB provider did not bind the exact database identity")
	}

	// A healthy FDB still cannot admit the Cell. The independent Cell Agent must
	// publish fresh, UID/generation-bound qualification evidence.
	mustReconcile(t, ctx, &cellReconciler, cellRequest)
	assertCellAdmission(t, ctx, kubeClient, target.GetName(), namespace, false)
	provider.Ensure(t, ctx, claim)
	if got := claimStatusString(t, ctx, kubeClient, claim.GetName(), namespace, "phase"); got != "Provisioning" {
		t.Fatalf("Claim bound before independent qualification: phase=%q", got)
	}

	targetNormalEvidence := collectMeshCapacity(t, ctx, sharedPrometheus.URL, target.GetName())
	fakeCellAgentReport(t, ctx, kubeClient, target, profileDigest, now, targetNormalEvidence)
	mustReconcile(t, ctx, &cellReconciler, cellRequest)
	assertCellAdmission(t, ctx, kubeClient, target.GetName(), namespace, true)

	provider.Ensure(t, ctx, claim)
	boundClaim := getObject(t, ctx, kubeClient, claimGVK, claim.GetName(), namespace)
	if got := nestedString(boundClaim.Object, "status", "phase"); got != "Bound" {
		t.Fatalf("qualified Claim phase = %q, want Bound", got)
	}
	if got := nestedString(boundClaim.Object, "status", "cellRef", "uid"); got != string(target.GetUID()) {
		t.Fatalf("Claim bound Cell UID = %q, want %q", got, target.GetUID())
	}

	mustReconcile(t, ctx, &poolReconciler, request)
	updatedPool := getObject(t, ctx, kubeClient, poolGVK, poolName, namespace)
	if !nestedBool(updatedPool.Object, "status", "admissionOpen") {
		t.Fatal("Pool admission did not open after the new Cell qualified")
	}
	candidates := nestedStringSlice(updatedPool.Object, "status", "admissionCandidates")
	if len(candidates) != 1 || candidates[0] != target.GetName() {
		t.Fatalf("Pool admission candidates = %#v, want only %q", candidates, target.GetName())
	}

	// Reconcile storms and provider retries must not materialize another Claim,
	// Cell, or FDB cluster for the already handled epoch.
	for i := 0; i < 5; i++ {
		provider.Ensure(t, ctx, claim)
		mustReconcile(t, ctx, &poolReconciler, request)
	}
	if got := len(listObjects(t, ctx, kubeClient, claimGVK, namespace)); got != 1 {
		t.Fatalf("handled epoch produced %d Claims, want 1", got)
	}
	if got := len(listObjects(t, ctx, kubeClient, cellGVK, namespace)); got != 2 {
		t.Fatalf("handled epoch produced %d total Cells, want 2", got)
	}
	if got := len(listObjects(t, ctx, kubeClient, fdbClusterGVK, namespace)); got != 2 {
		t.Fatalf("handled epoch produced %d FDB clusters, want one per Cell", got)
	}

	// The same fake environment also drives in-Cell autoscaling. Sustained low
	// headroom first changes the persisted target from 9 to 12. The Fleet FDB
	// provider then raises the dedicated TKE MachineSet floor, publishes the FDB
	// process target, and waits for independent Operator and backup evidence.
	sharedPrometheus.SetCell(target.GetName(), map[string]string{
		"actor:fdb_storage_headroom_bytes":       fmt.Sprint(32 << 30),
		"actor_fleet:cell_fdb_logical_bytes":     fmt.Sprint(3 << 30),
		"actor:fdb_storage_headroom_samples:6h":  "1200",
		"actor:fdb_write_utilization:ratio":      "0.70",
		"actor:fdb_data_movement_bytes":          "0",
		"actor:fdb_storage_headroom_eta_seconds": fmt.Sprint(24 * 60 * 60),
	})
	pressureEvidence := collectMeshCapacity(t, ctx, sharedPrometheus.URL, target.GetName())
	fakeCellAgentCapacityReport(t, ctx, kubeClient, target.GetName(), namespace, now, pressureEvidence)
	mustReconcile(t, ctx, &cellReconciler, cellRequest)
	target = getObject(t, ctx, kubeClient, cellGVK, target.GetName(), namespace)
	if got := nestedString(target.Object, "status", "capacityRisk"); got != "Protect" {
		t.Fatalf("target capacity risk = %q, want Protect", got)
	}
	if got := nestedInt64(target.Object, "status", "scaleOutEpoch"); got != 1 {
		t.Fatalf("target pressure did not mint one horizontal epoch: %d", got)
	}
	// Horizontal Cell expansion and vertical FDB expansion are independent.
	// The Pool may create one Claim while the FDB signal is still maturing.
	mustReconcile(t, ctx, &poolReconciler, request)
	mustReconcile(t, ctx, &poolReconciler, request)
	if got := len(listObjects(t, ctx, kubeClient, claimGVK, namespace)); got != 2 {
		t.Fatalf("dual-loop pressure produced %d Claims, want original plus one target epoch", got)
	}
	assertFDBDesiredProcesses(t, ctx, kubeClient, target.GetName(), namespace, 9)
	now = now.Add(31 * time.Minute)
	fakeCellAgentCapacityReport(t, ctx, kubeClient, target.GetName(), namespace, now, pressureEvidence)
	mustReconcile(t, ctx, &cellReconciler, cellRequest)
	assertFDBDesiredProcesses(t, ctx, kubeClient, target.GetName(), namespace, 12)

	mustReconcile(t, ctx, &fdbReconciler, cellRequest)
	mustReconcile(t, ctx, &fdbReconciler, cellRequest)
	operation := onlyObject(t, listObjects(t, ctx, kubeClient, fdbScaleOperationGVK, namespace), "FDBScaleOperation")
	if got := nestedString(operation.Object, "status", "phase"); got != "ProvisioningCapacity" {
		t.Fatalf("FDB scale operation phase = %q, want ProvisioningCapacity", got)
	}
	machineSet = getObject(t, ctx, kubeClient, tkeMachineSetGVK, "np-fdbpool0", "")
	if got := nestedInt64(machineSet.Object, "spec", "scaling", "minReplicas"); got != 12 {
		t.Fatalf("Cell MachineSet floor = %d, want 12", got)
	}
	cluster = getObject(t, ctx, kubeClient, fdbClusterGVK, target.GetName(), namespace)
	if got := nestedInt64(cluster.Object, "spec", "processCounts", "storage"); got != 12 {
		t.Fatalf("FoundationDB target = %d, want 12", got)
	}

	fakeTKECapacityReady(t, ctx, kubeClient, machineSet, 12)
	cluster = getObject(t, ctx, kubeClient, fdbClusterGVK, target.GetName(), namespace)
	fakeFDBOperatorProcessTarget(t, ctx, kubeClient, cluster, 12)
	mustReconcile(t, ctx, &fdbReconciler, cellRequest)
	fakeCellAgentCapacityReport(t, ctx, kubeClient, target.GetName(), namespace, now, pressureEvidence)
	mustReconcile(t, ctx, &fdbReconciler, cellRequest)
	operation = getObject(t, ctx, kubeClient, fdbScaleOperationGVK, operation.GetName(), namespace)
	if got := nestedString(operation.Object, "status", "phase"); got != "Succeeded" {
		t.Fatalf("FDB scale operation phase = %q, want Succeeded", got)
	}
	mustReconcile(t, ctx, &cellReconciler, cellRequest)
	target = getObject(t, ctx, kubeClient, cellGVK, target.GetName(), namespace)
	if got := nestedInt64(target.Object, "status", "foundationDBAutoscaling", "observedProcessCount"); got != 12 {
		t.Fatalf("Cell observed FDB processes = %d, want 12", got)
	}

	// Binding is durable, but admission is live evidence: expiration must close
	// the target immediately without replaying either handled pressure epoch.
	now = now.Add(3 * time.Minute)
	mustReconcile(t, ctx, &cellReconciler, cellRequest)
	assertCellAdmission(t, ctx, kubeClient, target.GetName(), namespace, false)
	mustReconcile(t, ctx, &poolReconciler, request)
	updatedPool = getObject(t, ctx, kubeClient, poolGVK, poolName, namespace)
	if nestedBool(updatedPool.Object, "status", "admissionOpen") {
		t.Fatal("Pool admission remained open with only stale qualification evidence")
	}
	if got := len(listObjects(t, ctx, kubeClient, claimGVK, namespace)); got != 2 {
		t.Fatalf("stale target report retriggered a handled pressure epoch: Claims=%d", got)
	}
}

type fakeAPIServerClient struct {
	client.Client
	nextID int
}

func (c *fakeAPIServerClient) Create(ctx context.Context, obj client.Object, options ...client.CreateOption) error {
	if obj.GetName() == "" && obj.GetGenerateName() != "" {
		c.nextID++
		obj.SetName(fmt.Sprintf("%s%03d", obj.GetGenerateName(), c.nextID))
	}
	if obj.GetUID() == "" {
		c.nextID++
		obj.SetUID(types.UID(fmt.Sprintf("fake-uid-%03d", c.nextID)))
	}
	if obj.GetGeneration() == 0 {
		obj.SetGeneration(1)
	}
	return c.Client.Create(ctx, obj, options...)
}

type fakeMeshHarness struct {
	Client client.Client
	Claim  ClaimReconciler
}

func (h fakeMeshHarness) Ensure(t *testing.T, ctx context.Context, originalClaim *unstructured.Unstructured) *unstructured.Unstructured {
	t.Helper()
	request := ctrl.Request{NamespacedName: types.NamespacedName{Name: originalClaim.GetName(), Namespace: originalClaim.GetNamespace()}}
	for i := 0; i < 8; i++ {
		if _, err := h.Claim.Reconcile(ctx, request); err != nil {
			if apierrors.IsConflict(err) || apierrors.IsTimeout(err) {
				continue
			}
			t.Fatalf("reconcile real Claim/ManifestWork state machine: %v", err)
		}
		claim := getObject(t, ctx, h.Client, claimGVK, originalClaim.GetName(), originalClaim.GetNamespace())
		cellName := nestedString(claim.Object, "status", "placementDecision", "logicalCellName")
		if cellName == "" {
			continue
		}
		cell := object(cellGVK)
		if err := h.Client.Get(ctx, types.NamespacedName{Name: cellName, Namespace: claim.GetNamespace()}, cell); err != nil {
			if client.IgnoreNotFound(err) == nil {
				continue
			}
			t.Fatal(err)
		}
		works := &workv1.ManifestWorkList{}
		if err := h.Client.List(ctx, works); err != nil {
			t.Fatal(err)
		}
		for workIndex := range works.Items {
			work := &works.Items[workIndex]
			if work.Annotations[claimUIDAnnotation] != string(claim.GetUID()) {
				continue
			}
			h.publishWorkFeedback(t, ctx, work, cell)
		}
	}
	claim := getObject(t, ctx, h.Client, claimGVK, originalClaim.GetName(), originalClaim.GetNamespace())
	name := nestedString(claim.Object, "status", "placementDecision", "logicalCellName")
	if name == "" {
		t.Fatal("real Claim reconciler did not persist a placement decision")
	}
	return getObject(t, ctx, h.Client, cellGVK, name, claim.GetNamespace())
}

func (h fakeMeshHarness) publishWorkFeedback(t *testing.T, ctx context.Context, work *workv1.ManifestWork, cell *unstructured.Unstructured) {
	t.Helper()
	stringValue := func(value string) workv1.FieldValue { return workv1.FieldValue{Type: workv1.String, String: &value} }
	integerValue := func(value int64) workv1.FieldValue { return workv1.FieldValue{Type: workv1.Integer, Integer: &value} }
	booleanValue := func(value bool) workv1.FieldValue { return workv1.FieldValue{Type: workv1.Boolean, Boolean: &value} }
	values := []workv1.FeedbackValue{
		{Name: "cellUID", Value: stringValue("spoke-" + string(work.UID))},
		{Name: "cellGeneration", Value: integerValue(cell.GetGeneration())},
		{Name: "phase", Value: stringValue(nestedString(cell.Object, "status", "phase"))},
		{Name: "readyForPlacement", Value: booleanValue(nestedBool(cell.Object, "status", "readyForPlacement"))},
		{Name: "capacityRisk", Value: stringValue(nestedString(cell.Object, "status", "capacityRisk"))},
		{Name: "scaleOutEpoch", Value: integerValue(nestedInt64(cell.Object, "status", "scaleOutEpoch"))},
		{Name: "placementCount", Value: integerValue(nestedInt64(cell.Object, "status", "placementCount"))},
		{Name: "pendingReservations", Value: integerValue(nestedInt64(cell.Object, "status", "pendingReservations"))},
		{Name: "reportObservedAt", Value: stringValue(nestedString(cell.Object, "status", "reportObservedAt"))},
		{Name: "scaleInEvidenceReady", Value: booleanValue(nestedBool(cell.Object, "status", "scaleInEvidenceReady"))},
		{Name: "placementUtilizationPercent", Value: integerValue(nestedInt64(cell.Object, "status", "placementUtilizationPercent"))},
		{Name: "runtimeUtilizationPercent", Value: integerValue(nestedInt64(cell.Object, "status", "runtimeUtilizationPercent"))},
		{Name: "fdbWriteUtilizationPercent", Value: integerValue(nestedInt64(cell.Object, "status", "fdbWriteUtilizationPercent"))},
		{Name: "activeWriters", Value: integerValue(nestedInt64(cell.Object, "status", "activeWriters"))},
		{Name: "inFlightCommits", Value: integerValue(nestedInt64(cell.Object, "status", "inFlightCommits"))},
		{Name: "migrationBacklog", Value: integerValue(nestedInt64(cell.Object, "status", "migrationBacklog"))},
		{Name: "compactionBacklog", Value: integerValue(nestedInt64(cell.Object, "status", "compactionBacklog"))},
		{Name: "gcBacklog", Value: integerValue(nestedInt64(cell.Object, "status", "gcBacklog"))},
		{Name: "reconciliationBacklog", Value: integerValue(nestedInt64(cell.Object, "status", "reconciliationBacklog"))},
		{Name: "retirementProofVerified", Value: booleanValue(nestedBool(cell.Object, "status", "retirementProofVerified"))},
		{Name: "retirementProofReady", Value: booleanValue(nestedBool(cell.Object, "status", "retirementProofReady"))},
	}
	updated := work.DeepCopy()
	updated.Status.ResourceStatus.Manifests = []workv1.ManifestCondition{{
		ResourceMeta:    workv1.ManifestResourceMeta{Ordinal: 0, Group: Group, Version: Version, Kind: "RivetCell", Resource: "rivetcells", Name: cell.GetName(), Namespace: cell.GetNamespace()},
		StatusFeedbacks: workv1.StatusFeedbackResult{Values: values},
	}}
	if err := h.Client.Status().Update(ctx, updated); err != nil {
		t.Fatalf("publish fake ManifestWork feedback: %v", err)
	}
}

func fakeEnvironmentReport(cluster, uid string, now time.Time, slots, current int64) *unstructured.Unstructured {
	report := object(environmentReportGVK)
	report.SetName(cluster)
	report.SetUID(types.UID("environment-" + uid))
	report.SetGeneration(1)
	report.Object["spec"] = map[string]any{
		"managedClusterRef":                map[string]any{"name": cluster, "uid": uid, "generation": int64(1)},
		"observedManagedClusterGeneration": int64(1), "observedAt": now.Format(time.RFC3339), "region": "ap-beijing",
		"health":   map[string]any{"reachable": true, "apiReady": true, "cellControllerReady": true, "fdbOperatorReady": true},
		"capacity": map[string]any{"maxCells": int64(20), "currentCells": current, "provisioningCells": int64(0), "availableCellSlots": slots, "allocatableCellUnits": slots * 10, "maxConcurrentProvisioning": int64(2)},
	}
	return report
}

func fakeFDBOperatorReady(t *testing.T, ctx context.Context, kubeClient client.Client, cluster *unstructured.Unstructured) {
	t.Helper()
	cluster.Object["status"] = map[string]any{
		"generations":          map[string]any{"reconciled": cluster.GetGeneration()},
		"desiredProcessGroups": int64(9), "reconciledProcessGroups": int64(9),
		"runningVersion": "7.3.79", "configured": true,
		"connectionString": "actor:fake-cell-b@10.0.0.1:4500",
		"health":           map[string]any{"available": true, "healthy": true, "fullReplication": true},
	}
	if err := kubeClient.Status().Update(ctx, cluster); err != nil {
		t.Fatalf("publish fake FoundationDB Operator status: %v", err)
	}
}

func fakeCellAgentReport(t *testing.T, ctx context.Context, kubeClient client.Client, cell *unstructured.Unstructured, profileDigest string, now time.Time, evidence cellreporter.FDBCapacityEvidence) {
	t.Helper()
	report := object(reportGVK)
	report.SetName(cell.GetName())
	report.SetNamespace(cell.GetNamespace())
	report.Object["spec"] = map[string]any{
		"cellRef":                map[string]any{"name": cell.GetName(), "uid": string(cell.GetUID())},
		"observedCellGeneration": cell.GetGeneration(), "observedAt": now.Format(time.RFC3339),
		"profileDigest": profileDigest,
		"releaseDigest": testDigest,
		"foundationDB": map[string]any{
			"clusterIdentityHash": nestedString(cell.Object, "spec", "foundationDB", "clusterIdentityHash"),
			"available":           true, "healthy": true, "topologyConforming": true,
		},
		"health": map[string]any{
			"runtimeReadyHosts": int64(3), "backupReady": true,
			"credentialsReady": true, "correctnessViolation": false,
		},
		"capacity": map[string]any{
			"riskLevel": "Normal", "scaleOutEpoch": int64(0),
			"placementCount": int64(0), "pendingReservations": int64(0),
			"activeWriters": int64(0), "inFlightCommits": int64(0),
			"migrationBacklog": int64(0), "compactionBacklog": int64(0),
			"gcBacklog": int64(0), "reconciliationBacklog": int64(0),
			"fdbCapacityEvidenceReady": true, "fdbStorageHeadroomBytes": evidence.HeadroomBytes,
			"fdbStorageHeadroomETAKnown": evidence.ETAKnown, "fdbStorageHeadroomETASeconds": evidence.ETASeconds,
			"fdbStorageHeadroomSamples":  evidence.HeadroomSamples,
			"fdbWriteUtilizationPercent": evidence.WriteUtilizationPercent,
			"fdbDataMovementBytes":       evidence.DataMovementBytes,
		},
		"qualification": map[string]any{
			"ready": true, "receiptRef": "cos://fake-qualification/actor-bj-b01.json",
			"receiptDigest": testDigest, "releaseDigest": testDigest,
		},
	}
	if err := kubeClient.Create(ctx, report); err != nil {
		t.Fatalf("publish fake Cell Agent report: %v", err)
	}
}

func fakeCellAgentCapacityReport(t *testing.T, ctx context.Context, kubeClient client.Client, name, namespace string, now time.Time, evidence cellreporter.FDBCapacityEvidence) {
	t.Helper()
	report := getObject(t, ctx, kubeClient, reportGVK, name, namespace)
	if err := unstructured.SetNestedField(report.Object, now.Format(time.RFC3339), "spec", "observedAt"); err != nil {
		t.Fatal(err)
	}
	for field, value := range map[string]any{
		"fdbCapacityEvidenceReady":     true,
		"fdbStorageHeadroomBytes":      evidence.HeadroomBytes,
		"fdbLogicalBytes":              evidence.LogicalBytes,
		"fdbStorageHeadroomETAKnown":   evidence.ETAKnown,
		"fdbStorageHeadroomETASeconds": evidence.ETASeconds,
		"fdbStorageHeadroomSamples":    evidence.HeadroomSamples,
		"fdbWriteUtilizationPercent":   evidence.WriteUtilizationPercent,
		"fdbDataMovementBytes":         evidence.DataMovementBytes,
	} {
		if err := unstructured.SetNestedField(report.Object, value, "spec", "capacity", field); err != nil {
			t.Fatal(err)
		}
	}
	if err := kubeClient.Update(ctx, report); err != nil {
		t.Fatalf("refresh fake Cell capacity report: %v", err)
	}
}

type meshSharedPrometheus struct {
	*httptest.Server
	mu     sync.RWMutex
	values map[string]map[string]string
}

func newMeshSharedPrometheus(t *testing.T, values map[string]map[string]string) *meshSharedPrometheus {
	t.Helper()
	mesh := &meshSharedPrometheus{values: values}
	mesh.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		query := request.URL.Query().Get("query")
		metric, _, found := strings.Cut(query, "{")
		if !found {
			t.Errorf("MeshHarness Prometheus query has no Cell selector: %q", query)
			_, _ = w.Write([]byte(`{"status":"success","data":{"result":[]}}`))
			return
		}
		mesh.mu.RLock()
		defer mesh.mu.RUnlock()
		for cell, metrics := range mesh.values {
			if strings.Contains(query, `cell="`+cell+`"`) {
				value, ok := metrics[metric]
				if !ok {
					t.Errorf("MeshHarness Prometheus has no value for %s/%s", cell, metric)
					_, _ = w.Write([]byte(`{"status":"success","data":{"result":[]}}`))
					return
				}
				_, _ = fmt.Fprintf(w, `{"status":"success","data":{"result":[{"metric":{"cell":%q},"value":[%d,%q]}]}}`, cell, time.Now().Unix(), value)
				return
			}
		}
		t.Errorf("MeshHarness Prometheus query is not bound to a known Cell: %q", query)
		_, _ = w.Write([]byte(`{"status":"success","data":{"result":[]}}`))
	}))
	return mesh
}

func (m *meshSharedPrometheus) SetCell(cell string, values map[string]string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.values[cell] = values
}

func collectMeshCapacity(t *testing.T, ctx context.Context, prometheusURL, cell string) cellreporter.FDBCapacityEvidence {
	t.Helper()
	reporter := cellreporter.Reporter{Config: cellreporter.Config{CellName: cell, PrometheusURL: prometheusURL}}
	evidence, err := reporter.CollectFDBCapacity(ctx)
	if err != nil {
		t.Fatalf("collect shared Prometheus evidence for %s: %v", cell, err)
	}
	return evidence
}

func fakeTKECapacityReady(t *testing.T, ctx context.Context, kubeClient client.Client, machineSet *unstructured.Unstructured, count int64) {
	t.Helper()
	machineSet.Object["status"] = map[string]any{
		"replicas": count, "readyReplicas": count, "availableReplicas": count,
		"observedGeneration": machineSet.GetGeneration(),
	}
	if err := kubeClient.Update(ctx, machineSet); err != nil {
		t.Fatalf("publish fake TKE MachineSet status: %v", err)
	}
}

func fakeFDBOperatorProcessTarget(t *testing.T, ctx context.Context, kubeClient client.Client, cluster *unstructured.Unstructured, count int64) {
	t.Helper()
	cluster.Object["status"] = map[string]any{
		"generations":          map[string]any{"reconciled": cluster.GetGeneration()},
		"desiredProcessGroups": count, "reconciledProcessGroups": count,
		"runningVersion": "7.3.79", "configured": true,
		"connectionString": "actor:fake-cell-b@10.0.0.1:4500",
		"health":           map[string]any{"available": true, "healthy": true, "fullReplication": true},
	}
	if err := kubeClient.Status().Update(ctx, cluster); err != nil {
		t.Fatalf("publish fake FoundationDB process target: %v", err)
	}
}

func assertFDBDesiredProcesses(t *testing.T, ctx context.Context, kubeClient client.Client, name, namespace string, want int64) {
	t.Helper()
	cell := getObject(t, ctx, kubeClient, cellGVK, name, namespace)
	if got := nestedInt64(cell.Object, "status", "foundationDBAutoscaling", "desiredProcessCount"); got != want {
		t.Fatalf("Cell desired FDB processes = %d, want %d; autoscaling=%#v", got, want, nestedMap(cell.Object, "status", "foundationDBAutoscaling"))
	}
}

func onlyObject(t *testing.T, values []unstructured.Unstructured, kind string) *unstructured.Unstructured {
	t.Helper()
	if len(values) != 1 {
		t.Fatalf("got %d %s objects, want 1", len(values), kind)
	}
	return values[0].DeepCopy()
}

type reconciler interface {
	Reconcile(context.Context, ctrl.Request) (ctrl.Result, error)
}

func mustReconcile(t *testing.T, ctx context.Context, value reconciler, request ctrl.Request) {
	t.Helper()
	if _, err := value.Reconcile(ctx, request); err != nil {
		t.Fatalf("reconcile %T: %v", value, err)
	}
}

func addUnstructuredTypes(scheme *runtime.Scheme, gvks ...schema.GroupVersionKind) {
	for _, gvk := range gvks {
		scheme.AddKnownTypeWithName(gvk, &unstructured.Unstructured{})
		scheme.AddKnownTypeWithName(gvk.GroupVersion().WithKind(gvk.Kind+"List"), &unstructured.UnstructuredList{})
	}
}

func listObjects(t *testing.T, ctx context.Context, kubeClient client.Client, gvk schema.GroupVersionKind, namespace string) []unstructured.Unstructured {
	t.Helper()
	values := list(gvk)
	if err := kubeClient.List(ctx, values, client.InNamespace(namespace)); err != nil {
		t.Fatalf("list %s: %v", gvk.Kind, err)
	}
	return values.Items
}

func getObject(t *testing.T, ctx context.Context, kubeClient client.Client, gvk schema.GroupVersionKind, name, namespace string) *unstructured.Unstructured {
	t.Helper()
	value := object(gvk)
	if err := kubeClient.Get(ctx, types.NamespacedName{Name: name, Namespace: namespace}, value); err != nil {
		t.Fatalf("get %s %s/%s: %v", gvk.Kind, namespace, name, err)
	}
	return value
}

func claimStatusString(t *testing.T, ctx context.Context, kubeClient client.Client, name, namespace, field string) string {
	t.Helper()
	return nestedString(getObject(t, ctx, kubeClient, claimGVK, name, namespace).Object, "status", field)
}

func assertCellAdmission(t *testing.T, ctx context.Context, kubeClient client.Client, name, namespace string, want bool) {
	t.Helper()
	cell := getObject(t, ctx, kubeClient, cellGVK, name, namespace)
	if got := nestedBool(cell.Object, "status", "readyForPlacement"); got != want {
		t.Fatalf("Cell %s readyForPlacement = %v, want %v; status=%#v", name, got, want, cell.Object["status"])
	}
}

func nestedMap(value map[string]any, fields ...string) map[string]any {
	result, _, _ := unstructured.NestedMap(value, fields...)
	return result
}

var _ client.Client = (*fakeAPIServerClient)(nil)
