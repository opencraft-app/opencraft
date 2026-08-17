package immembership

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"chatserver/internal/config"
	"chatserver/internal/database"
	"chatserver/internal/database/migration"
	immembershipport "chatserver/internal/ports/immembership"
)

const (
	membershipAccountID   = "0198f4c2-7a39-7c91-a6d2-7d76f9188c39"
	membershipServerID    = "0198f4c2-7a31-7c91-a6d2-7d76f9188c38"
	membershipMemberID    = "0198f4c2-7a37-7e45-913c-6baf30401a83"
	membershipOperationID = "0198f4c2-7a38-7e45-913c-6baf30401a84"
	membershipChannelID   = "0198f4c2-7a3a-7e45-913c-6baf30401a85"
	membershipChannelOpID = "0198f4c2-7a3b-7e45-913c-6baf30401a86"
	membershipChannelMem  = "0198f4c2-7a3c-7e45-913c-6baf30401a87"
)

func TestEntRepositoryClaimsAndCompletesMemberEnsure(t *testing.T) {
	repository, handle := openMembershipRepository(t)
	now := time.Date(2026, 7, 31, 1, 30, 0, 0, time.UTC)
	seedMembershipWork(t, handle, now)

	work, found, err := repository.Claim(
		context.Background(),
		immembershipport.Claim{
			LeaseOwner: "worker-1", Now: now,
			LeaseExpiresAt: now.Add(30 * time.Second),
		},
	)
	if err != nil || !found {
		t.Fatalf("Claim() = (%#v, %v, %v)", work, found, err)
	}
	if work.OperationID != membershipOperationID ||
		work.Kind != "im.membership.ensure" ||
		work.GroupID != "@TGS#2MEMBER" ||
		work.IMUserID != "u_MEMBER" ||
		work.MemberRevision != 1 ||
		work.DesiredRevision != 1 {
		t.Fatalf("work = %#v", work)
	}
	err = repository.Complete(
		context.Background(),
		immembershipport.Completion{
			OperationID: membershipOperationID,
			LeaseOwner:  "worker-1",
			Status:      immembershipport.CompletionSucceeded,
			CompletedAt: now.Add(time.Second),
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	memberEntity, err := handle.Client().Member.Get(
		context.Background(),
		membershipMemberID,
	)
	if err != nil ||
		memberEntity.ImState != "ready" ||
		memberEntity.Revision != 2 {
		t.Fatalf("member = (%#v, %v)", memberEntity, err)
	}
	operation, err := handle.Client().TencentOperation.Get(
		context.Background(),
		membershipOperationID,
	)
	if err != nil ||
		operation.State != "succeeded" ||
		operation.CompletedAt == nil {
		t.Fatalf("operation = (%#v, %v)", operation, err)
	}
	outbox, err := handle.Client().OutboxEvent.Query().Only(
		context.Background(),
	)
	if err != nil || outbox.State != "processed" {
		t.Fatalf("outbox = (%#v, %v)", outbox, err)
	}
}

func TestEntRepositoryClaimsAgentCommunityMembership(t *testing.T) {
	repository, handle := openMembershipRepository(t)
	now := time.Date(2026, 7, 31, 1, 45, 0, 0, time.UTC)
	const (
		serverID    = "0198f4c2-7a41-7c91-a6d2-7d76f9188c41"
		agentID     = "0198f4c2-7a42-7e45-913c-6baf30401a42"
		operationID = "0198f4c2-7a43-7e45-913c-6baf30401a43"
		imUserID    = "a_MEMBERAGENTUSERID2345678901234"
	)
	ctx := context.Background()
	if _, err := handle.Client().Server.Create().
		SetID(serverID).
		SetSlug("agent-member-test").
		SetName("Agent 成员测试").
		SetImGroupID("@TGS#2AGENTMEMBER").
		SetImState("ready").
		SetNextTaskNumber(1).
		SetRevision(1).
		SetCreatedAt(now).
		SetUpdatedAt(now).
		Save(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Client().Member.Create().
		SetID(agentID).
		SetServerID(serverID).
		SetKind("agent").
		SetRole("member").
		SetDisplayName("Agent 成员").
		SetHandle("a_member").
		SetStatus("active").
		SetImState("provisioning").
		SetRevision(1).
		SetCreatedAt(now).
		SetUpdatedAt(now).
		Save(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Client().Agent.Create().
		SetID(agentID).
		SetServerID(serverID).
		SetImUserID(imUserID).
		SetRuntimeKind("codex").
		SetReplyPolicy("mention_and_dm").
		SetDesiredState("stopped").
		SetObservedState("unknown").
		SetCredentialVersion(0).
		SetImState("ready").
		SetCreatedByMemberID(agentID).
		SetRevision(2).
		SetCreatedAt(now).
		SetUpdatedAt(now).
		Save(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Client().TencentOperation.Create().
		SetID(operationID).
		SetPartitionKey(serverID).
		SetServerID(serverID).
		SetService("im").
		SetKind("im.membership.ensure").
		SetResourceType("member").
		SetResourceID(agentID).
		SetIdempotencyKey("agent-membership-fixture").
		SetDesiredRevision(1).
		SetState("pending").
		SetAttempts(0).
		SetCreatedAt(now).
		SetUpdatedAt(now).
		Save(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Client().OutboxEvent.Create().
		SetPartitionKey(serverID).
		SetServerID(serverID).
		SetEventType("tencent.operation.ready").
		SetAggregateType("tencent_operation").
		SetAggregateID(operationID).
		SetState("pending").
		SetAttempts(0).
		SetAvailableAt(now).
		SetCreatedAt(now).
		Save(ctx); err != nil {
		t.Fatal(err)
	}
	work, found, err := repository.Claim(
		ctx,
		immembershipport.Claim{
			LeaseOwner: "worker-agent",
			Now:        now,
			LeaseExpiresAt: now.Add(
				30 * time.Second,
			),
		},
	)
	if err != nil || !found ||
		work.GroupID != "@TGS#2AGENTMEMBER" ||
		work.TopicID != "" ||
		work.IMUserID != imUserID ||
		work.MemberRevision != 1 ||
		work.DesiredRevision != 1 {
		t.Fatalf("Claim() = (%#v, %v, %v)", work, found, err)
	}
	if err := repository.Complete(
		ctx,
		immembershipport.Completion{
			OperationID: operationID,
			LeaseOwner:  "worker-agent",
			Status:      immembershipport.CompletionSucceeded,
			CompletedAt: now.Add(time.Second),
		},
	); err != nil {
		t.Fatal(err)
	}
	memberEntity, err := handle.Client().Member.Get(ctx, agentID)
	if err != nil || memberEntity.ImState != "ready" ||
		memberEntity.Revision != 2 {
		t.Fatalf("Agent Member = (%#v, %v)", memberEntity, err)
	}
}

func TestEntRepositoryClaimsPublicChannelWithTopicMembership(t *testing.T) {
	repository, handle := openMembershipRepository(t)
	now := time.Date(2026, 8, 4, 3, 33, 13, 0, time.UTC)
	seedPublicChannelMembershipWork(t, handle, now)

	work, found, err := repository.Claim(
		context.Background(),
		immembershipport.Claim{
			LeaseOwner:     "worker-public-channel",
			Now:            now,
			LeaseExpiresAt: now.Add(30 * time.Second),
		},
	)

	if err != nil || !found {
		t.Fatalf("Claim() = (%#v, %v, %v)", work, found, err)
	}
	if work.OperationID != membershipChannelOpID ||
		work.ResourceType != "channel_member" ||
		work.GroupID != "@TGS#_C_PUBLIC" ||
		work.TopicID != "@TGS#_C_PUBLIC@TOPIC#_T_GENERAL" ||
		work.IMUserID != "u_MEMBER" {
		t.Fatalf("work = %#v", work)
	}
}

func openMembershipRepository(
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

func seedMembershipWork(
	t *testing.T,
	handle *database.Handle,
	now time.Time,
) {
	t.Helper()
	ctx := context.Background()
	if _, err := handle.Client().Account.Create().
		SetID(membershipAccountID).
		SetEmail("member@example.com").
		SetEmailNormalized("member@example.com").
		SetDisplayName("成员").
		SetPasswordHash("test-only").
		SetTokenVersion(1).
		SetImUserID("u_MEMBER").
		SetImState("ready").
		SetRevision(1).
		SetCreatedAt(now).
		SetUpdatedAt(now).
		Save(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Client().Server.Create().
		SetID(membershipServerID).
		SetSlug("member-test").
		SetName("成员测试").
		SetImGroupID("@TGS#2MEMBER").
		SetImState("ready").
		SetNextTaskNumber(1).
		SetRevision(1).
		SetCreatedAt(now).
		SetUpdatedAt(now).
		Save(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Client().Member.Create().
		SetID(membershipMemberID).
		SetServerID(membershipServerID).
		SetAccountID(membershipAccountID).
		SetKind("human").
		SetRole("member").
		SetDisplayName("成员").
		SetHandle("h_member").
		SetStatus("active").
		SetImState("provisioning").
		SetRevision(1).
		SetCreatedAt(now).
		SetUpdatedAt(now).
		Save(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Client().TencentOperation.Create().
		SetID(membershipOperationID).
		SetPartitionKey(membershipServerID).
		SetServerID(membershipServerID).
		SetService("im").
		SetKind("im.membership.ensure").
		SetResourceType("member").
		SetResourceID(membershipMemberID).
		SetIdempotencyKey("membership-fixture").
		SetDesiredRevision(1).
		SetState("pending").
		SetAttempts(0).
		SetCreatedAt(now).
		SetUpdatedAt(now).
		Save(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Client().OutboxEvent.Create().
		SetPartitionKey(membershipServerID).
		SetServerID(membershipServerID).
		SetEventType("tencent.operation.ready").
		SetAggregateType("tencent_operation").
		SetAggregateID(membershipOperationID).
		SetState("pending").
		SetAttempts(0).
		SetAvailableAt(now).
		SetCreatedAt(now).
		Save(ctx); err != nil {
		t.Fatal(err)
	}
}

func seedPublicChannelMembershipWork(
	t *testing.T,
	handle *database.Handle,
	now time.Time,
) {
	t.Helper()
	seedMembershipWork(t, handle, now.Add(-time.Minute))
	ctx := context.Background()
	if _, err := handle.Client().TencentOperation.UpdateOneID(
		membershipOperationID,
	).
		SetState("succeeded").
		SetCompletedAt(now.Add(-30 * time.Second)).
		Save(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Client().Server.UpdateOneID(membershipServerID).
		SetImGroupID("@TGS#_C_PUBLIC").
		Save(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Client().Channel.Create().
		SetID(membershipChannelID).
		SetServerID(membershipServerID).
		SetName("general").
		SetVisibility("public").
		SetImGroupID("@TGS#_C_PUBLIC").
		SetImTopicID("@TGS#_C_PUBLIC@TOPIC#_T_GENERAL").
		SetImState("ready").
		SetRevision(1).
		SetCreatedAt(now).
		SetUpdatedAt(now).
		Save(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Client().ChannelMember.Create().
		SetID(membershipChannelMem).
		SetServerID(membershipServerID).
		SetChannelID(membershipChannelID).
		SetMemberID(membershipMemberID).
		SetState("active").
		SetImState("provisioning").
		SetMembershipVersion(1).
		SetCreatedAt(now).
		SetUpdatedAt(now).
		Save(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Client().TencentOperation.Create().
		SetID(membershipChannelOpID).
		SetPartitionKey(membershipServerID).
		SetServerID(membershipServerID).
		SetService("im").
		SetKind("im.membership.ensure").
		SetResourceType("channel_member").
		SetResourceID(membershipChannelMem).
		SetIdempotencyKey("public-channel-membership-fixture").
		SetDesiredRevision(1).
		SetState("pending").
		SetAttempts(0).
		SetCreatedAt(now).
		SetUpdatedAt(now).
		Save(ctx); err != nil {
		t.Fatal(err)
	}
}
