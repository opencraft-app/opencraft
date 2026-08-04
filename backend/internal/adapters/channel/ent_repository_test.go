package channel

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
	channelport "chatserver/internal/ports/channel"
)

const (
	repoChannelAccountID    = "0198f4c2-7a30-7c91-a6d2-7d76f9188c37"
	repoChannelServerID     = "0198f4c2-7a31-7c91-a6d2-7d76f9188c38"
	repoChannelMemberID     = "0198f4c2-7a32-7d02-b8c1-3f6e15aa91b4"
	repoChannelID           = "0198f4c2-7a36-7e45-913c-6baf30401a82"
	repoChannelOperationID  = "0198f4c2-7a37-7e45-913c-6baf30401a83"
	repoInitialMembershipID = "0198f4c2-7a38-7e45-913c-6baf30401a84"
	repoChannelMemberOpID   = "0198f4c2-7a39-7e45-913c-6baf30401a85"
	repoChannelGroupID      = "@TGS#_C_5ODDSBF3PNVZH25YMT3OMJ4ZSF"
	repoChannelTopicID      = repoChannelGroupID + "@TOPIC#_T_46HDVNIIYDGRIRBGXZTJ7KMFLP"
)

var repoChannelNow = time.Date(2026, 7, 30, 23, 10, 0, 0, time.UTC)

func TestEntRepositoryCreatesListsAndGetsChannel(t *testing.T) {
	repository, handle := openChannelRepository(t)
	seedChannelServer(t, handle, "owner", "ready")
	serverContext, err := repository.GetServerContext(
		context.Background(),
		repoChannelAccountID,
		repoChannelServerID,
	)
	if err != nil {
		t.Fatal(err)
	}
	if serverContext.IMGroupID != repoChannelGroupID ||
		serverContext.Role != "owner" ||
		serverContext.IMState != "ready" {
		t.Fatalf("server context = %#v", serverContext)
	}
	description := "项目讨论"
	command := channelport.CreateCommand{
		AccountID: repoChannelAccountID, ServerID: repoChannelServerID,
		IdempotencyKey: "channel-create-0001",
		RequestHash:    sha256.Sum256([]byte("channel")),
		Channel: channelport.Draft{
			ID: repoChannelID, Name: "研发", Description: &description,
			Visibility: "private",
			IMGroupID:  repoChannelGroupID,
			IMTopicID:  repoChannelTopicID, IMTopicName: "C-46HDVNIIYDGRIRBGXZTJ",
		},
		OperationID:                  repoChannelOperationID,
		InitialChannelMemberID:       repoInitialMembershipID,
		InitialMembershipOperationID: repoChannelMemberOpID,
		CreatedAt:                    repoChannelNow,
	}
	result, err := repository.Create(context.Background(), command)
	if err != nil {
		t.Fatal(err)
	}
	if result.Channel.ID != repoChannelID ||
		result.Channel.IMState != "provisioning" ||
		result.Channel.IMTopicID == nil ||
		*result.Channel.IMTopicID != repoChannelTopicID ||
		len(result.Operations) != 2 ||
		result.Operations[0].Kind != "im.topic.ensure" ||
		result.Operations[1].Kind != "im.membership.ensure" {
		t.Fatalf("Create() = %#v", result)
	}
	replay := command
	replay.Channel.ID = "0198f4c2-7a46-7e45-913c-6baf30401a82"
	replay.OperationID = "0198f4c2-7a47-7e45-913c-6baf30401a83"
	replay.InitialChannelMemberID = "0198f4c2-7a48-7e45-913c-6baf30401a84"
	replay.InitialMembershipOperationID = "0198f4c2-7a49-7e45-913c-6baf30401a85"
	replayed, err := repository.Create(context.Background(), replay)
	if err != nil || replayed.Channel.ID != repoChannelID ||
		len(replayed.Operations) != 2 ||
		replayed.Operations[0].ID != repoChannelOperationID ||
		replayed.Operations[1].ID != repoChannelMemberOpID {
		t.Fatalf("Create(replay) = (%#v, %v)", replayed, err)
	}
	values, err := repository.List(
		context.Background(),
		repoChannelAccountID,
		repoChannelServerID,
	)
	if err != nil || len(values) != 1 || values[0].ID != repoChannelID {
		t.Fatalf("List() = (%#v, %v)", values, err)
	}
	value, err := repository.Get(
		context.Background(),
		repoChannelAccountID,
		repoChannelServerID,
		repoChannelID,
	)
	if err != nil || value.Name != "研发" {
		t.Fatalf("Get() = (%#v, %v)", value, err)
	}
	if count, err := handle.Client().TencentOperation.Query().Count(
		context.Background(),
	); err != nil || count != 2 {
		t.Fatalf("operation count = (%d, %v)", count, err)
	}
	initial, err := handle.Client().ChannelMember.Get(
		context.Background(), repoInitialMembershipID,
	)
	if err != nil || initial.MemberID != repoChannelMemberID ||
		initial.ChannelID != repoChannelID || initial.State != "active" ||
		initial.ImState != "provisioning" {
		t.Fatalf("initial channel member = (%#v, %v)", initial, err)
	}

	nextName := "产品研发"
	nextDescription := "新的协作说明"
	update := channelport.UpdateCommand{
		AccountID: repoChannelAccountID, ServerID: repoChannelServerID,
		ChannelID: repoChannelID, Revision: 1,
		IdempotencyKey: "channel-update-0001",
		RequestHash:    sha256.Sum256([]byte("channel update")),
		NameSet:        true, Name: nextName,
		DescriptionSet: true, Description: &nextDescription,
		UpdatedAt: repoChannelNow.Add(time.Minute),
	}
	updated, err := repository.Update(context.Background(), update)
	if err != nil {
		t.Fatal(err)
	}
	if updated.Name != nextName || updated.Description == nil ||
		*updated.Description != nextDescription || updated.Revision != 2 ||
		updated.IMState != "provisioning" {
		t.Fatalf("Update() = %#v", updated)
	}
	updateReplayed, err := repository.Update(context.Background(), update)
	if err != nil || updateReplayed.Revision != 2 ||
		updateReplayed.Name != nextName {
		t.Fatalf("Update(replay) = (%#v, %v)", updateReplayed, err)
	}
	stale := update
	stale.IdempotencyKey = "channel-update-0002"
	stale.RequestHash = sha256.Sum256([]byte("stale channel update"))
	stale.Revision = 1
	if _, err := repository.Update(
		context.Background(),
		stale,
	); !errors.Is(err, channelport.ErrRevisionConflict) {
		t.Fatalf("Update(stale) error = %v", err)
	}
}

func TestEntRepositoryRequiresAdminForChannelCreation(t *testing.T) {
	repository, handle := openChannelRepository(t)
	seedChannelServer(t, handle, "member", "ready")
	_, err := repository.Create(
		context.Background(),
		channelport.CreateCommand{
			AccountID: repoChannelAccountID, ServerID: repoChannelServerID,
			IdempotencyKey: "channel-create-0001",
			RequestHash:    sha256.Sum256([]byte("channel")),
			Channel: channelport.Draft{
				ID: repoChannelID, Name: "研发", Visibility: "public",
				IMGroupID: repoChannelGroupID, IMTopicID: repoChannelTopicID,
				IMTopicName: "C-46HDVNIIYDGRIRBGXZTJ",
			},
			OperationID: repoChannelOperationID,
			CreatedAt:   repoChannelNow,
		},
	)
	if !errors.Is(err, channelport.ErrPermissionDenied) {
		t.Fatalf("Create(member) error = %v", err)
	}
}

func TestEntRepositoryProjectsPublicDiscoveryAndIndependentMembership(t *testing.T) {
	repository, handle := openChannelRepository(t)
	seedChannelServer(t, handle, "member", "ready")
	ctx := context.Background()

	const (
		rootID          = "0198f4c2-7b10-7e45-913c-6baf30401a90"
		publicID        = "0198f4c2-7b11-7e45-913c-6baf30401a91"
		joinedPrivateID = "0198f4c2-7b12-7e45-913c-6baf30401a92"
		hiddenPrivateID = "0198f4c2-7b13-7e45-913c-6baf30401a93"
		membershipID    = "0198f4c2-7b14-7e45-913c-6baf30401a94"
		joiningID       = "0198f4c2-7b15-7e45-913c-6baf30401a95"
	)
	createChannel := func(id, name, visibility string, systemKey *string) {
		builder := handle.Client().Channel.Create().
			SetID(id).
			SetServerID(repoChannelServerID).
			SetName(name).
			SetVisibility(visibility).
			SetImGroupID(repoChannelGroupID).
			SetImState("ready").
			SetRevision(1).
			SetCreatedAt(repoChannelNow).
			SetUpdatedAt(repoChannelNow)
		if systemKey != nil {
			builder.SetSystemKey(*systemKey)
		} else {
			builder.SetImTopicID(repoChannelTopicID + id[len(id)-2:])
		}
		if _, err := builder.Save(ctx); err != nil {
			t.Fatal(err)
		}
	}
	rootKey := "all"
	createChannel(rootID, "全员", "public", &rootKey)
	createChannel(publicID, "公开讨论", "public", nil)
	createChannel(joinedPrivateID, "已加入私密", "private", nil)
	createChannel(hiddenPrivateID, "未加入私密", "private", nil)
	if _, err := handle.Client().ChannelMember.Create().
		SetID(membershipID).
		SetServerID(repoChannelServerID).
		SetChannelID(joinedPrivateID).
		SetMemberID(repoChannelMemberID).
		SetState("active").
		SetImState("ready").
		SetMembershipVersion(1).
		SetCreatedAt(repoChannelNow).
		SetUpdatedAt(repoChannelNow).
		Save(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Client().ChannelMember.Create().
		SetID(joiningID).
		SetServerID(repoChannelServerID).
		SetChannelID(publicID).
		SetMemberID(repoChannelMemberID).
		SetState("active").
		SetImState("provisioning").
		SetMembershipVersion(1).
		SetCreatedAt(repoChannelNow).
		SetUpdatedAt(repoChannelNow).
		Save(ctx); err != nil {
		t.Fatal(err)
	}

	values, err := repository.List(ctx, repoChannelAccountID, repoChannelServerID)
	if err != nil {
		t.Fatal(err)
	}
	got := make(map[string]channelport.Channel, len(values))
	for _, value := range values {
		got[value.ID] = value
	}
	if len(got) != 3 || !got[rootID].Joined || got[publicID].Joined ||
		!got[joinedPrivateID].Joined {
		t.Fatalf("List() visibility/joined projection = %#v", values)
	}
	if _, exists := got[hiddenPrivateID]; exists {
		t.Fatalf("List() unexpectedly exposed private channel: %#v", values)
	}

	publicValue, err := repository.Get(
		ctx, repoChannelAccountID, repoChannelServerID, publicID,
	)
	if err != nil || publicValue.Joined {
		t.Fatalf("Get(public unjoined) = (%#v, %v)", publicValue, err)
	}
	if _, err := repository.Get(
		ctx, repoChannelAccountID, repoChannelServerID, hiddenPrivateID,
	); !errors.Is(err, channelport.ErrChannelNotFound) {
		t.Fatalf("Get(private unjoined) error = %v", err)
	}
}

func openChannelRepository(t *testing.T) (*EntRepository, *database.Handle) {
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

func seedChannelServer(
	t *testing.T,
	handle *database.Handle,
	role string,
	imState string,
) {
	t.Helper()
	ctx := context.Background()
	if _, err := handle.Client().Server.Create().
		SetID(repoChannelServerID).
		SetSlug("channel-test").
		SetName("Channel 测试").
		SetImGroupID(repoChannelGroupID).
		SetImState(imState).
		SetNextTaskNumber(1).
		SetRevision(2).
		SetCreatedAt(repoChannelNow).
		SetUpdatedAt(repoChannelNow).
		Save(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Client().AccountServerMembership.Create().
		SetAccountID(repoChannelAccountID).
		SetServerID(repoChannelServerID).
		SetMemberID(repoChannelMemberID).
		SetRole(role).
		SetStatus("active").
		SetServerNameSnapshot("Channel 测试").
		SetServerSlugSnapshot("channel-test").
		SetServerRevision(2).
		SetProjectedAt(repoChannelNow).
		SetUpdatedAt(repoChannelNow).
		Save(ctx); err != nil {
		t.Fatal(err)
	}
}
