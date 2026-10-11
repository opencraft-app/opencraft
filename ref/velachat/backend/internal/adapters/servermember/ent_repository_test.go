package servermember

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
	servermemberport "chatserver/internal/ports/servermember"
)

const (
	testAccountID            = "0198f4c2-7a30-7c91-a6d2-7d76f9188c37"
	testServerID             = "0198f4c2-7a31-7c91-a6d2-7d76f9188c38"
	testMemberID             = "0198f4c2-7a32-7d02-b8c1-3f6e15aa91b4"
	testAgentID              = "0198f4c2-7a35-7d02-b8c1-3f6e15aa91b4"
	testChannelID            = "0198f4c2-7a33-7af3-a01e-0fcb31e9d84a"
	testOperationID          = "0198f4c2-7a34-7af3-a01e-0fcb31e9d84b"
	testRootTopicOperationID = "0198f4c2-7a36-7af3-a01e-0fcb31e9d84c"
	testGroupID              = "@TGS#_C_5ODDSBF3PNVZH25YMT3OMJ4ZSF"
	testRootTopicID          = testGroupID + "@TOPIC#_T_46HDVNIIYDGRIRBGXZTJ7KMFLP"
	testIMUserID             = "u_BKHSUO5LLVUPHQTHDIA5U46EWD5ZQ"
	testAgentIMID            = "a_BKHSUO5LLVUPHQTHDIA5U46EWD5ZQ"
)

var testNow = time.Date(2026, 7, 30, 14, 0, 0, 0, time.UTC)

func TestEntRepositoryCreateWritesCompleteServerAggregateAtomically(
	t *testing.T,
) {
	repository, handle := openServerRepository(t)
	createReadyAccount(t, handle)

	result, err := repository.Create(context.Background(), testCreateCommand())
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if !result.Created ||
		result.ServerID != testServerID ||
		result.OperationID != testOperationID {
		t.Fatalf("Create() result = %#v", result)
	}

	ctx := context.Background()
	serverEntity, err := handle.Client().Server.Query().Only(ctx)
	if err != nil {
		t.Fatalf("query Server: %v", err)
	}
	if serverEntity.ID != testServerID ||
		serverEntity.Slug != "agent-lab" ||
		serverEntity.Name != "Agent 实验室" ||
		serverEntity.OwnerMemberID == nil ||
		*serverEntity.OwnerMemberID != testMemberID ||
		serverEntity.ImGroupID != testGroupID ||
		serverEntity.ImState != "provisioning" ||
		serverEntity.NextTaskNumber != 1 ||
		serverEntity.Revision != 1 {
		t.Fatalf("Server = %#v", serverEntity)
	}

	memberEntity, err := handle.Client().Member.Query().Only(ctx)
	if err != nil {
		t.Fatalf("query Member: %v", err)
	}
	if memberEntity.ID != testMemberID ||
		memberEntity.ServerID != testServerID ||
		memberEntity.AccountID == nil ||
		*memberEntity.AccountID != testAccountID ||
		memberEntity.Kind != "human" ||
		memberEntity.Role != "owner" ||
		memberEntity.DisplayName != "Alice" ||
		memberEntity.Handle != "u_Q4JUHFNA4CTQZQIS32XH" ||
		memberEntity.Status != "active" ||
		memberEntity.ImState != "provisioning" {
		t.Fatalf("Member = %#v", memberEntity)
	}

	channelEntity, err := handle.Client().Channel.Query().Only(ctx)
	if err != nil {
		t.Fatalf("query Channel: %v", err)
	}
	if channelEntity.ID != testChannelID ||
		channelEntity.ServerID != testServerID ||
		channelEntity.Name != "全员" ||
		channelEntity.Visibility != "public" ||
		channelEntity.SystemKey == nil ||
		*channelEntity.SystemKey != "all" ||
		channelEntity.ImGroupID != testGroupID ||
		channelEntity.ImTopicID == nil ||
		*channelEntity.ImTopicID != testRootTopicID ||
		channelEntity.ImState != "provisioning" {
		t.Fatalf("Channel = %#v", channelEntity)
	}

	assertServerSupportingRows(t, handle)
}

func TestEntRepositoryCreateReusesSameIdempotentResource(t *testing.T) {
	repository, handle := openServerRepository(t)
	createReadyAccount(t, handle)

	first, err := repository.Create(context.Background(), testCreateCommand())
	if err != nil {
		t.Fatal(err)
	}
	replay := testCreateCommand()
	replay.Server.ID = "0198f4c2-7a41-7c91-a6d2-7d76f9188c38"
	replay.Server.OwnerMemberID = "0198f4c2-7a42-7d02-b8c1-3f6e15aa91b4"
	replay.Owner.ID = replay.Server.OwnerMemberID
	replay.RootChannelID = "0198f4c2-7a43-7af3-a01e-0fcb31e9d84a"
	replay.OperationID = "0198f4c2-7a44-7af3-a01e-0fcb31e9d84b"

	second, err := repository.Create(context.Background(), replay)
	if err != nil {
		t.Fatalf("Create(replay) error = %v", err)
	}
	if second.Created ||
		second.ServerID != first.ServerID ||
		second.OperationID != first.OperationID {
		t.Fatalf("Create(replay) = %#v, first = %#v", second, first)
	}
	assertAggregateCounts(t, handle, 1)
}

func TestEntRepositoryCreateRejectsIdempotencyHashConflict(t *testing.T) {
	repository, handle := openServerRepository(t)
	createReadyAccount(t, handle)
	if _, err := repository.Create(
		context.Background(),
		testCreateCommand(),
	); err != nil {
		t.Fatal(err)
	}
	conflict := testCreateCommand()
	conflict.RequestHash = sha256.Sum256([]byte("different request"))

	_, err := repository.Create(context.Background(), conflict)
	if !errors.Is(err, servermemberport.ErrIdempotencyConflict) {
		t.Fatalf("Create(idempotency conflict) error = %v", err)
	}
	assertAggregateCounts(t, handle, 1)
}

func TestEntRepositoryCreateMapsSlugConflictAndRollsBack(t *testing.T) {
	repository, handle := openServerRepository(t)
	createReadyAccount(t, handle)
	if _, err := repository.Create(
		context.Background(),
		testCreateCommand(),
	); err != nil {
		t.Fatal(err)
	}
	conflict := testCreateCommand()
	conflict.IdempotencyKey = "server-create-test-0002"
	conflict.RequestHash = sha256.Sum256([]byte("different create"))
	conflict.Server.ID = "0198f4c2-7a41-7c91-a6d2-7d76f9188c38"
	conflict.Server.OwnerMemberID = "0198f4c2-7a42-7d02-b8c1-3f6e15aa91b4"
	conflict.Owner.ID = conflict.Server.OwnerMemberID
	conflict.RootChannelID = "0198f4c2-7a43-7af3-a01e-0fcb31e9d84a"
	conflict.OperationID = "0198f4c2-7a44-7af3-a01e-0fcb31e9d84b"

	_, err := repository.Create(context.Background(), conflict)
	if !errors.Is(err, servermemberport.ErrServerSlugConflict) {
		t.Fatalf("Create(slug conflict) error = %v", err)
	}
	assertAggregateCounts(t, handle, 1)
}

func TestEntRepositoryCreateRejectsAccountWithoutReadyIMIdentity(
	t *testing.T,
) {
	repository, handle := openServerRepository(t)
	createAccount(t, handle, "provisioning", "")

	_, err := repository.Create(context.Background(), testCreateCommand())
	if !errors.Is(err, servermemberport.ErrAccountIMNotReady) {
		t.Fatalf("Create(IM not ready) error = %v", err)
	}
	assertAggregateCounts(t, handle, 0)
}

func TestEntRepositoryUpdateUsesAuthoritativeMemberAndReplaysIdempotently(
	t *testing.T,
) {
	repository, handle := openServerRepository(t)
	createReadyAccount(t, handle)
	if _, err := repository.Create(context.Background(), testCreateCommand()); err != nil {
		t.Fatal(err)
	}
	description := "更新后的描述"
	command := servermemberport.UpdateCommand{
		AccountID: testAccountID, ServerID: testServerID, Revision: 1,
		IdempotencyKey: "server-update-test-0001",
		RequestHash:    sha256.Sum256([]byte("server-update-request")),
		NameSet:        true, Name: "Vela 研究实验室",
		DescriptionSet: true, Description: &description,
		UpdatedAt: testNow.Add(time.Minute),
	}

	first, err := repository.Update(context.Background(), command)
	if err != nil {
		t.Fatal(err)
	}
	second, err := repository.Update(context.Background(), command)
	if err != nil {
		t.Fatal(err)
	}
	if first.Name != "Vela 研究实验室" || first.Description == nil ||
		*first.Description != description || first.Revision != 2 ||
		second.Name != first.Name || second.Revision != first.Revision ||
		second.Description == nil || *second.Description != description {
		t.Fatalf("updates = (%#v, %#v)", first, second)
	}
	entity, err := handle.Client().Server.Query().Only(context.Background())
	if err != nil || entity.Revision != 2 || entity.Slug != "agent-lab" ||
		entity.ImGroupID != testGroupID {
		t.Fatalf("Server = %#v, %v", entity, err)
	}
	if got, err := handle.Client().IdempotencyRecord.Query().Count(context.Background()); err != nil || got != 2 {
		t.Fatalf("idempotency count = %d, %v", got, err)
	}
}

func TestEntRepositoryUpdateRejectsRevisionAndIdempotencyConflicts(t *testing.T) {
	repository, handle := openServerRepository(t)
	createReadyAccount(t, handle)
	if _, err := repository.Create(context.Background(), testCreateCommand()); err != nil {
		t.Fatal(err)
	}
	command := servermemberport.UpdateCommand{
		AccountID: testAccountID, ServerID: testServerID, Revision: 1,
		IdempotencyKey: "server-update-test-0001",
		RequestHash:    sha256.Sum256([]byte("server-update-request")),
		NameSet:        true, Name: "新的名称", UpdatedAt: testNow.Add(time.Minute),
	}
	if _, err := repository.Update(context.Background(), command); err != nil {
		t.Fatal(err)
	}
	conflict := command
	conflict.RequestHash = sha256.Sum256([]byte("different-update"))
	if _, err := repository.Update(context.Background(), conflict); !errors.Is(err, servermemberport.ErrIdempotencyConflict) {
		t.Fatalf("idempotency conflict = %v", err)
	}
	stale := command
	stale.IdempotencyKey = "server-update-test-0002"
	stale.RequestHash = sha256.Sum256([]byte("stale-update"))
	if _, err := repository.Update(context.Background(), stale); !errors.Is(err, servermemberport.ErrRevisionConflict) {
		t.Fatalf("revision conflict = %v", err)
	}
}

func TestEntRepositoryUpdateRequiresAuthoritativeManagerMember(t *testing.T) {
	repository, handle := openServerRepository(t)
	createReadyAccount(t, handle)
	if _, err := repository.Create(context.Background(), testCreateCommand()); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Client().Member.UpdateOneID(testMemberID).
		SetRole("member").Save(context.Background()); err != nil {
		t.Fatal(err)
	}
	_, err := repository.Update(context.Background(), servermemberport.UpdateCommand{
		AccountID: testAccountID, ServerID: testServerID, Revision: 1,
		IdempotencyKey: "server-update-test-0001",
		RequestHash:    sha256.Sum256([]byte("server-update-request")),
		NameSet:        true, Name: "不允许的名称", UpdatedAt: testNow.Add(time.Minute),
	})
	if !errors.Is(err, servermemberport.ErrPermissionDenied) {
		t.Fatalf("Update(member) error = %v", err)
	}
}

func TestEntRepositoryQueriesServerAndOwnerThroughActiveMembership(
	t *testing.T,
) {
	repository, handle := openServerRepository(t)
	createReadyAccount(t, handle)
	if _, err := repository.Create(
		context.Background(),
		testCreateCommand(),
	); err != nil {
		t.Fatal(err)
	}

	page, err := repository.ListServers(
		context.Background(),
		testAccountID,
		servermemberport.ListOptions{Limit: 20},
	)
	if err != nil {
		t.Fatalf("ListServers() error = %v", err)
	}
	if len(page.Items) != 1 ||
		page.Items[0].ID != testServerID ||
		page.NextCursor != "" {
		t.Fatalf("ListServers() = %#v", page)
	}
	serverValue, err := repository.GetServer(
		context.Background(),
		testAccountID,
		testServerID,
	)
	if err != nil || serverValue.OwnerMemberID != testMemberID {
		t.Fatalf("GetServer() = %#v, %v", serverValue, err)
	}
	members, err := repository.ListMembers(
		context.Background(),
		testAccountID,
		testServerID,
		servermemberport.ListOptions{Limit: 20},
	)
	if err != nil {
		t.Fatalf("ListMembers() error = %v", err)
	}
	if len(members.Items) != 1 ||
		members.Items[0].ID != testMemberID ||
		members.Items[0].IMUserID != testIMUserID {
		t.Fatalf("ListMembers() = %#v", members)
	}
	memberValue, err := repository.GetMember(
		context.Background(),
		testAccountID,
		testServerID,
		testMemberID,
	)
	if err != nil || memberValue.Role != "owner" {
		t.Fatalf("GetMember() = %#v, %v", memberValue, err)
	}
}

func TestEntRepositoryListsExplicitPrivateChannelMembers(t *testing.T) {
	repository, handle := openServerRepository(t)
	createReadyAccount(t, handle)
	if _, err := repository.Create(
		context.Background(),
		testCreateCommand(),
	); err != nil {
		t.Fatal(err)
	}
	privateChannelID := "0198f4c2-7a36-7af3-a01e-0fcb31e9d84a"
	privateMembershipID := "0198f4c2-7a37-7af3-a01e-0fcb31e9d84a"
	topicID := "@TGS#_test@TOPIC#_PRIVATE"
	ctx := context.Background()
	if _, err := handle.Client().Channel.Create().
		SetID(privateChannelID).
		SetServerID(testServerID).
		SetName("私密协作").
		SetVisibility("private").
		SetImGroupID(testGroupID).
		SetImTopicID(topicID).
		SetImState("ready").
		SetRevision(1).
		SetCreatedAt(testNow).
		SetUpdatedAt(testNow).
		Save(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Client().ChannelMember.Create().
		SetID(privateMembershipID).
		SetServerID(testServerID).
		SetChannelID(privateChannelID).
		SetMemberID(testMemberID).
		SetState("active").
		SetImState("provisioning").
		SetMembershipVersion(1).
		SetCreatedAt(testNow).
		SetUpdatedAt(testNow).
		Save(ctx); err != nil {
		t.Fatal(err)
	}

	members, err := repository.ListChannelMembers(
		ctx,
		testAccountID,
		testServerID,
		privateChannelID,
		servermemberport.ListOptions{Limit: 20},
	)
	if err != nil {
		t.Fatalf("ListChannelMembers() error = %v", err)
	}
	if len(members) != 1 ||
		members[0].ID != testMemberID ||
		members[0].IMUserID != testIMUserID {
		t.Fatalf("ListChannelMembers() = %#v", members)
	}

	if _, err := repository.ListChannelMembers(
		ctx,
		"0198f4c2-7a50-7c91-a6d2-7d76f9188c37",
		testServerID,
		privateChannelID,
		servermemberport.ListOptions{Limit: 20},
	); !errors.Is(err, servermemberport.ErrServerNotFound) {
		t.Fatalf("ListChannelMembers(non-member) error = %v", err)
	}
}

func TestEntRepositoryReturnsAgentIMIdentityForAgentMember(t *testing.T) {
	repository, handle := openServerRepository(t)
	createReadyAccount(t, handle)
	if _, err := repository.Create(
		context.Background(),
		testCreateCommand(),
	); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Client().Member.Create().
		SetID(testAgentID).
		SetServerID(testServerID).
		SetKind("agent").
		SetRole("member").
		SetDisplayName("验收 Agent").
		SetHandle("acceptance-agent").
		SetStatus("active").
		SetImState("ready").
		SetRevision(2).
		SetCreatedAt(testNow).
		SetUpdatedAt(testNow).
		Save(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Client().Agent.Create().
		SetID(testAgentID).
		SetServerID(testServerID).
		SetImUserID(testAgentIMID).
		SetRuntimeKind("codex").
		SetReplyPolicy("mention_and_dm").
		SetDesiredState("running").
		SetObservedState("running").
		SetCredentialVersion(1).
		SetImState("ready").
		SetCreatedByMemberID(testMemberID).
		SetRevision(2).
		SetCreatedAt(testNow).
		SetUpdatedAt(testNow).
		Save(context.Background()); err != nil {
		t.Fatal(err)
	}

	value, err := repository.GetMember(
		context.Background(),
		testAccountID,
		testServerID,
		testAgentID,
	)
	if err != nil {
		t.Fatalf("GetMember() error = %v", err)
	}
	if value.Kind != "agent" || value.IMUserID != testAgentIMID {
		t.Fatalf("GetMember() = %#v", value)
	}
}

func TestEntRepositoryQueriesHideServerFromNonMember(t *testing.T) {
	repository, handle := openServerRepository(t)
	createReadyAccount(t, handle)
	if _, err := repository.Create(
		context.Background(),
		testCreateCommand(),
	); err != nil {
		t.Fatal(err)
	}
	otherAccountID := "0198f4c2-7a50-7c91-a6d2-7d76f9188c37"

	if _, err := repository.GetServer(
		context.Background(),
		otherAccountID,
		testServerID,
	); !errors.Is(err, servermemberport.ErrServerNotFound) {
		t.Fatalf("GetServer(non-member) error = %v", err)
	}
	if _, err := repository.ListMembers(
		context.Background(),
		otherAccountID,
		testServerID,
		servermemberport.ListOptions{Limit: 20},
	); !errors.Is(err, servermemberport.ErrServerNotFound) {
		t.Fatalf("ListMembers(non-member) error = %v", err)
	}
	if _, err := repository.GetMember(
		context.Background(),
		otherAccountID,
		testServerID,
		testMemberID,
	); !errors.Is(err, servermemberport.ErrServerNotFound) {
		t.Fatalf("GetMember(non-member) error = %v", err)
	}
}

func openServerRepository(
	t *testing.T,
) (*EntRepository, *database.Handle) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "data", "chatserver.db")
	cfg, err := config.NewDatabase(path)
	if err != nil {
		t.Fatal(err)
	}
	handle, err := database.OpenWriter(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := handle.Close(); err != nil {
			t.Errorf("Close() error = %v", err)
		}
	})
	if err := migration.Apply(context.Background(), handle.SQLDB()); err != nil {
		t.Fatal(err)
	}
	repository, err := NewEntRepository(handle)
	if err != nil {
		t.Fatal(err)
	}
	return repository, handle
}

func createReadyAccount(t *testing.T, handle *database.Handle) {
	createAccount(t, handle, "ready", testIMUserID)
}

func createAccount(
	t *testing.T,
	handle *database.Handle,
	imState string,
	imUserID string,
) {
	t.Helper()
	_, err := handle.Client().Account.Create().
		SetID(testAccountID).
		SetEmail("alice@example.com").
		SetEmailNormalized("alice@example.com").
		SetDisplayName("Alice").
		SetPasswordHash("not-used-in-this-test").
		SetTokenVersion(1).
		SetImUserID(imUserID).
		SetImState(imState).
		SetRevision(2).
		SetCreatedAt(testNow).
		SetUpdatedAt(testNow).
		Save(context.Background())
	if err != nil {
		t.Fatal(err)
	}
}

func testCreateCommand() servermemberport.CreateCommand {
	description := "Canary Server"
	return servermemberport.CreateCommand{
		AccountID:      testAccountID,
		IdempotencyKey: "server-create-test-0001",
		RequestHash:    sha256.Sum256([]byte("create-server-request")),
		CreatedAt:      testNow,
		Server: servermemberport.ServerDraft{
			ID:            testServerID,
			Slug:          "agent-lab",
			Name:          "Agent 实验室",
			Description:   &description,
			IMGroupID:     testGroupID,
			OwnerMemberID: testMemberID,
		},
		Owner: servermemberport.OwnerDraft{
			ID:     testMemberID,
			Handle: "u_Q4JUHFNA4CTQZQIS32XH",
		},
		RootChannelID:        testChannelID,
		RootChannelTopicID:   testRootTopicID,
		RootTopicOperationID: testRootTopicOperationID,
		OperationID:          testOperationID,
	}
}

func assertServerSupportingRows(
	t *testing.T,
	handle *database.Handle,
) {
	t.Helper()
	ctx := context.Background()
	projection, err := handle.Client().AccountServerMembership.Query().Only(ctx)
	if err != nil {
		t.Fatalf("query AccountServerMembership: %v", err)
	}
	if projection.AccountID != testAccountID ||
		projection.ServerID != testServerID ||
		projection.MemberID != testMemberID ||
		projection.Role != "owner" ||
		projection.Status != "active" ||
		!projection.ProjectedAt.Equal(testNow) {
		t.Fatalf("AccountServerMembership = %#v", projection)
	}
	slug, err := handle.Client().ServerSlugRegistry.Query().Only(ctx)
	if err != nil {
		t.Fatalf("query ServerSlugRegistry: %v", err)
	}
	if slug.Slug != "agent-lab" ||
		slug.ServerID != testServerID ||
		slug.State != "active" {
		t.Fatalf("ServerSlugRegistry = %#v", slug)
	}
	operation, err := handle.Client().TencentOperation.Query().Only(ctx)
	if err != nil {
		t.Fatalf("query TencentOperation: %v", err)
	}
	if operation.ID != testOperationID ||
		operation.PartitionKey != testServerID ||
		operation.Kind != "im.community.ensure" ||
		operation.ResourceType != "server" ||
		operation.ResourceID != testServerID ||
		operation.State != "pending" ||
		operation.Attempts != 0 {
		t.Fatalf("TencentOperation = %#v", operation)
	}
	outbox, err := handle.Client().OutboxEvent.Query().Only(ctx)
	if err != nil {
		t.Fatalf("query OutboxEvent: %v", err)
	}
	if outbox.PartitionKey != testServerID ||
		outbox.AggregateID != testOperationID ||
		outbox.EventType != "tencent.operation.ready" ||
		outbox.State != "pending" {
		t.Fatalf("OutboxEvent = %#v", outbox)
	}
	idempotency, err := handle.Client().IdempotencyRecord.Query().Only(ctx)
	if err != nil {
		t.Fatalf("query IdempotencyRecord: %v", err)
	}
	if idempotency.PartitionKey != testAccountID ||
		idempotency.ScopeType != "server.create" ||
		idempotency.ScopeID != testAccountID ||
		idempotency.ResponseStatus != 202 ||
		!idempotency.ExpiresAt.Equal(testNow.Add(24*time.Hour)) {
		t.Fatalf("IdempotencyRecord = %#v", idempotency)
	}
}

func assertAggregateCounts(
	t *testing.T,
	handle *database.Handle,
	want int,
) {
	t.Helper()
	ctx := context.Background()
	counts := []struct {
		name  string
		count func(context.Context) (int, error)
	}{
		{"Server", handle.Client().Server.Query().Count},
		{"Member", handle.Client().Member.Query().Count},
		{"Channel", handle.Client().Channel.Query().Count},
		{"AccountServerMembership", handle.Client().AccountServerMembership.Query().Count},
		{"ServerSlugRegistry", handle.Client().ServerSlugRegistry.Query().Count},
		{"TencentOperation", handle.Client().TencentOperation.Query().Count},
		{"OutboxEvent", handle.Client().OutboxEvent.Query().Count},
		{"IdempotencyRecord", handle.Client().IdempotencyRecord.Query().Count},
	}
	for _, item := range counts {
		got, err := item.count(ctx)
		if err != nil || got != want {
			t.Fatalf("%s count = %d, %v; want %d", item.name, got, err, want)
		}
	}
}
