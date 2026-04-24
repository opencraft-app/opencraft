package faultinject

import (
	"context"

	"cvm-mock-e2b/internal/core"
	"cvm-mock-e2b/internal/provider"
	"cvm-mock-e2b/internal/service"
)

type RecoveryResult struct {
	Triggered   bool
	Bundle      core.CapacityBundle
	NewPool     core.Pool
	PoolCreated bool
}

func IsSecurityGroupShardLimitCode(code string) bool {
	return service.IsSecurityGroupShardLimitCode(code)
}

func TriggerSGLimitRecovery(ctx context.Context, svc *service.Service, cp provider.CloudProvider, pool core.Pool, code string) (RecoveryResult, error) {
	result, err := svc.ReconcileSGShardRecovery(ctx, cp, pool, code)
	if err != nil {
		return RecoveryResult{}, err
	}
	return RecoveryResult{
		Triggered:   result.Triggered,
		Bundle:      result.Bundle,
		NewPool:     result.NewPool,
		PoolCreated: result.PoolCreated,
	}, nil
}
