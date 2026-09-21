package instance

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	paigateway "ctl/pkg/adapter/aigateway"
	pllmgateway "ctl/pkg/adapter/llmgateway"
	psandbox "ctl/pkg/adapter/sandbox"
	pctx "ctl/pkg/context"
	modelinstance "ctl/pkg/model/instance"

	"go.uber.org/zap"
)

type migrationLegacyGatewayStub struct {
	paigateway.Adapter
	active  *paigateway.Subscription
	revoked []string
}

func (s *migrationLegacyGatewayStub) GetActiveSubscription(context.Context, string) (*paigateway.Subscription, error) {
	return s.active, nil
}

func (s *migrationLegacyGatewayStub) RevokeApiKey(_ context.Context, keyID string) error {
	s.revoked = append(s.revoked, keyID)
	return nil
}

func TestMigrateInstanceToLLMGatewayDryRunHasNoSideEffects(t *testing.T) {
	installCreateTaskAiGatewayConfig(t)
	instanceDao := &createTaskInstanceDaoStub{entity: &modelinstance.Entity{
		Id: 1, InstanceId: "ins-migrate", UserId: "usr_migrate", Status: modelinstance.InstanceStatusRunning,
		SandboxId: "sbx-migrate", AiGatewayKeyID: "legacy-key", CreatedAt: time.Now().UTC(),
	}}
	legacy := &migrationLegacyGatewayStub{active: &paigateway.Subscription{ID: "legacy-sub", PlanID: "legacy-plan"}}
	llm := &createTaskLLMGatewayAdapterStub{createResp: &pllmgateway.CreateApiKeyResponse{
		KeyID: "new-key", KeyPrefix: "sk-new", APIKey: "sk-new-secret",
	}}
	sandbox := &createTaskSandboxAdapterStub{}
	logic := &logic{
		instanceDao: instanceDao, sandboxAdapter: sandbox, aiGatewayAdapter: legacy,
		llmGatewayAdapter: llm, logger: zap.NewNop(), legacyPassEntitlementEnsurer: legacyPassEntitlementAlreadyReady,
	}

	result, err := logic.MigrateInstanceToLLMGateway(
		pctx.NewContext(nil).WithUserID("usr_migrate"), "ins-migrate", true,
	)
	if err != nil {
		t.Fatal(err)
	}
	if !result.DryRun || result.PreviousGateway != "ai_gateway" || result.TargetGateway != "llm_gateway" {
		t.Fatalf("unexpected dry-run result: %+v", result)
	}
	if llm.createCalls != 0 || len(llm.ensureCalls) != 0 || len(sandbox.processCalls) != 0 || len(instanceDao.updates) != 0 || len(legacy.revoked) != 0 {
		t.Fatalf("dry-run mutated state: create=%d ensure=%d process=%d updates=%d revoked=%d",
			llm.createCalls, len(llm.ensureCalls), len(sandbox.processCalls), len(instanceDao.updates), len(legacy.revoked))
	}
}

func TestMigrateInstanceToLLMGatewayConfiguresBeforePersistingAndRevokesLegacyKey(t *testing.T) {
	installCreateTaskAiGatewayConfig(t)
	instanceDao := &createTaskInstanceDaoStub{entity: &modelinstance.Entity{
		Id: 1, InstanceId: "ins-migrate", UserId: "usr_migrate", Status: modelinstance.InstanceStatusRunning,
		SandboxId: "sbx-migrate", AiGatewayKeyID: "legacy-key", CreatedAt: time.Now().UTC(),
	}}
	legacy := &migrationLegacyGatewayStub{active: &paigateway.Subscription{ID: "legacy-sub", PlanID: "legacy-plan"}}
	llm := &createTaskLLMGatewayAdapterStub{createResp: &pllmgateway.CreateApiKeyResponse{
		KeyID: "new-key", KeyPrefix: "sk-new", APIKey: "sk-new-secret",
	}}
	sandbox := &createTaskSandboxAdapterStub{}
	logic := &logic{
		instanceDao: instanceDao, sandboxAdapter: sandbox, aiGatewayAdapter: legacy,
		llmGatewayAdapter: llm, logger: zap.NewNop(), legacyPassEntitlementEnsurer: legacyPassEntitlementAlreadyReady,
	}

	result, err := logic.MigrateInstanceToLLMGateway(
		pctx.NewContext(nil).WithUserID("usr_migrate"), "ins-migrate", false,
	)
	if err != nil {
		t.Fatal(err)
	}
	if !result.Migrated || result.KeyID != "new-key" || result.KeyPrefix != "sk-new" || !result.LegacyKeyRevoked {
		t.Fatalf("unexpected migration result: %+v", result)
	}
	if len(llm.ensureCalls) != 1 || llm.createCalls != 1 {
		t.Fatalf("unexpected llmgateway calls: ensure=%d create=%d", len(llm.ensureCalls), llm.createCalls)
	}
	if len(sandbox.processCalls) != 2 {
		t.Fatalf("expected ensure-cli and model-config commands, got %d", len(sandbox.processCalls))
	}
	if !strings.Contains(strings.Join(sandbox.processCalls[1].Args, " "), "https://model.internal/v1") {
		t.Fatalf("model configuration does not target llmgateway: %+v", sandbox.processCalls[1].Args)
	}
	if instanceDao.entity.AiGatewayKeyID != "new-key" || len(instanceDao.updates) != 1 {
		t.Fatalf("new key was not persisted exactly once: entity=%+v updates=%+v", instanceDao.entity, instanceDao.updates)
	}
	if len(legacy.revoked) != 1 || legacy.revoked[0] != "legacy-key" {
		t.Fatalf("legacy key revoke mismatch: %+v", legacy.revoked)
	}
}

func TestMigrateInstanceToLLMGatewayDoesNotCommitWhenHermesConfigurationFails(t *testing.T) {
	installCreateTaskAiGatewayConfig(t)
	instanceDao := &createTaskInstanceDaoStub{entity: &modelinstance.Entity{
		Id: 1, InstanceId: "ins-migrate", UserId: "usr_migrate", Status: modelinstance.InstanceStatusRunning,
		SandboxId: "sbx-migrate", AiGatewayKeyID: "legacy-key", CreatedAt: time.Now().UTC(),
	}}
	legacy := &migrationLegacyGatewayStub{active: &paigateway.Subscription{ID: "legacy-sub", PlanID: "legacy-plan"}}
	llm := &createTaskLLMGatewayAdapterStub{createResp: &pllmgateway.CreateApiKeyResponse{
		KeyID: "new-key", KeyPrefix: "sk-new", APIKey: "sk-new-secret",
	}}
	sandbox := &createTaskSandboxAdapterStub{processBatches: [][]psandbox.ProcessStreamEvent{
		{{Ended: true, ExitCode: 0, Status: "SUCCESS"}},
		{{Ended: true, ExitCode: 17, Status: "FAILED", Stderr: "restart failed"}},
	}}
	logic := &logic{
		instanceDao: instanceDao, sandboxAdapter: sandbox, aiGatewayAdapter: legacy,
		llmGatewayAdapter: llm, logger: zap.NewNop(), legacyPassEntitlementEnsurer: legacyPassEntitlementAlreadyReady,
	}

	_, err := logic.MigrateInstanceToLLMGateway(
		pctx.NewContext(nil).WithUserID("usr_migrate"), "ins-migrate", false,
	)
	if err == nil || !strings.Contains(err.Error(), "restart failed") {
		t.Fatalf("expected Hermes configuration failure, got %v", err)
	}
	if instanceDao.entity.AiGatewayKeyID != "legacy-key" || len(instanceDao.updates) != 0 {
		t.Fatalf("failed migration committed key state: entity=%+v updates=%+v", instanceDao.entity, instanceDao.updates)
	}
	if len(legacy.revoked) != 0 {
		t.Fatalf("failed migration revoked legacy key: %+v", legacy.revoked)
	}
}

func TestMigrateInstanceToLLMGatewayRejectsUserWithoutLegacySubscription(t *testing.T) {
	installCreateTaskAiGatewayConfig(t)
	logic := &logic{
		instanceDao: &createTaskInstanceDaoStub{entity: &modelinstance.Entity{
			Id: 1, InstanceId: "ins-migrate", UserId: "usr_migrate", Status: modelinstance.InstanceStatusRunning,
			SandboxId: "sbx-migrate", CreatedAt: time.Now().UTC(),
		}},
		aiGatewayAdapter: &migrationLegacyGatewayStub{}, llmGatewayAdapter: &createTaskLLMGatewayAdapterStub{},
		sandboxAdapter: &createTaskSandboxAdapterStub{}, logger: zap.NewNop(),
	}

	_, err := logic.MigrateInstanceToLLMGateway(
		pctx.NewContext(nil).WithUserID("usr_migrate"), "ins-migrate", true,
	)
	if err == nil || !errors.Is(err, ErrLegacyGatewaySubscriptionNotFound) {
		t.Fatalf("expected legacy subscription error, got %v", err)
	}
}

func TestMigrateInstanceToLLMGatewayRejectsMultipleNonTerminalBots(t *testing.T) {
	installCreateTaskAiGatewayConfig(t)
	target := &modelinstance.Entity{
		Id: 1, InstanceId: "ins-migrate", UserId: "usr_migrate", Status: modelinstance.InstanceStatusRunning,
		SandboxId: "sbx-migrate", AiGatewayKeyID: "legacy-key", CreatedAt: time.Now().UTC(),
	}
	other := &modelinstance.Entity{
		Id: 2, InstanceId: "ins-paused", UserId: "usr_migrate", Status: modelinstance.InstanceStatusPaused,
		SandboxId: "sbx-paused", CreatedAt: time.Now().UTC(),
	}
	llm := &createTaskLLMGatewayAdapterStub{}
	logic := &logic{
		instanceDao:       &createTaskInstanceDaoStub{entity: target, allByUser: []*modelinstance.Entity{target, other}},
		aiGatewayAdapter:  &migrationLegacyGatewayStub{active: &paigateway.Subscription{ID: "legacy-sub", PlanID: "legacy-plan"}},
		llmGatewayAdapter: llm, sandboxAdapter: &createTaskSandboxAdapterStub{}, logger: zap.NewNop(),
	}

	_, err := logic.MigrateInstanceToLLMGateway(
		pctx.NewContext(nil).WithUserID("usr_migrate"), "ins-migrate", true,
	)
	if err == nil || !errors.Is(err, ErrGatewayMigrationRequiresSingleInstance) {
		t.Fatalf("expected single instance guard, got %v", err)
	}
	if llm.createCalls != 0 || len(llm.ensureCalls) != 0 {
		t.Fatalf("guard failure mutated llmgateway: create=%d ensure=%d", llm.createCalls, len(llm.ensureCalls))
	}
}

func TestMigrateInstanceToLLMGatewayReconcilesExistingLLMGatewayRoute(t *testing.T) {
	installCreateTaskAiGatewayConfig(t)
	instanceDao := &createTaskInstanceDaoStub{entity: &modelinstance.Entity{
		Id: 1, InstanceId: "ins-reconcile", UserId: "usr_reconcile", Status: modelinstance.InstanceStatusRunning,
		SandboxId: "sbx-reconcile", AiGatewayKeyID: "stale-key", CreatedAt: time.Now().UTC(),
	}}
	llm := &createTaskLLMGatewayAdapterStub{
		activeResp: &pllmgateway.Subscription{ID: "llm-sub", PlanID: "llm-plan", Status: "active"},
		createResp: &pllmgateway.CreateApiKeyResponse{KeyID: "stable-key", KeyPrefix: "sk-stable", APIKey: "sk-stable-secret"},
	}
	sandbox := &createTaskSandboxAdapterStub{}
	logic := &logic{
		instanceDao: instanceDao, sandboxAdapter: sandbox, llmGatewayAdapter: llm,
		logger: zap.NewNop(), legacyPassEntitlementEnsurer: legacyPassEntitlementAlreadyReady,
	}

	result, err := logic.MigrateInstanceToLLMGateway(
		pctx.NewContext(nil).WithUserID("usr_reconcile"), "ins-reconcile", false,
	)
	if err != nil {
		t.Fatal(err)
	}
	if !result.AlreadyMigrated || !result.Migrated {
		t.Fatalf("expected a completed reconcile result, got %+v", result)
	}
	if result.LegacyKeyRevoked {
		t.Fatalf("reconcile must not claim knowledge of a historical legacy key: %+v", result)
	}
	if llm.createCalls != 1 || len(sandbox.processCalls) != 2 || instanceDao.entity.AiGatewayKeyID != "stable-key" {
		t.Fatalf("reconcile did not converge key/runtime: create=%d process=%d key=%q", llm.createCalls, len(sandbox.processCalls), instanceDao.entity.AiGatewayKeyID)
	}
}
