package instance

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	paigateway "ctl/pkg/adapter/aigateway"
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
	processBatches [][]psandbox.ProcessStreamEvent
	processCalls   []psandbox.ProcessStartRequest
	deletedIDs     []string
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
func (s *createTaskSandboxAdapterStub) GetSandbox(context.Context, string) (*psandbox.SandboxDetail, error) {
	return nil, nil
}
func (s *createTaskSandboxAdapterStub) ListSandboxes(context.Context, *psandbox.ListSandboxesRequest) ([]psandbox.ListedSandbox, error) {
	return nil, nil
}
func (s *createTaskSandboxAdapterStub) ListPools(context.Context) ([]psandbox.Pool, error) {
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

type createTaskAiGatewayAdapterStub struct {
	paigateway.Adapter
	createResp  *paigateway.CreateApiKeyResponse
	createCalls int
	ensureErr   error
	ensureCalls []struct {
		userID   string
		nickname string
	}
	revoked []string
}

func (s *createTaskAiGatewayAdapterStub) CreateApiKey(_ context.Context, _ string, _ string) (*paigateway.CreateApiKeyResponse, error) {
	s.createCalls++
	if s.createResp != nil {
		return s.createResp, nil
	}
	return &paigateway.CreateApiKeyResponse{KeyID: "key-create-1", APIKey: "api-create-1"}, nil
}
func (s *createTaskAiGatewayAdapterStub) EnsureUser(_ context.Context, userID string, nickname string) (*paigateway.EnsureUserResponse, error) {
	s.ensureCalls = append(s.ensureCalls, struct {
		userID   string
		nickname string
	}{userID: userID, nickname: nickname})
	if s.ensureErr != nil {
		return nil, s.ensureErr
	}
	return &paigateway.EnsureUserResponse{UserID: userID, Result: "created"}, nil
}
func (s *createTaskAiGatewayAdapterStub) RevokeApiKey(_ context.Context, keyID string) error {
	s.revoked = append(s.revoked, keyID)
	return nil
}
func (s *createTaskAiGatewayAdapterStub) GetUserUsage(_ context.Context, _ string) (*paigateway.UserUsageResponse, error) {
	return &paigateway.UserUsageResponse{}, nil
}

func installCreateTaskAiGatewayConfig(t *testing.T) {
	t.Helper()

	prev := config.ServerConf
	config.ServerConf = &config.GlobalConfig{
		AdapterConfig: &config.AdapterConfig{
			AiGateway: &config.AiGatewayConfig{
				BaseURL:              "https://aigateway.test",
				DefaultBaseURL:       "https://model.internal/v1",
				DefaultModelID:       "kimi-k2.5",
				DefaultCompatibility: "openai",
				DefaultGatewayPort:   18789,
			},
		},
	}
	t.Cleanup(func() {
		config.ServerConf = prev
	})
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
		processBatches: [][]psandbox.ProcessStreamEvent{
			{{Stdout: "install ok", Status: "running"}, {Ended: true, ExitCode: 0, Status: "SUCCESS"}},
			{{Stdout: "model set ok", Status: "running"}, {Ended: true, ExitCode: 0, Status: "SUCCESS"}},
		},
	}
	aiGatewayAdapter := &createTaskAiGatewayAdapterStub{
		createResp: &paigateway.CreateApiKeyResponse{KeyID: "key-create-1", APIKey: "api-create-1"},
	}

	logic := &logic{
		instanceDao:        instanceDao,
		sandboxAdapter:     sandboxAdapter,
		aiGatewayAdapter:   aiGatewayAdapter,
		logger:             zap.NewNop(),
		defaultTemplate:    "tpl-create",
		candidateTemplates: []string{"tpl-create"},
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
	if len(sandboxAdapter.processCalls) != 2 {
		t.Fatalf("expected model cli ensure + model set process calls, got %d", len(sandboxAdapter.processCalls))
	}
	if !strings.Contains(sandboxAdapter.processCalls[0].Args[2], "command -v acli") || !strings.Contains(sandboxAdapter.processCalls[0].Args[2], "curl -fsSL -z /usr/local/bin/harness") {
		t.Fatalf("expected first process call to prefer acli and fall back to harness install, got %q", sandboxAdapter.processCalls[0].Args[2])
	}
	if !strings.Contains(sandboxAdapter.processCalls[1].Args[2], "target_user='agentuser'") ||
		!strings.Contains(sandboxAdapter.processCalls[1].Args[2], "acli provider save") ||
		!strings.Contains(sandboxAdapter.processCalls[1].Args[2], "harness model set") {
		t.Fatalf("expected second process call to prefer acli provider save and fall back to harness model set as agentuser, got %q", sandboxAdapter.processCalls[1].Args[2])
	}
	if !strings.Contains(sandboxAdapter.processCalls[1].Args[2], "--name") ||
		!strings.Contains(sandboxAdapter.processCalls[1].Args[2], "acli model switch --model") ||
		!strings.Contains(sandboxAdapter.processCalls[1].Args[2], "--model-name") ||
		!strings.Contains(sandboxAdapter.processCalls[1].Args[2], "kimi-k2.5") ||
		!strings.Contains(sandboxAdapter.processCalls[1].Args[2], "switch_model=") ||
		!strings.Contains(sandboxAdapter.processCalls[1].Args[2], "model_name") ||
		!strings.Contains(sandboxAdapter.processCalls[1].Args[2], "--model \"$switch_model\"") ||
		strings.Contains(sandboxAdapter.processCalls[1].Args[2], "--agent") ||
		!strings.Contains(sandboxAdapter.processCalls[1].Args[2], "--api") ||
		!strings.Contains(sandboxAdapter.processCalls[1].Args[2], "--api-key \"$ACLI_SECRET_API_KEY\"") ||
		!strings.Contains(sandboxAdapter.processCalls[1].Args[2], "--model-id") ||
		!strings.Contains(sandboxAdapter.processCalls[1].Args[2], "--model-name") ||
		!strings.Contains(sandboxAdapter.processCalls[1].Args[2], "custom") {
		t.Fatalf("expected hermes provider name to stay fixed as custom, got %q", sandboxAdapter.processCalls[1].Args[2])
	}
	if sandboxAdapter.processCalls[1].Env["HOME"] != "/home/agentuser" {
		t.Fatalf("expected HOME env for agentuser, got %+v", sandboxAdapter.processCalls[1].Env)
	}
	if !strings.Contains(sandboxAdapter.processCalls[1].Env["PATH"], "/home/agentuser/.local/bin") {
		t.Fatalf("expected PATH env to include agentuser local bin, got %+v", sandboxAdapter.processCalls[1].Env)
	}
}

func TestRunCreateInstanceTaskFailsWhenAiGatewayOnboardFails(t *testing.T) {
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
		processBatches: [][]psandbox.ProcessStreamEvent{
			{{Stdout: "install ok", Status: "running"}, {Ended: true, ExitCode: 0, Status: "SUCCESS"}},
			{{Stderr: "model set failed", Status: "running"}, {Ended: true, ExitCode: 1, Status: "FAILED", Error: "exit status 1"}},
		},
	}
	aiGatewayAdapter := &createTaskAiGatewayAdapterStub{
		createResp: &paigateway.CreateApiKeyResponse{KeyID: "key-create-fail", APIKey: "api-create-fail"},
	}

	logic := &logic{
		instanceDao:        instanceDao,
		sandboxAdapter:     sandboxAdapter,
		aiGatewayAdapter:   aiGatewayAdapter,
		logger:             zap.NewNop(),
		defaultTemplate:    "tpl-create",
		candidateTemplates: []string{"tpl-create"},
	}
	ctx := pctx.NewContext(nil).WithUserID("user-create-2")

	err := logic.RunCreateInstanceTask(ctx, &CreateInstanceTaskPayload{InstanceID: "ins-create-onboard-fail", Timeout: 600})
	if !errors.Is(err, errcode.ErrInstanceCreationFailed) {
		t.Fatalf("expected instance creation failed, got %v", err)
	}
	if instanceDao.entity.Status == modelinstance.InstanceStatusRunning {
		t.Fatalf("expected instance to stay non-running after onboard failure, got %s", instanceDao.entity.Status)
	}
	if len(aiGatewayAdapter.revoked) != 1 || aiGatewayAdapter.revoked[0] != "key-create-fail" {
		t.Fatalf("expected created key to be revoked, got %+v", aiGatewayAdapter.revoked)
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
	}
	aiGatewayAdapter := &createTaskAiGatewayAdapterStub{
		ensureErr: errors.New("ensure user failed"),
	}

	logic := &logic{
		instanceDao:        instanceDao,
		sandboxAdapter:     sandboxAdapter,
		aiGatewayAdapter:   aiGatewayAdapter,
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
