package channelmembership

import (
	"context"
	"crypto/sha256"
	"errors"
	"path/filepath"
	"testing"
	"time"

	"chatserver/internal/config"
	"chatserver/internal/database"
	"chatserver/internal/database/migration"
	"chatserver/internal/ent/accountservermembership"
	channelmembershipport "chatserver/internal/ports/channelmembership"
)

const (
	channelActorAccount  = "0198f4c2-7a30-7c91-a6d2-7d76f9188c37"
	channelActorMember   = "0198f4c2-7a32-7d02-b8c1-3f6e15aa91b4"
	channelTargetAccount = "0198f4c2-7a39-7c91-a6d2-7d76f9188c39"
	channelTargetMember  = "0198f4c2-7a37-7e45-913c-6baf30401a83"
	channelServerID      = "0198f4c2-7a31-7c91-a6d2-7d76f9188c38"
	channelID            = "0198f4c2-7a35-7c91-a6d2-7d76f9188c40"
	channelMemberID      = "0198f4c2-7a36-7c91-a6d2-7d76f9188c41"
	channelEnsureOp      = "0198f4c2-7a38-7e45-913c-6baf30401a84"
	channelRemoveOp      = "0198f4c2-7a3a-7e45-913c-6baf30401a85"
	channelRepairMember  = "0198f4c2-7a3d-7e45-913c-6baf30401a88"
	channelRepairOp      = "0198f4c2-7a3e-7e45-913c-6baf30401a89"
)

func TestEntRepositoryAddsAndRemovesPrivateChannelMember(t *testing.T) {
	repository, handle := openChannelMembershipRepository(t)
	now := time.Date(2026, 7, 31, 4, 30, 0, 0, time.UTC)
	seedChannelMembership(t, handle, now)
	ensured, err := repository.Change(
		context.Background(),
		channelmembershipport.Command{
			AccountID: channelActorAccount, ServerID: channelServerID,
			ChannelID: channelID, MemberID: channelTargetMember,
			ChannelMemberID: channelMemberID, OperationID: channelEnsureOp,
			IdempotencyKey: "channel-member-add-0001",
			RequestHash:    sha256.Sum256([]byte("ensure")),
			Action:         "ensure", ChangedAt: now,
		},
	)
	if err != nil || ensured.ChannelMemberID != channelMemberID {
		t.Fatalf("Change(ensure) = (%#v, %v)", ensured, err)
	}
	entity, err := handle.Client().ChannelMember.Get(
		context.Background(),
		channelMemberID,
	)
	if err != nil || entity.State != "active" ||
		entity.ImState != "provisioning" ||
		entity.MembershipVersion != 1 {
		t.Fatalf("channel member = (%#v, %v)", entity, err)
	}
	removed, err := repository.Change(
		context.Background(),
		channelmembershipport.Command{
			AccountID: channelActorAccount, ServerID: channelServerID,
			ChannelID: channelID, MemberID: channelTargetMember,
			ChannelMemberID: channelMemberID, OperationID: channelRemoveOp,
			IdempotencyKey: "channel-member-remove-0001",
			RequestHash:    sha256.Sum256([]byte("remove")),
			Action:         "remove", ChangedAt: now.Add(time.Minute),
		},
	)
	if err != nil || removed.OperationID != channelRemoveOp {
		t.Fatalf("Change(remove) = (%#v, %v)", removed, err)
	}
	entity, err = handle.Client().ChannelMember.Get(
		context.Background(),
		channelMemberID,
	)
	if err != nil || entity.State != "removed" ||
		entity.MembershipVersion != 2 {
		t.Fatalf("removed channel member = (%#v, %v)", entity, err)
	}
}

func TestEntRepositoryLetsMemberJoinSelfOnlyInPublicChannel(t *testing.T) {
	repository, handle := openChannelMembershipRepository(t)
	now := time.Date(2026, 7, 31, 4, 45, 0, 0, time.UTC)
	seedChannelMembership(t, handle, now)
	ctx := context.Background()
	actor, err := handle.Client().AccountServerMembership.Query().
		Where(
			accountservermembership.AccountIDEQ(channelActorAccount),
			accountservermembership.ServerIDEQ(channelServerID),
		).
		Only(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Client().AccountServerMembership.UpdateOne(actor).
		SetRole("member").Save(ctx); err != nil {
		t.Fatal(err)
	}
	command := channelmembershipport.Command{
		AccountID: channelActorAccount, ServerID: channelServerID,
		ChannelID: channelID, MemberID: channelActorMember,
		ChannelMemberID: "0198f4c2-7a3b-7e45-913c-6baf30401a86",
		OperationID:     "0198f4c2-7a3c-7e45-913c-6baf30401a87",
		IdempotencyKey:  "channel-self-join-0001",
		RequestHash:     sha256.Sum256([]byte("self join")),
		Action:          "ensure", ChangedAt: now,
	}
	if _, err := repository.Change(ctx, command); err != nil {
		t.Fatalf("Change(public self join) error = %v", err)
	}

	repository, handle = openChannelMembershipRepository(t)
	seedChannelMembership(t, handle, now)
	ctx = context.Background()
	actor, err = handle.Client().AccountServerMembership.Query().
		Where(
			accountservermembership.AccountIDEQ(channelActorAccount),
			accountservermembership.ServerIDEQ(channelServerID),
		).
		Only(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Client().AccountServerMembership.UpdateOne(actor).
		SetRole("member").Save(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Client().Channel.UpdateOneID(channelID).
		SetVisibility("private").Save(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := repository.Change(ctx, command); !errors.Is(err, channelmembershipport.ErrPermissionDenied) {
		t.Fatalf("Change(private self join) error = %v", err)
	}
}

func TestEntRepositoryLetsMemberReassertOwnActivePrivateMembership(
	t *testing.T,
) {
	repository, handle := openChannelMembershipRepository(t)
	now := time.Date(2026, 8, 17, 11, 30, 0, 0, time.UTC)
	seedChannelMembership(t, handle, now)
	ctx := context.Background()
	actor, err := handle.Client().AccountServerMembership.Query().
		Where(
			accountservermembership.AccountIDEQ(channelActorAccount),
			accountservermembership.ServerIDEQ(channelServerID),
		).
		Only(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Client().AccountServerMembership.UpdateOne(actor).
		SetRole("member").Save(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Client().Channel.UpdateOneID(channelID).
		SetVisibility("private").Save(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Client().ChannelMember.Create().
		SetID(channelRepairMember).
		SetServerID(channelServerID).
		SetChannelID(channelID).
		SetMemberID(channelActorMember).
		SetState("active").
		SetImState("ready").
		SetMembershipVersion(3).
		SetCreatedAt(now).
		SetUpdatedAt(now).
		Save(ctx); err != nil {
		t.Fatal(err)
	}

	result, err := repository.Change(
		ctx,
		channelmembershipport.Command{
			AccountID: channelActorAccount, ServerID: channelServerID,
			ChannelID: channelID, MemberID: channelActorMember,
			ChannelMemberID: "0198f4c2-7a3f-7e45-913c-6baf30401a8a",
			OperationID:     channelRepairOp,
			IdempotencyKey:  "channel-private-self-repair-0001",
			RequestHash:     sha256.Sum256([]byte("private self repair")),
			Action:          "ensure", ChangedAt: now.Add(time.Minute),
		},
	)

	if err != nil || result.ChannelMemberID != channelRepairMember ||
		result.OperationID != channelRepairOp {
		t.Fatalf("Change(private self repair) = (%#v, %v)", result, err)
	}
	membership, err := handle.Client().ChannelMember.Get(
		ctx,
		channelRepairMember,
	)
	if err != nil || membership.State != "active" ||
		membership.ImState != "provisioning" ||
		membership.MembershipVersion != 4 {
		t.Fatalf("repaired membership = (%#v, %v)", membership, err)
	}
	operation, err := handle.Client().TencentOperation.Get(ctx, channelRepairOp)
	if err != nil || operation.Kind != "im.membership.ensure" ||
		operation.DesiredRevision == nil || *operation.DesiredRevision != 4 ||
		operation.State != "pending" {
		t.Fatalf("repair operation = (%#v, %v)", operation, err)
	}
}

func openChannelMembershipRepository(
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

func seedChannelMembership(
	t *testing.T,
	handle *database.Handle,
	now time.Time,
) {
	t.Helper()
	ctx := context.Background()
	for _, value := range []struct {
		id, email, name, imUser string
	}{
		{channelActorAccount, "owner@example.com", "所有者", "u_OWNER"},
		{channelTargetAccount, "target@example.com", "目标", "u_TARGET"},
	} {
		if _, err := handle.Client().Account.Create().
			SetID(value.id).SetEmail(value.email).
			SetEmailNormalized(value.email).SetDisplayName(value.name).
			SetPasswordHash("test-only").SetTokenVersion(1).
			SetImUserID(value.imUser).SetImState("ready").SetRevision(1).
			SetCreatedAt(now).SetUpdatedAt(now).Save(ctx); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := handle.Client().Server.Create().
		SetID(channelServerID).SetSlug("channel-members").
		SetName("Channel 成员").SetOwnerMemberID(channelActorMember).
		SetImGroupID("@TGS#2CHANNEL").SetImState("ready").
		SetNextTaskNumber(1).SetRevision(1).
		SetCreatedAt(now).SetUpdatedAt(now).Save(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Client().Channel.Create().
		SetID(channelID).SetServerID(channelServerID).
		SetName("公开讨论").SetVisibility("public").
		SetImGroupID("@TGS#2CHANNEL").
		SetImTopicID("@TGS#2CHANNEL@TOPIC#_T_PRIVATE").
		SetImState("ready").SetRevision(1).
		SetCreatedAt(now).SetUpdatedAt(now).Save(ctx); err != nil {
		t.Fatal(err)
	}
	for _, value := range []struct {
		id, accountID, role, name string
	}{
		{channelActorMember, channelActorAccount, "owner", "所有者"},
		{channelTargetMember, channelTargetAccount, "member", "目标"},
	} {
		if _, err := handle.Client().Member.Create().
			SetID(value.id).SetServerID(channelServerID).
			SetAccountID(value.accountID).SetKind("human").
			SetRole(value.role).SetDisplayName(value.name).
			SetHandle(value.name).SetStatus("active").SetImState("ready").
			SetRevision(1).SetCreatedAt(now).SetUpdatedAt(now).
			Save(ctx); err != nil {
			t.Fatal(err)
		}
		if _, err := handle.Client().AccountServerMembership.Create().
			SetAccountID(value.accountID).SetServerID(channelServerID).
			SetMemberID(value.id).SetRole(value.role).SetStatus("active").
			SetServerNameSnapshot("Channel 成员").
			SetServerSlugSnapshot("channel-members").SetServerRevision(1).
			SetProjectedAt(now).SetUpdatedAt(now).Save(ctx); err != nil {
			t.Fatal(err)
		}
	}
}
