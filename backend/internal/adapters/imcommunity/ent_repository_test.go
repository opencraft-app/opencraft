package imcommunity

import (
	"context"
	"testing"
	"time"

	"chatserver/internal/config"
	"chatserver/internal/database"
	"chatserver/internal/database/migration"
	"chatserver/internal/persistedjson"
	imcommunityport "chatserver/internal/ports/imcommunity"
)

const (
	communityAccountID        = "019b1f87-5dab-7cc1-a8e9-ad53ce7c3651"
	communityServerID         = "019b1f87-5dab-7cc1-a8e9-ad53ce7c3652"
	communityMemberID         = "019b1f87-5dab-7cc1-a8e9-ad53ce7c3653"
	communityChannelID        = "019b1f87-5dab-7cc1-a8e9-ad53ce7c3654"
	communityOperationID      = "019b1f87-5dab-7cc1-a8e9-ad53ce7c3655"
	communityTopicOperationID = "019b1f87-5dab-7cc1-a8e9-ad53ce7c3656"
	communityTopicID          = "@TGS#_C_TEST@TOPIC#_T_46HDVNIIYDGRIRBGXZTJ7KMFLP"
)

var communityRepoNow = time.Date(2026, 7, 30, 20, 30, 0, 0, time.UTC)

func TestRepositoryClaimsCommunityAndAtomicallyMarksAggregateReady(t *testing.T) {
	handle := openCommunityDatabase(t)
	seedCommunity(t, handle)
	repository, err := NewEntRepository(handle)
	if err != nil {
		t.Fatal(err)
	}
	work, ok, err := repository.Claim(context.Background(), imcommunityport.Claim{
		LeaseOwner:     "worker-community",
		Now:            communityRepoNow,
		LeaseExpiresAt: communityRepoNow.Add(time.Minute),
	})
	if err != nil || !ok {
		t.Fatalf("Claim() = (%#v, %v, %v)", work, ok, err)
	}
	if work.ServerID != communityServerID ||
		work.ServerName != "工程部" ||
		work.GroupID != "@TGS#_C_TEST" ||
		work.OwnerIMUserID != "u_OWNER" ||
		work.RootChannelID != communityChannelID ||
		work.ServerRevision != 1 ||
		work.DesiredRevision != 1 {
		t.Fatalf("work = %#v", work)
	}
	err = repository.Complete(context.Background(), imcommunityport.Completion{
		OperationID: communityOperationID,
		LeaseOwner:  "worker-community",
		Status:      imcommunityport.CompletionSucceeded,
		CompletedAt: communityRepoNow.Add(time.Second),
	})
	if err != nil {
		t.Fatal(err)
	}
	server, err := handle.Client().Server.Get(context.Background(), communityServerID)
	if err != nil {
		t.Fatal(err)
	}
	member, err := handle.Client().Member.Get(context.Background(), communityMemberID)
	if err != nil {
		t.Fatal(err)
	}
	channel, err := handle.Client().Channel.Get(context.Background(), communityChannelID)
	if err != nil {
		t.Fatal(err)
	}
	operation, err := handle.Client().TencentOperation.Get(
		context.Background(),
		communityOperationID,
	)
	if err != nil {
		t.Fatal(err)
	}
	topicOperation, topicErr := handle.Client().TencentOperation.Get(
		context.Background(), communityTopicOperationID,
	)
	if topicErr != nil {
		t.Fatal(topicErr)
	}
	if server.ImState != "ready" || server.Revision != 2 ||
		member.ImState != "ready" || channel.ImState != "provisioning" ||
		topicOperation.Kind != "im.topic.ensure" ||
		topicOperation.ResourceID != communityChannelID ||
		topicOperation.State != "pending" ||
		operation.State != "succeeded" {
		t.Fatalf("aggregate = (%#v, %#v, %#v, %#v, %#v)",
			server, member, channel, operation, topicOperation)
	}
}

func openCommunityDatabase(t *testing.T) *database.Handle {
	t.Helper()
	cfg, err := config.NewDatabase(t.TempDir() + "/data/chatserver.db")
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
	return handle
}

func seedCommunity(t *testing.T, handle *database.Handle) {
	t.Helper()
	ctx := context.Background()
	if _, err := handle.Client().Account.Create().
		SetID(communityAccountID).
		SetEmail("owner@example.com").
		SetEmailNormalized("owner@example.com").
		SetDisplayName("Owner").
		SetPasswordHash("unused").
		SetTokenVersion(1).
		SetImUserID("u_OWNER").
		SetImState("ready").
		SetRevision(1).
		SetCreatedAt(communityRepoNow).
		SetUpdatedAt(communityRepoNow).
		Save(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Client().Server.Create().
		SetID(communityServerID).
		SetSlug("engineering").
		SetName("工程部").
		SetDescription("Agent 协作空间").
		SetOwnerMemberID(communityMemberID).
		SetImGroupID("@TGS#_C_TEST").
		SetImState("provisioning").
		SetNextTaskNumber(1).
		SetRevision(1).
		SetCreatedAt(communityRepoNow).
		SetUpdatedAt(communityRepoNow).
		Save(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Client().Member.Create().
		SetID(communityMemberID).
		SetServerID(communityServerID).
		SetAccountID(communityAccountID).
		SetKind("human").
		SetRole("owner").
		SetDisplayName("Owner").
		SetHandle("u_OWNER_HANDLE").
		SetStatus("active").
		SetImState("provisioning").
		SetRevision(1).
		SetCreatedAt(communityRepoNow).
		SetUpdatedAt(communityRepoNow).
		Save(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Client().Channel.Create().
		SetID(communityChannelID).
		SetServerID(communityServerID).
		SetName("全员").
		SetVisibility("public").
		SetSystemKey("all").
		SetImGroupID("@TGS#_C_TEST").
		SetImTopicID(communityTopicID).
		SetImState("provisioning").
		SetRevision(1).
		SetCreatedAt(communityRepoNow).
		SetUpdatedAt(communityRepoNow).
		Save(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Client().AccountServerMembership.Create().
		SetAccountID(communityAccountID).
		SetServerID(communityServerID).
		SetMemberID(communityMemberID).
		SetRole("owner").
		SetStatus("active").
		SetServerNameSnapshot("工程部").
		SetServerSlugSnapshot("engineering").
		SetServerRevision(1).
		SetProjectedAt(communityRepoNow).
		SetUpdatedAt(communityRepoNow).
		Save(ctx); err != nil {
		t.Fatal(err)
	}
	snapshot, err := persistedjson.EncodeSnapshot(
		"im",
		"im.community.ensure",
		struct {
			RootTopicOperationID string `json:"rootTopicOperationId"`
		}{RootTopicOperationID: communityTopicOperationID},
	)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Client().TencentOperation.Create().
		SetID(communityOperationID).
		SetPartitionKey(communityServerID).
		SetServerID(communityServerID).
		SetService("im").
		SetKind("im.community.ensure").
		SetResourceType("server").
		SetResourceID(communityServerID).
		SetIdempotencyKey("community-v1").
		SetRequestSnapshotJSON(snapshot).
		SetDesiredRevision(1).
		SetState("pending").
		SetAttempts(0).
		SetCreatedAt(communityRepoNow).
		SetUpdatedAt(communityRepoNow).
		Save(ctx); err != nil {
		t.Fatal(err)
	}
}
