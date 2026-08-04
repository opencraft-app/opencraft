package runtimedirectory

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
	"time"

	"chatserver/internal/config"
	"chatserver/internal/database"
	"chatserver/internal/database/migration"
	directoryport "chatserver/internal/ports/runtimedirectory"
)

const (
	repoServerID       = "0198fa3d-8d91-7a2b-a067-dff9cc0aa101"
	repoSelfAgentID    = "0198fa3d-8d92-736a-b658-852313951102"
	repoHumanAccountID = "0198fa3d-8d93-75bf-85d0-64219fa90103"
	repoHumanMemberID  = "0198fa3d-8d94-7008-910d-c571bf3a0104"
	repoOtherAgentID   = "0198fa3d-8d95-732a-a52d-746a61c00105"
	repoInactiveID     = "0198fa3d-8d96-73cd-b7b4-fec69d910106"
	repoPublicChannel  = "0198fa3d-8d97-7357-8ddc-a98477ad0107"
	repoJoinedPrivate  = "0198fa3d-8d98-75c0-9363-bcb899c10108"
	repoHiddenPrivate  = "0198fa3d-8d99-7fa1-a2cf-209773de0109"
	repoOpenChannel    = "0198fa3d-8d9b-74b6-bbca-89aaf00f010b"
)

var repoNow = time.Date(2026, 8, 2, 16, 0, 0, 0, time.UTC)

func TestEntRepositoryReturnsOnlyAuthorizedRuntimeDirectory(t *testing.T) {
	repository, handle := openDirectoryRepository(t)
	seedDirectoryFacts(t, handle)

	got, err := repository.Get(context.Background(), repoServerID, repoSelfAgentID)
	if err != nil {
		t.Fatalf("Get() error = %v", err)
	}
	if got.Server.ID != repoServerID || got.Server.Slug != "engineering" ||
		got.Self.AgentID != repoSelfAgentID || got.Self.Handle != "builder" ||
		got.Self.IMUserID != "agent_builder" || len(got.Channels) != 3 ||
		len(got.Members) != 3 || len(got.Revision) != len("sha256:")+64 {
		t.Fatalf("Get() = %#v", got)
	}
	channelIDs := map[string]bool{}
	for _, channel := range got.Channels {
		channelIDs[channel.ID] = channel.Joined
		if channel.ID == repoHiddenPrivate {
			t.Fatal("hidden private channel leaked")
		}
	}
	if !channelIDs[repoPublicChannel] || !channelIDs[repoOpenChannel] ||
		!channelIDs[repoJoinedPrivate] {
		t.Fatalf("channels = %#v", got.Channels)
	}
	kinds := map[string]string{}
	for _, member := range got.Members {
		kinds[member.MemberID] = member.Kind + ":" + member.IMUserID
	}
	if kinds[repoSelfAgentID] != "agent:agent_builder" ||
		kinds[repoHumanMemberID] != "human:human_alice" ||
		kinds[repoOtherAgentID] != "agent:agent_reviewer" {
		t.Fatalf("members = %#v", got.Members)
	}
	if _, leaked := kinds[repoInactiveID]; leaked {
		t.Fatal("inactive member leaked")
	}

	repeated, err := repository.Get(context.Background(), repoServerID, repoSelfAgentID)
	if err != nil || repeated.Revision != got.Revision {
		t.Fatalf("stable revision = %q, %v; want %q", repeated.Revision, err, got.Revision)
	}
}

func TestEntRepositoryRejectsNonCurrentAgent(t *testing.T) {
	repository, handle := openDirectoryRepository(t)
	seedDirectoryFacts(t, handle)

	_, err := repository.Get(
		context.Background(),
		repoServerID,
		"0198fa3d-8d9a-74b6-bbca-89aaf00f010a",
	)
	if !errors.Is(err, directoryport.ErrNotFound) {
		t.Fatalf("Get() error = %v", err)
	}
}

func TestEntRepositoryReturnsAuthorizedChannelMembers(t *testing.T) {
	repository, handle := openDirectoryRepository(t)
	seedDirectoryFacts(t, handle)

	publicMembers, err := repository.GetChannelMembers(
		context.Background(), repoServerID, repoSelfAgentID, repoPublicChannel,
	)
	if err != nil {
		t.Fatalf("GetChannelMembers(public) error = %v", err)
	}
	if publicMembers.Channel.ID != repoPublicChannel ||
		len(publicMembers.Members) != 3 ||
		len(publicMembers.Revision) != len("sha256:")+64 {
		t.Fatalf("GetChannelMembers(public) = %#v", publicMembers)
	}
	openMembers, err := repository.GetChannelMembers(
		context.Background(), repoServerID, repoSelfAgentID, repoOpenChannel,
	)
	if err != nil {
		t.Fatalf("GetChannelMembers(open) error = %v", err)
	}
	if openMembers.Channel.ID != repoOpenChannel ||
		len(openMembers.Members) != 2 {
		t.Fatalf("GetChannelMembers(open) = %#v", openMembers)
	}

	privateMembers, err := repository.GetChannelMembers(
		context.Background(), repoServerID, repoSelfAgentID, repoJoinedPrivate,
	)
	if err != nil {
		t.Fatalf("GetChannelMembers(private) error = %v", err)
	}
	if privateMembers.Channel.ID != repoJoinedPrivate ||
		len(privateMembers.Members) != 1 ||
		privateMembers.Members[0].MemberID != repoSelfAgentID {
		t.Fatalf("GetChannelMembers(private) = %#v", privateMembers)
	}

	_, err = repository.GetChannelMembers(
		context.Background(), repoServerID, repoSelfAgentID, repoHiddenPrivate,
	)
	if !errors.Is(err, directoryport.ErrNotFound) {
		t.Fatalf("GetChannelMembers(hidden private) error = %v", err)
	}
}

func openDirectoryRepository(t *testing.T) (*EntRepository, *database.Handle) {
	t.Helper()
	cfg, err := config.NewDatabase(filepath.Join(t.TempDir(), "data", "chatserver.db"))
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

func seedDirectoryFacts(t *testing.T, handle *database.Handle) {
	t.Helper()
	ctx := context.Background()
	client := handle.Client()
	if _, err := client.Server.Create().
		SetID(repoServerID).SetSlug("engineering").SetName("研发").
		SetImGroupID("community-1").SetImState("ready").
		SetNextTaskNumber(1).SetRevision(7).
		SetCreatedAt(repoNow).SetUpdatedAt(repoNow).Save(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := client.Account.Create().
		SetID(repoHumanAccountID).SetEmail("alice@example.invalid").
		SetEmailNormalized("alice@example.invalid").SetDisplayName("Alice").
		SetPasswordHash("test-only").SetTokenVersion(1).
		SetImUserID("human_alice").SetImState("ready").SetRevision(1).
		SetCreatedAt(repoNow).SetUpdatedAt(repoNow).Save(ctx); err != nil {
		t.Fatal(err)
	}
	createMember := func(id, kind, handleValue, displayName, status string, accountID *string) {
		builder := client.Member.Create().SetID(id).SetServerID(repoServerID).
			SetKind(kind).SetRole("member").SetDisplayName(displayName).
			SetHandle(handleValue).SetStatus(status).SetImState("ready").
			SetRevision(1).SetCreatedAt(repoNow).SetUpdatedAt(repoNow)
		if accountID != nil {
			builder.SetAccountID(*accountID)
		}
		if _, err := builder.Save(ctx); err != nil {
			t.Fatal(err)
		}
	}
	createMember(repoSelfAgentID, "agent", "builder", "Builder", "active", nil)
	createMember(repoHumanMemberID, "human", "alice", "Alice", "active", &[]string{repoHumanAccountID}[0])
	createMember(repoOtherAgentID, "agent", "reviewer", "Reviewer", "active", nil)
	createMember(repoInactiveID, "agent", "disabled", "Disabled", "inactive", nil)
	createAgent := func(id, imUserID, desired string) {
		if _, err := client.Agent.Create().SetID(id).SetServerID(repoServerID).
			SetImUserID(imUserID).SetRuntimeKind("codex").SetRuntimeModel("default").
			SetReplyPolicy("mention_and_dm").SetDesiredState(desired).
			SetObservedState("running").SetCredentialVersion(1).SetImState("ready").
			SetCreatedByMemberID(repoSelfAgentID).SetRevision(1).
			SetCreatedAt(repoNow).SetUpdatedAt(repoNow).Save(ctx); err != nil {
			t.Fatal(err)
		}
	}
	createAgent(repoSelfAgentID, "agent_builder", "running")
	createAgent(repoOtherAgentID, "agent_reviewer", "running")
	createAgent(repoInactiveID, "agent_disabled", "stopped")
	createChannel := func(id, name, visibility string, topicID *string) {
		builder := client.Channel.Create().SetID(id).SetServerID(repoServerID).
			SetName(name).SetVisibility(visibility).SetImGroupID("community-1").
			SetImState("ready").SetRevision(1).
			SetCreatedAt(repoNow).SetUpdatedAt(repoNow)
		if topicID != nil {
			builder.SetImTopicID(*topicID)
		}
		if name == "全员" {
			builder.SetSystemKey("all")
		}
		if _, err := builder.Save(ctx); err != nil {
			t.Fatal(err)
		}
	}
	joinedTopic := "topic-private-joined"
	hiddenTopic := "topic-private-hidden"
	openTopic := "topic-public-independent"
	createChannel(repoPublicChannel, "全员", "public", nil)
	createChannel(repoOpenChannel, "公开项目", "public", &openTopic)
	createChannel(repoJoinedPrivate, "秘密项目", "private", &joinedTopic)
	createChannel(repoHiddenPrivate, "管理层", "private", &hiddenTopic)
	if _, err := client.ChannelMember.Create().SetServerID(repoServerID).
		SetChannelID(repoJoinedPrivate).SetMemberID(repoSelfAgentID).
		SetState("active").SetImState("ready").SetMembershipVersion(1).
		SetCreatedAt(repoNow).SetUpdatedAt(repoNow).Save(ctx); err != nil {
		t.Fatal(err)
	}
	for _, memberID := range []string{repoSelfAgentID, repoOtherAgentID} {
		if _, err := client.ChannelMember.Create().SetServerID(repoServerID).
			SetChannelID(repoOpenChannel).SetMemberID(memberID).
			SetState("active").SetImState("ready").SetMembershipVersion(1).
			SetCreatedAt(repoNow).SetUpdatedAt(repoNow).Save(ctx); err != nil {
			t.Fatal(err)
		}
	}
}
