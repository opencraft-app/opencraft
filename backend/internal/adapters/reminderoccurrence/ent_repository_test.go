package reminderoccurrence

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"chatserver/internal/config"
	"chatserver/internal/database"
	"chatserver/internal/database/migration"
	"chatserver/internal/ent"
	"chatserver/internal/ent/outboxevent"
	occurrenceport "chatserver/internal/ports/reminderoccurrence"
)

const (
	testServerID   = "0198f4c2-7a31-7c91-a6d2-7d76f9188c38"
	testMemberID   = "0198f4c2-7a32-7d02-b8c1-3f6e15aa91b4"
	testAgentID    = "0198f4c2-7a33-7e45-913c-6baf30401a82"
	onceReminderID = "0198f4c2-7a36-7e45-913c-6baf30401a85"
	cronReminderID = "0198f4c2-7a37-7e45-913c-6baf30401a86"
	onceOccurrence = "0198f4c2-7a38-7e45-913c-6baf30401a87"
	cronOccurrence = "0198f4c2-7a39-7e45-913c-6baf30401a88"
	onceOutbox     = "0198f4c2-7a3a-7e45-913c-6baf30401a89"
	cronOutbox     = "0198f4c2-7a3b-7e45-913c-6baf30401a8a"
)

var testNow = time.Date(2026, 7, 30, 14, 2, 0, 0, time.UTC)

type sequenceIDs struct {
	values []string
}

func (ids *sequenceIDs) New() (string, error) {
	value := ids.values[0]
	ids.values = ids.values[1:]
	return value, nil
}

func TestEntRepositoryMaterializesDueRemindersAndAcknowledgesOccurrence(t *testing.T) {
	repository, handle := openRepository(t)
	seedReminder(t, handle, onceReminderID, "once", "2026-07-30T14:01:00Z", testNow.Add(-time.Minute))
	seedReminder(t, handle, cronReminderID, "cron", "*/5 * * * *", testNow.Add(-time.Minute))

	processed, err := repository.ProcessOne(context.Background(), testNow)
	if err != nil || !processed {
		t.Fatalf("ProcessOne(once) = (%v, %v)", processed, err)
	}
	processed, err = repository.ProcessOne(context.Background(), testNow)
	if err != nil || !processed {
		t.Fatalf("ProcessOne(cron) = (%v, %v)", processed, err)
	}
	processed, err = repository.ProcessOne(context.Background(), testNow)
	if err != nil || processed {
		t.Fatalf("ProcessOne(empty) = (%v, %v)", processed, err)
	}
	outboxes, err := handle.Client().OutboxEvent.Query().
		Where(outboxevent.EventTypeEQ("reminder.agent-notification.requested")).
		Order(ent.Asc(outboxevent.FieldID)).
		All(context.Background())
	if err != nil || len(outboxes) != 2 ||
		outboxes[0].AggregateType != "reminder_occurrence" ||
		outboxes[0].AggregateID != onceOccurrence ||
		outboxes[0].State != "pending" ||
		outboxes[1].AggregateID != cronOccurrence {
		t.Fatalf("outboxes = (%#v, %v)", outboxes, err)
	}

	once, err := handle.Client().Reminder.Get(context.Background(), onceReminderID)
	if err != nil || once.Status != "completed" || once.NextFireAt != nil {
		t.Fatalf("once reminder = (%#v, %v)", once, err)
	}
	cronValue, err := handle.Client().Reminder.Get(context.Background(), cronReminderID)
	if err != nil || cronValue.Status != "active" ||
		cronValue.NextFireAt == nil ||
		!cronValue.NextFireAt.Equal(
			time.Date(2026, 7, 30, 14, 5, 0, 0, time.UTC),
		) {
		t.Fatalf("cron reminder = (%#v, %v)", cronValue, err)
	}

	due, err := repository.ListDue(
		context.Background(),
		testServerID,
		testAgentID,
		occurrenceport.ListOptions{Limit: 10},
	)
	if err != nil || len(due.Items) != 2 ||
		due.Items[0].ID != onceOccurrence ||
		due.Items[1].ID != cronOccurrence ||
		due.Items[0].Text != "remind "+onceReminderID {
		t.Fatalf("due = (%#v, %v)", due, err)
	}
	resultCode := "handled"
	acknowledged, err := repository.Acknowledge(
		context.Background(),
		testServerID,
		testAgentID,
		onceOccurrence,
		&resultCode,
		testNow.Add(time.Minute),
	)
	if err != nil || acknowledged.State != "acknowledged" ||
		acknowledged.AcknowledgedAt == nil ||
		acknowledged.ResultCode == nil ||
		*acknowledged.ResultCode != resultCode {
		t.Fatalf("acknowledged = (%#v, %v)", acknowledged, err)
	}
	remaining, err := repository.ListDue(
		context.Background(),
		testServerID,
		testAgentID,
		occurrenceport.ListOptions{
			Limit: 10, AfterScheduledFireAt: &due.Items[0].ScheduledFireAt, AfterID: onceOccurrence,
		},
	)
	if err != nil || len(remaining.Items) != 1 || remaining.Items[0].ID != cronOccurrence {
		t.Fatalf("remaining = (%#v, %v)", remaining, err)
	}
}

func TestEntRepositoryClaimsCompletesAndRetriesReminderNotifications(t *testing.T) {
	repository, handle := openRepository(t)
	seedAgent(t, handle)
	seedReminder(t, handle, onceReminderID, "once", "2026-07-30T14:01:00Z", testNow.Add(-time.Minute))
	if processed, err := repository.ProcessOne(context.Background(), testNow); err != nil || !processed {
		t.Fatalf("ProcessOne() = (%v, %v)", processed, err)
	}
	claim := occurrenceport.NotificationClaim{
		LeaseOwner:     "reminder-worker-1",
		Now:            testNow,
		LeaseExpiresAt: testNow.Add(time.Minute),
	}
	work, ok, err := repository.ClaimNotification(context.Background(), claim)
	if err != nil || !ok || work.EventID != onceOutbox ||
		work.ServerID != testServerID || work.AgentID != testAgentID ||
		work.ResourceID != onceOccurrence || work.RecipientUserID != "a_REMINDER" ||
		work.Revision != 1 || work.Attempts != 1 {
		t.Fatalf("ClaimNotification() = (%#v, %v, %v)", work, ok, err)
	}
	if err := repository.RetryNotification(
		context.Background(),
		work.EventID,
		claim.LeaseOwner,
		testNow.Add(time.Minute),
		"tencent_network_error",
		false,
	); err != nil {
		t.Fatal(err)
	}
	if _, ok, err := repository.ClaimNotification(
		context.Background(),
		occurrenceport.NotificationClaim{
			LeaseOwner:     claim.LeaseOwner,
			Now:            testNow.Add(30 * time.Second),
			LeaseExpiresAt: testNow.Add(90 * time.Second),
		},
	); err != nil || ok {
		t.Fatalf("early retry claim = (%v, %v)", ok, err)
	}
	work, ok, err = repository.ClaimNotification(
		context.Background(),
		occurrenceport.NotificationClaim{
			LeaseOwner:     claim.LeaseOwner,
			Now:            testNow.Add(time.Minute),
			LeaseExpiresAt: testNow.Add(2 * time.Minute),
		},
	)
	if err != nil || !ok || work.Attempts != 2 {
		t.Fatalf("retry ClaimNotification() = (%#v, %v, %v)", work, ok, err)
	}
	if err := repository.CompleteNotification(
		context.Background(),
		work.EventID,
		claim.LeaseOwner,
		testNow.Add(time.Minute),
	); err != nil {
		t.Fatal(err)
	}
	event, err := handle.Client().OutboxEvent.Get(context.Background(), work.EventID)
	if err != nil || event.State != "processed" || event.ProcessedAt == nil ||
		event.LeaseOwner != nil || event.LeaseExpiresAt != nil {
		t.Fatalf("completed event = (%#v, %v)", event, err)
	}
}

func openRepository(t *testing.T) (*EntRepository, *database.Handle) {
	t.Helper()
	cfg, err := config.NewDatabase(filepath.Join(t.TempDir(), "data", "chatserver.db"))
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
	repository, err := NewEntRepository(
		handle,
		&sequenceIDs{values: []string{
			onceOccurrence, onceOutbox, cronOccurrence, cronOutbox,
		}},
	)
	if err != nil {
		t.Fatal(err)
	}
	return repository, handle
}

func seedAgent(t *testing.T, handle *database.Handle) {
	t.Helper()
	if _, err := handle.Client().Agent.Create().
		SetID(testAgentID).
		SetServerID(testServerID).
		SetImUserID("a_REMINDER").
		SetRuntimeKind("codex").
		SetReplyPolicy("mention_and_dm").
		SetDesiredState("running").
		SetObservedState("running").
		SetCredentialVersion(1).
		SetImState("ready").
		SetCreatedByMemberID(testMemberID).
		SetRevision(1).
		SetCreatedAt(testNow.Add(-time.Hour)).
		SetUpdatedAt(testNow.Add(-time.Hour)).
		Save(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func seedReminder(
	t *testing.T,
	handle *database.Handle,
	id string,
	kind string,
	expression string,
	fireAt time.Time,
) {
	t.Helper()
	_, err := handle.Client().Reminder.Create().
		SetID(id).
		SetServerID(testServerID).
		SetAgentID(testAgentID).
		SetCreatedByMemberID(testMemberID).
		SetScheduleKind(kind).
		SetSchedule(expression).
		SetTimezone("UTC").
		SetText("remind " + id).
		SetStatus("active").
		SetNextFireAt(fireAt).
		SetRevision(1).
		SetCreatedAt(testNow.Add(-time.Hour)).
		SetUpdatedAt(testNow.Add(-time.Hour)).
		Save(context.Background())
	if err != nil {
		t.Fatal(err)
	}
}
