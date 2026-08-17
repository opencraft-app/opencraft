package httptransport

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"strings"

	"chatserver/internal/api/openapi"
	appagent "chatserver/internal/app/agentmanagement"
	"chatserver/internal/apperror"
	"chatserver/internal/persistedjson"
	agentport "chatserver/internal/ports/agent"
)

type agentService interface {
	Create(context.Context, appagent.CreateCommand) (agentport.CreateResult, error)
	List(context.Context, string, string) ([]agentport.Agent, error)
	Get(context.Context, string, string, string) (agentport.Agent, error)
	Update(
		context.Context,
		appagent.UpdateCommand,
	) (agentport.Agent, error)
	Delete(
		context.Context,
		appagent.DeleteCommand,
	) (agentport.Operation, error)
	Lifecycle(
		context.Context,
		appagent.LifecycleCommand,
	) (agentport.Operation, error)
	RotateCredential(
		context.Context,
		appagent.CredentialCommand,
	) (agentport.Operation, error)
}

type agentProfileCapabilityService interface {
	GetProfileCapabilities(
		context.Context,
		string,
		string,
		string,
	) (agentport.ProfileCapabilities, error)
	RefreshProfileCapabilities(
		context.Context,
		appagent.ProfileCapabilityRefreshCommand,
	) (agentport.Operation, error)
}

func (handler *AgentHandler) GetAgentProfileCapabilities(
	ctx context.Context,
	request openapi.GetAgentProfileCapabilitiesRequestObject,
) (openapi.GetAgentProfileCapabilitiesResponseObject, error) {
	principal, ok := CurrentHumanPrincipal(ctx)
	if !ok {
		return nil, apperror.New("unauthenticated", "登录凭证无效", nil)
	}
	service, ok := handler.service.(agentProfileCapabilityService)
	if !ok {
		return nil, apperror.New(
			"internal_error",
			"Profile capability service 未配置",
			nil,
		)
	}
	value, err := service.GetProfileCapabilities(
		ctx,
		principal.AccountID(),
		request.ServerId.String(),
		request.AgentId.String(),
	)
	if err != nil {
		return nil, err
	}
	agentID, err := parseDomainID(value.AgentID, "Agent")
	if err != nil {
		return nil, err
	}
	body := openapi.AgentProfileCapabilities{
		AgentId:       agentID,
		SnapshotState: openapi.AgentProfileSnapshotAbsent,
		StaleReasons:  []openapi.AgentProfileCapabilitiesStaleReasons{},
	}
	if value.RefreshOperation != nil {
		operation, err := agentOperationDTO(*value.RefreshOperation)
		if err != nil {
			return nil, err
		}
		body.RefreshOperation = &operation
	}
	if value.SnapshotJSON != nil {
		var payload persistedjson.ProfileCapabilitiesPayload
		if _, err := persistedjson.DecodeProfileCapabilities(
			*value.SnapshotJSON,
			&payload,
		); err != nil || payload.SchemaVersion != 1 || len(payload.Snapshot) == 0 {
			return nil, apperror.New(
				"internal_error",
				"Profile capability envelope 无效",
				err,
			)
		}
		var snapshot openapi.ComputerAgentProfileCapabilityResult
		if err := json.Unmarshal(payload.Snapshot, &snapshot); err != nil {
			return nil, apperror.New(
				"internal_error",
				"Profile capability snapshot 无效",
				err,
			)
		}
		body.SnapshotState = openapi.AgentProfileSnapshotCurrent
		body.Subject = snapshot.Subject
		body.Source = snapshot.Source
		observedAt := snapshot.ObservedAt.UTC()
		body.ObservedAt = &observedAt
		if snapshot.Subject != nil {
			if value.ComputerID == nil ||
				snapshot.Subject.ComputerId.String() != *value.ComputerID {
				body.StaleReasons = append(
					body.StaleReasons,
					openapi.AgentProfileStaleComputerChanged,
				)
			}
			if string(snapshot.Subject.RuntimeKind) != value.Runtime.Kind {
				body.StaleReasons = append(
					body.StaleReasons,
					openapi.AgentProfileStaleRuntimeChanged,
				)
			}
			if snapshot.Subject.ContextGeneration != value.ContextGeneration {
				body.StaleReasons = append(
					body.StaleReasons,
					openapi.AgentProfileStaleProfileChanged,
				)
			}
			if len(body.StaleReasons) > 0 {
				body.SnapshotState = openapi.AgentProfileSnapshotStale
			}
		}
		for _, invalidation := range payload.Invalidations {
			reason := openapi.AgentProfileCapabilitiesStaleReasons(invalidation.Reason)
			if !reason.Valid() || containsProfileStaleReason(body.StaleReasons, reason) {
				continue
			}
			body.StaleReasons = append(body.StaleReasons, reason)
			body.SnapshotState = openapi.AgentProfileSnapshotStale
		}
		if string(snapshot.Models.Status) == "succeeded" {
			selectionMode := openapi.AgentProfileModelCapabilitiesSelectionMode(
				"follow_runtime_default",
			)
			availability := openapi.AgentProfileModelCapabilitiesSelectedAvailability(
				"unknown",
			)
			configured := value.Runtime.Model
			if configured != nil {
				selectionMode = openapi.AgentProfileModelCapabilitiesSelectionMode("fixed")
				availability = openapi.AgentProfileModelCapabilitiesSelectedAvailability(
					"unavailable",
				)
				for _, item := range snapshot.Models.Items {
					if item.Id == *configured {
						availability = openapi.AgentProfileModelCapabilitiesSelectedAvailability(
							"available",
						)
						break
					}
				}
			}
			body.Models = &openapi.AgentProfileModelCapabilities{
				SelectionMode: selectionMode, ConfiguredModelId: configured,
				EffectiveDefaultModelId: snapshot.Models.EffectiveDefaultModelId,
				SelectedAvailability:    availability, Items: snapshot.Models.Items,
				Truncated: snapshot.Models.Truncated, Warnings: snapshot.Models.Warnings,
			}
		}
		if string(snapshot.Skills.Status) == "succeeded" {
			body.Skills = &openapi.AgentProfileSkillCapabilities{
				Items: snapshot.Skills.Items, Truncated: snapshot.Skills.Truncated,
				Warnings: snapshot.Skills.Warnings,
			}
		}
	}
	return openapi.GetAgentProfileCapabilities200JSONResponse(body), nil
}

func containsProfileStaleReason(
	values []openapi.AgentProfileCapabilitiesStaleReasons,
	want openapi.AgentProfileCapabilitiesStaleReasons,
) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}

type AgentHandler struct {
	openapi.StrictServerInterface
	service agentService
	logger  *slog.Logger
}

var _ openapi.StrictServerInterface = (*AgentHandler)(nil)

func NewAgentHandler(
	service agentService,
	loggers ...*slog.Logger,
) (*AgentHandler, error) {
	if service == nil {
		return nil, errors.New("Agent 应用服务不能为空")
	}
	logger := slog.Default()
	if len(loggers) > 0 && loggers[0] != nil {
		logger = loggers[0]
	}
	return &AgentHandler{service: service, logger: logger}, nil
}

func (handler *AgentHandler) CreateAgent(
	ctx context.Context,
	request openapi.CreateAgentRequestObject,
) (openapi.CreateAgentResponseObject, error) {
	principal, ok := CurrentHumanPrincipal(ctx)
	if !ok {
		return nil, apperror.New("unauthenticated", "登录凭证无效", nil)
	}
	if request.Body == nil {
		return nil, apperror.New("invalid_request", "请求体不能为空", nil)
	}
	computerIDValue := request.Body.ComputerId.String()
	computerID := &computerIDValue
	replyPolicy := ""
	if request.Body.ReplyPolicy != nil {
		replyPolicy = string(*request.Body.ReplyPolicy)
	}
	result, err := handler.service.Create(ctx, appagent.CreateCommand{
		AccountID: principal.AccountID(), ServerID: request.ServerId.String(),
		IdempotencyKey: request.Params.IdempotencyKey,
		DisplayName:    request.Body.DisplayName, Handle: request.Body.Handle,
		Description: request.Body.Description, ComputerID: computerID,
		Runtime: agentport.Runtime{
			Kind:  string(request.Body.Runtime.Kind),
			Model: request.Body.Runtime.Model,
		},
		ReplyPolicy: replyPolicy,
	})
	if err != nil {
		return nil, err
	}
	resourceID, err := parseDomainID(result.Agent.ID, "Agent")
	if err != nil {
		return nil, err
	}
	operation, err := agentOperationDTO(result.Operation)
	if err != nil {
		return nil, err
	}
	handler.logger.Info(
		"agent create accepted",
		"request_id", RequestID(ctx),
		"server_id", request.ServerId.String(),
		"agent_id", result.Agent.ID,
		"computer_id", computerIDValue,
		"operation_id", result.Operation.ID,
		"operation_state", result.Operation.State,
	)
	return openapi.CreateAgent202JSONResponse{
		ResourceId: resourceID,
		Operations: []openapi.Operation{operation},
	}, nil
}

func (handler *AgentHandler) ListAgents(
	ctx context.Context,
	request openapi.ListAgentsRequestObject,
) (openapi.ListAgentsResponseObject, error) {
	principal, ok := CurrentHumanPrincipal(ctx)
	if !ok {
		return nil, apperror.New("unauthenticated", "登录凭证无效", nil)
	}
	values, err := handler.service.List(
		ctx,
		principal.AccountID(),
		request.ServerId.String(),
	)
	if err != nil {
		return nil, err
	}
	body := make(openapi.ListAgents200JSONResponse, 0, len(values))
	for _, value := range values {
		item, err := agentDTO(value)
		if err != nil {
			return nil, err
		}
		body = append(body, item)
	}
	return body, nil
}

func (handler *AgentHandler) GetAgent(
	ctx context.Context,
	request openapi.GetAgentRequestObject,
) (openapi.GetAgentResponseObject, error) {
	principal, ok := CurrentHumanPrincipal(ctx)
	if !ok {
		return nil, apperror.New("unauthenticated", "登录凭证无效", nil)
	}
	value, err := handler.service.Get(
		ctx,
		principal.AccountID(),
		request.ServerId.String(),
		request.AgentId.String(),
	)
	if err != nil {
		return nil, err
	}
	body, err := agentDTO(value)
	if err != nil {
		return nil, err
	}
	return openapi.GetAgent200JSONResponse(body), nil
}

func (handler *AgentHandler) UpdateAgent(
	ctx context.Context,
	request openapi.UpdateAgentRequestObject,
) (openapi.UpdateAgentResponseObject, error) {
	principal, ok := CurrentHumanPrincipal(ctx)
	if !ok {
		return nil, apperror.New("unauthenticated", "登录凭证无效", nil)
	}
	if request.Body == nil {
		return nil, apperror.New("invalid_request", "请求体不能为空", nil)
	}
	revision, err := workRevision(request.Params.XResourceRevision)
	if err != nil {
		return nil, err
	}
	command := appagent.UpdateCommand{
		AccountID:      principal.AccountID(),
		ServerID:       request.ServerId.String(),
		AgentID:        request.AgentId.String(),
		Revision:       revision,
		IdempotencyKey: request.Params.IdempotencyKey,
		DisplayName:    request.Body.DisplayName,
		DescriptionSet: request.Body.Description != nil,
		Description:    request.Body.Description,
		ComputerIDSet:  request.Body.ComputerId != nil,
	}
	if request.Body.ComputerId != nil {
		value := request.Body.ComputerId.String()
		command.ComputerID = &value
	}
	if request.Body.Runtime != nil {
		command.Runtime = &agentport.Runtime{
			Kind:  string(request.Body.Runtime.Kind),
			Model: request.Body.Runtime.Model,
		}
	}
	if request.Body.ReplyPolicy != nil {
		value := string(*request.Body.ReplyPolicy)
		command.ReplyPolicy = &value
	}
	value, err := handler.service.Update(ctx, command)
	if err != nil {
		return nil, err
	}
	body, err := agentDTO(value)
	if err != nil {
		return nil, err
	}
	return openapi.UpdateAgent200JSONResponse{
		Body: body,
		Headers: openapi.UpdateAgent200ResponseHeaders{
			XResourceRevision: body.Revision,
		},
	}, nil
}

func (handler *AgentHandler) DeleteAgent(
	ctx context.Context,
	request openapi.DeleteAgentRequestObject,
) (openapi.DeleteAgentResponseObject, error) {
	principal, ok := CurrentHumanPrincipal(ctx)
	if !ok {
		return nil, apperror.New("unauthenticated", "登录凭证无效", nil)
	}
	operation, err := handler.service.Delete(ctx, appagent.DeleteCommand{
		AccountID:      principal.AccountID(),
		ServerID:       request.ServerId.String(),
		AgentID:        request.AgentId.String(),
		IdempotencyKey: request.Params.IdempotencyKey,
	})
	if err != nil {
		return nil, err
	}
	resourceID, err := parseDomainID(request.AgentId.String(), "Agent")
	if err != nil {
		return nil, err
	}
	body, err := agentOperationDTO(operation)
	if err != nil {
		return nil, err
	}
	return openapi.DeleteAgent202JSONResponse{
		ResourceId: resourceID,
		Operations: []openapi.Operation{body},
	}, nil
}

func (handler *AgentHandler) DeployAgent(
	ctx context.Context,
	request openapi.DeployAgentRequestObject,
) (openapi.DeployAgentResponseObject, error) {
	value, err := handler.lifecycle(
		ctx, request.ServerId.String(), request.AgentId.String(),
		request.Params.IdempotencyKey, "deploy",
	)
	if err != nil {
		return nil, err
	}
	return openapi.DeployAgent202JSONResponse(value), nil
}

func (handler *AgentHandler) StartAgent(
	ctx context.Context,
	request openapi.StartAgentRequestObject,
) (openapi.StartAgentResponseObject, error) {
	value, err := handler.lifecycle(
		ctx, request.ServerId.String(), request.AgentId.String(),
		request.Params.IdempotencyKey, "start",
	)
	if err != nil {
		return nil, err
	}
	return openapi.StartAgent202JSONResponse(value), nil
}

func (handler *AgentHandler) StopAgent(
	ctx context.Context,
	request openapi.StopAgentRequestObject,
) (openapi.StopAgentResponseObject, error) {
	value, err := handler.lifecycle(
		ctx, request.ServerId.String(), request.AgentId.String(),
		request.Params.IdempotencyKey, "stop",
	)
	if err != nil {
		return nil, err
	}
	return openapi.StopAgent202JSONResponse(value), nil
}

func (handler *AgentHandler) RestartAgent(
	ctx context.Context,
	request openapi.RestartAgentRequestObject,
) (openapi.RestartAgentResponseObject, error) {
	value, err := handler.lifecycle(
		ctx, request.ServerId.String(), request.AgentId.String(),
		request.Params.IdempotencyKey, "restart",
	)
	if err != nil {
		return nil, err
	}
	return openapi.RestartAgent202JSONResponse(value), nil
}

func (handler *AgentHandler) RotateAgentRuntimeCredential(
	ctx context.Context,
	request openapi.RotateAgentRuntimeCredentialRequestObject,
) (openapi.RotateAgentRuntimeCredentialResponseObject, error) {
	principal, ok := CurrentHumanPrincipal(ctx)
	if !ok {
		return nil, apperror.New("unauthenticated", "登录凭证无效", nil)
	}
	operation, err := handler.service.RotateCredential(
		ctx,
		appagent.CredentialCommand{
			AccountID:      principal.AccountID(),
			ServerID:       request.ServerId.String(),
			AgentID:        request.AgentId.String(),
			IdempotencyKey: request.Params.IdempotencyKey,
		},
	)
	if err != nil {
		return nil, err
	}
	body, err := agentOperationDTO(operation)
	if err != nil {
		return nil, err
	}
	return openapi.RotateAgentRuntimeCredential202JSONResponse(body), nil
}

func (handler *AgentHandler) RefreshAgentProfileCapabilities(
	ctx context.Context,
	request openapi.RefreshAgentProfileCapabilitiesRequestObject,
) (openapi.RefreshAgentProfileCapabilitiesResponseObject, error) {
	principal, ok := CurrentHumanPrincipal(ctx)
	if !ok {
		return nil, apperror.New("unauthenticated", "登录凭证无效", nil)
	}
	service, ok := handler.service.(agentProfileCapabilityService)
	if !ok {
		return nil, apperror.New(
			"internal_error",
			"Profile capability service 未配置",
			nil,
		)
	}
	operation, err := service.RefreshProfileCapabilities(
		ctx,
		appagent.ProfileCapabilityRefreshCommand{
			AccountID:      principal.AccountID(),
			ServerID:       request.ServerId.String(),
			AgentID:        request.AgentId.String(),
			IdempotencyKey: request.Params.IdempotencyKey,
		},
	)
	if err != nil {
		return nil, err
	}
	body, err := agentOperationDTO(operation)
	if err != nil {
		return nil, err
	}
	return openapi.RefreshAgentProfileCapabilities202JSONResponse(body), nil
}

func (handler *AgentHandler) lifecycle(
	ctx context.Context,
	serverID string,
	agentID string,
	idempotencyKey string,
	kind string,
) (openapi.Operation, error) {
	principal, ok := CurrentHumanPrincipal(ctx)
	if !ok {
		return openapi.Operation{},
			apperror.New("unauthenticated", "登录凭证无效", nil)
	}
	operation, err := handler.service.Lifecycle(
		ctx,
		appagent.LifecycleCommand{
			AccountID:      principal.AccountID(),
			ServerID:       serverID,
			AgentID:        agentID,
			Kind:           kind,
			IdempotencyKey: idempotencyKey,
		},
	)
	if err != nil {
		return openapi.Operation{}, err
	}
	body, err := agentOperationDTO(operation)
	if err != nil {
		return openapi.Operation{}, err
	}
	handler.logger.Info(
		"agent lifecycle accepted",
		"request_id", RequestID(ctx),
		"server_id", serverID,
		"agent_id", agentID,
		"action", kind,
		"operation_id", operation.ID,
		"operation_state", operation.State,
	)
	return body, nil
}

func agentDTO(value agentport.Agent) (openapi.Agent, error) {
	id, err := parseDomainID(value.ID, "Agent")
	if err != nil {
		return openapi.Agent{}, err
	}
	serverID, err := parseDomainID(value.ServerID, "Server")
	if err != nil {
		return openapi.Agent{}, err
	}
	if value.ComputerID == nil {
		return openapi.Agent{}, invalidDomainData("Agent 未绑定 Computer", nil)
	}
	computerID, err := parseDomainID(*value.ComputerID, "Computer")
	if err != nil {
		return openapi.Agent{}, err
	}
	result := openapi.Agent{
		Id: id, ServerId: serverID,
		DisplayName: value.DisplayName, Handle: value.Handle,
		Description: value.Description, ImUserId: value.IMUserID,
		ImState:    openapi.AgentImState(value.IMState),
		ComputerId: computerID,
		Runtime: openapi.RuntimeConfig{
			Kind:  openapi.RuntimeConfigKind(value.Runtime.Kind),
			Model: value.Runtime.Model,
		},
		ReplyPolicy:       openapi.AgentReplyPolicy(value.ReplyPolicy),
		DesiredState:      openapi.AgentDesiredState(value.DesiredState),
		ObservedState:     openapi.AgentObservedState(value.ObservedState),
		Availability:      openapi.AgentAvailability(value.Availability),
		ImPresence:        openapi.AgentImPresence(value.IMPresence),
		ImTransportState:  openapi.AgentImTransportState(value.IMTransportState),
		CredentialVersion: int(value.CredentialVersion),
		LastErrorCode:     normalizedOptionalString(value.LastErrorCode),
		Revision:          value.Revision,
	}
	if value.LastObservedAt != nil {
		observedAt := value.LastObservedAt.UTC()
		result.LastObservedAt = &observedAt
	}
	if value.IMPresenceUpdatedAt != nil {
		observedAt := value.IMPresenceUpdatedAt.UTC()
		result.ImPresenceUpdatedAt = &observedAt
	}
	if value.IMTransportUpdatedAt != nil {
		observedAt := value.IMTransportUpdatedAt.UTC()
		result.ImTransportUpdatedAt = &observedAt
	}
	if value.HostLastSeenAt != nil {
		seenAt := value.HostLastSeenAt.UTC()
		result.HostLastSeenAt = &seenAt
	}
	if !result.ImState.Valid() || !result.Runtime.Kind.Valid() ||
		!result.ReplyPolicy.Valid() || !result.DesiredState.Valid() ||
		!result.ObservedState.Valid() || !result.Availability.Valid() ||
		!result.ImPresence.Valid() || !result.ImTransportState.Valid() ||
		value.CredentialVersion < 0 ||
		result.Revision < 1 {
		return openapi.Agent{}, invalidDomainData("Agent 数据无效", nil)
	}
	return result, nil
}

func agentOperationDTO(value agentport.Operation) (openapi.Operation, error) {
	id, err := parseDomainID(value.ID, "Operation")
	if err != nil {
		return openapi.Operation{}, err
	}
	result := openapi.Operation{
		Id: id, Service: openapi.OperationService(value.Service),
		Kind: value.Kind, State: openapi.OperationState(value.State),
		CreatedAt: value.CreatedAt.UTC(),
	}
	if value.CompletedAt != nil {
		completedAt := value.CompletedAt.UTC()
		result.CompletedAt = &completedAt
	}
	if code := strings.TrimSpace(value.LastErrorCode); code != "" {
		result.Error = &struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		}{
			Code: code, Message: "腾讯云操作尚未收敛",
		}
	}
	if !result.Service.Valid() || !result.State.Valid() ||
		value.CreatedAt.IsZero() {
		return openapi.Operation{},
			invalidDomainData("Operation 数据无效", nil)
	}
	return result, nil
}

func normalizedOptionalString(value string) *string {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil
	}
	return &value
}
