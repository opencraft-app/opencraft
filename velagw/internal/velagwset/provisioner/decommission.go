package provisioner

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strconv"
	"strings"
	"sync"
	"time"

	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/utils/ptr"
	"sigs.k8s.io/controller-runtime/pkg/client"

	"git.woa.com/wisp/mono2/llmgateway/internal/gateway"
	"git.woa.com/wisp/mono2/llmgateway/internal/setmanager"
	velagwv1alpha1 "git.woa.com/wisp/mono2/llmgateway/internal/velagwset/api/v1alpha1"
)

type DecommissionClaim struct {
	Job     gateway.SetDecommissionJob
	Cleanup gateway.SetRuntimeCleanupPayload
}

type DecommissionQueueControl interface {
	ListDecommissionJobs(context.Context, int) ([]gateway.SetDecommissionJob, error)
	ClaimDecommission(context.Context, string, string, time.Duration) (DecommissionClaim, bool, error)
}

type DecommissionRunReconciler interface {
	Reconcile(context.Context, gateway.SetRuntimeCleanupPayload) error
}

type DecommissionRunner struct {
	Control    DecommissionQueueControl
	Reconciler DecommissionRunReconciler
	Source     string
	Namespace  string
	Fleet      string
	Owner      string
	LeaseTTL   time.Duration
	Limit      int

	mu       sync.Mutex
	inFlight map[string]gateway.SetRuntimeCleanupPayload
}

func (r *DecommissionRunner) RunOnce(ctx context.Context) error {
	if r == nil || r.Control == nil || r.Reconciler == nil {
		return fmt.Errorf("decommission control and reconciler are required")
	}
	if r.Limit <= 0 {
		r.Limit = 10
	}
	if r.LeaseTTL <= 0 {
		r.LeaseTTL = 15 * time.Minute
	}
	r.mu.Lock()
	hasInFlight := len(r.inFlight) > 0
	r.mu.Unlock()
	if hasInFlight {
		return r.reconcileInFlight(ctx)
	}
	jobs, err := r.Control.ListDecommissionJobs(ctx, r.Limit)
	if err != nil {
		return err
	}
	for _, job := range jobs {
		r.mu.Lock()
		_, tracked := r.inFlight[job.ID]
		r.mu.Unlock()
		if tracked {
			continue
		}
		claim, acquired, err := r.Control.ClaimDecommission(ctx, job.ID, r.Owner, r.LeaseTTL)
		if err != nil {
			if httpErrorStatus(err) == 409 {
				continue
			}
			return fmt.Errorf("claim decommission %s: %w", job.ID, err)
		}
		if !acquired {
			continue
		}
		if claim.Job.ID != job.ID || claim.Cleanup.CleanupID != job.ID || claim.Cleanup.SetID != job.SetID {
			return fmt.Errorf("decommission %s claim identity mismatch", job.ID)
		}
		if claim.Cleanup.Source != r.Source || claim.Cleanup.Namespace != r.Namespace || claim.Cleanup.Fleet != r.Fleet {
			return fmt.Errorf("decommission %s belongs to another fleet", job.ID)
		}
		r.mu.Lock()
		if r.inFlight == nil {
			r.inFlight = make(map[string]gateway.SetRuntimeCleanupPayload)
		}
		r.inFlight[claim.Cleanup.CleanupID] = claim.Cleanup
		r.mu.Unlock()
		return r.reconcileInFlight(ctx)
	}
	return nil
}

func (r *DecommissionRunner) reconcileInFlight(ctx context.Context) error {
	r.mu.Lock()
	payloads := make([]gateway.SetRuntimeCleanupPayload, 0, len(r.inFlight))
	for _, payload := range r.inFlight {
		payloads = append(payloads, payload)
	}
	r.mu.Unlock()
	for _, payload := range payloads {
		err := r.Reconciler.Reconcile(ctx, payload)
		if err == nil {
			r.mu.Lock()
			delete(r.inFlight, payload.CleanupID)
			r.mu.Unlock()
			continue
		}
		if err != ErrWaiting {
			return fmt.Errorf("reconcile decommission %s: %w", payload.CleanupID, err)
		}
	}
	return nil
}

type DecommissionControl interface {
	FinalizeDecommission(context.Context, gateway.SetRuntimeCleanupPayload, string) error
	FailDecommission(context.Context, gateway.SetRuntimeCleanupPayload, string, string) error
	AcknowledgeDecommission(context.Context, string, int) error
}

type DecommissionReconciler struct {
	Client          client.Client
	Control         DecommissionControl
	CleanerImage    string
	ControlURL      string
	ImagePullSecret string
	Now             func() time.Time
}

func (r DecommissionReconciler) Reconcile(ctx context.Context, payload gateway.SetRuntimeCleanupPayload) error {
	if r.Client == nil || r.Control == nil {
		return fmt.Errorf("kubernetes client and decommission control are required")
	}
	if strings.TrimSpace(r.CleanerImage) == "" || strings.TrimSpace(r.ControlURL) == "" {
		return fmt.Errorf("cleaner image and control url are required")
	}
	set := &velagwv1alpha1.VelaGWSet{}
	key := client.ObjectKey{Namespace: payload.Namespace, Name: payload.SetID}
	err := r.Client.Get(ctx, key, set)
	if err == nil {
		if err := validateCleanupSet(set, payload); err != nil {
			return err
		}
		if set.Spec.DecommissionApproval == nil {
			set.Spec.DecommissionApproval = &velagwv1alpha1.DecommissionApproval{
				RequestID: payload.CleanupID, Attempt: int32(payload.Attempt), ApprovedAt: metav1.NewTime(r.nowUTC()),
				CRUID: string(set.UID), FleetRef: set.Spec.FleetRef, ShardRef: set.Spec.ShardRef,
				DatabaseName: set.Spec.DatabaseName, RedisDB: set.Spec.RedisDB,
			}
			if err := r.Client.Update(ctx, set); err != nil {
				return err
			}
			return ErrWaiting
		}
		if !cleanupApprovalMatches(set, payload) {
			return fmt.Errorf("velagwset %q has a conflicting decommission approval", set.Name)
		}
		propagation := metav1.DeletePropagationForeground
		if err := client.IgnoreNotFound(r.Client.Delete(ctx, set, &client.DeleteOptions{PropagationPolicy: &propagation})); err != nil {
			return err
		}
		return ErrWaiting
	}
	if !apierrors.IsNotFound(err) {
		return err
	}
	shard, err := r.loadCleanupShard(ctx, payload)
	if err != nil {
		return err
	}
	job := &batchv1.Job{}
	jobKey := client.ObjectKey{Namespace: payload.Namespace, Name: cleanupJobName(payload.CleanupID, payload.Attempt)}
	if err := r.Client.Get(ctx, jobKey, job); err != nil {
		if !apierrors.IsNotFound(err) {
			return err
		}
		job = r.cleanupJob(payload, shard)
		if err := r.Client.Create(ctx, job); err != nil {
			return err
		}
		return ErrWaiting
	}
	if job.Annotations["gateway.lightvela.com/cleanup-id"] != payload.CleanupID ||
		job.Annotations["gateway.lightvela.com/lease-fingerprint"] != payload.LeaseFingerprint {
		return fmt.Errorf("cleanup job %q identity conflicts with control payload", job.Name)
	}
	if job.Status.Succeeded > 0 {
		if strings.TrimSpace(string(job.UID)) == "" {
			return ErrWaiting
		}
		if err := r.Control.FinalizeDecommission(ctx, payload, string(job.UID)); err != nil {
			return err
		}
		return r.Control.AcknowledgeDecommission(ctx, payload.CleanupID, payload.Attempt)
	}
	if cleanupJobFailed(job) {
		lastError := fmt.Sprintf("runtime cleanup job failed (failed=%d)", job.Status.Failed)
		return r.Control.FailDecommission(ctx, payload, string(job.UID), lastError)
	}
	return ErrWaiting
}

func validateCleanupSet(set *velagwv1alpha1.VelaGWSet, payload gateway.SetRuntimeCleanupPayload) error {
	redisDB, err := strconv.Atoi(payload.RedisDB)
	if err != nil {
		return fmt.Errorf("invalid cleanup redis db %q", payload.RedisDB)
	}
	if set.Spec.ManagementPolicy != velagwv1alpha1.ManagementPolicyManaged || set.Spec.FleetRef != payload.Fleet ||
		set.Spec.ShardRef != payload.ShardRef || set.Spec.DatabaseName != payload.DatabaseName || set.Spec.RedisDB != int32(redisDB) {
		return fmt.Errorf("velagwset %q identity conflicts with cleanup payload", set.Name)
	}
	return nil
}

func cleanupApprovalMatches(set *velagwv1alpha1.VelaGWSet, payload gateway.SetRuntimeCleanupPayload) bool {
	approval := set.Spec.DecommissionApproval
	return approval != nil && approval.RequestID == payload.CleanupID && approval.Attempt == int32(payload.Attempt) &&
		approval.CRUID == string(set.UID) && approval.FleetRef == payload.Fleet && approval.ShardRef == payload.ShardRef &&
		approval.DatabaseName == payload.DatabaseName && strconv.Itoa(int(approval.RedisDB)) == payload.RedisDB
}

func (r DecommissionReconciler) loadCleanupShard(ctx context.Context, payload gateway.SetRuntimeCleanupPayload) (setmanager.LLMFleetShard, error) {
	object := &unstructured.Unstructured{}
	object.SetAPIVersion("llmgateway.io/v1alpha1")
	object.SetKind("LLMFleet")
	if err := r.Client.Get(ctx, client.ObjectKey{Namespace: payload.Namespace, Name: payload.Fleet}, object); err != nil {
		return setmanager.LLMFleetShard{}, fmt.Errorf("read fleet %q: %w", payload.Fleet, err)
	}
	var fleet setmanager.LLMFleet
	if err := runtime.DefaultUnstructuredConverter.FromUnstructured(object.Object, &fleet); err != nil {
		return setmanager.LLMFleetShard{}, fmt.Errorf("decode fleet %q: %w", payload.Fleet, err)
	}
	for _, shard := range fleet.Spec.Shards {
		if shard.Name != payload.ShardRef {
			continue
		}
		redisDB, err := strconv.Atoi(payload.RedisDB)
		if err != nil || shard.RedisDBLimit <= shard.RedisDBStart || redisDB < shard.RedisDBStart || redisDB >= shard.RedisDBLimit {
			return setmanager.LLMFleetShard{}, fmt.Errorf("redis db %q is outside shard %q range [%d,%d)", payload.RedisDB, shard.Name, shard.RedisDBStart, shard.RedisDBLimit)
		}
		return shard, nil
	}
	return setmanager.LLMFleetShard{}, fmt.Errorf("shard %q is absent from fleet %q", payload.ShardRef, payload.Fleet)
}

func (r DecommissionReconciler) cleanupJob(payload gateway.SetRuntimeCleanupPayload, shard setmanager.LLMFleetShard) *batchv1.Job {
	labels := map[string]string{
		"app.kubernetes.io/name": "llmgateway-runtime-cleaner", "app.kubernetes.io/component": "runtime-cleanup",
		"gateway.lightvela.com/fleet": payload.Fleet, "gateway.lightvela.com/set": payload.SetID,
	}
	env := []corev1.EnvVar{
		{Name: "LLMGATEWAY_CONTROL_URL", Value: strings.TrimRight(r.ControlURL, "/")},
		{Name: "LLMGATEWAY_CLEANUP_ID", Value: payload.CleanupID}, {Name: "LLMGATEWAY_CLEANUP_SET_ID", Value: payload.SetID},
		{Name: "LLMGATEWAY_CLEANUP_ATTEMPT", Value: strconv.Itoa(payload.Attempt)}, {Name: "LLMGATEWAY_CLEANUP_SOURCE", Value: payload.Source},
		{Name: "LLMGATEWAY_CLEANUP_NAMESPACE", Value: payload.Namespace}, {Name: "LLMGATEWAY_CLEANUP_FLEET", Value: payload.Fleet},
		{Name: "LLMGATEWAY_CLEANUP_SHARD_REF", Value: payload.ShardRef}, {Name: "LLMGATEWAY_CLEANUP_DATABASE_NAME", Value: payload.DatabaseName},
		{Name: "LLMGATEWAY_CLEANUP_REDIS_DB", Value: payload.RedisDB}, {Name: "LLMGATEWAY_CLEANUP_REDIS_DB_START", Value: strconv.Itoa(shard.RedisDBStart)},
		{Name: "LLMGATEWAY_CLEANUP_REDIS_DB_LIMIT", Value: strconv.Itoa(shard.RedisDBLimit)},
		{Name: "LLMGATEWAY_CLEANUP_LEASE_FINGERPRINT", Value: payload.LeaseFingerprint}, {Name: "LLMGATEWAY_CLEANUP_CLAIM_TOKEN", Value: payload.ClaimToken},
		{Name: "LLMGATEWAY_CLEANUP_CAPABILITY", Value: payload.CleanupCapability},
		{Name: "MYSQL_HOST", Value: shard.MySQLHost}, {Name: "MYSQL_PORT", Value: shard.MySQLPort},
		{Name: "MYSQL_ADMIN_USER", ValueFrom: secretKeyRef(shard.SecretName, "mysqlAdminUser")},
		{Name: "MYSQL_ADMIN_PASSWORD", ValueFrom: secretKeyRef(shard.SecretName, "mysqlAdminPassword")},
		{Name: "REDIS_HOST", Value: shard.RedisHost}, {Name: "REDIS_PORT", Value: shard.RedisPort},
		{Name: "REDIS_PASSWORD_ENCODED", ValueFrom: secretKeyRef(shard.SecretName, "redisPasswordEncoded")},
	}
	podSpec := corev1.PodSpec{
		AutomountServiceAccountToken: ptr.To(false), RestartPolicy: corev1.RestartPolicyNever,
		Containers: []corev1.Container{{Name: "cleaner", Image: r.CleanerImage, ImagePullPolicy: corev1.PullIfNotPresent,
			Command: []string{"/usr/local/bin/llmgateway-runtime-cleaner"}, Env: env}},
	}
	if strings.TrimSpace(r.ImagePullSecret) != "" {
		podSpec.ImagePullSecrets = []corev1.LocalObjectReference{{Name: r.ImagePullSecret}}
	}
	return &batchv1.Job{
		ObjectMeta: metav1.ObjectMeta{Name: cleanupJobName(payload.CleanupID, payload.Attempt), Namespace: payload.Namespace, Labels: labels, Annotations: map[string]string{
			"gateway.lightvela.com/cleanup-id": payload.CleanupID, "gateway.lightvela.com/cleanup-attempt": strconv.Itoa(payload.Attempt),
			"gateway.lightvela.com/lease-fingerprint": payload.LeaseFingerprint,
		}},
		Spec: batchv1.JobSpec{BackoffLimit: ptr.To[int32](2), ActiveDeadlineSeconds: ptr.To[int64](600), TTLSecondsAfterFinished: ptr.To[int32](3600),
			Template: corev1.PodTemplateSpec{ObjectMeta: metav1.ObjectMeta{Labels: labels}, Spec: podSpec}},
	}
}

func cleanupJobName(cleanupID string, attempt int) string {
	digest := sha256.Sum256([]byte(cleanupID))
	return fmt.Sprintf("velagw-cleanup-%s-a%d", hex.EncodeToString(digest[:8]), attempt)
}

func cleanupJobFailed(job *batchv1.Job) bool {
	for _, condition := range job.Status.Conditions {
		if condition.Type == batchv1.JobFailed && condition.Status == corev1.ConditionTrue {
			return true
		}
	}
	return false
}

func (r DecommissionReconciler) nowUTC() time.Time {
	if r.Now != nil {
		return r.Now().UTC()
	}
	return time.Now().UTC()
}
