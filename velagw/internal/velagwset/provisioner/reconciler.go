package provisioner

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	mysql "github.com/go-sql-driver/mysql"
	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	policyv1 "k8s.io/api/policy/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/utils/ptr"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"

	"git.woa.com/wisp/mono2/llmgateway/internal/gateway"
	"git.woa.com/wisp/mono2/llmgateway/internal/setmanager"
	velagwv1alpha1 "git.woa.com/wisp/mono2/llmgateway/internal/velagwset/api/v1alpha1"
)

var ErrWaiting = errors.New("provisioning dependency is not ready")

const (
	requestDigestLabel      = "gateway.lightvela.com/request-digest"
	requestDigestAnnotation = "gateway.lightvela.com/request-digest"
	requestIDAnnotation     = "gateway.lightvela.com/request-id"
	allocationAnnotation    = "gateway.lightvela.com/allocation-digest"
	managedByLabel          = "gateway.lightvela.com/managed-by"
	provisionerManagedValue = "velagwset-provisioner"
)

type Control interface {
	Materialized(context.Context, gateway.SetProvisionFactCommitInput) error
	ServingReady(context.Context, gateway.SetProvisionFactCommitInput) error
}

type Reconciler struct {
	Client            client.Client
	Scheme            *runtime.Scheme
	Control           Control
	BootstrapImage    string
	ImagePullSecret   string
	ServerlessTraffic bool
}

type FleetConfig struct {
	TrafficReplicas              int
	TrafficTopologyKey           string
	PDBMinAvailable              int
	AdminMaxOpenConns            int
	AdminMaxIdleConns            int
	AdminMaxLifetimeSeconds      int
	TrafficMaxOpenConns          int
	TrafficMaxIdleConns          int
	TrafficMaxLifetimeSeconds    int
	SubscriptionWriteConcurrency int
	Shard                        setmanager.LLMFleetShard
	ImagePullSecret              string
	ServerlessTraffic            bool
}

func (r Reconciler) ReconcileClaim(ctx context.Context, request gateway.SetProvisionRequest) error {
	if request.RuntimeBackend != gateway.SetRuntimeBackendVelaGWSet || request.ClaimToken == "" {
		return fmt.Errorf("request %q is not a claimed velagwset request", request.ID)
	}
	fleet, cfg, err := r.loadFleetConfig(ctx, request)
	if err != nil {
		return err
	}
	_ = fleet
	if err := validateRequest(request, cfg.Shard); err != nil {
		return err
	}
	switch request.Status {
	case gateway.SetProvisionStatusProvisioning:
		return r.reconcileProvisioning(ctx, request, cfg)
	case gateway.SetProvisionStatusConfigured:
		return r.reconcileConfigured(ctx, request, cfg)
	default:
		return fmt.Errorf("request %q has unsupported claimed status %q", request.ID, request.Status)
	}
}

func (r Reconciler) reconcileProvisioning(ctx context.Context, request gateway.SetProvisionRequest, cfg FleetConfig) error {
	set, err := r.ensureObserveSet(ctx, request, cfg)
	if err != nil {
		return err
	}
	secret, err := r.ensureRuntimeSecret(ctx, set, request, cfg)
	if err != nil {
		return err
	}
	job, err := r.ensureBootstrapJob(ctx, set, request, cfg)
	if err != nil {
		return err
	}
	if job.Status.Failed > 0 {
		return fmt.Errorf("bootstrap job %q failed", job.Name)
	}
	if job.Status.Succeeded == 0 {
		return ErrWaiting
	}
	if set.Spec.ManagementPolicy != velagwv1alpha1.ManagementPolicyManaged {
		set.Spec.ManagementPolicy = velagwv1alpha1.ManagementPolicyManaged
		if err := r.Client.Update(ctx, set); err != nil {
			return err
		}
		return ErrWaiting
	}
	if !conditionTrue(set.Status.Conditions, "AdminReady") || set.Status.ObservedGeneration < set.Generation {
		return ErrWaiting
	}
	return r.Control.Materialized(ctx, gateway.SetProvisionFactCommitInput{
		ID: request.ID, RuntimeBackend: gateway.SetRuntimeBackendVelaGWSet, WriterEpoch: request.WriterEpoch,
		LifecycleRevision: request.LifecycleRevision, ExpectedStatus: request.Status,
		ExpectedVersion: request.Version, ClaimToken: request.ClaimToken,
		CRUID: string(set.UID), CRGeneration: set.Generation, RuntimeSecretUID: string(secret.UID),
		RuntimeIdentityDigest: allocationDigest(request), BootstrapJobUID: string(job.UID),
		BootstrapCompletedAt: completionTime(job), Fact: adminFact(request, cfg),
	})
}

func (r Reconciler) reconcileConfigured(ctx context.Context, request gateway.SetProvisionRequest, cfg FleetConfig) error {
	set := &velagwv1alpha1.VelaGWSet{}
	if err := r.Client.Get(ctx, clientKey(request.Namespace, request.SetID), set); err != nil {
		return err
	}
	if err := validateSetIdentity(set, request); err != nil {
		return err
	}
	if len(set.Spec.TrafficRuntimes) != 1 || set.Spec.TrafficRuntimes[0].Generation != 1 || set.Spec.TrafficRuntimes[0].Image != request.ReleaseImage {
		return fmt.Errorf("velagwset %q traffic generation identity conflicts with request", request.SetID)
	}
	target := int32(cfg.TrafficReplicas)
	if set.Spec.TrafficRuntimes[0].Replicas != target {
		set.Spec.TrafficRuntimes[0].Replicas = target
		if err := r.Client.Update(ctx, set); err != nil {
			return err
		}
		return ErrWaiting
	}
	traffic, ok := readyTrafficStatus(set, target)
	if !ok || !conditionTrue(set.Status.Conditions, "Ready") || set.Status.ObservedGeneration < set.Generation {
		return ErrWaiting
	}
	pdbHealthy, err := r.trafficPDBHealthy(ctx, request, cfg)
	if err != nil {
		return err
	}
	if !pdbHealthy {
		return ErrWaiting
	}
	fact := servingFact(request, cfg, traffic)
	return r.Control.ServingReady(ctx, gateway.SetProvisionFactCommitInput{
		ID: request.ID, RuntimeBackend: gateway.SetRuntimeBackendVelaGWSet, WriterEpoch: request.WriterEpoch,
		LifecycleRevision: request.LifecycleRevision, ExpectedStatus: request.Status,
		ExpectedVersion: request.Version, ClaimToken: request.ClaimToken, CRUID: string(set.UID),
		CRGeneration: set.Generation, RuntimeIdentityDigest: allocationDigest(request), Fact: fact,
	})
}

func (r Reconciler) trafficPDBHealthy(ctx context.Context, request gateway.SetProvisionRequest, cfg FleetConfig) (bool, error) {
	pdb := &policyv1.PodDisruptionBudget{}
	if err := r.Client.Get(ctx, clientKey(request.Namespace, fmt.Sprintf("%s-%s-g1-newapi-traffic", request.Fleet, request.SetID)), pdb); err != nil {
		if apierrors.IsNotFound(err) {
			return false, nil
		}
		return false, err
	}
	minAvailable := cfg.PDBMinAvailable
	if minAvailable <= 0 {
		minAvailable = 1
	}
	return pdb.Spec.MinAvailable != nil && pdb.Spec.MinAvailable.IntValue() == minAvailable &&
		int(pdb.Status.ExpectedPods) >= cfg.TrafficReplicas && int(pdb.Status.CurrentHealthy) >= minAvailable, nil
}

func (r Reconciler) loadFleetConfig(ctx context.Context, request gateway.SetProvisionRequest) (setmanager.LLMFleet, FleetConfig, error) {
	object := &unstructured.Unstructured{}
	object.SetAPIVersion("llmgateway.io/v1alpha1")
	object.SetKind("LLMFleet")
	if err := r.Client.Get(ctx, clientKey(request.Namespace, request.Fleet), object); err != nil {
		return setmanager.LLMFleet{}, FleetConfig{}, fmt.Errorf("read fleet %q: %w", request.Fleet, err)
	}
	var fleet setmanager.LLMFleet
	if err := runtime.DefaultUnstructuredConverter.FromUnstructured(object.Object, &fleet); err != nil {
		return setmanager.LLMFleet{}, FleetConfig{}, fmt.Errorf("decode fleet %q: %w", request.Fleet, err)
	}
	runtimeConfig, err := setmanager.ResolveSetRuntimeConfig(fleet, request.ShardRef)
	if err != nil {
		return fleet, FleetConfig{}, err
	}
	var shard setmanager.LLMFleetShard
	for _, candidate := range fleet.Spec.Shards {
		if candidate.Name == request.ShardRef {
			shard = candidate
			break
		}
	}
	replicas := fleet.Spec.Availability.Traffic.MinReplicas
	if replicas <= 0 {
		return fleet, FleetConfig{}, fmt.Errorf("fleet traffic minReplicas must be positive")
	}
	return fleet, FleetConfig{
		TrafficReplicas: replicas, TrafficTopologyKey: fleet.Spec.Availability.Traffic.TopologyKey,
		PDBMinAvailable:   fleet.Spec.Availability.Traffic.PDBMinAvailable,
		AdminMaxOpenConns: runtimeConfig.Admin.MaxOpenConns, AdminMaxIdleConns: runtimeConfig.Admin.MaxIdleConns,
		AdminMaxLifetimeSeconds: runtimeConfig.Admin.MaxLifetimeSeconds,
		TrafficMaxOpenConns:     runtimeConfig.Traffic.MaxOpenConns, TrafficMaxIdleConns: runtimeConfig.Traffic.MaxIdleConns,
		TrafficMaxLifetimeSeconds:    runtimeConfig.Traffic.MaxLifetimeSeconds,
		SubscriptionWriteConcurrency: runtimeConfig.SubscriptionWriteConcurrency, Shard: shard,
		ImagePullSecret: r.ImagePullSecret, ServerlessTraffic: r.ServerlessTraffic,
	}, nil
}

func (r Reconciler) ensureObserveSet(ctx context.Context, request gateway.SetProvisionRequest, cfg FleetConfig) (*velagwv1alpha1.VelaGWSet, error) {
	set := &velagwv1alpha1.VelaGWSet{}
	key := clientKey(request.Namespace, request.SetID)
	err := r.Client.Get(ctx, key, set)
	if err == nil {
		if err := validateSetIdentity(set, request); err != nil {
			return nil, err
		}
		return set, nil
	}
	if !apierrors.IsNotFound(err) {
		return nil, err
	}
	set = desiredSet(request, cfg, runtimeSecretName(request.SetID))
	if err := r.Client.Create(ctx, set); err != nil {
		return nil, err
	}
	return set, nil
}

func desiredSet(request gateway.SetProvisionRequest, cfg FleetConfig, secretName string) *velagwv1alpha1.VelaGWSet {
	return &velagwv1alpha1.VelaGWSet{
		TypeMeta:   metav1.TypeMeta{APIVersion: velagwv1alpha1.GroupVersion.String(), Kind: "VelaGWSet"},
		ObjectMeta: metav1.ObjectMeta{Name: request.SetID, Namespace: request.Namespace, Labels: provisionLabels(request), Annotations: provisionAnnotations(request)},
		Spec: velagwv1alpha1.VelaGWSetSpec{
			FleetRef: request.Fleet, ShardRef: request.ShardRef, DatabaseName: request.DatabaseName,
			RedisDB: int32(mustAtoi(request.RedisDB)), RuntimeSecretRef: corev1.LocalObjectReference{Name: secretName},
			ManagementPolicy:    velagwv1alpha1.ManagementPolicyObserve,
			Scheduling:          velagwv1alpha1.SchedulingSpec{ImagePullSecret: cfg.ImagePullSecret, ServerlessTraffic: cfg.ServerlessTraffic},
			TrafficAvailability: velagwv1alpha1.TrafficAvailabilitySpec{TopologyKey: cfg.TrafficTopologyKey, PDBMinAvailable: int32(cfg.PDBMinAvailable)},
			Admin:               velagwv1alpha1.AdminRuntimeSpec{Image: request.ReleaseImage},
			TrafficRuntimes:     []velagwv1alpha1.TrafficRuntimeSpec{{Generation: 1, Image: request.ReleaseImage, Replicas: 0}},
		},
	}
}

func (r Reconciler) ensureRuntimeSecret(ctx context.Context, set *velagwv1alpha1.VelaGWSet, request gateway.SetProvisionRequest, cfg FleetConfig) (*corev1.Secret, error) {
	secret := &corev1.Secret{}
	key := clientKey(request.Namespace, runtimeSecretName(request.SetID))
	err := r.Client.Get(ctx, key, secret)
	if err == nil {
		if secret.Annotations[allocationAnnotation] != allocationDigest(request) {
			return nil, fmt.Errorf("runtime secret %q identity conflicts with request", secret.Name)
		}
		return secret, nil
	}
	if !apierrors.IsNotFound(err) {
		return nil, err
	}
	shardSecret := &corev1.Secret{}
	if err := r.Client.Get(ctx, clientKey(request.Namespace, cfg.Shard.SecretName), shardSecret); err != nil {
		return nil, fmt.Errorf("read shard secret %q: %w", cfg.Shard.SecretName, err)
	}
	data, err := runtimeSecretData(request, cfg, shardSecret.Data)
	if err != nil {
		return nil, err
	}
	secret = &corev1.Secret{ObjectMeta: metav1.ObjectMeta{Name: key.Name, Namespace: key.Namespace, Labels: provisionLabels(request), Annotations: provisionAnnotations(request)}, Type: corev1.SecretTypeOpaque, Data: data}
	if err := controllerutil.SetControllerReference(set, secret, r.Scheme); err != nil {
		return nil, err
	}
	if err := r.Client.Create(ctx, secret); err != nil {
		return nil, err
	}
	return secret, nil
}

func runtimeSecretData(request gateway.SetProvisionRequest, cfg FleetConfig, shardData map[string][]byte) (map[string][]byte, error) {
	for _, key := range []string{"mysqlAppUser", "mysqlAppPassword", "redisPasswordEncoded"} {
		if len(shardData[key]) == 0 {
			return nil, fmt.Errorf("shard secret is missing %q", key)
		}
	}
	mysqlConfig := &mysql.Config{User: string(shardData["mysqlAppUser"]), Passwd: string(shardData["mysqlAppPassword"]), Net: "tcp", Addr: cfg.Shard.MySQLHost + ":" + cfg.Shard.MySQLPort, DBName: request.DatabaseName, ParseTime: true, Loc: time.UTC, AllowNativePasswords: true, Params: map[string]string{"charset": "utf8mb4"}}
	dsn := mysqlConfig.FormatDSN()
	session := make([]byte, 32)
	if _, err := rand.Read(session); err != nil {
		return nil, fmt.Errorf("generate session secret: %w", err)
	}
	values := map[string]string{
		"SQL_DSN":                  dsn,
		"REDIS_CONN_STRING":        "redis://:" + string(shardData["redisPasswordEncoded"]) + "@" + cfg.Shard.RedisHost + ":" + cfg.Shard.RedisPort + "/" + request.RedisDB,
		"SESSION_SECRET":           hex.EncodeToString(session),
		"ADMIN_SQL_MAX_OPEN_CONNS": strconv.Itoa(cfg.AdminMaxOpenConns), "ADMIN_SQL_MAX_IDLE_CONNS": strconv.Itoa(cfg.AdminMaxIdleConns),
		"ADMIN_SQL_MAX_LIFETIME":     strconv.Itoa(cfg.AdminMaxLifetimeSeconds),
		"TRAFFIC_SQL_MAX_OPEN_CONNS": strconv.Itoa(cfg.TrafficMaxOpenConns), "TRAFFIC_SQL_MAX_IDLE_CONNS": strconv.Itoa(cfg.TrafficMaxIdleConns),
		"TRAFFIC_SQL_MAX_LIFETIME": strconv.Itoa(cfg.TrafficMaxLifetimeSeconds),
	}
	data := make(map[string][]byte, len(values))
	for key, value := range values {
		data[key] = []byte(value)
	}
	return data, nil
}

func (r Reconciler) ensureBootstrapJob(ctx context.Context, set *velagwv1alpha1.VelaGWSet, request gateway.SetProvisionRequest, cfg FleetConfig) (*batchv1.Job, error) {
	name := bootstrapJobName(request.ID, request.Attempt)
	job := &batchv1.Job{}
	key := clientKey(request.Namespace, name)
	err := r.Client.Get(ctx, key, job)
	if err == nil {
		if job.Annotations[allocationAnnotation] != allocationDigest(request) {
			return nil, fmt.Errorf("bootstrap job %q identity conflicts with request", name)
		}
		return job, nil
	}
	if !apierrors.IsNotFound(err) {
		return nil, err
	}
	if strings.TrimSpace(r.BootstrapImage) == "" {
		return nil, fmt.Errorf("bootstrap image is required")
	}
	labels := provisionLabels(request)
	job = &batchv1.Job{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: request.Namespace, Labels: labels, Annotations: provisionAnnotations(request)},
		Spec: batchv1.JobSpec{BackoffLimit: ptr.To[int32](3), TTLSecondsAfterFinished: ptr.To[int32](86400), Template: corev1.PodTemplateSpec{
			ObjectMeta: metav1.ObjectMeta{Labels: labels},
			Spec: corev1.PodSpec{RestartPolicy: corev1.RestartPolicyOnFailure, AutomountServiceAccountToken: ptr.To(false), Containers: []corev1.Container{{
				Name: "create-database", Image: r.BootstrapImage, Command: []string{"/usr/local/bin/llmgateway-db-create"},
				Env: []corev1.EnvVar{
					{Name: "MYSQL_HOST", Value: cfg.Shard.MySQLHost}, {Name: "MYSQL_PORT", Value: cfg.Shard.MySQLPort},
					{Name: "MYSQL_DATABASE", Value: request.DatabaseName},
					{Name: "MYSQL_ADMIN_USER", ValueFrom: secretKeyRef(cfg.Shard.SecretName, "mysqlAdminUser")},
					{Name: "MYSQL_ADMIN_PASSWORD", ValueFrom: secretKeyRef(cfg.Shard.SecretName, "mysqlAdminPassword")},
				},
			}}},
		}},
	}
	if err := controllerutil.SetControllerReference(set, job, r.Scheme); err != nil {
		return nil, err
	}
	if err := r.Client.Create(ctx, job); err != nil {
		return nil, err
	}
	return job, nil
}

func validateRequest(request gateway.SetProvisionRequest, shard setmanager.LLMFleetShard) error {
	if !digestPinnedImage(request.ReleaseImage) {
		return fmt.Errorf("release image must be pinned by sha256 digest")
	}
	redisDB, err := strconv.Atoi(request.RedisDB)
	if err != nil || redisDB < shard.RedisDBStart || redisDB >= shard.RedisDBLimit {
		return fmt.Errorf("redis db %q is outside shard range [%d,%d)", request.RedisDB, shard.RedisDBStart, shard.RedisDBLimit)
	}
	if request.DatabaseName == "" || strings.ContainsAny(request.DatabaseName, "` ;/\\") {
		return fmt.Errorf("invalid database name %q", request.DatabaseName)
	}
	return nil
}

func validateSetIdentity(set *velagwv1alpha1.VelaGWSet, request gateway.SetProvisionRequest) error {
	redisDB, _ := strconv.Atoi(request.RedisDB)
	if set.Spec.FleetRef != request.Fleet || set.Spec.ShardRef != request.ShardRef || set.Spec.DatabaseName != request.DatabaseName || set.Spec.RedisDB != int32(redisDB) || set.Spec.Admin.Image != request.ReleaseImage || set.Annotations[allocationAnnotation] != allocationDigest(request) {
		return fmt.Errorf("velagwset %q identity conflicts with request", request.SetID)
	}
	return nil
}

func digestPinnedImage(image string) bool {
	parts := strings.Split(image, "@sha256:")
	if len(parts) != 2 || parts[0] == "" || len(parts[1]) != 64 {
		return false
	}
	_, err := hex.DecodeString(parts[1])
	return err == nil
}

func adminFact(request gateway.SetProvisionRequest, cfg FleetConfig) gateway.SetReconcileFactInput {
	return gateway.SetReconcileFactInput{SetID: request.SetID, Name: request.SetID, BaseURL: adminBaseURL(request), ShardRef: request.ShardRef, DatabaseName: request.DatabaseName, RedisDB: request.RedisDB,
		SQLMaxOpenConns: cfg.AdminMaxOpenConns, SQLMaxIdleConns: cfg.AdminMaxIdleConns, SQLMaxLifetimeSeconds: cfg.AdminMaxLifetimeSeconds,
		TrafficSQLMaxOpenConns: cfg.TrafficMaxOpenConns, TrafficSQLMaxIdleConns: cfg.TrafficMaxIdleConns, TrafficSQLMaxLifetimeSeconds: cfg.TrafficMaxLifetimeSeconds,
		SubscriptionWriteConcurrency: cfg.SubscriptionWriteConcurrency}
}

func servingFact(request gateway.SetProvisionRequest, cfg FleetConfig, status velagwv1alpha1.TrafficRuntimeStatus) gateway.SetReconcileFactInput {
	fact := adminFact(request, cfg)
	fact.TrafficBaseURL = trafficBaseURL(request)
	fact.RuntimeGeneration = 1
	fact.RuntimeImage = request.ReleaseImage
	fact.RuntimeHAStatus = gateway.SetRuntimeHAHealthy
	fact.RuntimeHADesiredReplicas = int(status.DesiredReplicas)
	fact.RuntimeHAReadyReplicas = int(status.ReadyReplicas)
	fact.RuntimeHAPDBHealthy = true
	fact.RuntimeHATopologyKey = cfg.TrafficTopologyKey
	fact.RuntimeHACheckedAt = time.Now().UTC()
	return fact
}

func readyTrafficStatus(set *velagwv1alpha1.VelaGWSet, target int32) (velagwv1alpha1.TrafficRuntimeStatus, bool) {
	for _, status := range set.Status.TrafficRuntimes {
		if status.Generation == 1 && status.DesiredReplicas == target && status.ReadyReplicas >= target && status.AvailableReplicas >= target {
			return status, true
		}
	}
	return velagwv1alpha1.TrafficRuntimeStatus{}, false
}

func conditionTrue(conditions []metav1.Condition, kind string) bool {
	for _, condition := range conditions {
		if condition.Type == kind {
			return condition.Status == metav1.ConditionTrue
		}
	}
	return false
}

func completionTime(job *batchv1.Job) time.Time {
	if job.Status.CompletionTime != nil {
		return job.Status.CompletionTime.Time
	}
	return time.Now().UTC()
}

func runtimeSecretName(setID string) string { return setID + "-runtime" }

func bootstrapJobName(requestID string, attempt int) string {
	digest := sha256.Sum256([]byte(requestID))
	return fmt.Sprintf("velagw-bootstrap-%x-a%d", digest[:6], attempt)
}

func allocationDigest(request gateway.SetProvisionRequest) string {
	value := strings.Join([]string{request.Source, request.Namespace, request.Fleet, request.SetID, request.ShardRef, request.DatabaseName, request.RedisDB, request.ReleaseImage}, "\x00")
	digest := sha256.Sum256([]byte(value))
	return hex.EncodeToString(digest[:])
}

func provisionLabels(request gateway.SetProvisionRequest) map[string]string {
	digest := sha256.Sum256([]byte(request.ID))
	return map[string]string{requestDigestLabel: hex.EncodeToString(digest[:16]), managedByLabel: provisionerManagedValue, "gateway.lightvela.com/fleet": request.Fleet, "gateway.lightvela.com/set": request.SetID}
}

func provisionAnnotations(request gateway.SetProvisionRequest) map[string]string {
	digest := sha256.Sum256([]byte(request.ID))
	return map[string]string{requestIDAnnotation: request.ID, requestDigestAnnotation: hex.EncodeToString(digest[:]), allocationAnnotation: allocationDigest(request)}
}

func clientKey(namespace, name string) types.NamespacedName {
	return types.NamespacedName{Namespace: namespace, Name: name}
}

func adminBaseURL(request gateway.SetProvisionRequest) string {
	return fmt.Sprintf("http://%s-%s-newapi-admin:3000", request.Fleet, request.SetID)
}

func trafficBaseURL(request gateway.SetProvisionRequest) string {
	return fmt.Sprintf("http://%s-%s-g1-newapi-traffic:3000", request.Fleet, request.SetID)
}

func secretKeyRef(name, key string) *corev1.EnvVarSource {
	return &corev1.EnvVarSource{SecretKeyRef: &corev1.SecretKeySelector{LocalObjectReference: corev1.LocalObjectReference{Name: name}, Key: key}}
}

func mustAtoi(value string) int {
	result, _ := strconv.Atoi(value)
	return result
}
