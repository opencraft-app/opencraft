package httptransport

import (
	"context"
	"errors"

	"chatserver/internal/api/openapi"
	appwork "chatserver/internal/app/workmanagement"
	"chatserver/internal/apperror"
	workport "chatserver/internal/ports/work"

	"github.com/google/uuid"
)

type workService interface {
	ListTasks(context.Context, string, string, workport.TaskListOptions) (workport.TaskPage, error)
	GetTask(context.Context, string, string, string) (workport.Task, error)
	CreateTask(context.Context, appwork.CreateTaskCommand) (workport.Task, error)
	UpdateTask(context.Context, appwork.UpdateTaskCommand) (workport.Task, error)

	ListReminders(context.Context, string, string) ([]workport.Reminder, error)
	GetReminder(context.Context, string, string, string) (workport.Reminder, error)
	CreateReminder(context.Context, appwork.CreateReminderCommand) (workport.Reminder, error)
	UpdateReminder(context.Context, appwork.UpdateReminderCommand) (workport.Reminder, error)
	CancelReminder(context.Context, string, string, string, int64, string) error

	ListInbox(context.Context, string, string) ([]workport.InboxItem, error)
	ListActivity(context.Context, string, string) ([]workport.ActivityItem, error)
	EnsureThread(
		context.Context,
		appwork.EnsureThreadCommand,
	) (workport.MessageThread, error)
	GetThread(
		context.Context,
		string,
		string,
		string,
		string,
	) (workport.MessageThread, error)
	ListThreadReplies(
		context.Context,
		string,
		string,
		string,
		string,
		string,
		int,
	) (workport.ThreadReplyPage, error)
	RegisterThreadReply(
		context.Context,
		appwork.RegisterThreadReplyCommand,
	) (workport.ThreadReplyReference, error)
	MarkThreadRead(
		context.Context,
		string,
		string,
		string,
		string,
		string,
		string,
	) error
}

// WorkHandler 实现 Human 使用的 Task、Reminder、Inbox 与 Activity 操作。
type WorkHandler struct {
	openapi.StrictServerInterface
	service workService
}

var _ openapi.StrictServerInterface = (*WorkHandler)(nil)

func NewWorkHandler(service workService) (*WorkHandler, error) {
	if service == nil {
		return nil, errors.New("Work 应用服务不能为空")
	}
	return &WorkHandler{service: service}, nil
}

func (handler *WorkHandler) ListTasks(
	ctx context.Context,
	request openapi.ListTasksRequestObject,
) (openapi.ListTasksResponseObject, error) {
	accountID, err := currentWorkAccountID(ctx)
	if err != nil {
		return nil, err
	}
	options := workport.TaskListOptions{Limit: intValue(request.Params.Limit, 50)}
	if request.Params.Cursor != nil {
		options.Cursor = string(*request.Params.Cursor)
	}
	options.OwnerMemberID = request.Params.Owner
	options.UpdatedAfter = request.Params.UpdatedAfter
	page, err := handler.service.ListTasks(
		ctx, accountID, request.ServerId.String(), options,
	)
	if err != nil {
		return nil, err
	}
	items := make([]openapi.Task, 0, len(page.Items))
	for _, value := range page.Items {
		item, err := taskDTO(value)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	var next *openapi.NullableCursor
	if page.NextCursor != "" {
		value := openapi.NullableCursor(page.NextCursor)
		next = &value
	}
	return openapi.ListTasks200JSONResponse{Items: items, NextCursor: next}, nil
}

func intValue(value *openapi.Limit, fallback int) int {
	if value == nil {
		return fallback
	}
	return int(*value)
}

func (handler *WorkHandler) GetTask(
	ctx context.Context,
	request openapi.GetTaskRequestObject,
) (openapi.GetTaskResponseObject, error) {
	accountID, err := currentWorkAccountID(ctx)
	if err != nil {
		return nil, err
	}
	value, err := handler.service.GetTask(
		ctx,
		accountID,
		request.ServerId.String(),
		request.TaskId.String(),
	)
	if err != nil {
		return nil, err
	}
	result, err := taskDTO(value)
	return openapi.GetTask200JSONResponse(result), err
}

func (handler *WorkHandler) CreateTask(
	ctx context.Context,
	request openapi.CreateTaskRequestObject,
) (openapi.CreateTaskResponseObject, error) {
	accountID, err := currentWorkAccountID(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return nil, apperror.New("invalid_request", "Task 请求体不能为空", nil)
	}
	value, err := handler.service.CreateTask(ctx, appwork.CreateTaskCommand{
		AccountID: accountID, ServerID: request.ServerId.String(),
		IdempotencyKey: string(request.Params.IdempotencyKey),
		Title:          request.Body.Title,
		Description:    request.Body.Description,
		OwnerMemberID:  uuidString(request.Body.OwnerMemberId),
		SourceMessageRef: workMessageRef(
			request.Body.SourceMessageRef,
		),
	})
	if err != nil {
		return nil, err
	}
	result, err := taskDTO(value)
	return openapi.CreateTask201JSONResponse(result), err
}

func (handler *WorkHandler) UpdateTask(
	ctx context.Context,
	request openapi.UpdateTaskRequestObject,
) (openapi.UpdateTaskResponseObject, error) {
	accountID, err := currentWorkAccountID(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return nil, apperror.New("invalid_request", "Task 请求体不能为空", nil)
	}
	revision, err := workRevision(request.Params.XResourceRevision)
	if err != nil {
		return nil, err
	}
	patch := workport.TaskPatch{
		Title:       request.Body.Title,
		Description: optionalStringPatch(request.Body.Description),
		Status:      taskStatus(request.Body.Status),
		OwnerMemberID: optionalUUIDPatch(
			request.Body.OwnerMemberId,
		),
	}
	value, err := handler.service.UpdateTask(ctx, appwork.UpdateTaskCommand{
		AccountID: accountID, ServerID: request.ServerId.String(),
		TaskID: request.TaskId.String(), Revision: revision,
		IdempotencyKey: string(request.Params.IdempotencyKey),
		Patch:          patch,
	})
	if err != nil {
		return nil, err
	}
	result, err := taskDTO(value)
	if err != nil {
		return nil, err
	}
	return openapi.UpdateTask200JSONResponse{
		Body: result,
		Headers: openapi.UpdateTask200ResponseHeaders{
			XResourceRevision: result.Revision,
		},
	}, nil
}

func (handler *WorkHandler) ListReminders(
	ctx context.Context,
	request openapi.ListRemindersRequestObject,
) (openapi.ListRemindersResponseObject, error) {
	accountID, err := currentWorkAccountID(ctx)
	if err != nil {
		return nil, err
	}
	values, err := handler.service.ListReminders(
		ctx, accountID, request.ServerId.String(),
	)
	if err != nil {
		return nil, err
	}
	result := make(openapi.ListReminders200JSONResponse, 0, len(values))
	for _, value := range values {
		item, err := reminderDTO(value)
		if err != nil {
			return nil, err
		}
		result = append(result, item)
	}
	return result, nil
}

func (handler *WorkHandler) GetReminder(
	ctx context.Context,
	request openapi.GetReminderRequestObject,
) (openapi.GetReminderResponseObject, error) {
	accountID, err := currentWorkAccountID(ctx)
	if err != nil {
		return nil, err
	}
	value, err := handler.service.GetReminder(
		ctx,
		accountID,
		request.ServerId.String(),
		request.ReminderId.String(),
	)
	if err != nil {
		return nil, err
	}
	result, err := reminderDTO(value)
	return openapi.GetReminder200JSONResponse(result), err
}

func (handler *WorkHandler) CreateReminder(
	ctx context.Context,
	request openapi.CreateReminderRequestObject,
) (openapi.CreateReminderResponseObject, error) {
	accountID, err := currentWorkAccountID(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return nil, apperror.New("invalid_request", "Reminder 请求体不能为空", nil)
	}
	value, err := handler.service.CreateReminder(
		ctx,
		appwork.CreateReminderCommand{
			AccountID: accountID, ServerID: request.ServerId.String(),
			IdempotencyKey: string(request.Params.IdempotencyKey),
			AgentID:        request.Body.AgentId.String(),
			ScheduleKind:   string(request.Body.ScheduleKind),
			Schedule:       request.Body.Schedule,
			Timezone:       request.Body.Timezone,
			Text:           request.Body.Text,
		},
	)
	if err != nil {
		return nil, err
	}
	result, err := reminderDTO(value)
	return openapi.CreateReminder201JSONResponse(result), err
}

func (handler *WorkHandler) UpdateReminder(
	ctx context.Context,
	request openapi.UpdateReminderRequestObject,
) (openapi.UpdateReminderResponseObject, error) {
	accountID, err := currentWorkAccountID(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return nil, apperror.New("invalid_request", "Reminder 请求体不能为空", nil)
	}
	revision, err := workRevision(request.Params.XResourceRevision)
	if err != nil {
		return nil, err
	}
	value, err := handler.service.UpdateReminder(
		ctx,
		appwork.UpdateReminderCommand{
			AccountID: accountID, ServerID: request.ServerId.String(),
			ReminderID: request.ReminderId.String(), Revision: revision,
			IdempotencyKey: string(request.Params.IdempotencyKey),
			Patch: workport.ReminderPatch{
				Schedule: request.Body.Schedule,
				Timezone: request.Body.Timezone,
				Text:     request.Body.Text,
				Status:   reminderStatus(request.Body.Status),
			},
		},
	)
	if err != nil {
		return nil, err
	}
	result, err := reminderDTO(value)
	if err != nil {
		return nil, err
	}
	return openapi.UpdateReminder200JSONResponse{
		Body: result,
		Headers: openapi.UpdateReminder200ResponseHeaders{
			XResourceRevision: result.Revision,
		},
	}, nil
}

func (handler *WorkHandler) CancelReminder(
	ctx context.Context,
	request openapi.CancelReminderRequestObject,
) (openapi.CancelReminderResponseObject, error) {
	accountID, err := currentWorkAccountID(ctx)
	if err != nil {
		return nil, err
	}
	if err := handler.service.CancelReminder(
		ctx,
		accountID,
		request.ServerId.String(),
		request.ReminderId.String(),
		int64(request.Params.XResourceRevision),
		string(request.Params.IdempotencyKey),
	); err != nil {
		return nil, err
	}
	return openapi.CancelReminder204Response{}, nil
}

func (handler *WorkHandler) ListInbox(
	ctx context.Context,
	request openapi.ListInboxRequestObject,
) (openapi.ListInboxResponseObject, error) {
	accountID, err := currentWorkAccountID(ctx)
	if err != nil {
		return nil, err
	}
	values, err := handler.service.ListInbox(
		ctx, accountID, request.ServerId.String(),
	)
	if err != nil {
		return nil, err
	}
	result := make(openapi.ListInbox200JSONResponse, 0, len(values))
	for _, value := range values {
		item, err := inboxItemDTO(value)
		if err != nil {
			return nil, err
		}
		result = append(result, item)
	}
	return result, nil
}

func (handler *WorkHandler) ListActivity(
	ctx context.Context,
	request openapi.ListActivityRequestObject,
) (openapi.ListActivityResponseObject, error) {
	accountID, err := currentWorkAccountID(ctx)
	if err != nil {
		return nil, err
	}
	values, err := handler.service.ListActivity(
		ctx, accountID, request.ServerId.String(),
	)
	if err != nil {
		return nil, err
	}
	result := make(openapi.ListActivity200JSONResponse, 0, len(values))
	for _, value := range values {
		item, err := activityItemDTO(value)
		if err != nil {
			return nil, err
		}
		result = append(result, item)
	}
	return result, nil
}

func (handler *WorkHandler) EnsureMessageThread(
	ctx context.Context,
	request openapi.EnsureMessageThreadRequestObject,
) (openapi.EnsureMessageThreadResponseObject, error) {
	accountID, err := currentWorkAccountID(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return nil, apperror.New(
			"invalid_request", "Thread 请求体不能为空", nil,
		)
	}
	value, err := handler.service.EnsureThread(
		ctx,
		appwork.EnsureThreadCommand{
			AccountID:      accountID,
			ServerID:       request.ServerId.String(),
			ChannelID:      request.ChannelId.String(),
			IdempotencyKey: string(request.Params.IdempotencyKey),
			RootMessageRef: threadMessageRef(request.Body.RootMessageRef),
		},
	)
	if err != nil {
		return nil, err
	}
	result, err := messageThreadDTO(value)
	return openapi.EnsureMessageThread201JSONResponse(result), err
}

func (handler *WorkHandler) GetMessageThread(
	ctx context.Context,
	request openapi.GetMessageThreadRequestObject,
) (openapi.GetMessageThreadResponseObject, error) {
	accountID, err := currentWorkAccountID(ctx)
	if err != nil {
		return nil, err
	}
	value, err := handler.service.GetThread(
		ctx,
		accountID,
		request.ServerId.String(),
		request.ChannelId.String(),
		request.ThreadId.String(),
	)
	if err != nil {
		return nil, err
	}
	result, err := messageThreadDTO(value)
	return openapi.GetMessageThread200JSONResponse(result), err
}

func (handler *WorkHandler) ListMessageThreadReplies(
	ctx context.Context,
	request openapi.ListMessageThreadRepliesRequestObject,
) (openapi.ListMessageThreadRepliesResponseObject, error) {
	accountID, err := currentWorkAccountID(ctx)
	if err != nil {
		return nil, err
	}
	limit := 20
	if request.Params.Limit != nil {
		limit = int(*request.Params.Limit)
	}
	cursor := ""
	if request.Params.Cursor != nil {
		cursor = string(*request.Params.Cursor)
	}
	page, err := handler.service.ListThreadReplies(
		ctx,
		accountID,
		request.ServerId.String(),
		request.ChannelId.String(),
		request.ThreadId.String(),
		cursor,
		limit,
	)
	if err != nil {
		return nil, err
	}
	items := make(
		[]openapi.ThreadReplyReference,
		0,
		len(page.Items),
	)
	for _, value := range page.Items {
		item, err := threadReplyDTO(value)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return openapi.ListMessageThreadReplies200JSONResponse{
		Items: items, NextCursor: page.NextCursor,
	}, nil
}

func (handler *WorkHandler) RegisterMessageThreadReply(
	ctx context.Context,
	request openapi.RegisterMessageThreadReplyRequestObject,
) (openapi.RegisterMessageThreadReplyResponseObject, error) {
	accountID, err := currentWorkAccountID(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return nil, apperror.New(
			"invalid_request", "Thread 回复请求体不能为空", nil,
		)
	}
	value, err := handler.service.RegisterThreadReply(
		ctx,
		appwork.RegisterThreadReplyCommand{
			AccountID:      accountID,
			ServerID:       request.ServerId.String(),
			ChannelID:      request.ChannelId.String(),
			ThreadID:       request.ThreadId.String(),
			IdempotencyKey: string(request.Params.IdempotencyKey),
			MessageRef:     threadMessageRef(request.Body.MessageRef),
		},
	)
	if err != nil {
		return nil, err
	}
	result, err := threadReplyDTO(value)
	return openapi.RegisterMessageThreadReply201JSONResponse(result), err
}

func (handler *WorkHandler) MarkMessageThreadRead(
	ctx context.Context,
	request openapi.MarkMessageThreadReadRequestObject,
) (openapi.MarkMessageThreadReadResponseObject, error) {
	accountID, err := currentWorkAccountID(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return nil, apperror.New(
			"invalid_request", "Thread 已读请求体不能为空", nil,
		)
	}
	if err := handler.service.MarkThreadRead(
		ctx,
		accountID,
		request.ServerId.String(),
		request.ChannelId.String(),
		request.ThreadId.String(),
		request.Body.LastReadRefId.String(),
		string(request.Params.IdempotencyKey),
	); err != nil {
		return nil, err
	}
	return openapi.MarkMessageThreadRead204Response{}, nil
}

func currentWorkAccountID(ctx context.Context) (string, error) {
	principal, ok := CurrentHumanPrincipal(ctx)
	if !ok {
		return "", apperror.New("unauthenticated", "登录凭证无效", nil)
	}
	return principal.AccountID(), nil
}

func workRevision(value openapi.ResourceRevision) (int64, error) {
	revision := int64(value)
	if revision < 0 {
		return 0, apperror.New("invalid_request", "X-Resource-Revision 无效", nil)
	}
	return revision, nil
}

func taskDTO(value workport.Task) (openapi.Task, error) {
	id, err := requiredWorkUUID(value.ID)
	if err != nil {
		return openapi.Task{}, err
	}
	serverID, err := requiredWorkUUID(value.ServerID)
	if err != nil {
		return openapi.Task{}, err
	}
	createdBy, err := requiredWorkUUID(value.CreatedByMemberID)
	if err != nil {
		return openapi.Task{}, err
	}
	updatedBy, err := requiredWorkUUID(value.UpdatedByMemberID)
	if err != nil {
		return openapi.Task{}, err
	}
	if value.Number < 1 {
		return openapi.Task{}, invalidWorkData()
	}
	result := openapi.Task{
		Id: id, ServerId: serverID, Number: int(value.Number),
		Title: value.Title, Description: value.Description,
		Status:             openapi.TaskStatus(value.Status),
		AssignmentRevision: value.AssignmentRevision,
		CreatedByMemberId:  createdBy, UpdatedByMemberId: updatedBy,
		Revision: value.Revision,
	}
	if value.OwnerMemberID != nil {
		owner, err := requiredWorkUUID(*value.OwnerMemberID)
		if err != nil {
			return openapi.Task{}, err
		}
		result.OwnerMemberId = &owner
	}
	if value.SourceMessageRef != nil {
		result.SourceMessageRef = &openapi.IMMessageRef{
			Kind:         openapi.IMMessageRefKind(value.SourceMessageRef.Kind),
			MessageId:    value.SourceMessageRef.MessageID,
			GroupId:      value.SourceMessageRef.GroupID,
			TopicId:      value.SourceMessageRef.TopicID,
			SenderUserId: value.SourceMessageRef.SenderUserID,
			Sequence:     value.SourceMessageRef.Sequence,
			Timestamp:    value.SourceMessageRef.Timestamp,
		}
	}
	return result, nil
}

func messageThreadDTO(
	value workport.MessageThread,
) (openapi.MessageThread, error) {
	id, err := requiredWorkUUID(value.ID)
	if err != nil {
		return openapi.MessageThread{}, err
	}
	serverID, err := requiredWorkUUID(value.ServerID)
	if err != nil {
		return openapi.MessageThread{}, err
	}
	channelID, err := requiredWorkUUID(value.ChannelID)
	if err != nil {
		return openapi.MessageThread{}, err
	}
	root, err := threadMessageRefDTO(value.RootMessageRef)
	if err != nil {
		return openapi.MessageThread{}, err
	}
	if value.ReplyCount < 0 || value.UnreadCount < 0 {
		return openapi.MessageThread{}, invalidWorkData()
	}
	return openapi.MessageThread{
		Id: id, ServerId: serverID, ChannelId: channelID,
		RootMessageRef: root, ReplyCount: value.ReplyCount,
		UnreadCount: value.UnreadCount, LastReplyAt: value.LastReplyAt,
		CreatedAt: value.CreatedAt,
	}, nil
}

func threadReplyDTO(
	value workport.ThreadReplyReference,
) (openapi.ThreadReplyReference, error) {
	id, err := requiredWorkUUID(value.ID)
	if err != nil {
		return openapi.ThreadReplyReference{}, err
	}
	threadID, err := requiredWorkUUID(value.ThreadID)
	if err != nil {
		return openapi.ThreadReplyReference{}, err
	}
	ref, err := threadMessageRefDTO(value.MessageRef)
	if err != nil {
		return openapi.ThreadReplyReference{}, err
	}
	return openapi.ThreadReplyReference{
		Id: id, ThreadId: threadID, MessageRef: ref,
		CreatedAt: value.CreatedAt,
	}, nil
}

func threadMessageRefDTO(
	value workport.MessageRef,
) (openapi.ThreadMessageRef, error) {
	if value.Sequence == nil || value.Timestamp == nil ||
		*value.Sequence < 1 || *value.Timestamp < 1 {
		return openapi.ThreadMessageRef{}, invalidWorkData()
	}
	return openapi.ThreadMessageRef{
		Kind:      openapi.ThreadMessageRefKind(value.Kind),
		MessageId: value.MessageID, GroupId: value.GroupID,
		TopicId: value.TopicID, SenderUserId: value.SenderUserID,
		Sequence: *value.Sequence, Timestamp: *value.Timestamp,
	}, nil
}

func reminderDTO(value workport.Reminder) (openapi.Reminder, error) {
	id, err := requiredWorkUUID(value.ID)
	if err != nil {
		return openapi.Reminder{}, err
	}
	serverID, err := requiredWorkUUID(value.ServerID)
	if err != nil {
		return openapi.Reminder{}, err
	}
	agentID, err := requiredWorkUUID(value.AgentID)
	if err != nil {
		return openapi.Reminder{}, err
	}
	createdBy, err := requiredWorkUUID(value.CreatedByMemberID)
	if err != nil {
		return openapi.Reminder{}, err
	}
	return openapi.Reminder{
		Id: id, ServerId: serverID, AgentId: agentID,
		CreatedByMemberId: createdBy,
		ScheduleKind:      openapi.ReminderScheduleKind(value.ScheduleKind),
		Schedule:          value.Schedule, Timezone: value.Timezone, Text: value.Text,
		Status:     openapi.ReminderStatus(value.Status),
		NextFireAt: value.NextFireAt, Revision: value.Revision,
	}, nil
}

func inboxItemDTO(value workport.InboxItem) (openapi.InboxItem, error) {
	id, err := requiredWorkUUID(value.ID)
	if err != nil {
		return openapi.InboxItem{}, err
	}
	serverID, err := requiredWorkUUID(value.ServerID)
	if err != nil {
		return openapi.InboxItem{}, err
	}
	resourceID, err := requiredWorkUUID(value.ResourceID)
	if err != nil {
		return openapi.InboxItem{}, err
	}
	return openapi.InboxItem{
		Id: id, ServerId: serverID,
		Kind:  openapi.InboxItemKind(value.Kind),
		Title: value.Title, Status: openapi.InboxItemStatus(value.Status),
		ResourceId: resourceID, UpdatedAt: value.UpdatedAt,
	}, nil
}

func activityItemDTO(value workport.ActivityItem) (openapi.ActivityItem, error) {
	id, err := requiredWorkUUID(value.ID)
	if err != nil {
		return openapi.ActivityItem{}, err
	}
	serverID, err := requiredWorkUUID(value.ServerID)
	if err != nil {
		return openapi.ActivityItem{}, err
	}
	resourceID, err := requiredWorkUUID(value.ResourceID)
	if err != nil {
		return openapi.ActivityItem{}, err
	}
	return openapi.ActivityItem{
		Id: id, ServerId: serverID,
		Kind:         openapi.ActivityItemKind(value.Kind),
		ResourceType: openapi.ActivityItemResourceType(value.ResourceType),
		ResourceId:   resourceID, Summary: value.Summary,
		OccurredAt: value.OccurredAt,
	}, nil
}

func requiredWorkUUID(value string) (uuid.UUID, error) {
	id, err := uuid.Parse(value)
	if err != nil || id == uuid.Nil {
		return uuid.Nil, invalidWorkData()
	}
	return id, nil
}

func invalidWorkData() error {
	return apperror.New("internal_error", "Work 数据无效", nil)
}

func uuidString(value *openapi.NullableId) *string {
	if value == nil {
		return nil
	}
	result := value.String()
	return &result
}

func workMessageRef(value *openapi.NullableIMMessageRef) *workport.MessageRef {
	if value == nil {
		return nil
	}
	return &workport.MessageRef{
		Kind: string(value.Kind), MessageID: value.MessageId,
		GroupID: value.GroupId, TopicID: value.TopicId,
		SenderUserID: value.SenderUserId,
		Sequence:     value.Sequence, Timestamp: value.Timestamp,
	}
}

func threadMessageRef(value openapi.ThreadMessageRef) workport.MessageRef {
	sequence := value.Sequence
	timestamp := value.Timestamp
	return workport.MessageRef{
		Kind: string(value.Kind), MessageID: value.MessageId,
		GroupID: value.GroupId, TopicID: value.TopicId,
		SenderUserID: value.SenderUserId,
		Sequence:     &sequence, Timestamp: &timestamp,
	}
}

func optionalStringPatch(value *string) **string {
	if value == nil {
		return nil
	}
	return &value
}

func optionalUUIDPatch(value *openapi.NullableId) **string {
	if value == nil {
		return nil
	}
	asString := value.String()
	pointer := &asString
	return &pointer
}

func taskStatus(value *openapi.UpdateTaskRequestStatus) *string {
	if value == nil {
		return nil
	}
	result := string(*value)
	return &result
}

func reminderStatus(value *openapi.UpdateReminderRequestStatus) *string {
	if value == nil {
		return nil
	}
	result := string(*value)
	return &result
}
