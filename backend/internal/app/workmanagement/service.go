// Package workmanagement 实现 Server 内 Task、Reminder、Inbox 与 Activity。
package workmanagement

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"chatserver/internal/apperror"
	"chatserver/internal/pagination"
	clockport "chatserver/internal/ports/clock"
	idport "chatserver/internal/ports/id"
	workport "chatserver/internal/ports/work"
	"chatserver/internal/schedule"

	"github.com/google/uuid"
)

type Service struct {
	repository workport.Repository
	ids        idport.Generator
	clock      clockport.Clock
}

func NewService(
	repository workport.Repository,
	ids idport.Generator,
	clock clockport.Clock,
) (*Service, error) {
	if repository == nil || ids == nil || clock == nil {
		return nil, errors.New("Work 服务配置无效")
	}
	return &Service{repository: repository, ids: ids, clock: clock}, nil
}

type CreateTaskCommand struct {
	AccountID, ServerID, IdempotencyKey string
	Title                               string
	Description                         *string
	OwnerMemberID                       *string
	SourceMessageRef                    *workport.MessageRef
}

type UpdateTaskCommand struct {
	AccountID, ServerID, TaskID, IdempotencyKey string
	Revision                                    int64
	Patch                                       workport.TaskPatch
}

type CreateReminderCommand struct {
	AccountID, ServerID, IdempotencyKey             string
	AgentID, ScheduleKind, Schedule, Timezone, Text string
}

type UpdateReminderCommand struct {
	AccountID, ServerID, ReminderID, IdempotencyKey string
	Revision                                        int64
	Patch                                           workport.ReminderPatch
}

type EnsureThreadCommand struct {
	AccountID, ServerID, ChannelID, IdempotencyKey string
	RootMessageRef                                 workport.MessageRef
}

type RegisterThreadReplyCommand struct {
	AccountID, ServerID, ChannelID, ThreadID, IdempotencyKey string
	MessageRef                                               workport.MessageRef
}

func (service *Service) CreateTask(
	ctx context.Context,
	command CreateTaskCommand,
) (workport.Task, error) {
	if err := validateMutation(command.AccountID, command.ServerID, command.IdempotencyKey); err != nil {
		return workport.Task{}, err
	}
	title := strings.TrimSpace(command.Title)
	if title == "" || len(title) > 500 || !utf8.ValidString(title) {
		return workport.Task{}, invalid("Task 标题无效")
	}
	description := normalizeOptional(command.Description)
	if description != nil && (len(*description) > 20000 || !utf8.ValidString(*description)) {
		return workport.Task{}, invalid("Task 描述无效")
	}
	if command.OwnerMemberID != nil && !validID(*command.OwnerMemberID) {
		return workport.Task{}, invalid("Task owner 无效")
	}
	if err := validateMessageRef(command.SourceMessageRef); err != nil {
		return workport.Task{}, err
	}
	id, err := service.ids.New()
	if err != nil {
		return workport.Task{}, internal(err)
	}
	var notificationOperationID *string
	if command.OwnerMemberID != nil {
		value, err := service.ids.New()
		if err != nil {
			return workport.Task{}, internal(err)
		}
		notificationOperationID = &value
	}
	mutation := service.mutation(
		command.AccountID, command.ServerID, command.IdempotencyKey,
		hashParts(title, valueOrEmpty(description), valueOrEmpty(command.OwnerMemberID)),
	)
	value, err := service.repository.CreateTask(ctx, mutation, workport.TaskDraft{
		ID: id, Title: title, Description: description,
		OwnerMemberID:           command.OwnerMemberID,
		SourceMessageRef:        command.SourceMessageRef,
		NotificationOperationID: notificationOperationID,
	})
	return value, mapError(err)
}

func (service *Service) ListTasks(
	ctx context.Context,
	accountID, serverID string,
	options workport.TaskListOptions,
) (workport.TaskPage, error) {
	if !validID(accountID) || !validID(serverID) || options.Limit < 1 || options.Limit > 100 ||
		(options.OwnerMemberID != nil && !validID(*options.OwnerMemberID)) {
		return workport.TaskPage{}, invalid("Task 列表参数无效")
	}
	filter := taskListFilter(accountID, serverID, options.OwnerMemberID, options.UpdatedAfter)
	if options.Cursor != "" {
		sort, err := pagination.Decode(options.Cursor, "listTasks", filter, 2)
		if err != nil || !validID(sort[1]) {
			return workport.TaskPage{}, apperror.New("invalid_cursor", "Task 分页游标无效", err)
		}
		updatedAt, parseErr := time.Parse(time.RFC3339Nano, sort[0])
		if parseErr != nil {
			return workport.TaskPage{}, apperror.New("invalid_cursor", "Task 分页游标无效", parseErr)
		}
		options.AfterUpdatedAt, options.AfterID = &updatedAt, sort[1]
	}
	page, err := service.repository.ListTasks(ctx, accountID, serverID, options)
	if err != nil {
		return workport.TaskPage{}, mapError(err)
	}
	if page.NextUpdatedAt != nil && page.NextID != "" {
		page.NextCursor, err = pagination.Encode(
			"listTasks", filter, page.NextUpdatedAt.UTC().Format(time.RFC3339Nano), page.NextID,
		)
		if err != nil {
			return workport.TaskPage{}, internal(err)
		}
	}
	return page, nil
}

func taskListFilter(accountID, serverID string, ownerID *string, updatedAfter *time.Time) string {
	owner, updated := "", ""
	if ownerID != nil {
		owner = *ownerID
	}
	if updatedAfter != nil {
		updated = updatedAfter.UTC().Format(time.RFC3339Nano)
	}
	return fmt.Sprintf("account=%s&server=%s&owner=%s&updatedAfter=%s", accountID, serverID, owner, updated)
}

func (service *Service) GetTask(
	ctx context.Context,
	accountID, serverID, taskID string,
) (workport.Task, error) {
	if !validID(accountID) || !validID(serverID) || !validID(taskID) {
		return workport.Task{}, invalid("Task 查询参数无效")
	}
	value, err := service.repository.GetTask(ctx, accountID, serverID, taskID)
	return value, mapError(err)
}

func (service *Service) UpdateTask(
	ctx context.Context,
	command UpdateTaskCommand,
) (workport.Task, error) {
	if err := validateMutation(command.AccountID, command.ServerID, command.IdempotencyKey); err != nil ||
		!validID(command.TaskID) || command.Revision < 1 {
		return workport.Task{}, invalid("Task 更新参数无效")
	}
	if err := validateTaskPatch(command.Patch); err != nil {
		return workport.Task{}, err
	}
	requestHash := hashTaskPatch(command.Revision, command.Patch)
	if command.Patch.OwnerMemberID != nil &&
		*command.Patch.OwnerMemberID != nil {
		operationID, err := service.ids.New()
		if err != nil {
			return workport.Task{}, internal(err)
		}
		command.Patch.NotificationOperationID = &operationID
	}
	value, err := service.repository.UpdateTask(
		ctx,
		service.mutation(
			command.AccountID, command.ServerID, command.IdempotencyKey,
			requestHash,
		),
		command.TaskID,
		command.Revision,
		command.Patch,
	)
	return value, mapError(err)
}

func hashTaskPatch(revision int64, patch workport.TaskPatch) [32]byte {
	parts := []string{fmt.Sprintf("revision=%d", revision)}
	if patch.Title == nil {
		parts = append(parts, "title=unset")
	} else {
		parts = append(parts, "title=set", *patch.Title)
	}
	if patch.Description == nil {
		parts = append(parts, "description=unset")
	} else if *patch.Description == nil {
		parts = append(parts, "description=null")
	} else {
		parts = append(parts, "description=set", **patch.Description)
	}
	if patch.Status == nil {
		parts = append(parts, "status=unset")
	} else {
		parts = append(parts, "status=set", *patch.Status)
	}
	if patch.OwnerMemberID == nil {
		parts = append(parts, "owner=unset")
	} else if *patch.OwnerMemberID == nil {
		parts = append(parts, "owner=null")
	} else {
		parts = append(parts, "owner=set", **patch.OwnerMemberID)
	}
	return hashParts(parts...)
}

func (service *Service) CreateReminder(
	ctx context.Context,
	command CreateReminderCommand,
) (workport.Reminder, error) {
	if err := validateMutation(command.AccountID, command.ServerID, command.IdempotencyKey); err != nil ||
		!validID(command.AgentID) {
		return workport.Reminder{}, invalid("Reminder 创建参数无效")
	}
	draft, err := service.reminderDraft(command)
	if err != nil {
		return workport.Reminder{}, err
	}
	id, err := service.ids.New()
	if err != nil {
		return workport.Reminder{}, internal(err)
	}
	draft.ID = id
	value, err := service.repository.CreateReminder(
		ctx,
		service.mutation(
			command.AccountID, command.ServerID, command.IdempotencyKey,
			hashParts(command.AgentID, draft.ScheduleKind, draft.Schedule, draft.Timezone, draft.Text),
		),
		draft,
	)
	return value, mapError(err)
}

func (service *Service) ListReminders(
	ctx context.Context,
	accountID, serverID string,
) ([]workport.Reminder, error) {
	if !validID(accountID) || !validID(serverID) {
		return nil, invalid("Reminder 列表参数无效")
	}
	values, err := service.repository.ListReminders(ctx, accountID, serverID)
	return values, mapError(err)
}

func (service *Service) GetReminder(
	ctx context.Context,
	accountID, serverID, reminderID string,
) (workport.Reminder, error) {
	if !validID(accountID) || !validID(serverID) || !validID(reminderID) {
		return workport.Reminder{}, invalid("Reminder 查询参数无效")
	}
	value, err := service.repository.GetReminder(ctx, accountID, serverID, reminderID)
	return value, mapError(err)
}

func (service *Service) UpdateReminder(
	ctx context.Context,
	command UpdateReminderCommand,
) (workport.Reminder, error) {
	if err := validateMutation(command.AccountID, command.ServerID, command.IdempotencyKey); err != nil ||
		!validID(command.ReminderID) || command.Revision < 1 {
		return workport.Reminder{}, invalid("Reminder 更新参数无效")
	}
	if err := validateReminderPatch(&command.Patch, service.clock.Now().UTC()); err != nil {
		return workport.Reminder{}, err
	}
	requestHash := hashParts(
		fmt.Sprintf("%d", command.Revision),
		fmt.Sprintf("%#v", command.Patch),
	)
	current, err := service.repository.GetReminder(
		ctx,
		command.AccountID,
		command.ServerID,
		command.ReminderID,
	)
	if err != nil {
		return workport.Reminder{}, mapError(err)
	}
	if err := service.prepareReminderPatch(&command.Patch, current); err != nil {
		return workport.Reminder{}, err
	}
	value, err := service.repository.UpdateReminder(
		ctx,
		service.mutation(
			command.AccountID, command.ServerID, command.IdempotencyKey,
			requestHash,
		),
		command.ReminderID,
		command.Revision,
		command.Patch,
	)
	return value, mapError(err)
}

func (service *Service) CancelReminder(
	ctx context.Context,
	accountID, serverID, reminderID string,
	revision int64,
	idempotencyKey string,
) error {
	if err := validateMutation(accountID, serverID, idempotencyKey); err != nil ||
		!validID(reminderID) || revision < 1 {
		return invalid("Reminder 取消参数无效")
	}
	return mapError(service.repository.CancelReminder(
		ctx,
		service.mutation(
			accountID, serverID, idempotencyKey,
			hashParts(reminderID, strconv.FormatInt(revision, 10)),
		),
		reminderID,
		revision,
	))
}

func (service *Service) ListInbox(
	ctx context.Context,
	accountID, serverID string,
) ([]workport.InboxItem, error) {
	if !validID(accountID) || !validID(serverID) {
		return nil, invalid("Inbox 参数无效")
	}
	values, err := service.repository.ListInbox(ctx, accountID, serverID)
	return values, mapError(err)
}

func (service *Service) ListActivity(
	ctx context.Context,
	accountID, serverID string,
) ([]workport.ActivityItem, error) {
	if !validID(accountID) || !validID(serverID) {
		return nil, invalid("Activity 参数无效")
	}
	values, err := service.repository.ListActivity(ctx, accountID, serverID)
	return values, mapError(err)
}

func (service *Service) EnsureThread(
	ctx context.Context,
	command EnsureThreadCommand,
) (workport.MessageThread, error) {
	if err := validateMutation(
		command.AccountID,
		command.ServerID,
		command.IdempotencyKey,
	); err != nil || !validID(command.ChannelID) {
		return workport.MessageThread{}, invalid("Thread 创建参数无效")
	}
	if err := validateThreadMessageRef(command.RootMessageRef); err != nil {
		return workport.MessageThread{}, err
	}
	id, err := service.ids.New()
	if err != nil {
		return workport.MessageThread{}, internal(err)
	}
	value, err := service.repository.EnsureThread(
		ctx,
		service.mutation(
			command.AccountID,
			command.ServerID,
			command.IdempotencyKey,
			hashThreadMessageRef(command.ChannelID, command.RootMessageRef),
		),
		command.ChannelID,
		workport.ThreadDraft{
			ID: id, ChannelID: command.ChannelID,
			RootMessageRef: command.RootMessageRef,
		},
	)
	return value, mapError(err)
}

func (service *Service) GetThread(
	ctx context.Context,
	accountID, serverID, channelID, threadID string,
) (workport.MessageThread, error) {
	if !validID(accountID) || !validID(serverID) ||
		!validID(channelID) || !validID(threadID) {
		return workport.MessageThread{}, invalid("Thread 查询参数无效")
	}
	value, err := service.repository.GetThread(
		ctx, accountID, serverID, channelID, threadID,
	)
	return value, mapError(err)
}

func (service *Service) ListThreadReplies(
	ctx context.Context,
	accountID, serverID, channelID, threadID, cursor string,
	limit int,
) (workport.ThreadReplyPage, error) {
	if !validID(accountID) || !validID(serverID) ||
		!validID(channelID) || !validID(threadID) ||
		limit < 1 || limit > 100 || len(cursor) > 512 {
		return workport.ThreadReplyPage{}, invalid("Thread 分页参数无效")
	}
	filter := fmt.Sprintf(
		"account=%s&server=%s&channel=%s&thread=%s",
		accountID, serverID, channelID, threadID,
	)
	options := workport.ThreadReplyListOptions{Limit: limit}
	if cursor != "" {
		sort, err := pagination.Decode(cursor, "listThreadReplies", filter, 2)
		if err != nil || !validID(sort[1]) {
			return workport.ThreadReplyPage{}, apperror.New("invalid_cursor", "Thread 分页游标无效", err)
		}
		sequence, parseErr := strconv.ParseInt(sort[0], 10, 64)
		if parseErr != nil || sequence < 1 {
			return workport.ThreadReplyPage{}, apperror.New("invalid_cursor", "Thread 分页游标无效", parseErr)
		}
		options.AfterSequence, options.AfterID = &sequence, sort[1]
	}
	value, err := service.repository.ListThreadReplies(
		ctx, accountID, serverID, channelID, threadID, options,
	)
	if err != nil {
		return workport.ThreadReplyPage{}, mapError(err)
	}
	if value.NextSequence != nil && value.NextID != "" {
		next, encodeErr := pagination.Encode(
			"listThreadReplies", filter, strconv.FormatInt(*value.NextSequence, 10), value.NextID,
		)
		if encodeErr != nil {
			return workport.ThreadReplyPage{}, internal(encodeErr)
		}
		value.NextCursor = &next
	}
	return value, nil
}

func (service *Service) RegisterThreadReply(
	ctx context.Context,
	command RegisterThreadReplyCommand,
) (workport.ThreadReplyReference, error) {
	if err := validateMutation(
		command.AccountID,
		command.ServerID,
		command.IdempotencyKey,
	); err != nil || !validID(command.ChannelID) || !validID(command.ThreadID) {
		return workport.ThreadReplyReference{}, invalid("Thread 回复参数无效")
	}
	if err := validateThreadMessageRef(command.MessageRef); err != nil {
		return workport.ThreadReplyReference{}, err
	}
	id, err := service.ids.New()
	if err != nil {
		return workport.ThreadReplyReference{}, internal(err)
	}
	value, err := service.repository.RegisterThreadReply(
		ctx,
		service.mutation(
			command.AccountID,
			command.ServerID,
			command.IdempotencyKey,
			hashThreadMessageRef(command.ThreadID, command.MessageRef),
		),
		command.ChannelID,
		command.ThreadID,
		workport.ThreadReplyDraft{
			ID: id, ThreadID: command.ThreadID,
			MessageRef: command.MessageRef,
		},
	)
	return value, mapError(err)
}

func (service *Service) MarkThreadRead(
	ctx context.Context,
	accountID, serverID, channelID, threadID, lastReadRefID,
	idempotencyKey string,
) error {
	if err := validateMutation(
		accountID, serverID, idempotencyKey,
	); err != nil || !validID(channelID) || !validID(threadID) ||
		!validID(lastReadRefID) {
		return invalid("Thread 已读参数无效")
	}
	return mapError(service.repository.MarkThreadRead(
		ctx,
		service.mutation(
			accountID,
			serverID,
			idempotencyKey,
			hashParts(channelID, threadID, lastReadRefID),
		),
		channelID,
		threadID,
		lastReadRefID,
	))
}

func (service *Service) reminderDraft(command CreateReminderCommand) (workport.ReminderDraft, error) {
	kind := strings.TrimSpace(command.ScheduleKind)
	expression := strings.TrimSpace(command.Schedule)
	timezone := strings.TrimSpace(command.Timezone)
	text := strings.TrimSpace(command.Text)
	if (kind != "once" && kind != "cron") || expression == "" ||
		len(expression) > 200 || timezone == "" || len(timezone) > 100 ||
		text == "" || len(text) > 5000 || !utf8.ValidString(text) {
		return workport.ReminderDraft{}, invalid("Reminder 内容无效")
	}
	if _, err := time.LoadLocation(timezone); err != nil {
		return workport.ReminderDraft{}, invalid("Reminder 时区无效")
	}
	value, err := schedule.NextReminderFire(
		kind,
		expression,
		timezone,
		service.clock.Now().UTC(),
	)
	if err != nil {
		return workport.ReminderDraft{}, invalid(err.Error())
	}
	next := &value
	return workport.ReminderDraft{
		AgentID: command.AgentID, ScheduleKind: kind, Schedule: expression,
		Timezone: timezone, Text: text, NextFireAt: next,
	}, nil
}

func (service *Service) prepareReminderPatch(
	patch *workport.ReminderPatch,
	current workport.Reminder,
) error {
	status := current.Status
	if patch.Status != nil {
		status = *patch.Status
	}
	if status == "paused" || status == "canceled" {
		var cleared *time.Time
		patch.NextFireAt = &cleared
		return nil
	}
	needsNext := patch.Schedule != nil || patch.Timezone != nil ||
		(patch.Status != nil && current.Status != "active")
	if !needsNext {
		return nil
	}
	expression := current.Schedule
	if patch.Schedule != nil {
		expression = *patch.Schedule
	}
	timezone := current.Timezone
	if patch.Timezone != nil {
		timezone = *patch.Timezone
	}
	next, err := schedule.NextReminderFire(
		current.ScheduleKind,
		expression,
		timezone,
		service.clock.Now().UTC(),
	)
	if err != nil {
		return invalid(err.Error())
	}
	nextValue := &next
	patch.NextFireAt = &nextValue
	return nil
}

func validateTaskPatch(patch workport.TaskPatch) error {
	if patch.Title == nil && patch.Description == nil &&
		patch.Status == nil && patch.OwnerMemberID == nil {
		return invalid("Task 更新内容不能为空")
	}
	if patch.Title != nil {
		*patch.Title = strings.TrimSpace(*patch.Title)
		if *patch.Title == "" || len(*patch.Title) > 500 {
			return invalid("Task 标题无效")
		}
	}
	if patch.Status != nil && !oneOf(*patch.Status, "todo", "in_progress", "in_review", "done", "closed") {
		return invalid("Task 状态无效")
	}
	if patch.OwnerMemberID != nil && *patch.OwnerMemberID != nil &&
		!validID(**patch.OwnerMemberID) {
		return invalid("Task owner 无效")
	}
	return nil
}

func validateReminderPatch(patch *workport.ReminderPatch, now time.Time) error {
	if patch.Schedule == nil && patch.Timezone == nil && patch.Text == nil &&
		patch.Status == nil {
		return invalid("Reminder 更新内容不能为空")
	}
	if patch.Text != nil {
		*patch.Text = strings.TrimSpace(*patch.Text)
		if *patch.Text == "" || len(*patch.Text) > 5000 {
			return invalid("Reminder 文本无效")
		}
	}
	if patch.Status != nil && !oneOf(*patch.Status, "active", "paused", "canceled") {
		return invalid("Reminder 状态无效")
	}
	if patch.Timezone != nil {
		*patch.Timezone = strings.TrimSpace(*patch.Timezone)
		if _, err := time.LoadLocation(*patch.Timezone); err != nil {
			return invalid("Reminder 时区无效")
		}
	}
	if patch.Schedule != nil {
		*patch.Schedule = strings.TrimSpace(*patch.Schedule)
		if *patch.Schedule == "" || len(*patch.Schedule) > 200 {
			return invalid("Reminder schedule 无效")
		}
		if value, err := time.Parse(time.RFC3339, *patch.Schedule); err == nil {
			if !value.After(now) {
				return invalid("Reminder 时间必须在未来")
			}
			value = value.UTC()
			next := &value
			patch.NextFireAt = &next
		}
	}
	return nil
}

func validateMessageRef(ref *workport.MessageRef) error {
	if ref == nil {
		return nil
	}
	if (ref.Kind != "c2c" && ref.Kind != "group") ||
		strings.TrimSpace(ref.MessageID) == "" {
		return invalid("消息引用无效")
	}
	return nil
}

func validateThreadMessageRef(ref workport.MessageRef) error {
	if err := validateMessageRef(&ref); err != nil {
		return err
	}
	if len(ref.MessageID) > 512 || ref.Sequence == nil ||
		ref.Timestamp == nil || *ref.Sequence < 1 || *ref.Timestamp < 1 {
		return invalid("Thread 消息引用缺少腾讯 sequence 或 timestamp")
	}
	return nil
}

func hashThreadMessageRef(
	scope string,
	ref workport.MessageRef,
) [32]byte {
	return hashParts(
		scope,
		ref.Kind,
		ref.MessageID,
		valueOrEmpty(ref.GroupID),
		valueOrEmpty(ref.TopicID),
		valueOrEmpty(ref.SenderUserID),
		fmt.Sprintf("%d", *ref.Sequence),
		fmt.Sprintf("%d", *ref.Timestamp),
	)
}

func (service *Service) mutation(
	accountID, serverID, key string,
	hash [32]byte,
) workport.Mutation {
	return workport.Mutation{
		AccountID: accountID, ServerID: serverID,
		IdempotencyKey: strings.TrimSpace(key), RequestHash: hash,
		Now: service.clock.Now().UTC(),
	}
}

func validateMutation(accountID, serverID, key string) error {
	if !validID(accountID) || !validID(serverID) || strings.TrimSpace(key) == "" {
		return invalid("Work 写入参数无效")
	}
	return nil
}

func normalizeOptional(value *string) *string {
	if value == nil {
		return nil
	}
	normalized := strings.TrimSpace(*value)
	return &normalized
}

func valueOrEmpty(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func hashParts(parts ...string) [32]byte {
	return sha256.Sum256([]byte(strings.Join(parts, "\x00")))
}

func validID(value string) bool {
	parsed, err := uuid.Parse(value)
	return err == nil && parsed != uuid.Nil && parsed.Version() == 7
}

func oneOf(value string, values ...string) bool {
	for _, allowed := range values {
		if value == allowed {
			return true
		}
	}
	return false
}

func invalid(message string) error {
	return apperror.New("invalid_request", message, nil)
}

func internal(err error) error {
	return apperror.New("internal_error", "暂时无法处理 Work 请求", err)
}

func mapError(err error) error {
	if err == nil {
		return nil
	}
	switch {
	case errors.Is(err, workport.ErrForbidden):
		return apperror.New("permission_denied", "没有访问该 Work 资源的权限", err)
	case errors.Is(err, workport.ErrNotFound):
		return apperror.New("resource_not_found", "Work 资源不存在", err)
	case errors.Is(err, workport.ErrRevisionConflict):
		return apperror.New("revision_conflict", "Work 资源版本冲突", err)
	case errors.Is(err, workport.ErrIdempotencyConflict):
		return apperror.New("idempotency_conflict", "幂等键与原请求不一致", err)
	case errors.Is(err, workport.ErrInvalidOwner):
		return apperror.New("invalid_request", "Task owner 不是当前 Server 的 active Member", err)
	case errors.Is(err, workport.ErrInvalidAgent):
		return apperror.New("invalid_request", "Reminder Agent 不属于当前 Server", err)
	default:
		return internal(err)
	}
}
