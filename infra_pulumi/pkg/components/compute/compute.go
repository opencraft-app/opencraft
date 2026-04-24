package compute

import (
	"strings"

	"github.com/pulumi/pulumi/sdk/v3/go/pulumi"
	tcimage "github.com/tencentcloudstack/pulumi-tencentcloud/sdk/go/tencentcloud/image"
	"github.com/tencentcloudstack/pulumi-tencentcloud/sdk/go/tencentcloud/instance"

	"github.com/skipzhang/mono/infra_pulumi/pkg/naming"
	"github.com/skipzhang/mono/infra_pulumi/pkg/stackctx"
)

func Ensure(ctx *stackctx.Context) error {
	cfg := ctx.Inventory.Stacks.Compute.Jumpserver
	instanceName := naming.JumpserverName(ctx.Inventory.EnvShort)
	imageID := resolveJumpserverImageID(ctx, cfg.ImageID)
	_, err := instance.NewInstance(ctx.Pulumi, naming.StableResource("compute", "jumpserver"), &instance.InstanceArgs{
		AvailabilityZone:        pulumi.String(cfg.AvailabilityZone),
		InstanceName:            pulumi.String(instanceName),
		InstanceType:            pulumi.String(cfg.InstanceType),
		ImageId:                 imageID,
		InstanceChargeType:      pulumi.String(cfg.InstanceChargeType),
		SystemDiskType:          pulumi.String(cfg.SystemDiskType),
		SystemDiskSize:          pulumi.Int(cfg.SystemDiskSize),
		VpcId:                   ctx.ResolveString(stackctx.RefVPCID),
		SubnetId:                ctx.ResolveString(cfg.SubnetID),
		OrderlySecurityGroups:   ctx.ResolveStringArray(cfg.SecurityGroups),
		InternetMaxBandwidthOut: pulumi.Int(0),
		AllocatePublicIp:        pulumi.Bool(false),
		UserDataRaw:             pulumi.StringPtr(cfg.UserDataRaw),
	}, ctx.OptionsWithImport(ctx.Plan.Compute.JumpserverID,
		pulumi.IgnoreChanges([]string{"userDataRaw", "disableAutomationService", "disableMonitorService", "disableSecurityService", "forceDelete", "userDataReplaceOnChange"}),
	)...)
	ctx.Pulumi.Export("jumpserverImageId", imageID)
	return err
}

func resolveJumpserverImageID(ctx *stackctx.Context, configured string) pulumi.StringInput {
	configured = strings.TrimSpace(configured)
	if configured != "" && !strings.Contains(configured, "REPLACE") {
		return pulumi.String(configured)
	}

	result := tcimage.LookupInstanceOutput(ctx.Pulumi, tcimage.LookupInstanceOutputArgs{
		Filters: tcimage.GetInstanceFilterArray{
			tcimage.GetInstanceFilterArgs{
				Name:   pulumi.String("image-type"),
				Values: pulumi.StringArray{pulumi.String("PUBLIC_IMAGE")},
			},
		},
		ImageNameRegex: pulumi.StringPtr("(?i)^ubuntu.*24"),
	}, pulumi.Provider(ctx.Provider))
	ctx.Pulumi.Export("jumpserverImageName", result.ImageName())
	return result.ImageId()
}
