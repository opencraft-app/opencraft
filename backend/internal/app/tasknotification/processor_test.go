package tasknotification

import (
	"context"
	"testing"
	"time"

	clockport "chatserver/internal/ports/clock"
	tasknotificationport "chatserver/internal/ports/tasknotification"
	tencentimport "chatserver/internal/ports/tencentim"
)

type fakeRepository struct {
	work       tasknotificationport.Work
	found      bool
	claim      tasknotificationport.Claim
	completion tasknotificationport.Completion
	current    *bool
}

func (repository *fakeRepository) Current(
	_ context.Context,
	work tasknotificationport.Work,
	_ time.Time,
) (bool, error) {
	if repository.current != nil {
		return *repository.current, nil
	}
	return work.Current, nil
}

func (repository *fakeRepository) Claim(
	_ context.Context,
	claim tasknotificationport.Claim,
) (tasknotificationport.Work, bool, error) {
	repository.claim = claim
	found := repository.found
	repository.found = false
	return repository.work, found, nil
}

func (repository *fakeRepository) Complete(
	_ context.Context,
	completion tasknotificationport.Completion,
) error {
	repository.completion = completion
	return nil
}

type fakeSender struct {
	notification tencentimport.AgentNotification
}

func (sender *fakeSender) SendAgentNotification(
	_ context.Context,
	notification tencentimport.AgentNotification,
) error {
	sender.notification = notification
	return nil
}

type fixedClock struct{ now time.Time }

func (clock fixedClock) Now() time.Time { return clock.now }

var _ clockport.Clock = fixedClock{}

func TestProcessorSendsCurrentAssignmentAndCompletesOperation(t *testing.T) {
	now := time.Date(2026, 8, 1, 13, 0, 0, 0, time.UTC)
	repository := &fakeRepository{found: true, work: tasknotificationport.Work{
		OperationID:        "0198f4c2-7a3b-7e45-913c-6baf30401a8a",
		LeaseOwner:         "task-worker-1",
		ServerID:           "0198f4c2-7a31-7c91-a6d2-7d76f9188c38",
		TaskID:             "0198f4c2-7a34-7e45-913c-6baf30401a83",
		AgentID:            "0198f4c2-7a33-7e45-913c-6baf30401a82",
		RecipientUserID:    "a_task_agent",
		AssignmentRevision: 2,
		Attempts:           1,
		Current:            true,
	}}
	sender := &fakeSender{}
	processor, err := NewProcessor(
		repository,
		sender,
		fixedClock{now: now},
		Config{
			WorkerID: "task-worker-1", LeaseTTL: 30 * time.Second,
			MaxAttempts: 5, BaseBackoff: time.Second, MaxBackoff: time.Minute,
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	processed, err := processor.ProcessOne(context.Background())
	if err != nil || !processed {
		t.Fatalf("ProcessOne() = (%v, %v)", processed, err)
	}
	if sender.notification.Type != "task.assigned" ||
		sender.notification.EventID != repository.work.OperationID ||
		sender.notification.ResourceID != repository.work.TaskID ||
		sender.notification.Revision != 2 {
		t.Fatalf("notification = %#v", sender.notification)
	}
	if repository.completion.Status != tasknotificationport.CompletionSucceeded ||
		repository.completion.OperationID != repository.work.OperationID {
		t.Fatalf("completion = %#v", repository.completion)
	}
}

func TestProcessorSuppressesAssignmentThatBecameStaleAfterClaim(t *testing.T) {
	now := time.Date(2026, 8, 4, 13, 0, 0, 0, time.UTC)
	work := tasknotificationport.Work{
		OperationID: "operation-1", LeaseOwner: "task-worker-1",
		ServerID: "server-1", TaskID: "task-1", AgentID: "agent-1",
		RecipientUserID: "a_task_agent", AssignmentRevision: 2, Current: true,
	}
	current := false
	repository := &fakeRepository{found: true, work: work, current: &current}
	sender := &fakeSender{}
	processor, err := NewProcessor(repository, sender, fixedClock{now: now}, Config{
		WorkerID: "task-worker-1", LeaseTTL: 30 * time.Second,
		MaxAttempts: 5, BaseBackoff: time.Second, MaxBackoff: time.Minute,
	})
	if err != nil {
		t.Fatal(err)
	}
	processed, err := processor.ProcessOne(context.Background())
	if err != nil || !processed {
		t.Fatalf("ProcessOne() = (%v, %v)", processed, err)
	}
	if sender.notification.EventID != "" {
		t.Fatalf("stale notification sent: %#v", sender.notification)
	}
	if repository.completion.Status != tasknotificationport.CompletionSuperseded {
		t.Fatalf("completion = %#v", repository.completion)
	}
}
