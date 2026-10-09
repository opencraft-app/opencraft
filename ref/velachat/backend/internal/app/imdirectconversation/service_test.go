package imdirectconversation

import (
	"context"
	"errors"
	"testing"
	"time"

	clockport "chatserver/internal/ports/clock"
	workport "chatserver/internal/ports/imdirectconversation"
	tencentimport "chatserver/internal/ports/tencentim"
)

type directRepository struct {
	work       workport.Work
	found      bool
	completion workport.Completion
}

func (repository *directRepository) Claim(context.Context, workport.Claim) (workport.Work, bool, error) {
	return repository.work, repository.found, nil
}

func (repository *directRepository) Complete(_ context.Context, completion workport.Completion) error {
	repository.completion = completion
	return nil
}

type directProvisioner struct {
	group tencentimport.DirectGroup
	err   error
}

func (provisioner *directProvisioner) EnsureDirectGroup(_ context.Context, group tencentimport.DirectGroup) error {
	provisioner.group = group
	return provisioner.err
}

func TestServiceEnsuresDirectGroupAndCompletesOperation(t *testing.T) {
	now := time.Date(2026, 8, 4, 16, 0, 0, 0, time.UTC)
	repository := &directRepository{found: true, work: directWork()}
	provisioner := &directProvisioner{}
	service, err := NewService(repository, provisioner, fixedDirectClock{now}, directConfig())
	if err != nil {
		t.Fatal(err)
	}
	processed, err := service.ProcessOne(context.Background())
	if err != nil || !processed {
		t.Fatalf("ProcessOne() = (%v, %v)", processed, err)
	}
	if provisioner.group.GroupID != "an_dm_direct" || provisioner.group.MemberAUserID != "u_A" ||
		provisioner.group.MemberBUserID != "u_B" || provisioner.group.Name != "Server 内私信" {
		t.Fatalf("group = %#v", provisioner.group)
	}
	if repository.completion.Status != workport.CompletionSucceeded {
		t.Fatalf("completion = %#v", repository.completion)
	}
}

func TestServiceRetriesOnlyRetryableTencentFailure(t *testing.T) {
	now := time.Date(2026, 8, 4, 16, 0, 0, 0, time.UTC)
	repository := &directRepository{found: true, work: directWork()}
	provisioner := &directProvisioner{err: directTencentError{}}
	service, err := NewService(repository, provisioner, fixedDirectClock{now}, directConfig())
	if err != nil {
		t.Fatal(err)
	}
	if processed, err := service.ProcessOne(context.Background()); err != nil || !processed {
		t.Fatalf("ProcessOne() = (%v, %v)", processed, err)
	}
	if repository.completion.Status != workport.CompletionRetry ||
		repository.completion.ErrorCode != "tencent_network_error" ||
		!repository.completion.NextAttemptAt.After(now) {
		t.Fatalf("completion = %#v", repository.completion)
	}
}

func TestServiceSupersedesStaleDirectConversationRevision(t *testing.T) {
	repository := &directRepository{found: true, work: directWork()}
	repository.work.DesiredRevision++
	provisioner := &directProvisioner{err: errors.New("must not call")}
	service, err := NewService(repository, provisioner, fixedDirectClock{time.Now()}, directConfig())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.ProcessOne(context.Background()); err != nil {
		t.Fatal(err)
	}
	if repository.completion.Status != workport.CompletionSuperseded || provisioner.group.GroupID != "" {
		t.Fatalf("completion=%#v group=%#v", repository.completion, provisioner.group)
	}
}

func directWork() workport.Work {
	return workport.Work{
		OperationID: "op", LeaseOwner: "worker", ServerID: "server", DirectConversationID: "direct",
		GroupID: "an_dm_direct", GroupName: "Server 内私信",
		MemberAIMUserID: "u_A", MemberBIMUserID: "u_B", IMState: "provisioning",
		ConversationRevision: 1, DesiredRevision: 1, Attempts: 1,
	}
}

func directConfig() Config {
	return Config{WorkerID: "worker", LeaseTTL: 30 * time.Second, MaxAttempts: 8, BaseBackoff: time.Second, MaxBackoff: time.Minute}
}

type fixedDirectClock struct{ now time.Time }

func (clock fixedDirectClock) Now() time.Time { return clock.now }

var _ clockport.Clock = fixedDirectClock{}

type directTencentError struct{}

func (directTencentError) Error() string       { return "redacted" }
func (directTencentError) TencentCode() string { return "tencent_network_error" }
func (directTencentError) Retryable() bool     { return true }
