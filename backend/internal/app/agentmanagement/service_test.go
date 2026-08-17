package agentmanagement

import (
	"bytes"
	"context"
	"testing"
	"time"

	"chatserver/internal/apperror"
	agentport "chatserver/internal/ports/agent"
)

const (
	appAgentAccountID  = "01989c24-7540-7f12-a27b-c83243215dd1"
	appAgentServerID   = "01989c24-7540-7f12-a27b-c83243215dd3"
	appAgentID         = "01989c24-7540-7f12-a27b-c83243215dd4"
	appAgentOperation  = "01989c24-7540-7f12-a27b-c83243215dd5"
	appAgentCredential = "01989c24-7540-7f12-a27b-c83243215dd6"
	appAgentComputer   = "01989c24-7540-7f12-a27b-c83243215dd7"
	appAgentRotation   = "01989c24-7540-7f12-a27b-c83243215dd8"
)

var appAgentNow = time.Date(2026, 7, 30, 23, 45, 0, 0, time.UTC)

type fakeAgentRepository struct {
	context           agentport.ServerContext
	createCommand     agentport.CreateCommand
	updateCommand     agentport.UpdateCommand
	lifecycleCommand  agentport.LifecycleCommand
	credentialCommand agentport.CredentialCommand
	deleteCommand     agentport.DeleteCommand
	agent             agentport.Agent
	operation         agentport.Operation
	lifecycleErrors   []error
	lifecycleCalls    int
}

func (repository *fakeAgentRepository) GetServerContext(
	context.Context,
	string,
	string,
) (agentport.ServerContext, error) {
	return repository.context, nil
}

func (repository *fakeAgentRepository) Create(
	_ context.Context,
	command agentport.CreateCommand,
) (agentport.CreateResult, error) {
	repository.createCommand = command
	return agentport.CreateResult{
		Agent: repository.agent, Operation: repository.operation,
	}, nil
}

func (repository *fakeAgentRepository) List(
	context.Context,
	string,
	string,
) ([]agentport.Agent, error) {
	return []agentport.Agent{repository.agent}, nil
}

func (repository *fakeAgentRepository) Get(
	context.Context,
	string,
	string,
	string,
) (agentport.Agent, error) {
	return repository.agent, nil
}

func (repository *fakeAgentRepository) Update(
	_ context.Context,
	command agentport.UpdateCommand,
) (agentport.Agent, error) {
	repository.updateCommand = command
	return repository.agent, nil
}

func (repository *fakeAgentRepository) ApplyLifecycle(
	_ context.Context,
	command agentport.LifecycleCommand,
) (agentport.Operation, error) {
	repository.lifecycleCommand = command
	repository.lifecycleCalls++
	if repository.lifecycleCalls <= len(repository.lifecycleErrors) {
		return agentport.Operation{},
			repository.lifecycleErrors[repository.lifecycleCalls-1]
	}
	return repository.operation, nil
}

func (repository *fakeAgentRepository) RotateCredential(
	_ context.Context,
	command agentport.CredentialCommand,
) (agentport.CredentialResult, error) {
	repository.credentialCommand = command
	return agentport.CredentialResult{
		Operation: repository.operation,
		Created:   true,
	}, nil
}

func (repository *fakeAgentRepository) Delete(
	_ context.Context,
	command agentport.DeleteCommand,
) (agentport.Operation, error) {
	repository.deleteCommand = command
	return repository.operation, nil
}

type sequenceIDs struct {
	values []string
	index  int
}

func (ids *sequenceIDs) New() (string, error) {
	value := ids.values[ids.index]
	ids.index++
	return value, nil
}

type agentIdentityDeriver struct{}

func (agentIdentityDeriver) AgentUserID(string) (string, error) {
	return "a_TESTAGENTUSERID2345678901234", nil
}

type fixedClock struct{ now time.Time }

func (clock fixedClock) Now() time.Time { return clock.now }

func TestServiceCreatesAgentAndEnqueuesLifecycle(t *testing.T) {
	computerID := appAgentComputer
	repository := &fakeAgentRepository{
		context: agentport.ServerContext{
			Role: "owner", IMState: "ready",
			CreatorMemberID: appAgentAccountID,
		},
		agent: agentport.Agent{
			ID: appAgentID, ServerID: appAgentServerID,
			DisplayName: "小舟", Handle: "xiaozhou",
			IMUserID: "a_TESTAGENTUSERID2345678901234",
			IMState:  "provisioning", ComputerID: &computerID,
			Runtime:     agentport.Runtime{Kind: "codex"},
			ReplyPolicy: "mention_and_dm", DesiredState: "stopped",
			ObservedState: "unknown", Revision: 1,
		},
		operation: agentport.Operation{
			ID: appAgentOperation, ServerID: appAgentServerID,
			Service: "im", Kind: "im.identity.ensure",
			State: "pending", CreatedAt: appAgentNow,
		},
	}
	service, err := NewService(
		repository,
		agentIdentityDeriver{},
		&sequenceIDs{values: []string{
			appAgentID, appAgentOperation, appAgentOperation,
		}},
		fixedClock{now: appAgentNow},
		bytes.NewReader(bytes.Repeat([]byte{0x42}, 32)),
	)
	if err != nil {
		t.Fatal(err)
	}
	result, err := service.Create(context.Background(), CreateCommand{
		AccountID: appAgentAccountID, ServerID: appAgentServerID,
		IdempotencyKey: "agent-create-0001",
		DisplayName:    "小舟", Handle: "xiaozhou",
		ComputerID: &computerID,
		Runtime:    agentport.Runtime{Kind: "codex"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Agent.ID != appAgentID ||
		repository.createCommand.Agent.IMUserID !=
			"a_TESTAGENTUSERID2345678901234" {
		t.Fatalf("Create() = %#v command=%#v", result, repository.createCommand)
	}
	repository.operation = agentport.Operation{
		ID: appAgentOperation, ServerID: appAgentServerID,
		Service: "platform", Kind: "agent.start",
		State: "succeeded", CreatedAt: appAgentNow,
	}
	operation, err := service.Lifecycle(
		context.Background(),
		LifecycleCommand{
			AccountID: appAgentAccountID, ServerID: appAgentServerID,
			AgentID: appAgentID, Kind: "start",
			IdempotencyKey: "agent-start-0001",
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	if operation.Kind != "agent.start" ||
		repository.lifecycleCommand.Kind != "agent.start" {
		t.Fatalf(
			"Lifecycle() = %#v command=%#v",
			operation,
			repository.lifecycleCommand,
		)
	}
}

func TestServiceRejectsAgentWithoutComputer(t *testing.T) {
	repository := &fakeAgentRepository{
		context: agentport.ServerContext{
			Role: "owner", IMState: "ready",
			CreatorMemberID: appAgentAccountID,
		},
	}
	service, err := NewService(
		repository,
		agentIdentityDeriver{},
		&sequenceIDs{values: []string{appAgentID, appAgentOperation}},
		fixedClock{now: appAgentNow},
		bytes.NewReader(bytes.Repeat([]byte{0x42}, 32)),
	)
	if err != nil {
		t.Fatal(err)
	}

	_, err = service.Create(context.Background(), CreateCommand{
		AccountID: appAgentAccountID, ServerID: appAgentServerID,
		IdempotencyKey: "agent-create-without-computer-0001",
		DisplayName:    "小舟", Handle: "xiaozhou",
		Runtime: agentport.Runtime{Kind: "codex"},
	})
	if apperror.CodeOf(err) != "invalid_request" {
		t.Fatalf("Create() error = %v code=%q", err, apperror.CodeOf(err))
	}
	if repository.createCommand.Agent.ID != "" {
		t.Fatalf("Create() reached repository: %#v", repository.createCommand)
	}
}

func TestServiceRejectsClearingComputerBinding(t *testing.T) {
	repository := &fakeAgentRepository{}
	service, err := NewService(
		repository,
		agentIdentityDeriver{},
		&sequenceIDs{},
		fixedClock{now: appAgentNow},
		bytes.NewReader(bytes.Repeat([]byte{0x42}, 32)),
	)
	if err != nil {
		t.Fatal(err)
	}

	_, err = service.Update(context.Background(), UpdateCommand{
		AccountID: appAgentAccountID, ServerID: appAgentServerID,
		AgentID: appAgentID, Revision: 1,
		IdempotencyKey: "agent-clear-computer-0001",
		ComputerIDSet:  true,
	})
	if apperror.CodeOf(err) != "invalid_request" {
		t.Fatalf("Update() error = %v code=%q", err, apperror.CodeOf(err))
	}
	if repository.updateCommand.AgentID != "" {
		t.Fatalf("Update() reached repository: %#v", repository.updateCommand)
	}
}

func TestServiceDeletesAgentWithoutComputerLifecycleCommand(t *testing.T) {
	repository := &fakeAgentRepository{
		operation: agentport.Operation{
			ID: appAgentOperation, ServerID: appAgentServerID,
			Service: "im", Kind: "im.identity.delete",
			State: "pending", CreatedAt: appAgentNow,
		},
	}
	service, err := NewService(
		repository,
		agentIdentityDeriver{},
		&sequenceIDs{values: []string{appAgentOperation}},
		fixedClock{now: appAgentNow},
		bytes.NewReader(bytes.Repeat([]byte{0x42}, 32)),
	)
	if err != nil {
		t.Fatal(err)
	}
	operation, err := service.Delete(context.Background(), DeleteCommand{
		AccountID: appAgentAccountID, ServerID: appAgentServerID,
		AgentID: appAgentID, IdempotencyKey: "agent-delete-0001",
	})
	if err != nil {
		t.Fatal(err)
	}
	if operation.Kind != "im.identity.delete" ||
		repository.deleteCommand.OperationID != appAgentOperation ||
		repository.deleteCommand.RequestHash == [32]byte{} {
		t.Fatalf(
			"Delete() = %#v command=%#v",
			operation,
			repository.deleteCommand,
		)
	}
}

func TestServiceUpdatesAgentConfigurationWithRevisionFence(t *testing.T) {
	repository := &fakeAgentRepository{
		agent: agentport.Agent{
			ID: appAgentID, ServerID: appAgentServerID,
			DisplayName: "新名称", Handle: "xiaozhou",
			Runtime:     agentport.Runtime{Kind: "hermes-acp"},
			ReplyPolicy: "dm_only", Revision: 2,
		},
	}
	service, err := NewService(
		repository,
		agentIdentityDeriver{},
		&sequenceIDs{},
		fixedClock{now: appAgentNow},
		bytes.NewReader(bytes.Repeat([]byte{0x42}, 32)),
	)
	if err != nil {
		t.Fatal(err)
	}
	name := " 新名称 "
	policy := "dm_only"
	runtime := agentport.Runtime{Kind: "hermes-acp"}
	value, err := service.Update(context.Background(), UpdateCommand{
		AccountID: appAgentAccountID, ServerID: appAgentServerID,
		AgentID: appAgentID, Revision: 1,
		IdempotencyKey: "agent-update-0001",
		DisplayName:    &name, Runtime: &runtime, ReplyPolicy: &policy,
	})
	if err != nil {
		t.Fatal(err)
	}
	if value.Revision != 2 ||
		repository.updateCommand.Revision != 1 ||
		repository.updateCommand.Patch.DisplayName == nil ||
		*repository.updateCommand.Patch.DisplayName != "新名称" ||
		repository.updateCommand.Patch.Runtime == nil ||
		repository.updateCommand.Patch.Runtime.Kind != "hermes-acp" {
		t.Fatalf(
			"Update() = %#v command=%#v",
			value,
			repository.updateCommand,
		)
	}
}

func TestServiceBootstrapsMissingCredentialOnFirstStart(t *testing.T) {
	computerID := appAgentComputer
	repository := &fakeAgentRepository{
		agent: agentport.Agent{
			ID: appAgentID, ServerID: appAgentServerID,
			ComputerID: &computerID, CredentialVersion: 0,
		},
		operation: agentport.Operation{
			ID: appAgentOperation, ServerID: appAgentServerID,
			Service: "platform", Kind: "agent.start",
			State: "succeeded", CreatedAt: appAgentNow,
		},
		lifecycleErrors: []error{agentport.ErrCredentialMissing},
	}
	service, err := NewService(
		repository,
		agentIdentityDeriver{},
		&sequenceIDs{values: []string{
			appAgentOperation, appAgentCredential, appAgentRotation,
		}},
		fixedClock{now: appAgentNow},
		bytes.NewReader(bytes.Repeat([]byte{0x24}, 32)),
	)
	if err != nil {
		t.Fatal(err)
	}
	operation, err := service.Lifecycle(context.Background(), LifecycleCommand{
		AccountID: appAgentAccountID, ServerID: appAgentServerID,
		AgentID: appAgentID, Kind: "start",
		IdempotencyKey: "agent-first-start-0001",
	})
	if err != nil {
		t.Fatal(err)
	}
	if operation.Kind != "agent.start" || repository.lifecycleCalls != 2 ||
		repository.credentialCommand.Version != 1 ||
		repository.credentialCommand.SecretHash == [32]byte{} {
		t.Fatalf(
			"Lifecycle() = %#v calls=%d credential=%#v",
			operation,
			repository.lifecycleCalls,
			repository.credentialCommand,
		)
	}
}

func TestServiceBootstrapsMissingCredentialOnFirstDeploy(t *testing.T) {
	computerID := appAgentComputer
	repository := &fakeAgentRepository{
		agent: agentport.Agent{
			ID: appAgentID, ServerID: appAgentServerID,
			ComputerID: &computerID, CredentialVersion: 0,
		},
		operation: agentport.Operation{
			ID: appAgentOperation, ServerID: appAgentServerID,
			Service: "platform", Kind: "agent.deploy",
			State: "succeeded", CreatedAt: appAgentNow,
		},
		lifecycleErrors: []error{agentport.ErrCredentialMissing},
	}
	service, err := NewService(
		repository,
		agentIdentityDeriver{},
		&sequenceIDs{values: []string{
			appAgentOperation, appAgentCredential, appAgentRotation,
		}},
		fixedClock{now: appAgentNow},
		bytes.NewReader(bytes.Repeat([]byte{0x24}, 32)),
	)
	if err != nil {
		t.Fatal(err)
	}
	operation, err := service.Lifecycle(context.Background(), LifecycleCommand{
		AccountID: appAgentAccountID, ServerID: appAgentServerID,
		AgentID: appAgentID, Kind: "deploy",
		IdempotencyKey: "agent-first-deploy-0001",
	})
	if err != nil {
		t.Fatal(err)
	}
	if operation.Kind != "agent.deploy" || repository.lifecycleCalls != 2 ||
		repository.credentialCommand.Version != 1 ||
		repository.credentialCommand.SecretHash == [32]byte{} {
		t.Fatalf(
			"Lifecycle() = %#v calls=%d credential=%#v",
			operation,
			repository.lifecycleCalls,
			repository.credentialCommand,
		)
	}
}

func TestServiceRotatesRuntimeCredentialWithoutTATVault(t *testing.T) {
	computerID := appAgentComputer
	repository := &fakeAgentRepository{
		agent: agentport.Agent{
			ID: appAgentID, ServerID: appAgentServerID,
			ComputerID: &computerID, CredentialVersion: 0,
		},
		operation: agentport.Operation{
			ID: appAgentOperation, ServerID: appAgentServerID,
			Service: "platform", Kind: "agent.credential.rotate",
			State: "succeeded", CreatedAt: appAgentNow,
		},
	}
	service, err := NewService(
		repository,
		agentIdentityDeriver{},
		&sequenceIDs{values: []string{
			appAgentCredential, appAgentOperation,
		}},
		fixedClock{now: appAgentNow},
		bytes.NewReader(bytes.Repeat([]byte{0x24}, 32)),
	)
	if err != nil {
		t.Fatal(err)
	}
	operation, err := service.RotateCredential(
		context.Background(),
		CredentialCommand{
			AccountID: appAgentAccountID, ServerID: appAgentServerID,
			AgentID:        appAgentID,
			IdempotencyKey: "agent-credential-0001",
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	if operation.ID != appAgentOperation ||
		operation.Service != "platform" ||
		operation.Kind != "agent.credential.rotate" ||
		operation.State != "succeeded" ||
		repository.credentialCommand.Version != 1 ||
		repository.credentialCommand.SecretHash == [32]byte{} {
		t.Fatalf(
			"RotateCredential() operation=%#v command=%#v",
			operation,
			repository.credentialCommand,
		)
	}
}
