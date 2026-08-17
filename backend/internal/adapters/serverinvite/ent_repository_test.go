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
	repoSecondAccountID  = "0198f4c2-7a45-7c91-a6d2-7d76f9188c45"
	repoInviteServerID   = "0198f4c2-7a31-7c91-a6d2-7d76f9188c38"
	repoInviteMemberID   = "0198f4c2-7a32-7d02-b8c1-3f6e15aa91b4"
	repoInviteID         = "0198f4c2-7a36-7e45-913c-6baf30401a82"
	repoAcceptMemberID   = "0198f4c2-7a37-7e45-913c-6baf30401a83"
	repoAcceptOperation  = "0198f4c2-7a38-7e45-913c-6baf30401a84"
	repoRootChannelID    = "0198f4c2-7a40-7e45-913c-6baf30401a85"
	repoPrivateChannelID = "0198f4c2-7a43-7e45-913c-6baf30401a88"
	repoChannelMemberID  = "0198f4c2-7a44-7e45-913c-6baf30401a89"
	repoSecondMemberID   = "0198f4c2-7a46-7e45-913c-6baf30401a90"
	repoSecondOperation  = "0198f4c2-7a47-7e45-913c-6baf30401a91"
	repoMissingChannelID = "0198f4c2-7a48-7e45-913c-6baf30401a92"
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

func TestEntRepositoryRejectsInactiveInvite(t *testing.T) {
	tests := []struct {
		name      string
		wantUsage int64
		mutate    func(t *testing.T, handle *database.Handle)
	}{
		{
			name:      "expired",
			wantUsage: 0,
			mutate: func(t *testing.T, handle *database.Handle) {
				t.Helper()
				if _, err := handle.Client().ServerInvite.UpdateOneID(repoInviteID).
					SetExpiresAt(repoInviteNow).
					Save(context.Background()); err != nil {
					t.Fatal(err)
				}
			},
		},
		{
			name:      "revoked",
			wantUsage: 0,
			mutate: func(t *testing.T, handle *database.Handle) {
				t.Helper()
				if _, err := handle.Client().ServerInvite.UpdateOneID(repoInviteID).
					SetRevokedAt(repoInviteNow.Add(-time.Minute)).
					Save(context.Background()); err != nil {
					t.Fatal(err)
				}
			},
		},
		{
			name:      "exhausted",
			wantUsage: 1,
			mutate: func(t *testing.T, handle *database.Handle) {
				t.Helper()
				if _, err := handle.Client().ServerInvite.UpdateOneID(repoInviteID).
					SetMaxUses(1).
					SetUsedCount(1).
					Save(context.Background()); err != nil {
					t.Fatal(err)
				}
			},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			repository, handle := openInviteRepository(t)
			seedAcceptInvite(t, handle)
			test.mutate(t, handle)

			_, err := repository.Accept(
				context.Background(),
				acceptInviteCommand(
					repoAcceptAccountID,
					repoAcceptMemberID,
					repoAcceptOperation,
					"invite-inactive-"+test.name,
				),
			)
			if !errors.Is(err, inviteport.ErrInviteInvalid) {
				t.Fatalf("Accept(%s) error = %v", test.name, err)
			}
			assertInviteUsage(t, handle, test.wantUsage)
		})
	}
}

func TestEntRepositoryRejectsAlreadyMemberWithoutConsumingInvite(t *testing.T) {
	repository, handle := openInviteRepository(t)
	seedAcceptInvite(t, handle)
	first := acceptInviteCommand(
		repoAcceptAccountID,
		repoAcceptMemberID,
		repoAcceptOperation,
		"invite-first-membership",
	)
	if _, err := repository.Accept(context.Background(), first); err != nil {
		t.Fatal(err)
	}

	second := first
	second.MemberID = repoSecondMemberID
	second.OperationID = repoSecondOperation
	second.IdempotencyKey = "invite-existing-membership"
	_, err := repository.Accept(context.Background(), second)
	if !errors.Is(err, inviteport.ErrAlreadyMember) {
		t.Fatalf("Accept(existing member) error = %v", err)
	}
	assertInviteUsage(t, handle, 1)
}

func TestEntRepositoryRejectsAccountWithoutReadyIMIdentity(t *testing.T) {
	repository, handle := openInviteRepository(t)
	seedAcceptInvite(t, handle)
	if _, err := handle.Client().Account.UpdateOneID(repoAcceptAccountID).
		SetImState("provisioning").
		Save(context.Background()); err != nil {
		t.Fatal(err)
	}

	_, err := repository.Accept(
		context.Background(),
		acceptInviteCommand(
			repoAcceptAccountID,
			repoAcceptMemberID,
			repoAcceptOperation,
			"invite-account-not-ready",
		),
	)
	if !errors.Is(err, inviteport.ErrAccountNotReady) {
		t.Fatalf("Accept(account not ready) error = %v", err)
	}
	assertInviteUsage(t, handle, 0)
}

func TestEntRepositoryRejectsMissingLandingChannelOnCreate(t *testing.T) {
	repository, handle := openInviteRepository(t)
	seedInviteMembership(t, handle, "owner")
	missing := repoMissingChannelID

	_, err := repository.Create(
		context.Background(),
		inviteport.CreateCommand{
			AccountID:        repoInviteAccountID,
			ServerID:         repoInviteServerID,
			InviteID:         repoInviteID,
			TokenHash:        sha256.Sum256([]byte("rfi_missing_landing")),
			Role:             "member",
			MaxUses:          1,
			LandingChannelID: &missing,
			ExpiresAt:        repoInviteNow.Add(time.Hour),
			CreatedAt:        repoInviteNow,
		},
	)
	if !errors.Is(err, inviteport.ErrLandingNotFound) {
		t.Fatalf("Create(missing landing channel) error = %v", err)
	}
}

func TestEntRepositoryFallsBackToRootWhenLandingChannelIsMissing(t *testing.T) {
	repository, handle := openInviteRepository(t)
	seedAcceptInvite(t, handle)
	if _, err := handle.Client().ServerInvite.UpdateOneID(repoInviteID).
		SetLandingChannelID(repoMissingChannelID).
		Save(context.Background()); err != nil {
		t.Fatal(err)
	}

	result, err := repository.Accept(
		context.Background(),
		acceptInviteCommand(
			repoAcceptAccountID,
			repoAcceptMemberID,
			repoAcceptOperation,
			"invite-missing-landing",
		),
	)
	if err != nil {
		t.Fatal(err)
	}
	if result.LandingChannelID != repoRootChannelID {
		t.Fatalf("Accept(missing landing channel) landing = %q", result.LandingChannelID)
	}
	assertInviteUsage(t, handle, 1)
}

func TestEntRepositoryAllowsOnlyOneConsumerForLastInviteUse(t *testing.T) {
	repository, handle := openInviteRepository(t)
	seedAcceptInvite(t, handle)
	seedAcceptAccount(
		t,
		handle,
		repoSecondAccountID,
		"second-joiner@example.com",
		"第二位加入者",
		"u_SECOND_JOINER",
	)
	if _, err := handle.Client().ServerInvite.UpdateOneID(repoInviteID).
		SetMaxUses(1).
		Save(context.Background()); err != nil {
		t.Fatal(err)
	}

	commands := []inviteport.AcceptCommand{
		acceptInviteCommand(
			repoAcceptAccountID,
			repoAcceptMemberID,
			repoAcceptOperation,
			"invite-last-use-first",
		),
		acceptInviteCommand(
			repoSecondAccountID,
			repoSecondMemberID,
			repoSecondOperation,
			"invite-last-use-second",
		),
	}
	start := make(chan struct{})
	results := make(chan error, len(commands))
	for _, command := range commands {
		command := command
		go func() {
			<-start
			_, err := repository.Accept(context.Background(), command)
			results <- err
		}()
	}
	close(start)

	var succeeded, rejected int
	for range commands {
		switch err := <-results; {
		case err == nil:
			succeeded++
		case errors.Is(err, inviteport.ErrInviteInvalid):
			rejected++
		default:
			t.Fatalf("concurrent Accept() error = %v", err)
		}
	}
	if succeeded != 1 || rejected != 1 {
		t.Fatalf("concurrent Accept() = succeeded %d, rejected %d", succeeded, rejected)
	}
	assertInviteUsage(t, handle, 1)
	memberships, err := handle.Client().AccountServerMembership.Query().
		Where(accountservermembership.ServerIDEQ(repoInviteServerID)).
		Count(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if memberships != 1 {
		t.Fatalf("membership count = %d", memberships)
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
	seedAcceptAccount(
		t,
		handle,
		repoAcceptAccountID,
		"joiner@example.com",
		"加入者",
		"u_JOINER",
	)
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

func seedAcceptAccount(
	t *testing.T,
	handle *database.Handle,
	accountID string,
	email string,
	displayName string,
	imUserID string,
) {
	t.Helper()
	if _, err := handle.Client().Account.Create().
		SetID(accountID).
		SetEmail(email).
		SetEmailNormalized(email).
		SetDisplayName(displayName).
		SetPasswordHash("test-only").
		SetTokenVersion(1).
		SetImUserID(imUserID).
		SetImState("ready").
		SetRevision(1).
		SetCreatedAt(repoInviteNow).
		SetUpdatedAt(repoInviteNow).
		Save(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func acceptInviteCommand(
	accountID string,
	memberID string,
	operationID string,
	idempotencyKey string,
) inviteport.AcceptCommand {
	tokenHash := sha256.Sum256([]byte("rfi_routable_fixture"))
	return inviteport.AcceptCommand{
		AccountID:      accountID,
		ServerID:       repoInviteServerID,
		MemberID:       memberID,
		OperationID:    operationID,
		IdempotencyKey: idempotencyKey,
		RequestHash:    tokenHash,
		TokenHash:      tokenHash,
		Handle:         "h_" + memberID[len(memberID)-8:],
		AcceptedAt:     repoInviteNow,
	}
}

func assertInviteUsage(
	t *testing.T,
	handle *database.Handle,
	want int64,
) {
	t.Helper()
	entity, err := handle.Client().ServerInvite.Get(
		context.Background(),
		repoInviteID,
	)
	if err != nil {
		t.Fatal(err)
	}
	if entity.UsedCount != want {
		t.Fatalf("invite used count = %d, want %d", entity.UsedCount, want)
	}
}
