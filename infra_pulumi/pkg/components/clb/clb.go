package clb

import (
	"fmt"
	"strings"

	"github.com/pulumi/pulumi/sdk/v3/go/pulumi"
	tencentclb "github.com/tencentcloudstack/pulumi-tencentcloud/sdk/go/tencentcloud/clb"

	"github.com/skipzhang/mono/infra_pulumi/pkg/naming"
	"github.com/skipzhang/mono/infra_pulumi/pkg/stackctx"
)

func EnsureAIGatewayModelInternal(ctx *stackctx.Context) error {
	resourceName := naming.StableResource("ai-gateway", "model", "internal", "lb")
	clbName := fmt.Sprintf("ai-gateway-model-%s", ctx.Inventory.EnvShort)

	instance, err := tencentclb.NewInstance(ctx.Pulumi, resourceName, &tencentclb.InstanceArgs{
		NetworkType: pulumi.String("INTERNAL"),
		ClbName:     pulumi.String(clbName),
		ProjectId:   pulumi.IntPtr(0),
		VpcId:       ctx.Derived.VPCID,
		SubnetId:    ctx.Derived.SupportSubnetID,
		Tags: pulumi.StringMap{
			"env": pulumi.String(ctx.Inventory.EnvShort),
			"app": pulumi.String("ai-gateway-model"),
		},
	}, ctx.Options()...)
	if err != nil {
		return err
	}

	baseURL := pulumi.Sprintf("http://%s/v1", instance.Vip)
	if domainOrigin := strings.TrimSpace(ctx.Inventory.Domains.ModelAPIInternal); domainOrigin != "" {
		baseURL = pulumi.String(fmt.Sprintf("%s/v1", strings.TrimRight(domainOrigin, "/"))).ToStringOutput()
	}

	ctx.Pulumi.Export("aiGatewayModelInternalLbId", instance.ID())
	ctx.Pulumi.Export("aiGatewayModelInternalVip", instance.Vip)
	ctx.Pulumi.Export("aiGatewayModelInternalBaseUrl", baseURL)
	return nil
}
