package controller

import (
	"context"
	"strings"
	"testing"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	policyv1 "k8s.io/api/policy/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	apimeta "k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	clientgoscheme "k8s.io/client-go/kubernetes/scheme"
	"k8s.io/utils/ptr"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"

	velagwv1alpha1 "git.woa.com/wisp/mono2/llmgateway/internal/velagwset/api/v1alpha1"
)

func TestReconcileManagedSetCreatesOneSetRuntime(t *testing.T) {
	t.Parallel()

	scheme := runtime.NewScheme()
	if err := clientgoscheme.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	if err := velagwv1alpha1.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}

	set := newManagedSet()
	secret := &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{Name: "set-a-runtime", Namespace: "llmgateway"},
		StringData: map[string]string{
			"SQL_DSN":           "root:secret@tcp(mysql:3306)/newapi_set_a",
			"REDIS_CONN_STRING": "redis://:secret@redis:6379/1",
			"SESSION_SECRET":    "session-secret",
		},
	}
	cl := fake.NewClientBuilder().WithScheme(scheme).WithStatusSubresource(set).WithObjects(set, secret).Build()
	reconciler := &VelaGWSetReconciler{Client: cl, Scheme: scheme}

	request := ctrl.Request{NamespacedName: types.NamespacedName{Name: set.Name, Namespace: set.Namespace}}
	if _, err := reconciler.Reconcile(context.Background(), request); err != nil {
		t.Fatalf("add VelaGWSet finalizer: %v", err)
	}
	if _, err := reconciler.Reconcile(context.Background(), request); err != nil {
		t.Fatalf("reconcile VelaGWSet: %v", err)
	}

	assertObjectExists(t, cl, "llmgateway", "fleet-demo-set-a-newapi-admin-master", &appsv1.Deployment{})
	traffic := &appsv1.Deployment{}
	assertObjectExists(t, cl, "llmgateway", "fleet-demo-set-a-g7-newapi-traffic", traffic)
	if got := *traffic.Spec.Replicas; got != 3 {
		t.Fatalf("traffic replicas = %d, want 3", got)
	}
	if got := traffic.Spec.Template.Spec.Containers[0].Image; got != "new-api@sha256:traffic" {
		t.Fatalf("traffic image = %q", got)
	}
	if got := traffic.Spec.Template.Spec.Containers[0].EnvFrom[0].SecretRef.Name; got != "set-a-runtime" {
		t.Fatalf("traffic runtime secret = %q", got)
	}
	assertPoolSecretKey(t, traffic.Spec.Template.Spec.Containers[0], "SQL_MAX_OPEN_CONNS", "TRAFFIC_SQL_MAX_OPEN_CONNS")
	admin := &appsv1.Deployment{}
	assertObjectExists(t, cl, "llmgateway", "fleet-demo-set-a-newapi-admin-master", admin)
	assertPoolSecretKey(t, admin.Spec.Template.Spec.Containers[0], "SQL_MAX_OPEN_CONNS", "ADMIN_SQL_MAX_OPEN_CONNS")
	if got := traffic.Spec.Template.Spec.PriorityClassName; got != "system-node-critical" {
		t.Fatalf("traffic priority class = %q, want system-node-critical", got)
	}
	if len(traffic.Spec.Template.Spec.ImagePullSecrets) != 1 || traffic.Spec.Template.Spec.ImagePullSecrets[0].Name != "tcr-pull-secret" {
		t.Fatalf("traffic image pull secrets = %+v", traffic.Spec.Template.Spec.ImagePullSecrets)
	}
	if traffic.Spec.Template.Spec.NodeSelector["llmgateway.io/runtime"] != "serverless" || len(traffic.Spec.Template.Spec.Tolerations) != 1 {
		t.Fatalf("traffic serverless scheduling = selector=%v tolerations=%v", traffic.Spec.Template.Spec.NodeSelector, traffic.Spec.Template.Spec.Tolerations)
	}
	if len(traffic.Spec.Template.Spec.TopologySpreadConstraints) != 1 || traffic.Spec.Template.Spec.TopologySpreadConstraints[0].TopologyKey != "topology.kubernetes.io/zone" {
		t.Fatalf("traffic topology spread = %+v", traffic.Spec.Template.Spec.TopologySpreadConstraints)
	}
	if *traffic.Spec.Template.Spec.TerminationGracePeriodSeconds != 330 {
		t.Fatalf("traffic termination grace=%d want 330", *traffic.Spec.Template.Spec.TerminationGracePeriodSeconds)
	}

	assertObjectExists(t, cl, "llmgateway", "fleet-demo-set-a-newapi-admin", &corev1.Service{})
	assertObjectExists(t, cl, "llmgateway", "fleet-demo-set-a-g7-newapi-traffic", &corev1.Service{})
	pdb := &policyv1.PodDisruptionBudget{}
	assertObjectExists(t, cl, "llmgateway", "fleet-demo-set-a-g7-newapi-traffic", pdb)
	if pdb.Spec.MinAvailable == nil || pdb.Spec.MinAvailable.IntValue() != 1 {
		t.Fatalf("traffic PDB minAvailable=%v want 1", pdb.Spec.MinAvailable)
	}

	updated := &velagwv1alpha1.VelaGWSet{}
	if err := cl.Get(context.Background(), request.NamespacedName, updated); err != nil {
		t.Fatal(err)
	}
	if !containsString(updated.Finalizers, RuntimeCleanupFinalizer) {
		t.Fatalf("finalizers = %v, want %q", updated.Finalizers, RuntimeCleanupFinalizer)
	}
}

func assertPoolSecretKey(t *testing.T, container corev1.Container, envName, secretKey string) {
	t.Helper()
	for _, env := range container.Env {
		if env.Name == envName && env.ValueFrom != nil && env.ValueFrom.SecretKeyRef != nil && env.ValueFrom.SecretKeyRef.Key == secretKey && env.ValueFrom.SecretKeyRef.Optional != nil && *env.ValueFrom.SecretKeyRef.Optional {
			return
		}
	}
	t.Fatalf("container %s missing optional %s from secret key %s: %+v", container.Name, envName, secretKey, container.Env)
}

func TestReconcileBootstrapSetStartsOnlyAdmin(t *testing.T) {
	t.Parallel()

	scheme := runtime.NewScheme()
	if err := clientgoscheme.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	if err := velagwv1alpha1.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	set := newManagedSet()
	set.Finalizers = []string{RuntimeCleanupFinalizer}
	set.Spec.TrafficRuntimes[0].Replicas = 0
	cl := fake.NewClientBuilder().WithScheme(scheme).WithStatusSubresource(set).WithObjects(set).Build()
	reconciler := &VelaGWSetReconciler{Client: cl, Scheme: scheme}
	request := ctrl.Request{NamespacedName: types.NamespacedName{Name: set.Name, Namespace: set.Namespace}}

	if _, err := reconciler.Reconcile(context.Background(), request); err != nil {
		t.Fatal(err)
	}
	assertObjectExists(t, cl, set.Namespace, "fleet-demo-set-a-newapi-admin-master", &appsv1.Deployment{})
	for _, object := range []client.Object{&appsv1.Deployment{}, &corev1.Service{}, &policyv1.PodDisruptionBudget{}} {
		err := cl.Get(context.Background(), types.NamespacedName{Namespace: set.Namespace, Name: "fleet-demo-set-a-g7-newapi-traffic"}, object)
		if !apierrors.IsNotFound(err) {
			t.Fatalf("bootstrap traffic object %T error = %v, want not found", object, err)
		}
	}
}

func TestUpdateStatusSeparatesAdminReadyFromServingReady(t *testing.T) {
	t.Parallel()

	scheme := runtime.NewScheme()
	if err := clientgoscheme.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	if err := velagwv1alpha1.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	set := newManagedSet()
	set.Generation = 4
	set.Spec.TrafficRuntimes[0].Replicas = 0
	admin := desiredAdminDeployment(set)
	admin.Generation = 2
	admin.Status.ObservedGeneration = 2
	admin.Status.UpdatedReplicas = 1
	admin.Status.ReadyReplicas = 1
	admin.Status.AvailableReplicas = 1
	cl := fake.NewClientBuilder().WithScheme(scheme).WithStatusSubresource(set).WithObjects(set, admin).Build()
	reconciler := &VelaGWSetReconciler{Client: cl, Scheme: scheme}

	if err := reconciler.updateStatus(context.Background(), set); err != nil {
		t.Fatal(err)
	}
	updated := &velagwv1alpha1.VelaGWSet{}
	if err := cl.Get(context.Background(), client.ObjectKeyFromObject(set), updated); err != nil {
		t.Fatal(err)
	}
	adminReady := apimeta.FindStatusCondition(updated.Status.Conditions, "AdminReady")
	if adminReady == nil || adminReady.Status != metav1.ConditionTrue {
		t.Fatalf("AdminReady = %+v, want true", adminReady)
	}
	ready := apimeta.FindStatusCondition(updated.Status.Conditions, "Ready")
	if ready == nil || ready.Status != metav1.ConditionFalse || ready.Reason != "AwaitingTrafficActivation" {
		t.Fatalf("Ready = %+v, want AwaitingTrafficActivation", ready)
	}
}

func TestReconcileManagedSetDoesNotRequireSecretReadPermission(t *testing.T) {
	t.Parallel()

	scheme := runtime.NewScheme()
	if err := clientgoscheme.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	if err := velagwv1alpha1.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	set := newManagedSet()
	set.Finalizers = []string{RuntimeCleanupFinalizer}
	base := fake.NewClientBuilder().WithScheme(scheme).WithStatusSubresource(set).WithObjects(set).Build()
	reconciler := &VelaGWSetReconciler{Client: &secretDenyingClient{Client: base}, Scheme: scheme}
	request := ctrl.Request{NamespacedName: types.NamespacedName{Name: set.Name, Namespace: set.Namespace}}

	if _, err := reconciler.Reconcile(context.Background(), request); err != nil {
		t.Fatalf("reconcile attempted to read the runtime Secret: %v", err)
	}
	assertObjectExists(t, base, set.Namespace, "fleet-demo-set-a-newapi-admin-master", &appsv1.Deployment{})
}

func TestReconcileObjectDoesNotUpdateUnchangedChild(t *testing.T) {
	t.Parallel()

	scheme := runtime.NewScheme()
	if err := clientgoscheme.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	if err := velagwv1alpha1.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	set := newManagedSet()
	base := fake.NewClientBuilder().WithScheme(scheme).WithObjects(set).Build()
	tracked := &updateCountingClient{Client: base}
	reconciler := &VelaGWSetReconciler{Client: tracked, Scheme: scheme}

	if err := reconciler.reconcileObject(context.Background(), set, desiredAdminDeployment(set)); err != nil {
		t.Fatal(err)
	}
	if err := reconciler.reconcileObject(context.Background(), set, desiredAdminDeployment(set)); err != nil {
		t.Fatal(err)
	}
	if tracked.childUpdates != 0 {
		t.Fatalf("unchanged child updates = %d, want 0", tracked.childUpdates)
	}
}

func TestReconcileObjectRefusesToTakeOverForeignChild(t *testing.T) {
	t.Parallel()

	scheme := runtime.NewScheme()
	if err := clientgoscheme.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	if err := velagwv1alpha1.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	set := newManagedSet()
	existing := desiredAdminDeployment(set)
	existing.OwnerReferences = []metav1.OwnerReference{{
		APIVersion: "gateway.lightvela.com/v1alpha1",
		Kind:       "VelaGWSet",
		Name:       "another-set",
		UID:        types.UID("another-set-uid"),
		Controller: ptr.To(true),
	}}
	existing.Spec.Replicas = ptr.To[int32](9)
	cl := fake.NewClientBuilder().WithScheme(scheme).WithObjects(set, existing).Build()
	reconciler := &VelaGWSetReconciler{Client: cl, Scheme: scheme}

	err := reconciler.reconcileObject(context.Background(), set, desiredAdminDeployment(set))
	if err == nil || !strings.Contains(err.Error(), "refuse to manage") {
		t.Fatalf("foreign child reconcile error = %v, want ownership refusal", err)
	}
	after := &appsv1.Deployment{}
	assertObjectExists(t, cl, existing.Namespace, existing.Name, after)
	if got := *after.Spec.Replicas; got != 9 {
		t.Fatalf("foreign child replicas = %d after reconcile, want 9", got)
	}
	if owner := metav1.GetControllerOf(after); owner == nil || owner.UID != types.UID("another-set-uid") {
		t.Fatalf("foreign child owner was overwritten: %#v", owner)
	}
}

func TestReconcileObjectPatchesThroughConcurrentStatusUpdates(t *testing.T) {
	t.Parallel()

	scheme := runtime.NewScheme()
	if err := clientgoscheme.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	if err := velagwv1alpha1.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	set := newManagedSet()
	existing := desiredAdminDeployment(set)
	if err := controllerutil.SetControllerReference(set, existing, scheme); err != nil {
		t.Fatal(err)
	}
	existing.Spec.Template.Spec.Containers[0].Image = "new-api@sha256:previous-admin"
	base := fake.NewClientBuilder().WithScheme(scheme).WithObjects(set, existing).Build()
	cl := &conflictOnChildUpdateClient{Client: base}
	reconciler := &VelaGWSetReconciler{Client: cl, Scheme: scheme}

	if err := reconciler.reconcileObject(context.Background(), set, desiredAdminDeployment(set)); err != nil {
		t.Fatalf("reconcile through concurrent status update: %v", err)
	}
	after := &appsv1.Deployment{}
	assertObjectExists(t, base, existing.Namespace, existing.Name, after)
	if got := after.Spec.Template.Spec.Containers[0].Image; got != set.Spec.Admin.Image {
		t.Fatalf("admin image = %q, want %q", got, set.Spec.Admin.Image)
	}
	if cl.childPatches != 1 {
		t.Fatalf("child patches = %d, want 1", cl.childPatches)
	}
}

func TestReconcileDeleteWithoutApprovalKeepsFinalizerAndChildren(t *testing.T) {
	t.Parallel()

	scheme := runtime.NewScheme()
	if err := clientgoscheme.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	if err := velagwv1alpha1.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	set := newManagedSet()
	set.Finalizers = []string{RuntimeCleanupFinalizer}
	now := metav1.NewTime(time.Now())
	set.DeletionTimestamp = &now
	child := desiredAdminDeployment(set)
	if err := controllerutil.SetControllerReference(set, child, scheme); err != nil {
		t.Fatal(err)
	}
	cl := fake.NewClientBuilder().WithScheme(scheme).WithStatusSubresource(set).WithObjects(set, child).Build()
	reconciler := &VelaGWSetReconciler{Client: cl, Scheme: scheme}
	request := ctrl.Request{NamespacedName: types.NamespacedName{Name: set.Name, Namespace: set.Namespace}}

	if _, err := reconciler.Reconcile(context.Background(), request); err != nil {
		t.Fatal(err)
	}
	updated := &velagwv1alpha1.VelaGWSet{}
	if err := cl.Get(context.Background(), request.NamespacedName, updated); err != nil {
		t.Fatal(err)
	}
	if !containsString(updated.Finalizers, RuntimeCleanupFinalizer) {
		t.Fatal("unapproved deletion removed the runtime finalizer")
	}
	assertObjectExists(t, cl, set.Namespace, child.Name, &appsv1.Deployment{})
}

func TestReconcileDeleteWithApprovalRemovesOwnedChildrenThenFinalizer(t *testing.T) {
	t.Parallel()

	scheme := runtime.NewScheme()
	if err := clientgoscheme.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	if err := velagwv1alpha1.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	set := newManagedSet()
	set.Finalizers = []string{RuntimeCleanupFinalizer}
	now := metav1.NewTime(time.Now())
	set.DeletionTimestamp = &now
	set.Spec.DecommissionApproval = &velagwv1alpha1.DecommissionApproval{
		RequestID: "cleanup-1", Attempt: 1, ApprovedAt: now, CRUID: string(set.UID),
		FleetRef: set.Spec.FleetRef, ShardRef: set.Spec.ShardRef,
		DatabaseName: set.Spec.DatabaseName, RedisDB: set.Spec.RedisDB,
	}
	child := desiredAdminDeployment(set)
	if err := controllerutil.SetControllerReference(set, child, scheme); err != nil {
		t.Fatal(err)
	}
	cl := fake.NewClientBuilder().WithScheme(scheme).WithStatusSubresource(set).WithObjects(set, child).Build()
	reconciler := &VelaGWSetReconciler{Client: cl, Scheme: scheme}
	request := ctrl.Request{NamespacedName: types.NamespacedName{Name: set.Name, Namespace: set.Namespace}}

	if _, err := reconciler.Reconcile(context.Background(), request); err != nil {
		t.Fatal(err)
	}
	if err := cl.Get(context.Background(), types.NamespacedName{Namespace: set.Namespace, Name: child.Name}, &appsv1.Deployment{}); !apierrors.IsNotFound(err) {
		t.Fatalf("owned child still exists after approved deletion: %v", err)
	}
	if _, err := reconciler.Reconcile(context.Background(), request); err != nil {
		t.Fatal(err)
	}
	updated := &velagwv1alpha1.VelaGWSet{}
	if err := cl.Get(context.Background(), request.NamespacedName, updated); err == nil && containsString(updated.Finalizers, RuntimeCleanupFinalizer) {
		t.Fatal("approved deletion kept the runtime finalizer after children disappeared")
	}
}

func TestReconcileDeleteRemovesOwnedTrafficGenerationOmittedFromSpec(t *testing.T) {
	t.Parallel()

	scheme := runtime.NewScheme()
	if err := clientgoscheme.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	if err := velagwv1alpha1.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	set := newManagedSet()
	set.Finalizers = []string{RuntimeCleanupFinalizer}
	now := metav1.NewTime(time.Now())
	set.DeletionTimestamp = &now
	set.Spec.DecommissionApproval = &velagwv1alpha1.DecommissionApproval{
		RequestID: "cleanup-omitted", Attempt: 1, ApprovedAt: now, CRUID: string(set.UID),
		FleetRef: set.Spec.FleetRef, ShardRef: set.Spec.ShardRef,
		DatabaseName: set.Spec.DatabaseName, RedisDB: set.Spec.RedisDB,
	}
	omitted := desiredTrafficDeployment(set, velagwv1alpha1.TrafficRuntimeSpec{
		Generation: 6,
		Image:      "new-api@sha256:old-traffic",
		Replicas:   1,
	})
	if err := controllerutil.SetControllerReference(set, omitted, scheme); err != nil {
		t.Fatal(err)
	}
	cl := fake.NewClientBuilder().WithScheme(scheme).WithStatusSubresource(set).WithObjects(set, omitted).Build()
	reconciler := &VelaGWSetReconciler{Client: cl, Scheme: scheme}
	request := ctrl.Request{NamespacedName: types.NamespacedName{Name: set.Name, Namespace: set.Namespace}}

	if _, err := reconciler.Reconcile(context.Background(), request); err != nil {
		t.Fatal(err)
	}
	err := cl.Get(context.Background(), client.ObjectKeyFromObject(omitted), &appsv1.Deployment{})
	if !apierrors.IsNotFound(err) {
		t.Fatalf("omitted owned generation survived approved deletion: %v", err)
	}
}

func TestReconcileObserveDoesNotAddFinalizerOrMutateExistingResources(t *testing.T) {
	t.Parallel()

	scheme := runtime.NewScheme()
	if err := clientgoscheme.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	if err := velagwv1alpha1.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	set := newManagedSet()
	set.Spec.ManagementPolicy = velagwv1alpha1.ManagementPolicyObserve
	existing := desiredAdminDeployment(set)
	existing.OwnerReferences = nil
	existing.Spec.Replicas = ptr.To[int32](7)
	base := fake.NewClientBuilder().WithScheme(scheme).WithStatusSubresource(set).WithObjects(set, existing).Build()
	tracked := &updateCountingClient{Client: base}
	reconciler := &VelaGWSetReconciler{Client: tracked, Scheme: scheme}
	request := ctrl.Request{NamespacedName: types.NamespacedName{Name: set.Name, Namespace: set.Namespace}}

	if _, err := reconciler.Reconcile(context.Background(), request); err != nil {
		t.Fatal(err)
	}
	updated := &velagwv1alpha1.VelaGWSet{}
	if err := base.Get(context.Background(), request.NamespacedName, updated); err != nil {
		t.Fatal(err)
	}
	if containsString(updated.Finalizers, RuntimeCleanupFinalizer) {
		t.Fatal("Observe policy added a runtime cleanup finalizer")
	}
	if tracked.childUpdates != 0 {
		t.Fatalf("Observe policy updated %d children", tracked.childUpdates)
	}
	after := &appsv1.Deployment{}
	assertObjectExists(t, base, existing.Namespace, existing.Name, after)
	if got := *after.Spec.Replicas; got != 7 {
		t.Fatalf("Observe policy changed replicas to %d", got)
	}
}

func TestReconcileAddsFinalizerBeforeCreatingChildren(t *testing.T) {
	t.Parallel()

	scheme := runtime.NewScheme()
	if err := clientgoscheme.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	if err := velagwv1alpha1.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	set := newManagedSet()
	cl := fake.NewClientBuilder().WithScheme(scheme).WithStatusSubresource(set).WithObjects(set).Build()
	reconciler := &VelaGWSetReconciler{Client: cl, Scheme: scheme}
	request := ctrl.Request{NamespacedName: types.NamespacedName{Name: set.Name, Namespace: set.Namespace}}

	if _, err := reconciler.Reconcile(context.Background(), request); err != nil {
		t.Fatalf("add finalizer: %v", err)
	}
	deployment := &appsv1.Deployment{}
	err := cl.Get(context.Background(), types.NamespacedName{Namespace: set.Namespace, Name: "fleet-demo-set-a-newapi-admin-master"}, deployment)
	if err == nil {
		t.Fatal("admin Deployment was created before the VelaGWSet finalizer was persisted")
	}
}

func TestReconcileRemovesOnlyOmittedOwnedTrafficGeneration(t *testing.T) {
	t.Parallel()

	scheme := runtime.NewScheme()
	if err := clientgoscheme.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	if err := velagwv1alpha1.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	set := newManagedSet()
	set.Spec.TrafficRuntimes = append(set.Spec.TrafficRuntimes, velagwv1alpha1.TrafficRuntimeSpec{
		Generation: 8,
		Image:      "new-api@sha256:traffic-next",
		Replicas:   2,
	})
	secret := &corev1.Secret{ObjectMeta: metav1.ObjectMeta{Name: "set-a-runtime", Namespace: "llmgateway"}}
	cl := fake.NewClientBuilder().WithScheme(scheme).WithStatusSubresource(set).WithObjects(set, secret).Build()
	reconciler := &VelaGWSetReconciler{Client: cl, Scheme: scheme}
	request := ctrl.Request{NamespacedName: types.NamespacedName{Name: set.Name, Namespace: set.Namespace}}

	if _, err := reconciler.Reconcile(context.Background(), request); err != nil {
		t.Fatal(err)
	}
	if _, err := reconciler.Reconcile(context.Background(), request); err != nil {
		t.Fatal(err)
	}
	current := &velagwv1alpha1.VelaGWSet{}
	if err := cl.Get(context.Background(), request.NamespacedName, current); err != nil {
		t.Fatal(err)
	}
	current.Spec.TrafficRuntimes = current.Spec.TrafficRuntimes[1:]
	if err := cl.Update(context.Background(), current); err != nil {
		t.Fatal(err)
	}
	if _, err := reconciler.Reconcile(context.Background(), request); err != nil {
		t.Fatal(err)
	}

	removed := &appsv1.Deployment{}
	err := cl.Get(context.Background(), types.NamespacedName{Namespace: "llmgateway", Name: "fleet-demo-set-a-g7-newapi-traffic"}, removed)
	if !apierrors.IsNotFound(err) {
		t.Fatalf("generation 7 Deployment still exists: %v", err)
	}
	assertObjectExists(t, cl, "llmgateway", "fleet-demo-set-a-g8-newapi-traffic", &appsv1.Deployment{})
	assertObjectExists(t, cl, "llmgateway", "fleet-demo-set-a-newapi-admin-master", &appsv1.Deployment{})
}

func TestReconcilePublishesReadyStatusForEveryRuntime(t *testing.T) {
	t.Parallel()

	scheme := runtime.NewScheme()
	if err := clientgoscheme.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	if err := velagwv1alpha1.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	set := newManagedSet()
	set.Generation = 4
	set.Finalizers = []string{RuntimeCleanupFinalizer}
	secret := &corev1.Secret{ObjectMeta: metav1.ObjectMeta{Name: "set-a-runtime", Namespace: "llmgateway"}}
	cl := fake.NewClientBuilder().WithScheme(scheme).WithStatusSubresource(set, &appsv1.Deployment{}).WithObjects(set, secret).Build()
	reconciler := &VelaGWSetReconciler{Client: cl, Scheme: scheme}
	request := ctrl.Request{NamespacedName: types.NamespacedName{Name: set.Name, Namespace: set.Namespace}}
	if _, err := reconciler.Reconcile(context.Background(), request); err != nil {
		t.Fatal(err)
	}

	admin := &appsv1.Deployment{}
	assertObjectExists(t, cl, "llmgateway", "fleet-demo-set-a-newapi-admin-master", admin)
	admin.Status.ReadyReplicas = 1
	admin.Status.AvailableReplicas = 1
	admin.Status.UpdatedReplicas = 1
	admin.Status.ObservedGeneration = admin.Generation
	if err := cl.Status().Update(context.Background(), admin); err != nil {
		t.Fatal(err)
	}
	traffic := &appsv1.Deployment{}
	assertObjectExists(t, cl, "llmgateway", "fleet-demo-set-a-g7-newapi-traffic", traffic)
	traffic.Status.ReadyReplicas = 3
	traffic.Status.AvailableReplicas = 3
	traffic.Status.UpdatedReplicas = 3
	traffic.Status.ObservedGeneration = traffic.Generation
	if err := cl.Status().Update(context.Background(), traffic); err != nil {
		t.Fatal(err)
	}
	result, err := reconciler.Reconcile(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	if result.Requeue || result.RequeueAfter > 0 {
		t.Fatalf("ready Set requeue result = %#v, want no scheduled retry", result)
	}

	updated := &velagwv1alpha1.VelaGWSet{}
	if err := cl.Get(context.Background(), request.NamespacedName, updated); err != nil {
		t.Fatal(err)
	}
	if updated.Status.ObservedGeneration != 4 {
		t.Fatalf("observed generation = %d, want 4", updated.Status.ObservedGeneration)
	}
	if updated.Status.AdminReadyReplicas != 1 {
		t.Fatalf("admin ready replicas = %d, want 1", updated.Status.AdminReadyReplicas)
	}
	if len(updated.Status.TrafficRuntimes) != 1 || updated.Status.TrafficRuntimes[0].ReadyReplicas != 3 {
		t.Fatalf("traffic runtime status = %#v", updated.Status.TrafficRuntimes)
	}
	ready := apimeta.FindStatusCondition(updated.Status.Conditions, "Ready")
	if ready == nil || ready.Status != metav1.ConditionTrue {
		t.Fatalf("Ready condition = %#v", ready)
	}
}

func TestReconcileRequeuesWhileRuntimeResourcesArePending(t *testing.T) {
	t.Parallel()

	scheme := runtime.NewScheme()
	if err := clientgoscheme.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	if err := velagwv1alpha1.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	set := newManagedSet()
	set.Finalizers = []string{RuntimeCleanupFinalizer}
	cl := fake.NewClientBuilder().WithScheme(scheme).WithStatusSubresource(set).WithObjects(set).Build()
	reconciler := &VelaGWSetReconciler{Client: cl, Scheme: scheme}
	request := ctrl.Request{NamespacedName: types.NamespacedName{Name: set.Name, Namespace: set.Namespace}}

	result, err := reconciler.Reconcile(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	if result.RequeueAfter <= 0 {
		t.Fatalf("pending Set requeue result = %#v, want a scheduled retry", result)
	}
}

func TestUpdateStatusPersistsReadyConditionTransition(t *testing.T) {
	t.Parallel()

	scheme := runtime.NewScheme()
	if err := clientgoscheme.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	if err := velagwv1alpha1.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	set := newManagedSet()
	set.Generation = 10
	set.Finalizers = []string{RuntimeCleanupFinalizer}
	set.Status.Conditions = []metav1.Condition{{
		Type:               "Ready",
		Status:             metav1.ConditionFalse,
		ObservedGeneration: 10,
		Reason:             "WaitingForResources",
		Message:            "waiting",
		LastTransitionTime: metav1.Now(),
	}}
	set.Status.ObservedGeneration = 10
	set.Status.AdminReadyReplicas = 1
	set.Status.TrafficRuntimes = []velagwv1alpha1.TrafficRuntimeStatus{{
		Generation: 7, DesiredReplicas: 3, ReadyReplicas: 3, AvailableReplicas: 3,
	}}
	admin := desiredAdminDeployment(set)
	admin.Generation = 2
	admin.Status = appsv1.DeploymentStatus{ObservedGeneration: 2, ReadyReplicas: 1, UpdatedReplicas: 1, AvailableReplicas: 1}
	traffic := desiredTrafficDeployment(set, set.Spec.TrafficRuntimes[0])
	traffic.Generation = 3
	traffic.Status = appsv1.DeploymentStatus{ObservedGeneration: 3, ReadyReplicas: 3, UpdatedReplicas: 3, AvailableReplicas: 3}
	base := fake.NewClientBuilder().WithScheme(scheme).
		WithStatusSubresource(set, &appsv1.Deployment{}).
		WithObjects(set, admin, traffic).
		Build()
	cl := &statusUpdateCountingClient{Client: base}
	reconciler := &VelaGWSetReconciler{Client: cl, Scheme: scheme}

	if err := reconciler.updateStatus(context.Background(), set); err != nil {
		t.Fatal(err)
	}
	if cl.statusUpdates != 1 {
		t.Fatalf("status updates = %d, want 1 for Ready False -> True transition", cl.statusUpdates)
	}
	stored := &velagwv1alpha1.VelaGWSet{}
	if err := base.Get(context.Background(), client.ObjectKeyFromObject(set), stored); err != nil {
		t.Fatal(err)
	}
	ready := apimeta.FindStatusCondition(stored.Status.Conditions, "Ready")
	if ready == nil || ready.Status != metav1.ConditionTrue {
		t.Fatalf("stored Ready condition = %#v, want True", ready)
	}
}

func TestReconcileDoesNotPublishReadyForStaleDeploymentGeneration(t *testing.T) {
	t.Parallel()

	scheme := runtime.NewScheme()
	if err := clientgoscheme.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	if err := velagwv1alpha1.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	set := newManagedSet()
	set.Generation = 8
	set.Finalizers = []string{RuntimeCleanupFinalizer}
	admin := desiredAdminDeployment(set)
	admin.Generation = 5
	admin.Status = appsv1.DeploymentStatus{
		ObservedGeneration: 4,
		ReadyReplicas:      1,
		UpdatedReplicas:    1,
		AvailableReplicas:  1,
	}
	if err := controllerutil.SetControllerReference(set, admin, scheme); err != nil {
		t.Fatal(err)
	}
	traffic := desiredTrafficDeployment(set, set.Spec.TrafficRuntimes[0])
	traffic.Generation = 6
	traffic.Status = appsv1.DeploymentStatus{
		ObservedGeneration: 6,
		ReadyReplicas:      3,
		UpdatedReplicas:    3,
		AvailableReplicas:  3,
	}
	if err := controllerutil.SetControllerReference(set, traffic, scheme); err != nil {
		t.Fatal(err)
	}
	cl := fake.NewClientBuilder().WithScheme(scheme).
		WithStatusSubresource(set, &appsv1.Deployment{}).
		WithObjects(set, admin, traffic).
		Build()
	reconciler := &VelaGWSetReconciler{Client: cl, Scheme: scheme}
	request := ctrl.Request{NamespacedName: types.NamespacedName{Name: set.Name, Namespace: set.Namespace}}

	if _, err := reconciler.Reconcile(context.Background(), request); err != nil {
		t.Fatal(err)
	}
	updated := &velagwv1alpha1.VelaGWSet{}
	if err := cl.Get(context.Background(), request.NamespacedName, updated); err != nil {
		t.Fatal(err)
	}
	ready := apimeta.FindStatusCondition(updated.Status.Conditions, "Ready")
	if ready == nil || ready.Status != metav1.ConditionFalse {
		t.Fatalf("Ready condition = %#v, want False while deployment status observes an old generation", ready)
	}
}

func TestReconcileDoesNotPublishReadyWhileCachedDeploymentSpecIsStale(t *testing.T) {
	t.Parallel()

	scheme := runtime.NewScheme()
	if err := clientgoscheme.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	if err := velagwv1alpha1.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	set := newManagedSet()
	set.Generation = 9
	set.Finalizers = []string{RuntimeCleanupFinalizer}
	admin := desiredAdminDeployment(set)
	admin.Generation = 4
	admin.Spec.Template.Spec.Containers[0].Image = "new-api@sha256:previous-admin"
	admin.Status = appsv1.DeploymentStatus{
		ObservedGeneration: 4,
		ReadyReplicas:      1,
		UpdatedReplicas:    1,
		AvailableReplicas:  1,
	}
	if err := controllerutil.SetControllerReference(set, admin, scheme); err != nil {
		t.Fatal(err)
	}
	traffic := desiredTrafficDeployment(set, set.Spec.TrafficRuntimes[0])
	traffic.Generation = 5
	traffic.Status = appsv1.DeploymentStatus{
		ObservedGeneration: 5,
		ReadyReplicas:      3,
		UpdatedReplicas:    3,
		AvailableReplicas:  3,
	}
	if err := controllerutil.SetControllerReference(set, traffic, scheme); err != nil {
		t.Fatal(err)
	}
	base := fake.NewClientBuilder().WithScheme(scheme).
		WithStatusSubresource(set, &appsv1.Deployment{}).
		WithObjects(set, admin, traffic).
		Build()
	cl := &staleChildUpdateClient{Client: base}
	reconciler := &VelaGWSetReconciler{Client: cl, Scheme: scheme}
	request := ctrl.Request{NamespacedName: types.NamespacedName{Name: set.Name, Namespace: set.Namespace}}

	if _, err := reconciler.Reconcile(context.Background(), request); err != nil {
		t.Fatal(err)
	}
	updated := &velagwv1alpha1.VelaGWSet{}
	if err := base.Get(context.Background(), request.NamespacedName, updated); err != nil {
		t.Fatal(err)
	}
	ready := apimeta.FindStatusCondition(updated.Status.Conditions, "Ready")
	if ready == nil || ready.Status != metav1.ConditionFalse {
		t.Fatalf("Ready condition = %#v, want False while cached Deployment spec is stale", ready)
	}
}

func TestNewAPIRolesEnableBatchUpdatesOnlyOnAdminMaster(t *testing.T) {
	t.Parallel()

	set := newManagedSet()
	admin := desiredAdminDeployment(set)
	traffic := desiredTrafficDeployment(set, set.Spec.TrafficRuntimes[0])
	if got := envValue(admin.Spec.Template.Spec.Containers[0].Env, "BATCH_UPDATE_ENABLED"); got != "true" {
		t.Fatalf("admin BATCH_UPDATE_ENABLED = %q, want true", got)
	}
	if got := envValue(traffic.Spec.Template.Spec.Containers[0].Env, "BATCH_UPDATE_ENABLED"); got != "false" {
		t.Fatalf("traffic BATCH_UPDATE_ENABLED = %q, want false", got)
	}
}

func TestNewAPIDeploymentsPropagateSubscriptionQuotaPacingEffectiveAt(t *testing.T) {
	t.Setenv("SUBSCRIPTION_QUOTA_PACING_EFFECTIVE_AT", "1800000000")

	set := newManagedSet()
	admin := desiredAdminDeployment(set)
	traffic := desiredTrafficDeployment(set, set.Spec.TrafficRuntimes[0])

	for _, deployment := range []*appsv1.Deployment{admin, traffic} {
		got := envValue(deployment.Spec.Template.Spec.Containers[0].Env, "SUBSCRIPTION_QUOTA_PACING_EFFECTIVE_AT")
		if got != "1800000000" {
			t.Fatalf("deployment %s pacing effective-at = %q, want 1800000000", deployment.Name, got)
		}
	}
}

func TestDesiredDeploymentPinsKubernetesAPIDefaults(t *testing.T) {
	t.Parallel()

	deployment := desiredAdminDeployment(newManagedSet())
	pod := deployment.Spec.Template.Spec
	container := pod.Containers[0]
	if deployment.Spec.RevisionHistoryLimit == nil || *deployment.Spec.RevisionHistoryLimit != 10 {
		t.Fatalf("revisionHistoryLimit = %v, want 10", deployment.Spec.RevisionHistoryLimit)
	}
	if deployment.Spec.ProgressDeadlineSeconds == nil || *deployment.Spec.ProgressDeadlineSeconds != 600 {
		t.Fatalf("progressDeadlineSeconds = %v, want 600", deployment.Spec.ProgressDeadlineSeconds)
	}
	if pod.RestartPolicy != corev1.RestartPolicyAlways || pod.DNSPolicy != corev1.DNSClusterFirst || pod.SchedulerName != corev1.DefaultSchedulerName {
		t.Fatalf("pod API defaults are not pinned: restart=%q dns=%q scheduler=%q", pod.RestartPolicy, pod.DNSPolicy, pod.SchedulerName)
	}
	if pod.TerminationGracePeriodSeconds == nil || *pod.TerminationGracePeriodSeconds != 60 {
		t.Fatalf("terminationGracePeriodSeconds = %v, want 60", pod.TerminationGracePeriodSeconds)
	}
	if pod.AutomountServiceAccountToken == nil || *pod.AutomountServiceAccountToken {
		t.Fatalf("automountServiceAccountToken = %v, want false", pod.AutomountServiceAccountToken)
	}
	if container.ImagePullPolicy != corev1.PullIfNotPresent || container.Ports[0].Protocol != corev1.ProtocolTCP {
		t.Fatalf("container API defaults are not pinned: pull=%q protocol=%q", container.ImagePullPolicy, container.Ports[0].Protocol)
	}
	if container.ReadinessProbe.SuccessThreshold != 1 || container.ReadinessProbe.HTTPGet.Scheme != corev1.URISchemeHTTP {
		t.Fatalf("probe API defaults are not pinned: success=%d scheme=%q", container.ReadinessProbe.SuccessThreshold, container.ReadinessProbe.HTTPGet.Scheme)
	}
}

func newManagedSet() *velagwv1alpha1.VelaGWSet {
	return &velagwv1alpha1.VelaGWSet{
		ObjectMeta: metav1.ObjectMeta{Name: "set-a", Namespace: "llmgateway", UID: types.UID("set-a-uid")},
		Spec: velagwv1alpha1.VelaGWSetSpec{
			FleetRef:         "fleet-demo",
			ShardRef:         "shard-a",
			DatabaseName:     "newapi_set_a",
			RedisDB:          1,
			RuntimeSecretRef: corev1.LocalObjectReference{Name: "set-a-runtime"},
			ManagementPolicy: velagwv1alpha1.ManagementPolicyManaged,
			Scheduling: velagwv1alpha1.SchedulingSpec{
				PriorityClassName: "system-node-critical", ImagePullSecret: "tcr-pull-secret", ServerlessTraffic: true,
			},
			TrafficAvailability: velagwv1alpha1.TrafficAvailabilitySpec{TopologyKey: "topology.kubernetes.io/zone", PDBMinAvailable: 1},
			Admin: velagwv1alpha1.AdminRuntimeSpec{
				Image: "new-api@sha256:admin",
			},
			TrafficRuntimes: []velagwv1alpha1.TrafficRuntimeSpec{{
				Generation: 7,
				Image:      "new-api@sha256:traffic",
				Replicas:   3,
			}},
		},
	}
}

func assertObjectExists(t *testing.T, cl client.Client, namespace, name string, object client.Object) {
	t.Helper()
	if err := cl.Get(context.Background(), types.NamespacedName{Namespace: namespace, Name: name}, object); err != nil {
		t.Fatalf("get %T %s/%s: %v", object, namespace, name, err)
	}
}

func containsString(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

func envValue(values []corev1.EnvVar, name string) string {
	for _, value := range values {
		if value.Name == name {
			return value.Value
		}
	}
	return ""
}

type updateCountingClient struct {
	client.Client
	childUpdates int
}

type secretDenyingClient struct {
	client.Client
}

type staleChildUpdateClient struct {
	client.Client
}

type conflictOnChildUpdateClient struct {
	client.Client
	childPatches int
}

type statusUpdateCountingClient struct {
	client.Client
	statusUpdates int
}

type statusUpdateCountingWriter struct {
	client.SubResourceWriter
	parent *statusUpdateCountingClient
}

func (c *secretDenyingClient) Get(ctx context.Context, key client.ObjectKey, object client.Object, options ...client.GetOption) error {
	if _, ok := object.(*corev1.Secret); ok {
		return apierrors.NewForbidden(corev1.Resource("secrets"), key.Name, nil)
	}
	return c.Client.Get(ctx, key, object, options...)
}

func (c *staleChildUpdateClient) Update(ctx context.Context, object client.Object, options ...client.UpdateOption) error {
	if _, ok := object.(*appsv1.Deployment); ok {
		return nil
	}
	return c.Client.Update(ctx, object, options...)
}

func (c *staleChildUpdateClient) Patch(ctx context.Context, object client.Object, patch client.Patch, options ...client.PatchOption) error {
	if _, ok := object.(*appsv1.Deployment); ok {
		return nil
	}
	return c.Client.Patch(ctx, object, patch, options...)
}

func (c *conflictOnChildUpdateClient) Update(ctx context.Context, object client.Object, options ...client.UpdateOption) error {
	if _, ok := object.(*appsv1.Deployment); ok {
		return apierrors.NewConflict(appsv1.Resource("deployments"), object.GetName(), nil)
	}
	return c.Client.Update(ctx, object, options...)
}

func (c *conflictOnChildUpdateClient) Patch(ctx context.Context, object client.Object, patch client.Patch, options ...client.PatchOption) error {
	if _, ok := object.(*appsv1.Deployment); ok {
		c.childPatches++
	}
	return c.Client.Patch(ctx, object, patch, options...)
}

func (c *statusUpdateCountingClient) Status() client.SubResourceWriter {
	return &statusUpdateCountingWriter{SubResourceWriter: c.Client.Status(), parent: c}
}

func (w *statusUpdateCountingWriter) Update(ctx context.Context, object client.Object, options ...client.SubResourceUpdateOption) error {
	w.parent.statusUpdates++
	return w.SubResourceWriter.Update(ctx, object, options...)
}

func (c *updateCountingClient) Update(ctx context.Context, object client.Object, options ...client.UpdateOption) error {
	switch object.(type) {
	case *appsv1.Deployment, *corev1.Service, *policyv1.PodDisruptionBudget:
		c.childUpdates++
	}
	return c.Client.Update(ctx, object, options...)
}
