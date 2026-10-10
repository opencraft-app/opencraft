package tat

import (
	"context"
	"encoding/base64"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/tencentcloud/tencentcloud-sdk-go/tencentcloud/common"
	tcerr "github.com/tencentcloud/tencentcloud-sdk-go/tencentcloud/common/errors"
	tatsdk "github.com/tencentcloud/tencentcloud-sdk-go/tencentcloud/tat/v20201028"

	tencenttatport "chatserver/internal/ports/tencenttat"
)

const (
	adapterOperationID = "019b1f57-94de-7825-bbaa-877aa4756d48"
	adapterInstanceID  = "rins-adapter-test"
)

type fakeSDKFactory struct {
	regions []string
	client  *fakeSDKClient
	err     error
}

func (factory *fakeSDKFactory) Client(
	_ context.Context,
	region string,
) (sdkClient, error) {
	factory.regions = append(factory.regions, region)
	return factory.client, factory.err
}

type fakeSDKClient struct {
	runRequest     *tatsdk.RunCommandRequest
	runResponse    *tatsdk.RunCommandResponse
	runErr         error
	invocationsReq *tatsdk.DescribeInvocationsRequest
	invocations    *tatsdk.DescribeInvocationsResponse
	invocationsErr error
	tasksReq       *tatsdk.DescribeInvocationTasksRequest
	tasks          *tatsdk.DescribeInvocationTasksResponse
	tasksErr       error
	agentReq       *tatsdk.DescribeAutomationAgentStatusRequest
	agent          *tatsdk.DescribeAutomationAgentStatusResponse
	agentErr       error
	registerReq    *tatsdk.CreateRegisterCodeRequest
	register       *tatsdk.CreateRegisterCodeResponse
	registerErr    error
	registeredReq  *tatsdk.DescribeRegisterInstancesRequest
	registered     *tatsdk.DescribeRegisterInstancesResponse
	registeredErr  error
}

func (client *fakeSDKClient) DescribeRegisterInstancesWithContext(
	_ context.Context,
	request *tatsdk.DescribeRegisterInstancesRequest,
) (*tatsdk.DescribeRegisterInstancesResponse, error) {
	client.registeredReq = request
	return client.registered, client.registeredErr
}

func (client *fakeSDKClient) CreateRegisterCodeWithContext(
	_ context.Context,
	request *tatsdk.CreateRegisterCodeRequest,
) (*tatsdk.CreateRegisterCodeResponse, error) {
	client.registerReq = request
	return client.register, client.registerErr
}

func (client *fakeSDKClient) RunCommandWithContext(
	_ context.Context,
	request *tatsdk.RunCommandRequest,
) (*tatsdk.RunCommandResponse, error) {
	client.runRequest = request
	return client.runResponse, client.runErr
}

func (client *fakeSDKClient) DescribeInvocationsWithContext(
	_ context.Context,
	request *tatsdk.DescribeInvocationsRequest,
) (*tatsdk.DescribeInvocationsResponse, error) {
	client.invocationsReq = request
	return client.invocations, client.invocationsErr
}

func (client *fakeSDKClient) DescribeInvocationTasksWithContext(
	_ context.Context,
	request *tatsdk.DescribeInvocationTasksRequest,
) (*tatsdk.DescribeInvocationTasksResponse, error) {
	client.tasksReq = request
	return client.tasks, client.tasksErr
}

func (client *fakeSDKClient) DescribeAutomationAgentStatusWithContext(
	_ context.Context,
	request *tatsdk.DescribeAutomationAgentStatusRequest,
) (*tatsdk.DescribeAutomationAgentStatusResponse, error) {
	client.agentReq = request
	return client.agent, client.agentErr
}

func TestRunUsesExactRegionInstanceAndHiddenParameter(t *testing.T) {
	sdk := &fakeSDKClient{
		runResponse: &tatsdk.RunCommandResponse{
			Response: &tatsdk.RunCommandResponseParams{
				CommandId:    common.StringPtr("cmd-test"),
				InvocationId: common.StringPtr("inv-test"),
				RequestId:    common.StringPtr("request-test"),
			},
		},
	}
	factory := &fakeSDKFactory{client: sdk}
	client := newTestAdapter(t, factory)
	command := credentialCommand(t)

	invocation, err := client.Run(context.Background(), command)
	if err != nil {
		t.Fatal(err)
	}
	if len(factory.regions) != 1 || factory.regions[0] != "ap-beijing" {
		t.Fatalf("regions = %#v", factory.regions)
	}
	request := sdk.runRequest
	if request == nil || len(request.InstanceIds) != 1 ||
		value(request.InstanceIds[0]) != adapterInstanceID ||
		value(request.Description) != operationDescription(adapterOperationID) ||
		value(request.CommandType) != "SHELL" ||
		value(request.WorkingDirectory) != "/var/lib/chatserver-agent" ||
		request.SaveCommand == nil || *request.SaveCommand ||
		request.EnableParameter == nil || !*request.EnableParameter {
		t.Fatalf("RunCommand request = %#v", request)
	}
	decoded, err := base64.StdEncoding.DecodeString(value(request.Content))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(decoded), "test-runtime-secret") ||
		!strings.Contains(string(decoded), "{{tat-hidden:runtimeCredential}}") {
		t.Fatalf("decoded command = %q", decoded)
	}
	if value(request.Parameters) !=
		`{"runtimeCredential":"arc_test-runtime-secret-1234567890"}` {
		t.Fatalf("parameters = %q", value(request.Parameters))
	}
	if invocation.InvocationID != "inv-test" ||
		invocation.CommandID != "cmd-test" ||
		invocation.Status != tencenttatport.StatusPending {
		t.Fatalf("invocation = %#v", invocation)
	}
}

func TestCreateRegistrationUsesSingleOneHourCodeWithoutPersistingValue(
	t *testing.T,
) {
	sdk := &fakeSDKClient{
		register: &tatsdk.CreateRegisterCodeResponse{
			Response: &tatsdk.CreateRegisterCodeResponseParams{
				RegisterCodeId:    common.StringPtr("register-code-id"),
				RegisterCodeValue: common.StringPtr("register-code-value"),
				RequestId:         common.StringPtr("request-test"),
			},
		},
	}
	factory := &fakeSDKFactory{client: sdk}
	client := newTestAdapter(t, factory)
	before := time.Now().UTC()
	registration, err := client.CreateRegistration(
		context.Background(),
		tencenttatport.RegistrationRequest{
			Region:        "ap-beijing",
			Description:   "chatserver Computer test",
			NamePrefix:    "chatserver-test",
			RegisterLimit: 1,
			EffectiveTime: time.Hour,
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	if len(factory.regions) != 1 || factory.regions[0] != "ap-beijing" {
		t.Fatalf("regions = %#v", factory.regions)
	}
	request := sdk.registerReq
	if request == nil ||
		value(request.Description) != "chatserver Computer test" ||
		value(request.InstanceNamePrefix) != "chatserver-test" ||
		value(request.RegisterLimit) != int64(1) ||
		value(request.EffectiveTime) != int64(1) {
		t.Fatalf("CreateRegisterCode request = %#v", request)
	}
	if registration.CodeID != "register-code-id" ||
		registration.CodeValue != "register-code-value" ||
		registration.ExpiresAt.Before(before.Add(59*time.Minute)) ||
		registration.ExpiresAt.After(time.Now().UTC().Add(61*time.Minute)) {
		t.Fatalf("registration = %#v", registration)
	}
}

func TestNewCredentialClient使用后台专属静态凭据(t *testing.T) {
	const testSecret = "test-only-secret1"
	client, err := NewCredentialClient(
		"AKIDtest-only-platform-id",
		testSecret,
		15*time.Second,
	)
	if err != nil {
		t.Fatal(err)
	}
	factory, ok := client.factory.(providerFactory)
	if !ok {
		t.Fatalf("factory type = %T", client.factory)
	}
	credential, err := factory.provider.GetCredential()
	if err != nil {
		t.Fatal(err)
	}
	if credential.GetSecretId() != "AKIDtest-only-platform-id" ||
		credential.GetSecretKey() != testSecret {
		t.Fatal("静态凭据没有进入后台 TAT provider")
	}
}

func TestNewCredentialClient拒绝换行和空凭据(t *testing.T) {
	for _, value := range []string{"", "short", "AKIDline\nbreak"} {
		if _, err := NewCredentialClient(value, "test-only-secret1", 15*time.Second); err == nil {
			t.Fatalf("NewCredentialClient() accepted secret id %q", value)
		}
	}
}

func TestFindManagedByComputerTagReturnsUniqueRustBridge(t *testing.T) {
	sdk := &fakeSDKClient{
		registered: &tatsdk.DescribeRegisterInstancesResponse{
			Response: &tatsdk.DescribeRegisterInstancesResponseParams{
				RegisterInstanceSet: []*tatsdk.RegisterInstanceInfo{{
					InstanceId: common.StringPtr("rins-test0001"),
					SystemName: common.StringPtr("Linux"),
					Status:     common.StringPtr("Online"),
					Tags: []*tatsdk.Tag{{
						Key:   common.StringPtr("agent-network-computer-id"),
						Value: common.StringPtr(adapterOperationID),
					}},
				}},
			},
		},
	}
	factory := &fakeSDKFactory{client: sdk}
	client := newTestAdapter(t, factory)
	instance, found, err := client.FindManagedByComputerTag(
		context.Background(), "ap-beijing", adapterOperationID,
	)
	if err != nil || !found {
		t.Fatalf("FindManagedByComputerTag() = (%#v, %v, %v)", instance, found, err)
	}
	if instance.InstanceID != "rins-test0001" ||
		instance.OS != tencenttatport.OSLinux ||
		!instance.Online {
		t.Fatalf("instance = %#v", instance)
	}
	request := sdk.registeredReq
	if request == nil || len(request.Filters) != 1 ||
		value(request.Filters[0].Name) !=
			"tag:agent-network-computer-id" ||
		len(request.Filters[0].Values) != 1 ||
		value(request.Filters[0].Values[0]) != adapterOperationID ||
		value(request.Limit) != int64(2) {
		t.Fatalf("DescribeRegisterInstances request = %#v", request)
	}
}

func TestFindByOperationQueriesBeforeRetryAndConfirmsExactInstance(t *testing.T) {
	sdk := &fakeSDKClient{
		invocations: invocationsResponse(
			invocation("inv-other", operationDescription("019b1f57-94de-7825-bbaa-877aa4756d49")),
			invocation("inv-match", operationDescription(adapterOperationID)),
		),
		tasks: tasksResponse(task("inv-match", adapterInstanceID, "RUNNING")),
	}
	factory := &fakeSDKFactory{client: sdk}
	client := newTestAdapter(t, factory)

	found, ok, err := client.FindByOperation(
		context.Background(),
		linuxTarget(),
		adapterOperationID,
	)
	if err != nil || !ok {
		t.Fatalf("FindByOperation() = (%#v, %v, %v)", found, ok, err)
	}
	if found.InvocationID != "inv-match" ||
		found.Status != tencenttatport.StatusRunning ||
		len(factory.regions) != 2 ||
		factory.regions[0] != "ap-beijing" ||
		factory.regions[1] != "ap-beijing" {
		t.Fatalf("found/regions = (%#v, %#v)", found, factory.regions)
	}
	if sdk.invocationsReq == nil || value(sdk.invocationsReq.Limit) != uint64(100) {
		t.Fatalf("DescribeInvocations request = %#v", sdk.invocationsReq)
	}
	assertTaskFilters(t, sdk.tasksReq, "inv-match", adapterInstanceID)
}

func TestInspectHidesOutputAndNormalizesTerminalStates(t *testing.T) {
	for _, test := range []struct {
		raw  string
		want tencenttatport.Status
	}{
		{"SUCCESS", tencenttatport.StatusSucceeded},
		{"FAILED", tencenttatport.StatusFailed},
		{"DELIVER_FAILED", tencenttatport.StatusFailed},
		{"TIMEOUT", tencenttatport.StatusTimedOut},
		{"TASK_TIMEOUT", tencenttatport.StatusTimedOut},
		{"CANCELLED", tencenttatport.StatusCancelled},
		{"TERMINATED", tencenttatport.StatusCancelled},
		{"PENDING", tencenttatport.StatusPending},
	} {
		t.Run(test.raw, func(t *testing.T) {
			sdk := &fakeSDKClient{
				tasks: tasksResponse(task("inv-test", adapterInstanceID, test.raw)),
			}
			client := newTestAdapter(t, &fakeSDKFactory{client: sdk})
			got, err := client.Inspect(
				context.Background(),
				linuxTarget(),
				"inv-test",
			)
			if err != nil || got.Status != test.want {
				t.Fatalf("Inspect() = (%#v, %v)", got, err)
			}
			if sdk.tasksReq.HideOutput == nil || !*sdk.tasksReq.HideOutput {
				t.Fatal("DescribeInvocationTasks did not hide output")
			}
		})
	}
}

func TestProbeUsesExactTargetAndNormalizesOS(t *testing.T) {
	sdk := &fakeSDKClient{
		agent: &tatsdk.DescribeAutomationAgentStatusResponse{
			Response: &tatsdk.DescribeAutomationAgentStatusResponseParams{
				AutomationAgentSet: []*tatsdk.AutomationAgentInfo{{
					InstanceId:  common.StringPtr(adapterInstanceID),
					AgentStatus: common.StringPtr("Online"),
					Environment: common.StringPtr("Linux"),
				}},
			},
		},
	}
	client := newTestAdapter(t, &fakeSDKFactory{client: sdk})
	status, err := client.Probe(context.Background(), linuxTarget())
	if err != nil || !status.Online || status.OS != tencenttatport.OSLinux {
		t.Fatalf("Probe() = (%#v, %v)", status, err)
	}
	if len(sdk.agentReq.InstanceIds) != 1 ||
		value(sdk.agentReq.InstanceIds[0]) != adapterInstanceID {
		t.Fatalf("agent request = %#v", sdk.agentReq)
	}
}

func TestProbeAcceptsLinuxWireEnvironmentForManagedMacOSBridge(t *testing.T) {
	sdk := &fakeSDKClient{
		agent: &tatsdk.DescribeAutomationAgentStatusResponse{
			Response: &tatsdk.DescribeAutomationAgentStatusResponseParams{
				AutomationAgentSet: []*tatsdk.AutomationAgentInfo{{
					InstanceId:  common.StringPtr(adapterInstanceID),
					AgentStatus: common.StringPtr("Online"),
					Environment: common.StringPtr("Linux"),
				}},
			},
		},
	}
	client := newTestAdapter(t, &fakeSDKFactory{client: sdk})
	target := linuxTarget()
	target.OS = tencenttatport.OSMacOS

	status, err := client.Probe(context.Background(), target)

	if err != nil || !status.Online || status.OS != tencenttatport.OSLinux {
		t.Fatalf("Probe() = (%#v, %v)", status, err)
	}
}

func TestErrorsMapToStableNonSensitiveCodes(t *testing.T) {
	tests := []struct {
		name      string
		err       error
		wantCode  string
		retryable bool
		uncertain bool
	}{
		{
			name:      "throttled",
			err:       tcerr.NewTencentCloudSDKError("RequestLimitExceeded", "raw provider detail", "request"),
			wantCode:  "tat_throttled",
			retryable: true,
		},
		{
			name:      "offline",
			err:       tcerr.NewTencentCloudSDKError("ResourceUnavailable.AgentStatusNotOnline", "raw", "request"),
			wantCode:  "tat_agent_offline",
			retryable: true,
		},
		{
			name:      "auth failure",
			err:       tcerr.NewTencentCloudSDKError("AuthFailure.SecretIdNotFound", "raw", "request"),
			wantCode:  "tat_unauthorized",
			retryable: false,
		},
		{
			name:      "invalid credential",
			err:       tcerr.NewTencentCloudSDKError("InvalidCredential", "raw", "request"),
			wantCode:  "tat_unauthorized",
			retryable: false,
		},
		{
			name:      "timeout unknown",
			err:       context.DeadlineExceeded,
			wantCode:  "tat_timeout",
			retryable: true,
			uncertain: true,
		},
		{
			name:      "network unknown",
			err:       errors.New("network failed with test-runtime-secret"),
			wantCode:  "tat_result_unknown",
			retryable: true,
			uncertain: true,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			sdk := &fakeSDKClient{runErr: test.err}
			client := newTestAdapter(t, &fakeSDKFactory{client: sdk})
			_, err := client.Run(context.Background(), nonSecretCommand(t))
			if tencenttatport.CodeOf(err) != test.wantCode ||
				tencenttatport.IsRetryable(err) != test.retryable ||
				tencenttatport.IsUncertain(err) != test.uncertain ||
				strings.Contains(err.Error(), "raw") ||
				strings.Contains(err.Error(), "test-runtime-secret") {
				t.Fatalf("classified error = %v", err)
			}
		})
	}
}

func newTestAdapter(t *testing.T, factory sdkFactory) *Client {
	t.Helper()
	client, err := newClient(factory)
	if err != nil {
		t.Fatal(err)
	}
	return client
}

func credentialCommand(t *testing.T) tencenttatport.Command {
	t.Helper()
	credential, err := tencenttatport.NewRuntimeCredential(
		"arc_test-runtime-secret-1234567890",
	)
	if err != nil {
		t.Fatal(err)
	}
	command, err := tencenttatport.NewCommand(tencenttatport.CommandSpec{
		Template:         tencenttatport.TemplateCredentialInstall,
		OperationID:      adapterOperationID,
		Target:           linuxTarget(),
		CommandType:      tencenttatport.CommandShell,
		Content:          "printf '%s' '{{tat-hidden:runtimeCredential}}'",
		WorkingDirectory: "/var/lib/chatserver-agent",
		Username:         "root",
		Timeout:          time.Minute,
		SensitiveParameters: map[string]tencenttatport.RuntimeCredential{
			"runtimeCredential": credential,
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	return command
}

func nonSecretCommand(t *testing.T) tencenttatport.Command {
	t.Helper()
	command, err := tencenttatport.NewCommand(tencenttatport.CommandSpec{
		Template:         tencenttatport.TemplateProbe,
		OperationID:      adapterOperationID,
		Target:           linuxTarget(),
		CommandType:      tencenttatport.CommandShell,
		Content:          "true",
		WorkingDirectory: "/var/lib/chatserver-agent",
		Username:         "root",
		Timeout:          time.Minute,
	})
	if err != nil {
		t.Fatal(err)
	}
	return command
}

func TestNormalizeOSAcceptsMacOSAliasesForForwardCompatibility(t *testing.T) {
	for _, raw := range []string{"macos", "MacOS", "darwin", "Darwin"} {
		osType, ok := normalizeOS(raw)
		if !ok || osType != tencenttatport.OSMacOS {
			t.Fatalf("normalizeOS(%q) = (%q, %v)", raw, osType, ok)
		}
	}
}

func linuxTarget() tencenttatport.Target {
	return tencenttatport.Target{
		Region:     "ap-beijing",
		InstanceID: adapterInstanceID,
		OS:         tencenttatport.OSLinux,
	}
}

func invocationsResponse(values ...*tatsdk.Invocation) *tatsdk.DescribeInvocationsResponse {
	return &tatsdk.DescribeInvocationsResponse{
		Response: &tatsdk.DescribeInvocationsResponseParams{
			InvocationSet: values,
		},
	}
}

func invocation(id string, description string) *tatsdk.Invocation {
	return &tatsdk.Invocation{
		InvocationId: common.StringPtr(id),
		Description:  common.StringPtr(description),
	}
}

func tasksResponse(values ...*tatsdk.InvocationTask) *tatsdk.DescribeInvocationTasksResponse {
	return &tatsdk.DescribeInvocationTasksResponse{
		Response: &tatsdk.DescribeInvocationTasksResponseParams{
			InvocationTaskSet: values,
		},
	}
}

func task(invocationID string, instanceID string, status string) *tatsdk.InvocationTask {
	return &tatsdk.InvocationTask{
		InvocationId: common.StringPtr(invocationID),
		InstanceId:   common.StringPtr(instanceID),
		TaskStatus:   common.StringPtr(status),
		CommandId:    common.StringPtr("cmd-test"),
	}
}

func assertTaskFilters(
	t *testing.T,
	request *tatsdk.DescribeInvocationTasksRequest,
	invocationID string,
	instanceID string,
) {
	t.Helper()
	if request == nil || len(request.Filters) != 2 {
		t.Fatalf("task request = %#v", request)
	}
	got := map[string]string{}
	for _, filter := range request.Filters {
		if filter != nil && len(filter.Values) == 1 {
			got[value(filter.Name)] = value(filter.Values[0])
		}
	}
	if got["invocation-id"] != invocationID || got["instance-id"] != instanceID {
		t.Fatalf("task filters = %#v", got)
	}
}

func value[T any](pointer *T) T {
	var zero T
	if pointer == nil {
		return zero
	}
	return *pointer
}
