package imtopic

import (
	"context"
	"testing"
	"time"

	imtopicport "chatserver/internal/ports/imtopic"
	tencentimport "chatserver/internal/ports/tencentim"
)

type fakeTopicRepository struct {
	work       imtopicport.Work
	hasWork    bool
	completion imtopicport.Completion
}

func (repository *fakeTopicRepository) Claim(
	context.Context,
	imtopicport.Claim,
) (imtopicport.Work, bool, error) {
	return repository.work, repository.hasWork, nil
}

func (repository *fakeTopicRepository) Complete(
	_ context.Context,
	completion imtopicport.Completion,
) error {
	repository.completion = completion
	return nil
}

type fakeTopicProvisioner struct {
	topic tencentimport.Topic
}

func (provisioner *fakeTopicProvisioner) EnsureTopic(
	_ context.Context,
	topic tencentimport.Topic,
) error {
	provisioner.topic = topic
	return nil
}

type fixedTopicClock struct{ now time.Time }

func (clock fixedTopicClock) Now() time.Time { return clock.now }

func TestServiceEnsuresPrivateTopicAndCompletes(t *testing.T) {
	now := time.Date(2026, 7, 30, 23, 20, 0, 0, time.UTC)
	repository := &fakeTopicRepository{
		hasWork: true,
		work: imtopicport.Work{
			OperationID:   "0198f4c2-7a37-7e45-913c-6baf30401a83",
			LeaseOwner:    "worker-a",
			ServerID:      "0198f4c2-7a31-7c91-a6d2-7d76f9188c38",
			ChannelID:     "0198f4c2-7a36-7e45-913c-6baf30401a82",
			GroupID:       "@TGS#_C_TEST",
			TopicID:       "@TGS#_C_TEST@TOPIC#_T_TEST",
			TopicName:     "C-TEST",
			OwnerIMUserID: "u_owner",
			Description:   "研发频道", Private: true,
			IMState:         "provisioning",
			ChannelRevision: 1, DesiredRevision: 1, Attempts: 1,
		},
	}
	provisioner := &fakeTopicProvisioner{}
	service, err := NewService(
		repository,
		provisioner,
		fixedTopicClock{now: now},
		Config{
			WorkerID: "worker-a", LeaseTTL: time.Minute,
			MaxAttempts: 5, BaseBackoff: time.Second,
			MaxBackoff: time.Minute,
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	processed, err := service.ProcessOne(context.Background())
	if err != nil || !processed {
		t.Fatalf("ProcessOne() = (%v, %v)", processed, err)
	}
	if provisioner.topic.TopicID != repository.work.TopicID ||
		!provisioner.topic.Private ||
		repository.completion.Status != imtopicport.CompletionSucceeded {
		t.Fatalf(
			"topic/completion = (%#v, %#v)",
			provisioner.topic,
			repository.completion,
		)
	}
}
