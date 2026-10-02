package fleetcontroller

import (
	"context"
	"fmt"
	"os"
	"sort"
	"strings"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	storagev1 "k8s.io/api/storage/v1"
	"k8s.io/apiextensions-apiserver/pkg/apis/apiextensions"
	apiextensionsv1 "k8s.io/apiextensions-apiserver/pkg/apis/apiextensions/v1"
	crvalidation "k8s.io/apiextensions-apiserver/pkg/apiserver/validation"
	"k8s.io/apimachinery/pkg/api/equality"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
	"sigs.k8s.io/yaml"
)

func TestFoundationDBClusterForCellBuildsNineDedicatedProcessGroups(t *testing.T) {
	cell, profile := operatorTestObjects("Required")
	cluster, err := foundationDBClusterForCell(cell, profile, testDigest)
	if err != nil {
		t.Fatal(err)
	}
	if len(cluster.GetOwnerReferences()) != 0 {
		t.Fatal("durable FoundationDBCluster must not be garbage-collected with the Cell")
	}
	if !nestedBool(cluster.Object, "spec", "routing", "useDNSInClusterFile") {
		t.Fatal("steady-state FoundationDB spec must use stable DNS coordinators")
	}
	if !nestedBool(cluster.Object, "spec", "routing", "headlessService") ||
		!nestedBool(cluster.Object, "spec", "routing", "defineDNSLocalityFields") {
		t.Fatal("FoundationDB Pods must have stable DNS identities from initial creation")
	}
	if got := nestedInt64(cluster.Object, "spec", "processCounts", "storage"); got != 9 {
		t.Fatalf("storage process count = %d, want 9", got)
	}
	for _, processClass := range []string{"unset", "log", "stateless"} {
		if got := nestedInt64(cluster.Object, "spec", "processCounts", processClass); got != -1 {
			t.Fatalf("%s process count = %d, want -1", processClass, got)
		}
	}
	if got := nestedString(cluster.Object, "spec", "processes", "general", "volumeClaimTemplate", "spec", "storageClassName"); got != "actor-fdb-cbs-wffc-retain" {
		t.Fatalf("storage class = %q", got)
	}
	if got := nestedString(cluster.Object, "spec", "processes", "general", "podTemplate", "spec", "nodeSelector", FDBCellNameLabel); got != cell.GetName() {
		t.Fatalf("dynamic Cell node selector = %q", got)
	}
	if got := nestedString(cluster.Object, "spec", "processes", "general", "podTemplate", "spec", "priorityClassName"); got != "actor-fdb-critical" {
		t.Fatalf("priority class = %q", got)
	}
	pullSecrets, found, err := unstructured.NestedSlice(cluster.Object, "spec", "processes", "general", "podTemplate", "spec", "imagePullSecrets")
	if err != nil || !found || len(pullSecrets) != 1 || nestedString(pullSecrets[0].(map[string]any), "name") != FDBImagePullSecretName {
		t.Fatalf("private FDB image pull secret = %#v, found=%v, err=%v", pullSecrets, found, err)
	}
	if got := nestedString(cluster.Object, "spec", "processes", "general", "podTemplate", "metadata", "annotations", "cluster-autoscaler.kubernetes.io/safe-to-evict"); got != "false" {
		t.Fatalf("FDB Pods must fence Cluster Autoscaler eviction, got %q", got)
	}
	if tolerations, found, _ := unstructured.NestedSlice(cluster.Object, "spec", "processes", "general", "podTemplate", "spec", "tolerations"); found || len(tolerations) != 0 {
		t.Fatalf("mixed-node profile unexpectedly tolerates the dedicated-node taint: %#v", tolerations)
	}
	if !nestedBool(cluster.Object, "spec", "mainContainer", "enableTls") {
		t.Fatal("production profile did not enable FDB mutual TLS")
	}
	imageConfigs, _, _ := unstructured.NestedSlice(cluster.Object, "spec", "mainContainer", "imageConfigs")
	if len(imageConfigs) != 1 || nestedString(imageConfigs[0].(map[string]any), "tag") != "7.3.79@sha256:45f5b7632984a4835326f45a7bcfd662886db64d82333796ee14cbb3a7537c8c" {
		t.Fatalf("FDB Pod image is not pinned by tag and digest: %#v", imageConfigs)
	}
	volumes, _, _ := unstructured.NestedSlice(cluster.Object, "spec", "processes", "general", "podTemplate", "spec", "volumes")
	if len(volumes) != 1 || nestedString(volumes[0].(map[string]any), "secret", "secretName") != "actor-bj-k01-fdb-tls" {
		t.Fatalf("TLS volume = %#v", volumes)
	}
}

func TestFoundationDBClusterAutomaticAutoscalingUsesPersistedCellTarget(t *testing.T) {
	cell, profile := operatorTestObjects("Required")
	foundationDB := profile.Object["spec"].(map[string]any)["foundationDB"].(map[string]any)
	foundationDB["autoscaling"] = autoscalingTestProfile(FDBAutoscalingAutomatic)
	cell.Object["status"] = map[string]any{"foundationDBAutoscaling": map[string]any{"desiredProcessCount": int64(12)}}
	cluster, err := foundationDBClusterForCell(cell, profile, testDigest)
	if err != nil {
		t.Fatal(err)
	}
	if got := nestedInt64(cluster.Object, "spec", "processCounts", "storage"); got != 12 {
		t.Fatalf("operator process target = %d, want 12", got)
	}
	if got := nestedInt64(cluster.Object, "spec", "databaseConfiguration", "storage"); got != 12 {
		t.Fatalf("database storage role target = %d, want 12", got)
	}
}

func TestFoundationDBClusterObserveOnlyKeepsTheLastSafeExpandedTarget(t *testing.T) {
	cell, profile := operatorTestObjects("Required")
	foundationDB := profile.Object["spec"].(map[string]any)["foundationDB"].(map[string]any)
	foundationDB["autoscaling"] = autoscalingTestProfile(FDBAutoscalingObserveOnly)
	cell.Object["status"] = map[string]any{"foundationDBAutoscaling": map[string]any{"desiredProcessCount": int64(12)}}
	cluster, err := foundationDBClusterForCell(cell, profile, testDigest)
	if err != nil {
		t.Fatal(err)
	}
	if got := nestedInt64(cluster.Object, "spec", "processCounts", "storage"); got != 12 {
		t.Fatalf("ObserveOnly would contract a safely expanded database without an operation: got %d, want 12", got)
	}
}

func autoscalingTestProfile(mode string) map[string]any {
	return map[string]any{
		"mode": mode, "minProcessCount": int64(9), "maxProcessCount": int64(30), "stepProcessCount": int64(3),
		"scaleUp":                map[string]any{"headroomBytes": int64(80 << 30), "etaSeconds": int64(259200), "sustainSeconds": int64(1800), "cooldownSeconds": int64(7200), "minimumSamples": int64(600)},
		"scaleDown":              map[string]any{"headroomBytes": int64(160 << 30), "writeUtilizationPercent": int64(20), "sustainSeconds": int64(86400), "cooldownSeconds": int64(604800), "minimumSamples": int64(1200)},
		"volumeRetentionSeconds": int64(2592000), "volumeGCMode": FDBVolumeGCObserveOnly,
	}
}

func TestFoundationDBClusterQualificationCanExplicitlyDisableTLS(t *testing.T) {
	cell, profile := operatorTestObjects("DisabledForQualification")
	cluster, err := foundationDBClusterForCell(cell, profile, testDigest)
	if err != nil {
		t.Fatal(err)
	}
	if nestedBool(cluster.Object, "spec", "mainContainer", "enableTls") {
		t.Fatal("qualification-only TLS mode unexpectedly enabled TLS")
	}
}

func TestFoundationDBClusterDedicatedPlacementAddsOnlyFDBTaintToleration(t *testing.T) {
	cell, profile := operatorTestObjects("Required")
	kubernetesSettings := profile.Object["spec"].(map[string]any)["foundationDB"].(map[string]any)["kubernetes"].(map[string]any)
	kubernetesSettings["placementMode"] = "DedicatedNodes"
	kubernetesSettings["nodeSelector"] = map[string]any{"fleet.actor.dev/fdb-dedicated": "true"}
	cluster, err := foundationDBClusterForCell(cell, profile, testDigest)
	if err != nil {
		t.Fatal(err)
	}
	tolerations, found, _ := unstructured.NestedSlice(cluster.Object, "spec", "processes", "general", "podTemplate", "spec", "tolerations")
	if !found || len(tolerations) != 1 || nestedString(tolerations[0].(map[string]any), "key") != "fleet.actor.dev/fdb-dedicated" {
		t.Fatalf("dedicated placement tolerations = %#v", tolerations)
	}
}

func TestFDBVolumeInventoryStampsImmutableTencentCBSIdentity(t *testing.T) {
	cell, _ := operatorTestObjects("Required")
	cluster := object(fdbClusterGVK)
	cluster.SetName(cell.GetName())
	cluster.SetNamespace(cell.GetNamespace())
	cluster.SetUID(types.UID("fdb-cluster-uid"))
	storageClass := "actor-fdb-cbs-wffc-retain"
	pvc := &corev1.PersistentVolumeClaim{
		ObjectMeta: metav1.ObjectMeta{
			Name: "actor-bj-k01-storage-123-data", Namespace: cell.GetNamespace(), UID: types.UID("pvc-uid"),
			Labels: map[string]string{
				"foundationdb.org/fdb-cluster-name":     cell.GetName(),
				"foundationdb.org/fdb-process-class":    "storage",
				"foundationdb.org/fdb-process-group-id": "storage-123",
			},
		},
		Spec:   corev1.PersistentVolumeClaimSpec{StorageClassName: &storageClass, VolumeName: "pvc-pv-uid"},
		Status: corev1.PersistentVolumeClaimStatus{Phase: corev1.ClaimBound},
	}
	pv := &corev1.PersistentVolume{
		ObjectMeta: metav1.ObjectMeta{Name: "pvc-pv-uid", UID: types.UID("pv-uid")},
		Spec: corev1.PersistentVolumeSpec{
			PersistentVolumeReclaimPolicy: corev1.PersistentVolumeReclaimRetain,
			ClaimRef:                      &corev1.ObjectReference{Name: pvc.Name, Namespace: pvc.Namespace, UID: pvc.UID},
			PersistentVolumeSource: corev1.PersistentVolumeSource{CSI: &corev1.CSIPersistentVolumeSource{
				Driver: "com.tencent.cloud.csi.cbs", VolumeHandle: "disk-test123",
			}},
		},
	}
	kubeClient := fake.NewClientBuilder().WithScheme(operatorTestScheme()).WithObjects(cell, cluster, pvc, pv).Build()
	reconciler := FDBKubernetesReconciler{Client: kubeClient}
	inventory, err := reconciler.reconcileFDBVolumeInventory(context.Background(), cell, cluster, storageClass)
	if err != nil {
		t.Fatal(err)
	}
	if len(inventory) != 1 {
		t.Fatalf("inventory count = %d", len(inventory))
	}
	updated := &corev1.PersistentVolume{}
	if err := kubeClient.Get(context.Background(), types.NamespacedName{Name: pv.Name}, updated); err != nil {
		t.Fatal(err)
	}
	if updated.Labels[FDBVolumeManagedLabel] != "true" || updated.Annotations[FDBVolumeProcessGroup] != "storage-123" ||
		updated.Annotations[FDBVolumePVCUID] != "pvc-uid" || updated.Annotations[FDBVolumeCBSDiskID] != "disk-test123" {
		t.Fatalf("PV inventory identity is incomplete: labels=%v annotations=%v", updated.Labels, updated.Annotations)
	}
}

func TestFoundationDBClusterRejectsSixHostThreeDataHallProfile(t *testing.T) {
	cell, profile := operatorTestObjects("Required")
	foundationDB := profile.Object["spec"].(map[string]any)["foundationDB"].(map[string]any)
	foundationDB["processCount"] = int64(6)
	foundationDB["processesPerZone"] = int64(2)
	foundationDB["coordinatorCount"] = int64(5)
	if _, err := foundationDBClusterForCell(cell, profile, testDigest); err == nil {
		t.Fatal("six hostname fault domains cannot satisfy the operator's nine-coordinator three_data_hall contract")
	}
}

func TestFoundationDBClusterMatchesPinnedUpstreamSchema(t *testing.T) {
	crdPath := os.Getenv("FDB_OPERATOR_CLUSTER_CRD")
	if crdPath == "" {
		t.Skip("set FDB_OPERATOR_CLUSTER_CRD to the pinned upstream FoundationDBCluster CRD")
	}
	data, err := os.ReadFile(crdPath)
	if err != nil {
		t.Fatal(err)
	}
	crd := apiextensionsv1.CustomResourceDefinition{}
	if err := yaml.Unmarshal(data, &crd); err != nil {
		t.Fatal(err)
	}
	if len(crd.Spec.Versions) != 1 || crd.Spec.Versions[0].Name != "v1beta2" {
		t.Fatalf("unexpected upstream CRD versions: %#v", crd.Spec.Versions)
	}
	internalSchema := apiextensions.JSONSchemaProps{}
	if err := apiextensionsv1.Convert_v1_JSONSchemaProps_To_apiextensions_JSONSchemaProps(
		crd.Spec.Versions[0].Schema.OpenAPIV3Schema, &internalSchema, nil,
	); err != nil {
		t.Fatal(err)
	}
	validator, _, err := crvalidation.NewSchemaValidator(&internalSchema)
	if err != nil {
		t.Fatal(err)
	}
	cell, profile := operatorTestObjects("Required")
	cluster, err := foundationDBClusterForCell(cell, profile, testDigest)
	if err != nil {
		t.Fatal(err)
	}
	if errs := crvalidation.ValidateCustomResource(nil, cluster.Object, validator); len(errs) != 0 {
		t.Fatalf("generated FoundationDBCluster violates pinned upstream OpenAPI schema: %v", errs)
	}
}

func TestFDBKubernetesReconcilerCreatesClusterWithoutOwnerReference(t *testing.T) {
	cell, profile, class := operatorReconcileObjects(t)
	objects := []client.Object{cell, profile, class}
	objects = append(objects, initialControlMachineTopology(cell, map[string]int{"zone-a": 1, "zone-b": 1, "zone-c": 1})...)
	objects = append(objects, initialFDBMachineTopology(cell, map[string]int{"zone-a": 3, "zone-b": 3, "zone-c": 3})...)
	kubeClient := fake.NewClientBuilder().WithScheme(operatorTestScheme()).WithObjects(objects...).Build()
	reconciler := FDBKubernetesReconciler{Client: kubeClient}
	request := ctrl.Request{NamespacedName: types.NamespacedName{Name: cell.GetName(), Namespace: cell.GetNamespace()}}
	if _, err := reconciler.Reconcile(context.Background(), request); err != nil {
		t.Fatal(err)
	}
	cluster := object(fdbClusterGVK)
	if err := kubeClient.Get(context.Background(), types.NamespacedName{Name: cell.GetName(), Namespace: cell.GetNamespace()}, cluster); err != nil {
		t.Fatal(err)
	}
	if len(cluster.GetOwnerReferences()) != 0 {
		t.Fatal("created database resource must not have a Cell owner reference")
	}
	if nestedBool(cluster.Object, "spec", "routing", "useDNSInClusterFile") {
		t.Fatal("unconfigured database must bootstrap with Pod IP coordinators")
	}
	if !nestedBool(cluster.Object, "spec", "routing", "headlessService") ||
		!nestedBool(cluster.Object, "spec", "routing", "defineDNSLocalityFields") {
		t.Fatal("bootstrap database Pods must already have stable DNS identities")
	}
	pdb := object(fdbPodDisruptionBudgetGVK)
	if err := kubeClient.Get(context.Background(), types.NamespacedName{Name: cell.GetName() + "-availability", Namespace: cell.GetNamespace()}, pdb); err != nil {
		t.Fatal(err)
	}
	if got := nestedInt64(pdb.Object, "spec", "minAvailable"); got != 8 {
		t.Fatalf("PDB minAvailable = %d, want 8", got)
	}
	if len(pdb.GetOwnerReferences()) != 0 {
		t.Fatal("durability PDB must not be garbage-collected with the Cell")
	}
}

func TestInitialFDBMachineTopologyReplacesOnlyOneNewestSurplusMachine(t *testing.T) {
	cell, _ := operatorTestObjects("Required")
	objects := initialFDBMachineTopology(cell, map[string]int{"zone-a": 5, "zone-c": 4})
	kubeClient := fake.NewClientBuilder().WithScheme(operatorTestScheme()).WithObjects(objects...).Build()
	reconciler := FDBKubernetesReconciler{Client: kubeClient}
	ready, err := reconciler.ensureInitialMachineSetTopology(context.Background(), cell, "np-fdbpool0", 9, 3, "fleet.actor.dev/fdb-dedicated")
	if err != nil {
		t.Fatal(err)
	}
	if ready {
		t.Fatal("skewed initial Machine topology was accepted")
	}
	machines := &unstructured.UnstructuredList{}
	machines.SetGroupVersionKind(tkeMachineGVK.GroupVersion().WithKind("MachineList"))
	if err := kubeClient.List(context.Background(), machines); err != nil {
		t.Fatal(err)
	}
	if len(machines.Items) != 8 {
		t.Fatalf("remaining Machines = %d, want exactly one replacement deletion", len(machines.Items))
	}
	counts := map[string]int{}
	for i := range machines.Items {
		node := &corev1.Node{}
		if err := kubeClient.Get(context.Background(), types.NamespacedName{Name: nestedString(machines.Items[i].Object, "status", "nodeRef", "name")}, node); err != nil {
			t.Fatal(err)
		}
		counts[node.Labels["topology.kubernetes.io/zone"]]++
	}
	if counts["zone-a"] != 4 || counts["zone-c"] != 4 {
		t.Fatalf("post-deletion topology = %v, want one deletion from surplus zone-a", counts)
	}
	machineSet := object(tkeMachineSetGVK)
	if err := kubeClient.Get(context.Background(), types.NamespacedName{Name: "np-fdbpool0"}, machineSet); err != nil {
		t.Fatal(err)
	}
	if got := machineSet.GetAnnotations()[FDBInitialTopologyReplacementCountAnnotation]; got != "1" {
		t.Fatalf("replacement count = %q, want 1", got)
	}
}

func TestInitialFDBMachineTopologyStopsAfterBoundedReplacements(t *testing.T) {
	cell, _ := operatorTestObjects("Required")
	objects := initialFDBMachineTopology(cell, map[string]int{"zone-a": 5, "zone-c": 4})
	machineSet := objects[0].(*unstructured.Unstructured)
	machineSet.SetAnnotations(map[string]string{FDBInitialTopologyReplacementCountAnnotation: "9"})
	kubeClient := fake.NewClientBuilder().WithScheme(operatorTestScheme()).WithObjects(objects...).Build()
	reconciler := FDBKubernetesReconciler{Client: kubeClient}
	ready, err := reconciler.ensureInitialMachineSetTopology(context.Background(), cell, "np-fdbpool0", 9, 3, "fleet.actor.dev/fdb-dedicated")
	if err == nil || !strings.Contains(err.Error(), "exhausted 9 bounded topology replacements") {
		t.Fatalf("bounded replacement error = %v", err)
	}
	if ready {
		t.Fatal("exhausted skewed topology was accepted")
	}
	machines := &unstructured.UnstructuredList{}
	machines.SetGroupVersionKind(tkeMachineGVK.GroupVersion().WithKind("MachineList"))
	if err := kubeClient.List(context.Background(), machines); err != nil {
		t.Fatal(err)
	}
	if len(machines.Items) != 9 {
		t.Fatalf("Machine count after exhausted replacement = %d, want 9", len(machines.Items))
	}
}

func TestInitialFDBMachineTopologyAcceptsExactThreeZoneLayout(t *testing.T) {
	cell, _ := operatorTestObjects("Required")
	objects := initialFDBMachineTopology(cell, map[string]int{"zone-a": 3, "zone-b": 3, "zone-c": 3})
	kubeClient := fake.NewClientBuilder().WithScheme(operatorTestScheme()).WithObjects(objects...).Build()
	reconciler := FDBKubernetesReconciler{Client: kubeClient}
	ready, err := reconciler.ensureInitialMachineSetTopology(context.Background(), cell, "np-fdbpool0", 9, 3, "fleet.actor.dev/fdb-dedicated")
	if err != nil {
		t.Fatal(err)
	}
	if !ready {
		t.Fatal("exact 3/3/3 initial Machine topology was not accepted")
	}
}

func initialFDBMachineTopology(cell *unstructured.Unstructured, zoneCounts map[string]int) []client.Object {
	machineSet := testTKEMachineSet(9, 9)
	return initialMachineTopology(cell, machineSet, "fleet.actor.dev/fdb-dedicated", zoneCounts)
}

func initialControlMachineTopology(cell *unstructured.Unstructured, zoneCounts map[string]int) []client.Object {
	machineSet := testTKEMachineSet(3, 3)
	machineSet.SetName("np-control0")
	machineSet.SetUID(types.UID("control-machineset-uid"))
	labels, _, _ := unstructured.NestedStringMap(machineSet.Object, "spec", "template", "spec", "metadata", "labels")
	delete(labels, "fleet.actor.dev/fdb-dedicated")
	labels[FDBCellNameLabel] = cell.GetName()
	labels["fleet.actor.dev/control-pool"] = "true"
	if err := unstructured.SetNestedStringMap(machineSet.Object, labels, "spec", "template", "spec", "metadata", "labels"); err != nil {
		panic(err)
	}
	return initialMachineTopology(cell, machineSet, "fleet.actor.dev/control-pool", zoneCounts)
}

func initialMachineTopology(cell, machineSet *unstructured.Unstructured, roleLabel string, zoneCounts map[string]int) []client.Object {
	machineSetName := machineSet.GetName()
	objects := []client.Object{machineSet}
	index := 0
	for zone, count := range zoneCounts {
		for range count {
			index++
			name := fmt.Sprintf("%s-machine-%02d", machineSetName, index)
			nodeName := fmt.Sprintf("%s-node-%02d", machineSetName, index)
			controller := true
			machine := object(tkeMachineGVK)
			machine.SetName(name)
			machine.SetUID(types.UID(name + "-uid"))
			machine.SetCreationTimestamp(metav1.NewTime(time.Date(2026, 9, 12, 0, 0, index, 0, time.UTC)))
			machine.SetLabels(map[string]string{"node.tke.cloud.tencent.com/machineset": machineSetName})
			machine.SetOwnerReferences([]metav1.OwnerReference{{
				APIVersion: tkeMachineSetGVK.GroupVersion().String(), Kind: "MachineSet", Name: machineSetName,
				UID: machineSet.GetUID(), Controller: &controller,
			}})
			machine.Object["spec"] = map[string]any{"metadata": map[string]any{"labels": map[string]any{
				FDBCellNameLabel: cell.GetName(), roleLabel: "true",
			}}}
			machine.Object["status"] = map[string]any{"nodeRef": map[string]any{"name": nodeName}}
			node := &corev1.Node{
				ObjectMeta: metav1.ObjectMeta{Name: nodeName, Labels: map[string]string{
					FDBCellNameLabel: cell.GetName(), roleLabel: "true", "topology.kubernetes.io/zone": zone,
				}},
				Status: corev1.NodeStatus{Conditions: []corev1.NodeCondition{{Type: corev1.NodeReady, Status: corev1.ConditionTrue}}},
			}
			objects = append(objects, machine, node)
		}
	}
	return objects
}

func TestFDBKubernetesReconcilerPromotesConfiguredClusterToDNSCoordinators(t *testing.T) {
	cell, profile, class := operatorReconcileObjects(t)
	cluster, err := foundationDBClusterForCell(cell, profile, digestSpec(profile))
	if err != nil {
		t.Fatal(err)
	}
	cluster.SetUID(types.UID("fdb-exact-uid"))
	setFDBUseDNSInClusterFile(cluster, false)
	connectionString := "actor:identity@10.0.0.1:4500"
	cluster.Object["status"] = map[string]any{
		"configured":       true,
		"connectionString": connectionString,
	}
	if err := unstructured.SetNestedField(cell.Object, "fdb-exact-uid", "spec", "foundationDB", "clusterRef", "uid"); err != nil {
		t.Fatal(err)
	}
	if err := unstructured.SetNestedField(cell.Object, databaseIdentityHash("fdb-exact-uid", connectionString), "spec", "foundationDB", "clusterIdentityHash"); err != nil {
		t.Fatal(err)
	}

	kubeClient := fake.NewClientBuilder().WithScheme(operatorTestScheme()).WithObjects(cell, profile, class, cluster).Build()
	reconciler := FDBKubernetesReconciler{Client: kubeClient}
	request := ctrl.Request{NamespacedName: types.NamespacedName{Name: cell.GetName(), Namespace: cell.GetNamespace()}}
	if _, err := reconciler.Reconcile(context.Background(), request); err != nil {
		t.Fatal(err)
	}
	updated := object(fdbClusterGVK)
	if err := kubeClient.Get(context.Background(), request.NamespacedName, updated); err != nil {
		t.Fatal(err)
	}
	if !nestedBool(updated.Object, "spec", "routing", "useDNSInClusterFile") {
		t.Fatal("configured database was not promoted to DNS coordinators")
	}
}

func TestFDBKubernetesReconcilerKeepsUnconfiguredClusterOnIPCoordinators(t *testing.T) {
	cell, profile, class := operatorReconcileObjects(t)
	cluster, err := foundationDBClusterForCell(cell, profile, digestSpec(profile))
	if err != nil {
		t.Fatal(err)
	}
	cluster.SetUID(types.UID("fdb-exact-uid"))
	setFDBUseDNSInClusterFile(cluster, false)
	cluster.Object["status"] = map[string]any{}
	if err := unstructured.SetNestedField(cell.Object, "fdb-exact-uid", "spec", "foundationDB", "clusterRef", "uid"); err != nil {
		t.Fatal(err)
	}

	kubeClient := fake.NewClientBuilder().WithScheme(operatorTestScheme()).WithObjects(cell, profile, class, cluster).Build()
	reconciler := FDBKubernetesReconciler{Client: kubeClient}
	request := ctrl.Request{NamespacedName: types.NamespacedName{Name: cell.GetName(), Namespace: cell.GetNamespace()}}
	if _, err := reconciler.Reconcile(context.Background(), request); err != nil {
		t.Fatal(err)
	}
	updated := object(fdbClusterGVK)
	if err := kubeClient.Get(context.Background(), request.NamespacedName, updated); err != nil {
		t.Fatal(err)
	}
	if nestedBool(updated.Object, "spec", "routing", "useDNSInClusterFile") {
		t.Fatal("unconfigured database was prematurely promoted to DNS coordinators")
	}
	if !nestedBool(updated.Object, "spec", "routing", "headlessService") ||
		!nestedBool(updated.Object, "spec", "routing", "defineDNSLocalityFields") {
		t.Fatal("unconfigured database lost stable Pod DNS identities")
	}
}

func TestFDBKubernetesReconcilerBindsExactClusterUID(t *testing.T) {
	cell, profile, class := operatorReconcileObjects(t)
	cluster, err := foundationDBClusterForCell(cell, profile, digestSpec(profile))
	if err != nil {
		t.Fatal(err)
	}
	cluster.SetUID(types.UID("fdb-exact-uid"))
	cluster.Object["status"] = map[string]any{"connectionString": "actor:identity@10.0.0.1:4500"}
	kubeClient := fake.NewClientBuilder().WithScheme(operatorTestScheme()).WithObjects(cell, profile, class, cluster).Build()
	reconciler := FDBKubernetesReconciler{Client: kubeClient}
	request := ctrl.Request{NamespacedName: types.NamespacedName{Name: cell.GetName(), Namespace: cell.GetNamespace()}}
	if _, err := reconciler.Reconcile(context.Background(), request); err != nil {
		t.Fatal(err)
	}
	updated := object(cellGVK)
	if err := kubeClient.Get(context.Background(), request.NamespacedName, updated); err != nil {
		t.Fatal(err)
	}
	if got := nestedString(updated.Object, "spec", "foundationDB", "clusterRef", "uid"); got != "fdb-exact-uid" {
		t.Fatalf("bound cluster UID = %q", got)
	}
	if got := nestedString(updated.Object, "spec", "foundationDB", "clusterIdentityHash"); got != databaseIdentityHash("fdb-exact-uid", "actor:identity@10.0.0.1:4500") {
		t.Fatalf("bound database identity = %q", got)
	}
}

func TestFDBKubernetesReconcilerRefusesToRecreateMissingBoundDatabase(t *testing.T) {
	cell, profile, class := operatorReconcileObjects(t)
	if err := unstructured.SetNestedField(cell.Object, "missing-fdb-uid", "spec", "foundationDB", "clusterRef", "uid"); err != nil {
		t.Fatal(err)
	}
	kubeClient := fake.NewClientBuilder().WithScheme(operatorTestScheme()).WithObjects(cell, profile, class).Build()
	reconciler := FDBKubernetesReconciler{Client: kubeClient}
	request := ctrl.Request{NamespacedName: types.NamespacedName{Name: cell.GetName(), Namespace: cell.GetNamespace()}}
	if _, err := reconciler.Reconcile(context.Background(), request); err == nil {
		t.Fatal("missing bound database identity was silently recreated")
	}
}

func TestFDBKubernetesReconcilerCorrectsOwnedSpecAndLabelDrift(t *testing.T) {
	cell, profile, class := operatorReconcileObjects(t)
	cluster, err := foundationDBClusterForCell(cell, profile, digestSpec(profile))
	if err != nil {
		t.Fatal(err)
	}
	cluster.SetUID(types.UID("fdb-exact-uid"))
	cluster.Object["status"] = map[string]any{"connectionString": "actor:identity@10.0.0.1:4500"}
	if err := unstructured.SetNestedField(cell.Object, "fdb-exact-uid", "spec", "foundationDB", "clusterRef", "uid"); err != nil {
		t.Fatal(err)
	}
	if err := unstructured.SetNestedField(cell.Object, databaseIdentityHash("fdb-exact-uid", "actor:identity@10.0.0.1:4500"), "spec", "foundationDB", "clusterIdentityHash"); err != nil {
		t.Fatal(err)
	}
	if err := unstructured.SetNestedField(cluster.Object, "7.3.78", "spec", "version"); err != nil {
		t.Fatal(err)
	}
	labels := cluster.GetLabels()
	labels[FDBCellNameLabel] = "wrong-cell"
	cluster.SetLabels(labels)

	kubeClient := fake.NewClientBuilder().WithScheme(operatorTestScheme()).WithObjects(cell, profile, class, cluster).Build()
	reconciler := FDBKubernetesReconciler{Client: kubeClient}
	request := ctrl.Request{NamespacedName: types.NamespacedName{Name: cell.GetName(), Namespace: cell.GetNamespace()}}
	if _, err := reconciler.Reconcile(context.Background(), request); err != nil {
		t.Fatal(err)
	}
	updated := object(fdbClusterGVK)
	if err := kubeClient.Get(context.Background(), request.NamespacedName, updated); err != nil {
		t.Fatal(err)
	}
	if got := nestedString(updated.Object, "spec", "version"); got != "7.3.79" {
		t.Fatalf("reconciled FDB version = %q", got)
	}
	if got := updated.GetLabels()[FDBCellNameLabel]; got != cell.GetName() {
		t.Fatalf("reconciled Cell label = %q", got)
	}
}

func TestObserveFDBKubernetesClusterRequiresExactUIDAndFullReconciliation(t *testing.T) {
	cell, profile := operatorTestObjects("Required")
	cluster, err := foundationDBClusterForCell(cell, profile, testDigest)
	if err != nil {
		t.Fatal(err)
	}
	cluster.SetUID(types.UID("fdb-uid"))
	cluster.SetGeneration(4)
	cluster.Object["status"] = map[string]any{
		"generations":             map[string]any{"reconciled": int64(4)},
		"desiredProcessGroups":    int64(9),
		"reconciledProcessGroups": int64(9),
		"runningVersion":          "7.3.79",
		"configured":              true,
		"connectionString":        "actor:identity@10.0.0.1:4500",
		"health":                  map[string]any{"available": true, "healthy": true, "fullReplication": true},
	}
	if err := unstructured.SetNestedField(cell.Object, "fdb-uid", "spec", "foundationDB", "clusterRef", "uid"); err != nil {
		t.Fatal(err)
	}
	if err := unstructured.SetNestedField(cell.Object, databaseIdentityHash("fdb-uid", "actor:identity@10.0.0.1:4500"), "spec", "foundationDB", "clusterIdentityHash"); err != nil {
		t.Fatal(err)
	}

	scheme := runtime.NewScheme()
	scheme.AddKnownTypeWithName(fdbClusterGVK, &unstructured.Unstructured{})
	scheme.AddKnownTypeWithName(fdbClusterGVK.GroupVersion().WithKind("FoundationDBClusterList"), &unstructured.UnstructuredList{})
	kubeClient := fake.NewClientBuilder().WithScheme(scheme).WithObjects(cluster).Build()
	in := CellInput{}
	if err := observeFDBKubernetesCluster(context.Background(), kubeClient, &in, cell, profile); err != nil {
		t.Fatal(err)
	}
	if !in.FDBOperatorRequired || !in.FDBOperatorFound || !in.FDBOperatorReady {
		t.Fatalf("operator observation = %#v", in)
	}

	cluster.Object["status"].(map[string]any)["health"].(map[string]any)["fullReplication"] = false
	kubeClient = fake.NewClientBuilder().WithScheme(scheme).WithObjects(cluster).Build()
	in = CellInput{}
	if err := observeFDBKubernetesCluster(context.Background(), kubeClient, &in, cell, profile); err != nil {
		t.Fatal(err)
	}
	if in.FDBOperatorReady || in.FDBOperatorReason != "DatabaseUnhealthy" {
		t.Fatalf("unreplicated database was accepted: %#v", in)
	}
}

func TestRequestFDBHealthStatusRefreshIsBoundedAndStatusDriven(t *testing.T) {
	cluster := object(fdbClusterGVK)
	cluster.SetName("actor-bj-k01")
	cluster.SetNamespace("actor-fdb-cells")
	cluster.SetGeneration(4)
	cluster.Object["spec"] = map[string]any{"processCounts": map[string]any{"storage": int64(9)}}
	cluster.Object["status"] = map[string]any{
		"generations":             map[string]any{"reconciled": int64(4)},
		"desiredProcessGroups":    int64(9),
		"reconciledProcessGroups": int64(9),
		"configured":              true,
		"health":                  map[string]any{"available": true, "fullReplication": true},
	}

	now := time.Date(2026, 9, 10, 9, 0, 0, 0, time.UTC)
	kubeClient := fake.NewClientBuilder().WithScheme(operatorTestScheme()).WithObjects(cluster).Build()
	reconciler := FDBKubernetesReconciler{Client: kubeClient, Now: func() time.Time { return now }}

	refreshed, err := reconciler.requestFDBHealthStatusRefresh(context.Background(), cluster)
	if err != nil {
		t.Fatal(err)
	}
	if !refreshed {
		t.Fatal("stale terminal health did not trigger an upstream status refresh")
	}

	updated := object(fdbClusterGVK)
	key := types.NamespacedName{Name: cluster.GetName(), Namespace: cluster.GetNamespace()}
	if err := kubeClient.Get(context.Background(), key, updated); err != nil {
		t.Fatal(err)
	}
	if got := updated.GetAnnotations()[FDBHealthRefreshAnnotation]; got != now.Format(time.RFC3339) {
		t.Fatalf("health refresh annotation = %q", got)
	}

	reconciler.Now = func() time.Time { return now.Add(time.Minute) }
	refreshed, err = reconciler.requestFDBHealthStatusRefresh(context.Background(), updated)
	if err != nil {
		t.Fatal(err)
	}
	if refreshed {
		t.Fatal("health refresh was issued again inside the bounded interval")
	}

	if err := unstructured.SetNestedField(updated.Object, true, "status", "health", "healthy"); err != nil {
		t.Fatal(err)
	}
	reconciler.Now = func() time.Time { return now.Add(3 * time.Minute) }
	refreshed, err = reconciler.requestFDBHealthStatusRefresh(context.Background(), updated)
	if err != nil {
		t.Fatal(err)
	}
	if refreshed {
		t.Fatal("healthy database unexpectedly triggered an upstream status refresh")
	}
}

func TestRequestFDBHealthStatusRefreshRequiresCompleteReconciliation(t *testing.T) {
	cluster := object(fdbClusterGVK)
	cluster.SetName("actor-bj-k01")
	cluster.SetNamespace("actor-fdb-cells")
	cluster.SetGeneration(4)
	cluster.Object["spec"] = map[string]any{"processCounts": map[string]any{"storage": int64(9)}}
	cluster.Object["status"] = map[string]any{
		"generations":             map[string]any{"reconciled": int64(3)},
		"desiredProcessGroups":    int64(9),
		"reconciledProcessGroups": int64(9),
		"configured":              true,
		"health":                  map[string]any{"available": true, "fullReplication": true},
	}
	kubeClient := fake.NewClientBuilder().WithScheme(operatorTestScheme()).WithObjects(cluster).Build()
	reconciler := FDBKubernetesReconciler{Client: kubeClient}
	refreshed, err := reconciler.requestFDBHealthStatusRefresh(context.Background(), cluster)
	if err != nil {
		t.Fatal(err)
	}
	if refreshed {
		t.Fatal("incomplete FoundationDB reconciliation must not be poked by the health refresher")
	}
}

func operatorTestObjects(tlsMode string) (*unstructured.Unstructured, *unstructured.Unstructured) {
	cell := object(cellGVK)
	cell.SetName("actor-bj-k01")
	cell.SetNamespace("actor-fdb-cells")
	cell.SetUID(types.UID("cell-uid"))
	cell.SetLabels(map[string]string{PoolLabel: "actor-beijing"})
	cell.Object["spec"] = map[string]any{
		"foundationDB": map[string]any{"clusterRef": map[string]any{
			"name": "actor-bj-k01", "namespace": "actor-fdb-cells",
		}},
	}

	profile := object(profileGVK)
	profile.Object["spec"] = map[string]any{
		"capacity": map[string]any{
			"healthyWriteUtilizationLimitPercent":  int64(50),
			"degradedWriteUtilizationLimitPercent": int64(70),
			"scaleOutAtPercent":                    int64(80),
		},
		"topology": map[string]any{
			"zoneLabelKey": "topology.kubernetes.io/zone", "zoneCount": int64(3),
			"maxSkew": int64(1), "whenUnsatisfiable": "DoNotSchedule",
		},
		"foundationDB": map[string]any{
			"version": "7.3.79", "processCount": int64(9),
			"coordinatorCount": int64(9),
			"redundancyMode":   "three_data_hall", "storageEngine": "ssd-2",
			"dataDisk":   map[string]any{"sizeGiB": int64(200)},
			"supervisor": FDBKubernetesSupervisor,
			"kubernetes": map[string]any{
				"imageType":             "unified",
				"imageRepository":       "foundationdb/fdb-kubernetes-monitor",
				"imageTagDigest":        "7.3.79@sha256:45f5b7632984a4835326f45a7bcfd662886db64d82333796ee14cbb3a7537c8c",
				"storageClassName":      "actor-fdb-cbs-wffc-retain",
				"fdbServiceAccountName": "fdb-kubernetes",
				"placementMode":         "MixedEligibleNodes",
				"priorityClassName":     "actor-fdb-critical",
				"faultDomainKey":        "kubernetes.io/hostname",
				"nodeSelector":          map[string]any{"fleet.actor.dev/fdb-eligible": "true"},
				"nodeCapacity": map[string]any{
					"provider": FDBNodeCapacityTKE, "machineSetName": "np-fdbpool0", "processesPerNode": int64(1),
				},
				"resources": map[string]any{
					"cpuRequest": "2", "memoryRequest": "8Gi", "cpuLimit": "2", "memoryLimit": "8Gi",
				},
				"tls": map[string]any{
					"mode":                  tlsMode,
					"secretNameTemplate":    "{clusterName}-fdb-tls",
					"peerVerificationRules": "S.OU=actor-fdb",
				},
			},
		},
	}
	return cell, profile
}

func TestDatabaseIdentityHashIgnoresCoordinatorGenerationAndAddresses(t *testing.T) {
	first := databaseIdentityHash("fdb-uid", "actor:identity-a@10.0.0.1:4500")
	second := databaseIdentityHash("fdb-uid", "actor:identity-b@10.0.0.2:4500,10.0.0.3:4500")
	if first == "" || first != second {
		t.Fatalf("stable database identity changed with coordinators: %q != %q", first, second)
	}
	if first == databaseIdentityHash("fdb-uid", "another:identity-a@10.0.0.1:4500") {
		t.Fatal("different FoundationDB database names produced the same identity")
	}
	if first == databaseIdentityHash("other-uid", "actor:identity-a@10.0.0.1:4500") {
		t.Fatal("different FoundationDBCluster UIDs produced the same identity")
	}
}

func operatorReconcileObjects(t *testing.T) (*unstructured.Unstructured, *unstructured.Unstructured, *unstructured.Unstructured) {
	t.Helper()
	cell, profile := operatorTestObjects("Required")
	profile.SetName("operator-profile")
	cell.Object["spec"].(map[string]any)["className"] = "operator-class"
	class := object(classGVK)
	class.SetName("operator-class")
	class.Object["spec"] = map[string]any{
		"controllerName": ControllerName,
		"profileRef": map[string]any{
			"name": profile.GetName(), "digest": digestSpec(profile),
		},
	}
	return cell, profile, class
}

func operatorTestScheme() *runtime.Scheme {
	scheme := runtime.NewScheme()
	if err := corev1.AddToScheme(scheme); err != nil {
		panic(err)
	}
	if err := storagev1.AddToScheme(scheme); err != nil {
		panic(err)
	}
	for _, gvk := range []schema.GroupVersionKind{cellGVK, classGVK, profileGVK, reportGVK, fdbClusterGVK, fdbPodDisruptionBudgetGVK, fdbScaleOperationGVK, fdbVolumeRetirementGVK, tkeMachineSetGVK, tkeMachineGVK} {
		scheme.AddKnownTypeWithName(gvk, &unstructured.Unstructured{})
		scheme.AddKnownTypeWithName(gvk.GroupVersion().WithKind(gvk.Kind+"List"), &unstructured.UnstructuredList{})
	}
	return scheme
}

func TestReconcileTKECapacityFloorDeclaresExactMachineSetTarget(t *testing.T) {
	cell, _ := operatorTestObjects("Required")
	operation := object(fdbScaleOperationGVK)
	operation.SetName("scale-up")
	operation.Object["spec"] = map[string]any{"nodeCapacityRef": map[string]any{
		"provider": FDBNodeCapacityTKE, "machineSetName": "np-fdbpool0", "processesPerNode": int64(1),
	}}
	machineSet := testTKEMachineSet(9, 9)
	kubeClient := fake.NewClientBuilder().WithScheme(operatorTestScheme()).WithObjects(machineSet).Build()
	reconciler := FDBKubernetesReconciler{Client: kubeClient}
	ready, snapshot, err := reconciler.reconcileTKECapacityFloor(context.Background(), cell, operation, 12, false)
	if err != nil {
		t.Fatal(err)
	}
	if ready || nestedInt64(snapshot, "desiredNodes") != 12 {
		t.Fatalf("premature capacity readiness: ready=%v snapshot=%#v", ready, snapshot)
	}
	updated := object(tkeMachineSetGVK)
	if err := kubeClient.Get(context.Background(), types.NamespacedName{Name: "np-fdbpool0"}, updated); err != nil {
		t.Fatal(err)
	}
	if got := nestedInt64(updated.Object, "spec", "scaling", "minReplicas"); got != 12 {
		t.Fatalf("autoscaler minimum = %d, want 12", got)
	}
	if got := nestedInt64(updated.Object, "spec", "replicas"); got != 12 {
		t.Fatalf("MachineSet replica target = %d, want 12", got)
	}
}

func TestScaleUpPublishesFDBDemandBeforeTKECapacityIsReady(t *testing.T) {
	cell, _ := operatorTestObjects("Required")
	cluster := object(fdbClusterGVK)
	cluster.SetName(cell.GetName())
	cluster.SetNamespace(cell.GetNamespace())
	cluster.SetUID(types.UID("fdb-uid"))
	cluster.SetGeneration(3)
	cluster.Object["spec"] = map[string]any{"processCounts": map[string]any{"storage": int64(9)}}
	cluster.Object["status"] = map[string]any{
		"generations": map[string]any{"reconciled": int64(3)},
		"health":      map[string]any{"available": true, "healthy": true, "fullReplication": true},
	}
	operation := object(fdbScaleOperationGVK)
	operation.SetName("scale-up")
	operation.SetNamespace(cell.GetNamespace())
	operation.SetUID(types.UID("scale-up-uid"))
	operation.SetLabels(map[string]string{FDBCellUIDLabel: string(cell.GetUID())})
	operation.Object["spec"] = map[string]any{
		"foundationDBClusterRef": map[string]any{"name": cluster.GetName(), "uid": string(cluster.GetUID())},
		"direction":              "Up", "fromProcessCount": int64(9), "toProcessCount": int64(12),
		"nodeCapacityRef": map[string]any{
			"provider": FDBNodeCapacityTKE, "machineSetName": "np-fdbpool0", "processesPerNode": int64(1),
		},
	}
	machineSet := testTKEMachineSet(9, 9)
	kubeClient := fake.NewClientBuilder().WithScheme(operatorTestScheme()).
		WithStatusSubresource(operation).WithObjects(operation, machineSet).Build()
	reconciler := FDBKubernetesReconciler{Client: kubeClient}

	active, err := reconciler.reconcileActiveFDBScaleOperation(context.Background(), cell, cluster)
	if err != nil {
		t.Fatal(err)
	}
	if active {
		t.Fatal("capacity wait blocked publication of the Pending FDB Pod demand")
	}
	updatedOperation := object(fdbScaleOperationGVK)
	if err := kubeClient.Get(context.Background(), types.NamespacedName{Name: operation.GetName(), Namespace: operation.GetNamespace()}, updatedOperation); err != nil {
		t.Fatal(err)
	}
	if got := nestedString(updatedOperation.Object, "status", "phase"); got != "ProvisioningCapacity" {
		t.Fatalf("operation phase = %q, want ProvisioningCapacity", got)
	}
	updatedMachineSet := object(tkeMachineSetGVK)
	if err := kubeClient.Get(context.Background(), types.NamespacedName{Name: machineSet.GetName()}, updatedMachineSet); err != nil {
		t.Fatal(err)
	}
	if got := nestedInt64(updatedMachineSet.Object, "spec", "scaling", "minReplicas"); got != 12 {
		t.Fatalf("capacity floor = %d, want 12", got)
	}
	if got := nestedInt64(updatedMachineSet.Object, "spec", "replicas"); got != 12 {
		t.Fatalf("MachineSet replica target = %d, want 12", got)
	}

	if err := unstructured.SetNestedField(cluster.Object, int64(12), "spec", "processCounts", "storage"); err != nil {
		t.Fatal(err)
	}
	active, err = reconciler.reconcileActiveFDBScaleOperation(context.Background(), cell, cluster)
	if err != nil {
		t.Fatal(err)
	}
	if !active {
		t.Fatal("operation stopped waiting after the FDB demand was published but before nodes were Ready")
	}
}

func TestReconcileTKECapacityFloorLowersOnlyAfterScaleDownGate(t *testing.T) {
	cell, _ := operatorTestObjects("Required")
	operation := object(fdbScaleOperationGVK)
	operation.SetName("scale-down")
	operation.Object["spec"] = map[string]any{"nodeCapacityRef": map[string]any{
		"provider": FDBNodeCapacityTKE, "machineSetName": "np-fdbpool0", "processesPerNode": int64(1),
	}}
	machineSet := testTKEMachineSet(12, 12)
	kubeClient := fake.NewClientBuilder().WithScheme(operatorTestScheme()).WithObjects(machineSet).Build()
	reconciler := FDBKubernetesReconciler{Client: kubeClient}
	ready, _, err := reconciler.reconcileTKECapacityFloor(context.Background(), cell, operation, 9, true)
	if err != nil {
		t.Fatal(err)
	}
	if ready {
		t.Fatal("capacity was declared reclaimed while twelve nodes were still Ready")
	}
	updated := object(tkeMachineSetGVK)
	if err := kubeClient.Get(context.Background(), types.NamespacedName{Name: "np-fdbpool0"}, updated); err != nil {
		t.Fatal(err)
	}
	if got := nestedInt64(updated.Object, "spec", "scaling", "minReplicas"); got != 9 {
		t.Fatalf("autoscaler minimum = %d, want 9", got)
	}
	if got := nestedInt64(updated.Object, "spec", "replicas"); got != 9 {
		t.Fatalf("MachineSet replica target = %d, want 9", got)
	}
}

func TestReconcileTKECapacityFloorReservesAuxiliaryFDBClusters(t *testing.T) {
	cell, _ := operatorTestObjects("Required")
	operation := object(fdbScaleOperationGVK)
	operation.SetName("scale-down-with-restore")
	operation.Object["spec"] = map[string]any{
		"foundationDBClusterRef": map[string]any{"name": cell.GetName()},
		"nodeCapacityRef": map[string]any{
			"provider": FDBNodeCapacityTKE, "machineSetName": "np-fdbpool0", "processesPerNode": int64(1),
		},
	}
	objects := []runtime.Object{testTKEMachineSet(12, 12)}
	for i := 0; i < 3; i++ {
		objects = append(objects, &corev1.Pod{ObjectMeta: metav1.ObjectMeta{
			Name: fmt.Sprintf("restore-storage-%d", i), Namespace: cell.GetNamespace(),
			Labels: map[string]string{
				"foundationdb.org/fdb-cluster-name": "actor-bj-k01-dr", "foundationdb.org/fdb-process-class": "storage",
			},
		}})
	}
	kubeClient := fake.NewClientBuilder().WithScheme(operatorTestScheme()).WithRuntimeObjects(objects...).Build()
	reconciler := FDBKubernetesReconciler{Client: kubeClient}
	ready, snapshot, err := reconciler.reconcileTKECapacityFloor(context.Background(), cell, operation, 9, true)
	if err != nil {
		t.Fatal(err)
	}
	if !ready || nestedInt64(snapshot, "desiredNodes") != 12 || nestedInt64(snapshot, "auxiliaryStorageProcesses") != 3 {
		t.Fatalf("auxiliary restore capacity was not preserved: ready=%v snapshot=%#v", ready, snapshot)
	}
	updated := object(tkeMachineSetGVK)
	if err := kubeClient.Get(context.Background(), types.NamespacedName{Name: "np-fdbpool0"}, updated); err != nil {
		t.Fatal(err)
	}
	if got := nestedInt64(updated.Object, "spec", "replicas"); got != 12 {
		t.Fatalf("MachineSet replica target = %d, want 12", got)
	}
}

func TestAuxiliaryFDBCapacityExpandsWithoutPrimaryScaleOperation(t *testing.T) {
	cell, profile := operatorTestObjects("Required")
	profile.Object["spec"].(map[string]any)["foundationDB"].(map[string]any)["kubernetes"].(map[string]any)["placementMode"] = "DedicatedNodes"
	cluster := object(fdbClusterGVK)
	cluster.SetName(cell.GetName())
	cluster.SetNamespace(cell.GetNamespace())
	cluster.Object["spec"] = map[string]any{"processCounts": map[string]any{"storage": int64(9)}}
	objects := []runtime.Object{testTKEMachineSet(9, 9)}
	for i := 0; i < 6; i++ {
		objects = append(objects, &corev1.Pod{ObjectMeta: metav1.ObjectMeta{
			Name: fmt.Sprintf("restore-storage-%d", i), Namespace: cell.GetNamespace(),
			Labels: map[string]string{
				"foundationdb.org/fdb-cluster-name":  fmt.Sprintf("%s-dr-%d", cell.GetName(), i/3),
				"foundationdb.org/fdb-process-class": "storage",
			},
		}})
	}
	kubeClient := fake.NewClientBuilder().WithScheme(operatorTestScheme()).WithRuntimeObjects(objects...).Build()
	reconciler := FDBKubernetesReconciler{Client: kubeClient}
	if err := reconciler.reconcileAuxiliaryFDBCapacity(context.Background(), cell, cluster, profile); err != nil {
		t.Fatal(err)
	}
	updated := object(tkeMachineSetGVK)
	if err := kubeClient.Get(context.Background(), types.NamespacedName{Name: "np-fdbpool0"}, updated); err != nil {
		t.Fatal(err)
	}
	if got := nestedInt64(updated.Object, "spec", "replicas"); got != 15 {
		t.Fatalf("MachineSet target = %d, want primary 9 + two DR targets of 3", got)
	}
	if got := nestedInt64(updated.Object, "spec", "scaling", "minReplicas"); got != 15 {
		t.Fatalf("MachineSet floor = %d, want 15", got)
	}
	if got := nestedInt64(cluster.Object, "spec", "processCounts", "storage"); got != 9 {
		t.Fatalf("primary FDB target changed to %d while reserving DR capacity", got)
	}
}

func TestEnsureVolumeRetirementsRequiresAllThreeRecordsBeforeScaleDownCanComplete(t *testing.T) {
	cell, _, _ := operatorReconcileObjects(t)
	cluster := object(fdbClusterGVK)
	cluster.SetName(cell.GetName())
	cluster.SetNamespace(cell.GetNamespace())
	cluster.SetUID(types.UID("fdb-uid"))
	operation := object(fdbScaleOperationGVK)
	operation.SetName("actor-bj-k01-fdb-12-9-proof")
	operation.SetNamespace(cell.GetNamespace())
	operation.SetUID(types.UID("scale-down-uid"))
	operation.Object["spec"] = map[string]any{
		"fromProcessCount": int64(12), "toProcessCount": int64(9),
		"selectedProcessGroups":  []any{"storage-a", "storage-b", "storage-c"},
		"volumeRetentionSeconds": int64(2592000), "volumeGCMode": "ObserveOnly",
		"volumeInventory": []any{},
	}
	objects := []runtime.Object{}
	for _, processGroup := range []string{"storage-a", "storage-b", "storage-c"} {
		pvcUID, pvUID := "pvc-"+processGroup, "pv-"+processGroup
		pvName, diskID := "pv-"+processGroup, "disk-"+processGroup
		inventory, _, _ := unstructured.NestedSlice(operation.Object, "spec", "volumeInventory")
		inventory = append(inventory, map[string]any{
			"processGroupID": processGroup, "pvcName": "pvc-" + processGroup, "pvcUID": pvcUID,
			"pvName": pvName, "pvUID": pvUID, "cbsDiskID": diskID,
		})
		if err := unstructured.SetNestedSlice(operation.Object, inventory, "spec", "volumeInventory"); err != nil {
			t.Fatal(err)
		}
		objects = append(objects, &corev1.PersistentVolume{ObjectMeta: metav1.ObjectMeta{
			Name: pvName, UID: types.UID(pvUID), Annotations: map[string]string{
				FDBVolumeProcessGroup: processGroup, FDBVolumeCBSDiskID: diskID,
			},
		}, Spec: corev1.PersistentVolumeSpec{
			PersistentVolumeReclaimPolicy: corev1.PersistentVolumeReclaimRetain,
		}, Status: corev1.PersistentVolumeStatus{Phase: corev1.VolumeReleased}})
	}
	kubeClient := fake.NewClientBuilder().WithScheme(operatorTestScheme()).WithRuntimeObjects(objects...).Build()
	reconciler := FDBKubernetesReconciler{Client: kubeClient}
	ready, selected, err := reconciler.ensureVolumeRetirements(context.Background(), cell, cluster, operation)
	if err != nil || !ready {
		t.Fatalf("retirement gate was not ready after exact released inventory: ready=%v err=%v", ready, err)
	}
	if !equality.Semantic.DeepEqual(selected, []string{"storage-a", "storage-b", "storage-c"}) {
		t.Fatalf("selected retired groups = %v", selected)
	}
	retirements := list(fdbVolumeRetirementGVK)
	if err := kubeClient.List(context.Background(), retirements, client.InNamespace(cell.GetNamespace())); err != nil {
		t.Fatal(err)
	}
	if len(retirements.Items) != 3 {
		t.Fatalf("scale-down may not complete without exactly three retirement records; got %d", len(retirements.Items))
	}
}

func TestPlanScaleDownProcessGroupsChoosesNewestPodInEveryZone(t *testing.T) {
	cell, _ := operatorTestObjects("Required")
	cluster := object(fdbClusterGVK)
	cluster.SetName(cell.GetName())
	cluster.SetNamespace(cell.GetNamespace())

	objects := []runtime.Object{cell, cluster}
	inventory := make([]FDBVolumeInventory, 0, 12)
	expected := make([]string, 0, 3)
	base := time.Date(2026, 8, 19, 0, 0, 0, 0, time.UTC)
	for zoneIndex := 0; zoneIndex < 3; zoneIndex++ {
		zone := fmt.Sprintf("zone-%d", zoneIndex)
		for candidateIndex := 0; candidateIndex < 4; candidateIndex++ {
			processGroup := fmt.Sprintf("storage-%d%d", zoneIndex+1, candidateIndex+1)
			nodeName := fmt.Sprintf("node-%d-%d", zoneIndex, candidateIndex)
			node := &corev1.Node{ObjectMeta: metav1.ObjectMeta{Name: nodeName, Labels: map[string]string{
				corev1.LabelTopologyZone: zone, FDBCellNameLabel: cell.GetName(), "fleet.actor.dev/fdb-dedicated": "true",
			}}}
			pod := &corev1.Pod{
				ObjectMeta: metav1.ObjectMeta{
					Name: processGroup, Namespace: cell.GetNamespace(), CreationTimestamp: metav1.NewTime(base.Add(time.Duration(candidateIndex) * time.Minute)),
					Labels: map[string]string{
						"foundationdb.org/fdb-cluster-name": cluster.GetName(), "foundationdb.org/fdb-process-class": "storage",
						"foundationdb.org/fdb-process-group-id": processGroup,
					},
				},
				Spec: corev1.PodSpec{NodeName: nodeName},
				Status: corev1.PodStatus{Phase: corev1.PodRunning, Conditions: []corev1.PodCondition{{
					Type: corev1.PodReady, Status: corev1.ConditionTrue,
				}}},
			}
			objects = append(objects, node, pod)
			inventory = append(inventory, FDBVolumeInventory{ProcessGroupID: processGroup})
			if candidateIndex == 3 {
				expected = append(expected, processGroup)
			}
		}
	}
	kubeClient := fake.NewClientBuilder().WithScheme(operatorTestScheme()).WithRuntimeObjects(objects...).Build()
	reconciler := FDBKubernetesReconciler{Client: kubeClient}
	selected, topology, err := reconciler.planScaleDownProcessGroups(context.Background(), cell, cluster, 12, 9, inventory)
	if err != nil {
		t.Fatal(err)
	}
	sort.Strings(expected)
	if !equality.Semantic.DeepEqual(selected, expected) {
		t.Fatalf("selected process groups = %v, want one newest Pod per zone %v", selected, expected)
	}
	if len(topology) != 3 {
		t.Fatalf("selection topology = %#v, want three entries", topology)
	}
	zones := map[string]struct{}{}
	for _, item := range topology {
		zones[nestedString(item, "zone")] = struct{}{}
	}
	if len(zones) != 3 {
		t.Fatalf("selection topology zones = %#v, want three distinct zones", topology)
	}
}

func TestPublishFDBScaleDownTargetSetsCountAndExactRemovalPlanAtomically(t *testing.T) {
	cluster := object(fdbClusterGVK)
	cluster.SetName("actor-bj-k01")
	cluster.SetNamespace("actor-fdb-cell-system")
	cluster.Object["spec"] = map[string]any{
		"processCounts":         map[string]any{"storage": int64(12)},
		"databaseConfiguration": map[string]any{"storage": int64(12)},
	}
	operation := object(fdbScaleOperationGVK)
	operation.SetName("scale-down")
	operation.SetNamespace(cluster.GetNamespace())
	operation.Object["spec"] = map[string]any{
		"fromProcessCount": int64(12), "toProcessCount": int64(9),
		"selectedProcessGroups": []any{"storage-14", "storage-24", "storage-34"},
	}
	kubeClient := fake.NewClientBuilder().WithScheme(operatorTestScheme()).WithObjects(cluster).Build()
	reconciler := FDBKubernetesReconciler{Client: kubeClient}
	if err := reconciler.publishFDBScaleDownTarget(context.Background(), operation, cluster, 9); err != nil {
		t.Fatal(err)
	}
	updated := object(fdbClusterGVK)
	if err := kubeClient.Get(context.Background(), types.NamespacedName{Name: cluster.GetName(), Namespace: cluster.GetNamespace()}, updated); err != nil {
		t.Fatal(err)
	}
	if got := nestedInt64(updated.Object, "spec", "processCounts", "storage"); got != 9 {
		t.Fatalf("process target = %d, want 9", got)
	}
	if got := nestedInt64(updated.Object, "spec", "databaseConfiguration", "storage"); got != 9 {
		t.Fatalf("database storage target = %d, want 9", got)
	}
	selected, _, err := unstructured.NestedStringSlice(updated.Object, "spec", "processGroupsToRemove")
	if err != nil || !equality.Semantic.DeepEqual(selected, []string{"storage-14", "storage-24", "storage-34"}) {
		t.Fatalf("published removal plan = %v, err=%v", selected, err)
	}
}

func testTKEMachineSet(minimum, ready int64) *unstructured.Unstructured {
	machineSet := object(tkeMachineSetGVK)
	machineSet.SetName("np-fdbpool0")
	machineSet.SetUID(types.UID("fdb-machineset-uid"))
	machineSet.SetGeneration(3)
	machineSet.Object["spec"] = map[string]any{
		"type": "Native", "replicas": minimum, "deletePolicy": "Newest",
		"scaling": map[string]any{"createPolicy": "ZoneEquality", "minReplicas": minimum, "maxReplicas": int64(30)},
		"template": map[string]any{"spec": map[string]any{"metadata": map[string]any{"labels": map[string]any{
			FDBCellNameLabel: "actor-bj-k01", "fleet.actor.dev/fdb-dedicated": "true",
		}}}},
	}
	machineSet.Object["status"] = map[string]any{
		"replicas": ready, "readyReplicas": ready, "availableReplicas": ready, "observedGeneration": int64(3),
	}
	return machineSet
}
