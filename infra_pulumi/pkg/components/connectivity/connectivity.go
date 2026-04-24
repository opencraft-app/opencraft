package connectivity

import (
	"strings"

	"github.com/pulumi/pulumi/sdk/v3/go/pulumi"
	tencentcloud "github.com/tencentcloudstack/pulumi-tencentcloud/sdk/go/tencentcloud"
	"github.com/tencentcloudstack/pulumi-tencentcloud/sdk/go/tencentcloud/ccn"
	"github.com/tencentcloudstack/pulumi-tencentcloud/sdk/go/tencentcloud/clb"
	"github.com/tencentcloudstack/pulumi-tencentcloud/sdk/go/tencentcloud/route"
	"github.com/tencentcloudstack/pulumi-tencentcloud/sdk/go/tencentcloud/subnet"
	"github.com/tencentcloudstack/pulumi-tencentcloud/sdk/go/tencentcloud/vpc"

	"github.com/skipzhang/mono/infra_pulumi/pkg/naming"
	"github.com/skipzhang/mono/infra_pulumi/pkg/stackctx"
	"github.com/skipzhang/mono/infra_pulumi/pkg/tencenttke"
)

func Ensure(ctx *stackctx.Context) error {
	cfg := ctx.Inventory.Stacks.Connectivity
	if !cfg.Enabled {
		return nil
	}

	accessVpcName := strings.TrimSpace(cfg.AccessVPC.RouteTableName)
	if accessVpcName == "" {
		accessVpcName = naming.AccessRouteTableName(ctx.Inventory.EnvShort)
	}

	accessVPC, err := vpc.NewInstance(ctx.Pulumi, naming.StableResource("connectivity", "access-vpc"), &vpc.InstanceArgs{
		Name:        pulumi.StringPtr(naming.AccessVPCName(ctx.Inventory.EnvShort)),
		CidrBlock:   pulumi.String(cfg.AccessVPC.CIDR),
		IsMulticast: pulumi.BoolPtr(false),
	}, ctx.Options()...)
	if err != nil {
		return err
	}
	ctx.Derived.AccessVPCID = accessVPC.ID().ToStringOutput()

	accessRouteTable, err := route.NewTable(ctx.Pulumi, naming.StableResource("connectivity", "access-route-table"), &route.TableArgs{
		VpcId: accessVPC.ID().ToStringOutput(),
		Name:  pulumi.String(accessVpcName),
	}, ctx.Options()...)
	if err != nil {
		return err
	}
	ctx.Derived.AccessRouteTableID = accessRouteTable.ID().ToStringOutput()

	accessSubnet, err := subnet.NewInstance(ctx.Pulumi, naming.StableResource("connectivity", "access-subnet"), &subnet.InstanceArgs{
		Name:             pulumi.StringPtr(naming.AccessSubnetName(ctx.Inventory.EnvShort)),
		VpcId:            accessVPC.ID().ToStringOutput(),
		CidrBlock:        pulumi.String(cfg.AccessVPC.SubnetCIDR),
		AvailabilityZone: pulumi.String(cfg.AccessVPC.AvailabilityZone),
		RouteTableId:     accessRouteTable.ID().ToStringOutput(),
	}, ctx.Options()...)
	if err != nil {
		return err
	}
	ctx.Derived.AccessSubnetID = accessSubnet.ID().ToStringOutput()

	ccnName := strings.TrimSpace(cfg.CCN.Name)
	if ccnName == "" {
		ccnName = naming.ControlPlaneCCNName(ctx.Inventory.EnvShort)
	}
	ccnChargeType := strings.TrimSpace(cfg.CCN.ChargeType)
	if ccnChargeType == "" {
		ccnChargeType = "POSTPAID"
	}
	ccnBandwidthLimitType := strings.TrimSpace(cfg.CCN.BandwidthLimitType)
	if ccnBandwidthLimitType == "" {
		ccnBandwidthLimitType = "INTER_REGION_LIMIT"
	}
	ccnQos := strings.TrimSpace(cfg.CCN.Qos)
	if ccnQos == "" {
		ccnQos = "AG"
	}

	var controlPlaneCCNID pulumi.StringInput
	if existingID := strings.TrimSpace(cfg.CCN.ExistingID); existingID != "" {
		controlPlaneCCNID = pulumi.String(existingID)
	} else {
		controlPlaneCCN, err := ccn.NewInstance(ctx.Pulumi, naming.StableResource("connectivity", "ccn"), &ccn.InstanceArgs{
			Name:               pulumi.String(ccnName),
			Description:        pulumi.StringPtr(cfg.CCN.Description),
			ChargeType:         pulumi.StringPtr(ccnChargeType),
			BandwidthLimitType: pulumi.StringPtr(ccnBandwidthLimitType),
			Qos:                pulumi.StringPtr(ccnQos),
			RouteOverlapFlag:   pulumi.BoolPtr(true),
		}, ctx.Options()...)
		if err != nil {
			return err
		}
		controlPlaneCCNID = controlPlaneCCN.ID().ToStringOutput()
	}
	ctx.Derived.ControlPlaneCCNID = controlPlaneCCNID

	if _, err := ccn.NewAttachmentV2(ctx.Pulumi, naming.StableResource("connectivity", "ccn-attachment", "access-vpc"), &ccn.AttachmentV2Args{
		CcnId:          controlPlaneCCNID,
		InstanceId:     accessVPC.ID().ToStringOutput(),
		InstanceRegion: pulumi.String(ctx.Inventory.Region),
		InstanceType:   pulumi.String("VPC"),
		Description:    pulumi.StringPtr("Beijing access VPC attachment for Argo control-plane traffic"),
	}, ctx.Options(pulumi.DeleteBeforeReplace(true))...); err != nil {
		return err
	}

	if strings.TrimSpace(cfg.CCN.ExistingID) == "" {
		if _, err := ccn.NewAttachmentV2(ctx.Pulumi, naming.StableResource("connectivity", "ccn-attachment", "remote-vpc"), &ccn.AttachmentV2Args{
			CcnId:          controlPlaneCCNID,
			InstanceId:     pulumi.String(cfg.CCN.RemoteVpcID),
			InstanceRegion: pulumi.String(cfg.CCN.RemoteRegion),
			InstanceType:   pulumi.String("VPC"),
			Description:    pulumi.StringPtr("Hong Kong Argo control-plane VPC attachment"),
		}, ctx.Options()...); err != nil {
			return err
		}
	}

	if _, err := route.NewTableEntry(ctx.Pulumi, naming.StableResource("connectivity", "access-route", "remote-vpc"), &route.TableEntryArgs{
		RouteTableId:         accessRouteTable.ID().ToStringOutput(),
		DestinationCidrBlock: pulumi.String(cfg.CCN.RemoteVpcCIDR),
		NextType:             pulumi.String("USER_CCN"),
		NextHub:              controlPlaneCCNID,
		Description:          pulumi.StringPtr("Route Hong Kong Argo VPC traffic via control-plane CCN"),
	}, ctx.Options()...); err != nil {
		return err
	}

	remoteProvider, err := tencentcloud.NewProvider(ctx.Pulumi, naming.StableResource("connectivity", "remote-provider"), &tencentcloud.ProviderArgs{
		Region: pulumi.StringPtr(cfg.CCN.RemoteRegion),
	})
	if err != nil {
		return err
	}
	if _, err := route.NewTableEntry(ctx.Pulumi, naming.StableResource("connectivity", "remote-route", "access-vpc"), &route.TableEntryArgs{
		RouteTableId:         pulumi.String(cfg.CCN.RemoteRouteTableID),
		DestinationCidrBlock: pulumi.String(cfg.AccessVPC.CIDR),
		NextType:             pulumi.String("USER_CCN"),
		NextHub:              controlPlaneCCNID,
		Description:          pulumi.StringPtr("Route Beijing access VPC traffic via control-plane CCN"),
	}, pulumi.Provider(remoteProvider)); err != nil {
		return err
	}

	if cfg.PrivateLink.Enabled {
		clusterID := ctx.Plan.TKE.ClusterID
		if strings.TrimSpace(clusterID) == "" {
			return nil
		}

		providerInstanceID := strings.TrimSpace(cfg.PrivateLink.ProviderServiceInstanceID)
		var providerInstanceIDInput pulumi.StringInput
		if providerInstanceID != "" {
			providerInstanceIDInput = pulumi.String(providerInstanceID)
		}
		listenerPort := cfg.PrivateLink.ProviderListenerPort
		if listenerPort == 0 {
			listenerPort = 443
		}
		targetPort := cfg.PrivateLink.ProviderTargetPort
		if targetPort == 0 {
			targetPort = 443
		}
		if providerInstanceID == "" {
			endpoints, err := tencenttke.GetClusterEndpoints(ctx.Runtime.SecretID, ctx.Runtime.SecretKey, ctx.Inventory.Region, clusterID)
			if err != nil {
				return err
			}
			if strings.TrimSpace(endpoints.IntranetEndpoint) == "" {
				return nil
			}

			providerCLB, err := clb.NewInstance(ctx.Pulumi, naming.StableResource("connectivity", "private-link", "provider-clb"), &clb.InstanceArgs{
				NetworkType: pulumi.String("INTERNAL"),
				ClbName:     pulumi.String(naming.ControlPlaneProviderCLBName(ctx.Inventory.EnvShort)),
				ProjectId:   pulumi.IntPtr(0),
				VpcId:       ctx.Derived.VPCID,
				SubnetId:    ctx.Derived.SupportSubnetID,
			}, ctx.Options()...)
			if err != nil {
				return err
			}
			ctx.Derived.ControlPlaneProviderCLBID = providerCLB.ID().ToStringOutput()
			providerInstanceIDInput = providerCLB.ID().ToStringOutput()

			listener, err := clb.NewListener(ctx.Pulumi, naming.StableResource("connectivity", "private-link", "listener"), &clb.ListenerArgs{
				ClbId:                   providerCLB.ID(),
				ListenerName:            pulumi.String("control-plane"),
				Port:                    pulumi.Int(listenerPort),
				Protocol:                pulumi.String("TCP"),
				TargetType:              pulumi.StringPtr("NODE"),
				HealthCheckSwitch:       pulumi.BoolPtr(true),
				HealthCheckType:         pulumi.StringPtr("TCP"),
				HealthCheckPort:         pulumi.IntPtr(targetPort),
				HealthCheckTimeOut:      pulumi.IntPtr(2),
				HealthCheckIntervalTime: pulumi.IntPtr(5),
				HealthCheckHealthNum:    pulumi.IntPtr(2),
				HealthCheckUnhealthNum:  pulumi.IntPtr(2),
				Scheduler:               pulumi.StringPtr("WRR"),
			}, ctx.Options()...)
			if err != nil {
				return err
			}
			if _, err := clb.NewAttachment(ctx.Pulumi, naming.StableResource("connectivity", "private-link", "listener-attachment"), &clb.AttachmentArgs{
				ClbId:      providerCLB.ID(),
				ListenerId: listener.ListenerId,
				Targets: clb.AttachmentTargetArray{
					&clb.AttachmentTargetArgs{
						EniIp:  pulumi.String(endpoints.IntranetEndpoint),
						Port:   pulumi.Int(targetPort),
						Weight: pulumi.Int(100),
					},
				},
			}, ctx.Options()...); err != nil {
				return err
			}

			ctx.Pulumi.Export("controlPlaneProviderClbId", providerCLB.ID())
			ctx.Pulumi.Export("controlPlaneProviderClbVip", providerCLB.Vip)
		}

		serviceName := strings.TrimSpace(cfg.PrivateLink.ProviderServiceName)
		if serviceName == "" {
			serviceName = naming.ControlPlanePrivateLinkServiceName(ctx.Inventory.EnvShort)
		}
		serviceType := strings.TrimSpace(cfg.PrivateLink.ProviderServiceType)
		if serviceType == "" {
			serviceType = "CLB"
		}
		endpointName := strings.TrimSpace(cfg.PrivateLink.ConsumerEndpointName)
		if endpointName == "" {
			endpointName = naming.ControlPlanePrivateLinkEndpointName(ctx.Inventory.EnvShort)
		}

		endpointService, err := vpc.NewEndPointService(ctx.Pulumi, naming.StableResource("connectivity", "private-link", "service"), &vpc.EndPointServiceArgs{
			VpcId:               ctx.Derived.VPCID,
			EndPointServiceName: pulumi.String(serviceName),
			AutoAcceptFlag:      pulumi.Bool(cfg.PrivateLink.AutoAccept),
			ServiceType:         pulumi.StringPtr(serviceType),
			ServiceInstanceId:   providerInstanceIDInput,
		}, ctx.Options()...)
		if err != nil {
			return err
		}
		ctx.Derived.ControlPlaneEndpointServiceID = endpointService.ID().ToStringOutput()

		endpointArgs := &vpc.EndPointArgs{
			VpcId:             accessVPC.ID().ToStringOutput(),
			SubnetId:          accessSubnet.ID().ToStringOutput(),
			EndPointName:      pulumi.String(endpointName),
			EndPointServiceId: endpointService.ID().ToStringOutput(),
		}
		if vip := strings.TrimSpace(cfg.PrivateLink.ConsumerEndpointVIP); vip != "" {
			endpointArgs.EndPointVip = pulumi.StringPtr(vip)
		}
		if len(cfg.PrivateLink.ConsumerSecurityGroupIDs) > 0 {
			endpointArgs.SecurityGroupsIds = ctx.ResolveStringArray(cfg.PrivateLink.ConsumerSecurityGroupIDs)
		}

		endpoint, err := vpc.NewEndPoint(ctx.Pulumi, naming.StableResource("connectivity", "private-link", "endpoint"), endpointArgs, ctx.Options()...)
		if err != nil {
			return err
		}
		ctx.Derived.ControlPlaneEndpointID = endpoint.ID().ToStringOutput()

		ctx.Pulumi.Export("controlPlanePrivateLinkServiceId", endpointService.ID())
		ctx.Pulumi.Export("controlPlanePrivateLinkServiceVip", endpointService.ServiceVip)
		ctx.Pulumi.Export("controlPlanePrivateLinkEndpointId", endpoint.ID())
		ctx.Pulumi.Export("controlPlanePrivateLinkEndpointVip", endpoint.EndPointVip)
	}

	ctx.Pulumi.Export("controlPlaneAccessVpcId", accessVPC.ID())
	ctx.Pulumi.Export("controlPlaneAccessVpcCidr", pulumi.String(cfg.AccessVPC.CIDR))
	ctx.Pulumi.Export("controlPlaneAccessSubnetId", accessSubnet.ID())
	ctx.Pulumi.Export("controlPlaneAccessSubnetCidr", pulumi.String(cfg.AccessVPC.SubnetCIDR))
	ctx.Pulumi.Export("controlPlaneCCNId", controlPlaneCCNID)
	ctx.Pulumi.Export("controlPlaneRemoteRegion", pulumi.String(cfg.CCN.RemoteRegion))
	ctx.Pulumi.Export("controlPlaneRemoteVpcId", pulumi.String(cfg.CCN.RemoteVpcID))
	ctx.Pulumi.Export("controlPlaneRemoteVpcCidr", pulumi.String(cfg.CCN.RemoteVpcCIDR))

	return nil
}
