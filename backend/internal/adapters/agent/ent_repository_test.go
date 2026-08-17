package agent

import (
	"context"
	"crypto/sha256"
	"errors"
	"path/filepath"
	"testing"
	"time"

	computercontroladapter "chatserver/internal/adapters/computercontrol"
	"chatserver/internal/config"
	"chatserver/internal/database"
	"chatserver/internal/database/migration"
	"chatserver/internal/ent/agent"
	"chatserver/internal/ent/agentruntimecredential"
	"chatserver/internal/ent/channelmember"
	"chatserver/internal/ent/outboxevent"
	"chatserver/internal/ent/reminderoccurrence"
	"chatserver/internal/ent/tencentoperation"
	agentport "chatserver/internal/ports/agent"
)

const (
	repoAgentAccountID    = "0198f4c2-7a30-7c91-a6d2-7d76f9188c37"
	repoAgentServerID     = "0198f4c2-7a31-7c91-a6d2-7d76f9188c38"
	repoAgentOwnerID      = "0198f4c2-7a32-7d02-b8c1-3f6e15aa91b4"
	repoAgentComputerID   = "0198f4c2-7a35-7af3-a01e-0fcb31e9d84c"
	repoAgentID           = "0198f4c2-7a36-7e45-913c-6baf30401a82"
	repoAgentIMOperation  = "0198f4c2-7a37-7e45-913c-6baf30401a83"
	repoAgentTATOperation = "0198f4c2-7a38-7e45-913c-6baf30401a84"
	repoAgentCredentialID = "0198f4c2-7a39-7e45-913c-6baf30401a85"
	repoAgentDeleteOp     = "0198f4c2-7a40-7e45-913c-6baf30401a86"
	repoAgentChannelID    = "0198f4c2-7a41-7e45-913c-6baf30401a87"
	repoAgentChannelMemID = "0198f4c2-7a42-7e45-913c-6baf30401a88"
	repoAgentOpenTaskID   = "0198f4c2-7a43-7e45-913c-6baf30401a89"
	repoAgentDoneTaskID   = "0198f4c2-7a44-7e45-913c-6baf30401a8a"
	repoAgentReminderID   = "0198f4c2-7a45-7e45-913c-6baf30401a8b"
	repoAgentOccurrenceID = "0198f4c2-7a46-7e45-913c-6baf30401a8c"
	repoAgentProfileOp    = "0198f4c2-7a47-7e45-913c-6baf30401a8d"
)

var repoAgentNow = time.Date(2026, 7, 31, 0, 0, 0, 0, time.UTC)

func TestEntRepositoryCreatesListsAndGetsAgent(t *testing.T) {
	repository, handle := openAgentRepository(t)
	seedAgentServer(t, handle)
	command := createAgentCommand()
	result, err := repository.Create(context.Background(), command)
	if err != nil {
		t.Fatal(err)
	}
	if result.Agent.ID != repoAgentID ||
		result.Agent.IMState != "provisioning" ||
		result.Operation.Kind != "im.identity.ensure" {
		t.Fatalf("Create() = %#v", result)
	}
	machine, err := handle.Client().Computer.Get(context.Background(), repoAgentComputerID)
	if err != nil || machine.AssignmentRevision != 2 {
		t.Fatalf("assignment revision after create = %v, %v", machine.AssignmentRevision, err)
	}
	member, err := handle.Client().Member.Get(
		context.Background(),
		repoAgentID,
	)
	if err != nil || member.Kind != "agent" ||
		member.Handle != "xiaozhou" || member.ActiveHandleKey == nil ||
		*member.ActiveHandleKey != "xiaozhou" {
		t.Fatalf("member = (%#v, %v)", member, err)
	}
	replay := command
	replay.Agent.ID = "0198f4c2-7a46-7e45-913c-6baf30401a82"
	replay.OperationID = "0198f4c2-7a47-7e45-913c-6baf30401a83"
	replayed, err := repository.Create(context.Background(), replay)
	if err != nil || replayed.Agent.ID != repoAgentID ||
		replayed.Operation.ID != repoAgentIMOperation {
		t.Fatalf("Create(replay) = (%#v, %v)", replayed, err)
	}
	machine, err = handle.Client().Computer.Get(context.Background(), repoAgentComputerID)
	if err != nil || machine.AssignmentRevision != 2 {
		t.Fatalf("assignment revision after replay = %v, %v", machine.AssignmentRevision, err)
	}
	values, err := repository.List(
		context.Background(),
		repoAgentAccountID,
		repoAgentServerID,
	)
	if err != nil || len(values) != 1 || values[0].ID != repoAgentID {
		t.Fatalf("List() = (%#v, %v)", values, err)
	}
	value, err := repository.Get(
		context.Background(),
		repoAgentAccountID,
		repoAgentServerID,
		repoAgentID,
	)
	if err != nil || value.DisplayName != "小舟" {
		t.Fatalf("Get() = (%#v, %v)", value, err)
	}
}

func TestEntRepositoryBeginsProfileCapabilityRefreshAtomically(t *testing.T) {
	repository, handle := openAgentRepository(t)
	seedAgentServer(t, handle)
	if _, err := repository.Create(context.Background(), createAgentCommand()); err != nil {
		t.Fatal(err)
	}
	command := agentport.ProfileCapabilityRefreshCommand{
		AccountID: repoAgentAccountID, ServerID: repoAgentServerID,
		AgentID: repoAgentID, ComputerID: repoAgentComputerID,
		RuntimeKind: "codex", ContextGeneration: 1,
		AuthorityContextKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
		ForceReload:         true, Trigger: "human",
		IdempotencyKey: "profile-refresh-0001",
		RequestHash:    sha256.Sum256([]byte("profile-refresh")),
		OperationID:    repoAgentProfileOp, CreatedAt: repoAgentNow.Add(time.Minute),
		DeadlineAt: repoAgentNow.Add(3 * time.Minute),
	}
	operation, err := repository.BeginProfileCapabilityRefresh(context.Background(), command)
	if err != nil {
		t.Fatal(err)
	}
	storedAgent, err := handle.Client().Agent.Get(context.Background(), repoAgentID)
	if err != nil || storedAgent.ProfileCapabilityRefreshID == nil ||
		*storedAgent.ProfileCapabilityRefreshID != repoAgentProfileOp {
		t.Fatalf("stored Agent = (%#v, %v)", storedAgent, err)
	}
	storedOperation, err := handle.Client().TencentOperation.Get(
		context.Background(), repoAgentProfileOp,
	)
	if err != nil || operation.Kind != "agent.profile.capabilities.refresh" ||
		storedOperation.RequestSnapshotJSON == nil || storedOperation.DeadlineAt == nil {
		t.Fatalf("operation = (%#v, %#v, %v)", operation, storedOperation, err)
	}
	machine, err := handle.Client().Computer.Get(context.Background(), repoAgentComputerID)
	if err != nil || machine.AssignmentRevision != 3 {
		t.Fatalf("assignment revision = (%d, %v)", machine.AssignmentRevision, err)
	}
	computerRepository, err := computercontroladapter.NewEntRepository(handle)
	if err != nil {
		t.Fatal(err)
	}
	snapshot, err := computerRepository.GetAssignmentSnapshot(
		context.Background(), repoAgentServerID, repoAgentComputerID,
	)
	if err != nil || len(snapshot.Agents) != 1 ||
		snapshot.Agents[0].ProfileCapabilityRefresh == nil ||
		snapshot.Agents[0].ProfileCapabilityRefresh.RefreshID != repoAgentProfileOp ||
		snapshot.Agents[0].ProfileCapabilityRefresh.ContextGeneration != 1 {
		t.Fatalf("Assignment Profile refresh = (%#v, %v)", snapshot, err)
	}
	replay := command
	replay.OperationID = "0198f4c2-7a48-7e45-913c-6baf30401a8e"
	replayed, err := repository.BeginProfileCapabilityRefresh(context.Background(), replay)
	if err != nil || replayed.ID != repoAgentProfileOp {
		t.Fatalf("replay = (%#v, %v)", replayed, err)
	}
	machine, _ = handle.Client().Computer.Get(context.Background(), repoAgentComputerID)
	if machine.AssignmentRevision != 3 {
		t.Fatalf("replay assignment revision = %d", machine.AssignmentRevision)
	}
	completed, err := repository.CompleteProfileCapabilityRefresh(
		context.Background(),
		agentport.ProfileCapabilityResultCommand{
			ServerID: repoAgentServerID, ComputerID: repoAgentComputerID,
			AgentID: repoAgentID, OperationID: repoAgentProfileOp,
			ContextGeneration:   1,
			AuthorityContextKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
			Succeeded:           true, ResultJSON: []byte(`{"models":[],"skills":[]}`),
			ResultHash:  sha256.Sum256([]byte(`{"models":[],"skills":[]}`)),
			CompletedAt: repoAgentNow.Add(2 * time.Minute),
		},
	)
	if err != nil || !completed.Accepted || completed.Reason != "accepted" {
		t.Fatalf("CompleteProfileCapabilityRefresh() = (%#v, %v)", completed, err)
	}
	storedAgent, _ = handle.Client().Agent.Get(context.Background(), repoAgentID)
	storedOperation, _ = handle.Client().TencentOperation.Get(
		context.Background(), repoAgentProfileOp,
	)
	if storedAgent.ProfileCapabilityRefreshID != nil ||
		storedAgent.ProfileCapabilitiesJSON == nil || storedOperation.State != "succeeded" ||
		storedOperation.ResultJSON == nil {
		t.Fatalf("completed Agent/Operation = (%#v, %#v)", storedAgent, storedOperation)
	}
}

func TestEntRepositoryRejectsDuplicateActiveAgentHandle(t *testing.T) {
	repository, handle := openAgentRepository(t)
	seedAgentServer(t, handle)
	if _, err := repository.Create(context.Background(), createAgentCommand()); err != nil {
		t.Fatal(err)
	}

	duplicate := createAgentCommand()
	duplicate.Agent.ID = "0198f4c2-7a4b-7e45-913c-6baf30401a91"
	duplicate.Agent.IMUserID = "a_DUPLICATEHANDLEUSER23456789012"
	duplicate.IdempotencyKey = "agent-create-duplicate-handle-0001"
	duplicate.RequestHash = sha256.Sum256([]byte("duplicate active handle"))
	duplicate.OperationID = "0198f4c2-7a4c-7e45-913c-6baf30401a92"
	duplicate.CreatedAt = repoAgentNow.Add(time.Minute)

	_, err := repository.Create(context.Background(), duplicate)
	if !errors.Is(err, agentport.ErrHandleConflict) {
		t.Fatalf("Create(duplicate active handle) error = %v", err)
	}
}

func TestEntRepositoryRejectsAgentWithoutComputer(t *testing.T) {
	repository, handle := openAgentRepository(t)
	seedAgentServer(t, handle)
	command := createAgentCommand()
	command.Agent.ComputerID = nil

	_, err := repository.Create(context.Background(), command)
	if !errors.Is(err, agentport.ErrComputerNotReady) {
		t.Fatalf("Create() error = %v", err)
	}
	count, countErr := handle.Client().Agent.Query().Count(context.Background())
	if countErr != nil || count != 0 {
		t.Fatalf("stored Agent count = (%d, %v)", count, countErr)
	}
}

func TestEntRepositoryAllowsBindingOfflineManagedComputer(t *testing.T) {
	repository, handle := openAgentRepository(t)
	seedAgentServer(t, handle)
	if _, err := handle.Client().Computer.UpdateOneID(repoAgentComputerID).
		SetTatAgentState("offline").
		Save(context.Background()); err != nil {
		t.Fatal(err)
	}

	result, err := repository.Create(context.Background(), createAgentCommand())
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if result.Agent.ComputerID == nil ||
		*result.Agent.ComputerID != repoAgentComputerID {
		t.Fatalf("Create() = %#v", result)
	}
}

func TestEntRepositoryRejectsClearingComputerBinding(t *testing.T) {
	repository, handle := openAgentRepository(t)
	seedAgentServer(t, handle)
	if _, err := repository.Create(
		context.Background(), createAgentCommand(),
	); err != nil {
		t.Fatal(err)
	}

	_, err := repository.Update(context.Background(), agentport.UpdateCommand{
		AccountID: repoAgentAccountID, ServerID: repoAgentServerID,
		AgentID: repoAgentID, Revision: 1,
		IdempotencyKey: "agent-clear-computer-0001",
		RequestHash:    sha256.Sum256([]byte("agent-clear-computer")),
		Patch: agentport.UpdatePatch{
			ComputerIDSet: true,
			ComputerID:    nil,
		},
		UpdatedAt: repoAgentNow.Add(time.Minute),
	})
	if !errors.Is(err, agentport.ErrComputerNotReady) {
		t.Fatalf("Update() error = %v", err)
	}
	stored, getErr := handle.Client().Agent.Get(context.Background(), repoAgentID)
	if getErr != nil || stored.ComputerID == nil ||
		*stored.ComputerID != repoAgentComputerID {
		t.Fatalf("stored Agent = (%#v, %v)", stored, getErr)
	}
}

func TestEntRepositoryDeletesAgentAsOneServerShardTransaction(t *testing.T) {
	repository, handle := openAgentRepository(t)
	seedAgentServer(t, handle)
	if _, err := repository.Create(context.Background(), createAgentCommand()); err != nil {
		t.Fatal(err)
	}
	markAgentIMReady(t, handle)
	seedAgentDeleteRelations(t, handle)

	deletedAt := repoAgentNow.Add(3 * time.Minute)
	command := agentport.DeleteCommand{
		AccountID: repoAgentAccountID, ServerID: repoAgentServerID,
		AgentID: repoAgentID, IdempotencyKey: "agent-delete-0001",
		RequestHash: sha256.Sum256([]byte("agent.delete")),
		OperationID: repoAgentDeleteOp, DeletedAt: deletedAt,
	}
	operation, err := repository.Delete(context.Background(), command)
	if err != nil {
		t.Fatalf("Delete() error = %v; cause = %v", err, errors.Unwrap(err))
	}
	if operation.ID != repoAgentDeleteOp || operation.Service != "im" ||
		operation.Kind != "im.identity.delete" || operation.State != "pending" {
		t.Fatalf("Delete() = %#v", operation)
	}

	entity, err := handle.Client().Agent.Get(context.Background(), repoAgentID)
	if err != nil || entity.DeletedAt == nil || !entity.DeletedAt.Equal(deletedAt) ||
		entity.DesiredState != "stopped" || entity.ImState != "deleting" {
		t.Fatalf("deleted Agent = (%#v, %v)", entity, err)
	}
	agentMember, err := handle.Client().Member.Get(context.Background(), repoAgentID)
	if err != nil || agentMember.Status != "removed" {
		t.Fatalf("deleted Member = (%#v, %v)", agentMember, err)
	}
	credential, err := handle.Client().AgentRuntimeCredential.Query().
		Where(agentruntimecredential.AgentIDEQ(repoAgentID)).Only(context.Background())
	if err != nil || credential.State != "revoked" || credential.RevokedAt == nil {
		t.Fatalf("runtime credential = (%#v, %v)", credential, err)
	}
	channelProjection, err := handle.Client().ChannelMember.Query().
		Where(channelmember.MemberIDEQ(repoAgentID)).Only(context.Background())
	if err != nil || channelProjection.State != "removed" ||
		channelProjection.ImState != "removing" {
		t.Fatalf("channel membership = (%#v, %v)", channelProjection, err)
	}
	openTask, err := handle.Client().Task.Get(context.Background(), repoAgentOpenTaskID)
	if err != nil || openTask.OwnerMemberID != nil || openTask.AssignmentRevision != 2 {
		t.Fatalf("open task = (%#v, %v)", openTask, err)
	}
	doneTask, err := handle.Client().Task.Get(context.Background(), repoAgentDoneTaskID)
	if err != nil || doneTask.OwnerMemberID == nil || *doneTask.OwnerMemberID != repoAgentID {
		t.Fatalf("done task = (%#v, %v)", doneTask, err)
	}
	reminder, err := handle.Client().Reminder.Get(context.Background(), repoAgentReminderID)
	if err != nil || reminder.Status != "canceled" || reminder.NextFireAt != nil {
		t.Fatalf("reminder = (%#v, %v)", reminder, err)
	}
	occurrence, err := handle.Client().ReminderOccurrence.Query().
		Where(reminderoccurrence.IDEQ(repoAgentOccurrenceID)).Only(context.Background())
	if err != nil || occurrence.State != "canceled" {
		t.Fatalf("reminder occurrence = (%#v, %v)", occurrence, err)
	}
	machine, err := handle.Client().Computer.Get(context.Background(), repoAgentComputerID)
	if err != nil || machine.AssignmentRevision != 3 {
		t.Fatalf("assignment revision after delete = (%#v, %v)", machine, err)
	}
	if _, err := repository.Get(
		context.Background(), repoAgentAccountID, repoAgentServerID, repoAgentID,
	); err != agentport.ErrAgentNotFound {
		t.Fatalf("Get(deleted) error = %v", err)
	}
	values, err := repository.List(context.Background(), repoAgentAccountID, repoAgentServerID)
	if err != nil || len(values) != 0 {
		t.Fatalf("List(deleted) = (%#v, %v)", values, err)
	}

	replay := command
	replay.OperationID = "0198f4c2-7a47-7e45-913c-6baf30401a8d"
	replayed, err := repository.Delete(context.Background(), replay)
	if err != nil || replayed.ID != repoAgentDeleteOp {
		t.Fatalf("Delete(replay) = (%#v, %v)", replayed, err)
	}
	newKey := command
	newKey.IdempotencyKey = "agent-delete-0002"
	newKey.OperationID = "0198f4c2-7a48-7e45-913c-6baf30401a8e"
	reused, err := repository.Delete(context.Background(), newKey)
	if err != nil || reused.ID != repoAgentDeleteOp {
		t.Fatalf("Delete(new key after tombstone) = (%#v, %v)", reused, err)
	}
	machine, err = handle.Client().Computer.Get(context.Background(), repoAgentComputerID)
	if err != nil || machine.AssignmentRevision != 3 {
		t.Fatalf("assignment revision after replay = (%#v, %v)", machine, err)
	}
	pending, err := handle.Client().TencentOperation.Query().Where(
		tencentoperation.KindEQ("im.identity.delete"),
		tencentoperation.ResourceIDEQ(repoAgentID),
	).Count(context.Background())
	if err != nil || pending != 1 {
		t.Fatalf("delete operation count = (%d, %v)", pending, err)
	}

	replacement := createAgentCommand()
	replacement.Agent.ID = "0198f4c2-7a49-7e45-913c-6baf30401a8f"
	replacement.Agent.IMUserID = "a_REPLACEMENTAGENTUSER2345678901"
	replacement.IdempotencyKey = "agent-create-replacement-0001"
	replacement.RequestHash = sha256.Sum256([]byte("agent replacement"))
	replacement.OperationID = "0198f4c2-7a4a-7e45-913c-6baf30401a90"
	replacement.CreatedAt = deletedAt.Add(time.Minute)
	created, err := repository.Create(context.Background(), replacement)
	if err != nil || created.Agent.ID != replacement.Agent.ID {
		cause := err
		for cause != nil && errors.Unwrap(cause) != nil {
			cause = errors.Unwrap(cause)
		}
		t.Fatalf(
			"Create(reusing deleted handle) = (%#v, %v); root cause = %v",
			created, err, cause,
		)
	}
	historical, err := handle.Client().Member.Get(context.Background(), repoAgentID)
	if err != nil || historical.Handle != replacement.Agent.Handle ||
		historical.Status != "removed" || historical.ActiveHandleKey != nil {
		t.Fatalf("historical Member = (%#v, %v)", historical, err)
	}
}

func TestEntRepositoryUpdatesAgentConfigurationIdempotently(t *testing.T) {
	repository, handle := openAgentRepository(t)
	seedAgentServer(t, handle)
	if _, err := repository.Create(
		context.Background(),
		createAgentCommand(),
	); err != nil {
		t.Fatal(err)
	}
	name := "新小舟"
	policy := "dm_only"
	runtime := agentport.Runtime{Kind: "claude"}
	command := agentport.UpdateCommand{
		AccountID: repoAgentAccountID, ServerID: repoAgentServerID,
		AgentID: repoAgentID, Revision: 1,
		IdempotencyKey: "agent-update-0001",
		RequestHash:    sha256.Sum256([]byte("agent-update")),
		Patch: agentport.UpdatePatch{
			DisplayName: &name, Runtime: &runtime, ReplyPolicy: &policy,
		},
		UpdatedAt: repoAgentNow.Add(time.Minute),
	}
	value, err := repository.Update(context.Background(), command)
	if err != nil {
		t.Fatal(err)
	}
	if value.DisplayName != name ||
		value.Runtime.Kind != "claude" ||
		value.ReplyPolicy != "dm_only" ||
		value.Revision != 2 {
		t.Fatalf("Update() = %#v", value)
	}
	replayed, err := repository.Update(context.Background(), command)
	if err != nil || replayed.Revision != 2 ||
		replayed.DisplayName != name {
		t.Fatalf("Update(replay) = (%#v, %v)", replayed, err)
	}
	stored, err := handle.Client().Agent.Get(
		context.Background(),
		repoAgentID,
	)
	if err != nil || stored.Revision != 2 ||
		stored.RuntimeKind != "claude" {
		t.Fatalf("stored Agent = (%#v, %v)", stored, err)
	}
	machine, err := handle.Client().Computer.Get(context.Background(), repoAgentComputerID)
	if err != nil || machine.AssignmentRevision != 3 {
		t.Fatalf("assignment revision after update = %v, %v", machine.AssignmentRevision, err)
	}
}

func TestEntRepositoryRejectsDeployWithoutActiveCredential(t *testing.T) {
	repository, handle := openAgentRepository(t)
	seedAgentServer(t, handle)
	if _, err := repository.Create(
		context.Background(),
		createAgentCommand(),
	); err != nil {
		t.Fatal(err)
	}
	markAgentIMReady(t, handle)

	_, err := repository.ApplyLifecycle(
		context.Background(),
		agentport.LifecycleCommand{
			AccountID: repoAgentAccountID, ServerID: repoAgentServerID,
			AgentID: repoAgentID, Kind: "agent.deploy",
			IdempotencyKey: "agent-deploy-without-credential-0001",
			RequestHash:    sha256.Sum256([]byte("deploy")),
			OperationID:    repoAgentTATOperation, CreatedAt: repoAgentNow,
		},
	)
	if !errors.Is(err, agentport.ErrCredentialMissing) {
		t.Fatalf("ApplyLifecycle() error = %v", err)
	}
}

func TestEntRepositoryAppliesVelaLifecycleSynchronously(t *testing.T) {
	repository, handle := openAgentRepository(t)
	seedAgentServer(t, handle)
	if _, err := repository.Create(
		context.Background(),
		createAgentCommand(),
	); err != nil {
		t.Fatal(err)
	}
	markAgentIMReady(t, handle)
	if _, err := repository.RotateCredential(
		context.Background(),
		agentport.CredentialCommand{
			AccountID: repoAgentAccountID, ServerID: repoAgentServerID,
			AgentID: repoAgentID, Version: 1,
			CredentialID:   repoAgentCredentialID,
			SecretHash:     sha256.Sum256([]byte("deploy-agent-secret")),
			IdempotencyKey: "agent-deploy-credential-0001",
			RequestHash:    sha256.Sum256([]byte("1")),
			OperationID:    "0198f4c2-7a50-7e45-913c-6baf30401a84",
			CreatedAt:      repoAgentNow,
		},
	); err != nil {
		t.Fatal(err)
	}
	operation, err := repository.ApplyLifecycle(
		context.Background(),
		agentport.LifecycleCommand{
			AccountID: repoAgentAccountID, ServerID: repoAgentServerID,
			AgentID: repoAgentID, Kind: "agent.deploy",
			IdempotencyKey: "agent-deploy-0001",
			RequestHash:    sha256.Sum256([]byte("deploy")),
			OperationID:    repoAgentTATOperation, CreatedAt: repoAgentNow,
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	entity, err := handle.Client().Agent.Get(
		context.Background(),
		repoAgentID,
	)
	if err != nil {
		t.Fatal(err)
	}
	if operation.Service != "platform" ||
		operation.Kind != "agent.deploy" ||
		operation.State != "succeeded" ||
		operation.CompletedAt == nil ||
		entity.DesiredState != "stopped" ||
		entity.ObservedState != "stopped" ||
		entity.CredentialVersion != 1 ||
		entity.Revision != 3 {
		t.Fatalf("operation=%#v agent=%#v", operation, entity)
	}
	machine, err := handle.Client().Computer.Get(context.Background(), repoAgentComputerID)
	if err != nil || machine.AssignmentRevision != 4 {
		t.Fatalf("assignment revision after lifecycle = %v, %v", machine.AssignmentRevision, err)
	}
}

func TestEntRepositoryActivatesCredentialAndStartsVelaAssignment(t *testing.T) {
	repository, handle := openAgentRepository(t)
	seedAgentServer(t, handle)
	if _, err := repository.Create(
		context.Background(),
		createAgentCommand(),
	); err != nil {
		t.Fatal(err)
	}
	markAgentIMReady(t, handle)
	command := agentport.CredentialCommand{
		AccountID: repoAgentAccountID, ServerID: repoAgentServerID,
		AgentID: repoAgentID, Version: 1,
		CredentialID:   repoAgentCredentialID,
		SecretHash:     sha256.Sum256([]byte("test-agent-secret")),
		IdempotencyKey: "agent-credential-0001",
		RequestHash:    sha256.Sum256([]byte("1")),
		OperationID:    repoAgentTATOperation, CreatedAt: repoAgentNow,
	}
	result, err := repository.RotateCredential(context.Background(), command)
	if err != nil {
		t.Fatal(err)
	}
	if !result.Created ||
		result.Operation.Service != "platform" ||
		result.Operation.Kind != "agent.credential.rotate" ||
		result.Operation.State != "succeeded" ||
		result.Operation.CompletedAt == nil {
		t.Fatalf("RotateCredential() = %#v", result)
	}
	credential, err := handle.Client().AgentRuntimeCredential.Query().
		Where(
			agentruntimecredential.AgentIDEQ(repoAgentID),
			agentruntimecredential.VersionEQ(1),
		).
		Only(context.Background())
	if err != nil || credential.State != "active" || credential.RevokedAt != nil {
		t.Fatalf("credential = (%#v, %v)", credential, err)
	}
	entity, err := handle.Client().Agent.Query().
		Where(agent.IDEQ(repoAgentID)).
		Only(context.Background())
	if err != nil || entity.Revision != 2 || entity.CredentialVersion != 1 {
		t.Fatalf("agent = (%#v, %v)", entity, err)
	}
	replay := command
	replay.CredentialID = "0198f4c2-7a49-7e45-913c-6baf30401a85"
	replay.OperationID = "0198f4c2-7a48-7e45-913c-6baf30401a84"
	replayed, err := repository.RotateCredential(context.Background(), replay)
	if err != nil || replayed.Created ||
		replayed.Operation.ID != repoAgentTATOperation {
		t.Fatalf("RotateCredential(replay) = (%#v, %v)", replayed, err)
	}
	operation, err := repository.ApplyLifecycle(
		context.Background(),
		agentport.LifecycleCommand{
			AccountID: repoAgentAccountID, ServerID: repoAgentServerID,
			AgentID: repoAgentID, Kind: "agent.start",
			IdempotencyKey: "agent-start-0001",
			RequestHash:    sha256.Sum256([]byte("start")),
			OperationID:    "0198f4c2-7a58-7e45-913c-6baf30401a84",
			CreatedAt:      repoAgentNow,
		},
	)
	if err != nil || operation.Service != "platform" ||
		operation.Kind != "agent.start" || operation.State != "succeeded" {
		t.Fatalf("ApplyLifecycle() = (%#v, %v)", operation, err)
	}
	entity, err = handle.Client().Agent.Get(context.Background(), repoAgentID)
	if err != nil || entity.DesiredState != "running" ||
		entity.ObservedState != "starting" || entity.Revision != 3 {
		t.Fatalf("started Agent = (%#v, %v)", entity, err)
	}
	machine, err := handle.Client().Computer.Get(
		context.Background(),
		repoAgentComputerID,
	)
	if err != nil || machine.AssignmentRevision != 4 {
		t.Fatalf("assignment revision = (%#v, %v)", machine, err)
	}
	outboxCount, err := handle.Client().OutboxEvent.Query().
		Where(outboxevent.ServerIDEQ(repoAgentServerID)).
		Count(context.Background())
	if err != nil || outboxCount != 1 {
		t.Fatalf("outbox count = (%d, %v)", outboxCount, err)
	}
}

func TestEntRepositoryReplacesNeverActivatedRevokedCredentialVersion(t *testing.T) {
	repository, handle := openAgentRepository(t)
	seedAgentServer(t, handle)
	if _, err := repository.Create(
		context.Background(),
		createAgentCommand(),
	); err != nil {
		t.Fatal(err)
	}
	markAgentIMReady(t, handle)
	const revokedCredentialID = "0198f4c2-7a40-7e45-913c-6baf30401a86"
	failedDigest := sha256.Sum256([]byte("failed-secret"))
	if _, err := handle.Client().AgentRuntimeCredential.Create().
		SetID(revokedCredentialID).
		SetServerID(repoAgentServerID).
		SetAgentID(repoAgentID).
		SetVersion(1).
		SetSecretHash(failedDigest[:]).
		SetState("revoked").
		SetCreatedAt(repoAgentNow.Add(-time.Minute)).
		SetRevokedAt(repoAgentNow.Add(-30 * time.Second)).
		Save(context.Background()); err != nil {
		t.Fatal(err)
	}
	command := agentport.CredentialCommand{
		AccountID: repoAgentAccountID, ServerID: repoAgentServerID,
		AgentID: repoAgentID, Version: 1,
		CredentialID:   repoAgentCredentialID,
		SecretHash:     sha256.Sum256([]byte("replacement-secret")),
		IdempotencyKey: "agent-credential-retry-0001",
		RequestHash:    sha256.Sum256([]byte("retry")),
		OperationID:    repoAgentTATOperation, CreatedAt: repoAgentNow,
	}

	result, err := repository.RotateCredential(context.Background(), command)

	if err != nil || !result.Created {
		t.Fatalf("RotateCredential() = (%#v, %v)", result, err)
	}
	credentials, err := handle.Client().AgentRuntimeCredential.Query().
		Where(
			agentruntimecredential.AgentIDEQ(repoAgentID),
			agentruntimecredential.VersionEQ(1),
		).
		All(context.Background())
	if err != nil || len(credentials) != 1 ||
		credentials[0].ID != repoAgentCredentialID ||
		credentials[0].State != "active" {
		t.Fatalf("replacement credentials = (%#v, %v)", credentials, err)
	}
}

func TestEntRepositoryRotatesRunningAgentCredentialWithoutStoppingRuntime(t *testing.T) {
	repository, handle := openAgentRepository(t)
	seedAgentServer(t, handle)
	if _, err := repository.Create(
		context.Background(),
		createAgentCommand(),
	); err != nil {
		t.Fatal(err)
	}
	markAgentIMReady(t, handle)
	first := agentport.CredentialCommand{
		AccountID: repoAgentAccountID, ServerID: repoAgentServerID,
		AgentID: repoAgentID, Version: 1,
		CredentialID:   repoAgentCredentialID,
		SecretHash:     sha256.Sum256([]byte("first-secret")),
		IdempotencyKey: "agent-credential-running-0001",
		RequestHash:    sha256.Sum256([]byte("first")),
		OperationID:    repoAgentTATOperation, CreatedAt: repoAgentNow,
	}
	if _, err := repository.RotateCredential(context.Background(), first); err != nil {
		t.Fatal(err)
	}
	if _, err := repository.ApplyLifecycle(
		context.Background(),
		agentport.LifecycleCommand{
			AccountID: repoAgentAccountID, ServerID: repoAgentServerID,
			AgentID: repoAgentID, Kind: "agent.start",
			IdempotencyKey: "agent-running-start-0001",
			RequestHash:    sha256.Sum256([]byte("start")),
			OperationID:    "0198f4c2-7a58-7e45-913c-6baf30401a84",
			CreatedAt:      repoAgentNow.Add(time.Minute),
		},
	); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Client().Agent.UpdateOneID(repoAgentID).
		SetObservedState("running").
		Save(context.Background()); err != nil {
		t.Fatal(err)
	}
	second := agentport.CredentialCommand{
		AccountID: repoAgentAccountID, ServerID: repoAgentServerID,
		AgentID: repoAgentID, Version: 2,
		CredentialID:   "0198f4c2-7a59-7e45-913c-6baf30401a85",
		SecretHash:     sha256.Sum256([]byte("second-secret")),
		IdempotencyKey: "agent-credential-running-0002",
		RequestHash:    sha256.Sum256([]byte("second")),
		OperationID:    "0198f4c2-7a60-7e45-913c-6baf30401a86",
		CreatedAt:      repoAgentNow.Add(2 * time.Minute),
	}
	result, err := repository.RotateCredential(context.Background(), second)
	if err != nil || result.Operation.State != "succeeded" {
		t.Fatalf("RotateCredential(v2) = (%#v, %v)", result, err)
	}
	oldCredential, err := handle.Client().AgentRuntimeCredential.Query().
		Where(
			agentruntimecredential.AgentIDEQ(repoAgentID),
			agentruntimecredential.VersionEQ(1),
		).
		Only(context.Background())
	if err != nil || oldCredential.State != "revoked" ||
		oldCredential.RevokedAt == nil {
		t.Fatalf("old credential = (%#v, %v)", oldCredential, err)
	}
	newCredential, err := handle.Client().AgentRuntimeCredential.Query().
		Where(
			agentruntimecredential.AgentIDEQ(repoAgentID),
			agentruntimecredential.VersionEQ(2),
		).
		Only(context.Background())
	if err != nil || newCredential.State != "active" ||
		newCredential.RevokedAt != nil {
		t.Fatalf("new credential = (%#v, %v)", newCredential, err)
	}
	entity, err := handle.Client().Agent.Get(context.Background(), repoAgentID)
	if err != nil || entity.CredentialVersion != 2 ||
		entity.DesiredState != "running" || entity.ObservedState != "running" {
		t.Fatalf("running Agent = (%#v, %v)", entity, err)
	}
}

func createAgentCommand() agentport.CreateCommand {
	computerID := repoAgentComputerID
	description := "协作 Agent"
	return agentport.CreateCommand{
		AccountID: repoAgentAccountID, ServerID: repoAgentServerID,
		IdempotencyKey: "agent-create-0001",
		RequestHash:    sha256.Sum256([]byte("agent")),
		Agent: agentport.Draft{
			ID: repoAgentID, DisplayName: "小舟", Handle: "xiaozhou",
			Description:     &description,
			IMUserID:        "a_REPOAGENTUSERID23456789012345",
			ComputerID:      &computerID,
			Runtime:         agentport.Runtime{Kind: "codex"},
			ReplyPolicy:     "mention_and_dm",
			CreatorMemberID: repoAgentOwnerID,
		},
		OperationID: repoAgentIMOperation,
		CreatedAt:   repoAgentNow,
	}
}

func openAgentRepository(t *testing.T) (*EntRepository, *database.Handle) {
	t.Helper()
	cfg, err := config.NewDatabase(
		filepath.Join(t.TempDir(), "data", "chatserver.db"),
	)
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

func seedAgentServer(t *testing.T, handle *database.Handle) {
	t.Helper()
	ctx := context.Background()
	if _, err := handle.Client().Server.Create().
		SetID(repoAgentServerID).
		SetSlug("agent-test").
		SetName("Agent 测试").
		SetImGroupID("@TGS#_C_AGENT_TEST").
		SetImState("ready").
		SetOwnerMemberID(repoAgentOwnerID).
		SetNextTaskNumber(1).
		SetRevision(2).
		SetCreatedAt(repoAgentNow).
		SetUpdatedAt(repoAgentNow).
		Save(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Client().Member.Create().
		SetID(repoAgentOwnerID).
		SetServerID(repoAgentServerID).
		SetAccountID(repoAgentAccountID).
		SetKind("human").
		SetRole("owner").
		SetDisplayName("所有者").
		SetHandle("owner").
		SetStatus("active").
		SetImState("ready").
		SetRevision(1).
		SetCreatedAt(repoAgentNow).
		SetUpdatedAt(repoAgentNow).
		Save(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Client().AccountServerMembership.Create().
		SetAccountID(repoAgentAccountID).
		SetServerID(repoAgentServerID).
		SetMemberID(repoAgentOwnerID).
		SetRole("owner").
		SetStatus("active").
		SetServerNameSnapshot("Agent 测试").
		SetServerSlugSnapshot("agent-test").
		SetServerRevision(2).
		SetProjectedAt(repoAgentNow).
		SetUpdatedAt(repoAgentNow).
		Save(ctx); err != nil {
		t.Fatal(err)
	}
	instanceID := "rins-agent-test"
	if _, err := handle.Client().Computer.Create().
		SetID(repoAgentComputerID).
		SetServerID(repoAgentServerID).
		SetName("执行机").
		SetTatRegion("ap-beijing").
		SetTatInstanceID(instanceID).
		SetTatInstanceKind("managed").
		SetOsType("linux").
		SetLifecycleState("active").
		SetTatAgentState("online").
		SetRevision(1).
		SetCreatedAt(repoAgentNow).
		SetUpdatedAt(repoAgentNow).
		Save(ctx); err != nil {
		t.Fatal(err)
	}
}

func markAgentIMReady(t *testing.T, handle *database.Handle) {
	t.Helper()
	ctx := context.Background()
	if _, err := handle.Client().Agent.UpdateOneID(repoAgentID).
		SetImState("ready").
		Save(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Client().Member.UpdateOneID(repoAgentID).
		SetImState("ready").
		Save(ctx); err != nil {
		t.Fatal(err)
	}
}

func seedAgentDeleteRelations(t *testing.T, handle *database.Handle) {
	t.Helper()
	ctx := context.Background()
	secretHash := sha256.Sum256([]byte("delete-test-secret"))
	if _, err := handle.Client().AgentRuntimeCredential.Create().
		SetID(repoAgentCredentialID).
		SetServerID(repoAgentServerID).
		SetAgentID(repoAgentID).
		SetVersion(1).
		SetSecretHash(secretHash[:]).
		SetState("active").
		SetCreatedAt(repoAgentNow).
		Save(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Client().Agent.UpdateOneID(repoAgentID).
		SetCredentialVersion(1).
		SetDesiredState("running").
		SetObservedState("running").
		Save(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Client().Channel.Create().
		SetID(repoAgentChannelID).
		SetServerID(repoAgentServerID).
		SetName("agent-delete").
		SetVisibility("private").
		SetImGroupID("@TGS#_C_AGENT_TEST").
		SetImTopicID("agent-delete-topic").
		SetImState("ready").
		SetRevision(1).
		SetCreatedAt(repoAgentNow).
		SetUpdatedAt(repoAgentNow).
		Save(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Client().ChannelMember.Create().
		SetID(repoAgentChannelMemID).
		SetServerID(repoAgentServerID).
		SetChannelID(repoAgentChannelID).
		SetMemberID(repoAgentID).
		SetState("active").
		SetImState("ready").
		SetMembershipVersion(1).
		SetCreatedAt(repoAgentNow).
		SetUpdatedAt(repoAgentNow).
		Save(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Client().Task.Create().
		SetID(repoAgentOpenTaskID).
		SetServerID(repoAgentServerID).
		SetNumber(1).
		SetTitle("尚未完成").
		SetStatus("in_progress").
		SetOwnerMemberID(repoAgentID).
		SetAssignmentRevision(1).
		SetCreatedByMemberID(repoAgentOwnerID).
		SetUpdatedByMemberID(repoAgentOwnerID).
		SetRevision(1).
		SetCreatedAt(repoAgentNow).
		SetUpdatedAt(repoAgentNow).
		Save(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Client().Task.Create().
		SetID(repoAgentDoneTaskID).
		SetServerID(repoAgentServerID).
		SetNumber(2).
		SetTitle("已经完成").
		SetStatus("done").
		SetOwnerMemberID(repoAgentID).
		SetAssignmentRevision(1).
		SetCreatedByMemberID(repoAgentOwnerID).
		SetUpdatedByMemberID(repoAgentOwnerID).
		SetRevision(1).
		SetCreatedAt(repoAgentNow).
		SetUpdatedAt(repoAgentNow).
		Save(ctx); err != nil {
		t.Fatal(err)
	}
	nextFireAt := repoAgentNow.Add(time.Hour)
	if _, err := handle.Client().Reminder.Create().
		SetID(repoAgentReminderID).
		SetServerID(repoAgentServerID).
		SetAgentID(repoAgentID).
		SetCreatedByMemberID(repoAgentOwnerID).
		SetScheduleKind("once").
		SetSchedule(nextFireAt.Format(time.RFC3339)).
		SetTimezone("Asia/Shanghai").
		SetText("提醒事项").
		SetStatus("active").
		SetNextFireAt(nextFireAt).
		SetRevision(1).
		SetCreatedAt(repoAgentNow).
		SetUpdatedAt(repoAgentNow).
		Save(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Client().ReminderOccurrence.Create().
		SetID(repoAgentOccurrenceID).
		SetServerID(repoAgentServerID).
		SetReminderID(repoAgentReminderID).
		SetAgentID(repoAgentID).
		SetScheduledFireAt(nextFireAt).
		SetState("due").
		SetTextSnapshot("提醒事项").
		SetCreatedAt(repoAgentNow).
		SetUpdatedAt(repoAgentNow).
		Save(ctx); err != nil {
		t.Fatal(err)
	}
}
