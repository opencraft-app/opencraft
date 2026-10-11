package computercontrol

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"math"
	"strings"
	"time"

	"chatserver/internal/apperror"
	clockport "chatserver/internal/ports/clock"
	computercontrolport "chatserver/internal/ports/computercontrol"
)

type ObservationConfig struct {
	MaximumClockSkew time.Duration
}

type ObservationRequest struct {
	AssignmentEpoch    string
	AssignmentRevision int64
	ConfigGeneration   int64
	CredentialVersion  uint64
	Attempt            int64
	Sequence           int64
	LaunchID           string
	State              string
	IMTransportState   string
	ErrorCode          *string
	ObservedAt         time.Time
}

type HeartbeatAgent struct {
	AgentID           string
	AssignmentEpoch   string
	ConfigGeneration  int64
	CredentialVersion uint64
	Attempt           int64
	LaunchID          string
}

type HeartbeatRequest struct {
	ID                        string
	DaemonVersion             string
	DaemonBuildID             string
	AssignmentEpoch           string
	AssignmentRevision        int64
	AssignmentVersion         int
	ProfileCapabilityVersions []int
	TATState                  string
	ReconcileState            string
	ReconcileErrorCode        *string
	Agents                    []HeartbeatAgent
}

type ObservationService struct {
	repository          computercontrolport.ObservationRepository
	clock               clockport.Clock
	config              ObservationConfig
	profileCapabilities profileCapabilityEnsurer
}

type profileCapabilityEnsurer interface {
	Ensure(context.Context, string, string, string, int64) error
}

func NewObservationService(
	repository computercontrolport.ObservationRepository,
	clock clockport.Clock,
	config ObservationConfig,
	profileCapabilities ...profileCapabilityEnsurer,
) (*ObservationService, error) {
	if repository == nil || clock == nil || config.MaximumClockSkew <= 0 ||
		config.MaximumClockSkew > time.Hour || len(profileCapabilities) > 1 {
		return nil, errors.New("Computer Observation 服务配置无效")
	}
	service := &ObservationService{repository: repository, clock: clock, config: config}
	if len(profileCapabilities) == 1 {
		service.profileCapabilities = profileCapabilities[0]
	}
	return service, nil
}

func (service *ObservationService) Put(
	ctx context.Context,
	serverID string,
	computerID string,
	agentID string,
	observationID string,
	request ObservationRequest,
) (computercontrolport.ObservationResult, error) {
	now := service.clock.Now().UTC()
	if !validV7(serverID) || !validV7(computerID) || !validV7(agentID) ||
		!validV7(observationID) || !validV7(request.AssignmentEpoch) ||
		!validV7(request.LaunchID) || request.ConfigGeneration < 1 ||
		request.CredentialVersion == 0 || request.CredentialVersion > math.MaxInt64 ||
		request.Attempt < 1 || request.Sequence < 1 ||
		!validObservationState(request.State) || request.ObservedAt.IsZero() ||
		!validIMTransportState(request.IMTransportState) ||
		request.ObservedAt.UTC().After(now.Add(service.config.MaximumClockSkew)) ||
		!validErrorCode(request.ErrorCode) {
		return computercontrolport.ObservationResult{}, invalidObservation()
	}
	hash, err := observationHash(agentID, observationID, request)
	if err != nil {
		return computercontrolport.ObservationResult{}, invalidObservation()
	}
	result, err := service.repository.PutObservation(ctx, computercontrolport.Observation{
		ID:                 observationID,
		ServerID:           serverID,
		ComputerID:         computerID,
		AgentID:            agentID,
		AssignmentEpoch:    request.AssignmentEpoch,
		AssignmentRevision: request.AssignmentRevision,
		ConfigGeneration:   request.ConfigGeneration,
		CredentialVersion:  request.CredentialVersion,
		Attempt:            request.Attempt,
		Sequence:           request.Sequence,
		LaunchID:           request.LaunchID,
		State:              request.State,
		IMTransportState:   request.IMTransportState,
		ErrorCode:          request.ErrorCode,
		RequestHash:        hash,
		ObservedAt:         request.ObservedAt.UTC(),
		ReceivedAt:         now,
	})
	switch {
	case errors.Is(err, computercontrolport.ErrObservationConflict):
		return computercontrolport.ObservationResult{}, apperror.New(
			"idempotency_conflict", "Observation ID 已用于不同请求", err,
		)
	case errors.Is(err, computercontrolport.ErrObservationSequenceConflict):
		return computercontrolport.ObservationResult{}, apperror.New(
			"sequence_conflict", "Observation sequence 已被其他请求使用", err,
		)
	case errors.Is(err, computercontrolport.ErrAssignmentStale):
		return computercontrolport.ObservationResult{}, staleAssignment(err)
	case err != nil:
		return computercontrolport.ObservationResult{}, apperror.New(
			"internal_error", "暂时无法保存 Agent Observation", err,
		)
	default:
		if result.Accepted && request.State == "running" &&
			service.profileCapabilities != nil {
			if err := service.profileCapabilities.Ensure(
				ctx, serverID, computerID, agentID, request.ConfigGeneration,
			); err != nil {
				return computercontrolport.ObservationResult{}, apperror.New(
					"internal_error", "暂时无法确保 Agent Profile capability refresh", err,
				)
			}
		}
		return result, nil
	}
}

func (service *ObservationService) Heartbeat(
	ctx context.Context,
	serverID string,
	computerID string,
	request HeartbeatRequest,
) error {
	if !validV7(serverID) || !validV7(computerID) || !validV7(request.ID) ||
		!validV7(request.AssignmentEpoch) || request.AssignmentRevision < 1 ||
		strings.TrimSpace(request.DaemonVersion) != request.DaemonVersion ||
		request.DaemonVersion == "" || len(request.DaemonVersion) > 100 ||
		strings.TrimSpace(request.DaemonBuildID) != request.DaemonBuildID ||
		request.DaemonBuildID == "" || len(request.DaemonBuildID) > 200 ||
		!validTATState(request.TATState) || !validReconcileState(request.ReconcileState) ||
		!validErrorCode(request.ReconcileErrorCode) || len(request.Agents) > 5 {
		return invalidHeartbeat()
	}
	if request.AssignmentVersion != 0 && request.AssignmentVersion != 1 &&
		request.AssignmentVersion != 2 && request.AssignmentVersion != 3 ||
		len(request.ProfileCapabilityVersions) > 1 ||
		len(request.ProfileCapabilityVersions) == 1 &&
			request.ProfileCapabilityVersions[0] != 1 {
		return invalidHeartbeat()
	}
	seen := make(map[string]struct{}, len(request.Agents))
	agents := make([]computercontrolport.HeartbeatAgent, 0, len(request.Agents))
	for _, item := range request.Agents {
		if !validV7(item.AgentID) || !validV7(item.AssignmentEpoch) ||
			!validV7(item.LaunchID) || item.ConfigGeneration < 1 ||
			item.CredentialVersion == 0 || item.CredentialVersion > math.MaxInt64 ||
			item.Attempt < 1 {
			return invalidHeartbeat()
		}
		if _, ok := seen[item.AgentID]; ok {
			return invalidHeartbeat()
		}
		seen[item.AgentID] = struct{}{}
		agents = append(agents, computercontrolport.HeartbeatAgent{
			AgentID: item.AgentID, AssignmentEpoch: item.AssignmentEpoch,
			ConfigGeneration:  item.ConfigGeneration,
			CredentialVersion: item.CredentialVersion,
			Attempt:           item.Attempt, LaunchID: item.LaunchID,
		})
	}
	err := service.repository.ApplyHeartbeat(ctx, computercontrolport.Heartbeat{
		ID: request.ID, ServerID: serverID, ComputerID: computerID,
		AssignmentEpoch:           request.AssignmentEpoch,
		AssignmentRevision:        request.AssignmentRevision,
		AssignmentVersion:         request.AssignmentVersion,
		ProfileCapabilityVersions: append([]int(nil), request.ProfileCapabilityVersions...),
		DaemonVersion:             request.DaemonVersion, DaemonBuildID: request.DaemonBuildID,
		TATState:           request.TATState,
		ReconcileState:     request.ReconcileState,
		ReconcileErrorCode: request.ReconcileErrorCode,
		Agents:             agents, ReceivedAt: service.clock.Now().UTC(),
	})
	switch {
	case errors.Is(err, computercontrolport.ErrComputerNotCurrent):
		return apperror.New("computer_credential_revoked", "Computer 已失效", err)
	case errors.Is(err, computercontrolport.ErrAssignmentStale):
		return staleAssignment(err)
	case err != nil:
		return apperror.New("internal_error", "暂时无法保存 Computer heartbeat", err)
	default:
		return nil
	}
}

func observationHash(
	agentID string,
	observationID string,
	request ObservationRequest,
) ([32]byte, error) {
	encoded, err := json.Marshal(struct {
		AgentID       string             `json:"agentId"`
		ObservationID string             `json:"observationId"`
		Request       ObservationRequest `json:"request"`
	}{AgentID: agentID, ObservationID: observationID, Request: request})
	if err != nil {
		return [32]byte{}, err
	}
	return sha256.Sum256(encoded), nil
}

func validObservationState(value string) bool {
	switch value {
	case "starting", "running", "stopping", "stopped", "error":
		return true
	default:
		return false
	}
}

func validIMTransportState(value string) bool {
	switch value {
	case "unknown", "connecting", "connected", "disconnected", "error":
		return true
	default:
		return false
	}
}

func validTATState(value string) bool {
	return value == "online" || value == "offline" || value == "error"
}

func validReconcileState(value string) bool {
	return value == "healthy" || value == "error"
}

func validErrorCode(value *string) bool {
	return value == nil || (*value != "" && len(*value) <= 100 && strings.TrimSpace(*value) == *value)
}

func invalidObservation() error {
	return apperror.New("invalid_request", "Agent Observation 无效", nil)
}

func invalidHeartbeat() error {
	return apperror.New("invalid_request", "Computer heartbeat 无效", nil)
}
