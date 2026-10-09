package agentidentity

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	immembershipadapter "chatserver/internal/adapters/immembership"
	appagentidentity "chatserver/internal/app/agentidentity"
	appimmembership "chatserver/internal/app/immembership"
	"chatserver/internal/config"
	"chatserver/internal/database"
	"chatserver/internal/database/migration"
	"chatserver/internal/ent/agentimroute"
	"chatserver/internal/ent/outboxevent"
	"chatserver/internal/ent/tencentoperation"
	agentidentityport "chatserver/internal/ports/agentidentity"
	tencentimport "chatserver/internal/ports/tencentim"
)

const (
	identityServerID              = "0198f4c2-7a31-7c91-a6d2-7d76f9188c38"
	identityAgentID               = "0198f4c2-7a36-7e45-913c-6baf30401a82"
	identityOperationID           = "0198f4c2-7a37-7e45-913c-6baf30401a83"
	identityMembershipOperationID = "0198f4c2-7a38-7ae1-8b1b-1abf6588898b"
	legacyMembershipOperationID   = "0198f4c2-7a39-7e45-913c-6baf30401a84"
	legacyRepairMarkerID          = "0198f4c2-7a3a-7e45-913c-6baf30401a85"
)

var identityNow = time.Date(2026, 7, 31, 0, 20, 0, 0, time.UTC)

type chainClock struct{ now time.Time }

func (clock chainClock) Now() time.Time { return clock.now }

type chainIDGenerator struct{ value string }

func (generator chainIDGenerator) New() (string, error) {
	return generator.value, nil
}

type chainProvisioner struct {
	identity   tencentimport.Identity
	membership tencentimport.Membership
}

func (provisioner *chainProvisioner) EnsureIdentity(
	_ context.Context,
	value tencentimport.Identity,
) error {
	provisioner.identity = value
	return nil
}

func (*chainProvisioner) KickIdentity(context.Context, string) error { return nil }

func (*chainProvisioner) DeleteIdentity(context.Context, string) error { return nil }

func (provisioner *chainProvisioner) EnsureMember(
	_ context.Context,
	value tencentimport.Membership,
) error {
	provisioner.membership = value
	return nil
}

func (*chainProvisioner) RemoveMember(
	context.Context,
	tencentimport.Membership,
) error {
	return nil
}

func TestEntRepositoryClaimsAndCompletesAgentIdentity(t *testing.T) {
	repository, handle := openIdentityRepository(t)
	seedIdentityWork(t, handle)
	work, found, err := repository.Claim(
		context.Background(),
		agentidentityport.Claim{
			LeaseOwner: "agent-identity-worker",
			Now:        identityNow, LeaseExpiresAt: identityNow.Add(time.Minute),
		},
	)
	if err != nil || !found {
		t.Fatalf("Claim() = (%#v, %v, %v)", work, found, err)
	}
	if work.AgentID != identityAgentID ||
		work.DisplayName != "小舟" ||
		work.IMUserID != "a_IDENTITYAGENTUSERID23456789012" {
		t.Fatalf("work = %#v", work)
	}
	if err := repository.Complete(
		context.Background(),
		agentidentityport.Completion{
			OperationID:           identityOperationID,
			MembershipOperationID: identityMembershipOperationID,
			LeaseOwner:            "agent-identity-worker",
			Status:                agentidentityport.CompletionSucceeded,
			CompletedAt:           identityNow.Add(time.Second),
		},
	); err != nil {
		t.Fatal(err)
	}
	agentEntity, err := handle.Client().Agent.Get(
		context.Background(),
		identityAgentID,
	)
	if err != nil || agentEntity.ImState != "ready" ||
		agentEntity.Revision != 2 {
		t.Fatalf("agent = (%#v, %v)", agentEntity, err)
	}
	memberEntity, err := handle.Client().Member.Get(
		context.Background(),
		identityAgentID,
	)
	if err != nil || memberEntity.ImState != "provisioning" ||
		memberEntity.Revision != 1 {
		t.Fatalf("member = (%#v, %v)", memberEntity, err)
	}
	membershipOperation, err := handle.Client().TencentOperation.Query().
		Where(
			tencentoperation.KindEQ("im.membership.ensure"),
			tencentoperation.ResourceTypeEQ("member"),
			tencentoperation.ResourceIDEQ(identityAgentID),
		).
		Only(context.Background())
	if err != nil ||
		membershipOperation.ID != identityMembershipOperationID ||
		membershipOperation.State != "pending" ||
		membershipOperation.PartitionKey != identityServerID ||
		membershipOperation.ServerID == nil ||
		*membershipOperation.ServerID != identityServerID ||
		membershipOperation.DesiredRevision == nil ||
		*membershipOperation.DesiredRevision != memberEntity.Revision {
		t.Fatalf(
			"membership operation = (%#v, %v)",
			membershipOperation,
			err,
		)
	}
	membershipOutbox, err := handle.Client().OutboxEvent.Query().
		Where(
			outboxevent.AggregateTypeEQ("tencent_operation"),
			outboxevent.AggregateIDEQ(membershipOperation.ID),
		).
		Only(context.Background())
	if err != nil ||
		membershipOutbox.State != "pending" ||
		membershipOutbox.PartitionKey != identityServerID {
		t.Fatalf(
			"membership outbox = (%#v, %v)",
			membershipOutbox,
			err,
		)
	}
}

func TestEntRepositoryClaimsRevokesRouteAndCompletesAgentDeletion(t *testing.T) {
	repository, handle := openIdentityRepository(t)
	seedIdentityDeletionWork(t, handle)
	work, found, err := repository.Claim(
		context.Background(),
		agentidentityport.Claim{
			LeaseOwner: "agent-identity-worker",
			Now:        identityNow, LeaseExpiresAt: identityNow.Add(time.Minute),
		},
	)
	if err != nil || !found || work.Kind != "im.identity.delete" ||
		!work.Deleted || work.AgentRevision != 2 || work.DesiredRevision != 2 {
		t.Fatalf("Claim(delete) = (%#v, %v, %v)", work, found, err)
	}
	if err := repository.RevokeRoute(
		context.Background(),
		agentidentityport.RouteRevocation{
			OperationID: identityOperationID,
			LeaseOwner:  "agent-identity-worker",
			AgentID:     identityAgentID,
			IMUserID:    "a_IDENTITYAGENTUSERID23456789012",
			RevokedAt:   identityNow.Add(time.Second),
		},
	); err != nil {
		t.Fatal(err)
	}
	route, err := handle.Client().AgentIMRoute.Query().Where(
		agentimroute.AgentIDEQ(identityAgentID),
	).Only(context.Background())
	if err != nil || route.State != "revoked" {
		t.Fatalf("route = (%#v, %v)", route, err)
	}
	if err := repository.Complete(
		context.Background(),
		agentidentityport.Completion{
			OperationID: identityOperationID,
			LeaseOwner:  "agent-identity-worker",
			Status:      agentidentityport.CompletionSucceeded,
			CompletedAt: identityNow.Add(2 * time.Second),
		},
	); err != nil {
		t.Fatal(err)
	}
	agentEntity, err := handle.Client().Agent.Get(context.Background(), identityAgentID)
	if err != nil || agentEntity.ImState != "deleted" || agentEntity.Revision != 3 {
		t.Fatalf("deleted agent = (%#v, %v)", agentEntity, err)
	}
	memberEntity, err := handle.Client().Member.Get(context.Background(), identityAgentID)
	if err != nil || memberEntity.Status != "removed" ||
		memberEntity.ImState != "deleted" || memberEntity.Revision != 3 {
		t.Fatalf("deleted member = (%#v, %v)", memberEntity, err)
	}
	operation, err := handle.Client().TencentOperation.Get(
		context.Background(), identityOperationID,
	)
	if err != nil || operation.State != "succeeded" {
		t.Fatalf("delete operation = (%#v, %v)", operation, err)
	}
}

func TestEntRepositoryDoesNotCreateMembershipWhenIdentityFails(
	t *testing.T,
) {
	repository, handle := openIdentityRepository(t)
	seedIdentityWork(t, handle)
	_, found, err := repository.Claim(
		context.Background(),
		agentidentityport.Claim{
			LeaseOwner: "agent-identity-worker",
			Now:        identityNow,
			LeaseExpiresAt: identityNow.Add(
				time.Minute,
			),
		},
	)
	if err != nil || !found {
		t.Fatalf("Claim() = (%v, %v)", found, err)
	}
	if err := repository.Complete(
		context.Background(),
		agentidentityport.Completion{
			OperationID: identityOperationID,
			LeaseOwner:  "agent-identity-worker",
			Status:      agentidentityport.CompletionFailed,
			ErrorCode:   "tencent_10007",
			CompletedAt: identityNow.Add(time.Second),
		},
	); err != nil {
		t.Fatal(err)
	}
	agentEntity, err := handle.Client().Agent.Get(
		context.Background(),
		identityAgentID,
	)
	if err != nil || agentEntity.ImState != "error" ||
		agentEntity.Revision != 2 {
		t.Fatalf("agent = (%#v, %v)", agentEntity, err)
	}
	memberEntity, err := handle.Client().Member.Get(
		context.Background(),
		identityAgentID,
	)
	if err != nil || memberEntity.ImState != "error" ||
		memberEntity.Revision != 2 {
		t.Fatalf("member = (%#v, %v)", memberEntity, err)
	}
	count, err := handle.Client().TencentOperation.Query().
		Where(tencentoperation.KindEQ("im.membership.ensure")).
		Count(context.Background())
	if err != nil || count != 0 {
		t.Fatalf("membership operation count = (%d, %v)", count, err)
	}
}

func TestAgentIdentitySuccessFlowsIntoCommunityMembership(t *testing.T) {
	identityRepository, handle := openIdentityRepository(t)
	seedIdentityWork(t, handle)
	provisioner := &chainProvisioner{}
	identityService, err := appagentidentity.NewService(
		identityRepository,
		provisioner,
		chainIDGenerator{value: identityMembershipOperationID},
		chainClock{now: identityNow},
		appagentidentity.Config{
			WorkerID: "identity-worker",
			LeaseTTL: 30 * time.Second, MaxAttempts: 8,
			BaseBackoff: time.Second, MaxBackoff: time.Minute,
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	processed, err := identityService.ProcessOne(context.Background())
	if err != nil || !processed {
		t.Fatalf(
			"identity ProcessOne() = (%v, %v)",
			processed,
			err,
		)
	}
	membershipRepository, err := immembershipadapter.NewEntRepository(
		handle,
	)
	if err != nil {
		t.Fatal(err)
	}
	membershipService, err := appimmembership.NewService(
		membershipRepository,
		provisioner,
		chainClock{now: identityNow.Add(2 * time.Second)},
		appimmembership.Config{
			WorkerID: "membership-worker",
			LeaseTTL: 30 * time.Second, MaxAttempts: 8,
			BaseBackoff: time.Second, MaxBackoff: time.Minute,
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	processed, err = membershipService.ProcessOne(context.Background())
	if err != nil || !processed {
		t.Fatalf(
			"membership ProcessOne() = (%v, %v)",
			processed,
			err,
		)
	}
	if provisioner.identity.UserID !=
		"a_IDENTITYAGENTUSERID23456789012" ||
		provisioner.membership.GroupID != "@TGS#2IDENTITY" ||
		provisioner.membership.TopicID != "" ||
		provisioner.membership.UserID !=
			"a_IDENTITYAGENTUSERID23456789012" {
		t.Fatalf("provisioner = %#v", provisioner)
	}
	agentEntity, err := handle.Client().Agent.Get(
		context.Background(),
		identityAgentID,
	)
	if err != nil || agentEntity.ImState != "ready" {
		t.Fatalf("agent = (%#v, %v)", agentEntity, err)
	}
	memberEntity, err := handle.Client().Member.Get(
		context.Background(),
		identityAgentID,
	)
	if err != nil || memberEntity.ImState != "ready" ||
		memberEntity.Revision != 2 {
		t.Fatalf("member = (%#v, %v)", memberEntity, err)
	}
}

func TestEntRepositorySchedulesLegacyAgentMembershipOnlyOnce(
	t *testing.T,
) {
	repository, handle := openIdentityRepository(t)
	seedLegacyReadyAgent(t, handle)
	ctx := context.Background()
	candidate, found, err := repository.FindLegacyMembership(ctx)
	if err != nil || !found ||
		candidate.ServerID != identityServerID ||
		candidate.MemberID != identityAgentID ||
		candidate.Revision != 2 {
		t.Fatalf(
			"FindLegacyMembership() = (%#v, %v, %v)",
			candidate,
			found,
			err,
		)
	}
	scheduled, err := repository.ScheduleLegacyMembership(
		ctx,
		agentidentityport.LegacyMembershipSchedule{
			LegacyMembership: candidate,
			OperationID:      legacyMembershipOperationID,
			ScheduledAt:      identityNow.Add(time.Second),
		},
	)
	if err != nil || !scheduled {
		t.Fatalf(
			"ScheduleLegacyMembership() = (%v, %v)",
			scheduled,
			err,
		)
	}
	memberEntity, err := handle.Client().Member.Get(ctx, identityAgentID)
	if err != nil ||
		memberEntity.ImState != "provisioning" ||
		memberEntity.Revision != 3 {
		t.Fatalf("legacy Member = (%#v, %v)", memberEntity, err)
	}
	operation, err := handle.Client().TencentOperation.Get(
		ctx,
		legacyMembershipOperationID,
	)
	if err != nil ||
		operation.State != "pending" ||
		operation.DesiredRevision == nil ||
		*operation.DesiredRevision != 3 ||
		operation.ResourceID != identityAgentID {
		t.Fatalf("legacy operation = (%#v, %v)", operation, err)
	}
	membershipRepository, err := immembershipadapter.NewEntRepository(
		handle,
	)
	if err != nil {
		t.Fatal(err)
	}
	provisioner := &chainProvisioner{}
	membershipService, err := appimmembership.NewService(
		membershipRepository,
		provisioner,
		chainClock{now: identityNow.Add(2 * time.Second)},
		appimmembership.Config{
			WorkerID: "legacy-membership-worker",
			LeaseTTL: 30 * time.Second, MaxAttempts: 8,
			BaseBackoff: time.Second, MaxBackoff: time.Minute,
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	processed, err := membershipService.ProcessOne(ctx)
	if err != nil || !processed {
		t.Fatalf(
			"membership ProcessOne() = (%v, %v)",
			processed,
			err,
		)
	}
	if provisioner.membership.GroupID != "@TGS#2IDENTITY" ||
		provisioner.membership.UserID !=
			"a_IDENTITYAGENTUSERID23456789012" {
		t.Fatalf("legacy membership = %#v", provisioner.membership)
	}
	memberEntity, err = handle.Client().Member.Get(ctx, identityAgentID)
	if err != nil ||
		memberEntity.ImState != "ready" ||
		memberEntity.Revision != 4 {
		t.Fatalf(
			"repaired legacy Member = (%#v, %v)",
			memberEntity,
			err,
		)
	}
	next, found, err := repository.FindLegacyMembership(ctx)
	if err != nil || found {
		t.Fatalf(
			"second FindLegacyMembership() = (%#v, %v, %v)",
			next,
			found,
			err,
		)
	}
	completed, err := repository.LegacyMembershipRepairCompleted(ctx)
	if err != nil || completed {
		t.Fatalf(
			"LegacyMembershipRepairCompleted() = (%v, %v)",
			completed,
			err,
		)
	}
	if err := repository.CompleteLegacyMembershipRepair(
		ctx,
		legacyRepairMarkerID,
		identityNow.Add(3*time.Second),
	); err != nil {
		t.Fatal(err)
	}
	completed, err = repository.LegacyMembershipRepairCompleted(ctx)
	if err != nil || !completed {
		t.Fatalf(
			"completed LegacyMembershipRepair = (%v, %v)",
			completed,
			err,
		)
	}
	if err := repository.CompleteLegacyMembershipRepair(
		ctx,
		"0198f4c2-7a3b-7e45-913c-6baf30401a86",
		identityNow.Add(4*time.Second),
	); err != nil {
		t.Fatalf("second completion error = %v", err)
	}
}

func openIdentityRepository(t *testing.T) (*EntRepository, *database.Handle) {
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

func seedLegacyReadyAgent(t *testing.T, handle *database.Handle) {
	t.Helper()
	ctx := context.Background()
	if _, err := handle.Client().Server.Create().
		SetID(identityServerID).
		SetSlug("legacy-agent-test").
		SetName("旧 Agent 入群修复").
		SetImGroupID("@TGS#2IDENTITY").
		SetImState("ready").
		SetNextTaskNumber(1).
		SetRevision(1).
		SetCreatedAt(identityNow).
		SetUpdatedAt(identityNow).
		Save(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Client().Member.Create().
		SetID(identityAgentID).
		SetServerID(identityServerID).
		SetKind("agent").
		SetRole("member").
		SetDisplayName("旧 Agent").
		SetHandle("legacy-agent").
		SetStatus("active").
		SetImState("ready").
		SetRevision(2).
		SetCreatedAt(identityNow).
		SetUpdatedAt(identityNow).
		Save(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Client().Agent.Create().
		SetID(identityAgentID).
		SetServerID(identityServerID).
		SetImUserID("a_IDENTITYAGENTUSERID23456789012").
		SetRuntimeKind("codex").
		SetReplyPolicy("mention_and_dm").
		SetDesiredState("running").
		SetObservedState("running").
		SetCredentialVersion(1).
		SetImState("ready").
		SetCreatedByMemberID(identityAgentID).
		SetRevision(2).
		SetCreatedAt(identityNow).
		SetUpdatedAt(identityNow).
		Save(ctx); err != nil {
		t.Fatal(err)
	}
}

func seedIdentityWork(t *testing.T, handle *database.Handle) {
	t.Helper()
	ctx := context.Background()
	if _, err := handle.Client().Server.Create().
		SetID(identityServerID).
		SetSlug("identity-test").
		SetName("Agent 身份测试").
		SetImGroupID("@TGS#2IDENTITY").
		SetImState("ready").
		SetNextTaskNumber(1).
		SetRevision(1).
		SetCreatedAt(identityNow).
		SetUpdatedAt(identityNow).
		Save(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Client().Member.Create().
		SetID(identityAgentID).
		SetServerID(identityServerID).
		SetKind("agent").
		SetRole("member").
		SetDisplayName("小舟").
		SetHandle("xiaozhou").
		SetStatus("active").
		SetImState("provisioning").
		SetRevision(1).
		SetCreatedAt(identityNow).
		SetUpdatedAt(identityNow).
		Save(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Client().Agent.Create().
		SetID(identityAgentID).
		SetServerID(identityServerID).
		SetImUserID("a_IDENTITYAGENTUSERID23456789012").
		SetRuntimeKind("codex").
		SetReplyPolicy("mention_and_dm").
		SetDesiredState("stopped").
		SetObservedState("unknown").
		SetCredentialVersion(0).
		SetImState("provisioning").
		SetCreatedByMemberID(
			"0198f4c2-7a32-7d02-b8c1-3f6e15aa91b4",
		).
		SetRevision(1).
		SetCreatedAt(identityNow).
		SetUpdatedAt(identityNow).
		Save(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Client().TencentOperation.Create().
		SetID(identityOperationID).
		SetPartitionKey(identityServerID).
		SetServerID(identityServerID).
		SetService("im").
		SetKind("im.identity.ensure").
		SetResourceType("agent").
		SetResourceID(identityAgentID).
		SetIdempotencyKey("im.identity.ensure:v1:" + identityAgentID + ":1").
		SetDesiredRevision(1).
		SetState("pending").
		SetAttempts(0).
		SetCreatedAt(identityNow).
		SetUpdatedAt(identityNow).
		Save(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Client().OutboxEvent.Create().
		SetPartitionKey(identityServerID).
		SetServerID(identityServerID).
		SetEventType("tencent.operation.ready").
		SetAggregateType("tencent_operation").
		SetAggregateID(identityOperationID).
		SetState("pending").
		SetAttempts(0).
		SetAvailableAt(identityNow).
		SetCreatedAt(identityNow).
		Save(ctx); err != nil {
		t.Fatal(err)
	}
}

func seedIdentityDeletionWork(t *testing.T, handle *database.Handle) {
	t.Helper()
	seedIdentityWork(t, handle)
	ctx := context.Background()
	if _, err := handle.Client().Agent.UpdateOneID(identityAgentID).
		SetDesiredState("stopped").
		SetObservedState("stopping").
		SetImState("deleting").
		SetDeletedAt(identityNow).
		SetRevision(2).
		SetUpdatedAt(identityNow).
		Save(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Client().Member.UpdateOneID(identityAgentID).
		SetStatus("removed").
		SetImState("deleting").
		SetRevision(2).
		SetUpdatedAt(identityNow).
		Save(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Client().TencentOperation.UpdateOneID(identityOperationID).
		SetKind("im.identity.delete").
		SetIdempotencyKey("im.identity.delete:v1:" + identityAgentID + ":2").
		SetDesiredRevision(2).
		Save(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Client().AgentIMRoute.Create().
		SetID(identityAgentID).
		SetImUserID("a_IDENTITYAGENTUSERID23456789012").
		SetServerID(identityServerID).
		SetAgentID(identityAgentID).
		SetState("active").
		SetCreatedAt(identityNow).
		SetUpdatedAt(identityNow).
		Save(ctx); err != nil {
		t.Fatal(err)
	}
}
