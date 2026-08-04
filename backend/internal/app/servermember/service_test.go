package servermember

import (
	"context"
	"testing"
	"time"

	clockport "chatserver/internal/ports/clock"
	servermemberport "chatserver/internal/ports/servermember"
)

func TestServiceCreateReturnsReadyWhenCommunityFinishesInWindow(
	t *testing.T,
) {
	repository := &fakeCreateRepository{
		result: servermemberport.CreateResult{
			Created:     true,
			ServerID:    testServiceIDs[0],
			OperationID: testServiceIDs[3],
		},
	}
	observer := &fakeCreationObserver{
		observation: CreationObservation{
			Server: servermemberport.Server{
				ID:            testServiceIDs[0],
				Slug:          "agent-lab",
				Name:          "Agent 实验室",
				OwnerMemberID: testServiceIDs[1],
				IMState:       "ready",
				Revision:      2,
			},
			Operation: Operation{
				ID:      testServiceIDs[3],
				Service: "im",
				Kind:    "im.community.ensure",
				State:   "succeeded",
			},
		},
	}
	service := newTestService(t, repository, observer)

	result, err := service.Create(context.Background(), CreateCommand{
		AccountID:      testServiceAccountID,
		IdempotencyKey: "server-create-test-0001",
		Slug:           "agent-lab",
		Name:           "Agent 实验室",
	})
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if !result.Ready ||
		result.Server.ID != testServiceIDs[0] ||
		result.Operation.State != "succeeded" {
		t.Fatalf("Create() = %#v", result)
	}
	if repository.command.Server.ID != testServiceIDs[0] ||
		repository.command.Owner.ID != testServiceIDs[1] ||
		repository.command.RootChannelID != testServiceIDs[2] ||
		repository.command.OperationID != testServiceIDs[3] ||
		repository.command.RootTopicOperationID != testServiceIDs[4] ||
		repository.command.RootChannelTopicID != testServiceTopicID ||
		repository.command.Server.IMGroupID != testServiceGroupID ||
		repository.command.Owner.Handle != "u_Q4JUHFNA4CTQZQIS32XH" ||
		repository.command.RequestHash == [32]byte{} {
		t.Fatalf("Create command = %#v", repository.command)
	}
	if observer.wait != 10*time.Second {
		t.Fatalf("observer wait = %s", observer.wait)
	}
}

func TestServiceCreateReturnsAcceptedWhileCommunityIsPending(
	t *testing.T,
) {
	repository := &fakeCreateRepository{
		result: servermemberport.CreateResult{
			Created:     true,
			ServerID:    testServiceIDs[0],
			OperationID: testServiceIDs[3],
		},
	}
	observer := &fakeCreationObserver{
		observation: CreationObservation{
			Server: servermemberport.Server{
				ID:            testServiceIDs[0],
				OwnerMemberID: testServiceIDs[1],
				IMState:       "provisioning",
				Revision:      1,
			},
			Operation: Operation{
				ID:      testServiceIDs[3],
				Service: "im",
				Kind:    "im.community.ensure",
				State:   "retry_wait",
			},
		},
	}
	service := newTestService(t, repository, observer)

	result, err := service.Create(context.Background(), CreateCommand{
		AccountID:      testServiceAccountID,
		IdempotencyKey: "server-create-test-0001",
		Slug:           "agent-lab",
		Name:           "Agent 实验室",
	})
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if result.Ready || result.Operation.State != "retry_wait" {
		t.Fatalf("Create() = %#v", result)
	}
}

const (
	testServiceAccountID = "0198f4c2-7a30-7c91-a6d2-7d76f9188c37"
	testServiceGroupID   = "@TGS#_C_5ODDSBF3PNVZH25YMT3OMJ4ZSF"
)

var testServiceIDs = []string{
	"0198f4c2-7a31-7c91-a6d2-7d76f9188c38",
	"0198f4c2-7a32-7d02-b8c1-3f6e15aa91b4",
	"0198f4c2-7a33-7af3-a01e-0fcb31e9d84a",
	"0198f4c2-7a34-7af3-a01e-0fcb31e9d84b",
	"0198f4c2-7a35-7af3-a01e-0fcb31e9d84c",
}

const testServiceTopicID = testServiceGroupID + "@TOPIC#_T_46HDVNIIYDGRIRBGXZTJ7KMFLP"

var testServiceNow = time.Date(2026, 7, 30, 14, 0, 0, 0, time.UTC)

type fakeCreateRepository struct {
	command servermemberport.CreateCommand
	result  servermemberport.CreateResult
	err     error
}

func (repository *fakeCreateRepository) Create(
	_ context.Context,
	command servermemberport.CreateCommand,
) (servermemberport.CreateResult, error) {
	repository.command = command
	return repository.result, repository.err
}

type fakeCreationObserver struct {
	observation CreationObservation
	err         error
	wait        time.Duration
}

func (observer *fakeCreationObserver) Await(
	_ context.Context,
	_ string,
	_ string,
	_ string,
	wait time.Duration,
) (CreationObservation, error) {
	observer.wait = wait
	return observer.observation, observer.err
}

type fakeResourceDeriver struct{}

func (fakeResourceDeriver) CommunityGroupID(string) (string, error) {
	return testServiceGroupID, nil
}

func (fakeResourceDeriver) Topic(string, string, string) (string, string, error) {
	return testServiceTopicID, "C-46HDVNIIYDGRIRBGXZTJ", nil
}

type sequenceIDs struct {
	values []string
	index  int
}

func (generator *sequenceIDs) New() (string, error) {
	value := generator.values[generator.index]
	generator.index++
	return value, nil
}

func newTestService(
	t *testing.T,
	repository *fakeCreateRepository,
	observer *fakeCreationObserver,
) *Service {
	t.Helper()
	service, err := NewService(
		repository,
		observer,
		fakeResourceDeriver{},
		&sequenceIDs{values: append([]string(nil), testServiceIDs...)},
		fixedClock{now: testServiceNow},
		Config{CreationWait: 10 * time.Second},
	)
	if err != nil {
		t.Fatal(err)
	}
	return service
}

type fixedClock struct {
	now time.Time
}

func (clock fixedClock) Now() time.Time {
	return clock.now
}

var _ clockport.Clock = fixedClock{}
