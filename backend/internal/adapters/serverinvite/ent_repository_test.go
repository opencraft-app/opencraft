package serverinvite

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
	"chatserver/internal/ent/serverinvite"
	inviteport "chatserver/internal/ports/serverinvite"
)

const (
	repoInviteAccountID  = "0198f4c2-7a30-7c91-a6d2-7d76f9188c37"
	repoAcceptAccountID  = "0198f4c2-7a39-7c91-a6d2-7d76f9188c39"
	repoInviteServerID   = "0198f4c2-7a31-7c91-a6d2-7d76f9188c38"
	repoInviteMemberID   = "0198f4c2-7a32-7d02-b8c1-3f6e15aa91b4"
	repoInviteID         = "0198f4c2-7a36-7e45-913c-6baf30401a82"
	repoAcceptMemberID   = "0198f4c2-7a37-7e45-913c-6baf30401a83"
	repoAcceptOperation  = "0198f4c2-7a38-7e45-913c-6baf30401a84"
	repoRootChannelID    = "0198f4c2-7a40-7e45-913c-6baf30401a85"
	repoPrivateChannelID = "0198f4c2-7a43-7e45-913c-6baf30401a88"
	repoChannelMemberID  = "0198f4c2-7a44-7e45-913c-6baf30401a89"
)

var repoInviteNow = time.Date(2026, 7, 30, 23, 20, 0, 0, time.UTC)

func TestEntRepositoryCreatesListsAndRevokesInvite(t *testing.T) {
	repository, handle := openInviteRepository(t)
	seedInviteMembership(t, handle, "owner")
	tokenHash := sha256.Sum256([]byte("rfi_fixture"))

	created, err := repository.Create(
		context.Background(),
		inviteport.CreateCommand{
			AccountID: repoInviteAccountID,
			ServerID:  repoInviteServerID,
			InviteID:  repoInviteID,
			TokenHash: tokenHash,
			Role:      "member",
			MaxUses:   3,
			ExpiresAt: repoInviteNow.Add(24 * time.Hour),
			CreatedAt: repoInviteNow,
		},
	)

	if err != nil {
		t.Fatal(err)
	}
	if created.ID != repoInviteID ||
		created.UsedCount != 0 ||
		created.Revision != 1 {
		t.Fatalf("Create() = %#v", created)
	}
	entity, err := handle.Client().ServerInvite.Query().Only(
		context.Background(),
	)
	if err != nil {
		t.Fatal(err)
	}
	if string(entity.TokenHash) == "rfi_fixture" ||
		entity.CreatedByMemberID != repoInviteMemberID {
		t.Fatalf("entity = %#v", entity)
	}
	values, err := repository.List(
		context.Background(),
		repoInviteAccountID,
		repoInviteServerID,
	)
	if err != nil || len(values) != 1 || values[0].ID != repoInviteID {
		t.Fatalf("List() = (%#v, %v)", values, err)
	}

	err = repository.Revoke(
		context.Background(),
		inviteport.RevokeCommand{
			AccountID: repoInviteAccountID,
			ServerID:  repoInviteServerID,
			InviteID:  repoInviteID,
			RevokedAt: repoInviteNow.Add(time.Minute),
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	revoked, err := handle.Client().ServerInvite.Query().
		Where(serverinvite.IDEQ(repoInviteID)).
		Only(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if revoked.RevokedAt == nil ||
		revoked.Revision != 2 {
		t.Fatalf("revoked = %#v", revoked)
	}
	values, err = repository.List(
		context.Background(),
		repoInviteAccountID,
		repoInviteServerID,
	)
	if err != nil || len(values) != 0 {
		t.Fatalf("List(after revoke) = (%#v, %v)", values, err)
	}
}

func TestEntRepositoryRequiresOwnerOrAdmin(t *testing.T) {
	repository, handle := openInviteRepository(t)
	seedInviteMembership(t, handle, "member")

	_, err := repository.Create(
		context.Background(),
		inviteport.CreateCommand{
			AccountID: repoInviteAccountID,
			ServerID:  repoInviteServerID,
			InviteID:  repoInviteID,
			TokenHash: sha256.Sum256([]byte("rfi_fixture")),
			Role:      "member",
			MaxUses:   1,
			ExpiresAt: repoInviteNow.Add(time.Hour),
			CreatedAt: repoInviteNow,
		},
	)

	if !errors.Is(err, inviteport.ErrPermissionDenied) {
		t.Fatalf("Create(member) error = %v", err)
	}
}

func TestEntRepositoryAcceptsInviteAtomicallyAndIdempotently(t *testing.T) {
	repository, handle := openInviteRepository(t)
	seedAcceptInvite(t, handle)
	tokenHash := sha256.Sum256([]byte("rfi_routable_fixture"))
	command := inviteport.AcceptCommand{
		AccountID:           repoAcceptAccountID,
		ServerID:            repoInviteServerID,
		MemberID:            repoAcceptMemberID,
		OperationID:         repoAcceptOperation,
		IdempotencyKey:      "invite-accept-0001",
		RequestHash:         tokenHash,
		TokenHash:           tokenHash,
		Handle:              "h_accept",
		AllowExistingMember: true,
		AcceptedAt:          repoInviteNow,
	}

	result, err := repository.Accept(context.Background(), command)
	if err != nil {
		t.Fatal(err)
	}
	if result.MemberID != repoAcceptMemberID ||
		result.ServerID != repoInviteServerID ||
		result.ServerSlug != "invite-test" ||
		result.LandingChannelID != repoRootChannelID ||
		result.OperationID != repoAcceptOperation {
		t.Fatalf("Accept() = %#v", result)
	}
	memberEntity, err := handle.Client().Member.Get(
		context.Background(),
		repoAcceptMemberID,
	)
	if err != nil ||
		memberEntity.AccountID == nil ||
		*memberEntity.AccountID != repoAcceptAccountID ||
		memberEntity.ImState != "provisioning" {
		t.Fatalf("member = (%#v, %v)", memberEntity, err)
	}
	projection, err := handle.Client().AccountServerMembership.Query().
		Where(
			accountservermembership.AccountIDEQ(repoAcceptAccountID),
			accountservermembership.ServerIDEQ(repoInviteServerID),
		).
		Only(context.Background())
	if err != nil ||
		projection.MemberID != repoAcceptMemberID ||
		projection.Status != "active" {
		t.Fatalf("projection = (%#v, %v)", projection, err)
	}
	operation, err := handle.Client().TencentOperation.Get(
		context.Background(),
		repoAcceptOperation,
	)
	if err != nil ||
		operation.Kind != "im.membership.ensure" ||
		operation.ResourceID != repoAcceptMemberID {
		t.Fatalf("operation = (%#v, %v)", operation, err)
	}
	inviteEntity, err := handle.Client().ServerInvite.Get(
		context.Background(),
		repoInviteID,
	)
	if err != nil || inviteEntity.UsedCount != 1 {
		t.Fatalf("invite = (%#v, %v)", inviteEntity, err)
	}
	if _, err := handle.Client().Channel.Create().
		SetID(repoPrivateChannelID).
		SetServerID(repoInviteServerID).
		SetName("private-landing").
		SetVisibility("private").
		SetImGroupID("@TGS#2INVITE").
		SetImTopicID("private-landing-topic").
		SetImState("ready").
		SetRevision(1).
		SetCreatedAt(repoInviteNow).
		SetUpdatedAt(repoInviteNow).
		Save(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Client().ChannelMember.Create().
		SetID(repoChannelMemberID).
		SetServerID(repoInviteServerID).
		SetChannelID(repoPrivateChannelID).
		SetMemberID(repoAcceptMemberID).
		SetState("active").
		SetImState("ready").
		SetMembershipVersion(1).
		SetCreatedAt(repoInviteNow).
		SetUpdatedAt(repoInviteNow).
		Save(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Client().ServerInvite.UpdateOneID(repoInviteID).
		SetLandingChannelID(repoPrivateChannelID).
		Save(context.Background()); err != nil {
		t.Fatal(err)
	}
	existing := command
	existing.MemberID = "0198f4c2-7a41-7e45-913c-6baf30401a86"
	existing.OperationID = "0198f4c2-7a42-7e45-913c-6baf30401a87"
	existing.IdempotencyKey = "invite-accept-existing-0002"
	existingResult, err := repository.Accept(context.Background(), existing)
	if err != nil ||
		existingResult.MemberID != repoAcceptMemberID ||
		existingResult.OperationID != "" ||
		existingResult.ServerSlug != "invite-test" ||
		existingResult.LandingChannelID != repoPrivateChannelID {
		t.Fatalf("Accept(existing member) = (%#v, %v)", existingResult, err)
	}
	inviteEntity, err = handle.Client().ServerInvite.Get(
		context.Background(),
		repoInviteID,
	)
	if err != nil || inviteEntity.UsedCount != 1 {
		t.Fatalf("invite after existing member replay = (%#v, %v)", inviteEntity, err)
	}
	replayed, err := repository.Accept(context.Background(), command)
	if err != nil || replayed != result {
		t.Fatalf("Accept(replay) = (%#v, %v)", replayed, err)
	}
	conflict := command
	conflict.RequestHash = sha256.Sum256([]byte("different"))
	if _, err := repository.Accept(
		context.Background(),
		conflict,
	); !errors.Is(err, inviteport.ErrIdempotency) {
		t.Fatalf("Accept(conflict) error = %v", err)
	}
}

func openInviteRepository(
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

func seedInviteMembership(
	t *testing.T,
	handle *database.Handle,
	role string,
) {
	t.Helper()
	_, err := handle.Client().AccountServerMembership.Create().
		SetAccountID(repoInviteAccountID).
		SetServerID(repoInviteServerID).
		SetMemberID(repoInviteMemberID).
		SetRole(role).
		SetStatus("active").
		SetServerNameSnapshot("Invite 测试").
		SetServerSlugSnapshot("invite-test").
		SetServerRevision(1).
		SetProjectedAt(repoInviteNow).
		SetUpdatedAt(repoInviteNow).
		Save(context.Background())
	if err != nil {
		t.Fatal(err)
	}
}

func seedAcceptInvite(t *testing.T, handle *database.Handle) {
	t.Helper()
	ctx := context.Background()
	if _, err := handle.Client().Account.Create().
		SetID(repoAcceptAccountID).
		SetEmail("joiner@example.com").
		SetEmailNormalized("joiner@example.com").
		SetDisplayName("加入者").
		SetPasswordHash("test-only").
		SetTokenVersion(1).
		SetImUserID("u_JOINER").
		SetImState("ready").
		SetRevision(1).
		SetCreatedAt(repoInviteNow).
		SetUpdatedAt(repoInviteNow).
		Save(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Client().Server.Create().
		SetID(repoInviteServerID).
		SetSlug("invite-test").
		SetName("Invite 测试").
		SetImGroupID("@TGS#2INVITE").
		SetImState("ready").
		SetNextTaskNumber(1).
		SetRevision(1).
		SetCreatedAt(repoInviteNow).
		SetUpdatedAt(repoInviteNow).
		Save(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Client().Channel.Create().
		SetID(repoRootChannelID).
		SetServerID(repoInviteServerID).
		SetName("全员").
		SetVisibility("public").
		SetSystemKey("all").
		SetImGroupID("@TGS#2INVITE").
		SetImState("ready").
		SetRevision(1).
		SetCreatedAt(repoInviteNow).
		SetUpdatedAt(repoInviteNow).
		Save(ctx); err != nil {
		t.Fatal(err)
	}
	hash := sha256.Sum256([]byte("rfi_routable_fixture"))
	if _, err := handle.Client().ServerInvite.Create().
		SetID(repoInviteID).
		SetServerID(repoInviteServerID).
		SetTokenHash(hash[:]).
		SetRole("member").
		SetMaxUses(2).
		SetUsedCount(0).
		SetExpiresAt(repoInviteNow.Add(time.Hour)).
		SetCreatedByMemberID(repoInviteMemberID).
		SetRevision(1).
		SetCreatedAt(repoInviteNow.Add(-time.Minute)).
		SetUpdatedAt(repoInviteNow.Add(-time.Minute)).
		Save(ctx); err != nil {
		t.Fatal(err)
	}
}
