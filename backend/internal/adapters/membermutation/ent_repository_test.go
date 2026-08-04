package membermutation

import (
	"context"
	"crypto/sha256"
	"path/filepath"
	"testing"
	"time"

	"chatserver/internal/config"
	"chatserver/internal/database"
	"chatserver/internal/database/migration"
	membermutationport "chatserver/internal/ports/membermutation"
)

const (
	memberActorAccountID = "0198f4c2-7a30-7c91-a6d2-7d76f9188c37"
	memberActorMemberID  = "0198f4c2-7a32-7d02-b8c1-3f6e15aa91b4"
	memberTargetAccount  = "0198f4c2-7a39-7c91-a6d2-7d76f9188c39"
	memberTargetMember   = "0198f4c2-7a37-7e45-913c-6baf30401a83"
	memberServerID       = "0198f4c2-7a31-7c91-a6d2-7d76f9188c38"
	memberOperationID    = "0198f4c2-7a38-7e45-913c-6baf30401a84"
)

func TestEntRepositoryUpdatesAndRemovesHumanMember(t *testing.T) {
	repository, handle := openMemberMutationRepository(t)
	now := time.Date(2026, 7, 31, 2, 30, 0, 0, time.UTC)
	seedMemberMutation(t, handle, now)
	displayName := "新成员名"
	role := "admin"
	update := membermutationport.UpdateCommand{
		AccountID: memberActorAccountID, ServerID: memberServerID,
		MemberID: memberTargetMember, ExpectedRevision: 1,
		IdempotencyKey: "member-update-0001",
		RequestHash:    sha256.Sum256([]byte("update")),
		DisplayName:    &displayName, Role: &role, UpdatedAt: now,
	}
	result, err := repository.Update(context.Background(), update)
	if err != nil || result.MemberID != memberTargetMember {
		t.Fatalf("Update() = (%#v, %v)", result, err)
	}
	replayed, err := repository.Update(context.Background(), update)
	if err != nil || replayed != result {
		t.Fatalf("Update(replay) = (%#v, %v)", replayed, err)
	}
	target, err := handle.Client().Member.Get(
		context.Background(),
		memberTargetMember,
	)
	if err != nil ||
		target.DisplayName != displayName ||
		target.Role != role ||
		target.Revision != 2 {
		t.Fatalf("member after update = (%#v, %v)", target, err)
	}
	removed, err := repository.Remove(
		context.Background(),
		membermutationport.RemoveCommand{
			AccountID: memberActorAccountID, ServerID: memberServerID,
			MemberID: memberTargetMember, OperationID: memberOperationID,
			IdempotencyKey: "member-remove-0001",
			RequestHash:    sha256.Sum256([]byte(memberTargetMember)),
			RemovedAt:      now.Add(time.Minute),
		},
	)
	if err != nil || removed.OperationID != memberOperationID {
		t.Fatalf("Remove() = (%#v, %v)", removed, err)
	}
	target, err = handle.Client().Member.Get(
		context.Background(),
		memberTargetMember,
	)
	if err != nil ||
		target.Status != "removed" ||
		target.ActiveHandleKey != nil ||
		target.ImState != "provisioning" ||
		target.Revision != 3 {
		t.Fatalf("member after remove = (%#v, %v)", target, err)
	}
	operation, err := handle.Client().TencentOperation.Get(
		context.Background(),
		memberOperationID,
	)
	if err != nil ||
		operation.Kind != "im.membership.remove" ||
		operation.DesiredRevision == nil ||
		*operation.DesiredRevision != 3 {
		t.Fatalf("operation = (%#v, %v)", operation, err)
	}
}

func openMemberMutationRepository(
	t *testing.T,
) (*EntRepository, *database.Handle) {
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

func seedMemberMutation(
	t *testing.T,
	handle *database.Handle,
	now time.Time,
) {
	t.Helper()
	ctx := context.Background()
	for _, value := range []struct {
		id, email, name, imUserID string
	}{
		{
			memberActorAccountID, "owner@example.com",
			"所有者", "u_OWNER",
		},
		{
			memberTargetAccount, "member@example.com",
			"成员", "u_MEMBER",
		},
	} {
		if _, err := handle.Client().Account.Create().
			SetID(value.id).
			SetEmail(value.email).
			SetEmailNormalized(value.email).
			SetDisplayName(value.name).
			SetPasswordHash("test-only").
			SetTokenVersion(1).
			SetImUserID(value.imUserID).
			SetImState("ready").
			SetRevision(1).
			SetCreatedAt(now).
			SetUpdatedAt(now).
			Save(ctx); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := handle.Client().Server.Create().
		SetID(memberServerID).
		SetSlug("member-mutation").
		SetName("成员变更").
		SetOwnerMemberID(memberActorMemberID).
		SetImGroupID("@TGS#2MEMBER").
		SetImState("ready").
		SetNextTaskNumber(1).
		SetRevision(1).
		SetCreatedAt(now).
		SetUpdatedAt(now).
		Save(ctx); err != nil {
		t.Fatal(err)
	}
	for _, value := range []struct {
		id, accountID, role, name, handle string
	}{
		{
			memberActorMemberID, memberActorAccountID,
			"owner", "所有者", "owner",
		},
		{
			memberTargetMember, memberTargetAccount,
			"member", "成员", "member",
		},
	} {
		if _, err := handle.Client().Member.Create().
			SetID(value.id).
			SetServerID(memberServerID).
			SetAccountID(value.accountID).
			SetKind("human").
			SetRole(value.role).
			SetDisplayName(value.name).
			SetHandle(value.handle).
			SetActiveHandleKey(value.handle).
			SetStatus("active").
			SetImState("ready").
			SetRevision(1).
			SetCreatedAt(now).
			SetUpdatedAt(now).
			Save(ctx); err != nil {
			t.Fatal(err)
		}
		if _, err := handle.Client().AccountServerMembership.Create().
			SetAccountID(value.accountID).
			SetServerID(memberServerID).
			SetMemberID(value.id).
			SetRole(value.role).
			SetStatus("active").
			SetServerNameSnapshot("成员变更").
			SetServerSlugSnapshot("member-mutation").
			SetServerRevision(1).
			SetProjectedAt(now).
			SetUpdatedAt(now).
			Save(ctx); err != nil {
			t.Fatal(err)
		}
	}
}
