package redis

import (
	"fmt"

	"github.com/pulumi/pulumi/sdk/v3/go/pulumi"
	tcredis "github.com/tencentcloudstack/pulumi-tencentcloud/sdk/go/tencentcloud/redis"

	"github.com/skipzhang/mono/infra_pulumi/pkg/config"
	"github.com/skipzhang/mono/infra_pulumi/pkg/naming"
	"github.com/skipzhang/mono/infra_pulumi/pkg/pulumiutil"
	"github.com/skipzhang/mono/infra_pulumi/pkg/stackctx"
	"github.com/skipzhang/mono/infra_pulumi/pkg/tencentredis"
)

func Ensure(ctx *stackctx.Context) error {
	ctlMQ, err := ensureInstance(ctx, "ctl-mq", naming.CtlMqRedisName(ctx.Inventory.EnvShort), ctx.Inventory.Stacks.Redis.CtlMQ, ctx.Plan.Redis.CtlMQID)
	if err != nil {
		return err
	}

	sandboxRoute, err := ensureInstance(ctx, "sandbox-route", naming.SandboxRouteRedisName(ctx.Inventory.EnvShort), ctx.Inventory.Stacks.Redis.SandboxRoute, ctx.Plan.Redis.SandboxRouteID)
	if err != nil {
		return err
	}

	ctx.Pulumi.Export("ctlMqRedisId", ctlMQ.ID())
	ctx.Pulumi.Export("ctlMqRedisHost", ctlMQ.Ip)
	ctx.Pulumi.Export("ctlMqRedisPort", ctlMQ.Port)
	ctx.Pulumi.Export("ctlMqRedisAddr", pulumiutil.HostPort(ctlMQ.Ip, ctlMQ.Port))

	ctx.Pulumi.Export("sandboxRouteRedisId", sandboxRoute.ID())
	ctx.Pulumi.Export("sandboxRouteRedisHost", sandboxRoute.Ip)
	ctx.Pulumi.Export("sandboxRouteRedisPort", sandboxRoute.Port)
	ctx.Pulumi.Export("sandboxRouteRedisAddr", pulumiutil.HostPort(sandboxRoute.Ip, sandboxRoute.Port))
	return nil
}

func ensureInstance(ctx *stackctx.Context, suffix, name string, cfg config.RedisInventory, importID string) (*tcredis.Instance, error) {
	resolvedImportID, err := resolveImportID(ctx, name, cfg, importID)
	if err != nil {
		return nil, err
	}

	return tcredis.NewInstance(ctx.Pulumi, naming.StableResource("redis", suffix), &tcredis.InstanceArgs{
		AvailabilityZone: pulumi.String(cfg.AvailabilityZone),
		MemSize:          pulumi.Int(cfg.MemSize),
		Name:             pulumi.String(name),
		TypeId:           pulumi.Int(cfg.TypeID),
		VpcId:            ctx.ResolveString(stackctx.RefVPCID),
		SubnetId:         ctx.ResolveString(cfg.SubnetID),
		ChargeType:       pulumi.StringPtr("POSTPAID"),
		RedisShardNum:    pulumi.IntPtr(cfg.RedisShardNum),
		RedisReplicasNum: pulumi.IntPtr(cfg.RedisReplicasNum),
		SecurityGroups:   ctx.ResolveStringArray(cfg.SecurityGroups),
		Password:         ctx.Runtime.RedisPassword.ToStringPtrOutput(),
	}, ctx.OptionsWithAdopt(resolvedImportID, pulumi.IgnoreChanges([]string{"password"}))...)
}

func resolveImportID(ctx *stackctx.Context, name string, cfg config.RedisInventory, importID string) (string, error) {
	if importID != "" {
		return importID, nil
	}

	existing, err := tencentredis.FindInstancesByName(ctx.Runtime, ctx.Inventory.Region, name)
	if err != nil {
		return "", err
	}
	if len(existing) == 0 {
		return "", nil
	}
	if existing[0].Status == 1 {
		ids := make([]string, 0, len(existing))
		for _, instance := range existing {
			ids = append(ids, instance.ID)
		}
		return "", fmt.Errorf("redis instances named %q already exist but are still creating: %v", name, ids)
	}
	return existing[0].ID, nil
}
