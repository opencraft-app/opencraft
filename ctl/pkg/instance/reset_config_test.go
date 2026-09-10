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

func TestResetInstanceConfigCreatesNewKeyPersistsAndPreservesUserKeys(t *testing.T) {
	installCreateTaskAiGatewayConfig(t)

	instanceDao := &createTaskInstanceDaoStub{
		entity: &modelinstance.Entity{
			Id:             1,
			InstanceId:     "ins-reset-1",
			UserId:         "user-reset",
			Status:         modelinstance.InstanceStatusRunning,
			SandboxId:      "sbx-reset-1",
			AiGatewayKeyID: "key-old",
			CreatedAt:      time.Now().UTC(),
		},
	}
	sandboxAdapter := singleProfileResetSandbox()
	aiGatewayAdapter := &createTaskLLMGatewayAdapterStub{
		createResp: &pllmgateway.CreateApiKeyResponse{KeyID: "key-new", KeyPrefix: "sk-new", APIKey: "sk-new-secret"},
	}
	logic := &logic{
		instanceDao:                  instanceDao,
		sandboxAdapter:               sandboxAdapter,
		llmGatewayAdapter:            aiGatewayAdapter,
		logger:                       zap.NewNop(),
		legacyPassEntitlementEnsurer: legacyPassEntitlementAlreadyReady,
	}

	resp, err := logic.ResetInstanceConfig(pctx.NewContext(nil).WithUserID("user-reset"), "ins-reset-1")
	if err != nil {
		t.Fatalf("reset instance config: %v", err)
	}
	if resp.KeyID != "key-new" || resp.KeyPrefix != "sk-new" {
		t.Fatalf("unexpected key response: %+v", resp)
	}
	if resp.Config == nil {
		t.Fatal("expected config response")
	}
	if resp.Config.ProviderName != "custom" ||
		resp.Config.BaseURL != "https://model.internal/v1" ||
		resp.Config.ModelID != "kimi-k2.5" ||
		resp.Config.API != "chat_completions" ||
		resp.Config.APIKey != "sk-new-secret" {
		t.Fatalf("unexpected provider config: %+v", resp.Config)
	}
	if instanceDao.entity.AiGatewayKeyID != "key-new" {
		t.Fatalf("expected new key id to be persisted, got %q", instanceDao.entity.AiGatewayKeyID)
	}
	if len(instanceDao.updates) != 1 {
		t.Fatalf("expected exactly one instance update, got %d", len(instanceDao.updates))
	}
	if got := aiGatewayAdapter.revoked; len(got) != 0 {
		t.Fatalf("LLMGateway user keys must survive instance config reset, got revocations %+v", got)
	}
	if len(aiGatewayAdapter.ensureCalls) != 1 || aiGatewayAdapter.ensureCalls[0].userID != "user-reset" {
		t.Fatalf("expected ensure user before key creation, got %+v", aiGatewayAdapter.ensureCalls)
	}
	if aiGatewayAdapter.createCalls != 1 {
		t.Fatalf("expected one api key creation, got %d", aiGatewayAdapter.createCalls)
	}
	if len(sandboxAdapter.processCalls) != 1 {
		t.Fatalf("expected one Profile inventory command, got %+v", sandboxAdapter.processCalls)
	}
}

func TestResetInstanceConfigDoesNotIssueLLMGatewayKeyWhenEntitlementPreparationFails(t *testing.T) {
	installCreateTaskAiGatewayConfig(t)

	instanceDao := &createTaskInstanceDaoStub{
		entity: &modelinstance.Entity{
			Id:         1,
			InstanceId: "ins-reset-entitlement-fail",
			UserId:     "user-reset-entitlement-fail",
			Status:     modelinstance.InstanceStatusRunning,
			SandboxId:  "sbx-reset-entitlement-fail",
			CreatedAt:  time.Now().UTC(),
		},
	}
	llmGateway := &createTaskLLMGatewayAdapterStub{
		createResp: &pllmgateway.CreateApiKeyResponse{KeyID: "must-not-be-created", APIKey: "must-not-be-created"},
	}
	logic := &logic{
		sandboxAdapter:    singleProfileResetSandbox(),
		instanceDao:       instanceDao,
		llmGatewayAdapter: llmGateway,
		logger:            zap.NewNop(),
		legacyPassEntitlementEnsurer: func(_ context.Context, userID string, _ time.Time) error {
			if userID != "user-reset-entitlement-fail" {
				t.Fatalf("userID = %q", userID)
			}
			return errors.New("entitlement unavailable")
		},
	}

	_, err := logic.ResetInstanceConfig(
		pctx.NewContext(nil).WithUserID("user-reset-entitlement-fail"),
		"ins-reset-entitlement-fail",
	)
	if err == nil || !strings.Contains(err.Error(), "entitlement unavailable") {
		t.Fatalf("error = %v", err)
	}
	if llmGateway.createCalls != 0 {
		t.Fatalf("create-api-key calls = %d, want 0", llmGateway.createCalls)
	}
	if len(llmGateway.ensureCalls) != 1 {
		t.Fatalf("ensure-user calls = %d, want 1", len(llmGateway.ensureCalls))
	}
}

func TestResetInstanceConfigRejectsMissingDefaultProviderConfigBeforeCreatingKey(t *testing.T) {
	prev := config.ServerConf
	config.ServerConf = &config.GlobalConfig{
		AdapterConfig: &config.AdapterConfig{
			LLMGateway: &config.LLMGatewayConfig{
				Enabled:                    true,
				BaseURL:                    "https://llmgateway.test",
				DefaultBaseURL:             "https://model.internal/v1",
				NewAllocationUserAllowlist: []string{"*"},
			},
		},
	}
	t.Cleanup(func() { config.ServerConf = prev })

	instanceDao := &createTaskInstanceDaoStub{
		entity: &modelinstance.Entity{
			Id:         1,
			InstanceId: "ins-reset-1",
			UserId:     "user-reset",
			Status:     modelinstance.InstanceStatusRunning,
			SandboxId:  "sbx-reset-1",
			CreatedAt:  time.Now().UTC(),
		},
	}
	aiGatewayAdapter := &createTaskLLMGatewayAdapterStub{}
	logic := &logic{
		sandboxAdapter:               singleProfileResetSandbox(),
		instanceDao:                  instanceDao,
		llmGatewayAdapter:            aiGatewayAdapter,
		logger:                       zap.NewNop(),
		legacyPassEntitlementEnsurer: legacyPassEntitlementAlreadyReady,
	}

	_, err := logic.ResetInstanceConfig(pctx.NewContext(nil).WithUserID("user-reset"), "ins-reset-1")
	if err == nil {
		t.Fatal("expected missing default model id error")
	}
	if !strings.Contains(err.Error(), "default_base_url or default_model_id not configured") {
		t.Fatalf("unexpected error: %v", err)
	}
	if aiGatewayAdapter.createCalls != 0 {
		t.Fatalf("expected no key creation, got %d", aiGatewayAdapter.createCalls)
	}
	if len(instanceDao.updates) != 0 {
		t.Fatalf("expected no instance update, got %+v", instanceDao.updates)
	}
}

func TestResetInstanceConfigDoesNotCallLLMGatewayRevoke(t *testing.T) {
	installCreateTaskAiGatewayConfig(t)

	instanceDao := &createTaskInstanceDaoStub{
		entity: &modelinstance.Entity{
			Id:             1,
			InstanceId:     "ins-reset-1",
			UserId:         "user-reset",
			Status:         modelinstance.InstanceStatusRunning,
			SandboxId:      "sbx-reset-1",
			AiGatewayKeyID: "key-old",
			CreatedAt:      time.Now().UTC(),
		},
	}
	aiGatewayAdapter := &createTaskLLMGatewayAdapterStub{
		createResp:       &pllmgateway.CreateApiKeyResponse{KeyID: "key-new", KeyPrefix: "sk-new", APIKey: "sk-new-secret"},
		revokeErrByKeyID: map[string]error{"key-old": errors.New("revoke failed")},
	}
	logic := &logic{
		sandboxAdapter:               singleProfileResetSandbox(),
		instanceDao:                  instanceDao,
		llmGatewayAdapter:            aiGatewayAdapter,
		logger:                       zap.NewNop(),
		legacyPassEntitlementEnsurer: legacyPassEntitlementAlreadyReady,
	}

	_, err := logic.ResetInstanceConfig(pctx.NewContext(nil).WithUserID("user-reset"), "ins-reset-1")
	if err != nil {
		t.Fatal(err)
	}
	if instanceDao.entity.AiGatewayKeyID != "key-new" {
		t.Fatalf("expected new key id to be persisted, got %q", instanceDao.entity.AiGatewayKeyID)
	}
	if len(instanceDao.updates) != 1 {
		t.Fatalf("expected one instance update, got %+v", instanceDao.updates)
	}
	if got := aiGatewayAdapter.revoked; len(got) != 0 {
		t.Fatalf("LLMGateway revoke must not be called, got %+v", got)
	}
}

func TestResetInstanceConfigRejectsInstanceOwnedByAnotherUser(t *testing.T) {
	installCreateTaskAiGatewayConfig(t)

	instanceDao := &createTaskInstanceDaoStub{
		entity: &modelinstance.Entity{
			Id:         1,
			InstanceId: "ins-reset-1",
			UserId:     "other-user",
			Status:     modelinstance.InstanceStatusRunning,
			SandboxId:  "sbx-reset-1",
			CreatedAt:  time.Now().UTC(),
		},
	}
	aiGatewayAdapter := &createTaskLLMGatewayAdapterStub{}
	logic := &logic{
		sandboxAdapter:    singleProfileResetSandbox(),
		instanceDao:       instanceDao,
		llmGatewayAdapter: aiGatewayAdapter,
		logger:            zap.NewNop(),
	}

	_, err := logic.ResetInstanceConfig(pctx.NewContext(nil).WithUserID("user-reset"), "ins-reset-1")
	if !errors.Is(err, errcode.ErrInstanceNotFound) {
		t.Fatalf("expected instance not found, got %v", err)
	}
	if aiGatewayAdapter.createCalls != 0 {
		t.Fatalf("expected no key creation, got %d", aiGatewayAdapter.createCalls)
	}
}

func singleProfileResetSandbox() *commandSandboxAdapterStub {
	return &commandSandboxAdapterStub{processEvents: []psandbox.ProcessStreamEvent{
		{Stdout: `{"items":[{"native_id":"default","is_default":true}]}`},
		{Ended: true, ExitCode: 0, Status: "SUCCESS"},
	}}
}

func TestResetInstanceConfigRejectsUnsafeProfileInventoryBeforeKeyChanges(t *testing.T) {
	for _, tc := range []struct {
		name, output string
		failed       bool
	}{
		{"siblings", `{"items":[{"native_id":"default","is_default":true},{"native_id":"sales"}]}`, false},
		{"missing-root", `{"items":[{"native_id":"sales"}]}`, false},
		{"empty", `{"items":[]}`, false},
		{"invalid", "not-json", false},
		{"unavailable", "", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			installCreateTaskAiGatewayConfig(t)
			dao := &createTaskInstanceDaoStub{entity: &modelinstance.Entity{
				Id: 1, InstanceId: "ins-reset", UserId: "user-reset", SandboxId: "sbx-reset",
				Status: modelinstance.InstanceStatusRunning, AiGatewayKeyID: "old-key", CreatedAt: time.Now().UTC(),
			}}
			sandbox := &commandSandboxAdapterStub{processEvents: []psandbox.ProcessStreamEvent{
				{Stdout: tc.output}, {Ended: true, ExitCode: 0, Status: "SUCCESS"},
			}}
			if tc.failed {
				sandbox.processErr = errors.New("profile inventory unavailable")
			}
			gateway := &createTaskLLMGatewayAdapterStub{}
			l := &logic{instanceDao: dao, sandboxAdapter: sandbox, llmGatewayAdapter: gateway, logger: zap.NewNop(), legacyPassEntitlementEnsurer: legacyPassEntitlementAlreadyReady}
			_, err := l.ResetInstanceConfig(pctx.NewContext(nil).WithUserID("user-reset"), "ins-reset")
			if err == nil {
				t.Fatal("expected reset rejection")
			}
			if gateway.createCalls != 0 || len(gateway.revoked) != 0 || len(dao.updates) != 0 {
				t.Fatal("unsafe inventory must not issue, revoke or persist keys")
			}
		})
	}
}
