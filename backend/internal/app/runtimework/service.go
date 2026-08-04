// Package runtimework implements Agent-scoped Task use cases.
package runtimework

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"chatserver/internal/apperror"
	"chatserver/internal/pagination"
	clockport "chatserver/internal/ports/clock"
	idport "chatserver/internal/ports/id"
	runtimeworkport "chatserver/internal/ports/runtimework"
	workport "chatserver/internal/ports/work"
	"chatserver/internal/schedule"

	"github.com/google/uuid"
)

type Service struct {
	repository runtimeworkport.Repository
	clock      clockport.Clock
	ids        idport.Generator
}

func NewService(
	repository runtimeworkport.Repository,
	clock clockport.Clock,
	ids idport.Generator,
) (*Service, error) {
	if repository == nil || clock == nil || ids == nil {
		return nil, errors.New("Runtime Task 服务配置无效")
	}
	return &Service{repository: repository, clock: clock, ids: ids}, nil
}

func (service *Service) ListTasks(
	ctx context.Context,
	serverID string,
	agentID string,
	options workport.TaskListOptions,
) (workport.TaskPage, error) {
	if !validID(serverID) || !validID(agentID) || options.Limit < 1 || options.Limit > 100 {
		return workport.TaskPage{}, invalid("Runtime Task 身份无效")
	}
	updated := ""
	if options.UpdatedAfter != nil {
		updated = options.UpdatedAfter.UTC().Format(time.RFC3339Nano)
	}
	filter := fmt.Sprintf("server=%s&agent=%s&updatedAfter=%s", serverID, agentID, updated)
	if options.Cursor != "" {
		sort, err := pagination.Decode(options.Cursor, "listRuntimeTasks", filter, 2)
		if err != nil || !validID(sort[1]) {
			return workport.TaskPage{}, apperror.New("invalid_cursor", "Runtime Task 分页游标无效", err)
		}
		updatedAt, parseErr := time.Parse(time.RFC3339Nano, sort[0])
		if parseErr != nil {
			return workport.TaskPage{}, apperror.New("invalid_cursor", "Runtime Task 分页游标无效", parseErr)
		}
		options.AfterUpdatedAt, options.AfterID = &updatedAt, sort[1]
	}
	page, err := service.repository.ListRuntimeTasks(ctx, serverID, agentID, options)
	if err != nil {
		return workport.TaskPage{}, mapError(err)
	}
	if page.NextUpdatedAt != nil && page.NextID != "" {
		page.NextCursor, err = pagination.Encode(
			"listRuntimeTasks", filter, page.NextUpdatedAt.UTC().Format(time.RFC3339Nano), page.NextID,
		)
		if err != nil {
			return workport.TaskPage{}, apperror.New("internal_error", "暂时无法生成 Runtime Task 分页游标", err)
		}
	}
	return page, nil
}

func (service *Service) GetTask(
	ctx context.Context,
	serverID string,
	agentID string,
	taskID string,
) (workport.Task, error) {
	if !validID(serverID) || !validID(agentID) || !validID(taskID) {
		return workport.Task{}, invalid("Runtime Task 查询参数无效")
	}
	value, err := service.repository.GetRuntimeTask(ctx, serverID, agentID, taskID)
	return value, mapError(err)
}

func (service *Service) ClaimTask(
	ctx context.Context,
	serverID string,
	agentID string,
	taskID string,
	idempotencyKey string,
) (workport.Task, error) {
	if !validID(serverID) || !validID(agentID) || !validID(taskID) ||
		strings.TrimSpace(idempotencyKey) == "" {
		return workport.Task{}, invalid("Runtime Task 领取参数无效")
	}
	value, err := service.repository.ClaimRuntimeTask(
		ctx,
		serverID,
		agentID,
		taskID,
		service.clock.Now().UTC(),
	)
	return value, mapError(err)
}

func (service *Service) UpdateTaskStatus(
	ctx context.Context,
	serverID string,
	agentID string,
	taskID string,
	revision int64,
	status string,
	idempotencyKey string,
) (workport.Task, error) {
	if !validID(serverID) || !validID(agentID) || !validID(taskID) ||
		revision < 1 || strings.TrimSpace(idempotencyKey) == "" ||
		!runtimeTaskStatus(status) {
		return workport.Task{}, invalid("Runtime Task 状态更新参数无效")
	}
	value, err := service.repository.UpdateRuntimeTaskStatus(
		ctx,
		serverID,
		agentID,
		taskID,
		revision,
		status,
		service.clock.Now().UTC(),
	)
	return value, mapError(err)
}

func (service *Service) ResolveThread(
	ctx context.Context,
	serverID string,
	agentID string,
	channelID string,
	idempotencyKey string,
	root workport.MessageRef,
) (workport.MessageThread, error) {
	if !validID(serverID) || !validID(agentID) || !validID(channelID) ||
		strings.TrimSpace(idempotencyKey) == "" || !validRuntimeThreadRef(root, false) {
		return workport.MessageThread{}, invalid("Runtime Thread 参数无效")
	}
	threadID, err := service.ids.New()
	if err != nil {
		return workport.MessageThread{}, apperror.New("internal_error", "暂时无法建立 Thread", err)
	}
	value, err := service.repository.EnsureRuntimeThread(
		ctx,
		agentID,
		workport.Mutation{
			AccountID: agentID, ServerID: serverID,
			IdempotencyKey: runtimeIdempotencyKey(agentID, idempotencyKey),
			RequestHash:    runtimeThreadHash("resolve", channelID, "", root),
			Now:            service.clock.Now().UTC(),
		},
		channelID,
		workport.ThreadDraft{ID: threadID, ChannelID: channelID, RootMessageRef: root},
	)
	return value, mapThreadError(err)
}

func (service *Service) RegisterThreadReply(
	ctx context.Context,
	serverID string,
	agentID string,
	channelID string,
	threadID string,
	idempotencyKey string,
	reference workport.MessageRef,
) (workport.ThreadReplyReference, error) {
	if !validID(serverID) || !validID(agentID) || !validID(channelID) ||
		!validID(threadID) || strings.TrimSpace(idempotencyKey) == "" ||
		!validRuntimeThreadRef(reference, true) {
		return workport.ThreadReplyReference{}, invalid("Runtime Thread 回复参数无效")
	}
	referenceID, err := service.ids.New()
	if err != nil {
		return workport.ThreadReplyReference{}, apperror.New("internal_error", "暂时无法登记 Thread 回复", err)
	}
	value, err := service.repository.RegisterRuntimeThreadReply(
		ctx,
		agentID,
		workport.Mutation{
			AccountID: agentID, ServerID: serverID,
			IdempotencyKey: runtimeIdempotencyKey(agentID, idempotencyKey),
			RequestHash:    runtimeThreadHash("reply", channelID, threadID, reference),
			Now:            service.clock.Now().UTC(),
		},
		channelID,
		threadID,
		workport.ThreadReplyDraft{ID: referenceID, ThreadID: threadID, MessageRef: reference},
	)
	return value, mapThreadError(err)
}

func (service *Service) ListReminders(
	ctx context.Context,
	serverID string,
	agentID string,
) ([]workport.Reminder, error) {
	if !validID(serverID) || !validID(agentID) {
		return nil, invalid("Runtime Reminder 身份无效")
	}
	values, err := service.repository.ListRuntimeReminders(ctx, serverID, agentID)
	return values, mapReminderError(err)
}

func (service *Service) GetReminder(
	ctx context.Context,
	serverID string,
	agentID string,
	reminderID string,
) (workport.Reminder, error) {
	if !validID(serverID) || !validID(agentID) || !validID(reminderID) {
		return workport.Reminder{}, invalid("Runtime Reminder 查询参数无效")
	}
	value, err := service.repository.GetRuntimeReminder(ctx, serverID, agentID, reminderID)
	return value, mapReminderError(err)
}

func (service *Service) CreateReminder(
	ctx context.Context,
	serverID string,
	agentID string,
	idempotencyKey string,
	draft workport.ReminderDraft,
) (workport.Reminder, error) {
	if !validID(serverID) || !validID(agentID) || strings.TrimSpace(idempotencyKey) == "" {
		return workport.Reminder{}, invalid("Runtime Reminder 创建参数无效")
	}
	prepared, err := service.prepareReminderDraft(agentID, draft)
	if err != nil {
		return workport.Reminder{}, err
	}
	prepared.ID, err = service.ids.New()
	if err != nil {
		return workport.Reminder{}, apperror.New("internal_error", "暂时无法创建 Reminder", err)
	}
	value, err := service.repository.CreateRuntimeReminder(
		ctx,
		agentID,
		workport.Mutation{
			AccountID: agentID, ServerID: serverID,
			IdempotencyKey: runtimeIdempotencyKey(agentID, idempotencyKey),
			RequestHash:    runtimeReminderDraftHash(prepared),
			Now:            service.clock.Now().UTC(),
		},
		prepared,
	)
	return value, mapReminderError(err)
}

func (service *Service) UpdateReminder(
	ctx context.Context,
	serverID string,
	agentID string,
	reminderID string,
	revision int64,
	idempotencyKey string,
	patch workport.ReminderPatch,
) (workport.Reminder, error) {
	if !validID(serverID) || !validID(agentID) || !validID(reminderID) ||
		revision < 1 || strings.TrimSpace(idempotencyKey) == "" {
		return workport.Reminder{}, invalid("Runtime Reminder 更新参数无效")
	}
	current, err := service.repository.GetRuntimeReminder(ctx, serverID, agentID, reminderID)
	if err != nil {
		return workport.Reminder{}, mapReminderError(err)
	}
	if err := service.prepareReminderPatch(&patch, current); err != nil {
		return workport.Reminder{}, err
	}
	value, err := service.repository.UpdateRuntimeReminder(
		ctx,
		agentID,
		workport.Mutation{
			AccountID: agentID, ServerID: serverID,
			IdempotencyKey: runtimeIdempotencyKey(agentID, idempotencyKey),
			RequestHash:    runtimeReminderPatchHash(revision, patch),
			Now:            service.clock.Now().UTC(),
		},
		reminderID,
		revision,
		patch,
	)
	return value, mapReminderError(err)
}

func (service *Service) CancelReminder(
	ctx context.Context,
	serverID string,
	agentID string,
	reminderID string,
	revision int64,
	idempotencyKey string,
) error {
	status := "canceled"
	var next *time.Time
	_, err := service.UpdateReminder(
		ctx, serverID, agentID, reminderID, revision, idempotencyKey,
		workport.ReminderPatch{Status: &status, NextFireAt: &next},
	)
	return err
}

func (service *Service) SnoozeReminder(
	ctx context.Context,
	serverID string,
	agentID string,
	reminderID string,
	revision int64,
	delay time.Duration,
	idempotencyKey string,
) (workport.Reminder, error) {
	if delay < time.Second || delay > 365*24*time.Hour {
		return workport.Reminder{}, invalid("Runtime Reminder snooze 时长无效")
	}
	next := service.clock.Now().UTC().Add(delay)
	nextValue := &next
	status := "active"
	return service.UpdateReminder(
		ctx, serverID, agentID, reminderID, revision, idempotencyKey,
		workport.ReminderPatch{Status: &status, NextFireAt: &nextValue},
	)
}

func (service *Service) ListReminderLog(
	ctx context.Context,
	serverID string,
	agentID string,
	reminderID string,
	cursor string,
	limit int,
) (workport.ReminderLogPage, error) {
	if !validID(serverID) || !validID(agentID) || !validID(reminderID) ||
		limit < 1 || limit > 100 || len(cursor) > 512 {
		return workport.ReminderLogPage{}, invalid("Runtime Reminder log 参数无效")
	}
	filter := fmt.Sprintf("server=%s&agent=%s&reminder=%s", serverID, agentID, reminderID)
	options := workport.ReminderLogListOptions{Limit: limit, Cursor: cursor}
	if cursor != "" {
		sort, err := pagination.Decode(cursor, "listRuntimeReminderLog", filter, 2)
		if err != nil || !validID(sort[1]) {
			return workport.ReminderLogPage{}, apperror.New("invalid_cursor", "Runtime Reminder log 游标无效", err)
		}
		scheduledAt, parseErr := time.Parse(time.RFC3339Nano, sort[0])
		if parseErr != nil {
			return workport.ReminderLogPage{}, apperror.New("invalid_cursor", "Runtime Reminder log 游标无效", parseErr)
		}
		options.AfterScheduledFireAt, options.AfterID = &scheduledAt, sort[1]
	}
	page, err := service.repository.ListRuntimeReminderLog(
		ctx, serverID, agentID, reminderID, options,
	)
	if err != nil {
		return workport.ReminderLogPage{}, mapReminderError(err)
	}
	if page.NextScheduledFireAt != nil && page.NextID != "" {
		page.NextCursor, err = pagination.Encode(
			"listRuntimeReminderLog", filter,
			page.NextScheduledFireAt.UTC().Format(time.RFC3339Nano), page.NextID,
		)
		if err != nil {
			return workport.ReminderLogPage{}, apperror.New("internal_error", "暂时无法生成 Reminder log 分页游标", err)
		}
	}
	return page, nil
}

func (service *Service) prepareReminderDraft(
	agentID string,
	draft workport.ReminderDraft,
) (workport.ReminderDraft, error) {
	draft.AgentID = agentID
	draft.ScheduleKind = strings.TrimSpace(draft.ScheduleKind)
	draft.Schedule = strings.TrimSpace(draft.Schedule)
	draft.Timezone = strings.TrimSpace(draft.Timezone)
	draft.Text = strings.TrimSpace(draft.Text)
	if (draft.ScheduleKind != "once" && draft.ScheduleKind != "cron") ||
		draft.Schedule == "" || len(draft.Schedule) > 200 ||
		draft.Timezone == "" || len(draft.Timezone) > 100 ||
		draft.Text == "" || len(draft.Text) > 5000 || !utf8.ValidString(draft.Text) ||
		validateReminderAnchor(draft.Anchor) != nil {
		return workport.ReminderDraft{}, invalid("Runtime Reminder 内容或锚点无效")
	}
	next, err := schedule.NextReminderFire(
		draft.ScheduleKind, draft.Schedule, draft.Timezone, service.clock.Now().UTC(),
	)
	if err != nil {
		return workport.ReminderDraft{}, invalid(err.Error())
	}
	draft.NextFireAt = &next
	return draft, nil
}

func (service *Service) prepareReminderPatch(
	patch *workport.ReminderPatch,
	current workport.Reminder,
) error {
	if patch.Schedule == nil && patch.Timezone == nil && patch.Text == nil &&
		patch.Status == nil && patch.NextFireAt == nil && patch.Anchor == nil {
		return invalid("Runtime Reminder 更新内容不能为空")
	}
	if patch.Text != nil {
		*patch.Text = strings.TrimSpace(*patch.Text)
		if *patch.Text == "" || len(*patch.Text) > 5000 || !utf8.ValidString(*patch.Text) {
			return invalid("Runtime Reminder 文本无效")
		}
	}
	if patch.Timezone != nil {
		*patch.Timezone = strings.TrimSpace(*patch.Timezone)
		if _, err := time.LoadLocation(*patch.Timezone); err != nil {
			return invalid("Runtime Reminder 时区无效")
		}
	}
	if patch.Schedule != nil {
		*patch.Schedule = strings.TrimSpace(*patch.Schedule)
		if *patch.Schedule == "" || len(*patch.Schedule) > 200 {
			return invalid("Runtime Reminder schedule 无效")
		}
	}
	if patch.Status != nil && *patch.Status != "active" &&
		*patch.Status != "paused" && *patch.Status != "canceled" {
		return invalid("Runtime Reminder 状态无效")
	}
	if patch.Anchor != nil && *patch.Anchor != nil && validateReminderAnchor(*patch.Anchor) != nil {
		return invalid("Runtime Reminder 锚点无效")
	}
	if patch.NextFireAt != nil {
		return nil
	}
	status := current.Status
	if patch.Status != nil {
		status = *patch.Status
	}
	if status == "paused" || status == "canceled" {
		var cleared *time.Time
		patch.NextFireAt = &cleared
		return nil
	}
	if patch.Schedule == nil && patch.Timezone == nil &&
		(patch.Status == nil || current.Status == "active") {
		return nil
	}
	expression, timezone := current.Schedule, current.Timezone
	if patch.Schedule != nil {
		expression = *patch.Schedule
	}
	if patch.Timezone != nil {
		timezone = *patch.Timezone
	}
	next, err := schedule.NextReminderFire(
		current.ScheduleKind, expression, timezone, service.clock.Now().UTC(),
	)
	if err != nil {
		return invalid(err.Error())
	}
	nextValue := &next
	patch.NextFireAt = &nextValue
	return nil
}

func validateReminderAnchor(anchor *workport.ReminderAnchor) error {
	if anchor == nil {
		return nil
	}
	if !validID(anchor.ChannelID) || !validRuntimeThreadRef(anchor.MessageRef, false) {
		return errors.New("invalid reminder anchor")
	}
	switch anchor.Kind {
	case "message":
		if anchor.ThreadID != nil {
			return errors.New("message anchor has thread")
		}
	case "thread":
		if anchor.ThreadID == nil || !validID(*anchor.ThreadID) {
			return errors.New("thread anchor is incomplete")
		}
	default:
		return errors.New("unknown anchor kind")
	}
	return nil
}

func runtimeReminderDraftHash(value workport.ReminderDraft) [32]byte {
	return sha256.Sum256([]byte(strings.Join([]string{
		value.AgentID, value.ScheduleKind, value.Schedule, value.Timezone,
		value.Text, reminderAnchorHashText(value.Anchor),
	}, "\x00")))
}

func runtimeReminderPatchHash(revision int64, value workport.ReminderPatch) [32]byte {
	return sha256.Sum256([]byte(strings.Join([]string{
		fmt.Sprintf("revision=%d", revision), optionalStringText(value.Schedule),
		optionalStringText(value.Timezone), optionalStringText(value.Text),
		optionalStringText(value.Status), optionalTimeText(value.NextFireAt),
		optionalAnchorText(value.Anchor),
	}, "\x00")))
}

func reminderAnchorHashText(value *workport.ReminderAnchor) string {
	if value == nil {
		return "anchor=null"
	}
	return fmt.Sprintf(
		"anchor=%s:%s:%s:%s:%s:%s:%s:%d:%d",
		value.Kind, value.ChannelID, optionalValue(value.ThreadID),
		value.MessageRef.Kind, value.MessageRef.MessageID,
		optionalValue(value.MessageRef.GroupID), optionalValue(value.MessageRef.TopicID),
		*value.MessageRef.Sequence, *value.MessageRef.Timestamp,
	)
}

func optionalStringText(value *string) string {
	if value == nil {
		return "unset"
	}
	return "set:" + *value
}

func optionalTimeText(value **time.Time) string {
	if value == nil {
		return "unset"
	}
	if *value == nil {
		return "null"
	}
	return (*value).UTC().Format(time.RFC3339Nano)
}

func optionalAnchorText(value **workport.ReminderAnchor) string {
	if value == nil {
		return "unset"
	}
	return reminderAnchorHashText(*value)
}

func mapReminderError(err error) error {
	switch {
	case err == nil:
		return nil
	case errors.Is(err, workport.ErrNotFound):
		return apperror.New("reminder_not_found", "Reminder 不存在", err)
	case errors.Is(err, workport.ErrForbidden):
		return apperror.New("forbidden", "当前 Agent 无权操作该 Reminder 或锚点", err)
	case errors.Is(err, workport.ErrRevisionConflict):
		return apperror.New("revision_conflict", "Reminder 已被其他操作更新", err)
	case errors.Is(err, workport.ErrIdempotencyConflict):
		return apperror.New("idempotency_conflict", "幂等键与原请求不一致", err)
	default:
		return apperror.New("internal_error", "暂时无法处理 Runtime Reminder 请求", err)
	}
}

func validRuntimeThreadRef(value workport.MessageRef, requireSender bool) bool {
	if value.Kind != "group" || strings.TrimSpace(value.MessageID) == "" ||
		len(value.MessageID) > 512 || value.GroupID == nil ||
		strings.TrimSpace(*value.GroupID) == "" || value.Sequence == nil ||
		*value.Sequence < 1 || value.Timestamp == nil || *value.Timestamp < 1 {
		return false
	}
	if value.TopicID != nil && strings.TrimSpace(*value.TopicID) == "" {
		return false
	}
	return !requireSender || value.SenderUserID != nil && strings.TrimSpace(*value.SenderUserID) != ""
}

func runtimeThreadHash(
	action string,
	channelID string,
	threadID string,
	value workport.MessageRef,
) [32]byte {
	text := fmt.Sprintf(
		"%s\x00%s\x00%s\x00%s\x00%s\x00%s\x00%s\x00%s\x00%d\x00%d",
		action, channelID, threadID, value.Kind, value.MessageID,
		optionalValue(value.GroupID), optionalValue(value.TopicID), optionalValue(value.SenderUserID),
		*value.Sequence, *value.Timestamp,
	)
	return sha256.Sum256([]byte(text))
}

func runtimeIdempotencyKey(agentID string, value string) string {
	return agentID + ":" + strings.TrimSpace(value)
}

func optionalValue(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func mapThreadError(err error) error {
	switch {
	case err == nil:
		return nil
	case errors.Is(err, workport.ErrNotFound):
		return apperror.New("thread_not_found", "Thread 或 Channel 不存在", err)
	case errors.Is(err, workport.ErrForbidden):
		return apperror.New("forbidden", "当前 Agent 无权访问该 Channel", err)
	case errors.Is(err, workport.ErrRevisionConflict):
		return apperror.New("revision_conflict", "消息引用已属于其他 Thread", err)
	case errors.Is(err, workport.ErrIdempotencyConflict):
		return apperror.New("idempotency_conflict", "幂等键与原请求不一致", err)
	default:
		return apperror.New("internal_error", "暂时无法处理 Runtime Thread 请求", err)
	}
}

func runtimeTaskStatus(value string) bool {
	switch value {
	case "in_progress", "in_review", "done":
		return true
	default:
		return false
	}
}

func validID(value string) bool {
	parsed, err := uuid.Parse(value)
	return err == nil && parsed != uuid.Nil && parsed.Version() == 7
}

func invalid(message string) error {
	return apperror.New("invalid_request", message, nil)
}

func mapError(err error) error {
	switch {
	case err == nil:
		return nil
	case errors.Is(err, workport.ErrNotFound):
		return apperror.New("task_not_found", "Task 不存在", err)
	case errors.Is(err, workport.ErrForbidden):
		return apperror.New("forbidden", "当前 Agent 无权操作该 Task", err)
	case errors.Is(err, workport.ErrRevisionConflict):
		return apperror.New("revision_conflict", "Task 已被其他操作更新", err)
	default:
		return apperror.New("internal_error", "暂时无法处理 Runtime Task 请求", err)
	}
}
