package humanaccount

import (
	"context"
	"errors"
	"testing"

	"chatserver/internal/config"
	"chatserver/internal/database"
	"chatserver/internal/database/migration"
	humanaccountport "chatserver/internal/ports/humanaccount"
)

const testHumanAccountID = "01989c24-7540-7f12-a27b-c83243215dd1"

func TestEntRepositoryFindsAccountAndMapsUnsignedFields(t *testing.T) {
	handle := openHumanAccountDatabase(t)
	_, err := handle.Client().Account.Create().
		SetID(testHumanAccountID).
		SetEmail("alice@example.com").
		SetEmailNormalized("alice@example.com").
		SetDisplayName("爱丽丝").
		SetPasswordHash("not-used").
		SetTokenVersion(2).
		SetImUserID("u_OPAQUE").
		SetImState("ready").
		SetRevision(3).
		Save(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	repository, err := NewEntRepository(handle)
	if err != nil {
		t.Fatal(err)
	}

	account, err := repository.FindByID(
		context.Background(),
		testHumanAccountID,
	)
	if err != nil {
		t.Fatalf("FindByID() error = %v", err)
	}
	if account.ID != testHumanAccountID ||
		account.Email != "alice@example.com" ||
		account.DisplayName != "爱丽丝" ||
		account.IMUserID != "u_OPAQUE" ||
		account.IMState != "ready" ||
		account.TokenVersion != 2 ||
		account.Revision != 3 {
		t.Fatalf("account = %#v", account)
	}
}

func TestEntRepositoryMapsMissingAccountToStableSentinel(t *testing.T) {
	handle := openHumanAccountDatabase(t)
	repository, err := NewEntRepository(handle)
	if err != nil {
		t.Fatal(err)
	}

	_, err = repository.FindByID(
		context.Background(),
		testHumanAccountID,
	)
	if !errors.Is(err, humanaccountport.ErrNotFound) {
		t.Fatalf("FindByID() error = %v", err)
	}
}

func openHumanAccountDatabase(t *testing.T) *database.Handle {
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
