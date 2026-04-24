package securitygroup

import (
	"strings"

	"github.com/pulumi/pulumi/sdk/v3/go/pulumi"
	"github.com/tencentcloudstack/pulumi-tencentcloud/sdk/go/tencentcloud/security"

	"github.com/skipzhang/mono/infra_pulumi/pkg/config"
	"github.com/skipzhang/mono/infra_pulumi/pkg/naming"
	"github.com/skipzhang/mono/infra_pulumi/pkg/stackctx"
)

func EnsureSandbox(ctx *stackctx.Context) error {
	sg := ctx.Inventory.Stacks.Security.SandboxSG
	group, err := security.NewGroup(ctx.Pulumi, naming.StableResource("sandbox", "sg"), &security.GroupArgs{
		Name:        pulumi.StringPtr(sg.SecurityGroupName),
		Description: pulumi.StringPtr(sg.Description),
	}, ctx.ImportOption(ctx.Plan.Security.SandboxSecurityGroupID)...)
	if err != nil {
		return err
	}

	_, err = security.NewGroupRuleSet(ctx.Pulumi, naming.StableResource("sandbox", "sg-rules"), &security.GroupRuleSetArgs{
		SecurityGroupId: group.ID().ToStringOutput(),
		Ingresses:       toIngressArrayWithContext(ctx, sg.Ingress),
		Egresses:        ToEgressArray(sg.Egress),
	}, ctx.ImportOption(ctx.Plan.Security.SandboxSecurityGroupID)...)
	if err != nil {
		return err
	}

	ctx.Pulumi.Export("sandboxSecurityGroupId", group.ID())
	return nil
}

func ToIngressArray(rules []string) security.GroupRuleSetIngressArray {
	out := make(security.GroupRuleSetIngressArray, 0, len(rules))
	for _, rule := range rules {
		parsed := parseRule(rule)
		args := &security.GroupRuleSetIngressArgs{
			Action:      pulumi.String(parsed.Action),
			Protocol:    pulumi.String(parsed.Protocol),
			Port:        pulumi.String(parsed.Port),
			Description: pulumi.StringPtr(parsed.Description),
		}
		if strings.HasPrefix(parsed.Source, "sg-") {
			args.SourceSecurityId = pulumi.StringPtr(parsed.Source)
		} else {
			args.CidrBlock = pulumi.StringPtr(parsed.Source)
		}
		out = append(out, args)
	}
	return out
}

func ToEgressArray(rules []string) security.GroupRuleSetEgressArray {
	out := make(security.GroupRuleSetEgressArray, 0, len(rules))
	for _, rule := range rules {
		parsed := parseRule(rule)
		args := &security.GroupRuleSetEgressArgs{
			Action:      pulumi.String(parsed.Action),
			Protocol:    pulumi.String(parsed.Protocol),
			Port:        pulumi.String(parsed.Port),
			Description: pulumi.StringPtr(parsed.Description),
		}
		if strings.HasPrefix(parsed.Source, "sg-") {
			args.SourceSecurityId = pulumi.StringPtr(parsed.Source)
		} else {
			args.CidrBlock = pulumi.StringPtr(parsed.Source)
		}
		out = append(out, args)
	}
	return out
}

func ParseRules(inventory config.SecurityGroupInventory) (security.GroupRuleSetIngressArray, security.GroupRuleSetEgressArray) {
	return ToIngressArray(inventory.Ingress), ToEgressArray(inventory.Egress)
}

type rule struct {
	Action      string
	Source      string
	Port        string
	Protocol    string
	Description string
}

func parseRule(raw string) rule {
	parts := strings.Split(raw, "#")
	parsed := rule{}
	if len(parts) > 0 {
		parsed.Action = parts[0]
	}
	if len(parts) > 1 {
		parsed.Source = parts[1]
	}
	if len(parts) > 2 {
		parsed.Port = parts[2]
	}
	if len(parts) > 3 {
		parsed.Protocol = parts[3]
	}
	if len(parts) > 4 {
		parsed.Description = strings.Join(parts[4:], "#")
	}
	return parsed
}

func toIngressArrayWithContext(ctx *stackctx.Context, rules []string) security.GroupRuleSetIngressArray {
	out := make(security.GroupRuleSetIngressArray, 0, len(rules))
	for _, rule := range rules {
		parsed := parseRule(rule)
		args := &security.GroupRuleSetIngressArgs{
			Action:      pulumi.String(parsed.Action),
			Protocol:    pulumi.String(parsed.Protocol),
			Port:        pulumi.String(parsed.Port),
			Description: pulumi.StringPtr(parsed.Description),
		}
		switch {
		case strings.HasPrefix(parsed.Source, "sg-"):
			args.SourceSecurityId = pulumi.StringPtr(parsed.Source)
		case strings.HasPrefix(parsed.Source, "__"):
			args.SourceSecurityId = ctx.ResolveStringPtr(parsed.Source)
		default:
			args.CidrBlock = pulumi.StringPtr(parsed.Source)
		}
		out = append(out, args)
	}
	return out
}
