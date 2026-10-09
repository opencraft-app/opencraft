package directconversation

import (
	"context"
	"crypto/sha256"
	"path/filepath"
	"testing"
	"time"

	"chatserver/internal/config"
	"chatserver/internal/database"
	"chatserver/internal/database/migration"
	directport "chatserver/internal/ports/directconversation"
)

const (
	repoDirectAccountID   = "0198f4c2-7a30-7c91-a6d2-7d76f9188c37"
	repoDirectPeerAccount = "0198f4c2-7a31-7c91-a6d2-7d76f9188c38"
	repoDirectServerID    = "0198f4c2-7a32-7c91-a6d2-7d76f9188c39"
	repoDirectSelfID      = "0198f4c2-7a33-7c91-a6d2-7d76f9188c40"
	repoDirectPeerID      = "0198f4c2-7a34-7c91-a6d2-7d76f9188c41"
	repoDirectID          = "0198f4c2-7a35-7c91-a6d2-7d76f9188c42"
	repoDirectOperationID = "0198f4c2-7a36-7c91-a6d2-7d76f9188c43"
	repoDirectRetryOpID   = "0198f4c2-7a37-7c91-a6d2-7d76f9188c44"
	repoDirectGroupID     = "an_dm_5ODDSBF3PNVZH25YMT3OMJ4ZSF"
)

var repoDirectNow = time.Date(2026, 8, 4, 15, 0, 0, 0, time.UTC)

func TestEntRepositoryConvergesCreateKeysAndSeparatesRetry(t *testing.T) {
	repository, handle := openDirectRepository(t)
	seedDirectParticipants(t, handle)
	ctx := context.Background()

	participants, err := repository.ResolveParticipants(ctx, repoDirectAccountID, repoDirectServerID, repoDirectPeerID)
	if err != nil || participants.Self.ID != repoDirectSelfID || participants.Peer.ID != repoDirectPeerID ||
		participants.Self.IMUserID != "u_SELF" || participants.Peer.IMUserID != "u_PEER" {
		t.Fatalf("ResolveParticipants() = (%#v, %v)", participants, err)
	}

	command := directport.CreateCommand{
		AccountID: repoDirectAccountID, ServerID: repoDirectServerID,
		PeerMemberID: repoDirectPeerID, MemberAID: repoDirectSelfID, MemberBID: repoDirectPeerID,
		DirectConversationID: repoDirectID, IMGroupID: repoDirectGroupID,
		OperationID: repoDirectOperationID, IdempotencyKey: "direct-create-0001",
		RequestHash: sha256.Sum256([]byte(repoDirectPeerID)), CreatedAt: repoDirectNow,
	}
	created, err := repository.Create(ctx, command)
	if err != nil {
		t.Fatal(err)
	}
	if !created.Accepted || created.Conversation.ID != repoDirectID ||
		created.Conversation.IMState != "provisioning" || len(created.Operations) != 1 ||
		created.Operations[0].Kind != "im.direct.ensure" {
		t.Fatalf("Create() = %#v", created)
	}

	replay := command
	replay.DirectConversationID = "0198f4c2-7a45-7c91-a6d2-7d76f9188c42"
	replay.OperationID = "0198f4c2-7a46-7c91-a6d2-7d76f9188c43"
	replayed, err := repository.Create(ctx, replay)
	if err != nil || replayed.Conversation.ID != repoDirectID || replayed.Operations[0].ID != repoDirectOperationID {
		t.Fatalf("Create(replay) = (%#v, %v)", replayed, err)
	}

	concurrentKey := command
	concurrentKey.IdempotencyKey = "direct-create-0002"
	concurrentKey.DirectConversationID = "0198f4c2-7a55-7c91-a6d2-7d76f9188c42"
	concurrentKey.OperationID = "0198f4c2-7a56-7c91-a6d2-7d76f9188c43"
	converged, err := repository.Create(ctx, concurrentKey)
	if err != nil || converged.Conversation.ID != repoDirectID || converged.Operations[0].ID != repoDirectOperationID {
		t.Fatalf("Create(other key) = (%#v, %v)", converged, err)
	}
	if count, err := handle.Client().DirectConversation.Query().Count(ctx); err != nil || count != 1 {
		t.Fatalf("direct count = (%d, %v)", count, err)
	}
	if count, err := handle.Client().TencentOperation.Query().Count(ctx); err != nil || count != 1 {
		t.Fatalf("operation count = (%d, %v)", count, err)
	}

	if _, err := handle.Client().DirectConversation.UpdateOneID(repoDirectID).
		SetImState("error").AddRevision(1).SetUpdatedAt(repoDirectNow.Add(time.Minute)).Save(ctx); err != nil {
		t.Fatal(err)
	}
	retried, err := repository.Retry(ctx, directport.RetryCommand{
		AccountID: repoDirectAccountID, ServerID: repoDirectServerID,
		DirectConversationID: repoDirectID, OperationID: repoDirectRetryOpID,
		IdempotencyKey: "direct-retry-0001",
		RequestHash:    sha256.Sum256([]byte(repoDirectID)), RequestedAt: repoDirectNow.Add(2 * time.Minute),
	})
	if err != nil || !retried.Accepted || retried.Conversation.ID != repoDirectID ||
		retried.Conversation.IMState != "provisioning" || retried.Conversation.Revision != 3 ||
		len(retried.Operations) != 1 || retried.Operations[0].ID != repoDirectRetryOpID {
		t.Fatalf("Retry() = (%#v, %v)", retried, err)
	}
	retryReplay, err := repository.Retry(ctx, directport.RetryCommand{
		AccountID: repoDirectAccountID, ServerID: repoDirectServerID,
		DirectConversationID: repoDirectID,
		OperationID:          "0198f4c2-7a47-7c91-a6d2-7d76f9188c44",
		IdempotencyKey:       "direct-retry-0001",
		RequestHash:          sha256.Sum256([]byte(repoDirectID)), RequestedAt: repoDirectNow.Add(3 * time.Minute),
	})
	if err != nil || retryReplay.Operations[0].ID != repoDirectRetryOpID {
		t.Fatalf("Retry(replay) = (%#v, %v)", retryReplay, err)
	}
}

func TestEntRepositoryListsOnlyCurrentMemberConversations(t *testing.T) {
	repository, handle := openDirectRepository(t)
	seedDirectParticipants(t, handle)
	ctx := context.Background()
	_, err := repository.Create(ctx, directport.CreateCommand{
		AccountID: repoDirectAccountID, ServerID: repoDirectServerID,
		PeerMemberID: repoDirectPeerID, MemberAID: repoDirectSelfID, MemberBID: repoDirectPeerID,
		DirectConversationID: repoDirectID, IMGroupID: repoDirectGroupID,
		OperationID: repoDirectOperationID, IdempotencyKey: "direct-create-0001",
		RequestHash: sha256.Sum256([]byte(repoDirectPeerID)), CreatedAt: repoDirectNow,
	})
	if err != nil {
		t.Fatal(err)
	}
	page, err := repository.List(ctx, directport.PageRequest{AccountID: repoDirectAccountID, ServerID: repoDirectServerID, Limit: 20})
	if err != nil || len(page.Items) != 1 || page.Items[0].ID != repoDirectID {
		t.Fatalf("List() = (%#v, %v)", page, err)
	}
	value, err := repository.Get(ctx, repoDirectAccountID, repoDirectServerID, repoDirectID)
	if err != nil || value.MemberA.ID != repoDirectSelfID || value.MemberB.ID != repoDirectPeerID {
		t.Fatalf("Get() = (%#v, %v)", value, err)
	}
}

func openDirectRepository(t *testing.T) (*EntRepository, *database.Handle) {
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

func seedDirectParticipants(t *testing.T, handle *database.Handle) {
	t.Helper()
	ctx := context.Background()
	for _, account := range []struct{ id, email, name, im string }{
		{repoDirectAccountID, "self@example.com", "Self", "u_SELF"},
		{repoDirectPeerAccount, "peer@example.com", "Peer", "u_PEER"},
	} {
		if _, err := handle.Client().Account.Create().SetID(account.id).
			SetEmail(account.email).SetEmailNormalized(account.email).SetDisplayName(account.name).
			SetPasswordHash("unused").SetTokenVersion(1).SetImUserID(account.im).SetImState("ready").
			SetRevision(1).SetCreatedAt(repoDirectNow).SetUpdatedAt(repoDirectNow).Save(ctx); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := handle.Client().Server.Create().SetID(repoDirectServerID).SetSlug("direct-test").
		SetName("Direct Test").SetOwnerMemberID(repoDirectSelfID).SetImGroupID("@TGS#_C_DIRECT").
		SetImState("ready").SetNextTaskNumber(1).SetRevision(1).
		SetCreatedAt(repoDirectNow).SetUpdatedAt(repoDirectNow).Save(ctx); err != nil {
		t.Fatal(err)
	}
	for _, value := range []struct{ id, account, role, name, handle string }{
		{repoDirectSelfID, repoDirectAccountID, "owner", "Self", "self"},
		{repoDirectPeerID, repoDirectPeerAccount, "member", "Peer", "peer"},
	} {
		if _, err := handle.Client().Member.Create().SetID(value.id).SetServerID(repoDirectServerID).
			SetAccountID(value.account).SetKind("human").SetRole(value.role).SetDisplayName(value.name).
			SetHandle(value.handle).SetActiveHandleKey(value.handle).SetStatus("active").SetImState("ready").
			SetRevision(1).SetCreatedAt(repoDirectNow).SetUpdatedAt(repoDirectNow).Save(ctx); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := handle.Client().AccountServerMembership.Create().SetAccountID(repoDirectAccountID).
		SetServerID(repoDirectServerID).SetMemberID(repoDirectSelfID).SetRole("owner").SetStatus("active").
		SetServerNameSnapshot("Direct Test").SetServerSlugSnapshot("direct-test").SetServerRevision(1).
		SetProjectedAt(repoDirectNow).SetUpdatedAt(repoDirectNow).Save(ctx); err != nil {
		t.Fatal(err)
	}
}
