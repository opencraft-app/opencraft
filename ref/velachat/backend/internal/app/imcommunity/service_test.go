package imcommunity

import (
	"context"
	"testing"
	"time"

	imcommunityport "chatserver/internal/ports/imcommunity"
	tencentimport "chatserver/internal/ports/tencentim"
)

var communityWorkerNow = time.Date(2026, 7, 30, 16, 0, 0, 0, time.UTC)

type fakeCommunityRepository struct {
	work        imcommunityport.Work
	hasWork     bool
	claim       imcommunityport.Claim
	completion  imcommunityport.Completion
	completeErr error
}

func (repository *fakeCommunityRepository) Claim(
	_ context.Context,
	claim imcommunityport.Claim,
) (imcommunityport.Work, bool, error) {
	repository.claim = claim
	return repository.work, repository.hasWork, nil
}

func (repository *fakeCommunityRepository) Complete(
	_ context.Context,
	completion imcommunityport.Completion,
) error {
	repository.completion = completion
	return repository.completeErr
}

type fakeCommunityProvisioner struct {
	community tencentimport.Community
	err       error
}

func (provisioner *fakeCommunityProvisioner) EnsureCommunity(
	_ context.Context,
	community tencentimport.Community,
) error {
	provisioner.community = community
	return provisioner.err
}

type fixedCommunityClock struct{ now time.Time }

func (clock fixedCommunityClock) Now() time.Time { return clock.now }

type communityTencentFailure struct {
	code      string
	retryable bool
}

func (failure communityTencentFailure) Error() string { return "腾讯云测试失败" }
func (failure communityTencentFailure) TencentCode() string {
	return failure.code
}
func (failure communityTencentFailure) Retryable() bool {
	return failure.retryable
}

func TestProcessOneEnsuresServerCommunity(t *testing.T) {
	repository := &fakeCommunityRepository{
		hasWork: true,
		work:    testCommunityWork(),
	}
	provisioner := &fakeCommunityProvisioner{}
	service := newCommunityWorkerService(t, repository, provisioner)

	processed, err := service.ProcessOne(context.Background())
	if err != nil || !processed {
		t.Fatalf("ProcessOne() = (%v, %v)", processed, err)
	}
	if provisioner.community != (tencentimport.Community{
		GroupID:      "@TGS#_C_platform",
		OwnerUserID:  "u_owner",
		Name:         "Agent 实验室",
		Introduction: "协作空间",
	}) {
		t.Fatalf("community = %#v", provisioner.community)
	}
	if repository.completion.Status != imcommunityport.CompletionSucceeded {
		t.Fatalf("completion = %#v", repository.completion)
	}
}

func TestProcessOneSkipsTencentForReadyCommunity(t *testing.T) {
	work := testCommunityWork()
	work.IMState = "ready"
	repository := &fakeCommunityRepository{hasWork: true, work: work}
	provisioner := &fakeCommunityProvisioner{}
	service := newCommunityWorkerService(t, repository, provisioner)

	processed, err := service.ProcessOne(context.Background())
	if err != nil || !processed {
		t.Fatalf("ProcessOne() = (%v, %v)", processed, err)
	}
	if repository.completion.Status != imcommunityport.CompletionSucceeded ||
		provisioner.community.GroupID != "" {
		t.Fatalf("completion/community = %#v / %#v",
			repository.completion, provisioner.community)
	}
}

func TestProcessOneSupersedesStaleCommunityRevision(t *testing.T) {
	work := testCommunityWork()
	work.ServerRevision = 2
	repository := &fakeCommunityRepository{hasWork: true, work: work}
	provisioner := &fakeCommunityProvisioner{}
	service := newCommunityWorkerService(t, repository, provisioner)

	processed, err := service.ProcessOne(context.Background())
	if err != nil || !processed {
		t.Fatalf("ProcessOne() = (%v, %v)", processed, err)
	}
	if repository.completion.Status != imcommunityport.CompletionSuperseded ||
		provisioner.community.GroupID != "" {
		t.Fatalf("completion/community = %#v / %#v",
			repository.completion, provisioner.community)
	}
}

func TestProcessOneClassifiesCommunityFailure(t *testing.T) {
	tests := []struct {
		name      string
		attempts  int64
		retryable bool
		want      imcommunityport.CompletionStatus
	}{
		{
			name:      "transient",
			attempts:  2,
			retryable: true,
			want:      imcommunityport.CompletionRetry,
		},
		{
			name:      "max attempts",
			attempts:  5,
			retryable: true,
			want:      imcommunityport.CompletionFailed,
		},
		{
			name:      "permanent",
			attempts:  1,
			retryable: false,
			want:      imcommunityport.CompletionFailed,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			work := testCommunityWork()
			work.Attempts = test.attempts
			repository := &fakeCommunityRepository{
				hasWork: true,
				work:    work,
			}
			provisioner := &fakeCommunityProvisioner{
				err: communityTencentFailure{
					code:      "tencent_test",
					retryable: test.retryable,
				},
			}
			service := newCommunityWorkerService(t, repository, provisioner)

			processed, err := service.ProcessOne(context.Background())
			if err != nil || !processed {
				t.Fatalf("ProcessOne() = (%v, %v)", processed, err)
			}
			if repository.completion.Status != test.want ||
				repository.completion.ErrorCode != "tencent_test" {
				t.Fatalf("completion = %#v", repository.completion)
			}
			if test.want == imcommunityport.CompletionRetry &&
				!repository.completion.NextAttemptAt.Equal(
					communityWorkerNow.Add(2*time.Second),
				) {
				t.Fatalf("nextAttemptAt = %v",
					repository.completion.NextAttemptAt)
			}
		})
	}
}

func testCommunityWork() imcommunityport.Work {
	return imcommunityport.Work{
		OperationID:     "operation",
		LeaseOwner:      "worker-a",
		ServerID:        "server",
		ServerName:      "Agent 实验室",
		Description:     "协作空间",
		GroupID:         "@TGS#_C_platform",
		OwnerMemberID:   "member",
		OwnerIMUserID:   "u_owner",
		RootChannelID:   "channel",
		IMState:         "provisioning",
		ServerRevision:  1,
		DesiredRevision: 1,
		Attempts:        1,
	}
}

func newCommunityWorkerService(
	t *testing.T,
	repository imcommunityport.Repository,
	provisioner tencentimport.CommunityProvisioner,
) *Service {
	t.Helper()
	service, err := NewService(
		repository,
		provisioner,
		fixedCommunityClock{now: communityWorkerNow},
		Config{
			WorkerID:    "worker-a",
			LeaseTTL:    30 * time.Second,
			MaxAttempts: 5,
			BaseBackoff: time.Second,
			MaxBackoff:  time.Minute,
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	return service
}
