package httptransport

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"strings"
	"testing"
	"time"

	"chatserver/internal/api/openapi"
	appagent "chatserver/internal/app/agentmanagement"
	"chatserver/internal/persistedjson"
	agentport "chatserver/internal/ports/agent"

	"github.com/google/uuid"
)

const handlerAgentID = "0198f4c2-7a36-7af3-a01e-0fcb31e9d84e"

type fakeAgentService struct {
	createCommand            appagent.CreateCommand
	updateCommand            appagent.UpdateCommand
	lifecycleCommands        []appagent.LifecycleCommand
	credentialCommand        appagent.CredentialCommand
	deleteCommand            appagent.DeleteCommand
	profileCapabilityCommand appagent.ProfileCapabilityRefreshCommand
	profileCapabilities      agentport.ProfileCapabilities
	result                   agentport.CreateResult
	agents                   []agentport.Agent
}

func (service *fakeAgentService) GetProfileCapabilities(
	context.Context,
	string,
	string,
	string,
) (agentport.ProfileCapabilities, error) {
	return service.profileCapabilities, nil
}

func (service *fakeAgentService) RefreshProfileCapabilities(
	_ context.Context,
	command appagent.ProfileCapabilityRefreshCommand,
) (agentport.Operation, error) {
	service.profileCapabilityCommand = command
	return agentport.Operation{
		ID: handlerOperationID, ServerID: command.ServerID,
		Service: "platform", Kind: "agent.profile.capabilities.refresh",
		State: "pending", CreatedAt: time.Date(2026, 7, 31, 0, 30, 0, 0, time.UTC),
	}, nil
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

func TestAgentHandlerStartsProfileCapabilityRefresh(t *testing.T) {
	computerID := handlerComputerID
	service := &fakeAgentService{agents: []agentport.Agent{{
		ID: handlerAgentID, ServerID: handlerServerID, ComputerID: &computerID,
		Runtime: agentport.Runtime{Kind: "codex"}, Revision: 1,
	}}}
	handler, err := NewAgentHandler(service)
	if err != nil {
		t.Fatal(err)
	}
	response, err := handler.RefreshAgentProfileCapabilities(
		currentHumanContext(t),
		openapi.RefreshAgentProfileCapabilitiesRequestObject{
			ServerId: uuid.MustParse(handlerServerID),
			AgentId:  uuid.MustParse(handlerAgentID),
			Params: openapi.RefreshAgentProfileCapabilitiesParams{
				IdempotencyKey: "profile-refresh-0001",
			},
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	accepted, ok := response.(openapi.RefreshAgentProfileCapabilities202JSONResponse)
	if !ok || accepted.Kind != "agent.profile.capabilities.refresh" ||
		service.profileCapabilityCommand.AgentID != handlerAgentID ||
		service.profileCapabilityCommand.IdempotencyKey != "profile-refresh-0001" {
		t.Fatalf("RefreshAgentProfileCapabilities() = %#v command=%#v", response, service.profileCapabilityCommand)
	}
}

func TestAgentHandlerReturnsAbsentProfileCapabilitiesWithoutRefreshing(t *testing.T) {
	service := &fakeAgentService{profileCapabilities: agentport.ProfileCapabilities{
		AgentID: handlerAgentID,
	}}
	handler, err := NewAgentHandler(service)
	if err != nil {
		t.Fatal(err)
	}
	response, err := handler.GetAgentProfileCapabilities(
		currentHumanContext(t),
		openapi.GetAgentProfileCapabilitiesRequestObject{
			ServerId: uuid.MustParse(handlerServerID),
			AgentId:  uuid.MustParse(handlerAgentID),
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	body, ok := response.(openapi.GetAgentProfileCapabilities200JSONResponse)
	if !ok || body.SnapshotState != openapi.AgentProfileSnapshotAbsent ||
		body.Subject != nil || body.Models != nil || body.Skills != nil ||
		body.RefreshOperation != nil {
		t.Fatalf("GetAgentProfileCapabilities() = %#v", response)
	}
	if service.profileCapabilityCommand.AgentID != "" {
		t.Fatalf("GET triggered refresh: %#v", service.profileCapabilityCommand)
	}
}

func TestAgentHandlerMarksSnapshotStaleWhenAuthorityContextChanges(t *testing.T) {
	observedAt := time.Date(2026, 8, 18, 11, 0, 0, 0, time.UTC)
	snapshot, err := json.Marshal(openapi.ComputerAgentProfileCapabilityResult{
		SchemaVersion: 1, Status: openapi.ComputerProfileCapabilityResultSucceeded,
		ContextGeneration:        1,
		AuthorityContextKey:      "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
		RuntimeKind:              openapi.ComputerProfileCapabilityRuntimeCodex,
		RuntimeContextGeneration: 1, ObservedThroughSequence: 0,
		Subject: &openapi.AgentProfileCapabilitySubject{
			ComputerId:         uuid.MustParse("01989c24-7540-7f12-a27b-c83243215dd5"),
			RuntimeKind:        openapi.ProfileCapabilityRefreshRuntimeCodex,
			ProfileKind:        openapi.AgentProfileCapabilityProfileCodexHome,
			ProfileFingerprint: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
			WorkspacePath:      "/workspace", ContextGeneration: 1,
			AuthorityContextKey:      "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
			RuntimeContextGeneration: 1, ObservedThroughSequence: 0,
		},
		Models: openapi.ComputerProfileCapabilityModelSection{
			Status:   openapi.ComputerProfileModelSectionSucceeded,
			Items:    []openapi.AgentProfileModelCapability{},
			Warnings: []openapi.ProfileCapabilityWarning{},
		},
		Skills: openapi.ComputerProfileCapabilitySkillSection{
			Status:   openapi.ComputerProfileSkillSectionSucceeded,
			Items:    []openapi.AgentProfileSkillCapability{},
			Warnings: []openapi.ProfileCapabilityWarning{},
		},
		ObservedAt: observedAt,
	})
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := persistedjson.EncodeProfileCapabilities(
		persistedjson.ProfileCapabilitiesPayload{
			SchemaVersion: 1, Snapshot: json.RawMessage(snapshot),
			Invalidations: []persistedjson.ProfileCapabilityInvalidation{},
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	currentComputer := "01989c24-7540-7f12-a27b-c83243215dd6"
	service := &fakeAgentService{profileCapabilities: agentport.ProfileCapabilities{
		AgentID: handlerAgentID, ComputerID: &currentComputer, ContextGeneration: 2,
		Runtime: agentport.Runtime{Kind: "codex"}, SnapshotJSON: &encoded,
	}}
	handler, err := NewAgentHandler(service)
	if err != nil {
		t.Fatal(err)
	}
	response, err := handler.GetAgentProfileCapabilities(
		currentHumanContext(t),
		openapi.GetAgentProfileCapabilitiesRequestObject{
			ServerId: uuid.MustParse(handlerServerID),
			AgentId:  uuid.MustParse(handlerAgentID),
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	body := response.(openapi.GetAgentProfileCapabilities200JSONResponse)
	if body.SnapshotState != openapi.AgentProfileSnapshotStale ||
		len(body.StaleReasons) != 2 ||
		body.StaleReasons[0] != openapi.AgentProfileStaleComputerChanged ||
		body.StaleReasons[1] != openapi.AgentProfileStaleProfileChanged {
		t.Fatalf("stale capability projection = %#v", body)
	}
}

func TestAgentHandlerLogsAcceptedLifecycleWithoutIdempotencyKey(t *testing.T) {
	service := &fakeAgentService{}
	var output bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&output, nil))
	handler, err := NewAgentHandler(service, logger)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.WithValue(
		currentHumanContext(t),
		requestIDContextKey{},
		"request-agent-deploy",
	)
	const idempotencyKey = "agent-deploy-secret-idempotency-key"
	if _, err := handler.DeployAgent(
		ctx,
		openapi.DeployAgentRequestObject{
			ServerId: uuid.MustParse(handlerServerID),
			AgentId:  uuid.MustParse(handlerAgentID),
			Params: openapi.DeployAgentParams{
				IdempotencyKey: idempotencyKey,
			},
		},
	); err != nil {
		t.Fatal(err)
	}

	logged := output.String()
	for _, expected := range []string{
		`"msg":"agent lifecycle accepted"`,
		`"request_id":"request-agent-deploy"`,
		`"server_id":"` + handlerServerID + `"`,
		`"agent_id":"` + handlerAgentID + `"`,
		`"action":"deploy"`,
		`"operation_id":"` + handlerOperationID + `"`,
		`"operation_state":"succeeded"`,
	} {
		if !strings.Contains(logged, expected) {
			t.Errorf("log = %q, want field %q", logged, expected)
		}
	}
	if strings.Contains(logged, idempotencyKey) {
		t.Fatalf("log leaked idempotency key: %s", logged)
	}
}

func TestAgentHandlerLogsAcceptedCreateWithoutIdempotencyKey(t *testing.T) {
	computerID := handlerComputerID
	service := &fakeAgentService{
		result: agentport.CreateResult{
			Agent: agentport.Agent{
				ID: handlerAgentID, ServerID: handlerServerID,
				ComputerID: &computerID,
			},
			Operation: agentport.Operation{
				ID: handlerOperationID, ServerID: handlerServerID,
				Service: "im", Kind: "im.identity.ensure",
				State: "pending",
				CreatedAt: time.Date(
					2026, 7, 31, 0, 30, 0, 0, time.UTC,
				),
			},
		},
	}
	var output bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&output, nil))
	handler, err := NewAgentHandler(service, logger)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.WithValue(
		currentHumanContext(t),
		requestIDContextKey{},
		"request-agent-create",
	)
	const idempotencyKey = "agent-create-secret-idempotency-key"
	if _, err := handler.CreateAgent(
		ctx,
		openapi.CreateAgentRequestObject{
			ServerId: uuid.MustParse(handlerServerID),
			Params: openapi.CreateAgentParams{
				IdempotencyKey: idempotencyKey,
			},
			Body: &openapi.CreateAgentRequest{
				DisplayName: "小舟", Handle: "xiaozhou",
				ComputerId: uuid.MustParse(handlerComputerID),
				Runtime: openapi.RuntimeConfig{
					Kind: openapi.RuntimeConfigKind("codex"),
				},
			},
		},
	); err != nil {
		t.Fatal(err)
	}

	logged := output.String()
	for _, expected := range []string{
		`"msg":"agent create accepted"`,
		`"request_id":"request-agent-create"`,
		`"server_id":"` + handlerServerID + `"`,
		`"agent_id":"` + handlerAgentID + `"`,
		`"computer_id":"` + handlerComputerID + `"`,
		`"operation_id":"` + handlerOperationID + `"`,
		`"operation_state":"pending"`,
	} {
		if !strings.Contains(logged, expected) {
			t.Errorf("log = %q, want field %q", logged, expected)
		}
	}
	if strings.Contains(logged, idempotencyKey) {
		t.Fatalf("log leaked idempotency key: %s", logged)
	}
}
