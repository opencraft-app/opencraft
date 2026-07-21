package provisioner

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"testing"
	"time"

	mysql "github.com/go-sql-driver/mysql"
	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	policyv1 "k8s.io/api/policy/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/util/intstr"
	clientgoscheme "k8s.io/client-go/kubernetes/scheme"
	"k8s.io/utils/ptr"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	"git.woa.com/wisp/mono2/llmgateway/internal/gateway"
	velagwv1alpha1 "git.woa.com/wisp/mono2/llmgateway/internal/velagwset/api/v1alpha1"
)

const testReleaseImage = "registry.example/new-api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

type recordingControl struct {
	materialized []gateway.SetProvisionFactCommitInput
	serving      []gateway.SetProvisionFactCommitInput
}

func (c *recordingControl) Materialized(_ context.Context, input gateway.SetProvisionFactCommitInput) error {
	c.materialized = append(c.materialized, input)
	return nil
}

func (c *recordingControl) ServingReady(_ context.Context, input gateway.SetProvisionFactCommitInput) error {
	c.serving = append(c.serving, input)
	return nil
}

func TestReconcileProvisioningCreatesObserveResourcesAndCommitsAdminFact(t *testing.T) {
	scheme := testScheme(t)
	request := testProvisionRequest(gateway.SetProvisionStatusProvisioning)
	fleet := testFleet()
	shardSecret := testShardSecret()
	cl := fake.NewClientBuilder().WithScheme(scheme).WithRuntimeObjects(fleet, shardSecret).
		WithStatusSubresource(&velagwv1alpha1.VelaGWSet{}).Build()
	control := &recordingControl{}
	reconciler := Reconciler{Client: cl, Scheme: scheme, Control: control, BootstrapImage: "registry.example/velagw@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", ImagePullSecret: "tcr-pull-secret", ServerlessTraffic: true}

	if err := reconciler.ReconcileClaim(t.Context(), request); err != ErrWaiting {
		t.Fatalf("first reconcile error=%v, want waiting", err)
	}
	set := &velagwv1alpha1.VelaGWSet{}
	if err := cl.Get(t.Context(), clientKey(request.Namespace, request.SetID), set); err != nil {
		t.Fatal(err)
	}
	if set.Spec.ManagementPolicy != velagwv1alpha1.ManagementPolicyObserve || set.Spec.TrafficRuntimes[0].Replicas != 0 {
		t.Fatalf("unexpected bootstrap set: %+v", set.Spec)
	}
	if set.Spec.TrafficAvailability.TopologyKey != "topology.kubernetes.io/zone" || set.Spec.TrafficAvailability.PDBMinAvailable != 1 || !set.Spec.Scheduling.ServerlessTraffic || set.Spec.Scheduling.ImagePullSecret != "tcr-pull-secret" {
		t.Fatalf("production runtime contract was not projected: %+v", set.Spec)
	}
	runtimeSecret := &corev1.Secret{}
	if err := cl.Get(t.Context(), clientKey(request.Namespace, runtimeSecretName(request.SetID)), runtimeSecret); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"SQL_DSN", "REDIS_CONN_STRING", "SESSION_SECRET", "ADMIN_SQL_MAX_OPEN_CONNS", "ADMIN_SQL_MAX_IDLE_CONNS", "ADMIN_SQL_MAX_LIFETIME", "TRAFFIC_SQL_MAX_OPEN_CONNS", "TRAFFIC_SQL_MAX_IDLE_CONNS", "TRAFFIC_SQL_MAX_LIFETIME"} {
		if len(runtimeSecret.Data[key]) == 0 {
			t.Fatalf("runtime secret missing %s", key)
		}
	}
	dsnConfig, err := mysql.ParseDSN(string(runtimeSecret.Data["SQL_DSN"]))
	if err != nil {
		t.Fatalf("parse runtime SQL_DSN: %v", err)
	}
	if !dsnConfig.AllowNativePasswords {
		t.Fatal("new-api SQL_DSN must allow the mysql_native_password plugin used by Tencent Cloud MySQL")
	}
	if len(runtimeSecret.OwnerReferences) != 1 || runtimeSecret.OwnerReferences[0].UID != set.UID {
		t.Fatalf("runtime secret owner references = %+v", runtimeSecret.OwnerReferences)
	}
	job := &batchv1.Job{}
	if err := cl.Get(t.Context(), clientKey(request.Namespace, bootstrapJobName(request.ID, request.Attempt)), job); err != nil {
		t.Fatal(err)
	}
	if len(job.OwnerReferences) != 1 || job.OwnerReferences[0].UID != set.UID {
		t.Fatalf("bootstrap job owner references = %+v", job.OwnerReferences)
	}

	job.Status.Succeeded = 1
	if err := cl.Status().Update(t.Context(), job); err != nil {
		t.Fatal(err)
	}
	if err := reconciler.ReconcileClaim(t.Context(), request); err != ErrWaiting {
		t.Fatalf("managed transition error=%v, want waiting", err)
	}
	if err := cl.Get(t.Context(), clientKey(request.Namespace, request.SetID), set); err != nil {
		t.Fatal(err)
	}
	if set.Spec.ManagementPolicy != velagwv1alpha1.ManagementPolicyManaged {
		t.Fatalf("management policy=%s want Managed", set.Spec.ManagementPolicy)
	}
	set.Status.ObservedGeneration = set.Generation
	set.Status.AdminReadyReplicas = 1
	set.Status.Conditions = []metav1.Condition{{Type: "AdminReady", Status: metav1.ConditionTrue}}
	if err := cl.Status().Update(t.Context(), set); err != nil {
		t.Fatal(err)
	}
	if err := reconciler.ReconcileClaim(t.Context(), request); err != nil {
		t.Fatalf("admin ready reconcile: %v", err)
	}
	if len(control.materialized) != 1 || control.materialized[0].Fact.RuntimeGeneration != 0 {
		t.Fatalf("materialized calls = %+v", control.materialized)
	}
}

func TestReconcileConfiguredActivatesTrafficAndCommitsServingFact(t *testing.T) {
	scheme := testScheme(t)
	request := testProvisionRequest(gateway.SetProvisionStatusConfigured)
	set := desiredSet(request, testFleetConfig(), runtimeSecretName(request.SetID))
	set.Spec.ManagementPolicy = velagwv1alpha1.ManagementPolicyManaged
	set.UID = "set-uid"
	set.Generation = 2
	set.Status.ObservedGeneration = 2
	set.Status.AdminReadyReplicas = 1
	set.Status.Conditions = []metav1.Condition{{Type: "AdminReady", Status: metav1.ConditionTrue}}
	pdb := &policyv1.PodDisruptionBudget{ObjectMeta: metav1.ObjectMeta{Name: "prod-set-a-g1-newapi-traffic", Namespace: "llmgateway"}, Spec: policyv1.PodDisruptionBudgetSpec{MinAvailable: ptr.To(intstr.FromInt(1))}}
	pdb.Status.ExpectedPods = 2
	pdb.Status.CurrentHealthy = 2
	cl := fake.NewClientBuilder().WithScheme(scheme).WithRuntimeObjects(testFleet(), set, pdb).
		WithStatusSubresource(&velagwv1alpha1.VelaGWSet{}).Build()
	control := &recordingControl{}
	reconciler := Reconciler{Client: cl, Scheme: scheme, Control: control}

	if err := reconciler.ReconcileClaim(t.Context(), request); err != ErrWaiting {
		t.Fatalf("traffic activation error=%v, want waiting", err)
	}
	if err := cl.Get(t.Context(), clientKey(request.Namespace, request.SetID), set); err != nil {
		t.Fatal(err)
	}
	if set.Spec.TrafficRuntimes[0].Replicas != 2 {
		t.Fatalf("traffic replicas=%d want 2", set.Spec.TrafficRuntimes[0].Replicas)
	}
	set.Status.ObservedGeneration = set.Generation
	set.Status.TrafficRuntimes = []velagwv1alpha1.TrafficRuntimeStatus{{Generation: 1, DesiredReplicas: 2, ReadyReplicas: 2, AvailableReplicas: 2}}
	set.Status.Conditions = append(set.Status.Conditions, metav1.Condition{Type: "Ready", Status: metav1.ConditionTrue})
	if err := cl.Status().Update(t.Context(), set); err != nil {
		t.Fatal(err)
	}
	if err := reconciler.ReconcileClaim(t.Context(), request); err != nil {
		t.Fatalf("serving ready reconcile: %v", err)
	}
	if len(control.serving) != 1 {
		t.Fatalf("serving calls=%d want 1", len(control.serving))
	}
	fact := control.serving[0].Fact
	if fact.RuntimeGeneration != 1 || fact.RuntimeImage != testReleaseImage || fact.RuntimeHADesiredReplicas != 2 || fact.RuntimeHAReadyReplicas != 2 {
		t.Fatalf("serving fact = %+v", fact)
	}
}

func TestReconcileRejectsConflictingSetIdentity(t *testing.T) {
	scheme := testScheme(t)
	request := testProvisionRequest(gateway.SetProvisionStatusProvisioning)
	conflict := desiredSet(request, testFleetConfig(), runtimeSecretName(request.SetID))
	conflict.Spec.DatabaseName = "some_other_database"
	cl := fake.NewClientBuilder().WithScheme(scheme).WithRuntimeObjects(testFleet(), conflict).Build()
	reconciler := Reconciler{Client: cl, Scheme: scheme, Control: &recordingControl{}}
	if err := reconciler.ReconcileClaim(t.Context(), request); err == nil || err == ErrWaiting {
		t.Fatalf("conflict error=%v, want terminal identity error", err)
	}
}

func TestProvisionMetadataUsesShortLabelAndFullAnnotation(t *testing.T) {
	request := testProvisionRequest(gateway.SetProvisionStatusProvisioning)
	labels := provisionLabels(request)
	annotations := provisionAnnotations(request)

	labelDigest := labels[requestDigestLabel]
	if len(labelDigest) != 32 {
		t.Fatalf("request digest label length=%d want 32", len(labelDigest))
	}
	fullDigest := sha256.Sum256([]byte(request.ID))
	if annotations[requestDigestAnnotation] != hex.EncodeToString(fullDigest[:]) {
		t.Fatalf("request digest annotation=%q want full sha256", annotations[requestDigestAnnotation])
	}
	if labelDigest != annotations[requestDigestAnnotation][:len(labelDigest)] {
		t.Fatalf("request digest label=%q is not annotation prefix", labelDigest)
	}
}

func testScheme(t *testing.T) *runtime.Scheme {
	t.Helper()
	scheme := runtime.NewScheme()
	if err := clientgoscheme.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	if err := velagwv1alpha1.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	return scheme
}

func testProvisionRequest(status string) gateway.SetProvisionRequest {
	return gateway.SetProvisionRequest{
		ID: "prod:llmgateway:prod:set-a", Source: "prod", Namespace: "llmgateway", Fleet: "prod", SetID: "set-a",
		ShardRef: "shard-a", DatabaseName: "newapi_set_a", RedisDB: "3", ReleaseImage: testReleaseImage,
		RuntimeBackend: gateway.SetRuntimeBackendVelaGWSet, WriterEpoch: 1, LifecycleRevision: 1,
		Attempt: 1, Version: 2, ClaimToken: "claim-token", ClaimLeaseUntil: time.Now().Add(time.Minute), Status: status,
	}
}

func testFleet() *unstructured.Unstructured {
	fleet := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "llmgateway.io/v1alpha1", "kind": "LLMFleet",
		"metadata": map[string]any{"name": "prod", "namespace": "llmgateway"},
		"spec": map[string]any{
			"availability": map[string]any{"traffic": map[string]any{"minReplicas": int64(2), "topologyKey": "topology.kubernetes.io/zone", "pdbMinAvailable": int64(1)}},
			"newapi": map[string]any{"databasePool": map[string]any{
				"admin":   map[string]any{"maxOpenConns": int64(16), "maxIdleConns": int64(2), "maxLifetimeSeconds": int64(60)},
				"traffic": map[string]any{"maxOpenConns": int64(8), "maxIdleConns": int64(2), "maxLifetimeSeconds": int64(60)},
			}, "subscriptionWriteConcurrency": int64(8)},
			"shards": []any{map[string]any{"name": "shard-a", "mysqlHost": "mysql.internal", "mysqlPort": "3306", "redisHost": "redis.internal", "redisPort": "6379", "secretName": "shard-a-secret", "redisDBStart": int64(0), "redisDBLimit": int64(16)}},
			"sets":   []any{}, "trafficRuntimes": []any{}, "cleanups": []any{},
		},
	}}
	return fleet
}

func testFleetConfig() FleetConfig {
	return FleetConfig{TrafficReplicas: 2, TrafficTopologyKey: "topology.kubernetes.io/zone", PDBMinAvailable: 1, AdminMaxOpenConns: 16, AdminMaxIdleConns: 2, AdminMaxLifetimeSeconds: 60, TrafficMaxOpenConns: 8, TrafficMaxIdleConns: 2, TrafficMaxLifetimeSeconds: 60, SubscriptionWriteConcurrency: 8}
}

func testShardSecret() *corev1.Secret {
	return &corev1.Secret{ObjectMeta: metav1.ObjectMeta{Name: "shard-a-secret", Namespace: "llmgateway"}, Data: map[string][]byte{
		"mysqlAdminUser": []byte("root"), "mysqlAdminPassword": []byte("root-pass"),
		"mysqlAppUser": []byte("newapi"), "mysqlAppPassword": []byte("app-pass"), "redisPasswordEncoded": []byte("redis-pass"),
	}}
}
