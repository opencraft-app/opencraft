package networking

import (
	"fmt"
	"sort"

	"github.com/pulumi/pulumi/sdk/v3/go/pulumi"
	"github.com/tencentcloudstack/pulumi-tencentcloud/sdk/go/tencentcloud/eip"
	"github.com/tencentcloudstack/pulumi-tencentcloud/sdk/go/tencentcloud/nat"
	"github.com/tencentcloudstack/pulumi-tencentcloud/sdk/go/tencentcloud/route"
	"github.com/tencentcloudstack/pulumi-tencentcloud/sdk/go/tencentcloud/subnet"
	"github.com/tencentcloudstack/pulumi-tencentcloud/sdk/go/tencentcloud/vpc"

	"github.com/skipzhang/mono/infra_pulumi/pkg/naming"
	"github.com/skipzhang/mono/infra_pulumi/pkg/networklayout"
	"github.com/skipzhang/mono/infra_pulumi/pkg/pulumiutil"
	"github.com/skipzhang/mono/infra_pulumi/pkg/stackctx"
)

func Ensure(ctx *stackctx.Context) error {
	inv := ctx.Inventory.Stacks.Networking
	vpcResource, err := vpc.NewInstance(ctx.Pulumi, naming.StableResource("networking", "vpc"), &vpc.InstanceArgs{
		Name:        pulumi.StringPtr(naming.VPCName(ctx.Inventory.EnvShort)),
		CidrBlock:   pulumi.String(ctx.Inventory.Network.VpcCIDR),
		IsMulticast: pulumi.BoolPtr(false),
	}, ctx.OptionsWithImport(ctx.Plan.Networking.VpcID, pulumi.IgnoreChanges([]string{"dnsServers", "isMulticast", "tags", "assistantCidrs"}))...)
	if err != nil {
		return err
	}
	ctx.Derived.VPCID = vpcResource.ID().ToStringOutput()

	primaryEIPs := make(map[string]*eip.Instance, len(inv.PrimaryEIPs))
	for _, key := range sortedKeys(inv.PrimaryEIPs) {
		cfg := inv.PrimaryEIPs[key]
		res, err := eip.NewInstance(ctx.Pulumi, naming.StableResource("networking", "eip", key), &eip.InstanceArgs{
			Name:                    pulumi.StringPtr(key),
			InternetChargeType:      pulumi.String("TRAFFIC_POSTPAID_BY_HOUR"),
			InternetMaxBandwidthOut: pulumi.Int(cfg.Bandwidth),
			Type:                    pulumi.StringPtr("EIP"),
		}, ctx.OptionsWithImport(ctx.Plan.Networking.PrimaryEIPs[key], pulumi.IgnoreChanges([]string{"name"}))...)
		if err != nil {
			return err
		}
		primaryEIPs[key] = res
	}

	secondaryEIPs := make(map[string]*eip.Instance, len(inv.SecondaryEIPs))
	for _, key := range sortedKeys(inv.SecondaryEIPs) {
		cfg := inv.SecondaryEIPs[key]
		res, err := eip.NewInstance(ctx.Pulumi, naming.StableResource("networking", "eip", key), &eip.InstanceArgs{
			Name:                    pulumi.StringPtr(key),
			InternetChargeType:      pulumi.String("TRAFFIC_POSTPAID_BY_HOUR"),
			InternetMaxBandwidthOut: pulumi.Int(cfg.Bandwidth),
			Type:                    pulumi.StringPtr("EIP"),
		}, ctx.OptionsWithImport(ctx.Plan.Networking.SecondaryEIPs[key], pulumi.IgnoreChanges([]string{"name"}))...)
		if err != nil {
			return err
		}
		secondaryEIPs[key] = res
	}

	primaryNAT, err := nat.NewGateway(ctx.Pulumi, naming.StableResource("networking", "nat", "primary"), &nat.GatewayArgs{
		Name:                               pulumi.String(inv.PrimaryNATGatewayName),
		VpcId:                              vpcResource.ID().ToStringOutput(),
		NatProductVersion:                  pulumi.IntPtr(2),
		AssignedEipSets:                    natPublicIPs(ctx, inv.PrimaryNATPublicIPs, primaryEIPs),
		StockPublicIpAddressesBandwidthOut: pulumi.IntPtr(200),
	}, ctx.ImportOption(ctx.Plan.Networking.PrimaryNATID)...)
	if err != nil {
		return err
	}

	_, err = nat.NewGateway(ctx.Pulumi, naming.StableResource("networking", "nat", "secondary"), &nat.GatewayArgs{
		Name:                               pulumi.String(inv.SecondaryNATGatewayName),
		VpcId:                              vpcResource.ID().ToStringOutput(),
		NatProductVersion:                  pulumi.IntPtr(2),
		AssignedEipSets:                    natPublicIPs(ctx, inv.SecondaryNATPublicIPs, secondaryEIPs),
		StockPublicIpAddressesBandwidthOut: pulumi.IntPtr(200),
	}, ctx.ImportOption(ctx.Plan.Networking.SecondaryNATID)...)
	if err != nil {
		return err
	}

	routeTable, err := route.NewTable(ctx.Pulumi, naming.StableResource("networking", "route-table"), &route.TableArgs{
		VpcId: vpcResource.ID().ToStringOutput(),
		Name:  pulumi.String(inv.RouteTableName),
	}, ctx.ImportOption(ctx.Plan.Networking.RouteTableID)...)
	if err != nil {
		return err
	}

	if _, err := route.NewTableEntry(ctx.Pulumi, naming.StableResource("networking", "route-entry", "default-nat"), &route.TableEntryArgs{
		RouteTableId:         routeTable.ID(),
		DestinationCidrBlock: pulumi.String("0.0.0.0/0"),
		NextType:             pulumi.String("NAT"),
		NextHub:              primaryNAT.ID().ToStringOutput(),
		Description:          pulumi.StringPtr("claw-default-egress-nat"),
		Disabled:             pulumi.BoolPtr(false),
	}, ctx.ImportOption(ctx.Plan.Networking.RouteEntryID)...); err != nil {
		return err
	}

	subnetResources := make(map[string]*subnet.Instance, len(inv.SNATSubnets))
	orderedSubnetKeys := subnetOrder(ctx)
	subnetIDs := make(pulumi.StringMap, len(orderedSubnetKeys))
	subnetZones := make(pulumi.StringMap, len(orderedSubnetKeys))
	subnetCIDRs := make(pulumi.StringMap, len(orderedSubnetKeys))
	plannedSubnetCIDRs := make(pulumi.StringMap, len(orderedSubnetKeys))
	for _, subnetKey := range orderedSubnetKeys {
		cfg := inv.SNATSubnets[subnetKey]
		resourceSuffix := importedSuffix(subnetKey, ctx.Plan.Networking.Subnets[subnetKey])
		plannedSubnetCIDR, err := subnetCIDRForKey(ctx, subnetKey, orderedSubnetKeys)
		if err != nil {
			return err
		}
		actualSubnetCIDR, err := actualSubnetCIDRInput(ctx, subnetKey, resourceSuffix, plannedSubnetCIDR)
		if err != nil {
			return err
		}
		res, err := subnet.NewInstance(ctx.Pulumi, naming.StableResource("networking", "subnet", resourceSuffix), &subnet.InstanceArgs{
			Name:             pulumi.StringPtr(fmt.Sprintf("%s-%s", ctx.Inventory.EnvShort, subnetKey)),
			VpcId:            vpcResource.ID().ToStringOutput(),
			CidrBlock:        actualSubnetCIDR,
			AvailabilityZone: pulumi.String(cfg.AvailabilityZone),
			RouteTableId:     routeTable.ID().ToStringOutput(),
		}, ctx.OptionsWithImport(ctx.Plan.Networking.Subnets[subnetKey], pulumi.IgnoreChanges([]string{"tags", "isMulticast"}))...)
		if err != nil {
			return err
		}
		subnetResources[subnetKey] = res
		subnetIDs[subnetKey] = res.ID().ToStringOutput()
		subnetZones[subnetKey] = res.AvailabilityZone
		subnetCIDRs[subnetKey] = res.CidrBlock
		plannedSubnetCIDRs[subnetKey] = pulumi.String(plannedSubnetCIDR)
		if subnetKey == ctx.Inventory.Network.SupportSubnetKey {
			ctx.Derived.SupportSubnetID = res.ID().ToStringOutput()
		}
	}

	for _, subnetKey := range orderedSubnetKeys {
		cfg := inv.SNATSubnets[subnetKey]
		subnetResource := subnetResources[subnetKey]
		resourceSuffix := importedSuffix(subnetKey, ctx.Plan.Networking.Subnets[subnetKey])
		adoptImportID := resolvedSNATImportID(ctx, subnetKey)
		if _, err := nat.NewGatewaySnat(ctx.Pulumi, naming.StableResource("networking", "snat", resourceSuffix), &nat.GatewaySnatArgs{
			NatGatewayId:    primaryNAT.ID().ToStringOutput(),
			ResourceType:    pulumi.String("SUBNET"),
			SubnetId:        subnetResource.ID().ToStringOutput().ToStringPtrOutput(),
			SubnetCidrBlock: subnetResource.CidrBlock.ToStringPtrOutput(),
			Description:     pulumi.String(cfg.Description),
			PublicIpAddrs:   snatPublicIPs(ctx, inv.PrimaryNATPublicIPs, primaryEIPs, primaryNAT.AssignedEipSets, adoptImportID != ""),
		}, snatOptions(ctx, subnetKey)...); err != nil {
			return err
		}
	}
	ctx.Derived.NetworkSubnetIDs = subnetIDs.ToStringMapOutput()

	supportSubnetPlannedCIDR := plannedSubnetCIDRs[ctx.Inventory.Network.SupportSubnetKey]
	supportSubnetActualCIDR := subnetResources[ctx.Inventory.Network.SupportSubnetKey].CidrBlock
	supportSubnetPlannedAddressCount := supportSubnetPlannedCIDR.ToStringOutput().ApplyT(func(cidr string) (int, error) {
		return networklayout.CIDRAddressCount(cidr)
	}).(pulumi.IntOutput)
	supportSubnetActualAddressCount := supportSubnetActualCIDR.ApplyT(func(cidr string) (int, error) {
		return networklayout.CIDRAddressCount(cidr)
	}).(pulumi.IntOutput)
	supportSubnetPolicySatisfied := supportSubnetActualAddressCount.ApplyT(func(count int) bool {
		return count >= networklayout.MinSupportSubnetIPs
	}).(pulumi.BoolOutput)

	ctx.Pulumi.Export("vpcId", vpcResource.ID())
	ctx.Pulumi.Export("supportSubnetId", ctx.Derived.SupportSubnetID)
	ctx.Pulumi.Export("supportSubnetPlannedCidr", supportSubnetPlannedCIDR)
	ctx.Pulumi.Export("supportSubnetActualCidr", supportSubnetActualCIDR)
	ctx.Pulumi.Export("supportSubnetPlannedAddressCount", supportSubnetPlannedAddressCount)
	ctx.Pulumi.Export("supportSubnetActualAddressCount", supportSubnetActualAddressCount)
	ctx.Pulumi.Export("supportSubnetMinAddressCount", pulumi.Int(networklayout.MinSupportSubnetIPs))
	ctx.Pulumi.Export("supportSubnetPolicySatisfied", supportSubnetPolicySatisfied)
	ctx.Pulumi.Export("networkSubnetIds", subnetIDs)
	ctx.Pulumi.Export("networkSubnetZones", subnetZones)
	ctx.Pulumi.Export("networkSubnetCidrs", subnetCIDRs)
	ctx.Pulumi.Export("networkPlannedSubnetCidrs", plannedSubnetCIDRs)
	return nil
}

func sortedKeys[T any](m map[string]T) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

func natPublicIPs(ctx *stackctx.Context, configured []string, instances map[string]*eip.Instance) pulumi.StringArrayInput {
	if len(configured) > 0 {
		return pulumiutil.StringArray(configured)
	}
	return eipPublicIPs(instances)
}

func eipPublicIPs(instances map[string]*eip.Instance) pulumi.StringArray {
	publicIPs := make(pulumi.StringArray, 0, len(instances))
	for _, key := range sortedKeys(instances) {
		publicIPs = append(publicIPs, instances[key].PublicIp)
	}
	return publicIPs
}

func snatPublicIPs(ctx *stackctx.Context, configured []string, instances map[string]*eip.Instance, imported pulumi.StringArrayOutput, adopt bool) pulumi.StringArrayInput {
	if ctx.Runtime.EnableImport || adopt {
		return imported
	}

	if len(configured) > 0 {
		publicIPs := configured
		if len(publicIPs) > 5 {
			publicIPs = publicIPs[:5]
		}
		return pulumiutil.StringArray(publicIPs)
	}

	keys := sortedKeys(instances)
	if len(keys) > 5 {
		keys = keys[:5]
	}
	publicIPs := make(pulumi.StringArray, 0, len(keys))
	for _, key := range keys {
		publicIPs = append(publicIPs, instances[key].PublicIp)
	}
	return publicIPs
}

func importedSuffix(defaultKey, importID string) string {
	if importID != "" {
		return importID
	}
	return defaultKey
}

func subnetOrder(ctx *stackctx.Context) []string {
	keys := make([]string, 0, len(ctx.Inventory.Network.SandboxPoolSubnetKeys))
	keys = append(keys, ctx.Inventory.Network.SandboxPoolSubnetKeys...)
	supportKey := ctx.Inventory.Network.SupportSubnetKey
	seenSupport := false
	for _, key := range keys {
		if key == supportKey {
			seenSupport = true
			break
		}
	}
	if !seenSupport && supportKey != "" {
		keys = append(keys, supportKey)
	}
	return keys
}

func subnetCIDRForKey(ctx *stackctx.Context, subnetKey string, orderedKeys []string) (string, error) {
	if subnetKey == ctx.Inventory.Network.SupportSubnetKey {
		return networklayout.SupportSubnetCIDR(ctx.Inventory.Network.VpcCIDR)
	}

	poolIndex := 0
	for _, key := range orderedKeys {
		if key == ctx.Inventory.Network.SupportSubnetKey {
			continue
		}
		if key == subnetKey {
			return networklayout.PoolSubnetCIDR(ctx.Inventory.Network.VpcCIDR, poolIndex)
		}
		poolIndex++
	}
	return "", fmt.Errorf("subnet key %q not found in layout", subnetKey)
}

func actualSubnetCIDRInput(ctx *stackctx.Context, subnetKey, resourceSuffix, plannedCIDR string) (pulumi.StringInput, error) {
	importID := ctx.Plan.Networking.Subnets[subnetKey]
	if !ctx.Runtime.EnableImport || importID == "" {
		return pulumi.String(plannedCIDR), nil
	}

	existing, err := subnet.GetInstance(
		ctx.Pulumi,
		naming.StableResource("networking", "subnet-lookup", resourceSuffix),
		pulumi.ID(importID),
		nil,
		ctx.Options()...,
	)
	if err != nil {
		return nil, fmt.Errorf("read imported subnet %s: %w", subnetKey, err)
	}
	return existing.CidrBlock, nil
}

func snatOptions(ctx *stackctx.Context, subnetKey string) []pulumi.ResourceOption {
	if importID := resolvedSNATImportID(ctx, subnetKey); importID != "" {
		return ctx.OptionsWithAdopt(importID, pulumi.IgnoreChanges([]string{"publicIpAddrs"}))
	}
	return ctx.Options(pulumi.IgnoreChanges([]string{"publicIpAddrs"}))
}

func resolvedSNATImportID(ctx *stackctx.Context, subnetKey string) string {
	subnetID := ctx.Plan.Networking.Subnets[subnetKey]
	if ctx.Plan.Networking.PrimaryNATID != "" && subnetID != "" {
		return ctx.Plan.Networking.PrimaryNATID + "#" + subnetID
	}
	return ctx.Runtime.Reconcile.SNATImports[subnetKey]
}
