package fleetcontroller

import (
	"context"
	"testing"
	"time"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/types"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
)

func TestMeshHarnessCellGenerationAndRetirementLifecycle(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	now := time.Date(2026, 8, 21, 12, 0, 0, 0, time.UTC)
	profile, class, cell, cluster, report := lifecycleObjects(t, now)

	// Delayed feedback from the previous same-name Cell must not qualify the
	// replacement generation.
	if err := unstructured.SetNestedField(report.Object, "old-cell-uid", "spec", "cellRef", "uid"); err != nil {
		t.Fatal(err)
	}
	scheme := operatorTestScheme()
	kubeClient := fake.NewClientBuilder().
		WithScheme(scheme).
		WithStatusSubresource(object(cellGVK), object(fdbClusterGVK)).
		WithObjects(profile, class, cell, cluster, report).
		Build()
	reconciler := CellReconciler{Client: kubeClient, Now: func() time.Time { return now }, ReportFreshness: 2 * time.Minute, WatchFDBClusters: true}
	request := ctrl.Request{NamespacedName: types.NamespacedName{Name: cell.GetName(), Namespace: cell.GetNamespace()}}
	mustReconcile(t, ctx, &reconciler, request)
	mustReconcile(t, ctx, &reconciler, request)
	updated := getObject(t, ctx, kubeClient, cellGVK, cell.GetName(), cell.GetNamespace())
	if nestedBool(updated.Object, "status", "readyForPlacement") {
		t.Fatal("old-generation Cell report reopened placement")
	}
	if got := findCondition(t, nestedConditions(updated.Object, "status", "conditions"), "ReportFresh").Reason; got != "CellReferenceMismatch" {
		t.Fatalf("stale report reason = %q, want CellReferenceMismatch", got)
	}

	report = getObject(t, ctx, kubeClient, reportGVK, report.GetName(), report.GetNamespace())
	if err := unstructured.SetNestedField(report.Object, string(cell.GetUID()), "spec", "cellRef", "uid"); err != nil {
		t.Fatal(err)
	}
	if err := kubeClient.Update(ctx, report); err != nil {
		t.Fatal(err)
	}
	mustReconcile(t, ctx, &reconciler, request)
	updated = getObject(t, ctx, kubeClient, cellGVK, cell.GetName(), cell.GetNamespace())
	if !nestedBool(updated.Object, "status", "readyForPlacement") {
		t.Fatalf("matching generation did not qualify: %#v", nestedMap(updated.Object, "status"))
	}

	// Retirement removes only the Cell protection boundary. The database has no
	// Cell ownerReference and must remain for its independent quarantine/GC flow.
	if err := unstructured.SetNestedField(updated.Object, "Retired", "spec", "desiredState"); err != nil {
		t.Fatal(err)
	}
	if err := kubeClient.Update(ctx, updated); err != nil {
		t.Fatal(err)
	}
	if err := kubeClient.Delete(ctx, updated); err != nil {
		t.Fatal(err)
	}
	report = getObject(t, ctx, kubeClient, reportGVK, report.GetName(), report.GetNamespace())
	if err := unstructured.SetNestedMap(report.Object, map[string]any{
		"generation": int64(1), "exactColdReachable": true, "exactBackupReachable": true,
		"oldGenerationRejected": true, "rollbackRetentionExpired": true, "artifactsEnumerated": true,
		"fullySettled": true, "crossCellRestoreVerified": true,
		"coldManifestRef": "cos://cold/manifests/cell-new.json", "coldManifestDigest": testDigest,
		"receiptRef": "cos://retirement/cell-new.json", "receiptDigest": testDigest,
	}, "spec", "retirement"); err != nil {
		t.Fatal(err)
	}
	if err := kubeClient.Update(ctx, report); err != nil {
		t.Fatal(err)
	}
	mustReconcile(t, ctx, &reconciler, request)
	mustReconcile(t, ctx, &reconciler, request)
	deletedCell := object(cellGVK)
	if err := kubeClient.Get(ctx, request.NamespacedName, deletedCell); !apierrors.IsNotFound(err) {
		t.Fatalf("retired Cell remains after proof and finalizer release: %v", err)
	}
	retained := getObject(t, ctx, kubeClient, fdbClusterGVK, cluster.GetName(), cluster.GetNamespace())
	if len(retained.GetOwnerReferences()) != 0 {
		t.Fatalf("durable FDBCluster gained a Cell ownerReference: %#v", retained.GetOwnerReferences())
	}
}

func lifecycleObjects(t *testing.T, now time.Time) (*unstructured.Unstructured, *unstructured.Unstructured, *unstructured.Unstructured, *unstructured.Unstructured, *unstructured.Unstructured) {
	t.Helper()
	cell, profile := operatorTestObjects("Required")
	cell.SetName("actor-bj-new")
	cell.SetNamespace("actor-fdb-cell-system")
	cell.SetUID(types.UID("new-cell-uid"))
	cell.SetGeneration(1)
	cell.SetLabels(map[string]string{PoolLabel: "actor-beijing"})
	profile.SetName("lifecycle-profile")
	profile.Object["spec"].(map[string]any)["availabilityMode"] = "production-multi-zone"
	profile.Object["spec"].(map[string]any)["region"] = "ap-beijing"
	profile.Object["spec"].(map[string]any)["runtime"] = map[string]any{"minWorkerdHosts": int64(3)}
	profile.Object["spec"].(map[string]any)["cos"] = map[string]any{
		"coldBucketPrefix": "fake-cold-", "backupBucketPrefix": "fake-backup-",
	}
	profileDigest := digestSpec(profile)
	class := object(classGVK)
	class.SetName("lifecycle-class")
	class.Object["spec"] = map[string]any{
		"controllerName": ControllerName, "profileRef": map[string]any{"name": profile.GetName(), "digest": profileDigest},
	}
	connection := "lifecycle:identity@10.0.0.20:4500"
	clusterUID := "lifecycle-fdb-uid"
	identity := databaseIdentityHash(clusterUID, connection)
	cell.Object["spec"] = map[string]any{
		"className": class.GetName(), "region": "ap-beijing", "managementCluster": "tke-b", "desiredState": "Ready",
		"foundationDB": map[string]any{
			"exclusive": true, "clusterIdentityHash": identity,
			"clusterRef": map[string]any{"name": cell.GetName(), "namespace": cell.GetNamespace(), "uid": clusterUID},
		},
		"cos":        map[string]any{"coldBucket": "fake-cold-new", "backupBucket": "fake-backup-new"},
		"retirement": map[string]any{"generation": int64(1), "proofRequired": true, "rollbackRetentionSeconds": int64(604800)},
	}
	cell.Object["status"] = map[string]any{}
	cluster, err := foundationDBClusterForCell(cell, profile, profileDigest)
	if err != nil {
		t.Fatal(err)
	}
	cluster.SetUID(types.UID(clusterUID))
	cluster.SetGeneration(1)
	cluster.Object["status"] = map[string]any{
		"generations":          map[string]any{"reconciled": int64(1)},
		"desiredProcessGroups": int64(9), "reconciledProcessGroups": int64(9),
		"runningVersion": "7.3.79", "configured": true, "connectionString": connection,
		"health": map[string]any{"available": true, "healthy": true, "fullReplication": true},
	}
	report := object(reportGVK)
	report.SetName(cell.GetName())
	report.SetNamespace(cell.GetNamespace())
	report.Object["spec"] = map[string]any{
		"cellRef":                map[string]any{"name": cell.GetName(), "uid": string(cell.GetUID())},
		"observedCellGeneration": int64(1), "observedAt": now.Format(time.RFC3339), "profileDigest": profileDigest,
		"foundationDB": map[string]any{"clusterIdentityHash": identity, "available": true, "healthy": true, "topologyConforming": true},
		"health":       map[string]any{"runtimeReadyHosts": int64(3), "backupReady": true, "credentialsReady": true, "correctnessViolation": false},
		"capacity": map[string]any{
			"riskLevel": "Emergency", "scaleOutEpoch": int64(999), "placementCount": int64(0), "pendingReservations": int64(0),
			"activeWriters": int64(0), "inFlightCommits": int64(0), "migrationBacklog": int64(0), "compactionBacklog": int64(0),
			"gcBacklog": int64(0), "reconciliationBacklog": int64(0), "fdbCapacityEvidenceReady": true,
			"fdbStorageHeadroomBytes": int64(192 << 30), "fdbStorageHeadroomSamples": int64(1200),
			"fdbWriteUtilizationPercent": int64(10), "fdbDataMovementBytes": int64(0),
		},
		"releaseDigest": testDigest,
		"qualification": map[string]any{"ready": true, "receiptRef": "cos://qualification/new.json", "receiptDigest": testDigest, "releaseDigest": testDigest},
	}
	return profile, class, cell, cluster, report
}
