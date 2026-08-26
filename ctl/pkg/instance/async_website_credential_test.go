package instance

import (
	"context"
	"errors"
	"testing"
	"time"

	psandbox "ctl/pkg/adapter/sandbox"
	pctx "ctl/pkg/context"
	"ctl/pkg/errcode"
	modelinstance "ctl/pkg/model/instance"
	taskcommon "ctl/pkg/taskruntime/common"
	"ctl/pkg/websiteauth"

	"go.uber.org/zap"
	"go.uber.org/zap/zaptest/observer"
)

type destroyCredentialInstanceDAO struct {
	modelinstance.Dao
	entity *modelinstance.Entity
	err    error
}

func (d *destroyCredentialInstanceDAO) GetByInstanceID(pctx.Context, string) (*modelinstance.Entity, error) {
	return d.entity, d.err
}

type destroyCredentialSandbox struct {
	psandbox.Adapter
	deleteErr error
}

func (s *destroyCredentialSandbox) DeleteSandbox(context.Context, string) error {
	return s.deleteErr
}

type destroyCredentialStore struct {
	revokedInstanceIDs []string
	revokeErr          error
}

type createCredentialStore struct {
	issueToken         string
	issueBinding       websiteauth.Binding
	issueErr           error
	revokedInstanceIDs []string
	revokedKeyIDs      []string
	revokeContextErr   error
	revokeErr          error
	provisionalTTLs    []time.Duration
	activatedKeyIDs    []string
	activateErr        error
}

func (s *createCredentialStore) Issue(_ context.Context, userID, instanceID string) (string, websiteauth.Binding, error) {
	if s.issueErr != nil {
		return "", websiteauth.Binding{}, s.issueErr
	}
	binding := s.issueBinding
	if binding.KeyID == "" {
		binding = websiteauth.Binding{KeyID: "website-key-1", UserID: userID, InstanceID: instanceID}
	}
	return s.issueToken, binding, nil
}

func (s *createCredentialStore) IssueProvisional(ctx context.Context, userID, instanceID string, ttl time.Duration) (string, websiteauth.Binding, error) {
	s.provisionalTTLs = append(s.provisionalTTLs, ttl)
	return s.Issue(ctx, userID, instanceID)
}

func (s *createCredentialStore) Activate(_ context.Context, _, keyID string) error {
	s.activatedKeyIDs = append(s.activatedKeyIDs, keyID)
	return s.activateErr
}

func (*createCredentialStore) Validate(context.Context, string) (*websiteauth.Binding, error) {
	panic("unexpected Validate")
}

func (s *createCredentialStore) Revoke(ctx context.Context, _ string, keyID string) error {
	s.revokedKeyIDs = append(s.revokedKeyIDs, keyID)
	s.revokeContextErr = ctx.Err()
	return s.revokeErr
}

func (s *createCredentialStore) RevokeInstance(_ context.Context, instanceID string) error {
	s.revokedInstanceIDs = append(s.revokedInstanceIDs, instanceID)
	return nil
}

func TestCreateTaskBecomesRunningBeforeDeliveringWebsiteCredential(t *testing.T) {
	instanceDao := &createTaskInstanceDaoStub{entity: &modelinstance.Entity{
		Id: 10, InstanceId: "ins-website-success", UserId: "user-website-success",
		Status: modelinstance.InstanceStatusCreating,
	}}
	sandboxAdapter := &createTaskSandboxAdapterStub{
		createResp:   &psandbox.Sandbox{SandboxID: "sbx-website-success", TemplateID: "tpl-create"},
		pools:        []psandbox.Pool{{ID: "tpl-create", Status: "active", CapacityState: "active"}},
		invokeResult: &psandbox.ExecCommandResult{Status: "SUCCESS", ExitCode: 0},
	}
	sandboxAdapter.beforeInvoke = func() {
		if instanceDao.entity.Status != modelinstance.InstanceStatusRunning {
			t.Fatalf("status at TAT invocation = %s, want Running", instanceDao.entity.Status)
		}
	}
	store := &createCredentialStore{issueToken: "vik_test_key_secret"}
	l := &logic{
		instanceDao: instanceDao, sandboxAdapter: sandboxAdapter, logger: zap.NewNop(),
		defaultTemplate: "tpl-create", candidateTemplates: []string{"tpl-create"},
		websiteCredentialStore: store, websiteCredentialTATCommandID: "cmd-website1",
		websiteAgentAPIBase: "https://api.lightvela.test",
	}

	err := l.RunCreateInstanceTask(pctx.NewContext(context.Background()).WithUserID("user-website-success"), &CreateInstanceTaskPayload{
		InstanceID: "ins-website-success", Timeout: 600,
	})
	if err != nil {
		t.Fatalf("RunCreateInstanceTask: %v", err)
	}
	if instanceDao.entity.Status != modelinstance.InstanceStatusRunning {
		t.Fatalf("status = %s, want Running", instanceDao.entity.Status)
	}
	if len(sandboxAdapter.invokeCalls) != 1 {
		t.Fatalf("invoke calls = %d, want 1", len(sandboxAdapter.invokeCalls))
	}
	call := sandboxAdapter.invokeCalls[0]
	if call.commandID != "cmd-website1" || call.parameters["website_key"] != "vik_test_key_secret" || call.parameters["api_base"] != "https://api.lightvela.test" {
		t.Fatalf("unexpected invoke call: %+v", call)
	}
	if len(store.revokedKeyIDs) != 0 {
		t.Fatalf("successful credential was revoked: %+v", store.revokedKeyIDs)
	}
	if len(store.provisionalTTLs) != 1 || store.provisionalTTLs[0] != websiteCredentialProvisionalTTL {
		t.Fatalf("provisional TTLs = %+v, want [%s]", store.provisionalTTLs, websiteCredentialProvisionalTTL)
	}
	if len(store.activatedKeyIDs) != 1 || store.activatedKeyIDs[0] != "website-key-1" {
		t.Fatalf("activated keys = %+v, want [website-key-1]", store.activatedKeyIDs)
	}
}

func TestCreateTaskAlreadyRunningDoesNotRotateWebsiteCredential(t *testing.T) {
	instanceDao := &createTaskInstanceDaoStub{entity: &modelinstance.Entity{
		Id: 15, InstanceId: "ins-website-existing", UserId: "user-website-existing",
		SandboxId: "sbx-website-existing", Status: modelinstance.InstanceStatusRunning,
	}}
	sandboxAdapter := &createTaskSandboxAdapterStub{}
	store := &createCredentialStore{issueToken: "vik_test_key_secret"}
	l := &logic{
		instanceDao: instanceDao, sandboxAdapter: sandboxAdapter, logger: zap.NewNop(),
		websiteCredentialStore: store, websiteCredentialTATCommandID: "cmd-website1",
		websiteAgentAPIBase: "https://api.lightvela.test",
	}

	if err := l.RunCreateInstanceTask(pctx.NewContext(context.Background()).WithUserID("user-website-existing"), &CreateInstanceTaskPayload{
		InstanceID: "ins-website-existing", Timeout: 600,
	}); err != nil {
		t.Fatalf("RunCreateInstanceTask re-entry: %v", err)
	}
	if len(sandboxAdapter.invokeCalls) != 0 || len(store.revokedInstanceIDs) != 0 || len(store.provisionalTTLs) != 0 {
		t.Fatalf("re-entry rotated credential: invoke=%d revoked=%v provisional=%v", len(sandboxAdapter.invokeCalls), store.revokedInstanceIDs, store.provisionalTTLs)
	}
}

func TestCreateTaskWebsiteCredentialFailureStillBecomesRunning(t *testing.T) {
	instanceDao := &createTaskInstanceDaoStub{entity: &modelinstance.Entity{
		Id: 11, InstanceId: "ins-website-fail", UserId: "user-website-fail",
		Status: modelinstance.InstanceStatusCreating,
	}}
	sandboxAdapter := &createTaskSandboxAdapterStub{
		createResp: &psandbox.Sandbox{SandboxID: "sbx-website-fail", TemplateID: "tpl-create"},
		pools:      []psandbox.Pool{{ID: "tpl-create", Status: "active", CapacityState: "active"}},
		invokeErr:  errors.New("TAT unavailable"),
	}
	baseCtx, cancel := context.WithCancel(context.Background())
	sandboxAdapter.beforeInvoke = cancel
	store := &createCredentialStore{issueToken: "vik_test_key_secret"}
	l := &logic{
		instanceDao: instanceDao, sandboxAdapter: sandboxAdapter, logger: zap.NewNop(),
		defaultTemplate: "tpl-create", candidateTemplates: []string{"tpl-create"},
		websiteCredentialStore: store, websiteCredentialTATCommandID: "cmd-website1",
		websiteAgentAPIBase: "https://api.lightvela.test",
	}

	err := l.RunCreateInstanceTask(pctx.NewContext(baseCtx).WithUserID("user-website-fail"), &CreateInstanceTaskPayload{
		InstanceID: "ins-website-fail", Timeout: 600,
	})
	if err != nil {
		t.Fatalf("website delivery failure must not fail instance create: %v", err)
	}
	if instanceDao.entity.Status != modelinstance.InstanceStatusRunning {
		t.Fatalf("status = %s, want Running", instanceDao.entity.Status)
	}
	if len(sandboxAdapter.deletedIDs) != 0 {
		t.Fatalf("sandbox was deleted after optional delivery failure: %+v", sandboxAdapter.deletedIDs)
	}
	if len(store.revokedKeyIDs) != 1 || store.revokedKeyIDs[0] != "website-key-1" {
		t.Fatalf("revoked keys = %+v, want [website-key-1]", store.revokedKeyIDs)
	}
	if store.revokeContextErr != nil {
		t.Fatalf("credential cleanup inherited canceled delivery context: %v", store.revokeContextErr)
	}
	if len(store.activatedKeyIDs) != 0 {
		t.Fatalf("failed delivery activated credentials: %+v", store.activatedKeyIDs)
	}
}

func TestCreateTaskWebsiteCredentialIssueFailureStillBecomesRunning(t *testing.T) {
	instanceDao := &createTaskInstanceDaoStub{entity: &modelinstance.Entity{
		Id: 12, InstanceId: "ins-website-issue-fail", UserId: "user-website-issue-fail",
		Status: modelinstance.InstanceStatusCreating,
	}}
	sandboxAdapter := &createTaskSandboxAdapterStub{
		createResp: &psandbox.Sandbox{SandboxID: "sbx-website-issue-fail", TemplateID: "tpl-create"},
		pools:      []psandbox.Pool{{ID: "tpl-create", Status: "active", CapacityState: "active"}},
	}
	store := &createCredentialStore{issueErr: errors.New("credential store unavailable")}
	core, logs := observer.New(zap.WarnLevel)
	l := &logic{
		instanceDao: instanceDao, sandboxAdapter: sandboxAdapter, logger: zap.New(core),
		defaultTemplate: "tpl-create", candidateTemplates: []string{"tpl-create"},
		websiteCredentialStore: store, websiteCredentialTATCommandID: "cmd-website1",
		websiteAgentAPIBase: "https://api.lightvela.test",
	}

	err := l.RunCreateInstanceTask(pctx.NewContext(context.Background()).WithUserID("user-website-issue-fail"), &CreateInstanceTaskPayload{
		InstanceID: "ins-website-issue-fail", Timeout: 600,
	})
	if err != nil {
		t.Fatalf("credential issue failure must not fail instance create: %v", err)
	}
	if instanceDao.entity.Status != modelinstance.InstanceStatusRunning {
		t.Fatalf("status = %s, want Running", instanceDao.entity.Status)
	}
	if len(sandboxAdapter.invokeCalls) != 0 || len(sandboxAdapter.deletedIDs) != 0 {
		t.Fatalf("invoke=%+v deleted=%+v", sandboxAdapter.invokeCalls, sandboxAdapter.deletedIDs)
	}
	if logs.FilterMessage("issue website credential during instance create failed").Len() != 1 {
		t.Fatalf("warning logs = %+v", logs.All())
	}
}

func TestCreateTaskWebsiteCredentialNonSuccessStillBecomesRunningAndRevokesKey(t *testing.T) {
	instanceDao := &createTaskInstanceDaoStub{entity: &modelinstance.Entity{
		Id: 13, InstanceId: "ins-website-command-fail", UserId: "user-website-command-fail",
		Status: modelinstance.InstanceStatusCreating,
	}}
	sandboxAdapter := &createTaskSandboxAdapterStub{
		createResp:   &psandbox.Sandbox{SandboxID: "sbx-website-command-fail", TemplateID: "tpl-create"},
		pools:        []psandbox.Pool{{ID: "tpl-create", Status: "active", CapacityState: "active"}},
		invokeResult: &psandbox.ExecCommandResult{Status: "FAILED", ExitCode: 17},
	}
	store := &createCredentialStore{issueToken: "vik_test_key_secret"}
	l := &logic{
		instanceDao: instanceDao, sandboxAdapter: sandboxAdapter, logger: zap.NewNop(),
		defaultTemplate: "tpl-create", candidateTemplates: []string{"tpl-create"},
		websiteCredentialStore: store, websiteCredentialTATCommandID: "cmd-website1",
		websiteAgentAPIBase: "https://api.lightvela.test",
	}

	err := l.RunCreateInstanceTask(pctx.NewContext(context.Background()).WithUserID("user-website-command-fail"), &CreateInstanceTaskPayload{
		InstanceID: "ins-website-command-fail", Timeout: 600,
	})
	if err != nil {
		t.Fatalf("command failure must not fail instance create: %v", err)
	}
	if instanceDao.entity.Status != modelinstance.InstanceStatusRunning || len(sandboxAdapter.deletedIDs) != 0 {
		t.Fatalf("status=%s deleted=%+v", instanceDao.entity.Status, sandboxAdapter.deletedIDs)
	}
	if len(store.revokedKeyIDs) != 1 || store.revokedKeyIDs[0] != "website-key-1" {
		t.Fatalf("revoked keys = %+v", store.revokedKeyIDs)
	}
}

func TestCreateTaskWebsiteCredentialActivationFailureStillBecomesRunningAndRevokesKey(t *testing.T) {
	instanceDao := &createTaskInstanceDaoStub{entity: &modelinstance.Entity{
		Id: 14, InstanceId: "ins-website-activate-fail", UserId: "user-website-activate-fail",
		Status: modelinstance.InstanceStatusCreating,
	}}
	sandboxAdapter := &createTaskSandboxAdapterStub{
		createResp:   &psandbox.Sandbox{SandboxID: "sbx-website-activate-fail", TemplateID: "tpl-create"},
		pools:        []psandbox.Pool{{ID: "tpl-create", Status: "active", CapacityState: "active"}},
		invokeResult: &psandbox.ExecCommandResult{Status: "SUCCESS", ExitCode: 0},
	}
	store := &createCredentialStore{
		issueToken:  "vik_test_key_secret",
		activateErr: errors.New("Redis unavailable during activation"),
	}
	l := &logic{
		instanceDao: instanceDao, sandboxAdapter: sandboxAdapter, logger: zap.NewNop(),
		defaultTemplate: "tpl-create", candidateTemplates: []string{"tpl-create"},
		websiteCredentialStore: store, websiteCredentialTATCommandID: "cmd-website1",
		websiteAgentAPIBase: "https://api.lightvela.test",
	}

	err := l.RunCreateInstanceTask(pctx.NewContext(context.Background()).WithUserID("user-website-activate-fail"), &CreateInstanceTaskPayload{
		InstanceID: "ins-website-activate-fail", Timeout: 600,
	})
	if err != nil {
		t.Fatalf("activation failure must not fail instance create: %v", err)
	}
	if instanceDao.entity.Status != modelinstance.InstanceStatusRunning || len(sandboxAdapter.deletedIDs) != 0 {
		t.Fatalf("status=%s deleted=%+v", instanceDao.entity.Status, sandboxAdapter.deletedIDs)
	}
	if len(store.activatedKeyIDs) != 1 || len(store.revokedKeyIDs) != 1 || store.revokedKeyIDs[0] != "website-key-1" {
		t.Fatalf("activated=%+v revoked=%+v", store.activatedKeyIDs, store.revokedKeyIDs)
	}
}

func TestCreateTaskWebsiteCredentialRevokeFailureStillBecomesRunning(t *testing.T) {
	instanceDao := &createTaskInstanceDaoStub{entity: &modelinstance.Entity{
		Id: 16, InstanceId: "ins-website-revoke-fail", UserId: "user-website-revoke-fail",
		Status: modelinstance.InstanceStatusCreating,
	}}
	sandboxAdapter := &createTaskSandboxAdapterStub{
		createResp: &psandbox.Sandbox{SandboxID: "sbx-website-revoke-fail", TemplateID: "tpl-create"},
		pools:      []psandbox.Pool{{ID: "tpl-create", Status: "active", CapacityState: "active"}},
		invokeErr:  errors.New("TAT unavailable"),
	}
	store := &createCredentialStore{
		issueToken: "vik_test_key_secret",
		revokeErr:  errors.New("Redis unavailable during revoke"),
	}
	l := &logic{
		instanceDao: instanceDao, sandboxAdapter: sandboxAdapter, logger: zap.NewNop(),
		defaultTemplate: "tpl-create", candidateTemplates: []string{"tpl-create"},
		websiteCredentialStore: store, websiteCredentialTATCommandID: "cmd-website1",
		websiteAgentAPIBase: "https://api.lightvela.test",
	}

	err := l.RunCreateInstanceTask(pctx.NewContext(context.Background()).WithUserID("user-website-revoke-fail"), &CreateInstanceTaskPayload{
		InstanceID: "ins-website-revoke-fail", Timeout: 600,
	})
	if err != nil {
		t.Fatalf("cleanup failure must not fail instance create: %v", err)
	}
	if instanceDao.entity.Status != modelinstance.InstanceStatusRunning || len(sandboxAdapter.deletedIDs) != 0 {
		t.Fatalf("status=%s deleted=%+v", instanceDao.entity.Status, sandboxAdapter.deletedIDs)
	}
	if len(store.revokedKeyIDs) != 1 || len(store.provisionalTTLs) != 1 {
		t.Fatalf("revoked=%+v provisional=%+v", store.revokedKeyIDs, store.provisionalTTLs)
	}
}

func (*destroyCredentialStore) Issue(context.Context, string, string) (string, websiteauth.Binding, error) {
	panic("unexpected Issue")
}

func (*destroyCredentialStore) Validate(context.Context, string) (*websiteauth.Binding, error) {
	panic("unexpected Validate")
}

func (*destroyCredentialStore) Revoke(context.Context, string, string) error {
	panic("unexpected Revoke")
}

func (s *destroyCredentialStore) RevokeInstance(_ context.Context, instanceID string) error {
	s.revokedInstanceIDs = append(s.revokedInstanceIDs, instanceID)
	return s.revokeErr
}

func TestDestroyTaskRevokesWebsiteCredentialWhenInstanceIsAlreadyDestroyed(t *testing.T) {
	store := &destroyCredentialStore{}
	l := &logic{
		instanceDao:            &destroyCredentialInstanceDAO{err: errcode.ErrInstanceNotFound},
		websiteCredentialStore: store,
		logger:                 zap.NewNop(),
	}
	ctx := pctx.NewContext(context.Background()).WithUserID("user-1")

	if err := l.RunDestroyInstanceTask(ctx, &DestroyInstanceTaskPayload{InstanceID: "ins-1"}); err != nil {
		t.Fatalf("RunDestroyInstanceTask: %v", err)
	}
	if len(store.revokedInstanceIDs) != 1 || store.revokedInstanceIDs[0] != "ins-1" {
		t.Fatalf("revoked instances = %#v, want [ins-1]", store.revokedInstanceIDs)
	}
}

func TestDestroyTaskDoesNotRevokeWebsiteCredentialBeforeSandboxDeletionSucceeds(t *testing.T) {
	store := &destroyCredentialStore{}
	l := &logic{
		instanceDao: &destroyCredentialInstanceDAO{entity: &modelinstance.Entity{
			InstanceId: "ins-1",
			SandboxId:  "sbx-1",
			Status:     modelinstance.InstanceStatusDeleting,
		}},
		sandboxAdapter:         &destroyCredentialSandbox{deleteErr: errors.New("sandbox unavailable")},
		websiteCredentialStore: store,
		logger:                 zap.NewNop(),
	}
	ctx := pctx.NewContext(context.Background()).WithUserID("user-1")

	if err := l.RunDestroyInstanceTask(ctx, &DestroyInstanceTaskPayload{InstanceID: "ins-1"}); err == nil {
		t.Fatal("RunDestroyInstanceTask succeeded, want sandbox error")
	}
	if len(store.revokedInstanceIDs) != 0 {
		t.Fatalf("revoked instances = %#v, want none", store.revokedInstanceIDs)
	}
}

func TestDestroyTaskDoesNotFailAfterCredentialCleanupError(t *testing.T) {
	store := &destroyCredentialStore{revokeErr: errors.New("Redis unavailable")}
	core, logs := observer.New(zap.WarnLevel)
	l := &logic{
		instanceDao:            &destroyCredentialInstanceDAO{err: errcode.ErrInstanceNotFound},
		websiteCredentialStore: store,
		logger:                 zap.New(core),
	}
	ctx := pctx.NewContext(context.Background()).WithUserID("user-1")

	err := l.RunDestroyInstanceTask(ctx, &DestroyInstanceTaskPayload{InstanceID: "ins-1"})
	if err != nil {
		t.Fatalf("RunDestroyInstanceTask must preserve successful destruction: %v", err)
	}
	if len(store.revokedInstanceIDs) != 1 || store.revokedInstanceIDs[0] != "ins-1" {
		t.Fatalf("revoked instances = %#v, want [ins-1]", store.revokedInstanceIDs)
	}
	if logs.FilterMessage("revoke website credentials after instance destruction failed").Len() != 1 {
		t.Fatalf("warning logs = %#v", logs.All())
	}
}

func TestPassDestroyTaskRevokesWebsiteCredentialAfterIdempotentSuccess(t *testing.T) {
	store := &destroyCredentialStore{}
	l := &logic{
		instanceDao:            &destroyCredentialInstanceDAO{err: errcode.ErrInstanceNotFound},
		websiteCredentialStore: store,
		logger:                 zap.NewNop(),
	}
	ctx := pctx.NewContext(context.Background()).WithUserID("user-1")

	err := l.RunDestroyInstanceForPassTask(ctx, "task-1", &taskcommon.DestroyInstanceForPassTaskPayload{
		InstanceID:  "ins-1",
		PassID:      "pass-1",
		TradeFlowID: 1,
	})
	if err != nil {
		t.Fatalf("RunDestroyInstanceForPassTask: %v", err)
	}
	if len(store.revokedInstanceIDs) != 1 || store.revokedInstanceIDs[0] != "ins-1" {
		t.Fatalf("revoked instances = %#v, want [ins-1]", store.revokedInstanceIDs)
	}
}

func TestPassDestroyTaskDoesNotFailAfterCredentialCleanupError(t *testing.T) {
	store := &destroyCredentialStore{revokeErr: errors.New("Redis unavailable")}
	core, logs := observer.New(zap.WarnLevel)
	l := &logic{
		instanceDao:            &destroyCredentialInstanceDAO{err: errcode.ErrInstanceNotFound},
		websiteCredentialStore: store,
		logger:                 zap.New(core),
	}
	ctx := pctx.NewContext(context.Background()).WithUserID("user-1")

	err := l.RunDestroyInstanceForPassTask(ctx, "task-1", &taskcommon.DestroyInstanceForPassTaskPayload{
		InstanceID:  "ins-1",
		PassID:      "pass-1",
		TradeFlowID: 1,
	})
	if err != nil {
		t.Fatalf("RunDestroyInstanceForPassTask must preserve successful destruction: %v", err)
	}
	if len(store.revokedInstanceIDs) != 1 || store.revokedInstanceIDs[0] != "ins-1" {
		t.Fatalf("revoked instances = %#v, want [ins-1]", store.revokedInstanceIDs)
	}
	if logs.FilterMessage("revoke website credentials after instance destruction failed").Len() != 1 {
		t.Fatalf("warning logs = %#v", logs.All())
	}
}
