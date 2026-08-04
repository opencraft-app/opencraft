package httptransport

import (
	"context"
	"testing"
	"time"

	"chatserver/internal/api/openapi"
	appwork "chatserver/internal/app/workmanagement"
	workport "chatserver/internal/ports/work"

	"github.com/google/uuid"
)

const (
	handlerTaskID          = "0198f4c2-7a36-7af3-a01e-0fcb31e9d84e"
	handlerReminderID      = "0198f4c2-7a37-7af3-a01e-0fcb31e9d84f"
	handlerThreadChannelID = "0198f4c2-7a38-7af3-a01e-0fcb31e9d850"
	handlerThreadID        = "0198f4c2-7a39-7af3-a01e-0fcb31e9d851"
	handlerReplyID         = "0198f4c2-7a3a-7af3-a01e-0fcb31e9d852"
)

type fakeWorkService struct {
	createTaskCommand     appwork.CreateTaskCommand
	updateTaskCommand     appwork.UpdateTaskCommand
	createReminderCommand appwork.CreateReminderCommand
	updateReminderCommand appwork.UpdateReminderCommand
	cancelReminderID      string
	task                  workport.Task
	reminder              workport.Reminder
	inbox                 []workport.InboxItem
	activity              []workport.ActivityItem
	ensureThreadCommand   appwork.EnsureThreadCommand
	registerReplyCommand  appwork.RegisterThreadReplyCommand
	markReadRefID         string
	thread                workport.MessageThread
	threadReply           workport.ThreadReplyReference
}

func (service *fakeWorkService) ListTasks(
	context.Context, string, string, workport.TaskListOptions,
) (workport.TaskPage, error) {
	return workport.TaskPage{Items: []workport.Task{service.task}}, nil
}

func (service *fakeWorkService) GetTask(
	context.Context, string, string, string,
) (workport.Task, error) {
	return service.task, nil
}

func (service *fakeWorkService) CreateTask(
	_ context.Context,
	command appwork.CreateTaskCommand,
) (workport.Task, error) {
	service.createTaskCommand = command
	return service.task, nil
}

func (service *fakeWorkService) UpdateTask(
	_ context.Context,
	command appwork.UpdateTaskCommand,
) (workport.Task, error) {
	service.updateTaskCommand = command
	return service.task, nil
}

func (service *fakeWorkService) ListReminders(
	context.Context, string, string,
) ([]workport.Reminder, error) {
	return []workport.Reminder{service.reminder}, nil
}

func (service *fakeWorkService) GetReminder(
	context.Context, string, string, string,
) (workport.Reminder, error) {
	return service.reminder, nil
}

func (service *fakeWorkService) CreateReminder(
	_ context.Context,
	command appwork.CreateReminderCommand,
) (workport.Reminder, error) {
	service.createReminderCommand = command
	return service.reminder, nil
}

func (service *fakeWorkService) UpdateReminder(
	_ context.Context,
	command appwork.UpdateReminderCommand,
) (workport.Reminder, error) {
	service.updateReminderCommand = command
	return service.reminder, nil
}

func (service *fakeWorkService) CancelReminder(
	_ context.Context,
	_, _, reminderID string, _ int64, _ string,
) error {
	service.cancelReminderID = reminderID
	return nil
}

func (service *fakeWorkService) ListInbox(
	context.Context, string, string,
) ([]workport.InboxItem, error) {
	return service.inbox, nil
}

func (service *fakeWorkService) ListActivity(
	context.Context, string, string,
) ([]workport.ActivityItem, error) {
	return service.activity, nil
}

func (service *fakeWorkService) EnsureThread(
	_ context.Context,
	command appwork.EnsureThreadCommand,
) (workport.MessageThread, error) {
	service.ensureThreadCommand = command
	return service.thread, nil
}

func (service *fakeWorkService) GetThread(
	context.Context, string, string, string, string,
) (workport.MessageThread, error) {
	return service.thread, nil
}

func (service *fakeWorkService) ListThreadReplies(
	context.Context, string, string, string, string, string, int,
) (workport.ThreadReplyPage, error) {
	return workport.ThreadReplyPage{
		Items: []workport.ThreadReplyReference{service.threadReply},
	}, nil
}

func (service *fakeWorkService) RegisterThreadReply(
	_ context.Context,
	command appwork.RegisterThreadReplyCommand,
) (workport.ThreadReplyReference, error) {
	service.registerReplyCommand = command
	return service.threadReply, nil
}

func (service *fakeWorkService) MarkThreadRead(
	_ context.Context,
	_, _, _, _, lastReadRefID, _ string,
) error {
	service.markReadRefID = lastReadRefID
	return nil
}

func TestWorkHandlerMapsTaskCommandsAndViews(t *testing.T) {
	now := time.Date(2026, 7, 30, 15, 0, 0, 0, time.UTC)
	groupID := "@TGS#_C_HANDLER"
	topicID := groupID + "@TOPIC#_HANDLER"
	ownerMemberID := handlerMemberID
	taskValue := workport.Task{
		ID: handlerTaskID, ServerID: handlerServerID, Number: 7,
		Title: "完成 Work 面板", Status: "in_progress",
		OwnerMemberID: &ownerMemberID, AssignmentRevision: 2,
		CreatedByMemberID: handlerMemberID,
		UpdatedByMemberID: handlerMemberID,
		SourceMessageRef: &workport.MessageRef{
			Kind: "group", MessageID: "144115",
			GroupID: &groupID, TopicID: &topicID,
		},
		Revision: 3, CreatedAt: now, UpdatedAt: now,
	}
	service := &fakeWorkService{
		task: taskValue,
		inbox: []workport.InboxItem{{
			ID: handlerTaskID, ServerID: handlerServerID, Kind: "task",
			Title: "#7 完成 Work 面板", Status: "in_progress",
			ResourceID: handlerTaskID, UpdatedAt: now,
		}},
		activity: []workport.ActivityItem{{
			ID: handlerTaskID, ServerID: handlerServerID, Kind: "task.changed",
			ResourceType: "task", ResourceID: handlerTaskID,
			Summary: "Task #7 · 完成 Work 面板 · in_progress", OccurredAt: now,
		}},
	}
	handler, err := NewWorkHandler(service)
	if err != nil {
		t.Fatal(err)
	}
	ownerID := uuid.MustParse(handlerMemberID)
	response, err := handler.CreateTask(
		currentHumanContext(t),
		openapi.CreateTaskRequestObject{
			ServerId: uuid.MustParse(handlerServerID),
			Params: openapi.CreateTaskParams{
				IdempotencyKey: "task-create-0001",
			},
			Body: &openapi.CreateTaskRequest{
				Title: "完成 Work 面板", OwnerMemberId: &ownerID,
				SourceMessageRef: &openapi.IMMessageRef{
					Kind:      openapi.IMMessageRefKind("group"),
					MessageId: "144115", GroupId: &groupID, TopicId: &topicID,
				},
			},
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	created, ok := response.(openapi.CreateTask201JSONResponse)
	if !ok || created.Id.String() != handlerTaskID ||
		service.createTaskCommand.AccountID != handlerAccountID ||
		service.createTaskCommand.OwnerMemberID == nil ||
		service.createTaskCommand.SourceMessageRef == nil {
		t.Fatalf(
			"CreateTask() = %#v command=%#v",
			response,
			service.createTaskCommand,
		)
	}
	status := openapi.UpdateTaskRequestStatus("done")
	if _, err := handler.UpdateTask(
		currentHumanContext(t),
		openapi.UpdateTaskRequestObject{
			ServerId: uuid.MustParse(handlerServerID),
			TaskId:   uuid.MustParse(handlerTaskID),
			Params: openapi.UpdateTaskParams{
				XResourceRevision: 3, IdempotencyKey: "task-update-0001",
			},
			Body: &openapi.UpdateTaskRequest{Status: &status},
		},
	); err != nil {
		t.Fatal(err)
	}
	if service.updateTaskCommand.Revision != 3 ||
		service.updateTaskCommand.Patch.Status == nil ||
		*service.updateTaskCommand.Patch.Status != "done" {
		t.Fatalf("update command = %#v", service.updateTaskCommand)
	}
	inboxResponse, err := handler.ListInbox(
		currentHumanContext(t),
		openapi.ListInboxRequestObject{
			ServerId: uuid.MustParse(handlerServerID),
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	inbox, ok := inboxResponse.(openapi.ListInbox200JSONResponse)
	if !ok || len(inbox) != 1 || inbox[0].ResourceId.String() != handlerTaskID {
		t.Fatalf("ListInbox() = %#v", inboxResponse)
	}
	activityResponse, err := handler.ListActivity(
		currentHumanContext(t),
		openapi.ListActivityRequestObject{
			ServerId: uuid.MustParse(handlerServerID),
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	activity, ok := activityResponse.(openapi.ListActivity200JSONResponse)
	if !ok || len(activity) != 1 ||
		activity[0].ResourceId.String() != handlerTaskID {
		t.Fatalf("ListActivity() = %#v", activityResponse)
	}
}

func TestWorkHandlerMapsThreadReferenceOperationsWithoutMessageBody(
	t *testing.T,
) {
	now := time.Date(2026, 7, 31, 8, 0, 0, 0, time.UTC)
	sequence, timestamp := int64(100), int64(1_785_484_800)
	groupID := "@TGS#_C_HANDLER"
	topicID := groupID + "@TOPIC#_THREAD"
	ref := workport.MessageRef{
		Kind: "group", MessageID: "root-message",
		GroupID: &groupID, TopicID: &topicID,
		Sequence: &sequence, Timestamp: &timestamp,
	}
	service := &fakeWorkService{
		thread: workport.MessageThread{
			ID: handlerThreadID, ServerID: handlerServerID,
			ChannelID: handlerThreadChannelID, RootMessageRef: ref,
			CreatedAt: now,
		},
		threadReply: workport.ThreadReplyReference{
			ID: handlerReplyID, ThreadID: handlerThreadID,
			MessageRef: ref, CreatedAt: now,
		},
	}
	handler, err := NewWorkHandler(service)
	if err != nil {
		t.Fatal(err)
	}
	openRef := openapi.ThreadMessageRef{
		Kind:      openapi.ThreadMessageRefKind("group"),
		MessageId: "root-message", GroupId: &groupID, TopicId: &topicID,
		Sequence: sequence, Timestamp: timestamp,
	}
	response, err := handler.EnsureMessageThread(
		currentHumanContext(t),
		openapi.EnsureMessageThreadRequestObject{
			ServerId:  uuid.MustParse(handlerServerID),
			ChannelId: uuid.MustParse(handlerThreadChannelID),
			Params: openapi.EnsureMessageThreadParams{
				IdempotencyKey: "thread-ensure-0001",
			},
			Body: &openapi.EnsureMessageThreadRequest{
				RootMessageRef: openRef,
			},
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	created, ok := response.(openapi.EnsureMessageThread201JSONResponse)
	if !ok || created.Id.String() != handlerThreadID ||
		service.ensureThreadCommand.RootMessageRef.Sequence == nil {
		t.Fatalf("EnsureMessageThread() = %#v", response)
	}
	replyResponse, err := handler.RegisterMessageThreadReply(
		currentHumanContext(t),
		openapi.RegisterMessageThreadReplyRequestObject{
			ServerId:  uuid.MustParse(handlerServerID),
			ChannelId: uuid.MustParse(handlerThreadChannelID),
			ThreadId:  uuid.MustParse(handlerThreadID),
			Params: openapi.RegisterMessageThreadReplyParams{
				IdempotencyKey: "thread-reply-0001",
			},
			Body: &openapi.RegisterMessageThreadReplyRequest{
				MessageRef: openRef,
			},
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	reply, ok := replyResponse.(openapi.RegisterMessageThreadReply201JSONResponse)
	if !ok || reply.Id.String() != handlerReplyID ||
		service.registerReplyCommand.MessageRef.Timestamp == nil {
		t.Fatalf("RegisterMessageThreadReply() = %#v", replyResponse)
	}
	listResponse, err := handler.ListMessageThreadReplies(
		currentHumanContext(t),
		openapi.ListMessageThreadRepliesRequestObject{
			ServerId:  uuid.MustParse(handlerServerID),
			ChannelId: uuid.MustParse(handlerThreadChannelID),
			ThreadId:  uuid.MustParse(handlerThreadID),
			Params:    openapi.ListMessageThreadRepliesParams{},
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	page, ok := listResponse.(openapi.ListMessageThreadReplies200JSONResponse)
	if !ok || len(page.Items) != 1 ||
		page.Items[0].MessageRef.MessageId != "root-message" {
		t.Fatalf("ListMessageThreadReplies() = %#v", listResponse)
	}
	_, err = handler.MarkMessageThreadRead(
		currentHumanContext(t),
		openapi.MarkMessageThreadReadRequestObject{
			ServerId:  uuid.MustParse(handlerServerID),
			ChannelId: uuid.MustParse(handlerThreadChannelID),
			ThreadId:  uuid.MustParse(handlerThreadID),
			Params: openapi.MarkMessageThreadReadParams{
				IdempotencyKey: "thread-read-0001",
			},
			Body: &openapi.MarkMessageThreadReadRequest{
				LastReadRefId: uuid.MustParse(handlerReplyID),
			},
		},
	)
	if err != nil || service.markReadRefID != handlerReplyID {
		t.Fatalf("MarkMessageThreadRead() = (%q, %v)", service.markReadRefID, err)
	}
}

func TestWorkHandlerMapsReminderCommands(t *testing.T) {
	now := time.Date(2026, 7, 30, 15, 0, 0, 0, time.UTC)
	next := now.Add(time.Hour)
	service := &fakeWorkService{
		reminder: workport.Reminder{
			ID: handlerReminderID, ServerID: handlerServerID,
			AgentID: handlerAgentID, CreatedByMemberID: handlerMemberID,
			ScheduleKind: "once", Schedule: next.Format(time.RFC3339),
			Timezone: "Asia/Shanghai", Text: "汇报进度",
			Status: "active", NextFireAt: &next, Revision: 1,
			CreatedAt: now, UpdatedAt: now,
		},
	}
	handler, err := NewWorkHandler(service)
	if err != nil {
		t.Fatal(err)
	}
	response, err := handler.CreateReminder(
		currentHumanContext(t),
		openapi.CreateReminderRequestObject{
			ServerId: uuid.MustParse(handlerServerID),
			Params: openapi.CreateReminderParams{
				IdempotencyKey: "reminder-create-0001",
			},
			Body: &openapi.CreateReminderRequest{
				AgentId:      uuid.MustParse(handlerAgentID),
				ScheduleKind: openapi.CreateReminderRequestScheduleKind("once"),
				Schedule:     next.Format(time.RFC3339),
				Timezone:     "Asia/Shanghai", Text: "汇报进度",
			},
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	created, ok := response.(openapi.CreateReminder201JSONResponse)
	if !ok || created.Id.String() != handlerReminderID ||
		service.createReminderCommand.AgentID != handlerAgentID {
		t.Fatalf(
			"CreateReminder() = %#v command=%#v",
			response,
			service.createReminderCommand,
		)
	}
	status := openapi.UpdateReminderRequestStatus("paused")
	if _, err := handler.UpdateReminder(
		currentHumanContext(t),
		openapi.UpdateReminderRequestObject{
			ServerId:   uuid.MustParse(handlerServerID),
			ReminderId: uuid.MustParse(handlerReminderID),
			Params: openapi.UpdateReminderParams{
				XResourceRevision: 1, IdempotencyKey: "reminder-update-0001",
			},
			Body: &openapi.UpdateReminderRequest{Status: &status},
		},
	); err != nil {
		t.Fatal(err)
	}
	if service.updateReminderCommand.Revision != 1 ||
		service.updateReminderCommand.Patch.Status == nil ||
		*service.updateReminderCommand.Patch.Status != "paused" {
		t.Fatalf("update reminder command = %#v", service.updateReminderCommand)
	}
	cancelResponse, err := handler.CancelReminder(
		currentHumanContext(t),
		openapi.CancelReminderRequestObject{
			ServerId:   uuid.MustParse(handlerServerID),
			ReminderId: uuid.MustParse(handlerReminderID),
			Params: openapi.CancelReminderParams{
				XResourceRevision: 1, IdempotencyKey: "reminder-cancel-0001",
			},
		},
	)
	if err != nil || service.cancelReminderID != handlerReminderID {
		t.Fatalf("CancelReminder() = (%#v, %v)", cancelResponse, err)
	}
	if _, ok := cancelResponse.(openapi.CancelReminder204Response); !ok {
		t.Fatalf("CancelReminder() response = %#v", cancelResponse)
	}
}
