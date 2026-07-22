package provisioner

import (
	"context"
	"errors"
	"fmt"
	"time"

	"git.woa.com/wisp/mono2/llmgateway/internal/gateway"
)

type ClaimReconciler interface {
	ReconcileClaim(context.Context, gateway.SetProvisionRequest) error
}

type Runner struct {
	Control    ProvisionControl
	Reconciler ClaimReconciler
	Source     string
	Namespace  string
	Fleet      string
	Owner      string
	LeaseTTL   time.Duration
	Limit      int
}

func (r Runner) RunOnce(ctx context.Context) error {
	if r.Control == nil || r.Reconciler == nil {
		return fmt.Errorf("control and reconciler are required")
	}
	if r.Limit <= 0 {
		r.Limit = 50
	}
	if r.LeaseTTL <= 0 {
		r.LeaseTTL = time.Minute
	}
	requests, err := r.Control.ListRequests(ctx, r.Source, r.Namespace, r.Fleet, "", r.Limit)
	if err != nil {
		return err
	}
	var joined error
	for _, request := range requests {
		if request.Status != gateway.SetProvisionStatusPending && request.Status != gateway.SetProvisionStatusProvisioning && request.Status != gateway.SetProvisionStatusConfigured {
			continue
		}
		if request.Status == gateway.SetProvisionStatusConfigured && request.ServingFactHash != "" {
			continue
		}
		claimed, acquired, err := r.Control.Claim(ctx, request, r.Owner, r.LeaseTTL)
		if err != nil {
			joined = errors.Join(joined, fmt.Errorf("claim request %s: %w", request.ID, err))
			continue
		}
		if !acquired {
			continue
		}
		reconcileErr := r.Reconciler.ReconcileClaim(ctx, claimed)
		if reconcileErr == nil {
			continue
		}
		if err := r.Control.Release(ctx, claimed); err != nil && httpErrorStatus(err) != 409 {
			joined = errors.Join(joined, fmt.Errorf("release request %s: %w", request.ID, err))
		}
		if !errors.Is(reconcileErr, ErrWaiting) {
			joined = errors.Join(joined, fmt.Errorf("reconcile request %s: %w", request.ID, reconcileErr))
		}
	}
	return joined
}
