package computerbootstrap

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	tencentoperationadapter "chatserver/internal/adapters/tencentoperation"
	"chatserver/internal/config"
	"chatserver/internal/database"
	"chatserver/internal/database/migration"
	bootstrapport "chatserver/internal/ports/computerbootstrap"
	tencentoperationport "chatserver/internal/ports/tencentoperation"
)

const (
	repositoryServerID     = "019b1f49-c5e8-7d78-8c08-d39d35722e95"
	repositoryComputerID   = "019b1f49-c5e8-7d78-8c08-d39d35722e96"
	repositoryCredentialID = "019b1f49-c5e8-7d78-8c08-d39d35722e97"
	repositoryOperationID  = "019b1f49-c5e8-7d78-8c08-d39d35722e98"
	repositoryReplayID     = "019b1f49-c5e8-7d78-8c08-d39d35722e99"
	repositoryLeaseID      = "019b1f49-c5e8-7d78-8c08-d39d35722e9a"
	repositoryReconcileID  = "019b1f49-c5e8-7d78-8c08-d39d35722e9b"
)

var repositoryNow = time.Date(2026, 8, 2, 11, 0, 0, 0, time.UTC)

func TestEntRepositoryCreatesLeasesAndCompletesOneBootstrapOperation(t *testing.T) {
	repository, handle := openBootstrapRepository(t)
	seedEligibleComputer(t, handle)
	command := bootstrapport.StartCommand{
		ServerID: repositoryServerID, ComputerID: repositoryComputerID,
		CredentialVersion: 1, OperationID: repositoryOperationID,
		IdempotencyKey: "computer-provider-enroll:" + repositoryComputerID + ":1",
		CreatedAt:      repositoryNow, DeadlineAt: repositoryNow.Add(time.Hour),
	}
	first, err := repository.GetOrCreate(context.Background(), command)
	if err != nil {
		t.Fatal(err)
	}
	command.OperationID = repositoryReplayID
	second, err := repository.GetOrCreate(context.Background(), command)
	if err != nil {
		t.Fatal(err)
	}
	if first.ID != repositoryOperationID || second.ID != first.ID || first.State != "pending" {
		t.Fatalf("first=%#v second=%#v", first, second)
	}
	generalWorker, err := tencentoperationadapter.NewEntRepository(handle)
	if err != nil {
		t.Fatal(err)
	}
	_, found, err := generalWorker.Claim(context.Background(), tencentoperationport.Claim{
		LeaseOwner: repositoryLeaseID, Now: repositoryNow,
		LeaseExpiresAt: repositoryNow.Add(time.Minute),
	})
	if err != nil || found {
		t.Fatalf("general TAT worker claimed bootstrap operation: found=%v err=%v", found, err)
	}
	claim := bootstrapport.ClaimCommand{
		LeaseOwner: repositoryLeaseID,
		Now:        repositoryNow, LeaseExpiresAt: repositoryNow.Add(time.Minute), MaxAttempts: 3,
	}
	claimed, acquired, err := repository.ClaimNext(context.Background(), claim)
	if err != nil || !acquired || claimed.ID != first.ID || claimed.Attempts != 1 {
		t.Fatalf("ClaimNext() = %#v, %v, %v", claimed, acquired, err)
	}
	claim.LeaseOwner = repositoryReplayID
	_, acquired, err = repository.ClaimNext(context.Background(), claim)
	if err != nil || acquired {
		t.Fatalf("second ClaimNext() = %v, %v", acquired, err)
	}
	expiresAt := repositoryNow.Add(55 * time.Minute)
	if err := repository.Complete(context.Background(), bootstrapport.CompleteCommand{
		OperationID: first.ID, LeaseOwner: repositoryLeaseID,
		EncryptedResult: "encrypted-registration", ResultExpiresAt: expiresAt,
		CompletedAt: repositoryNow.Add(time.Second),
	}); err != nil {
		t.Fatal(err)
	}
	completed, err := repository.GetOrCreate(context.Background(), command)
	if err != nil {
		t.Fatal(err)
	}
	if completed.State != "succeeded" || completed.EncryptedResult != "encrypted-registration" ||
		!completed.ResultExpiresAt.Equal(expiresAt) || completed.Attempts != 1 {
		t.Fatalf("completed = %#v", completed)
	}
	renewedAt := expiresAt.Add(time.Second)
	renewed, won, err := repository.RenewExpired(
		context.Background(),
		bootstrapport.RenewExpiredCommand{
			OperationID: first.ID, ServerID: repositoryServerID,
			ComputerID: repositoryComputerID, CredentialVersion: 1,
			ExpectedEncryptedResult: "encrypted-registration",
			RenewedAt:               renewedAt, DeadlineAt: renewedAt.Add(time.Hour),
		},
	)
	if err != nil || !won || renewed.ID != first.ID || renewed.State != "pending" ||
		renewed.Attempts != 0 || renewed.EncryptedResult != "" {
		t.Fatalf("RenewExpired() = %#v, %v, %v", renewed, won, err)
	}
	current, won, err := repository.RenewExpired(
		context.Background(),
		bootstrapport.RenewExpiredCommand{
			OperationID: first.ID, ServerID: repositoryServerID,
			ComputerID: repositoryComputerID, CredentialVersion: 1,
			ExpectedEncryptedResult: "encrypted-registration",
			RenewedAt:               renewedAt, DeadlineAt: renewedAt.Add(time.Hour),
		},
	)
	if err != nil || won || current.ID != first.ID || current.State != "pending" {
		t.Fatalf("RenewExpired() loser = %#v, %v, %v", current, won, err)
	}
}

func TestEntRepositoryRejectsComputerOutsideClaimedProvisioningFence(t *testing.T) {
	repository, handle := openBootstrapRepository(t)
	seedEligibleComputer(t, handle)
	if _, err := handle.Client().Computer.Update().
		SetLifecycleState("active").
		Save(context.Background()); err != nil {
		t.Fatal(err)
	}
	_, err := repository.GetOrCreate(context.Background(), bootstrapport.StartCommand{
		ServerID: repositoryServerID, ComputerID: repositoryComputerID,
		CredentialVersion: 1, OperationID: repositoryOperationID,
		IdempotencyKey: "computer-provider-enroll:" + repositoryComputerID + ":1",
		CreatedAt:      repositoryNow, DeadlineAt: repositoryNow.Add(time.Hour),
	})
	if !errors.Is(err, bootstrapport.ErrNotEligible) {
		t.Fatalf("GetOrCreate() error = %v", err)
	}
}

func TestEntRepositoryEnsuresOneTATReconcileOperationPerProviderMaterial(t *testing.T) {
	repository, handle := openBootstrapRepository(t)
	seedEligibleComputer(t, handle)
	command := bootstrapport.EnsureReconcileCommand{
		BootstrapOperationID: repositoryOperationID,
		ReconcileOperationID: repositoryReconcileID,
		ServerID:             repositoryServerID, ComputerID: repositoryComputerID,
		CredentialVersion:   1,
		MaterialFingerprint: [32]byte{0x71, 0x72},
		MaterialExpiresAt:   repositoryNow.Add(time.Hour + 987654*time.Nanosecond),
		CreatedAt:           repositoryNow.Add(time.Second),
	}
	if err := repository.EnsureReconcile(context.Background(), command); err != nil {
		t.Fatal(err)
	}
	command.ReconcileOperationID = repositoryReplayID
	if err := repository.EnsureReconcile(context.Background(), command); err != nil {
		t.Fatal(err)
	}

	computer, err := handle.Client().Computer.Get(context.Background(), repositoryComputerID)
	if err != nil {
		t.Fatal(err)
	}
	if computer.Revision != 3 || computer.RegistrationExpiresAt == nil ||
		!computer.RegistrationExpiresAt.Equal(command.MaterialExpiresAt) {
		t.Fatalf("computer = %#v", computer)
	}
	operations, err := handle.Client().TencentOperation.Query().All(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(operations) != 1 || operations[0].ID != repositoryReconcileID ||
		operations[0].Service != "tat" ||
		operations[0].Kind != "tat.computer.registration.reconcile" ||
		operations[0].DesiredRevision == nil || *operations[0].DesiredRevision != 3 ||
		operations[0].State != "pending" || operations[0].DeadlineAt == nil ||
		!operations[0].DeadlineAt.Equal(command.MaterialExpiresAt) {
		t.Fatalf("operations = %#v", operations)
	}
	worker, err := tencentoperationadapter.NewEntRepository(handle)
	if err != nil {
		t.Fatal(err)
	}
	work, found, err := worker.Claim(context.Background(), tencentoperationport.Claim{
		LeaseOwner: repositoryLeaseID, Now: command.CreatedAt,
		LeaseExpiresAt: command.CreatedAt.Add(time.Minute),
	})
	if err != nil || !found || work.OperationID != repositoryReconcileID ||
		work.DesiredRevision != 3 || work.ResourceRevision != 3 ||
		work.RegistrationExpiresAt == nil ||
		!work.RegistrationExpiresAt.Equal(command.MaterialExpiresAt) {
		t.Fatalf("Claim() = %#v, %v, %v", work, found, err)
	}
}

func TestEntRepositoryCreatesNewReconcileOperationForRenewedProviderMaterial(t *testing.T) {
	repository, handle := openBootstrapRepository(t)
	seedEligibleComputer(t, handle)
	first := bootstrapport.EnsureReconcileCommand{
		BootstrapOperationID: repositoryOperationID,
		ReconcileOperationID: repositoryReconcileID,
		ServerID:             repositoryServerID, ComputerID: repositoryComputerID,
		CredentialVersion: 1, MaterialFingerprint: [32]byte{0x11},
		MaterialExpiresAt: repositoryNow.Add(time.Hour), CreatedAt: repositoryNow,
	}
	if err := repository.EnsureReconcile(context.Background(), first); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Client().TencentOperation.UpdateOneID(repositoryReconcileID).
		SetState("failed").SetCompletedAt(first.MaterialExpiresAt).
		Save(context.Background()); err != nil {
		t.Fatal(err)
	}
	renewed := first
	renewed.ReconcileOperationID = repositoryReplayID
	renewed.MaterialFingerprint = [32]byte{0x22}
	renewed.MaterialExpiresAt = repositoryNow.Add(2 * time.Hour)
	renewed.CreatedAt = repositoryNow.Add(time.Hour + time.Second)
	if err := repository.EnsureReconcile(context.Background(), renewed); err != nil {
		t.Fatal(err)
	}
	computer, err := handle.Client().Computer.Get(context.Background(), repositoryComputerID)
	if err != nil || computer.Revision != 4 {
		t.Fatalf("computer = %#v, %v", computer, err)
	}
	operations, err := handle.Client().TencentOperation.Query().All(context.Background())
	if err != nil || len(operations) != 2 {
		t.Fatalf("operations = %#v, %v", operations, err)
	}
}

func TestEntRepositoryRejectsReconcileWhenComputerOrCredentialFenceIsInvalid(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*testing.T, *database.Handle)
	}{
		{name: "computer active", mutate: func(t *testing.T, handle *database.Handle) {
			_, err := handle.Client().Computer.Update().SetLifecycleState("active").Save(context.Background())
			if err != nil {
				t.Fatal(err)
			}
		}},
		{name: "computer bound", mutate: func(t *testing.T, handle *database.Handle) {
			_, err := handle.Client().Computer.Update().SetTatInstanceID("rins-existing").Save(context.Background())
			if err != nil {
				t.Fatal(err)
			}
		}},
		{name: "credential revoked", mutate: func(t *testing.T, handle *database.Handle) {
			_, err := handle.Client().ComputerRuntimeCredential.Update().SetState("revoked").SetRevokedAt(repositoryNow).Save(context.Background())
			if err != nil {
				t.Fatal(err)
			}
		}},
		{name: "credential expired", mutate: func(t *testing.T, handle *database.Handle) {
			_, err := handle.Client().ComputerRuntimeCredential.Update().SetExpiresAt(repositoryNow).Save(context.Background())
			if err != nil {
				t.Fatal(err)
			}
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			repository, handle := openBootstrapRepository(t)
			seedEligibleComputer(t, handle)
			test.mutate(t, handle)
			err := repository.EnsureReconcile(context.Background(), bootstrapport.EnsureReconcileCommand{
				BootstrapOperationID: repositoryOperationID,
				ReconcileOperationID: repositoryReconcileID,
				ServerID:             repositoryServerID, ComputerID: repositoryComputerID,
				CredentialVersion: 1, MaterialFingerprint: [32]byte{0x71},
				MaterialExpiresAt: repositoryNow.Add(time.Hour), CreatedAt: repositoryNow,
			})
			if !errors.Is(err, bootstrapport.ErrNotEligible) {
				t.Fatalf("EnsureReconcile() error = %v", err)
			}
			count, countErr := handle.Client().TencentOperation.Query().Count(context.Background())
			if countErr != nil || count != 0 {
				t.Fatalf("operation count = %d, %v", count, countErr)
			}
		})
	}
}

func TestEntRepositoryRenewExpiredKeepsSucceededResultWhenComputerOrCredentialFenceIsInvalid(
	t *testing.T,
) {
	tests := []struct {
		name   string
		mutate func(*testing.T, *database.Handle)
	}{
		{name: "computer active", mutate: func(t *testing.T, handle *database.Handle) {
			if _, err := handle.Client().Computer.Update().
				SetLifecycleState("active").Save(context.Background()); err != nil {
				t.Fatal(err)
			}
		}},
		{name: "computer already bound", mutate: func(t *testing.T, handle *database.Handle) {
			if _, err := handle.Client().Computer.Update().
				SetTatInstanceID("rins-existing").Save(context.Background()); err != nil {
				t.Fatal(err)
			}
		}},
		{name: "credential revoked", mutate: func(t *testing.T, handle *database.Handle) {
			if _, err := handle.Client().ComputerRuntimeCredential.Update().
				SetState("revoked").SetRevokedAt(repositoryNow.Add(time.Minute)).
				Save(context.Background()); err != nil {
				t.Fatal(err)
			}
		}},
		{name: "credential expired", mutate: func(t *testing.T, handle *database.Handle) {
			if _, err := handle.Client().ComputerRuntimeCredential.Update().
				SetExpiresAt(repositoryNow).Save(context.Background()); err != nil {
				t.Fatal(err)
			}
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			repository, handle := openBootstrapRepository(t)
			seedEligibleComputer(t, handle)
			operation := completeBootstrapOperation(t, repository)
			test.mutate(t, handle)
			_, _, err := repository.RenewExpired(
				context.Background(),
				bootstrapport.RenewExpiredCommand{
					OperationID: operation.ID, ServerID: repositoryServerID,
					ComputerID: repositoryComputerID, CredentialVersion: 1,
					ExpectedEncryptedResult: "encrypted-registration",
					RenewedAt:               repositoryNow.Add(2 * time.Minute),
					DeadlineAt:              repositoryNow.Add(62 * time.Minute),
				},
			)
			if !errors.Is(err, bootstrapport.ErrNotEligible) {
				t.Fatalf("RenewExpired() error = %v", err)
			}
			stored, queryErr := handle.Client().TencentOperation.Get(context.Background(), operation.ID)
			if queryErr != nil || stored.State != "succeeded" || stored.ResultJSON == nil {
				t.Fatalf("stored operation = %#v, %v", stored, queryErr)
			}
		})
	}
}

func completeBootstrapOperation(
	t *testing.T,
	repository *EntRepository,
) bootstrapport.Operation {
	t.Helper()
	operation, err := repository.GetOrCreate(context.Background(), bootstrapport.StartCommand{
		ServerID: repositoryServerID, ComputerID: repositoryComputerID,
		CredentialVersion: 1, OperationID: repositoryOperationID,
		IdempotencyKey: "computer-provider-enroll:" + repositoryComputerID + ":1",
		CreatedAt:      repositoryNow, DeadlineAt: repositoryNow.Add(time.Hour),
	})
	if err != nil {
		t.Fatal(err)
	}
	claimed, found, err := repository.ClaimNext(context.Background(), bootstrapport.ClaimCommand{
		LeaseOwner: repositoryLeaseID, Now: repositoryNow,
		LeaseExpiresAt: repositoryNow.Add(time.Minute), MaxAttempts: 3,
	})
	if err != nil || !found {
		t.Fatalf("ClaimNext() = %#v, %v, %v", claimed, found, err)
	}
	if err := repository.Complete(context.Background(), bootstrapport.CompleteCommand{
		OperationID: operation.ID, LeaseOwner: repositoryLeaseID,
		EncryptedResult: "encrypted-registration",
		ResultExpiresAt: repositoryNow.Add(time.Hour),
		CompletedAt:     repositoryNow.Add(time.Second),
	}); err != nil {
		t.Fatal(err)
	}
	return operation
}

func TestEntRepositoryRejectsRetryAfterLeaseExpiry(t *testing.T) {
	repository, handle := openBootstrapRepository(t)
	seedEligibleComputer(t, handle)
	operation, err := repository.GetOrCreate(context.Background(), bootstrapport.StartCommand{
		ServerID: repositoryServerID, ComputerID: repositoryComputerID,
		CredentialVersion: 1, OperationID: repositoryOperationID,
		IdempotencyKey: "computer-provider-enroll:" + repositoryComputerID + ":1",
		CreatedAt:      repositoryNow, DeadlineAt: repositoryNow.Add(time.Hour),
	})
	if err != nil {
		t.Fatal(err)
	}
	leaseExpiry := repositoryNow.Add(time.Minute)
	_, acquired, err := repository.ClaimNext(context.Background(), bootstrapport.ClaimCommand{
		LeaseOwner: repositoryLeaseID, Now: repositoryNow,
		LeaseExpiresAt: leaseExpiry, MaxAttempts: 3,
	})
	if err != nil || !acquired {
		t.Fatalf("ClaimNext() acquired=%v err=%v", acquired, err)
	}
	err = repository.Retry(context.Background(), bootstrapport.RetryCommand{
		OperationID: operation.ID, LeaseOwner: repositoryLeaseID,
		ErrorCode: "provider_unavailable", FailedAt: leaseExpiry,
		NextAttemptAt: leaseExpiry.Add(time.Minute),
	})
	if !errors.Is(err, bootstrapport.ErrLeaseLost) {
		t.Fatalf("Retry() error = %v, want ErrLeaseLost", err)
	}
}

func openBootstrapRepository(t *testing.T) (*EntRepository, *database.Handle) {
	t.Helper()
	directory := filepath.Join(t.TempDir(), "data")
	if err := os.MkdirAll(directory, 0o700); err != nil {
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
	repository, err := NewEntRepository(handle)
	if err != nil {
		t.Fatal(err)
	}
	return repository, handle
}

func seedEligibleComputer(t *testing.T, handle *database.Handle) {
	t.Helper()
	if _, err := handle.Client().Computer.Create().
		SetID(repositoryComputerID).SetServerID(repositoryServerID).SetName("Bootstrap Computer").
		SetTatRegion("ap-beijing").SetTatInstanceKind("managed").SetOsType("macos").
		SetLifecycleState("provisioning").SetTatAgentState("unknown").SetRevision(2).
		SetEnrollmentGeneration(1).SetEnrollmentClaimedAt(repositoryNow).
		SetEnrollmentCredentialVersion(1).SetCreatedAt(repositoryNow).SetUpdatedAt(repositoryNow).
		Save(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Client().ComputerRuntimeCredential.Create().
		SetID(repositoryCredentialID).SetServerID(repositoryServerID).SetComputerID(repositoryComputerID).
		SetVersion(1).SetSecretHash(make([]byte, 32)).SetState("active").
		SetExpiresAt(repositoryNow.Add(24 * time.Hour)).SetCreatedAt(repositoryNow).
		Save(context.Background()); err != nil {
		t.Fatal(err)
	}
}
