package cynosdb

import (
	"github.com/pulumi/pulumi/sdk/v3/go/pulumi"
	"github.com/tencentcloudstack/pulumi-tencentcloud/sdk/go/tencentcloud/cynosdb"
	"github.com/tencentcloudstack/pulumi-tencentcloud/sdk/go/tencentcloud/security"

	"github.com/skipzhang/mono/infra_pulumi/pkg/components/securitygroup"
	"github.com/skipzhang/mono/infra_pulumi/pkg/config"
	"github.com/skipzhang/mono/infra_pulumi/pkg/naming"
	"github.com/skipzhang/mono/infra_pulumi/pkg/pulumiutil"
	"github.com/skipzhang/mono/infra_pulumi/pkg/stackctx"
)

func Ensure(ctx *stackctx.Context) error {
	inv := ctx.Inventory
	cfg := inv.Stacks.Cynosdb
	clusterName := naming.CynosdbClusterName(inv.EnvShort)

	group, err := security.NewGroup(ctx.Pulumi, naming.StableResource("cynosdb", "sg"), &security.GroupArgs{
		Name:        pulumi.StringPtr(clusterName + "-sg"),
		Description: pulumi.StringPtr("Security group for " + clusterName),
	}, ctx.ImportOption(ctx.Plan.Cynosdb.SecurityGroupID)...)
	if err != nil {
		return err
	}

	sgInventory := config.SecurityGroupInventory{
		Ingress: []string{
			"ACCEPT#" + inv.Network.VpcCIDR + "#3306#TCP",
			"ACCEPT#" + cfg.ClusterCIDR + "#3306#TCP",
		},
		Egress: []string{
			"ACCEPT#0.0.0.0/0#ALL#ALL",
		},
	}
	_, err = security.NewGroupRuleSet(ctx.Pulumi, naming.StableResource("cynosdb", "sg-rules"), &security.GroupRuleSetArgs{
		SecurityGroupId: group.ID().ToStringOutput(),
		Ingresses:       securitygroup.ToIngressArray(sgInventory.Ingress),
		Egresses:        securitygroup.ToEgressArray(sgInventory.Egress),
	}, ctx.ImportOption(ctx.Plan.Cynosdb.SecurityGroupID)...)
	if err != nil {
		return err
	}

	cluster, err := cynosdb.NewCluster(ctx.Pulumi, naming.StableResource("cynosdb", "cluster"), &cynosdb.ClusterArgs{
		AvailableZone:      pulumi.String(cfg.AvailabilityZone),
		VpcId:              ctx.ResolveString(stackctx.RefVPCID),
		SubnetId:           ctx.ResolveString(cfg.SubnetID),
		DbMode:             pulumi.StringPtr("NORMAL"),
		DbType:             pulumi.String("MYSQL"),
		DbVersion:          pulumi.String(cfg.DBVersion),
		Port:               pulumi.IntPtr(3306),
		StorageLimit:       pulumi.IntPtr(cfg.StorageLimit),
		ClusterName:        pulumi.String(clusterName),
		Password:           ctx.Runtime.DBPassword,
		InstanceCpuCore:    pulumi.IntPtr(cfg.InstanceCPUCore),
		InstanceMemorySize: pulumi.IntPtr(cfg.InstanceMemorySize),
		ChargeType:         pulumi.StringPtr("POSTPAID_BY_HOUR"),
		StoragePayMode:     pulumi.IntPtr(0),
		ForceDelete:        pulumi.BoolPtr(false),
		RwGroupSgs:         pulumi.StringArray{group.ID().ToStringOutput()},
		RoGroupSgs:         pulumi.StringArray{group.ID().ToStringOutput()},
		ParamItems: cynosdb.ClusterParamItemArray{
			&cynosdb.ClusterParamItemArgs{
				Name:         pulumi.String("character_set_server"),
				CurrentValue: pulumi.String("utf8mb4"),
			},
		},
	}, ctx.OptionsWithImport(ctx.Plan.Cynosdb.ClusterID, pulumi.IgnoreChanges([]string{"paramItems", "storageLimit"}))...)
	if err != nil {
		return err
	}

	primaryAddr := cluster.RwGroupAddrs.Index(pulumi.Int(0))
	ctx.Pulumi.Export("cynosdbClusterId", cluster.ID())
	ctx.Pulumi.Export("cynosdbPrimaryHost", primaryAddr.Ip())
	ctx.Pulumi.Export("cynosdbPrimaryPort", primaryAddr.Port())
	ctx.Pulumi.Export("cynosdbPrimaryAddr", pulumiutil.NullableHostPort(primaryAddr.Ip(), primaryAddr.Port()))
	return nil
}
