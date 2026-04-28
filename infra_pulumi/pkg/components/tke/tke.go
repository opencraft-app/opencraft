package tke

import (
	"encoding/json"
	"fmt"
	"strconv"
	"strings"

	"github.com/pulumi/pulumi/sdk/v3/go/pulumi"
	"github.com/tencentcloudstack/pulumi-tencentcloud/sdk/go/tencentcloud/kubernetes"
	"github.com/tencentcloudstack/pulumi-tencentcloud/sdk/go/tencentcloud/security"

	"github.com/skipzhang/mono/infra_pulumi/pkg/components/securitygroup"
	"github.com/skipzhang/mono/infra_pulumi/pkg/naming"
	"github.com/skipzhang/mono/infra_pulumi/pkg/stackctx"
)

func Ensure(ctx *stackctx.Context) error {
	inv := ctx.Inventory
	tke := inv.Stacks.TKE
	clusterName := strings.TrimSpace(tke.ClusterName)
	if clusterName == "" {
		clusterName = naming.ClusterName(inv.EnvShort)
	}
	nodePoolName := strings.TrimSpace(tke.NodePoolName)
	if nodePoolName == "" {
		nodePoolName = naming.NodePoolName(inv.EnvShort)
	}
	networkType := strings.TrimSpace(tke.NetworkType)
	if networkType == "" {
		networkType = "VPC-CNI"
	}

	nodePoolGroup, err := security.NewGroup(ctx.Pulumi, naming.StableResource("tke", "node-pool-sg"), &security.GroupArgs{
		Name:        pulumi.StringPtr(clusterName + "-node-sg"),
		Description: pulumi.StringPtr("Security group for " + clusterName + " node pool"),
	}, ctx.ImportOption(ctx.Plan.TKE.NodePoolSecurityGroupID)...)
	if err != nil {
		return err
	}

	_, err = security.NewGroupRuleSet(ctx.Pulumi, naming.StableResource("tke", "node-pool-sg-rules"), &security.GroupRuleSetArgs{
		SecurityGroupId: nodePoolGroup.ID().ToStringOutput(),
		Ingresses:       nodePoolIngress(ctx),
		Egresses: security.GroupRuleSetEgressArray{
			&security.GroupRuleSetEgressArgs{
				Action:    pulumi.String("ACCEPT"),
				CidrBlock: pulumi.StringPtr("0.0.0.0/0"),
				Protocol:  pulumi.String("ALL"),
				Port:      pulumi.String("ALL"),
			},
		},
	}, ctx.ImportOption(ctx.Plan.TKE.NodePoolSecurityGroupID)...)
	if err != nil {
		return err
	}
	ctx.Derived.TKENodeSecurityGroupID = nodePoolGroup.ID().ToStringOutput()

	clusterArgs := &kubernetes.ClusterArgs{
		VpcId:             ctx.ResolveString(stackctx.RefVPCID),
		ClusterName:       pulumi.String(clusterName),
		NetworkType:       pulumi.StringPtr(networkType),
		ClusterSubnetId:   ctx.ResolveStringPtr(tke.SubnetID),
		ClusterVersion:    pulumi.StringPtr(tke.ClusterVersion),
		ClusterDeployType: pulumi.StringPtr("MANAGED_CLUSTER"),
		ContainerRuntime:  pulumi.StringPtr("containerd"),
		RuntimeVersion:    pulumi.StringPtr("1.6.9"),
		IsNonStaticIpMode: pulumi.BoolPtr(true),
	}
	if strings.EqualFold(networkType, "VPC-CNI") {
		clusterArgs.ServiceCidr = pulumi.StringPtr(tke.ServiceCIDR)
		clusterArgs.VpcCniType = pulumi.StringPtr(tke.VpcCniType)
		clusterArgs.EniSubnetIds = eniSubnetIDs(ctx, tke.EniSubnetKeys)
	} else {
		clusterArgs.ClusterCidr = pulumi.StringPtr(tke.ClusterCIDR)
	}

	cluster, err := kubernetes.NewCluster(ctx.Pulumi, naming.StableResource("tke", "cluster"), clusterArgs, ctx.OptionsWithImport(ctx.Plan.TKE.ClusterID, pulumi.IgnoreChanges([]string{
		"autoUpgradeClusterLevel",
		"clusterCidr",
		"clusterSubnetId",
		"eniSubnetIds",
		"isNonStaticIpMode",
		"logAgent",
		"networkType",
		"runtimeVersion",
		"serviceCidr",
		"vpcCniType",
	}))...)
	if err != nil {
		return err
	}

	clusterID := cluster.ID().ToStringOutput()
	if ctx.Runtime.EnableImport && ctx.Plan.TKE.ClusterID != "" {
		clusterID = pulumi.String(ctx.Plan.TKE.ClusterID).ToStringOutput()
	}
	reconcileClusterID := existingClusterID(ctx)
	nodePoolImportID, err := resolveNodePoolImportID(ctx, reconcileClusterID, nodePoolName, ctx.Plan.TKE.NodePoolID)
	if err != nil {
		return err
	}

	nodePool, err := kubernetes.NewNodePool(ctx.Pulumi, naming.StableResource("tke", "node-pool"), &kubernetes.NodePoolArgs{
		Name:               pulumi.StringPtr(nodePoolName),
		ClusterId:          clusterID,
		MaxSize:            pulumi.Int(tke.NodePoolMaxSize),
		MinSize:            pulumi.Int(tke.NodePoolMinSize),
		DesiredCapacity:    pulumi.IntPtr(tke.NodePoolDesiredCapacity),
		EnableAutoScale:    pulumi.BoolPtr(true),
		DeletionProtection: pulumi.BoolPtr(true),
		VpcId:              ctx.ResolveString(stackctx.RefVPCID),
		SubnetIds:          pulumi.StringArray{ctx.ResolveString(tke.SubnetID)},
		RetryPolicy:        pulumi.StringPtr("INCREMENTAL_INTERVALS"),
		DeleteKeepInstance: pulumi.BoolPtr(false),
		NodeOs:             pulumi.StringPtr(tke.WorkerImgID),
		Labels: pulumi.StringMap{
			"pool": pulumi.String(nodePoolName),
		},
		AutoScalingConfig: &kubernetes.NodePoolAutoScalingConfigArgs{
			InstanceType:            pulumi.String(tke.InstanceType),
			SystemDiskType:          pulumi.StringPtr("CLOUD_PREMIUM"),
			SystemDiskSize:          pulumi.IntPtr(50),
			OrderlySecurityGroupIds: pulumi.StringArray{nodePoolGroup.ID().ToStringOutput()},
			InternetChargeType:      pulumi.StringPtr("TRAFFIC_POSTPAID_BY_HOUR"),
			InternetMaxBandwidthOut: pulumi.IntPtr(0),
			PublicIpAssigned:        pulumi.BoolPtr(false),
			Password:                ctx.Runtime.NodePassword.ToStringPtrOutput(),
			EnhancedSecurityService: pulumi.BoolPtr(false),
			EnhancedMonitorService:  pulumi.BoolPtr(false),
		},
		NodeConfig: nodePoolNodeConfig(ctx),
	}, ctx.OptionsWithAdopt(nodePoolImportID, pulumi.IgnoreChanges([]string{
		"autoScalingConfig.password",
		"deleteKeepInstance",
		"nodeConfig",
	}))...)
	if err != nil {
		return err
	}

	if _, err := kubernetes.NewAddon(ctx.Pulumi, naming.StableResource("tke", "addon", "log-agent"), &kubernetes.AddonArgs{
		ClusterId:    clusterID,
		AddonName:    pulumi.String("tke-log-agent"),
		AddonVersion: pulumi.StringPtr("1.1.23"),
	}, ctx.OptionsWithImport(ctx.Plan.TKE.AddonID, pulumi.IgnoreChanges([]string{
		"addonVersion",
		"rawValues",
	}))...); err != nil {
		return err
	}

	tcrAddonImportID := ""
	if ctx.Runtime.EnableImport && existingClusterID(ctx) != "" {
		tcrAddonImportID = existingClusterID(ctx) + "#tcr"
	}
	if _, err := kubernetes.NewAddon(ctx.Pulumi, naming.StableResource("tke", "addon", "tcr"), &kubernetes.AddonArgs{
		ClusterId: clusterID,
		AddonName: pulumi.String("tcr"),
		RawValues: tcrAddonRawValues(ctx),
	}, ctx.OptionsWithAdopt(tcrAddonImportID, pulumi.IgnoreChanges([]string{
		"addonVersion",
		"rawValues",
	}))...); err != nil {
		return err
	}

	scaleWorker, err := kubernetes.NewScaleWorker(ctx.Pulumi, naming.StableResource("tke", "scale-worker"), &kubernetes.ScaleWorkerArgs{
		ClusterId:     clusterID,
		DesiredPodNum: scaleWorkerDesiredPodNum(ctx),
		WorkerConfig: &kubernetes.ScaleWorkerWorkerConfigArgs{
			AvailabilityZone:        pulumi.String(tke.AvailabilityZone),
			InstanceType:            pulumi.String(tke.InstanceType),
			SubnetId:                ctx.ResolveString(tke.SubnetID),
			SecurityGroupIds:        pulumi.StringArray{nodePoolGroup.ID().ToStringOutput()},
			ImgId:                   pulumi.StringPtr(tke.WorkerImgID),
			Password:                ctx.Runtime.NodePassword,
			EnhancedSecurityService: pulumi.Bool(false),
			EnhancedMonitorService:  pulumi.Bool(false),
		},
	}, ctx.OptionsWithImport(ctx.Plan.TKE.ScaleWorkerID, pulumi.IgnoreChanges([]string{"desiredPodNum", "workerConfig"}))...)
	if err != nil {
		return err
	}

	if !ctx.Runtime.EnableImport && tke.ClusterInternet {
		endpointArgs := &kubernetes.ClusterEndpointArgs{
			ClusterId:                    clusterID,
			ClusterInternet:              pulumi.BoolPtr(true),
			ClusterInternetSecurityGroup: nodePoolGroup.ID().ToStringOutput().ToStringPtrOutput(),
			ExtensiveParameters:          pulumi.StringPtr(clusterEndpointExtensiveParameters()),
		}
		_, err = kubernetes.NewClusterEndpoint(ctx.Pulumi, naming.StableResource("tke", "cluster-endpoint"), endpointArgs,
			ctx.Options(
				pulumi.DependsOn([]pulumi.Resource{nodePool, scaleWorker}),
				pulumi.IgnoreChanges([]string{
					"clusterInternetDomain",
					"clusterExternalEndpoint",
					"domain",
					"kubeConfig",
					"kubeConfigIntranet",
					"password",
					"userName",
				}),
			)...,
		)
		if err != nil {
			return err
		}
	}

	ctx.Pulumi.Export("tkeClusterId", cluster.ID())
	ctx.Pulumi.Export("tkeClusterName", pulumi.String(clusterName))
	ctx.Pulumi.Export("tkeNodePoolId", nodePool.ID())
	ctx.Pulumi.Export("tkeNodePoolName", pulumi.String(nodePoolName))
	return nil
}

func nodePoolNodeConfig(ctx *stackctx.Context) *kubernetes.NodePoolNodeConfigArgs {
	if !ctx.Runtime.EnableImport {
		return nil
	}
	return &kubernetes.NodePoolNodeConfigArgs{
		DesiredPodNum: pulumi.IntPtr(256),
	}
}

func scaleWorkerDesiredPodNum(ctx *stackctx.Context) pulumi.IntPtrInput {
	if !ctx.Runtime.EnableImport {
		return nil
	}
	return pulumi.IntPtr(256)
}

func nodePoolIngress(ctx *stackctx.Context) security.GroupRuleSetIngressArray {
	inv := ctx.Inventory
	ingressRules := []string{
		"ACCEPT#" + inv.Network.VpcCIDR + "#ALL#ALL",
		"ACCEPT#" + inv.Stacks.TKE.ClusterCIDR + "#ALL#ALL",
	}
	if !ctx.Runtime.EnableImport && inv.Stacks.TKE.ClusterInternet {
		for _, cidr := range inv.Stacks.TKE.ClusterInternetCIDRs {
			ingressRules = append(ingressRules, "ACCEPT#"+cidr+"#443#TCP")
		}
	}
	for _, port := range inv.Stacks.TKE.NodePoolPublicIngressPorts {
		ingressRules = append(ingressRules, "ACCEPT#0.0.0.0/0#"+strconv.Itoa(port)+"#TCP")
	}
	return securitygroup.ToIngressArray(ingressRules)
}

func clusterEndpointExtensiveParameters() string {
	raw, _ := json.Marshal(map[string]any{
		"AddressIPVersion": "IPV4",
		"InternetAccessible": map[string]any{
			"InternetChargeType":      "TRAFFIC_POSTPAID_BY_HOUR",
			"InternetMaxBandwidthOut": 10,
		},
	})
	return string(raw)
}

func tcrAddonRawValues(ctx *stackctx.Context) pulumi.StringPtrInput {
	secretNames := []string{
		"qcloudregistrykey",
		"tcr-regcred",
		"tcr-lightclaw-secret",
	}
	return pulumi.All(
		ctx.Derived.TCRPublicDomain,
		ctx.Derived.TCRPullUsername,
		ctx.Derived.TCRPullPassword,
	).ApplyT(func(args []interface{}) (*string, error) {
		server := args[0].(string)
		username := args[1].(string)
		password := args[2].(string)
		imagePullSecrets := make([]map[string]any, 0, len(secretNames))
		for _, name := range secretNames {
			imagePullSecrets = append(imagePullSecrets, map[string]any{
				"name":            name,
				"namespaces":      "*",
				"serviceAccounts": "*",
				"type":            "docker",
				"dockerUsername":  username,
				"dockerPassword":  password,
				"dockerServer":    server,
			})
		}
		raw, err := json.Marshal(map[string]any{
			"global": map[string]any{
				"imagePullSecretsCrs": imagePullSecrets,
			},
		})
		if err != nil {
			return nil, err
		}
		value := string(raw)
		return &value, nil
	}).(pulumi.StringPtrOutput)
}

func eniSubnetIDs(ctx *stackctx.Context, configuredKeys []string) pulumi.StringArrayInput {
	keys := configuredKeys
	if len(keys) == 0 {
		keys = make([]string, 0, len(ctx.Inventory.Network.SandboxPoolSubnetKeys)+1)
		keys = append(keys, ctx.Inventory.Network.SandboxPoolSubnetKeys...)
		supportKey := ctx.Inventory.Network.SupportSubnetKey
		seenSupport := false
		for _, key := range keys {
			if key == supportKey {
				seenSupport = true
				break
			}
		}
		if supportKey != "" && !seenSupport {
			keys = append(keys, supportKey)
		}
	}

	return ctx.Derived.NetworkSubnetIDs.ApplyT(func(subnetIDs map[string]string) ([]string, error) {
		resolved := make([]string, 0, len(keys))
		for _, key := range keys {
			subnetID, ok := subnetIDs[key]
			if !ok || strings.TrimSpace(subnetID) == "" {
				return nil, fmt.Errorf("missing subnet id for eni_subnet_key %q", key)
			}
			resolved = append(resolved, subnetID)
		}
		return resolved, nil
	}).(pulumi.StringArrayOutput)
}

func existingClusterID(ctx *stackctx.Context) string {
	if !ctx.Runtime.EnableImport {
		return ""
	}
	if ctx.Plan.TKE.ClusterID != "" {
		return ctx.Plan.TKE.ClusterID
	}
	return ctx.Runtime.Reconcile.TKEClusterID
}

func resolveNodePoolImportID(ctx *stackctx.Context, clusterID, nodePoolName, importID string) (string, error) {
	if importID != "" || clusterID == "" {
		return importID, nil
	}

	existing, err := kubernetes.GetClusterNodePools(ctx.Pulumi, &kubernetes.GetClusterNodePoolsArgs{
		ClusterId: clusterID,
		Filters: []kubernetes.GetClusterNodePoolsFilter{
			{
				Name:   "NodePoolsName",
				Values: []string{nodePoolName},
			},
		},
	}, pulumi.Provider(ctx.Provider))
	if err != nil {
		return "", err
	}

	for _, nodePool := range existing.NodePoolSets {
		if nodePool.Name != nodePoolName || nodePool.NodePoolId == "" {
			continue
		}
		return clusterID + "#" + nodePool.NodePoolId, nil
	}
	return "", nil
}
