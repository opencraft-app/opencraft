package reminderoccurrence

import (
	"context"
	"testing"
	"time"

	occurrenceport "chatserver/internal/ports/reminderoccurrence"
	tencentimport "chatserver/internal/ports/tencentim"
)

type fakeSchedulerRepository struct {
	occurrenceport.Repository
	materialized []bool
	work         occurrenceport.NotificationWork
	hasWork      bool
	claimResults []bool
	claim        occurrenceport.NotificationClaim
	completed    []any
	retried      []any
	current      *bool
}

func (repository *fakeSchedulerRepository) NotificationCurrent(
	_ context.Context,
	_ occurrenceport.NotificationWork,
	_ time.Time,
) (bool, error) {
	if repository.current == nil {
		return true, nil
	}
	return *repository.current, nil
}

func (repository *fakeSchedulerRepository) ProcessOne(
	context.Context,
	time.Time,
) (bool, error) {
	if len(repository.materialized) == 0 {
		return false, nil
	}
	result := repository.materialized[0]
	repository.materialized = repository.materialized[1:]
	return result, nil
}

func (repository *fakeSchedulerRepository) ClaimNotification(
	_ context.Context,
	claim occurrenceport.NotificationClaim,
) (occurrenceport.NotificationWork, bool, error) {
	repository.claim = claim
	hasWork := repository.hasWork
	if len(repository.claimResults) > 0 {
		hasWork = repository.claimResults[0]
		repository.claimResults = repository.claimResults[1:]
	}
	return repository.work, hasWork, nil
}

func (repository *fakeSchedulerRepository) CompleteNotification(
	_ context.Context,
	eventID string,
	leaseOwner string,
	now time.Time,
) error {
	repository.completed = []any{eventID, leaseOwner, now}
	return nil
}

func (repository *fakeSchedulerRepository) RetryNotification(
	_ context.Context,
	eventID string,
	leaseOwner string,
	availableAt time.Time,
	errorCode string,
	dead bool,
) error {
	repository.retried = []any{eventID, leaseOwner, availableAt, errorCode, dead}
	return nil
}

type fakeNotificationSender struct {
	value tencentimport.AgentNotification
	err   error
}

func (sender *fakeNotificationSender) SendAgentNotification(
	_ context.Context,
	value tencentimport.AgentNotification,
) error {
	sender.value = value
	return sender.err
}

type notificationFailure struct {
	code      string
	retryable bool
}

func (failure notificationFailure) Error() string       { return "notification failure" }
func (failure notificationFailure) TencentCode() string { return failure.code }
func (failure notificationFailure) Retryable() bool     { return failure.retryable }

func TestSchedulerMaterializesThenSendsReminderNotification(t *testing.T) {
	now := time.Date(2026, 8, 1, 22, 0, 0, 0, time.UTC)
	repository := &fakeSchedulerRepository{
		materialized: []bool{true, false},
		claimResults: []bool{false, true},
		work: occurrenceport.NotificationWork{
			EventID:  "01989c24-7540-7f12-a27b-c83243215ddf",
			ServerID: serviceServerID, AgentID: serviceAgentID,
			ResourceID: serviceOccurrenceID, RecipientUserID: "a_AGENT",
			Revision: 1, Attempts: 1,
		},
	}
	sender := &fakeNotificationSender{}
	service, err := NewSchedulerService(
		repository,
		sender,
		fixedClock{now: now},
		SchedulerConfig{
			WorkerID: "reminder-worker-1", LeaseTTL: time.Minute,
			MaxAttempts: 8, BaseBackoff: time.Second, MaxBackoff: time.Minute,
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	processed, err := service.ProcessOne(context.Background())
	if err != nil || !processed || sender.value.EventID != "" {
		t.Fatalf("materialize ProcessOne() = (%v, %v), sent=%#v", processed, err, sender.value)
	}
	processed, err = service.ProcessOne(context.Background())
	if err != nil || !processed {
		t.Fatalf("notification ProcessOne() = (%v, %v)", processed, err)
	}
	if sender.value.Type != "reminder.due" ||
		sender.value.ToUserID != "a_AGENT" ||
		sender.value.ServerID != serviceServerID ||
		sender.value.AgentID != serviceAgentID ||
		sender.value.ResourceID != serviceOccurrenceID ||
		sender.value.Revision != 1 ||
		sender.value.EventID != repository.work.EventID {
		t.Fatalf("notification = %#v", sender.value)
	}
	if len(repository.completed) != 3 ||
		repository.completed[0] != repository.work.EventID ||
		repository.completed[1] != "reminder-worker-1" {
		t.Fatalf("completion = %#v", repository.completed)
	}
}

func TestSchedulerRetriesRetryableTencentFailure(t *testing.T) {
	now := time.Date(2026, 8, 1, 22, 0, 0, 0, time.UTC)
	repository := &fakeSchedulerRepository{
		hasWork: true,
		work: occurrenceport.NotificationWork{
			EventID:  "01989c24-7540-7f12-a27b-c83243215ddf",
			ServerID: serviceServerID, AgentID: serviceAgentID,
			ResourceID: serviceOccurrenceID, RecipientUserID: "a_AGENT",
			Revision: 1, Attempts: 2,
		},
	}
	service, err := NewSchedulerService(
		repository,
		&fakeNotificationSender{err: notificationFailure{
			code: "tencent_network_error", retryable: true,
		}},
		fixedClock{now: now},
		SchedulerConfig{
			WorkerID: "reminder-worker-1", LeaseTTL: time.Minute,
			MaxAttempts: 8, BaseBackoff: time.Second, MaxBackoff: time.Minute,
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	processed, err := service.ProcessOne(context.Background())
	if err != nil || !processed {
		t.Fatalf("ProcessOne() = (%v, %v)", processed, err)
	}
	if len(repository.retried) != 5 ||
		repository.retried[3] != "tencent_network_error" ||
		repository.retried[4] != false ||
		!repository.retried[2].(time.Time).Equal(now.Add(2*time.Second)) {
		t.Fatalf("retry = %#v", repository.retried)
	}
}

func TestSchedulerSuppressesReminderWhoseAgentWasDeletedAfterClaim(t *testing.T) {
	now := time.Date(2026, 8, 4, 22, 0, 0, 0, time.UTC)
	current := false
	repository := &fakeSchedulerRepository{
		hasWork: true,
		current: &current,
		work: occurrenceport.NotificationWork{
			EventID: "event-1", ServerID: serviceServerID,
			AgentID: serviceAgentID, ResourceID: serviceOccurrenceID,
			RecipientUserID: "a_AGENT", Revision: 1, Attempts: 1,
		},
	}
	sender := &fakeNotificationSender{}
	service, err := NewSchedulerService(repository, sender, fixedClock{now: now}, SchedulerConfig{
		WorkerID: "reminder-worker-1", LeaseTTL: time.Minute,
		MaxAttempts: 8, BaseBackoff: time.Second, MaxBackoff: time.Minute,
	})
	if err != nil {
		t.Fatal(err)
	}
	processed, err := service.ProcessOne(context.Background())
	if err != nil || !processed {
		t.Fatalf("ProcessOne() = (%v, %v)", processed, err)
	}
	if sender.value.EventID != "" {
		t.Fatalf("stale reminder sent: %#v", sender.value)
	}
	if len(repository.completed) != 3 {
		t.Fatalf("completion = %#v", repository.completed)
	}
}
