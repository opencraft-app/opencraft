package provisioner

import (
	"context"
	"testing"
	"time"

	batchv1 "k8s.io/api/batch/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	"git.woa.com/wisp/mono2/llmgateway/internal/gateway"
	velagwv1alpha1 "git.woa.com/wisp/mono2/llmgateway/internal/velagwset/api/v1alpha1"
)

type fakeDecommissionQueueControl struct {
	job        gateway.SetDecommissionJob
	payload    gateway.SetRuntimeCleanupPayload
	claimCalls int
}

func (c *fakeDecommissionQueueControl) ListDecommissionJobs(context.Context, int) ([]gateway.SetDecommissionJob, error) {
	return []gateway.SetDecommissionJob{c.job}, nil
}

func (c *fakeDecommissionQueueControl) ClaimDecommission(context.Context, string, string, time.Duration) (DecommissionClaim, bool, error) {
	c.claimCalls++
	return DecommissionClaim{Job: c.job, Cleanup: c.payload}, true, nil
}

type stagedDecommissionReconciler struct{ calls int }

func (r *stagedDecommissionReconciler) Reconcile(context.Context, gateway.SetRuntimeCleanupPayload) error {
	r.calls++
	if r.calls < 2 {
		return ErrWaiting
	}
	return nil
}

func TestDecommissionRunnerRetainsClaimAcrossReconcileCycles(t *testing.T) {
	payload := nativeCleanupPayload()
	control := &fakeDecommissionQueueControl{job: gateway.SetDecommissionJob{ID: payload.CleanupID, SetID: payload.SetID}, payload: payload}
	reconciler := &stagedDecommissionReconciler{}
	runner := &DecommissionRunner{
		Control: control, Reconciler: reconciler, Source: "prod", Namespace: "llmgateway", Fleet: "prod", Owner: "pod-a",
	}
	if err := runner.RunOnce(t.Context()); err != nil {
		t.Fatal(err)
	}
	if err := runner.RunOnce(t.Context()); err != nil {
		t.Fatal(err)
	}
	if control.claimCalls != 1 || reconciler.calls != 2 {
		t.Fatalf("claim calls=%d reconcile calls=%d", control.claimCalls, reconciler.calls)
	}
}

type recordingDecommissionControl struct {
	finalized int
	failed    int
	acked     int
}

func (c *recordingDecommissionControl) FinalizeDecommission(context.Context, gateway.SetRuntimeCleanupPayload, string) error {
	c.finalized++
	return nil
}

func (c *recordingDecommissionControl) FailDecommission(context.Context, gateway.SetRuntimeCleanupPayload, string, string) error {
	c.failed++
	return nil
}

func (c *recordingDecommissionControl) AcknowledgeDecommission(context.Context, string, int) error {
	c.acked++
	return nil
}

func TestNativeDecommissionDeletesRuntimeBeforeStartingCleanup(t *testing.T) {
	scheme := testScheme(t)
	set := managedUpgradeSet()
	set.UID = "set-uid"
	set.Spec.ShardRef = "shard-a"
	set.Spec.DatabaseName = "newapi_set_a"
	set.Spec.RedisDB = 12
	set.Finalizers = []string{"gateway.lightvela.com/runtime-cleanup"}
	fleet := cleanupFleet()
	cl := fake.NewClientBuilder().WithScheme(scheme).WithRuntimeObjects(set, fleet).
		WithStatusSubresource(&velagwv1alpha1.VelaGWSet{}, &batchv1.Job{}).Build()
	control := &recordingDecommissionControl{}
	reconciler := DecommissionReconciler{
		Client: cl, Control: control, CleanerImage: nextReleaseImage,
		ControlURL: "http://llmgateway-control", ImagePullSecret: "tcr-pull-secret",
	}
	payload := nativeCleanupPayload()

	if err := reconciler.Reconcile(t.Context(), payload); err != ErrWaiting {
		t.Fatalf("approval reconcile err=%v want ErrWaiting", err)
	}
	got := &velagwv1alpha1.VelaGWSet{}
	if err := cl.Get(t.Context(), client.ObjectKey{Namespace: "llmgateway", Name: "set-a"}, got); err != nil {
		t.Fatal(err)
	}
	approval := got.Spec.DecommissionApproval
	if approval == nil || approval.RequestID != payload.CleanupID || approval.CRUID != "set-uid" || approval.RedisDB != 12 {
		t.Fatalf("approval=%+v", approval)
	}

	// The real controller removes the finalizer after deleting all children.
	got.Finalizers = nil
	if err := cl.Update(t.Context(), got); err != nil {
		t.Fatal(err)
	}
	if err := reconciler.Reconcile(t.Context(), payload); err != ErrWaiting {
		t.Fatalf("delete reconcile err=%v want ErrWaiting", err)
	}
	if err := reconciler.Reconcile(t.Context(), payload); err != ErrWaiting {
		t.Fatalf("cleanup create err=%v want ErrWaiting", err)
	}
	job := &batchv1.Job{}
	if err := cl.Get(t.Context(), client.ObjectKey{Namespace: "llmgateway", Name: cleanupJobName(payload.CleanupID, payload.Attempt)}, job); err != nil {
		t.Fatal(err)
	}
	if envValue(job, "LLMGATEWAY_CLEANUP_REDIS_DB_START") != "10" || envValue(job, "LLMGATEWAY_CLEANUP_REDIS_DB_LIMIT") != "16" {
		t.Fatalf("cleanup redis range start=%q limit=%q", envValue(job, "LLMGATEWAY_CLEANUP_REDIS_DB_START"), envValue(job, "LLMGATEWAY_CLEANUP_REDIS_DB_LIMIT"))
	}
	if envValue(job, "LLMGATEWAY_CLEANUP_CAPABILITY") != payload.CleanupCapability {
		t.Fatal("cleanup capability was not projected")
	}
	if control.finalized != 0 || control.acked != 0 {
		t.Fatalf("control finalized=%d acked=%d before cleanup", control.finalized, control.acked)
	}

	job.UID = "cleanup-job-uid"
	if err := cl.Update(t.Context(), job); err != nil {
		t.Fatal(err)
	}
	if err := cl.Get(t.Context(), client.ObjectKey{Namespace: "llmgateway", Name: job.Name}, job); err != nil {
		t.Fatal(err)
	}
	job.Status.Succeeded = 1
	if err := cl.Status().Update(t.Context(), job); err != nil {
		t.Fatal(err)
	}
	if err := reconciler.Reconcile(t.Context(), payload); err != nil {
		t.Fatal(err)
	}
	if control.finalized != 1 || control.acked != 1 || control.failed != 0 {
		t.Fatalf("control finalized=%d acked=%d failed=%d", control.finalized, control.acked, control.failed)
	}
}

func cleanupFleet() *unstructured.Unstructured {
	fleet := testFleet().DeepCopy()
	fleet.Object["spec"].(map[string]any)["shards"] = []any{map[string]any{
		"name": "shard-a", "mysqlHost": "mysql.internal", "mysqlPort": "3306",
		"redisHost": "redis.internal", "redisPort": "6379", "secretName": "shard-a-secret",
		"redisDBStart": int64(10), "redisDBLimit": int64(16),
	}}
	return fleet
}

func nativeCleanupPayload() gateway.SetRuntimeCleanupPayload {
	return gateway.SetRuntimeCleanupPayload{
		CleanupID: "decommission-a", SetID: "set-a", Attempt: 2, Source: "prod", Namespace: "llmgateway", Fleet: "prod",
		ShardRef: "shard-a", DatabaseName: "newapi_set_a", RedisDB: "12", LeaseFingerprint: "lease-fingerprint",
		ClaimToken: "claim-token", CleanupCapability: "cleanup-capability",
	}
}

func envValue(job *batchv1.Job, name string) string {
	for _, env := range job.Spec.Template.Spec.Containers[0].Env {
		if env.Name == name {
			return env.Value
		}
	}
	return ""
}
