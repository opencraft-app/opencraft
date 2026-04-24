package cls

import (
	"github.com/pulumi/pulumi/sdk/v3/go/pulumi"
	tencentcls "github.com/tencentcloudstack/pulumi-tencentcloud/sdk/go/tencentcloud/cls"

	"github.com/skipzhang/mono/infra_pulumi/pkg/naming"
	"github.com/skipzhang/mono/infra_pulumi/pkg/stackctx"
)

func Ensure(ctx *stackctx.Context) error {
	monitoring := ctx.Inventory.Stacks.Monitoring

	logset, err := tencentcls.NewLogset(ctx.Pulumi, naming.StableResource("cls", "service-gateway-logset"), &tencentcls.LogsetArgs{
		LogsetName: pulumi.String(monitoring.CLSLogs.LogsetName),
		Tags: pulumi.StringMap{
			"service": pulumi.String("service-gateway"),
			"env":     pulumi.String(ctx.Inventory.EnvName),
		},
	}, ctx.ImportOption(ctx.Plan.Monitoring.ServiceGatewayLogsetID)...)
	if err != nil {
		return err
	}

	serviceTopic, err := tencentcls.NewTopic(ctx.Pulumi, naming.StableResource("cls", "service-gateway-topic"), &tencentcls.TopicArgs{
		LogsetId:       logset.ID().ToStringOutput(),
		TopicName:      pulumi.String(monitoring.CLSLogs.TopicName),
		Describes:      pulumi.StringPtr("service-gateway access logs collected from container stdout"),
		StorageType:    pulumi.StringPtr("hot"),
		PartitionCount: pulumi.IntPtr(1),
		Period:         pulumi.IntPtr(30),
		Tags: pulumi.StringMap{
			"service": pulumi.String("service-gateway"),
			"env":     pulumi.String(ctx.Inventory.EnvName),
		},
	}, ctx.OptionsWithImport(ctx.Plan.Monitoring.ServiceGatewayTopicID, pulumi.IgnoreChanges([]string{"describes"}))...)
	if err != nil {
		return err
	}

	if _, err := tencentcls.NewIndex(ctx.Pulumi, naming.StableResource("cls", "service-gateway-index"), &tencentcls.IndexArgs{
		TopicId:               serviceTopic.ID().ToStringOutput(),
		Rule:                  defaultIndexRule(),
		Status:                pulumi.BoolPtr(true),
		IncludeInternalFields: pulumi.BoolPtr(true),
		MetadataFlag:          pulumi.IntPtr(1),
	}, ctx.OptionsWithImport(ctx.Plan.Monitoring.ServiceGatewayIndexID, pulumi.IgnoreChanges([]string{"rule", "includeInternalFields", "metadataFlag"}))...); err != nil {
		return err
	}

	ctlLogsetID := runtimeLogsetID(ctx, monitoring.CtlCLSLogs.LogsetID, logset.ID().ToStringOutput())
	ctlRuntimeTopic, err := ensureRuntimeTopic(ctx, "ctl-runtime", ctlLogsetID, monitoring.CtlCLSLogs.TopicName, "ctl", ctx.Plan.Monitoring.CtlRuntimeTopicID, ctx.Plan.Monitoring.CtlRuntimeIndexID)
	if err != nil {
		return err
	}
	sandboxLogsetID := runtimeLogsetID(ctx, monitoring.SandboxCLSLogs.LogsetID, logset.ID().ToStringOutput())
	sandboxRuntimeTopic, err := ensureRuntimeTopic(ctx, "sandbox-runtime", sandboxLogsetID, monitoring.SandboxCLSLogs.TopicName, "sandbox", ctx.Plan.Monitoring.SandboxRuntimeTopicID, ctx.Plan.Monitoring.SandboxRuntimeIndexID)
	if err != nil {
		return err
	}
	ctx.Pulumi.Export("serviceGatewayCLSTopicId", serviceTopic.ID())
	ctx.Pulumi.Export("serviceGatewayCLSLogsetId", logset.ID())
	ctx.Pulumi.Export("ctlRuntimeCLSTopicId", ctlRuntimeTopic.ID())
	ctx.Pulumi.Export("sandboxRuntimeCLSTopicId", sandboxRuntimeTopic.ID())
	return nil
}

func ensureRuntimeTopic(ctx *stackctx.Context, suffix string, logsetID pulumi.StringInput, topicName, service, topicImportID, indexImportID string) (*tencentcls.Topic, error) {
	topic, err := tencentcls.NewTopic(ctx.Pulumi, naming.StableResource("cls", suffix, "topic"), &tencentcls.TopicArgs{
		LogsetId:       logsetID,
		TopicName:      pulumi.String(topicName),
		Describes:      pulumi.StringPtr(service + " runtime logs collected from container stdout"),
		StorageType:    pulumi.StringPtr("hot"),
		PartitionCount: pulumi.IntPtr(1),
		Period:         pulumi.IntPtr(30),
		Tags: pulumi.StringMap{
			"service": pulumi.String(service),
			"env":     pulumi.String(ctx.Inventory.EnvName),
		},
	}, ctx.OptionsWithImport(topicImportID, pulumi.IgnoreChanges([]string{"describes"}))...)
	if err != nil {
		return nil, err
	}

	_, err = tencentcls.NewIndex(ctx.Pulumi, naming.StableResource("cls", suffix, "index"), &tencentcls.IndexArgs{
		TopicId:               topic.ID().ToStringOutput(),
		Rule:                  defaultIndexRule(),
		Status:                pulumi.BoolPtr(true),
		IncludeInternalFields: pulumi.BoolPtr(true),
		MetadataFlag:          pulumi.IntPtr(1),
	}, ctx.OptionsWithImport(indexImportID, pulumi.IgnoreChanges([]string{"rule", "includeInternalFields", "metadataFlag"}))...)
	if err != nil {
		return nil, err
	}
	return topic, nil
}

func runtimeLogsetID(ctx *stackctx.Context, inventoryLogsetID string, defaultLogsetID pulumi.StringInput) pulumi.StringInput {
	if inventoryLogsetID != "" {
		return pulumi.String(inventoryLogsetID)
	}
	return defaultLogsetID
}

func defaultIndexRule() *tencentcls.IndexRuleArgs {
	return &tencentcls.IndexRuleArgs{
		FullText: &tencentcls.IndexRuleFullTextArgs{
			CaseSensitive: pulumi.Bool(false),
			ContainZH:     pulumi.Bool(true),
			Tokenizer:     pulumi.String("@&?|#()='\",;:<>[]{}"),
		},
		DynamicIndex: &tencentcls.IndexRuleDynamicIndexArgs{
			Status: pulumi.Bool(true),
		},
	}
}
