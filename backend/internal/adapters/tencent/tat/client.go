// Package tat 使用腾讯云官方 Go SDK 实现受限 TAT 端口。
package tat

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/tencentcloud/tencentcloud-sdk-go/tencentcloud/common"
	tcerr "github.com/tencentcloud/tencentcloud-sdk-go/tencentcloud/common/errors"
	"github.com/tencentcloud/tencentcloud-sdk-go/tencentcloud/common/profile"
	tatsdk "github.com/tencentcloud/tencentcloud-sdk-go/tencentcloud/tat/v20201028"

	tencenttatport "chatserver/internal/ports/tencenttat"
)

const operationDescriptionPrefix = "chatserver-operation:"

type sdkClient interface {
	CreateRegisterCodeWithContext(
		context.Context,
		*tatsdk.CreateRegisterCodeRequest,
	) (*tatsdk.CreateRegisterCodeResponse, error)
	DescribeRegisterInstancesWithContext(
		context.Context,
		*tatsdk.DescribeRegisterInstancesRequest,
	) (*tatsdk.DescribeRegisterInstancesResponse, error)
	RunCommandWithContext(
		context.Context,
		*tatsdk.RunCommandRequest,
	) (*tatsdk.RunCommandResponse, error)
	DescribeInvocationsWithContext(
		context.Context,
		*tatsdk.DescribeInvocationsRequest,
	) (*tatsdk.DescribeInvocationsResponse, error)
	DescribeInvocationTasksWithContext(
		context.Context,
		*tatsdk.DescribeInvocationTasksRequest,
	) (*tatsdk.DescribeInvocationTasksResponse, error)
	DescribeAutomationAgentStatusWithContext(
		context.Context,
		*tatsdk.DescribeAutomationAgentStatusRequest,
	) (*tatsdk.DescribeAutomationAgentStatusResponse, error)
}

type sdkFactory interface {
	Client(context.Context, string) (sdkClient, error)
}

type providerFactory struct {
	provider common.Provider
	timeout  time.Duration
}

type staticProvider struct {
	credential common.CredentialIface
}

func (provider staticProvider) GetCredential() (common.CredentialIface, error) {
	if provider.credential == nil {
		return nil, errors.New("TAT 静态凭据为空")
	}
	return provider.credential, nil
}

func (factory providerFactory) Client(
	_ context.Context,
	region string,
) (sdkClient, error) {
	credential, err := factory.provider.GetCredential()
	if err != nil {
		return nil, err
	}
	clientProfile := profile.NewClientProfile()
	clientProfile.HttpProfile.ReqTimeout = int(factory.timeout.Seconds())
	// RunCommand 没有 ClientToken；显式关闭 SDK 自动重试，交给 operation worker
	// 先查询云端事实后再决定。
	clientProfile.NetworkFailureMaxRetries = 0
	clientProfile.RateLimitExceededMaxRetries = 0
	clientProfile.UnsafeRetryOnConnectionFailure = false
	return tatsdk.NewClient(credential, region, clientProfile)
}

// Client 是 TAT 端口的官方 SDK Adapter。
type Client struct{ factory sdkFactory }

// NewDefaultClient 使用官方安全凭据链：环境、受限 profile、CVM 角色。
//
// SecretId/SecretKey 不作为本构造函数参数，也不进入平台配置或数据库。
func NewDefaultClient(timeout time.Duration) (*Client, error) {
	if timeout < time.Second || timeout > 5*time.Minute {
		return nil, errors.New("TAT SDK 超时配置无效")
	}
	return newClient(providerFactory{
		// 不读取本地凭据配置文件。生产节点只允许受控环境注入或绑定 CAM
		// 实例角色；Agent/CLI 不会装配此 Adapter。
		provider: common.NewProviderChain([]common.Provider{
			common.DefaultEnvProvider(),
			common.DefaultCvmRoleProvider(),
		}),
		timeout: timeout,
	})
}

// NewCredentialClient 使用仅由后台 Secret 文件加载的静态 CAM 凭据。
// Agent、Computer 与浏览器端不会装配此构造函数。
func NewCredentialClient(secretID string, secretKey string, timeout time.Duration) (*Client, error) {
	secretID = strings.TrimSpace(secretID)
	secretKey = strings.TrimSpace(secretKey)
	if timeout < time.Second || timeout > 5*time.Minute ||
		len(secretID) < 16 || len(secretKey) < 16 ||
		len(secretID) > 256 || len(secretKey) > 256 ||
		strings.ContainsAny(secretID, "\r\n\x00") ||
		strings.ContainsAny(secretKey, "\r\n\x00") {
		return nil, errors.New("TAT 静态凭据配置无效")
	}
	return newClient(providerFactory{
		provider: staticProvider{credential: common.NewCredential(secretID, secretKey)},
		timeout:  timeout,
	})
}

func newClient(factory sdkFactory) (*Client, error) {
	if factory == nil {
		return nil, errors.New("TAT SDK Factory 不能为空")
	}
	return &Client{factory: factory}, nil
}

// FindManagedByComputerTag 按结构化注册写入的稳定标签发现唯一 TAT Computer。
func (client *Client) FindManagedByComputerTag(
	ctx context.Context,
	region string,
	computerID string,
) (tencenttatport.ManagedInstance, bool, error) {
	parsedID, parseErr := uuid.Parse(computerID)
	region = strings.TrimSpace(region)
	if client == nil || ctx == nil || region == "" ||
		parseErr != nil || parsedID.Version() != 7 {
		return tencenttatport.ManagedInstance{}, false,
			newError("tat_invalid_request", false, false)
	}
	sdk, err := client.factory.Client(ctx, region)
	if err != nil {
		return tencenttatport.ManagedInstance{}, false, classifyError(err, false)
	}
	request := tatsdk.NewDescribeRegisterInstancesRequest()
	request.Filters = []*tatsdk.Filter{{
		Name: common.StringPtr("tag:agent-network-computer-id"),
		Values: []*string{
			common.StringPtr(computerID),
		},
	}}
	request.Offset = common.Int64Ptr(0)
	request.Limit = common.Int64Ptr(2)
	response, err := sdk.DescribeRegisterInstancesWithContext(ctx, request)
	if err != nil {
		return tencenttatport.ManagedInstance{}, false, classifyError(err, false)
	}
	if response == nil || response.Response == nil {
		return tencenttatport.ManagedInstance{}, false,
			newError("tat_response_invalid", true, false)
	}
	matches := make([]*tatsdk.RegisterInstanceInfo, 0, 2)
	for _, candidate := range response.Response.RegisterInstanceSet {
		if candidate == nil || !hasComputerTag(candidate.Tags, computerID) {
			continue
		}
		matches = append(matches, candidate)
	}
	if len(matches) == 0 {
		return tencenttatport.ManagedInstance{}, false, nil
	}
	if len(matches) != 1 {
		return tencenttatport.ManagedInstance{}, false,
			newError("tat_register_instance_ambiguous", false, false)
	}
	candidate := matches[0]
	instanceID := strings.TrimSpace(stringValue(candidate.InstanceId))
	os, validOS := normalizeOS(stringValue(candidate.SystemName))
	if instanceID == "" || !strings.HasPrefix(instanceID, "rins-") || !validOS {
		return tencenttatport.ManagedInstance{}, false,
			newError("tat_response_invalid", true, false)
	}
	return tencenttatport.ManagedInstance{
		InstanceID: instanceID,
		OS:         os,
		Online: strings.EqualFold(
			strings.TrimSpace(stringValue(candidate.Status)),
			"Online",
		),
	}, true, nil
}

func hasComputerTag(tags []*tatsdk.Tag, computerID string) bool {
	for _, tag := range tags {
		if tag != nil &&
			stringValue(tag.Key) == "agent-network-computer-id" &&
			stringValue(tag.Value) == computerID {
			return true
		}
	}
	return false
}

// CreateRegistration 创建限一台、限一小时且仅返回一次明文的注册码。
func (client *Client) CreateRegistration(
	ctx context.Context,
	request tencenttatport.RegistrationRequest,
) (tencenttatport.Registration, error) {
	region := strings.TrimSpace(request.Region)
	description := strings.TrimSpace(request.Description)
	namePrefix := strings.TrimSpace(request.NamePrefix)
	if client == nil || ctx == nil || region == "" ||
		description == "" || len(description) > 128 ||
		namePrefix == "" || len(namePrefix) > 32 ||
		request.RegisterLimit != 1 ||
		request.EffectiveTime != time.Hour {
		return tencenttatport.Registration{},
			newError("tat_invalid_request", false, false)
	}
	sdk, err := client.factory.Client(ctx, region)
	if err != nil {
		return tencenttatport.Registration{}, classifyError(err, false)
	}
	sdkRequest := tatsdk.NewCreateRegisterCodeRequest()
	sdkRequest.Description = common.StringPtr(description)
	sdkRequest.InstanceNamePrefix = common.StringPtr(namePrefix)
	sdkRequest.RegisterLimit = common.Int64Ptr(1)
	sdkRequest.EffectiveTime = common.Int64Ptr(1)
	response, err := sdk.CreateRegisterCodeWithContext(ctx, sdkRequest)
	if err != nil {
		return tencenttatport.Registration{}, classifyError(err, false)
	}
	if response == nil || response.Response == nil ||
		strings.TrimSpace(stringValue(response.Response.RegisterCodeId)) == "" ||
		strings.TrimSpace(stringValue(response.Response.RegisterCodeValue)) == "" {
		return tencenttatport.Registration{},
			newError("tat_response_invalid", true, true)
	}
	return tencenttatport.Registration{
		CodeID:    *response.Response.RegisterCodeId,
		CodeValue: *response.Response.RegisterCodeValue,
		ExpiresAt: time.Now().UTC().Add(time.Hour),
	}, nil
}

// Run 向 Command 内冻结的地域和单个实例执行命令。
func (client *Client) Run(
	ctx context.Context,
	command tencenttatport.Command,
) (tencenttatport.Invocation, error) {
	if client == nil || ctx == nil || command.Target().Validate() != nil ||
		!tencenttatport.IsTemplateAllowed(command.Template()) {
		return tencenttatport.Invocation{}, newError("tat_invalid_request", false, false)
	}
	sdk, err := client.factory.Client(ctx, command.Target().Region)
	if err != nil {
		return tencenttatport.Invocation{}, classifyError(err, true)
	}
	request := tatsdk.NewRunCommandRequest()
	request.Content = common.StringPtr(
		base64.StdEncoding.EncodeToString([]byte(command.Content())),
	)
	request.InstanceIds = []*string{common.StringPtr(command.Target().InstanceID)}
	request.CommandName = common.StringPtr(commandName(command.Template()))
	request.Description = common.StringPtr(operationDescription(command.OperationID()))
	request.CommandType = common.StringPtr(string(command.CommandType()))
	request.WorkingDirectory = common.StringPtr(command.WorkingDirectory())
	request.Timeout = common.Uint64Ptr(uint64(command.Timeout() / time.Second))
	request.SaveCommand = common.BoolPtr(false)
	request.Username = common.StringPtr(command.Username())
	if command.SensitiveParameterCount() > 0 {
		parameters := make(map[string]string, command.SensitiveParameterCount())
		if err := command.VisitSensitiveParameters(
			func(key string, credential tencenttatport.RuntimeCredential) error {
				parameters[key] = credential.RevealForRequest()
				return nil
			},
		); err != nil {
			return tencenttatport.Invocation{}, newError("tat_invalid_request", false, false)
		}
		encoded, err := json.Marshal(parameters)
		if err != nil {
			return tencenttatport.Invocation{}, newError("tat_request_encode_failed", false, false)
		}
		request.EnableParameter = common.BoolPtr(true)
		request.Parameters = common.StringPtr(string(encoded))
	}
	response, err := sdk.RunCommandWithContext(ctx, request)
	if err != nil {
		return tencenttatport.Invocation{}, classifyError(err, true)
	}
	if response == nil || response.Response == nil ||
		response.Response.InvocationId == nil ||
		strings.TrimSpace(*response.Response.InvocationId) == "" {
		return tencenttatport.Invocation{}, newError("tat_result_unknown", true, true)
	}
	return tencenttatport.Invocation{
		InvocationID: *response.Response.InvocationId,
		CommandID:    stringValue(response.Response.CommandId),
		Status:       tencenttatport.StatusPending,
	}, nil
}

// FindByOperation 在不确定重试前按稳定 operationId 查找近期执行活动。
func (client *Client) FindByOperation(
	ctx context.Context,
	target tencenttatport.Target,
	operationID string,
) (tencenttatport.Invocation, bool, error) {
	if client == nil || ctx == nil || target.Validate() != nil ||
		strings.TrimSpace(operationID) == "" {
		return tencenttatport.Invocation{}, false, newError("tat_invalid_request", false, false)
	}
	sdk, err := client.factory.Client(ctx, target.Region)
	if err != nil {
		return tencenttatport.Invocation{}, false, classifyError(err, false)
	}
	request := tatsdk.NewDescribeInvocationsRequest()
	request.Limit = common.Uint64Ptr(100)
	request.Offset = common.Uint64Ptr(0)
	response, err := sdk.DescribeInvocationsWithContext(ctx, request)
	if err != nil {
		return tencenttatport.Invocation{}, false, classifyError(err, false)
	}
	if response == nil || response.Response == nil {
		return tencenttatport.Invocation{}, false, newError("tat_response_invalid", true, false)
	}
	description := operationDescription(operationID)
	for _, candidate := range response.Response.InvocationSet {
		if candidate == nil || stringValue(candidate.Description) != description ||
			strings.TrimSpace(stringValue(candidate.InvocationId)) == "" {
			continue
		}
		found, inspectErr := client.Inspect(
			ctx,
			target,
			stringValue(candidate.InvocationId),
		)
		if inspectErr == nil {
			return found, true, nil
		}
		if tencenttatport.CodeOf(inspectErr) == "tat_invocation_not_found" {
			continue
		}
		return tencenttatport.Invocation{}, false, inspectErr
	}
	return tencenttatport.Invocation{}, false, nil
}

// Inspect 精确按 invocationId 和 instanceId 查询任务，并始终隐藏输出。
func (client *Client) Inspect(
	ctx context.Context,
	target tencenttatport.Target,
	invocationID string,
) (tencenttatport.Invocation, error) {
	if client == nil || ctx == nil || target.Validate() != nil ||
		strings.TrimSpace(invocationID) == "" {
		return tencenttatport.Invocation{}, newError("tat_invalid_request", false, false)
	}
	sdk, err := client.factory.Client(ctx, target.Region)
	if err != nil {
		return tencenttatport.Invocation{}, classifyError(err, false)
	}
	request := tatsdk.NewDescribeInvocationTasksRequest()
	request.Filters = []*tatsdk.Filter{
		{
			Name:   common.StringPtr("invocation-id"),
			Values: []*string{common.StringPtr(invocationID)},
		},
		{
			Name:   common.StringPtr("instance-id"),
			Values: []*string{common.StringPtr(target.InstanceID)},
		},
	}
	request.Limit = common.Uint64Ptr(100)
	request.Offset = common.Uint64Ptr(0)
	request.HideOutput = common.BoolPtr(true)
	response, err := sdk.DescribeInvocationTasksWithContext(ctx, request)
	if err != nil {
		return tencenttatport.Invocation{}, classifyError(err, false)
	}
	if response == nil || response.Response == nil {
		return tencenttatport.Invocation{}, newError("tat_response_invalid", true, false)
	}
	for _, task := range response.Response.InvocationTaskSet {
		if task == nil || stringValue(task.InvocationId) != invocationID ||
			stringValue(task.InstanceId) != target.InstanceID {
			continue
		}
		status, ok := normalizeStatus(stringValue(task.TaskStatus))
		if !ok {
			return tencenttatport.Invocation{}, newError("tat_response_invalid", true, false)
		}
		return tencenttatport.Invocation{
			InvocationID: invocationID,
			CommandID:    stringValue(task.CommandId),
			Status:       status,
		}, nil
	}
	return tencenttatport.Invocation{}, newError("tat_invocation_not_found", true, false)
}

// Probe 精确查询一个目标的 TAT Agent 在线状态和 OS。
func (client *Client) Probe(
	ctx context.Context,
	target tencenttatport.Target,
) (tencenttatport.AgentStatus, error) {
	if client == nil || ctx == nil || target.Validate() != nil {
		return tencenttatport.AgentStatus{}, newError("tat_invalid_request", false, false)
	}
	sdk, err := client.factory.Client(ctx, target.Region)
	if err != nil {
		return tencenttatport.AgentStatus{}, classifyError(err, false)
	}
	request := tatsdk.NewDescribeAutomationAgentStatusRequest()
	request.InstanceIds = []*string{common.StringPtr(target.InstanceID)}
	request.Limit = common.Uint64Ptr(1)
	response, err := sdk.DescribeAutomationAgentStatusWithContext(ctx, request)
	if err != nil {
		return tencenttatport.AgentStatus{}, classifyError(err, false)
	}
	if response == nil || response.Response == nil {
		return tencenttatport.AgentStatus{}, newError("tat_response_invalid", true, false)
	}
	for _, agent := range response.Response.AutomationAgentSet {
		if agent == nil || stringValue(agent.InstanceId) != target.InstanceID {
			continue
		}
		os, ok := normalizeOS(stringValue(agent.Environment))
		if !ok {
			return tencenttatport.AgentStatus{}, newError("tat_response_invalid", true, false)
		}
		if !tencenttatport.ObservedOSCompatible(target.OS, os) {
			return tencenttatport.AgentStatus{}, newError("tat_os_mismatch", false, false)
		}
		return tencenttatport.AgentStatus{
			Online: strings.EqualFold(stringValue(agent.AgentStatus), "Online"),
			OS:     os,
		}, nil
	}
	return tencenttatport.AgentStatus{}, newError("tat_agent_not_found", false, false)
}

func operationDescription(operationID string) string {
	return operationDescriptionPrefix + operationID
}

func commandName(kind tencenttatport.TemplateKind) string {
	return "chatserver-" + string(kind)
}

func normalizeStatus(raw string) (tencenttatport.Status, bool) {
	switch strings.ToUpper(raw) {
	case "PENDING", "DELIVERING", "DELIVER_DELAYED", "CANCELLING":
		return tencenttatport.StatusPending, true
	case "RUNNING":
		return tencenttatport.StatusRunning, true
	case "SUCCESS":
		return tencenttatport.StatusSucceeded, true
	case "FAILED", "DELIVER_FAILED", "START_FAILED", "PARTIAL_FAILED":
		return tencenttatport.StatusFailed, true
	case "TIMEOUT", "TASK_TIMEOUT":
		return tencenttatport.StatusTimedOut, true
	case "CANCELLED", "TERMINATED", "PARTIAL_CANCELLED":
		return tencenttatport.StatusCancelled, true
	default:
		return "", false
	}
}

func normalizeOS(raw string) (tencenttatport.OS, bool) {
	switch strings.ToLower(raw) {
	case "linux":
		return tencenttatport.OSLinux, true
	case "windows":
		return tencenttatport.OSWindows, true
	case "macos", "darwin":
		return tencenttatport.OSMacOS, true
	default:
		return "", false
	}
}

type tatError struct {
	code      string
	retryable bool
	uncertain bool
}

func newError(code string, retryable bool, uncertain bool) error {
	return &tatError{code: code, retryable: retryable, uncertain: uncertain}
}

func (failure *tatError) Error() string {
	return fmt.Sprintf("腾讯云 TAT 操作失败（%s）", failure.code)
}

func (failure *tatError) TATCode() string { return failure.code }
func (failure *tatError) Retryable() bool { return failure.retryable }
func (failure *tatError) Uncertain() bool { return failure.uncertain }

func classifyError(err error, runMayHaveReachedCloud bool) error {
	if errors.Is(err, context.DeadlineExceeded) {
		return newError("tat_timeout", true, runMayHaveReachedCloud)
	}
	var sdkError *tcerr.TencentCloudSDKError
	if errors.As(err, &sdkError) {
		code := sdkError.GetCode()
		switch {
		case strings.Contains(code, "RequestLimitExceeded") ||
			strings.Contains(code, "LimitExceeded"):
			return newError("tat_throttled", true, false)
		case strings.Contains(code, "AgentStatusNotOnline") ||
			strings.Contains(code, "AgentNotInstalled") ||
			strings.Contains(code, "InstanceStateNotRunning"):
			return newError("tat_agent_offline", true, false)
		case strings.HasPrefix(code, "InternalError") ||
			strings.HasPrefix(code, "FailedOperation") ||
			strings.HasPrefix(code, "ResourceUnavailable"):
			return newError("tat_service_unavailable", true, false)
		case strings.HasPrefix(code, "UnauthorizedOperation") ||
			strings.HasPrefix(code, "AuthFailure") ||
			strings.HasPrefix(code, "InvalidCredential"):
			return newError("tat_unauthorized", false, false)
		case strings.HasPrefix(code, "ResourceNotFound"):
			return newError("tat_instance_not_found", false, false)
		default:
			return newError("tat_invalid_request", false, false)
		}
	}
	if runMayHaveReachedCloud {
		return newError("tat_result_unknown", true, true)
	}
	return newError("tat_network_error", true, false)
}

func stringValue(pointer *string) string {
	if pointer == nil {
		return ""
	}
	return *pointer
}

var _ tencenttatport.Client = (*Client)(nil)
