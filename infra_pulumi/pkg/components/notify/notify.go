package notify

import (
	"encoding/json"
	"fmt"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/pulumi/pulumi/sdk/v3/go/pulumi"
	"github.com/tencentcloudstack/pulumi-tencentcloud/sdk/go/tencentcloud/cam"
	"github.com/tencentcloudstack/pulumi-tencentcloud/sdk/go/tencentcloud/scf"
	"github.com/tencentcloudstack/pulumi-tencentcloud/sdk/go/tencentcloud/ssm"
	"github.com/tencentcloudstack/pulumi-tencentcloud/sdk/go/tencentcloud/user"

	"github.com/skipzhang/mono/infra_pulumi/pkg/config"
	"github.com/skipzhang/mono/infra_pulumi/pkg/naming"
	"github.com/skipzhang/mono/infra_pulumi/pkg/scfpack"
	"github.com/skipzhang/mono/infra_pulumi/pkg/stackctx"
)

const (
	functionNamespace     = "default"
	runtimeName           = "Python3.10"
	functionTimeout       = 900
	notifySecretVersionID = "SSM_Current"
)

func Ensure(ctx *stackctx.Context) error {
	inv := ctx.Inventory.Stacks.Notify
	if err := validateInventory(ctx.Inventory.EnvName, inv); err != nil {
		return err
	}
	if !inv.Enabled {
		return nil
	}

	zipPath := filepath.Join(ctx.Runtime.ProjectRoot, ".build", "notify_runtime.zip")
	if err := scfpack.BuildPythonRuntimeZip(filepath.Join(ctx.Runtime.ProjectRoot, "functions", "notify_runtime"), zipPath); err != nil {
		return err
	}
	zipPath, err := scfpack.ContentAddressedPath(zipPath)
	if err != nil {
		return err
	}

	redisSecretName := inv.RedisSecretName
	if redisSecretName == "" {
		redisSecretName = fmt.Sprintf("mono-%s-notify-redis", ctx.Inventory.EnvName)
	}
	redisSecret, err := ssm.NewSecret(ctx.Pulumi, naming.StableResource("notify", "redis-secret"), &ssm.SecretArgs{
		SecretName:           pulumi.String(redisSecretName),
		Description:          pulumi.StringPtr("Redis credential for LightVela expiry notification SCF"),
		IsEnabled:            pulumi.BoolPtr(true),
		RecoveryWindowInDays: pulumi.IntPtr(7),
		Tags:                 resourceTags(ctx),
	}, ctx.Options()...)
	if err != nil {
		return err
	}
	redisSecretJSON := ctx.Runtime.RedisPassword.ApplyT(func(password string) (string, error) {
		value, err := json.Marshal(map[string]string{"password": password})
		return string(value), err
	}).(pulumi.StringOutput)
	redisVersion, err := ssm.NewSecretVersion(ctx.Pulumi, naming.StableResource("notify", "redis-secret-version"), &ssm.SecretVersionArgs{
		SecretName:   redisSecret.SecretName,
		VersionId:    pulumi.String(notifySecretVersionID),
		SecretString: redisSecretJSON.ToStringPtrOutput(),
	}, ctx.Options(pulumi.DependsOn([]pulumi.Resource{redisSecret}))...)
	if err != nil {
		return err
	}

	role, attachment, err := ensureRuntimeRole(ctx, redisSecretName)
	if err != nil {
		return err
	}
	baseEnvironment := functionEnvironment(ctx, inv, redisSecretName)
	dependencies := []pulumi.Resource{attachment, redisVersion}

	scanner, err := ensureFunction(ctx, "scanner", inv.ScannerFunctionName, inv.ExistingScannerFunctionID, "app.scanner_handler", zipPath, role, baseEnvironment, dependencies)
	if err != nil {
		return err
	}
	worker, err := ensureFunction(ctx, "worker", inv.WorkerFunctionName, inv.ExistingWorkerFunctionID, "app.worker_handler", zipPath, role, baseEnvironment, dependencies)
	if err != nil {
		return err
	}

	if shouldManageTriggers(inv) {
		triggerState := "CLOSE"
		if inv.TriggersEnabled {
			triggerState = "OPEN"
		}
		if err := ensureTimer(ctx, "scanner", scanner, inv.ScannerFunctionName, inv.ScannerCron, triggerState); err != nil {
			return err
		}
		if err := ensureTimer(ctx, "worker", worker, inv.WorkerFunctionName, inv.WorkerCron, triggerState); err != nil {
			return err
		}
	}

	ctx.Pulumi.Export("notifyScannerFunctionName", scanner.Name)
	ctx.Pulumi.Export("notifyTriggersManaged", pulumi.Bool(inv.ManageTriggers))
	ctx.Pulumi.Export("notifyWorkerFunctionName", worker.Name)
	ctx.Pulumi.Export("notifyTriggersEnabled", pulumi.Bool(inv.TriggersEnabled))
	return nil
}

func shouldManageTriggers(inv config.NotifyInventory) bool {
	return inv.ManageTriggers
}

func ensureRuntimeRole(ctx *stackctx.Context, redisSecretName string) (*cam.Role, *cam.RolePolicyAttachment, error) {
	trust := `{"version":"2.0","statement":[{"effect":"allow","action":"name/sts:AssumeRole","principal":{"service":["scf.qcloud.com"]}}]}`
	role, err := cam.NewRole(ctx.Pulumi, naming.StableResource("notify", "runtime-role"), &cam.RoleArgs{
		Name:         pulumi.StringPtr(fmt.Sprintf("lightvela-notify-runtime-%s-v2", ctx.Inventory.EnvShort)),
		Document:     pulumi.String(trust),
		Description:  pulumi.StringPtr("Runtime role for LightVela expiry notification SCF"),
		ConsoleLogin: pulumi.BoolPtr(false),
		Tags:         resourceTags(ctx),
	}, ctx.Options()...)
	if err != nil {
		return nil, nil, err
	}
	account, err := user.GetInfo(ctx.Pulumi, &user.GetInfoArgs{}, pulumi.Provider(ctx.Provider))
	if err != nil {
		return nil, nil, fmt.Errorf("query Tencent Cloud account for notify policy: %w", err)
	}
	policyDocument, err := buildRuntimePolicy(
		ctx.Inventory.Region,
		account.OwnerUin,
		ctx.Inventory.Stacks.Notify.DBSecretName,
		redisSecretName,
	)
	if err != nil {
		return nil, nil, err
	}
	policy, err := cam.NewPolicy(ctx.Pulumi, naming.StableResource("notify", "runtime-policy"), &cam.PolicyArgs{
		Name:        pulumi.StringPtr(fmt.Sprintf("lightvela-notify-runtime-%s-v2", ctx.Inventory.EnvShort)),
		Document:    pulumi.String(policyDocument),
		Description: pulumi.StringPtr("Read notification secrets and send approved SMS templates"),
	}, ctx.Options()...)
	if err != nil {
		return nil, nil, err
	}
	attachment, err := cam.NewRolePolicyAttachment(ctx.Pulumi, naming.StableResource("notify", "runtime-policy-attachment"), &cam.RolePolicyAttachmentArgs{
		RoleId:   role.ID().ToStringOutput(),
		PolicyId: policy.ID().ToStringOutput(),
	}, ctx.Options()...)
	if err != nil {
		return nil, nil, err
	}
	return role, attachment, nil
}

func buildRuntimePolicy(region, ownerUIN, dbSecretName, redisSecretName string) (string, error) {
	secretARN := func(secretName string) string {
		return fmt.Sprintf(
			"qcs::ssm:%s:uin/%s:secret/creatorUin/%s/%s",
			region,
			ownerUIN,
			ownerUIN,
			secretName,
		)
	}
	policy := struct {
		Version   string `json:"version"`
		Statement []struct {
			Effect   string   `json:"effect"`
			Action   []string `json:"action"`
			Resource []string `json:"resource"`
		} `json:"statement"`
	}{
		Version: "2.0",
		Statement: []struct {
			Effect   string   `json:"effect"`
			Action   []string `json:"action"`
			Resource []string `json:"resource"`
		}{
			{
				Effect:   "allow",
				Action:   []string{"name/ssm:GetSecretValue"},
				Resource: []string{secretARN(dbSecretName), secretARN(redisSecretName)},
			},
			{
				Effect:   "allow",
				Action:   []string{"name/sms:SendSms"},
				Resource: []string{"*"},
			},
		},
	}
	document, err := json.Marshal(policy)
	if err != nil {
		return "", fmt.Errorf("marshal notify runtime policy: %w", err)
	}
	return string(document), nil
}

func ensureFunction(ctx *stackctx.Context, suffix, functionName, importID, handler, zipPath string, role *cam.Role, environment pulumi.StringMap, dependencies []pulumi.Resource) (*scf.Function, error) {
	if strings.TrimSpace(functionName) == "" {
		return nil, fmt.Errorf("notify %s_function_name is required", suffix)
	}
	return scf.NewFunction(ctx.Pulumi, naming.StableResource("notify", suffix, "function"), &scf.FunctionArgs{
		Name:            pulumi.StringPtr(functionName),
		Namespace:       pulumi.StringPtr(functionNamespace),
		Description:     pulumi.StringPtr("LightVela expiry notification " + suffix),
		Handler:         pulumi.StringPtr(handler),
		Runtime:         pulumi.StringPtr(runtimeName),
		ZipFile:         pulumi.StringPtr(zipPath),
		MemSize:         pulumi.IntPtr(512),
		Timeout:         pulumi.IntPtr(functionTimeout),
		Role:            role.Name.ToStringPtrOutput(),
		VpcId:           pulumi.StringPtr(ctx.Inventory.Stacks.Notify.VPCID),
		SubnetId:        pulumi.StringPtr(ctx.Inventory.Stacks.Notify.SubnetID),
		EnablePublicNet: pulumi.BoolPtr(false),
		Environment:     environment,
		ClsLogsetId:     pulumi.StringPtr(ctx.Inventory.Stacks.Notify.CLSLogsetID),
		ClsTopicId:      pulumi.StringPtr(ctx.Inventory.Stacks.Notify.CLSTopicID),
		Tags:            resourceTags(ctx),
	}, ctx.OptionsWithAdopt(importID, pulumi.DependsOn(dependencies))...)
}

func ensureTimer(ctx *stackctx.Context, suffix string, function *scf.Function, functionName, cron, state string) error {
	triggerName := "lightvela-notify-" + suffix + "-timer"
	_, err := scf.NewTriggerConfig(ctx.Pulumi, naming.StableResource("notify", suffix, "timer"), &scf.TriggerConfigArgs{
		FunctionName: function.Name,
		Namespace:    pulumi.StringPtr(functionNamespace),
		Qualifier:    pulumi.StringPtr("$DEFAULT"),
		TriggerName:  pulumi.String(triggerName),
		Type:         pulumi.String("timer"),
		TriggerDesc:  pulumi.String(cron),
		Enable:       pulumi.StringPtr(state),
		Description:  pulumi.StringPtr("Managed by infra_pulumi"),
	}, ctx.OptionsWithAdopt(triggerImportID(functionName, triggerName), pulumi.DependsOn([]pulumi.Resource{function}))...)
	return err
}

func triggerImportID(functionName, triggerName string) string {
	return strings.Join([]string{functionName, functionNamespace, triggerName}, "#")
}

func functionEnvironment(ctx *stackctx.Context, inv config.NotifyInventory, redisSecretName string) pulumi.StringMap {
	environment := pulumi.StringMap{
		"TZ":                         pulumi.String("Asia/Shanghai"),
		"NOTIFY_ENV":                 pulumi.String(ctx.Inventory.EnvName),
		"SSM_REGION":                 pulumi.String(ctx.Inventory.Region),
		"DB_HOST":                    pulumi.String(inv.DBHost),
		"DB_PORT":                    pulumi.String(strconv.Itoa(inv.DBPort)),
		"DB_USER":                    pulumi.String(inv.DBUser),
		"DB_SECRET_NAME":             pulumi.String(inv.DBSecretName),
		"REDIS_HOST":                 pulumi.String(inv.RedisHost),
		"REDIS_PORT":                 pulumi.String(strconv.Itoa(inv.RedisPort)),
		"REDIS_SECRET_NAME":          pulumi.String(redisSecretName),
		"SMS_REGION":                 pulumi.String("ap-guangzhou"),
		"SMS_ENDPOINT":               pulumi.String("sms.internal.tencentcloudapi.com"),
		"SMS_SDK_APP_ID":             pulumi.String(inv.SMSSDKAppID),
		"SMS_SIGN_NAME":              pulumi.String(inv.SMSSignName),
		"SMS_TEMPLATE_ID":            pulumi.String(inv.SMSTemplateID),
		"EXPIRY_WINDOWS_DAYS":        pulumi.String(inv.ExpiryWindowsDays),
		"SMS_QPS":                    pulumi.String(strconv.Itoa(inv.SMSQPS)),
		"SMS_BURST":                  pulumi.String(strconv.Itoa(inv.SMSBurst)),
		"SCAN_PAGE_SIZE":             pulumi.String(strconv.Itoa(inv.ScanPageSize)),
		"WORKER_BATCH_SIZE":          pulumi.String(strconv.Itoa(inv.WorkerBatchSize)),
		"WORKER_MAX_MESSAGES":        pulumi.String(strconv.Itoa(inv.WorkerMaxMessages)),
		"WORKER_MAX_RUNTIME_SECONDS": pulumi.String("840"),
		"SCANNER_LOCK_TTL_SECONDS":   pulumi.String("900"),
		"SCANNER_MAX_CATCHUP_DAYS":   pulumi.String("7"),
		"DELETE_ACKED_MESSAGES":      pulumi.String("true"),
	}
	if inv.TestAllowlistEnabled {
		environment["SMS_TEST_ALLOWLIST_SHA256"] = ctx.Runtime.NotifyTestAllowlistSHA256
	}
	return environment
}

func resourceTags(ctx *stackctx.Context) pulumi.StringMap {
	return pulumi.StringMap{
		"env":        pulumi.String(ctx.Inventory.EnvName),
		"service":    pulumi.String("expiry-notify"),
		"managed-by": pulumi.String("infra-pulumi"),
	}
}
