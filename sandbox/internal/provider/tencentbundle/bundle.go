package tencentbundle

import (
	"context"
	"fmt"
	"strings"
	"time"

	"cvm-mock-e2b/internal/core"
)

func ProvisionCapacityBundle(ctx context.Context, factory ClientFactory, retry RetryFunc, req BundleRequest) (core.CapacityBundle, error) {
	req, err := normalizeBundleRequest(req)
	if err != nil {
		return core.CapacityBundle{}, err
	}

	clonedSGIDs := make([]string, 0, len(req.SourceSecurityGroupIDs))
	for _, sourceSecurityGroupID := range req.SourceSecurityGroupIDs {
		clonedID, err := CloneSecurityGroup(ctx, factory, retry, req.Region, sourceSecurityGroupID, req.TemplateClassID)
		if err != nil {
			return core.CapacityBundle{}, err
		}
		if err := AssertSecurityGroupPoliciesCloned(ctx, factory, retry, req.Region, sourceSecurityGroupID, clonedID); err != nil {
			_ = DeleteSecurityGroup(ctx, factory, retry, req.Region, clonedID)
			return core.CapacityBundle{}, err
		}
		clonedSGIDs = append(clonedSGIDs, clonedID)
	}

	now := time.Now().UTC()
	suffix := fmt.Sprintf("%d", now.UnixNano())
	return core.CapacityBundle{
		ID:                  "bundle-" + suffix,
		Region:              req.Region,
		Zone:                req.Zone,
		VpcID:               req.SourceVpcID,
		SubnetID:            req.SourceSubnetID,
		SecurityGroupIDs:    clonedSGIDs,
		NetworkTemplateID:   req.NetworkTemplateID,
		Status:              core.CapacityBundleStatusWarm,
		BootstrapGeneration: 1,
		LineageTags: map[string]string{
			"template_class_id":      req.TemplateClassID,
			"provisioner":            "tencent",
			"source_vpc_id":          req.SourceVpcID,
			"source_subnet_id":       req.SourceSubnetID,
			"source_security_groups": strings.Join(req.SourceSecurityGroupIDs, ","),
		},
		CreatedAt: now,
		UpdatedAt: now,
	}, nil
}
