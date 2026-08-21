package instance

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	pllmgateway "ctl/pkg/adapter/llmgateway"
	psandbox "ctl/pkg/adapter/sandbox"
	"ctl/pkg/config"
	pctx "ctl/pkg/context"
	"ctl/pkg/errcode"
	modelinstance "ctl/pkg/model/instance"

	"go.uber.org/zap"
)

type createTaskInstanceDaoStub struct {
	modelinstance.Dao
	entity    *modelinstance.Entity
	updateErr error
	updates   []map[string]interface{}
}

func (s *createTaskInstanceDaoStub) GetByInstanceID(_ pctx.Context, _ string) (*modelinstance.Entity, error) {
	return s.entity, nil
}

func (s *createTaskInstanceDaoStub) UpdateWithStatusPrecondition(_ pctx.Context, _ int64, _ []string, updates map[string]interface{}) error {
	if s.updateErr != nil {
		return s.updateErr
	}
	cloned := make(map[string]interface{}, len(updates))
	for k, v := range updates {
		cloned[k] = v
	}
	s.updates = append(s.updates, cloned)
	if s.entity != nil {
		if sandboxID, ok := updates[modelinstance.ColumnSandboxID].(string); ok {
			s.entity.SandboxId = sandboxID
		}
		if keyID, ok := updates[modelinstance.ColumnAiGatewayKeyID].(string); ok {
			s.entity.AiGatewayKeyID = keyID
		}
		if token, ok := updates[modelinstance.ColumnGatewayAuthToken].(string); ok {
			s.entity.GatewayAuthToken = token
		}
		if status, ok := updates[modelinstance.ColumnStatus].(string); ok {
			s.entity.Status = status
		}
	}
	return nil
}

type createTaskSandboxAdapterStub struct {
	createResp     *psandbox.Sandbox
	pools          []psandbox.Pool
	processBatches [][]psandbox.ProcessStreamEvent
	processCalls   []psandbox.ProcessStartRequest
	ptyBatches     [][]psandbox.PtyExecStreamEvent
	ptyCalls       []psandbox.PtyExecStreamRequest
	deletedIDs     []string
	invokeResult   *psandbox.ExecCommandResult
	invokeErr      error
	invokeCalls    []struct {
		sandboxID  string
		commandID  string
		parameters map[string]string
		timeoutSec int
	}
	beforeInvoke func()
}

func (s *createTaskSandboxAdapterStub) InvokeCommand(_ context.Context, sandboxID, commandID string, parameters map[string]string, timeoutSec int) (*psandbox.ExecCommandResult, error) {
	cloned := make(map[string]string, len(parameters))
	for key, value := range parameters {
		cloned[key] = value
	}
	s.invokeCalls = append(s.invokeCalls, struct {
		sandboxID  string
		commandID  string
		parameters map[string]string
		timeoutSec int
	}{sandboxID: sandboxID, commandID: commandID, parameters: cloned, timeoutSec: timeoutSec})
	if s.beforeInvoke != nil {
		s.beforeInvoke()
	}
	if s.invokeResult != nil {
		return s.invokeResult, s.invokeErr
	}
	return &psandbox.ExecCommandResult{Status: "SUCCESS", ExitCode: 0}, s.invokeErr
}

func (s *createTaskSandboxAdapterStub) CreateSandbox(_ context.Context, _ *psandbox.CreateSandboxRequest) (*psandbox.Sandbox, error) {
	if s.createResp != nil {
		return s.createResp, nil
	}
	return &psandbox.Sandbox{SandboxID: "sbx-create-1", TemplateID: "tpl-1"}, nil
}
func (s *createTaskSandboxAdapterStub) DeleteSandbox(_ context.Context, sandboxID string) error {
	s.deletedIDs = append(s.deletedIDs, sandboxID)
	return nil
}
func (s *createTaskSandboxAdapterStub) StartProcessStream(_ context.Context, _ string, req *psandbox.ProcessStartRequest, onEvent func(psandbox.ProcessStreamEvent) error) error {
	if req != nil {
		cloned := *req
		cloned.Args = append([]string(nil), req.Args...)
		s.processCalls = append(s.processCalls, cloned)
	}
	events := []psandbox.ProcessStreamEvent{{Ended: true, ExitCode: 0, Status: "SUCCESS"}}
	if len(s.processBatches) > 0 {
		events = s.processBatches[0]
		s.processBatches = s.processBatches[1:]
	}
	for _, ev := range events {
		if err := onEvent(ev); err != nil {
			return err
		}
	}
	return nil
}
func (s *createTaskSandboxAdapterStub) StreamPtyCommand(_ context.Context, _ string, req *psandbox.PtyExecStreamRequest, onEvent func(psandbox.PtyExecStreamEvent) error) error {
	if req != nil {
		cloned := *req
		s.ptyCalls = append(s.ptyCalls, cloned)
	}
	events := []psandbox.PtyExecStreamEvent{
		{Type: "started", ExecutionID: "pty:create-onboard"},
		{Type: "finished", ExecutionID: "pty:create-onboard", Status: "SUCCESS", ExitCode: 0},
	}
	if len(s.ptyBatches) > 0 {
		events = s.ptyBatches[0]
		s.ptyBatches = s.ptyBatches[1:]
	}
	for _, ev := range events {
		if err := onEvent(ev); err != nil {
			return err
		}
	}
	return nil
}
func (s *createTaskSandboxAdapterStub) GetSandbox(context.Context, string) (*psandbox.SandboxDetail, error) {
	return nil, nil
}
func (s *createTaskSandboxAdapterStub) ListSandboxes(context.Context, *psandbox.ListSandboxesRequest) ([]psandbox.ListedSandbox, error) {
	return nil, nil
}
func (s *createTaskSandboxAdapterStub) ListPools(context.Context) ([]psandbox.Pool, error) {
	if s.pools != nil {
		return s.pools, nil
	}
	return nil, nil
}
func (s *createTaskSandboxAdapterStub) ListPoolInstances(context.Context, string) ([]psandbox.PoolInstance, error) {
	return nil, nil
}
func (s *createTaskSandboxAdapterStub) PauseSandbox(context.Context, string) error { return nil }
func (s *createTaskSandboxAdapterStub) ResumeSandbox(context.Context, string, *psandbox.ResumeSandboxRequest) (*psandbox.Sandbox, error) {
	return nil, nil
}
func (s *createTaskSandboxAdapterStub) SetTimeout(context.Context, string, int32) error { return nil }
func (s *createTaskSandboxAdapterStub) Refresh(context.Context, string, int32) error    { return nil }
func (s *createTaskSandboxAdapterStub) GetLogs(context.Context, string, *psandbox.GetLogsRequest) (*psandbox.SandboxLogs, error) {
	return nil, nil
}
func (s *createTaskSandboxAdapterStub) StartTerminalSession(context.Context, string) (*psandbox.TerminalSession, error) {
	return nil, nil
}
func (s *createTaskSandboxAdapterStub) ExecCommand(context.Context, string, string, int) (*psandbox.ExecCommandResult, error) {
	return nil, nil
}
func (s *createTaskSandboxAdapterStub) GetCommandResult(context.Context, string, string) (*psandbox.ExecCommandResult, error) {
	return nil, nil
}
func (s *createTaskSandboxAdapterStub) RunProcessWithStdin(context.Context, string, *psandbox.ProcessStartRequest, []byte) (*psandbox.ExecCommandResult, error) {
	return &psandbox.ExecCommandResult{Status: "SUCCESS", ExitCode: 0}, nil
}
func (s *createTaskSandboxAdapterStub) SendProcessSignal(context.Context, string, uint32, string) error {
	return nil
}
func (s *createTaskSandboxAdapterStub) CreateSnapshot(context.Context, string, *psandbox.CreateSnapshotRequest) (*psandbox.CreateSnapshotResponse, error) {
	panic("unexpected call")
}
func (s *createTaskSandboxAdapterStub) GetSnapshotStatus(context.Context, string, string) (*psandbox.GetSnapshotStatusResponse, error) {
	panic("unexpected call")
}

type createTaskLLMGatewayAdapterStub struct {
	pllmgateway.Adapter
	createResp  *pllmgateway.CreateApiKeyResponse
	createCalls int
	ensureErr   error
	ensureCalls []struct {
		userID   string
		nickname string
	}
	revokeErrByKeyID map[string]error
	revoked          []string
}

func (s *createTaskLLMGatewayAdapterStub) CreateApiKey(_ context.Context, _ string, _ string) (*pllmgateway.CreateApiKeyResponse, error) {
	s.createCalls++
	if s.createResp != nil {
		return s.createResp, nil
	}
	return &pllmgateway.CreateApiKeyResponse{KeyID: "key-create-1", APIKey: "api-create-1"}, nil
}
func (s *createTaskLLMGatewayAdapterStub) EnsureUser(_ context.Context, userID string, nickname string) (*pllmgateway.EnsureUserResponse, error) {
	s.ensureCalls = append(s.ensureCalls, struct {
		userID   string
		nickname string
	}{userID: userID, nickname: nickname})
	if s.ensureErr != nil {
		return nil, s.ensureErr
	}
	return &pllmgateway.EnsureUserResponse{UserID: userID, Result: "created"}, nil
}
func (s *createTaskLLMGatewayAdapterStub) RevokeApiKey(_ context.Context, keyID string) error {
	s.revoked = append(s.revoked, keyID)
	if s.revokeErrByKeyID != nil {
		if err := s.revokeErrByKeyID[keyID]; err != nil {
			return err
		}
	}
	return nil
}
func (s *createTaskLLMGatewayAdapterStub) GetUserUsage(_ context.Context, _ string) (*pllmgateway.UserUsageResponse, error) {
	return &pllmgateway.UserUsageResponse{}, nil
}
func (s *createTaskLLMGatewayAdapterStub) GetActiveSubscription(_ context.Context, _ string) (*pllmgateway.Subscription, error) {
	return nil, nil
}
func (s *createTaskLLMGatewayAdapterStub) ListActiveSubscriptions(_ context.Context, _ string) (*pllmgateway.ActiveSubscriptionList, error) {
	return &pllmgateway.ActiveSubscriptionList{Subscriptions: []pllmgateway.Subscription{}}, nil
}

func installCreateTaskAiGatewayConfig(t *testing.T) {
	t.Helper()

	prev := config.ServerConf
	config.ServerConf = &config.GlobalConfig{
		AdapterConfig: &config.AdapterConfig{
			LLMGateway: &config.LLMGatewayConfig{
				Enabled:                    true,
				BaseURL:                    "https://llmgateway.test",
				DefaultBaseURL:             "https://model.internal/v1",
				DefaultModelID:             "kimi-k2.5",
				DefaultCompatibility:       "openai",
				DefaultGatewayPort:         18789,
				NewAllocationUserAllowlist: []string{"*"},
			},
		},
	}
	t.Cleanup(func() {
		config.ServerConf = prev
	})
}

func legacyPassEntitlementAlreadyReady(context.Context, string, time.Time) error { return nil }

func TestProvisionAiGatewayOnCreateDoesNotIssueKeyWhenLegacyEntitlementMigrationFails(t *testing.T) {
	installCreateTaskAiGatewayConfig(t)

	llm := &createTaskLLMGatewayAdapterStub{}
	logic := &logic{
		llmGatewayAdapter: llm,
		logger:            zap.NewNop(),
		legacyPassEntitlementEnsurer: func(_ context.Context, userID string, _ time.Time) error {
			if userID != "user-migration-fail" {
				t.Fatalf("userID = %q", userID)
			}
			return errors.New("trade unavailable")
		},
	}
	ctx := pctx.NewContext(nil).WithUserID("user-migration-fail")
	err := logic.provisionAiGatewayOnCreate(ctx, &modelinstance.Entity{InstanceId: "ins-migration-fail"}, "sbx-migration-fail")
	if err == nil || !strings.Contains(err.Error(), "trade unavailable") {
		t.Fatalf("error = %v", err)
	}
	if llm.createCalls != 0 {
		t.Fatalf("create-api-key calls = %d, want 0", llm.createCalls)
	}
}

func TestRunCreateInstanceTaskProvisionsAiGatewayOnCreate(t *testing.T) {
	installCreateTaskAiGatewayConfig(t)

	instanceDao := &createTaskInstanceDaoStub{
		entity: &modelinstance.Entity{
			Id:         1,
			InstanceId: "ins-create-onboard",
			Status:     modelinstance.InstanceStatusCreating,
			CreatedAt:  time.Now().UTC(),
		},
	}
	sandboxAdapter := &createTaskSandboxAdapterStub{
		createResp: &psandbox.Sandbox{SandboxID: "sbx-create-onboard", TemplateID: "tpl-create"},
		pools:      []psandbox.Pool{{ID: "tpl-create", Status: "active", CapacityState: "active"}},
	}
	aiGatewayAdapter := &createTaskLLMGatewayAdapterStub{
		createResp: &pllmgateway.CreateApiKeyResponse{KeyID: "key-create-1", APIKey: "api-create-1"},
	}

	logic := &logic{
		instanceDao:                  instanceDao,
		sandboxAdapter:               sandboxAdapter,
		llmGatewayAdapter:            aiGatewayAdapter,
		logger:                       zap.NewNop(),
		defaultTemplate:              "tpl-create",
		candidateTemplates:           []string{"tpl-create"},
		legacyPassEntitlementEnsurer: legacyPassEntitlementAlreadyReady,
	}
	ctx := pctx.NewContext(nil).WithUserID("user-create-1")

	err := logic.RunCreateInstanceTask(ctx, &CreateInstanceTaskPayload{InstanceID: "ins-create-onboard", Timeout: 600})
	if err != nil {
		t.Fatalf("run create instance task: %v", err)
	}
	if instanceDao.entity.Status != modelinstance.InstanceStatusRunning {
		t.Fatalf("expected instance to become running, got %s", instanceDao.entity.Status)
	}
	if instanceDao.entity.SandboxId != "sbx-create-onboard" {
		t.Fatalf("expected sandbox id to persist, got %s", instanceDao.entity.SandboxId)
	}
	if instanceDao.entity.AiGatewayKeyID != "key-create-1" {
		t.Fatalf("expected ai gateway key to persist, got %s", instanceDao.entity.AiGatewayKeyID)
	}
	if strings.TrimSpace(instanceDao.entity.GatewayAuthToken) == "" {
		t.Fatal("expected gateway auth token to persist")
	}
	if len(aiGatewayAdapter.ensureCalls) != 1 || aiGatewayAdapter.ensureCalls[0].userID != "user-create-1" {
		t.Fatalf("expected ensure user to run once before key creation, got %+v", aiGatewayAdapter.ensureCalls)
	}
	if len(sandboxAdapter.processCalls) != 0 || len(sandboxAdapter.ptyCalls) != 2 {
		t.Fatalf("expected two TAT PTY onboard calls, process=%d pty=%d", len(sandboxAdapter.processCalls), len(sandboxAdapter.ptyCalls))
	}
	if !strings.Contains(sandboxAdapter.ptyCalls[0].Command, "command -v acli") || !strings.Contains(sandboxAdapter.ptyCalls[0].Command, "curl -fsSL -z /usr/local/bin/harness") {
		t.Fatalf("expected first TAT call to prefer acli and fall back to harness install, got %q", sandboxAdapter.ptyCalls[0].Command)
	}
	if !strings.Contains(sandboxAdapter.ptyCalls[1].Command, "target_user='agentuser'") ||
		!strings.Contains(sandboxAdapter.ptyCalls[1].Command, "acli provider save") ||
		!strings.Contains(sandboxAdapter.ptyCalls[1].Command, "harness model set") {
		t.Fatalf("expected second TAT call to prefer acli provider save and fall back to harness model set as agentuser, got %q", sandboxAdapter.ptyCalls[1].Command)
	}
	if !strings.Contains(sandboxAdapter.ptyCalls[1].Command, "--name") ||
		!strings.Contains(sandboxAdapter.ptyCalls[1].Command, "acli model switch --model") ||
		!strings.Contains(sandboxAdapter.ptyCalls[1].Command, "--model-name") ||
		!strings.Contains(sandboxAdapter.ptyCalls[1].Command, "kimi-k2.5") ||
		!strings.Contains(sandboxAdapter.ptyCalls[1].Command, "switch_model=") ||
		!strings.Contains(sandboxAdapter.ptyCalls[1].Command, "model_name") ||
		!strings.Contains(sandboxAdapter.ptyCalls[1].Command, "--model \"$switch_model\"") ||
		strings.Contains(sandboxAdapter.ptyCalls[1].Command, "--agent") ||
		!strings.Contains(sandboxAdapter.ptyCalls[1].Command, "--api") ||
		!strings.Contains(sandboxAdapter.ptyCalls[1].Command, "--api-key \"$ACLI_SECRET_API_KEY\"") ||
		!strings.Contains(sandboxAdapter.ptyCalls[1].Command, "--model-id") ||
		!strings.Contains(sandboxAdapter.ptyCalls[1].Command, "--model-name") ||
		!strings.Contains(sandboxAdapter.ptyCalls[1].Command, "custom") {
		t.Fatalf("expected hermes provider name to stay fixed as custom, got %q", sandboxAdapter.ptyCalls[1].Command)
	}
	if sandboxAdapter.ptyCalls[1].Username != hermesRuntimeUser || sandboxAdapter.ptyCalls[1].WorkingDirectory != "/home/agentuser" {
		t.Fatalf("expected agentuser TAT identity, got %+v", sandboxAdapter.ptyCalls[1])
	}
}

func TestRunCreateInstanceTaskPreservesLLMGatewayKeyWhenOnboardFails(t *testing.T) {
	installCreateTaskAiGatewayConfig(t)

	instanceDao := &createTaskInstanceDaoStub{
		entity: &modelinstance.Entity{
			Id:         2,
			InstanceId: "ins-create-onboard-fail",
			Status:     modelinstance.InstanceStatusCreating,
			CreatedAt:  time.Now().UTC(),
		},
	}
	sandboxAdapter := &createTaskSandboxAdapterStub{
		createResp: &psandbox.Sandbox{SandboxID: "sbx-create-onboard-fail", TemplateID: "tpl-create"},
		pools:      []psandbox.Pool{{ID: "tpl-create", Status: "active", CapacityState: "active"}},
		ptyBatches: [][]psandbox.PtyExecStreamEvent{
			{{Type: "started", ExecutionID: "pty:install"}, {Type: "finished", ExecutionID: "pty:install", Status: "SUCCESS", ExitCode: 0}},
			{{Type: "started", ExecutionID: "pty:model"}, {Type: "error", ExecutionID: "pty:model", Status: "FAILED", Message: "exit status 1"}},
		},
	}
	aiGatewayAdapter := &createTaskLLMGatewayAdapterStub{
		createResp: &pllmgateway.CreateApiKeyResponse{KeyID: "key-create-fail", APIKey: "api-create-fail"},
	}

	logic := &logic{
		instanceDao:                  instanceDao,
		sandboxAdapter:               sandboxAdapter,
		llmGatewayAdapter:            aiGatewayAdapter,
		logger:                       zap.NewNop(),
		defaultTemplate:              "tpl-create",
		candidateTemplates:           []string{"tpl-create"},
		legacyPassEntitlementEnsurer: legacyPassEntitlementAlreadyReady,
	}
	ctx := pctx.NewContext(nil).WithUserID("user-create-2")

	err := logic.RunCreateInstanceTask(ctx, &CreateInstanceTaskPayload{InstanceID: "ins-create-onboard-fail", Timeout: 600})
	if !errors.Is(err, errcode.ErrInstanceCreationFailed) {
		t.Fatalf("expected instance creation failed, got %v", err)
	}
	if instanceDao.entity.Status == modelinstance.InstanceStatusRunning {
		t.Fatalf("expected instance to stay non-running after onboard failure, got %s", instanceDao.entity.Status)
	}
	if len(aiGatewayAdapter.revoked) != 0 {
		t.Fatalf("LLMGateway user key must survive instance onboarding failure, got revocations %+v", aiGatewayAdapter.revoked)
	}
	if len(aiGatewayAdapter.ensureCalls) != 1 || aiGatewayAdapter.ensureCalls[0].userID != "user-create-2" {
		t.Fatalf("expected ensure user to run before failed key provisioning, got %+v", aiGatewayAdapter.ensureCalls)
	}
	if len(sandboxAdapter.deletedIDs) != 1 || sandboxAdapter.deletedIDs[0] != "sbx-create-onboard-fail" {
		t.Fatalf("expected created sandbox to be cleaned up, got %+v", sandboxAdapter.deletedIDs)
	}
}

func TestRunCreateInstanceTaskFailsWhenEnsureAiGatewayUserFails(t *testing.T) {
	installCreateTaskAiGatewayConfig(t)

	instanceDao := &createTaskInstanceDaoStub{
		entity: &modelinstance.Entity{
			Id:         3,
			InstanceId: "ins-create-ensure-user-fail",
			Status:     modelinstance.InstanceStatusCreating,
			CreatedAt:  time.Now().UTC(),
		},
	}
	sandboxAdapter := &createTaskSandboxAdapterStub{
		createResp: &psandbox.Sandbox{SandboxID: "sbx-create-ensure-user-fail", TemplateID: "tpl-create"},
		pools:      []psandbox.Pool{{ID: "tpl-create", Status: "active", CapacityState: "active"}},
	}
	aiGatewayAdapter := &createTaskLLMGatewayAdapterStub{
		ensureErr: errors.New("ensure user failed"),
	}

	logic := &logic{
		instanceDao:        instanceDao,
		sandboxAdapter:     sandboxAdapter,
		llmGatewayAdapter:  aiGatewayAdapter,
		logger:             zap.NewNop(),
		defaultTemplate:    "tpl-create",
		candidateTemplates: []string{"tpl-create"},
	}
	ctx := pctx.NewContext(nil).WithUserID("user-create-3")

	err := logic.RunCreateInstanceTask(ctx, &CreateInstanceTaskPayload{InstanceID: "ins-create-ensure-user-fail", Timeout: 600})
	if !errors.Is(err, errcode.ErrInstanceCreationFailed) {
		t.Fatalf("expected instance creation failed, got %v", err)
	}
	if len(aiGatewayAdapter.ensureCalls) != 1 || aiGatewayAdapter.ensureCalls[0].userID != "user-create-3" {
		t.Fatalf("expected ensure user to run once, got %+v", aiGatewayAdapter.ensureCalls)
	}
	if aiGatewayAdapter.createCalls != 0 {
		t.Fatalf("expected create api key to be skipped after ensure user failure, got %d calls", aiGatewayAdapter.createCalls)
	}
	if len(sandboxAdapter.deletedIDs) != 1 || sandboxAdapter.deletedIDs[0] != "sbx-create-ensure-user-fail" {
		t.Fatalf("expected created sandbox to be cleaned up, got %+v", sandboxAdapter.deletedIDs)
	}
}
