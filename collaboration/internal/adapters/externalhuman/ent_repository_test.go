package externalhuman

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"git.woa.com/wisp/mono2/collaboration/internal/app/externalhuman"
	"git.woa.com/wisp/mono2/collaboration/internal/config"
	"git.woa.com/wisp/mono2/collaboration/internal/database"
	"git.woa.com/wisp/mono2/collaboration/internal/database/migration"
	"git.woa.com/wisp/mono2/collaboration/internal/ent/tencentoperation"
)

const (
	externalHumanEpochA = "credential_epoch_a"
	externalHumanEpochB = "credential_epoch_b"
)

func TestEntRepositoryJITCreatesOneCredentialFreeCollaborationActor(t *testing.T) {
	handle := openExternalHumanRepository(t)
	repository, err := NewEntRepository(handle)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 9, 14, 12, 0, 0, 0, time.UTC)
	input := externalhuman.EnsureInput{
		Kind:              externalhuman.LightVelaIdentityKind,
		Subject:           "usr_0123456789abcdef01234567",
		SubjectHash:       "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
		ProposedAccountID: "01989c24-7540-7f12-a27b-c83243215dd1",
		ProvisioningEpoch: externalHumanEpochA,
		OccurredAt:        now,
	}

	first, err := repository.ResolveOrCreate(context.Background(), input)
	if err != nil {
		t.Fatal(err)
	}
	input.ProposedAccountID = "01989c24-7540-7f12-a27b-c83243215dd2"
	second, err := repository.ResolveOrCreate(context.Background(), input)
	if err != nil {
		t.Fatal(err)
	}
	if first != "01989c24-7540-7f12-a27b-c83243215dd1" || second != first {
		t.Fatalf("resolved IDs = %q, %q", first, second)
	}

	ctx := context.Background()
	accountEntity, err := handle.Client().Account.Query().Only(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if accountEntity.Email != "" || accountEntity.PasswordHash != "" ||
		accountEntity.TokenVersion != 0 || accountEntity.ImState != "provisioning" {
		t.Fatalf("account = %#v", accountEntity)
	}
	if count, err := handle.Client().AuthSession.Query().Count(ctx); err != nil || count != 0 {
		t.Fatalf("auth session count = %d, %v", count, err)
	}
	if count, err := handle.Client().TencentOperation.Query().Count(ctx); err != nil || count != 1 {
		t.Fatalf("operation count = %d, %v", count, err)
	}
	if count, err := handle.Client().OutboxEvent.Query().Count(ctx); err != nil || count != 1 {
		t.Fatalf("outbox count = %d, %v", count, err)
	}
}

func TestEntRepositoryRetriesFailedIdentityOncePerCredentialEpoch(t *testing.T) {
	handle := openExternalHumanRepository(t)
	repository, err := NewEntRepository(handle)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 9, 14, 12, 0, 0, 0, time.UTC)
	input := externalhuman.EnsureInput{
		Kind:              externalhuman.LightVelaIdentityKind,
		Subject:           "usr_0123456789abcdef01234567",
		SubjectHash:       "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
		ProposedAccountID: "01989c24-7540-7f12-a27b-c83243215dd1",
		ProvisioningEpoch: externalHumanEpochA,
		OccurredAt:        now,
	}
	accountID, err := repository.ResolveOrCreate(context.Background(), input)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	accountEntity, err := handle.Client().Account.Get(ctx, accountID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Client().Account.UpdateOne(accountEntity).
		SetImState("error").
		AddRevision(1).
		SetUpdatedAt(now.Add(time.Minute)).
		Save(ctx); err != nil {
		t.Fatal(err)
	}
	operation, err := handle.Client().TencentOperation.Query().Only(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Client().TencentOperation.UpdateOne(operation).
		SetState("failed").
		SetAttempts(8).
		SetLastErrorCode("tencent_70009").
		SetCompletedAt(now.Add(time.Minute)).
		SetUpdatedAt(now.Add(time.Minute)).
		Save(ctx); err != nil {
		t.Fatal(err)
	}

	input.OccurredAt = now.Add(2 * time.Minute)
	if _, err := repository.ResolveOrCreate(ctx, input); err != nil {
		t.Fatal(err)
	}
	if count, err := handle.Client().TencentOperation.Query().Count(ctx); err != nil || count != 1 {
		t.Fatalf("same-epoch operation count = %d, %v", count, err)
	}
	accountEntity, err = handle.Client().Account.Get(ctx, accountID)
	if err != nil || accountEntity.ImState != "error" || accountEntity.Revision != 2 {
		t.Fatalf("same-epoch account = %#v, %v", accountEntity, err)
	}

	input.ProvisioningEpoch = externalHumanEpochB
	input.OccurredAt = now.Add(3 * time.Minute)
	if _, err := repository.ResolveOrCreate(ctx, input); err != nil {
		t.Fatal(err)
	}
	accountEntity, err = handle.Client().Account.Get(ctx, accountID)
	if err != nil || accountEntity.ImState != "provisioning" || accountEntity.Revision != 3 {
		t.Fatalf("new-epoch account = %#v, %v", accountEntity, err)
	}
	retry, err := handle.Client().TencentOperation.Query().Where(
		tencentoperation.StateEQ("pending"),
		tencentoperation.DesiredRevisionEQ(3),
	).Only(ctx)
	if err != nil {
		t.Fatal(err)
	}
	wantKey := "account:" + accountID + ":im.identity.ensure:" + externalHumanEpochB
	if retry.IdempotencyKey != wantKey || retry.Attempts != 0 {
		t.Fatalf("retry operation = %#v", retry)
	}
	if count, err := handle.Client().TencentOperation.Query().Count(ctx); err != nil || count != 2 {
		t.Fatalf("new-epoch operation count = %d, %v", count, err)
	}
	if count, err := handle.Client().OutboxEvent.Query().Count(ctx); err != nil || count != 2 {
		t.Fatalf("new-epoch outbox count = %d, %v", count, err)
	}
}

func openExternalHumanRepository(t *testing.T) *database.Handle {
	t.Helper()
	path := filepath.Join(t.TempDir(), "data", "collaboration.db")
	cfg, err := config.NewDatabase(path)
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
