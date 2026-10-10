package imidentity

import (
	"context"
	"errors"
	"testing"
	"time"

	"chatserver/internal/config"
	"chatserver/internal/database"
	"chatserver/internal/database/migration"
	"chatserver/internal/ent/outboxevent"
	"chatserver/internal/ent/tencentoperation"
	imidentityport "chatserver/internal/ports/imidentity"
)

const (
	repositoryAccountID   = "01989c24-7540-7f12-a27b-c83243215dd1"
	repositoryOperationID = "01989c24-7540-7f12-a27b-c83243215dd2"
	repositoryOutboxID    = "01989c24-7540-7f12-a27b-c83243215dd3"
)

var repositoryNow = time.Date(2026, 7, 30, 15, 0, 0, 0, time.UTC)

func TestEntRepositoryClaimsAndAtomicallyCompletesIdentity(t *testing.T) {
	handle := openIdentityTestDatabase(t)
	seedIdentityWork(t, handle)
	repository, err := NewEntRepository(handle)
	if err != nil {
		t.Fatal(err)
	}

	work, ok, err := repository.Claim(context.Background(), imidentityport.Claim{
		LeaseOwner:     "worker-a",
		Now:            repositoryNow,
		LeaseExpiresAt: repositoryNow.Add(time.Minute),
	})
	if err != nil || !ok {
		t.Fatalf("Claim() = (%#v, %v, %v)", work, ok, err)
	}
	if work.OperationID != repositoryOperationID ||
		work.AccountID != repositoryAccountID ||
		work.DisplayName != "爱丽丝" ||
		work.AccountRevision != 1 ||
		work.DesiredRevision != 1 ||
		work.Attempts != 1 ||
		work.LeaseOwner != "worker-a" {
		t.Fatalf("work = %#v", work)
	}
	if _, second, err := repository.Claim(
		context.Background(),
		imidentityport.Claim{
			LeaseOwner:     "worker-b",
			Now:            repositoryNow,
			LeaseExpiresAt: repositoryNow.Add(time.Minute),
		},
	); err != nil || second {
		t.Fatalf("second Claim() = (%v, %v)", second, err)
	}

	err = repository.Complete(context.Background(), imidentityport.Completion{
		OperationID: repositoryOperationID,
		LeaseOwner:  "worker-a",
		Status:      imidentityport.CompletionSucceeded,
		IMUserID:    "u_OPAQUE",
		CompletedAt: repositoryNow.Add(time.Second),
	})
	if err != nil {
		t.Fatalf("Complete() error = %v", err)
	}
	account, err := handle.Client().Account.Get(
		context.Background(),
		repositoryAccountID,
	)
	if err != nil {
		t.Fatal(err)
	}
	if account.ImUserID != "u_OPAQUE" ||
		account.ImState != "ready" ||
		account.Revision != 2 {
		t.Fatalf("account = %#v", account)
	}
	operation, err := handle.Client().TencentOperation.Get(
		context.Background(),
		repositoryOperationID,
	)
	if err != nil {
		t.Fatal(err)
	}
	if operation.State != "succeeded" ||
		operation.LeaseOwner != nil ||
		operation.LeaseExpiresAt != nil ||
		operation.CompletedAt == nil {
		t.Fatalf("operation = %#v", operation)
	}
	outbox, err := handle.Client().OutboxEvent.Get(
		context.Background(),
		repositoryOutboxID,
	)
	if err != nil {
		t.Fatal(err)
	}
	if outbox.State != "processed" || outbox.ProcessedAt == nil {
		t.Fatalf("outbox = %#v", outbox)
	}
}

func TestEntRepositoryExpiredLeaseIsReclaimedAndOldOwnerCannotComplete(
	t *testing.T,
) {
	handle := openIdentityTestDatabase(t)
	seedIdentityWork(t, handle)
	repository, err := NewEntRepository(handle)
	if err != nil {
		t.Fatal(err)
	}
	_, ok, err := repository.Claim(context.Background(), imidentityport.Claim{
		LeaseOwner:     "worker-a",
		Now:            repositoryNow,
		LeaseExpiresAt: repositoryNow.Add(time.Minute),
	})
	if err != nil || !ok {
		t.Fatalf("first Claim() = (%v, %v)", ok, err)
	}
	work, ok, err := repository.Claim(context.Background(), imidentityport.Claim{
		LeaseOwner:     "worker-b",
		Now:            repositoryNow.Add(2 * time.Minute),
		LeaseExpiresAt: repositoryNow.Add(3 * time.Minute),
	})
	if err != nil || !ok || work.Attempts != 2 {
		t.Fatalf("reclaim = (%#v, %v, %v)", work, ok, err)
	}

	err = repository.Complete(context.Background(), imidentityport.Completion{
		OperationID: repositoryOperationID,
		LeaseOwner:  "worker-a",
		Status:      imidentityport.CompletionSucceeded,
		IMUserID:    "u_STALE",
		CompletedAt: repositoryNow.Add(2 * time.Minute),
	})
	if !errors.Is(err, imidentityport.ErrLeaseLost) {
		t.Fatalf("stale Complete() error = %v", err)
	}
	account, err := handle.Client().Account.Get(
		context.Background(),
		repositoryAccountID,
	)
	if err != nil {
		t.Fatal(err)
	}
	if account.ImState != "provisioning" || account.ImUserID != "" {
		t.Fatalf("stale owner changed account = %#v", account)
	}
}

func TestEntRepositoryRejectsCompletionAfterLeaseExpiryWithoutReclaim(
	t *testing.T,
) {
	handle := openIdentityTestDatabase(t)
	seedIdentityWork(t, handle)
	repository, err := NewEntRepository(handle)
	if err != nil {
		t.Fatal(err)
	}
	_, ok, err := repository.Claim(context.Background(), imidentityport.Claim{
		LeaseOwner:     "worker-a",
		Now:            repositoryNow,
		LeaseExpiresAt: repositoryNow.Add(time.Minute),
	})
	if err != nil || !ok {
		t.Fatalf("Claim() = (%v, %v)", ok, err)
	}

	err = repository.Complete(context.Background(), imidentityport.Completion{
		OperationID: repositoryOperationID,
		LeaseOwner:  "worker-a",
		Status:      imidentityport.CompletionSucceeded,
		IMUserID:    "u_EXPIRED",
		CompletedAt: repositoryNow.Add(2 * time.Minute),
	})
	if !errors.Is(err, imidentityport.ErrLeaseLost) {
		t.Fatalf("expired Complete() error = %v", err)
	}
	account, err := handle.Client().Account.Get(
		context.Background(),
		repositoryAccountID,
	)
	if err != nil {
		t.Fatal(err)
	}
	if account.ImState != "provisioning" || account.ImUserID != "" {
		t.Fatalf("expired owner changed account = %#v", account)
	}
}

func TestEntRepositoryRetryWaitIsNotClaimedBeforeDueTime(t *testing.T) {
	handle := openIdentityTestDatabase(t)
	seedIdentityWork(t, handle)
	repository, err := NewEntRepository(handle)
	if err != nil {
		t.Fatal(err)
	}
	_, ok, err := repository.Claim(context.Background(), imidentityport.Claim{
		LeaseOwner:     "worker-a",
		Now:            repositoryNow,
		LeaseExpiresAt: repositoryNow.Add(time.Minute),
	})
	if err != nil || !ok {
		t.Fatalf("Claim() = (%v, %v)", ok, err)
	}
	next := repositoryNow.Add(10 * time.Second)
	err = repository.Complete(context.Background(), imidentityport.Completion{
		OperationID:   repositoryOperationID,
		LeaseOwner:    "worker-a",
		Status:        imidentityport.CompletionRetry,
		ErrorCode:     "tencent_70169",
		NextAttemptAt: next,
		CompletedAt:   repositoryNow.Add(time.Second),
	})
	if err != nil {
		t.Fatalf("Complete(retry) error = %v", err)
	}
	if _, ok, err := repository.Claim(
		context.Background(),
		imidentityport.Claim{
			LeaseOwner:     "worker-b",
			Now:            next.Add(-time.Millisecond),
			LeaseExpiresAt: next.Add(time.Minute),
		},
	); err != nil || ok {
		t.Fatalf("early Claim() = (%v, %v)", ok, err)
	}
	work, ok, err := repository.Claim(context.Background(), imidentityport.Claim{
		LeaseOwner:     "worker-b",
		Now:            next,
		LeaseExpiresAt: next.Add(time.Minute),
	})
	if err != nil || !ok || work.Attempts != 2 {
		t.Fatalf("due Claim() = (%#v, %v, %v)", work, ok, err)
	}
}

func TestEntRepositoryTerminalFailureMarksAccountError(t *testing.T) {
	handle := openIdentityTestDatabase(t)
	seedIdentityWork(t, handle)
	repository, err := NewEntRepository(handle)
	if err != nil {
		t.Fatal(err)
	}
	_, ok, err := repository.Claim(context.Background(), imidentityport.Claim{
		LeaseOwner:     "worker-a",
		Now:            repositoryNow,
		LeaseExpiresAt: repositoryNow.Add(time.Minute),
	})
	if err != nil || !ok {
		t.Fatalf("Claim() = (%v, %v)", ok, err)
	}
	err = repository.Complete(context.Background(), imidentityport.Completion{
		OperationID: repositoryOperationID,
		LeaseOwner:  "worker-a",
		Status:      imidentityport.CompletionFailed,
		ErrorCode:   "tencent_70403",
		CompletedAt: repositoryNow.Add(time.Second),
	})
	if err != nil {
		t.Fatalf("Complete(failed) error = %v", err)
	}
	account, err := handle.Client().Account.Get(
		context.Background(),
		repositoryAccountID,
	)
	if err != nil {
		t.Fatal(err)
	}
	if account.ImState != "error" || account.Revision != 2 {
		t.Fatalf("account = %#v", account)
	}
	operation, err := handle.Client().TencentOperation.Get(
		context.Background(),
		repositoryOperationID,
	)
	if err != nil {
		t.Fatal(err)
	}
	if operation.State != "failed" ||
		operation.LastErrorCode == nil ||
		*operation.LastErrorCode != "tencent_70403" {
		t.Fatalf("operation = %#v", operation)
	}
	processed, err := handle.Client().OutboxEvent.Query().
		Where(
			outboxevent.AggregateIDEQ(repositoryOperationID),
			outboxevent.StateEQ("processed"),
		).
		Exist(context.Background())
	if err != nil || !processed {
		t.Fatalf("outbox processed = (%v, %v)", processed, err)
	}
}

func TestEntRepositorySupersededDoesNotChangeAccount(t *testing.T) {
	handle := openIdentityTestDatabase(t)
	seedIdentityWork(t, handle)
	repository, err := NewEntRepository(handle)
	if err != nil {
		t.Fatal(err)
	}
	_, ok, err := repository.Claim(context.Background(), imidentityport.Claim{
		LeaseOwner:     "worker-a",
		Now:            repositoryNow,
		LeaseExpiresAt: repositoryNow.Add(time.Minute),
	})
	if err != nil || !ok {
		t.Fatalf("Claim() = (%v, %v)", ok, err)
	}
	err = repository.Complete(context.Background(), imidentityport.Completion{
		OperationID: repositoryOperationID,
		LeaseOwner:  "worker-a",
		Status:      imidentityport.CompletionSuperseded,
		CompletedAt: repositoryNow.Add(time.Second),
	})
	if err != nil {
		t.Fatalf("Complete(superseded) error = %v", err)
	}
	account, err := handle.Client().Account.Get(
		context.Background(),
		repositoryAccountID,
	)
	if err != nil {
		t.Fatal(err)
	}
	if account.ImState != "provisioning" || account.Revision != 1 {
		t.Fatalf("account = %#v", account)
	}
	_, err = handle.Client().TencentOperation.Query().
		Where(
			tencentoperation.IDEQ(repositoryOperationID),
			tencentoperation.StateEQ("superseded"),
		).
		Only(context.Background())
	if err != nil {
		t.Fatalf("superseded operation: %v", err)
	}
}

func openIdentityTestDatabase(t *testing.T) *database.Handle {
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

func seedIdentityWork(t *testing.T, handle *database.Handle) {
	t.Helper()
	ctx := context.Background()
	if _, err := handle.Client().Account.Create().
		SetID(repositoryAccountID).
		SetEmail("alice@example.com").
		SetEmailNormalized("alice@example.com").
		SetDisplayName("爱丽丝").
		SetPasswordHash("not-used").
		SetTokenVersion(1).
		SetImUserID("").
		SetImState("provisioning").
		SetRevision(1).
		SetCreatedAt(repositoryNow).
		SetUpdatedAt(repositoryNow).
		Save(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Client().TencentOperation.Create().
		SetID(repositoryOperationID).
		SetPartitionKey(repositoryAccountID).
		SetService("im").
		SetKind("im.identity.ensure").
		SetResourceType("account").
		SetResourceID(repositoryAccountID).
		SetIdempotencyKey("account:identity:v1").
		SetDesiredRevision(1).
		SetState("pending").
		SetAttempts(0).
		SetCreatedAt(repositoryNow).
		SetUpdatedAt(repositoryNow).
		Save(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Client().OutboxEvent.Create().
		SetID(repositoryOutboxID).
		SetPartitionKey(repositoryAccountID).
		SetEventType("tencent.operation.ready").
		SetAggregateType("tencent_operation").
		SetAggregateID(repositoryOperationID).
		SetState("pending").
		SetAttempts(0).
		SetAvailableAt(repositoryNow).
		SetCreatedAt(repositoryNow).
		Save(ctx); err != nil {
		t.Fatal(err)
	}
}
