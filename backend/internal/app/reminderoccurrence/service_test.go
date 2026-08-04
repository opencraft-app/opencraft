package reminderoccurrence

import (
	"context"
	"testing"
	"time"

	occurrenceport "chatserver/internal/ports/reminderoccurrence"
)

const (
	serviceServerID     = "0198f4c2-7a31-7c91-a6d2-7d76f9188c38"
	serviceAgentID      = "0198f4c2-7a33-7e45-913c-6baf30401a82"
	serviceOccurrenceID = "0198f4c2-7a38-7e45-913c-6baf30401a87"
)

type fakeRepository struct {
	occurrenceport.Repository
	listArgs []any
	ackArgs  []any
	values   []occurrenceport.Occurrence
	page     occurrenceport.Page
}

func (repository *fakeRepository) ListDue(
	_ context.Context,
	serverID string,
	agentID string,
	options occurrenceport.ListOptions,
) (occurrenceport.Page, error) {
	repository.listArgs = []any{serverID, agentID, options}
	if len(repository.page.Items) != 0 || repository.page.NextID != "" {
		return repository.page, nil
	}
	return occurrenceport.Page{Items: repository.values}, nil
}

func (repository *fakeRepository) Acknowledge(
	_ context.Context,
	serverID string,
	agentID string,
	occurrenceID string,
	resultCode *string,
	now time.Time,
) (occurrenceport.Occurrence, error) {
	repository.ackArgs = []any{
		serverID, agentID, occurrenceID, resultCode, now,
	}
	return repository.values[0], nil
}

type fixedClock struct{ now time.Time }

func (clock fixedClock) Now() time.Time { return clock.now }

func TestServiceListsAndAcknowledgesCurrentAgentOccurrences(t *testing.T) {
	now := time.Date(2026, 7, 30, 14, 5, 0, 0, time.UTC)
	repository := &fakeRepository{values: []occurrenceport.Occurrence{{
		ID: serviceOccurrenceID, ServerID: serviceServerID, AgentID: serviceAgentID,
		State: "due", Text: "汇报",
	}}}
	service, err := NewService(repository, fixedClock{now: now})
	if err != nil {
		t.Fatal(err)
	}
	values, err := service.List(
		context.Background(),
		serviceServerID,
		serviceAgentID,
		0,
		"",
	)
	if err != nil || len(values.Items) != 1 ||
		len(repository.listArgs) != 3 || repository.listArgs[2].(occurrenceport.ListOptions).Limit != 50 {
		t.Fatalf("List() = (%#v, %v), args = %#v", values, err, repository.listArgs)
	}
	resultCode := " handled "
	value, err := service.Acknowledge(
		context.Background(),
		serviceServerID,
		serviceAgentID,
		serviceOccurrenceID,
		"ack-1",
		&resultCode,
	)
	if err != nil || value.ID != serviceOccurrenceID {
		t.Fatalf("Acknowledge() = (%#v, %v)", value, err)
	}
	gotResult := repository.ackArgs[3].(*string)
	if *gotResult != "handled" || !repository.ackArgs[4].(time.Time).Equal(now) {
		t.Fatalf("ack args = %#v", repository.ackArgs)
	}
}

func TestServiceRejectsInvalidCursorLimitAndResultCode(t *testing.T) {
	service, err := NewService(&fakeRepository{}, fixedClock{now: time.Now()})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.List(
		context.Background(), serviceServerID, serviceAgentID, 101, "",
	); err == nil {
		t.Fatal("expected invalid limit")
	}
	if _, err := service.List(
		context.Background(), serviceServerID, serviceAgentID, 10, "not-a-v7",
	); err == nil {
		t.Fatal("expected invalid cursor")
	}
	tooLong := string(make([]byte, 65))
	if _, err := service.Acknowledge(
		context.Background(),
		serviceServerID,
		serviceAgentID,
		serviceOccurrenceID,
		"ack-1",
		&tooLong,
	); err == nil {
		t.Fatal("expected invalid result code")
	}
}
