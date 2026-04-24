package app

import (
	"github.com/pulumi/pulumi/sdk/v3/go/pulumi"
	"github.com/tencentcloudstack/pulumi-tencentcloud/sdk/go/tencentcloud"

	"github.com/skipzhang/mono/infra_pulumi/pkg/components/clb"
	"github.com/skipzhang/mono/infra_pulumi/pkg/components/cls"
	"github.com/skipzhang/mono/infra_pulumi/pkg/components/compute"
	"github.com/skipzhang/mono/infra_pulumi/pkg/components/connectivity"
	"github.com/skipzhang/mono/infra_pulumi/pkg/components/cynosdb"
	"github.com/skipzhang/mono/infra_pulumi/pkg/components/networking"
	"github.com/skipzhang/mono/infra_pulumi/pkg/components/redis"
	"github.com/skipzhang/mono/infra_pulumi/pkg/components/securitygroup"
	"github.com/skipzhang/mono/infra_pulumi/pkg/components/storage"
	"github.com/skipzhang/mono/infra_pulumi/pkg/components/tcr"
	"github.com/skipzhang/mono/infra_pulumi/pkg/components/tke"
	"github.com/skipzhang/mono/infra_pulumi/pkg/config"
	"github.com/skipzhang/mono/infra_pulumi/pkg/importplan"
	"github.com/skipzhang/mono/infra_pulumi/pkg/stackctx"
)

func Run(ctx *pulumi.Context) error {
	runtime, err := config.LoadRuntimeConfig(ctx)
	if err != nil {
		return err
	}

	inventory, err := config.LoadInventory(runtime.InventoryPath)
	if err != nil {
		return err
	}

	provider, err := tencentcloud.NewProvider(ctx, "tencentcloud", &tencentcloud.ProviderArgs{
		Region: pulumi.StringPtr(inventory.Region),
	})
	if err != nil {
		return err
	}

	appCtx := &stackctx.Context{
		Pulumi:    ctx,
		Runtime:   runtime,
		Inventory: inventory,
		Plan:      importplan.ForEnvironment(runtime.EnvironmentName),
		Provider:  provider,
	}

	steps := []func(*stackctx.Context) error{
		networking.Ensure,
		connectivity.Ensure,
		clb.EnsureAIGatewayModelInternal,
		tcr.Ensure,
		tke.Ensure,
		securitygroup.EnsureSandbox,
		cynosdb.Ensure,
		redis.Ensure,
		storage.Ensure,
		cls.Ensure,
		compute.Ensure,
	}

	for _, step := range steps {
		if err := step(appCtx); err != nil {
			return err
		}
	}

	ctx.Export("environmentName", pulumi.String(runtime.EnvironmentName))
	ctx.Export("envShort", pulumi.String(inventory.EnvShort))
	ctx.Export("region", pulumi.String(inventory.Region))
	ctx.Export("vpcCidr", pulumi.String(inventory.Network.VpcCIDR))
	ctx.Export("inventoryPath", pulumi.String(runtime.InventoryPath))
	ctx.Export("domainPublicAPI", pulumi.String(inventory.Domains.PublicAPI))
	ctx.Export("domainAdmin", pulumi.String(inventory.Domains.Admin))
	ctx.Export("domainFrontendStatic", pulumi.String(inventory.Domains.FrontendStatic))
	ctx.Export("registryPullServer", pulumi.String(runtime.RegistryPullServer))
	if appCtx.Derived.TCRPublicDomain != nil {
		ctx.Export("registryPublicDomain", appCtx.Derived.TCRPublicDomain)
	}
	if appCtx.Derived.TCRPullUsername != nil {
		ctx.Export("registryPullUsername", appCtx.Derived.TCRPullUsername)
	}
	return nil
}
