package imidentity

import (
	"context"
	"errors"
	"testing"
	"time"

	imidentityport "chatserver/internal/ports/imidentity"
	tencentimport "chatserver/internal/ports/tencentim"
)

var workerNow = time.Date(2026, 7, 30, 14, 0, 0, 0, time.UTC)

type fakeWorkRepository struct {
	work        imidentityport.Work
	hasWork     bool
	claim       imidentityport.Claim
	claimErr    error
	completion  imidentityport.Completion
	completeErr error
}

func (repository *fakeWorkRepository) Claim(
	_ context.Context,
	claim imidentityport.Claim,
) (imidentityport.Work, bool, error) {
	repository.claim = claim
	return repository.work, repository.hasWork, repository.claimErr
}

func (repository *fakeWorkRepository) Complete(
	_ context.Context,
	completion imidentityport.Completion,
) error {
	repository.completion = completion
	return repository.completeErr
}

type fakeIdentityDeriver struct {
	userID    string
	accountID string
	err       error
}

func (deriver *fakeIdentityDeriver) HumanUserID(accountID string) (string, error) {
	deriver.accountID = accountID
	return deriver.userID, deriver.err
}

type fakeProvisioner struct {
	identity tencentimport.Identity
	err      error
}

func (provisioner *fakeProvisioner) EnsureIdentity(
	_ context.Context,
	identity tencentimport.Identity,
) error {
	provisioner.identity = identity
	return provisioner.err
}

type tencentFailure struct {
	code      string
	retryable bool
}

func (failure tencentFailure) Error() string       { return "腾讯云测试失败" }
func (failure tencentFailure) TencentCode() string { return failure.code }
func (failure tencentFailure) Retryable() bool     { return failure.retryable }

type fixedWorkerClock struct{ now time.Time }

func (clock fixedWorkerClock) Now() time.Time { return clock.now }

func TestProcessOneDerivesAndImportsProvisioningHumanIdentity(t *testing.T) {
	repository := &fakeWorkRepository{
		hasWork: true,
		work: imidentityport.Work{
			OperationID:     "01989c24-7540-7f12-a27b-c83243215dd2",
			LeaseOwner:      "worker-a",
			AccountID:       "01989c24-7540-7f12-a27b-c83243215dd1",
			DisplayName:     "爱丽丝",
			IMState:         "provisioning",
			AccountRevision: 1,
			DesiredRevision: 1,
			Attempts:        1,
		},
	}
	deriver := &fakeIdentityDeriver{userID: "u_OPAQUE"}
	provisioner := &fakeProvisioner{}
	service := newWorkerService(t, repository, deriver, provisioner)

	processed, err := service.ProcessOne(context.Background())
	if err != nil {
		t.Fatalf("ProcessOne() error = %v", err)
	}
	if !processed {
		t.Fatal("ProcessOne() processed = false")
	}
	if deriver.accountID != repository.work.AccountID {
		t.Fatalf("deriver accountID = %q", deriver.accountID)
	}
	if provisioner.identity != (tencentimport.Identity{
		UserID: "u_OPAQUE",
		Nick:   "爱丽丝",
	}) {
		t.Fatalf("provisioned identity = %#v", provisioner.identity)
	}
	if repository.completion.Status != imidentityport.CompletionSucceeded ||
		repository.completion.IMUserID != "u_OPAQUE" {
		t.Fatalf("completion = %#v", repository.completion)
	}
}

func TestProcessOneSkipsTencentWhenIdentityAlreadyReady(t *testing.T) {
	repository := &fakeWorkRepository{
		hasWork: true,
		work: imidentityport.Work{
			OperationID:     "operation",
			LeaseOwner:      "worker-a",
			AccountID:       "account",
			IMUserID:        "u_EXISTING",
			IMState:         "ready",
			AccountRevision: 1,
			DesiredRevision: 1,
			Attempts:        1,
		},
	}
	deriver := &fakeIdentityDeriver{err: errors.New("must not derive")}
	provisioner := &fakeProvisioner{err: errors.New("must not call")}
	service := newWorkerService(t, repository, deriver, provisioner)

	processed, err := service.ProcessOne(context.Background())
	if err != nil || !processed {
		t.Fatalf("ProcessOne() = (%v, %v)", processed, err)
	}
	if repository.completion.Status != imidentityport.CompletionSucceeded ||
		repository.completion.IMUserID != "u_EXISTING" {
		t.Fatalf("completion = %#v", repository.completion)
	}
	if provisioner.identity.UserID != "" || deriver.accountID != "" {
		t.Fatal("ready identity still invoked external work")
	}
}

func TestProcessOneSupersedesStaleRevisionWithoutTencentCall(t *testing.T) {
	repository := &fakeWorkRepository{
		hasWork: true,
		work: imidentityport.Work{
			OperationID:     "operation",
			LeaseOwner:      "worker-a",
			AccountID:       "account",
			IMState:         "provisioning",
			AccountRevision: 2,
			DesiredRevision: 1,
			Attempts:        1,
		},
	}
	provisioner := &fakeProvisioner{}
	service := newWorkerService(
		t,
		repository,
		&fakeIdentityDeriver{userID: "u_OPAQUE"},
		provisioner,
	)

	processed, err := service.ProcessOne(context.Background())
	if err != nil || !processed {
		t.Fatalf("ProcessOne() = (%v, %v)", processed, err)
	}
	if repository.completion.Status != imidentityport.CompletionSuperseded {
		t.Fatalf("completion = %#v", repository.completion)
	}
	if provisioner.identity.UserID != "" {
		t.Fatal("stale work called Tencent")
	}
}

func TestProcessOneClassifiesRetryAndTerminalFailure(t *testing.T) {
	tests := []struct {
		name       string
		attempts   int64
		failure    error
		wantStatus imidentityport.CompletionStatus
		wantNext   time.Time
	}{
		{
			name:       "transient before max attempts",
			attempts:   2,
			failure:    tencentFailure{code: "tencent_70169", retryable: true},
			wantStatus: imidentityport.CompletionRetry,
			wantNext:   workerNow.Add(2 * time.Second),
		},
		{
			name:       "transient at max attempts",
			attempts:   5,
			failure:    tencentFailure{code: "tencent_70169", retryable: true},
			wantStatus: imidentityport.CompletionFailed,
		},
		{
			name:       "permanent",
			attempts:   1,
			failure:    tencentFailure{code: "tencent_70403", retryable: false},
			wantStatus: imidentityport.CompletionFailed,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			repository := &fakeWorkRepository{
				hasWork: true,
				work: imidentityport.Work{
					OperationID:     "operation",
					LeaseOwner:      "worker-a",
					AccountID:       "account",
					DisplayName:     "Alice",
					IMState:         "provisioning",
					AccountRevision: 1,
					DesiredRevision: 1,
					Attempts:        test.attempts,
				},
			}
			service := newWorkerService(
				t,
				repository,
				&fakeIdentityDeriver{userID: "u_OPAQUE"},
				&fakeProvisioner{err: test.failure},
			)

			processed, err := service.ProcessOne(context.Background())
			if err != nil || !processed {
				t.Fatalf("ProcessOne() = (%v, %v)", processed, err)
			}
			if repository.completion.Status != test.wantStatus ||
				repository.completion.ErrorCode != tencentimport.CodeOf(test.failure) ||
				!repository.completion.NextAttemptAt.Equal(test.wantNext) {
				t.Fatalf("completion = %#v", repository.completion)
			}
		})
	}
}

func TestProcessOneReturnsNoWorkWithoutCallingDependencies(t *testing.T) {
	repository := &fakeWorkRepository{}
	service := newWorkerService(
		t,
		repository,
		&fakeIdentityDeriver{err: errors.New("must not call")},
		&fakeProvisioner{err: errors.New("must not call")},
	)

	processed, err := service.ProcessOne(context.Background())
	if err != nil || processed {
		t.Fatalf("ProcessOne() = (%v, %v)", processed, err)
	}
}

func TestProcessOneTreatsLostLeaseAsHandledFencing(t *testing.T) {
	repository := &fakeWorkRepository{
		hasWork: true,
		work: imidentityport.Work{
			OperationID:     "operation",
			LeaseOwner:      "worker-a",
			AccountID:       "account",
			DisplayName:     "Alice",
			IMState:         "provisioning",
			AccountRevision: 1,
			DesiredRevision: 1,
			Attempts:        1,
		},
		completeErr: imidentityport.ErrLeaseLost,
	}
	service := newWorkerService(
		t,
		repository,
		&fakeIdentityDeriver{userID: "u_OPAQUE"},
		&fakeProvisioner{},
	)

	processed, err := service.ProcessOne(context.Background())
	if err != nil || !processed {
		t.Fatalf("ProcessOne() = (%v, %v)", processed, err)
	}
}

func newWorkerService(
	t *testing.T,
	repository *fakeWorkRepository,
	deriver *fakeIdentityDeriver,
	provisioner *fakeProvisioner,
) *Service {
	t.Helper()
	service, err := NewService(
		repository,
		deriver,
		provisioner,
		fixedWorkerClock{now: workerNow},
		Config{
			WorkerID:    "worker-a",
			LeaseTTL:    time.Minute,
			MaxAttempts: 5,
			BaseBackoff: time.Second,
			MaxBackoff:  time.Minute,
		},
	)
	if err != nil {
		t.Fatalf("NewService() error = %v", err)
	}
	return service
}
