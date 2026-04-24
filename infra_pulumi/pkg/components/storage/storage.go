package storage

import (
	"fmt"

	"github.com/pulumi/pulumi/sdk/v3/go/pulumi"
	"github.com/tencentcloudstack/pulumi-tencentcloud/sdk/go/tencentcloud/cam"
	"github.com/tencentcloudstack/pulumi-tencentcloud/sdk/go/tencentcloud/cos"

	"github.com/skipzhang/mono/infra_pulumi/pkg/naming"
	"github.com/skipzhang/mono/infra_pulumi/pkg/stackctx"
	"github.com/skipzhang/mono/infra_pulumi/pkg/tencentcam"
)

func Ensure(ctx *stackctx.Context) error {
	accountAppID, err := tencentcam.GetAccountAppID(ctx.Runtime)
	if err != nil {
		return err
	}
	bucketName := resolvedBucketName(ctx, accountAppID)
	camUserName := resolvedCAMUserName(ctx)
	camPolicyName := resolvedCAMPolicyName(ctx)

	_, err = cos.NewBucket(ctx.Pulumi, naming.StableResource("storage", "bucket"), &cos.BucketArgs{
		Bucket: pulumi.String(bucketName),
		Acl:    pulumi.String("private"),
	}, ctx.ImportOption(ctx.Plan.Storage.BucketID)...)
	if err != nil {
		return err
	}

	user, err := cam.NewUser(ctx.Pulumi, naming.StableResource("storage", "cam-user"), &cam.UserArgs{
		Name:        pulumi.StringPtr(camUserName),
		Remark:      pulumi.StringPtr("Scoped API user for lightclaw user asset bucket access."),
		UseApi:      pulumi.BoolPtr(true),
		ForceDelete: pulumi.BoolPtr(false),
	}, ctx.ImportOption(ctx.Plan.Storage.CAMUserID)...)
	if err != nil {
		return err
	}

	policy, err := cam.NewPolicy(ctx.Pulumi, naming.StableResource("storage", "cam-policy"), &cam.PolicyArgs{
		Name:        pulumi.String(camPolicyName),
		Description: pulumi.StringPtr("Allow COS access only for bucket " + bucketName + "."),
		Document:    pulumi.String(bucketPolicy(ctx, accountAppID, bucketName)),
	}, ctx.ImportOption(ctx.Plan.Storage.CAMPolicyID)...)
	if err != nil {
		return err
	}

	if _, err := cam.NewUserPolicyAttachment(ctx.Pulumi, naming.StableResource("storage", "cam-policy-attach"), &cam.UserPolicyAttachmentArgs{
		UserName: user.Name,
		PolicyId: policy.ID().ToStringOutput(),
	}, ctx.ImportOption(ctx.Plan.Storage.CAMUserPolicyAttachID)...); err != nil {
		return err
	}

	if ctx.Runtime.StorageAccessKeyImport != "" {
		if _, err := cam.NewAccessKey(ctx.Pulumi, naming.StableResource("storage", "cam-access-key"), &cam.AccessKeyArgs{
			Status:    pulumi.StringPtr("Active"),
			TargetUin: user.Uin.ToIntPtrOutput(),
		}, ctx.ImportOption(ctx.Runtime.StorageAccessKeyImport)...); err != nil {
			return err
		}
	}

	ctx.Pulumi.Export("storageBucketName", pulumi.String(bucketName))
	return nil
}

func bucketPolicy(ctx *stackctx.Context, accountAppID, bucketName string) string {
	resource := fmt.Sprintf("qcs::cos:%s:uid/%s:%s", ctx.Inventory.Region, accountAppID, bucketName)
	return fmt.Sprintf(`{"version":"2.0","statement":[{"effect":"allow","action":["name/cos:*"],"resource":["%s","%s/*"]}]}`, resource, resource)
}

func resolvedBucketName(ctx *stackctx.Context, accountAppID string) string {
	if ctx.Runtime.EnableImport && ctx.Plan.Storage.BucketID != "" {
		return ctx.Plan.Storage.BucketID
	}
	return naming.StorageBucketName(ctx.Inventory.EnvShort, accountAppID)
}

func resolvedCAMUserName(ctx *stackctx.Context) string {
	if ctx.Inventory.EnvName == "beijing-sandbox" {
		return "lightclawuser-cos"
	}
	return naming.StorageCAMUserName(ctx.Inventory.EnvShort)
}

func resolvedCAMPolicyName(ctx *stackctx.Context) string {
	if ctx.Inventory.EnvName == "beijing-sandbox" {
		return "lightclawuser-cos-only"
	}
	return naming.StorageCAMPolicyName(ctx.Inventory.EnvShort)
}
