package workmanagement

import (
	"context"
	"testing"
	"time"

	"chatserver/internal/apperror"
	clockport "chatserver/internal/ports/clock"
	workport "chatserver/internal/ports/work"
)

type fakeRepository struct {
	workport.Repository
	taskMutation  workport.Mutation
	taskDraft     workport.TaskDraft
	taskPatch     workport.TaskPatch
	reminderDraft workport.ReminderDraft
	reminder      workport.Reminder
	reminderPatch workport.ReminderPatch
	taskListPage  workport.TaskPage
	taskListOpts  workport.TaskListOptions
}

func (repository *fakeRepository) ListTasks(
	_ context.Context,
	_, _ string,
	options workport.TaskListOptions,
) (workport.TaskPage, error) {
	repository.taskListOpts = options
	return repository.taskListPage, nil
}

func (repository *fakeRepository) UpdateTask(
	_ context.Context,
	_ workport.Mutation,
	_ string,
	_ int64,
	patch workport.TaskPatch,
) (workport.Task, error) {
	repository.taskPatch = patch
	return workport.Task{
		ID:       "01987be5-3d67-7a10-8ee0-3e1f932b52de",
		ServerID: "01987be5-3d67-7a10-8ee0-3e1f932b52db",
		Number:   1, Title: "处理发布故障", Status: "todo",
		AssignmentRevision: 2,
		CreatedByMemberID:  "01987be5-3d67-7a10-8ee0-3e1f932b52dd",
		UpdatedByMemberID:  "01987be5-3d67-7a10-8ee0-3e1f932b52dd",
		Revision:           2,
	}, nil
}

func (repository *fakeRepository) CreateTask(
	_ context.Context,
	mutation workport.Mutation,
	draft workport.TaskDraft,
) (workport.Task, error) {
	repository.taskMutation = mutation
	repository.taskDraft = draft
	return workport.Task{
		ID: draft.ID, ServerID: mutation.ServerID, Number: 1,
		Title: draft.Title, Status: "todo", AssignmentRevision: 1,
		CreatedByMemberID: "01987be5-3d67-7a10-8ee0-3e1f932b52dd",
		UpdatedByMemberID: "01987be5-3d67-7a10-8ee0-3e1f932b52dd",
		Revision:          1, CreatedAt: mutation.Now, UpdatedAt: mutation.Now,
	}, nil
}

func (repository *fakeRepository) CreateReminder(
	_ context.Context,
	mutation workport.Mutation,
	draft workport.ReminderDraft,
) (workport.Reminder, error) {
	repository.reminderDraft = draft
	return workport.Reminder{
		ID: draft.ID, ServerID: mutation.ServerID, AgentID: draft.AgentID,
		CreatedByMemberID: "01987be5-3d67-7a10-8ee0-3e1f932b52dd",
		ScheduleKind:      draft.ScheduleKind, Schedule: draft.Schedule,
		Timezone: draft.Timezone, Text: draft.Text, Status: "active",
		NextFireAt: draft.NextFireAt, Revision: 1,
		CreatedAt: mutation.Now, UpdatedAt: mutation.Now,
	}, nil
}

func (repository *fakeRepository) GetReminder(
	_ context.Context,
	_, _, _ string,
) (workport.Reminder, error) {
	return repository.reminder, nil
}

func (repository *fakeRepository) UpdateReminder(
	_ context.Context,
	_ workport.Mutation,
	_ string,
	_ int64,
	patch workport.ReminderPatch,
) (workport.Reminder, error) {
	repository.reminderPatch = patch
	return repository.reminder, nil
}

type fixedIDs struct{ values []string }

func (ids *fixedIDs) New() (string, error) {
	value := ids.values[0]
	ids.values = ids.values[1:]
	return value, nil
}

type fixedClock struct{ now time.Time }

func (clock fixedClock) Now() time.Time { return clock.now }

var _ clockport.Clock = fixedClock{}

func TestListTasksUsesBoundOpaqueCursor(t *testing.T) {
	now := time.Date(2026, 8, 2, 8, 0, 0, 123, time.UTC)
	nextID := "01987be5-3d67-7a10-8ee0-3e1f932b52de"
	repository := &fakeRepository{taskListPage: workport.TaskPage{
		NextUpdatedAt: &now, NextID: nextID,
	}}
	service, err := NewService(repository, &fixedIDs{}, fixedClock{now: now})
	if err != nil {
		t.Fatal(err)
	}
	accountID := "01987be5-3d67-7a10-8ee0-3e1f932b52dc"
	serverID := "01987be5-3d67-7a10-8ee0-3e1f932b52db"
	ownerID := "01987be5-3d67-7a10-8ee0-3e1f932b52dd"
	first, err := service.ListTasks(context.Background(), accountID, serverID, workport.TaskListOptions{
		Limit: 2, OwnerMemberID: &ownerID,
	})
	if err != nil || first.NextCursor == "" {
		t.Fatalf("first page = (%#v, %v)", first, err)
	}
	repository.taskListPage = workport.TaskPage{}
	if _, err := service.ListTasks(context.Background(), accountID, serverID, workport.TaskListOptions{
		Limit: 2, OwnerMemberID: &ownerID, Cursor: first.NextCursor,
	}); err != nil {
		t.Fatalf("second page error = %v", err)
	}
	if repository.taskListOpts.AfterUpdatedAt == nil || repository.taskListOpts.AfterID != nextID {
		t.Fatalf("decoded options = %#v", repository.taskListOpts)
	}
	otherOwner := "01987be5-3d67-7a10-8ee0-3e1f932b52df"
	_, err = service.ListTasks(context.Background(), accountID, serverID, workport.TaskListOptions{
		Limit: 2, OwnerMemberID: &otherOwner, Cursor: first.NextCursor,
	})
	if got := apperror.CodeOf(err); got != "invalid_cursor" {
		t.Fatalf("changed-filter cursor code = %q, error=%v", got, err)
	}
}

func TestCreateTaskNormalizesInputAndBuildsStableMutation(t *testing.T) {
	repository := &fakeRepository{}
	service, err := NewService(
		repository,
		&fixedIDs{values: []string{"01987be5-3d67-7a10-8ee0-3e1f932b52de"}},
		fixedClock{now: time.Date(2026, 7, 30, 12, 0, 0, 0, time.UTC)},
	)
	if err != nil {
		t.Fatalf("NewService() error = %v", err)
	}
	description := " 交付首版 "
	task, err := service.CreateTask(context.Background(), CreateTaskCommand{
		AccountID:      "01987be5-3d67-7a10-8ee0-3e1f932b52dc",
		ServerID:       "01987be5-3d67-7a10-8ee0-3e1f932b52db",
		IdempotencyKey: "task-create-1",
		Title:          " 完成 TUI ",
		Description:    &description,
	})
	if err != nil {
		t.Fatalf("CreateTask() error = %v", err)
	}
	if task.Title != "完成 TUI" ||
		repository.taskDraft.Description == nil ||
		*repository.taskDraft.Description != "交付首版" {
		t.Fatalf("task = %#v draft = %#v", task, repository.taskDraft)
	}
	if repository.taskMutation.RequestHash == [32]byte{} {
		t.Fatal("request hash is empty")
	}
}

func TestCreateAssignedTaskAllocatesDurableNotificationOperation(t *testing.T) {
	repository := &fakeRepository{}
	operationID := "01987be5-3d67-7a10-8ee0-3e1f932b52df"
	service, err := NewService(
		repository,
		&fixedIDs{values: []string{
			"01987be5-3d67-7a10-8ee0-3e1f932b52de",
			operationID,
		}},
		fixedClock{now: time.Date(2026, 7, 30, 12, 0, 0, 0, time.UTC)},
	)
	if err != nil {
		t.Fatal(err)
	}
	ownerID := "01987be5-3d67-7a10-8ee0-3e1f932b52da"
	if _, err := service.CreateTask(
		context.Background(),
		CreateTaskCommand{
			AccountID:      "01987be5-3d67-7a10-8ee0-3e1f932b52dc",
			ServerID:       "01987be5-3d67-7a10-8ee0-3e1f932b52db",
			IdempotencyKey: "task-create-assigned-1",
			Title:          "处理发布故障", OwnerMemberID: &ownerID,
		},
	); err != nil {
		t.Fatal(err)
	}
	if repository.taskDraft.NotificationOperationID == nil ||
		*repository.taskDraft.NotificationOperationID != operationID {
		t.Fatalf("notification operation = %#v", repository.taskDraft.NotificationOperationID)
	}
}

func TestAssignTaskAllocatesDurableNotificationOperation(t *testing.T) {
	repository := &fakeRepository{}
	operationID := "01987be5-3d67-7a10-8ee0-3e1f932b52df"
	service, err := NewService(
		repository,
		&fixedIDs{values: []string{operationID}},
		fixedClock{now: time.Date(2026, 7, 30, 12, 0, 0, 0, time.UTC)},
	)
	if err != nil {
		t.Fatal(err)
	}
	ownerID := "01987be5-3d67-7a10-8ee0-3e1f932b52da"
	owner := &ownerID
	if _, err := service.UpdateTask(
		context.Background(),
		UpdateTaskCommand{
			AccountID:      "01987be5-3d67-7a10-8ee0-3e1f932b52dc",
			ServerID:       "01987be5-3d67-7a10-8ee0-3e1f932b52db",
			TaskID:         "01987be5-3d67-7a10-8ee0-3e1f932b52de",
			IdempotencyKey: "task-assign-1", Revision: 1,
			Patch: workport.TaskPatch{OwnerMemberID: &owner},
		},
	); err != nil {
		t.Fatal(err)
	}
	if repository.taskPatch.NotificationOperationID == nil ||
		*repository.taskPatch.NotificationOperationID != operationID {
		t.Fatalf("notification operation = %#v", repository.taskPatch.NotificationOperationID)
	}
}

func TestCreateOnceReminderParsesFutureRFC3339FireTime(t *testing.T) {
	repository := &fakeRepository{}
	service, err := NewService(
		repository,
		&fixedIDs{values: []string{"01987be5-3d67-7a10-8ee0-3e1f932b52df"}},
		fixedClock{now: time.Date(2026, 7, 30, 12, 0, 0, 0, time.UTC)},
	)
	if err != nil {
		t.Fatalf("NewService() error = %v", err)
	}
	_, err = service.CreateReminder(context.Background(), CreateReminderCommand{
		AccountID:      "01987be5-3d67-7a10-8ee0-3e1f932b52dc",
		ServerID:       "01987be5-3d67-7a10-8ee0-3e1f932b52db",
		IdempotencyKey: "reminder-create-1",
		AgentID:        "01987be5-3d67-7a10-8ee0-3e1f932b52da",
		ScheduleKind:   "once",
		Schedule:       "2026-07-30T13:00:00Z",
		Timezone:       "Asia/Shanghai",
		Text:           "提醒 Agent 汇报",
	})
	if err != nil {
		t.Fatalf("CreateReminder() error = %v", err)
	}
	if repository.reminderDraft.NextFireAt == nil ||
		!repository.reminderDraft.NextFireAt.Equal(
			time.Date(2026, 7, 30, 13, 0, 0, 0, time.UTC),
		) {
		t.Fatalf("next fire = %#v", repository.reminderDraft.NextFireAt)
	}
}

func TestCreateCronReminderComputesInitialFireInConfiguredTimezone(t *testing.T) {
	repository := &fakeRepository{}
	service, err := NewService(
		repository,
		&fixedIDs{values: []string{"01987be5-3d67-7a10-8ee0-3e1f932b52df"}},
		fixedClock{now: time.Date(2026, 7, 30, 12, 0, 0, 0, time.UTC)},
	)
	if err != nil {
		t.Fatal(err)
	}
	_, err = service.CreateReminder(context.Background(), CreateReminderCommand{
		AccountID:      "01987be5-3d67-7a10-8ee0-3e1f932b52dc",
		ServerID:       "01987be5-3d67-7a10-8ee0-3e1f932b52db",
		IdempotencyKey: "reminder-create-cron-1",
		AgentID:        "01987be5-3d67-7a10-8ee0-3e1f932b52da",
		ScheduleKind:   "cron",
		Schedule:       "30 20 * * *",
		Timezone:       "Asia/Shanghai",
		Text:           "每日汇报",
	})
	if err != nil {
		t.Fatalf("CreateReminder() error = %v", err)
	}
	if repository.reminderDraft.NextFireAt == nil ||
		!repository.reminderDraft.NextFireAt.Equal(
			time.Date(2026, 7, 30, 12, 30, 0, 0, time.UTC),
		) {
		t.Fatalf("next fire = %#v", repository.reminderDraft.NextFireAt)
	}
}

func TestUpdateReminderRecomputesNextFireForPauseAndResume(t *testing.T) {
	now := time.Date(2026, 7, 30, 12, 0, 0, 0, time.UTC)
	repository := &fakeRepository{reminder: workport.Reminder{
		ID:           "01987be5-3d67-7a10-8ee0-3e1f932b52df",
		ServerID:     "01987be5-3d67-7a10-8ee0-3e1f932b52db",
		ScheduleKind: "cron",
		Schedule:     "30 20 * * *",
		Timezone:     "Asia/Shanghai",
		Status:       "paused",
		Revision:     1,
	}}
	service, err := NewService(
		repository,
		&fixedIDs{},
		fixedClock{now: now},
	)
	if err != nil {
		t.Fatal(err)
	}
	status := "active"
	_, err = service.UpdateReminder(context.Background(), UpdateReminderCommand{
		AccountID:      "01987be5-3d67-7a10-8ee0-3e1f932b52dc",
		ServerID:       repository.reminder.ServerID,
		ReminderID:     repository.reminder.ID,
		IdempotencyKey: "reminder-resume-1",
		Revision:       1,
		Patch:          workport.ReminderPatch{Status: &status},
	})
	if err != nil {
		t.Fatalf("UpdateReminder() error = %v", err)
	}
	if repository.reminderPatch.NextFireAt == nil ||
		*repository.reminderPatch.NextFireAt == nil ||
		!(*repository.reminderPatch.NextFireAt).Equal(
			time.Date(2026, 7, 30, 12, 30, 0, 0, time.UTC),
		) {
		t.Fatalf("resume next fire = %#v", repository.reminderPatch.NextFireAt)
	}
}
