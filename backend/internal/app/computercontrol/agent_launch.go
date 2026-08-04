package computercontrol

import (
	"context"
	"errors"
	"math"

	appruntimesession "chatserver/internal/app/runtimesession"
	"chatserver/internal/apperror"
	clockport "chatserver/internal/ports/clock"
	computercontrolport "chatserver/internal/ports/computercontrol"
)

type runtimeSessionIssuer interface {
	CreateForLaunch(
		context.Context,
		string,
		string,
		string,
		appruntimesession.LaunchFence,
	) (appruntimesession.Session, error)
}

type AgentLaunchRequest struct {
	ComputerCredentialVersion uint64
	LaunchID                  string
	PredecessorLaunchID       *string
	AssignmentEpoch           string
	AssignmentRevision        int64
	ConfigGeneration          int64
	CredentialVersion         uint64
}

type AgentSessionRefreshRequest struct {
	AssignmentEpoch   string
	ConfigGeneration  int64
	CredentialVersion uint64
	Attempt           int64
}

type AgentLaunch struct {
	Created bool
	Fence   computercontrolport.AgentLaunchFence
	Runtime appruntimesession.Session
}

type AgentLaunchService struct {
	repository computercontrolport.AgentLaunchRepository
	runtimes   runtimeSessionIssuer
	clock      clockport.Clock
}

func NewAgentLaunchService(
	repository computercontrolport.AgentLaunchRepository,
	runtimes runtimeSessionIssuer,
	clock clockport.Clock,
) (*AgentLaunchService, error) {
	if repository == nil || runtimes == nil || clock == nil {
		return nil, errors.New("Computer Agent Launch 服务配置无效")
	}
	return &AgentLaunchService{repository: repository, runtimes: runtimes, clock: clock}, nil
}

func (service *AgentLaunchService) Create(
	ctx context.Context,
	serverID string,
	computerID string,
	agentID string,
	request AgentLaunchRequest,
) (AgentLaunch, error) {
	if !validV7(serverID) || !validV7(computerID) || !validV7(agentID) ||
		!validV7(request.LaunchID) || !validV7(request.AssignmentEpoch) ||
		(request.PredecessorLaunchID != nil && !validV7(*request.PredecessorLaunchID)) ||
		request.ComputerCredentialVersion == 0 ||
		request.ComputerCredentialVersion > math.MaxInt64 ||
		request.AssignmentRevision < 1 || request.ConfigGeneration < 1 ||
		request.CredentialVersion == 0 || request.CredentialVersion > math.MaxInt64 {
		return AgentLaunch{}, staleAssignment(nil)
	}
	command := computercontrolport.AgentLaunchRequest{
		ServerID:                  serverID,
		ComputerID:                computerID,
		ComputerCredentialVersion: request.ComputerCredentialVersion,
		AgentID:                   agentID,
		LaunchID:                  request.LaunchID,
		PredecessorLaunchID:       request.PredecessorLaunchID,
		AssignmentEpoch:           request.AssignmentEpoch,
		AssignmentRevision:        request.AssignmentRevision,
		ConfigGeneration:          request.ConfigGeneration,
		CredentialVersion:         request.CredentialVersion,
		RequestedAt:               service.clock.Now().UTC(),
	}
	allocation, err := service.allocate(ctx, command)
	if err != nil {
		return AgentLaunch{}, err
	}
	runtime, err := service.mintSession(
		ctx, serverID, computerID, agentID, allocation.Fence,
	)
	if err != nil {
		return AgentLaunch{}, err
	}
	confirmed, err := service.allocate(ctx, command)
	if err != nil {
		return AgentLaunch{}, err
	}
	if allocation.Fence != confirmed.Fence {
		return AgentLaunch{}, staleAssignment(nil)
	}
	return AgentLaunch{
		Created: allocation.Created,
		Fence:   allocation.Fence,
		Runtime: runtime,
	}, nil
}

func (service *AgentLaunchService) allocate(
	ctx context.Context,
	request computercontrolport.AgentLaunchRequest,
) (computercontrolport.AgentLaunchAllocation, error) {
	result, err := service.repository.AllocateAgentLaunch(ctx, request)
	switch {
	case errors.Is(err, computercontrolport.ErrComputerCredentialNotActive):
		return computercontrolport.AgentLaunchAllocation{}, apperror.New(
			"computer_credential_not_active",
			"只有 active Computer credential 可以分配 Agent Launch",
			err,
		)
	case errors.Is(err, computercontrolport.ErrAssignmentStale):
		return computercontrolport.AgentLaunchAllocation{}, staleAssignment(err)
	case errors.Is(err, computercontrolport.ErrLaunchPredecessorMismatch):
		return computercontrolport.AgentLaunchAllocation{}, apperror.New(
			"predecessor_mismatch", "Agent Launch 前序已变化", err,
		)
	case errors.Is(err, computercontrolport.ErrLaunchConflict):
		return computercontrolport.AgentLaunchAllocation{}, apperror.New(
			"launch_id_conflict", "Agent Launch ID 已绑定其他 Fence", err,
		)
	case err != nil:
		return computercontrolport.AgentLaunchAllocation{}, apperror.New(
			"internal_error", "暂时无法分配 Agent Launch", err,
		)
	default:
		return result, nil
	}
}

func (service *AgentLaunchService) Refresh(
	ctx context.Context,
	serverID string,
	computerID string,
	agentID string,
	launchID string,
	request AgentSessionRefreshRequest,
) (appruntimesession.Session, error) {
	if !validV7(serverID) || !validV7(computerID) || !validV7(agentID) ||
		!validV7(launchID) || !validV7(request.AssignmentEpoch) ||
		request.ConfigGeneration < 1 || request.CredentialVersion == 0 ||
		request.CredentialVersion > math.MaxInt64 || request.Attempt < 1 {
		return appruntimesession.Session{}, staleLaunch(nil)
	}
	command := computercontrolport.AgentLaunchSessionRequest{
		ServerID: serverID, ComputerID: computerID, AgentID: agentID,
		LaunchID: launchID, AssignmentEpoch: request.AssignmentEpoch,
		ConfigGeneration:  request.ConfigGeneration,
		CredentialVersion: request.CredentialVersion,
		Attempt:           request.Attempt,
	}
	fence, err := service.validateCurrentLaunch(ctx, command)
	if err != nil {
		return appruntimesession.Session{}, err
	}
	runtime, err := service.mintSession(
		ctx, serverID, computerID, agentID, fence,
	)
	if err != nil {
		return appruntimesession.Session{}, err
	}
	if _, err := service.validateCurrentLaunch(ctx, command); err != nil {
		return appruntimesession.Session{}, err
	}
	return runtime, nil
}

func (service *AgentLaunchService) mintSession(
	ctx context.Context,
	serverID string,
	computerID string,
	agentID string,
	fence computercontrolport.AgentLaunchFence,
) (appruntimesession.Session, error) {
	result, err := service.runtimes.CreateForLaunch(
		ctx, serverID, computerID, agentID,
		appruntimesession.LaunchFence{
			LaunchID: fence.LaunchID, AssignmentEpoch: fence.AssignmentEpoch,
			ConfigGeneration:  fence.ConfigGeneration,
			CredentialVersion: fence.CredentialVersion, Attempt: fence.Attempt,
		},
	)
	if err != nil {
		return appruntimesession.Session{}, apperror.New(
			"session_temporarily_unavailable",
			"暂时无法签发 Agent Session；请使用同一 launchId 重试",
			err,
		)
	}
	return result, nil
}

func (service *AgentLaunchService) validateCurrentLaunch(
	ctx context.Context,
	request computercontrolport.AgentLaunchSessionRequest,
) (computercontrolport.AgentLaunchFence, error) {
	result, err := service.repository.ValidateAgentLaunch(ctx, request)
	switch {
	case errors.Is(err, computercontrolport.ErrAssignmentStale),
		errors.Is(err, computercontrolport.ErrLaunchConflict),
		errors.Is(err, computercontrolport.ErrLaunchPredecessorMismatch):
		return computercontrolport.AgentLaunchFence{}, staleLaunch(err)
	case err != nil:
		return computercontrolport.AgentLaunchFence{}, err
	default:
		return result, nil
	}
}

func staleLaunch(err error) error {
	return apperror.New("stale_launch", "Agent Launch 已失效", err)
}

func staleAssignment(err error) error {
	return apperror.New("assignment_stale", "Agent Assignment 已变化", err)
}
