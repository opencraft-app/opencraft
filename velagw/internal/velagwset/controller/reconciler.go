package controller

import (
	"context"
	"fmt"
	"reflect"
	"strings"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	policyv1 "k8s.io/api/policy/v1"
	apiequality "k8s.io/apimachinery/pkg/api/equality"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	apimeta "k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/util/intstr"
	"k8s.io/utils/ptr"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"

	velagwv1alpha1 "git.woa.com/wisp/mono2/llmgateway/internal/velagwset/api/v1alpha1"
)

const (
	RuntimeCleanupFinalizer = "gateway.lightvela.com/runtime-cleanup"
	runtimeStatusRetryDelay = 5 * time.Second
)

type VelaGWSetReconciler struct {
	client.Client
	Scheme *runtime.Scheme
}

func (r *VelaGWSetReconciler) Reconcile(ctx context.Context, request ctrl.Request) (ctrl.Result, error) {
	set := &velagwv1alpha1.VelaGWSet{}
	if err := r.Get(ctx, request.NamespacedName, set); err != nil {
		return ctrl.Result{}, client.IgnoreNotFound(err)
	}
	if !set.DeletionTimestamp.IsZero() {
		return r.reconcileDelete(ctx, set)
	}
	if set.Spec.ManagementPolicy == velagwv1alpha1.ManagementPolicyObserve || set.Spec.ManagementPolicy == velagwv1alpha1.ManagementPolicyAdoptionPending {
		return ctrl.Result{}, nil
	}
	if !controllerutil.ContainsFinalizer(set, RuntimeCleanupFinalizer) {
		controllerutil.AddFinalizer(set, RuntimeCleanupFinalizer)
		if err := r.Update(ctx, set); err != nil {
			return ctrl.Result{}, err
		}
		return ctrl.Result{Requeue: true}, nil
	}
	for _, object := range desiredObjects(set) {
		if err := r.reconcileObject(ctx, set, object); err != nil {
			return ctrl.Result{}, err
		}
	}
	if err := r.pruneOmittedTrafficRuntimes(ctx, set); err != nil {
		return ctrl.Result{}, err
	}
	if err := r.updateStatus(ctx, set); err != nil {
		return ctrl.Result{}, err
	}
	ready := apimeta.FindStatusCondition(set.Status.Conditions, "Ready")
	if ready == nil || ready.Status != metav1.ConditionTrue {
		return ctrl.Result{RequeueAfter: runtimeStatusRetryDelay}, nil
	}
	return ctrl.Result{}, nil
}

func (r *VelaGWSetReconciler) SetupWithManager(manager ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(manager).
		For(&velagwv1alpha1.VelaGWSet{}).
		Owns(&appsv1.Deployment{}).
		Owns(&corev1.Service{}).
		Owns(&policyv1.PodDisruptionBudget{}).
		Complete(r)
}

func (r *VelaGWSetReconciler) reconcileObject(ctx context.Context, set *velagwv1alpha1.VelaGWSet, desired client.Object) error {
	r.Scheme.Default(desired)
	if err := controllerutil.SetControllerReference(set, desired, r.Scheme); err != nil {
		return err
	}
	existing := emptyObjectFor(desired)
	key := client.ObjectKeyFromObject(desired)
	if err := r.Get(ctx, key, existing); err != nil {
		if apierrors.IsNotFound(err) {
			return r.Create(ctx, desired)
		}
		return err
	}
	owner := metav1.GetControllerOf(existing)
	if owner == nil || owner.UID != set.UID {
		return fmt.Errorf("refuse to manage %T %s/%s: controller owner does not match VelaGWSet uid %s", existing, existing.GetNamespace(), existing.GetName(), set.UID)
	}
	preserveAllocatedFields(existing, desired)
	preserveUnmanagedMetadata(existing, desired)
	if managedObjectEqual(existing, desired) {
		return nil
	}
	return r.Patch(ctx, desired, client.MergeFrom(existing))
}

func preserveUnmanagedMetadata(existing, desired client.Object) {
	mergedLabels := copyLabels(existing.GetLabels())
	for key, value := range desired.GetLabels() {
		mergedLabels[key] = value
	}
	desired.SetLabels(mergedLabels)
	desired.SetAnnotations(existing.GetAnnotations())
	desired.SetFinalizers(existing.GetFinalizers())
}

func managedObjectEqual(existing, desired client.Object) bool {
	if !apiequality.Semantic.DeepEqual(existing.GetLabels(), desired.GetLabels()) ||
		!apiequality.Semantic.DeepEqual(existing.GetAnnotations(), desired.GetAnnotations()) ||
		!apiequality.Semantic.DeepEqual(existing.GetFinalizers(), desired.GetFinalizers()) ||
		!apiequality.Semantic.DeepEqual(existing.GetOwnerReferences(), desired.GetOwnerReferences()) {
		return false
	}
	switch current := existing.(type) {
	case *appsv1.Deployment:
		return apiequality.Semantic.DeepEqual(current.Spec, desired.(*appsv1.Deployment).Spec)
	case *corev1.Service:
		return apiequality.Semantic.DeepEqual(current.Spec, desired.(*corev1.Service).Spec)
	case *policyv1.PodDisruptionBudget:
		return apiequality.Semantic.DeepEqual(current.Spec, desired.(*policyv1.PodDisruptionBudget).Spec)
	default:
		return false
	}
}

func emptyObjectFor(object client.Object) client.Object {
	switch object.(type) {
	case *appsv1.Deployment:
		return &appsv1.Deployment{}
	case *corev1.Service:
		return &corev1.Service{}
	case *policyv1.PodDisruptionBudget:
		return &policyv1.PodDisruptionBudget{}
	default:
		panic(fmt.Sprintf("unsupported VelaGWSet child object %T", object))
	}
}

func preserveAllocatedFields(existing, desired client.Object) {
	existingService, ok := existing.(*corev1.Service)
	if !ok {
		return
	}
	desiredService := desired.(*corev1.Service)
	desiredService.Spec.ClusterIP = existingService.Spec.ClusterIP
	desiredService.Spec.ClusterIPs = append([]string(nil), existingService.Spec.ClusterIPs...)
	desiredService.Spec.IPFamilies = append([]corev1.IPFamily(nil), existingService.Spec.IPFamilies...)
	desiredService.Spec.IPFamilyPolicy = existingService.Spec.IPFamilyPolicy
	desiredService.Spec.HealthCheckNodePort = existingService.Spec.HealthCheckNodePort
}

func (r *VelaGWSetReconciler) reconcileDelete(ctx context.Context, set *velagwv1alpha1.VelaGWSet) (ctrl.Result, error) {
	if !controllerutil.ContainsFinalizer(set, RuntimeCleanupFinalizer) {
		return ctrl.Result{}, nil
	}
	if !validDecommissionApproval(set) {
		condition := metav1.Condition{
			Type:               "DeletionBlocked",
			Status:             metav1.ConditionTrue,
			ObservedGeneration: set.Generation,
			Reason:             "ApprovalMissingOrInvalid",
			Message:            "decommission approval does not match the current VelaGWSet identity",
		}
		previous := append([]metav1.Condition(nil), set.Status.Conditions...)
		apimeta.SetStatusCondition(&set.Status.Conditions, condition)
		if !apiequality.Semantic.DeepEqual(previous, set.Status.Conditions) {
			if err := r.Status().Update(ctx, set); err != nil {
				return ctrl.Result{}, err
			}
		}
		return ctrl.Result{RequeueAfter: 30 * time.Second}, nil
	}
	children, err := r.ownedDeletionChildren(ctx, set)
	if err != nil {
		return ctrl.Result{}, err
	}
	if len(children) > 0 {
		propagation := metav1.DeletePropagationForeground
		for _, child := range children {
			if err := client.IgnoreNotFound(r.Delete(ctx, child, &client.DeleteOptions{PropagationPolicy: &propagation})); err != nil {
				return ctrl.Result{}, err
			}
		}
		return ctrl.Result{RequeueAfter: time.Second}, nil
	}
	controllerutil.RemoveFinalizer(set, RuntimeCleanupFinalizer)
	return ctrl.Result{}, r.Update(ctx, set)
}

func validDecommissionApproval(set *velagwv1alpha1.VelaGWSet) bool {
	approval := set.Spec.DecommissionApproval
	return approval != nil && strings.TrimSpace(approval.RequestID) != "" && approval.Attempt > 0 && !approval.ApprovedAt.IsZero() &&
		approval.CRUID == string(set.UID) && approval.FleetRef == set.Spec.FleetRef && approval.ShardRef == set.Spec.ShardRef &&
		approval.DatabaseName == set.Spec.DatabaseName && approval.RedisDB == set.Spec.RedisDB
}

func (r *VelaGWSetReconciler) ownedDeletionChildren(ctx context.Context, set *velagwv1alpha1.VelaGWSet) ([]client.Object, error) {
	children := make([]client.Object, 0, 2+len(set.Spec.TrafficRuntimes)*3)
	seen := make(map[string]struct{})
	appendOwned := func(current client.Object) error {
		owner := metav1.GetControllerOf(current)
		if owner == nil || owner.UID != set.UID {
			return fmt.Errorf("refuse to delete %T %s/%s: controller owner does not match VelaGWSet uid %s", current, current.GetNamespace(), current.GetName(), set.UID)
		}
		key := fmt.Sprintf("%T/%s", current, current.GetName())
		if _, ok := seen[key]; ok {
			return nil
		}
		seen[key] = struct{}{}
		children = append(children, current)
		return nil
	}
	for _, desired := range desiredObjects(set) {
		current := emptyObjectFor(desired)
		if err := r.Get(ctx, client.ObjectKeyFromObject(desired), current); err != nil {
			if apierrors.IsNotFound(err) {
				continue
			}
			return nil, err
		}
		if err := appendOwned(current); err != nil {
			return nil, err
		}
	}

	matchingLabels := client.MatchingLabels{
		"gateway.lightvela.com/set":        set.Name,
		"gateway.lightvela.com/managed-by": "velagwset-controller",
	}
	deployments := &appsv1.DeploymentList{}
	if err := r.List(ctx, deployments, client.InNamespace(set.Namespace), matchingLabels); err != nil {
		return nil, err
	}
	for index := range deployments.Items {
		if err := appendOwned(&deployments.Items[index]); err != nil {
			return nil, err
		}
	}
	services := &corev1.ServiceList{}
	if err := r.List(ctx, services, client.InNamespace(set.Namespace), matchingLabels); err != nil {
		return nil, err
	}
	for index := range services.Items {
		if err := appendOwned(&services.Items[index]); err != nil {
			return nil, err
		}
	}
	pdbs := &policyv1.PodDisruptionBudgetList{}
	if err := r.List(ctx, pdbs, client.InNamespace(set.Namespace), matchingLabels); err != nil {
		return nil, err
	}
	for index := range pdbs.Items {
		if err := appendOwned(&pdbs.Items[index]); err != nil {
			return nil, err
		}
	}
	return children, nil
}

func (r *VelaGWSetReconciler) pruneOmittedTrafficRuntimes(ctx context.Context, set *velagwv1alpha1.VelaGWSet) error {
	desiredNames := make(map[string]struct{}, len(set.Spec.TrafficRuntimes))
	for _, traffic := range set.Spec.TrafficRuntimes {
		desiredNames[trafficResourceName(set, traffic.Generation)] = struct{}{}
	}
	matchingLabels := client.MatchingLabels{
		"gateway.lightvela.com/set":         set.Name,
		"gateway.lightvela.com/newapi-role": "traffic",
		"gateway.lightvela.com/managed-by":  "velagwset-controller",
	}
	deleteIfOmitted := func(object client.Object) error {
		if _, ok := desiredNames[object.GetName()]; ok {
			return nil
		}
		owner := metav1.GetControllerOf(object)
		if owner == nil || owner.UID != set.UID {
			return nil
		}
		propagation := metav1.DeletePropagationForeground
		return client.IgnoreNotFound(r.Delete(ctx, object, &client.DeleteOptions{PropagationPolicy: &propagation}))
	}

	deployments := &appsv1.DeploymentList{}
	if err := r.List(ctx, deployments, client.InNamespace(set.Namespace), matchingLabels); err != nil {
		return err
	}
	for index := range deployments.Items {
		if err := deleteIfOmitted(&deployments.Items[index]); err != nil {
			return err
		}
	}
	services := &corev1.ServiceList{}
	if err := r.List(ctx, services, client.InNamespace(set.Namespace), matchingLabels); err != nil {
		return err
	}
	for index := range services.Items {
		if err := deleteIfOmitted(&services.Items[index]); err != nil {
			return err
		}
	}
	pdbs := &policyv1.PodDisruptionBudgetList{}
	if err := r.List(ctx, pdbs, client.InNamespace(set.Namespace), matchingLabels); err != nil {
		return err
	}
	for index := range pdbs.Items {
		if err := deleteIfOmitted(&pdbs.Items[index]); err != nil {
			return err
		}
	}
	return nil
}

func (r *VelaGWSetReconciler) updateStatus(ctx context.Context, set *velagwv1alpha1.VelaGWSet) error {
	previous := set.DeepCopy().Status
	status := set.DeepCopy().Status
	status.ObservedGeneration = set.Generation
	status.AdminReadyReplicas = 0
	status.TrafficRuntimes = make([]velagwv1alpha1.TrafficRuntimeStatus, 0, len(set.Spec.TrafficRuntimes))

	admin := &appsv1.Deployment{}
	if err := r.Get(ctx, client.ObjectKey{Namespace: set.Namespace, Name: resourcePrefix(set) + "-newapi-admin-master"}, admin); err != nil {
		if !apierrors.IsNotFound(err) {
			return err
		}
	} else {
		status.AdminReadyReplicas = admin.Status.ReadyReplicas
	}
	adminReady := r.deploymentRolloutReady(admin, desiredAdminDeployment(set), 1)
	adminCondition := metav1.Condition{
		Type:               "AdminReady",
		Status:             metav1.ConditionFalse,
		ObservedGeneration: set.Generation,
		Reason:             "WaitingForAdmin",
		Message:            "admin runtime is not ready",
	}
	if adminReady {
		adminCondition.Status = metav1.ConditionTrue
		adminCondition.Reason = "AdminReady"
		adminCondition.Message = "admin runtime is ready"
	}
	apimeta.SetStatusCondition(&status.Conditions, adminCondition)

	ready := adminReady
	activeTrafficRuntimes := 0
	for _, traffic := range set.Spec.TrafficRuntimes {
		item := velagwv1alpha1.TrafficRuntimeStatus{Generation: traffic.Generation, DesiredReplicas: traffic.Replicas}
		if traffic.Replicas == 0 {
			status.TrafficRuntimes = append(status.TrafficRuntimes, item)
			continue
		}
		activeTrafficRuntimes++
		deployment := &appsv1.Deployment{}
		if err := r.Get(ctx, client.ObjectKey{Namespace: set.Namespace, Name: trafficResourceName(set, traffic.Generation)}, deployment); err != nil {
			if !apierrors.IsNotFound(err) {
				return err
			}
			ready = false
		} else {
			item.ReadyReplicas = deployment.Status.ReadyReplicas
			item.AvailableReplicas = deployment.Status.AvailableReplicas
			if !r.deploymentRolloutReady(deployment, desiredTrafficDeployment(set, traffic), traffic.Replicas) {
				ready = false
			}
		}
		status.TrafficRuntimes = append(status.TrafficRuntimes, item)
	}
	condition := metav1.Condition{
		Type:               "Ready",
		Status:             metav1.ConditionFalse,
		ObservedGeneration: set.Generation,
		Reason:             "WaitingForResources",
		Message:            "admin or traffic runtime replicas are not ready",
	}
	if activeTrafficRuntimes == 0 {
		ready = false
		condition.Reason = "AwaitingTrafficActivation"
		condition.Message = "admin may be ready, but no traffic runtime is active"
	} else if ready {
		condition.Status = metav1.ConditionTrue
		condition.Reason = "ResourcesReady"
		condition.Message = "admin and all declared traffic runtimes are ready"
	}
	apimeta.SetStatusCondition(&status.Conditions, condition)
	if reflect.DeepEqual(previous, status) {
		return nil
	}
	set.Status = status
	return r.Status().Update(ctx, set)
}

func (r *VelaGWSetReconciler) deploymentRolloutReady(actual, desired *appsv1.Deployment, desiredReplicas int32) bool {
	if actual == nil || desired == nil {
		return false
	}
	r.Scheme.Default(desired)
	return apiequality.Semantic.DeepEqual(actual.Spec, desired.Spec) &&
		actual.Status.ObservedGeneration >= actual.Generation &&
		actual.Status.UpdatedReplicas >= desiredReplicas &&
		actual.Status.ReadyReplicas >= desiredReplicas &&
		actual.Status.AvailableReplicas >= desiredReplicas
}

func desiredObjects(set *velagwv1alpha1.VelaGWSet) []client.Object {
	objects := []client.Object{
		desiredAdminService(set),
		desiredAdminDeployment(set),
	}
	for _, traffic := range set.Spec.TrafficRuntimes {
		if traffic.Replicas == 0 {
			continue
		}
		objects = append(objects, desiredTrafficService(set, traffic), desiredTrafficDeployment(set, traffic), desiredTrafficPDB(set, traffic))
	}
	return objects
}

func desiredAdminService(set *velagwv1alpha1.VelaGWSet) *corev1.Service {
	name := resourcePrefix(set) + "-newapi-admin"
	selector := map[string]string{"app.kubernetes.io/name": resourcePrefix(set) + "-newapi-admin-master"}
	return &corev1.Service{
		TypeMeta:   metav1.TypeMeta{APIVersion: "v1", Kind: "Service"},
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: set.Namespace, Labels: labels(set, "admin")},
		Spec:       corev1.ServiceSpec{Selector: selector, Ports: []corev1.ServicePort{{Name: "http", Port: 3000, TargetPort: intstr.FromInt32(3000)}}},
	}
}

func desiredTrafficService(set *velagwv1alpha1.VelaGWSet, traffic velagwv1alpha1.TrafficRuntimeSpec) *corev1.Service {
	name := trafficResourceName(set, traffic.Generation)
	selector := map[string]string{"app.kubernetes.io/name": name}
	return &corev1.Service{
		TypeMeta:   metav1.TypeMeta{APIVersion: "v1", Kind: "Service"},
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: set.Namespace, Labels: labels(set, "traffic")},
		Spec:       corev1.ServiceSpec{Selector: selector, Ports: []corev1.ServicePort{{Name: "http", Port: 3000, TargetPort: intstr.FromInt32(3000)}}},
	}
}

func desiredAdminDeployment(set *velagwv1alpha1.VelaGWSet) *appsv1.Deployment {
	name := resourcePrefix(set) + "-newapi-admin-master"
	podLabels := labels(set, "admin")
	podLabels["app.kubernetes.io/name"] = name
	return deployment(set, name, set.Spec.Admin.Image, 1, podLabels, "master", appsv1.DeploymentStrategy{Type: appsv1.RecreateDeploymentStrategyType})
}

func desiredTrafficDeployment(set *velagwv1alpha1.VelaGWSet, traffic velagwv1alpha1.TrafficRuntimeSpec) *appsv1.Deployment {
	name := trafficResourceName(set, traffic.Generation)
	podLabels := labels(set, "traffic")
	podLabels["app.kubernetes.io/name"] = name
	podLabels["gateway.lightvela.com/serving"] = "true"
	maxUnavailable := intstr.FromInt32(0)
	maxSurge := intstr.FromInt32(1)
	return deployment(set, name, traffic.Image, traffic.Replicas, podLabels, "slave", appsv1.DeploymentStrategy{
		Type:          appsv1.RollingUpdateDeploymentStrategyType,
		RollingUpdate: &appsv1.RollingUpdateDeployment{MaxUnavailable: &maxUnavailable, MaxSurge: &maxSurge},
	})
}

func deployment(set *velagwv1alpha1.VelaGWSet, name, image string, replicas int32, podLabels map[string]string, nodeType string, strategy appsv1.DeploymentStrategy) *appsv1.Deployment {
	batchUpdates := "false"
	poolPrefix := "TRAFFIC_"
	terminationGrace := int64(330)
	if nodeType == "master" {
		batchUpdates = "true"
		poolPrefix = "ADMIN_"
		terminationGrace = 60
	}
	podSpec := corev1.PodSpec{
		PriorityClassName:             set.Spec.Scheduling.PriorityClassName,
		AutomountServiceAccountToken:  ptr.To(false),
		RestartPolicy:                 corev1.RestartPolicyAlways,
		TerminationGracePeriodSeconds: ptr.To(terminationGrace),
		DNSPolicy:                     corev1.DNSClusterFirst,
		SecurityContext:               &corev1.PodSecurityContext{},
		SchedulerName:                 corev1.DefaultSchedulerName,
	}
	if set.Spec.Scheduling.ImagePullSecret != "" {
		podSpec.ImagePullSecrets = []corev1.LocalObjectReference{{Name: set.Spec.Scheduling.ImagePullSecret}}
	}
	if nodeType != "master" && set.Spec.Scheduling.ServerlessTraffic {
		podSpec.NodeSelector = map[string]string{"llmgateway.io/runtime": "serverless"}
		podSpec.Tolerations = []corev1.Toleration{{Key: "eks.tke.cloud.tencent.com/eklet", Operator: corev1.TolerationOpExists, Effect: corev1.TaintEffectNoSchedule}}
	}
	if nodeType != "master" && set.Spec.TrafficAvailability.TopologyKey != "" {
		podSpec.TopologySpreadConstraints = []corev1.TopologySpreadConstraint{{
			MaxSkew: 1, TopologyKey: set.Spec.TrafficAvailability.TopologyKey,
			WhenUnsatisfiable: corev1.DoNotSchedule, MatchLabelKeys: []string{"pod-template-hash"},
			LabelSelector: &metav1.LabelSelector{MatchLabels: map[string]string{"app.kubernetes.io/name": name}},
		}}
	}
	podSpec.Containers = []corev1.Container{{
		Name: "newapi", Image: image, ImagePullPolicy: corev1.PullIfNotPresent, Args: []string{"--log-dir", "/app/logs"},
		EnvFrom: []corev1.EnvFromSource{{SecretRef: &corev1.SecretEnvSource{LocalObjectReference: set.Spec.RuntimeSecretRef}}},
		Env: []corev1.EnvVar{
			{Name: "TZ", Value: "Asia/Shanghai"},
			{Name: "GLOBAL_API_RATE_LIMIT_ENABLE", Value: "false"},
			{Name: "GLOBAL_WEB_RATE_LIMIT_ENABLE", Value: "false"},
			{Name: "CRITICAL_RATE_LIMIT_ENABLE", Value: "false"},
			{Name: "SEARCH_RATE_LIMIT_ENABLE", Value: "false"},
			{Name: "BATCH_UPDATE_ENABLED", Value: batchUpdates},
			{Name: "NODE_TYPE", Value: nodeType},
			{Name: "NODE_NAME", Value: name},
			optionalRuntimeSecretEnv(set.Spec.RuntimeSecretRef.Name, "SQL_MAX_OPEN_CONNS", poolPrefix+"SQL_MAX_OPEN_CONNS"),
			optionalRuntimeSecretEnv(set.Spec.RuntimeSecretRef.Name, "SQL_MAX_IDLE_CONNS", poolPrefix+"SQL_MAX_IDLE_CONNS"),
			optionalRuntimeSecretEnv(set.Spec.RuntimeSecretRef.Name, "SQL_MAX_LIFETIME", poolPrefix+"SQL_MAX_LIFETIME"),
		},
		Ports: []corev1.ContainerPort{{Name: "http", ContainerPort: 3000, Protocol: corev1.ProtocolTCP}},
		ReadinessProbe: &corev1.Probe{
			ProbeHandler:        corev1.ProbeHandler{HTTPGet: &corev1.HTTPGetAction{Path: "/api/status", Port: intstr.FromString("http"), Scheme: corev1.URISchemeHTTP}},
			InitialDelaySeconds: 10, PeriodSeconds: 5, TimeoutSeconds: 3, SuccessThreshold: 1, FailureThreshold: 60,
		},
		TerminationMessagePath: corev1.TerminationMessagePathDefault, TerminationMessagePolicy: corev1.TerminationMessageReadFile,
		VolumeMounts: []corev1.VolumeMount{{Name: "newapi-logs", MountPath: "/app/logs"}},
	}}
	podSpec.Volumes = []corev1.Volume{{Name: "newapi-logs", VolumeSource: corev1.VolumeSource{EmptyDir: &corev1.EmptyDirVolumeSource{}}}}
	return &appsv1.Deployment{
		TypeMeta:   metav1.TypeMeta{APIVersion: "apps/v1", Kind: "Deployment"},
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: set.Namespace, Labels: copyLabels(podLabels)},
		Spec: appsv1.DeploymentSpec{
			Replicas:                ptr.To(replicas),
			Strategy:                strategy,
			Selector:                &metav1.LabelSelector{MatchLabels: map[string]string{"app.kubernetes.io/name": name}},
			RevisionHistoryLimit:    ptr.To[int32](10),
			ProgressDeadlineSeconds: ptr.To[int32](600),
			Template:                corev1.PodTemplateSpec{ObjectMeta: metav1.ObjectMeta{Labels: podLabels}, Spec: podSpec},
		},
	}
}

func optionalRuntimeSecretEnv(secretName, envName, key string) corev1.EnvVar {
	return corev1.EnvVar{Name: envName, ValueFrom: &corev1.EnvVarSource{SecretKeyRef: &corev1.SecretKeySelector{
		LocalObjectReference: corev1.LocalObjectReference{Name: secretName}, Key: key, Optional: ptr.To(true),
	}}}
}

func copyLabels(source map[string]string) map[string]string {
	result := make(map[string]string, len(source))
	for key, value := range source {
		result[key] = value
	}
	return result
}

func desiredTrafficPDB(set *velagwv1alpha1.VelaGWSet, traffic velagwv1alpha1.TrafficRuntimeSpec) *policyv1.PodDisruptionBudget {
	name := trafficResourceName(set, traffic.Generation)
	minAvailableValue := set.Spec.TrafficAvailability.PDBMinAvailable
	if minAvailableValue <= 0 {
		minAvailableValue = 1
	}
	minAvailable := intstr.FromInt32(minAvailableValue)
	return &policyv1.PodDisruptionBudget{
		TypeMeta:   metav1.TypeMeta{APIVersion: "policy/v1", Kind: "PodDisruptionBudget"},
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: set.Namespace, Labels: labels(set, "traffic")},
		Spec:       policyv1.PodDisruptionBudgetSpec{MinAvailable: &minAvailable, Selector: &metav1.LabelSelector{MatchLabels: map[string]string{"app.kubernetes.io/name": name}}},
	}
}

func resourcePrefix(set *velagwv1alpha1.VelaGWSet) string {
	return set.Spec.FleetRef + "-" + set.Name
}

func trafficResourceName(set *velagwv1alpha1.VelaGWSet, generation int64) string {
	return fmt.Sprintf("%s-g%d-newapi-traffic", resourcePrefix(set), generation)
}

func labels(set *velagwv1alpha1.VelaGWSet, role string) map[string]string {
	return map[string]string{
		"app.kubernetes.io/component":       "new-api",
		"app.kubernetes.io/part-of":         "velagw",
		"gateway.lightvela.com/fleet":       set.Spec.FleetRef,
		"gateway.lightvela.com/set":         set.Name,
		"gateway.lightvela.com/shard":       set.Spec.ShardRef,
		"gateway.lightvela.com/newapi-role": role,
		"gateway.lightvela.com/managed-by":  "velagwset-controller",
	}
}
