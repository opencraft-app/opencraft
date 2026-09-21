package app

import (
	"fmt"
	"strings"

	"github.com/pulumi/pulumi/sdk/v3/go/pulumi"
	"github.com/tencentcloudstack/pulumi-tencentcloud/sdk/go/tencentcloud"

	"github.com/skipzhang/mono/infra_pulumi/pkg/components/clb"
	"github.com/skipzhang/mono/infra_pulumi/pkg/components/cls"
	"github.com/skipzhang/mono/infra_pulumi/pkg/components/compute"
	"github.com/skipzhang/mono/infra_pulumi/pkg/components/connectivity"
	"github.com/skipzhang/mono/infra_pulumi/pkg/components/cynosdb"
	"github.com/skipzhang/mono/infra_pulumi/pkg/components/networking"
	"github.com/skipzhang/mono/infra_pulumi/pkg/components/notify"
	"github.com/skipzhang/mono/infra_pulumi/pkg/components/pulsar"
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

	if err := validateInventoryProfileScope(inventory.Profile, runtime.ComponentScope); err != nil {
		return err
	}

	steps, err := selectedSteps(runtime.ComponentScope)
	if err != nil {
		return err
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

func selectedSteps(scope string) ([]func(*stackctx.Context) error, error) {
	all := []func(*stackctx.Context) error{
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
		notify.Ensure,
		pulsar.Ensure,
		compute.Ensure,
	}
	switch strings.TrimSpace(scope) {
	case "":
		return all, nil
	case "notify":
		return []func(*stackctx.Context) error{notify.Ensure}, nil
	case "pulsar":
		return []func(*stackctx.Context) error{pulsar.Ensure}, nil
	case "sandbox-network":
		return []func(*stackctx.Context) error{networking.Ensure, securitygroup.EnsureSandbox}, nil
	default:
		return nil, fmt.Errorf("unsupported INFRA_COMPONENT_SCOPE %q", scope)
	}
}

func validateInventoryProfileScope(profile, scope string) error {
	profile = strings.TrimSpace(profile)
	scope = strings.TrimSpace(scope)
	if profile == config.ProfileSandboxNetwork && scope != "sandbox-network" {
		return fmt.Errorf("inventory profile %q requires component scope sandbox-network", profile)
	}
	if scope == "sandbox-network" && profile != config.ProfileSandboxNetwork {
		return fmt.Errorf("component scope sandbox-network requires inventory profile %q", config.ProfileSandboxNetwork)
	}
	return nil
}
