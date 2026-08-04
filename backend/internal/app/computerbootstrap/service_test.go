package computerbootstrap

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"chatserver/internal/apperror"
	computerauthport "chatserver/internal/ports/computerauth"
	bootstrapport "chatserver/internal/ports/computerbootstrap"
	tencenttatport "chatserver/internal/ports/tencenttat"
)

const (
	bootstrapServerID    = "019b1f49-c5e8-7d78-8c08-d39d35722e95"
	bootstrapComputerID  = "019b1f49-c5e8-7d78-8c08-d39d35722e96"
	bootstrapOperationID = "019b1f49-c5e8-7d78-8c08-d39d35722e97"
	bootstrapLeaseID     = "019b1f49-c5e8-7d78-8c08-d39d35722e98"
	bootstrapReplayID    = "019b1f49-c5e8-7d78-8c08-d39d35722e99"
	bootstrapReconcileID = "019b1f49-c5e8-7d78-8c08-d39d35722e9a"
)

var bootstrapNow = time.Date(2026, 8, 2, 10, 0, 0, 0, time.UTC)

func TestServiceQueuesThenWorkerCreatesEncryptedRecoverableProviderRegistration(t *testing.T) {
	repository := &fakeRepository{operation: bootstrapport.Operation{
		ID: bootstrapOperationID, ServerID: bootstrapServerID,
		ComputerID: bootstrapComputerID, CredentialVersion: 1, State: "pending",
	}}
	registrar := &fakeRegistrar{result: tencenttatport.Registration{
		CodeID: "registration-code-id", CodeValue: "registration-secret-value",
		ExpiresAt: bootstrapNow.Add(time.Hour),
	}}
	service := newTestService(t, repository, registrar)
	result, err := service.GetOrCreate(context.Background(), computerauthport.Route{
		ServerID: bootstrapServerID, ComputerID: bootstrapComputerID, Version: 1,
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Ready || result.OperationID != bootstrapOperationID ||
		result.State != "pending" || registrar.calls != 0 {
		t.Fatalf("result = %#v", result)
	}
	processed, err := service.ProcessOne(context.Background())
	if err != nil || !processed {
		t.Fatalf("ProcessOne() = %v, %v", processed, err)
	}
	if repository.complete.EncryptedResult == "" ||
		strings.Contains(repository.complete.EncryptedResult, "registration-secret-value") ||
		strings.Contains(repository.complete.EncryptedResult, "registration-code-id") {
		t.Fatalf("unsafe completion = %#v", repository.complete)
	}
	if registrar.calls != 1 || registrar.request.RegisterLimit != 1 ||
		registrar.request.Region != "ap-beijing" {
		t.Fatalf("registrar calls=%d request=%#v", registrar.calls, registrar.request)
	}

	registrar.calls = 0
	recovered, err := service.GetOrCreate(context.Background(), computerauthport.Route{
		ServerID: bootstrapServerID, ComputerID: bootstrapComputerID, Version: 1,
	})
	if err != nil || !recovered.Ready ||
		recovered.Registration.CodeValue != "registration-secret-value" ||
		recovered.Registration.Region != "ap-beijing" ||
		registrar.calls != 0 {
		t.Fatalf("recovered=%#v calls=%d err=%v", recovered, registrar.calls, err)
	}
	if reflect.DeepEqual(recovered.Registration, Registration{}) {
		t.Fatal("recovered registration is empty")
	}
	wantFingerprint := sha256.Sum256([]byte(repository.complete.EncryptedResult))
	if repository.ensureCalls != 1 ||
		repository.ensureCommand.BootstrapOperationID != bootstrapOperationID ||
		repository.ensureCommand.ReconcileOperationID != bootstrapReconcileID ||
		repository.ensureCommand.ServerID != bootstrapServerID ||
		repository.ensureCommand.ComputerID != bootstrapComputerID ||
		repository.ensureCommand.CredentialVersion != 1 ||
		repository.ensureCommand.MaterialFingerprint != wantFingerprint ||
		!repository.ensureCommand.MaterialExpiresAt.Equal(registrar.result.ExpiresAt) ||
		!repository.ensureCommand.CreatedAt.Equal(bootstrapNow) {
		t.Fatalf("EnsureReconcile calls=%d command=%#v", repository.ensureCalls, repository.ensureCommand)
	}
}

func TestServiceDoesNotReturnProviderMaterialWhenReconcileCannotBeScheduled(t *testing.T) {
	repository := &fakeRepository{operation: bootstrapport.Operation{
		ID: bootstrapOperationID, ServerID: bootstrapServerID,
		ComputerID: bootstrapComputerID, CredentialVersion: 1, State: "succeeded",
		ResultExpiresAt: bootstrapNow.Add(time.Hour),
	}, ensureErr: bootstrapport.ErrNotEligible}
	service := newTestService(t, repository, &fakeRegistrar{})
	sealed, err := service.seal(repository.operation, encryptedRegistration{
		Protocol: "tencent-tat-register-v1", Region: "ap-beijing",
		CodeID: "registration-code-id", CodeValue: "registration-secret-value",
		Tags:      []Tag{{Key: "agent-network-computer-id", Value: bootstrapComputerID}},
		ExpiresAt: bootstrapNow.Add(time.Hour),
	})
	if err != nil {
		t.Fatal(err)
	}
	repository.operation.EncryptedResult = sealed

	result, err := service.GetOrCreate(context.Background(), computerauthport.Route{
		ServerID: bootstrapServerID, ComputerID: bootstrapComputerID, Version: 1,
	})
	if result.Ready || apperror.CodeOf(err) != "computer_bootstrap_not_allowed" ||
		repository.ensureCalls != 1 {
		t.Fatalf("GetOrCreate() = %#v, %v ensureCalls=%d", result, err, repository.ensureCalls)
	}
}

func TestServiceRecoversProviderRegistrationWhenDatabaseDeadlineLosesSubMillisecondPrecision(
	t *testing.T,
) {
	repository := &fakeRepository{operation: bootstrapport.Operation{
		ID: bootstrapOperationID, ServerID: bootstrapServerID,
		ComputerID: bootstrapComputerID, CredentialVersion: 1, State: "pending",
	}}
	registrar := &fakeRegistrar{result: tencenttatport.Registration{
		CodeID: "registration-code-id", CodeValue: "registration-secret-value",
		ExpiresAt: bootstrapNow.Add(time.Hour + 987654*time.Nanosecond),
	}}
	service := newTestService(t, repository, registrar)

	processed, err := service.ProcessOne(context.Background())
	if err != nil || !processed {
		t.Fatalf("ProcessOne() = %v, %v", processed, err)
	}
	repository.operation.ResultExpiresAt = repository.operation.ResultExpiresAt.Truncate(time.Millisecond)

	recovered, err := service.GetOrCreate(context.Background(), computerauthport.Route{
		ServerID: bootstrapServerID, ComputerID: bootstrapComputerID, Version: 1,
	})
	if err != nil {
		t.Fatalf("GetOrCreate() error = %v", err)
	}
	if !recovered.Ready || recovered.Registration.CodeValue != "registration-secret-value" ||
		!recovered.Registration.ExpiresAt.Equal(registrar.result.ExpiresAt) {
		t.Fatalf("recovered = %#v", recovered)
	}
}

func TestServiceUsesEncryptedPayloadExpiryInsteadOfElapsedDatabaseDeadline(t *testing.T) {
	repository := &fakeRepository{operation: bootstrapport.Operation{
		ID: bootstrapOperationID, ServerID: bootstrapServerID,
		ComputerID: bootstrapComputerID, CredentialVersion: 1, State: "succeeded",
		ResultExpiresAt: bootstrapNow,
	}}
	service := newTestService(t, repository, &fakeRegistrar{})
	payloadExpiresAt := bootstrapNow.Add(500 * time.Microsecond)
	sealed, err := service.seal(repository.operation, encryptedRegistration{
		Protocol: "tencent-tat-register-v1", Region: "ap-beijing",
		CodeID: "registration-code-id", CodeValue: "registration-secret-value",
		Tags:      []Tag{{Key: "agent-network-computer-id", Value: bootstrapComputerID}},
		ExpiresAt: payloadExpiresAt,
	})
	if err != nil {
		t.Fatal(err)
	}
	repository.operation.EncryptedResult = sealed

	recovered, err := service.GetOrCreate(context.Background(), computerauthport.Route{
		ServerID: bootstrapServerID, ComputerID: bootstrapComputerID, Version: 1,
	})
	if err != nil || !recovered.Ready ||
		!recovered.Registration.ExpiresAt.Equal(payloadExpiresAt) {
		t.Fatalf("GetOrCreate() = %#v, %v", recovered, err)
	}
}

func TestServiceRejectsZeroEncryptedPayloadExpiryWithoutRenewal(t *testing.T) {
	repository := &fakeRepository{operation: bootstrapport.Operation{
		ID: bootstrapOperationID, ServerID: bootstrapServerID,
		ComputerID: bootstrapComputerID, CredentialVersion: 1, State: "succeeded",
		ResultExpiresAt: bootstrapNow.Add(time.Hour),
	}}
	service := newTestService(t, repository, &fakeRegistrar{})
	sealed, err := service.seal(repository.operation, encryptedRegistration{
		Protocol: "tencent-tat-register-v1", Region: "ap-beijing",
		CodeID: "registration-code-id", CodeValue: "registration-secret-value",
		Tags:      []Tag{{Key: "agent-network-computer-id", Value: bootstrapComputerID}},
		ExpiresAt: time.Time{},
	})
	if err != nil {
		t.Fatal(err)
	}
	repository.operation.EncryptedResult = sealed

	_, err = service.GetOrCreate(context.Background(), computerauthport.Route{
		ServerID: bootstrapServerID, ComputerID: bootstrapComputerID, Version: 1,
	})
	if got := apperror.CodeOf(err); got != "internal_error" || repository.renewCalls != 0 {
		t.Fatalf("GetOrCreate() code = %q, error = %v", got, err)
	}
}

func TestServiceRequeuesExpiredProviderMaterialOnTheSameOperation(t *testing.T) {
	repository := &fakeRepository{operation: bootstrapport.Operation{
		ID: bootstrapOperationID, ServerID: bootstrapServerID,
		ComputerID: bootstrapComputerID, CredentialVersion: 1, State: "succeeded",
		ResultExpiresAt: bootstrapNow.Add(time.Hour),
	}}
	service := newTestService(t, repository, &fakeRegistrar{})
	sealed, err := service.seal(repository.operation, encryptedRegistration{
		Protocol: "tencent-tat-register-v1", Region: "ap-beijing",
		CodeID: "registration-code-id", CodeValue: "registration-secret-value",
		Tags:      []Tag{{Key: "agent-network-computer-id", Value: bootstrapComputerID}},
		ExpiresAt: bootstrapNow.Add(-time.Nanosecond),
	})
	if err != nil {
		t.Fatal(err)
	}
	repository.operation.EncryptedResult = sealed
	repository.renewedOperation = repository.operation
	repository.renewedOperation.State = "pending"
	repository.renewedOperation.EncryptedResult = ""

	result, err := service.GetOrCreate(context.Background(), computerauthport.Route{
		ServerID: bootstrapServerID, ComputerID: bootstrapComputerID, Version: 1,
	})
	if err != nil || result.Ready || result.State != "pending" ||
		result.OperationID != bootstrapOperationID || repository.renewCalls != 1 ||
		repository.renewCommand.OperationID != bootstrapOperationID ||
		repository.renewCommand.ServerID != bootstrapServerID ||
		repository.renewCommand.ComputerID != bootstrapComputerID ||
		repository.renewCommand.CredentialVersion != 1 ||
		repository.renewCommand.ExpectedEncryptedResult != sealed ||
		!repository.renewCommand.RenewedAt.Equal(bootstrapNow) ||
		!repository.renewCommand.DeadlineAt.Equal(bootstrapNow.Add(time.Hour)) {
		t.Fatalf("GetOrCreate() = %#v, %v renewCalls=%d", result, err, repository.renewCalls)
	}
}

func TestServiceUsesBoundedNormalStateMachineAfterRenewalCASLoss(t *testing.T) {
	tests := []struct {
		state     string
		wantState string
		wantCode  string
	}{
		{state: "pending", wantState: "pending"},
		{state: "running", wantState: "pending"},
		{state: "retry_wait", wantState: "retry_wait"},
		{state: "failed", wantCode: "provider_registration_failed"},
		{state: "succeeded"},
	}
	for _, test := range tests {
		t.Run(test.state, func(t *testing.T) {
			operation := bootstrapport.Operation{
				ID: bootstrapOperationID, ServerID: bootstrapServerID,
				ComputerID: bootstrapComputerID, CredentialVersion: 1,
				State: "succeeded", ResultExpiresAt: bootstrapNow.Add(time.Hour),
			}
			repository := &fakeRepository{operation: operation}
			service := newTestService(t, repository, &fakeRegistrar{})
			expired, err := service.seal(operation, encryptedRegistration{
				Protocol: "tencent-tat-register-v1", Region: "ap-beijing",
				CodeID: "expired-id", CodeValue: "expired-value",
				Tags:      []Tag{{Key: "agent-network-computer-id", Value: bootstrapComputerID}},
				ExpiresAt: bootstrapNow.Add(-time.Nanosecond),
			})
			if err != nil {
				t.Fatal(err)
			}
			repository.operation.EncryptedResult = expired
			repository.renewedOperation = operation
			repository.renewedOperation.State = test.state
			if test.state == "retry_wait" {
				next := bootstrapNow.Add(5 * time.Second)
				repository.renewedOperation.NextAttemptAt = &next
			}
			if test.state == "succeeded" {
				fresh, sealErr := service.seal(operation, encryptedRegistration{
					Protocol: "tencent-tat-register-v1", Region: "ap-beijing",
					CodeID: "fresh-id", CodeValue: "fresh-value",
					Tags:      []Tag{{Key: "agent-network-computer-id", Value: bootstrapComputerID}},
					ExpiresAt: bootstrapNow.Add(time.Hour),
				})
				if sealErr != nil {
					t.Fatal(sealErr)
				}
				repository.renewedOperation.EncryptedResult = fresh
			}

			result, err := service.GetOrCreate(context.Background(), computerauthport.Route{
				ServerID: bootstrapServerID, ComputerID: bootstrapComputerID, Version: 1,
			})
			if got := apperror.CodeOf(err); got != test.wantCode {
				t.Fatalf("GetOrCreate() code=%q error=%v", got, err)
			}
			if test.wantState != "" && result.State != test.wantState {
				t.Fatalf("GetOrCreate() result=%#v", result)
			}
			if test.state == "succeeded" && (!result.Ready || result.Registration.CodeID != "fresh-id") {
				t.Fatalf("GetOrCreate() result=%#v", result)
			}
			if repository.renewCalls != 1 {
				t.Fatalf("renewCalls=%d", repository.renewCalls)
			}
		})
	}
}

func TestServiceRejectsDamagedProviderMaterialWithoutRenewal(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*encryptedRegistration, *bootstrapport.Operation)
		raw    string
		empty  bool
	}{
		{name: "empty ciphertext", empty: true},
		{name: "protocol", mutate: func(value *encryptedRegistration, _ *bootstrapport.Operation) {
			value.Protocol = "wrong"
		}},
		{name: "region", mutate: func(value *encryptedRegistration, _ *bootstrapport.Operation) {
			value.Region = "ap-shanghai"
		}},
		{name: "empty code id", mutate: func(value *encryptedRegistration, _ *bootstrapport.Operation) {
			value.CodeID = ""
		}},
		{name: "empty code value", mutate: func(value *encryptedRegistration, _ *bootstrapport.Operation) {
			value.CodeValue = ""
		}},
		{name: "empty tags", mutate: func(value *encryptedRegistration, _ *bootstrapport.Operation) {
			value.Tags = nil
		}},
		{name: "wrong tag", mutate: func(value *encryptedRegistration, _ *bootstrapport.Operation) {
			value.Tags[0].Value = bootstrapReplayID
		}},
		{name: "duplicate tag", mutate: func(value *encryptedRegistration, _ *bootstrapport.Operation) {
			value.Tags = append(value.Tags, value.Tags[0])
		}},
		{name: "extra tag", mutate: func(value *encryptedRegistration, _ *bootstrapport.Operation) {
			value.Tags = append(value.Tags, Tag{Key: "extra", Value: "value"})
		}},
		{name: "aad operation", mutate: func(_ *encryptedRegistration, operation *bootstrapport.Operation) {
			operation.ID = bootstrapReplayID
		}},
		{name: "aad server", mutate: func(_ *encryptedRegistration, operation *bootstrapport.Operation) {
			operation.ServerID = bootstrapReplayID
		}},
		{name: "aad computer", mutate: func(_ *encryptedRegistration, operation *bootstrapport.Operation) {
			operation.ComputerID = bootstrapReplayID
		}},
		{name: "aad credential version", mutate: func(_ *encryptedRegistration, operation *bootstrapport.Operation) {
			operation.CredentialVersion = 2
		}},
		{name: "strict json", raw: `{"protocol":"tencent-tat-register-v1","unexpected":true}`},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			operation := bootstrapport.Operation{
				ID: bootstrapOperationID, ServerID: bootstrapServerID,
				ComputerID: bootstrapComputerID, CredentialVersion: 1,
				State: "succeeded", ResultExpiresAt: bootstrapNow.Add(time.Hour),
			}
			repository := &fakeRepository{operation: operation}
			service := newTestService(t, repository, &fakeRegistrar{})
			if !test.empty {
				payload := encryptedRegistration{
					Protocol: "tencent-tat-register-v1", Region: "ap-beijing",
					CodeID: "registration-code-id", CodeValue: "registration-secret-value",
					Tags:      []Tag{{Key: "agent-network-computer-id", Value: bootstrapComputerID}},
					ExpiresAt: bootstrapNow.Add(time.Hour),
				}
				sealOperation := operation
				if test.mutate != nil {
					test.mutate(&payload, &sealOperation)
				}
				var err error
				if test.raw != "" {
					repository.operation.EncryptedResult = sealRawRegistration(
						service, sealOperation, []byte(test.raw),
					)
				} else {
					repository.operation.EncryptedResult, err = service.seal(sealOperation, payload)
					if err != nil {
						t.Fatal(err)
					}
				}
			}

			_, err := service.GetOrCreate(context.Background(), computerauthport.Route{
				ServerID: bootstrapServerID, ComputerID: bootstrapComputerID, Version: 1,
			})
			if got := apperror.CodeOf(err); got != "internal_error" || repository.renewCalls != 0 {
				t.Fatalf("GetOrCreate() code=%q error=%v renewCalls=%d", got, err, repository.renewCalls)
			}
		})
	}
}

func sealRawRegistration(
	service *Service,
	operation bootstrapport.Operation,
	plain []byte,
) string {
	nonce := bytes.Repeat([]byte{0x7f}, service.aead.NonceSize())
	sealed := service.aead.Seal(nil, nonce, plain, associatedData(operation))
	return base64.RawURLEncoding.EncodeToString(append(nonce, sealed...))
}

func TestServiceReturnsPendingWhenAnotherCallerOwnsLease(t *testing.T) {
	repository := &fakeRepository{
		operation: bootstrapport.Operation{
			ID: bootstrapOperationID, ServerID: bootstrapServerID,
			ComputerID: bootstrapComputerID, CredentialVersion: 1, State: "running",
		},
		leaseAcquired: false,
	}
	registrar := &fakeRegistrar{}
	service := newTestService(t, repository, registrar)
	result, err := service.GetOrCreate(context.Background(), computerauthport.Route{
		ServerID: bootstrapServerID, ComputerID: bootstrapComputerID, Version: 1,
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Ready || result.State != "pending" || result.RetryAfterSeconds < 1 ||
		registrar.calls != 0 {
		t.Fatalf("result=%#v calls=%d", result, registrar.calls)
	}
}

func newTestService(t *testing.T, repository *fakeRepository, registrar *fakeRegistrar) *Service {
	t.Helper()
	service, err := NewService(
		repository, registrar,
		&fixedIDs{values: []string{
			bootstrapOperationID, bootstrapLeaseID, bootstrapReplayID, bootstrapReconcileID,
		}},
		fixedClock{now: bootstrapNow},
		Config{
			Region: "ap-beijing", LeaseTTL: time.Minute, MaterialTTL: time.Hour,
			MaxAttempts: 3, EncryptionKey: bytes.Repeat([]byte{0x41}, 32),
			Random: bytes.NewReader(bytes.Repeat([]byte{0x42}, 128)),
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	return service
}

type fixedIDs struct {
	values []string
	index  int
}

func (ids *fixedIDs) New() (string, error) {
	if ids.index >= len(ids.values) {
		return "", errors.New("no id")
	}
	value := ids.values[ids.index]
	ids.index++
	return value, nil
}

type fixedClock struct{ now time.Time }

func (clock fixedClock) Now() time.Time { return clock.now }

type fakeRepository struct {
	operation        bootstrapport.Operation
	leaseAcquired    bool
	complete         bootstrapport.CompleteCommand
	renewedOperation bootstrapport.Operation
	renewCalls       int
	renewCommand     bootstrapport.RenewExpiredCommand
	ensureCalls      int
	ensureCommand    bootstrapport.EnsureReconcileCommand
	ensureErr        error
}

func (repository *fakeRepository) EnsureReconcile(
	_ context.Context,
	command bootstrapport.EnsureReconcileCommand,
) error {
	repository.ensureCalls++
	repository.ensureCommand = command
	return repository.ensureErr
}

func (repository *fakeRepository) ClaimNext(
	_ context.Context,
	command bootstrapport.ClaimCommand,
) (bootstrapport.Operation, bool, error) {
	if repository.operation.State != "pending" || repository.leaseAcquired {
		return bootstrapport.Operation{}, false, nil
	}
	repository.leaseAcquired = true
	repository.operation.State = "running"
	repository.operation.Attempts++
	repository.operation.LeaseOwner = command.LeaseOwner
	return repository.operation, true, nil
}

func (repository *fakeRepository) GetOrCreate(
	context.Context,
	bootstrapport.StartCommand,
) (bootstrapport.Operation, error) {
	return repository.operation, nil
}

func (repository *fakeRepository) TryLease(
	_ context.Context,
	command bootstrapport.LeaseCommand,
) (bool, error) {
	if repository.operation.State == "pending" && !repository.leaseAcquired {
		repository.leaseAcquired = true
		return true, nil
	}
	return repository.leaseAcquired, nil
}

func (repository *fakeRepository) Complete(
	_ context.Context,
	command bootstrapport.CompleteCommand,
) error {
	repository.complete = command
	repository.operation.State = "succeeded"
	repository.operation.EncryptedResult = command.EncryptedResult
	repository.operation.ResultExpiresAt = command.ResultExpiresAt
	return nil
}

func (repository *fakeRepository) Retry(
	context.Context,
	bootstrapport.RetryCommand,
) error {
	return nil
}

func (repository *fakeRepository) RenewExpired(
	_ context.Context,
	command bootstrapport.RenewExpiredCommand,
) (bootstrapport.Operation, bool, error) {
	repository.renewCalls++
	repository.renewCommand = command
	return repository.renewedOperation, true, nil
}

type fakeRegistrar struct {
	result  tencenttatport.Registration
	err     error
	request tencenttatport.RegistrationRequest
	calls   int
}

func (registrar *fakeRegistrar) CreateRegistration(
	_ context.Context,
	request tencenttatport.RegistrationRequest,
) (tencenttatport.Registration, error) {
	registrar.calls++
	registrar.request = request
	return registrar.result, registrar.err
}
