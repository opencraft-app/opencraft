package computercontrol

import (
	"context"
	"crypto/sha256"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"chatserver/internal/config"
	"chatserver/internal/database"
	"chatserver/internal/database/migration"
	"chatserver/internal/ent"
	"chatserver/internal/ent/agent"
	"chatserver/internal/ent/computer"
	"chatserver/internal/ent/computerruntimecredential"
	computerauthport "chatserver/internal/ports/computerauth"
	computercontrolport "chatserver/internal/ports/computercontrol"
)

const (
	controlRepoServerID     = "01989c24-7540-7f12-a27b-c83243215dd3"
	controlRepoComputerID   = "01989c24-7540-7f12-a27b-c83243215dd5"
	controlRepoCredentialID = "01989c24-7540-7f12-a27b-c83243215dd6"
	controlRepoEpoch        = "01989c24-7540-7f12-a27b-c83243215dd7"
	controlRepoAgentID      = "01989c24-7540-7f12-a27b-c83243215dd8"
	controlRepoMemberID     = "01989c24-7540-7f12-a27b-c83243215dd9"
)

var controlRepoNow = time.Date(2026, 8, 1, 17, 0, 0, 0, time.UTC)

func TestEntRepositoryUsesCredentialThenRefreshesSessionLease(t *testing.T) {
	repository, handle := openControlRepository(t)
	seedControlComputer(t, handle, "active")
	seedControlCredential(t, handle, "active", controlRepoNow.Add(time.Hour))
	route := computerauthport.Route{ServerID: controlRepoServerID, ComputerID: controlRepoComputerID, Version: 1}
	identity, err := repository.UseCurrentCredential(context.Background(), route, controlRepoNow)
	if err != nil {
		t.Fatal(err)
	}
	if identity != (computercontrolport.SessionIdentity{
		ServerID:           controlRepoServerID,
		ComputerID:         controlRepoComputerID,
		CredentialVersion:  1,
		AssignmentEpoch:    controlRepoEpoch,
		AssignmentRevision: 4,
	}) {
		t.Fatalf("UseCurrentCredential() = %#v", identity)
	}
	entity, err := handle.Client().ComputerRuntimeCredential.Query().Where(
		computerruntimecredential.IDEQ(controlRepoCredentialID),
	).Only(context.Background())
	if err != nil || entity.LastUsedAt == nil || !entity.LastUsedAt.Equal(controlRepoNow) {
		t.Fatalf("last_used_at = %v, %v", entity.LastUsedAt, err)
	}
	machine, err := handle.Client().Computer.Get(
		context.Background(),
		controlRepoComputerID,
	)
	if err != nil {
		t.Fatal(err)
	}
	if machine.HostLastSeenAt != nil {
		t.Fatalf("credential use refreshed session lease at %s", machine.HostLastSeenAt)
	}
	if err := repository.RefreshSessionLease(
		context.Background(),
		computerauthport.Route{
			ServerID: controlRepoServerID, ComputerID: controlRepoComputerID,
			Version: 1,
		},
		controlRepoNow,
	); err != nil {
		t.Fatal(err)
	}
	machine, err = handle.Client().Computer.Get(
		context.Background(),
		controlRepoComputerID,
	)
	if err != nil {
		t.Fatal(err)
	}
	if machine.HostLastSeenAt == nil ||
		!machine.HostLastSeenAt.Equal(controlRepoNow) ||
		machine.AssignmentEpoch != controlRepoEpoch ||
		machine.AssignmentRevision != 4 {
		t.Fatalf("Computer session lease = %#v", machine)
	}
}

func TestEntRepositorySessionLeaseDoesNotRewriteCredentialUsage(t *testing.T) {
	repository, handle := openControlRepository(t)
	seedControlComputer(t, handle, "active")
	seedControlCredential(t, handle, "active", controlRepoNow.Add(time.Hour))
	route := computerauthport.Route{
		ServerID: controlRepoServerID, ComputerID: controlRepoComputerID, Version: 1,
	}
	if _, err := repository.UseCurrentCredential(
		context.Background(), route, controlRepoNow,
	); err != nil {
		t.Fatal(err)
	}
	leaseAt := controlRepoNow.Add(time.Minute)
	if err := repository.RefreshSessionLease(
		context.Background(), route, leaseAt,
	); err != nil {
		t.Fatal(err)
	}
	credential, err := handle.Client().ComputerRuntimeCredential.Get(
		context.Background(), controlRepoCredentialID,
	)
	if err != nil {
		t.Fatal(err)
	}
	if credential.LastUsedAt == nil || !credential.LastUsedAt.Equal(controlRepoNow) {
		t.Fatalf("credential usage changed during lease refresh: %v", credential.LastUsedAt)
	}
	machine, err := handle.Client().Computer.Get(
		context.Background(), controlRepoComputerID,
	)
	if err != nil {
		t.Fatal(err)
	}
	if machine.HostLastSeenAt == nil || !machine.HostLastSeenAt.Equal(leaseAt) {
		t.Fatalf("Computer host lease = %v, want %s", machine.HostLastSeenAt, leaseAt)
	}
}

func TestEntRepositorySessionLeaseNeverMovesBackward(t *testing.T) {
	repository, handle := openControlRepository(t)
	seedControlComputer(t, handle, "active")
	seedControlCredential(t, handle, "active", controlRepoNow.Add(time.Hour))
	route := computerauthport.Route{
		ServerID: controlRepoServerID, ComputerID: controlRepoComputerID, Version: 1,
	}
	later := controlRepoNow.Add(2 * time.Minute)
	for _, seenAt := range []time.Time{later, controlRepoNow.Add(time.Minute)} {
		if err := repository.RefreshSessionLease(
			context.Background(), route, seenAt,
		); err != nil {
			t.Fatal(err)
		}
	}
	machine, err := handle.Client().Computer.Get(
		context.Background(), controlRepoComputerID,
	)
	if err != nil {
		t.Fatal(err)
	}
	if machine.HostLastSeenAt == nil || !machine.HostLastSeenAt.Equal(later) {
		t.Fatalf("Computer host lease moved backward: %v", machine.HostLastSeenAt)
	}
}

func TestEntRepositoryRejectsExpiredCredentialWithoutUpdatingUsage(t *testing.T) {
	repository, handle := openControlRepository(t)
	seedControlComputer(t, handle, "active")
	seedControlCredential(t, handle, "active", controlRepoNow)
	_, err := repository.UseCurrentCredential(context.Background(), computerauthport.Route{
		ServerID:   controlRepoServerID,
		ComputerID: controlRepoComputerID,
		Version:    1,
	}, controlRepoNow)
	if !errors.Is(err, computercontrolport.ErrCredentialNotCurrent) {
		t.Fatalf("UseCurrentCredential() error = %v", err)
	}
	entity, err := handle.Client().ComputerRuntimeCredential.Get(context.Background(), controlRepoCredentialID)
	if err != nil {
		t.Fatal(err)
	}
	if entity.LastUsedAt != nil {
		t.Fatalf("last_used_at = %v", entity.LastUsedAt)
	}
}

func TestEntRepositoryRejectsSessionLeaseAfterCredentialRotation(t *testing.T) {
	repository, handle := openControlRepository(t)
	seedControlComputer(t, handle, "active")
	seedControlCredential(t, handle, "active", controlRepoNow.Add(time.Hour))
	if _, err := repository.UseCurrentCredential(
		context.Background(),
		computerauthport.Route{
			ServerID: controlRepoServerID, ComputerID: controlRepoComputerID,
			Version: 1,
		},
		controlRepoNow,
	); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Client().ComputerRuntimeCredential.Update().
		Where(computerruntimecredential.IDEQ(controlRepoCredentialID)).
		SetState("revoked").
		SetRevokedAt(controlRepoNow).
		Save(context.Background()); err != nil {
		t.Fatal(err)
	}
	err := repository.RefreshSessionLease(
		context.Background(),
		computerauthport.Route{
			ServerID: controlRepoServerID, ComputerID: controlRepoComputerID,
			Version: 1,
		},
		controlRepoNow,
	)
	if !errors.Is(err, computercontrolport.ErrCredentialNotCurrent) {
		t.Fatalf("RefreshSessionLease() error = %v", err)
	}
	machine, err := handle.Client().Computer.Get(
		context.Background(), controlRepoComputerID,
	)
	if err != nil {
		t.Fatal(err)
	}
	if machine.HostLastSeenAt != nil {
		t.Fatalf("rotated credential refreshed lease at %s", machine.HostLastSeenAt)
	}
}

func TestEntRepositoryReturnsComputerAssignmentSnapshot(t *testing.T) {
	repository, handle := openControlRepository(t)
	seedControlComputer(t, handle, "active")
	model := "gpt-5-codex"
	_, err := handle.Client().Agent.Create().
		SetID(controlRepoAgentID).
		SetServerID(controlRepoServerID).
		SetImUserID("a_control").
		SetComputerID(controlRepoComputerID).
		SetRuntimeKind("codex").
		SetRuntimeModel(model).
		SetReplyPolicy("mention_and_dm").
		SetDesiredState("running").
		SetObservedState("starting").
		SetCredentialVersion(2).
		SetImState("ready").
		SetCurrentLaunchID("01989c24-7540-7f12-a27b-c83243215dda").
		SetCurrentLaunchAssignmentEpoch(controlRepoEpoch).
		SetCurrentLaunchGeneration(6).
		SetCurrentLaunchCredentialVersion(2).
		SetCurrentLaunchAttempt(3).
		SetCurrentLaunchUpdatedAt(controlRepoNow).
		SetCreatedByMemberID(controlRepoMemberID).
		SetRevision(6).
		SetCreatedAt(controlRepoNow).
		SetUpdatedAt(controlRepoNow).
		Save(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	snapshot, err := repository.GetAssignmentSnapshot(
		context.Background(),
		controlRepoServerID,
		controlRepoComputerID,
	)
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.ComputerID != controlRepoComputerID ||
		snapshot.Epoch != controlRepoEpoch || snapshot.Revision != 4 ||
		len(snapshot.Agents) != 1 {
		t.Fatalf("snapshot = %#v", snapshot)
	}
	agent := snapshot.Agents[0]
	if agent.AgentID != controlRepoAgentID ||
		agent.ServerID != controlRepoServerID ||
		agent.ConfigGeneration != 6 || agent.CredentialVersion != 2 ||
		agent.DesiredState != "running" || agent.RuntimeKind != "codex" ||
		agent.RuntimeModel == nil || *agent.RuntimeModel != model ||
		agent.ReplyPolicy != "mention_and_dm" {
		t.Fatalf("assignment = %#v", agent)
	}
	if agent.CurrentLaunch == nil || agent.CurrentLaunch.Attempt != 3 ||
		agent.CurrentLaunch.LaunchID != "01989c24-7540-7f12-a27b-c83243215dda" ||
		agent.CurrentLaunch.AssignmentEpoch != controlRepoEpoch {
		t.Fatalf("assignment current Launch = %#v", agent.CurrentLaunch)
	}
}

func TestEntRepositoryAllocatesFirstAgentLaunchAttempt(t *testing.T) {
	repository, handle := openControlRepository(t)
	seedControlComputer(t, handle, "active")
	seedControlCredential(t, handle, "active", controlRepoNow.Add(time.Hour))
	seedControlRunningAgent(t, handle)
	launchID := "01989c24-7540-7f12-a27b-c83243215dda"
	issuedAt := controlRepoNow.Add(time.Minute)
	fence, err := repository.AllocateAgentLaunch(
		context.Background(),
		computercontrolport.AgentLaunchRequest{
			ServerID:                  controlRepoServerID,
			ComputerID:                controlRepoComputerID,
			ComputerCredentialVersion: 1,
			AgentID:                   controlRepoAgentID,
			LaunchID:                  launchID,
			AssignmentEpoch:           controlRepoEpoch,
			AssignmentRevision:        4,
			ConfigGeneration:          6,
			CredentialVersion:         2,
			RequestedAt:               issuedAt,
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	if !fence.Created || fence.Fence.LaunchID != launchID || fence.Fence.Attempt != 1 ||
		fence.Fence.AssignmentEpoch != controlRepoEpoch ||
		fence.Fence.ConfigGeneration != 6 || fence.Fence.CredentialVersion != 2 ||
		!fence.Fence.IssuedAt.Equal(issuedAt) {
		t.Fatalf("launch allocation = %#v", fence)
	}
	machine, err := handle.Client().Computer.Query().Where(
		computer.ServerIDEQ(controlRepoServerID),
		computer.IDEQ(controlRepoComputerID),
	).Only(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if machine.AssignmentRevision != 5 {
		t.Fatalf("assignment revision = %d, want 5", machine.AssignmentRevision)
	}
	snapshot, err := repository.GetAssignmentSnapshot(
		context.Background(), controlRepoServerID, controlRepoComputerID,
	)
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.Revision != 5 || len(snapshot.Agents) != 1 ||
		snapshot.Agents[0].CurrentLaunch == nil ||
		snapshot.Agents[0].CurrentLaunch.LaunchID != launchID {
		t.Fatalf("assignment snapshot after launch = %#v", snapshot)
	}
}

func TestEntRepositoryRejectsGraceComputerCredentialForLaunch(t *testing.T) {
	repository, handle := openControlRepository(t)
	seedControlComputer(t, handle, "active")
	seedControlCredential(t, handle, "grace", controlRepoNow.Add(time.Hour))
	seedControlRunningAgent(t, handle)
	_, err := repository.AllocateAgentLaunch(
		context.Background(),
		computercontrolport.AgentLaunchRequest{
			ServerID: controlRepoServerID, ComputerID: controlRepoComputerID,
			ComputerCredentialVersion: 1,
			AgentID:                   controlRepoAgentID,
			LaunchID:                  "01989c24-7540-7f12-a27b-c83243215dda",
			AssignmentEpoch:           controlRepoEpoch, AssignmentRevision: 4,
			ConfigGeneration: 6, CredentialVersion: 2,
			RequestedAt: controlRepoNow.Add(time.Minute),
		},
	)
	if !errors.Is(err, computercontrolport.ErrComputerCredentialNotActive) {
		t.Fatalf("AllocateAgentLaunch() error = %v", err)
	}
}

func TestEntRepositoryRetriesSameAgentLaunchIdempotently(t *testing.T) {
	repository, handle := openControlRepository(t)
	seedControlComputer(t, handle, "active")
	seedControlCredential(t, handle, "active", controlRepoNow.Add(time.Hour))
	seedControlRunningAgent(t, handle)
	launchID := "01989c24-7540-7f12-a27b-c83243215dda"
	request := computercontrolport.AgentLaunchRequest{
		ServerID:                  controlRepoServerID,
		ComputerID:                controlRepoComputerID,
		ComputerCredentialVersion: 1,
		AgentID:                   controlRepoAgentID,
		LaunchID:                  launchID,
		AssignmentEpoch:           controlRepoEpoch,
		AssignmentRevision:        4,
		ConfigGeneration:          6,
		CredentialVersion:         2,
		RequestedAt:               controlRepoNow.Add(time.Minute),
	}
	first, err := repository.AllocateAgentLaunch(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	request.RequestedAt = controlRepoNow.Add(2 * time.Minute)
	second, err := repository.AllocateAgentLaunch(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	if !first.Created || second.Created || first.Fence != second.Fence || second.Fence.Attempt != 1 {
		t.Fatalf("launch retry = first %#v, second %#v", first, second)
	}
	machine, err := handle.Client().Computer.Get(context.Background(), controlRepoComputerID)
	if err != nil {
		t.Fatal(err)
	}
	if machine.AssignmentRevision != 5 {
		t.Fatalf("idempotent retry advanced assignment revision to %d, want 5", machine.AssignmentRevision)
	}
}

func TestEntRepositoryRejectsMismatchedLaunchPredecessor(t *testing.T) {
	repository, handle := openControlRepository(t)
	seedControlComputer(t, handle, "active")
	seedControlCredential(t, handle, "active", controlRepoNow.Add(time.Hour))
	seedControlRunningAgent(t, handle)
	firstLaunchID := "01989c24-7540-7f12-a27b-c83243215dda"
	base := computercontrolport.AgentLaunchRequest{
		ServerID:                  controlRepoServerID,
		ComputerID:                controlRepoComputerID,
		ComputerCredentialVersion: 1,
		AgentID:                   controlRepoAgentID,
		LaunchID:                  firstLaunchID,
		AssignmentEpoch:           controlRepoEpoch,
		AssignmentRevision:        4,
		ConfigGeneration:          6,
		CredentialVersion:         2,
		RequestedAt:               controlRepoNow.Add(time.Minute),
	}
	if _, err := repository.AllocateAgentLaunch(context.Background(), base); err != nil {
		t.Fatal(err)
	}
	wrongPredecessor := "01989c24-7540-7f12-a27b-c83243215ddb"
	base.LaunchID = "01989c24-7540-7f12-a27b-c83243215ddc"
	base.PredecessorLaunchID = &wrongPredecessor
	base.AssignmentRevision = 5
	base.RequestedAt = controlRepoNow.Add(2 * time.Minute)
	_, err := repository.AllocateAgentLaunch(context.Background(), base)
	if !errors.Is(err, computercontrolport.ErrLaunchPredecessorMismatch) {
		t.Fatalf("AllocateAgentLaunch() error = %v", err)
	}
}

func TestEntRepositoryReplacementLaunchResetsPreviousProjection(t *testing.T) {
	repository, handle := openControlRepository(t)
	seedControlComputer(t, handle, "active")
	seedControlCredential(t, handle, "active", controlRepoNow.Add(time.Hour))
	seedControlRunningAgent(t, handle)
	firstLaunchID := "01989c24-7540-7f12-a27b-c83243215dda"
	request := computercontrolport.AgentLaunchRequest{
		ServerID:                  controlRepoServerID,
		ComputerID:                controlRepoComputerID,
		ComputerCredentialVersion: 1,
		AgentID:                   controlRepoAgentID,
		LaunchID:                  firstLaunchID,
		AssignmentEpoch:           controlRepoEpoch,
		AssignmentRevision:        4,
		ConfigGeneration:          6,
		CredentialVersion:         2,
		RequestedAt:               controlRepoNow.Add(time.Minute),
	}
	if _, err := repository.AllocateAgentLaunch(context.Background(), request); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Client().Agent.Update().
		Where(agent.IDEQ(controlRepoAgentID)).
		SetObservedState("running").
		SetObservedAssignmentEpoch(controlRepoEpoch).
		SetObservedGeneration(6).
		SetObservedAttempt(1).
		SetObservedSequence(3).
		SetObservedLaunchID(firstLaunchID).
		SetHostLastSeenAt(controlRepoNow.Add(time.Minute)).
		SetLastObservedAt(controlRepoNow.Add(time.Minute)).
		Save(context.Background()); err != nil {
		t.Fatal(err)
	}
	secondLaunchID := "01989c24-7540-7f12-a27b-c83243215ddc"
	request.LaunchID = secondLaunchID
	request.PredecessorLaunchID = &firstLaunchID
	request.AssignmentRevision = 5
	request.RequestedAt = controlRepoNow.Add(2 * time.Minute)
	fence, err := repository.AllocateAgentLaunch(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	entity, err := handle.Client().Agent.Get(context.Background(), controlRepoAgentID)
	if err != nil {
		t.Fatal(err)
	}
	if !fence.Created || fence.Fence.Attempt != 2 || entity.CurrentLaunchID == nil ||
		*entity.CurrentLaunchID != secondLaunchID ||
		entity.ObservedState != "unknown" || entity.ObservedAssignmentEpoch != nil ||
		entity.ObservedGeneration != 0 || entity.ObservedAttempt != 0 ||
		entity.ObservedSequence != 0 || entity.ObservedLaunchID != nil ||
		entity.HostLastSeenAt != nil || entity.LastObservedAt != nil {
		t.Fatalf("replacement projection = fence %#v, Agent %#v", fence, entity)
	}
}

func TestAgentLaunchCASRejectsStaleAgentSnapshot(t *testing.T) {
	_, handle := openControlRepository(t)
	seedControlComputer(t, handle, "active")
	seedControlRunningAgent(t, handle)
	stale, err := handle.Client().Agent.Get(context.Background(), controlRepoAgentID)
	if err != nil {
		t.Fatal(err)
	}
	winnerLaunchID := "01989c24-7540-7f12-a27b-c83243215dda"
	if _, err := handle.Client().Agent.UpdateOneID(controlRepoAgentID).
		SetCurrentLaunchID(winnerLaunchID).
		SetCurrentLaunchAssignmentEpoch(controlRepoEpoch).
		SetCurrentLaunchGeneration(6).
		SetCurrentLaunchCredentialVersion(2).
		SetCurrentLaunchAttempt(1).
		SetCurrentLaunchUpdatedAt(controlRepoNow.Add(time.Minute)).
		Save(context.Background()); err != nil {
		t.Fatal(err)
	}
	request := computercontrolport.AgentLaunchRequest{
		ServerID:                  controlRepoServerID,
		ComputerID:                controlRepoComputerID,
		ComputerCredentialVersion: 1,
		AgentID:                   controlRepoAgentID,
		LaunchID:                  "01989c24-7540-7f12-a27b-c83243215ddc",
		AssignmentEpoch:           controlRepoEpoch,
		AssignmentRevision:        4,
		ConfigGeneration:          6,
		CredentialVersion:         2,
		RequestedAt:               controlRepoNow.Add(2 * time.Minute),
	}
	err = handle.WithTx(context.Background(), func(ctx context.Context, tx *ent.Tx) error {
		_, err := replaceAgentLaunch(ctx, tx, stale, request)
		return err
	})
	if !errors.Is(err, computercontrolport.ErrLaunchConflict) {
		t.Fatalf("replaceAgentLaunch() error = %v", err)
	}
}

func openControlRepository(t *testing.T) (*EntRepository, *database.Handle) {
	t.Helper()
	directory := filepath.Join(t.TempDir(), "data")
	if err := os.MkdirAll(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	cfg, err := config.NewDatabase(filepath.Join(directory, "chatserver.db"))
	if err != nil {
		t.Fatal(err)
	}
	handle, err := database.OpenWriter(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = handle.Close() })
	if err := migration.Apply(context.Background(), handle.SQLDB()); err != nil {
		t.Fatal(err)
	}
	repository, err := NewEntRepository(handle)
	if err != nil {
		t.Fatal(err)
	}
	return repository, handle
}

func seedControlComputer(t *testing.T, handle *database.Handle, state string) {
	t.Helper()
	_, err := handle.Client().Computer.Create().
		SetID(controlRepoComputerID).
		SetServerID(controlRepoServerID).
		SetName("Computer").
		SetTatRegion("ap-guangzhou").
		SetTatInstanceKind("managed").
		SetOsType("macos").
		SetLifecycleState(state).
		SetTatAgentState("online").
		SetAssignmentEpoch(controlRepoEpoch).
		SetAssignmentRevision(4).
		SetRevision(1).
		SetCreatedAt(controlRepoNow).
		SetUpdatedAt(controlRepoNow).
		Save(context.Background())
	if err != nil {
		t.Fatal(err)
	}
}

func seedControlCredential(t *testing.T, handle *database.Handle, state string, expiresAt time.Time) {
	t.Helper()
	digest := sha256.Sum256([]byte("computer-secret"))
	_, err := handle.Client().ComputerRuntimeCredential.Create().
		SetID(controlRepoCredentialID).
		SetServerID(controlRepoServerID).
		SetComputerID(controlRepoComputerID).
		SetVersion(1).
		SetSecretHash(digest[:]).
		SetState(state).
		SetExpiresAt(expiresAt).
		SetCreatedAt(controlRepoNow).
		Save(context.Background())
	if err != nil {
		t.Fatal(err)
	}
}

func seedControlRunningAgent(t *testing.T, handle *database.Handle) {
	t.Helper()
	_, err := handle.Client().Agent.Create().
		SetID(controlRepoAgentID).
		SetServerID(controlRepoServerID).
		SetImUserID("a_control_launch").
		SetComputerID(controlRepoComputerID).
		SetRuntimeKind("codex").
		SetReplyPolicy("mention_and_dm").
		SetDesiredState("running").
		SetObservedState("running").
		SetCredentialVersion(2).
		SetImState("ready").
		SetHostLastSeenAt(controlRepoNow).
		SetCreatedByMemberID(controlRepoMemberID).
		SetRevision(6).
		SetCreatedAt(controlRepoNow).
		SetUpdatedAt(controlRepoNow).
		Save(context.Background())
	if err != nil {
		t.Fatal(err)
	}
}
