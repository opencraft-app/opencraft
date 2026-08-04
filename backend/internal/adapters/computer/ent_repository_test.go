package computer

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"chatserver/internal/config"
	"chatserver/internal/database"
	"chatserver/internal/database/migration"
	"chatserver/internal/ent/accountservermembership"
	computerentity "chatserver/internal/ent/computer"
	computerport "chatserver/internal/ports/computer"
)

const (
	repositoryAccountID   = "0198f4c2-7a30-7c91-a6d2-7d76f9188c37"
	repositoryServerID    = "0198f4c2-7a31-7c91-a6d2-7d76f9188c38"
	repositoryMemberID    = "0198f4c2-7a32-7d02-b8c1-3f6e15aa91b4"
	repositoryComputerID  = "0198f4c2-7a35-7af3-a01e-0fcb31e9d84c"
	repositoryOperationID = "0198f4c2-7a36-7af3-a01e-0fcb31e9d84d"
)

var repositoryNow = time.Date(2026, 7, 30, 22, 30, 0, 0, time.UTC)

func TestEntRepositoryCreatesListsAndGetsComputerThroughMembership(t *testing.T) {
	repository, handle := openComputerRepository(t)
	seedComputerMembership(t, handle)
	instanceID := "ins-test0001"
	command := computerport.CreateCommand{
		AccountID:      repositoryAccountID,
		ServerID:       repositoryServerID,
		IdempotencyKey: "computer-create-0001",
		RequestHash:    sha256.Sum256([]byte("native")),
		CreatedAt:      repositoryNow,
		Computer: computerport.Draft{
			ID: repositoryComputerID, Name: "北京执行机",
			TATRegion: "ap-beijing", TATInstanceID: &instanceID,
			TATInstanceKind: "cvm", OSType: "linux",
			LifecycleState: "active",
		},
	}
	created, err := repository.Create(context.Background(), command)
	if err != nil {
		t.Fatal(err)
	}
	if created.ID != repositoryComputerID ||
		created.TATAgentState != "unknown" ||
		created.Revision != 1 {
		t.Fatalf("Create() = %#v", created)
	}
	replay := command
	replay.Computer.ID = "0198f4c2-7a45-7af3-a01e-0fcb31e9d84c"
	replayed, err := repository.Create(context.Background(), replay)
	if err != nil || replayed.ID != repositoryComputerID {
		t.Fatalf("Create(replay) = (%#v, %v)", replayed, err)
	}
	values, err := repository.List(
		context.Background(), repositoryAccountID, repositoryServerID,
	)
	if err != nil || len(values) != 1 || values[0].ID != repositoryComputerID {
		t.Fatalf("List() = (%#v, %v)", values, err)
	}
	value, err := repository.Get(
		context.Background(),
		repositoryAccountID,
		repositoryServerID,
		repositoryComputerID,
	)
	if err != nil || value.Name != "北京执行机" {
		t.Fatalf("Get() = (%#v, %v)", value, err)
	}
	if count, err := handle.Client().IdempotencyRecord.Query().Count(
		context.Background(),
	); err != nil || count != 1 {
		t.Fatalf("idempotency count=(%d, %v)", count, err)
	}
}

func TestEntRepositoryAllowsDuplicateComputerDisplayNames(t *testing.T) {
	repository, handle := openComputerRepository(t)
	seedComputerMembership(t, handle)
	ctx := context.Background()
	for index, computerID := range []string{
		repositoryComputerID,
		"0198f4c2-7a35-7af3-a01e-0fcb31e9d852",
	} {
		created, err := repository.Create(ctx, computerport.CreateCommand{
			AccountID: repositoryAccountID, ServerID: repositoryServerID,
			IdempotencyKey: fmt.Sprintf("computer-duplicate-name-%d", index),
			RequestHash:    sha256.Sum256([]byte(fmt.Sprintf("duplicate-name-%d", index))),
			CreatedAt:      repositoryNow.Add(time.Duration(index) * time.Second),
			Computer: computerport.Draft{
				ID: computerID, Name: "11", TATRegion: "ap-beijing",
				TATInstanceKind: "managed", OSType: "linux",
				LifecycleState: "provisioning",
			},
		})
		if err != nil || created.ID != computerID {
			t.Fatalf("Create(duplicate display name %d) = (%#v, %v)", index, created, err)
		}
	}
	values, err := repository.List(ctx, repositoryAccountID, repositoryServerID)
	if err != nil || len(values) != 2 || values[0].Name != "11" || values[1].Name != "11" {
		t.Fatalf("List(duplicate display names) = (%#v, %v)", values, err)
	}
}

func TestEntRepositoryReleasesComputerAsAnIdempotentTombstone(t *testing.T) {
	repository, handle := openComputerRepository(t)
	seedComputerMembership(t, handle)
	ctx := context.Background()
	if _, err := repository.Create(ctx, computerport.CreateCommand{
		AccountID: repositoryAccountID, ServerID: repositoryServerID,
		IdempotencyKey: "computer-create-release",
		RequestHash:    sha256.Sum256([]byte("release-target")),
		CreatedAt:      repositoryNow,
		Computer: computerport.Draft{
			ID: repositoryComputerID, Name: "待解除执行机",
			TATRegion: "ap-beijing", TATInstanceKind: "managed",
			OSType: "linux", LifecycleState: "provisioning",
		},
	}); err != nil {
		t.Fatal(err)
	}
	secretHash := sha256.Sum256([]byte("release-credential"))
	credentialID := "0198f4c2-7a35-7af3-a01e-0fcb31e9d851"
	if _, err := handle.Client().ComputerRuntimeCredential.Create().
		SetID(credentialID).
		SetServerID(repositoryServerID).
		SetComputerID(repositoryComputerID).
		SetVersion(1).
		SetSecretHash(secretHash[:]).
		SetState("active").
		SetExpiresAt(repositoryNow.Add(24 * time.Hour)).
		SetCreatedAt(repositoryNow).
		Save(ctx); err != nil {
		t.Fatal(err)
	}
	setupHash := strings.Repeat("a", 64)
	if _, err := handle.Client().ComputerSetupCode.Create().
		SetCodeHash(setupHash).
		SetServerID(repositoryServerID).
		SetComputerID(repositoryComputerID).
		SetGeneration(1).
		SetExpiresAt(repositoryNow.Add(time.Hour)).
		SetCreatedAt(repositoryNow).
		Save(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Client().Computer.UpdateOneID(repositoryComputerID).
		SetEnrollmentTokenHash(secretHash[:]).
		SetEnrollmentExpiresAt(repositoryNow.Add(time.Hour)).
		Save(ctx); err != nil {
		t.Fatal(err)
	}
	command := computerport.ReleaseCommand{
		AccountID: repositoryAccountID, ServerID: repositoryServerID,
		ComputerID:     repositoryComputerID,
		IdempotencyKey: "computer-release-0001",
		ReleasedAt:     repositoryNow.Add(time.Minute),
	}
	if err := repository.Release(ctx, command); err != nil {
		t.Fatal(err)
	}
	if err := repository.Release(ctx, command); err != nil {
		t.Fatalf("Release(replay) error = %v", err)
	}
	values, err := repository.List(ctx, repositoryAccountID, repositoryServerID)
	if err != nil || len(values) != 0 {
		t.Fatalf("List(after release) = (%#v, %v)", values, err)
	}
	entity, err := handle.Client().Computer.Get(ctx, repositoryComputerID)
	if err != nil || entity.LifecycleState != "removed" ||
		entity.TatAgentState != "offline" || entity.Revision != 2 {
		t.Fatalf("released Computer = (%#v, %v)", entity, err)
	}
	replacementID := "0198f4c2-7a35-7af3-a01e-0fcb31e9d852"
	replacement, err := repository.Create(ctx, computerport.CreateCommand{
		AccountID: repositoryAccountID, ServerID: repositoryServerID,
		IdempotencyKey: "computer-create-reused-name",
		RequestHash:    sha256.Sum256([]byte("replacement-with-reused-name")),
		CreatedAt:      repositoryNow.Add(2 * time.Minute),
		Computer: computerport.Draft{
			ID: replacementID, Name: "待解除执行机",
			TATRegion: "ap-beijing", TATInstanceKind: "managed",
			OSType: "linux", LifecycleState: "provisioning",
		},
	})
	if err != nil || replacement.ID != replacementID || replacement.Name != entity.Name {
		t.Fatalf("Create(reused released name) = (%#v, %v)", replacement, err)
	}
	if (entity.EnrollmentTokenHash != nil &&
		len(*entity.EnrollmentTokenHash) > 0) || entity.EnrollmentExpiresAt != nil {
		t.Fatalf("released enrollment material was retained: %#v", entity)
	}
	credential, err := handle.Client().ComputerRuntimeCredential.Get(ctx, credentialID)
	if err != nil || credential.State != "revoked" || credential.RevokedAt == nil {
		t.Fatalf("released credential = (%#v, %v)", credential, err)
	}
	setupCount, err := handle.Client().ComputerSetupCode.Query().Count(ctx)
	if err != nil || setupCount != 0 {
		t.Fatalf("setup code count after release = (%d, %v)", setupCount, err)
	}
}

func TestEntRepositoryRefusesToReleaseComputerWithBoundAgent(t *testing.T) {
	repository, handle := openComputerRepository(t)
	seedComputerMembership(t, handle)
	ctx := context.Background()
	if _, err := repository.Create(ctx, computerport.CreateCommand{
		AccountID: repositoryAccountID, ServerID: repositoryServerID,
		IdempotencyKey: "computer-create-bound",
		RequestHash:    sha256.Sum256([]byte("bound-target")),
		CreatedAt:      repositoryNow,
		Computer: computerport.Draft{
			ID: repositoryComputerID, Name: "绑定执行机",
			TATRegion: "ap-beijing", TATInstanceKind: "managed",
			OSType: "linux", LifecycleState: "active",
		},
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Client().Agent.Create().
		SetID("0198f4c2-7a35-7af3-a01e-0fcb31e9d850").
		SetServerID(repositoryServerID).
		SetImUserID("a_bound_agent").
		SetComputerID(repositoryComputerID).
		SetRuntimeKind("codex").
		SetReplyPolicy("mention_and_dm").
		SetDesiredState("stopped").
		SetObservedState("stopped").
		SetCredentialVersion(1).
		SetImState("ready").
		SetCreatedByMemberID(repositoryMemberID).
		SetRevision(1).
		SetCreatedAt(repositoryNow).
		SetUpdatedAt(repositoryNow).
		Save(ctx); err != nil {
		t.Fatal(err)
	}
	err := repository.Release(ctx, computerport.ReleaseCommand{
		AccountID: repositoryAccountID, ServerID: repositoryServerID,
		ComputerID:     repositoryComputerID,
		IdempotencyKey: "computer-release-bound",
		ReleasedAt:     repositoryNow.Add(time.Minute),
	})
	if !errors.Is(err, computerport.ErrComputerHasBoundAgents) {
		t.Fatalf("Release(bound) error = %v", err)
	}
	entity, err := handle.Client().Computer.Get(ctx, repositoryComputerID)
	if err != nil || entity.LifecycleState != "active" || entity.Revision != 1 {
		t.Fatalf("Computer after rejected release = (%#v, %v)", entity, err)
	}
}

func TestEntRepositoryHidesComputerFromNonMember(t *testing.T) {
	repository, handle := openComputerRepository(t)
	seedComputerMembership(t, handle)
	instanceID := "ins-test0001"
	if _, err := repository.Create(
		context.Background(),
		computerport.CreateCommand{
			AccountID: repositoryAccountID, ServerID: repositoryServerID,
			IdempotencyKey: "computer-create-0001",
			RequestHash:    sha256.Sum256([]byte("native")),
			CreatedAt:      repositoryNow,
			Computer: computerport.Draft{
				ID: repositoryComputerID, Name: "执行机",
				TATRegion: "ap-beijing", TATInstanceID: &instanceID,
				TATInstanceKind: "cvm", OSType: "linux",
				LifecycleState: "active",
			},
		},
	); err != nil {
		t.Fatal(err)
	}
	other := "0198f4c2-7a50-7c91-a6d2-7d76f9188c37"
	if _, err := repository.List(
		context.Background(), other, repositoryServerID,
	); !errors.Is(err, computerport.ErrServerNotFound) {
		t.Fatalf("List(non-member) error=%v", err)
	}
	if _, err := repository.Get(
		context.Background(), other, repositoryServerID, repositoryComputerID,
	); !errors.Is(err, computerport.ErrServerNotFound) {
		t.Fatalf("Get(non-member) error=%v", err)
	}
}

func TestEntRepositoryAllowsTerminalLookupOnlyForOwnerOrAdmin(t *testing.T) {
	repository, handle := openComputerRepository(t)
	seedComputerMembership(t, handle)
	ctx := context.Background()
	if _, err := handle.Client().Computer.Create().
		SetID(repositoryComputerID).
		SetServerID(repositoryServerID).
		SetName("Terminal Computer").
		SetTatRegion("ap-beijing").
		SetTatInstanceID("rins-terminal-test").
		SetTatInstanceKind("managed").
		SetOsType("linux").
		SetLifecycleState("active").
		SetTatAgentState("online").
		SetRevision(1).
		SetCreatedAt(repositoryNow).
		SetUpdatedAt(repositoryNow).
		Save(ctx); err != nil {
		t.Fatal(err)
	}

	value, err := repository.GetForAdmin(
		ctx, repositoryAccountID, repositoryServerID, repositoryComputerID,
	)
	if err != nil || value.ID != repositoryComputerID {
		t.Fatalf("GetForAdmin(owner) = (%#v, %v)", value, err)
	}
	if _, err := handle.Client().AccountServerMembership.Update().
		Where(
			accountservermembership.AccountIDEQ(repositoryAccountID),
			accountservermembership.ServerIDEQ(repositoryServerID),
		).
		SetRole("member").
		Save(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := repository.GetForAdmin(
		ctx, repositoryAccountID, repositoryServerID, repositoryComputerID,
	); !errors.Is(err, computerport.ErrAdminRequired) {
		t.Fatalf("GetForAdmin(member) error = %v", err)
	}
}

func TestEntRepositoryIssuesAndRecoversComputerCredentialIdempotently(t *testing.T) {
	repository, handle := openComputerRepository(t)
	seedComputerMembership(t, handle)
	ctx := context.Background()
	if _, err := handle.Client().Computer.Create().
		SetID(repositoryComputerID).
		SetServerID(repositoryServerID).
		SetName("Credential Computer").
		SetTatRegion("ap-beijing").
		SetTatInstanceID("rins-credential-test").
		SetTatInstanceKind("managed").
		SetOsType("linux").
		SetLifecycleState("active").
		SetTatAgentState("online").
		SetRevision(1).
		SetCreatedAt(repositoryNow).
		SetUpdatedAt(repositoryNow).
		Save(ctx); err != nil {
		t.Fatal(err)
	}
	firstID := "0198f4c2-7a36-7af3-a01e-0fcb31e9d84d"
	firstHash := sha256.Sum256([]byte("first-secret-part"))
	command := computerport.CredentialCommand{
		AccountID: repositoryAccountID, ServerID: repositoryServerID,
		ComputerID: repositoryComputerID, Mode: "bootstrap",
		CredentialID: firstID, SecretHash: firstHash,
		IdempotencyKey:   "computer-credential-0001",
		RequestHash:      sha256.Sum256([]byte("bootstrap")),
		ExpiresAt:        repositoryNow.Add(365 * 24 * time.Hour),
		HandoffExpiresAt: repositoryNow.Add(time.Hour),
		CreatedAt:        repositoryNow,
	}
	first, err := repository.IssueCredential(ctx, command)
	if err != nil || !first.Created || first.ID != firstID || first.Version != 1 {
		t.Fatalf("IssueCredential() = %#v, %v", first, err)
	}
	replayCommand := command
	replayCommand.CredentialID = "0198f4c2-7a37-7af3-a01e-0fcb31e9d84d"
	replayCommand.SecretHash = sha256.Sum256([]byte("different-derived-secret"))
	replay, err := repository.IssueCredential(ctx, replayCommand)
	if err != nil || replay.Created || replay.ID != firstID || replay.Version != 1 {
		t.Fatalf("IssueCredential(replay) = %#v, %v", replay, err)
	}
	secondBootstrap := command
	secondBootstrap.CredentialID = "0198f4c2-7a38-7af3-a01e-0fcb31e9d84d"
	secondBootstrap.IdempotencyKey = "computer-credential-0002"
	if _, err := repository.IssueCredential(ctx, secondBootstrap); !errors.Is(err, computerport.ErrCredentialExists) {
		t.Fatalf("second bootstrap error = %v", err)
	}
	recoverCommand := command
	recoverCommand.Mode = "recover"
	recoverCommand.CredentialID = "0198f4c2-7a39-7af3-a01e-0fcb31e9d84d"
	recoverCommand.SecretHash = sha256.Sum256([]byte("recovered-secret-part"))
	recoverCommand.IdempotencyKey = "computer-credential-recover-0001"
	recoverCommand.RequestHash = sha256.Sum256([]byte("recover"))
	recoverCommand.CreatedAt = repositoryNow.Add(time.Minute)
	recoverCommand.ExpiresAt = recoverCommand.CreatedAt.Add(365 * 24 * time.Hour)
	recoverCommand.HandoffExpiresAt = recoverCommand.CreatedAt.Add(time.Hour)
	recovered, err := repository.IssueCredential(ctx, recoverCommand)
	if err != nil || recovered.Version != 2 || !recovered.Created {
		t.Fatalf("IssueCredential(recover) = %#v, %v", recovered, err)
	}
	old, err := handle.Client().ComputerRuntimeCredential.Get(ctx, firstID)
	if err != nil || old.State != "revoked" || old.RevokedAt == nil {
		t.Fatalf("old credential = %#v, %v", old, err)
	}
	rotationTime := recoverCommand.CreatedAt.Add(time.Minute)
	rotation := computerport.CredentialRotationCommand{
		ServerID: repositoryServerID, ComputerID: repositoryComputerID,
		CurrentVersion:   2,
		CredentialID:     "0198f4c2-7a3a-7af3-a01e-0fcb31e9d84d",
		SecretHash:       sha256.Sum256([]byte("rotated-secret-part")),
		IdempotencyKey:   "computer-credential-rotate-0001",
		RequestHash:      sha256.Sum256([]byte("rotate:2")),
		ExpiresAt:        rotationTime.Add(365 * 24 * time.Hour),
		GraceExpiresAt:   rotationTime.Add(time.Hour),
		HandoffExpiresAt: rotationTime.Add(time.Hour),
		CreatedAt:        rotationTime,
	}
	rotated, err := repository.RotateCredential(ctx, rotation)
	if err != nil || !rotated.Created || rotated.Version != 3 ||
		rotated.GraceExpiresAt == nil ||
		!rotated.GraceExpiresAt.Equal(rotation.GraceExpiresAt) {
		t.Fatalf("RotateCredential() = %#v, %v", rotated, err)
	}
	replayRotation := rotation
	replayRotation.CredentialID = "0198f4c2-7a3b-7af3-a01e-0fcb31e9d84d"
	replayRotation.SecretHash = sha256.Sum256([]byte("ignored-secret-part"))
	replayedRotation, err := repository.RotateCredential(ctx, replayRotation)
	if err != nil || replayedRotation.Created ||
		replayedRotation.ID != rotated.ID || replayedRotation.Version != 3 {
		t.Fatalf("RotateCredential(replay) = %#v, %v", replayedRotation, err)
	}
	staleRotation := rotation
	staleRotation.CredentialID = "0198f4c2-7a3c-7af3-a01e-0fcb31e9d84d"
	staleRotation.IdempotencyKey = "computer-credential-rotate-stale"
	if _, err := repository.RotateCredential(ctx, staleRotation); !errors.Is(
		err,
		computerport.ErrCredentialNotCurrent,
	) {
		t.Fatalf("RotateCredential(stale) error = %v", err)
	}
	previous, err := handle.Client().ComputerRuntimeCredential.Get(
		ctx,
		recovered.ID,
	)
	if err != nil || previous.State != "grace" ||
		previous.GraceExpiresAt == nil ||
		!previous.GraceExpiresAt.Equal(rotation.GraceExpiresAt) {
		t.Fatalf("previous credential = %#v, %v", previous, err)
	}
}

func TestEntRepositoryEnqueuesIdempotentComputerRefresh(t *testing.T) {
	repository, handle := openComputerRepository(t)
	seedComputerMembership(t, handle)
	instanceID := "ins-test0001"
	if _, err := repository.Create(
		context.Background(),
		computerport.CreateCommand{
			AccountID: repositoryAccountID, ServerID: repositoryServerID,
			IdempotencyKey: "computer-create-0001",
			RequestHash:    sha256.Sum256([]byte("native")),
			CreatedAt:      repositoryNow,
			Computer: computerport.Draft{
				ID: repositoryComputerID, Name: "执行机",
				TATRegion: "ap-beijing", TATInstanceID: &instanceID,
				TATInstanceKind: "cvm", OSType: "linux",
				LifecycleState: "active",
			},
		},
	); err != nil {
		t.Fatal(err)
	}
	command := computerport.RefreshCommand{
		AccountID: repositoryAccountID, ServerID: repositoryServerID,
		ComputerID: repositoryComputerID, ComputerRevision: 1,
		OperationID:    repositoryOperationID,
		IdempotencyKey: "computer-refresh-0001", CreatedAt: repositoryNow,
	}
	operation, err := repository.EnqueueRefresh(context.Background(), command)
	if err != nil {
		t.Fatal(err)
	}
	if operation.ID != repositoryOperationID ||
		operation.Kind != "tat.computer.refresh" ||
		operation.State != "pending" {
		t.Fatalf("EnqueueRefresh() = %#v", operation)
	}
	replay := command
	replay.OperationID = "0198f4c2-7a46-7af3-a01e-0fcb31e9d84d"
	replayed, err := repository.EnqueueRefresh(context.Background(), replay)
	if err != nil || replayed.ID != repositoryOperationID {
		t.Fatalf("EnqueueRefresh(replay) = (%#v, %v)", replayed, err)
	}
	if count, err := handle.Client().TencentOperation.Query().Count(
		context.Background(),
	); err != nil || count != 1 {
		t.Fatalf("operation count=(%d, %v)", count, err)
	}
}

func TestEntRepositoryBeginsTaggedRegistrationReconciliation(t *testing.T) {
	repository, handle := openComputerRepository(t)
	seedComputerMembership(t, handle)
	if _, err := repository.Create(
		context.Background(),
		computerport.CreateCommand{
			AccountID: repositoryAccountID, ServerID: repositoryServerID,
			IdempotencyKey: "computer-create-managed",
			RequestHash:    sha256.Sum256([]byte("managed")),
			CreatedAt:      repositoryNow,
			Computer: computerport.Draft{
				ID: repositoryComputerID, Name: "外部执行机",
				TATRegion: "ap-beijing", TATInstanceKind: "managed",
				OSType: "linux", LifecycleState: "provisioning",
			},
		},
	); err != nil {
		t.Fatal(err)
	}
	expiresAt := repositoryNow.Add(time.Hour)
	operation, err := repository.BeginRegistration(
		context.Background(),
		computerport.RegistrationCommand{
			AccountID: repositoryAccountID, ServerID: repositoryServerID,
			ComputerID: repositoryComputerID, ComputerRevision: 1,
			OperationID: repositoryOperationID,
			ExpiresAt:   expiresAt, CreatedAt: repositoryNow,
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	if operation.ID != repositoryOperationID ||
		operation.Kind != "tat.computer.registration.reconcile" {
		t.Fatalf("BeginRegistration() = %#v", operation)
	}
	entity, err := handle.Client().Computer.Get(
		context.Background(), repositoryComputerID,
	)
	if err != nil {
		t.Fatal(err)
	}
	if entity.RegistrationExpiresAt == nil ||
		!entity.RegistrationExpiresAt.Equal(expiresAt) ||
		entity.Revision != 2 {
		t.Fatalf("Computer after registration = %#v", entity)
	}
	stored, err := handle.Client().TencentOperation.Get(
		context.Background(), repositoryOperationID,
	)
	if err != nil {
		t.Fatal(err)
	}
	if stored.ResourceType != "computer" ||
		stored.DesiredRevision == nil ||
		*stored.DesiredRevision != 2 ||
		stored.RequestSnapshotJSON != nil {
		t.Fatalf("registration operation = %#v", stored)
	}
}

func TestEntRepositoryBeginsEnrollmentWithRevisionCAS(t *testing.T) {
	repository, handle := openComputerRepository(t)
	seedComputerMembership(t, handle)
	ctx := context.Background()
	if _, err := repository.Create(ctx, computerport.CreateCommand{
		AccountID: repositoryAccountID, ServerID: repositoryServerID,
		IdempotencyKey: "computer-create-enrollment",
		RequestHash:    sha256.Sum256([]byte("enrollment")),
		CreatedAt:      repositoryNow,
		Computer: computerport.Draft{
			ID: repositoryComputerID, Name: "Enrollment Mac",
			TATRegion: "ap-beijing", TATInstanceKind: "managed",
			OSType: "macos", LifecycleState: "provisioning",
		},
	}); err != nil {
		t.Fatal(err)
	}
	tokenHash := sha256.Sum256([]byte("enrollment-token-one"))
	command := computerport.BeginEnrollmentCommand{
		AccountID: repositoryAccountID, ServerID: repositoryServerID,
		ComputerID: repositoryComputerID, ExpectedRevision: 1,
		ExpectedGeneration: 0, Generation: 1, TokenHash: tokenHash,
		ExpiresAt: repositoryNow.Add(15 * time.Minute),
		Release:   repositoryEnrollmentRelease(), CreatedAt: repositoryNow,
	}
	created, err := repository.BeginEnrollment(ctx, command)
	if err != nil {
		t.Fatal(err)
	}
	if created.EnrollmentGeneration != 1 || created.Revision != 2 ||
		created.EnrollmentClaimedAt != nil {
		t.Fatalf("BeginEnrollment() = %#v", created)
	}
	stored, err := handle.Client().Computer.Get(ctx, repositoryComputerID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.EnrollmentGeneration != 1 ||
		stored.EnrollmentReleaseVersion == nil || *stored.EnrollmentReleaseVersion != "0.1.0" ||
		stored.EnrollmentProgramSize == nil || *stored.EnrollmentProgramSize != 8<<20 ||
		stored.EnrollmentTokenHash == nil || len(*stored.EnrollmentTokenHash) != 32 {
		t.Fatalf("stored enrollment = %#v", stored)
	}
	if _, err := repository.BeginEnrollment(ctx, command); !errors.Is(
		err, computerport.ErrEnrollmentRevisionConflict,
	) {
		t.Fatalf("stale BeginEnrollment error = %v", err)
	}
	reissue := command
	reissue.ExpectedRevision = 2
	reissue.ExpectedGeneration = 1
	reissue.Generation = 2
	reissue.TokenHash = sha256.Sum256([]byte("enrollment-token-two"))
	reissued, err := repository.BeginEnrollment(ctx, reissue)
	if err != nil || reissued.EnrollmentGeneration != 2 || reissued.Revision != 3 {
		t.Fatalf("BeginEnrollment(reissue) = (%#v, %v)", reissued, err)
	}
}

func TestEntRepositoryStoresResolvesAndValidatesSetupCodeRoute(t *testing.T) {
	repository, handle := openComputerRepository(t)
	seedComputerMembership(t, handle)
	ctx := context.Background()
	if _, err := repository.Create(ctx, computerport.CreateCommand{
		AccountID: repositoryAccountID, ServerID: repositoryServerID,
		IdempotencyKey: "computer-create-setup-code",
		RequestHash:    sha256.Sum256([]byte("setup-code")),
		CreatedAt:      repositoryNow,
		Computer: computerport.Draft{
			ID: repositoryComputerID, Name: "Setup Code Mac",
			TATRegion: "ap-beijing", TATInstanceKind: "managed",
			OSType: "macos", LifecycleState: "provisioning",
		},
	}); err != nil {
		t.Fatal(err)
	}
	tokenHash := sha256.Sum256([]byte("derived-enrollment-token"))
	expiresAt := repositoryNow.Add(15 * time.Minute)
	if _, err := repository.BeginEnrollment(ctx, computerport.BeginEnrollmentCommand{
		AccountID: repositoryAccountID, ServerID: repositoryServerID,
		ComputerID: repositoryComputerID, ExpectedRevision: 1,
		ExpectedGeneration: 0, Generation: 1, TokenHash: tokenHash,
		ExpiresAt: expiresAt, Release: repositoryEnrollmentRelease(), CreatedAt: repositoryNow,
	}); err != nil {
		t.Fatal(err)
	}
	codeHash := strings.Repeat("a", 64)
	if err := repository.StoreSetupCode(ctx, computerport.StoreSetupCodeCommand{
		ID: "0198f4c2-7a37-7af3-a01e-0fcb31e9d84f", CodeHash: codeHash,
		ServerID: repositoryServerID, ComputerID: repositoryComputerID,
		Generation: 1, ExpiresAt: expiresAt, CreatedAt: repositoryNow,
	}); err != nil {
		t.Fatal(err)
	}
	route, err := repository.ResolveSetupCode(ctx, computerport.ResolveSetupCodeCommand{
		CodeHash: codeHash, RequestedAt: repositoryNow,
	})
	if err != nil || route.ServerID != repositoryServerID ||
		route.ComputerID != repositoryComputerID || route.Generation != 1 ||
		!route.ExpiresAt.Equal(expiresAt) {
		t.Fatalf("ResolveSetupCode() = (%#v, %v)", route, err)
	}
	redemption, err := repository.ValidateSetupCode(ctx, computerport.ValidateSetupCodeCommand{
		ServerID: repositoryServerID, ComputerID: repositoryComputerID,
		Generation: 1, TokenHash: tokenHash, RequestedAt: repositoryNow,
	})
	if err != nil || redemption.Release.Version != "0.1.0" ||
		redemption.Release.Target != "darwin-arm64" ||
		redemption.Release.InstallerSHA256 != repositoryEnrollmentRelease().Installer.SHA256 {
		t.Fatalf("ValidateSetupCode() = (%#v, %v)", redemption, err)
	}
	if _, err := repository.ResolveSetupCode(ctx, computerport.ResolveSetupCodeCommand{
		CodeHash: codeHash, RequestedAt: expiresAt,
	}); !errors.Is(err, computerport.ErrSetupCodeInvalid) {
		t.Fatalf("expired ResolveSetupCode() error = %v", err)
	}
	wrong := tokenHash
	wrong[0] ^= 0xff
	if _, err := repository.ValidateSetupCode(ctx, computerport.ValidateSetupCodeCommand{
		ServerID: repositoryServerID, ComputerID: repositoryComputerID,
		Generation: 1, TokenHash: wrong, RequestedAt: repositoryNow,
	}); !errors.Is(err, computerport.ErrSetupCodeInvalid) {
		t.Fatalf("wrong ValidateSetupCode() error = %v", err)
	}
}

func TestEntRepositoryClaimsEnrollmentAndRecoversAfterTokenExpiry(t *testing.T) {
	repository, handle := openComputerRepository(t)
	seedComputerMembership(t, handle)
	ctx := context.Background()
	if _, err := repository.Create(ctx, computerport.CreateCommand{
		AccountID: repositoryAccountID, ServerID: repositoryServerID,
		IdempotencyKey: "computer-create-claim",
		RequestHash:    sha256.Sum256([]byte("claim")),
		CreatedAt:      repositoryNow,
		Computer: computerport.Draft{
			ID: repositoryComputerID, Name: "Claim Mac",
			TATRegion: "ap-beijing", TATInstanceKind: "managed",
			OSType: "macos", LifecycleState: "provisioning",
		},
	}); err != nil {
		t.Fatal(err)
	}
	tokenHash := sha256.Sum256([]byte("claim-token"))
	if _, err := repository.BeginEnrollment(ctx, computerport.BeginEnrollmentCommand{
		AccountID: repositoryAccountID, ServerID: repositoryServerID,
		ComputerID: repositoryComputerID, ExpectedRevision: 1,
		ExpectedGeneration: 0, Generation: 1, TokenHash: tokenHash,
		ExpiresAt: repositoryNow.Add(time.Minute),
		Release:   repositoryEnrollmentRelease(), CreatedAt: repositoryNow,
	}); err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256([]byte("client-generated-secret-part"))
	command := computerport.ClaimEnrollmentCommand{
		ServerID: repositoryServerID, ComputerID: repositoryComputerID,
		Generation: 1, TokenHash: tokenHash, OSType: "macos",
		Architecture: "arm64", InstallerVersion: "0.1.0",
		CredentialID:        "0198f4c2-7a37-7af3-a01e-0fcb31e9d84e",
		CredentialDigest:    digest,
		CredentialExpiresAt: repositoryNow.Add(365 * 24 * time.Hour),
		ClaimedAt:           repositoryNow.Add(30 * time.Second),
	}
	claimed, err := repository.ClaimEnrollment(ctx, command)
	if err != nil || !claimed.Created || claimed.CredentialVersion != 1 {
		t.Fatalf("ClaimEnrollment() = (%#v, %v)", claimed, err)
	}
	replay := command
	replay.CredentialID = "0198f4c2-7a38-7af3-a01e-0fcb31e9d84e"
	replay.ClaimedAt = repositoryNow.Add(24 * time.Hour)
	replayed, err := repository.ClaimEnrollment(ctx, replay)
	if err != nil || replayed.Created || replayed.CredentialID != claimed.CredentialID ||
		replayed.CredentialVersion != 1 {
		t.Fatalf("ClaimEnrollment(replay) = (%#v, %v)", replayed, err)
	}
	conflict := replay
	conflict.CredentialDigest = sha256.Sum256([]byte("different-secret"))
	if _, err := repository.ClaimEnrollment(ctx, conflict); !errors.Is(
		err, computerport.ErrEnrollmentClaimConflict,
	) {
		t.Fatalf("ClaimEnrollment(conflict) error = %v", err)
	}
	wrongToken := replay
	wrongToken.TokenHash = sha256.Sum256([]byte("wrong-token"))
	if _, err := repository.ClaimEnrollment(ctx, wrongToken); !errors.Is(
		err, computerport.ErrEnrollmentInvalid,
	) {
		t.Fatalf("ClaimEnrollment(wrong token) error = %v", err)
	}
	if _, err := handle.Client().Computer.Update().
		Where(
			computerentity.IDEQ(repositoryComputerID),
			computerentity.ServerIDEQ(repositoryServerID),
		).
		SetTatAgentState("online").
		Save(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := repository.ClaimEnrollment(ctx, replay); !errors.Is(
		err, computerport.ErrEnrollmentInvalid,
	) {
		t.Fatalf("ClaimEnrollment(online replay) error = %v", err)
	}
}

func TestEntRepositoryRejectsExpiredUnclaimedEnrollment(t *testing.T) {
	repository, handle := openComputerRepository(t)
	seedComputerMembership(t, handle)
	ctx := context.Background()
	if _, err := repository.Create(ctx, computerport.CreateCommand{
		AccountID: repositoryAccountID, ServerID: repositoryServerID,
		IdempotencyKey: "computer-create-expired-claim",
		RequestHash:    sha256.Sum256([]byte("expired-claim")),
		CreatedAt:      repositoryNow,
		Computer: computerport.Draft{
			ID: repositoryComputerID, Name: "Expired Mac", TATRegion: "ap-beijing",
			TATInstanceKind: "managed", OSType: "macos", LifecycleState: "provisioning",
		},
	}); err != nil {
		t.Fatal(err)
	}
	tokenHash := sha256.Sum256([]byte("expired-token"))
	if _, err := repository.BeginEnrollment(ctx, computerport.BeginEnrollmentCommand{
		AccountID: repositoryAccountID, ServerID: repositoryServerID,
		ComputerID: repositoryComputerID, ExpectedRevision: 1,
		ExpectedGeneration: 0, Generation: 1, TokenHash: tokenHash,
		ExpiresAt: repositoryNow.Add(time.Minute),
		Release:   repositoryEnrollmentRelease(), CreatedAt: repositoryNow,
	}); err != nil {
		t.Fatal(err)
	}
	_, err := repository.ClaimEnrollment(ctx, computerport.ClaimEnrollmentCommand{
		ServerID: repositoryServerID, ComputerID: repositoryComputerID,
		Generation: 1, TokenHash: tokenHash, OSType: "macos",
		Architecture: "arm64", InstallerVersion: "0.1.0",
		CredentialID:        "0198f4c2-7a37-7af3-a01e-0fcb31e9d84e",
		CredentialDigest:    sha256.Sum256([]byte("secret")),
		CredentialExpiresAt: repositoryNow.Add(365 * 24 * time.Hour),
		ClaimedAt:           repositoryNow.Add(2 * time.Minute),
	})
	if !errors.Is(err, computerport.ErrEnrollmentExpired) {
		t.Fatalf("ClaimEnrollment(expired) error = %v", err)
	}
}

func TestEntRepositoryResolvesOnlyCurrentBoundEnrollmentArtifact(t *testing.T) {
	repository, handle := openComputerRepository(t)
	seedComputerMembership(t, handle)
	ctx := context.Background()
	if _, err := repository.Create(ctx, computerport.CreateCommand{
		AccountID: repositoryAccountID, ServerID: repositoryServerID,
		IdempotencyKey: "computer-create-artifact",
		RequestHash:    sha256.Sum256([]byte("artifact")),
		CreatedAt:      repositoryNow,
		Computer: computerport.Draft{
			ID: repositoryComputerID, Name: "Artifact Mac", TATRegion: "ap-beijing",
			TATInstanceKind: "managed", OSType: "macos", LifecycleState: "provisioning",
		},
	}); err != nil {
		t.Fatal(err)
	}
	tokenHash := sha256.Sum256([]byte("artifact-token"))
	release := repositoryEnrollmentRelease()
	expiresAt := repositoryNow.Add(15 * time.Minute)
	if _, err := repository.BeginEnrollment(ctx, computerport.BeginEnrollmentCommand{
		AccountID: repositoryAccountID, ServerID: repositoryServerID,
		ComputerID: repositoryComputerID, ExpectedRevision: 1,
		ExpectedGeneration: 0, Generation: 1, TokenHash: tokenHash,
		ExpiresAt: expiresAt, Release: release, CreatedAt: repositoryNow,
	}); err != nil {
		t.Fatal(err)
	}
	access, err := repository.ResolveEnrollmentArtifact(
		ctx,
		computerport.ResolveArtifactCommand{
			ServerID: repositoryServerID, ComputerID: repositoryComputerID,
			Generation: 1, TokenHash: tokenHash, Version: release.Version,
			Target: release.Target, File: "install.sh", RequestedAt: repositoryNow,
		},
	)
	if err != nil || access.ObjectKey != release.Installer.ObjectKey ||
		access.SHA256 != release.Installer.SHA256 || !access.ExpiresAt.Equal(expiresAt) {
		t.Fatalf("ResolveEnrollmentArtifact() = (%#v, %v)", access, err)
	}
	wrong := computerport.ResolveArtifactCommand{
		ServerID: repositoryServerID, ComputerID: repositoryComputerID,
		Generation: 1, TokenHash: tokenHash, Version: release.Version,
		Target: release.Target, File: "unknown", RequestedAt: repositoryNow,
	}
	if _, err := repository.ResolveEnrollmentArtifact(ctx, wrong); !errors.Is(
		err, computerport.ErrEnrollmentInvalid,
	) {
		t.Fatalf("unknown artifact error = %v", err)
	}
	wrong.File = "install.sh"
	wrong.RequestedAt = expiresAt
	if _, err := repository.ResolveEnrollmentArtifact(ctx, wrong); !errors.Is(
		err, computerport.ErrEnrollmentExpired,
	) {
		t.Fatalf("expired artifact error = %v", err)
	}
}

func repositoryEnrollmentRelease() computerport.ReleaseBinding {
	return computerport.ReleaseBinding{
		Version: "0.1.0", Target: "darwin-arm64", OSType: "macos",
		Architecture: "arm64", SigningKeyID: "release-2026-01",
		Manifest:  computerport.ArtifactBinding{ObjectKey: "computer/releases/0.1.0/manifest.json", SHA256: sha256.Sum256([]byte("manifest")), Size: 512},
		Signature: computerport.ArtifactBinding{ObjectKey: "computer/releases/0.1.0/manifest.sig", SHA256: sha256.Sum256([]byte("signature")), Size: 64},
		Installer: computerport.ArtifactBinding{ObjectKey: "computer/releases/0.1.0/darwin-arm64/install.sh", SHA256: sha256.Sum256([]byte("installer")), Size: 1024},
		Program:   computerport.ArtifactBinding{ObjectKey: "computer/releases/0.1.0/darwin-arm64/vela-computer", SHA256: sha256.Sum256([]byte("program")), Size: 8 << 20},
	}
}

func openComputerRepository(t *testing.T) (*EntRepository, *database.Handle) {
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

func seedComputerMembership(t *testing.T, handle *database.Handle) {
	t.Helper()
	ctx := context.Background()
	if _, err := handle.Client().Account.Create().
		SetID(repositoryAccountID).
		SetEmail("alice@example.com").
		SetEmailNormalized("alice@example.com").
		SetDisplayName("Alice").
		SetPasswordHash("not-used").
		SetTokenVersion(1).
		SetImUserID("u_ALICE").
		SetImState("ready").
		SetRevision(1).
		SetCreatedAt(repositoryNow).
		SetUpdatedAt(repositoryNow).
		Save(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Client().Server.Create().
		SetID(repositoryServerID).
		SetSlug("agent-lab").
		SetName("Agent 实验室").
		SetOwnerMemberID(repositoryMemberID).
		SetImGroupID("@TGS#_C_TEST").
		SetImState("ready").
		SetNextTaskNumber(1).
		SetRevision(1).
		SetCreatedAt(repositoryNow).
		SetUpdatedAt(repositoryNow).
		Save(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Client().Member.Create().
		SetID(repositoryMemberID).
		SetServerID(repositoryServerID).
		SetAccountID(repositoryAccountID).
		SetKind("human").
		SetRole("owner").
		SetDisplayName("Alice").
		SetHandle("alice").
		SetStatus("active").
		SetImState("ready").
		SetRevision(1).
		SetCreatedAt(repositoryNow).
		SetUpdatedAt(repositoryNow).
		Save(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Client().AccountServerMembership.Create().
		SetAccountID(repositoryAccountID).
		SetServerID(repositoryServerID).
		SetMemberID(repositoryMemberID).
		SetRole("owner").
		SetStatus("active").
		SetServerNameSnapshot("Agent 实验室").
		SetServerSlugSnapshot("agent-lab").
		SetServerRevision(1).
		SetProjectedAt(repositoryNow).
		SetUpdatedAt(repositoryNow).
		Save(ctx); err != nil {
		t.Fatal(err)
	}
}
