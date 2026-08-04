package computerauth

import (
	"context"
	"crypto/sha256"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"chatserver/internal/config"
	"chatserver/internal/database"
	"chatserver/internal/database/migration"
	computerentity "chatserver/internal/ent/computer"
	computerauthport "chatserver/internal/ports/computerauth"
)

const (
	computerAuthServerID     = "01989c24-7540-7f12-a27b-c83243215dd3"
	computerAuthComputerID   = "01989c24-7540-7f12-a27b-c83243215dd5"
	computerAuthCredentialID = "01989c24-7540-7f12-a27b-c83243215dd6"
)

var computerAuthNow = time.Date(2026, 8, 1, 16, 0, 0, 0, time.UTC)

type fixedClock struct{ now time.Time }

func (clock fixedClock) Now() time.Time { return clock.now }

func TestEntRepositoryFindsOnlyCurrentComputerCredential(t *testing.T) {
	repository, handle := openComputerAuthRepository(t)
	seedComputer(t, handle, "active")
	digest := sha256.Sum256([]byte("computer-secret"))
	seedComputerCredential(t, handle, "active", nil, digest)
	route := computerauthport.Route{
		ServerID:   computerAuthServerID,
		ComputerID: computerAuthComputerID,
		Version:    1,
	}
	got, err := repository.FindCurrent(context.Background(), route)
	if err != nil {
		t.Fatal(err)
	}
	if got.Route != route || got.SecretDigest != digest {
		t.Fatalf("FindCurrent() = %#v", got)
	}
	current, err := repository.ConfirmCurrent(context.Background(), route)
	if err != nil || !current {
		t.Fatalf("ConfirmCurrent() = %v, %v", current, err)
	}
}

func TestEntRepositoryRejectsExpiredRevokedAndRemovedComputerCredentials(t *testing.T) {
	tests := []struct {
		name            string
		computerState   string
		credentialState string
		expiresAt       time.Time
		graceExpiresAt  *time.Time
	}{
		{name: "removed computer", computerState: "removed", credentialState: "active", expiresAt: computerAuthNow.Add(time.Hour)},
		{name: "expired active", computerState: "active", credentialState: "active", expiresAt: computerAuthNow},
		{name: "revoked", computerState: "active", credentialState: "revoked", expiresAt: computerAuthNow.Add(time.Hour)},
		{name: "expired grace", computerState: "active", credentialState: "grace", expiresAt: computerAuthNow.Add(time.Hour), graceExpiresAt: timePointer(computerAuthNow)},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			repository, handle := openComputerAuthRepository(t)
			seedComputer(t, handle, test.computerState)
			digest := sha256.Sum256([]byte("computer-secret"))
			seedComputerCredentialAt(t, handle, test.credentialState, test.expiresAt, test.graceExpiresAt, digest)
			_, err := repository.FindCurrent(context.Background(), computerauthport.Route{
				ServerID:   computerAuthServerID,
				ComputerID: computerAuthComputerID,
				Version:    1,
			})
			if !errors.Is(err, computerauthport.ErrCredentialNotCurrent) {
				t.Fatalf("FindCurrent() error = %v", err)
			}
		})
	}
}

func TestBootstrapEntRepositoryAcceptsOnlyExactClaimedProvisioningCredential(t *testing.T) {
	_, handle := openComputerAuthRepository(t)
	if _, err := handle.Client().Computer.Create().
		SetID(computerAuthComputerID).
		SetServerID(computerAuthServerID).
		SetName("Computer").
		SetTatRegion("ap-beijing").
		SetTatInstanceKind("managed").
		SetOsType("macos").
		SetLifecycleState("provisioning").
		SetTatAgentState("unknown").
		SetRevision(2).
		SetEnrollmentGeneration(1).
		SetEnrollmentClaimedAt(computerAuthNow).
		SetEnrollmentCredentialVersion(1).
		SetCreatedAt(computerAuthNow).
		SetUpdatedAt(computerAuthNow).
		Save(context.Background()); err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256([]byte("computer-secret"))
	seedComputerCredential(t, handle, "active", nil, digest)
	repository, err := NewBootstrapEntRepository(handle, fixedClock{now: computerAuthNow})
	if err != nil {
		t.Fatal(err)
	}
	route := computerauthport.Route{
		ServerID: computerAuthServerID, ComputerID: computerAuthComputerID, Version: 1,
	}
	credential, err := repository.FindCurrent(context.Background(), route)
	if err != nil || credential.Route != route || credential.SecretDigest != digest {
		t.Fatalf("FindCurrent() = %#v, %v", credential, err)
	}

	if _, err := handle.Client().Computer.Update().
		Where(computerentity.IDEQ(computerAuthComputerID)).
		SetLifecycleState("active").
		Save(context.Background()); err != nil {
		t.Fatal(err)
	}
	_, err = repository.FindCurrent(context.Background(), route)
	if !errors.Is(err, computerauthport.ErrCredentialNotCurrent) {
		t.Fatalf("active Computer bootstrap auth error = %v", err)
	}
}

func openComputerAuthRepository(t *testing.T) (*EntRepository, *database.Handle) {
	t.Helper()
	directory := filepath.Join(t.TempDir(), "data")
	if err := os.MkdirAll(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	cfg, err := config.NewDatabase(filepath.Join(directory, "chatserver.db"))
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
	repository, err := NewEntRepository(handle, fixedClock{now: computerAuthNow})
	if err != nil {
		t.Fatal(err)
	}
	return repository, handle
}

func seedComputer(t *testing.T, handle *database.Handle, state string) {
	t.Helper()
	_, err := handle.Client().Computer.Create().
		SetID(computerAuthComputerID).
		SetServerID(computerAuthServerID).
		SetName("Computer").
		SetTatRegion("ap-guangzhou").
		SetTatInstanceKind("managed").
		SetOsType("macos").
		SetLifecycleState(state).
		SetTatAgentState("online").
		SetRevision(1).
		SetCreatedAt(computerAuthNow).
		SetUpdatedAt(computerAuthNow).
		Save(context.Background())
	if err != nil {
		t.Fatal(err)
	}
}

func seedComputerCredential(t *testing.T, handle *database.Handle, state string, grace *time.Time, digest [32]byte) {
	t.Helper()
	seedComputerCredentialAt(t, handle, state, computerAuthNow.Add(time.Hour), grace, digest)
}

func seedComputerCredentialAt(t *testing.T, handle *database.Handle, state string, expiresAt time.Time, grace *time.Time, digest [32]byte) {
	t.Helper()
	create := handle.Client().ComputerRuntimeCredential.Create().
		SetID(computerAuthCredentialID).
		SetServerID(computerAuthServerID).
		SetComputerID(computerAuthComputerID).
		SetVersion(1).
		SetSecretHash(digest[:]).
		SetState(state).
		SetExpiresAt(expiresAt).
		SetCreatedAt(computerAuthNow)
	if grace != nil {
		create.SetGraceExpiresAt(*grace)
	}
	if _, err := create.Save(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func timePointer(value time.Time) *time.Time { return &value }
