package runtimework

import (
	"context"
	"testing"
	"time"

	"chatserver/internal/apperror"
	clockport "chatserver/internal/ports/clock"
	runtimeworkport "chatserver/internal/ports/runtimework"
	workport "chatserver/internal/ports/work"
)

type fakeRepository struct {
	value            workport.Task
	claimNow         time.Time
	updateRevision   int64
	updateStatus     string
	updateStatusTime time.Time
	thread           workport.MessageThread
	reply            workport.ThreadReplyReference
	threadAgentID    string
	replyAgentID     string
	reminder         workport.Reminder
	reminderDraft    workport.ReminderDraft
	reminderPatch    workport.ReminderPatch
	reminderMutation workport.Mutation
	reminderLog      []workport.ReminderLogEntry
	taskListPage     workport.TaskPage
	taskListOptions  workport.TaskListOptions
}

func (repository *fakeRepository) ListRuntimeTasks(
	_ context.Context, _, _ string, options workport.TaskListOptions,
) (workport.TaskPage, error) {
	repository.taskListOptions = options
	if repository.taskListPage.NextID != "" {
		return repository.taskListPage, nil
	}
	return workport.TaskPage{Items: []workport.Task{repository.value}}, nil
}

func (repository *fakeRepository) GetRuntimeTask(
	context.Context, string, string, string,
) (workport.Task, error) {
	return repository.value, nil
}

func (repository *fakeRepository) ClaimRuntimeTask(
	_ context.Context, _, _, _ string, now time.Time,
) (workport.Task, error) {
	repository.claimNow = now
	return repository.value, nil
}

func (repository *fakeRepository) UpdateRuntimeTaskStatus(
	_ context.Context, _, _, _ string, revision int64, status string, now time.Time,
) (workport.Task, error) {
	repository.updateRevision = revision
	repository.updateStatus = status
	repository.updateStatusTime = now
	return repository.value, nil
}

func (repository *fakeRepository) EnsureRuntimeThread(
	_ context.Context,
	agentID string,
	_ workport.Mutation,
	_ string,
	_ workport.ThreadDraft,
) (workport.MessageThread, error) {
	repository.threadAgentID = agentID
	return repository.thread, nil
}

func (repository *fakeRepository) RegisterRuntimeThreadReply(
	_ context.Context,
	agentID string,
	_ workport.Mutation,
	_, _ string,
	_ workport.ThreadReplyDraft,
) (workport.ThreadReplyReference, error) {
	repository.replyAgentID = agentID
	return repository.reply, nil
}

func (repository *fakeRepository) ListRuntimeReminders(
	context.Context, string, string,
) ([]workport.Reminder, error) {
	return []workport.Reminder{repository.reminder}, nil
}

func (repository *fakeRepository) GetRuntimeReminder(
	context.Context, string, string, string,
) (workport.Reminder, error) {
	return repository.reminder, nil
}

func (repository *fakeRepository) CreateRuntimeReminder(
	_ context.Context,
	_ string,
	mutation workport.Mutation,
	draft workport.ReminderDraft,
) (workport.Reminder, error) {
	repository.reminderMutation = mutation
	repository.reminderDraft = draft
	return repository.reminder, nil
}

func (repository *fakeRepository) UpdateRuntimeReminder(
	_ context.Context,
	_ string,
	mutation workport.Mutation,
	_ string,
	_ int64,
	patch workport.ReminderPatch,
) (workport.Reminder, error) {
	repository.reminderMutation = mutation
	repository.reminderPatch = patch
	return repository.reminder, nil
}

func (repository *fakeRepository) ListRuntimeReminderLog(
	context.Context, string, string, string, workport.ReminderLogListOptions,
) (workport.ReminderLogPage, error) {
	return workport.ReminderLogPage{Items: repository.reminderLog}, nil
}

var _ runtimeworkport.Repository = (*fakeRepository)(nil)

type fixedClock struct{ now time.Time }

func (clock fixedClock) Now() time.Time { return clock.now }

var _ clockport.Clock = fixedClock{}

func TestRuntimeTaskCursorIsBoundToAgentAndFilter(t *testing.T) {
	now := time.Date(2026, 8, 2, 8, 0, 0, 123, time.UTC)
	nextID := "0198f4c2-7a34-7e45-913c-6baf30401a83"
	repository := &fakeRepository{taskListPage: workport.TaskPage{NextUpdatedAt: &now, NextID: nextID}}
	service, err := NewService(repository, fixedClock{now: now}, &fixedIDs{})
	if err != nil {
		t.Fatal(err)
	}
	serverID := "0198f4c2-7a31-7c91-a6d2-7d76f9188c38"
	agentID := "0198f4c2-7a33-7e45-913c-6baf30401a82"
	first, err := service.ListTasks(context.Background(), serverID, agentID, workport.TaskListOptions{Limit: 2})
	if err != nil || first.NextCursor == "" {
		t.Fatalf("first page = (%#v, %v)", first, err)
	}
	repository.taskListPage = workport.TaskPage{}
	if _, err := service.ListTasks(context.Background(), serverID, agentID, workport.TaskListOptions{Limit: 2, Cursor: first.NextCursor}); err != nil {
		t.Fatalf("second page error = %v", err)
	}
	if repository.taskListOptions.AfterUpdatedAt == nil || repository.taskListOptions.AfterID != nextID {
		t.Fatalf("decoded options = %#v", repository.taskListOptions)
	}
	otherAgent := "0198f4c2-7a35-7e45-913c-6baf30401a84"
	_, err = service.ListTasks(context.Background(), serverID, otherAgent, workport.TaskListOptions{Limit: 2, Cursor: first.NextCursor})
	if got := apperror.CodeOf(err); got != "invalid_cursor" {
		t.Fatalf("changed-agent cursor code = %q, error=%v", got, err)
	}
}

func TestServiceClaimsAndUpdatesOnlyWithValidRuntimeCommands(t *testing.T) {
	now := time.Date(2026, 8, 1, 15, 0, 0, 0, time.UTC)
	repository := &fakeRepository{value: workport.Task{
		ID: "0198f4c2-7a34-7e45-913c-6baf30401a83",
	}}
	service, err := NewService(repository, fixedClock{now: now}, &fixedIDs{
		values: []string{
			"0198f4c2-7a38-7e45-913c-6baf30401a87",
			"0198f4c2-7a39-7e45-913c-6baf30401a88",
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	serverID := "0198f4c2-7a31-7c91-a6d2-7d76f9188c38"
	agentID := "0198f4c2-7a33-7e45-913c-6baf30401a82"
	taskID := repository.value.ID
	if _, err := service.ClaimTask(
		context.Background(), serverID, agentID, taskID, "claim-1",
	); err != nil {
		t.Fatal(err)
	}
	if !repository.claimNow.Equal(now) {
		t.Fatalf("claimNow = %v", repository.claimNow)
	}
	if _, err := service.UpdateTaskStatus(
		context.Background(), serverID, agentID, taskID,
		4, "done", "update-1",
	); err != nil {
		t.Fatal(err)
	}
	if repository.updateRevision != 4 || repository.updateStatus != "done" ||
		!repository.updateStatusTime.Equal(now) {
		t.Fatalf("update = (%d, %q, %v)", repository.updateRevision, repository.updateStatus, repository.updateStatusTime)
	}
	if _, err := service.UpdateTaskStatus(
		context.Background(), serverID, agentID, taskID,
		4, "closed", "update-2",
	); err == nil {
		t.Fatal("UpdateTaskStatus() accepted Agent-only forbidden status")
	}
}

func TestServiceResolvesAndRegistersRuntimeThreadReferences(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 8, 2, 20, 0, 0, 0, time.UTC)
	repository := &fakeRepository{
		thread: workport.MessageThread{ID: "0198f4c2-7a38-7e45-913c-6baf30401a87"},
		reply:  workport.ThreadReplyReference{ID: "0198f4c2-7a39-7e45-913c-6baf30401a88"},
	}
	service, err := NewService(repository, fixedClock{now: now}, &fixedIDs{values: []string{
		repository.thread.ID, repository.reply.ID,
	}})
	if err != nil {
		t.Fatal(err)
	}
	serverID := "0198f4c2-7a31-7c91-a6d2-7d76f9188c38"
	agentID := "0198f4c2-7a33-7e45-913c-6baf30401a82"
	channelID := "0198f4c2-7a35-7e45-913c-6baf30401a84"
	threadID := repository.thread.ID
	sequence, timestamp := int64(42), int64(1_785_000_000)
	groupID, topicID := "community-1", "topic-general"
	root := workport.MessageRef{
		Kind: "group", MessageID: "root-message-1", GroupID: &groupID,
		TopicID: &topicID, Sequence: &sequence, Timestamp: &timestamp,
	}
	if _, err := service.ResolveThread(
		context.Background(), serverID, agentID, channelID, "resolve-1", root,
	); err != nil {
		t.Fatal(err)
	}
	replySequence := int64(43)
	sender := "agent_builder"
	reply := root
	reply.MessageID = "reply-message-1"
	reply.Sequence = &replySequence
	reply.SenderUserID = &sender
	if _, err := service.RegisterThreadReply(
		context.Background(), serverID, agentID, channelID, threadID, "reply-1", reply,
	); err != nil {
		t.Fatal(err)
	}
	if repository.threadAgentID != agentID || repository.replyAgentID != agentID {
		t.Fatalf("runtime actors = (%q, %q)", repository.threadAgentID, repository.replyAgentID)
	}
}

func TestServiceCreatesSnoozesAndScopesRuntimeReminderWithAnchor(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 8, 2, 21, 0, 0, 0, time.UTC)
	serverID := "0198f4c2-7a31-7c91-a6d2-7d76f9188c38"
	agentID := "0198f4c2-7a33-7e45-913c-6baf30401a82"
	reminderID := "0198f4c2-7a3a-7e45-913c-6baf30401a89"
	channelID := "0198f4c2-7a35-7e45-913c-6baf30401a84"
	sequence, timestamp := int64(42), int64(1_785_000_000)
	groupID, topicID := "community-1", "topic-general"
	anchor := &workport.ReminderAnchor{
		Kind: "message", ChannelID: channelID,
		MessageRef: workport.MessageRef{
			Kind: "group", MessageID: "root-message-1", GroupID: &groupID,
			TopicID: &topicID, Sequence: &sequence, Timestamp: &timestamp,
		},
	}
	repository := &fakeRepository{reminder: workport.Reminder{
		ID: reminderID, ServerID: serverID, AgentID: agentID,
		ScheduleKind: "once", Schedule: now.Add(time.Hour).Format(time.RFC3339),
		Timezone: "Asia/Shanghai", Text: "回到消息处理", Status: "active",
		Revision: 1, Anchor: anchor,
	}}
	service, err := NewService(repository, fixedClock{now: now}, &fixedIDs{
		values: []string{reminderID},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.CreateReminder(
		context.Background(), serverID, agentID, "reminder-create-1",
		workport.ReminderDraft{
			ScheduleKind: "once", Schedule: now.Add(time.Hour).Format(time.RFC3339),
			Timezone: "Asia/Shanghai", Text: "回到消息处理", Anchor: anchor,
		},
	); err != nil {
		t.Fatal(err)
	}
	if repository.reminderDraft.ID != reminderID ||
		repository.reminderDraft.AgentID != agentID ||
		repository.reminderDraft.NextFireAt == nil ||
		!repository.reminderDraft.NextFireAt.Equal(now.Add(time.Hour)) ||
		repository.reminderDraft.Anchor == nil ||
		repository.reminderDraft.Anchor.MessageRef.MessageID != "root-message-1" {
		t.Fatalf("reminder draft = %#v", repository.reminderDraft)
	}
	if _, err := service.SnoozeReminder(
		context.Background(), serverID, agentID, reminderID, 1,
		30*time.Minute, "reminder-snooze-1",
	); err != nil {
		t.Fatal(err)
	}
	if repository.reminderPatch.NextFireAt == nil ||
		*repository.reminderPatch.NextFireAt == nil ||
		!(*repository.reminderPatch.NextFireAt).Equal(now.Add(30*time.Minute)) {
		t.Fatalf("snooze patch = %#v", repository.reminderPatch)
	}
	if _, err := service.CreateReminder(
		context.Background(), serverID, agentID, "reminder-create-2",
		workport.ReminderDraft{
			ScheduleKind: "once", Schedule: now.Add(time.Hour).Format(time.RFC3339),
			Timezone: "Asia/Shanghai", Text: "bad",
			Anchor: &workport.ReminderAnchor{
				Kind: "thread", ChannelID: channelID, MessageRef: anchor.MessageRef,
			},
		},
	); err == nil {
		t.Fatal("CreateReminder accepted thread anchor without threadId")
	}
}

type fixedIDs struct{ values []string }

func (generator *fixedIDs) New() (string, error) {
	value := generator.values[0]
	generator.values = generator.values[1:]
	return value, nil
}
