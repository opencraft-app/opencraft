// Package computercontrol provides the Ent persistence adapter for the Vela control plane.
package computercontrol

import (
	"context"
	"crypto/subtle"
	"errors"
	"math"
	"time"

	"chatserver/internal/database"
	"chatserver/internal/ent"
	"chatserver/internal/ent/agent"
	"chatserver/internal/ent/computer"
	"chatserver/internal/ent/computeragentobservation"
	"chatserver/internal/ent/computerruntimecredential"
	"chatserver/internal/ent/tencentoperation"
	"chatserver/internal/persistedjson"
	computerauthport "chatserver/internal/ports/computerauth"
	computercontrolport "chatserver/internal/ports/computercontrol"

	"github.com/google/uuid"
)

// EntRepository keeps credential use and the returned assignment fence in one
// database transaction. It never trusts route information carried by a token
// without re-checking the current credential row.
type EntRepository struct {
	handle *database.Handle
}

type profileCapabilityRefreshSnapshot struct {
	SchemaVersion         int       `json:"schemaVersion"`
	ServerID              string    `json:"serverId"`
	AgentID               string    `json:"agentId"`
	ComputerID            string    `json:"computerId"`
	RuntimeKind           string    `json:"runtimeKind"`
	ContextGeneration     int64     `json:"contextGeneration"`
	AuthorityContextKey   string    `json:"authorityContextKey"`
	InvalidationWatermark int64     `json:"invalidationWatermark"`
	ForceReload           bool      `json:"forceReload"`
	Trigger               string    `json:"trigger"`
	RequestedAt           time.Time `json:"requestedAt"`
}

// NewEntRepository creates the Computer control-plane repository.
func NewEntRepository(handle *database.Handle) (*EntRepository, error) {
	if handle == nil || handle.Client() == nil {
		return nil, errors.New("Computer 控制 Repository 缺少数据库 Handle")
	}
	return &EntRepository{handle: handle}, nil
}

// UseCurrentCredential atomically records credential use and returns the
// authoritative assignment fence from the same server_id partition.
func (repository *EntRepository) UseCurrentCredential(
	ctx context.Context,
	route computerauthport.Route,
	usedAt time.Time,
) (identity computercontrolport.SessionIdentity, returnErr error) {
	if !validControlRoute(route) || usedAt.IsZero() {
		return computercontrolport.SessionIdentity{}, computercontrolport.ErrCredentialNotCurrent
	}
	usedAt = usedAt.UTC()
	returnErr = repository.handle.WithTx(ctx, func(ctx context.Context, tx *ent.Tx) error {
		credential, err := tx.ComputerRuntimeCredential.Query().
			Where(
				computerruntimecredential.ServerIDEQ(route.ServerID),
				computerruntimecredential.ComputerIDEQ(route.ComputerID),
				computerruntimecredential.VersionEQ(int64(route.Version)),
				computerruntimecredential.RevokedAtIsNil(),
				computerruntimecredential.Or(
					computerruntimecredential.And(
						computerruntimecredential.StateEQ("active"),
						computerruntimecredential.ExpiresAtGT(usedAt),
					),
					computerruntimecredential.And(
						computerruntimecredential.StateEQ("grace"),
						computerruntimecredential.GraceExpiresAtGT(usedAt),
					),
				),
			).
			Only(ctx)
		if ent.IsNotFound(err) {
			return computercontrolport.ErrCredentialNotCurrent
		}
		if err != nil {
			return err
		}

		machine, err := tx.Computer.Query().
			Where(
				computer.ServerIDEQ(route.ServerID),
				computer.IDEQ(route.ComputerID),
				computer.LifecycleStateEQ("active"),
			).
			Only(ctx)
		if ent.IsNotFound(err) {
			return computercontrolport.ErrCredentialNotCurrent
		}
		if err != nil {
			return err
		}
		if !uuidV7(machine.AssignmentEpoch) || machine.AssignmentRevision < 1 {
			return computercontrolport.ErrCredentialNotCurrent
		}
		if _, err := tx.ComputerRuntimeCredential.UpdateOne(credential).
			SetLastUsedAt(usedAt).
			Save(ctx); err != nil {
			return err
		}
		identity = computercontrolport.SessionIdentity{
			ServerID:           machine.ServerID,
			ComputerID:         machine.ID,
			CredentialVersion:  route.Version,
			AssignmentEpoch:    machine.AssignmentEpoch,
			AssignmentRevision: machine.AssignmentRevision,
		}
		return nil
	})
	return identity, returnErr
}

// RefreshSessionLease records that a fully issued Computer session reached
// the daemon. It intentionally does not acknowledge an assignment fence.
func (repository *EntRepository) RefreshSessionLease(
	ctx context.Context,
	route computerauthport.Route,
	seenAt time.Time,
) error {
	if !validControlRoute(route) || seenAt.IsZero() {
		return computercontrolport.ErrCredentialNotCurrent
	}
	seenAt = seenAt.UTC()
	return repository.handle.WithTx(ctx, func(ctx context.Context, tx *ent.Tx) error {
		credentialQuery := tx.ComputerRuntimeCredential.Query().
			Where(
				computerruntimecredential.ServerIDEQ(route.ServerID),
				computerruntimecredential.ComputerIDEQ(route.ComputerID),
				computerruntimecredential.VersionEQ(int64(route.Version)),
				computerruntimecredential.RevokedAtIsNil(),
				computerruntimecredential.Or(
					computerruntimecredential.And(
						computerruntimecredential.StateEQ("active"),
						computerruntimecredential.ExpiresAtGT(seenAt),
					),
					computerruntimecredential.And(
						computerruntimecredential.StateEQ("grace"),
						computerruntimecredential.GraceExpiresAtGT(seenAt),
					),
				),
			)
		if repository.handle.SupportsRowLocks() {
			credentialQuery.ForUpdate()
		}
		_, err := credentialQuery.Only(ctx)
		if ent.IsNotFound(err) {
			return computercontrolport.ErrCredentialNotCurrent
		}
		if err != nil {
			return err
		}

		computerQuery := tx.Computer.Query().
			Where(
				computer.ServerIDEQ(route.ServerID),
				computer.IDEQ(route.ComputerID),
				computer.LifecycleStateEQ("active"),
			)
		if repository.handle.SupportsRowLocks() {
			computerQuery.ForUpdate()
		}
		machine, err := computerQuery.Only(ctx)
		if ent.IsNotFound(err) {
			return computercontrolport.ErrCredentialNotCurrent
		}
		if err != nil {
			return err
		}
		if machine.HostLastSeenAt == nil || seenAt.After(machine.HostLastSeenAt.UTC()) {
			if _, err := tx.Computer.UpdateOne(machine).
				SetHostLastSeenAt(seenAt).
				Save(ctx); err != nil {
				return err
			}
		}
		return nil
	})
}

// GetAssignmentSnapshot returns a stable, Agent-ID ordered full snapshot.
func (repository *EntRepository) GetAssignmentSnapshot(
	ctx context.Context,
	serverID string,
	computerID string,
) (computercontrolport.AssignmentSnapshot, error) {
	if !uuidV7(serverID) || !uuidV7(computerID) {
		return computercontrolport.AssignmentSnapshot{}, computercontrolport.ErrComputerNotCurrent
	}
	machine, err := repository.handle.Client().Computer.Query().
		Where(
			computer.ServerIDEQ(serverID),
			computer.IDEQ(computerID),
			computer.LifecycleStateEQ("active"),
		).
		Only(ctx)
	if ent.IsNotFound(err) {
		return computercontrolport.AssignmentSnapshot{}, computercontrolport.ErrComputerNotCurrent
	}
	if err != nil {
		return computercontrolport.AssignmentSnapshot{}, err
	}
	entities, err := repository.handle.Client().Agent.Query().
		Where(
			agent.ServerIDEQ(serverID),
			agent.ComputerIDEQ(computerID),
			agent.DeletedAtIsNil(),
		).
		Order(ent.Asc(agent.FieldID)).
		All(ctx)
	if err != nil {
		return computercontrolport.AssignmentSnapshot{}, err
	}
	assignments := make([]computercontrolport.Assignment, 0, len(entities))
	for _, entity := range entities {
		assignment := computercontrolport.Assignment{
			AgentID:           entity.ID,
			ServerID:          entity.ServerID,
			DesiredState:      entity.DesiredState,
			ConfigGeneration:  entity.Revision,
			CredentialVersion: entity.CredentialVersion,
			RuntimeKind:       entity.RuntimeKind,
			RuntimeModel:      entity.RuntimeModel,
			ReplyPolicy:       entity.ReplyPolicy,
		}
		if entity.CurrentLaunchID != nil && entity.CurrentLaunchAssignmentEpoch != nil &&
			entity.CurrentLaunchGeneration > 0 &&
			entity.CurrentLaunchCredentialVersion > 0 && entity.CurrentLaunchAttempt > 0 {
			assignment.CurrentLaunch = &computercontrolport.AssignmentLaunchFence{
				LaunchID:          *entity.CurrentLaunchID,
				AssignmentEpoch:   *entity.CurrentLaunchAssignmentEpoch,
				ConfigGeneration:  entity.CurrentLaunchGeneration,
				CredentialVersion: uint64(entity.CurrentLaunchCredentialVersion),
				Attempt:           entity.CurrentLaunchAttempt,
			}
		}
		if entity.ProfileCapabilityRefreshID != nil {
			operation, err := repository.handle.Client().TencentOperation.Query().
				Where(
					tencentoperation.IDEQ(*entity.ProfileCapabilityRefreshID),
					tencentoperation.PartitionKeyEQ(serverID),
					tencentoperation.ServerIDEQ(serverID),
					tencentoperation.ServiceEQ("platform"),
					tencentoperation.KindEQ("agent.profile.capabilities.refresh"),
					tencentoperation.ResourceTypeEQ("agent"),
					tencentoperation.ResourceIDEQ(entity.ID),
					tencentoperation.StateIn("pending", "running", "retry_wait", "uncertain"),
				).
				Only(ctx)
			if err != nil {
				return computercontrolport.AssignmentSnapshot{}, err
			}
			if operation.RequestSnapshotJSON == nil {
				return computercontrolport.AssignmentSnapshot{}, errors.New(
					"Profile capability refresh 缺少 request snapshot",
				)
			}
			var snapshot profileCapabilityRefreshSnapshot
			if _, err := persistedjson.DecodeSnapshot(
				*operation.RequestSnapshotJSON,
				"platform",
				"agent.profile.capabilities.refresh",
				&snapshot,
			); err != nil {
				return computercontrolport.AssignmentSnapshot{}, err
			}
			if snapshot.SchemaVersion != 1 || snapshot.ServerID != serverID ||
				snapshot.AgentID != entity.ID || snapshot.ComputerID != computerID ||
				snapshot.RuntimeKind != entity.RuntimeKind ||
				snapshot.ContextGeneration != entity.Revision {
				return computercontrolport.AssignmentSnapshot{}, errors.New(
					"Profile capability refresh context 无效",
				)
			}
			assignment.ProfileCapabilityRefresh = &computercontrolport.ProfileCapabilityRefresh{
				RefreshID:             operation.ID,
				ContextGeneration:     snapshot.ContextGeneration,
				AuthorityContextKey:   snapshot.AuthorityContextKey,
				RuntimeKind:           snapshot.RuntimeKind,
				InvalidationWatermark: snapshot.InvalidationWatermark,
				ForceReload:           snapshot.ForceReload,
				RequestedAt:           snapshot.RequestedAt.UTC(),
			}
		}
		assignments = append(assignments, assignment)
	}
	return computercontrolport.AssignmentSnapshot{
		ComputerID: machine.ID,
		Epoch:      machine.AssignmentEpoch,
		Revision:   machine.AssignmentRevision,
		Agents:     assignments,
	}, nil
}

// AllocateAgentLaunch assigns the next Agent attempt from the authoritative
// Agent row. Later protocol layers use the returned tuple as the launch fence.
func (repository *EntRepository) AllocateAgentLaunch(
	ctx context.Context,
	request computercontrolport.AgentLaunchRequest,
) (result computercontrolport.AgentLaunchAllocation, returnErr error) {
	if !uuidV7(request.ServerID) || !uuidV7(request.ComputerID) ||
		!uuidV7(request.AgentID) || !uuidV7(request.LaunchID) ||
		!uuidV7(request.AssignmentEpoch) || request.AssignmentRevision < 1 ||
		request.AssignmentRevision == math.MaxInt64 ||
		request.ComputerCredentialVersion == 0 ||
		request.ComputerCredentialVersion > math.MaxInt64 ||
		request.ConfigGeneration < 1 || request.CredentialVersion == 0 ||
		request.CredentialVersion > math.MaxInt64 || request.RequestedAt.IsZero() {
		return result, computercontrolport.ErrAssignmentStale
	}
	returnErr = repository.handle.WithTx(ctx, func(ctx context.Context, tx *ent.Tx) error {
		activeCredential, err := tx.ComputerRuntimeCredential.Query().
			Where(
				computerruntimecredential.ServerIDEQ(request.ServerID),
				computerruntimecredential.ComputerIDEQ(request.ComputerID),
				computerruntimecredential.VersionEQ(int64(request.ComputerCredentialVersion)),
				computerruntimecredential.StateEQ("active"),
				computerruntimecredential.RevokedAtIsNil(),
				computerruntimecredential.ExpiresAtGT(request.RequestedAt.UTC()),
			).
			Exist(ctx)
		if err != nil {
			return err
		}
		if !activeCredential {
			return computercontrolport.ErrComputerCredentialNotActive
		}
		machine, err := tx.Computer.Query().
			Where(
				computer.ServerIDEQ(request.ServerID),
				computer.IDEQ(request.ComputerID),
				computer.LifecycleStateEQ("active"),
				computer.AssignmentEpochEQ(request.AssignmentEpoch),
			).
			Only(ctx)
		if ent.IsNotFound(err) {
			return computercontrolport.ErrAssignmentStale
		}
		if err != nil {
			return err
		}
		entity, err := tx.Agent.Query().
			Where(
				agent.ServerIDEQ(request.ServerID),
				agent.IDEQ(request.AgentID),
				agent.ComputerIDEQ(request.ComputerID),
				agent.RevisionEQ(request.ConfigGeneration),
				agent.CredentialVersionEQ(int64(request.CredentialVersion)),
				agent.DesiredStateEQ("running"),
				agent.DeletedAtIsNil(),
			).
			Only(ctx)
		if ent.IsNotFound(err) {
			return computercontrolport.ErrAssignmentStale
		}
		if err != nil {
			return err
		}
		if entity.CurrentLaunchID != nil &&
			*entity.CurrentLaunchID == request.LaunchID {
			// A successful allocation changes the Assignment snapshot and bumps
			// its revision. A retry may therefore carry the pre-allocation
			// revision; the immutable launch ID and complete launch tuple make
			// that retry safe to replay without advancing the revision again.
			if machine.AssignmentRevision < request.AssignmentRevision {
				return computercontrolport.ErrAssignmentStale
			}
			if entity.CurrentLaunchAssignmentEpoch == nil ||
				*entity.CurrentLaunchAssignmentEpoch != request.AssignmentEpoch ||
				entity.CurrentLaunchGeneration != request.ConfigGeneration ||
				entity.CurrentLaunchCredentialVersion != int64(request.CredentialVersion) ||
				entity.CurrentLaunchUpdatedAt == nil {
				return computercontrolport.ErrLaunchConflict
			}
			result.Fence = computercontrolport.AgentLaunchFence{
				LaunchID:          request.LaunchID,
				AssignmentEpoch:   request.AssignmentEpoch,
				ConfigGeneration:  request.ConfigGeneration,
				CredentialVersion: request.CredentialVersion,
				Attempt:           entity.CurrentLaunchAttempt,
				IssuedAt:          entity.CurrentLaunchUpdatedAt.UTC(),
			}
			return nil
		}
		if machine.AssignmentRevision != request.AssignmentRevision {
			return computercontrolport.ErrAssignmentStale
		}
		if !sameOptionalID(entity.CurrentLaunchID, request.PredecessorLaunchID) {
			return computercontrolport.ErrLaunchPredecessorMismatch
		}
		fence, err := replaceAgentLaunch(ctx, tx, entity, request)
		if err != nil {
			return err
		}
		updated, err := tx.Computer.Update().
			Where(
				computer.ServerIDEQ(request.ServerID),
				computer.IDEQ(request.ComputerID),
				computer.LifecycleStateEQ("active"),
				computer.AssignmentEpochEQ(request.AssignmentEpoch),
				computer.AssignmentRevisionEQ(request.AssignmentRevision),
			).
			SetAssignmentRevision(request.AssignmentRevision + 1).
			SetUpdatedAt(request.RequestedAt.UTC()).
			Save(ctx)
		if err != nil {
			return err
		}
		if updated != 1 {
			return computercontrolport.ErrAssignmentStale
		}
		result = computercontrolport.AgentLaunchAllocation{
			Created: true,
			Fence:   fence,
		}
		return nil
	})
	return result, returnErr
}

// ValidateAgentLaunch verifies the complete current Launch Fence without
// allocating a new attempt. Session refresh calls it before and after minting.
func (repository *EntRepository) ValidateAgentLaunch(
	ctx context.Context,
	request computercontrolport.AgentLaunchSessionRequest,
) (computercontrolport.AgentLaunchFence, error) {
	if !uuidV7(request.ServerID) || !uuidV7(request.ComputerID) ||
		!uuidV7(request.AgentID) || !uuidV7(request.LaunchID) ||
		!uuidV7(request.AssignmentEpoch) || request.ConfigGeneration < 1 ||
		request.CredentialVersion == 0 || request.CredentialVersion > math.MaxInt64 ||
		request.Attempt < 1 {
		return computercontrolport.AgentLaunchFence{}, computercontrolport.ErrLaunchConflict
	}
	_, err := repository.handle.Client().Computer.Query().
		Where(
			computer.ServerIDEQ(request.ServerID),
			computer.IDEQ(request.ComputerID),
			computer.LifecycleStateEQ("active"),
			computer.AssignmentEpochEQ(request.AssignmentEpoch),
		).
		Only(ctx)
	if ent.IsNotFound(err) {
		return computercontrolport.AgentLaunchFence{}, computercontrolport.ErrLaunchConflict
	}
	if err != nil {
		return computercontrolport.AgentLaunchFence{}, err
	}
	entity, err := repository.handle.Client().Agent.Query().
		Where(
			agent.ServerIDEQ(request.ServerID),
			agent.IDEQ(request.AgentID),
			agent.ComputerIDEQ(request.ComputerID),
			agent.DesiredStateEQ("running"),
			agent.DeletedAtIsNil(),
			agent.RevisionEQ(request.ConfigGeneration),
			agent.CredentialVersionEQ(int64(request.CredentialVersion)),
			agent.CurrentLaunchIDEQ(request.LaunchID),
			agent.CurrentLaunchAssignmentEpochEQ(request.AssignmentEpoch),
			agent.CurrentLaunchGenerationEQ(request.ConfigGeneration),
			agent.CurrentLaunchCredentialVersionEQ(int64(request.CredentialVersion)),
			agent.CurrentLaunchAttemptEQ(request.Attempt),
			agent.CurrentLaunchUpdatedAtNotNil(),
		).
		Only(ctx)
	if ent.IsNotFound(err) {
		return computercontrolport.AgentLaunchFence{}, computercontrolport.ErrLaunchConflict
	}
	if err != nil {
		return computercontrolport.AgentLaunchFence{}, err
	}
	return computercontrolport.AgentLaunchFence{
		LaunchID:          request.LaunchID,
		AssignmentEpoch:   request.AssignmentEpoch,
		ConfigGeneration:  request.ConfigGeneration,
		CredentialVersion: request.CredentialVersion,
		Attempt:           request.Attempt,
		IssuedAt:          entity.CurrentLaunchUpdatedAt.UTC(),
	}, nil
}

func replaceAgentLaunch(
	ctx context.Context,
	tx *ent.Tx,
	current *ent.Agent,
	request computercontrolport.AgentLaunchRequest,
) (computercontrolport.AgentLaunchFence, error) {
	if tx == nil || current == nil {
		return computercontrolport.AgentLaunchFence{}, computercontrolport.ErrLaunchConflict
	}
	update := tx.Agent.Update().Where(
		agent.ServerIDEQ(request.ServerID),
		agent.IDEQ(request.AgentID),
		agent.ComputerIDEQ(request.ComputerID),
		agent.RevisionEQ(request.ConfigGeneration),
		agent.CredentialVersionEQ(int64(request.CredentialVersion)),
		agent.DesiredStateEQ("running"),
		agent.DeletedAtIsNil(),
		agent.CurrentLaunchGenerationEQ(current.CurrentLaunchGeneration),
		agent.CurrentLaunchCredentialVersionEQ(current.CurrentLaunchCredentialVersion),
		agent.CurrentLaunchAttemptEQ(current.CurrentLaunchAttempt),
	)
	if current.CurrentLaunchID == nil {
		update.Where(agent.CurrentLaunchIDIsNil())
	} else {
		update.Where(agent.CurrentLaunchIDEQ(*current.CurrentLaunchID))
	}
	if current.CurrentLaunchAssignmentEpoch == nil {
		update.Where(agent.CurrentLaunchAssignmentEpochIsNil())
	} else {
		update.Where(agent.CurrentLaunchAssignmentEpochEQ(*current.CurrentLaunchAssignmentEpoch))
	}
	if current.CurrentLaunchUpdatedAt == nil {
		update.Where(agent.CurrentLaunchUpdatedAtIsNil())
	} else {
		update.Where(agent.CurrentLaunchUpdatedAtEQ(current.CurrentLaunchUpdatedAt.UTC()))
	}
	attempt := current.CurrentLaunchAttempt + 1
	issuedAt := request.RequestedAt.UTC()
	updated, err := update.
		SetCurrentLaunchID(request.LaunchID).
		SetCurrentLaunchAssignmentEpoch(request.AssignmentEpoch).
		SetCurrentLaunchGeneration(request.ConfigGeneration).
		SetCurrentLaunchCredentialVersion(int64(request.CredentialVersion)).
		SetCurrentLaunchAttempt(attempt).
		SetCurrentLaunchUpdatedAt(issuedAt).
		SetObservedState("unknown").
		ClearObservedAssignmentEpoch().
		SetObservedGeneration(0).
		SetObservedAttempt(0).
		SetObservedSequence(0).
		ClearObservedLaunchID().
		SetImTransportState("unknown").
		ClearImTransportUpdatedAt().
		ClearHostLastSeenAt().
		ClearLastObservedAt().
		ClearLastErrorCode().
		Save(ctx)
	if err != nil {
		return computercontrolport.AgentLaunchFence{}, err
	}
	if updated != 1 {
		return computercontrolport.AgentLaunchFence{}, computercontrolport.ErrLaunchConflict
	}
	return computercontrolport.AgentLaunchFence{
		LaunchID:          request.LaunchID,
		AssignmentEpoch:   request.AssignmentEpoch,
		ConfigGeneration:  request.ConfigGeneration,
		CredentialVersion: request.CredentialVersion,
		Attempt:           attempt,
		IssuedAt:          issuedAt,
	}, nil
}

// PutObservation writes an immutable receipt and advances the Agent projection
// only for the exact current server-issued Launch Fence.
func (repository *EntRepository) PutObservation(
	ctx context.Context,
	value computercontrolport.Observation,
) (result computercontrolport.ObservationResult, returnErr error) {
	if !validObservation(value) {
		return result, computercontrolport.ErrAssignmentStale
	}
	returnErr = repository.handle.WithTx(ctx, func(ctx context.Context, tx *ent.Tx) error {
		existing, err := tx.ComputerAgentObservation.Query().
			Where(
				computeragentobservation.ServerIDEQ(value.ServerID),
				computeragentobservation.IDEQ(value.ID),
			).
			Only(ctx)
		alreadyStored := err == nil
		if err != nil && !ent.IsNotFound(err) {
			return err
		}
		if alreadyStored && subtle.ConstantTimeCompare(
			existing.RequestHash,
			value.RequestHash[:],
		) != 1 {
			return computercontrolport.ErrObservationConflict
		}

		machine, machineErr := tx.Computer.Query().
			Where(
				computer.ServerIDEQ(value.ServerID),
				computer.IDEQ(value.ComputerID),
				computer.LifecycleStateEQ("active"),
			).
			Only(ctx)
		if machineErr != nil && !ent.IsNotFound(machineErr) {
			return machineErr
		}
		entity, agentErr := tx.Agent.Query().
			Where(
				agent.ServerIDEQ(value.ServerID),
				agent.IDEQ(value.AgentID),
				agent.ComputerIDEQ(value.ComputerID),
				agent.DeletedAtIsNil(),
			).
			Only(ctx)
		if agentErr != nil && !ent.IsNotFound(agentErr) {
			return agentErr
		}
		result = currentObservationResult(entity)
		fenceCurrent := machine != nil && entity != nil &&
			machine.AssignmentEpoch == value.AssignmentEpoch &&
			entity.CurrentLaunchID != nil && *entity.CurrentLaunchID == value.LaunchID &&
			entity.CurrentLaunchAssignmentEpoch != nil &&
			*entity.CurrentLaunchAssignmentEpoch == value.AssignmentEpoch &&
			entity.CurrentLaunchGeneration == value.ConfigGeneration &&
			entity.CurrentLaunchCredentialVersion == int64(value.CredentialVersion) &&
			entity.CurrentLaunchAttempt == value.Attempt
		if alreadyStored {
			if !fenceCurrent {
				result.Accepted = false
				result.Reason = computercontrolport.ObservationStaleLaunch
				return nil
			}
			result.Accepted = existing.AcceptedAtIngest
			if existing.AcceptedAtIngest {
				result.Reason = computercontrolport.ObservationAccepted
			} else if existing.RejectionReasonAtIngest != nil {
				result.Reason = *existing.RejectionReasonAtIngest
			} else {
				result.Reason = computercontrolport.ObservationStaleLaunch
			}
			return nil
		}
		if !fenceCurrent || entity == nil {
			result.Accepted = false
			result.Reason = computercontrolport.ObservationStaleLaunch
			return saveObservationReceipt(ctx, tx, value, false, result.Reason)
		}
		if value.Sequence < result.CurrentSequence {
			result.Accepted = false
			result.Reason = computercontrolport.ObservationOlderSequence
			return saveObservationReceipt(ctx, tx, value, false, result.Reason)
		}
		if value.Sequence == result.CurrentSequence {
			return computercontrolport.ErrObservationSequenceConflict
		}
		update := tx.Agent.Update().Where(
			agent.ServerIDEQ(value.ServerID),
			agent.IDEQ(value.AgentID),
			agent.ComputerIDEQ(value.ComputerID),
			agent.DeletedAtIsNil(),
			agent.CurrentLaunchIDEQ(value.LaunchID),
			agent.CurrentLaunchAssignmentEpochEQ(value.AssignmentEpoch),
			agent.CurrentLaunchGenerationEQ(value.ConfigGeneration),
			agent.CurrentLaunchCredentialVersionEQ(int64(value.CredentialVersion)),
			agent.CurrentLaunchAttemptEQ(value.Attempt),
			agent.ObservedSequenceEQ(result.CurrentSequence),
		).
			SetObservedAssignmentEpoch(value.AssignmentEpoch).
			SetObservedGeneration(value.ConfigGeneration).
			SetObservedAttempt(value.Attempt).
			SetObservedSequence(value.Sequence).
			SetObservedLaunchID(value.LaunchID).
			SetObservedState(value.State).
			SetImTransportState(value.IMTransportState).
			SetImTransportUpdatedAt(value.ObservedAt.UTC()).
			SetLastObservedAt(value.ObservedAt.UTC()).
			SetHostLastSeenAt(value.ReceivedAt.UTC())
		if result.CurrentSequence == 0 {
			update.Where(agent.ObservedLaunchIDIsNil())
		} else {
			update.Where(
				agent.ObservedLaunchIDEQ(value.LaunchID),
				agent.ObservedAttemptEQ(value.Attempt),
			)
		}
		if value.ErrorCode == nil {
			update.ClearLastErrorCode()
		} else {
			update.SetLastErrorCode(*value.ErrorCode)
		}
		updated, err := update.Save(ctx)
		if err != nil {
			return err
		}
		if updated != 1 {
			return computercontrolport.ErrLaunchConflict
		}
		result.Accepted = true
		result.Reason = computercontrolport.ObservationAccepted
		launchID := value.LaunchID
		result.CurrentLaunchID = &launchID
		result.CurrentAttempt = value.Attempt
		result.CurrentSequence = value.Sequence
		return saveObservationReceipt(ctx, tx, value, true, "")
	})
	return result, returnErr
}

func currentObservationResult(entity *ent.Agent) computercontrolport.ObservationResult {
	result := computercontrolport.ObservationResult{
		Accepted: false,
		Reason:   computercontrolport.ObservationStaleLaunch,
	}
	if entity == nil || entity.CurrentLaunchID == nil {
		return result
	}
	launchID := *entity.CurrentLaunchID
	result.CurrentLaunchID = &launchID
	result.CurrentAttempt = entity.CurrentLaunchAttempt
	if entity.ObservedLaunchID != nil && *entity.ObservedLaunchID == launchID &&
		entity.ObservedAttempt == entity.CurrentLaunchAttempt {
		result.CurrentSequence = entity.ObservedSequence
	}
	return result
}

func saveObservationReceipt(
	ctx context.Context,
	tx *ent.Tx,
	value computercontrolport.Observation,
	accepted bool,
	rejectionReason string,
) error {
	create := tx.ComputerAgentObservation.Create().
		SetID(value.ID).
		SetServerID(value.ServerID).
		SetComputerID(value.ComputerID).
		SetAgentID(value.AgentID).
		SetAssignmentEpoch(value.AssignmentEpoch).
		SetAssignmentRevision(value.AssignmentRevision).
		SetConfigGeneration(value.ConfigGeneration).
		SetCredentialVersion(int64(value.CredentialVersion)).
		SetAttempt(value.Attempt).
		SetSequence(value.Sequence).
		SetLaunchID(value.LaunchID).
		SetState(value.State).
		SetImTransportState(value.IMTransportState).
		SetNillableErrorCode(value.ErrorCode).
		SetAcceptedAtIngest(accepted).
		SetRequestHash(value.RequestHash[:]).
		SetObservedAt(value.ObservedAt.UTC()).
		SetCreatedAt(value.ReceivedAt.UTC())
	if rejectionReason != "" {
		create.SetRejectionReasonAtIngest(rejectionReason)
	}
	if _, err := create.Save(ctx); err != nil {
		if ent.IsConstraintError(err) {
			return computercontrolport.ErrObservationConflict
		}
		return err
	}
	return nil
}

// ApplyHeartbeat refreshes the Computer lease and only extends Agent host
// leases whose launch tuple still matches the current observation projection.
func (repository *EntRepository) ApplyHeartbeat(
	ctx context.Context,
	value computercontrolport.Heartbeat,
) error {
	if !validHeartbeat(value) {
		return computercontrolport.ErrAssignmentStale
	}
	return repository.handle.WithTx(ctx, func(ctx context.Context, tx *ent.Tx) error {
		machine, err := tx.Computer.Query().
			Where(
				computer.ServerIDEQ(value.ServerID),
				computer.IDEQ(value.ComputerID),
				computer.LifecycleStateEQ("active"),
			).
			Only(ctx)
		if ent.IsNotFound(err) {
			return computercontrolport.ErrComputerNotCurrent
		}
		if err != nil {
			return err
		}
		update := tx.Computer.UpdateOne(machine).
			SetHostLastSeenAt(value.ReceivedAt.UTC()).
			SetDaemonVersion(value.DaemonVersion).
			SetDaemonBuildID(value.DaemonBuildID).
			SetTatAgentState(value.TATState).
			SetLastObservedAt(value.ReceivedAt.UTC())
		assignmentVersion := value.AssignmentVersion
		if assignmentVersion == 0 {
			assignmentVersion = 1
		}
		update.SetAssignmentProtocolVersion(assignmentVersion)
		if len(value.ProfileCapabilityVersions) == 1 &&
			value.ProfileCapabilityVersions[0] == 1 {
			update.SetProfileCapabilityVersion(1)
		} else {
			update.ClearProfileCapabilityVersion()
		}
		if value.ReconcileErrorCode == nil {
			update.ClearLastReconcileErrorCode()
		} else {
			update.SetLastReconcileErrorCode(*value.ReconcileErrorCode)
		}
		if _, err := update.Save(ctx); err != nil {
			return err
		}
		runningAgentIDs := make(map[string]struct{}, len(value.Agents))
		for _, item := range value.Agents {
			runningAgentIDs[item.AgentID] = struct{}{}
			entity, err := tx.Agent.Query().
				Where(
					agent.ServerIDEQ(value.ServerID),
					agent.IDEQ(item.AgentID),
					agent.ComputerIDEQ(value.ComputerID),
					agent.DeletedAtIsNil(),
					agent.CurrentLaunchAssignmentEpochEQ(item.AssignmentEpoch),
					agent.CurrentLaunchGenerationEQ(item.ConfigGeneration),
					agent.CurrentLaunchCredentialVersionEQ(int64(item.CredentialVersion)),
					agent.CurrentLaunchAttemptEQ(item.Attempt),
					agent.CurrentLaunchIDEQ(item.LaunchID),
				).
				Only(ctx)
			if ent.IsNotFound(err) {
				continue
			}
			if err != nil {
				return err
			}
			if entity.HostLastSeenAt != nil &&
				!value.ReceivedAt.UTC().After(entity.HostLastSeenAt.UTC()) {
				continue
			}
			if _, err := tx.Agent.UpdateOne(entity).
				SetHostLastSeenAt(value.ReceivedAt.UTC()).
				Save(ctx); err != nil {
				return err
			}
		}
		// A current-assignment heartbeat is also the daemon's authoritative
		// running set. Once the desired state is stopped, absence from that set
		// proves the previous launch has terminated. This closes the projection
		// without accepting a terminal observation fenced by the old revision.
		if machine.AssignmentEpoch == value.AssignmentEpoch &&
			machine.AssignmentRevision == value.AssignmentRevision {
			stopping, err := tx.Agent.Query().
				Where(
					agent.ServerIDEQ(value.ServerID),
					agent.ComputerIDEQ(value.ComputerID),
					agent.DeletedAtIsNil(),
					agent.DesiredStateEQ("stopped"),
					agent.ObservedStateEQ("stopping"),
				).
				All(ctx)
			if err != nil {
				return err
			}
			for _, entity := range stopping {
				if _, running := runningAgentIDs[entity.ID]; running {
					continue
				}
				if _, err := tx.Agent.UpdateOne(entity).
					SetObservedState("stopped").
					SetLastObservedAt(value.ReceivedAt.UTC()).
					SetHostLastSeenAt(value.ReceivedAt.UTC()).
					ClearLastErrorCode().
					Save(ctx); err != nil {
					return err
				}
			}
		}
		return nil
	})
}

func validObservation(value computercontrolport.Observation) bool {
	return uuidV7(value.ID) && uuidV7(value.ServerID) &&
		uuidV7(value.ComputerID) && uuidV7(value.AgentID) &&
		uuidV7(value.AssignmentEpoch) && uuidV7(value.LaunchID) &&
		value.ConfigGeneration > 0 && value.CredentialVersion > 0 &&
		value.Attempt > 0 && value.Sequence > 0 &&
		validIMTransportState(value.IMTransportState) &&
		!value.ObservedAt.IsZero() && !value.ReceivedAt.IsZero()
}

func validIMTransportState(value string) bool {
	switch value {
	case "unknown", "connecting", "connected", "disconnected", "error":
		return true
	default:
		return false
	}
}

func validHeartbeat(value computercontrolport.Heartbeat) bool {
	if !uuidV7(value.ID) || !uuidV7(value.ServerID) ||
		!uuidV7(value.ComputerID) || !uuidV7(value.AssignmentEpoch) ||
		value.AssignmentRevision < 1 || value.DaemonVersion == "" ||
		value.DaemonBuildID == "" ||
		value.ReceivedAt.IsZero() {
		return false
	}
	if value.AssignmentVersion != 0 && value.AssignmentVersion != 1 &&
		value.AssignmentVersion != 2 ||
		len(value.ProfileCapabilityVersions) > 1 ||
		len(value.ProfileCapabilityVersions) == 1 &&
			value.ProfileCapabilityVersions[0] != 1 {
		return false
	}
	for _, item := range value.Agents {
		if !uuidV7(item.AgentID) || !uuidV7(item.AssignmentEpoch) ||
			!uuidV7(item.LaunchID) || item.ConfigGeneration < 1 ||
			item.CredentialVersion == 0 || item.Attempt < 1 {
			return false
		}
	}
	return true
}

func validControlRoute(route computerauthport.Route) bool {
	return route.Version > 0 && route.Version <= math.MaxInt64 &&
		uuidV7(route.ServerID) && uuidV7(route.ComputerID)
}

func uuidV7(value string) bool {
	parsed, err := uuid.Parse(value)
	return err == nil && parsed != uuid.Nil && parsed.Version() == 7
}

func sameOptionalID(left *string, right *string) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return *left == *right
}

var _ computercontrolport.Repository = (*EntRepository)(nil)
var _ computercontrolport.AssignmentRepository = (*EntRepository)(nil)
var _ computercontrolport.AgentLaunchRepository = (*EntRepository)(nil)
var _ computercontrolport.ObservationRepository = (*EntRepository)(nil)
