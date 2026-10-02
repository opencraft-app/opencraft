package fleetcontroller

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"time"

	"k8s.io/apimachinery/pkg/api/equality"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	clusterv1 "open-cluster-management.io/api/cluster/v1"
	workv1 "open-cluster-management.io/api/work/v1"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/handler"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	"github.com/rivet-dev/rivet/infra/cells/internal/meshharness"
)

const (
	claimNamespaceAnnotation = "fleet.actor.dev/claim-namespace"
	claimNameAnnotation      = "fleet.actor.dev/claim-name"
	claimUIDAnnotation       = "fleet.actor.dev/claim-uid"
	logicalCellUIDAnnotation = "fleet.actor.dev/logical-cell-uid"
	providerRefAnnotation    = "fleet.actor.dev/provider-ref"
)

type ClaimReconciler struct {
	Client               client.Client
	Now                  func() time.Time
	EnvironmentFreshness time.Duration
}

func (r *ClaimReconciler) Reconcile(ctx context.Context, request ctrl.Request) (ctrl.Result, error) {
	claim := object(claimGVK)
	if err := r.Client.Get(ctx, request.NamespacedName, claim); err != nil {
		return ctrl.Result{}, client.IgnoreNotFound(err)
	}
	if !claim.GetDeletionTimestamp().IsZero() {
		return ctrl.Result{}, nil
	}
	now := time.Now().UTC()
	if r.Now != nil {
		now = r.Now().UTC()
	}

	if nestedString(claim.Object, "status", "placementDecision", "targetClusterRef", "name") == "" {
		plan, err := r.planPlacement(ctx, claim, now)
		if err != nil {
			return ctrl.Result{}, err
		}
		if plan.Blocked {
			if err := r.setClaimCondition(ctx, claim, "PlacementReady", metav1.ConditionFalse, "NoEligibleEnvironment", plan.Reason, now); err != nil {
				return ctrl.Result{}, err
			}
			return ctrl.Result{RequeueAfter: 30 * time.Second}, nil
		}
		logicalName := deterministicCellName(claim)
		status := claimStatus(claim)
		status["phase"] = "Provisioning"
		status["placementDecision"] = map[string]any{
			"targetClusterRef":      map[string]any{"name": plan.TargetCluster, "uid": plan.TargetClusterUID, "generation": plan.TargetClusterGeneration},
			"environmentGeneration": plan.EnvironmentGeneration,
			"logicalCellName":       logicalName,
			"decidedAt":             now.Format(time.RFC3339),
		}
		setCondition(status, claim.GetGeneration(), now, "PlacementReady", metav1.ConditionTrue, "Selected", plan.Reason)
		return ctrl.Result{Requeue: true}, r.updateClaimStatus(ctx, claim, status)
	}

	targetCluster := nestedString(claim.Object, "status", "placementDecision", "targetClusterRef", "name")
	targetClusterUID := nestedString(claim.Object, "status", "placementDecision", "targetClusterRef", "uid")
	logicalName := nestedString(claim.Object, "status", "placementDecision", "logicalCellName")
	logicalCell, err := r.ensureLogicalCell(ctx, claim, logicalName, targetCluster)
	if err != nil {
		return ctrl.Result{}, err
	}
	if logicalCell.GetUID() == "" {
		return ctrl.Result{Requeue: true}, nil
	}

	observation := meshharness.ClaimObservation{
		Namespace: claim.GetNamespace(), Name: claim.GetName(), UID: string(claim.GetUID()),
		Phase: nestedString(claim.Object, "status", "phase"), ProviderRef: nestedString(claim.Object, "status", "providerRef"),
		BoundCellUID: nestedString(claim.Object, "status", "cellRef", "uid"), LogicalCellUID: string(logicalCell.GetUID()),
		SpokeCellUID:        nestedString(claim.Object, "status", "spokeCellRef", "uid"),
		SpokeCellGeneration: nestedInt64(claim.Object, "status", "spokeCellRef", "observedGeneration"),
		WorkUID:             nestedString(claim.Object, "status", "workRef", "uid"), TargetCluster: targetCluster,
		TargetClusterUID:        targetClusterUID,
		TargetClusterGeneration: nestedInt64(claim.Object, "status", "placementDecision", "targetClusterRef", "generation"),
		TargetCell:              logicalName,
	}
	workName := deterministicWorkName(logicalName, string(claim.GetUID()))
	work, workObservation, err := r.observeWork(ctx, claim, targetCluster, workName, logicalCell)
	if err != nil {
		return ctrl.Result{}, err
	}
	plan := meshharness.PlanClaim(observation, workObservation)
	if plan.Blocked {
		if err := r.setClaimCondition(ctx, claim, "ProviderReady", metav1.ConditionFalse, "IdentityConflict", plan.Reason, now); err != nil {
			return ctrl.Result{}, err
		}
		return ctrl.Result{}, nil
	}
	if observation.Phase == "Bound" && workObservation.Exists {
		if err := r.mirrorSpokeStatus(ctx, logicalCell, workObservation); err != nil {
			return ctrl.Result{}, err
		}
		// metadata.generation is a monotonic observation fence, not immutable
		// identity. Legitimate desired-state changes (for example Ready ->
		// Draining) advance it while preserving the exact spoke Cell UID. Persist
		// the high-water mark so delayed feedback from an older generation can no
		// longer cross the Bound Claim boundary.
		if workObservation.CellGeneration > observation.SpokeCellGeneration {
			status := claimStatus(claim)
			status["spokeCellRef"] = map[string]any{
				"name": logicalName, "uid": workObservation.CellUID, "observedGeneration": workObservation.CellGeneration,
			}
			setCondition(status, claim.GetGeneration(), now, "ProviderReady", metav1.ConditionTrue, "GenerationAdvanced", "accepted a newer generation of the same bound spoke Cell UID")
			return ctrl.Result{Requeue: true}, r.updateClaimStatus(ctx, claim, status)
		}
		logicalCell = object(cellGVK)
		if err := r.Client.Get(ctx, types.NamespacedName{Name: logicalName, Namespace: claim.GetNamespace()}, logicalCell); err != nil {
			return ctrl.Result{}, err
		}
		if work != nil {
			changed, err := r.reconcileWorkManifest(ctx, work, logicalCell)
			if err != nil {
				return ctrl.Result{}, err
			}
			if changed {
				return ctrl.Result{Requeue: true}, nil
			}
		}
	}
	if plan.PersistProviderRef {
		status := claimStatus(claim)
		status["providerRef"] = plan.ProviderRef
		status["logicalCellRef"] = map[string]any{"name": logicalName, "uid": string(logicalCell.GetUID())}
		setCondition(status, claim.GetGeneration(), now, "ProviderReady", metav1.ConditionFalse, "IdentityPersisted", plan.Reason)
		return ctrl.Result{Requeue: true}, r.updateClaimStatus(ctx, claim, status)
	}
	if plan.EnsureWork {
		if err := r.createWork(ctx, claim, logicalCell, targetCluster, targetClusterUID, workName, plan.ProviderRef); err != nil && !apierrors.IsAlreadyExists(err) {
			return ctrl.Result{}, err
		}
		return ctrl.Result{Requeue: true}, nil
	}
	if work != nil && nestedString(claim.Object, "status", "workRef", "uid") == "" {
		status := claimStatus(claim)
		status["workRef"] = map[string]any{"namespace": work.Namespace, "name": work.Name, "uid": string(work.UID)}
		return ctrl.Result{Requeue: true}, r.updateClaimStatus(ctx, claim, status)
	}
	if plan.BindClaim {
		if err := r.mirrorSpokeStatus(ctx, logicalCell, workObservation); err != nil {
			return ctrl.Result{}, err
		}
		status := claimStatus(claim)
		status["phase"] = "Bound"
		status["cellRef"] = map[string]any{"name": logicalName, "uid": plan.BoundCellUID}
		status["spokeCellRef"] = map[string]any{"name": logicalName, "uid": workObservation.CellUID, "observedGeneration": workObservation.CellGeneration}
		setCondition(status, claim.GetGeneration(), now, "ProviderReady", metav1.ConditionTrue, "Bound", plan.Reason)
		return ctrl.Result{}, r.updateClaimStatus(ctx, claim, status)
	}

	if nestedBool(logicalCell.Object, "status", "retirementProofVerified") {
		retirement := meshharness.PlanRetirement(true, work != nil)
		if retirement.DeleteWork {
			if err := r.Client.Delete(ctx, work); client.IgnoreNotFound(err) != nil {
				return ctrl.Result{}, err
			}
		}
	}
	return ctrl.Result{RequeueAfter: 30 * time.Second}, nil
}

func (r *ClaimReconciler) planPlacement(ctx context.Context, claim *unstructured.Unstructured, now time.Time) (meshharness.PlacementPlan, error) {
	managed := &clusterv1.ManagedClusterList{}
	if err := r.Client.List(ctx, managed); err != nil {
		return meshharness.PlacementPlan{}, fmt.Errorf("list ManagedClusters: %w", err)
	}
	managedByName := make(map[string]clusterv1.ManagedCluster, len(managed.Items))
	for i := range managed.Items {
		managedByName[managed.Items[i].Name] = managed.Items[i]
	}
	reports := list(environmentReportGVK)
	if err := r.Client.List(ctx, reports); err != nil {
		return meshharness.PlacementPlan{}, fmt.Errorf("list RivetEnvironmentReports: %w", err)
	}
	environments := make([]meshharness.EnvironmentObservation, 0, len(reports.Items))
	for i := range reports.Items {
		report := &reports.Items[i]
		cluster, found := managedByName[nestedString(report.Object, "spec", "managedClusterRef", "name")]
		if !found || string(cluster.UID) != nestedString(report.Object, "spec", "managedClusterRef", "uid") || cluster.Generation != nestedInt64(report.Object, "spec", "managedClusterRef", "generation") {
			continue
		}
		observedAt, _ := time.Parse(time.RFC3339, nestedString(report.Object, "spec", "observedAt"))
		environments = append(environments, meshharness.EnvironmentObservation{
			Name: cluster.Name, UID: string(cluster.UID), Generation: cluster.Generation,
			ObservedGeneration: nestedInt64(report.Object, "spec", "observedManagedClusterGeneration"), ObservedAt: observedAt,
			Region: nestedString(report.Object, "spec", "region"), Reachable: nestedBool(report.Object, "spec", "health", "reachable"),
			APIReady: nestedBool(report.Object, "spec", "health", "apiReady"), CellControllerReady: nestedBool(report.Object, "spec", "health", "cellControllerReady"),
			FDBOperatorReady: nestedBool(report.Object, "spec", "health", "fdbOperatorReady"), MaxCells: nestedInt64(report.Object, "spec", "capacity", "maxCells"),
			CurrentCells: nestedInt64(report.Object, "spec", "capacity", "currentCells"), ProvisioningCells: nestedInt64(report.Object, "spec", "capacity", "provisioningCells"),
			AvailableCellSlots: nestedInt64(report.Object, "spec", "capacity", "availableCellSlots"), AllocatableCellUnits: nestedInt64(report.Object, "spec", "capacity", "allocatableCellUnits"),
			MaxConcurrentProvisioning: nestedInt64(report.Object, "spec", "capacity", "maxConcurrentProvisioning"),
		})
	}
	return meshharness.PlanPlacement(
		nestedStringSlice(claim.Object, "spec", "managementClusters"), nestedString(claim.Object, "spec", "region"), now,
		r.EnvironmentFreshness, environments,
	), nil
}

func (r *ClaimReconciler) ensureLogicalCell(ctx context.Context, claim *unstructured.Unstructured, name, targetCluster string) (*unstructured.Unstructured, error) {
	cell := object(cellGVK)
	key := types.NamespacedName{Name: name, Namespace: claim.GetNamespace()}
	if err := r.Client.Get(ctx, key, cell); err == nil {
		if nestedString(cell.Object, "spec", "claimRef", "uid") != string(claim.GetUID()) || cell.GetAnnotations()["fleet.actor.dev/logical-cell"] != "true" {
			return nil, fmt.Errorf("logical Cell %s is owned by another Claim", key)
		}
		return cell, nil
	} else if !apierrors.IsNotFound(err) {
		return nil, err
	}
	cell.SetName(name)
	cell.SetNamespace(claim.GetNamespace())
	cell.SetLabels(map[string]string{PoolLabel: nestedString(claim.Object, "spec", "poolRef", "name"), "app.kubernetes.io/managed-by": "actor-fleet-controller"})
	cell.SetAnnotations(map[string]string{"fleet.actor.dev/logical-cell": "true", claimUIDAnnotation: string(claim.GetUID())})
	spec, err := r.cellSpecForClaim(ctx, claim, targetCluster, name)
	if err != nil {
		return nil, err
	}
	cell.Object["spec"] = spec
	cell.Object["status"] = map[string]any{}
	if err := r.Client.Create(ctx, cell); err != nil {
		return nil, err
	}
	return cell, nil
}

func (r *ClaimReconciler) cellSpecForClaim(ctx context.Context, claim *unstructured.Unstructured, targetCluster, name string) (map[string]any, error) {
	class := object(classGVK)
	if err := r.Client.Get(ctx, types.NamespacedName{Name: nestedString(claim.Object, "spec", "className")}, class); err != nil {
		return nil, fmt.Errorf("get Claim ShardClass: %w", err)
	}
	profile := object(profileGVK)
	if err := r.Client.Get(ctx, types.NamespacedName{Name: nestedString(class.Object, "spec", "profileRef", "name")}, profile); err != nil {
		return nil, fmt.Errorf("get Claim RivetCellProfile: %w", err)
	}
	coldBucket := nestedString(profile.Object, "spec", "cos", "coldBucket")
	backupBucket := nestedString(profile.Object, "spec", "cos", "backupBucket")
	if prefix := nestedString(profile.Object, "spec", "cos", "coldBucketPrefix"); prefix != "" {
		coldBucket = prefix + name
	}
	if prefix := nestedString(profile.Object, "spec", "cos", "backupBucketPrefix"); prefix != "" {
		backupBucket = prefix + name
	}
	return map[string]any{
		"cellId": name, "className": nestedString(claim.Object, "spec", "className"), "region": nestedString(claim.Object, "spec", "region"),
		"managementCluster": targetCluster, "claimRef": map[string]any{"name": claim.GetName(), "uid": string(claim.GetUID())}, "desiredState": "Ready",
		"foundationDB": map[string]any{"exclusive": true, "clusterRef": map[string]any{"name": name, "namespace": claim.GetNamespace()}},
		"cos":          map[string]any{"coldBucket": coldBucket, "backupBucket": backupBucket},
		"retirement":   map[string]any{"generation": int64(1), "requestId": "initial", "proofRequired": true, "rollbackRetentionSeconds": int64(604800)},
	}, nil
}

func (r *ClaimReconciler) observeWork(ctx context.Context, claim *unstructured.Unstructured, namespace, name string, logicalCell *unstructured.Unstructured) (*workv1.ManifestWork, meshharness.WorkObservation, error) {
	work := &workv1.ManifestWork{}
	err := r.Client.Get(ctx, types.NamespacedName{Name: name, Namespace: namespace}, work)
	if apierrors.IsNotFound(err) {
		return nil, meshharness.WorkObservation{}, nil
	}
	if err != nil {
		return nil, meshharness.WorkObservation{}, err
	}
	observation := meshharness.WorkObservation{
		Exists: true, UID: string(work.UID), ProviderRef: work.Annotations[providerRefAnnotation], ClaimUID: work.Annotations[claimUIDAnnotation],
		TargetClusterUID:        work.Annotations["fleet.actor.dev/target-cluster-uid"],
		TargetClusterGeneration: parseAnnotationInt64(work.Annotations["fleet.actor.dev/target-cluster-generation"]),
		CellName:                logicalCell.GetName(), LogicalCellUID: work.Annotations[logicalCellUIDAnnotation],
	}
	if len(work.Status.ResourceStatus.Manifests) != 1 {
		return work, observation, nil
	}
	manifest := work.Status.ResourceStatus.Manifests[0]
	if manifest.ResourceMeta.Group != Group || manifest.ResourceMeta.Kind != "RivetCell" || manifest.ResourceMeta.Name != logicalCell.GetName() {
		return work, observation, nil
	}
	observation.CellUID = feedbackString(manifest, "cellUID")
	observation.CellGeneration = feedbackInt(manifest, "cellGeneration")
	observation.Ready = feedbackBool(manifest, "readyForPlacement") && feedbackString(manifest, "phase") == "Ready"
	observation.Phase = feedbackString(manifest, "phase")
	observation.CapacityRisk = feedbackString(manifest, "capacityRisk")
	observation.ScaleOutEpoch = feedbackInt(manifest, "scaleOutEpoch")
	observation.PlacementCount = feedbackInt(manifest, "placementCount")
	observation.PendingReservations = feedbackInt(manifest, "pendingReservations")
	observation.ReportObservedAt = feedbackString(manifest, "reportObservedAt")
	observation.ScaleInEvidenceReady = feedbackBool(manifest, "scaleInEvidenceReady")
	observation.PlacementUtilizationPercent = feedbackInt(manifest, "placementUtilizationPercent")
	observation.RuntimeUtilizationPercent = feedbackInt(manifest, "runtimeUtilizationPercent")
	observation.FDBWriteUtilizationPercent = feedbackInt(manifest, "fdbWriteUtilizationPercent")
	observation.ActiveWriters = feedbackInt(manifest, "activeWriters")
	observation.InFlightCommits = feedbackInt(manifest, "inFlightCommits")
	observation.MigrationBacklog = feedbackInt(manifest, "migrationBacklog")
	observation.CompactionBacklog = feedbackInt(manifest, "compactionBacklog")
	observation.GCBacklog = feedbackInt(manifest, "gcBacklog")
	observation.ReconciliationBacklog = feedbackInt(manifest, "reconciliationBacklog")
	observation.RetirementProofVerified = feedbackBool(manifest, "retirementProofVerified")
	observation.RetirementProofReady = feedbackBool(manifest, "retirementProofReady")
	return work, observation, nil
}

func (r *ClaimReconciler) createWork(ctx context.Context, claim, logicalCell *unstructured.Unstructured, targetCluster, targetClusterUID, name, providerRef string) error {
	spoke := object(cellGVK)
	spoke.SetName(logicalCell.GetName())
	spoke.SetNamespace(logicalCell.GetNamespace())
	spoke.SetLabels(logicalCell.GetLabels())
	spoke.SetAnnotations(map[string]string{
		claimUIDAnnotation: string(claim.GetUID()), logicalCellUIDAnnotation: string(logicalCell.GetUID()), providerRefAnnotation: providerRef,
	})
	spoke.Object["spec"] = logicalCell.Object["spec"]
	raw, err := json.Marshal(spoke.Object)
	if err != nil {
		return err
	}
	work := &workv1.ManifestWork{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: targetCluster, Annotations: map[string]string{
			claimNamespaceAnnotation: claim.GetNamespace(), claimNameAnnotation: claim.GetName(), claimUIDAnnotation: string(claim.GetUID()),
			logicalCellUIDAnnotation: string(logicalCell.GetUID()), providerRefAnnotation: providerRef,
			"fleet.actor.dev/target-cluster-uid":        targetClusterUID,
			"fleet.actor.dev/target-cluster-generation": fmt.Sprintf("%d", nestedInt64(claim.Object, "status", "placementDecision", "targetClusterRef", "generation")),
		}},
		Spec: workv1.ManifestWorkSpec{
			Workload: workv1.ManifestsTemplate{Manifests: []workv1.Manifest{{RawExtension: runtime.RawExtension{Raw: raw}}}},
			ManifestConfigs: []workv1.ManifestConfigOption{{
				ResourceIdentifier: workv1.ResourceIdentifier{Group: Group, Resource: "rivetcells", Namespace: logicalCell.GetNamespace(), Name: logicalCell.GetName()},
				FeedbackRules:      []workv1.FeedbackRule{{Type: workv1.JSONPathsType, JsonPaths: cellFeedbackPaths()}},
				FeedbackScrapeType: workv1.FeedbackWatchType,
			}},
		},
	}
	return r.Client.Create(ctx, work)
}

func (r *ClaimReconciler) reconcileWorkManifest(ctx context.Context, work *workv1.ManifestWork, logicalCell *unstructured.Unstructured) (bool, error) {
	if len(work.Spec.Workload.Manifests) != 1 {
		return false, fmt.Errorf("ManifestWork %s/%s does not contain exactly one Cell", work.Namespace, work.Name)
	}
	var desired map[string]any
	if err := json.Unmarshal(work.Spec.Workload.Manifests[0].Raw, &desired); err != nil {
		return false, fmt.Errorf("decode ManifestWork Cell: %w", err)
	}
	desired["spec"] = logicalCell.Object["spec"]
	raw, err := json.Marshal(desired)
	if err != nil {
		return false, err
	}
	updated := work.DeepCopy()
	changed := false
	if string(raw) != string(work.Spec.Workload.Manifests[0].Raw) {
		updated.Spec.Workload.Manifests[0].Raw = raw
		changed = true
	}
	desiredConfig := workv1.ManifestConfigOption{
		ResourceIdentifier: workv1.ResourceIdentifier{Group: Group, Resource: "rivetcells", Namespace: logicalCell.GetNamespace(), Name: logicalCell.GetName()},
		FeedbackRules:      []workv1.FeedbackRule{{Type: workv1.JSONPathsType, JsonPaths: cellFeedbackPaths()}},
		FeedbackScrapeType: workv1.FeedbackWatchType,
	}
	if len(work.Spec.ManifestConfigs) != 1 || !equality.Semantic.DeepEqual(work.Spec.ManifestConfigs[0], desiredConfig) {
		updated.Spec.ManifestConfigs = []workv1.ManifestConfigOption{desiredConfig}
		changed = true
	}
	if !changed {
		return false, nil
	}
	if err := r.Client.Update(ctx, updated); err != nil {
		return false, err
	}
	return true, nil
}

func cellFeedbackPaths() []workv1.JsonPath {
	return []workv1.JsonPath{
		{Name: "cellUID", Path: ".metadata.uid"}, {Name: "cellGeneration", Path: ".metadata.generation"},
		{Name: "phase", Path: ".status.phase"}, {Name: "readyForPlacement", Path: ".status.readyForPlacement"},
		{Name: "capacityRisk", Path: ".status.capacityRisk"}, {Name: "scaleOutEpoch", Path: ".status.scaleOutEpoch"},
		{Name: "placementCount", Path: ".status.placementCount"}, {Name: "pendingReservations", Path: ".status.pendingReservations"},
		{Name: "reportObservedAt", Path: ".status.reportObservedAt"}, {Name: "scaleInEvidenceReady", Path: ".status.scaleInEvidenceReady"},
		{Name: "placementUtilizationPercent", Path: ".status.placementUtilizationPercent"}, {Name: "runtimeUtilizationPercent", Path: ".status.runtimeUtilizationPercent"},
		{Name: "fdbWriteUtilizationPercent", Path: ".status.fdbWriteUtilizationPercent"}, {Name: "activeWriters", Path: ".status.activeWriters"},
		{Name: "inFlightCommits", Path: ".status.inFlightCommits"}, {Name: "migrationBacklog", Path: ".status.migrationBacklog"},
		{Name: "compactionBacklog", Path: ".status.compactionBacklog"}, {Name: "gcBacklog", Path: ".status.gcBacklog"},
		{Name: "reconciliationBacklog", Path: ".status.reconciliationBacklog"},
		{Name: "retirementProofVerified", Path: ".status.retirementProofVerified"},
		{Name: "retirementProofReady", Path: ".status.retirementProofReady"},
	}
}

func (r *ClaimReconciler) mirrorSpokeStatus(ctx context.Context, cell *unstructured.Unstructured, observation meshharness.WorkObservation) error {
	desired := map[string]any{
		"observedGeneration": cell.GetGeneration(),
		"phase":              observation.Phase, "readyForPlacement": observation.Ready, "capacityRisk": observation.CapacityRisk,
		"scaleOutEpoch": observation.ScaleOutEpoch, "placementCount": observation.PlacementCount,
		"pendingReservations": observation.PendingReservations, "retirementProofVerified": observation.RetirementProofVerified,
		"retirementProofReady": observation.RetirementProofReady,
		"reportObservedAt":     observation.ReportObservedAt, "scaleInEvidenceReady": observation.ScaleInEvidenceReady,
		"placementUtilizationPercent": observation.PlacementUtilizationPercent, "runtimeUtilizationPercent": observation.RuntimeUtilizationPercent,
		"fdbWriteUtilizationPercent": observation.FDBWriteUtilizationPercent, "activeWriters": observation.ActiveWriters,
		"inFlightCommits": observation.InFlightCommits, "migrationBacklog": observation.MigrationBacklog,
		"compactionBacklog": observation.CompactionBacklog, "gcBacklog": observation.GCBacklog,
		"reconciliationBacklog": observation.ReconciliationBacklog,
		"spokeCellRef":          map[string]any{"uid": observation.CellUID, "observedGeneration": observation.CellGeneration},
	}
	current, _, _ := unstructured.NestedMap(cell.Object, "status")
	if equality.Semantic.DeepEqual(current, desired) {
		return nil
	}
	updated := cell.DeepCopy()
	updated.Object["status"] = desired
	return r.Client.Status().Update(ctx, updated)
}

func (r *ClaimReconciler) updateClaimStatus(ctx context.Context, claim *unstructured.Unstructured, status map[string]any) error {
	updated := claim.DeepCopy()
	updated.Object["status"] = status
	return r.Client.Status().Update(ctx, updated)
}

func (r *ClaimReconciler) setClaimCondition(ctx context.Context, claim *unstructured.Unstructured, typ string, value metav1.ConditionStatus, reason, message string, now time.Time) error {
	status := claimStatus(claim)
	setCondition(status, claim.GetGeneration(), now, typ, value, reason, message)
	return r.updateClaimStatus(ctx, claim, status)
}

func claimStatus(claim *unstructured.Unstructured) map[string]any {
	status, _, _ := unstructured.NestedMap(claim.Object, "status")
	if status == nil {
		status = map[string]any{}
	}
	return status
}

func setCondition(status map[string]any, generation int64, now time.Time, typ string, value metav1.ConditionStatus, reason, message string) {
	conditions, _, _ := unstructured.NestedSlice(status, "conditions")
	next := make([]any, 0, len(conditions)+1)
	for _, raw := range conditions {
		condition, ok := raw.(map[string]any)
		if !ok || condition["type"] == typ {
			continue
		}
		next = append(next, condition)
	}
	next = append(next, map[string]any{
		"type": typ, "status": string(value), "reason": reason, "message": message,
		"observedGeneration": generation, "lastTransitionTime": now.Format(time.RFC3339),
	})
	status["conditions"] = next
}

func deterministicCellName(claim *unstructured.Unstructured) string {
	uid := strings.Map(func(value rune) rune {
		if value >= 'a' && value <= 'z' || value >= '0' && value <= '9' {
			return value
		}
		if value >= 'A' && value <= 'Z' {
			return value + ('a' - 'A')
		}
		return -1
	}, string(claim.GetUID()))
	if len(uid) > 16 {
		uid = uid[:16]
	}
	if uid == "" {
		uid = "pending"
	}
	return "actor-" + uid + "-a01"
}

func deterministicWorkName(cellName, claimUID string) string {
	uid := strings.NewReplacer("/", "-", ":", "-", "_", "-").Replace(strings.ToLower(claimUID))
	if len(uid) > 12 {
		uid = uid[:12]
	}
	return trimDNSName(cellName+"-"+uid, 63)
}

func trimDNSName(value string, max int) string {
	value = strings.Trim(strings.ToLower(value), "-")
	if len(value) > max {
		value = strings.TrimRight(value[:max], "-")
	}
	return value
}

func feedbackString(manifest workv1.ManifestCondition, name string) string {
	for _, value := range manifest.StatusFeedbacks.Values {
		if value.Name == name && value.Value.String != nil {
			return *value.Value.String
		}
	}
	return ""
}

func feedbackInt(manifest workv1.ManifestCondition, name string) int64 {
	for _, value := range manifest.StatusFeedbacks.Values {
		if value.Name == name && value.Value.Integer != nil {
			return *value.Value.Integer
		}
	}
	return 0
}

func feedbackBool(manifest workv1.ManifestCondition, name string) bool {
	for _, value := range manifest.StatusFeedbacks.Values {
		if value.Name == name && value.Value.Boolean != nil {
			return *value.Value.Boolean
		}
	}
	return false
}

func parseAnnotationInt64(value string) int64 {
	parsed, _ := strconv.ParseInt(value, 10, 64)
	return parsed
}

func (r *ClaimReconciler) SetupWithManager(manager ctrl.Manager) error {
	mapWork := handler.EnqueueRequestsFromMapFunc(func(_ context.Context, object client.Object) []reconcile.Request {
		annotations := object.GetAnnotations()
		if annotations[claimNamespaceAnnotation] == "" || annotations[claimNameAnnotation] == "" {
			return nil
		}
		return []reconcile.Request{{NamespacedName: types.NamespacedName{Namespace: annotations[claimNamespaceAnnotation], Name: annotations[claimNameAnnotation]}}}
	})
	return ctrl.NewControllerManagedBy(manager).
		Named("rivetcellclaim-ocm").
		For(object(claimGVK)).
		Watches(&workv1.ManifestWork{}, mapWork).
		Complete(r)
}
