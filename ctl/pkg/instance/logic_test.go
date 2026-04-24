//go:build integration

package instance_test

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
	"time"

	paigateway "ctl/pkg/adapter/aigateway"
	psandbox "ctl/pkg/adapter/sandbox"
	"ctl/pkg/config"
	pctx "ctl/pkg/context"
	"ctl/pkg/errcode"
	instancelogic "ctl/pkg/instance"
	modelfactory "ctl/pkg/model/factory"
	modelinstance "ctl/pkg/model/instance"
	"ctl/pkg/model/operationhistory"
	quota "ctl/pkg/model/userresourcequota"
	"ctl/pkg/transport"
	"ctl/test/testutil"
	"go.uber.org/zap"
	"go.uber.org/zap/zaptest/observer"
)

type sandboxAdapterStub struct {
	createResp         *psandbox.Sandbox
	createResponses    []*psandbox.Sandbox
	createErr          error
	createErrors       []error
	createRequests     []*psandbox.CreateSandboxRequest
	processRequests    []*psandbox.ProcessStartRequest
	deleteErr          error
	pauseErr           error
	pauseHook          func()
	resumeResp         *psandbox.Sandbox
	resumeErr          error
	resumeHook         func()
	setTimeoutErr      error
	setTimeoutHook     func()
	lastDeletedSandbox string
	lastPausedSandbox  string
	lastResumedSandbox string
	lastResumeRequest  *psandbox.ResumeSandboxRequest
	lastTimeoutSandbox string
	lastTimeoutValue   int32
	getLogsResp        *psandbox.SandboxLogs
	getLogsErr         error
	execCommandFunc    func(ctx context.Context, sandboxID, bash string, timeoutSec int) (*psandbox.ExecCommandResult, error)
	lastExecSandbox    string
	lastExecCommand    string
	lastExecTimeout    int
}

type quotaDaoStub struct {
	quota.Dao
	freeQuotaOK  bool
	freeQuotaErr error
}

type failingUpdateInstanceDao struct {
	modelinstance.Dao
	updateErr error
}

func (d *failingUpdateInstanceDao) UpdateWithStatusPrecondition(ctx pctx.Context, id int64, fromStatuses []string, updates map[string]interface{}) error {
	if status, ok := updates[modelinstance.ColumnStatus]; ok && status == modelinstance.InstanceStatusRunning {
		return d.updateErr
	}
	return d.Dao.UpdateWithStatusPrecondition(ctx, id, fromStatuses, updates)
}

type aiGatewayAdapterStub struct {
	createResp    *paigateway.CreateApiKeyResponse
	createErr     error
	revokedKeyIDs []string
	revokeErr     error
}

func (s *aiGatewayAdapterStub) CreateApiKey(_ context.Context, _ string, _ string) (*paigateway.CreateApiKeyResponse, error) {
	if s.createErr != nil {
		return nil, s.createErr
	}
	if s.createResp == nil {
		return nil, fmt.Errorf("create response not configured")
	}
	return s.createResp, nil
}

func (s *aiGatewayAdapterStub) EnsureUser(_ context.Context, userID string, nickname string) (*paigateway.EnsureUserResponse, error) {
	return &paigateway.EnsureUserResponse{UserID: userID, Result: "created"}, nil
}

func (s *aiGatewayAdapterStub) RevokeApiKey(_ context.Context, keyID string) error {
	s.revokedKeyIDs = append(s.revokedKeyIDs, keyID)
	return s.revokeErr
}

func (s *aiGatewayAdapterStub) GetUserUsage(_ context.Context, _ string) (*paigateway.UserUsageResponse, error) {
	return &paigateway.UserUsageResponse{}, nil
}

func (s *aiGatewayAdapterStub) GetPlan(_ context.Context, _ string) (*paigateway.Plan, error) {
	return nil, fmt.Errorf("plan lookup not configured")
}

func (s *aiGatewayAdapterStub) ApplySubscription(_ context.Context, _ string, _ string) (*paigateway.Subscription, error) {
	return nil, fmt.Errorf("subscription apply not configured")
}

func (s *aiGatewayAdapterStub) CancelSubscription(_ context.Context, _ string) error {
	return nil
}

func (s *aiGatewayAdapterStub) GetActiveSubscription(_ context.Context, _ string) (*paigateway.Subscription, error) {
	return nil, nil
}

func installAiGatewayConfigForTest(t *testing.T, conf *config.AiGatewayConfig) {
	t.Helper()

	if config.ServerConf.AdapterConfig == nil {
		config.ServerConf.AdapterConfig = &config.AdapterConfig{}
	}

	original := config.ServerConf.AdapterConfig.AiGateway
	config.ServerConf.AdapterConfig.AiGateway = conf
	t.Cleanup(func() {
		config.ServerConf.AdapterConfig.AiGateway = original
	})
}

func (s *sandboxAdapterStub) CreateSandbox(_ context.Context, req *psandbox.CreateSandboxRequest) (*psandbox.Sandbox, error) {
	if len(s.createRequests) == 0 {
		s.createRequests = make([]*psandbox.CreateSandboxRequest, 0, 1)
	}
	reqCopy := *req
	s.createRequests = append(s.createRequests, &reqCopy)
	if len(s.createErrors) > 0 {
		err := s.createErrors[0]
		s.createErrors = s.createErrors[1:]
		if err != nil {
			return nil, err
		}
	}
	if len(s.createResponses) > 0 {
		resp := s.createResponses[0]
		s.createResponses = s.createResponses[1:]
		return resp, nil
	}
	if s.createErr != nil {
		return nil, s.createErr
	}
	return s.createResp, nil
}

func (s *sandboxAdapterStub) GetSandbox(context.Context, string) (*psandbox.SandboxDetail, error) {
	panic("unexpected call")
}
func (s *sandboxAdapterStub) ListSandboxes(context.Context, *psandbox.ListSandboxesRequest) ([]psandbox.ListedSandbox, error) {
	panic("unexpected call")
}
func (s *sandboxAdapterStub) ListPools(context.Context) ([]psandbox.Pool, error) {
	panic("unexpected call")
}
func (s *sandboxAdapterStub) ListPoolInstances(context.Context, string) ([]psandbox.PoolInstance, error) {
	panic("unexpected call")
}
func (s *sandboxAdapterStub) DeleteSandbox(_ context.Context, sandboxID string) error {
	s.lastDeletedSandbox = sandboxID
	return s.deleteErr
}
func (s *sandboxAdapterStub) PauseSandbox(_ context.Context, sandboxID string) error {
	s.lastPausedSandbox = sandboxID
	if s.pauseHook != nil {
		s.pauseHook()
	}
	return s.pauseErr
}
func (s *sandboxAdapterStub) ResumeSandbox(_ context.Context, sandboxID string, req *psandbox.ResumeSandboxRequest) (*psandbox.Sandbox, error) {
	s.lastResumedSandbox = sandboxID
	s.lastResumeRequest = req
	if s.resumeHook != nil {
		s.resumeHook()
	}
	if s.resumeErr != nil {
		return nil, s.resumeErr
	}
	if s.resumeResp == nil {
		return &psandbox.Sandbox{SandboxID: sandboxID}, nil
	}
	return s.resumeResp, nil
}
func (s *sandboxAdapterStub) SetTimeout(_ context.Context, sandboxID string, timeout int32) error {
	s.lastTimeoutSandbox = sandboxID
	s.lastTimeoutValue = timeout
	if s.setTimeoutHook != nil {
		s.setTimeoutHook()
	}
	return s.setTimeoutErr
}
func (s *sandboxAdapterStub) Refresh(context.Context, string, int32) error { panic("unexpected call") }
func (s *sandboxAdapterStub) GetLogs(_ context.Context, _ string, _ *psandbox.GetLogsRequest) (*psandbox.SandboxLogs, error) {
	if s.getLogsResp != nil || s.getLogsErr != nil {
		return s.getLogsResp, s.getLogsErr
	}
	panic("unexpected call")
}
func (s *sandboxAdapterStub) ExecCommand(ctx context.Context, sandboxID, bash string, timeoutSec int) (*psandbox.ExecCommandResult, error) {
	s.lastExecSandbox = sandboxID
	s.lastExecCommand = bash
	s.lastExecTimeout = timeoutSec
	if s.execCommandFunc != nil {
		return s.execCommandFunc(ctx, sandboxID, bash, timeoutSec)
	}
	panic("unexpected call")
}
func (s *sandboxAdapterStub) GetCommandResult(_ context.Context, _ string, _ string) (*psandbox.ExecCommandResult, error) {
	panic("unexpected call")
}
func (s *sandboxAdapterStub) StartProcessStream(ctx context.Context, sandboxID string, req *psandbox.ProcessStartRequest, onEvent func(psandbox.ProcessStreamEvent) error) error {
	s.lastExecSandbox = sandboxID
	s.lastExecCommand = req.Cmd + " " + strings.Join(req.Args, " ")
	if req != nil {
		cloned := *req
		cloned.Args = append([]string(nil), req.Args...)
		s.processRequests = append(s.processRequests, &cloned)
	}
	if s.execCommandFunc != nil {
		result, err := s.execCommandFunc(ctx, sandboxID, s.lastExecCommand, s.lastExecTimeout)
		if err != nil {
			return err
		}
		if result == nil {
			return nil
		}
		return onEvent(psandbox.ProcessStreamEvent{
			PID:      1,
			Stdout:   result.Output,
			Stderr:   result.ErrorInfo,
			ExitCode: int32(result.ExitCode),
			Status:   result.Status,
			Error:    result.ErrorInfo,
			Ended:    true,
		})
	}
	return onEvent(psandbox.ProcessStreamEvent{
		PID:      1,
		ExitCode: 0,
		Status:   "SUCCESS",
		Ended:    true,
	})
}

func (s *sandboxAdapterStub) RunProcessWithStdin(ctx context.Context, sandboxID string, req *psandbox.ProcessStartRequest, stdin []byte) (*psandbox.ExecCommandResult, error) {
	s.lastExecSandbox = sandboxID
	if req != nil {
		s.lastExecCommand = req.Cmd + " " + strings.Join(req.Args, " ")
		cloned := *req
		cloned.Args = append([]string(nil), req.Args...)
		s.processRequests = append(s.processRequests, &cloned)
	}
	if s.execCommandFunc != nil {
		return s.execCommandFunc(ctx, sandboxID, s.lastExecCommand, s.lastExecTimeout)
	}
	return &psandbox.ExecCommandResult{
		Status:   "SUCCESS",
		ExitCode: 0,
		Output:   string(stdin),
	}, nil
}

func TestCreateInstanceRejectsInvalidSoulTemplateID(t *testing.T) {
	testutil.NewMySQLDB(t, "..", "..", "migrations")
	ensureInstanceConfigForTest(t)

	ctx := testutil.NewContext(t, "user-invalid-soul")
	logic := instancelogic.NewLogicForTest(
		modelfactory.DefaultDaoFactory.InstanceDao(ctx),
		modelfactory.DefaultDaoFactory.UserResourceQuotaDao(ctx),
		&sandboxAdapterStub{createResp: &psandbox.Sandbox{SandboxID: "sbx-invalid-soul"}},
		nil,
		nil,
		nil,
		"tpl-1",
	)

	_, err := logic.CreateInstance(ctx, &transport.CreateInstanceRequest{SoulTemplateID: "../bad"})
	if !errors.Is(err, errcode.ErrInstanceInvalidParam) {
		t.Fatalf("expected invalid param, got %v", err)
	}
}

func TestCreateInstanceSkipsSoulTemplateApplyDuringCreate(t *testing.T) {
	testutil.NewMySQLDB(t, "..", "..", "migrations")
	ensureInstanceConfigForTest(t)

	ctx := testutil.NewContext(t, "user-soul")
	db := modelfactory.DefaultDaoFactory.UserResourceQuotaDao(ctx)
	if err := db.DB().Create(&quota.Entity{
		UserID:                 ctx.GetUserID(),
		ResourceName:           "OPENCLAW_INSTANCE",
		ResourceKey:            "",
		ResourceQuotaAvailable: 1,
		ResourceQuotaTotal:     1,
	}).Error; err != nil {
		t.Fatalf("seed quota: %v", err)
	}

	originalDir := config.ServerConf.APIConfig.Instance.SoulTemplateDir
	config.ServerConf.APIConfig.Instance.SoulTemplateDir = filepath.Join("..", "..", "assets", "souls")
	t.Cleanup(func() {
		config.ServerConf.APIConfig.Instance.SoulTemplateDir = originalDir
	})

	adapter := &sandboxAdapterStub{createResp: &psandbox.Sandbox{SandboxID: "sbx-soul"}}
	logic := instancelogic.NewLogicForTest(
		modelfactory.DefaultDaoFactory.InstanceDao(ctx),
		modelfactory.DefaultDaoFactory.UserResourceQuotaDao(ctx),
		adapter,
		nil,
		nil,
		nil,
		"tpl-1",
	)

	resp, err := logic.CreateInstance(ctx, &transport.CreateInstanceRequest{SoulTemplateID: "gentle"})
	if err != nil {
		t.Fatalf("create instance: %v", err)
	}
	if resp.SandboxID != "sbx-soul" {
		t.Fatalf("unexpected sandbox id: %s", resp.SandboxID)
	}
	if len(adapter.processRequests) != 0 {
		t.Fatalf("expected soul apply to be skipped, got %d process request(s)", len(adapter.processRequests))
	}
}

func TestListSoulTemplatesReadsMetadataFromTemplateFiles(t *testing.T) {
	testutil.NewMySQLDB(t, "..", "..", "migrations")
	ensureInstanceConfigForTest(t)

	ctx := testutil.NewContext(t, "user-soul-list")
	originalDir := config.ServerConf.APIConfig.Instance.SoulTemplateDir
	config.ServerConf.APIConfig.Instance.SoulTemplateDir = filepath.Join("..", "..", "assets", "souls")
	t.Cleanup(func() {
		config.ServerConf.APIConfig.Instance.SoulTemplateDir = originalDir
	})

	logic := instancelogic.NewLogicForTest(
		modelfactory.DefaultDaoFactory.InstanceDao(ctx),
		modelfactory.DefaultDaoFactory.UserResourceQuotaDao(ctx),
		&sandboxAdapterStub{},
		nil,
		nil,
		nil,
		"tpl-1",
	)

	resp, err := logic.ListSoulTemplates(ctx)
	if err != nil {
		t.Fatalf("list soul templates: %v", err)
	}
	if len(resp.Items) != 3 {
		t.Fatalf("expected 3 soul templates, got %d", len(resp.Items))
	}
	if resp.Items[0].ID != "gentle" || resp.Items[0].Name != "Gentle & Caring" {
		t.Fatalf("unexpected first soul template: %+v", resp.Items[0])
	}
	if !strings.Contains(resp.Items[0].Description, "warm presence") {
		t.Fatalf("expected description extracted from file, got %+v", resp.Items[0])
	}
	if resp.Items[1].ID != "humor" || !strings.Contains(resp.Items[1].Description, "punchlines") {
		t.Fatalf("unexpected second soul template: %+v", resp.Items[1])
	}
	if resp.Items[2].ID != "pro" || !strings.Contains(resp.Items[2].Description, "trusted advisor") {
		t.Fatalf("unexpected third soul template: %+v", resp.Items[2])
	}
}

func (s *sandboxAdapterStub) SendProcessSignal(_ context.Context, _ string, _ uint32, _ string) error {
	panic("unexpected call")
}

func (d *quotaDaoStub) FreeQuota(_ string, _, _ string, _ int64) (bool, error) {
	return d.freeQuotaOK, d.freeQuotaErr
}

func ensureInstanceConfigForTest(t *testing.T) {
	t.Helper()
	if config.ServerConf.APIConfig == nil {
		config.ServerConf.APIConfig = &config.APIConfig{}
	}
	if config.ServerConf.APIConfig.Instance == nil {
		config.ServerConf.APIConfig.Instance = &config.InstanceAPIConfig{}
	}
	if config.ServerConf.APIConfig.Instance.DefaultTemplateID == "" {
		config.ServerConf.APIConfig.Instance.DefaultTemplateID = "test-template"
	}
	config.ServerConf.APIConfig.Instance.CreatePoolMaxAttempts = 0
}

func TestCreateInstanceSuccess(t *testing.T) {
	testutil.NewMySQLDB(t, "..", "..", "migrations")

	ctx := testutil.NewContext(t, "user-1")
	db := modelfactory.DefaultDaoFactory.UserResourceQuotaDao(ctx)
	if err := db.DB().Create(&quota.Entity{
		UserID:                 ctx.GetUserID(),
		ResourceName:           "OPENCLAW_INSTANCE",
		ResourceKey:            "",
		ResourceQuotaAvailable: 2,
		ResourceQuotaTotal:     2,
	}).Error; err != nil {
		t.Fatalf("seed quota: %v", err)
	}

	logic := instancelogic.NewLogicForTest(
		modelfactory.DefaultDaoFactory.InstanceDao(ctx),
		modelfactory.DefaultDaoFactory.UserResourceQuotaDao(ctx),
		&sandboxAdapterStub{createResp: &psandbox.Sandbox{SandboxID: "sbx-1"}},
		nil, // aiGatewayAdapter
		nil, // operationHistoryDao
		nil,
		"tpl-1",
	)

	resp, err := logic.CreateInstance(ctx, &transport.CreateInstanceRequest{})
	if err != nil {
		t.Fatalf("create instance: %v", err)
	}
	if resp.SandboxID != "sbx-1" {
		t.Fatalf("unexpected sandbox id: %s", resp.SandboxID)
	}
	if resp.Status != modelinstance.InstanceStatusRunning {
		t.Fatalf("unexpected status: %s", resp.Status)
	}

	quotaEntity, err := modelfactory.DefaultDaoFactory.UserResourceQuotaDao(ctx).
		SelectQuota(ctx.GetUserID(), "OPENCLAW_INSTANCE", "")
	if err != nil {
		t.Fatalf("query quota: %v", err)
	}
	if quotaEntity.ResourceQuotaAvailable != 1 {
		t.Fatalf("unexpected remaining quota: %d", quotaEntity.ResourceQuotaAvailable)
	}

	got, err := modelfactory.DefaultDaoFactory.InstanceDao(ctx).GetByInstanceID(ctx, resp.InstanceID)
	if err != nil {
		t.Fatalf("query instance: %v", err)
	}
	if got.Status != modelinstance.InstanceStatusRunning {
		t.Fatalf("expected running status, got %s", got.Status)
	}
	if got.SandboxId != "sbx-1" {
		t.Fatalf("expected sandbox persisted")
	}
}

func TestCreateInstanceAutoSeedsDefaultQuotaWhenMissing(t *testing.T) {
	testutil.NewMySQLDB(t, "..", "..", "migrations")

	ctx := testutil.NewContext(t, "user-auto-quota")
	logic := instancelogic.NewLogicForTest(
		modelfactory.DefaultDaoFactory.InstanceDao(ctx),
		modelfactory.DefaultDaoFactory.UserResourceQuotaDao(ctx),
		&sandboxAdapterStub{createResp: &psandbox.Sandbox{SandboxID: "sbx-auto"}},
		nil, // aiGatewayAdapter
		nil, // operationHistoryDao
		nil,
		"tpl-1",
	)

	resp, err := logic.CreateInstance(ctx, &transport.CreateInstanceRequest{})
	if err != nil {
		t.Fatalf("create instance with auto-seeded quota: %v", err)
	}
	if resp.SandboxID != "sbx-auto" {
		t.Fatalf("unexpected sandbox id: %s", resp.SandboxID)
	}

	quotaEntity, err := modelfactory.DefaultDaoFactory.UserResourceQuotaDao(ctx).
		SelectQuota(ctx.GetUserID(), "OPENCLAW_INSTANCE", "")
	if err != nil {
		t.Fatalf("query quota: %v", err)
	}
	if quotaEntity == nil {
		t.Fatal("expected quota row to be auto-created")
	}
	if quotaEntity.ResourceQuotaTotal != 5 {
		t.Fatalf("expected default quota total 5, got %d", quotaEntity.ResourceQuotaTotal)
	}
	if quotaEntity.ResourceQuotaAvailable != 4 {
		t.Fatalf("expected default quota available 4 after allocation, got %d", quotaEntity.ResourceQuotaAvailable)
	}
}

func TestCreateInstanceRollbackOnSandboxFailure(t *testing.T) {
	testutil.NewMySQLDB(t, "..", "..", "migrations")

	ctx := testutil.NewContext(t, "user-1")
	if err := modelfactory.DefaultDaoFactory.UserResourceQuotaDao(ctx).DB().Create(&quota.Entity{
		UserID:                 ctx.GetUserID(),
		ResourceName:           "OPENCLAW_INSTANCE",
		ResourceKey:            "",
		ResourceQuotaAvailable: 1,
		ResourceQuotaTotal:     1,
	}).Error; err != nil {
		t.Fatalf("seed quota: %v", err)
	}

	logic := instancelogic.NewLogicForTest(
		modelfactory.DefaultDaoFactory.InstanceDao(ctx),
		modelfactory.DefaultDaoFactory.UserResourceQuotaDao(ctx),
		&sandboxAdapterStub{createErr: errcode.ErrSandboxServiceError},
		nil, // aiGatewayAdapter
		nil, // operationHistoryDao
		nil,
		"tpl-1",
	)

	_, err := logic.CreateInstance(ctx, &transport.CreateInstanceRequest{Timeout: ptr(int32(20))})
	if !errors.Is(err, errcode.ErrSandboxServiceError) {
		t.Fatalf("expected sandbox service error, got %v", err)
	}

	quotaEntity, err := modelfactory.DefaultDaoFactory.UserResourceQuotaDao(ctx).
		SelectQuota(ctx.GetUserID(), "OPENCLAW_INSTANCE", "")
	if err != nil {
		t.Fatalf("query quota: %v", err)
	}
	if quotaEntity.ResourceQuotaAvailable != 1 {
		t.Fatalf("expected quota rollback, got %d", quotaEntity.ResourceQuotaAvailable)
	}

	list, total, err := modelfactory.DefaultDaoFactory.InstanceDao(ctx).ListByUserID(ctx, ctx.GetUserID(), 1, 10)
	if err != nil {
		t.Fatalf("list instances: %v", err)
	}
	if total != 1 || len(list) != 1 {
		t.Fatalf("expected one failed instance record, total=%d len=%d", total, len(list))
	}
	if list[0].Status != modelinstance.InstanceStatusFailed {
		t.Fatalf("expected failed status, got %s", list[0].Status)
	}
}

func TestCreateInstanceFallsBackToNextTemplateAfterFailure(t *testing.T) {
	testutil.NewMySQLDB(t, "..", "..", "migrations")

	ctx := testutil.NewContext(t, "user-1")
	if err := modelfactory.DefaultDaoFactory.UserResourceQuotaDao(ctx).DB().Create(&quota.Entity{
		UserID:                 ctx.GetUserID(),
		ResourceName:           "OPENCLAW_INSTANCE",
		ResourceKey:            "",
		ResourceQuotaAvailable: 1,
		ResourceQuotaTotal:     1,
	}).Error; err != nil {
		t.Fatalf("seed quota: %v", err)
	}

	adapter := &sandboxAdapterStub{
		createErrors: []error{errcode.ErrSandboxServiceError, nil},
		createResponses: []*psandbox.Sandbox{
			{SandboxID: "sbx-fallback-success"},
		},
	}
	logic := instancelogic.NewLogicForTest(
		modelfactory.DefaultDaoFactory.InstanceDao(ctx),
		modelfactory.DefaultDaoFactory.UserResourceQuotaDao(ctx),
		adapter,
		nil, // aiGatewayAdapter
		nil, // operationHistoryDao
		nil,
		"tpl-primary",
		"tpl-primary",
		"tpl-secondary",
	)

	resp, err := logic.CreateInstance(ctx, &transport.CreateInstanceRequest{})
	if err != nil {
		t.Fatalf("create instance with fallback: %v", err)
	}
	if resp.SandboxID != "sbx-fallback-success" {
		t.Fatalf("unexpected sandbox id: %s", resp.SandboxID)
	}
	if len(adapter.createRequests) != 2 {
		t.Fatalf("expected 2 sandbox create attempts, got %d", len(adapter.createRequests))
	}
	if adapter.createRequests[0].TemplateID != "tpl-primary" {
		t.Fatalf("unexpected first template: %s", adapter.createRequests[0].TemplateID)
	}
	if adapter.createRequests[1].TemplateID != "tpl-secondary" {
		t.Fatalf("unexpected second template: %s", adapter.createRequests[1].TemplateID)
	}

	quotaEntity, err := modelfactory.DefaultDaoFactory.UserResourceQuotaDao(ctx).
		SelectQuota(ctx.GetUserID(), "OPENCLAW_INSTANCE", "")
	if err != nil {
		t.Fatalf("query quota: %v", err)
	}
	if quotaEntity.ResourceQuotaAvailable != 0 {
		t.Fatalf("expected quota to be consumed once, got %d", quotaEntity.ResourceQuotaAvailable)
	}
}

func TestCreateInstanceSendsTemplateClassIDAlongsideLegacyTemplateFallback(t *testing.T) {
	testutil.NewMySQLDB(t, "..", "..", "migrations")

	ctx := testutil.NewContext(t, "user-template-class")
	if err := modelfactory.DefaultDaoFactory.UserResourceQuotaDao(ctx).DB().Create(&quota.Entity{
		UserID:                 ctx.GetUserID(),
		ResourceName:           "OPENCLAW_INSTANCE",
		ResourceKey:            "",
		ResourceQuotaAvailable: 1,
		ResourceQuotaTotal:     1,
	}).Error; err != nil {
		t.Fatalf("seed quota: %v", err)
	}

	adapter := &sandboxAdapterStub{
		createErrors: []error{errcode.ErrSandboxServiceError, nil},
		createResponses: []*psandbox.Sandbox{
			{SandboxID: "sbx-template-class-success"},
		},
	}
	logic := instancelogic.NewLogicForTestWithTemplateClass(
		modelfactory.DefaultDaoFactory.InstanceDao(ctx),
		modelfactory.DefaultDaoFactory.UserResourceQuotaDao(ctx),
		adapter,
		nil,
		nil,
		nil,
		"openclaw-default",
		"pool-primary",
		"pool-primary",
		"pool-secondary",
	)

	resp, err := logic.CreateInstance(ctx, &transport.CreateInstanceRequest{})
	if err != nil {
		t.Fatalf("create instance with template class: %v", err)
	}
	if resp.SandboxID != "sbx-template-class-success" {
		t.Fatalf("unexpected sandbox id: %s", resp.SandboxID)
	}
	if len(adapter.createRequests) != 2 {
		t.Fatalf("expected 2 sandbox create attempts, got %d", len(adapter.createRequests))
	}
	for i, req := range adapter.createRequests {
		if req.TemplateClassID != "openclaw-default" {
			t.Fatalf("request %d missing template class id, got %q", i, req.TemplateClassID)
		}
	}
	if adapter.createRequests[0].TemplateID != "pool-primary" {
		t.Fatalf("unexpected first legacy template id: %s", adapter.createRequests[0].TemplateID)
	}
	if adapter.createRequests[1].TemplateID != "pool-secondary" {
		t.Fatalf("unexpected second legacy template id: %s", adapter.createRequests[1].TemplateID)
	}
}

func TestCreateInstanceFailsAfterAllCandidateTemplatesFail(t *testing.T) {
	testutil.NewMySQLDB(t, "..", "..", "migrations")

	ctx := testutil.NewContext(t, "user-1")
	if err := modelfactory.DefaultDaoFactory.UserResourceQuotaDao(ctx).DB().Create(&quota.Entity{
		UserID:                 ctx.GetUserID(),
		ResourceName:           "OPENCLAW_INSTANCE",
		ResourceKey:            "",
		ResourceQuotaAvailable: 1,
		ResourceQuotaTotal:     1,
	}).Error; err != nil {
		t.Fatalf("seed quota: %v", err)
	}

	adapter := &sandboxAdapterStub{
		createErrors: []error{
			errcode.Wrap(errcode.ErrSandboxServiceError, "primary"),
			errcode.Wrap(errcode.ErrSandboxServiceError, "secondary"),
		},
	}
	core, logs := observer.New(zap.WarnLevel)
	logic := instancelogic.NewLogicForTest(
		modelfactory.DefaultDaoFactory.InstanceDao(ctx),
		modelfactory.DefaultDaoFactory.UserResourceQuotaDao(ctx),
		adapter,
		nil, // aiGatewayAdapter
		nil, // operationHistoryDao
		zap.New(core),
		"tpl-primary",
		"tpl-primary",
		"tpl-secondary",
	)

	_, err := logic.CreateInstance(ctx, &transport.CreateInstanceRequest{})
	if !errors.Is(err, errcode.ErrSandboxServiceError) {
		t.Fatalf("expected sandbox service error, got %v", err)
	}
	if len(adapter.createRequests) != 2 {
		t.Fatalf("expected 2 sandbox create attempts, got %d", len(adapter.createRequests))
	}
	if logs.Len() < 2 {
		t.Fatalf("expected warning logs for fallback attempts, got %d", logs.Len())
	}

	quotaEntity, err := modelfactory.DefaultDaoFactory.UserResourceQuotaDao(ctx).
		SelectQuota(ctx.GetUserID(), "OPENCLAW_INSTANCE", "")
	if err != nil {
		t.Fatalf("query quota: %v", err)
	}
	if quotaEntity.ResourceQuotaAvailable != 1 {
		t.Fatalf("expected quota rollback after all templates fail, got %d", quotaEntity.ResourceQuotaAvailable)
	}

	list, total, err := modelfactory.DefaultDaoFactory.InstanceDao(ctx).ListByUserID(ctx, ctx.GetUserID(), 1, 10)
	if err != nil {
		t.Fatalf("list instances: %v", err)
	}
	if total != 1 || len(list) != 1 {
		t.Fatalf("expected one failed instance record, total=%d len=%d", total, len(list))
	}
	if list[0].Status != modelinstance.InstanceStatusFailed {
		t.Fatalf("expected failed status, got %s", list[0].Status)
	}
}

func TestCreateInstanceStopsFallbackOnUnauthorizedError(t *testing.T) {
	testutil.NewMySQLDB(t, "..", "..", "migrations")

	ctx := testutil.NewContext(t, "user-1")
	if err := modelfactory.DefaultDaoFactory.UserResourceQuotaDao(ctx).DB().Create(&quota.Entity{
		UserID:                 ctx.GetUserID(),
		ResourceName:           "OPENCLAW_INSTANCE",
		ResourceKey:            "",
		ResourceQuotaAvailable: 1,
		ResourceQuotaTotal:     1,
	}).Error; err != nil {
		t.Fatalf("seed quota: %v", err)
	}

	adapter := &sandboxAdapterStub{
		createErrors: []error{errcode.ErrUnauthorized, nil},
		createResponses: []*psandbox.Sandbox{
			{SandboxID: "sbx-should-not-be-created"},
		},
	}
	logic := instancelogic.NewLogicForTest(
		modelfactory.DefaultDaoFactory.InstanceDao(ctx),
		modelfactory.DefaultDaoFactory.UserResourceQuotaDao(ctx),
		adapter,
		nil, // aiGatewayAdapter
		nil, // operationHistoryDao
		nil,
		"tpl-primary",
		"tpl-primary",
		"tpl-secondary",
	)

	_, err := logic.CreateInstance(ctx, &transport.CreateInstanceRequest{})
	if !errors.Is(err, errcode.ErrSandboxServiceError) {
		t.Fatalf("expected sandbox service error, got %v", err)
	}
	if len(adapter.createRequests) != 1 {
		t.Fatalf("expected fallback to stop after non-template error, got %d attempts", len(adapter.createRequests))
	}
}

func TestCreateInstanceStopsFallbackAtConfiguredAttemptLimit(t *testing.T) {
	testutil.NewMySQLDB(t, "..", "..", "migrations")
	ensureInstanceConfigForTest(t)
	originalLimit := config.ServerConf.APIConfig.Instance.CreatePoolMaxAttempts
	config.ServerConf.APIConfig.Instance.CreatePoolMaxAttempts = 2
	t.Cleanup(func() {
		config.ServerConf.APIConfig.Instance.CreatePoolMaxAttempts = originalLimit
	})

	ctx := testutil.NewContext(t, "user-attempt-limit")
	if err := modelfactory.DefaultDaoFactory.UserResourceQuotaDao(ctx).DB().Create(&quota.Entity{
		UserID:                 ctx.GetUserID(),
		ResourceName:           "OPENCLAW_INSTANCE",
		ResourceKey:            "",
		ResourceQuotaAvailable: 1,
		ResourceQuotaTotal:     1,
	}).Error; err != nil {
		t.Fatalf("seed quota: %v", err)
	}

	adapter := &sandboxAdapterStub{
		createErrors: []error{
			errcode.Wrap(errcode.ErrSandboxServiceError, "primary"),
			errcode.Wrap(errcode.ErrSandboxServiceError, "secondary"),
			errcode.Wrap(errcode.ErrSandboxServiceError, "tertiary"),
		},
	}
	logic := instancelogic.NewLogicForTest(
		modelfactory.DefaultDaoFactory.InstanceDao(ctx),
		modelfactory.DefaultDaoFactory.UserResourceQuotaDao(ctx),
		adapter,
		nil,
		nil,
		nil,
		"tpl-primary",
		"tpl-secondary",
		"tpl-tertiary",
	)

	_, err := logic.CreateInstance(ctx, &transport.CreateInstanceRequest{})
	if !errors.Is(err, errcode.ErrSandboxServiceError) {
		t.Fatalf("expected sandbox service error, got %v", err)
	}
	if len(adapter.createRequests) != 2 {
		t.Fatalf("expected 2 sandbox create attempts due to limit, got %d", len(adapter.createRequests))
	}
	if adapter.createRequests[0].TemplateID != "tpl-primary" || adapter.createRequests[1].TemplateID != "tpl-secondary" {
		t.Fatalf("unexpected attempt order: %s -> %s", adapter.createRequests[0].TemplateID, adapter.createRequests[1].TemplateID)
	}
	if strings.Contains(err.Error(), "tpl-tertiary") {
		t.Fatalf("did not expect third template in error message: %v", err)
	}
}

func TestCreateInstanceQuotaExceeded(t *testing.T) {
	testutil.NewMySQLDB(t, "..", "..", "migrations")

	ctx := testutil.NewContext(t, "user-1")
	if err := modelfactory.DefaultDaoFactory.UserResourceQuotaDao(ctx).DB().Create(&quota.Entity{
		UserID:                 ctx.GetUserID(),
		ResourceName:           "OPENCLAW_INSTANCE",
		ResourceKey:            "",
		ResourceQuotaAvailable: 0,
		ResourceQuotaTotal:     1,
	}).Error; err != nil {
		t.Fatalf("seed quota: %v", err)
	}

	logic := instancelogic.NewLogicForTest(
		modelfactory.DefaultDaoFactory.InstanceDao(ctx),
		modelfactory.DefaultDaoFactory.UserResourceQuotaDao(ctx),
		&sandboxAdapterStub{},
		nil, // aiGatewayAdapter
		nil, // operationHistoryDao
		nil,
		"tpl-1",
	)

	_, err := logic.CreateInstance(ctx, &transport.CreateInstanceRequest{})
	if !errors.Is(err, errcode.ErrInstanceQuotaExceeded) {
		t.Fatalf("expected quota exceeded, got %v", err)
	}

	list, total, err := modelfactory.DefaultDaoFactory.InstanceDao(ctx).ListByUserID(ctx, ctx.GetUserID(), 1, 10)
	if err != nil {
		t.Fatalf("list instances: %v", err)
	}
	if total != 0 || len(list) != 0 {
		t.Fatalf("quota exceeded should not create instance, total=%d len=%d", total, len(list))
	}
}

func TestCreateInstanceRollsBackWhenStatusPersistenceFailsAfterSandboxCreated(t *testing.T) {
	testutil.NewMySQLDB(t, "..", "..", "migrations")

	ctx := testutil.NewContext(t, "user-1")
	if err := modelfactory.DefaultDaoFactory.UserResourceQuotaDao(ctx).DB().Create(&quota.Entity{
		UserID:                 ctx.GetUserID(),
		ResourceName:           "OPENCLAW_INSTANCE",
		ResourceKey:            "",
		ResourceQuotaAvailable: 1,
		ResourceQuotaTotal:     1,
	}).Error; err != nil {
		t.Fatalf("seed quota: %v", err)
	}

	baseDao := modelfactory.DefaultDaoFactory.InstanceDao(ctx)
	db := baseDao.DB()
	instanceDao := &failingUpdateInstanceDao{
		Dao:       baseDao,
		updateErr: errors.New("forced update failure"),
	}

	adapter := &sandboxAdapterStub{createResp: &psandbox.Sandbox{SandboxID: "sbx-1"}}
	logic := instancelogic.NewLogicForTest(
		instanceDao,
		modelfactory.DefaultDaoFactory.UserResourceQuotaDao(ctx),
		adapter,
		nil, // aiGatewayAdapter
		nil, // operationHistoryDao
		nil,
		"tpl-1",
	)

	_, err := logic.CreateInstance(ctx, &transport.CreateInstanceRequest{})
	if !errors.Is(err, errcode.ErrInstanceCreationFailed) {
		t.Fatalf("expected creation failure, got %v", err)
	}
	if adapter.lastDeletedSandbox != "sbx-1" {
		t.Fatalf("expected sandbox rollback, got %q", adapter.lastDeletedSandbox)
	}

	var entity modelinstance.Entity
	if err := db.WithContext(ctx).First(&entity).Error; err != nil {
		t.Fatalf("query instance record: %v", err)
	}
	if entity.Status != modelinstance.InstanceStatusFailed {
		t.Fatalf("expected failed status after rollback, got %s", entity.Status)
	}
	if entity.SandboxId != "sbx-1" {
		t.Fatalf("expected real sandbox id to be persisted for cleanup, got %s", entity.SandboxId)
	}

	quotaEntity, err := modelfactory.DefaultDaoFactory.UserResourceQuotaDao(ctx).
		SelectQuota(ctx.GetUserID(), "OPENCLAW_INSTANCE", "")
	if err != nil {
		t.Fatalf("select quota: %v", err)
	}
	if quotaEntity.ResourceQuotaAvailable != 1 {
		t.Fatalf("quota should be released after rollback, got %d", quotaEntity.ResourceQuotaAvailable)
	}
}

func TestCreateInstanceLogsWarningWhenRollbackQuotaAffectsNoRows(t *testing.T) {
	testutil.NewMySQLDB(t, "..", "..", "migrations")

	ctx := testutil.NewContext(t, "user-1")
	if err := modelfactory.DefaultDaoFactory.UserResourceQuotaDao(ctx).DB().Create(&quota.Entity{
		UserID:                 ctx.GetUserID(),
		ResourceName:           "OPENCLAW_INSTANCE",
		ResourceKey:            "",
		ResourceQuotaAvailable: 1,
		ResourceQuotaTotal:     1,
	}).Error; err != nil {
		t.Fatalf("seed quota: %v", err)
	}

	core, logs := observer.New(zap.WarnLevel)
	logic := instancelogic.NewLogicForTest(
		modelfactory.DefaultDaoFactory.InstanceDao(ctx),
		&quotaDaoStub{
			Dao:         modelfactory.DefaultDaoFactory.UserResourceQuotaDao(ctx),
			freeQuotaOK: false,
		},
		&sandboxAdapterStub{createErr: errcode.ErrSandboxServiceError},
		nil, // aiGatewayAdapter
		nil, // operationHistoryDao
		zap.New(core),
		"tpl-1",
	)

	if _, err := logic.CreateInstance(ctx, &transport.CreateInstanceRequest{}); !errors.Is(err, errcode.ErrSandboxServiceError) {
		t.Fatalf("expected sandbox service error, got %v", err)
	}
	if logs.Len() == 0 {
		t.Fatalf("expected rollback warning log")
	}
	found := false
	for _, entry := range logs.All() {
		if entry.Message == "rollback quota affected no rows" {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("expected rollback warning log, got %+v", logs.All())
	}
}

func TestCreateInstanceFailsWhenSandboxIDAlreadyExists(t *testing.T) {
	testutil.NewMySQLDB(t, "..", "..", "migrations")

	ctx := testutil.NewContext(t, "user-1")
	if err := modelfactory.DefaultDaoFactory.UserResourceQuotaDao(ctx).DB().Create(&quota.Entity{
		UserID:                 ctx.GetUserID(),
		ResourceName:           "OPENCLAW_INSTANCE",
		ResourceKey:            "",
		ResourceQuotaAvailable: 2,
		ResourceQuotaTotal:     2,
	}).Error; err != nil {
		t.Fatalf("seed quota: %v", err)
	}
	if err := modelfactory.DefaultDaoFactory.InstanceDao(ctx).Create(ctx, &modelinstance.Entity{
		InstanceId: "ins-existing",
		Status:     modelinstance.InstanceStatusRunning,
		SandboxId:  "sbx-dup",
		TimeoutAt:  time.Now().Add(time.Hour),
	}); err != nil {
		t.Fatalf("seed existing instance: %v", err)
	}

	adapter := &sandboxAdapterStub{createResp: &psandbox.Sandbox{SandboxID: "sbx-dup"}}
	logic := instancelogic.NewLogicForTest(
		modelfactory.DefaultDaoFactory.InstanceDao(ctx),
		modelfactory.DefaultDaoFactory.UserResourceQuotaDao(ctx),
		adapter,
		nil, // aiGatewayAdapter
		nil, // operationHistoryDao
		nil,
		"tpl-1",
	)

	if _, err := logic.CreateInstance(ctx, &transport.CreateInstanceRequest{}); !errors.Is(err, errcode.ErrInstanceCreationFailed) {
		t.Fatalf("expected instance creation failure, got %v", err)
	}
	if adapter.lastDeletedSandbox != "sbx-dup" {
		t.Fatalf("expected duplicate sandbox to be deleted, got %q", adapter.lastDeletedSandbox)
	}

	quotaEntity, err := modelfactory.DefaultDaoFactory.UserResourceQuotaDao(ctx).
		SelectQuota(ctx.GetUserID(), "OPENCLAW_INSTANCE", "")
	if err != nil {
		t.Fatalf("select quota: %v", err)
	}
	if quotaEntity.ResourceQuotaAvailable != 2 {
		t.Fatalf("quota should be rolled back after duplicate sandbox id, got %d", quotaEntity.ResourceQuotaAvailable)
	}
}

func TestDestroyInstanceRevokesTrackedAiGatewayKey(t *testing.T) {
	testutil.NewMySQLDB(t, "..", "..", "migrations")

	ctx := testutil.NewContext(t, "user-1")
	entity := &modelinstance.Entity{
		InstanceId:     "ins-destroy-key",
		Status:         modelinstance.InstanceStatusFailed,
		SandboxId:      "sbx-destroy-key",
		AiGatewayKeyID: "key-123",
		TimeoutAt:      time.Now().Add(time.Hour),
	}
	if err := modelfactory.DefaultDaoFactory.InstanceDao(ctx).Create(ctx, entity); err != nil {
		t.Fatalf("seed instance: %v", err)
	}

	aiGateway := &aiGatewayAdapterStub{}
	logic := instancelogic.NewLogicForTest(
		modelfactory.DefaultDaoFactory.InstanceDao(ctx),
		modelfactory.DefaultDaoFactory.UserResourceQuotaDao(ctx),
		&sandboxAdapterStub{},
		aiGateway,
		nil,
		nil,
		"tpl-1",
	)

	_, err := logic.DestroyInstance(ctx, entity.InstanceId)
	if err != nil {
		t.Fatalf("destroy instance: %v", err)
	}
	if len(aiGateway.revokedKeyIDs) != 1 || aiGateway.revokedKeyIDs[0] != "key-123" {
		t.Fatalf("expected ai-gateway key to be revoked, got %#v", aiGateway.revokedKeyIDs)
	}
}

func TestCreateInstanceSkipsAiGatewayOnboardWhenConfigMissing(t *testing.T) {
	testutil.NewMySQLDB(t, "..", "..", "migrations")
	installAiGatewayConfigForTest(t, &config.AiGatewayConfig{
		BaseURL:        "http://ai-gateway.internal",
		Timeout:        10,
		DefaultModelID: "",
	})

	ctx := testutil.NewContext(t, "user-aigw-config-missing")
	if err := modelfactory.DefaultDaoFactory.UserResourceQuotaDao(ctx).DB().Create(&quota.Entity{
		UserID:                 ctx.GetUserID(),
		ResourceName:           "OPENCLAW_INSTANCE",
		ResourceKey:            "",
		ResourceQuotaAvailable: 1,
		ResourceQuotaTotal:     1,
	}).Error; err != nil {
		t.Fatalf("seed quota: %v", err)
	}

	sandboxStub := &sandboxAdapterStub{createResp: &psandbox.Sandbox{SandboxID: "sbx-aigw-missing"}}
	aiGateway := &aiGatewayAdapterStub{
		createErr: fmt.Errorf("CreateApiKey should not be called"),
	}
	logic := instancelogic.NewLogicForTest(
		modelfactory.DefaultDaoFactory.InstanceDao(ctx),
		modelfactory.DefaultDaoFactory.UserResourceQuotaDao(ctx),
		sandboxStub,
		aiGateway,
		nil,
		nil,
		"tpl-1",
	)

	resp, err := logic.CreateInstance(ctx, &transport.CreateInstanceRequest{})
	if err != nil {
		t.Fatalf("expected create instance success, got %v", err)
	}
	if resp.Status != modelinstance.InstanceStatusRunning {
		t.Fatalf("expected running status, got %s", resp.Status)
	}
	if sandboxStub.lastDeletedSandbox != "" {
		t.Fatalf("did not expect sandbox cleanup, got %q", sandboxStub.lastDeletedSandbox)
	}
	if len(aiGateway.revokedKeyIDs) != 0 {
		t.Fatalf("did not expect ai-gateway key revocation, got %#v", aiGateway.revokedKeyIDs)
	}

	list, total, err := modelfactory.DefaultDaoFactory.InstanceDao(ctx).ListByUserID(ctx, ctx.GetUserID(), 1, 10)
	if err != nil {
		t.Fatalf("list instances: %v", err)
	}
	if total != 1 || len(list) != 1 {
		t.Fatalf("expected one instance, total=%d len=%d", total, len(list))
	}
	if list[0].Status != modelinstance.InstanceStatusRunning {
		t.Fatalf("expected running status, got %s", list[0].Status)
	}
	if list[0].AiGatewayKeyID != "" {
		t.Fatalf("expected ai-gateway key id to stay empty, got %q", list[0].AiGatewayKeyID)
	}
}

func TestCreateInstanceSkipsAiGatewayOnboardCommandDuringCreate(t *testing.T) {
	testutil.NewMySQLDB(t, "..", "..", "migrations")
	installAiGatewayConfigForTest(t, &config.AiGatewayConfig{
		BaseURL:              "http://ai-gateway.internal",
		Timeout:              10,
		DefaultBaseURL:       "https://api.example.com/v1",
		DefaultModelID:       "gpt-4.1",
		DefaultCompatibility: "openai",
		DefaultGatewayPort:   18789,
	})

	ctx := testutil.NewContext(t, "user-aigw-onboard-fail")
	if err := modelfactory.DefaultDaoFactory.UserResourceQuotaDao(ctx).DB().Create(&quota.Entity{
		UserID:                 ctx.GetUserID(),
		ResourceName:           "OPENCLAW_INSTANCE",
		ResourceKey:            "",
		ResourceQuotaAvailable: 1,
		ResourceQuotaTotal:     1,
	}).Error; err != nil {
		t.Fatalf("seed quota: %v", err)
	}

	sandboxStub := &sandboxAdapterStub{
		createResp: &psandbox.Sandbox{SandboxID: "sbx-aigw-fail"},
		execCommandFunc: func(_ context.Context, _ string, _ string, _ int) (*psandbox.ExecCommandResult, error) {
			return &psandbox.ExecCommandResult{
				Status:    "FAILED",
				ExitCode:  1,
				ErrorInfo: "boom",
			}, nil
		},
	}
	aiGateway := &aiGatewayAdapterStub{
		createErr: fmt.Errorf("CreateApiKey should not be called"),
	}
	logic := instancelogic.NewLogicForTest(
		modelfactory.DefaultDaoFactory.InstanceDao(ctx),
		modelfactory.DefaultDaoFactory.UserResourceQuotaDao(ctx),
		sandboxStub,
		aiGateway,
		nil,
		nil,
		"tpl-1",
	)

	resp, err := logic.CreateInstance(ctx, &transport.CreateInstanceRequest{})
	if err != nil {
		t.Fatalf("expected create instance success, got %v", err)
	}
	if resp.Status != modelinstance.InstanceStatusRunning {
		t.Fatalf("expected running status, got %s", resp.Status)
	}
	if sandboxStub.lastDeletedSandbox != "" {
		t.Fatalf("did not expect sandbox cleanup, got %q", sandboxStub.lastDeletedSandbox)
	}
	if len(aiGateway.revokedKeyIDs) != 0 {
		t.Fatalf("did not expect ai-gateway key revocation, got %#v", aiGateway.revokedKeyIDs)
	}
	if got := sandboxStub.lastExecCommand; got != "" {
		t.Fatalf("expected onboard command to be skipped, got %q", got)
	}

	list, total, err := modelfactory.DefaultDaoFactory.InstanceDao(ctx).ListByUserID(ctx, ctx.GetUserID(), 1, 10)
	if err != nil {
		t.Fatalf("list instances: %v", err)
	}
	if total != 1 || len(list) != 1 {
		t.Fatalf("expected one instance, total=%d len=%d", total, len(list))
	}
	if list[0].Status != modelinstance.InstanceStatusRunning {
		t.Fatalf("expected running status, got %s", list[0].Status)
	}
	if list[0].AiGatewayKeyID != "" {
		t.Fatalf("expected ai-gateway key id to stay empty, got %q", list[0].AiGatewayKeyID)
	}
}

func TestCreateInstanceSkipsAiGatewayProvisioningDuringCreate(t *testing.T) {
	testutil.NewMySQLDB(t, "..", "..", "migrations")
	installAiGatewayConfigForTest(t, &config.AiGatewayConfig{
		BaseURL:              "http://ai-gateway.internal",
		Timeout:              10,
		DefaultBaseURL:       "https://api.example.com/v1",
		DefaultModelID:       "gpt-4.1",
		DefaultCompatibility: "openai",
		DefaultGatewayPort:   18789,
		DefaultProviderID:    "provider-1",
	})

	ctx := testutil.NewContext(t, "user-aigw-success")
	if err := modelfactory.DefaultDaoFactory.UserResourceQuotaDao(ctx).DB().Create(&quota.Entity{
		UserID:                 ctx.GetUserID(),
		ResourceName:           "OPENCLAW_INSTANCE",
		ResourceKey:            "",
		ResourceQuotaAvailable: 1,
		ResourceQuotaTotal:     1,
	}).Error; err != nil {
		t.Fatalf("seed quota: %v", err)
	}

	sandboxStub := &sandboxAdapterStub{
		createResp: &psandbox.Sandbox{SandboxID: "sbx-aigw-success"},
		execCommandFunc: func(_ context.Context, _ string, _ string, _ int) (*psandbox.ExecCommandResult, error) {
			return &psandbox.ExecCommandResult{Status: "SUCCESS", ExitCode: 0}, nil
		},
	}
	aiGateway := &aiGatewayAdapterStub{
		createResp: &paigateway.CreateApiKeyResponse{KeyID: "key-success", APIKey: "sk'a-success"},
	}
	logic := instancelogic.NewLogicForTest(
		modelfactory.DefaultDaoFactory.InstanceDao(ctx),
		modelfactory.DefaultDaoFactory.UserResourceQuotaDao(ctx),
		sandboxStub,
		aiGateway,
		nil,
		nil,
		"tpl-1",
	)

	resp, err := logic.CreateInstance(ctx, &transport.CreateInstanceRequest{})
	if err != nil {
		t.Fatalf("create instance: %v", err)
	}
	if len(aiGateway.revokedKeyIDs) != 0 {
		t.Fatalf("did not expect ai-gateway key revocation, got %#v", aiGateway.revokedKeyIDs)
	}
	if sandboxStub.lastDeletedSandbox != "" {
		t.Fatalf("did not expect sandbox cleanup, got %q", sandboxStub.lastDeletedSandbox)
	}
	if got := sandboxStub.lastExecCommand; got != "" {
		t.Fatalf("expected onboard command to be skipped, got %q", got)
	}

	got, err := modelfactory.DefaultDaoFactory.InstanceDao(ctx).GetByInstanceID(ctx, resp.InstanceID)
	if err != nil {
		t.Fatalf("query instance: %v", err)
	}
	if got.AiGatewayKeyID != "key-success" {
		t.Fatalf("expected ai-gateway key id to be persisted after successful onboard, got %q", got.AiGatewayKeyID)
	}
}

func TestResumeInstanceAppliesDefaultTimeoutBeforeSandboxCall(t *testing.T) {
	testutil.NewMySQLDB(t, "..", "..", "migrations")

	ctx := testutil.NewContext(t, "user-1")
	entity := &modelinstance.Entity{
		InstanceId: "ins-resume-default-timeout",
		Status:     modelinstance.InstanceStatusPaused,
		SandboxId:  "sbx-resume-default-timeout",
		TimeoutAt:  time.Now().Add(time.Hour),
	}
	if err := modelfactory.DefaultDaoFactory.InstanceDao(ctx).Create(ctx, entity); err != nil {
		t.Fatalf("seed resume instance: %v", err)
	}

	adapter := &sandboxAdapterStub{
		resumeHook: func() {
			time.Sleep(1200 * time.Millisecond)
		},
	}
	logic := instancelogic.NewLogicForTest(
		modelfactory.DefaultDaoFactory.InstanceDao(ctx),
		modelfactory.DefaultDaoFactory.UserResourceQuotaDao(ctx),
		adapter,
		nil, // aiGatewayAdapter
		nil, // operationHistoryDao
		nil,
		"tpl-1",
	)

	before := time.Now()
	resp, err := logic.ResumeInstance(ctx, entity.InstanceId, nil)
	if err != nil {
		t.Fatalf("resume instance: %v", err)
	}
	if adapter.lastResumeRequest == nil || adapter.lastResumeRequest.Timeout == nil {
		t.Fatalf("expected default timeout in sandbox request")
	}
	if *adapter.lastResumeRequest.Timeout != transport.DefaultInstanceTimeoutSeconds {
		t.Fatalf("unexpected sandbox timeout: %d", *adapter.lastResumeRequest.Timeout)
	}
	if resp.TimeoutAt == nil {
		t.Fatalf("expected timeout_at in response")
	}
	lowerBound := before.Add(time.Duration(transport.DefaultInstanceTimeoutSeconds) * time.Second)
	upperBound := before.Add(time.Duration(transport.DefaultInstanceTimeoutSeconds)*time.Second + 700*time.Millisecond)
	if resp.TimeoutAt.Before(lowerBound) || resp.TimeoutAt.After(upperBound) {
		t.Fatalf("timeout_at should be computed before RPC delay, got %v", resp.TimeoutAt)
	}
}

func TestSetInstanceTimeoutComputesTimeoutBeforeSandboxCall(t *testing.T) {
	testutil.NewMySQLDB(t, "..", "..", "migrations")

	ctx := testutil.NewContext(t, "user-1")
	entity := &modelinstance.Entity{
		InstanceId: "ins-set-timeout-before-rpc",
		Status:     modelinstance.InstanceStatusRunning,
		SandboxId:  "sbx-set-timeout-before-rpc",
		TimeoutAt:  time.Now().Add(time.Hour),
	}
	if err := modelfactory.DefaultDaoFactory.InstanceDao(ctx).Create(ctx, entity); err != nil {
		t.Fatalf("seed timeout instance: %v", err)
	}

	adapter := &sandboxAdapterStub{
		setTimeoutHook: func() {
			time.Sleep(1200 * time.Millisecond)
		},
	}
	logic := instancelogic.NewLogicForTest(
		modelfactory.DefaultDaoFactory.InstanceDao(ctx),
		modelfactory.DefaultDaoFactory.UserResourceQuotaDao(ctx),
		adapter,
		nil, // aiGatewayAdapter
		nil, // operationHistoryDao
		nil,
		"tpl-1",
	)

	before := time.Now()
	resp, err := logic.SetInstanceTimeout(ctx, entity.InstanceId, &transport.SetTimeoutRequest{Timeout: ptr(int32(30))})
	if err != nil {
		t.Fatalf("set timeout: %v", err)
	}
	if resp.TimeoutAt == nil {
		t.Fatalf("expected timeout_at in response")
	}
	lowerBound := before.Add(30 * time.Second)
	upperBound := before.Add(30*time.Second + 700*time.Millisecond)
	if resp.TimeoutAt.Before(lowerBound) || resp.TimeoutAt.After(upperBound) {
		t.Fatalf("timeout_at should be computed before RPC delay, got %v", resp.TimeoutAt)
	}
}

func TestGetAndListInstancesRespectTenantIsolation(t *testing.T) {
	testutil.NewMySQLDB(t, "..", "..", "migrations")

	ownerCtx := testutil.NewContext(t, "user-1")
	otherCtx := testutil.NewContext(t, "user-2")
	dao := modelfactory.DefaultDaoFactory.InstanceDao(ownerCtx)

	older := &modelinstance.Entity{
		InstanceId: "ins-older",
		Status:     modelinstance.InstanceStatusRunning,
		SandboxId:  "sbx-old",
		TimeoutAt:  time.Now().Add(time.Hour),
	}
	if err := dao.Create(ownerCtx, older); err != nil {
		t.Fatalf("create older: %v", err)
	}
	if err := dao.DB().Model(&modelinstance.Entity{}).
		Where("id = ?", older.Id).
		Update("created_at", time.Now().Add(-time.Hour)).Error; err != nil {
		t.Fatalf("backdate created_at: %v", err)
	}

	newer := &modelinstance.Entity{
		InstanceId: "ins-newer",
		Status:     modelinstance.InstanceStatusRunning,
		SandboxId:  "sbx-new",
		TimeoutAt:  time.Now().Add(2 * time.Hour),
	}
	if err := dao.Create(ownerCtx, newer); err != nil {
		t.Fatalf("create newer: %v", err)
	}

	logic := instancelogic.NewLogicForTest(
		modelfactory.DefaultDaoFactory.InstanceDao(ownerCtx),
		modelfactory.DefaultDaoFactory.UserResourceQuotaDao(ownerCtx),
		&sandboxAdapterStub{},
		nil, // aiGatewayAdapter
		nil, // operationHistoryDao
		nil,
		"tpl-1",
	)

	got, err := logic.GetInstance(ownerCtx, newer.InstanceId)
	if err != nil {
		t.Fatalf("get instance: %v", err)
	}
	if got.InstanceID != newer.InstanceId {
		t.Fatalf("unexpected instance id: %s", got.InstanceID)
	}

	if _, err := logic.GetInstance(otherCtx, newer.InstanceId); !errors.Is(err, errcode.ErrInstanceNotFound) {
		t.Fatalf("expected not found for other tenant, got %v", err)
	}

	list, err := logic.ListInstances(ownerCtx, 1, 10)
	if err != nil {
		t.Fatalf("list instances: %v", err)
	}
	if len(list.Items) != 2 {
		t.Fatalf("expected two items, got %d", len(list.Items))
	}
	if list.Items[0].InstanceID != newer.InstanceId {
		t.Fatalf("expected newest instance first, got %s", list.Items[0].InstanceID)
	}
}

func TestDestroyInstanceSuccess(t *testing.T) {
	testutil.NewMySQLDB(t, "..", "..", "migrations")

	ctx := testutil.NewContext(t, "user-1")
	if err := modelfactory.DefaultDaoFactory.UserResourceQuotaDao(ctx).DB().Create(&quota.Entity{
		UserID:                 ctx.GetUserID(),
		ResourceName:           "OPENCLAW_INSTANCE",
		ResourceKey:            "",
		ResourceQuotaAvailable: 0,
		ResourceQuotaTotal:     1,
	}).Error; err != nil {
		t.Fatalf("seed quota: %v", err)
	}

	entity := &modelinstance.Entity{
		InstanceId: "ins-destroy-success",
		Status:     modelinstance.InstanceStatusRunning,
		SandboxId:  "sbx-destroy-success",
		TimeoutAt:  time.Now().Add(time.Hour),
	}
	if err := modelfactory.DefaultDaoFactory.InstanceDao(ctx).Create(ctx, entity); err != nil {
		t.Fatalf("create instance: %v", err)
	}

	logic := instancelogic.NewLogicForTest(
		modelfactory.DefaultDaoFactory.InstanceDao(ctx),
		modelfactory.DefaultDaoFactory.UserResourceQuotaDao(ctx),
		&sandboxAdapterStub{},
		nil, // aiGatewayAdapter
		nil, // operationHistoryDao
		nil,
		"tpl-1",
	)

	resp, err := logic.DestroyInstance(ctx, entity.InstanceId)
	if err != nil {
		t.Fatalf("destroy instance: %v", err)
	}
	if resp.Status != modelinstance.InstanceStatusDeleted {
		t.Fatalf("unexpected destroy status: %s", resp.Status)
	}

	if _, err := modelfactory.DefaultDaoFactory.InstanceDao(ctx).GetByInstanceID(ctx, entity.InstanceId); !errors.Is(err, errcode.ErrInstanceNotFound) {
		t.Fatalf("expected soft deleted instance to be hidden, got %v", err)
	}

	quotaEntity, err := modelfactory.DefaultDaoFactory.UserResourceQuotaDao(ctx).
		SelectQuota(ctx.GetUserID(), "OPENCLAW_INSTANCE", "")
	if err != nil {
		t.Fatalf("select quota: %v", err)
	}
	if quotaEntity.ResourceQuotaAvailable != 1 {
		t.Fatalf("expected quota to be released, got %d", quotaEntity.ResourceQuotaAvailable)
	}
}

func TestListInstancesExcludesSoftDeletedFromTotal(t *testing.T) {
	testutil.NewMySQLDB(t, "..", "..", "migrations")

	ctx := testutil.NewContext(t, "user-1")
	dao := modelfactory.DefaultDaoFactory.InstanceDao(ctx)

	active := &modelinstance.Entity{
		InstanceId: "ins-active",
		Status:     modelinstance.InstanceStatusRunning,
		SandboxId:  "sbx-active",
		TimeoutAt:  time.Now().Add(time.Hour),
	}
	if err := dao.Create(ctx, active); err != nil {
		t.Fatalf("create active: %v", err)
	}

	deleted := &modelinstance.Entity{
		InstanceId: "ins-deleted",
		Status:     modelinstance.InstanceStatusDeleted,
		SandboxId:  "sbx-deleted",
		TimeoutAt:  time.Now().Add(time.Hour),
	}
	if err := dao.Create(ctx, deleted); err != nil {
		t.Fatalf("create deleted: %v", err)
	}
	if err := dao.DeleteByID(ctx, deleted.Id); err != nil {
		t.Fatalf("soft delete instance: %v", err)
	}

	logic := instancelogic.NewLogicForTest(
		modelfactory.DefaultDaoFactory.InstanceDao(ctx),
		modelfactory.DefaultDaoFactory.UserResourceQuotaDao(ctx),
		&sandboxAdapterStub{},
		nil, // aiGatewayAdapter
		nil, // operationHistoryDao
		nil,
		"tpl-1",
	)

	list, err := logic.ListInstances(ctx, 1, 10)
	if err != nil {
		t.Fatalf("list instances: %v", err)
	}
	if list.Total != 1 {
		t.Fatalf("expected total=1 after soft delete, got %d", list.Total)
	}
	if len(list.Items) != 1 {
		t.Fatalf("expected 1 item after soft delete, got %d", len(list.Items))
	}
	if list.Items[0].InstanceID != active.InstanceId {
		t.Fatalf("expected active instance, got %s", list.Items[0].InstanceID)
	}
}

func TestDestroyInstanceStatusValidationAndTenantIsolation(t *testing.T) {
	testutil.NewMySQLDB(t, "..", "..", "migrations")

	ownerCtx := testutil.NewContext(t, "user-1")
	otherCtx := testutil.NewContext(t, "user-2")
	dao := modelfactory.DefaultDaoFactory.InstanceDao(ownerCtx)

	failed := &modelinstance.Entity{
		InstanceId: "ins-failed",
		Status:     modelinstance.InstanceStatusFailed,
		SandboxId:  "sbx-failed",
		TimeoutAt:  time.Now().Add(time.Hour),
	}
	if err := dao.Create(ownerCtx, failed); err != nil {
		t.Fatalf("create failed instance: %v", err)
	}

	running := &modelinstance.Entity{
		InstanceId: "ins-tenant",
		Status:     modelinstance.InstanceStatusRunning,
		SandboxId:  "sbx-tenant",
		TimeoutAt:  time.Now().Add(time.Hour),
	}
	if err := dao.Create(ownerCtx, running); err != nil {
		t.Fatalf("create running instance: %v", err)
	}

	logic := instancelogic.NewLogicForTest(
		dao,
		modelfactory.DefaultDaoFactory.UserResourceQuotaDao(ownerCtx),
		&sandboxAdapterStub{},
		nil, // aiGatewayAdapter
		nil, // operationHistoryDao
		nil,
		"tpl-1",
	)

	resp, err := logic.DestroyInstance(ownerCtx, failed.InstanceId)
	if err != nil {
		t.Fatalf("destroy failed instance: %v", err)
	}
	if resp.Status != modelinstance.InstanceStatusDeleted {
		t.Fatalf("expected failed instance to be deletable, got %s", resp.Status)
	}

	if _, err := logic.DestroyInstance(otherCtx, running.InstanceId); !errors.Is(err, errcode.ErrInstanceNotFound) {
		t.Fatalf("expected tenant isolation, got %v", err)
	}
}

func TestDestroyInstanceTreatsSandboxNotFoundAsSuccess(t *testing.T) {
	testutil.NewMySQLDB(t, "..", "..", "migrations")

	ctx := testutil.NewContext(t, "user-1")
	if err := modelfactory.DefaultDaoFactory.UserResourceQuotaDao(ctx).DB().Create(&quota.Entity{
		UserID:                 ctx.GetUserID(),
		ResourceName:           "OPENCLAW_INSTANCE",
		ResourceKey:            "",
		ResourceQuotaAvailable: 0,
		ResourceQuotaTotal:     1,
	}).Error; err != nil {
		t.Fatalf("seed quota: %v", err)
	}

	entity := &modelinstance.Entity{
		InstanceId: "ins-sandbox-404",
		Status:     modelinstance.InstanceStatusPaused,
		SandboxId:  "sbx-sandbox-404",
		TimeoutAt:  time.Now().Add(time.Hour),
	}
	if err := modelfactory.DefaultDaoFactory.InstanceDao(ctx).Create(ctx, entity); err != nil {
		t.Fatalf("create instance: %v", err)
	}

	logic := instancelogic.NewLogicForTest(
		modelfactory.DefaultDaoFactory.InstanceDao(ctx),
		modelfactory.DefaultDaoFactory.UserResourceQuotaDao(ctx),
		&sandboxAdapterStub{deleteErr: errcode.ErrSandboxNotFound},
		nil, // aiGatewayAdapter
		nil, // operationHistoryDao
		nil,
		"tpl-1",
	)

	resp, err := logic.DestroyInstance(ctx, entity.InstanceId)
	if err != nil {
		t.Fatalf("destroy instance: %v", err)
	}
	if resp.Status != modelinstance.InstanceStatusDeleted {
		t.Fatalf("unexpected destroy status: %s", resp.Status)
	}
}

func TestPauseInstanceSuccessAndConflictAreIdempotent(t *testing.T) {
	testutil.NewMySQLDB(t, "..", "..", "migrations")

	ctx := testutil.NewContext(t, "user-1")
	for _, tc := range []struct {
		name       string
		sandboxErr error
	}{
		{name: "success"},
		{name: "conflict", sandboxErr: errcode.Wrap(errcode.ErrSandboxStatusConflict, "sandbox already paused")},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dao := modelfactory.DefaultDaoFactory.InstanceDao(ctx)
			entity := &modelinstance.Entity{
				InstanceId: "ins-pause-" + tc.name,
				Status:     modelinstance.InstanceStatusRunning,
				SandboxId:  "sbx-pause-" + tc.name,
				TimeoutAt:  time.Now().Add(time.Hour),
			}
			if err := dao.Create(ctx, entity); err != nil {
				t.Fatalf("create instance: %v", err)
			}

			adapter := &sandboxAdapterStub{pauseErr: tc.sandboxErr}
			logic := instancelogic.NewLogicForTest(
				dao,
				modelfactory.DefaultDaoFactory.UserResourceQuotaDao(ctx),
				adapter,
				nil, // aiGatewayAdapter
				nil, // operationHistoryDao
				nil,
				"tpl-1",
			)

			resp, err := logic.PauseInstance(ctx, entity.InstanceId)
			if err != nil {
				t.Fatalf("pause instance: %v", err)
			}
			if resp.Status != modelinstance.InstanceStatusPaused {
				t.Fatalf("unexpected status: %s", resp.Status)
			}
			if adapter.lastPausedSandbox != entity.SandboxId {
				t.Fatalf("expected sandbox pause call for %s, got %s", entity.SandboxId, adapter.lastPausedSandbox)
			}

			got, err := dao.GetByInstanceID(ctx, entity.InstanceId)
			if err != nil {
				t.Fatalf("query instance: %v", err)
			}
			if got.Status != modelinstance.InstanceStatusPaused {
				t.Fatalf("expected paused status, got %s", got.Status)
			}
		})
	}
}

func TestPauseInstanceValidationAndSandboxFailure(t *testing.T) {
	testutil.NewMySQLDB(t, "..", "..", "migrations")

	ownerCtx := testutil.NewContext(t, "user-1")
	otherCtx := testutil.NewContext(t, "user-2")
	dao := modelfactory.DefaultDaoFactory.InstanceDao(ownerCtx)
	entity := &modelinstance.Entity{
		InstanceId: "ins-pause-validate",
		Status:     modelinstance.InstanceStatusPaused,
		SandboxId:  "sbx-pause-validate",
		TimeoutAt:  time.Now().Add(time.Hour),
	}
	if err := dao.Create(ownerCtx, entity); err != nil {
		t.Fatalf("create instance: %v", err)
	}

	logic := instancelogic.NewLogicForTest(
		dao,
		modelfactory.DefaultDaoFactory.UserResourceQuotaDao(ownerCtx),
		&sandboxAdapterStub{},
		nil, // aiGatewayAdapter
		nil, // operationHistoryDao
		nil,
		"tpl-1",
	)

	if _, err := logic.PauseInstance(ownerCtx, entity.InstanceId); !errors.Is(err, errcode.ErrInstanceStatusInvalid) {
		t.Fatalf("expected invalid status, got %v", err)
	}
	if _, err := logic.PauseInstance(otherCtx, entity.InstanceId); !errors.Is(err, errcode.ErrInstanceNotFound) {
		t.Fatalf("expected tenant isolation, got %v", err)
	}

	entity.Status = modelinstance.InstanceStatusRunning
	if err := dao.DB().Model(&modelinstance.Entity{}).Where("id = ?", entity.Id).
		Update("status", modelinstance.InstanceStatusRunning).Error; err != nil {
		t.Fatalf("reset status: %v", err)
	}

	failLogic := instancelogic.NewLogicForTest(
		dao,
		modelfactory.DefaultDaoFactory.UserResourceQuotaDao(ownerCtx),
		&sandboxAdapterStub{pauseErr: errcode.ErrSandboxServiceError},
		nil, // aiGatewayAdapter
		nil, // operationHistoryDao
		nil,
		"tpl-1",
	)
	if _, err := failLogic.PauseInstance(ownerCtx, entity.InstanceId); !errors.Is(err, errcode.ErrSandboxServiceError) {
		t.Fatalf("expected sandbox service error, got %v", err)
	}

	got, err := dao.GetByInstanceID(ownerCtx, entity.InstanceId)
	if err != nil {
		t.Fatalf("query instance: %v", err)
	}
	if got.Status != modelinstance.InstanceStatusRunning {
		t.Fatalf("status should remain running after sandbox failure, got %s", got.Status)
	}
}

func TestPauseInstanceDoesNotOverrideDeletingStatus(t *testing.T) {
	testutil.NewMySQLDB(t, "..", "..", "migrations")

	ctx := testutil.NewContext(t, "user-1")
	dao := modelfactory.DefaultDaoFactory.InstanceDao(ctx)
	entity := &modelinstance.Entity{
		InstanceId: "ins-pause-race",
		Status:     modelinstance.InstanceStatusRunning,
		SandboxId:  "sbx-pause-race",
		TimeoutAt:  time.Now().Add(time.Hour),
	}
	if err := dao.Create(ctx, entity); err != nil {
		t.Fatalf("create instance: %v", err)
	}

	logic := instancelogic.NewLogicForTest(
		dao,
		modelfactory.DefaultDaoFactory.UserResourceQuotaDao(ctx),
		&sandboxAdapterStub{
			pauseHook: func() {
				if err := dao.UpdateStatus(ctx, entity.Id, modelinstance.InstanceStatusDeleting); err != nil {
					t.Fatalf("set deleting status: %v", err)
				}
			},
		},
		nil, // aiGatewayAdapter
		nil, // operationHistoryDao
		nil,
		"tpl-1",
	)

	if _, err := logic.PauseInstance(ctx, entity.InstanceId); !errors.Is(err, errcode.ErrInstanceStatusInvalid) {
		t.Fatalf("expected status invalid after concurrent delete, got %v", err)
	}

	got, err := dao.GetByInstanceID(ctx, entity.InstanceId)
	if err != nil {
		t.Fatalf("query instance: %v", err)
	}
	if got.Status != modelinstance.InstanceStatusDeleting {
		t.Fatalf("expected deleting status preserved, got %s", got.Status)
	}
}

func TestResumeInstanceSuccessConflictAndValidation(t *testing.T) {
	testutil.NewMySQLDB(t, "..", "..", "migrations")

	ctx := testutil.NewContext(t, "user-1")
	dao := modelfactory.DefaultDaoFactory.InstanceDao(ctx)

	for _, tc := range []struct {
		name        string
		req         *transport.ResumeInstanceRequest
		sandboxErr  error
		expectTimed bool
	}{
		{name: "without-timeout", req: &transport.ResumeInstanceRequest{}},
		{name: "with-timeout", req: &transport.ResumeInstanceRequest{Timeout: ptr(int32(120))}, expectTimed: true},
		{name: "conflict", req: &transport.ResumeInstanceRequest{Timeout: ptr(int32(90))}, sandboxErr: errcode.Wrap(errcode.ErrSandboxStatusConflict, "sandbox already running"), expectTimed: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			entity := &modelinstance.Entity{
				InstanceId: "ins-resume-" + tc.name,
				Status:     modelinstance.InstanceStatusPaused,
				SandboxId:  "sbx-resume-" + tc.name,
				TimeoutAt:  time.Now().Add(time.Hour),
			}
			if err := dao.Create(ctx, entity); err != nil {
				t.Fatalf("create instance: %v", err)
			}

			adapter := &sandboxAdapterStub{resumeErr: tc.sandboxErr}
			logic := instancelogic.NewLogicForTest(
				dao,
				modelfactory.DefaultDaoFactory.UserResourceQuotaDao(ctx),
				adapter,
				nil, // aiGatewayAdapter
				nil, // operationHistoryDao
				nil,
				"tpl-1",
			)

			before := time.Now()
			resp, err := logic.ResumeInstance(ctx, entity.InstanceId, tc.req)
			if err != nil {
				t.Fatalf("resume instance: %v", err)
			}
			if resp.Status != modelinstance.InstanceStatusRunning {
				t.Fatalf("unexpected status: %s", resp.Status)
			}
			if tc.expectTimed && resp.TimeoutAt == nil {
				t.Fatalf("expected timeout_at in resume response")
			}
			if adapter.lastResumedSandbox != entity.SandboxId {
				t.Fatalf("expected resume sandbox %s, got %s", entity.SandboxId, adapter.lastResumedSandbox)
			}

			got, err := dao.GetByInstanceID(ctx, entity.InstanceId)
			if err != nil {
				t.Fatalf("query instance: %v", err)
			}
			if got.Status != modelinstance.InstanceStatusRunning {
				t.Fatalf("expected running status, got %s", got.Status)
			}
			if tc.expectTimed {
				if adapter.lastResumeRequest == nil || adapter.lastResumeRequest.Timeout == nil {
					t.Fatalf("expected resume timeout request")
				}
				minTimeout := before.Add(time.Duration(*tc.req.Timeout) * time.Second).Add(-2 * time.Second)
				maxTimeout := before.Add(time.Duration(*tc.req.Timeout) * time.Second).Add(2 * time.Second)
				if got.TimeoutAt.Before(minTimeout) || got.TimeoutAt.After(maxTimeout) {
					t.Fatalf("unexpected timeout_at after resume: %v", got.TimeoutAt)
				}
			}
		})
	}

	running := &modelinstance.Entity{
		InstanceId: "ins-resume-invalid",
		Status:     modelinstance.InstanceStatusRunning,
		SandboxId:  "sbx-resume-invalid",
		TimeoutAt:  time.Now().Add(time.Hour),
	}
	if err := dao.Create(ctx, running); err != nil {
		t.Fatalf("create running instance: %v", err)
	}

	logic := instancelogic.NewLogicForTest(
		dao,
		modelfactory.DefaultDaoFactory.UserResourceQuotaDao(ctx),
		&sandboxAdapterStub{},
		nil, // aiGatewayAdapter
		nil, // operationHistoryDao
		nil,
		"tpl-1",
	)

	if _, err := logic.ResumeInstance(ctx, running.InstanceId, &transport.ResumeInstanceRequest{}); !errors.Is(err, errcode.ErrInstanceStatusInvalid) {
		t.Fatalf("expected invalid status, got %v", err)
	}
	if _, err := logic.ResumeInstance(ctx, running.InstanceId, &transport.ResumeInstanceRequest{Timeout: ptr(int32(0))}); !errors.Is(err, errcode.ErrInstanceInvalidParam) {
		t.Fatalf("expected invalid param, got %v", err)
	}
	if _, err := logic.ResumeInstance(ctx, running.InstanceId, &transport.ResumeInstanceRequest{Timeout: ptr(transport.MaxInstanceTimeoutSeconds + 1)}); !errors.Is(err, errcode.ErrInstanceInvalidParam) {
		t.Fatalf("expected timeout upper-bound validation, got %v", err)
	}
}

func TestResumeInstanceSandboxFailureLeavesStateUntouched(t *testing.T) {
	testutil.NewMySQLDB(t, "..", "..", "migrations")

	ctx := testutil.NewContext(t, "user-1")
	dao := modelfactory.DefaultDaoFactory.InstanceDao(ctx)
	entity := &modelinstance.Entity{
		InstanceId: "ins-resume-fail",
		Status:     modelinstance.InstanceStatusPaused,
		SandboxId:  "sbx-resume-fail",
		TimeoutAt:  time.Now().Add(time.Hour),
	}
	if err := dao.Create(ctx, entity); err != nil {
		t.Fatalf("create instance: %v", err)
	}

	logic := instancelogic.NewLogicForTest(
		dao,
		modelfactory.DefaultDaoFactory.UserResourceQuotaDao(ctx),
		&sandboxAdapterStub{resumeErr: errcode.ErrSandboxServiceError},
		nil, // aiGatewayAdapter
		nil, // operationHistoryDao
		nil,
		"tpl-1",
	)

	if _, err := logic.ResumeInstance(ctx, entity.InstanceId, &transport.ResumeInstanceRequest{Timeout: ptr(int32(60))}); !errors.Is(err, errcode.ErrSandboxServiceError) {
		t.Fatalf("expected sandbox service error, got %v", err)
	}

	got, err := dao.GetByInstanceID(ctx, entity.InstanceId)
	if err != nil {
		t.Fatalf("query instance: %v", err)
	}
	if got.Status != modelinstance.InstanceStatusPaused {
		t.Fatalf("status should remain paused, got %s", got.Status)
	}
}

func TestResumeInstanceDoesNotOverrideDeletingStatus(t *testing.T) {
	testutil.NewMySQLDB(t, "..", "..", "migrations")

	ctx := testutil.NewContext(t, "user-1")
	dao := modelfactory.DefaultDaoFactory.InstanceDao(ctx)
	entity := &modelinstance.Entity{
		InstanceId: "ins-resume-race",
		Status:     modelinstance.InstanceStatusPaused,
		SandboxId:  "sbx-resume-race",
		TimeoutAt:  time.Now().Add(time.Hour),
	}
	if err := dao.Create(ctx, entity); err != nil {
		t.Fatalf("create instance: %v", err)
	}

	logic := instancelogic.NewLogicForTest(
		dao,
		modelfactory.DefaultDaoFactory.UserResourceQuotaDao(ctx),
		&sandboxAdapterStub{
			resumeHook: func() {
				if err := dao.UpdateStatus(ctx, entity.Id, modelinstance.InstanceStatusDeleting); err != nil {
					t.Fatalf("set deleting status: %v", err)
				}
			},
		},
		nil, // aiGatewayAdapter
		nil, // operationHistoryDao
		nil,
		"tpl-1",
	)

	if _, err := logic.ResumeInstance(ctx, entity.InstanceId, &transport.ResumeInstanceRequest{Timeout: ptr(int32(60))}); !errors.Is(err, errcode.ErrInstanceStatusInvalid) {
		t.Fatalf("expected status invalid after concurrent delete, got %v", err)
	}

	got, err := dao.GetByInstanceID(ctx, entity.InstanceId)
	if err != nil {
		t.Fatalf("query instance: %v", err)
	}
	if got.Status != modelinstance.InstanceStatusDeleting {
		t.Fatalf("expected deleting status preserved, got %s", got.Status)
	}
}

func TestSetInstanceTimeoutSuccessAndValidation(t *testing.T) {
	testutil.NewMySQLDB(t, "..", "..", "migrations")

	ctx := testutil.NewContext(t, "user-1")
	dao := modelfactory.DefaultDaoFactory.InstanceDao(ctx)
	for _, status := range []string{modelinstance.InstanceStatusRunning, modelinstance.InstanceStatusPaused} {
		entity := &modelinstance.Entity{
			InstanceId: "ins-timeout-" + status,
			Status:     status,
			SandboxId:  "sbx-timeout-" + status,
			TimeoutAt:  time.Now().Add(time.Hour),
		}
		if err := dao.Create(ctx, entity); err != nil {
			t.Fatalf("create instance %s: %v", status, err)
		}

		adapter := &sandboxAdapterStub{}
		logic := instancelogic.NewLogicForTest(
			dao,
			modelfactory.DefaultDaoFactory.UserResourceQuotaDao(ctx),
			adapter,
			nil, // aiGatewayAdapter
			nil, // operationHistoryDao
			nil,
			"tpl-1",
		)

		before := time.Now()
		resp, err := logic.SetInstanceTimeout(ctx, entity.InstanceId, &transport.SetTimeoutRequest{Timeout: ptr(int32(300))})
		if err != nil {
			t.Fatalf("set timeout: %v", err)
		}
		if adapter.lastTimeoutSandbox != entity.SandboxId || adapter.lastTimeoutValue != 300 {
			t.Fatalf("unexpected timeout adapter call: sandbox=%s timeout=%d", adapter.lastTimeoutSandbox, adapter.lastTimeoutValue)
		}
		if resp.TimeoutAt == nil {
			t.Fatalf("expected timeout_at in response")
		}
		minTimeout := before.Add(300 * time.Second).Add(-2 * time.Second)
		maxTimeout := before.Add(300 * time.Second).Add(2 * time.Second)
		if resp.TimeoutAt.Before(minTimeout) || resp.TimeoutAt.After(maxTimeout) {
			t.Fatalf("unexpected response timeout_at: %v", resp.TimeoutAt)
		}
	}

	failed := &modelinstance.Entity{
		InstanceId: "ins-timeout-invalid",
		Status:     modelinstance.InstanceStatusFailed,
		SandboxId:  "sbx-timeout-invalid",
		TimeoutAt:  time.Now().Add(time.Hour),
	}
	if err := dao.Create(ctx, failed); err != nil {
		t.Fatalf("create failed instance: %v", err)
	}

	logic := instancelogic.NewLogicForTest(
		dao,
		modelfactory.DefaultDaoFactory.UserResourceQuotaDao(ctx),
		&sandboxAdapterStub{},
		nil, // aiGatewayAdapter
		nil, // operationHistoryDao
		nil,
		"tpl-1",
	)

	if _, err := logic.SetInstanceTimeout(ctx, failed.InstanceId, &transport.SetTimeoutRequest{Timeout: ptr(int32(10))}); !errors.Is(err, errcode.ErrInstanceStatusInvalid) {
		t.Fatalf("expected invalid status, got %v", err)
	}
	if _, err := logic.SetInstanceTimeout(ctx, failed.InstanceId, &transport.SetTimeoutRequest{}); !errors.Is(err, errcode.ErrInstanceInvalidParam) {
		t.Fatalf("expected invalid param, got %v", err)
	}
	if _, err := logic.SetInstanceTimeout(ctx, failed.InstanceId, &transport.SetTimeoutRequest{Timeout: ptr(transport.MaxInstanceTimeoutSeconds + 1)}); !errors.Is(err, errcode.ErrInstanceInvalidParam) {
		t.Fatalf("expected timeout upper-bound validation, got %v", err)
	}
}

func TestSetInstanceTimeoutSandboxFailureLeavesStateUntouched(t *testing.T) {
	testutil.NewMySQLDB(t, "..", "..", "migrations")

	ctx := testutil.NewContext(t, "user-1")
	dao := modelfactory.DefaultDaoFactory.InstanceDao(ctx)
	entity := &modelinstance.Entity{
		InstanceId: "ins-timeout-fail",
		Status:     modelinstance.InstanceStatusPaused,
		SandboxId:  "sbx-timeout-fail",
		TimeoutAt:  time.Now().Add(time.Hour),
	}
	if err := dao.Create(ctx, entity); err != nil {
		t.Fatalf("create instance: %v", err)
	}

	originalRecord, err := dao.GetByInstanceID(ctx, entity.InstanceId)
	if err != nil {
		t.Fatalf("query original instance: %v", err)
	}
	logic := instancelogic.NewLogicForTest(
		dao,
		modelfactory.DefaultDaoFactory.UserResourceQuotaDao(ctx),
		&sandboxAdapterStub{setTimeoutErr: errcode.ErrSandboxServiceError},
		nil, // aiGatewayAdapter
		nil, // operationHistoryDao
		nil,
		"tpl-1",
	)

	if _, err := logic.SetInstanceTimeout(ctx, entity.InstanceId, &transport.SetTimeoutRequest{Timeout: ptr(int32(120))}); !errors.Is(err, errcode.ErrSandboxServiceError) {
		t.Fatalf("expected sandbox service error, got %v", err)
	}

	got, err := dao.GetByInstanceID(ctx, entity.InstanceId)
	if err != nil {
		t.Fatalf("query instance: %v", err)
	}
	if !got.TimeoutAt.Equal(originalRecord.TimeoutAt) {
		t.Fatalf("timeout_at should remain unchanged, got %v want %v", got.TimeoutAt, originalRecord.TimeoutAt)
	}
}

func TestSetInstanceTimeoutDoesNotOverrideDeletingStatus(t *testing.T) {
	testutil.NewMySQLDB(t, "..", "..", "migrations")

	ctx := testutil.NewContext(t, "user-1")
	dao := modelfactory.DefaultDaoFactory.InstanceDao(ctx)
	entity := &modelinstance.Entity{
		InstanceId: "ins-timeout-race",
		Status:     modelinstance.InstanceStatusRunning,
		SandboxId:  "sbx-timeout-race",
		TimeoutAt:  time.Now().Add(time.Hour),
	}
	if err := dao.Create(ctx, entity); err != nil {
		t.Fatalf("create instance: %v", err)
	}

	originalRecord, err := dao.GetByInstanceID(ctx, entity.InstanceId)
	if err != nil {
		t.Fatalf("query original instance: %v", err)
	}
	logic := instancelogic.NewLogicForTest(
		dao,
		modelfactory.DefaultDaoFactory.UserResourceQuotaDao(ctx),
		&sandboxAdapterStub{
			setTimeoutHook: func() {
				if err := dao.UpdateStatus(ctx, entity.Id, modelinstance.InstanceStatusDeleting); err != nil {
					t.Fatalf("set deleting status: %v", err)
				}
			},
		},
		nil, // aiGatewayAdapter
		nil, // operationHistoryDao
		nil,
		"tpl-1",
	)

	if _, err := logic.SetInstanceTimeout(ctx, entity.InstanceId, &transport.SetTimeoutRequest{Timeout: ptr(int32(120))}); !errors.Is(err, errcode.ErrInstanceStatusInvalid) {
		t.Fatalf("expected status invalid after concurrent delete, got %v", err)
	}

	got, err := dao.GetByInstanceID(ctx, entity.InstanceId)
	if err != nil {
		t.Fatalf("query instance: %v", err)
	}
	if got.Status != modelinstance.InstanceStatusDeleting {
		t.Fatalf("expected deleting status preserved, got %s", got.Status)
	}
	if !got.TimeoutAt.Equal(originalRecord.TimeoutAt) {
		t.Fatalf("expected timeout_at unchanged, got %v want %v", got.TimeoutAt, originalRecord.TimeoutAt)
	}
}

func TestDestroyInstanceMarksFailedOnSandboxDeleteFailure(t *testing.T) {
	testutil.NewMySQLDB(t, "..", "..", "migrations")

	ctx := testutil.NewContext(t, "user-1")
	if err := modelfactory.DefaultDaoFactory.UserResourceQuotaDao(ctx).DB().Create(&quota.Entity{
		UserID:                 ctx.GetUserID(),
		ResourceName:           "OPENCLAW_INSTANCE",
		ResourceKey:            "",
		ResourceQuotaAvailable: 0,
		ResourceQuotaTotal:     1,
	}).Error; err != nil {
		t.Fatalf("seed quota: %v", err)
	}

	entity := &modelinstance.Entity{
		InstanceId: "ins-destroy-fail",
		Status:     modelinstance.InstanceStatusRunning,
		SandboxId:  "sbx-destroy-fail",
		TimeoutAt:  time.Now().Add(time.Hour),
	}
	if err := modelfactory.DefaultDaoFactory.InstanceDao(ctx).Create(ctx, entity); err != nil {
		t.Fatalf("create instance: %v", err)
	}

	logic := instancelogic.NewLogicForTest(
		modelfactory.DefaultDaoFactory.InstanceDao(ctx),
		modelfactory.DefaultDaoFactory.UserResourceQuotaDao(ctx),
		&sandboxAdapterStub{deleteErr: errcode.ErrSandboxServiceError},
		nil, // aiGatewayAdapter
		nil, // operationHistoryDao
		nil,
		"tpl-1",
	)

	_, err := logic.DestroyInstance(ctx, entity.InstanceId)
	if !errors.Is(err, errcode.ErrSandboxServiceError) {
		t.Fatalf("expected sandbox service error, got %v", err)
	}

	got, getErr := modelfactory.DefaultDaoFactory.InstanceDao(ctx).GetByInstanceID(ctx, entity.InstanceId)
	if getErr != nil {
		t.Fatalf("get instance after failure: %v", getErr)
	}
	if got.Status != modelinstance.InstanceStatusFailed {
		t.Fatalf("expected failed status after sandbox delete failure, got %s", got.Status)
	}

	quotaEntity, err := modelfactory.DefaultDaoFactory.UserResourceQuotaDao(ctx).
		SelectQuota(ctx.GetUserID(), "OPENCLAW_INSTANCE", "")
	if err != nil {
		t.Fatalf("select quota: %v", err)
	}
	if quotaEntity.ResourceQuotaAvailable != 0 {
		t.Fatalf("quota should remain allocated, got %d", quotaEntity.ResourceQuotaAvailable)
	}
}

func TestDestroyInstanceTreatsAlreadyReleasedQuotaAsSuccess(t *testing.T) {
	testutil.NewMySQLDB(t, "..", "..", "migrations")

	ctx := testutil.NewContext(t, "user-1")
	if err := modelfactory.DefaultDaoFactory.UserResourceQuotaDao(ctx).DB().Create(&quota.Entity{
		UserID:                 ctx.GetUserID(),
		ResourceName:           "OPENCLAW_INSTANCE",
		ResourceKey:            "",
		ResourceQuotaAvailable: 1,
		ResourceQuotaTotal:     1,
	}).Error; err != nil {
		t.Fatalf("seed quota: %v", err)
	}

	entity := &modelinstance.Entity{
		InstanceId: "ins-destroy-retry",
		Status:     modelinstance.InstanceStatusRunning,
		SandboxId:  "sbx-destroy-retry",
		TimeoutAt:  time.Now().Add(time.Hour),
	}
	if err := modelfactory.DefaultDaoFactory.InstanceDao(ctx).Create(ctx, entity); err != nil {
		t.Fatalf("create instance: %v", err)
	}

	logic := instancelogic.NewLogicForTest(
		modelfactory.DefaultDaoFactory.InstanceDao(ctx),
		modelfactory.DefaultDaoFactory.UserResourceQuotaDao(ctx),
		&sandboxAdapterStub{},
		nil, // aiGatewayAdapter
		nil, // operationHistoryDao
		nil,
		"tpl-1",
	)

	resp, err := logic.DestroyInstance(ctx, entity.InstanceId)
	if err != nil {
		t.Fatalf("destroy instance with already released quota: %v", err)
	}
	if resp.Status != modelinstance.InstanceStatusDeleted {
		t.Fatalf("expected deleted status, got %s", resp.Status)
	}
}

func TestDestroyInstanceTreatsMissingQuotaRowAsSuccess(t *testing.T) {
	testutil.NewMySQLDB(t, "..", "..", "migrations")

	ctx := testutil.NewContext(t, "user-1")
	entity := &modelinstance.Entity{
		InstanceId: "ins-destroy-missing-quota",
		Status:     modelinstance.InstanceStatusRunning,
		SandboxId:  "sbx-destroy-missing-quota",
		TimeoutAt:  time.Now().Add(time.Hour),
	}
	if err := modelfactory.DefaultDaoFactory.InstanceDao(ctx).Create(ctx, entity); err != nil {
		t.Fatalf("create instance: %v", err)
	}

	logic := instancelogic.NewLogicForTest(
		modelfactory.DefaultDaoFactory.InstanceDao(ctx),
		modelfactory.DefaultDaoFactory.UserResourceQuotaDao(ctx),
		&sandboxAdapterStub{},
		nil, // aiGatewayAdapter
		nil, // operationHistoryDao
		nil,
		"tpl-1",
	)

	resp, err := logic.DestroyInstance(ctx, entity.InstanceId)
	if err != nil {
		t.Fatalf("destroy instance with missing quota row: %v", err)
	}
	if resp.Status != modelinstance.InstanceStatusDeleted {
		t.Fatalf("expected deleted status, got %s", resp.Status)
	}
}

func ptr[T any](v T) *T {
	return &v
}

func TestCreateInstanceRecordsOperationHistory(t *testing.T) {
	testutil.NewMySQLDB(t, "..", "..", "migrations")

	ctx := testutil.NewContext(t, "user-op-hist")
	quotaDB := modelfactory.DefaultDaoFactory.UserResourceQuotaDao(ctx)
	if err := quotaDB.DB().Create(&quota.Entity{
		UserID:                 ctx.GetUserID(),
		ResourceName:           "OPENCLAW_INSTANCE",
		ResourceKey:            "",
		ResourceQuotaAvailable: 2,
		ResourceQuotaTotal:     2,
	}).Error; err != nil {
		t.Fatalf("seed quota: %v", err)
	}

	opHistoryDao := modelfactory.DefaultDaoFactory.OperationHistoryDao(ctx)

	logic := instancelogic.NewLogicForTest(
		modelfactory.DefaultDaoFactory.InstanceDao(ctx),
		modelfactory.DefaultDaoFactory.UserResourceQuotaDao(ctx),
		&sandboxAdapterStub{createResp: &psandbox.Sandbox{SandboxID: "sbx-op-1"}},
		nil, // aiGatewayAdapter
		opHistoryDao,
		nil,
		"tpl-1",
	)

	resp, err := logic.CreateInstance(ctx, &transport.CreateInstanceRequest{})
	if err != nil {
		t.Fatalf("create instance: %v", err)
	}

	// 验证操作记录写入了 operation_histories 表
	ops, total, err := opHistoryDao.ListByInstanceID(ctx, resp.InstanceID, ctx.GetUserID(), 1, 10)
	if err != nil {
		t.Fatalf("list operations: %v", err)
	}
	if total != 1 {
		t.Fatalf("expected 1 operation record, got %d", total)
	}
	if ops[0].OperationType != operationhistory.OperationTypeCreate {
		t.Fatalf("expected CREATE operation type, got %s", ops[0].OperationType)
	}
	if ops[0].Status != operationhistory.StatusSuccess {
		t.Fatalf("expected SUCCESS status, got %s", ops[0].Status)
	}
	if ops[0].InstanceId != resp.InstanceID {
		t.Fatalf("expected instance_id %s, got %s", resp.InstanceID, ops[0].InstanceId)
	}
}

func TestPauseInstanceRecordsOperationHistory(t *testing.T) {
	testutil.NewMySQLDB(t, "..", "..", "migrations")

	ctx := testutil.NewContext(t, "user-op-pause")
	quotaDB := modelfactory.DefaultDaoFactory.UserResourceQuotaDao(ctx)
	if err := quotaDB.DB().Create(&quota.Entity{
		UserID:                 ctx.GetUserID(),
		ResourceName:           "OPENCLAW_INSTANCE",
		ResourceKey:            "",
		ResourceQuotaAvailable: 2,
		ResourceQuotaTotal:     2,
	}).Error; err != nil {
		t.Fatalf("seed quota: %v", err)
	}

	opHistoryDao := modelfactory.DefaultDaoFactory.OperationHistoryDao(ctx)

	logic := instancelogic.NewLogicForTest(
		modelfactory.DefaultDaoFactory.InstanceDao(ctx),
		modelfactory.DefaultDaoFactory.UserResourceQuotaDao(ctx),
		&sandboxAdapterStub{createResp: &psandbox.Sandbox{SandboxID: "sbx-op-pause"}},
		nil, // aiGatewayAdapter
		opHistoryDao,
		nil,
		"tpl-1",
	)

	// 先创建实例
	resp, err := logic.CreateInstance(ctx, &transport.CreateInstanceRequest{})
	if err != nil {
		t.Fatalf("create instance: %v", err)
	}

	// 暂停实例
	_, err = logic.PauseInstance(ctx, resp.InstanceID)
	if err != nil {
		t.Fatalf("pause instance: %v", err)
	}

	// 验证有 2 条操作记录（CREATE + PAUSE）
	ops, total, err := opHistoryDao.ListByInstanceID(ctx, resp.InstanceID, ctx.GetUserID(), 1, 10)
	if err != nil {
		t.Fatalf("list operations: %v", err)
	}
	if total != 2 {
		t.Fatalf("expected 2 operation records, got %d", total)
	}
	// 按 created_at DESC 排序，第一条应该是 PAUSE
	if ops[0].OperationType != operationhistory.OperationTypePause {
		t.Fatalf("expected PAUSE operation type first, got %s", ops[0].OperationType)
	}
	if ops[0].Status != operationhistory.StatusSuccess {
		t.Fatalf("expected SUCCESS status, got %s", ops[0].Status)
	}
}

func TestListOperationsReturnsOperationHistory(t *testing.T) {
	testutil.NewMySQLDB(t, "..", "..", "migrations")

	ctx := testutil.NewContext(t, "user-list-ops")
	quotaDB := modelfactory.DefaultDaoFactory.UserResourceQuotaDao(ctx)
	if err := quotaDB.DB().Create(&quota.Entity{
		UserID:                 ctx.GetUserID(),
		ResourceName:           "OPENCLAW_INSTANCE",
		ResourceKey:            "",
		ResourceQuotaAvailable: 2,
		ResourceQuotaTotal:     2,
	}).Error; err != nil {
		t.Fatalf("seed quota: %v", err)
	}

	opHistoryDao := modelfactory.DefaultDaoFactory.OperationHistoryDao(ctx)

	logic := instancelogic.NewLogicForTest(
		modelfactory.DefaultDaoFactory.InstanceDao(ctx),
		modelfactory.DefaultDaoFactory.UserResourceQuotaDao(ctx),
		&sandboxAdapterStub{createResp: &psandbox.Sandbox{SandboxID: "sbx-list-ops"}},
		nil, // aiGatewayAdapter
		opHistoryDao,
		nil,
		"tpl-1",
	)

	resp, err := logic.CreateInstance(ctx, &transport.CreateInstanceRequest{})
	if err != nil {
		t.Fatalf("create instance: %v", err)
	}

	// 通过 ListOperations API 查询
	opResp, err := logic.ListOperations(ctx, resp.InstanceID, 1, 20)
	if err != nil {
		t.Fatalf("list operations: %v", err)
	}
	if opResp.Total != 1 {
		t.Fatalf("expected total=1, got %d", opResp.Total)
	}
	if opResp.Items[0].OperationType != "CREATE" {
		t.Fatalf("expected CREATE, got %s", opResp.Items[0].OperationType)
	}
	if opResp.Items[0].Status != "SUCCESS" {
		t.Fatalf("expected SUCCESS, got %s", opResp.Items[0].Status)
	}
	if opResp.Items[0].InstanceID != resp.InstanceID {
		t.Fatalf("expected instance_id %s, got %s", resp.InstanceID, opResp.Items[0].InstanceID)
	}
}

func TestGetInstanceLogsRejectsNonRunningInstance(t *testing.T) {
	testutil.NewMySQLDB(t, "..", "..", "migrations")

	ctx := testutil.NewContext(t, "user-logs-status")
	quotaDB := modelfactory.DefaultDaoFactory.UserResourceQuotaDao(ctx)
	if err := quotaDB.DB().Create(&quota.Entity{
		UserID:                 ctx.GetUserID(),
		ResourceName:           "OPENCLAW_INSTANCE",
		ResourceKey:            "",
		ResourceQuotaAvailable: 2,
		ResourceQuotaTotal:     2,
	}).Error; err != nil {
		t.Fatalf("seed quota: %v", err)
	}

	opHistoryDao := modelfactory.DefaultDaoFactory.OperationHistoryDao(ctx)

	adapter := &sandboxAdapterStub{createResp: &psandbox.Sandbox{SandboxID: "sbx-logs"}}
	logic := instancelogic.NewLogicForTest(
		modelfactory.DefaultDaoFactory.InstanceDao(ctx),
		modelfactory.DefaultDaoFactory.UserResourceQuotaDao(ctx),
		adapter,
		nil, // aiGatewayAdapter
		opHistoryDao,
		nil,
		"tpl-1",
	)

	// 创建实例（Running 状态）
	resp, err := logic.CreateInstance(ctx, &transport.CreateInstanceRequest{})
	if err != nil {
		t.Fatalf("create instance: %v", err)
	}

	// Running 状态查日志应该可以（adapter 返回结果）
	adapter.getLogsResp = &psandbox.SandboxLogs{
		Logs: []psandbox.SandboxLog{{Line: "test log"}},
	}
	logs, err := logic.GetInstanceLogs(ctx, resp.InstanceID, nil, nil)
	if err != nil {
		t.Fatalf("get logs for running instance should succeed: %v", err)
	}
	if len(logs.Logs) != 1 {
		t.Fatalf("expected 1 log line, got %d", len(logs.Logs))
	}

	// 暂停后查日志也应该可以
	_, err = logic.PauseInstance(ctx, resp.InstanceID)
	if err != nil {
		t.Fatalf("pause instance: %v", err)
	}
	logs, err = logic.GetInstanceLogs(ctx, resp.InstanceID, nil, nil)
	if err != nil {
		t.Fatalf("get logs for paused instance should succeed: %v", err)
	}
	if len(logs.Logs) != 1 {
		t.Fatalf("expected 1 log line, got %d", len(logs.Logs))
	}
}

func TestFailedOperationRecordsErrorInHistory(t *testing.T) {
	testutil.NewMySQLDB(t, "..", "..", "migrations")

	ctx := testutil.NewContext(t, "user-fail-record")
	quotaDB := modelfactory.DefaultDaoFactory.UserResourceQuotaDao(ctx)
	if err := quotaDB.DB().Create(&quota.Entity{
		UserID:                 ctx.GetUserID(),
		ResourceName:           "OPENCLAW_INSTANCE",
		ResourceKey:            "",
		ResourceQuotaAvailable: 2,
		ResourceQuotaTotal:     2,
	}).Error; err != nil {
		t.Fatalf("seed quota: %v", err)
	}

	opHistoryDao := modelfactory.DefaultDaoFactory.OperationHistoryDao(ctx)

	logic := instancelogic.NewLogicForTest(
		modelfactory.DefaultDaoFactory.InstanceDao(ctx),
		modelfactory.DefaultDaoFactory.UserResourceQuotaDao(ctx),
		&sandboxAdapterStub{
			createResp: &psandbox.Sandbox{SandboxID: "sbx-fail"},
			pauseErr:   errcode.ErrSandboxServiceError,
		},
		nil, // aiGatewayAdapter
		opHistoryDao,
		nil,
		"tpl-1",
	)

	// 创建成功
	resp, err := logic.CreateInstance(ctx, &transport.CreateInstanceRequest{})
	if err != nil {
		t.Fatalf("create instance: %v", err)
	}

	// 暂停失败（sandbox error）
	_, err = logic.PauseInstance(ctx, resp.InstanceID)
	if err == nil {
		t.Fatal("expected pause to fail")
	}

	// 验证有 2 条记录：CREATE(SUCCESS) + PAUSE(FAILED)
	ops, total, err := opHistoryDao.ListByInstanceID(ctx, resp.InstanceID, ctx.GetUserID(), 1, 10)
	if err != nil {
		t.Fatalf("list operations: %v", err)
	}
	if total != 2 {
		t.Fatalf("expected 2 operation records, got %d", total)
	}
	// 第一条（最新）是 PAUSE FAILED
	if ops[0].OperationType != operationhistory.OperationTypePause || ops[0].Status != operationhistory.StatusFailed {
		t.Fatalf("expected PAUSE/FAILED, got %s/%s", ops[0].OperationType, ops[0].Status)
	}
	if ops[0].ErrorMessage == "" {
		t.Fatal("expected non-empty error_message for failed operation")
	}
}
