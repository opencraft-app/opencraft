package service

import (
	"context"
	"fmt"
	"strings"

	"cvm-mock-e2b/internal/core"
	"cvm-mock-e2b/internal/provider"
)

type SGShardRecoveryResult struct {
	Triggered   bool
	Bundle      core.CapacityBundle
	NewPool     core.Pool
	PoolCreated bool
}

var securityGroupShardLimitCodes = map[string]struct{}{
	"LimitExceeded.CvmsVifsPerSecGroupLimitExceeded": {},
	"LimitExceeded.SingleUSGQuota":                   {},
	"LimitExceeded.AssociateUSGLimitExceeded":        {},
	"FailedOperation.SecurityGroupActionFailed":      {},
}

func IsSecurityGroupShardLimitCode(code string) bool {
	_, ok := securityGroupShardLimitCodes[strings.TrimSpace(code)]
	return ok
}

func (s *Service) ReconcileSGShardRecovery(ctx context.Context, cp provider.CloudProvider, pool core.Pool, code string) (SGShardRecoveryResult, error) {
	if !IsSecurityGroupShardLimitCode(code) {
		return SGShardRecoveryResult{}, nil
	}
	provisioner, ok := cp.(provider.CapacityBundleProvisioner)
	if !ok {
		return SGShardRecoveryResult{}, nil
	}
	if strings.TrimSpace(pool.TemplateClassID) == "" || strings.TrimSpace(pool.SKUID) == "" {
		return SGShardRecoveryResult{}, nil
	}

	templateClass, err := s.GetTemplateClass(ctx, pool.TemplateClassID)
	if err != nil {
		return SGShardRecoveryResult{}, err
	}
	sku, err := s.GetSKU(ctx, pool.SKUID)
	if err != nil {
		return SGShardRecoveryResult{}, err
	}
	bindings, err := s.ListTemplateSkuBindings(ctx, pool.TemplateClassID)
	if err != nil {
		return SGShardRecoveryResult{}, err
	}

	var binding *core.TemplateSkuBinding
	for i := range bindings {
		if bindings[i].SKUID != sku.ID {
			continue
		}
		if strings.TrimSpace(bindings[i].AdmissionState) != "" && bindings[i].AdmissionState != "active" {
			continue
		}
		binding = &bindings[i]
		break
	}
	if binding == nil {
		return SGShardRecoveryResult{}, fmt.Errorf("no active template sku binding for template_class=%s sku=%s", pool.TemplateClassID, pool.SKUID)
	}

	lockedPool, acquired, err := s.TryStartPoolSGShardRecovery(ctx, pool.ID)
	if err != nil {
		return SGShardRecoveryResult{}, err
	}
	if !acquired {
		return SGShardRecoveryResult{}, nil
	}
	pool = lockedPool

	bundle, err := provisioner.ProvisionCapacityBundle(ctx, provider.CapacityBundleProvisionRequest{
		TemplateClassID:        templateClass.ID,
		Region:                 templateClass.Region,
		Zone:                   pool.Zone,
		NetworkTemplateID:      sku.NetworkTemplateID,
		SourceVpcID:            pool.VpcID,
		SourceSubnetID:         pool.SubnetID,
		SourceSecurityGroupIDs: pool.SecurityGroups,
	})
	if err != nil {
		return SGShardRecoveryResult{}, err
	}
	if bundle.LineageTags == nil {
		bundle.LineageTags = map[string]string{}
	}
	bundle.LineageTags["template_class_id"] = templateClass.ID
	bundle.LineageTags["sku_id"] = sku.ID
	bundle, err = s.UpsertCapacityBundle(ctx, bundle)
	if err != nil {
		return SGShardRecoveryResult{}, err
	}
	newPool, created, err := s.EnsurePoolForCapacityBundle(ctx, *binding, sku, bundle.ID)
	if err != nil {
		return SGShardRecoveryResult{}, err
	}
	return SGShardRecoveryResult{
		Triggered:   true,
		Bundle:      bundle,
		NewPool:     newPool,
		PoolCreated: created,
	}, nil
}
