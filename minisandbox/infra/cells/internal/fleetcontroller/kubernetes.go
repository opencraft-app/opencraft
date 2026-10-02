package fleetcontroller

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strconv"
	"strings"
	"time"

	"k8s.io/apimachinery/pkg/api/equality"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/handler"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"
)

var (
	cellGVK              = schema.GroupVersionKind{Group: Group, Version: Version, Kind: "RivetCell"}
	reportGVK            = schema.GroupVersionKind{Group: Group, Version: Version, Kind: "RivetCellReport"}
	poolGVK              = schema.GroupVersionKind{Group: Group, Version: Version, Kind: "ShardPool"}
	claimGVK             = schema.GroupVersionKind{Group: Group, Version: Version, Kind: "RivetCellClaim"}
	registrationGVK      = schema.GroupVersionKind{Group: Group, Version: Version, Kind: "RivetCellRegistration"}
	environmentReportGVK = schema.GroupVersionKind{Group: Group, Version: Version, Kind: "RivetEnvironmentReport"}
	classGVK             = schema.GroupVersionKind{Group: Group, Version: Version, Kind: "ShardClass"}
	profileGVK           = schema.GroupVersionKind{Group: Group, Version: Version, Kind: "RivetCellProfile"}
)

type CellReconciler struct {
	Client              client.Client
	ReportFreshness     time.Duration
	Now                 func() time.Time
	WatchFDBClusters    bool
	ProcessLogicalCells bool
}

func (r *CellReconciler) Reconcile(ctx context.Context, request ctrl.Request) (ctrl.Result, error) {
	cell := object(cellGVK)
	if err := r.Client.Get(ctx, request.NamespacedName, cell); err != nil {
		return ctrl.Result{}, client.IgnoreNotFound(err)
	}
	if cell.GetAnnotations()["fleet.actor.dev/logical-cell"] == "true" && !r.ProcessLogicalCells {
		return ctrl.Result{}, nil
	}

	in, managed, err := r.cellInput(ctx, cell)
	if err != nil {
		return ctrl.Result{}, err
	}
	if !managed {
		return ctrl.Result{}, nil
	}

	if cell.GetDeletionTimestamp().IsZero() && !slices.Contains(cell.GetFinalizers(), RetirementFinalizer) {
		before := cell.DeepCopy()
		cell.SetFinalizers(append(cell.GetFinalizers(), RetirementFinalizer))
		if err := r.Client.Patch(ctx, cell, client.MergeFrom(before)); err != nil {
			return ctrl.Result{}, err
		}
		return ctrl.Result{Requeue: true}, nil
	}

	plan := PlanCell(in)
	changed, err := updateStatus(ctx, r.Client, cell, plan.Status)
	if err != nil {
		return ctrl.Result{}, err
	}
	if changed {
		return ctrl.Result{RequeueAfter: boundedRequeue(plan.RequeueAfter)}, nil
	}

	if !cell.GetDeletionTimestamp().IsZero() && slices.Contains(cell.GetFinalizers(), RetirementFinalizer) {
		if !plan.RemoveFinalizer {
			return ctrl.Result{RequeueAfter: boundedRequeue(plan.RequeueAfter)}, nil
		}
		before := cell.DeepCopy()
		cell.SetFinalizers(removeString(cell.GetFinalizers(), RetirementFinalizer))
		if err := r.Client.Patch(ctx, cell, client.MergeFrom(before)); err != nil {
			return ctrl.Result{}, err
		}
		return ctrl.Result{}, nil
	}

	return ctrl.Result{RequeueAfter: boundedRequeue(plan.RequeueAfter)}, nil
}

func (r *CellReconciler) SetupWithManager(manager ctrl.Manager) error {
	builder := ctrl.NewControllerManagedBy(manager).
		Named("rivetcell").
		For(object(cellGVK)).
		Watches(object(reportGVK), handler.EnqueueRequestsFromMapFunc(func(_ context.Context, report client.Object) []reconcile.Request {
			return []reconcile.Request{{NamespacedName: types.NamespacedName{Name: report.GetName(), Namespace: report.GetNamespace()}}}
		}))
	if r.WatchFDBClusters {
		builder = builder.Watches(object(fdbClusterGVK), handler.EnqueueRequestsFromMapFunc(func(_ context.Context, cluster client.Object) []reconcile.Request {
			name := cluster.GetLabels()[FDBCellNameLabel]
			namespace := cluster.GetLabels()[FDBCellNamespaceLabel]
			if name == "" || namespace == "" {
				return nil
			}
			return []reconcile.Request{{NamespacedName: types.NamespacedName{Name: name, Namespace: namespace}}}
		}))
	}
	return builder.Complete(r)
}

func (r *CellReconciler) cellInput(ctx context.Context, cell *unstructured.Unstructured) (CellInput, bool, error) {
	className, _, _ := unstructured.NestedString(cell.Object, "spec", "className")
	class := object(classGVK)
	if err := r.Client.Get(ctx, types.NamespacedName{Name: className}, class); err != nil {
		return CellInput{}, false, fmt.Errorf("get ShardClass %q: %w", className, err)
	}
	controllerName, _, _ := unstructured.NestedString(class.Object, "spec", "controllerName")
	if controllerName != ControllerName {
		return CellInput{}, false, nil
	}

	profileName, _, _ := unstructured.NestedString(class.Object, "spec", "profileRef", "name")
	profileDigest, _, _ := unstructured.NestedString(class.Object, "spec", "profileRef", "digest")
	profile := object(profileGVK)
	if err := r.Client.Get(ctx, types.NamespacedName{Name: profileName}, profile); err != nil {
		return CellInput{}, false, fmt.Errorf("get RivetCellProfile %q: %w", profileName, err)
	}

	now := time.Now().UTC()
	if r.Now != nil {
		now = r.Now().UTC()
	}
	freshness := r.ReportFreshness
	if freshness <= 0 {
		freshness = DefaultReportFreshness
	}
	in := CellInput{
		Name:                  cell.GetName(),
		UID:                   string(cell.GetUID()),
		Generation:            cell.GetGeneration(),
		DesiredState:          nestedString(cell.Object, "spec", "desiredState"),
		RetirementGeneration:  nestedInt64(cell.Object, "spec", "retirement", "generation"),
		ClusterIdentityHash:   nestedString(cell.Object, "spec", "foundationDB", "clusterIdentityHash"),
		ProfileDigest:         profileDigest,
		ProfileSpecDigest:     digestSpec(profile),
		ProfileConforming:     profileConforming(cell, profile),
		ProductionEligible:    nestedString(profile.Object, "spec", "availabilityMode") == "production-multi-zone",
		MinRuntimeReadyHosts:  nestedInt64(profile.Object, "spec", "runtime", "minWorkerdHosts"),
		TopologyConforming:    topologyConforming(cell, profile),
		ExistingConditions:    nestedConditions(cell.Object, "status", "conditions"),
		Now:                   now,
		ReportFreshness:       freshness,
		CapacityPolicy:        cellCapacityPolicy(profile),
		ExistingCapacityRisk:  nestedString(cell.Object, "status", "capacityRisk"),
		ExistingScaleOutEpoch: nestedInt64(cell.Object, "status", "scaleOutEpoch"),
		FDBAutoscalingPolicy:  fdbAutoscalingPolicy(profile),
		FDBAutoscalingStatus:  fdbAutoscalingStatus(cell),
		InitialFDBProcesses:   nestedInt64(profile.Object, "spec", "foundationDB", "processCount"),
	}
	if err := observeFDBKubernetesCluster(ctx, r.Client, &in, cell, profile); err != nil {
		return CellInput{}, false, err
	}

	report := object(reportGVK)
	if err := r.Client.Get(ctx, types.NamespacedName{Name: cell.GetName(), Namespace: cell.GetNamespace()}, report); err != nil {
		if !apierrors.IsNotFound(err) {
			return CellInput{}, false, fmt.Errorf("get RivetCellReport: %w", err)
		}
	} else {
		in.Report = parseReport(report)
	}
	return in, true, nil
}

func cellCapacityPolicy(profile *unstructured.Unstructured) CellCapacityPolicy {
	return CellCapacityPolicy{
		HealthyWriteUtilizationLimitPct:  nestedInt64(profile.Object, "spec", "capacity", "healthyWriteUtilizationLimitPercent"),
		DegradedWriteUtilizationLimitPct: nestedInt64(profile.Object, "spec", "capacity", "degradedWriteUtilizationLimitPercent"),
		ScaleOutAtPct:                    nestedInt64(profile.Object, "spec", "capacity", "scaleOutAtPercent"),
		FDBLogicalSoftBytes:              nestedInt64(profile.Object, "spec", "gasolineRetention", "fdbLogicalSoftBytes"),
		FDBLogicalHardBytes:              nestedInt64(profile.Object, "spec", "gasolineRetention", "fdbLogicalHardBytes"),
	}
}

type PoolReconciler struct {
	Client client.Client
	// Reader bypasses the controller-runtime cache for inventory that allocates
	// provisioning credits. A cached List can briefly miss the Claim created by
	// the previous reconcile and oversubscribe the Pool limit.
	Reader                client.Reader
	MaxClaimsPerReconcile int64
	PeriodicRequeue       time.Duration
	ReportFreshness       time.Duration
	Now                   func() time.Time
}

func (r *PoolReconciler) Reconcile(ctx context.Context, request ctrl.Request) (ctrl.Result, error) {
	pool := object(poolGVK)
	if err := r.Client.Get(ctx, request.NamespacedName, pool); err != nil {
		return ctrl.Result{}, client.IgnoreNotFound(err)
	}

	in, managed, err := r.poolInput(ctx, pool)
	if err != nil {
		return ctrl.Result{}, err
	}
	if !managed {
		return ctrl.Result{}, nil
	}
	plan := PlanPool(in)
	changed, err := updateStatus(ctx, r.Client, pool, plan.Status)
	if err != nil {
		return ctrl.Result{}, err
	}
	if changed {
		return ctrl.Result{Requeue: true}, nil
	}
	if plan.ScaleInRequest != nil {
		if err := r.beginCellDrain(ctx, pool, *plan.ScaleInRequest); err != nil {
			return ctrl.Result{}, err
		}
		return ctrl.Result{Requeue: true}, nil
	}

	claimsToMake := int64(len(plan.ClaimRequests))
	limit := r.MaxClaimsPerReconcile
	if limit <= 0 {
		limit = 1
	}
	if claimsToMake > limit {
		claimsToMake = limit
	}
	for i := int64(0); i < claimsToMake; i++ {
		if err := r.createClaim(ctx, pool, plan.ClaimRequests[i]); err != nil {
			return ctrl.Result{}, err
		}
	}

	requeue := r.PeriodicRequeue
	if requeue <= 0 {
		requeue = 30 * time.Second
	}
	return ctrl.Result{RequeueAfter: requeue}, nil
}

func scaleInPolicy(pool *unstructured.Unstructured) ScaleInPolicy {
	mode := nestedString(pool.Object, "spec", "scaleIn", "mode")
	if mode == "" {
		mode = "Automatic"
	}
	value := func(field string, fallback int64) int64 {
		got := nestedInt64(pool.Object, "spec", "scaleIn", field)
		if got == 0 {
			return fallback
		}
		return got
	}
	return ScaleInPolicy{
		Mode: mode, EnterPercent: value("enterUtilizationPercent", 25), ExitPercent: value("exitUtilizationPercent", 40),
		Observation:   time.Duration(value("observationSeconds", 604800)) * time.Second,
		MaxConcurrent: value("maxConcurrentRetirements", 1), ReportFreshness: DefaultReportFreshness,
	}
}

func (r *PoolReconciler) beginCellDrain(ctx context.Context, pool *unstructured.Unstructured, request ScaleInRequest) error {
	cell := object(cellGVK)
	key := types.NamespacedName{Name: request.CellName, Namespace: pool.GetNamespace()}
	if err := r.Client.Get(ctx, key, cell); err != nil {
		return err
	}
	if string(cell.GetUID()) != request.CellUID {
		return fmt.Errorf("scale-in target %s UID changed", key)
	}
	existingRequest := nestedString(cell.Object, "spec", "retirement", "requestId")
	desiredState := request.DesiredState
	if desiredState == "" {
		desiredState = "Draining"
	}
	if nestedString(cell.Object, "spec", "desiredState") == desiredState && existingRequest == request.RequestID {
		return nil
	}
	if existingRequest != "" && existingRequest != "initial" && existingRequest != request.RequestID {
		return fmt.Errorf("Cell %s already has retirement request %q", key, existingRequest)
	}
	updated := cell.DeepCopy()
	if desiredState == "Retired" {
		if nestedString(cell.Object, "spec", "desiredState") != "Draining" || existingRequest != request.RequestID || !nestedBool(cell.Object, "status", "retirementProofReady") {
			return fmt.Errorf("Cell %s is not ready to cross the Retired generation boundary", key)
		}
		if err := unstructured.SetNestedField(updated.Object, "Retired", "spec", "desiredState"); err != nil {
			return err
		}
		return r.Client.Update(ctx, updated)
	}
	if err := unstructured.SetNestedField(updated.Object, "Draining", "spec", "desiredState"); err != nil {
		return err
	}
	if err := unstructured.SetNestedField(updated.Object, request.RequestID, "spec", "retirement", "requestId"); err != nil {
		return err
	}
	generation := nestedInt64(cell.Object, "spec", "retirement", "generation")
	if generation < 1 {
		generation = 1
	}
	if err := unstructured.SetNestedField(updated.Object, generation+1, "spec", "retirement", "generation"); err != nil {
		return err
	}
	return r.Client.Update(ctx, updated)
}

func (r *PoolReconciler) SetupWithManager(manager ctrl.Manager) error {
	mapMember := func(_ context.Context, member client.Object) []reconcile.Request {
		poolName := member.GetLabels()[PoolLabel]
		if poolName == "" {
			return nil
		}
		return []reconcile.Request{{NamespacedName: types.NamespacedName{Name: poolName, Namespace: member.GetNamespace()}}}
	}
	return ctrl.NewControllerManagedBy(manager).
		Named("shardpool").
		For(object(poolGVK)).
		Watches(object(cellGVK), handler.EnqueueRequestsFromMapFunc(mapMember)).
		Watches(object(claimGVK), handler.EnqueueRequestsFromMapFunc(mapMember)).
		Complete(r)
}

func (r *PoolReconciler) poolInput(ctx context.Context, pool *unstructured.Unstructured) (PoolInput, bool, error) {
	reader := r.Reader
	if reader == nil {
		reader = r.Client
	}
	className := nestedString(pool.Object, "spec", "className")
	class := object(classGVK)
	if err := r.Client.Get(ctx, types.NamespacedName{Name: className}, class); err != nil {
		return PoolInput{}, false, fmt.Errorf("get ShardClass %q: %w", className, err)
	}
	controllerName := nestedString(class.Object, "spec", "controllerName")
	if controllerName != ControllerName {
		return PoolInput{}, false, nil
	}

	now := time.Now().UTC()
	if r.Now != nil {
		now = r.Now().UTC()
	}
	in := PoolInput{
		UID:                           string(pool.GetUID()),
		Generation:                    pool.GetGeneration(),
		MinCells:                      nestedInt64(pool.Object, "spec", "minCells"),
		MaxCells:                      nestedInt64(pool.Object, "spec", "maxCells"),
		MaxConcurrentCellProvisioning: nestedInt64(pool.Object, "spec", "maxConcurrentCellProvisioning"),
		ClassName:                     className,
		Region:                        nestedString(pool.Object, "spec", "placement", "region"),
		ManagementClusters:            nestedStringSlice(pool.Object, "spec", "placement", "managementClusters"),
		ExistingConditions:            nestedConditions(pool.Object, "status", "conditions"),
		Now:                           now,
		ReportFreshness:               r.ReportFreshness,
		ScaleInPolicy:                 scaleInPolicy(pool),
	}
	if candidate, found, _ := unstructured.NestedMap(pool.Object, "status", "scaleInCandidate"); found {
		observedSince, _ := time.Parse(time.RFC3339, nestedString(candidate, "observedSince"))
		in.ExistingScaleInCandidate = &ScaleInCandidate{
			CellName: nestedString(candidate, "cellName"), CellUID: nestedString(candidate, "cellUID"),
			RequestID: nestedString(candidate, "requestId"), ObservedSince: metav1.NewTime(observedSince),
			CompositeLoadPct: nestedInt64(candidate, "compositeLoadPercent"),
		}
	}

	cells := list(cellGVK)
	if err := reader.List(ctx, cells, client.InNamespace(pool.GetNamespace()), client.MatchingLabels{PoolLabel: pool.GetName()}); err != nil {
		return PoolInput{}, false, fmt.Errorf("list RivetCells: %w", err)
	}
	for i := range cells.Items {
		cell := &cells.Items[i]
		reportObservedAt, _ := time.Parse(time.RFC3339, nestedString(cell.Object, "status", "reportObservedAt"))
		in.Cells = append(in.Cells, PoolCell{
			Name:                        cell.GetName(),
			UID:                         string(cell.GetUID()),
			ClaimName:                   nestedString(cell.Object, "spec", "claimRef", "name"),
			ClaimUID:                    nestedString(cell.Object, "spec", "claimRef", "uid"),
			ClassName:                   nestedString(cell.Object, "spec", "className"),
			Region:                      nestedString(cell.Object, "spec", "region"),
			ManagementCluster:           nestedString(cell.Object, "spec", "managementCluster"),
			Phase:                       nestedString(cell.Object, "status", "phase"),
			ReadyForPlacement:           nestedBool(cell.Object, "status", "readyForPlacement"),
			CapacityRisk:                nestedString(cell.Object, "status", "capacityRisk"),
			ScaleOutEpoch:               nestedInt64(cell.Object, "status", "scaleOutEpoch"),
			PlacementCount:              nestedInt64(cell.Object, "status", "placementCount"),
			PendingReservations:         nestedInt64(cell.Object, "status", "pendingReservations"),
			ReportObservedAt:            reportObservedAt,
			ScaleInEvidenceReady:        nestedBool(cell.Object, "status", "scaleInEvidenceReady"),
			PlacementUtilizationPercent: nestedInt64(cell.Object, "status", "placementUtilizationPercent"),
			RuntimeUtilizationPercent:   nestedInt64(cell.Object, "status", "runtimeUtilizationPercent"),
			FDBWriteUtilizationPercent:  nestedInt64(cell.Object, "status", "fdbWriteUtilizationPercent"),
			ActiveWriters:               nestedInt64(cell.Object, "status", "activeWriters"), InFlightCommits: nestedInt64(cell.Object, "status", "inFlightCommits"),
			MigrationBacklog: nestedInt64(cell.Object, "status", "migrationBacklog"), CompactionBacklog: nestedInt64(cell.Object, "status", "compactionBacklog"),
			GCBacklog: nestedInt64(cell.Object, "status", "gcBacklog"), ReconciliationBacklog: nestedInt64(cell.Object, "status", "reconciliationBacklog"),
			RetirementProofVerified: nestedBool(cell.Object, "status", "retirementProofVerified"),
			RetirementProofReady:    nestedBool(cell.Object, "status", "retirementProofReady"),
			RetirementRequestID:     nestedString(cell.Object, "spec", "retirement", "requestId"),
		})
	}

	claims := list(claimGVK)
	if err := reader.List(ctx, claims, client.InNamespace(pool.GetNamespace()), client.MatchingLabels{PoolLabel: pool.GetName()}); err != nil {
		return PoolInput{}, false, fmt.Errorf("list RivetCellClaims: %w", err)
	}
	for i := range claims.Items {
		claim := &claims.Items[i]
		if nestedString(claim.Object, "spec", "poolRef", "uid") != string(pool.GetUID()) {
			continue
		}
		triggerKey := pressureTriggerKey(
			nestedString(claim.Object, "spec", "trigger", "cellRef", "uid"),
			nestedInt64(claim.Object, "spec", "trigger", "scaleOutEpoch"),
		)
		in.Claims = append(in.Claims, PoolClaim{Name: claim.GetName(), UID: string(claim.GetUID()), Phase: nestedString(claim.Object, "status", "phase"), TriggerKey: triggerKey})
	}
	return in, true, nil
}

func (r *PoolReconciler) createClaim(ctx context.Context, pool *unstructured.Unstructured, request ClaimRequest) error {
	if request.RequestID == "" {
		return fmt.Errorf("create RivetCellClaim: empty deterministic request ID")
	}
	digest := sha256.Sum256([]byte(string(pool.GetUID()) + "/" + request.RequestID))
	name := "cellclaim-" + hex.EncodeToString(digest[:10])
	claim := object(claimGVK)
	claim.SetNamespace(pool.GetNamespace())
	claim.SetName(name)
	claim.SetLabels(map[string]string{
		PoolLabel:                      pool.GetName(),
		"app.kubernetes.io/managed-by": "actor-fleet-controller",
		"fleet.actor.dev/pool-uid":     string(pool.GetUID()),
	})
	claim.SetAnnotations(map[string]string{"fleet.actor.dev/request-id": request.RequestID})
	claim.Object["spec"] = map[string]any{
		"poolRef":            map[string]any{"name": pool.GetName(), "uid": string(pool.GetUID())},
		"className":          nestedString(pool.Object, "spec", "className"),
		"region":             nestedString(pool.Object, "spec", "placement", "region"),
		"managementClusters": stringSliceAny(nestedStringSlice(pool.Object, "spec", "placement", "managementClusters")),
		"reason":             request.Reason,
	}
	if request.Reason == "CapacityPressure" {
		claim.Object["spec"].(map[string]any)["trigger"] = map[string]any{
			"cellRef":       map[string]any{"name": request.CellName, "uid": request.CellUID},
			"scaleOutEpoch": request.ScaleOutEpoch,
		}
	}
	if err := r.Client.Create(ctx, claim); apierrors.IsAlreadyExists(err) {
		existing := object(claimGVK)
		if getErr := r.Client.Get(ctx, types.NamespacedName{Namespace: pool.GetNamespace(), Name: name}, existing); getErr != nil {
			return fmt.Errorf("read existing deterministic RivetCellClaim: %w", getErr)
		}
		if existing.GetLabels()["fleet.actor.dev/pool-uid"] != string(pool.GetUID()) || existing.GetAnnotations()["fleet.actor.dev/request-id"] != request.RequestID {
			return fmt.Errorf("deterministic RivetCellClaim %s/%s has conflicting identity", pool.GetNamespace(), name)
		}
		return nil
	} else if err != nil {
		return fmt.Errorf("create RivetCellClaim: %w", err)
	}
	return nil
}

func object(gvk schema.GroupVersionKind) *unstructured.Unstructured {
	value := &unstructured.Unstructured{}
	value.SetGroupVersionKind(gvk)
	return value
}

func list(gvk schema.GroupVersionKind) *unstructured.UnstructuredList {
	value := &unstructured.UnstructuredList{}
	value.SetGroupVersionKind(schema.GroupVersionKind{Group: gvk.Group, Version: gvk.Version, Kind: gvk.Kind + "List"})
	return value
}

func updateStatus(ctx context.Context, kubeClient client.Client, value *unstructured.Unstructured, status any) (bool, error) {
	desired, err := runtime.DefaultUnstructuredConverter.ToUnstructured(&status)
	if err != nil {
		return false, fmt.Errorf("convert status: %w", err)
	}
	current, _, err := unstructured.NestedMap(value.Object, "status")
	if err != nil {
		return false, fmt.Errorf("read current status: %w", err)
	}
	if equality.Semantic.DeepEqual(current, desired) {
		return false, nil
	}
	updated := value.DeepCopy()
	if err := unstructured.SetNestedMap(updated.Object, desired, "status"); err != nil {
		return false, fmt.Errorf("set status: %w", err)
	}
	if err := kubeClient.Status().Update(ctx, updated); err != nil {
		return false, fmt.Errorf("update %s %s/%s status: %w", value.GetKind(), value.GetNamespace(), value.GetName(), err)
	}
	return true, nil
}

func parseReport(report *unstructured.Unstructured) *CellReport {
	observedAt, _ := time.Parse(time.RFC3339, nestedString(report.Object, "spec", "observedAt"))
	fdbLogicalBytes, fdbLogicalBytesKnown, _ := unstructured.NestedInt64(report.Object, "spec", "capacity", "fdbLogicalBytes")
	parsed := &CellReport{
		CellName:                     nestedString(report.Object, "spec", "cellRef", "name"),
		CellUID:                      nestedString(report.Object, "spec", "cellRef", "uid"),
		ObservedCellGeneration:       nestedInt64(report.Object, "spec", "observedCellGeneration"),
		ObservedAt:                   observedAt,
		ProfileDigest:                nestedString(report.Object, "spec", "profileDigest"),
		ClusterIdentityHash:          nestedString(report.Object, "spec", "foundationDB", "clusterIdentityHash"),
		FDBAvailable:                 nestedBool(report.Object, "spec", "foundationDB", "available"),
		FDBHealthy:                   nestedBool(report.Object, "spec", "foundationDB", "healthy"),
		FDBTopologyConforming:        nestedBool(report.Object, "spec", "foundationDB", "topologyConforming"),
		RuntimeReadyHosts:            nestedInt64(report.Object, "spec", "health", "runtimeReadyHosts"),
		BackupReady:                  nestedBool(report.Object, "spec", "health", "backupReady"),
		CredentialsReady:             nestedBool(report.Object, "spec", "health", "credentialsReady"),
		CorrectnessViolation:         nestedBool(report.Object, "spec", "health", "correctnessViolation"),
		CapacityRisk:                 nestedString(report.Object, "spec", "capacity", "riskLevel"),
		ScaleOutEpoch:                nestedInt64(report.Object, "spec", "capacity", "scaleOutEpoch"),
		PlacementCount:               nestedInt64(report.Object, "spec", "capacity", "placementCount"),
		PendingReservations:          nestedInt64(report.Object, "spec", "capacity", "pendingReservations"),
		ActiveWriters:                nestedInt64(report.Object, "spec", "capacity", "activeWriters"),
		InFlightCommits:              nestedInt64(report.Object, "spec", "capacity", "inFlightCommits"),
		MigrationBacklog:             nestedInt64(report.Object, "spec", "capacity", "migrationBacklog"),
		CompactionBacklog:            nestedInt64(report.Object, "spec", "capacity", "compactionBacklog"),
		GCBacklog:                    nestedInt64(report.Object, "spec", "capacity", "gcBacklog"),
		ReconciliationBacklog:        nestedInt64(report.Object, "spec", "capacity", "reconciliationBacklog"),
		FDBStorageHeadroomBytes:      nestedInt64(report.Object, "spec", "capacity", "fdbStorageHeadroomBytes"),
		FDBLogicalBytes:              fdbLogicalBytes,
		FDBLogicalBytesKnown:         fdbLogicalBytesKnown,
		FDBStorageHeadroomETASeconds: nestedInt64(report.Object, "spec", "capacity", "fdbStorageHeadroomETASeconds"),
		FDBStorageHeadroomETAKnown:   nestedBool(report.Object, "spec", "capacity", "fdbStorageHeadroomETAKnown"),
		FDBStorageHeadroomSamples:    nestedInt64(report.Object, "spec", "capacity", "fdbStorageHeadroomSamples"),
		FDBWriteUtilizationPercent:   nestedInt64(report.Object, "spec", "capacity", "fdbWriteUtilizationPercent"),
		FDBDataMovementBytes:         nestedInt64(report.Object, "spec", "capacity", "fdbDataMovementBytes"),
		FDBCapacityEvidenceReady:     nestedBool(report.Object, "spec", "capacity", "fdbCapacityEvidenceReady"),
		ScaleInEvidenceReady:         nestedBool(report.Object, "spec", "capacity", "scaleInEvidenceReady"),
		PlacementUtilizationPercent:  nestedInt64(report.Object, "spec", "capacity", "placementUtilizationPercent"),
		RuntimeUtilizationPercent:    nestedInt64(report.Object, "spec", "capacity", "runtimeUtilizationPercent"),
		ReleaseDigest:                nestedString(report.Object, "spec", "releaseDigest"),
		QualificationReady:           nestedBool(report.Object, "spec", "qualification", "ready"),
		QualificationReceiptRef:      nestedString(report.Object, "spec", "qualification", "receiptRef"),
		QualificationDigest:          nestedString(report.Object, "spec", "qualification", "receiptDigest"),
		QualificationReleaseDigest:   nestedString(report.Object, "spec", "qualification", "releaseDigest"),
	}
	if retirement, found, _ := unstructured.NestedMap(report.Object, "spec", "retirement"); found {
		parsed.Retirement = &RetirementReport{
			Generation:               nestedInt64(retirement, "generation"),
			ExactColdReachable:       nestedBool(retirement, "exactColdReachable"),
			ExactBackupReachable:     nestedBool(retirement, "exactBackupReachable"),
			OldGenerationRejected:    nestedBool(retirement, "oldGenerationRejected"),
			RollbackRetentionExpired: nestedBool(retirement, "rollbackRetentionExpired"),
			ArtifactsEnumerated:      nestedBool(retirement, "artifactsEnumerated"),
			FullySettled:             nestedBool(retirement, "fullySettled"),
			CrossCellRestoreVerified: nestedBool(retirement, "crossCellRestoreVerified"),
			ColdManifestRef:          nestedString(retirement, "coldManifestRef"),
			ColdManifestDigest:       nestedString(retirement, "coldManifestDigest"),
			ReceiptRef:               nestedString(retirement, "receiptRef"),
			ReceiptDigest:            nestedString(retirement, "receiptDigest"),
		}
	}
	return parsed
}

func fdbAutoscalingPolicy(profile *unstructured.Unstructured) FDBAutoscalingPolicy {
	mode := nestedString(profile.Object, "spec", "foundationDB", "autoscaling", "mode")
	if mode == "" {
		return FDBAutoscalingPolicy{
			Mode:                   FDBAutoscalingDisabled,
			VolumeRetentionSeconds: int64(DefaultFDBVolumeRetention / time.Second),
			VolumeGCMode:           FDBVolumeGCObserveOnly,
		}
	}
	seconds := func(path ...string) time.Duration {
		return time.Duration(nestedInt64(profile.Object, path...)) * time.Second
	}
	return FDBAutoscalingPolicy{
		Mode:                         mode,
		MinProcessCount:              nestedInt64(profile.Object, "spec", "foundationDB", "autoscaling", "minProcessCount"),
		MaxProcessCount:              nestedInt64(profile.Object, "spec", "foundationDB", "autoscaling", "maxProcessCount"),
		StepProcessCount:             nestedInt64(profile.Object, "spec", "foundationDB", "autoscaling", "stepProcessCount"),
		ScaleUpHeadroomBytes:         nestedInt64(profile.Object, "spec", "foundationDB", "autoscaling", "scaleUp", "headroomBytes"),
		ScaleUpETASeconds:            nestedInt64(profile.Object, "spec", "foundationDB", "autoscaling", "scaleUp", "etaSeconds"),
		ScaleUpSustain:               seconds("spec", "foundationDB", "autoscaling", "scaleUp", "sustainSeconds"),
		ScaleUpCooldown:              seconds("spec", "foundationDB", "autoscaling", "scaleUp", "cooldownSeconds"),
		ScaleUpMinimumSamples:        nestedInt64(profile.Object, "spec", "foundationDB", "autoscaling", "scaleUp", "minimumSamples"),
		ScaleDownHeadroomBytes:       nestedInt64(profile.Object, "spec", "foundationDB", "autoscaling", "scaleDown", "headroomBytes"),
		ScaleDownWriteUtilizationPct: nestedInt64(profile.Object, "spec", "foundationDB", "autoscaling", "scaleDown", "writeUtilizationPercent"),
		ScaleDownSustain:             seconds("spec", "foundationDB", "autoscaling", "scaleDown", "sustainSeconds"),
		ScaleDownCooldown:            seconds("spec", "foundationDB", "autoscaling", "scaleDown", "cooldownSeconds"),
		ScaleDownMinimumSamples:      nestedInt64(profile.Object, "spec", "foundationDB", "autoscaling", "scaleDown", "minimumSamples"),
		VolumeRetentionSeconds:       nestedInt64(profile.Object, "spec", "foundationDB", "autoscaling", "volumeRetentionSeconds"),
		VolumeGCMode:                 nestedString(profile.Object, "spec", "foundationDB", "autoscaling", "volumeGCMode"),
	}
}

func fdbAutoscalingStatus(cell *unstructured.Unstructured) FDBAutoscalingStatus {
	parseTime := func(name string) *metav1.Time {
		value := nestedString(cell.Object, "status", "foundationDBAutoscaling", name)
		if value == "" {
			return nil
		}
		parsed, err := time.Parse(time.RFC3339, value)
		if err != nil {
			return nil
		}
		result := metav1.NewTime(parsed.UTC())
		return &result
	}
	return FDBAutoscalingStatus{
		Mode:                    nestedString(cell.Object, "status", "foundationDBAutoscaling", "mode"),
		Phase:                   nestedString(cell.Object, "status", "foundationDBAutoscaling", "phase"),
		DesiredProcessCount:     nestedInt64(cell.Object, "status", "foundationDBAutoscaling", "desiredProcessCount"),
		RecommendedProcessCount: nestedInt64(cell.Object, "status", "foundationDBAutoscaling", "recommendedProcessCount"),
		ObservedProcessCount:    nestedInt64(cell.Object, "status", "foundationDBAutoscaling", "observedProcessCount"),
		ScaleUpSignalSince:      parseTime("scaleUpSignalSince"),
		ScaleDownSignalSince:    parseTime("scaleDownSignalSince"),
		LastScaleTime:           parseTime("lastScaleTime"),
		LastScaleDirection:      nestedString(cell.Object, "status", "foundationDBAutoscaling", "lastScaleDirection"),
		Reason:                  nestedString(cell.Object, "status", "foundationDBAutoscaling", "reason"),
		VolumeRetentionSeconds:  nestedInt64(cell.Object, "status", "foundationDBAutoscaling", "volumeRetentionSeconds"),
		VolumeGCMode:            nestedString(cell.Object, "status", "foundationDBAutoscaling", "volumeGCMode"),
	}
}

func topologyConforming(cell, profile *unstructured.Unstructured) bool {
	zones := nestedStringSlice(profile.Object, "spec", "zones")
	perZone := nestedInt64(profile.Object, "spec", "foundationDB", "processesPerZone")
	processCount := nestedInt64(profile.Object, "spec", "foundationDB", "processCount")
	if nestedString(profile.Object, "spec", "foundationDB", "supervisor") == FDBKubernetesSupervisor {
		zoneCount := nestedInt64(profile.Object, "spec", "topology", "zoneCount")
		return zoneCount >= 1 && processCount >= zoneCount &&
			nestedString(cell.Object, "spec", "foundationDB", "clusterRef", "name") != "" &&
			nestedString(cell.Object, "spec", "foundationDB", "clusterRef", "namespace") == cell.GetNamespace()
	}
	nodes, found, _ := unstructured.NestedSlice(cell.Object, "spec", "foundationDB", "nodeRefs")
	if !found || int64(len(nodes)) != processCount || int64(len(zones))*perZone != processCount {
		return false
	}
	counts := make(map[string]int64, len(zones))
	for _, item := range nodes {
		node, ok := item.(map[string]any)
		if !ok {
			return false
		}
		zone := nestedString(node, "zone")
		counts[zone]++
	}
	for _, zone := range zones {
		if counts[zone] != perZone {
			return false
		}
	}
	return len(counts) == len(zones)
}

func profileConforming(cell, profile *unstructured.Unstructured) bool {
	if nestedString(cell.Object, "spec", "region") != nestedString(profile.Object, "spec", "region") {
		return false
	}
	coldBucket := nestedString(cell.Object, "spec", "cos", "coldBucket")
	backupBucket := nestedString(cell.Object, "spec", "cos", "backupBucket")
	coldPrefix := nestedString(profile.Object, "spec", "cos", "coldBucketPrefix")
	backupPrefix := nestedString(profile.Object, "spec", "cos", "backupBucketPrefix")
	if coldPrefix != "" || backupPrefix != "" {
		return coldBucket != backupBucket && coldPrefix != "" && backupPrefix != "" &&
			strings.HasPrefix(coldBucket, coldPrefix) && strings.HasPrefix(backupBucket, backupPrefix)
	}
	return coldBucket != backupBucket &&
		coldBucket == nestedString(profile.Object, "spec", "cos", "coldBucket") &&
		backupBucket == nestedString(profile.Object, "spec", "cos", "backupBucket")
}

func digestSpec(value *unstructured.Unstructured) string {
	spec, found, _ := unstructured.NestedMap(value.Object, "spec")
	if !found {
		return ""
	}
	canonical, err := json.Marshal(spec)
	if err != nil {
		return ""
	}
	sum := sha256.Sum256(canonical)
	return "sha256:" + hex.EncodeToString(sum[:])
}

func nestedString(value map[string]any, fields ...string) string {
	result, _, _ := unstructured.NestedString(value, fields...)
	return result
}

func nestedBool(value map[string]any, fields ...string) bool {
	result, _, _ := unstructured.NestedBool(value, fields...)
	return result
}

func nestedInt64(value map[string]any, fields ...string) int64 {
	result, found, _ := unstructured.NestedFieldNoCopy(value, fields...)
	if !found {
		return 0
	}
	switch number := result.(type) {
	case int64:
		return number
	case int32:
		return int64(number)
	case int:
		return int64(number)
	case float64:
		return int64(number)
	case string:
		parsed, _ := strconv.ParseInt(number, 10, 64)
		return parsed
	default:
		return 0
	}
}

func nestedStringSlice(value map[string]any, fields ...string) []string {
	items, found, _ := unstructured.NestedSlice(value, fields...)
	if !found {
		return nil
	}
	result := make([]string, 0, len(items))
	for _, item := range items {
		if text, ok := item.(string); ok {
			result = append(result, text)
		}
	}
	return result
}

func nestedConditions(value map[string]any, fields ...string) []metav1.Condition {
	items, found, _ := unstructured.NestedSlice(value, fields...)
	if !found {
		return nil
	}
	conditions := make([]metav1.Condition, 0, len(items))
	for _, item := range items {
		entry, ok := item.(map[string]any)
		if !ok {
			continue
		}
		transition, err := time.Parse(time.RFC3339, nestedString(entry, "lastTransitionTime"))
		if err != nil {
			continue
		}
		conditions = append(conditions, metav1.Condition{
			Type:               nestedString(entry, "type"),
			Status:             metav1.ConditionStatus(nestedString(entry, "status")),
			Reason:             nestedString(entry, "reason"),
			Message:            nestedString(entry, "message"),
			ObservedGeneration: nestedInt64(entry, "observedGeneration"),
			LastTransitionTime: metav1.NewTime(transition),
		})
	}
	return conditions
}

func stringSliceAny(values []string) []any {
	result := make([]any, 0, len(values))
	for _, value := range values {
		result = append(result, value)
	}
	return result
}

func removeString(values []string, target string) []string {
	result := make([]string, 0, len(values))
	for _, value := range values {
		if value != target {
			result = append(result, value)
		}
	}
	return result
}

func boundedRequeue(value time.Duration) time.Duration {
	if value <= 0 {
		return time.Second
	}
	if value > 30*time.Second {
		return 30 * time.Second
	}
	return value
}

func ValidateConfiguration(reportFreshness time.Duration, maxClaims int64) error {
	if reportFreshness < 30*time.Second {
		return errors.New("report freshness must be at least 30 seconds")
	}
	if maxClaims < 1 || maxClaims > 20 {
		return errors.New("max claims per reconcile must be between 1 and 20")
	}
	return nil
}
