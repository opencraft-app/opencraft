package tencentbundle

import (
	"context"
	"fmt"
	"strings"

	"cvm-mock-e2b/internal/blueprint"
	"cvm-mock-e2b/internal/core"
	tchttp "github.com/tencentcloud/tencentcloud-sdk-go/tencentcloud/common/http"
)

const (
	VPCService = "vpc"
	VPCVersion = "2017-03-12"
)

type CommonSender interface {
	Send(request tchttp.Request, response tchttp.Response) error
}

type ClientFactory func(region string) CommonSender

type BundleRequest struct {
	TemplateClassID        string
	Region                 string
	Zone                   string
	NetworkTemplateID      string
	SourceVpcID            string
	SourceSubnetID         string
	SourceSecurityGroupIDs []string
}

type RetryFunc func(ctx context.Context, op string, fn func() error) error

type VPCShardSubnetPlan struct {
	Name    string
	CIDR    string
	Zone    string
	Role    core.VPCShardSubnetRole
	Ordinal int
}

type VPCShardPlan struct {
	TemplateClassID             string
	SKUID                       string
	BlueprintFingerprint        string
	NetworkTemplateID           string
	SecurityGroupRuleTemplateID string
	Region                      string
	VpcCIDR                     string
	SupportSubnet               VPCShardSubnetPlan
	WorkloadSubnets             []VPCShardSubnetPlan
	NATShape                    blueprint.StaticNATShape
	RouteShape                  blueprint.StaticRouteShape
	Tags                        map[string]string
}

type VPCShardApplyResult struct {
	VpcID             string
	SupportSubnetID   string
	WorkloadSubnetIDs map[string]string
	NATGatewayIDs     map[string]string
	RouteTableIDs     map[string]string
}

type VPCShardApplyError struct {
	Step          string
	PartialResult VPCShardApplyResult
	Err           error
}

func (e *VPCShardApplyError) Error() string {
	if e == nil || e.Err == nil {
		return "vpc shard apply failed"
	}
	if strings.TrimSpace(e.Step) == "" {
		return e.Err.Error()
	}
	return fmt.Sprintf("apply vpc shard failed at %s: %v", e.Step, e.Err)
}

func (e *VPCShardApplyError) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.Err
}

func normalizeBundleRequest(req BundleRequest) (BundleRequest, error) {
	req.TemplateClassID = strings.TrimSpace(req.TemplateClassID)
	req.Region = strings.TrimSpace(req.Region)
	req.Zone = strings.TrimSpace(req.Zone)
	req.NetworkTemplateID = strings.TrimSpace(req.NetworkTemplateID)
	req.SourceVpcID = strings.TrimSpace(req.SourceVpcID)
	req.SourceSubnetID = strings.TrimSpace(req.SourceSubnetID)

	securityGroups := make([]string, 0, len(req.SourceSecurityGroupIDs))
	for _, sg := range req.SourceSecurityGroupIDs {
		if trimmed := strings.TrimSpace(sg); trimmed != "" {
			securityGroups = append(securityGroups, trimmed)
		}
	}
	req.SourceSecurityGroupIDs = securityGroups

	if req.Region == "" || req.Zone == "" || req.SourceVpcID == "" || req.SourceSubnetID == "" || len(req.SourceSecurityGroupIDs) == 0 {
		return BundleRequest{}, fmt.Errorf(
			"missing tencent capacity bundle source config region=%q zone=%q vpc=%q subnet=%q security_groups=%d",
			req.Region,
			req.Zone,
			req.SourceVpcID,
			req.SourceSubnetID,
			len(req.SourceSecurityGroupIDs),
		)
	}
	return req, nil
}

func shortID(value string) string {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return "bundle"
	}
	if len(trimmed) <= 8 {
		return trimmed
	}
	return trimmed[:8]
}

func normalizeVPCShardPlan(plan VPCShardPlan) (VPCShardPlan, error) {
	plan.TemplateClassID = strings.TrimSpace(plan.TemplateClassID)
	plan.SKUID = strings.TrimSpace(plan.SKUID)
	plan.BlueprintFingerprint = strings.TrimSpace(plan.BlueprintFingerprint)
	plan.NetworkTemplateID = strings.TrimSpace(plan.NetworkTemplateID)
	plan.SecurityGroupRuleTemplateID = strings.TrimSpace(plan.SecurityGroupRuleTemplateID)
	plan.Region = strings.TrimSpace(plan.Region)
	plan.VpcCIDR = strings.TrimSpace(plan.VpcCIDR)
	plan.SupportSubnet.Name = strings.TrimSpace(plan.SupportSubnet.Name)
	plan.SupportSubnet.CIDR = strings.TrimSpace(plan.SupportSubnet.CIDR)
	plan.SupportSubnet.Zone = strings.TrimSpace(plan.SupportSubnet.Zone)
	if plan.Region == "" || plan.VpcCIDR == "" || plan.BlueprintFingerprint == "" || plan.NetworkTemplateID == "" {
		return VPCShardPlan{}, fmt.Errorf("missing vpc shard plan fields region=%q vpc_cidr=%q blueprint_fingerprint=%q network_template_id=%q", plan.Region, plan.VpcCIDR, plan.BlueprintFingerprint, plan.NetworkTemplateID)
	}
	if plan.SupportSubnet.Role == "" {
		plan.SupportSubnet.Role = core.VPCShardSubnetRoleSupport
	}
	if plan.SupportSubnet.Role != core.VPCShardSubnetRoleSupport {
		return VPCShardPlan{}, fmt.Errorf("support subnet role must be %s", core.VPCShardSubnetRoleSupport)
	}
	if plan.SupportSubnet.CIDR == "" || plan.SupportSubnet.Zone == "" {
		return VPCShardPlan{}, fmt.Errorf("missing support subnet cidr/zone")
	}
	workloads := make([]VPCShardSubnetPlan, 0, len(plan.WorkloadSubnets))
	for _, subnet := range plan.WorkloadSubnets {
		subnet.Name = strings.TrimSpace(subnet.Name)
		subnet.CIDR = strings.TrimSpace(subnet.CIDR)
		subnet.Zone = strings.TrimSpace(subnet.Zone)
		if subnet.Role == "" {
			subnet.Role = core.VPCShardSubnetRoleWorkload
		}
		if subnet.Role != core.VPCShardSubnetRoleWorkload {
			return VPCShardPlan{}, fmt.Errorf("workload subnet %q has invalid role %s", subnet.Name, subnet.Role)
		}
		if subnet.CIDR == "" || subnet.Zone == "" {
			return VPCShardPlan{}, fmt.Errorf("workload subnet %q missing cidr/zone", subnet.Name)
		}
		workloads = append(workloads, subnet)
	}
	if len(workloads) == 0 {
		return VPCShardPlan{}, fmt.Errorf("missing workload subnets")
	}
	if strings.TrimSpace(plan.NATShape.Mode) == "" {
		return VPCShardPlan{}, fmt.Errorf("missing nat shape")
	}
	if len(plan.RouteShape.RouteTables) == 0 {
		return VPCShardPlan{}, fmt.Errorf("missing route shape")
	}
	plan.WorkloadSubnets = workloads
	if plan.Tags == nil {
		plan.Tags = map[string]string{}
	}
	return plan, nil
}
