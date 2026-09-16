package pulsar

import (
	"fmt"
	"strconv"

	"github.com/pulumi/pulumi/sdk/v3/go/pulumi"
	"github.com/tencentcloudstack/pulumi-tencentcloud/sdk/go/tencentcloud/tdmq"

	"github.com/skipzhang/mono/infra_pulumi/pkg/config"
	"github.com/skipzhang/mono/infra_pulumi/pkg/stackctx"
)

func Ensure(ctx *stackctx.Context) error {
	inv := ctx.Inventory.Stacks.Pulsar
	if !inv.Enabled {
		return nil
	}
	protect := pulumi.Protect(true)
	clusterID, managedCluster, err := ensureCluster(ctx, inv, protect)
	if err != nil {
		return err
	}
	namespaceOptions := []pulumi.ResourceOption{protect}
	if managedCluster != nil {
		namespaceOptions = append(namespaceOptions, pulumi.DependsOn([]pulumi.Resource{managedCluster}))
	}
	namespace, err := tdmq.NewNamespace(ctx.Pulumi, "referral-pulsar-namespace", &tdmq.NamespaceArgs{
		ClusterId:   clusterID,
		EnvironName: pulumi.String(inv.Namespace),
		MsgTtl:      pulumi.Int(inv.MessageTTLSeconds),
		RetentionPolicy: &tdmq.NamespaceRetentionPolicyArgs{
			TimeInMinutes: pulumi.Int(inv.RetentionMinutes),
			SizeInMb:      pulumi.Int(inv.RetentionSizeMB),
		},
		Remark: pulumi.String("LightVela referral domain events"),
	}, ctx.Options(namespaceOptions...)...)
	if err != nil {
		return err
	}
	dlq, err := tdmq.NewTopic(ctx.Pulumi, "referral-pulsar-dlq-topic", &tdmq.TopicArgs{
		ClusterId:       clusterID,
		EnvironId:       namespace.EnvironName,
		TopicName:       pulumi.String(inv.DeadLetterTopic),
		Partitions:      pulumi.Int(0),
		PulsarTopicType: pulumi.IntPtr(2),
		Remark:          pulumi.String("Dead-letter events for LightVela referral processing"),
	}, ctx.Options(protect, pulumi.DependsOn([]pulumi.Resource{namespace}))...)
	if err != nil {
		return err
	}

	topic, err := tdmq.NewTopic(ctx.Pulumi, "referral-pulsar-topic", &tdmq.TopicArgs{
		ClusterId:       clusterID,
		EnvironId:       namespace.EnvironName,
		TopicName:       pulumi.String(inv.Topic),
		Partitions:      pulumi.Int(0),
		PulsarTopicType: pulumi.IntPtr(2),
		Remark:          pulumi.String("Versioned LightVela referral events"),
	}, ctx.Options(protect, pulumi.DependsOn([]pulumi.Resource{namespace}))...)
	if err != nil {
		return err
	}

	type roleSpec struct {
		resourceName string
		roleName     string
		permissions  []string
	}
	roles := []roleSpec{
		{resourceName: "referral-user-auth-producer", roleName: inv.UserAuthProducerRole, permissions: []string{"produce"}},
		{resourceName: "referral-ctl-producer", roleName: inv.CTLProducerRole, permissions: []string{"produce"}},
		{resourceName: "referral-consumer", roleName: inv.ReferralConsumerRole, permissions: []string{"consume", "produce"}},
	}
	for _, spec := range roles {
		role, roleErr := tdmq.NewRole(ctx.Pulumi, spec.resourceName+"-role", &tdmq.RoleArgs{
			ClusterId: clusterID,
			RoleName:  pulumi.String(spec.roleName),
			Remark:    pulumi.String("LightVela referral event role"),
		}, ctx.Options(protect)...)
		if roleErr != nil {
			return roleErr
		}
		permissions := make(pulumi.StringArray, 0, len(spec.permissions))
		for _, permission := range spec.permissions {
			permissions = append(permissions, pulumi.String(permission))
		}
		if _, attachmentErr := tdmq.NewNamespaceRoleAttachment(ctx.Pulumi, spec.resourceName+"-permission", &tdmq.NamespaceRoleAttachmentArgs{
			ClusterId:   clusterID,
			EnvironId:   namespace.EnvironName,
			RoleName:    role.RoleName,
			Permissions: permissions,
		}, ctx.Options(protect, pulumi.DependsOn([]pulumi.Resource{namespace, role}))...); attachmentErr != nil {
			return attachmentErr
		}
	}

	ctx.Pulumi.Export("pulsarClusterID", clusterID)
	ctx.Pulumi.Export("pulsarNamespace", namespace.EnvironName)
	ctx.Pulumi.Export("pulsarReferralTopic", topic.TopicName)
	ctx.Pulumi.Export("pulsarReferralDeadLetterTopic", dlq.TopicName)
	return nil
}

func ensureCluster(ctx *stackctx.Context, inv config.PulsarInventory, protect pulumi.ResourceOption) (pulumi.StringInput, pulumi.Resource, error) {
	if !inv.ManageCluster {
		detail, err := tdmq.GetProInstanceDetail(ctx.Pulumi, &tdmq.GetProInstanceDetailArgs{
			ClusterId: inv.ExistingClusterID,
		}, pulumi.Provider(ctx.Provider))
		if err != nil {
			return nil, nil, fmt.Errorf("read existing Pulsar cluster: %w", err)
		}
		if err := validateExistingCluster(inv, detail); err != nil {
			return nil, nil, err
		}
		return pulumi.String(inv.ExistingClusterID), nil, nil
	}

	zones := make(pulumi.IntArray, 0, len(inv.ExpectedZoneIDs))
	for _, zoneID := range inv.ExpectedZoneIDs {
		zones = append(zones, pulumi.Int(zoneID))
	}
	tags := make(pulumi.StringMap, len(inv.Tags))
	for key, value := range inv.Tags {
		tags[key] = pulumi.String(value)
	}
	cluster, err := tdmq.NewProfessionalCluster(ctx.Pulumi, "referral-pulsar-cluster", &tdmq.ProfessionalClusterArgs{
		AutoRenewFlag: pulumi.Int(inv.AutoRenewFlag),
		AutoVoucher:   pulumi.IntPtr(inv.AutoVoucher),
		ClusterName:   pulumi.String(inv.ExpectedClusterName),
		ProductName:   pulumi.String(inv.ExpectedProductName),
		StorageSize:   pulumi.Int(inv.StorageSizeGB),
		TimeSpan:      pulumi.IntPtr(inv.PurchaseMonths),
		ZoneIds:       zones,
		Vpc: &tdmq.ProfessionalClusterVpcArgs{
			VpcId:    pulumi.String(inv.ExpectedVPCID),
			SubnetId: pulumi.String(inv.ExpectedSubnetID),
		},
		Tags: tags,
	}, ctx.Options(protect, pulumi.IgnoreChanges([]string{"storageSize"}))...)
	if err != nil {
		return nil, nil, fmt.Errorf("create managed Pulsar cluster: %w", err)
	}
	return cluster.ID().ToStringOutput(), cluster, nil
}

func validateExistingCluster(inv config.PulsarInventory, detail *tdmq.GetProInstanceDetailResult) error {
	if detail == nil || len(detail.ClusterInfos) != 1 || len(detail.ClusterSpecInfos) != 1 {
		return fmt.Errorf("existing Pulsar cluster detail is incomplete")
	}
	cluster := detail.ClusterInfos[0]
	if cluster.ClusterId != inv.ExistingClusterID || cluster.ClusterName != inv.ExpectedClusterName || cluster.Status != 1 {
		return fmt.Errorf("existing Pulsar cluster identity/status does not match inventory")
	}
	if detail.ClusterSpecInfos[0].SpecName != inv.ExpectedProductName {
		return fmt.Errorf("existing Pulsar cluster product does not match inventory")
	}
	zones := make(map[int]struct{}, len(cluster.NodeDistributions))
	for _, distribution := range cluster.NodeDistributions {
		zoneID, err := strconv.Atoi(distribution.ZoneId)
		if err == nil {
			zones[zoneID] = struct{}{}
		}
	}
	for _, expectedZone := range inv.ExpectedZoneIDs {
		if _, ok := zones[expectedZone]; !ok {
			return fmt.Errorf("existing Pulsar cluster is missing expected zone %d", expectedZone)
		}
	}
	for _, point := range detail.NetworkAccessPointInfos {
		if point.VpcId == inv.ExpectedVPCID && point.SubnetId == inv.ExpectedSubnetID && point.Endpoint == inv.BrokerURL {
			return nil
		}
	}
	return fmt.Errorf("existing Pulsar cluster network access point does not match inventory")
}
