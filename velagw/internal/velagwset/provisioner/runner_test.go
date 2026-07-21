package provisioner

import (
	"context"
	"testing"
	"time"

	"git.woa.com/wisp/mono2/llmgateway/internal/gateway"
)

type runnerControl struct {
	requests []gateway.SetProvisionRequest
	claimed  int
	released int
}

func (c *runnerControl) ListRequests(context.Context, string, string, string, string, int) ([]gateway.SetProvisionRequest, error) {
	return c.requests, nil
}

func (c *runnerControl) Claim(_ context.Context, request gateway.SetProvisionRequest, _ string, _ time.Duration) (gateway.SetProvisionRequest, bool, error) {
	c.claimed++
	request.Status = gateway.SetProvisionStatusProvisioning
	request.Version++
	request.ClaimToken = "token"
	return request, true, nil
}

func (c *runnerControl) Release(context.Context, gateway.SetProvisionRequest) error {
	c.released++
	return nil
}

func (c *runnerControl) Materialized(context.Context, gateway.SetProvisionFactCommitInput) error {
	return nil
}
func (c *runnerControl) ServingReady(context.Context, gateway.SetProvisionFactCommitInput) error {
	return nil
}

type waitingClaimReconciler struct{ calls int }

func (r *waitingClaimReconciler) ReconcileClaim(context.Context, gateway.SetProvisionRequest) error {
	r.calls++
	return ErrWaiting
}

func TestRunnerReleasesClaimWhenKubernetesDependencyIsWaiting(t *testing.T) {
	control := &runnerControl{requests: []gateway.SetProvisionRequest{{
		ID: "native", Status: gateway.SetProvisionStatusPending, RuntimeBackend: gateway.SetRuntimeBackendVelaGWSet,
		WriterEpoch: 1, LifecycleRevision: 1, Version: 1,
	}}}
	reconciler := &waitingClaimReconciler{}
	runner := Runner{Control: control, Reconciler: reconciler, Source: "prod", Namespace: "llmgateway", Fleet: "prod", Owner: "p1", LeaseTTL: time.Minute, Limit: 10}
	if err := runner.RunOnce(t.Context()); err != nil {
		t.Fatal(err)
	}
	if control.claimed != 1 || control.released != 1 || reconciler.calls != 1 {
		t.Fatalf("claimed=%d released=%d reconciled=%d", control.claimed, control.released, reconciler.calls)
	}
}

func TestRunnerDoesNotReclaimConfiguredRequestWithDurableServingFact(t *testing.T) {
	control := &runnerControl{requests: []gateway.SetProvisionRequest{{
		ID: "native", Status: gateway.SetProvisionStatusConfigured, RuntimeBackend: gateway.SetRuntimeBackendVelaGWSet,
		WriterEpoch: 1, LifecycleRevision: 1, Version: 10, ServingFactHash: "durable-fact-hash",
	}}}
	reconciler := &waitingClaimReconciler{}
	runner := Runner{Control: control, Reconciler: reconciler, Source: "prod", Namespace: "llmgateway", Fleet: "prod", Owner: "p1"}
	if err := runner.RunOnce(t.Context()); err != nil {
		t.Fatal(err)
	}
	if control.claimed != 0 || control.released != 0 || reconciler.calls != 0 {
		t.Fatalf("durable serving fact was reclaimed: claimed=%d released=%d reconciled=%d", control.claimed, control.released, reconciler.calls)
	}
}
