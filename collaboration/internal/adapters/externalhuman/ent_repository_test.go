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
