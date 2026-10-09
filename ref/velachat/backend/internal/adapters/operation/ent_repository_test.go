package operation

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"chatserver/internal/config"
	"chatserver/internal/database"
	"chatserver/internal/database/migration"
)

const (
	operationAccountID = "0198f4c2-7a30-7c91-a6d2-7d76f9188c37"
	operationServerID  = "0198f4c2-7a31-7c91-a6d2-7d76f9188c38"
	operationMemberID  = "0198f4c2-7a32-7d02-b8c1-3f6e15aa91b4"
	operationID        = "0198f4c2-7a37-7e45-913c-6baf30401a83"
)

func TestEntRepositoryGetsOperationForActiveMembership(t *testing.T) {
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
	now := time.Date(2026, 7, 31, 1, 5, 0, 0, time.UTC)
	if _, err := handle.Client().AccountServerMembership.Create().
		SetAccountID(operationAccountID).
		SetServerID(operationServerID).
		SetMemberID(operationMemberID).
		SetRole("owner").
		SetStatus("active").
		SetServerNameSnapshot("测试").
		SetServerSlugSnapshot("test").
		SetServerRevision(1).
		SetProjectedAt(now).
		SetUpdatedAt(now).
		Save(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Client().TencentOperation.Create().
		SetID(operationID).
		SetPartitionKey(operationServerID).
		SetServerID(operationServerID).
		SetService("platform").
		SetKind("agent.start").
		SetResourceType("agent").
		SetResourceID(
			"0198f4c2-7a36-7e45-913c-6baf30401a82",
		).
		SetIdempotencyKey("operation-test").
		SetDesiredRevision(1).
		SetState("pending").
		SetAttempts(0).
		SetCreatedAt(now).
		SetUpdatedAt(now).
		Save(context.Background()); err != nil {
		t.Fatal(err)
	}
	repository, err := NewEntRepository(handle)
	if err != nil {
		t.Fatal(err)
	}
	got, err := repository.Get(
		context.Background(),
		operationAccountID,
		operationServerID,
		operationID,
	)
	if err != nil || got.ID != operationID ||
		got.Kind != "agent.start" {
		t.Fatalf("Get() = (%#v, %v)", got, err)
	}
}
