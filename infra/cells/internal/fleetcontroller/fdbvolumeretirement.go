package fleetcontroller

import (
	"context"
	"fmt"
	"strings"
	"time"

	corev1 "k8s.io/api/core/v1"
	storagev1 "k8s.io/api/storage/v1"
	"k8s.io/apimachinery/pkg/api/equality"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/types"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
)

// FDBVolumeRetirementReconciler turns every storage process removed by the FDB
// Operator into an exact, time-bounded CBS quarantine record. It deliberately
// has no delete capability: a separately permissioned cloud Disk GC consumes
// Eligible records only after the ObserveOnly qualification has passed.
type FDBVolumeRetirementReconciler struct {
	Client client.Client
	Now    func() time.Time
}

func (r *FDBVolumeRetirementReconciler) Reconcile(ctx context.Context, request ctrl.Request) (ctrl.Result, error) {
	retirement := object(fdbVolumeRetirementGVK)
	if err := r.Client.Get(ctx, request.NamespacedName, retirement); err != nil {
		return ctrl.Result{}, client.IgnoreNotFound(err)
	}
	if !retirement.GetDeletionTimestamp().IsZero() {
		return ctrl.Result{}, nil
	}
	now := time.Now().UTC()
	if r.Now != nil {
		now = r.Now().UTC()
	}
	quarantine := time.Duration(nestedInt64(retirement.Object, "spec", "quarantineSeconds")) * time.Second
	if quarantine < 24*time.Hour || nestedString(retirement.Object, "spec", "csiDriver") != "com.tencent.cloud.csi.cbs" ||
		!strings.HasPrefix(nestedString(retirement.Object, "spec", "cbsDiskID"), "disk-") {
		return r.finish(ctx, retirement, now, "Blocked", "InvalidIdentity", "retirement policy or Tencent CBS identity is invalid", "Unknown", ctrl.Result{})
	}

	operation := object(fdbScaleOperationGVK)
	operationKey := types.NamespacedName{Name: nestedString(retirement.Object, "spec", "scaleOperationRef", "name"), Namespace: retirement.GetNamespace()}
	if err := r.Client.Get(ctx, operationKey, operation); err != nil {
		if apierrors.IsNotFound(err) {
			return r.finish(ctx, retirement, now, "Inventoried", "ScaleReceiptPending", "scale-down operation receipt is not available", "Unknown", ctrl.Result{RequeueAfter: 30 * time.Second})
		}
		return ctrl.Result{}, err
	}
	if string(operation.GetUID()) != nestedString(retirement.Object, "spec", "scaleOperationRef", "uid") || nestedString(operation.Object, "status", "phase") != "Succeeded" ||
		nestedString(operation.Object, "status", "receiptRef") == "" || nestedString(operation.Object, "status", "receiptDigest") == "" {
		return r.finish(ctx, retirement, now, "Inventoried", "ScaleReceiptPending", "exact successful scale-down receipt is not available", "Unknown", ctrl.Result{RequeueAfter: 30 * time.Second})
	}

	pvc := &corev1.PersistentVolumeClaim{}
	pvcKey := types.NamespacedName{Name: nestedString(retirement.Object, "spec", "pvcRef", "name"), Namespace: retirement.GetNamespace()}
	if err := r.Client.Get(ctx, pvcKey, pvc); err == nil {
		if string(pvc.UID) != nestedString(retirement.Object, "spec", "pvcRef", "uid") {
			return r.finish(ctx, retirement, now, "Blocked", "PVCIdentityReused", "PVC name now resolves to a different UID", "Unknown", ctrl.Result{})
		}
		return r.finish(ctx, retirement, now, "WaitingForRelease", "PVCStillExists", "the FDB Operator has not retired the exact PVC", "Attached", ctrl.Result{RequeueAfter: 30 * time.Second})
	} else if !apierrors.IsNotFound(err) {
		return ctrl.Result{}, err
	}

	pv := &corev1.PersistentVolume{}
	pvKey := types.NamespacedName{Name: nestedString(retirement.Object, "spec", "pvRef", "name")}
	if err := r.Client.Get(ctx, pvKey, pv); err != nil {
		if apierrors.IsNotFound(err) {
			return r.finish(ctx, retirement, now, "Blocked", "PVIdentityMissing", "the retained PV disappeared before cloud deletion was proven", "Unknown", ctrl.Result{})
		}
		return ctrl.Result{}, err
	}
	if string(pv.UID) != nestedString(retirement.Object, "spec", "pvRef", "uid") || pv.Spec.CSI == nil ||
		pv.Spec.CSI.Driver != nestedString(retirement.Object, "spec", "csiDriver") || pv.Spec.CSI.VolumeHandle != nestedString(retirement.Object, "spec", "cbsDiskID") ||
		pv.Annotations[FDBVolumeProcessGroup] != nestedString(retirement.Object, "spec", "processGroupID") ||
		pv.Annotations[FDBVolumeCellUID] != nestedString(retirement.Object, "spec", "cellRef", "uid") ||
		pv.Annotations[FDBVolumeClusterUID] != nestedString(retirement.Object, "spec", "foundationDBClusterRef", "uid") ||
		pv.Spec.PersistentVolumeReclaimPolicy != corev1.PersistentVolumeReclaimRetain {
		return r.finish(ctx, retirement, now, "Blocked", "PVIdentityMismatch", "retained PV does not match the immutable retirement inventory", "Unknown", ctrl.Result{})
	}
	if pv.Status.Phase != corev1.VolumeReleased {
		return r.finish(ctx, retirement, now, "WaitingForRelease", "PVNotReleased", fmt.Sprintf("PV phase is %s", pv.Status.Phase), "Attached", ctrl.Result{RequeueAfter: 30 * time.Second})
	}

	attachments := &storagev1.VolumeAttachmentList{}
	if err := r.Client.List(ctx, attachments); err != nil {
		return ctrl.Result{}, fmt.Errorf("list VolumeAttachments: %w", err)
	}
	for i := range attachments.Items {
		attachment := &attachments.Items[i]
		if attachment.Spec.Source.PersistentVolumeName != nil && *attachment.Spec.Source.PersistentVolumeName == pv.Name {
			return r.finish(ctx, retirement, now, "WaitingForRelease", "CBSStillAttached", "a VolumeAttachment still references the retired PV", "Attached", ctrl.Result{RequeueAfter: 30 * time.Second})
		}
	}

	releasedAt := now
	if value := nestedString(retirement.Object, "status", "releasedAt"); value != "" {
		if parsed, err := time.Parse(time.RFC3339, value); err == nil {
			releasedAt = parsed
		}
	}
	eligibleAt := releasedAt.Add(quarantine)
	phase := "Quarantined"
	reason := "RetentionActive"
	message := fmt.Sprintf("exact CBS disk is retained until %s", eligibleAt.Format(time.RFC3339))
	requeue := ctrl.Result{RequeueAfter: minRetirementRequeue(eligibleAt.Sub(now))}
	if !now.Before(eligibleAt) {
		phase = "Eligible"
		reason = "RetentionExpired"
		message = "all scale-down, identity, release and retention gates passed; independent Disk GC may delete the CBS disk"
		requeue = ctrl.Result{RequeueAfter: 30 * time.Minute}
	}
	return r.finishWithTimes(ctx, retirement, now, phase, reason, message, "Unattached", releasedAt, eligibleAt, operation, requeue)
}

func minRetirementRequeue(remaining time.Duration) time.Duration {
	if remaining <= 0 {
		return time.Minute
	}
	if remaining > 30*time.Minute {
		return 30 * time.Minute
	}
	return remaining
}

func (r *FDBVolumeRetirementReconciler) finish(ctx context.Context, retirement *unstructured.Unstructured, now time.Time, phase, reason, message, cloudState string, result ctrl.Result) (ctrl.Result, error) {
	return result, r.updateStatus(ctx, retirement, map[string]any{
		"observedGeneration": retirement.GetGeneration(), "phase": phase, "cloudState": cloudState,
		"conditions": []any{retirementCondition(retirement, now, phase, reason, message)},
	})
}

func (r *FDBVolumeRetirementReconciler) finishWithTimes(ctx context.Context, retirement *unstructured.Unstructured, now time.Time, phase, reason, message, cloudState string, releasedAt, eligibleAt time.Time, operation *unstructured.Unstructured, result ctrl.Result) (ctrl.Result, error) {
	return result, r.updateStatus(ctx, retirement, map[string]any{
		"observedGeneration": retirement.GetGeneration(), "phase": phase, "cloudState": cloudState,
		"releasedAt": releasedAt.Format(time.RFC3339), "eligibleAt": eligibleAt.Format(time.RFC3339),
		"scaleDownReceiptRef":    nestedString(operation.Object, "status", "receiptRef"),
		"scaleDownReceiptDigest": nestedString(operation.Object, "status", "receiptDigest"),
		"conditions":             []any{retirementCondition(retirement, now, phase, reason, message)},
	})
}

func retirementCondition(retirement *unstructured.Unstructured, now time.Time, phase, reason, message string) map[string]any {
	transition := now.Format(time.RFC3339)
	conditions, _, _ := unstructured.NestedSlice(retirement.Object, "status", "conditions")
	if nestedString(retirement.Object, "status", "phase") == phase && len(conditions) == 1 {
		if existing, ok := conditions[0].(map[string]any); ok && nestedString(existing, "lastTransitionTime") != "" {
			transition = nestedString(existing, "lastTransitionTime")
		}
	}
	return map[string]any{
		"type": "ReadyForGC", "status": map[bool]string{true: "True", false: "False"}[phase == "Eligible"],
		"reason": reason, "message": message, "observedGeneration": retirement.GetGeneration(), "lastTransitionTime": transition,
	}
}

func (r *FDBVolumeRetirementReconciler) updateStatus(ctx context.Context, retirement *unstructured.Unstructured, status map[string]any) error {
	current, _, _ := unstructured.NestedMap(retirement.Object, "status")
	if equality.Semantic.DeepEqual(current, status) {
		return nil
	}
	updated := retirement.DeepCopy()
	if err := unstructured.SetNestedMap(updated.Object, status, "status"); err != nil {
		return err
	}
	if err := r.Client.Status().Update(ctx, updated); err != nil {
		return fmt.Errorf("update FDBVolumeRetirement status: %w", err)
	}
	return nil
}

func (r *FDBVolumeRetirementReconciler) SetupWithManager(manager ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(manager).
		Named("fdb-volume-retirement").
		For(object(fdbVolumeRetirementGVK)).
		Complete(r)
}
