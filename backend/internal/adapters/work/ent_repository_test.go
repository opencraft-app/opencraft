package work

import (
	"context"
	"crypto/sha256"
	"errors"
	"path/filepath"
	"testing"
	"time"

	"chatserver/internal/config"
	"chatserver/internal/database"
	"chatserver/internal/database/migration"
	"chatserver/internal/ent/channelmember"
	"chatserver/internal/ent/tencentoperation"
	workport "chatserver/internal/ports/work"
)

const (
	workAccountID  = "0198f4c2-7a30-7c91-a6d2-7d76f9188c37"
	workServerID   = "0198f4c2-7a31-7c91-a6d2-7d76f9188c38"
	workMemberID   = "0198f4c2-7a32-7d02-b8c1-3f6e15aa91b4"
	workAgentID    = "0198f4c2-7a33-7e45-913c-6baf30401a82"
	workTaskID     = "0198f4c2-7a34-7e45-913c-6baf30401a83"
	workTaskID2    = "0198f4c2-7a35-7e45-913c-6baf30401a84"
	workReminder   = "0198f4c2-7a36-7e45-913c-6baf30401a85"
	workChannelID  = "0198f4c2-7a37-7e45-913c-6baf30401a86"
	workThreadID   = "0198f4c2-7a38-7e45-913c-6baf30401a87"
	workReplyID1   = "0198f4c2-7a39-7e45-913c-6baf30401a88"
	workReplyID2   = "0198f4c2-7a3a-7e45-913c-6baf30401a89"
	workTaskNotify = "0198f4c2-7a3b-7e45-913c-6baf30401a8a"
)

var workNow = time.Date(2026, 7, 30, 14, 0, 0, 0, time.UTC)

func TestEntRepositoryNumbersAndReplaysTaskCreation(t *testing.T) {
	repository, handle := openWorkRepository(t)
	seedWorkServer(t, handle)
	mutation := workMutation("task-create-1", "create-1", workNow)
	groupID := "@TGS#_C_WORK_TEST"
	topicID := "@TGS#_C_WORK_TEST@TOPIC#_WORK"
	source := &workport.MessageRef{
		Kind: "topic", MessageID: "144115",
		GroupID: &groupID, TopicID: &topicID,
	}
	first, err := repository.CreateTask(context.Background(), mutation, workport.TaskDraft{
		ID: workTaskID, Title: "完成 TUI", SourceMessageRef: source,
	})
	if err != nil {
		t.Fatal(err)
	}
	if first.Number != 1 || first.Status != "todo" ||
		first.SourceMessageRef == nil ||
		first.SourceMessageRef.MessageID != "144115" {
		t.Fatalf("first task = %#v", first)
	}

	replayed, err := repository.CreateTask(context.Background(), mutation, workport.TaskDraft{
		ID: workTaskID2, Title: "不应创建",
	})
	if err != nil || replayed.ID != workTaskID || replayed.Number != 1 {
		t.Fatalf("replayed task = (%#v, %v)", replayed, err)
	}
	second, err := repository.CreateTask(
		context.Background(),
		workMutation("task-create-2", "create-2", workNow.Add(time.Second)),
		workport.TaskDraft{ID: workTaskID2, Title: "第二个任务"},
	)
	if err != nil || second.Number != 2 {
		t.Fatalf("second task = (%#v, %v)", second, err)
	}

}

func TestEntRepositoryCreatesDurableIMOperationForAgentAssignment(t *testing.T) {
	repository, handle := openWorkRepository(t)
	seedWorkServer(t, handle)
	created, err := repository.CreateTask(
		context.Background(),
		workMutation("task-create-assigned", "assigned", workNow),
		workport.TaskDraft{
			ID: workTaskID, Title: "处理发布故障",
			OwnerMemberID:           &[]string{workAgentID}[0],
			NotificationOperationID: &[]string{workTaskNotify}[0],
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	operation, err := handle.Client().TencentOperation.Query().Where(
		tencentoperation.IDEQ(workTaskNotify),
	).Only(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if created.AssignmentRevision != 1 ||
		operation.PartitionKey != workServerID ||
		operation.Service != "im" ||
		operation.Kind != "im.agent.task.assigned" ||
		operation.ResourceType != "task" ||
		operation.ResourceID != workTaskID ||
		operation.DesiredRevision == nil || *operation.DesiredRevision != 1 ||
		operation.State != "pending" {
		t.Fatalf("task=%#v operation=%#v", created, operation)
	}
}

func TestEntRepositoryCreatesNewIMOperationWhenTaskIsAssigned(t *testing.T) {
	repository, handle := openWorkRepository(t)
	seedWorkServer(t, handle)
	created, err := repository.CreateTask(
		context.Background(),
		workMutation("task-create-unassigned", "unassigned", workNow),
		workport.TaskDraft{ID: workTaskID, Title: "处理发布故障"},
	)
	if err != nil {
		t.Fatal(err)
	}
	ownerID := workAgentID
	owner := &ownerID
	updated, err := repository.UpdateTask(
		context.Background(),
		workMutation("task-assign-agent", "assign-agent", workNow.Add(time.Second)),
		created.ID,
		created.Revision,
		workport.TaskPatch{
			OwnerMemberID:           &owner,
			NotificationOperationID: &[]string{workTaskNotify}[0],
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	operation, err := handle.Client().TencentOperation.Query().Where(
		tencentoperation.IDEQ(workTaskNotify),
	).Only(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if updated.AssignmentRevision != 2 ||
		operation.DesiredRevision == nil || *operation.DesiredRevision != 2 ||
		operation.ResourceID != workTaskID || operation.State != "pending" {
		t.Fatalf("task=%#v operation=%#v", updated, operation)
	}
}

func TestEntRepositoryRuntimeTaskScopeAndSemanticIdempotency(t *testing.T) {
	repository, handle := openWorkRepository(t)
	seedWorkServer(t, handle)
	ctx := context.Background()
	if _, err := handle.Client().Task.Create().
		SetID(workTaskID).
		SetServerID(workServerID).
		SetNumber(1).
		SetTitle("处理线上告警").
		SetStatus("todo").
		SetOwnerMemberID(workAgentID).
		SetAssignmentRevision(1).
		SetCreatedByMemberID(workMemberID).
		SetUpdatedByMemberID(workMemberID).
		SetRevision(1).
		SetCreatedAt(workNow).
		SetUpdatedAt(workNow).
		Save(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Client().Task.Create().
		SetID(workTaskID2).
		SetServerID(workServerID).
		SetNumber(2).
		SetTitle("Human 自己处理").
		SetStatus("todo").
		SetOwnerMemberID(workMemberID).
		SetAssignmentRevision(1).
		SetCreatedByMemberID(workMemberID).
		SetUpdatedByMemberID(workMemberID).
		SetRevision(1).
		SetCreatedAt(workNow).
		SetUpdatedAt(workNow).
		Save(ctx); err != nil {
		t.Fatal(err)
	}

	values, err := repository.ListRuntimeTasks(
		ctx, workServerID, workAgentID, workport.TaskListOptions{Limit: 50},
	)
	if err != nil || len(values.Items) != 1 || values.Items[0].ID != workTaskID {
		t.Fatalf("ListRuntimeTasks() = (%#v, %v)", values, err)
	}
	if _, err := repository.GetRuntimeTask(
		ctx, workServerID, workAgentID, workTaskID2,
	); !errors.Is(err, workport.ErrForbidden) {
		t.Fatalf("GetRuntimeTask(other owner) error = %v", err)
	}

	claimed, err := repository.ClaimRuntimeTask(
		ctx, workServerID, workAgentID, workTaskID, workNow.Add(time.Second),
	)
	if err != nil || claimed.Status != "in_progress" || claimed.Revision != 2 ||
		claimed.UpdatedByMemberID != workAgentID {
		t.Fatalf("ClaimRuntimeTask() = (%#v, %v)", claimed, err)
	}
	replayedClaim, err := repository.ClaimRuntimeTask(
		ctx, workServerID, workAgentID, workTaskID, workNow.Add(2*time.Second),
	)
	if err != nil || replayedClaim.Revision != claimed.Revision {
		t.Fatalf("replayed ClaimRuntimeTask() = (%#v, %v)", replayedClaim, err)
	}
	done, err := repository.UpdateRuntimeTaskStatus(
		ctx,
		workServerID,
		workAgentID,
		workTaskID,
		claimed.Revision,
		"done",
		workNow.Add(3*time.Second),
	)
	if err != nil || done.Status != "done" || done.Revision != 3 {
		t.Fatalf("UpdateRuntimeTaskStatus() = (%#v, %v)", done, err)
	}
	replayedDone, err := repository.UpdateRuntimeTaskStatus(
		ctx,
		workServerID,
		workAgentID,
		workTaskID,
		claimed.Revision,
		"done",
		workNow.Add(4*time.Second),
	)
	if err != nil || replayedDone.Revision != done.Revision {
		t.Fatalf("replayed UpdateRuntimeTaskStatus() = (%#v, %v)", replayedDone, err)
	}
}

func TestEntRepositoryValidatesReminderAgentAndProjectsActivity(t *testing.T) {
	repository, handle := openWorkRepository(t)
	seedWorkServer(t, handle)
	fireAt := workNow.Add(time.Hour)
	mutation := workMutation("reminder-create-1", "reminder-1", workNow)

	_, err := repository.CreateReminder(
		context.Background(),
		mutation,
		workport.ReminderDraft{
			ID: workReminder, AgentID: workTaskID2,
			ScheduleKind: "once", Schedule: fireAt.Format(time.RFC3339),
			Timezone: "Asia/Shanghai", Text: "汇报进度", NextFireAt: &fireAt,
		},
	)
	if !errors.Is(err, workport.ErrInvalidAgent) {
		t.Fatalf("CreateReminder(invalid agent) error = %v", err)
	}

	created, err := repository.CreateReminder(
		context.Background(),
		mutation,
		workport.ReminderDraft{
			ID: workReminder, AgentID: workAgentID,
			ScheduleKind: "once", Schedule: fireAt.Format(time.RFC3339),
			Timezone: "Asia/Shanghai", Text: "汇报进度", NextFireAt: &fireAt,
		},
	)
	if err != nil || created.Status != "active" ||
		created.NextFireAt == nil || !created.NextFireAt.Equal(fireAt) {
		t.Fatalf("created reminder = (%#v, %v)", created, err)
	}
	if err := repository.CancelReminder(
		context.Background(),
		workMutation("reminder-cancel-stale", "cancel-stale", workNow.Add(30*time.Second)),
		workReminder,
		created.Revision+1,
	); !errors.Is(err, workport.ErrRevisionConflict) {
		t.Fatalf("CancelReminder(stale revision) error = %v", err)
	}
	if err := repository.CancelReminder(
		context.Background(),
		workMutation("reminder-cancel-1", "cancel-1", workNow.Add(time.Minute)),
		workReminder,
		created.Revision,
	); err != nil {
		t.Fatal(err)
	}
	canceled, err := repository.GetReminder(
		context.Background(), workAccountID, workServerID, workReminder,
	)
	if err != nil || canceled.Status != "canceled" ||
		canceled.NextFireAt != nil {
		t.Fatalf("canceled reminder = (%#v, %v)", canceled, err)
	}
	activity, err := repository.ListActivity(
		context.Background(), workAccountID, workServerID,
	)
	if err != nil || len(activity) != 1 ||
		activity[0].ResourceID != workReminder ||
		activity[0].Kind != "reminder.changed" {
		t.Fatalf("activity = (%#v, %v)", activity, err)
	}
}

func TestEntRepositoryIndexesThreadReferencesAndAdvancesReadMonotonically(
	t *testing.T,
) {
	repository, handle := openWorkRepository(t)
	seedWorkServer(t, handle)
	seedWorkChannel(t, handle)
	groupID := "@TGS#_C_WORK_TEST"
	topicID := "@TGS#_C_WORK_TEST@TOPIC#_GENERAL"
	rootSequence, rootTimestamp := int64(100), int64(1_785_484_800)
	rootRef := workport.MessageRef{
		Kind: "group", MessageID: "root-message",
		GroupID: &groupID, TopicID: &topicID,
		Sequence: &rootSequence, Timestamp: &rootTimestamp,
	}
	thread, err := repository.EnsureThread(
		context.Background(),
		workMutation("thread-ensure-1", "thread-root", workNow),
		workChannelID,
		workport.ThreadDraft{
			ID: workThreadID, ChannelID: workChannelID,
			RootMessageRef: rootRef,
		},
	)
	if err != nil || thread.ID != workThreadID || thread.ReplyCount != 0 {
		t.Fatalf("thread = (%#v, %v)", thread, err)
	}
	replayed, err := repository.EnsureThread(
		context.Background(),
		workMutation("thread-ensure-1", "thread-root", workNow),
		workChannelID,
		workport.ThreadDraft{
			ID: workReplyID1, ChannelID: workChannelID,
			RootMessageRef: rootRef,
		},
	)
	if err != nil || replayed.ID != workThreadID {
		t.Fatalf("replayed thread = (%#v, %v)", replayed, err)
	}

	reply1 := registerWorkThreadReply(
		t, repository, workReplyID1, "reply-message-1", 101,
		workNow.Add(time.Minute),
	)
	reply2 := registerWorkThreadReply(
		t, repository, workReplyID2, "reply-message-2", 102,
		workNow.Add(2*time.Minute),
	)
	page, err := repository.ListThreadReplies(
		context.Background(),
		workAccountID,
		workServerID,
		workChannelID,
		workThreadID,
		workport.ThreadReplyListOptions{Limit: 1},
	)
	if err != nil || len(page.Items) != 1 ||
		page.Items[0].ID != reply2.ID || page.NextSequence == nil {
		t.Fatalf("first reply page = (%#v, %v)", page, err)
	}
	older, err := repository.ListThreadReplies(
		context.Background(),
		workAccountID,
		workServerID,
		workChannelID,
		workThreadID,
		workport.ThreadReplyListOptions{
			Limit: 1, AfterSequence: page.NextSequence, AfterID: page.NextID,
		},
	)
	if err != nil || len(older.Items) != 1 ||
		older.Items[0].ID != reply1.ID {
		t.Fatalf("older reply page = (%#v, %v)", older, err)
	}
	beforeRead, err := repository.GetThread(
		context.Background(),
		workAccountID,
		workServerID,
		workChannelID,
		workThreadID,
	)
	if err != nil || beforeRead.ReplyCount != 2 ||
		beforeRead.UnreadCount != 2 {
		t.Fatalf("thread before read = (%#v, %v)", beforeRead, err)
	}
	if err := repository.MarkThreadRead(
		context.Background(),
		workMutation("thread-read-1", "thread-read-newest", workNow),
		workChannelID,
		workThreadID,
		reply2.ID,
	); err != nil {
		t.Fatal(err)
	}
	// 较旧回执不能使已读位置倒退。
	if err := repository.MarkThreadRead(
		context.Background(),
		workMutation("thread-read-2", "thread-read-older", workNow),
		workChannelID,
		workThreadID,
		reply1.ID,
	); err != nil {
		t.Fatal(err)
	}
	afterRead, err := repository.GetThread(
		context.Background(),
		workAccountID,
		workServerID,
		workChannelID,
		workThreadID,
	)
	if err != nil || afterRead.UnreadCount != 0 {
		t.Fatalf("thread after read = (%#v, %v)", afterRead, err)
	}
}

func TestEntRepositoryRuntimeThreadRequiresAuthorizedTencentRouteAndAgentSender(
	t *testing.T,
) {
	t.Parallel()
	repository, handle := openWorkRepository(t)
	seedWorkServer(t, handle)
	seedWorkChannel(t, handle)
	groupID := "@TGS#_C_WORK_TEST"
	topicID := "@TGS#_C_WORK_TEST@TOPIC#_GENERAL"
	sequence, timestamp := int64(100), workNow.Unix()
	root := workport.MessageRef{
		Kind: "group", MessageID: "runtime-root", GroupID: &groupID,
		TopicID: &topicID, Sequence: &sequence, Timestamp: &timestamp,
	}
	mutation := workMutation("runtime-thread-resolve", "runtime-root", workNow)
	mutation.AccountID = workAgentID
	thread, err := repository.EnsureRuntimeThread(
		context.Background(), workAgentID, mutation, workChannelID,
		workport.ThreadDraft{ID: workThreadID, ChannelID: workChannelID, RootMessageRef: root},
	)
	if err != nil || thread.ID != workThreadID {
		t.Fatalf("runtime thread = (%#v, %v)", thread, err)
	}
	replySequence := int64(101)
	sender := "a_work_reminder_agent"
	reply := root
	reply.MessageID = "runtime-reply"
	reply.Sequence = &replySequence
	reply.SenderUserID = &sender
	replyMutation := workMutation("runtime-thread-reply", "runtime-reply", workNow.Add(time.Second))
	replyMutation.AccountID = workAgentID
	registered, err := repository.RegisterRuntimeThreadReply(
		context.Background(), workAgentID, replyMutation, workChannelID, workThreadID,
		workport.ThreadReplyDraft{ID: workReplyID1, ThreadID: workThreadID, MessageRef: reply},
	)
	if err != nil || registered.ID != workReplyID1 {
		t.Fatalf("runtime reply = (%#v, %v)", registered, err)
	}
	wrongTopic := "@TGS#_C_WORK_TEST@TOPIC#_OTHER"
	root.TopicID = &wrongTopic
	badMutation := workMutation("runtime-thread-wrong-topic", "wrong", workNow)
	badMutation.AccountID = workAgentID
	if _, err := repository.EnsureRuntimeThread(
		context.Background(), workAgentID, badMutation, workChannelID,
		workport.ThreadDraft{ID: workReplyID2, ChannelID: workChannelID, RootMessageRef: root},
	); !errors.Is(err, workport.ErrForbidden) {
		t.Fatalf("wrong Topic error = %v", err)
	}
}

func TestEntRepositoryRuntimeThreadRejectsUnjoinedPublicChannel(t *testing.T) {
	t.Parallel()
	repository, handle := openWorkRepository(t)
	seedWorkServer(t, handle)
	seedWorkChannel(t, handle)
	if _, err := handle.Client().ChannelMember.Update().
		Where(
			channelmember.ServerIDEQ(workServerID),
			channelmember.ChannelIDEQ(workChannelID),
			channelmember.MemberIDEQ(workAgentID),
		).
		SetState("removed").
		Save(context.Background()); err != nil {
		t.Fatal(err)
	}
	groupID := "@TGS#_C_WORK_TEST"
	topicID := "@TGS#_C_WORK_TEST@TOPIC#_GENERAL"
	sequence, timestamp := int64(100), workNow.Unix()
	mutation := workMutation("runtime-thread-unjoined", "runtime-unjoined", workNow)
	mutation.AccountID = workAgentID
	_, err := repository.EnsureRuntimeThread(
		context.Background(), workAgentID, mutation, workChannelID,
		workport.ThreadDraft{
			ID: workThreadID, ChannelID: workChannelID,
			RootMessageRef: workport.MessageRef{
				Kind: "group", MessageID: "runtime-unjoined",
				GroupID: &groupID, TopicID: &topicID,
				Sequence: &sequence, Timestamp: &timestamp,
			},
		},
	)
	if !errors.Is(err, workport.ErrForbidden) {
		t.Fatalf("unjoined public Channel error = %v", err)
	}
}

func TestEntRepositoryRuntimeReminderScopeAndMessageAnchor(t *testing.T) {
	t.Parallel()
	repository, handle := openWorkRepository(t)
	seedWorkServer(t, handle)
	seedWorkChannel(t, handle)
	groupID := "@TGS#_C_WORK_TEST"
	topicID := "@TGS#_C_WORK_TEST@TOPIC#_GENERAL"
	sequence, timestamp := int64(100), workNow.Unix()
	anchor := &workport.ReminderAnchor{
		Kind: "message", ChannelID: workChannelID,
		MessageRef: workport.MessageRef{
			Kind: "group", MessageID: "runtime-reminder-root",
			GroupID: &groupID, TopicID: &topicID,
			Sequence: &sequence, Timestamp: &timestamp,
		},
	}
	fireAt := workNow.Add(time.Hour)
	mutation := workMutation("runtime-reminder-create", "runtime-reminder", workNow)
	mutation.AccountID = workAgentID
	created, err := repository.CreateRuntimeReminder(
		context.Background(), workAgentID, mutation,
		workport.ReminderDraft{
			ID: workReminder, AgentID: workAgentID, ScheduleKind: "once",
			Schedule: fireAt.Format(time.RFC3339), Timezone: "Asia/Shanghai",
			Text: "回到消息处理", NextFireAt: &fireAt, Anchor: anchor,
		},
	)
	if err != nil || created.ID != workReminder || created.Anchor == nil ||
		created.Anchor.MessageRef.MessageID != "runtime-reminder-root" {
		t.Fatalf("CreateRuntimeReminder() = (%#v, %v)", created, err)
	}
	values, err := repository.ListRuntimeReminders(
		context.Background(), workServerID, workAgentID,
	)
	if err != nil || len(values) != 1 || values[0].ID != workReminder {
		t.Fatalf("ListRuntimeReminders() = (%#v, %v)", values, err)
	}
	if _, err := repository.GetRuntimeReminder(
		context.Background(), workServerID, workMemberID, workReminder,
	); !errors.Is(err, workport.ErrForbidden) {
		t.Fatalf("GetRuntimeReminder(other actor) error = %v", err)
	}
	text := "更新后的提醒"
	updated, err := repository.UpdateRuntimeReminder(
		context.Background(), workAgentID,
		func() workport.Mutation {
			value := workMutation("runtime-reminder-update", "update", workNow.Add(time.Minute))
			value.AccountID = workAgentID
			return value
		}(),
		workReminder, created.Revision,
		workport.ReminderPatch{Text: &text},
	)
	if err != nil || updated.Text != text || updated.Revision != 2 || updated.Anchor == nil {
		t.Fatalf("UpdateRuntimeReminder() = (%#v, %v)", updated, err)
	}
	wrongTopic := "@TGS#_C_WORK_TEST@TOPIC#_OTHER"
	anchor.MessageRef.TopicID = &wrongTopic
	badMutation := workMutation("runtime-reminder-bad-anchor", "bad", workNow)
	badMutation.AccountID = workAgentID
	if _, err := repository.CreateRuntimeReminder(
		context.Background(), workAgentID, badMutation,
		workport.ReminderDraft{
			ID: workReplyID2, AgentID: workAgentID, ScheduleKind: "once",
			Schedule: fireAt.Format(time.RFC3339), Timezone: "Asia/Shanghai",
			Text: "不应创建", NextFireAt: &fireAt, Anchor: anchor,
		},
	); !errors.Is(err, workport.ErrForbidden) {
		t.Fatalf("wrong anchor error = %v", err)
	}
}

func openWorkRepository(t *testing.T) (*EntRepository, *database.Handle) {
	t.Helper()
	cfg, err := config.NewDatabase(
		filepath.Join(t.TempDir(), "data", "chatserver.db"),
	)
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
	repository, err := NewEntRepository(handle)
	if err != nil {
		t.Fatal(err)
	}
	return repository, handle
}

func seedWorkServer(t *testing.T, handle *database.Handle) {
	t.Helper()
	ctx := context.Background()
	if _, err := handle.Client().Server.Create().
		SetID(workServerID).
		SetSlug("work-test").
		SetName("Work 测试").
		SetImGroupID("@TGS#_C_WORK_TEST").
		SetImState("ready").
		SetOwnerMemberID(workMemberID).
		SetNextTaskNumber(1).
		SetRevision(1).
		SetCreatedAt(workNow).
		SetUpdatedAt(workNow).
		Save(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Client().Member.Create().
		SetID(workMemberID).
		SetServerID(workServerID).
		SetAccountID(workAccountID).
		SetKind("human").
		SetRole("owner").
		SetDisplayName("负责人").
		SetHandle("owner").
		SetStatus("active").
		SetImState("ready").
		SetRevision(1).
		SetCreatedAt(workNow).
		SetUpdatedAt(workNow).
		Save(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Client().AccountServerMembership.Create().
		SetAccountID(workAccountID).
		SetServerID(workServerID).
		SetMemberID(workMemberID).
		SetRole("owner").
		SetStatus("active").
		SetServerNameSnapshot("Work 测试").
		SetServerSlugSnapshot("work-test").
		SetServerRevision(1).
		SetProjectedAt(workNow).
		SetUpdatedAt(workNow).
		Save(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Client().Member.Create().
		SetID(workAgentID).
		SetServerID(workServerID).
		SetKind("agent").
		SetRole("member").
		SetDisplayName("提醒 Agent").
		SetHandle("reminder-agent").
		SetStatus("active").
		SetImState("ready").
		SetRevision(1).
		SetCreatedAt(workNow).
		SetUpdatedAt(workNow).
		Save(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Client().Agent.Create().
		SetID(workAgentID).
		SetServerID(workServerID).
		SetImUserID("a_work_reminder_agent").
		SetRuntimeKind("codex").
		SetReplyPolicy("mentions").
		SetDesiredState("stopped").
		SetObservedState("stopped").
		SetCredentialVersion(1).
		SetImState("ready").
		SetCreatedByMemberID(workMemberID).
		SetRevision(1).
		SetCreatedAt(workNow).
		SetUpdatedAt(workNow).
		Save(ctx); err != nil {
		t.Fatal(err)
	}
}

func seedWorkChannel(t *testing.T, handle *database.Handle) {
	t.Helper()
	if _, err := handle.Client().Channel.Create().
		SetID(workChannelID).
		SetServerID(workServerID).
		SetName("general").
		SetVisibility("public").
		SetImGroupID("@TGS#_C_WORK_TEST").
		SetImTopicID("@TGS#_C_WORK_TEST@TOPIC#_GENERAL").
		SetImState("ready").
		SetRevision(1).
		SetCreatedAt(workNow).
		SetUpdatedAt(workNow).
		Save(context.Background()); err != nil {
		t.Fatal(err)
	}
	for index, memberID := range []string{workMemberID, workAgentID} {
		if _, err := handle.Client().ChannelMember.Create().
			SetID([]string{
				"0198f4c2-7a3c-7e45-913c-6baf30401a8b",
				"0198f4c2-7a3d-7e45-913c-6baf30401a8c",
			}[index]).
			SetServerID(workServerID).
			SetChannelID(workChannelID).
			SetMemberID(memberID).
			SetState("active").
			SetImState("ready").
			SetMembershipVersion(1).
			SetCreatedAt(workNow).
			SetUpdatedAt(workNow).
			Save(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
}

func registerWorkThreadReply(
	t *testing.T,
	repository *EntRepository,
	id, messageID string,
	sequence int64,
	now time.Time,
) workport.ThreadReplyReference {
	t.Helper()
	groupID := "@TGS#_C_WORK_TEST"
	topicID := "@TGS#_C_WORK_TEST@TOPIC#_GENERAL"
	timestamp := now.Unix()
	value, err := repository.RegisterThreadReply(
		context.Background(),
		workMutation("thread-reply-"+id, "reply-"+messageID, now),
		workChannelID,
		workThreadID,
		workport.ThreadReplyDraft{
			ID: id, ThreadID: workThreadID,
			MessageRef: workport.MessageRef{
				Kind: "group", MessageID: messageID,
				GroupID: &groupID, TopicID: &topicID,
				Sequence: &sequence, Timestamp: &timestamp,
			},
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	return value
}

func workMutation(key, digest string, now time.Time) workport.Mutation {
	return workport.Mutation{
		AccountID: workAccountID, ServerID: workServerID,
		IdempotencyKey: key, RequestHash: sha256.Sum256([]byte(digest)),
		Now: now,
	}
}
