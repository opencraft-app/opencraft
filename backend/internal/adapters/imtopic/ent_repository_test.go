package imtopic

import (
	"context"
	"testing"
	"time"

	"chatserver/internal/config"
	"chatserver/internal/database"
	"chatserver/internal/database/migration"
	imtopicport "chatserver/internal/ports/imtopic"
)

const (
	topicAccountID         = "019b1f87-5dab-7cc1-a8e9-ad53ce7c3651"
	topicServerID          = "019b1f87-5dab-7cc1-a8e9-ad53ce7c3652"
	topicMemberID          = "019b1f87-5dab-7cc1-a8e9-ad53ce7c3653"
	topicChannelID         = "019b1f87-5dab-7cc1-a8e9-ad53ce7c3654"
	topicOperationID       = "019b1f87-5dab-7cc1-a8e9-ad53ce7c3655"
	topicRepairOperationID = "019b1f87-5dab-7cc1-a8e9-ad53ce7c3656"
	topicGroupID           = "@TGS#_C_TEST"
	topicIMID              = topicGroupID + "@TOPIC#_T_ABCDEFGHIJKLMNOPQRSTUVWX12"
)

type fixedRepairDeriver struct{}

func (fixedRepairDeriver) Topic(string, string, string) (string, string, error) {
	return topicIMID, "C-ABCDEFGHIJKLMNOPQRST", nil
}

type fixedRepairIDs struct{ used bool }

func (ids *fixedRepairIDs) New() (string, error) {
	ids.used = true
	return topicRepairOperationID, nil
}

var topicRepoNow = time.Date(2026, 7, 30, 23, 30, 0, 0, time.UTC)

func TestRepositoryClaimsTopicAndMarksChannelReady(t *testing.T) {
	handle := openTopicDatabase(t)
	seedTopic(t, handle)
	repository, err := NewEntRepository(handle)
	if err != nil {
		t.Fatal(err)
	}
	work, ok, err := repository.Claim(context.Background(), imtopicport.Claim{
		LeaseOwner:     "worker-topic",
		Now:            topicRepoNow,
		LeaseExpiresAt: topicRepoNow.Add(time.Minute),
	})
	if err != nil || !ok {
		t.Fatalf("Claim() = (%#v, %v, %v)", work, ok, err)
	}
	if work.ChannelID != topicChannelID ||
		work.GroupID != topicGroupID ||
		work.TopicID != topicIMID ||
		work.TopicName != "C-ABCDEFGHIJKLMNOPQRST" ||
		work.OwnerIMUserID != "u_OWNER" ||
		!work.Private ||
		work.ChannelRevision != 1 ||
		work.DesiredRevision != 1 {
		t.Fatalf("work = %#v", work)
	}
	err = repository.Complete(context.Background(), imtopicport.Completion{
		OperationID: topicOperationID,
		LeaseOwner:  "worker-topic",
		Status:      imtopicport.CompletionSucceeded,
		CompletedAt: topicRepoNow.Add(time.Second),
	})
	if err != nil {
		t.Fatal(err)
	}
	channel, err := handle.Client().Channel.Get(
		context.Background(),
		topicChannelID,
	)
	if err != nil {
		t.Fatal(err)
	}
	operation, err := handle.Client().TencentOperation.Get(
		context.Background(),
		topicOperationID,
	)
	if err != nil {
		t.Fatal(err)
	}
	if channel.ImState != "ready" || channel.Revision != 2 ||
		operation.State != "succeeded" {
		t.Fatalf("channel/operation = (%#v, %#v)", channel, operation)
	}
}

func TestRepositoryClaimsSystemAllMembersTopicAsPublic(t *testing.T) {
	handle := openTopicDatabase(t)
	seedTopic(t, handle)
	if _, err := handle.Client().Channel.UpdateOneID(topicChannelID).
		SetSystemKey("all").
		Save(context.Background()); err != nil {
		t.Fatal(err)
	}
	repository, err := NewEntRepository(handle)
	if err != nil {
		t.Fatal(err)
	}
	work, ok, err := repository.Claim(context.Background(), imtopicport.Claim{
		LeaseOwner:     "worker-system-topic",
		Now:            topicRepoNow,
		LeaseExpiresAt: topicRepoNow.Add(time.Minute),
	})
	if err != nil || !ok {
		t.Fatalf("Claim() = (%#v, %v, %v)", work, ok, err)
	}
	if work.Private {
		t.Fatalf("system all-members Topic must be public: %#v", work)
	}
}

func TestRepositoryRepairsLegacyAllMembersChannelWithoutTopic(t *testing.T) {
	handle := openTopicDatabase(t)
	seedTopic(t, handle)
	ctx := context.Background()
	if _, err := handle.Client().Channel.UpdateOneID(topicChannelID).
		SetSystemKey("all").
		ClearImTopicID().
		SetImState("ready").
		Save(ctx); err != nil {
		t.Fatal(err)
	}
	repository, err := NewEntRepository(handle)
	if err != nil {
		t.Fatal(err)
	}
	ids := &fixedRepairIDs{}
	repaired, err := repository.RepairLegacySystemTopics(
		ctx,
		fixedRepairDeriver{},
		ids,
		topicRepoNow.Add(time.Second),
	)
	if err != nil || repaired != 1 || !ids.used {
		t.Fatalf("RepairLegacySystemTopics() = (%d, %v), ids=%#v", repaired, err, ids)
	}
	entity, err := handle.Client().Channel.Get(ctx, topicChannelID)
	if err != nil {
		t.Fatal(err)
	}
	operation, err := handle.Client().TencentOperation.Get(ctx, topicRepairOperationID)
	if err != nil {
		t.Fatal(err)
	}
	if entity.ImTopicID == nil || *entity.ImTopicID != topicIMID ||
		entity.ImState != "provisioning" || entity.Revision != 2 ||
		operation.Kind != "im.topic.ensure" ||
		operation.ResourceID != topicChannelID ||
		operation.DesiredRevision == nil || *operation.DesiredRevision != 2 ||
		operation.State != "pending" {
		t.Fatalf("repaired = (%#v, %#v)", entity, operation)
	}
	again, err := repository.RepairLegacySystemTopics(
		ctx,
		fixedRepairDeriver{},
		&fixedRepairIDs{},
		topicRepoNow.Add(2*time.Second),
	)
	if err != nil || again != 0 {
		t.Fatalf("second RepairLegacySystemTopics() = (%d, %v)", again, err)
	}
}

func openTopicDatabase(t *testing.T) *database.Handle {
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

func seedTopic(t *testing.T, handle *database.Handle) {
	t.Helper()
	ctx := context.Background()
	if _, err := handle.Client().Account.Create().
		SetID(topicAccountID).
		SetEmail("topic-owner@example.com").
		SetEmailNormalized("topic-owner@example.com").
		SetDisplayName("Owner").
		SetPasswordHash("unused").
		SetTokenVersion(1).
		SetImUserID("u_OWNER").
		SetImState("ready").
		SetRevision(1).
		SetCreatedAt(topicRepoNow).
		SetUpdatedAt(topicRepoNow).
		Save(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Client().Server.Create().
		SetID(topicServerID).
		SetSlug("topic-test").
		SetName("话题测试").
		SetOwnerMemberID(topicMemberID).
		SetImGroupID(topicGroupID).
		SetImState("ready").
		SetNextTaskNumber(1).
		SetRevision(2).
		SetCreatedAt(topicRepoNow).
		SetUpdatedAt(topicRepoNow).
		Save(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Client().Member.Create().
		SetID(topicMemberID).
		SetServerID(topicServerID).
		SetAccountID(topicAccountID).
		SetKind("human").
		SetRole("owner").
		SetDisplayName("Owner").
		SetHandle("u_OWNER_HANDLE").
		SetStatus("active").
		SetImState("ready").
		SetRevision(2).
		SetCreatedAt(topicRepoNow).
		SetUpdatedAt(topicRepoNow).
		Save(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Client().Channel.Create().
		SetID(topicChannelID).
		SetServerID(topicServerID).
		SetName("研发").
		SetDescription("研发频道").
		SetVisibility("public").
		SetImGroupID(topicGroupID).
		SetImTopicID(topicIMID).
		SetImState("provisioning").
		SetRevision(1).
		SetCreatedAt(topicRepoNow).
		SetUpdatedAt(topicRepoNow).
		Save(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Client().TencentOperation.Create().
		SetID(topicOperationID).
		SetPartitionKey(topicServerID).
		SetServerID(topicServerID).
		SetService("im").
		SetKind("im.topic.ensure").
		SetResourceType("channel").
		SetResourceID(topicChannelID).
		SetIdempotencyKey("topic-v1").
		SetDesiredRevision(1).
		SetState("pending").
		SetAttempts(0).
		SetCreatedAt(topicRepoNow).
		SetUpdatedAt(topicRepoNow).
		Save(ctx); err != nil {
		t.Fatal(err)
	}
}
