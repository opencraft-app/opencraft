package accountauth

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
	"chatserver/internal/ent/account"
	"chatserver/internal/ent/authsession"
	accountauthport "chatserver/internal/ports/accountauth"
)

const (
	repoAccountID = "01989c24-7540-7f12-a27b-c83243215dd1"
	repoSessionID = "01989c24-7540-7f12-a27b-c83243215dd2"
	repoFamilyID  = "01989c24-7540-7f12-a27b-c83243215dd3"
	repoNextID    = "01989c24-7540-7f12-a27b-c83243215dd4"
)

var repoNow = time.Date(2026, 7, 30, 12, 0, 0, 0, time.UTC)

func TestEntRepositoryRegisterIsAtomicAndMapsLoginConflict(t *testing.T) {
	repository, handle := openRepository(t)
	registration := testRegistration()
	if err := repository.Register(context.Background(), registration); err != nil {
		t.Fatalf("Register() error = %v", err)
	}
	assertTableCounts(t, handle, 1, 1, 1)
	outbox, err := handle.Client().OutboxEvent.Query().Only(context.Background())
	if err != nil {
		t.Fatalf("registration outbox error = %v", err)
	}
	operation, err := handle.Client().TencentOperation.Query().Only(context.Background())
	if err != nil {
		t.Fatalf("registration tencent operation error = %v", err)
	}
	if operation.PartitionKey != repoAccountID ||
		operation.Service != "im" ||
		operation.Kind != "im.identity.ensure" ||
		operation.ResourceType != "account" ||
		operation.ResourceID != repoAccountID ||
		operation.State != "pending" {
		t.Fatalf("registration tencent operation = %#v", operation)
	}
	if outbox.PartitionKey != repoAccountID ||
		outbox.EventType != "tencent.operation.ready" ||
		outbox.AggregateType != "tencent_operation" ||
		outbox.AggregateID != operation.ID ||
		outbox.State != "pending" ||
		!outbox.AvailableAt.Equal(repoNow) {
		t.Fatalf("registration outbox = %#v", outbox)
	}

	conflict := registration
	conflict.Account.ID = "01989c24-7540-7f12-a27b-c83243215dd9"
	conflict.Session.ID = "01989c24-7540-7f12-a27b-c83243215dda"
	conflict.Session.FamilyID = "01989c24-7540-7f12-a27b-c83243215ddb"
	err = repository.Register(context.Background(), conflict)
	if !errors.Is(err, accountauthport.ErrLoginConflict) {
		t.Fatalf("Register(conflict) error = %v", err)
	}
	assertTableCounts(t, handle, 1, 1, 1)
}

func TestEntRepositoryFindCredentialRechecksNormalizedLogin(t *testing.T) {
	repository, _ := openRepository(t)
	if err := repository.Register(context.Background(), testRegistration()); err != nil {
		t.Fatal(err)
	}

	got, err := repository.FindCredentialByLogin(
		context.Background(),
		testRegistration().Login,
	)
	if err != nil {
		t.Fatalf("FindCredentialByLogin() error = %v", err)
	}
	if got.ID != repoAccountID ||
		got.PasswordHash != "stored-password-hash" ||
		got.TokenVersion != 1 {
		t.Fatalf("credential = %#v", got)
	}

	collision := testRegistration().Login
	collision.Normalized = "mallory@example.com"
	if _, err := repository.FindCredentialByLogin(
		context.Background(),
		collision,
	); !errors.Is(err, accountauthport.ErrLoginNotFound) {
		t.Fatalf("FindCredentialByLogin(collision) error = %v", err)
	}
}

func TestEntRepositoryCreatesIndependentLoginSession(t *testing.T) {
	repository, handle := openRepository(t)
	if err := repository.Register(context.Background(), testRegistration()); err != nil {
		t.Fatal(err)
	}
	nextDigest := sha256.Sum256([]byte("independent-refresh"))
	err := repository.CreateSession(
		context.Background(),
		repoAccountID,
		accountauthport.SessionDraft{
			ID:          repoNextID,
			FamilyID:    repoNextID,
			TokenDigest: nextDigest,
			ExpiresAt:   repoNow.Add(30 * 24 * time.Hour),
		},
	)
	if err != nil {
		t.Fatalf("CreateSession() error = %v", err)
	}
	if got, err := handle.Client().AuthSession.Query().Count(context.Background()); err != nil ||
		got != 2 {
		t.Fatalf("AuthSession count = %d, %v", got, err)
	}
}

func TestEntRepositoryRotatesOnceAndRevokesFamilyOnReplay(t *testing.T) {
	repository, handle := openRepository(t)
	registration := testRegistration()
	if err := repository.Register(context.Background(), registration); err != nil {
		t.Fatal(err)
	}
	nextDigest := sha256.Sum256([]byte("next-refresh"))
	rotation := accountauthport.Rotation{
		AccountID:       repoAccountID,
		SessionID:       repoSessionID,
		PresentedDigest: registration.Session.TokenDigest,
		Next: accountauthport.SessionDraft{
			ID:          repoNextID,
			TokenDigest: nextDigest,
			ExpiresAt:   repoNow.Add(30 * 24 * time.Hour),
		},
		RotatedAt: repoNow.Add(time.Minute),
	}

	result, err := repository.RotateSession(context.Background(), rotation)
	if err != nil {
		t.Fatalf("RotateSession() error = %v", err)
	}
	if result.Status != accountauthport.RotationSucceeded ||
		result.Account.ID != repoAccountID {
		t.Fatalf("RotateSession() result = %#v", result)
	}
	old, err := handle.Client().AuthSession.Query().
		Where(authsession.IDEQ(repoSessionID)).
		Only(context.Background())
	if err != nil || old.UsedAt == nil {
		t.Fatalf("old session usedAt = %#v, %v", old, err)
	}
	next, err := handle.Client().AuthSession.Query().
		Where(authsession.IDEQ(repoNextID)).
		Only(context.Background())
	if err != nil || next.FamilyID != repoFamilyID {
		t.Fatalf("next session = %#v, %v", next, err)
	}

	replayed, err := repository.RotateSession(context.Background(), rotation)
	if err != nil {
		t.Fatalf("RotateSession(replay) error = %v", err)
	}
	if replayed.Status != accountauthport.RotationReplayed {
		t.Fatalf("RotateSession(replay) status = %q", replayed.Status)
	}
	activeInFamily, err := handle.Client().AuthSession.Query().
		Where(
			authsession.AccountIDEQ(repoAccountID),
			authsession.FamilyIDEQ(repoFamilyID),
			authsession.RevokedAtIsNil(),
		).
		Count(context.Background())
	if err != nil || activeInFamily != 0 {
		t.Fatalf("active family sessions = %d, %v", activeInFamily, err)
	}
}

func TestEntRepositoryRejectsWrongDigestWithoutConsumingSession(t *testing.T) {
	repository, handle := openRepository(t)
	registration := testRegistration()
	if err := repository.Register(context.Background(), registration); err != nil {
		t.Fatal(err)
	}
	wrong := registration.Session.TokenDigest
	wrong[0] ^= 0xff
	result, err := repository.RotateSession(context.Background(), accountauthport.Rotation{
		AccountID:       repoAccountID,
		SessionID:       repoSessionID,
		PresentedDigest: wrong,
		Next: accountauthport.SessionDraft{
			ID:          repoNextID,
			TokenDigest: sha256.Sum256([]byte("next")),
			ExpiresAt:   repoNow.Add(time.Hour),
		},
		RotatedAt: repoNow,
	})
	if err != nil || result.Status != accountauthport.RotationInvalid {
		t.Fatalf("RotateSession(wrong digest) = %#v, %v", result, err)
	}
	old, err := handle.Client().AuthSession.Query().
		Where(authsession.IDEQ(repoSessionID)).
		Only(context.Background())
	if err != nil || old.UsedAt != nil {
		t.Fatalf("old session consumed = %#v, %v", old, err)
	}
}

func TestEntRepositoryRevokeSessionIsIdempotentAndCurrentnessAware(t *testing.T) {
	repository, _ := openRepository(t)
	if err := repository.Register(context.Background(), testRegistration()); err != nil {
		t.Fatal(err)
	}
	current, err := repository.FindCurrentSession(
		context.Background(),
		repoAccountID,
		repoSessionID,
		repoNow,
	)
	if err != nil || current.Status != accountauthport.SessionCurrent {
		t.Fatalf("FindCurrentSession(active) = %#v, %v", current, err)
	}
	for range 2 {
		if err := repository.RevokeSession(
			context.Background(),
			repoAccountID,
			repoSessionID,
			repoNow.Add(time.Minute),
		); err != nil {
			t.Fatalf("RevokeSession() error = %v", err)
		}
	}
	current, err = repository.FindCurrentSession(
		context.Background(),
		repoAccountID,
		repoSessionID,
		repoNow.Add(2*time.Minute),
	)
	if err != nil || current.Status != accountauthport.SessionRevoked {
		t.Fatalf("FindCurrentSession(revoked) = %#v, %v", current, err)
	}
}

func openRepository(t *testing.T) (*EntRepository, *database.Handle) {
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

func testRegistration() accountauthport.Registration {
	loginHash := sha256.Sum256([]byte("email\x00alice@example.com"))
	refreshHash := sha256.Sum256([]byte("initial-refresh"))
	return accountauthport.Registration{
		OccurredAt: repoNow,
		Login: accountauthport.LoginIdentity{
			Kind:       "email",
			Hash:       stringHex(loginHash),
			Normalized: "alice@example.com",
		},
		Account: accountauthport.AccountDraft{
			Account: accountauthport.Account{
				ID:           repoAccountID,
				Email:        "alice@example.com",
				DisplayName:  "Alice",
				IMState:      "provisioning",
				TokenVersion: 1,
				Revision:     1,
			},
			EmailNormalized: "alice@example.com",
			PasswordHash:    "stored-password-hash",
		},
		Session: accountauthport.SessionDraft{
			ID:          repoSessionID,
			FamilyID:    repoFamilyID,
			TokenDigest: refreshHash,
			ExpiresAt:   repoNow.Add(30 * 24 * time.Hour),
		},
	}
}

func stringHex(value [32]byte) string {
	const digits = "0123456789abcdef"
	result := make([]byte, len(value)*2)
	for index, item := range value {
		result[index*2] = digits[item>>4]
		result[index*2+1] = digits[item&0x0f]
	}
	return string(result)
}

func assertTableCounts(
	t *testing.T,
	handle *database.Handle,
	accounts int,
	identities int,
	sessions int,
) {
	t.Helper()
	ctx := context.Background()
	gotAccounts, err := handle.Client().Account.Query().
		Where(account.IDNEQ("")).
		Count(ctx)
	if err != nil {
		t.Fatal(err)
	}
	gotIdentities, err := handle.Client().AccountLoginIdentity.Query().Count(ctx)
	if err != nil {
		t.Fatal(err)
	}
	gotSessions, err := handle.Client().AuthSession.Query().Count(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if gotAccounts != accounts ||
		gotIdentities != identities ||
		gotSessions != sessions {
		t.Fatalf(
			"counts = accounts:%d identities:%d sessions:%d",
			gotAccounts,
			gotIdentities,
			gotSessions,
		)
	}
}
