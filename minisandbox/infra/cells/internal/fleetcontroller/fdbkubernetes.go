package fleetcontroller

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"maps"
	"sort"
	"strconv"
	"strings"
	"time"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/equality"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/handler"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"
)

const (
	FDBKubernetesSupervisor = "foundationdb-kubernetes-operator"
	FDBCellNameLabel        = "fleet.actor.dev/cell-name"
	FDBCellNamespaceLabel   = "fleet.actor.dev/cell-namespace"
	FDBCellUIDLabel         = "fleet.actor.dev/cell-uid"
	FDBProfileDigestLabel   = "fleet.actor.dev/profile-digest-short"
	FDBProfileAnnotation    = "fleet.actor.dev/profile-digest"
	// FDBHealthRefreshAnnotation is an edge-trigger for the upstream operator.
	// The operator does not periodically refresh a fully reconciled cluster's
	// status. If its final status sample is taken while the last restarted
	// process is still joining, health.healthy can remain false after the
	// database has recovered. This annotation changes only metadata and asks the
	// operator to take another authoritative machine-readable status sample.
	FDBHealthRefreshAnnotation = "fleet.actor.dev/health-refresh-requested-at"
	FDBVolumeManagedLabel      = "fleet.actor.dev/managed-fdb-volume"
	FDBVolumeCellUID           = "fleet.actor.dev/cell-uid"
	FDBVolumeClusterUID        = "fleet.actor.dev/fdb-cluster-uid"
	FDBVolumeProcessGroup      = "fleet.actor.dev/process-group-id"
	FDBVolumePVCUID            = "fleet.actor.dev/pvc-uid"
	FDBVolumeCBSDiskID         = "fleet.actor.dev/cbs-disk-id"
	FDBNodeCapacityTKE         = "TKENativeMachineSet"
	// FDB database Pods pull the unified monitor image from the private fleet
	// registry. The operator Deployment has its own Pod template, so configuring
	// the operator's pull secret does not propagate to the database Pods it
	// creates; the FoundationDBCluster template must carry it explicitly.
	FDBImagePullSecretName                       = "actor-fleet-tcr"
	FDBHealthRefreshInterval                     = 2 * time.Minute
	FDBInitialTopologyReplacementCountAnnotation = "fleet.actor.dev/initial-topology-replacement-count"
)

var fdbClusterGVK = schema.GroupVersionKind{
	Group: "apps.foundationdb.org", Version: "v1beta2", Kind: "FoundationDBCluster",
}

var fdbPodDisruptionBudgetGVK = schema.GroupVersionKind{
	Group: "policy", Version: "v1", Kind: "PodDisruptionBudget",
}

var fdbScaleOperationGVK = schema.GroupVersionKind{
	Group: Group, Version: Version, Kind: "FDBScaleOperation",
}

var fdbVolumeRetirementGVK = schema.GroupVersionKind{
	Group: Group, Version: Version, Kind: "FDBVolumeRetirement",
}

var tkeMachineSetGVK = schema.GroupVersionKind{
	Group: "node.tke.cloud.tencent.com", Version: "v1beta1", Kind: "MachineSet",
}

var tkeMachineGVK = schema.GroupVersionKind{
	Group: "node.tke.cloud.tencent.com", Version: "v1beta1", Kind: "Machine",
}

type FDBVolumeInventory struct {
	ProcessGroupID string
	PVCName        string
	PVCUID         string
	PVName         string
	PVUID          string
	CBSDiskID      string
}

type fdbScaleDownCandidate struct {
	ProcessGroupID string
	NodeName       string
	Zone           string
	CreatedAt      time.Time
}

// FDBKubernetesReconciler owns only the desired FoundationDBCluster spec and
// its binding labels. The upstream FoundationDB operator owns status, Pods,
// PVCs, ConfigMaps and process replacement. There is deliberately no owner
// reference from the Cell to the database cluster: deleting a Cell object must
// never garbage-collect durable database resources.
type FDBKubernetesReconciler struct {
	Client client.Client
	Now    func() time.Time
}

func (r *FDBKubernetesReconciler) Reconcile(ctx context.Context, request ctrl.Request) (ctrl.Result, error) {
	cell := object(cellGVK)
	if err := r.Client.Get(ctx, request.NamespacedName, cell); err != nil {
		return ctrl.Result{}, client.IgnoreNotFound(err)
	}
	if !cell.GetDeletionTimestamp().IsZero() {
		return ctrl.Result{}, nil
	}

	profile, profileDigest, managed, err := r.profileForCell(ctx, cell)
	if err != nil || !managed {
		return ctrl.Result{}, err
	}
	if nestedString(profile.Object, "spec", "foundationDB", "supervisor") != FDBKubernetesSupervisor {
		return ctrl.Result{}, nil
	}
	if profileDigest != digestSpec(profile) {
		return ctrl.Result{}, fmt.Errorf("RivetCellProfile digest mismatch: class has %q, observed %q", profileDigest, digestSpec(profile))
	}

	clusterName := nestedString(cell.Object, "spec", "foundationDB", "clusterRef", "name")
	clusterNamespace := nestedString(cell.Object, "spec", "foundationDB", "clusterRef", "namespace")
	boundUID := nestedString(cell.Object, "spec", "foundationDB", "clusterRef", "uid")
	if clusterName == "" || clusterNamespace == "" {
		return ctrl.Result{}, fmt.Errorf("operator-backed Cell requires foundationDB.clusterRef name and namespace")
	}
	if clusterNamespace != cell.GetNamespace() {
		return ctrl.Result{}, fmt.Errorf("cross-namespace FoundationDBCluster binding is disabled: Cell is in %q, clusterRef is in %q", cell.GetNamespace(), clusterNamespace)
	}

	desired, err := foundationDBClusterForCell(cell, profile, profileDigest)
	if err != nil {
		return ctrl.Result{}, err
	}
	desiredPDB, err := foundationDBPodDisruptionBudgetForCell(cell, profile)
	if err != nil {
		return ctrl.Result{}, err
	}
	actual := object(fdbClusterGVK)
	err = r.Client.Get(ctx, types.NamespacedName{Name: clusterName, Namespace: clusterNamespace}, actual)
	if apierrors.IsNotFound(err) {
		if boundUID != "" {
			return ctrl.Result{}, fmt.Errorf("bound FoundationDBCluster %s/%s with UID %s is missing; refusing to create a new database identity", clusterNamespace, clusterName, boundUID)
		}
		ready, err := r.ensureInitialCellMachineTopology(ctx, cell, profile)
		if err != nil {
			return ctrl.Result{}, err
		}
		if !ready {
			return ctrl.Result{RequeueAfter: 10 * time.Second}, nil
		}
		// The FDB client can crash while resolving DNS coordinators in the gap
		// between the operator publishing the initial connection string and
		// starting fdbserver. Bootstrap with Pod IP coordinators, then promote to
		// DNS after the database reports configured. This keeps fresh Cells fully
		// declarative without weakening steady-state coordinator stability.
		setFDBUseDNSInClusterFile(desired, false)
		if err := r.Client.Create(ctx, desired); err != nil {
			return ctrl.Result{}, fmt.Errorf("create FoundationDBCluster: %w", err)
		}
		if err := r.reconcilePodDisruptionBudget(ctx, desiredPDB, cell); err != nil {
			return ctrl.Result{}, err
		}
		return ctrl.Result{Requeue: true}, nil
	}
	if err != nil {
		return ctrl.Result{}, fmt.Errorf("get FoundationDBCluster: %w", err)
	}
	if actual.GetLabels()[FDBCellUIDLabel] != string(cell.GetUID()) {
		return ctrl.Result{}, fmt.Errorf("FoundationDBCluster %s/%s is not bound to Cell UID %s", clusterNamespace, clusterName, cell.GetUID())
	}
	if boundUID != "" && boundUID != string(actual.GetUID()) {
		return ctrl.Result{}, fmt.Errorf("FoundationDBCluster UID changed from %s to %s; refusing database identity replacement", boundUID, actual.GetUID())
	}
	if actual.GetUID() == "" {
		return ctrl.Result{Requeue: true}, nil
	}
	// An isolated restore creates its own FDB storage Pods without changing the
	// primary cluster's process target. Reserve their dedicated TKE capacity on
	// the normal Cell reconcile path; an FDBScaleOperation is not required just
	// to make a DR target schedulable. This path only raises the floor. Reclaim
	// remains governed by the scale-down and volume-retirement gates.
	if nestedString(profile.Object, "spec", "foundationDB", "kubernetes", "placementMode") == "DedicatedNodes" {
		if err := r.reconcileAuxiliaryFDBCapacity(ctx, cell, actual, profile); err != nil {
			return ctrl.Result{}, err
		}
	}
	refreshed, err := r.requestFDBHealthStatusRefresh(ctx, actual)
	if err != nil {
		return ctrl.Result{}, err
	}
	if refreshed {
		return ctrl.Result{RequeueAfter: 30 * time.Second}, nil
	}
	volumeInventory, err := r.reconcileFDBVolumeInventory(ctx, cell, actual, nestedString(profile.Object, "spec", "foundationDB", "kubernetes", "storageClassName"))
	if err != nil {
		return ctrl.Result{}, err
	}
	actualProcessCount := nestedInt64(actual.Object, "spec", "processCounts", "storage")
	desiredProcessCount := desiredFDBProcessCount(cell, profile)
	if fdbAutoscalingPolicy(profile).Mode != FDBAutoscalingAutomatic && desiredProcessCount != actualProcessCount {
		// ObserveOnly is a planning mode, not permission to mutate an existing
		// database back to the profile baseline. Preserve both the live process
		// count and PDB while no FDBScaleOperation is active. All scale targets
		// must be published by the operation transaction below.
		if err := unstructured.SetNestedField(desired.Object, actualProcessCount, "spec", "processCounts", "storage"); err != nil {
			return ctrl.Result{}, fmt.Errorf("preserve observed FoundationDB process count in ObserveOnly: %w", err)
		}
		if err := unstructured.SetNestedField(desiredPDB.Object, actualProcessCount-1, "spec", "minAvailable"); err != nil {
			return ctrl.Result{}, fmt.Errorf("preserve observed FoundationDB PDB in ObserveOnly: %w", err)
		}
	}
	if err := r.reconcilePodDisruptionBudget(ctx, desiredPDB, cell); err != nil {
		return ctrl.Result{}, err
	}
	if desiredProcessCount < actualProcessCount && int64(len(volumeInventory)) != actualProcessCount {
		return ctrl.Result{}, fmt.Errorf("refusing FDB scale-down from %d to %d: durable volume inventory covers %d process groups", actualProcessCount, desiredProcessCount, len(volumeInventory))
	}
	if active, err := r.reconcileActiveFDBScaleOperation(ctx, cell, actual); err != nil {
		return ctrl.Result{}, err
	} else if active {
		return ctrl.Result{RequeueAfter: 10 * time.Second}, nil
	}
	if desiredProcessCount != actualProcessCount && fdbAutoscalingPolicy(profile).Mode == FDBAutoscalingAutomatic {
		created, err := r.ensureFDBScaleOperation(ctx, cell, actual, profile, profileDigest, actualProcessCount, desiredProcessCount, volumeInventory)
		if err != nil {
			return ctrl.Result{}, err
		}
		if created {
			return ctrl.Result{Requeue: true}, nil
		}
	}
	setFDBUseDNSInClusterFile(desired, nestedBool(actual.Object, "status", "configured"))
	connectionString := nestedString(actual.Object, "status", "connectionString")
	observedIdentity := databaseIdentityHash(string(actual.GetUID()), connectionString)
	boundIdentity := nestedString(cell.Object, "spec", "foundationDB", "clusterIdentityHash")
	if boundIdentity != "" && observedIdentity != "" && boundIdentity != observedIdentity {
		return ctrl.Result{}, fmt.Errorf("FoundationDB database name changed under bound cluster UID %s; refusing identity replacement", actual.GetUID())
	}
	if boundUID == "" || (boundIdentity == "" && observedIdentity != "") {
		before := cell.DeepCopy()
		if boundUID == "" {
			if err := unstructured.SetNestedField(cell.Object, string(actual.GetUID()), "spec", "foundationDB", "clusterRef", "uid"); err != nil {
				return ctrl.Result{}, fmt.Errorf("bind FoundationDBCluster UID: %w", err)
			}
		}
		if boundIdentity == "" && observedIdentity != "" {
			if err := unstructured.SetNestedField(cell.Object, observedIdentity, "spec", "foundationDB", "clusterIdentityHash"); err != nil {
				return ctrl.Result{}, fmt.Errorf("bind FoundationDB database identity: %w", err)
			}
		}
		if err := r.Client.Patch(ctx, cell, client.MergeFrom(before)); err != nil {
			return ctrl.Result{}, fmt.Errorf("persist FoundationDB identity binding: %w", err)
		}
		return ctrl.Result{Requeue: true}, nil
	}

	desiredSpec, _, _ := unstructured.NestedMap(desired.Object, "spec")
	actualSpec, _, _ := unstructured.NestedMap(actual.Object, "spec")
	if !equality.Semantic.DeepDerivative(desiredSpec, actualSpec) ||
		!equality.Semantic.DeepDerivative(desired.GetLabels(), actual.GetLabels()) ||
		!equality.Semantic.DeepDerivative(desired.GetAnnotations(), actual.GetAnnotations()) {
		before := actual.DeepCopy()
		if err := unstructured.SetNestedMap(actual.Object, desiredSpec, "spec"); err != nil {
			return ctrl.Result{}, fmt.Errorf("set FoundationDBCluster spec: %w", err)
		}
		annotations := actual.GetAnnotations()
		if annotations == nil {
			annotations = map[string]string{}
		}
		annotations[FDBProfileAnnotation] = profileDigest
		actual.SetAnnotations(annotations)
		labels := actual.GetLabels()
		if labels == nil {
			labels = map[string]string{}
		}
		for key, value := range desired.GetLabels() {
			labels[key] = value
		}
		actual.SetLabels(labels)
		if err := r.Client.Patch(ctx, actual, client.MergeFrom(before)); err != nil {
			return ctrl.Result{}, fmt.Errorf("patch FoundationDBCluster spec: %w", err)
		}
	}

	// Profile and ShardClass resources are cluster-scoped and are not primary
	// watches for this controller. A bounded periodic reconcile makes profile
	// promotion observable without requiring an unrelated Cell or FDB event.
	return ctrl.Result{RequeueAfter: 30 * time.Second}, nil
}

// ensureInitialCellMachineTopology closes the gap between TKE's best-effort
// ZoneEquality placement and the Cell's strict three-zone bootstrap contract.
// It covers both the three-member control pool and FoundationDB's
// three_data_hall pool. It runs only while no FoundationDBCluster identity
// exists, before NATS or durable FDB volumes can depend on a selected Machine.
// If TKE creates an initially skewed batch, replace at most one newest Machine
// from a surplus zone per reconcile and wait for the provider to restore the
// exact replica count before considering another replacement.
func (r *FDBKubernetesReconciler) ensureInitialCellMachineTopology(ctx context.Context, cell, profile *unstructured.Unstructured) (bool, error) {
	zoneCount := nestedInt64(profile.Object, "spec", "topology", "zoneCount")
	ready, err := r.ensureInitialMachineSetTopology(ctx, cell, "np-control0", zoneCount, zoneCount, "fleet.actor.dev/control-pool")
	if err != nil || !ready {
		return false, err
	}
	settings, err := tkeNodeCapacityRef(profile)
	if err != nil {
		return false, err
	}
	machineSetName := nestedString(settings, "machineSetName")
	return r.ensureInitialMachineSetTopology(ctx, cell, machineSetName, desiredFDBProcessCount(cell, profile), zoneCount, "fleet.actor.dev/fdb-dedicated")
}

func (r *FDBKubernetesReconciler) ensureInitialMachineSetTopology(ctx context.Context, cell *unstructured.Unstructured, machineSetName string, processCount, zoneCount int64, roleLabel string) (bool, error) {
	machineSet := object(tkeMachineSetGVK)
	if err := r.Client.Get(ctx, types.NamespacedName{Name: machineSetName}, machineSet); err != nil {
		if apierrors.IsNotFound(err) {
			return false, nil
		}
		return false, fmt.Errorf("get initial FDB MachineSet %q: %w", machineSetName, err)
	}
	machineSetLabels, _, _ := unstructured.NestedStringMap(machineSet.Object, "spec", "template", "spec", "metadata", "labels")
	if machineSet.GetUID() == "" || nestedString(machineSet.Object, "spec", "type") != "Native" ||
		nestedString(machineSet.Object, "spec", "scaling", "createPolicy") != "ZoneEquality" ||
		nestedInt64(machineSet.Object, "spec", "replicas") != processCount ||
		nestedInt64(machineSet.Object, "spec", "scaling", "minReplicas") != processCount ||
		machineSetLabels[FDBCellNameLabel] != cell.GetName() || machineSetLabels[roleLabel] != "true" ||
		processCount < 1 || zoneCount < 1 || processCount%zoneCount != 0 {
		return false, fmt.Errorf("initial MachineSet %q violates the exact topology contract", machineSetName)
	}
	if nestedInt64(machineSet.Object, "status", "observedGeneration") != machineSet.GetGeneration() ||
		nestedInt64(machineSet.Object, "status", "replicas") != processCount ||
		nestedInt64(machineSet.Object, "status", "readyReplicas") != processCount ||
		nestedInt64(machineSet.Object, "status", "availableReplicas") != processCount {
		return false, nil
	}

	machines := &unstructured.UnstructuredList{}
	machines.SetGroupVersionKind(tkeMachineGVK.GroupVersion().WithKind("MachineList"))
	if err := r.Client.List(ctx, machines, client.MatchingLabels{"node.tke.cloud.tencent.com/machineset": machineSetName}); err != nil {
		return false, fmt.Errorf("list initial FDB Machines for %q: %w", machineSetName, err)
	}
	type machinePlacement struct {
		machine *unstructured.Unstructured
		zone    string
	}
	placements := make([]machinePlacement, 0, processCount)
	zoneCounts := map[string]int64{}
	for i := range machines.Items {
		machine := &machines.Items[i]
		if !machine.GetDeletionTimestamp().IsZero() {
			continue
		}
		owned := false
		for _, owner := range machine.GetOwnerReferences() {
			if owner.Controller != nil && *owner.Controller && owner.Kind == "MachineSet" && owner.Name == machineSetName && owner.UID == machineSet.GetUID() {
				owned = true
				break
			}
		}
		machineLabels, _, _ := unstructured.NestedStringMap(machine.Object, "spec", "metadata", "labels")
		if !owned || machineLabels[FDBCellNameLabel] != cell.GetName() || machineLabels[roleLabel] != "true" {
			return false, fmt.Errorf("Machine %q is not exclusively owned by initial MachineSet %q", machine.GetName(), machineSetName)
		}
		nodeName := nestedString(machine.Object, "status", "nodeRef", "name")
		if nodeName == "" {
			return false, nil
		}
		node := &corev1.Node{}
		if err := r.Client.Get(ctx, types.NamespacedName{Name: nodeName}, node); err != nil {
			if apierrors.IsNotFound(err) {
				return false, nil
			}
			return false, fmt.Errorf("get initial FDB Node %q: %w", nodeName, err)
		}
		ready := false
		for _, condition := range node.Status.Conditions {
			if condition.Type == corev1.NodeReady && condition.Status == corev1.ConditionTrue {
				ready = true
				break
			}
		}
		zone := node.Labels["topology.kubernetes.io/zone"]
		if !ready || node.Spec.Unschedulable || zone == "" || node.Labels[FDBCellNameLabel] != cell.GetName() || node.Labels[roleLabel] != "true" {
			return false, nil
		}
		placements = append(placements, machinePlacement{machine: machine, zone: zone})
		zoneCounts[zone]++
	}
	if int64(len(placements)) != processCount {
		return false, nil
	}
	perZone := processCount / zoneCount
	if int64(len(zoneCounts)) == zoneCount {
		balanced := true
		for _, count := range zoneCounts {
			if count != perZone {
				balanced = false
				break
			}
		}
		if balanced {
			return true, nil
		}
	}
	if int64(len(zoneCounts)) > zoneCount {
		return false, fmt.Errorf("initial MachineSet %q spans %d zones, expected %d", machineSetName, len(zoneCounts), zoneCount)
	}

	maxZoneCount := int64(0)
	for _, count := range zoneCounts {
		if count > maxZoneCount {
			maxZoneCount = count
		}
	}
	candidates := make([]*unstructured.Unstructured, 0)
	for _, placement := range placements {
		if maxZoneCount > perZone && zoneCounts[placement.zone] == maxZoneCount {
			candidates = append(candidates, placement.machine)
		}
	}
	if len(candidates) == 0 {
		return false, fmt.Errorf("initial MachineSet %q topology %v is unbalanced without a surplus-zone replacement candidate", machineSetName, zoneCounts)
	}
	replacementCount := 0
	if raw := machineSet.GetAnnotations()[FDBInitialTopologyReplacementCountAnnotation]; raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 0 || int64(parsed) > processCount {
			return false, fmt.Errorf("initial MachineSet %q has an invalid topology replacement count %q", machineSetName, raw)
		}
		replacementCount = parsed
	}
	// A permanently unavailable zone must not turn bootstrap reconciliation into
	// an unbounded VM create/delete loop. In the worst initial layout, replacing
	// at most every original Machine is ample opportunity to reach the exact
	// zone distribution. Persist the bounded attempt before deleting the Machine:
	// a controller crash can consume one attempt, but can never perform an
	// unaccounted destructive retry.
	if int64(replacementCount) >= processCount {
		return false, fmt.Errorf("initial MachineSet %q exhausted %d bounded topology replacements with topology %v", machineSetName, replacementCount, zoneCounts)
	}
	sort.Slice(candidates, func(i, j int) bool {
		left, right := candidates[i].GetCreationTimestamp().Time, candidates[j].GetCreationTimestamp().Time
		if left.Equal(right) {
			return candidates[i].GetName() > candidates[j].GetName()
		}
		return left.After(right)
	})
	before := machineSet.DeepCopy()
	annotations := machineSet.GetAnnotations()
	if annotations == nil {
		annotations = map[string]string{}
	}
	annotations[FDBInitialTopologyReplacementCountAnnotation] = strconv.Itoa(replacementCount + 1)
	machineSet.SetAnnotations(annotations)
	if err := r.Client.Patch(ctx, machineSet, client.MergeFrom(before)); err != nil {
		return false, fmt.Errorf("record bounded topology replacement for initial MachineSet %q: %w", machineSetName, err)
	}
	if err := r.Client.Delete(ctx, candidates[0]); err != nil {
		return false, fmt.Errorf("replace surplus-zone initial Machine %q: %w", candidates[0].GetName(), err)
	}
	return false, nil
}

func (r *FDBKubernetesReconciler) requestFDBHealthStatusRefresh(ctx context.Context, cluster *unstructured.Unstructured) (bool, error) {
	desiredGroups := nestedInt64(cluster.Object, "spec", "processCounts", "storage")
	if desiredGroups <= 0 ||
		nestedInt64(cluster.Object, "status", "generations", "reconciled") != cluster.GetGeneration() ||
		nestedInt64(cluster.Object, "status", "desiredProcessGroups") != desiredGroups ||
		nestedInt64(cluster.Object, "status", "reconciledProcessGroups") != desiredGroups ||
		!nestedBool(cluster.Object, "status", "configured") ||
		!nestedBool(cluster.Object, "status", "health", "available") ||
		!nestedBool(cluster.Object, "status", "health", "fullReplication") ||
		nestedBool(cluster.Object, "status", "health", "healthy") {
		return false, nil
	}

	now := time.Now().UTC()
	if r.Now != nil {
		now = r.Now().UTC()
	}
	annotations := cluster.GetAnnotations()
	if previous, err := time.Parse(time.RFC3339, annotations[FDBHealthRefreshAnnotation]); err == nil && now.Sub(previous) < FDBHealthRefreshInterval {
		return false, nil
	}

	before := cluster.DeepCopy()
	if annotations == nil {
		annotations = map[string]string{}
	} else {
		annotations = maps.Clone(annotations)
	}
	annotations[FDBHealthRefreshAnnotation] = now.Format(time.RFC3339)
	cluster.SetAnnotations(annotations)
	if err := r.Client.Patch(ctx, cluster, client.MergeFrom(before)); err != nil {
		return false, fmt.Errorf("request FoundationDB health status refresh: %w", err)
	}
	return true, nil
}

func (r *FDBKubernetesReconciler) ensureFDBScaleOperation(ctx context.Context, cell, cluster, profile *unstructured.Unstructured, profileDigest string, from, to int64, inventory []FDBVolumeInventory) (bool, error) {
	lastScaleTime := nestedString(cell.Object, "status", "foundationDBAutoscaling", "lastScaleTime")
	if lastScaleTime == "" {
		return false, fmt.Errorf("automatic FDB target changed without a persisted lastScaleTime")
	}
	direction := "Up"
	if to < from {
		direction = "Down"
	}
	selectedProcessGroups := []string{}
	selectedProcessGroupTopology := []map[string]any{}
	if direction == "Down" {
		var selectionErr error
		selectedProcessGroups, selectedProcessGroupTopology, selectionErr = r.planScaleDownProcessGroups(ctx, cell, cluster, from, to, inventory)
		if selectionErr != nil {
			return false, selectionErr
		}
	}
	identity := sha256.Sum256([]byte(fmt.Sprintf("%s\x00%s\x00%d\x00%d\x00%s", cell.GetUID(), cluster.GetUID(), from, to, lastScaleTime)))
	prefix := cell.GetName()
	if len(prefix) > 40 {
		prefix = prefix[:40]
	}
	name := fmt.Sprintf("%s-fdb-%d-%d-%x", prefix, from, to, identity[:4])
	key := types.NamespacedName{Name: name, Namespace: cell.GetNamespace()}
	existing := object(fdbScaleOperationGVK)
	if err := r.Client.Get(ctx, key, existing); err == nil {
		if nestedString(existing.Object, "spec", "cellRef", "uid") != string(cell.GetUID()) ||
			nestedInt64(existing.Object, "spec", "fromProcessCount") != from || nestedInt64(existing.Object, "spec", "toProcessCount") != to {
			return false, fmt.Errorf("FDBScaleOperation %s/%s identity collision", key.Namespace, key.Name)
		}
		return false, nil
	} else if !apierrors.IsNotFound(err) {
		return false, fmt.Errorf("get FDBScaleOperation: %w", err)
	}
	volumeInventory := make([]any, 0, len(inventory))
	for _, volume := range inventory {
		volumeInventory = append(volumeInventory, map[string]any{
			"processGroupID": volume.ProcessGroupID, "pvcName": volume.PVCName, "pvcUID": volume.PVCUID,
			"pvName": volume.PVName, "pvUID": volume.PVUID, "cbsDiskID": volume.CBSDiskID,
		})
	}
	nodeCapacityRef, err := tkeNodeCapacityRef(profile)
	if err != nil {
		return false, err
	}
	operation := object(fdbScaleOperationGVK)
	operation.SetName(name)
	operation.SetNamespace(cell.GetNamespace())
	operation.SetLabels(map[string]string{
		FDBCellNameLabel: cell.GetName(), FDBCellNamespaceLabel: cell.GetNamespace(), FDBCellUIDLabel: string(cell.GetUID()),
		"app.kubernetes.io/managed-by": "actor-fleet-controller",
	})
	operation.Object["spec"] = map[string]any{
		"cellRef":                map[string]any{"name": cell.GetName(), "uid": string(cell.GetUID())},
		"foundationDBClusterRef": map[string]any{"name": cluster.GetName(), "uid": string(cluster.GetUID())},
		"direction":              direction, "fromProcessCount": from, "toProcessCount": to,
		"requestedAt": lastScaleTime, "profileDigest": profileDigest, "volumeInventory": volumeInventory,
		"volumeRetentionSeconds": nestedInt64(cell.Object, "status", "foundationDBAutoscaling", "volumeRetentionSeconds"),
		"volumeGCMode":           nestedString(cell.Object, "status", "foundationDBAutoscaling", "volumeGCMode"),
		"nodeCapacityRef":        nodeCapacityRef,
	}
	if len(selectedProcessGroups) > 0 {
		selected := make([]any, 0, len(selectedProcessGroups))
		for _, processGroup := range selectedProcessGroups {
			selected = append(selected, processGroup)
		}
		operation.Object["spec"].(map[string]any)["selectedProcessGroups"] = selected
		topology := make([]any, 0, len(selectedProcessGroupTopology))
		for _, item := range selectedProcessGroupTopology {
			topology = append(topology, item)
		}
		operation.Object["spec"].(map[string]any)["selectedProcessGroupTopology"] = topology
	}
	if err := r.Client.Create(ctx, operation); err != nil {
		return false, fmt.Errorf("create FDBScaleOperation: %w", err)
	}
	return true, nil
}

// planScaleDownProcessGroups persists a deterministic, topology-balanced
// removal plan before the FoundationDB target is lowered. The upstream
// operator still performs exclusion, data movement, coordinator replacement
// and resource deletion. Explicit selection avoids an upstream locality
// ordering trap where an empty dcid can make a 4/4/4 cluster choose a 2/0/1
// removal set, leaving too few eligible coordinators in one data hall.
func (r *FDBKubernetesReconciler) planScaleDownProcessGroups(ctx context.Context, cell, cluster *unstructured.Unstructured, from, to int64, inventory []FDBVolumeInventory) ([]string, []map[string]any, error) {
	removeCount := from - to
	if removeCount <= 0 || from%3 != 0 || to%3 != 0 || removeCount%3 != 0 {
		return nil, nil, fmt.Errorf("FDB scale-down %d -> %d cannot preserve three-zone balance", from, to)
	}
	if int64(len(inventory)) != from {
		return nil, nil, fmt.Errorf("FDB scale-down selection requires %d inventoried process groups, got %d", from, len(inventory))
	}
	inventoried := make(map[string]struct{}, len(inventory))
	for _, volume := range inventory {
		inventoried[volume.ProcessGroupID] = struct{}{}
	}

	pods := &corev1.PodList{}
	if err := r.Client.List(ctx, pods, client.InNamespace(cell.GetNamespace()), client.MatchingLabels{
		"foundationdb.org/fdb-cluster-name":  cluster.GetName(),
		"foundationdb.org/fdb-process-class": "storage",
	}); err != nil {
		return nil, nil, fmt.Errorf("list FDB storage Pods for scale-down selection: %w", err)
	}
	if int64(len(pods.Items)) != from {
		return nil, nil, fmt.Errorf("FDB scale-down selection requires %d storage Pods, got %d", from, len(pods.Items))
	}

	candidatesByZone := map[string][]fdbScaleDownCandidate{}
	seenProcessGroups := make(map[string]struct{}, len(pods.Items))
	seenNodes := make(map[string]struct{}, len(pods.Items))
	for i := range pods.Items {
		pod := &pods.Items[i]
		processGroup := pod.Labels["foundationdb.org/fdb-process-group-id"]
		if _, ok := inventoried[processGroup]; processGroup == "" || !ok {
			return nil, nil, fmt.Errorf("FDB storage Pod %s has no matching durable process-group inventory", pod.Name)
		}
		if _, duplicate := seenProcessGroups[processGroup]; duplicate {
			return nil, nil, fmt.Errorf("multiple FDB storage Pods claim process group %s", processGroup)
		}
		seenProcessGroups[processGroup] = struct{}{}
		if pod.Spec.NodeName == "" || pod.DeletionTimestamp != nil || pod.Status.Phase != corev1.PodRunning || !podReady(pod) {
			return nil, nil, fmt.Errorf("FDB storage Pod %s is not a steady-state Ready removal candidate", pod.Name)
		}
		if _, duplicate := seenNodes[pod.Spec.NodeName]; duplicate {
			return nil, nil, fmt.Errorf("multiple FDB storage Pods share node %s", pod.Spec.NodeName)
		}
		seenNodes[pod.Spec.NodeName] = struct{}{}
		node := &corev1.Node{}
		if err := r.Client.Get(ctx, types.NamespacedName{Name: pod.Spec.NodeName}, node); err != nil {
			return nil, nil, fmt.Errorf("get FDB node %s for scale-down selection: %w", pod.Spec.NodeName, err)
		}
		zone := node.Labels[corev1.LabelTopologyZone]
		if zone == "" || node.Labels[FDBCellNameLabel] != cell.GetName() || node.Labels["fleet.actor.dev/fdb-dedicated"] != "true" {
			return nil, nil, fmt.Errorf("FDB node %s violates the dedicated topology contract", node.Name)
		}
		candidatesByZone[zone] = append(candidatesByZone[zone], fdbScaleDownCandidate{
			ProcessGroupID: processGroup,
			NodeName:       node.Name,
			Zone:           zone,
			CreatedAt:      pod.CreationTimestamp.Time,
		})
	}
	if len(candidatesByZone) != 3 {
		return nil, nil, fmt.Errorf("FDB scale-down selection requires exactly three zones, got %d", len(candidatesByZone))
	}
	currentPerZone := from / 3
	removePerZone := removeCount / 3
	selectedCandidates := make([]fdbScaleDownCandidate, 0, removeCount)
	for zone, candidates := range candidatesByZone {
		if int64(len(candidates)) != currentPerZone {
			return nil, nil, fmt.Errorf("FDB zone %s has %d storage Pods, want %d before scale-down", zone, len(candidates), currentPerZone)
		}
		sort.SliceStable(candidates, func(i, j int) bool {
			if candidates[i].CreatedAt.Equal(candidates[j].CreatedAt) {
				return candidates[i].ProcessGroupID > candidates[j].ProcessGroupID
			}
			return candidates[i].CreatedAt.After(candidates[j].CreatedAt)
		})
		for i := int64(0); i < removePerZone; i++ {
			selectedCandidates = append(selectedCandidates, candidates[i])
		}
	}
	sort.Slice(selectedCandidates, func(i, j int) bool {
		return selectedCandidates[i].ProcessGroupID < selectedCandidates[j].ProcessGroupID
	})
	selected := make([]string, 0, len(selectedCandidates))
	topology := make([]map[string]any, 0, len(selectedCandidates))
	for _, candidate := range selectedCandidates {
		selected = append(selected, candidate.ProcessGroupID)
		topology = append(topology, map[string]any{
			"processGroupID": candidate.ProcessGroupID,
			"nodeName":       candidate.NodeName,
			"zone":           candidate.Zone,
		})
	}
	return selected, topology, nil
}

func podReady(pod *corev1.Pod) bool {
	for _, condition := range pod.Status.Conditions {
		if condition.Type == corev1.PodReady {
			return condition.Status == corev1.ConditionTrue
		}
	}
	return false
}

func (r *FDBKubernetesReconciler) reconcileActiveFDBScaleOperation(ctx context.Context, cell, cluster *unstructured.Unstructured) (bool, error) {
	operations := list(fdbScaleOperationGVK)
	if err := r.Client.List(ctx, operations, client.InNamespace(cell.GetNamespace()), client.MatchingLabels{FDBCellUIDLabel: string(cell.GetUID())}); err != nil {
		return false, fmt.Errorf("list FDBScaleOperations: %w", err)
	}
	active := make([]*unstructured.Unstructured, 0, 1)
	for i := range operations.Items {
		operation := &operations.Items[i]
		switch nestedString(operation.Object, "status", "phase") {
		case "Succeeded", "Failed", "RolledBack":
			continue
		default:
			active = append(active, operation)
		}
	}
	if len(active) == 0 {
		return false, nil
	}
	if len(active) != 1 {
		return true, fmt.Errorf("Cell %s has %d concurrent FDBScaleOperations", cell.GetName(), len(active))
	}
	operation := active[0]
	if nestedString(operation.Object, "spec", "foundationDBClusterRef", "uid") != string(cluster.GetUID()) {
		return true, fmt.Errorf("FDBScaleOperation %s is bound to another FoundationDBCluster UID", operation.GetName())
	}
	target := nestedInt64(operation.Object, "spec", "toProcessCount")
	direction := nestedString(operation.Object, "spec", "direction")
	var nodeCapacitySnapshot map[string]any
	if direction == "Up" {
		ready, snapshot, err := r.reconcileTKECapacityFloor(ctx, cell, operation, target, false)
		if err != nil {
			return true, err
		}
		nodeCapacitySnapshot = snapshot
		if !ready {
			if err := r.updateScaleOperationProgress(ctx, operation, cluster, "ProvisioningCapacity",
				"TKE capacity floor is reserved; waiting for Pending FDB Pods to drive managed Cluster Autoscaler", snapshot); err != nil {
				return true, err
			}
			// Publish the FDB target after persisting the exact MachineSet target.
			// TKE may provision the declared nodes concurrently with the operator
			// creating Pending storage Pods. Once the target is published, keep the
			// operation active until the corresponding nodes are Ready.
			if nestedInt64(cluster.Object, "spec", "processCounts", "storage") != target {
				return false, nil
			}
			return true, nil
		}
	}
	if direction == "Down" && nestedInt64(cluster.Object, "spec", "processCounts", "storage") != target {
		if err := r.publishFDBScaleDownTarget(ctx, operation, cluster, target); err != nil {
			return true, err
		}
		return true, r.updateScaleOperationProgress(ctx, operation, cluster, "Scaling",
			"published the topology-balanced removal plan; FoundationDB Operator owns exclusion and redistribution", nil)
	}
	phase := "Pending"
	message := "waiting for the fleet provider to publish the operation target"
	clusterAtTarget := nestedInt64(cluster.Object, "spec", "processCounts", "storage") == target &&
		nestedInt64(cluster.Object, "status", "generations", "reconciled") == cluster.GetGeneration() &&
		nestedInt64(cluster.Object, "status", "desiredProcessGroups") == target &&
		nestedInt64(cluster.Object, "status", "reconciledProcessGroups") == target &&
		nestedBool(cluster.Object, "status", "health", "available") && nestedBool(cluster.Object, "status", "health", "healthy") &&
		nestedBool(cluster.Object, "status", "health", "fullReplication")
	if nestedInt64(cluster.Object, "spec", "processCounts", "storage") == target {
		phase = "Scaling"
		message = "FoundationDB Operator is reconciling and redistributing the target process groups"
	}
	if clusterAtTarget {
		backupReady, err := r.scaleOperationBackupReady(ctx, cell, operation)
		if err != nil {
			return true, err
		}
		if !backupReady {
			phase = "Verifying"
			message = "target is reconciled; waiting for a fresh Restorable backup report"
		} else if direction == "Down" {
			ready, selected, err := r.ensureVolumeRetirements(ctx, cell, cluster, operation)
			if err != nil {
				return true, err
			}
			if !ready {
				phase = "QuarantiningVolumes"
				message = "target is healthy; waiting for retired PVs to enter Released quarantine"
			} else {
				capacityReady, snapshot, err := r.reconcileTKECapacityFloor(ctx, cell, operation, target, true)
				if err != nil {
					return true, err
				}
				if !capacityReady {
					return true, r.updateScaleOperationProgress(ctx, operation, cluster, "ReclaimingCapacity",
						"retired volumes are quarantined; waiting for TKE to remove the empty nodes", snapshot)
				}
				if err := unstructured.SetNestedMap(operation.Object, snapshot, "status", "nodeCapacity"); err != nil {
					return true, err
				}
				return false, r.completeFDBScaleOperation(ctx, operation, cluster, selected)
			}
		} else {
			return false, r.completeFDBScaleOperation(ctx, operation, cluster, nil)
		}
	}
	status := map[string]any{
		"observedGeneration": operation.GetGeneration(), "phase": phase,
		"foundationDBGeneration": cluster.GetGeneration(),
	}
	if nodeCapacitySnapshot != nil {
		status["nodeCapacity"] = nodeCapacitySnapshot
	} else if capacity, found, _ := unstructured.NestedMap(operation.Object, "status", "nodeCapacity"); found {
		status["nodeCapacity"] = capacity
	}
	if selected, found, _ := unstructured.NestedSlice(operation.Object, "spec", "selectedProcessGroups"); found {
		status["selectedProcessGroups"] = selected
	}
	if clusterAtTarget {
		targetReadyAt := nestedString(operation.Object, "status", "targetReadyAt")
		if targetReadyAt == "" {
			targetReadyAt = time.Now().UTC().Format(time.RFC3339)
		}
		status["targetReadyAt"] = targetReadyAt
	}
	status["conditions"] = []any{scaleOperationProgressCondition(operation, phase, message)}
	if err := r.updateScaleOperationStatus(ctx, operation, status); err != nil {
		return true, err
	}
	// A freshly-created operation must be persisted before the provider changes
	// the FoundationDBCluster target, but Pending must not block that target
	// publication on the following reconcile.
	return nestedInt64(cluster.Object, "spec", "processCounts", "storage") == target, nil
}

func (r *FDBKubernetesReconciler) publishFDBScaleDownTarget(ctx context.Context, operation, cluster *unstructured.Unstructured, target int64) error {
	from := nestedInt64(operation.Object, "spec", "fromProcessCount")
	selected, _, err := unstructured.NestedStringSlice(operation.Object, "spec", "selectedProcessGroups")
	if err != nil || int64(len(selected)) != from-target {
		return fmt.Errorf("FDBScaleOperation %s has no complete topology-balanced removal plan", operation.GetName())
	}
	current := nestedInt64(cluster.Object, "spec", "processCounts", "storage")
	if current != from {
		return fmt.Errorf("refusing to publish FDB scale-down %d -> %d from unexpected live target %d", from, target, current)
	}
	existing, _, err := unstructured.NestedStringSlice(cluster.Object, "spec", "processGroupsToRemove")
	if err != nil {
		return fmt.Errorf("read existing FoundationDB removal plan: %w", err)
	}
	if len(existing) != 0 {
		return fmt.Errorf("refusing to replace existing FoundationDB removal plan %v", existing)
	}
	before := cluster.DeepCopy()
	if err := unstructured.SetNestedField(cluster.Object, target, "spec", "processCounts", "storage"); err != nil {
		return err
	}
	if err := unstructured.SetNestedField(cluster.Object, target, "spec", "databaseConfiguration", "storage"); err != nil {
		return err
	}
	if err := unstructured.SetNestedStringSlice(cluster.Object, selected, "spec", "processGroupsToRemove"); err != nil {
		return err
	}
	if err := r.Client.Patch(ctx, cluster, client.MergeFrom(before)); err != nil {
		return fmt.Errorf("publish topology-balanced FoundationDB scale-down target: %w", err)
	}
	return nil
}

func (r *FDBKubernetesReconciler) updateScaleOperationProgress(ctx context.Context, operation, cluster *unstructured.Unstructured, phase, message string, capacity map[string]any) error {
	status := map[string]any{
		"observedGeneration": operation.GetGeneration(), "phase": phase,
		"foundationDBGeneration": cluster.GetGeneration(),
		"conditions":             []any{scaleOperationProgressCondition(operation, phase, message)},
	}
	if capacity != nil {
		status["nodeCapacity"] = capacity
	} else if existing, found, _ := unstructured.NestedMap(operation.Object, "status", "nodeCapacity"); found {
		status["nodeCapacity"] = existing
	}
	if selected, found, _ := unstructured.NestedSlice(operation.Object, "spec", "selectedProcessGroups"); found {
		status["selectedProcessGroups"] = selected
	}
	return r.updateScaleOperationStatus(ctx, operation, status)
}

func tkeNodeCapacityRef(profile *unstructured.Unstructured) (map[string]any, error) {
	settings, found, _ := unstructured.NestedMap(profile.Object, "spec", "foundationDB", "kubernetes", "nodeCapacity")
	if !found {
		return nil, fmt.Errorf("automatic Kubernetes FDB autoscaling requires foundationDB.kubernetes.nodeCapacity")
	}
	provider := nestedString(settings, "provider")
	name := nestedString(settings, "machineSetName")
	processesPerNode := nestedInt64(settings, "processesPerNode")
	if provider != FDBNodeCapacityTKE || name == "" || processesPerNode != 1 {
		return nil, fmt.Errorf("unsupported FDB node capacity provider %q or invalid one-process-per-node contract", provider)
	}
	return map[string]any{"provider": provider, "machineSetName": name, "processesPerNode": processesPerNode}, nil
}

func (r *FDBKubernetesReconciler) reconcileAuxiliaryFDBCapacity(ctx context.Context, cell, cluster, profile *unstructured.Unstructured) error {
	nodeCapacityRef, err := tkeNodeCapacityRef(profile)
	if err != nil {
		return err
	}
	// Reuse the same MachineSet identity, ceiling, and auxiliary-Pod accounting
	// as a primary FDB scale operation. This in-memory request is not a second
	// durable operation or a second capacity owner.
	request := object(fdbScaleOperationGVK)
	request.SetName(cell.GetName() + "-auxiliary-capacity")
	request.Object["spec"] = map[string]any{
		"foundationDBClusterRef": map[string]any{"name": cluster.GetName()},
		"nodeCapacityRef":        nodeCapacityRef,
	}
	_, _, err = r.reconcileTKECapacityFloor(ctx, cell, request, nestedInt64(cluster.Object, "spec", "processCounts", "storage"), false)
	if err != nil {
		return fmt.Errorf("reserve auxiliary FDB storage capacity: %w", err)
	}
	return nil
}

// reconcileTKECapacityFloor is the single desired-capacity owner for the
// dedicated FDB MachineSet. It writes the exact replica target and matching
// autoscaling floor: up immediately before publishing the FDB Pod demand, and
// down only after FDB has drained the process groups and their CBS volumes are
// quarantined. TKE's MachineSet controller still owns node creation, deletion
// and ZoneEquality placement.
func (r *FDBKubernetesReconciler) reconcileTKECapacityFloor(ctx context.Context, cell, operation *unstructured.Unstructured, processTarget int64, scaleDown bool) (bool, map[string]any, error) {
	provider := nestedString(operation.Object, "spec", "nodeCapacityRef", "provider")
	name := nestedString(operation.Object, "spec", "nodeCapacityRef", "machineSetName")
	processesPerNode := nestedInt64(operation.Object, "spec", "nodeCapacityRef", "processesPerNode")
	if provider != FDBNodeCapacityTKE || name == "" || processesPerNode != 1 {
		return false, nil, fmt.Errorf("FDBScaleOperation %s has no supported node capacity binding", operation.GetName())
	}
	// The MachineSet is dedicated to the Cell's FDB estate, not necessarily to
	// one FoundationDBCluster. Disaster-recovery restores and other auxiliary
	// clusters can coexist in the namespace. Reserve one node for every such
	// storage process and round the total to a three-zone cardinality before
	// touching the MachineSet. This prevents a primary 12 -> 9 contraction from
	// evicting a live three-process restore cluster or silently overpacking it.
	storagePods := &corev1.PodList{}
	if err := r.Client.List(ctx, storagePods, client.InNamespace(cell.GetNamespace()), client.MatchingLabels{
		"foundationdb.org/fdb-process-class": "storage",
	}); err != nil {
		return false, nil, fmt.Errorf("list auxiliary FDB storage Pods for node capacity: %w", err)
	}
	targetCluster := nestedString(operation.Object, "spec", "foundationDBClusterRef", "name")
	if targetCluster == "" {
		targetCluster = cell.GetName()
	}
	auxiliaryStorageProcesses := int64(0)
	for i := range storagePods.Items {
		pod := &storagePods.Items[i]
		if pod.DeletionTimestamp == nil && pod.Labels["foundationdb.org/fdb-cluster-name"] != targetCluster {
			auxiliaryStorageProcesses++
		}
	}
	nodeTarget := processTarget + auxiliaryStorageProcesses
	if remainder := nodeTarget % 3; remainder != 0 {
		nodeTarget += 3 - remainder
	}
	machineSet := object(tkeMachineSetGVK)
	if err := r.Client.Get(ctx, types.NamespacedName{Name: name}, machineSet); err != nil {
		return false, nil, fmt.Errorf("get TKE MachineSet %q: %w", name, err)
	}
	labels, _, _ := unstructured.NestedStringMap(machineSet.Object, "spec", "template", "spec", "metadata", "labels")
	if nestedString(machineSet.Object, "spec", "type") != "Native" ||
		nestedString(machineSet.Object, "spec", "scaling", "createPolicy") != "ZoneEquality" ||
		nestedString(machineSet.Object, "spec", "deletePolicy") != "Newest" ||
		labels[FDBCellNameLabel] != cell.GetName() || labels["fleet.actor.dev/fdb-dedicated"] != "true" {
		return false, nil, fmt.Errorf("TKE MachineSet %q violates the dedicated three-zone FDB capacity contract", name)
	}
	maximum := nestedInt64(machineSet.Object, "spec", "scaling", "maxReplicas")
	if processTarget < 9 || processTarget%3 != 0 || maximum < nodeTarget {
		return false, nil, fmt.Errorf("TKE MachineSet %q cannot supply primary FDB target %d plus %d auxiliary storage processes within maxReplicas=%d", name, processTarget, auxiliaryStorageProcesses, maximum)
	}
	minimum := nestedInt64(machineSet.Object, "spec", "scaling", "minReplicas")
	desired := nestedInt64(machineSet.Object, "spec", "replicas")
	moveTarget := (scaleDown && (minimum != nodeTarget || desired != nodeTarget)) ||
		(!scaleDown && (minimum < nodeTarget || desired < nodeTarget))
	if moveTarget {
		before := machineSet.DeepCopy()
		if err := unstructured.SetNestedField(machineSet.Object, nodeTarget, "spec", "scaling", "minReplicas"); err != nil {
			return false, nil, err
		}
		if err := unstructured.SetNestedField(machineSet.Object, nodeTarget, "spec", "replicas"); err != nil {
			return false, nil, err
		}
		if err := r.Client.Patch(ctx, machineSet, client.MergeFrom(before)); err != nil {
			return false, nil, fmt.Errorf("patch TKE MachineSet %q capacity target: %w", name, err)
		}
		minimum = nodeTarget
		desired = nodeTarget
	}
	ready := nestedInt64(machineSet.Object, "status", "readyReplicas")
	available := nestedInt64(machineSet.Object, "status", "availableReplicas")
	replicas := nestedInt64(machineSet.Object, "status", "replicas")
	snapshot := map[string]any{
		"provider": provider, "machineSetName": name, "desiredNodes": nodeTarget,
		"primaryStorageProcesses": processTarget, "auxiliaryStorageProcesses": auxiliaryStorageProcesses,
		"minReplicas": minimum, "maxReplicas": maximum, "specReplicas": desired, "replicas": replicas,
		"readyReplicas": ready, "availableReplicas": available,
		"generation": machineSet.GetGeneration(), "observedGeneration": nestedInt64(machineSet.Object, "status", "observedGeneration"),
	}
	if scaleDown {
		return replicas <= nodeTarget && ready <= nodeTarget && available <= nodeTarget, snapshot, nil
	}
	return replicas >= nodeTarget && ready >= nodeTarget && available >= nodeTarget, snapshot, nil
}

func scaleOperationProgressCondition(operation *unstructured.Unstructured, phase, message string) map[string]any {
	transition := time.Now().UTC().Format(time.RFC3339)
	conditions, _, _ := unstructured.NestedSlice(operation.Object, "status", "conditions")
	if nestedString(operation.Object, "status", "phase") == phase && len(conditions) == 1 {
		if existing, ok := conditions[0].(map[string]any); ok && nestedString(existing, "lastTransitionTime") != "" {
			transition = nestedString(existing, "lastTransitionTime")
		}
	}
	return map[string]any{
		"type": "Progressing", "status": "True", "reason": phase, "message": message,
		"observedGeneration": operation.GetGeneration(), "lastTransitionTime": transition,
	}
}

func (r *FDBKubernetesReconciler) scaleOperationBackupReady(ctx context.Context, cell, operation *unstructured.Unstructured) (bool, error) {
	targetReadyAt, err := time.Parse(time.RFC3339, nestedString(operation.Object, "status", "targetReadyAt"))
	if err != nil {
		// Force at least one fresh reporter pass after the operator first reaches
		// the target. A merely recent pre-scale Restorable report is not evidence
		// for the new topology.
		return false, nil
	}
	report := object(reportGVK)
	if err := r.Client.Get(ctx, types.NamespacedName{Name: cell.GetName(), Namespace: cell.GetNamespace()}, report); err != nil {
		if apierrors.IsNotFound(err) {
			return false, nil
		}
		return false, fmt.Errorf("get scale-operation RivetCellReport: %w", err)
	}
	observedAt, err := time.Parse(time.RFC3339, nestedString(report.Object, "spec", "observedAt"))
	return err == nil && time.Since(observedAt) <= DefaultReportFreshness &&
		!observedAt.Before(targetReadyAt) &&
		nestedInt64(report.Object, "spec", "observedCellGeneration") == cell.GetGeneration() &&
		nestedBool(report.Object, "spec", "health", "backupReady"), nil
}

func (r *FDBKubernetesReconciler) ensureVolumeRetirements(ctx context.Context, cell, cluster, operation *unstructured.Unstructured) (bool, []string, error) {
	items, _, _ := unstructured.NestedSlice(operation.Object, "spec", "volumeInventory")
	expected := nestedInt64(operation.Object, "spec", "fromProcessCount") - nestedInt64(operation.Object, "spec", "toProcessCount")
	selected := make([]string, 0, expected)
	allReady := true
	for _, item := range items {
		volume, ok := item.(map[string]any)
		if !ok {
			return false, nil, fmt.Errorf("FDBScaleOperation %s has malformed volume inventory", operation.GetName())
		}
		pvcName := nestedString(volume, "pvcName")
		pvc := &corev1.PersistentVolumeClaim{}
		if err := r.Client.Get(ctx, types.NamespacedName{Name: pvcName, Namespace: cell.GetNamespace()}, pvc); err == nil {
			continue
		} else if !apierrors.IsNotFound(err) {
			return false, nil, err
		}
		processGroup := nestedString(volume, "processGroupID")
		selected = append(selected, processGroup)
		pv := &corev1.PersistentVolume{}
		if err := r.Client.Get(ctx, types.NamespacedName{Name: nestedString(volume, "pvName")}, pv); err != nil {
			return false, nil, fmt.Errorf("get retired PV for %s: %w", processGroup, err)
		}
		if string(pv.UID) != nestedString(volume, "pvUID") || pv.Status.Phase != corev1.VolumeReleased ||
			pv.Annotations[FDBVolumeProcessGroup] != processGroup || pv.Annotations[FDBVolumeCBSDiskID] != nestedString(volume, "cbsDiskID") {
			allReady = false
			continue
		}
		if err := r.ensureVolumeRetirement(ctx, cell, cluster, operation, volume); err != nil {
			return false, nil, err
		}
	}
	if int64(len(selected)) != expected {
		allReady = false
	}
	sort.Strings(selected)
	planned, _, err := unstructured.NestedStringSlice(operation.Object, "spec", "selectedProcessGroups")
	if err != nil {
		return false, nil, err
	}
	sort.Strings(planned)
	if len(planned) > 0 && !equality.Semantic.DeepEqual(planned, selected) {
		return false, nil, fmt.Errorf("FDBScaleOperation %s retired process groups %v, planned %v", operation.GetName(), selected, planned)
	}
	return allReady, selected, nil
}

func (r *FDBKubernetesReconciler) ensureVolumeRetirement(ctx context.Context, cell, cluster, operation *unstructured.Unstructured, volume map[string]any) error {
	processGroup := nestedString(volume, "processGroupID")
	name := operation.GetName() + "-" + strings.TrimPrefix(processGroup, "storage-")
	key := types.NamespacedName{Name: name, Namespace: cell.GetNamespace()}
	existing := object(fdbVolumeRetirementGVK)
	if err := r.Client.Get(ctx, key, existing); err == nil {
		return nil
	} else if !apierrors.IsNotFound(err) {
		return err
	}
	retirement := object(fdbVolumeRetirementGVK)
	retirement.SetName(name)
	retirement.SetNamespace(cell.GetNamespace())
	retirement.SetLabels(map[string]string{FDBCellNameLabel: cell.GetName(), FDBCellUIDLabel: string(cell.GetUID()), "app.kubernetes.io/managed-by": "actor-fleet-controller"})
	retirement.Object["spec"] = map[string]any{
		"cellRef":                map[string]any{"name": cell.GetName(), "uid": string(cell.GetUID())},
		"foundationDBClusterRef": map[string]any{"name": cluster.GetName(), "uid": string(cluster.GetUID())},
		"scaleOperationRef":      map[string]any{"name": operation.GetName(), "uid": string(operation.GetUID())},
		"processGroupID":         processGroup,
		"pvcRef":                 map[string]any{"name": nestedString(volume, "pvcName"), "uid": nestedString(volume, "pvcUID")},
		"pvRef":                  map[string]any{"name": nestedString(volume, "pvName"), "uid": nestedString(volume, "pvUID")},
		"cbsDiskID":              nestedString(volume, "cbsDiskID"), "csiDriver": "com.tencent.cloud.csi.cbs",
		"quarantineSeconds": nestedInt64(operation.Object, "spec", "volumeRetentionSeconds"),
		"gcMode":            nestedString(operation.Object, "spec", "volumeGCMode"),
	}
	return r.Client.Create(ctx, retirement)
}

func (r *FDBKubernetesReconciler) completeFDBScaleOperation(ctx context.Context, operation, cluster *unstructured.Unstructured, selected []string) error {
	receipt := map[string]any{
		"operationUID": string(operation.GetUID()), "spec": operation.Object["spec"],
		"foundationDBGeneration": cluster.GetGeneration(), "selectedProcessGroups": selected,
		"available": true, "healthy": true, "fullReplication": true,
	}
	payload, err := json.Marshal(receipt)
	if err != nil {
		return err
	}
	digest := sha256.Sum256(payload)
	selectedAny := make([]any, 0, len(selected))
	for _, value := range selected {
		selectedAny = append(selectedAny, value)
	}
	status := map[string]any{
		"observedGeneration": operation.GetGeneration(), "phase": "Succeeded", "foundationDBGeneration": cluster.GetGeneration(),
		"selectedProcessGroups": selectedAny,
		"receiptRef":            fmt.Sprintf("kubernetes://%s/fdbscaleoperations/%s", operation.GetNamespace(), operation.GetName()),
		"receiptDigest":         fmt.Sprintf("sha256:%x", digest[:]),
		"conditions": []any{map[string]any{
			"type": "Succeeded", "status": "True", "reason": "Verified", "message": "FDB target, full replication, backup and retired-volume inventory gates passed",
			"observedGeneration": operation.GetGeneration(), "lastTransitionTime": time.Now().UTC().Format(time.RFC3339),
		}},
	}
	if capacity, found, _ := unstructured.NestedMap(operation.Object, "status", "nodeCapacity"); found {
		status["nodeCapacity"] = capacity
	}
	return r.updateScaleOperationStatus(ctx, operation, status)
}

func (r *FDBKubernetesReconciler) updateScaleOperationStatus(ctx context.Context, operation *unstructured.Unstructured, status map[string]any) error {
	current, _, _ := unstructured.NestedMap(operation.Object, "status")
	if equality.Semantic.DeepEqual(current, status) {
		return nil
	}
	updated := operation.DeepCopy()
	if err := unstructured.SetNestedMap(updated.Object, status, "status"); err != nil {
		return err
	}
	if err := r.Client.Status().Update(ctx, updated); err != nil {
		return fmt.Errorf("update FDBScaleOperation status: %w", err)
	}
	return nil
}

func (r *FDBKubernetesReconciler) reconcileFDBVolumeInventory(ctx context.Context, cell, cluster *unstructured.Unstructured, expectedStorageClass string) ([]FDBVolumeInventory, error) {
	pvcs := &corev1.PersistentVolumeClaimList{}
	if err := r.Client.List(ctx, pvcs, client.InNamespace(cell.GetNamespace()), client.MatchingLabels{
		"foundationdb.org/fdb-cluster-name":  cluster.GetName(),
		"foundationdb.org/fdb-process-class": "storage",
	}); err != nil {
		return nil, fmt.Errorf("list FDB PVCs for volume inventory: %w", err)
	}
	inventory := make([]FDBVolumeInventory, 0, len(pvcs.Items))
	seen := make(map[string]struct{}, len(pvcs.Items))
	for i := range pvcs.Items {
		pvc := &pvcs.Items[i]
		processGroup := pvc.Labels["foundationdb.org/fdb-process-group-id"]
		if processGroup == "" || pvc.Spec.VolumeName == "" || pvc.Status.Phase != corev1.ClaimBound {
			continue
		}
		if _, duplicate := seen[processGroup]; duplicate {
			return nil, fmt.Errorf("multiple bound PVCs claim FDB process group %s", processGroup)
		}
		seen[processGroup] = struct{}{}
		if pvc.Spec.StorageClassName == nil || *pvc.Spec.StorageClassName != expectedStorageClass {
			return nil, fmt.Errorf("FDB PVC %s uses unexpected StorageClass", pvc.Name)
		}
		pv := &corev1.PersistentVolume{}
		if err := r.Client.Get(ctx, types.NamespacedName{Name: pvc.Spec.VolumeName}, pv); err != nil {
			return nil, fmt.Errorf("get FDB PV %s: %w", pvc.Spec.VolumeName, err)
		}
		if pv.Spec.ClaimRef == nil || pv.Spec.ClaimRef.UID != pvc.UID || pv.Spec.PersistentVolumeReclaimPolicy != corev1.PersistentVolumeReclaimRetain ||
			pv.Spec.CSI == nil || pv.Spec.CSI.Driver != "com.tencent.cloud.csi.cbs" || !strings.HasPrefix(pv.Spec.CSI.VolumeHandle, "disk-") {
			return nil, fmt.Errorf("FDB PV %s does not satisfy retained Tencent CBS identity gates", pv.Name)
		}
		before := pv.DeepCopy()
		if pv.Labels == nil {
			pv.Labels = map[string]string{}
		}
		if pv.Annotations == nil {
			pv.Annotations = map[string]string{}
		}
		pv.Labels[FDBVolumeManagedLabel] = "true"
		pv.Labels[FDBCellNameLabel] = cell.GetName()
		pv.Labels[FDBCellNamespaceLabel] = cell.GetNamespace()
		pv.Annotations[FDBVolumeCellUID] = string(cell.GetUID())
		pv.Annotations[FDBVolumeClusterUID] = string(cluster.GetUID())
		pv.Annotations[FDBVolumeProcessGroup] = processGroup
		pv.Annotations[FDBVolumePVCUID] = string(pvc.UID)
		pv.Annotations[FDBVolumeCBSDiskID] = pv.Spec.CSI.VolumeHandle
		if !equality.Semantic.DeepEqual(before.Labels, pv.Labels) || !equality.Semantic.DeepEqual(before.Annotations, pv.Annotations) {
			if err := r.Client.Patch(ctx, pv, client.MergeFrom(before)); err != nil {
				return nil, fmt.Errorf("stamp FDB PV %s inventory identity: %w", pv.Name, err)
			}
		}
		inventory = append(inventory, FDBVolumeInventory{
			ProcessGroupID: processGroup, PVCName: pvc.Name, PVCUID: string(pvc.UID),
			PVName: pv.Name, PVUID: string(pv.UID), CBSDiskID: pv.Spec.CSI.VolumeHandle,
		})
	}
	sort.Slice(inventory, func(i, j int) bool { return inventory[i].ProcessGroupID < inventory[j].ProcessGroupID })
	return inventory, nil
}

func setFDBUseDNSInClusterFile(cluster *unstructured.Unstructured, enabled bool) {
	spec, _, _ := unstructured.NestedMap(cluster.Object, "spec")
	routing, _, _ := unstructured.NestedMap(spec, "routing")
	if routing == nil {
		routing = map[string]any{}
	}
	routing["useDNSInClusterFile"] = enabled
	spec["routing"] = routing
	cluster.Object["spec"] = spec
}

func (r *FDBKubernetesReconciler) SetupWithManager(manager ctrl.Manager) error {
	mapToCell := handler.EnqueueRequestsFromMapFunc(func(_ context.Context, resource client.Object) []reconcile.Request {
		name := resource.GetLabels()[FDBCellNameLabel]
		namespace := resource.GetLabels()[FDBCellNamespaceLabel]
		if name == "" || namespace == "" {
			return nil
		}
		return []reconcile.Request{{NamespacedName: types.NamespacedName{Name: name, Namespace: namespace}}}
	})
	mapPVCToCell := handler.EnqueueRequestsFromMapFunc(func(_ context.Context, resource client.Object) []reconcile.Request {
		name := resource.GetLabels()["foundationdb.org/fdb-cluster-name"]
		if name == "" || resource.GetNamespace() == "" {
			return nil
		}
		return []reconcile.Request{{NamespacedName: types.NamespacedName{Name: name, Namespace: resource.GetNamespace()}}}
	})
	return ctrl.NewControllerManagedBy(manager).
		Named("rivetcell-foundationdbcluster").
		For(object(cellGVK)).
		Watches(object(fdbClusterGVK), mapToCell).
		Watches(object(fdbPodDisruptionBudgetGVK), mapToCell).
		Watches(&corev1.PersistentVolumeClaim{}, mapPVCToCell).
		Watches(&corev1.PersistentVolume{}, mapToCell).
		Complete(r)
}

func (r *FDBKubernetesReconciler) reconcilePodDisruptionBudget(ctx context.Context, desired, cell *unstructured.Unstructured) error {
	actual := object(fdbPodDisruptionBudgetGVK)
	key := types.NamespacedName{Name: desired.GetName(), Namespace: desired.GetNamespace()}
	if err := r.Client.Get(ctx, key, actual); apierrors.IsNotFound(err) {
		if err := r.Client.Create(ctx, desired); err != nil {
			return fmt.Errorf("create FoundationDB PodDisruptionBudget: %w", err)
		}
		return nil
	} else if err != nil {
		return fmt.Errorf("get FoundationDB PodDisruptionBudget: %w", err)
	}
	if actual.GetLabels()[FDBCellUIDLabel] != string(cell.GetUID()) {
		return fmt.Errorf("PodDisruptionBudget %s/%s is not bound to Cell UID %s", key.Namespace, key.Name, cell.GetUID())
	}
	desiredSpec, _, _ := unstructured.NestedMap(desired.Object, "spec")
	actualSpec, _, _ := unstructured.NestedMap(actual.Object, "spec")
	if equality.Semantic.DeepDerivative(desiredSpec, actualSpec) && equality.Semantic.DeepDerivative(desired.GetLabels(), actual.GetLabels()) {
		return nil
	}
	before := actual.DeepCopy()
	if err := unstructured.SetNestedMap(actual.Object, desiredSpec, "spec"); err != nil {
		return fmt.Errorf("set FoundationDB PodDisruptionBudget spec: %w", err)
	}
	labels := actual.GetLabels()
	if labels == nil {
		labels = map[string]string{}
	}
	for key, value := range desired.GetLabels() {
		labels[key] = value
	}
	actual.SetLabels(labels)
	if err := r.Client.Patch(ctx, actual, client.MergeFrom(before)); err != nil {
		return fmt.Errorf("patch FoundationDB PodDisruptionBudget: %w", err)
	}
	return nil
}

func (r *FDBKubernetesReconciler) profileForCell(ctx context.Context, cell *unstructured.Unstructured) (*unstructured.Unstructured, string, bool, error) {
	className := nestedString(cell.Object, "spec", "className")
	class := object(classGVK)
	if err := r.Client.Get(ctx, types.NamespacedName{Name: className}, class); err != nil {
		return nil, "", false, fmt.Errorf("get ShardClass %q: %w", className, err)
	}
	if nestedString(class.Object, "spec", "controllerName") != ControllerName {
		return nil, "", false, nil
	}
	profileName := nestedString(class.Object, "spec", "profileRef", "name")
	profile := object(profileGVK)
	if err := r.Client.Get(ctx, types.NamespacedName{Name: profileName}, profile); err != nil {
		return nil, "", false, fmt.Errorf("get RivetCellProfile %q: %w", profileName, err)
	}
	return profile, nestedString(class.Object, "spec", "profileRef", "digest"), true, nil
}

func foundationDBClusterForCell(cell, profile *unstructured.Unstructured, profileDigest string) (*unstructured.Unstructured, error) {
	clusterName := nestedString(cell.Object, "spec", "foundationDB", "clusterRef", "name")
	clusterNamespace := nestedString(cell.Object, "spec", "foundationDB", "clusterRef", "namespace")
	processCount := desiredFDBProcessCount(cell, profile)
	if clusterName == "" || len(clusterName) > 220 || clusterNamespace == "" || processCount < 1 {
		return nil, fmt.Errorf("invalid Kubernetes FDB Cell binding or process count")
	}
	zoneCount := nestedInt64(profile.Object, "spec", "topology", "zoneCount")
	zoneLabelKey := nestedString(profile.Object, "spec", "topology", "zoneLabelKey")
	topologyMaxSkew := nestedInt64(profile.Object, "spec", "topology", "maxSkew")
	topologyWhenUnsatisfiable := nestedString(profile.Object, "spec", "topology", "whenUnsatisfiable")
	coordinatorCount := nestedInt64(profile.Object, "spec", "foundationDB", "coordinatorCount")
	if nestedString(profile.Object, "spec", "foundationDB", "redundancyMode") == "three_data_hall" &&
		(processCount < 9 || coordinatorCount != 9 || zoneCount != 3 || processCount%zoneCount != 0) {
		return nil, fmt.Errorf("FoundationDB Operator three_data_hall requires at least 9 hostname fault domains, 9 coordinators, and an even per-zone process distribution")
	}
	if zoneLabelKey != "topology.kubernetes.io/zone" || topologyMaxSkew != 1 || topologyWhenUnsatisfiable != "DoNotSchedule" {
		return nil, fmt.Errorf("Kubernetes FDB topology must use the standard zone label with maxSkew 1 and hard scheduling")
	}

	kubernetesSettings, found, _ := unstructured.NestedMap(profile.Object, "spec", "foundationDB", "kubernetes")
	if !found {
		return nil, fmt.Errorf("Kubernetes FDB profile has no kubernetes settings")
	}
	nodeSelector, found, _ := unstructured.NestedStringMap(kubernetesSettings, "nodeSelector")
	if !found || len(nodeSelector) == 0 {
		return nil, fmt.Errorf("Kubernetes FDB profile requires a non-empty node selector")
	}
	placementMode := nestedString(kubernetesSettings, "placementMode")
	if placementMode != "MixedEligibleNodes" && placementMode != "DedicatedNodes" {
		return nil, fmt.Errorf("unsupported Kubernetes FDB placement mode %q", placementMode)
	}
	if nestedString(kubernetesSettings, "resources", "cpuRequest") != nestedString(kubernetesSettings, "resources", "cpuLimit") ||
		nestedString(kubernetesSettings, "resources", "memoryRequest") != nestedString(kubernetesSettings, "resources", "memoryLimit") {
		return nil, fmt.Errorf("Kubernetes FDB resources must use equal requests and limits for Guaranteed QoS")
	}
	version := nestedString(profile.Object, "spec", "foundationDB", "version")
	imageRepository := nestedString(kubernetesSettings, "imageRepository")
	imageTagDigest := nestedString(kubernetesSettings, "imageTagDigest")
	if imageRepository == "" || !strings.HasPrefix(imageTagDigest, version+"@sha256:") || len(strings.TrimPrefix(imageTagDigest, version+"@sha256:")) != 64 {
		return nil, fmt.Errorf("Kubernetes FDB unified image must be pinned as the profile version plus an sha256 digest")
	}
	nodeSelector[FDBCellNameLabel] = cell.GetName()

	clusterSelector := map[string]any{"matchLabels": map[string]any{
		"foundationdb.org/fdb-cluster-name": clusterName,
	}}
	container := map[string]any{
		"name": "foundationdb",
		"env":  []any{map[string]any{"name": "ENABLE_NODE_WATCH", "value": "true"}},
		"securityContext": map[string]any{
			"allowPrivilegeEscalation": false,
			"capabilities":             map[string]any{"drop": []any{"ALL"}},
		},
		"resources": map[string]any{
			"requests": map[string]any{
				"cpu":    nestedString(kubernetesSettings, "resources", "cpuRequest"),
				"memory": nestedString(kubernetesSettings, "resources", "memoryRequest"),
			},
			"limits": map[string]any{
				"cpu":    nestedString(kubernetesSettings, "resources", "cpuLimit"),
				"memory": nestedString(kubernetesSettings, "resources", "memoryLimit"),
			},
		},
	}

	mainContainer := map[string]any{
		"imageConfigs": []any{map[string]any{
			"baseImage": imageRepository,
			"tag":       imageTagDigest,
		}},
	}
	spec := map[string]any{
		"version":       version,
		"imageType":     nestedString(kubernetesSettings, "imageType"),
		"faultDomain":   map[string]any{"key": nestedString(kubernetesSettings, "faultDomainKey")},
		"mainContainer": mainContainer,
		"processCounts": map[string]any{
			// The operator excludes non-stateful process classes from coordinator
			// selection and does not provision PVCs for them. Using unset here
			// deadlocks initial cluster-file generation before FDB can recruit any
			// roles. All nine dedicated processes are storage-class so they are
			// eligible coordinators and receive the profile's durable volume.
			"storage": processCount, "unset": int64(-1), "log": int64(-1), "stateless": int64(-1),
		},
		"databaseConfiguration": map[string]any{
			"redundancy_mode": nestedString(profile.Object, "spec", "foundationDB", "redundancyMode"),
			"storage_engine":  nestedString(profile.Object, "spec", "foundationDB", "storageEngine"),
			"storage":         processCount,
		},
		"minimumUptimeSecondsForBounce": int64(60),
		"useExplicitListenAddress":      true,
		"routing": map[string]any{
			// Pods must have stable DNS identities from their first creation even
			// while the initial cluster file uses Pod IP coordinators. Otherwise the
			// later DNS promotion requires replacing every Pod and can deadlock
			// coordinator selection. The reconciler only toggles
			// useDNSInClusterFile after the database is configured.
			"headlessService":         true,
			"defineDNSLocalityFields": true,
			"useDNSInClusterFile":     true,
		},
		"automationOptions": map[string]any{
			"replacements": map[string]any{"enabled": true},
		},
		"processes": map[string]any{
			"general": map[string]any{
				"customParameters": []any{
					"locality_data_hall=$NODE_LABEL_TOPOLOGY_KUBERNETES_IO_ZONE",
				},
				"volumeClaimTemplate": map[string]any{"spec": map[string]any{
					"accessModes":      []any{"ReadWriteOnce"},
					"storageClassName": nestedString(kubernetesSettings, "storageClassName"),
					"resources": map[string]any{"requests": map[string]any{
						"storage": fmt.Sprintf("%dGi", nestedInt64(profile.Object, "spec", "foundationDB", "dataDisk", "sizeGiB")),
					}},
				}},
				"podTemplate": map[string]any{
					"metadata": map[string]any{"annotations": map[string]any{
						// TKE Cluster Autoscaler may reclaim only nodes that the FDB
						// Operator has already emptied. It must never evict a live
						// stateful process merely because its node is underutilized.
						"cluster-autoscaler.kubernetes.io/safe-to-evict": "false",
					}},
					"spec": map[string]any{
						"serviceAccountName": nestedString(kubernetesSettings, "fdbServiceAccountName"),
						"imagePullSecrets": []any{map[string]any{
							"name": FDBImagePullSecretName,
						}},
						"priorityClassName": nestedString(kubernetesSettings, "priorityClassName"),
						"nodeSelector":      stringMapAny(nodeSelector),
						"affinity": map[string]any{"podAntiAffinity": map[string]any{
							"requiredDuringSchedulingIgnoredDuringExecution": []any{map[string]any{
								"labelSelector": clusterSelector,
								"topologyKey":   "kubernetes.io/hostname",
							}},
						}},
						"topologySpreadConstraints": []any{map[string]any{
							"maxSkew":           topologyMaxSkew,
							"topologyKey":       zoneLabelKey,
							"whenUnsatisfiable": topologyWhenUnsatisfiable,
							"labelSelector":     clusterSelector,
						}},
						"securityContext": map[string]any{
							"runAsUser": int64(4059), "runAsGroup": int64(4059), "fsGroup": int64(4059),
							"seccompProfile": map[string]any{"type": "RuntimeDefault"},
						},
						"containers": []any{container},
					}},
			},
		},
	}
	if placementMode == "DedicatedNodes" {
		podSpec := spec["processes"].(map[string]any)["general"].(map[string]any)["podTemplate"].(map[string]any)["spec"].(map[string]any)
		podSpec["tolerations"] = []any{map[string]any{
			"key": "fleet.actor.dev/fdb-dedicated", "operator": "Equal", "value": "true", "effect": "NoSchedule",
		}}
	}

	tlsMode := nestedString(kubernetesSettings, "tls", "mode")
	if tlsMode == "Required" {
		secretTemplate := nestedString(kubernetesSettings, "tls", "secretNameTemplate")
		secretName := strings.ReplaceAll(secretTemplate, "{clusterName}", clusterName)
		peerRules := nestedString(kubernetesSettings, "tls", "peerVerificationRules")
		if secretName == "" || strings.Contains(secretName, "{") || peerRules == "" {
			return nil, fmt.Errorf("invalid TLS secret template or peer verification rules")
		}
		mainContainer["enableTls"] = true
		mainContainer["peerVerificationRules"] = peerRules
		podSpec := spec["processes"].(map[string]any)["general"].(map[string]any)["podTemplate"].(map[string]any)["spec"].(map[string]any)
		podSpec["volumes"] = []any{map[string]any{"name": "fdb-tls", "secret": map[string]any{"secretName": secretName}}}
		container["volumeMounts"] = []any{map[string]any{"name": "fdb-tls", "mountPath": "/var/fdb-tls", "readOnly": true}}
		container["env"] = append(container["env"].([]any),
			map[string]any{"name": "FDB_TLS_CERTIFICATE_FILE", "value": "/var/fdb-tls/cert.pem"},
			map[string]any{"name": "FDB_TLS_KEY_FILE", "value": "/var/fdb-tls/key.pem"},
			map[string]any{"name": "FDB_TLS_CA_FILE", "value": "/var/fdb-tls/ca.pem"},
		)
	} else if tlsMode != "DisabledForQualification" {
		return nil, fmt.Errorf("unsupported TLS mode %q", tlsMode)
	}

	cluster := object(fdbClusterGVK)
	cluster.SetName(clusterName)
	cluster.SetNamespace(clusterNamespace)
	cluster.SetLabels(map[string]string{
		FDBCellNameLabel:      cell.GetName(),
		FDBCellNamespaceLabel: cell.GetNamespace(),
		FDBCellUIDLabel:       string(cell.GetUID()),
		FDBProfileDigestLabel: shortDigest(profileDigest),
		PoolLabel:             cell.GetLabels()[PoolLabel],
	})
	cluster.SetAnnotations(map[string]string{FDBProfileAnnotation: profileDigest})
	cluster.Object["spec"] = spec
	return cluster, nil
}

func foundationDBPodDisruptionBudgetForCell(cell, profile *unstructured.Unstructured) (*unstructured.Unstructured, error) {
	clusterName := nestedString(cell.Object, "spec", "foundationDB", "clusterRef", "name")
	processCount := desiredFDBProcessCount(cell, profile)
	if clusterName == "" || len(clusterName) > 220 || processCount < 2 {
		return nil, fmt.Errorf("invalid Kubernetes FDB Cell binding or process count for PodDisruptionBudget")
	}
	pdb := object(fdbPodDisruptionBudgetGVK)
	pdb.SetName(clusterName + "-availability")
	pdb.SetNamespace(cell.GetNamespace())
	pdb.SetLabels(map[string]string{
		FDBCellNameLabel:               cell.GetName(),
		FDBCellNamespaceLabel:          cell.GetNamespace(),
		FDBCellUIDLabel:                string(cell.GetUID()),
		"app.kubernetes.io/managed-by": "actor-fleet-controller",
	})
	pdb.Object["spec"] = map[string]any{
		"minAvailable": processCount - 1,
		"selector": map[string]any{"matchLabels": map[string]any{
			"foundationdb.org/fdb-cluster-name": clusterName,
		}},
	}
	return pdb, nil
}

func observeFDBKubernetesCluster(ctx context.Context, kubeClient client.Client, in *CellInput, cell, profile *unstructured.Unstructured) error {
	if nestedString(profile.Object, "spec", "foundationDB", "supervisor") != FDBKubernetesSupervisor {
		return nil
	}
	in.FDBOperatorRequired = true
	name := nestedString(cell.Object, "spec", "foundationDB", "clusterRef", "name")
	namespace := nestedString(cell.Object, "spec", "foundationDB", "clusterRef", "namespace")
	uid := nestedString(cell.Object, "spec", "foundationDB", "clusterRef", "uid")
	if name == "" || namespace == "" {
		in.FDBOperatorReason = "ReferenceMissing"
		in.FDBOperatorMessage = "Cell has no FoundationDBCluster reference"
		return nil
	}
	cluster := object(fdbClusterGVK)
	if err := kubeClient.Get(ctx, types.NamespacedName{Name: name, Namespace: namespace}, cluster); err != nil {
		if apierrors.IsNotFound(err) {
			in.FDBOperatorReason = "ClusterMissing"
			in.FDBOperatorMessage = "the referenced FoundationDBCluster does not exist"
			return nil
		}
		return fmt.Errorf("observe FoundationDBCluster: %w", err)
	}
	in.FDBOperatorFound = true
	if uid == "" || uid != string(cluster.GetUID()) || cluster.GetLabels()[FDBCellUIDLabel] != string(cell.GetUID()) {
		in.FDBOperatorReason = "IdentityMismatch"
		in.FDBOperatorMessage = "FoundationDBCluster UID or Cell binding label does not match"
		return nil
	}
	connectionString := nestedString(cluster.Object, "status", "connectionString")
	observedIdentity := databaseIdentityHash(string(cluster.GetUID()), connectionString)
	boundIdentity := nestedString(cell.Object, "spec", "foundationDB", "clusterIdentityHash")
	if observedIdentity == "" || boundIdentity == "" {
		in.FDBOperatorReason = "IdentityPending"
		in.FDBOperatorMessage = "FoundationDB database identity has not been observed and bound"
		return nil
	}
	if observedIdentity != boundIdentity {
		in.FDBOperatorReason = "IdentityMismatch"
		in.FDBOperatorMessage = "FoundationDB database name does not match the immutable Cell identity"
		return nil
	}
	generation := cluster.GetGeneration()
	reconciled := nestedInt64(cluster.Object, "status", "generations", "reconciled")
	desiredGroups := nestedInt64(cluster.Object, "status", "desiredProcessGroups")
	reconciledGroups := nestedInt64(cluster.Object, "status", "reconciledProcessGroups")
	wantGroups := desiredFDBProcessCount(cell, profile)
	in.ObservedFDBProcesses = nestedInt64(cluster.Object, "spec", "processCounts", "storage")
	if reconciled != generation {
		in.FDBOperatorReason = "GenerationPending"
		in.FDBOperatorMessage = fmt.Sprintf("FoundationDBCluster generation %d has only reconciled through %d", generation, reconciled)
		return nil
	}
	if desiredGroups != wantGroups || reconciledGroups != wantGroups {
		in.FDBOperatorReason = "ProcessGroupsPending"
		in.FDBOperatorMessage = fmt.Sprintf("process groups are desired=%d reconciled=%d, expected=%d", desiredGroups, reconciledGroups, wantGroups)
		return nil
	}
	if nestedString(cluster.Object, "status", "runningVersion") != nestedString(profile.Object, "spec", "foundationDB", "version") {
		in.FDBOperatorReason = "VersionPending"
		in.FDBOperatorMessage = "running FoundationDB version does not match the Cell profile"
		return nil
	}
	if !nestedBool(cluster.Object, "status", "configured") || !nestedBool(cluster.Object, "status", "health", "available") ||
		!nestedBool(cluster.Object, "status", "health", "healthy") || !nestedBool(cluster.Object, "status", "health", "fullReplication") {
		in.FDBOperatorReason = "DatabaseUnhealthy"
		in.FDBOperatorMessage = "FoundationDB is not configured, available, healthy and fully replicated"
		return nil
	}
	in.FDBOperatorReady = true
	return nil
}

func desiredFDBProcessCount(cell, profile *unstructured.Unstructured) int64 {
	baseline := nestedInt64(profile.Object, "spec", "foundationDB", "processCount")
	policy := fdbAutoscalingPolicy(profile)
	if policy.Mode == FDBAutoscalingDisabled || policy.Mode == "" {
		return baseline
	}
	desired := nestedInt64(cell.Object, "status", "foundationDBAutoscaling", "desiredProcessCount")
	if desired < policy.MinProcessCount || desired > policy.MaxProcessCount || desired%policy.StepProcessCount != 0 {
		return baseline
	}
	return desired
}

func stringMapAny(values map[string]string) map[string]any {
	result := make(map[string]any, len(values))
	for key, value := range values {
		result[key] = value
	}
	return result
}

func shortDigest(value string) string {
	value = strings.TrimPrefix(value, "sha256:")
	if len(value) > 16 {
		return value[:16]
	}
	return value
}

func databaseIdentityHash(clusterUID, connectionString string) string {
	databaseName, coordinators, found := strings.Cut(connectionString, ":")
	if clusterUID == "" || !found || databaseName == "" || !strings.Contains(coordinators, "@") {
		return ""
	}
	sum := sha256.Sum256([]byte("foundationdb-kubernetes-v1\x00" + clusterUID + "\x00" + databaseName))
	return fmt.Sprintf("sha256:%x", sum[:])
}
