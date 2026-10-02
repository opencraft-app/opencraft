package fleetcontroller

import (
	"context"
	"fmt"
	"time"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/equality"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/tools/clientcmd"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/handler"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"
)

const (
	externalProviderName = "TerraformArgo"
)

var namespaceGVR = schema.GroupVersionResource{Group: "", Version: "v1", Resource: "namespaces"}

type ExternalCellObservation struct {
	Cell       *unstructured.Unstructured
	ClusterUID string
}

type ExternalCellObserver interface {
	Observe(context.Context, *corev1.Secret, *unstructured.Unstructured) (ExternalCellObservation, error)
	SetDesiredState(context.Context, *corev1.Secret, *unstructured.Unstructured, string) error
}

type KubernetesExternalCellObserver struct{}

func (KubernetesExternalCellObserver) client(secret *corev1.Secret, registration *unstructured.Unstructured) (dynamic.Interface, error) {
	if secret.Immutable == nil || !*secret.Immutable {
		return nil, fmt.Errorf("provider credential Secret must be immutable")
	}
	if string(secret.UID) != nestedString(registration.Object, "spec", "credentialSecretRef", "uid") {
		return nil, fmt.Errorf("provider credential Secret UID differs from the Registration")
	}
	key := nestedString(registration.Object, "spec", "credentialSecretRef", "key")
	if key == "" {
		key = "kubeconfig"
	}
	data := secret.Data[key]
	if len(data) == 0 {
		return nil, fmt.Errorf("provider credential Secret has no %q key", key)
	}
	config, err := clientcmd.RESTConfigFromKubeConfig(data)
	if err != nil {
		return nil, fmt.Errorf("parse provider kubeconfig: %w", err)
	}
	config.Timeout = 10 * time.Second
	config.QPS = 2
	config.Burst = 4
	return dynamic.NewForConfig(config)
}

func (o KubernetesExternalCellObserver) Observe(ctx context.Context, secret *corev1.Secret, registration *unstructured.Unstructured) (ExternalCellObservation, error) {
	remote, err := o.client(secret, registration)
	if err != nil {
		return ExternalCellObservation{}, err
	}
	namespace := nestedString(registration.Object, "spec", "spokeCellRef", "namespace")
	name := nestedString(registration.Object, "spec", "spokeCellRef", "name")
	clusterNamespace, err := remote.Resource(namespaceGVR).Get(ctx, "kube-system", metav1.GetOptions{})
	if err != nil {
		return ExternalCellObservation{}, fmt.Errorf("observe spoke cluster identity: %w", err)
	}
	cell, err := remote.Resource(schema.GroupVersionResource{Group: Group, Version: Version, Resource: "rivetcells"}).Namespace(namespace).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return ExternalCellObservation{}, fmt.Errorf("observe spoke Cell: %w", err)
	}
	return ExternalCellObservation{Cell: cell, ClusterUID: string(clusterNamespace.GetUID())}, nil
}

func (o KubernetesExternalCellObserver) SetDesiredState(ctx context.Context, secret *corev1.Secret, registration *unstructured.Unstructured, desired string) error {
	remote, err := o.client(secret, registration)
	if err != nil {
		return err
	}
	namespace := nestedString(registration.Object, "spec", "spokeCellRef", "namespace")
	name := nestedString(registration.Object, "spec", "spokeCellRef", "name")
	resource := remote.Resource(schema.GroupVersionResource{Group: Group, Version: Version, Resource: "rivetcells"}).Namespace(namespace)
	cell, err := resource.Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return err
	}
	if nestedString(cell.Object, "spec", "desiredState") == desired {
		return nil
	}
	if err := unstructured.SetNestedField(cell.Object, desired, "spec", "desiredState"); err != nil {
		return err
	}
	_, err = resource.Update(ctx, cell, metav1.UpdateOptions{FieldManager: "actor-fleet-external-provider"})
	return err
}

type ExternalClaimReconciler struct {
	Client              client.Client
	Reader              client.Reader
	Observer            ExternalCellObserver
	Now                 func() time.Time
	ReportFreshness     time.Duration
	PollInterval        time.Duration
	CredentialNamespace string
}

func (r *ExternalClaimReconciler) Reconcile(ctx context.Context, request ctrl.Request) (ctrl.Result, error) {
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
	registration, err := r.registrationForClaim(ctx, claim)
	if err != nil {
		if closeErr := r.failClosedBoundCell(ctx, claim); closeErr != nil {
			return ctrl.Result{}, closeErr
		}
		return r.failClaim(ctx, claim, "RegistrationConflict", err.Error(), now)
	}
	if registration == nil {
		if closeErr := r.failClosedBoundCell(ctx, claim); closeErr != nil {
			return ctrl.Result{}, closeErr
		}
		return r.failClaim(ctx, claim, "AwaitingRegistration", "waiting for an immutable Terraform/Argo Cell registration bound to this Claim UID", now)
	}
	if err := validateExternalRegistration(claim, registration); err != nil {
		if closeErr := r.failClosedBoundCell(ctx, claim); closeErr != nil {
			return ctrl.Result{}, closeErr
		}
		return r.failClaim(ctx, claim, "RegistrationInvalid", err.Error(), now)
	}
	reader := r.Reader
	if reader == nil {
		reader = r.Client
	}
	secret := &corev1.Secret{}
	secretName := nestedString(registration.Object, "spec", "credentialSecretRef", "name")
	secretNamespace := nestedString(registration.Object, "spec", "credentialSecretRef", "namespace")
	if secretNamespace != r.credentialNamespace(claim.GetNamespace()) {
		if closeErr := r.failClosedBoundCell(ctx, claim); closeErr != nil {
			return ctrl.Result{}, closeErr
		}
		return r.failClaim(ctx, claim, "CredentialNamespaceInvalid", "provider credential Secret is outside the controller-owned namespace", now)
	}
	if err := reader.Get(ctx, types.NamespacedName{Namespace: secretNamespace, Name: secretName}, secret); err != nil {
		if closeErr := r.failClosedBoundCell(ctx, claim); closeErr != nil {
			return ctrl.Result{}, closeErr
		}
		return r.failClaim(ctx, claim, "CredentialUnavailable", err.Error(), now)
	}
	observer := r.Observer
	if observer == nil {
		observer = KubernetesExternalCellObserver{}
	}
	observation, err := observer.Observe(ctx, secret, registration)
	if err != nil {
		if closeErr := r.failClosedBoundCell(ctx, claim); closeErr != nil {
			return ctrl.Result{}, closeErr
		}
		return r.failClaim(ctx, claim, "SpokeUnavailable", err.Error(), now)
	}
	if err := validateExternalObservation(claim, registration, observation); err != nil {
		if closeErr := r.failClosedBoundCell(ctx, claim); closeErr != nil {
			return ctrl.Result{}, closeErr
		}
		return r.failClaim(ctx, claim, "IdentityConflict", err.Error(), now)
	}

	logical, err := r.ensureExternalLogicalCell(ctx, claim, registration, observation.Cell)
	if err != nil {
		return ctrl.Result{}, err
	}
	if logical.GetUID() == "" {
		return ctrl.Result{Requeue: true}, nil
	}
	if desired := nestedString(logical.Object, "spec", "desiredState"); desired != "" && desired != nestedString(observation.Cell.Object, "spec", "desiredState") {
		if err := observer.SetDesiredState(ctx, secret, registration, desired); err != nil {
			return r.failClaim(ctx, claim, "DesiredStateSyncFailed", err.Error(), now)
		}
		return ctrl.Result{Requeue: true}, nil
	}
	if err := r.mirrorExternalStatus(ctx, logical, observation.Cell); err != nil {
		return ctrl.Result{}, err
	}

	status := claimStatus(claim)
	status["providerRef"] = externalProviderRef(registration)
	status["placementDecision"] = map[string]any{
		"targetClusterRef": map[string]any{
			"name": nestedString(registration.Object, "spec", "spokeClusterRef", "name"),
			"uid":  observation.ClusterUID, "generation": int64(1),
		},
		"environmentGeneration": int64(1),
		"logicalCellName":       logical.GetName(),
		"decidedAt":             nestedString(registration.Object, "spec", "registeredAt"),
	}
	status["logicalCellRef"] = map[string]any{"name": logical.GetName(), "uid": string(logical.GetUID())}
	status["spokeCellRef"] = map[string]any{"name": observation.Cell.GetName(), "uid": string(observation.Cell.GetUID()), "observedGeneration": observation.Cell.GetGeneration()}
	ready := externalObservationReady(observation.Cell, now, r.freshness())
	if ready {
		status["phase"] = "Bound"
		status["cellRef"] = map[string]any{"name": logical.GetName(), "uid": string(logical.GetUID())}
		setCondition(status, claim.GetGeneration(), now, "ProviderReady", metav1.ConditionTrue, "Bound", "bound exact Terraform/Argo Cell UID from a fresh qualified spoke observation")
	} else {
		if nestedString(status, "phase") != "Bound" {
			status["phase"] = "Provisioning"
		}
		setCondition(status, claim.GetGeneration(), now, "ProviderReady", metav1.ConditionFalse, "SpokeNotReady", "spoke Cell is observed but is not currently fresh and ready for placement")
	}
	if err := updateExternalClaimStatus(ctx, r.Client, claim, status); err != nil {
		return ctrl.Result{}, err
	}
	return ctrl.Result{RequeueAfter: r.pollInterval()}, nil
}

func (r *ExternalClaimReconciler) registrationForClaim(ctx context.Context, claim *unstructured.Unstructured) (*unstructured.Unstructured, error) {
	registrations := list(registrationGVK)
	if err := r.Client.List(ctx, registrations, client.InNamespace(claim.GetNamespace())); err != nil {
		return nil, err
	}
	matches := make([]unstructured.Unstructured, 0, 1)
	for i := range registrations.Items {
		if nestedString(registrations.Items[i].Object, "spec", "claimRef", "uid") == string(claim.GetUID()) {
			matches = append(matches, registrations.Items[i])
		}
	}
	if len(matches) == 0 {
		return nil, nil
	}
	if len(matches) != 1 {
		return nil, fmt.Errorf("Claim has %d external Cell registrations", len(matches))
	}
	return &matches[0], nil
}

func validateExternalRegistration(claim, registration *unstructured.Unstructured) error {
	if nestedString(registration.Object, "spec", "provider") != externalProviderName {
		return fmt.Errorf("Registration provider is not %s", externalProviderName)
	}
	if nestedString(registration.Object, "spec", "claimRef", "name") != claim.GetName() || nestedString(registration.Object, "spec", "claimRef", "uid") != string(claim.GetUID()) {
		return fmt.Errorf("Registration Claim identity differs")
	}
	if nestedString(registration.Object, "spec", "poolRef", "name") != nestedString(claim.Object, "spec", "poolRef", "name") || nestedString(registration.Object, "spec", "poolRef", "uid") != nestedString(claim.Object, "spec", "poolRef", "uid") {
		return fmt.Errorf("Registration Pool identity differs")
	}
	if registration.GetLabels()[claimUIDAnnotation] != string(claim.GetUID()) {
		return fmt.Errorf("Registration Claim UID label differs")
	}
	for _, field := range []string{
		"profileDigest", "releaseDigest", "convergenceReceiptDigest",
		"qualificationChainReceiptDigest", "activationReceiptDigest",
	} {
		if !hasDigest(nestedString(registration.Object, "spec", "evidence", field)) {
			return fmt.Errorf("Registration %s is not an exact sha256 digest", field)
		}
	}
	if _, err := externalManagementCluster(claim); err != nil {
		return err
	}
	return nil
}

func externalManagementCluster(claim *unstructured.Unstructured) (string, error) {
	clusters := nestedStringSlice(claim.Object, "spec", "managementClusters")
	if len(clusters) != 1 || clusters[0] == "" {
		return "", fmt.Errorf("Terraform/Argo adoption requires exactly one Claim management cluster")
	}
	return clusters[0], nil
}

func validateExternalObservation(claim, registration *unstructured.Unstructured, observation ExternalCellObservation) error {
	cell := observation.Cell
	if cell == nil || observation.ClusterUID == "" {
		return fmt.Errorf("spoke observation has no exact cluster and Cell identity")
	}
	if observation.ClusterUID != nestedString(registration.Object, "spec", "spokeClusterRef", "uid") {
		return fmt.Errorf("spoke cluster UID differs from the Registration")
	}
	if cell.GetName() != nestedString(registration.Object, "spec", "spokeCellRef", "name") || string(cell.GetUID()) != nestedString(registration.Object, "spec", "spokeCellRef", "uid") {
		return fmt.Errorf("spoke Cell UID differs from the Registration")
	}
	if nestedString(cell.Object, "spec", "cellId") != cell.GetName() || nestedString(cell.Object, "spec", "className") != nestedString(claim.Object, "spec", "className") || nestedString(cell.Object, "spec", "region") != nestedString(claim.Object, "spec", "region") {
		return fmt.Errorf("spoke Cell spec differs from the Claim")
	}
	profile := nestedString(registration.Object, "spec", "evidence", "profileDigest")
	if nestedString(cell.Object, "status", "profileDigest") != profile {
		return fmt.Errorf("spoke Cell profile digest differs from qualified evidence")
	}
	return nil
}

func (r *ExternalClaimReconciler) ensureExternalLogicalCell(ctx context.Context, claim, registration, spoke *unstructured.Unstructured) (*unstructured.Unstructured, error) {
	name := spoke.GetName()
	logical := object(cellGVK)
	key := types.NamespacedName{Namespace: claim.GetNamespace(), Name: name}
	if err := r.Client.Get(ctx, key, logical); err == nil {
		if logical.GetAnnotations()["fleet.actor.dev/logical-cell"] != "true" || nestedString(logical.Object, "spec", "claimRef", "uid") != string(claim.GetUID()) {
			return nil, fmt.Errorf("logical Cell %s is owned by another Claim", key)
		}
		return logical, nil
	} else if !apierrors.IsNotFound(err) {
		return nil, err
	}
	logical.SetName(name)
	logical.SetNamespace(claim.GetNamespace())
	logical.SetLabels(map[string]string{PoolLabel: nestedString(claim.Object, "spec", "poolRef", "name"), "app.kubernetes.io/managed-by": "actor-fleet-controller"})
	logical.SetAnnotations(map[string]string{
		"fleet.actor.dev/logical-cell": "true", claimUIDAnnotation: string(claim.GetUID()),
		"fleet.actor.dev/registration-uid": string(registration.GetUID()),
	})
	spec, _, _ := unstructured.NestedMap(spoke.Object, "spec")
	spec["claimRef"] = map[string]any{"name": claim.GetName(), "uid": string(claim.GetUID())}
	managementCluster, err := externalManagementCluster(claim)
	if err != nil {
		return nil, err
	}
	// The spoke records its physical TKE cluster. The central logical Cell
	// records the management environment selected by the Claim. Conflating the
	// two identities makes an otherwise healthy Terraform Cell fail Pool
	// membership validation.
	spec["managementCluster"] = managementCluster
	logical.Object["spec"] = spec
	logical.Object["status"] = map[string]any{}
	if err := r.Client.Create(ctx, logical); err != nil {
		return nil, err
	}
	return logical, nil
}

func (r *ExternalClaimReconciler) mirrorExternalStatus(ctx context.Context, logical, spoke *unstructured.Unstructured) error {
	status, _, _ := unstructured.NestedMap(spoke.Object, "status")
	if status == nil {
		status = map[string]any{}
	}
	status["observedGeneration"] = logical.GetGeneration()
	status["spokeCellRef"] = map[string]any{"uid": string(spoke.GetUID()), "observedGeneration": spoke.GetGeneration()}
	current, _, _ := unstructured.NestedMap(logical.Object, "status")
	if equality.Semantic.DeepEqual(current, status) {
		return nil
	}
	updated := logical.DeepCopy()
	updated.Object["status"] = status
	return r.Client.Status().Update(ctx, updated)
}

func (r *ExternalClaimReconciler) failClosedBoundCell(ctx context.Context, claim *unstructured.Unstructured) error {
	logical := nestedString(claim.Object, "status", "logicalCellRef", "name")
	if logical == "" {
		return nil
	}
	return r.failClosedLogicalCell(ctx, claim.GetNamespace(), logical)
}

func (r *ExternalClaimReconciler) failClosedLogicalCell(ctx context.Context, namespace, name string) error {
	cell := object(cellGVK)
	if err := r.Client.Get(ctx, types.NamespacedName{Namespace: namespace, Name: name}, cell); err != nil {
		return client.IgnoreNotFound(err)
	}
	status, _, _ := unstructured.NestedMap(cell.Object, "status")
	if status == nil {
		status = map[string]any{}
	}
	status["phase"] = "Unknown"
	status["readyForPlacement"] = false
	status["capacityRisk"] = "AdmissionClosed"
	updated := cell.DeepCopy()
	updated.Object["status"] = status
	return r.Client.Status().Update(ctx, updated)
}

func (r *ExternalClaimReconciler) failClaim(ctx context.Context, claim *unstructured.Unstructured, reason, message string, now time.Time) (ctrl.Result, error) {
	status := claimStatus(claim)
	if nestedString(status, "phase") != "Bound" {
		status["phase"] = "Pending"
	}
	setCondition(status, claim.GetGeneration(), now, "ProviderReady", metav1.ConditionFalse, reason, message)
	if err := updateExternalClaimStatus(ctx, r.Client, claim, status); err != nil {
		return ctrl.Result{}, err
	}
	return ctrl.Result{RequeueAfter: r.pollInterval()}, nil
}

func updateExternalClaimStatus(ctx context.Context, kube client.Client, claim *unstructured.Unstructured, status map[string]any) error {
	updated := claim.DeepCopy()
	updated.Object["status"] = status
	return kube.Status().Update(ctx, updated)
}

func externalObservationReady(cell *unstructured.Unstructured, now time.Time, freshness time.Duration) bool {
	observed, err := time.Parse(time.RFC3339, nestedString(cell.Object, "status", "reportObservedAt"))
	return err == nil && !observed.After(now.Add(time.Second)) && now.Sub(observed) <= freshness &&
		nestedString(cell.Object, "status", "phase") == "Ready" && nestedBool(cell.Object, "status", "readyForPlacement") &&
		nestedString(cell.Object, "status", "capacityRisk") == "Normal"
}

func externalProviderRef(registration *unstructured.Unstructured) string {
	return fmt.Sprintf("terraform-argo://%s/rivetcellregistrations/%s/%s", registration.GetNamespace(), registration.GetName(), registration.GetUID())
}

func (r *ExternalClaimReconciler) freshness() time.Duration {
	if r.ReportFreshness > 0 {
		return r.ReportFreshness
	}
	return DefaultReportFreshness
}

func (r *ExternalClaimReconciler) pollInterval() time.Duration {
	if r.PollInterval > 0 {
		return r.PollInterval
	}
	return 15 * time.Second
}

func (r *ExternalClaimReconciler) credentialNamespace(fallback string) string {
	if r.CredentialNamespace != "" {
		return r.CredentialNamespace
	}
	return fallback
}

func (r *ExternalClaimReconciler) SetupWithManager(manager ctrl.Manager) error {
	mapRegistration := handler.EnqueueRequestsFromMapFunc(func(_ context.Context, value client.Object) []reconcile.Request {
		registration, ok := value.(*unstructured.Unstructured)
		if !ok {
			return nil
		}
		name := nestedString(registration.Object, "spec", "claimRef", "name")
		if name == "" {
			return nil
		}
		return []reconcile.Request{{NamespacedName: types.NamespacedName{Namespace: registration.GetNamespace(), Name: name}}}
	})
	return ctrl.NewControllerManagedBy(manager).
		Named("rivetcellclaim-external").
		For(object(claimGVK)).
		Watches(object(registrationGVK), mapRegistration).
		Complete(r)
}
