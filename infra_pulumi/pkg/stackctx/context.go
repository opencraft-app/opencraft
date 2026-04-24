package stackctx

import (
	"github.com/pulumi/pulumi/sdk/v3/go/pulumi"
	"github.com/tencentcloudstack/pulumi-tencentcloud/sdk/go/tencentcloud"

	"github.com/skipzhang/mono/infra_pulumi/pkg/config"
	"github.com/skipzhang/mono/infra_pulumi/pkg/importplan"
)

type Context struct {
	Pulumi    *pulumi.Context
	Runtime   *config.RuntimeConfig
	Inventory *config.Inventory
	Plan      *importplan.Plan
	Provider  *tencentcloud.Provider
	Derived   DerivedOutputs
}

type DerivedOutputs struct {
	VPCID                         pulumi.StringInput
	SupportSubnetID               pulumi.StringInput
	NetworkSubnetIDs              pulumi.StringMapOutput
	AccessVPCID                   pulumi.StringInput
	AccessSubnetID                pulumi.StringInput
	AccessRouteTableID            pulumi.StringInput
	ControlPlaneCCNID             pulumi.StringInput
	ControlPlaneProviderCLBID     pulumi.StringInput
	ControlPlaneEndpointServiceID pulumi.StringInput
	ControlPlaneEndpointID        pulumi.StringInput
	TKENodeSecurityGroupID        pulumi.StringInput
	TCRPublicDomain               pulumi.StringInput
	TCRPullUsername               pulumi.StringInput
	TCRPullPassword               pulumi.StringInput
}

const (
	RefVPCID                  = "__VPC_ID__"
	RefSupportSubnetID        = "__SUPPORT_SUBNET_ID__"
	RefTKENodeSecurityGroupID = "__TKE_NODE_SECURITY_GROUP_ID__"
)

func (c *Context) ResolveString(value string) pulumi.StringInput {
	switch value {
	case RefVPCID:
		return c.Derived.VPCID
	case RefSupportSubnetID:
		return c.Derived.SupportSubnetID
	case RefTKENodeSecurityGroupID:
		return c.Derived.TKENodeSecurityGroupID
	default:
		return pulumi.String(value)
	}
}

func (c *Context) ResolveStringPtr(value string) pulumi.StringPtrInput {
	return c.ResolveString(value).ToStringOutput().ToStringPtrOutput()
}

func (c *Context) ResolveStringArray(values []string) pulumi.StringArray {
	out := make(pulumi.StringArray, 0, len(values))
	for _, value := range values {
		out = append(out, c.ResolveString(value))
	}
	return out
}

func (c *Context) Options(extra ...pulumi.ResourceOption) []pulumi.ResourceOption {
	opts := []pulumi.ResourceOption{pulumi.Provider(c.Provider)}
	opts = append(opts, extra...)
	return opts
}

func (c *Context) ImportOption(id string) []pulumi.ResourceOption {
	if !c.Runtime.EnableImport || id == "" {
		return c.Options()
	}
	return c.Options(pulumi.Import(pulumi.ID(id)))
}

func (c *Context) OptionsWithImport(id string, extra ...pulumi.ResourceOption) []pulumi.ResourceOption {
	if c.Runtime.EnableImport && id != "" {
		extra = append(extra, pulumi.Import(pulumi.ID(id)))
	}
	return c.Options(extra...)
}

func (c *Context) OptionsWithAdopt(id string, extra ...pulumi.ResourceOption) []pulumi.ResourceOption {
	if id != "" {
		extra = append(extra, pulumi.Import(pulumi.ID(id)))
	}
	return c.Options(extra...)
}
