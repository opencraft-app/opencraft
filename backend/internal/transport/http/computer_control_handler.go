package httptransport

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"net/http"

	"chatserver/internal/api/openapi"
	appagent "chatserver/internal/app/agentmanagement"
	appcomputercontrol "chatserver/internal/app/computercontrol"
	appcomputer "chatserver/internal/app/computermanagement"
	appruntimesession "chatserver/internal/app/runtimesession"
	"chatserver/internal/apperror"
	agentport "chatserver/internal/ports/agent"
	computercontrolport "chatserver/internal/ports/computercontrol"

	"github.com/google/uuid"
)

type computerControlSessionService interface {
	CreateSession(
		context.Context,
		string,
		string,
		uint64,
	) (appcomputercontrol.Session, error)
}

type computerAssignmentService interface {
	Get(
		context.Context,
		string,
		string,
		appcomputercontrol.AssignmentQuery,
	) (appcomputercontrol.AssignmentResult, error)
}

type computerCredentialRotationService interface {
	Rotate(
		context.Context,
		string,
		string,
		uint64,
		string,
	) (appcomputer.RuntimeCredential, error)
}

type computerAgentLaunchService interface {
	Create(
		context.Context,
		string,
		string,
		string,
		appcomputercontrol.AgentLaunchRequest,
	) (appcomputercontrol.AgentLaunch, error)
	Refresh(
		context.Context,
		string,
		string,
		string,
		string,
		appcomputercontrol.AgentSessionRefreshRequest,
	) (appruntimesession.Session, error)
}

type computerObservationService interface {
	Put(
		context.Context,
		string,
		string,
		string,
		string,
		appcomputercontrol.ObservationRequest,
	) (computercontrolport.ObservationResult, error)
	Heartbeat(
		context.Context,
		string,
		string,
		appcomputercontrol.HeartbeatRequest,
	) error
}

type computerProfileCapabilityService interface {
	CompleteProfileCapabilities(
		context.Context,
		appagent.ProfileCapabilityResultCommand,
	) (agentport.ProfileCapabilitySubmissionResult, error)
	InvalidateProfileCapabilities(
		context.Context,
		appagent.ProfileCapabilityInvalidationCommand,
	) (agentport.ProfileCapabilitySubmissionResult, error)
}

// ComputerControlHandler serves requests made by the Vela daemon. It is kept
// separate from the human-facing Computer management handler so the two trust
// boundaries cannot accidentally share authorization rules.
type ComputerControlHandler struct {
	openapi.StrictServerInterface
	sessions            computerControlSessionService
	credentials         computerCredentialRotationService
	assignments         computerAssignmentService
	launches            computerAgentLaunchService
	observations        computerObservationService
	profileCapabilities computerProfileCapabilityService
}

var _ openapi.StrictServerInterface = (*ComputerControlHandler)(nil)

// NewComputerControlHandler creates the daemon-facing strict handler.
func NewComputerControlHandler(
	sessions computerControlSessionService,
	credentials computerCredentialRotationService,
	assignments computerAssignmentService,
	launches computerAgentLaunchService,
	observations computerObservationService,
	profileCapabilities ...computerProfileCapabilityService,
) (*ComputerControlHandler, error) {
	if sessions == nil || credentials == nil || assignments == nil || launches == nil ||
		observations == nil {
		return nil, errors.New("Computer 控制应用服务不能为空")
	}
	handler := &ComputerControlHandler{
		sessions: sessions, credentials: credentials,
		assignments: assignments, launches: launches,
		observations: observations,
	}
	if len(profileCapabilities) > 0 {
		handler.profileCapabilities = profileCapabilities[0]
	}
	return handler, nil
}

// CreateComputerAgentLaunch atomically allocates the server-issued launch
// fence before returning short-lived Runtime and IM session material.
func (handler *ComputerControlHandler) CreateComputerAgentLaunch(
	ctx context.Context,
	request openapi.CreateComputerAgentLaunchRequestObject,
) (openapi.CreateComputerAgentLaunchResponseObject, error) {
	principal, ok := CurrentComputerPrincipal(ctx)
	if !ok {
		return nil, apperror.New("computer_credential_invalid", "Computer credential 无效", nil)
	}
	if request.Body == nil || request.Body.CredentialVersion < 1 {
		return nil, apperror.New("assignment_stale", "Agent Assignment 已变化", nil)
	}
	var predecessor *string
	if request.Body.PredecessorLaunchId != nil {
		value := request.Body.PredecessorLaunchId.String()
		predecessor = &value
	}
	result, err := handler.launches.Create(
		ctx,
		principal.ServerID(),
		principal.ComputerID(),
		request.AgentId.String(),
		appcomputercontrol.AgentLaunchRequest{
			ComputerCredentialVersion: principal.CredentialVersion(),
			LaunchID:                  request.Body.LaunchId.String(),
			PredecessorLaunchID:       predecessor,
			AssignmentEpoch:           request.Body.AssignmentEpoch.String(),
			AssignmentRevision:        request.Body.AssignmentRevision,
			ConfigGeneration:          request.Body.ConfigGeneration,
			CredentialVersion:         uint64(request.Body.CredentialVersion),
		},
	)
	if err != nil {
		return nil, err
	}
	body, err := agentLaunchDTO(result)
	if err != nil {
		return nil, err
	}
	if !result.Created {
		return openapi.CreateComputerAgentLaunch200JSONResponse{
			Body: body,
			Headers: openapi.CreateComputerAgentLaunch200ResponseHeaders{
				CacheControl: "no-store",
				Pragma:       "no-cache",
			},
		}, nil
	}
	return openapi.CreateComputerAgentLaunch201JSONResponse{
		Body: body,
		Headers: openapi.CreateComputerAgentLaunch201ResponseHeaders{
			CacheControl: "no-store",
			Pragma:       "no-cache",
		},
	}, nil
}

// RefreshComputerAgentSession mints new short-lived material only while the
// complete Launch Fence is still the Agent's current server-issued fence.
func (handler *ComputerControlHandler) RefreshComputerAgentSession(
	ctx context.Context,
	request openapi.RefreshComputerAgentSessionRequestObject,
) (openapi.RefreshComputerAgentSessionResponseObject, error) {
	principal, ok := CurrentComputerPrincipal(ctx)
	if !ok {
		return nil, apperror.New("computer_credential_invalid", "Computer credential 无效", nil)
	}
	if request.Body == nil || request.Body.CredentialVersion < 1 || request.Body.Attempt < 1 {
		return nil, apperror.New("stale_launch", "Agent Launch 已失效", nil)
	}
	result, err := handler.launches.Refresh(
		ctx,
		principal.ServerID(),
		principal.ComputerID(),
		request.AgentId.String(),
		request.LaunchId.String(),
		appcomputercontrol.AgentSessionRefreshRequest{
			AssignmentEpoch:   request.Body.AssignmentEpoch.String(),
			ConfigGeneration:  request.Body.ConfigGeneration,
			CredentialVersion: uint64(request.Body.CredentialVersion),
			Attempt:           request.Body.Attempt,
		},
	)
	if err != nil {
		return nil, err
	}
	body, err := agentLaunchSessionDTO(result)
	if err != nil {
		return nil, err
	}
	return openapi.RefreshComputerAgentSession200JSONResponse{
		Body: body,
		Headers: openapi.RefreshComputerAgentSession200ResponseHeaders{
			CacheControl: "no-store",
			Pragma:       "no-cache",
		},
	}, nil
}

// RotateComputerCredential rotates only the active version represented by the
// current short bearer. Repository fencing prevents a grace version from
// initiating a second independent rotation.
func (handler *ComputerControlHandler) RotateComputerCredential(
	ctx context.Context,
	request openapi.RotateComputerCredentialRequestObject,
) (openapi.RotateComputerCredentialResponseObject, error) {
	principal, ok := CurrentComputerPrincipal(ctx)
	if !ok {
		return nil, apperror.New(
			"computer_credential_invalid", "Computer credential 无效", nil,
		)
	}
	value, err := handler.credentials.Rotate(
		ctx,
		principal.ServerID(),
		principal.ComputerID(),
		principal.CredentialVersion(),
		request.Params.IdempotencyKey,
	)
	if err != nil {
		return nil, err
	}
	body, err := computerRuntimeCredentialDTO(value)
	if err != nil {
		return nil, err
	}
	return openapi.RotateComputerCredential201JSONResponse{
		Body: body,
		Headers: openapi.RotateComputerCredential201ResponseHeaders{
			CacheControl: "no-store",
			Pragma:       "no-cache",
		},
	}, nil
}

// PutComputerAgentObservation stores an idempotent receipt and advances the
// current Agent projection only for a non-stale launch tuple.
func (handler *ComputerControlHandler) PutComputerAgentObservation(
	ctx context.Context,
	request openapi.PutComputerAgentObservationRequestObject,
) (openapi.PutComputerAgentObservationResponseObject, error) {
	principal, ok := CurrentComputerPrincipal(ctx)
	if !ok {
		return nil, apperror.New("computer_credential_invalid", "Computer credential 无效", nil)
	}
	if request.Body == nil {
		return nil, apperror.New("invalid_request", "Agent Observation 无效", nil)
	}
	assignmentRevision := int64(0)
	if request.Body.AssignmentRevision != nil {
		assignmentRevision = *request.Body.AssignmentRevision
	}
	result, err := handler.observations.Put(
		ctx,
		principal.ServerID(),
		principal.ComputerID(),
		request.AgentId.String(),
		request.ObservationId.String(),
		appcomputercontrol.ObservationRequest{
			AssignmentEpoch:    request.Body.AssignmentEpoch.String(),
			AssignmentRevision: assignmentRevision,
			ConfigGeneration:   request.Body.ConfigGeneration,
			CredentialVersion:  uint64(request.Body.CredentialVersion),
			Attempt:            request.Body.Attempt,
			Sequence:           request.Body.Sequence,
			LaunchID:           request.Body.LaunchId.String(),
			State:              string(request.Body.State),
			IMTransportState:   string(request.Body.ImTransportState),
			ErrorCode:          request.Body.ErrorCode,
			ObservedAt:         request.Body.ObservedAt,
		},
	)
	if err != nil {
		return nil, err
	}
	body, err := observationResultDTO(result)
	if err != nil {
		return nil, err
	}
	return openapi.PutComputerAgentObservation200JSONResponse(body), nil
}

// SendComputerHeartbeat refreshes the Computer lease and exact current Agent
// launch leases. Stale launch entries are ignored by the repository.
func (handler *ComputerControlHandler) SendComputerHeartbeat(
	ctx context.Context,
	request openapi.SendComputerHeartbeatRequestObject,
) (openapi.SendComputerHeartbeatResponseObject, error) {
	principal, ok := CurrentComputerPrincipal(ctx)
	if !ok {
		return nil, apperror.New("computer_credential_invalid", "Computer credential 无效", nil)
	}
	if request.Body == nil {
		return nil, apperror.New("invalid_request", "Computer heartbeat 无效", nil)
	}
	agents := make([]appcomputercontrol.HeartbeatAgent, 0, len(request.Body.Agents))
	for _, item := range request.Body.Agents {
		agents = append(agents, appcomputercontrol.HeartbeatAgent{
			AgentID: item.AgentId.String(), AssignmentEpoch: item.AssignmentEpoch.String(),
			ConfigGeneration:  item.ConfigGeneration,
			CredentialVersion: uint64(item.CredentialVersion),
			Attempt:           item.Attempt, LaunchID: item.LaunchId.String(),
		})
	}
	assignmentVersion := 0
	if request.Body.AssignmentVersion != nil {
		assignmentVersion = int(*request.Body.AssignmentVersion)
	}
	profileCapabilityVersions := []int{}
	if request.Body.ProfileCapabilityVersions != nil {
		for _, version := range *request.Body.ProfileCapabilityVersions {
			profileCapabilityVersions = append(profileCapabilityVersions, int(version))
		}
	}
	if err := handler.observations.Heartbeat(
		ctx,
		principal.ServerID(),
		principal.ComputerID(),
		appcomputercontrol.HeartbeatRequest{
			ID:                        request.Body.HeartbeatId.String(),
			DaemonVersion:             request.Body.DaemonVersion,
			DaemonBuildID:             request.Body.DaemonBuildId,
			AssignmentEpoch:           request.Body.AssignmentEpoch.String(),
			AssignmentRevision:        request.Body.AssignmentRevision,
			AssignmentVersion:         assignmentVersion,
			ProfileCapabilityVersions: profileCapabilityVersions,
			TATState:                  string(request.Body.TatState),
			ReconcileState:            string(request.Body.Reconcile.State),
			ReconcileErrorCode:        request.Body.Reconcile.ErrorCode,
			Agents:                    agents,
		},
	); err != nil {
		return nil, err
	}
	return openapi.SendComputerHeartbeat204Response{}, nil
}

// CreateComputerSession exchanges a current long-lived Computer credential
// for a short-lived bearer token. OpenAPI validation enforces assignment
// protocol version 1 before this method runs.
func (handler *ComputerControlHandler) CreateComputerSession(
	ctx context.Context,
	_ openapi.CreateComputerSessionRequestObject,
) (openapi.CreateComputerSessionResponseObject, error) {
	principal, ok := CurrentComputerPrincipal(ctx)
	if !ok {
		return nil, apperror.New(
			"computer_credential_invalid",
			"Computer credential 无效",
			nil,
		)
	}
	session, err := handler.sessions.CreateSession(
		ctx,
		principal.ServerID(),
		principal.ComputerID(),
		principal.CredentialVersion(),
	)
	if err != nil {
		return nil, err
	}
	serverID, err := uuid.Parse(session.Computer.ServerID)
	if err != nil || serverID == uuid.Nil {
		return nil, invalidComputerControlData(err)
	}
	computerID, err := uuid.Parse(session.Computer.ComputerID)
	if err != nil || computerID == uuid.Nil {
		return nil, invalidComputerControlData(err)
	}
	epoch, err := uuid.Parse(session.Computer.AssignmentEpoch)
	if err != nil || epoch == uuid.Nil {
		return nil, invalidComputerControlData(err)
	}
	versions := make(
		[]openapi.ComputerSessionAssignmentVersions,
		0,
		len(session.AssignmentVersions),
	)
	for _, value := range session.AssignmentVersions {
		version := openapi.ComputerSessionAssignmentVersions(value)
		if !version.Valid() {
			return nil, invalidComputerControlData(nil)
		}
		versions = append(versions, version)
	}
	accessToken := session.AccessToken
	return openapi.CreateComputerSession201JSONResponse{
		Body: openapi.ComputerSession{
			AccessToken:        &accessToken,
			ExpiresAt:          session.ExpiresAt.UTC(),
			AssignmentVersions: versions,
			Computer: openapi.ComputerSessionIdentity{
				Id:                 computerID,
				ServerId:           serverID,
				CredentialVersion:  int64(session.Computer.CredentialVersion),
				AssignmentEpoch:    epoch,
				AssignmentRevision: session.Computer.AssignmentRevision,
			},
		},
		Headers: openapi.CreateComputerSession201ResponseHeaders{
			CacheControl: "no-store",
			Pragma:       "no-cache",
		},
	}, nil
}

// GetComputerAssignments returns either a complete, hash-fenced snapshot or
// an explicit 204 carrying the current revision.
func (handler *ComputerControlHandler) GetComputerAssignments(
	ctx context.Context,
	request openapi.GetComputerAssignmentsRequestObject,
) (openapi.GetComputerAssignmentsResponseObject, error) {
	principal, ok := CurrentComputerPrincipal(ctx)
	if !ok {
		return nil, apperror.New(
			"computer_credential_invalid",
			"Computer credential 无效",
			nil,
		)
	}
	query := appcomputercontrol.AssignmentQuery{
		SchemaVersion: 1,
		SinceRevision: request.Params.SinceRevision,
		WaitSeconds:   25,
	}
	if request.Params.SinceEpoch != nil {
		query.SinceEpoch = request.Params.SinceEpoch.String()
	}
	if request.Params.ForceFull != nil {
		query.ForceFull = *request.Params.ForceFull
	}
	if request.Params.WaitSeconds != nil {
		query.WaitSeconds = *request.Params.WaitSeconds
	}
	result, err := handler.assignments.Get(
		ctx,
		principal.ServerID(),
		principal.ComputerID(),
		query,
	)
	if err != nil {
		return nil, err
	}
	if result.NoChange {
		return openapi.GetComputerAssignments204Response{
			Headers: openapi.GetComputerAssignments204ResponseHeaders{
				XAssignmentRevision: result.Revision,
			},
		}, nil
	}
	if result.Snapshot == nil {
		return nil, invalidComputerControlData(nil)
	}
	body, err := assignmentSnapshotDTO(*result.Snapshot)
	if err != nil {
		return nil, err
	}
	return openapi.GetComputerAssignments200JSONResponse(body), nil
}

func (handler *ComputerControlHandler) GetComputerAssignmentsV2(
	ctx context.Context,
	request openapi.GetComputerAssignmentsV2RequestObject,
) (openapi.GetComputerAssignmentsV2ResponseObject, error) {
	principal, ok := CurrentComputerPrincipal(ctx)
	if !ok {
		return nil, apperror.New(
			"computer_credential_invalid",
			"Computer credential 无效",
			nil,
		)
	}
	query := appcomputercontrol.AssignmentQuery{
		SchemaVersion: 2,
		SinceRevision: request.Params.SinceRevision,
		WaitSeconds:   25,
	}
	if request.Params.SinceEpoch != nil {
		query.SinceEpoch = request.Params.SinceEpoch.String()
	}
	if request.Params.ForceFull != nil {
		query.ForceFull = *request.Params.ForceFull
	}
	if request.Params.WaitSeconds != nil {
		query.WaitSeconds = *request.Params.WaitSeconds
	}
	result, err := handler.assignments.Get(
		ctx,
		principal.ServerID(),
		principal.ComputerID(),
		query,
	)
	if err != nil {
		return nil, err
	}
	if result.NoChange {
		return openapi.GetComputerAssignmentsV2204Response{
			Headers: openapi.GetComputerAssignmentsV2204ResponseHeaders{
				XAssignmentRevision: result.Revision,
			},
		}, nil
	}
	if result.Snapshot == nil {
		return nil, invalidComputerControlData(nil)
	}
	body, err := assignmentSnapshotV2DTO(*result.Snapshot)
	if err != nil {
		return nil, err
	}
	return openapi.GetComputerAssignmentsV2200JSONResponse(body), nil
}

func (handler *ComputerControlHandler) PutComputerAgentProfileCapabilityResult(
	ctx context.Context,
	request openapi.PutComputerAgentProfileCapabilityResultRequestObject,
) (openapi.PutComputerAgentProfileCapabilityResultResponseObject, error) {
	principal, ok := CurrentComputerPrincipal(ctx)
	if !ok {
		return nil, apperror.New(
			"computer_credential_invalid",
			"Computer credential 无效",
			nil,
		)
	}
	if handler.profileCapabilities == nil || request.Body == nil {
		return nil, apperror.New(
			"internal_error",
			"Profile capability result service 未配置",
			nil,
		)
	}
	raw, err := json.Marshal(request.Body)
	if err != nil {
		return nil, apperror.New("invalid_request", "Profile capability result 无效", err)
	}
	errorCode := ""
	if request.Body.ErrorCode != nil {
		errorCode = string(*request.Body.ErrorCode)
	}
	result, err := handler.profileCapabilities.CompleteProfileCapabilities(
		ctx,
		appagent.ProfileCapabilityResultCommand{
			ServerID: principal.ServerID(), ComputerID: principal.ComputerID(),
			AgentID: request.AgentId.String(), OperationID: request.OperationId.String(),
			ContextGeneration:   request.Body.ContextGeneration,
			AuthorityContextKey: string(request.Body.AuthorityContextKey),
			Succeeded:           string(request.Body.Status) == "succeeded",
			ErrorCode:           errorCode, ResultJSON: raw, ResultHash: sha256.Sum256(raw),
			CompletedAt: request.Body.ObservedAt.UTC(),
		},
	)
	if err != nil {
		return nil, err
	}
	reason := openapi.ComputerProfileCapabilitySubmissionResultReason(result.Reason)
	if !reason.Valid() {
		return nil, invalidComputerControlData(nil)
	}
	return openapi.PutComputerAgentProfileCapabilityResult200JSONResponse{
		Accepted: result.Accepted,
		Reason:   reason,
	}, nil
}

func (handler *ComputerControlHandler) PutComputerAgentProfileCapabilityInvalidation(
	ctx context.Context,
	request openapi.PutComputerAgentProfileCapabilityInvalidationRequestObject,
) (openapi.PutComputerAgentProfileCapabilityInvalidationResponseObject, error) {
	principal, ok := CurrentComputerPrincipal(ctx)
	if !ok {
		return nil, apperror.New(
			"computer_credential_invalid", "Computer credential 无效", nil,
		)
	}
	if handler.profileCapabilities == nil || request.Body == nil {
		return nil, apperror.New(
			"internal_error", "Profile capability invalidation service 未配置", nil,
		)
	}
	result, err := handler.profileCapabilities.InvalidateProfileCapabilities(
		ctx,
		appagent.ProfileCapabilityInvalidationCommand{
			ServerID: principal.ServerID(), ComputerID: principal.ComputerID(),
			AgentID: request.AgentId.String(), EventID: request.EventId.String(),
			ContextGeneration:        request.Body.ContextGeneration,
			AuthorityContextKey:      string(request.Body.AuthorityContextKey),
			RuntimeContextGeneration: request.Body.RuntimeContextGeneration,
			EventSequence:            request.Body.EventSequence,
			Reason:                   string(request.Body.Reason),
			ObservedAt:               request.Body.ObservedAt.UTC(),
		},
	)
	if err != nil {
		return nil, err
	}
	reason := openapi.ComputerProfileCapabilitySubmissionResultReason(result.Reason)
	if !reason.Valid() {
		return nil, invalidComputerControlData(nil)
	}
	return openapi.PutComputerAgentProfileCapabilityInvalidation200JSONResponse{
		Accepted: result.Accepted, Reason: reason,
	}, nil
}

// NewComputerControlRoutes registers only operations implemented by the
// daemon-facing vertical slice.
func NewComputerControlRoutes(
	sessions computerControlSessionService,
	credentials computerCredentialRotationService,
	assignments computerAssignmentService,
	launches computerAgentLaunchService,
	observations computerObservationService,
	encoder *ErrorEncoder,
	profileCapabilities ...computerProfileCapabilityService,
) (http.Handler, error) {
	if encoder == nil {
		return nil, ErrValidatorEncoderRequired
	}
	handler, err := NewComputerControlHandler(
		sessions, credentials, assignments, launches, observations,
		profileCapabilities...,
	)
	if err != nil {
		return nil, err
	}
	strict := openapi.NewStrictHandlerWithOptions(
		handler,
		nil,
		StrictServerOptions(encoder),
	)
	wrapper := &openapi.ServerInterfaceWrapper{
		Handler:          strict,
		ErrorHandlerFunc: StdHTTPErrorHandler(encoder),
	}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/computer/session", wrapper.CreateComputerSession)
	mux.HandleFunc(
		"POST /v1/computer/credential:rotate",
		wrapper.RotateComputerCredential,
	)
	mux.HandleFunc("GET /v1/computer/assignments", wrapper.GetComputerAssignments)
	mux.HandleFunc("GET /v1/computer/assignments-v2", wrapper.GetComputerAssignmentsV2)
	mux.HandleFunc(
		"PUT /v1/computer/agents/{agentId}/profile-capability-results/{operationId}",
		wrapper.PutComputerAgentProfileCapabilityResult,
	)
	mux.HandleFunc(
		"PUT /v1/computer/agents/{agentId}/profile-capability-invalidations/{eventId}",
		wrapper.PutComputerAgentProfileCapabilityInvalidation,
	)
	mux.HandleFunc(
		"POST /v1/computer/agents/{agentId}/launches",
		wrapper.CreateComputerAgentLaunch,
	)
	mux.HandleFunc(
		"POST /v1/computer/agents/{agentId}/launches/{launchId}/session",
		wrapper.RefreshComputerAgentSession,
	)
	mux.HandleFunc(
		"PUT /v1/computer/agents/{agentId}/observations/{observationId}",
		wrapper.PutComputerAgentObservation,
	)
	mux.HandleFunc("POST /v1/computer/heartbeat", strict.SendComputerHeartbeat)
	return mux, nil
}

func agentLaunchDTO(
	value appcomputercontrol.AgentLaunch,
) (openapi.ComputerAgentLaunch, error) {
	launchID, err := uuid.Parse(value.Fence.LaunchID)
	if err != nil || launchID == uuid.Nil {
		return openapi.ComputerAgentLaunch{}, invalidComputerControlData(err)
	}
	epoch, err := uuid.Parse(value.Fence.AssignmentEpoch)
	if err != nil || epoch == uuid.Nil {
		return openapi.ComputerAgentLaunch{}, invalidComputerControlData(err)
	}
	session, err := agentLaunchSessionDTO(value.Runtime)
	if err != nil {
		return openapi.ComputerAgentLaunch{}, err
	}
	return openapi.ComputerAgentLaunch{
		Launch: openapi.ComputerAgentLaunchFence{
			LaunchId: launchID, AssignmentEpoch: epoch,
			ConfigGeneration:  value.Fence.ConfigGeneration,
			CredentialVersion: int64(value.Fence.CredentialVersion),
			Attempt:           value.Fence.Attempt, IssuedAt: value.Fence.IssuedAt.UTC(),
		},
		Session: session,
	}, nil
}

func agentLaunchSessionDTO(
	value appruntimesession.Session,
) (openapi.ComputerAgentLaunchSession, error) {
	agent, err := runtimeIdentityDTO(value.Agent)
	if err != nil {
		return openapi.ComputerAgentLaunchSession{}, err
	}
	accessToken := value.AccessToken
	userSig := value.IM.UserSig
	return openapi.ComputerAgentLaunchSession{
		AccessToken: &accessToken,
		ExpiresAt:   value.ExpiresAt.UTC(),
		Agent:       agent,
		Im: openapi.ImSession{
			SdkAppId: value.IM.SDKAppID, UserId: value.IM.UserID,
			UserSig: &userSig, ExpiresAt: value.IM.ExpiresAt.UTC(),
		},
	}, nil
}

func observationResultDTO(
	value computercontrolport.ObservationResult,
) (openapi.ComputerObservationResult, error) {
	reason := openapi.ComputerObservationResultReason(value.Reason)
	if !reason.Valid() || value.CurrentAttempt < 0 || value.CurrentSequence < 0 {
		return openapi.ComputerObservationResult{}, invalidComputerControlData(nil)
	}
	var launchID *openapi.NullableId
	if value.CurrentLaunchID != nil {
		parsed, err := uuid.Parse(*value.CurrentLaunchID)
		if err != nil || parsed == uuid.Nil {
			return openapi.ComputerObservationResult{}, invalidComputerControlData(err)
		}
		launchID = &parsed
	}
	return openapi.ComputerObservationResult{
		Accepted: value.Accepted,
		Reason:   reason,
		Current: openapi.ComputerObservationCurrent{
			LaunchId: launchID,
			Attempt:  value.CurrentAttempt,
			Sequence: value.CurrentSequence,
		},
	}, nil
}

func assignmentSnapshotDTO(
	value appcomputercontrol.AssignmentSnapshot,
) (openapi.ComputerAssignmentSnapshot, error) {
	computerID, err := uuid.Parse(value.ComputerID)
	if err != nil || computerID == uuid.Nil {
		return openapi.ComputerAssignmentSnapshot{}, invalidComputerControlData(err)
	}
	epoch, err := uuid.Parse(value.Epoch)
	if err != nil || epoch == uuid.Nil {
		return openapi.ComputerAssignmentSnapshot{}, invalidComputerControlData(err)
	}
	schemaVersion := openapi.ComputerAssignmentSnapshotSchemaVersion(value.SchemaVersion)
	if !schemaVersion.Valid() || value.Revision < 1 || value.SnapshotHash == "" {
		return openapi.ComputerAssignmentSnapshot{}, invalidComputerControlData(nil)
	}
	agents := make([]openapi.ComputerAssignment, 0, len(value.Agents))
	for _, item := range value.Agents {
		agentID, err := uuid.Parse(item.AgentID)
		if err != nil || agentID == uuid.Nil {
			return openapi.ComputerAssignmentSnapshot{}, invalidComputerControlData(err)
		}
		serverID, err := uuid.Parse(item.ServerID)
		if err != nil || serverID == uuid.Nil {
			return openapi.ComputerAssignmentSnapshot{}, invalidComputerControlData(err)
		}
		desired := openapi.ComputerAssignmentDesiredState(item.DesiredState)
		replyPolicy := openapi.ComputerAssignmentReplyPolicy(item.ReplyPolicy)
		runtimeKind := openapi.RuntimeConfigKind(item.RuntimeKind)
		if !desired.Valid() || !replyPolicy.Valid() || !runtimeKind.Valid() {
			return openapi.ComputerAssignmentSnapshot{}, invalidComputerControlData(nil)
		}
		assignment := openapi.ComputerAssignment{
			AgentId:           agentID,
			ServerId:          serverID,
			DesiredState:      desired,
			ConfigGeneration:  item.ConfigGeneration,
			CredentialVersion: item.CredentialVersion,
			ReplyPolicy:       replyPolicy,
			Runtime: openapi.RuntimeConfig{
				Kind: runtimeKind, Model: item.RuntimeModel,
			},
		}
		if item.CurrentLaunch != nil {
			launchID, err := uuid.Parse(item.CurrentLaunch.LaunchID)
			if err != nil || launchID == uuid.Nil {
				return openapi.ComputerAssignmentSnapshot{}, invalidComputerControlData(err)
			}
			launchEpoch, err := uuid.Parse(item.CurrentLaunch.AssignmentEpoch)
			if err != nil || launchEpoch == uuid.Nil {
				return openapi.ComputerAssignmentSnapshot{}, invalidComputerControlData(err)
			}
			assignment.CurrentLaunch = &openapi.ComputerAssignmentLaunchFence{
				LaunchId: launchID, AssignmentEpoch: launchEpoch,
				ConfigGeneration:  item.CurrentLaunch.ConfigGeneration,
				CredentialVersion: int64(item.CurrentLaunch.CredentialVersion),
				Attempt:           item.CurrentLaunch.Attempt,
			}
		}
		agents = append(agents, assignment)
	}
	return openapi.ComputerAssignmentSnapshot{
		SchemaVersion: schemaVersion,
		ComputerId:    computerID,
		Epoch:         epoch,
		Revision:      value.Revision,
		SnapshotHash:  value.SnapshotHash,
		Agents:        agents,
	}, nil
}

func assignmentSnapshotV2DTO(
	value appcomputercontrol.AssignmentSnapshot,
) (openapi.ComputerAssignmentSnapshotV2, error) {
	baseValue := value
	baseValue.SchemaVersion = 1
	base, err := assignmentSnapshotDTO(baseValue)
	if err != nil {
		return openapi.ComputerAssignmentSnapshotV2{}, err
	}
	agents := make([]openapi.ComputerAssignmentV2, 0, len(base.Agents))
	for index, item := range base.Agents {
		desired := openapi.ComputerAssignmentV2DesiredState(item.DesiredState)
		replyPolicy := openapi.ComputerAssignmentV2ReplyPolicy(item.ReplyPolicy)
		if !desired.Valid() || !replyPolicy.Valid() {
			return openapi.ComputerAssignmentSnapshotV2{}, invalidComputerControlData(nil)
		}
		assignment := openapi.ComputerAssignmentV2{
			AgentId:           item.AgentId,
			ServerId:          item.ServerId,
			DesiredState:      desired,
			ConfigGeneration:  item.ConfigGeneration,
			CredentialVersion: item.CredentialVersion,
			CurrentLaunch:     item.CurrentLaunch,
			Runtime:           item.Runtime,
			ReplyPolicy:       replyPolicy,
		}
		refresh := value.Agents[index].ProfileCapabilityRefresh
		if refresh != nil {
			refreshID, err := uuid.Parse(refresh.RefreshID)
			if err != nil || refreshID == uuid.Nil {
				return openapi.ComputerAssignmentSnapshotV2{}, invalidComputerControlData(err)
			}
			runtimeKind := openapi.ComputerProfileCapabilityRefreshRuntimeKind(
				refresh.RuntimeKind,
			)
			if !runtimeKind.Valid() {
				return openapi.ComputerAssignmentSnapshotV2{}, invalidComputerControlData(nil)
			}
			assignment.ProfileCapabilityRefresh = &openapi.ComputerProfileCapabilityRefresh{
				SchemaVersion:     openapi.ComputerProfileCapabilityRefreshSchemaVersionN1,
				RefreshId:         refreshID,
				ContextGeneration: refresh.ContextGeneration,
				AuthorityContextKey: openapi.ProfileCapabilityAuthorityContextKey(
					refresh.AuthorityContextKey,
				),
				RuntimeKind:           runtimeKind,
				InvalidationWatermark: refresh.InvalidationWatermark,
				ForceReload:           refresh.ForceReload,
				RequestedAt:           refresh.RequestedAt.UTC(),
			}
		}
		agents = append(agents, assignment)
	}
	return openapi.ComputerAssignmentSnapshotV2{
		SchemaVersion: openapi.ComputerAssignmentSnapshotV2SchemaVersionN2,
		ComputerId:    base.ComputerId,
		Epoch:         base.Epoch,
		Revision:      base.Revision,
		SnapshotHash:  base.SnapshotHash,
		Agents:        agents,
	}, nil
}

func invalidComputerControlData(err error) error {
	return apperror.New(
		"internal_error",
		"Computer 控制面数据无效",
		err,
	)
}
