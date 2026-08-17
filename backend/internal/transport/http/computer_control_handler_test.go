package httptransport

import (
	"context"
	"testing"
	"time"

	"chatserver/internal/api/openapi"
	appagent "chatserver/internal/app/agentmanagement"
	appcomputercontrol "chatserver/internal/app/computercontrol"
	appcomputer "chatserver/internal/app/computermanagement"
	appruntimesession "chatserver/internal/app/runtimesession"
	agentport "chatserver/internal/ports/agent"
	authnport "chatserver/internal/ports/authn"
	computercontrolport "chatserver/internal/ports/computercontrol"

	"github.com/google/uuid"
)

type fakeComputerControlSessionService struct {
	args    []any
	session appcomputercontrol.Session
	err     error
}

type fakeComputerAssignmentService struct {
	args   []any
	result appcomputercontrol.AssignmentResult
	err    error
}

type fakeComputerCredentialRotationService struct {
	args       []any
	credential appcomputer.RuntimeCredential
	err        error
}

func (service *fakeComputerCredentialRotationService) Rotate(
	_ context.Context,
	serverID string,
	computerID string,
	version uint64,
	idempotencyKey string,
) (appcomputer.RuntimeCredential, error) {
	service.args = []any{serverID, computerID, version, idempotencyKey}
	return service.credential, service.err
}

type fakeComputerAgentLaunchService struct {
	args          []any
	result        appcomputercontrol.AgentLaunch
	err           error
	refreshArgs   []any
	refreshResult appruntimesession.Session
	refreshErr    error
}

func (service *fakeComputerAgentLaunchService) Refresh(
	_ context.Context,
	serverID string,
	computerID string,
	agentID string,
	launchID string,
	request appcomputercontrol.AgentSessionRefreshRequest,
) (appruntimesession.Session, error) {
	service.refreshArgs = []any{serverID, computerID, agentID, launchID, request}
	return service.refreshResult, service.refreshErr
}

func (service *fakeComputerAgentLaunchService) Create(
	_ context.Context,
	serverID string,
	computerID string,
	agentID string,
	request appcomputercontrol.AgentLaunchRequest,
) (appcomputercontrol.AgentLaunch, error) {
	service.args = []any{serverID, computerID, agentID, request}
	return service.result, service.err
}

type fakeComputerObservationService struct {
	putArgs       []any
	heartbeatArgs []any
	result        computercontrolport.ObservationResult
	err           error
}

type fakeComputerProfileCapabilityService struct {
	invalidation appagent.ProfileCapabilityInvalidationCommand
}

func (*fakeComputerProfileCapabilityService) CompleteProfileCapabilities(
	context.Context,
	appagent.ProfileCapabilityResultCommand,
) (agentport.ProfileCapabilitySubmissionResult, error) {
	return agentport.ProfileCapabilitySubmissionResult{}, nil
}

func (service *fakeComputerProfileCapabilityService) InvalidateProfileCapabilities(
	_ context.Context,
	command appagent.ProfileCapabilityInvalidationCommand,
) (agentport.ProfileCapabilitySubmissionResult, error) {
	service.invalidation = command
	return agentport.ProfileCapabilitySubmissionResult{
		Accepted: true, Reason: "accepted",
	}, nil
}

func (service *fakeComputerObservationService) Put(
	_ context.Context,
	serverID string,
	computerID string,
	agentID string,
	observationID string,
	request appcomputercontrol.ObservationRequest,
) (computercontrolport.ObservationResult, error) {
	service.putArgs = []any{serverID, computerID, agentID, observationID, request}
	return service.result, service.err
}

func (service *fakeComputerObservationService) Heartbeat(
	_ context.Context,
	serverID string,
	computerID string,
	request appcomputercontrol.HeartbeatRequest,
) error {
	service.heartbeatArgs = []any{serverID, computerID, request}
	return service.err
}

func (service *fakeComputerAssignmentService) Get(
	_ context.Context,
	serverID string,
	computerID string,
	query appcomputercontrol.AssignmentQuery,
) (appcomputercontrol.AssignmentResult, error) {
	service.args = []any{serverID, computerID, query}
	return service.result, service.err
}

func (service *fakeComputerControlSessionService) CreateSession(
	_ context.Context,
	serverID string,
	computerID string,
	version uint64,
) (appcomputercontrol.Session, error) {
	service.args = []any{serverID, computerID, version}
	return service.session, service.err
}

func TestComputerControlHandlerCreatesShortSession(t *testing.T) {
	expiresAt := time.Date(2026, 8, 1, 18, 15, 0, 0, time.UTC)
	service := &fakeComputerControlSessionService{session: appcomputercontrol.Session{
		AccessToken: "short-computer-token",
		ExpiresAt:   expiresAt,
		Computer: computercontrolport.SessionIdentity{
			ServerID:           hookTestServerID,
			ComputerID:         hookTestComputerID,
			CredentialVersion:  4,
			AssignmentEpoch:    hookTestAgentID,
			AssignmentRevision: 9,
		},
		AssignmentVersions: []int{1},
	}}
	handler, err := NewComputerControlHandler(
		service,
		&fakeComputerCredentialRotationService{},
		&fakeComputerAssignmentService{},
		&fakeComputerAgentLaunchService{},
		&fakeComputerObservationService{},
	)
	if err != nil {
		t.Fatal(err)
	}
	response, err := handler.CreateComputerSession(
		currentComputerContext(t, 4),
		openapi.CreateComputerSessionRequestObject{Params: openapi.CreateComputerSessionParams{
			XVelaAssignmentVersion: openapi.CreateComputerSessionParamsXVelaAssignmentVersionN1,
		}},
	)
	if err != nil {
		t.Fatal(err)
	}
	created, ok := response.(openapi.CreateComputerSession201JSONResponse)
	if !ok || created.Body.AccessToken == nil ||
		*created.Body.AccessToken != "short-computer-token" ||
		!created.Body.ExpiresAt.Equal(expiresAt) ||
		created.Body.Computer.Id.String() != hookTestComputerID ||
		created.Body.Computer.ServerId.String() != hookTestServerID ||
		created.Body.Computer.CredentialVersion != 4 ||
		created.Body.Computer.AssignmentEpoch.String() != hookTestAgentID ||
		created.Body.Computer.AssignmentRevision != 9 ||
		len(created.Body.AssignmentVersions) != 1 ||
		created.Body.AssignmentVersions[0] != 1 ||
		created.Headers.CacheControl != "no-store" || created.Headers.Pragma != "no-cache" {
		t.Fatalf("CreateComputerSession() = %#v", response)
	}
	if len(service.args) != 3 || service.args[0] != hookTestServerID ||
		service.args[1] != hookTestComputerID || service.args[2] != uint64(4) {
		t.Fatalf("CreateSession args = %#v", service.args)
	}
}

func TestComputerControlHandlerRotatesCredential(t *testing.T) {
	expiresAt := time.Date(2027, 8, 1, 18, 0, 0, 0, time.UTC)
	graceExpiresAt := time.Date(2026, 8, 1, 19, 0, 0, 0, time.UTC)
	rotation := &fakeComputerCredentialRotationService{
		credential: appcomputer.RuntimeCredential{
			ID:             "01989c24-7540-7f12-a27b-c83243215dd2",
			Version:        5,
			Secret:         "crc_server.computer.5.secret",
			ExpiresAt:      expiresAt,
			GraceExpiresAt: &graceExpiresAt,
		},
	}
	handler, err := NewComputerControlHandler(
		&fakeComputerControlSessionService{},
		rotation,
		&fakeComputerAssignmentService{},
		&fakeComputerAgentLaunchService{},
		&fakeComputerObservationService{},
	)
	if err != nil {
		t.Fatal(err)
	}
	response, err := handler.RotateComputerCredential(
		currentComputerContext(t, 4),
		openapi.RotateComputerCredentialRequestObject{
			Params: openapi.RotateComputerCredentialParams{
				IdempotencyKey: "computer-rotate-0001",
			},
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	created, ok := response.(openapi.RotateComputerCredential201JSONResponse)
	if !ok || created.Headers.CacheControl != "no-store" ||
		created.Headers.Pragma != "no-cache" ||
		created.Body.Version != 5 || created.Body.Secret == nil ||
		*created.Body.Secret != "crc_server.computer.5.secret" ||
		created.Body.GraceExpiresAt == nil ||
		!created.Body.GraceExpiresAt.Equal(graceExpiresAt) ||
		len(rotation.args) != 4 || rotation.args[0] != hookTestServerID ||
		rotation.args[1] != hookTestComputerID || rotation.args[2] != uint64(4) ||
		rotation.args[3] != "computer-rotate-0001" {
		t.Fatalf("RotateComputerCredential() = %#v args=%#v", response, rotation.args)
	}
}

func TestComputerControlHandlerReturnsAssignmentSnapshotAndNoChange(t *testing.T) {
	agentID := hookTestAgentID
	assignmentService := &fakeComputerAssignmentService{result: appcomputercontrol.AssignmentResult{
		Revision: 9,
		Snapshot: &appcomputercontrol.AssignmentSnapshot{
			SchemaVersion: 1,
			ComputerID:    hookTestComputerID,
			Epoch:         hookTestAgentID,
			Revision:      9,
			SnapshotHash:  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
			Agents: []computercontrolport.Assignment{{
				AgentID:           agentID,
				ServerID:          hookTestServerID,
				DesiredState:      "running",
				ConfigGeneration:  3,
				CredentialVersion: 2,
				RuntimeKind:       "codex",
				ReplyPolicy:       "mention_and_dm",
				CurrentLaunch: &computercontrolport.AssignmentLaunchFence{
					LaunchID:         "01989c24-7540-7f12-a27b-c83243215dda",
					AssignmentEpoch:  hookTestAgentID,
					ConfigGeneration: 3, CredentialVersion: 2, Attempt: 4,
				},
			}},
		},
	}}
	handler, err := NewComputerControlHandler(
		&fakeComputerControlSessionService{},
		&fakeComputerCredentialRotationService{},
		assignmentService,
		&fakeComputerAgentLaunchService{},
		&fakeComputerObservationService{},
	)
	if err != nil {
		t.Fatal(err)
	}
	forceFull := true
	response, err := handler.GetComputerAssignments(
		currentComputerContext(t, 4),
		openapi.GetComputerAssignmentsRequestObject{Params: openapi.GetComputerAssignmentsParams{
			SinceRevision:          0,
			ForceFull:              &forceFull,
			XVelaAssignmentVersion: openapi.GetComputerAssignmentsParamsXVelaAssignmentVersionN1,
		}},
	)
	if err != nil {
		t.Fatal(err)
	}
	fullResponse, ok := response.(openapi.GetComputerAssignments200JSONResponse)
	if !ok {
		t.Fatalf("GetComputerAssignments() = %#v", response)
	}
	full := openapi.ComputerAssignmentSnapshot(fullResponse)
	if full.ComputerId.String() != hookTestComputerID ||
		full.Epoch.String() != hookTestAgentID || full.Revision != 9 ||
		full.SnapshotHash != "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" ||
		len(full.Agents) != 1 || full.Agents[0].AgentId.String() != agentID ||
		full.Agents[0].Runtime.Kind != "codex" || full.Agents[0].CurrentLaunch == nil ||
		full.Agents[0].CurrentLaunch.Attempt != 4 {
		t.Fatalf("GetComputerAssignments() = %#v", response)
	}
	assignmentService.result.Snapshot.SchemaVersion = 2
	v2Result, err := handler.GetComputerAssignmentsV2(
		currentComputerContext(t, 4),
		openapi.GetComputerAssignmentsV2RequestObject{Params: openapi.GetComputerAssignmentsV2Params{
			SinceRevision: 0,
			ForceFull:     &forceFull,
		}},
	)
	if err != nil {
		t.Fatal(err)
	}
	v2Response, ok := v2Result.(openapi.GetComputerAssignmentsV2200JSONResponse)
	if !ok {
		t.Fatalf("GetComputerAssignments(v2) = %#v", v2Result)
	}
	v2 := openapi.ComputerAssignmentSnapshotV2(v2Response)
	if v2.SchemaVersion != openapi.ComputerAssignmentSnapshotV2SchemaVersionN2 ||
		len(v2.Agents) != 1 || v2.Agents[0].ProfileCapabilityRefresh != nil {
		t.Fatalf("GetComputerAssignments(v2) = %#v", v2Result)
	}
	assignmentService.result.Snapshot.SchemaVersion = 1
	assignmentService.result = appcomputercontrol.AssignmentResult{NoChange: true, Revision: 9}
	response, err = handler.GetComputerAssignments(
		currentComputerContext(t, 4),
		openapi.GetComputerAssignmentsRequestObject{Params: openapi.GetComputerAssignmentsParams{
			SinceRevision:          9,
			XVelaAssignmentVersion: openapi.GetComputerAssignmentsParamsXVelaAssignmentVersionN1,
		}},
	)
	if err != nil {
		t.Fatal(err)
	}
	unchanged, ok := response.(openapi.GetComputerAssignments204Response)
	if !ok || unchanged.Headers.XAssignmentRevision != 9 {
		t.Fatalf("no change response = %#v", response)
	}
	query, ok := assignmentService.args[2].(appcomputercontrol.AssignmentQuery)
	if !ok || query.WaitSeconds != 25 {
		t.Fatalf("assignment query = %#v", assignmentService.args)
	}
}

func TestComputerControlHandlerCreatesAgentLaunch(t *testing.T) {
	expiresAt := time.Date(2026, 8, 1, 18, 15, 0, 0, time.UTC)
	imExpiresAt := expiresAt.Add(45 * time.Minute)
	launchID := uuid.MustParse("01989c24-7540-7f12-a27b-c83243215dda")
	epoch := uuid.MustParse(hookTestAgentID)
	launches := &fakeComputerAgentLaunchService{result: appcomputercontrol.AgentLaunch{
		Created: true,
		Fence: computercontrolport.AgentLaunchFence{
			LaunchID: launchID.String(), AssignmentEpoch: epoch.String(),
			ConfigGeneration: 3, CredentialVersion: 2, Attempt: 1,
			IssuedAt: time.Date(2026, 8, 1, 18, 0, 0, 0, time.UTC),
		},
		Runtime: appruntimesession.Session{
			AccessToken: "short-agent-token", ExpiresAt: expiresAt,
			Agent: appruntimesession.Identity{
				ID: hookTestAgentID, ServerID: hookTestServerID,
				UserID: "a_agent", Capabilities: []string{"read", "send"},
				ReplyPolicy: "mention_and_dm", RuntimeKind: "codex",
			},
			IM: appruntimesession.IMSession{
				SDKAppID: 1600000000, UserID: "a_agent",
				UserSig: "short-usersig", ExpiresAt: imExpiresAt,
			},
		},
	}}
	handler, err := NewComputerControlHandler(
		&fakeComputerControlSessionService{},
		&fakeComputerCredentialRotationService{},
		&fakeComputerAssignmentService{},
		launches,
		&fakeComputerObservationService{},
	)
	if err != nil {
		t.Fatal(err)
	}
	response, err := handler.CreateComputerAgentLaunch(
		currentComputerContext(t, 4),
		openapi.CreateComputerAgentLaunchRequestObject{
			AgentId: uuid.MustParse(hookTestAgentID),
			Body: &openapi.ComputerAgentLaunchRequest{
				LaunchId: launchID, AssignmentEpoch: epoch,
				AssignmentRevision: 9, ConfigGeneration: 3,
				CredentialVersion: 2,
			},
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	created, ok := response.(openapi.CreateComputerAgentLaunch201JSONResponse)
	if !ok || created.Headers.CacheControl != "no-store" ||
		created.Headers.Pragma != "no-cache" ||
		created.Body.Launch.LaunchId != launchID ||
		created.Body.Launch.Attempt != 1 ||
		created.Body.Session.AccessToken == nil ||
		*created.Body.Session.AccessToken != "short-agent-token" ||
		created.Body.Session.Im.UserSig == nil ||
		*created.Body.Session.Im.UserSig != "short-usersig" {
		t.Fatalf("CreateComputerAgentLaunch() = %#v", response)
	}
	if len(launches.args) != 4 || launches.args[0] != hookTestServerID ||
		launches.args[1] != hookTestComputerID ||
		launches.args[2] != hookTestAgentID {
		t.Fatalf("launch args = %#v", launches.args)
	}
}

func TestComputerControlHandlerReturnsOKForIdempotentAgentLaunch(t *testing.T) {
	launchID := uuid.MustParse("01989c24-7540-7f12-a27b-c83243215dda")
	epoch := uuid.MustParse(hookTestAgentID)
	launches := &fakeComputerAgentLaunchService{result: appcomputercontrol.AgentLaunch{
		Created: false,
		Fence: computercontrolport.AgentLaunchFence{
			LaunchID: launchID.String(), AssignmentEpoch: epoch.String(),
			ConfigGeneration: 3, CredentialVersion: 2, Attempt: 1,
			IssuedAt: time.Date(2026, 8, 1, 18, 0, 0, 0, time.UTC),
		},
		Runtime: appruntimesession.Session{
			AccessToken: "replacement-session",
			ExpiresAt:   time.Date(2026, 8, 1, 18, 15, 0, 0, time.UTC),
			Agent: appruntimesession.Identity{
				ID: hookTestAgentID, ServerID: hookTestServerID,
				UserID: "a_agent", Capabilities: []string{"read", "send"},
				ReplyPolicy: "mention_and_dm", RuntimeKind: "codex",
			},
			IM: appruntimesession.IMSession{
				SDKAppID: 1600000000, UserID: "a_agent", UserSig: "usersig",
				ExpiresAt: time.Date(2026, 8, 1, 19, 0, 0, 0, time.UTC),
			},
		},
	}}
	handler, err := NewComputerControlHandler(
		&fakeComputerControlSessionService{},
		&fakeComputerCredentialRotationService{},
		&fakeComputerAssignmentService{},
		launches,
		&fakeComputerObservationService{},
	)
	if err != nil {
		t.Fatal(err)
	}
	response, err := handler.CreateComputerAgentLaunch(
		currentComputerContext(t, 4),
		openapi.CreateComputerAgentLaunchRequestObject{
			AgentId: uuid.MustParse(hookTestAgentID),
			Body: &openapi.ComputerAgentLaunchRequest{
				LaunchId: launchID, AssignmentEpoch: epoch,
				AssignmentRevision: 9, ConfigGeneration: 3, CredentialVersion: 2,
			},
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	ok, matched := response.(openapi.CreateComputerAgentLaunch200JSONResponse)
	if !matched || ok.Headers.CacheControl != "no-store" || ok.Headers.Pragma != "no-cache" ||
		ok.Body.Launch.LaunchId != launchID || ok.Body.Session.AccessToken == nil ||
		*ok.Body.Session.AccessToken != "replacement-session" {
		t.Fatalf("CreateComputerAgentLaunch() = %#v", response)
	}
}

func TestComputerControlHandlerRefreshesCurrentAgentLaunchSession(t *testing.T) {
	launchID := uuid.MustParse("01989c24-7540-7f12-a27b-c83243215dda")
	epoch := uuid.MustParse(hookTestAgentID)
	expiresAt := time.Date(2026, 8, 1, 18, 15, 0, 0, time.UTC)
	launches := &fakeComputerAgentLaunchService{refreshResult: appruntimesession.Session{
		AccessToken: "refreshed-agent-token", ExpiresAt: expiresAt,
		Agent: appruntimesession.Identity{
			ID: hookTestAgentID, ServerID: hookTestServerID, UserID: "a_agent",
			Capabilities: []string{"read", "send"}, ReplyPolicy: "mention_and_dm",
			RuntimeKind: "codex",
		},
		IM: appruntimesession.IMSession{
			SDKAppID: 1600000000, UserID: "a_agent", UserSig: "fresh-usersig",
			ExpiresAt: expiresAt.Add(45 * time.Minute),
		},
	}}
	handler, err := NewComputerControlHandler(
		&fakeComputerControlSessionService{},
		&fakeComputerCredentialRotationService{},
		&fakeComputerAssignmentService{},
		launches,
		&fakeComputerObservationService{},
	)
	if err != nil {
		t.Fatal(err)
	}
	response, err := handler.RefreshComputerAgentSession(
		currentComputerContext(t, 4),
		openapi.RefreshComputerAgentSessionRequestObject{
			AgentId: uuid.MustParse(hookTestAgentID), LaunchId: launchID,
			Body: &openapi.ComputerAgentSessionRefreshRequest{
				AssignmentEpoch: epoch, ConfigGeneration: 3,
				CredentialVersion: 2, Attempt: 4,
			},
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	ok, matched := response.(openapi.RefreshComputerAgentSession200JSONResponse)
	if !matched || ok.Headers.CacheControl != "no-store" || ok.Headers.Pragma != "no-cache" ||
		ok.Body.AccessToken == nil || *ok.Body.AccessToken != "refreshed-agent-token" ||
		ok.Body.Im.UserSig == nil || *ok.Body.Im.UserSig != "fresh-usersig" {
		t.Fatalf("RefreshComputerAgentSession() = %#v", response)
	}
	if len(launches.refreshArgs) != 5 || launches.refreshArgs[0] != hookTestServerID ||
		launches.refreshArgs[1] != hookTestComputerID ||
		launches.refreshArgs[2] != hookTestAgentID ||
		launches.refreshArgs[3] != launchID.String() {
		t.Fatalf("Refresh args = %#v", launches.refreshArgs)
	}
}

func TestComputerControlHandlerAcceptsObservationAndHeartbeat(t *testing.T) {
	observationService := &fakeComputerObservationService{result: computercontrolport.ObservationResult{
		Accepted: false, Reason: "stale_launch",
	}}
	handler, err := NewComputerControlHandler(
		&fakeComputerControlSessionService{},
		&fakeComputerCredentialRotationService{},
		&fakeComputerAssignmentService{},
		&fakeComputerAgentLaunchService{},
		observationService,
	)
	if err != nil {
		t.Fatal(err)
	}
	agentUUID := uuid.MustParse(hookTestAgentID)
	observationID := uuid.MustParse("01989c24-7540-7f12-a27b-c83243215dde")
	launchID := uuid.MustParse("01989c24-7540-7f12-a27b-c83243215ddf")
	assignmentRevision := int64(9)
	response, err := handler.PutComputerAgentObservation(
		currentComputerContext(t, 4),
		openapi.PutComputerAgentObservationRequestObject{
			AgentId: agentUUID, ObservationId: observationID,
			Body: &openapi.ComputerAgentObservation{
				AssignmentEpoch: agentUUID, AssignmentRevision: &assignmentRevision,
				ConfigGeneration: 3, CredentialVersion: 2, Attempt: 2, Sequence: 8,
				LaunchId: launchID, State: "running", ImTransportState: "connected",
				ObservedAt: time.Date(2026, 8, 1, 18, 0, 0, 0, time.UTC),
			},
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	stale, ok := response.(openapi.PutComputerAgentObservation200JSONResponse)
	if !ok || stale.Accepted || stale.Reason != openapi.StaleLaunch {
		t.Fatalf("stale observation response = %#v", response)
	}
	heartbeatID := uuid.MustParse("01989c24-7540-7f12-a27b-c83243215dd1")
	assignmentVersion := openapi.ComputerHeartbeatAssignmentVersion(2)
	heartbeatResponse, err := handler.SendComputerHeartbeat(
		currentComputerContext(t, 4),
		openapi.SendComputerHeartbeatRequestObject{Body: &openapi.ComputerHeartbeat{
			HeartbeatId: heartbeatID, DaemonVersion: "1.0.0", DaemonBuildId: "build-test",
			AssignmentEpoch: agentUUID, AssignmentRevision: 9,
			AssignmentVersion:         &assignmentVersion,
			ProfileCapabilityVersions: &[]openapi.ComputerHeartbeatProfileCapabilityVersions{1},
			TatState:                  "online",
			Reconcile:                 openapi.ComputerHeartbeatReconcile{State: "healthy"},
			Agents: []openapi.ComputerHeartbeatAgent{{
				AgentId: agentUUID, AssignmentEpoch: agentUUID,
				ConfigGeneration: 3, CredentialVersion: 2,
				Attempt: 2, LaunchId: launchID,
			}},
		}},
	)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := heartbeatResponse.(openapi.SendComputerHeartbeat204Response); !ok {
		t.Fatalf("heartbeat response = %#v", heartbeatResponse)
	}
	if len(observationService.putArgs) != 5 || len(observationService.heartbeatArgs) != 3 {
		t.Fatalf("observation calls = %#v %#v", observationService.putArgs, observationService.heartbeatArgs)
	}
	heartbeatCommand := observationService.heartbeatArgs[2].(appcomputercontrol.HeartbeatRequest)
	if heartbeatCommand.AssignmentVersion != 2 ||
		len(heartbeatCommand.ProfileCapabilityVersions) != 1 ||
		heartbeatCommand.ProfileCapabilityVersions[0] != 1 {
		t.Fatalf("heartbeat capabilities = %#v", heartbeatCommand)
	}
}

func TestComputerControlHandlerAcceptsProfileCapabilityInvalidation(t *testing.T) {
	capabilities := &fakeComputerProfileCapabilityService{}
	handler, err := NewComputerControlHandler(
		&fakeComputerControlSessionService{},
		&fakeComputerCredentialRotationService{},
		&fakeComputerAssignmentService{},
		&fakeComputerAgentLaunchService{},
		&fakeComputerObservationService{},
		capabilities,
	)
	if err != nil {
		t.Fatal(err)
	}
	eventID := uuid.MustParse("01989c24-7540-7f12-a27b-c83243215dde")
	response, err := handler.PutComputerAgentProfileCapabilityInvalidation(
		currentComputerContext(t, 4),
		openapi.PutComputerAgentProfileCapabilityInvalidationRequestObject{
			AgentId: uuid.MustParse(hookTestAgentID), EventId: eventID,
			Body: &openapi.ComputerAgentProfileCapabilityInvalidation{
				SchemaVersion: 1, ContextGeneration: 3,
				AuthorityContextKey:      "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
				RuntimeContextGeneration: 2, EventSequence: 4,
				Reason:     openapi.ComputerProfileInvalidationRuntimeReportedChange,
				ObservedAt: time.Date(2026, 8, 18, 12, 0, 0, 0, time.UTC),
			},
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	body, ok := response.(openapi.PutComputerAgentProfileCapabilityInvalidation200JSONResponse)
	if !ok || !body.Accepted || body.Reason != openapi.ComputerProfileSubmissionAccepted ||
		capabilities.invalidation.EventID != eventID.String() ||
		capabilities.invalidation.EventSequence != 4 {
		t.Fatalf("invalidation response = %#v command=%#v", response, capabilities.invalidation)
	}
}

func currentComputerContext(t *testing.T, version uint64) context.Context {
	t.Helper()
	principal, err := authnport.NewCurrentComputerPrincipal(
		hookTestServerID,
		hookTestComputerID,
		version,
	)
	if err != nil {
		t.Fatal(err)
	}
	state := &AuthState{}
	if err := state.setPrincipal(principal); err != nil {
		t.Fatal(err)
	}
	return context.WithValue(context.Background(), authStateContextKey{}, state)
}
