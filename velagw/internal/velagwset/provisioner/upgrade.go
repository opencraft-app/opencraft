package provisioner

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"sigs.k8s.io/controller-runtime/pkg/client"

	"git.woa.com/wisp/mono2/llmgateway/internal/gateway"
	"git.woa.com/wisp/mono2/llmgateway/internal/setmanager"
	velagwv1alpha1 "git.woa.com/wisp/mono2/llmgateway/internal/velagwset/api/v1alpha1"
)

type UpgradeRunReconciler interface {
	Reconcile(context.Context, gateway.SetUpgradeRun, string) error
}

type UpgradeQueueControl interface {
	ListUpgradeRuns(context.Context, int) ([]gateway.SetUpgradeRun, error)
	ClaimUpgradeRun(context.Context, string, string, time.Duration) (gateway.SetUpgradeRun, bool, error)
}

type UpgradeRunner struct {
	Control    UpgradeQueueControl
	Reconciler UpgradeRunReconciler
	Source     string
	Namespace  string
	Fleet      string
	Owner      string
	LeaseTTL   time.Duration
	Limit      int
}

func (r UpgradeRunner) RunOnce(ctx context.Context) error {
	if r.Control == nil || r.Reconciler == nil {
		return fmt.Errorf("upgrade control and reconciler are required")
	}
	if r.Limit <= 0 {
		r.Limit = 20
	}
	if r.LeaseTTL <= 0 {
		r.LeaseTTL = 15 * time.Minute
	}
	runs, err := r.Control.ListUpgradeRuns(ctx, r.Limit)
	if err != nil {
		return err
	}
	var joined error
	for _, candidate := range runs {
		if candidate.Source != r.Source || candidate.Namespace != r.Namespace || candidate.Fleet != r.Fleet {
			continue
		}
		run, acquired, err := r.Control.ClaimUpgradeRun(ctx, candidate.ID, r.Owner, r.LeaseTTL)
		if err != nil {
			joined = errors.Join(joined, fmt.Errorf("claim upgrade %s: %w", candidate.ID, err))
			continue
		}
		if !acquired {
			continue
		}
		if err := r.Reconciler.Reconcile(ctx, run, r.Owner); err != nil && !errors.Is(err, ErrWaiting) {
			joined = errors.Join(joined, fmt.Errorf("reconcile upgrade %s: %w", run.ID, err))
		}
	}
	return joined
}

type UpgradeControl interface {
	CompleteUpgradeMaster(context.Context, string, string, bool, string) (gateway.SetUpgradeRun, error)
	CompleteUpgradeCompatibility(context.Context, string, string, bool, string) (gateway.SetUpgradeRun, error)
	UpgradeProbeCredential(context.Context, string, string) (gateway.SetUpgradeProbeCredential, error)
	PrepareUpgradeCandidate(context.Context, string, string, string) (gateway.SetUpgradeRun, error)
	RecordUpgradeProbe(context.Context, string, string, bool, string) (gateway.SetUpgradeRun, error)
	UpgradeAction(context.Context, string, string, string, bool, string, string) (gateway.SetUpgradeRun, error)
}

type UpgradeReconciler struct {
	Client     client.Client
	Control    UpgradeControl
	HTTPClient *http.Client
	ProbeModel string
	Probe      func(context.Context, string, string, string) error
	Now        func() time.Time
}

func (r UpgradeReconciler) Reconcile(ctx context.Context, run gateway.SetUpgradeRun, owner string) error {
	if r.Client == nil || r.Control == nil {
		return fmt.Errorf("kubernetes client and upgrade control are required")
	}
	if strings.TrimSpace(owner) == "" {
		return fmt.Errorf("upgrade owner is required")
	}
	set := &velagwv1alpha1.VelaGWSet{}
	if err := r.Client.Get(ctx, client.ObjectKey{Namespace: run.Namespace, Name: run.SetID}, set); err != nil {
		return err
	}
	if set.Spec.ManagementPolicy != velagwv1alpha1.ManagementPolicyManaged || set.Spec.FleetRef != run.Fleet {
		return fmt.Errorf("velagwset %q is not a managed member of fleet %q", run.SetID, run.Fleet)
	}
	switch run.Status {
	case gateway.SetUpgradeRunStatusUpgradingMaster:
		return r.reconcileMaster(ctx, set, run, owner)
	case gateway.SetUpgradeRunStatusVerifyingCompatibility:
		return r.reconcileCompatibility(ctx, run, owner)
	case gateway.SetUpgradeRunStatusPreparing:
		return r.reconcileCandidate(ctx, set, run, owner)
	case gateway.SetUpgradeRunStatusProbing:
		return r.reconcileProbe(ctx, set, run, owner)
	case gateway.SetUpgradeRunStatusSwitching:
		if run.SwitchedAt.IsZero() {
			_, err := r.Control.UpgradeAction(ctx, run.ID, "switch", owner, true, "", "")
			return err
		}
		return ErrWaiting
	case gateway.SetUpgradeRunStatusDraining:
		return r.reconcileDrain(ctx, set, run, owner, false)
	case gateway.SetUpgradeRunStatusRollbackSwitching:
		return ErrWaiting
	case gateway.SetUpgradeRunStatusRollbackDraining:
		return r.reconcileDrain(ctx, set, run, owner, true)
	default:
		return nil
	}
}

func (r UpgradeReconciler) reconcileMaster(ctx context.Context, set *velagwv1alpha1.VelaGWSet, run gateway.SetUpgradeRun, owner string) error {
	if !digestPinnedImage(run.TargetImage) {
		return fmt.Errorf("upgrade image must be pinned by sha256 digest")
	}
	if set.Spec.Admin.Image != run.TargetImage {
		if current, ok := trafficRuntime(set, run.FromGeneration); ok && set.Spec.Admin.Image != current.Image {
			return fmt.Errorf("velagwset %q admin image drifted from active runtime generation %d", set.Name, run.FromGeneration)
		}
		set.Spec.Admin.Image = run.TargetImage
		if err := r.Client.Update(ctx, set); err != nil {
			return err
		}
		return ErrWaiting
	}
	if set.Status.ObservedGeneration < set.Generation || !conditionTrue(set.Status.Conditions, "AdminReady") || set.Status.AdminReadyReplicas < 1 {
		return ErrWaiting
	}
	_, err := r.Control.CompleteUpgradeMaster(ctx, run.ID, owner, true, "")
	return err
}

func (r UpgradeReconciler) reconcileCompatibility(ctx context.Context, run gateway.SetUpgradeRun, owner string) error {
	credential, err := r.Control.UpgradeProbeCredential(ctx, run.ID, owner)
	if err != nil {
		return err
	}
	probeErr := r.probe(ctx, runtimeBaseURL(run.Fleet, run.SetID, run.FromGeneration), credential.UpstreamKey)
	lastError := ""
	if probeErr != nil {
		lastError = probeErr.Error()
	}
	_, err = r.Control.CompleteUpgradeCompatibility(ctx, run.ID, owner, probeErr == nil, lastError)
	if err != nil {
		return err
	}
	if probeErr != nil {
		return fmt.Errorf("old runtime is incompatible with upgraded admin schema: %w", probeErr)
	}
	return nil
}

func (r UpgradeReconciler) reconcileCandidate(ctx context.Context, set *velagwv1alpha1.VelaGWSet, run gateway.SetUpgradeRun, owner string) error {
	changed, err := ensureUpgradeRuntime(set, run)
	if err != nil {
		return err
	}
	if changed {
		if err := r.Client.Update(ctx, set); err != nil {
			return err
		}
		return ErrWaiting
	}
	if set.Status.ObservedGeneration < set.Generation || !trafficRuntimeReady(set, run.ToGeneration) {
		return ErrWaiting
	}
	credential, err := r.Control.UpgradeProbeCredential(ctx, run.ID, owner)
	if err != nil {
		return err
	}
	baseURL := runtimeBaseURL(run.Fleet, run.SetID, run.ToGeneration)
	if err := r.probe(ctx, baseURL, credential.UpstreamKey); err != nil {
		return ErrWaiting
	}
	_, err = r.Control.PrepareUpgradeCandidate(ctx, run.ID, owner, baseURL)
	return err
}

func (r UpgradeReconciler) reconcileProbe(ctx context.Context, set *velagwv1alpha1.VelaGWSet, run gateway.SetUpgradeRun, owner string) error {
	if _, ok := trafficRuntime(set, run.ToGeneration); !ok {
		return fmt.Errorf("candidate runtime generation %d is absent from velagwset %q", run.ToGeneration, set.Name)
	}
	credential, err := r.Control.UpgradeProbeCredential(ctx, run.ID, owner)
	if err != nil {
		return err
	}
	probeErr := r.probe(ctx, runtimeBaseURL(run.Fleet, run.SetID, run.ToGeneration), credential.UpstreamKey)
	lastError := ""
	if probeErr != nil {
		lastError = probeErr.Error()
	}
	updated, err := r.Control.RecordUpgradeProbe(ctx, run.ID, owner, probeErr == nil, lastError)
	if err != nil {
		return err
	}
	if updated.Status == gateway.SetUpgradeRunStatusFailed {
		if removeTrafficRuntime(set, run.ToGeneration) {
			return r.Client.Update(ctx, set)
		}
	}
	return nil
}

func (r UpgradeReconciler) reconcileDrain(ctx context.Context, set *velagwv1alpha1.VelaGWSet, run gateway.SetUpgradeRun, owner string, rollback bool) error {
	now := r.nowUTC()
	if !rollback && run.RollbackRequested {
		_, err := r.Control.UpgradeAction(ctx, run.ID, "rollback", owner, false, "", run.RollbackReason)
		return err
	}
	if !rollback && !run.RollbackDeadline.IsZero() && now.Before(run.RollbackDeadline) {
		credential, err := r.Control.UpgradeProbeCredential(ctx, run.ID, owner)
		if err != nil {
			return err
		}
		probeErr := r.probe(ctx, runtimeBaseURL(run.Fleet, run.SetID, run.ToGeneration), credential.UpstreamKey)
		lastError := ""
		if probeErr != nil {
			lastError = probeErr.Error()
		}
		_, err = r.Control.RecordUpgradeProbe(ctx, run.ID, owner, probeErr == nil, lastError)
		return err
	}
	if run.DrainDeadline.IsZero() || now.Before(run.DrainDeadline) {
		return ErrWaiting
	}
	retired := run.FromGeneration
	if rollback {
		retired = run.ToGeneration
	}
	if removeTrafficRuntime(set, retired) {
		if err := r.Client.Update(ctx, set); err != nil {
			return err
		}
		return ErrWaiting
	}
	if set.Status.ObservedGeneration < set.Generation || statusContainsRuntime(set, retired) {
		return ErrWaiting
	}
	_, err := r.Control.UpgradeAction(ctx, run.ID, "drain-complete", owner, true, "", "")
	return err
}

func ensureUpgradeRuntime(set *velagwv1alpha1.VelaGWSet, run gateway.SetUpgradeRun) (bool, error) {
	if !digestPinnedImage(run.TargetImage) || run.ToGeneration <= run.FromGeneration {
		return false, fmt.Errorf("invalid immutable runtime generation for set %q", run.SetID)
	}
	if existing, ok := trafficRuntime(set, run.ToGeneration); ok {
		if existing.Image != run.TargetImage {
			return false, fmt.Errorf("runtime generation %d for set %q already has another image", run.ToGeneration, run.SetID)
		}
		return false, nil
	}
	active, ok := trafficRuntime(set, run.FromGeneration)
	if !ok {
		return false, fmt.Errorf("active runtime generation %d for set %q is absent", run.FromGeneration, run.SetID)
	}
	replicas := active.Replicas
	if replicas <= 0 {
		replicas = 1
	}
	set.Spec.TrafficRuntimes = append(set.Spec.TrafficRuntimes, velagwv1alpha1.TrafficRuntimeSpec{
		Generation: run.ToGeneration, Image: run.TargetImage, Replicas: replicas,
	})
	return true, nil
}

func removeTrafficRuntime(set *velagwv1alpha1.VelaGWSet, generation int64) bool {
	kept := make([]velagwv1alpha1.TrafficRuntimeSpec, 0, len(set.Spec.TrafficRuntimes))
	for _, runtime := range set.Spec.TrafficRuntimes {
		if runtime.Generation != generation {
			kept = append(kept, runtime)
		}
	}
	if len(kept) == len(set.Spec.TrafficRuntimes) {
		return false
	}
	set.Spec.TrafficRuntimes = kept
	return true
}

func trafficRuntime(set *velagwv1alpha1.VelaGWSet, generation int64) (velagwv1alpha1.TrafficRuntimeSpec, bool) {
	for _, runtime := range set.Spec.TrafficRuntimes {
		if runtime.Generation == generation {
			return runtime, true
		}
	}
	return velagwv1alpha1.TrafficRuntimeSpec{}, false
}

func trafficRuntimeReady(set *velagwv1alpha1.VelaGWSet, generation int64) bool {
	for _, status := range set.Status.TrafficRuntimes {
		if status.Generation == generation {
			return status.DesiredReplicas > 0 && status.ReadyReplicas >= status.DesiredReplicas && status.AvailableReplicas >= status.DesiredReplicas
		}
	}
	return false
}

func statusContainsRuntime(set *velagwv1alpha1.VelaGWSet, generation int64) bool {
	for _, status := range set.Status.TrafficRuntimes {
		if status.Generation == generation {
			return true
		}
	}
	return false
}

func runtimeBaseURL(fleet, setID string, generation int64) string {
	return fmt.Sprintf("http://%s-%s-g%d-newapi-traffic:3000", fleet, setID, generation)
}

func (r UpgradeReconciler) probe(ctx context.Context, baseURL, key string) error {
	model := strings.TrimSpace(r.ProbeModel)
	if model == "" {
		model = "auto"
	}
	if r.Probe != nil {
		return r.Probe(ctx, baseURL, key, model)
	}
	return setmanager.ProbeSetUpgradeRuntime(ctx, r.HTTPClient, baseURL, key, model)
}

func (r UpgradeReconciler) nowUTC() time.Time {
	if r.Now != nil {
		return r.Now().UTC()
	}
	return time.Now().UTC()
}
