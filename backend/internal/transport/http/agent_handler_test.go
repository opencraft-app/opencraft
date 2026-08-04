package httptransport

import (
	"context"
	"testing"
	"time"

	"chatserver/internal/api/openapi"
	appagent "chatserver/internal/app/agentmanagement"
	agentport "chatserver/internal/ports/agent"

	"github.com/google/uuid"
)

const handlerAgentID = "0198f4c2-7a36-7af3-a01e-0fcb31e9d84e"

type fakeAgentService struct {
	createCommand     appagent.CreateCommand
	updateCommand     appagent.UpdateCommand
	lifecycleCommands []appagent.LifecycleCommand
	credentialCommand appagent.CredentialCommand
	deleteCommand     appagent.DeleteCommand
	result            agentport.CreateResult
	agents            []agentport.Agent
}

func (service *fakeAgentService) Create(
	_ context.Context,
	command appagent.CreateCommand,
) (agentport.CreateResult, error) {
	service.createCommand = command
	return service.result, nil
}

func (service *fakeAgentService) List(
	context.Context,
	string,
	string,
) ([]agentport.Agent, error) {
	return service.agents, nil
}

func (service *fakeAgentService) Get(
	context.Context,
	string,
	string,
	string,
) (agentport.Agent, error) {
	return service.agents[0], nil
}

func (service *fakeAgentService) Update(
	_ context.Context,
	command appagent.UpdateCommand,
) (agentport.Agent, error) {
	service.updateCommand = command
	value := service.agents[0]
	value.Revision = command.Revision + 1
	if command.DisplayName != nil {
		value.DisplayName = *command.DisplayName
	}
	return value, nil
}

func (service *fakeAgentService) Lifecycle(
	_ context.Context,
	command appagent.LifecycleCommand,
) (agentport.Operation, error) {
	service.lifecycleCommands = append(service.lifecycleCommands, command)
	return agentport.Operation{
		ID: handlerOperationID, ServerID: command.ServerID,
		Service: "platform", Kind: command.Kind,
		State:     "succeeded",
		CreatedAt: time.Date(2026, 7, 31, 0, 30, 0, 0, time.UTC),
	}, nil
}

func (service *fakeAgentService) RotateCredential(
	_ context.Context,
	command appagent.CredentialCommand,
) (agentport.Operation, error) {
	service.credentialCommand = command
	return agentport.Operation{
		ID: handlerOperationID, ServerID: command.ServerID,
		Service: "platform", Kind: "agent.credential.rotate",
		State:     "succeeded",
		CreatedAt: time.Date(2026, 7, 31, 0, 30, 0, 0, time.UTC),
	}, nil
}

func (service *fakeAgentService) Delete(
	_ context.Context,
	command appagent.DeleteCommand,
) (agentport.Operation, error) {
	service.deleteCommand = command
	return agentport.Operation{
		ID: handlerOperationID, ServerID: command.ServerID,
		Service: "im", Kind: "im.identity.delete",
		State:     "pending",
		CreatedAt: time.Date(2026, 7, 31, 0, 30, 0, 0, time.UTC),
	}, nil
}

func TestAgentHandlerMapsCreateQueriesAndOperations(t *testing.T) {
	now := time.Date(2026, 7, 31, 0, 30, 0, 0, time.UTC)
	computerID := handlerComputerID
	value := agentport.Agent{
		ID: handlerAgentID, ServerID: handlerServerID,
		DisplayName: "小舟", Handle: "xiaozhou",
		IMUserID: "a_TESTAGENTUSERID2345678901234",
		IMState:  "provisioning", ComputerID: &computerID,
		Runtime:     agentport.Runtime{Kind: "codex"},
		ReplyPolicy: "mention_and_dm", DesiredState: "stopped",
		ObservedState: "unknown", Availability: "offline",
		IMPresence: "unknown", IMTransportState: "unknown",
		CredentialVersion: 0, Revision: 1,
	}
	service := &fakeAgentService{
		agents: []agentport.Agent{value},
		result: agentport.CreateResult{
			Agent: value,
			Operation: agentport.Operation{
				ID: handlerOperationID, ServerID: handlerServerID,
				Service: "im", Kind: "im.identity.ensure",
				State: "pending", CreatedAt: now,
			},
		},
	}
	handler, err := NewAgentHandler(service)
	if err != nil {
		t.Fatal(err)
	}
	computerUUID := uuid.MustParse(handlerComputerID)
	response, err := handler.CreateAgent(
		currentHumanContext(t),
		openapi.CreateAgentRequestObject{
			ServerId: uuid.MustParse(handlerServerID),
			Params: openapi.CreateAgentParams{
				IdempotencyKey: "agent-create-0001",
			},
			Body: &openapi.CreateAgentRequest{
				DisplayName: "小舟", Handle: "xiaozhou",
				ComputerId: computerUUID,
				Runtime: openapi.RuntimeConfig{
					Kind: openapi.RuntimeConfigKind("codex"),
				},
			},
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	accepted, ok := response.(openapi.CreateAgent202JSONResponse)
	if !ok || accepted.ResourceId.String() != handlerAgentID ||
		len(accepted.Operations) != 1 ||
		service.createCommand.AccountID != handlerAccountID ||
		service.createCommand.ComputerID == nil ||
		*service.createCommand.ComputerID != handlerComputerID {
		t.Fatalf(
			"CreateAgent() = %#v command=%#v",
			response,
			service.createCommand,
		)
	}
	listResponse, err := handler.ListAgents(
		currentHumanContext(t),
		openapi.ListAgentsRequestObject{
			ServerId: uuid.MustParse(handlerServerID),
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	list, ok := listResponse.(openapi.ListAgents200JSONResponse)
	if !ok || len(list) != 1 ||
		list[0].Id.String() != handlerAgentID ||
		list[0].ComputerId.String() != handlerComputerID {
		t.Fatalf("ListAgents() = %#v", listResponse)
	}
	getResponse, err := handler.GetAgent(
		currentHumanContext(t),
		openapi.GetAgentRequestObject{
			ServerId: uuid.MustParse(handlerServerID),
			AgentId:  uuid.MustParse(handlerAgentID),
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	if got, ok := getResponse.(openapi.GetAgent200JSONResponse); !ok ||
		got.Runtime.Kind != openapi.RuntimeConfigKind("codex") {
		t.Fatalf("GetAgent() = %#v", getResponse)
	}
	newName := "新小舟"
	policy := openapi.UpdateAgentRequestReplyPolicy("dm_only")
	updateResponse, err := handler.UpdateAgent(
		currentHumanContext(t),
		openapi.UpdateAgentRequestObject{
			ServerId: uuid.MustParse(handlerServerID),
			AgentId:  uuid.MustParse(handlerAgentID),
			Params: openapi.UpdateAgentParams{
				XResourceRevision: 1,
				IdempotencyKey:    "agent-update-0001",
			},
			Body: &openapi.UpdateAgentRequest{
				DisplayName: &newName,
				ReplyPolicy: &policy,
			},
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	if got, ok := updateResponse.(openapi.UpdateAgent200JSONResponse); !ok ||
		got.Body.DisplayName != newName || got.Headers.XResourceRevision != 2 ||
		service.updateCommand.Revision != 1 ||
		service.updateCommand.ReplyPolicy == nil ||
		*service.updateCommand.ReplyPolicy != "dm_only" {
		t.Fatalf(
			"UpdateAgent() = %#v command=%#v",
			updateResponse,
			service.updateCommand,
		)
	}
	if _, err := handler.StartAgent(
		currentHumanContext(t),
		openapi.StartAgentRequestObject{
			ServerId: uuid.MustParse(handlerServerID),
			AgentId:  uuid.MustParse(handlerAgentID),
			Params: openapi.StartAgentParams{
				IdempotencyKey: "agent-start-0001",
			},
		},
	); err != nil {
		t.Fatal(err)
	}
	if len(service.lifecycleCommands) != 1 ||
		service.lifecycleCommands[0].Kind != "start" {
		t.Fatalf("lifecycle commands = %#v", service.lifecycleCommands)
	}
	if _, err := handler.RotateAgentRuntimeCredential(
		currentHumanContext(t),
		openapi.RotateAgentRuntimeCredentialRequestObject{
			ServerId: uuid.MustParse(handlerServerID),
			AgentId:  uuid.MustParse(handlerAgentID),
			Params: openapi.RotateAgentRuntimeCredentialParams{
				IdempotencyKey: "agent-credential-0001",
			},
		},
	); err != nil {
		t.Fatal(err)
	}
	if service.credentialCommand.AgentID != handlerAgentID {
		t.Fatalf("credential command = %#v", service.credentialCommand)
	}
	deleteResponse, err := handler.DeleteAgent(
		currentHumanContext(t),
		openapi.DeleteAgentRequestObject{
			ServerId: uuid.MustParse(handlerServerID),
			AgentId:  uuid.MustParse(handlerAgentID),
			Params: openapi.DeleteAgentParams{
				IdempotencyKey: "agent-delete-0001",
			},
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	deleted, ok := deleteResponse.(openapi.DeleteAgent202JSONResponse)
	if !ok || deleted.ResourceId.String() != handlerAgentID ||
		len(deleted.Operations) != 1 ||
		deleted.Operations[0].Kind != "im.identity.delete" ||
		service.deleteCommand.AgentID != handlerAgentID {
		t.Fatalf(
			"DeleteAgent() = %#v command=%#v",
			deleteResponse,
			service.deleteCommand,
		)
	}
}
