package imdirectconversation

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"chatserver/internal/config"
	"chatserver/internal/database"
	"chatserver/internal/database/migration"
	workport "chatserver/internal/ports/imdirectconversation"
)

const (
	directWorkerServerID = "0198f4c2-7b10-7c91-a6d2-7d76f9188c01"
	directWorkerAID      = "0198f4c2-7b11-7c91-a6d2-7d76f9188c02"
	directWorkerBID      = "0198f4c2-7b12-7c91-a6d2-7d76f9188c03"
	directWorkerID       = "0198f4c2-7b13-7c91-a6d2-7d76f9188c04"
	directWorkerOpID     = "0198f4c2-7b14-7c91-a6d2-7d76f9188c05"
)

var directWorkerNow = time.Date(2026, 8, 4, 17, 0, 0, 0, time.UTC)

func TestEntRepositoryClaimsAndCompletesDirectGroup(t *testing.T) {
	repository, handle := openDirectWorkerRepository(t)
	seedDirectWorkerOperation(t, handle)
	ctx := context.Background()

	work, found, err := repository.Claim(ctx, workport.Claim{
		LeaseOwner: "worker-1", Now: directWorkerNow, LeaseExpiresAt: directWorkerNow.Add(time.Minute),
	})
	if err != nil || !found {
		t.Fatalf("Claim() = (%#v, %v, %v)", work, found, err)
	}
	if work.DirectConversationID != directWorkerID || work.GroupID != "an_dm_worker" ||
		work.MemberAIMUserID != "u_WORK_A" || work.MemberBIMUserID != "u_WORK_B" ||
		work.ConversationRevision != 1 || work.DesiredRevision != 1 || work.Attempts != 1 {
		t.Fatalf("work = %#v", work)
	}

	completedAt := directWorkerNow.Add(time.Second)
	if err := repository.Complete(ctx, workport.Completion{
		OperationID: work.OperationID, LeaseOwner: work.LeaseOwner,
		Status: workport.CompletionSucceeded, CompletedAt: completedAt,
	}); err != nil {
		t.Fatal(err)
	}
	conversation, err := handle.Client().DirectConversation.Get(ctx, directWorkerID)
	if err != nil || conversation.ImState != "ready" || conversation.Revision != 2 {
		t.Fatalf("conversation = (%#v, %v)", conversation, err)
	}
	operation, err := handle.Client().TencentOperation.Get(ctx, directWorkerOpID)
	if err != nil || operation.State != "succeeded" || operation.CompletedAt == nil {
		t.Fatalf("operation = (%#v, %v)", operation, err)
	}
	outbox, err := handle.Client().OutboxEvent.Query().Only(ctx)
	if err != nil || outbox.State != "processed" || outbox.ProcessedAt == nil {
		t.Fatalf("outbox = (%#v, %v)", outbox, err)
	}
}

func TestEntRepositoryLeavesConversationProvisioningDuringRetryWait(t *testing.T) {
	repository, handle := openDirectWorkerRepository(t)
	seedDirectWorkerOperation(t, handle)
	ctx := context.Background()
	work, _, err := repository.Claim(ctx, workport.Claim{
		LeaseOwner: "worker-1", Now: directWorkerNow, LeaseExpiresAt: directWorkerNow.Add(time.Minute),
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := repository.Complete(ctx, workport.Completion{
		OperationID: work.OperationID, LeaseOwner: work.LeaseOwner, Status: workport.CompletionRetry,
		ErrorCode: "tencent_network_error", CompletedAt: directWorkerNow.Add(time.Second),
		NextAttemptAt: directWorkerNow.Add(time.Minute),
	}); err != nil {
		t.Fatal(err)
	}
	conversation, _ := handle.Client().DirectConversation.Get(ctx, directWorkerID)
	operation, _ := handle.Client().TencentOperation.Get(ctx, directWorkerOpID)
	outbox, _ := handle.Client().OutboxEvent.Query().Only(ctx)
	if conversation.ImState != "provisioning" || conversation.Revision != 1 ||
		operation.State != "retry_wait" || outbox.State != "pending" {
		t.Fatalf("conversation=%#v operation=%#v outbox=%#v", conversation, operation, outbox)
	}
}

func openDirectWorkerRepository(t *testing.T) (*EntRepository, *database.Handle) {
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

func seedDirectWorkerOperation(t *testing.T, handle *database.Handle) {
	t.Helper()
	ctx := context.Background()
	accounts := []struct{ id, email, im string }{
		{"0198f4c2-7b15-7c91-a6d2-7d76f9188c06", "a@example.com", "u_WORK_A"},
		{"0198f4c2-7b16-7c91-a6d2-7d76f9188c07", "b@example.com", "u_WORK_B"},
	}
	for _, value := range accounts {
		if _, err := handle.Client().Account.Create().SetID(value.id).SetEmail(value.email).
			SetEmailNormalized(value.email).SetDisplayName(value.email).SetPasswordHash("unused").
			SetTokenVersion(1).SetImUserID(value.im).SetImState("ready").SetRevision(1).
			SetCreatedAt(directWorkerNow).SetUpdatedAt(directWorkerNow).Save(ctx); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := handle.Client().Server.Create().SetID(directWorkerServerID).SetSlug("direct-worker").
		SetName("Direct Worker").SetImGroupID("@TGS#_C_worker").SetImState("ready").
		SetNextTaskNumber(1).SetRevision(1).SetCreatedAt(directWorkerNow).SetUpdatedAt(directWorkerNow).Save(ctx); err != nil {
		t.Fatal(err)
	}
	for index, value := range []struct{ id, account, handle string }{
		{directWorkerAID, accounts[0].id, "worker-a"}, {directWorkerBID, accounts[1].id, "worker-b"},
	} {
		if _, err := handle.Client().Member.Create().SetID(value.id).SetServerID(directWorkerServerID).
			SetAccountID(value.account).SetKind("human").SetRole("member").SetDisplayName(value.handle).
			SetHandle(value.handle).SetActiveHandleKey(value.handle).SetStatus("active").SetImState("ready").
			SetRevision(1).SetCreatedAt(directWorkerNow.Add(time.Duration(index) * time.Millisecond)).
			SetUpdatedAt(directWorkerNow).Save(ctx); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := handle.Client().DirectConversation.Create().SetID(directWorkerID).
		SetServerID(directWorkerServerID).SetMemberAID(directWorkerAID).SetMemberBID(directWorkerBID).
		SetImGroupID("an_dm_worker").SetStatus("active").SetImState("provisioning").
		SetRevision(1).SetCreatedAt(directWorkerNow).SetUpdatedAt(directWorkerNow).Save(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Client().TencentOperation.Create().SetID(directWorkerOpID).
		SetPartitionKey(directWorkerServerID).SetServerID(directWorkerServerID).SetService("im").
		SetKind("im.direct.ensure").SetResourceType("direct_conversation").SetResourceID(directWorkerID).
		SetIdempotencyKey("im.direct.ensure:v1:" + directWorkerID + ":1").SetDesiredRevision(1).
		SetState("pending").SetAttempts(0).SetCreatedAt(directWorkerNow).SetUpdatedAt(directWorkerNow).Save(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Client().OutboxEvent.Create().SetPartitionKey(directWorkerServerID).
		SetServerID(directWorkerServerID).SetEventType("tencent.operation.ready").
		SetAggregateType("tencent_operation").SetAggregateID(directWorkerOpID).
		SetState("pending").SetAttempts(0).SetAvailableAt(directWorkerNow).SetCreatedAt(directWorkerNow).Save(ctx); err != nil {
		t.Fatal(err)
	}
}
