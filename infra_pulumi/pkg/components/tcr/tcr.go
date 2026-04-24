package tcr

import (
	"context"
	"time"

	"github.com/pulumi/pulumi/sdk/v3/go/pulumi"
	tencenttcr "github.com/tencentcloudstack/pulumi-tencentcloud/sdk/go/tencentcloud/tcr"

	"github.com/skipzhang/mono/infra_pulumi/pkg/naming"
	"github.com/skipzhang/mono/infra_pulumi/pkg/pulumiutil"
	"github.com/skipzhang/mono/infra_pulumi/pkg/stackctx"
	sdktcr "github.com/skipzhang/mono/infra_pulumi/pkg/tencenttcr"
)

func Ensure(ctx *stackctx.Context) error {
	cfg := ctx.Inventory.Stacks.TCR
	instanceName := naming.TCRInstanceName(ctx.Inventory.EnvShort)
	var securityPolicies tencenttcr.InstanceSecurityPolicyArrayInput
	if cfg.OpenPublicOperation {
		securityPolicies = tencenttcr.InstanceSecurityPolicyArray{
			&tencenttcr.InstanceSecurityPolicyArgs{
				CidrBlock:   pulumi.StringPtr("0.0.0.0/0"),
				Description: pulumi.StringPtr("allow public access"),
			},
		}
	}
	instance, err := tencenttcr.NewInstance(ctx.Pulumi, naming.StableResource("tcr", "instance"), &tencenttcr.InstanceArgs{
		Name:                pulumi.String(instanceName),
		InstanceType:        pulumi.String(cfg.InstanceType),
		RegistryChargeType:  pulumi.IntPtr(1),
		OpenPublicOperation: pulumi.BoolPtr(cfg.OpenPublicOperation),
		SecurityPolicies:    securityPolicies,
		DeleteBucket:        pulumi.BoolPtr(false),
		Tags:                pulumiutil.StringMap(cfg.Tags),
	}, ctx.ImportOption(ctx.Plan.TCR.InstanceID)...)
	if err != nil {
		return err
	}

	readyRegistryID := instance.ID().ToStringOutput().ApplyT(func(_ string) (string, error) {
		summary, err := sdktcr.WaitUntilReady(
			context.Background(),
			ctx.Runtime,
			ctx.Inventory.Region,
			instanceName,
			10*time.Minute,
			10*time.Second,
		)
		if err != nil {
			return "", err
		}
		return summary.RegistryID, nil
	}).(pulumi.StringOutput)
	readyRegistryPublicDomain := instance.ID().ToStringOutput().ApplyT(func(_ string) (string, error) {
		summary, err := sdktcr.WaitUntilReady(
			context.Background(),
			ctx.Runtime,
			ctx.Inventory.Region,
			instanceName,
			10*time.Minute,
			10*time.Second,
		)
		if err != nil {
			return "", err
		}
		return summary.PublicDomain, nil
	}).(pulumi.StringOutput)
	ctx.Derived.TCRPublicDomain = readyRegistryPublicDomain

	clusterPullToken, err := tencenttcr.NewToken(ctx.Pulumi, naming.StableResource("tcr", "token"), &tencenttcr.TokenArgs{
		InstanceId:  readyRegistryID,
		Description: pulumi.StringPtr("Cluster image pull token for " + ctx.Runtime.EnvironmentName),
		Enable:      pulumi.BoolPtr(true),
	}, ctx.Options()...)
	if err != nil {
		return err
	}
	ctx.Derived.TCRPullUsername = clusterPullToken.UserName
	ctx.Derived.TCRPullPassword = clusterPullToken.Token

	namespace, err := tencenttcr.NewNamespace(ctx.Pulumi, naming.StableResource("tcr", "namespace"), &tencenttcr.NamespaceArgs{
		InstanceId:   readyRegistryID,
		Name:         pulumi.StringPtr(cfg.NamespaceName),
		IsPublic:     pulumi.Bool(false),
		IsAutoScan:   pulumi.Bool(false),
		IsPreventVul: pulumi.Bool(false),
	}, ctx.ImportOption(ctx.Plan.TCR.NamespaceID)...)
	if err != nil {
		return err
	}

	_, err = tencenttcr.NewServiceAccount(ctx.Pulumi, naming.StableResource("tcr", "service-account"), &tencenttcr.ServiceAccountArgs{
		RegistryId:  readyRegistryID,
		Name:        pulumi.String(cfg.PullServiceAccountName),
		Description: pulumi.StringPtr("Pull/push service account for the " + cfg.NamespaceName + " namespace."),
		Duration:    pulumi.IntPtr(cfg.PullServiceAccountDurationDays),
		Disable:     pulumi.BoolPtr(false),
		Permissions: tencenttcr.ServiceAccountPermissionArray{
			&tencenttcr.ServiceAccountPermissionArgs{
				Resource: namespace.Name,
				Actions: pulumi.StringArray{
					pulumi.String("tcr:CreateRepository"),
					pulumi.String("tcr:PullRepository"),
					pulumi.String("tcr:PushRepository"),
				},
			},
		},
	}, ctx.OptionsWithImport(ctx.Plan.TCR.ServiceAccountID, pulumi.IgnoreChanges([]string{"duration"}))...)
	return err
}
