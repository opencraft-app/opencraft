package service

import (
	"context"
	"errors"
	"os"
	"sort"
	"strings"

	"cvm-mock-e2b/internal/core"
	"cvm-mock-e2b/internal/observability"
	"cvm-mock-e2b/internal/provider"
	"go.opentelemetry.io/otel/attribute"
)

type AutoscaleTarget struct {
	TemplateClass core.TemplateClass
	Binding       core.TemplateSkuBinding
	SKU           core.SKU
}

func (s *Service) SelectAutoscaleTargets(ctx context.Context, templateClass core.TemplateClass) ([]AutoscaleTarget, error) {
	bindings, err := s.ListTemplateSkuBindings(ctx, templateClass.ID)
	if err != nil {
		if errors.Is(err, core.ErrTemplateClassNotFound) {
			return nil, nil
		}
		return nil, err
	}
	sort.SliceStable(bindings, func(i, j int) bool {
		if bindings[i].Priority != bindings[j].Priority {
			return bindings[i].Priority < bindings[j].Priority
		}
		if bindings[i].Weight != bindings[j].Weight {
			return bindings[i].Weight > bindings[j].Weight
		}
		return bindings[i].SKUID < bindings[j].SKUID
	})
	active := make([]AutoscaleTarget, 0, len(bindings))
	live := make([]AutoscaleTarget, 0, len(bindings))
	for _, binding := range bindings {
		if strings.TrimSpace(binding.AdmissionState) != "" && binding.AdmissionState != "active" {
			continue
		}
		if !binding.RolloutEligibility {
			continue
		}
		sku, err := s.GetSKU(ctx, binding.SKUID)
		if err != nil {
			return nil, err
		}
		target := AutoscaleTarget{TemplateClass: templateClass, Binding: binding, SKU: sku}
		active = append(active, target)
		pools, err := s.ListPoolsForSKU(ctx, binding.SKUID)
		if err != nil {
			return nil, err
		}
		if len(pools) > 0 {
			live = append(live, target)
		}
	}
	if len(live) > 0 {
		return live, nil
	}
	if len(active) == 0 {
		return nil, nil
	}
	return []AutoscaleTarget{active[0]}, nil
}

func CapacityBundlesForTarget(bundles []core.CapacityBundle, target AutoscaleTarget) []core.CapacityBundle {
	filtered := make([]core.CapacityBundle, 0, len(bundles))
	for _, bundle := range bundles {
		switch bundle.Status {
		case core.CapacityBundleStatusWarm, core.CapacityBundleStatusActive:
		default:
			continue
		}
		templateClassID := strings.TrimSpace(bundle.LineageTags["template_class_id"])
		if templateClassID != "" && templateClassID != target.TemplateClass.ID {
			continue
		}
		skuID := strings.TrimSpace(bundle.LineageTags["sku_id"])
		if skuID != "" && skuID != target.SKU.ID {
			continue
		}
		filtered = append(filtered, bundle)
	}
	sort.SliceStable(filtered, func(i, j int) bool {
		if !filtered[i].CreatedAt.Equal(filtered[j].CreatedAt) {
			return filtered[i].CreatedAt.Before(filtered[j].CreatedAt)
		}
		return filtered[i].ID < filtered[j].ID
	})
	return filtered
}

func SKUNeedsCapacityGrowth(policy core.PoolAutoscalePolicy, sku core.SKU, pools []core.Pool) bool {
	if policy.MaxPoolCount > 0 && len(pools) >= policy.MaxPoolCount {
		return false
	}
	activePools := 0
	currentDesired := 0
	for _, pool := range pools {
		if !PoolEligibleForRollout(pool) {
			continue
		}
		activePools++
		if pool.DesiredCap > 0 {
			currentDesired += pool.DesiredCap
		}
	}
	if policy.MinPoolCount > 0 && activePools < policy.MinPoolCount {
		return true
	}
	if policy.SlowHorizonTarget > 0 && currentDesired < policy.SlowHorizonTarget {
		return true
	}
	return false
}

func PoolEligibleForRollout(pool core.Pool) bool {
	if pool.Status != core.PoolStatusActive {
		return false
	}
	switch pool.CapacityState {
	case "", core.PoolCapacityStateActive:
		return true
	default:
		return false
	}
}

func SourceNetworkForAutoscaleTarget(ctx context.Context, svc *Service, templateClassID string, sku core.SKU, region string, pools []core.Pool) (vpcID string, subnetID string, zone string, securityGroups []string, err error) {
	if svc != nil {
		shard, subnet, ok, lookupErr := svc.ActiveShardSubnetForSKU(ctx, templateClassID, sku.ID)
		if lookupErr != nil {
			return "", "", "", nil, lookupErr
		}
		if ok {
			vpcID = strings.TrimSpace(shard.VpcID)
			subnetID = strings.TrimSpace(subnet.SubnetID)
			zone = strings.TrimSpace(subnet.Zone)
		}
	}
	if region == "ap-beijing" {
		if vpcID == "" {
			vpcID = firstNonEmptyBundleString(strings.TrimSpace(os.Getenv("SANDBOX_VPC_ID")), strings.TrimSpace(os.Getenv("SANDBOX_TENCENT_LIVE_VPC_ID")))
		}
		if subnetID == "" {
			subnetID = firstNonEmptyBundleString(strings.TrimSpace(os.Getenv("SANDBOX_POOL_BJ8_SUBNET_ID")), strings.TrimSpace(os.Getenv("SANDBOX_TENCENT_LIVE_SUBNET_ID")))
		}
		if zone == "" {
			zone = firstNonEmptyBundleString(strings.TrimSpace(os.Getenv("SANDBOX_POOL_BJ8_ZONE")), strings.TrimSpace(os.Getenv("SANDBOX_TENCENT_LIVE_ZONE")))
		}
		if len(securityGroups) == 0 {
			securityGroups = splitCapacityBundleCSV(
				firstNonEmptyBundleString(strings.TrimSpace(os.Getenv("SANDBOX_POOL_BJ8_SECURITY_GROUPS")), strings.TrimSpace(os.Getenv("SANDBOX_TENCENT_LIVE_SECURITY_GROUPS"))),
			)
		}
	}
	for _, pool := range pools {
		if vpcID == "" {
			vpcID = strings.TrimSpace(pool.VpcID)
		}
		if subnetID == "" {
			subnetID = strings.TrimSpace(pool.SubnetID)
		}
		if zone == "" {
			zone = strings.TrimSpace(pool.Zone)
		}
		if len(securityGroups) == 0 && len(pool.SecurityGroups) > 0 {
			securityGroups = append([]string(nil), pool.SecurityGroups...)
		}
	}
	return vpcID, subnetID, zone, securityGroups, nil
}

func (s *Service) BuildWarmCapacityBundleProvisionRequest(ctx context.Context, templateClass core.TemplateClass, target AutoscaleTarget, pools []core.Pool) (provider.CapacityBundleProvisionRequest, error) {
	vpcID, subnetID, zone, securityGroups, err := SourceNetworkForAutoscaleTarget(ctx, s, templateClass.ID, target.SKU, templateClass.Region, pools)
	if err != nil {
		return provider.CapacityBundleProvisionRequest{}, err
	}
	return provider.CapacityBundleProvisionRequest{
		TemplateClassID:        templateClass.ID,
		Region:                 templateClass.Region,
		Zone:                   zone,
		NetworkTemplateID:      target.SKU.NetworkTemplateID,
		SourceVpcID:            vpcID,
		SourceSubnetID:         subnetID,
		SourceSecurityGroupIDs: securityGroups,
	}, nil
}

func (s *Service) EnsureWarmBundleFromActiveShardSubnet(ctx context.Context, templateClass core.TemplateClass, target AutoscaleTarget, provisioner provider.CapacityBundleProvisioner, pools []core.Pool) (core.CapacityBundle, error) {
	if provisioner == nil {
		return core.CapacityBundle{}, errors.New("missing capacity bundle provisioner")
	}
	req, err := s.BuildWarmCapacityBundleProvisionRequest(ctx, templateClass, target, pools)
	if err != nil {
		return core.CapacityBundle{}, err
	}
	bundle, err := provisioner.ProvisionCapacityBundle(ctx, req)
	if err != nil {
		return core.CapacityBundle{}, err
	}
	if bundle.LineageTags == nil {
		bundle.LineageTags = map[string]string{}
	}
	bundle.LineageTags["template_class_id"] = templateClass.ID
	bundle.LineageTags["sku_id"] = target.SKU.ID
	if shard, subnet, ok, lookupErr := s.ActiveShardSubnetForSKU(ctx, templateClass.ID, target.SKU.ID); lookupErr == nil && ok {
		bundle.LineageTags["vpc_shard_id"] = shard.ID
		bundle.LineageTags["subnet_member_id"] = subnet.ID
		bundle.LineageTags["blueprint_snapshot_id"] = shard.BlueprintSnapshotID
	}
	return s.UpsertCapacityBundle(ctx, bundle)
}

func (s *Service) EnsureWarmCapacityBundles(ctx context.Context, cp provider.CloudProvider) (int, error) {
	provisioner, ok := cp.(provider.CapacityBundleProvisioner)
	if !ok {
		return 0, errors.New("missing capacity bundle provisioner")
	}
	shardProvisioner, _ := cp.(provider.VPCShardProvisioner)
	templateClasses, err := s.ListTemplateClasses(ctx)
	if err != nil {
		return 0, err
	}
	created := 0
	for _, templateClass := range templateClasses {
		policy, err := s.GetPoolAutoscalePolicy(ctx, templateClass.ID)
		if err != nil {
			if errors.Is(err, core.ErrPoolAutoscalePolicyNotFound) {
				continue
			}
			return created, err
		}
		targets, err := s.SelectAutoscaleTargets(ctx, templateClass)
		if err != nil {
			return created, err
		}
		for _, target := range targets {
			if shardProvisioner != nil {
				if _, _, err := s.ReconcileVPCShardHeadroom(ctx, shardProvisioner, templateClass, target, ""); err != nil {
					return created, err
				}
			}
			currentWarm, err := s.WarmCapacityBundleCountForSKU(ctx, target.SKU.ID)
			if err != nil {
				return created, err
			}
			pools, err := s.ListPoolsForSKU(ctx, target.SKU.ID)
			if err != nil {
				return created, err
			}
			deficit := policy.WarmBundleTarget - currentWarm
			for i := 0; i < deficit; i++ {
				bundle, err := s.EnsureWarmBundleFromActiveShardSubnet(ctx, templateClass, target, provisioner, pools)
				if err != nil {
					return created, err
				}
				observability.EmitEvent(ctx, "sandbox.capacity_bundle.provisioned", "已为指定模板类和 SKU 预热创建一个新的容量 bundle，记录了这次生成的 VPC、子网、安全组和目标地域信息。",
					attribute.String("template_class_id", templateClass.ID),
					attribute.String("sku_id", target.SKU.ID),
					attribute.String("bundle_id", bundle.ID),
					attribute.String("region", bundle.Region),
					attribute.String("zone", bundle.Zone),
					attribute.String("vpc_id", bundle.VpcID),
					attribute.String("subnet_id", bundle.SubnetID),
					attribute.StringSlice("security_group_ids", bundle.SecurityGroupIDs),
					attribute.String("network_template_id", target.SKU.NetworkTemplateID),
				)
				created++
			}
		}
	}
	return created, nil
}

func (s *Service) EnsurePoolsFromWarmCapacityBundles(ctx context.Context) (int, error) {
	templateClasses, err := s.ListTemplateClasses(ctx)
	if err != nil {
		return 0, err
	}
	bundles, err := s.ListCapacityBundles(ctx)
	if err != nil {
		return 0, err
	}
	created := 0
	for _, templateClass := range templateClasses {
		policy, err := s.GetPoolAutoscalePolicy(ctx, templateClass.ID)
		if err != nil {
			if errors.Is(err, core.ErrPoolAutoscalePolicyNotFound) {
				continue
			}
			return created, err
		}
		targets, err := s.SelectAutoscaleTargets(ctx, templateClass)
		if err != nil {
			return created, err
		}
		for _, target := range targets {
			pools, err := s.ListPoolsForSKU(ctx, target.SKU.ID)
			if err != nil {
				return created, err
			}
			available := CapacityBundlesForTarget(bundles, target)
			for SKUNeedsCapacityGrowth(policy, target.SKU, pools) && len(available) > 0 {
				bundle := available[0]
				pool, createdPool, err := s.EnsurePoolForCapacityBundle(ctx, target.Binding, target.SKU, bundle.ID)
				if err != nil {
					observability.EmitEvent(ctx, "sandbox.capacity_bundle.assignment_failed", "控制器尝试将容量 bundle 派生成具体 pool 时失败，因此这次容量扩张没有成功落成可服务的新 pool。",
						attribute.String("template_class_id", target.Binding.TemplateClassID),
						attribute.String("sku_id", target.SKU.ID),
						attribute.String("bundle_id", bundle.ID),
						attribute.String("error", err.Error()),
					)
					return created, err
				}
				observability.EmitEvent(ctx, "sandbox.capacity_bundle.assigned_to_pool", "已将一个容量 bundle 分配给具体 pool；如果 pool_created=true，表示这次还顺带派生创建了新的 pool 并准备接流量。",
					attribute.String("template_class_id", target.Binding.TemplateClassID),
					attribute.String("sku_id", target.SKU.ID),
					attribute.String("bundle_id", bundle.ID),
					attribute.String("pool_id", pool.ID),
					attribute.Bool("pool_created", createdPool),
					attribute.String("pool_image_id", pool.BaseImage),
					attribute.Int("pool_desired_capacity", pool.DesiredCap),
					attribute.String("pool_zone", pool.Zone),
				)
				pools = append(pools, pool)
				if createdPool {
					created++
				}
				available = available[1:]
			}
		}
	}
	return created, nil
}

func splitCapacityBundleCSV(value string) []string {
	parts := strings.Split(strings.TrimSpace(value), ",")
	items := make([]string, 0, len(parts))
	for _, part := range parts {
		if trimmed := strings.TrimSpace(part); trimmed != "" {
			items = append(items, trimmed)
		}
	}
	return items
}

func firstNonEmptyBundleString(values ...string) string {
	for _, value := range values {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			return trimmed
		}
	}
	return ""
}
