package httptransport

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"chatserver/internal/api/openapi"
	appruntimesession "chatserver/internal/app/runtimesession"
	"chatserver/internal/apperror"
	authnport "chatserver/internal/ports/authn"
	occurrenceport "chatserver/internal/ports/reminderoccurrence"
	directoryport "chatserver/internal/ports/runtimedirectory"
	workport "chatserver/internal/ports/work"

	"github.com/google/uuid"
)

type runtimeSessionService interface {
	Get(
		context.Context,
		string,
		string,
		uint64,
	) (appruntimesession.Identity, error)
}

type runtimeOccurrenceService interface {
	List(
		context.Context,
		string,
		string,
		int,
		string,
	) (occurrenceport.Page, error)
	Acknowledge(
		context.Context,
		string,
		string,
		string,
		string,
		*string,
	) (occurrenceport.Occurrence, error)
}

type runtimeTaskService interface {
	ListTasks(context.Context, string, string, workport.TaskListOptions) (workport.TaskPage, error)
	GetTask(context.Context, string, string, string) (workport.Task, error)
	ClaimTask(context.Context, string, string, string, string) (workport.Task, error)
	UpdateTaskStatus(
		context.Context,
		string,
		string,
		string,
		int64,
		string,
		string,
	) (workport.Task, error)
	ResolveThread(
		context.Context,
		string,
		string,
		string,
		string,
		workport.MessageRef,
	) (workport.MessageThread, error)
	RegisterThreadReply(
		context.Context,
		string,
		string,
		string,
		string,
		string,
		workport.MessageRef,
	) (workport.ThreadReplyReference, error)
	ListReminders(context.Context, string, string) ([]workport.Reminder, error)
	CreateReminder(
		context.Context,
		string,
		string,
		string,
		workport.ReminderDraft,
	) (workport.Reminder, error)
	UpdateReminder(
		context.Context,
		string,
		string,
		string,
		int64,
		string,
		workport.ReminderPatch,
	) (workport.Reminder, error)
	CancelReminder(context.Context, string, string, string, int64, string) error
	SnoozeReminder(
		context.Context,
		string,
		string,
		string,
		int64,
		time.Duration,
		string,
	) (workport.Reminder, error)
	ListReminderLog(
		context.Context,
		string,
		string,
		string,
		string,
		int,
	) (workport.ReminderLogPage, error)
}

type runtimeDirectoryService interface {
	Get(context.Context, string, string) (directoryport.Directory, error)
	GetChannelMembers(
		context.Context,
		string,
		string,
		string,
	) (directoryport.ChannelMembers, error)
}

// RuntimeHandler 实现 Runtime Session 和当前身份 strict operation。
type RuntimeHandler struct {
	openapi.StrictServerInterface
	service     runtimeSessionService
	occurrences runtimeOccurrenceService
	tasks       runtimeTaskService
	directory   runtimeDirectoryService
}

var _ openapi.StrictServerInterface = (*RuntimeHandler)(nil)

// NewRuntimeHandler 创建 Runtime strict handler。
func NewRuntimeHandler(
	service runtimeSessionService,
	occurrences runtimeOccurrenceService,
	tasks runtimeTaskService,
	directory runtimeDirectoryService,
) (*RuntimeHandler, error) {
	if service == nil || occurrences == nil || tasks == nil || directory == nil {
		return nil, errors.New("Runtime 应用服务不能为空")
	}
	return &RuntimeHandler{
		service: service, occurrences: occurrences, tasks: tasks, directory: directory,
	}, nil
}

func (h *RuntimeHandler) GetRuntimeDirectory(
	ctx context.Context,
	_ openapi.GetRuntimeDirectoryRequestObject,
) (openapi.GetRuntimeDirectoryResponseObject, error) {
	principal, err := currentRuntimePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	value, err := h.directory.Get(ctx, principal.ServerID(), principal.AgentID())
	if err != nil {
		return nil, err
	}
	body, err := runtimeDirectoryDTO(value)
	if err != nil {
		return nil, err
	}
	return openapi.GetRuntimeDirectory200JSONResponse(body), nil
}

func (h *RuntimeHandler) GetRuntimeDirectoryV2(
	ctx context.Context,
	_ openapi.GetRuntimeDirectoryV2RequestObject,
) (openapi.GetRuntimeDirectoryV2ResponseObject, error) {
	principal, err := currentRuntimePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	value, err := h.directory.Get(ctx, principal.ServerID(), principal.AgentID())
	if err != nil {
		return nil, err
	}
	body, err := runtimeDirectoryV2DTO(value)
	if err != nil {
		return nil, err
	}
	return openapi.GetRuntimeDirectoryV2200JSONResponse(body), nil
}

func (h *RuntimeHandler) GetRuntimeChannelMembers(
	ctx context.Context,
	request openapi.GetRuntimeChannelMembersRequestObject,
) (openapi.GetRuntimeChannelMembersResponseObject, error) {
	principal, err := currentRuntimePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	value, err := h.directory.GetChannelMembers(
		ctx,
		principal.ServerID(),
		principal.AgentID(),
		request.ChannelId.String(),
	)
	if err != nil {
		return nil, err
	}
	body, err := runtimeChannelMembersDTO(value)
	if err != nil {
		return nil, err
	}
	return openapi.GetRuntimeChannelMembers200JSONResponse(body), nil
}

func (h *RuntimeHandler) ResolveRuntimeThread(
	ctx context.Context,
	request openapi.ResolveRuntimeThreadRequestObject,
) (openapi.ResolveRuntimeThreadResponseObject, error) {
	principal, err := currentRuntimePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return nil, apperror.New("invalid_request", "Thread 请求体不能为空", nil)
	}
	value, err := h.tasks.ResolveThread(
		ctx,
		principal.ServerID(),
		principal.AgentID(),
		request.Body.ChannelId.String(),
		string(request.Params.IdempotencyKey),
		threadMessageRef(request.Body.RootMessageRef),
	)
	if err != nil {
		return nil, err
	}
	body, err := messageThreadDTO(value)
	if err != nil {
		return nil, err
	}
	return openapi.ResolveRuntimeThread200JSONResponse(body), nil
}

func (h *RuntimeHandler) RegisterRuntimeThreadReply(
	ctx context.Context,
	request openapi.RegisterRuntimeThreadReplyRequestObject,
) (openapi.RegisterRuntimeThreadReplyResponseObject, error) {
	principal, err := currentRuntimePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return nil, apperror.New("invalid_request", "Thread 回复请求体不能为空", nil)
	}
	value, err := h.tasks.RegisterThreadReply(
		ctx,
		principal.ServerID(),
		principal.AgentID(),
		request.Body.ChannelId.String(),
		request.ThreadId.String(),
		string(request.Params.IdempotencyKey),
		threadMessageRef(request.Body.MessageRef),
	)
	if err != nil {
		return nil, err
	}
	body, err := threadReplyDTO(value)
	if err != nil {
		return nil, err
	}
	return openapi.RegisterRuntimeThreadReply201JSONResponse(body), nil
}

// GetRuntimeMe 只接受已验证且 current 的短期 Runtime Bearer。
func (h *RuntimeHandler) GetRuntimeMe(
	ctx context.Context,
	_ openapi.GetRuntimeMeRequestObject,
) (openapi.GetRuntimeMeResponseObject, error) {
	principal, ok := CurrentRuntimePrincipal(ctx)
	if !ok {
		return nil, apperror.New(
			"runtime_credential_invalid",
			"Runtime 凭证无效",
			nil,
		)
	}
	identity, err := h.service.Get(
		ctx,
		principal.ServerID(),
		principal.AgentID(),
		principal.CredentialVersion(),
	)
	if err != nil {
		return nil, err
	}
	body, err := runtimeIdentityDTO(identity)
	if err != nil {
		return nil, err
	}
	return openapi.GetRuntimeMe200JSONResponse(body), nil
}

// ListRuntimeReminderOccurrences 返回当前 Runtime Agent 未确认的触发记录。
func (h *RuntimeHandler) ListRuntimeReminderOccurrences(
	ctx context.Context,
	request openapi.ListRuntimeReminderOccurrencesRequestObject,
) (openapi.ListRuntimeReminderOccurrencesResponseObject, error) {
	principal, ok := CurrentRuntimePrincipal(ctx)
	if !ok {
		return nil, apperror.New(
			"runtime_credential_invalid",
			"Runtime 凭证无效",
			nil,
		)
	}
	limit := 0
	if request.Params.Limit != nil {
		limit = *request.Params.Limit
	}
	cursor := ""
	if request.Params.Cursor != nil {
		cursor = *request.Params.Cursor
	}
	page, err := h.occurrences.List(
		ctx,
		principal.ServerID(),
		principal.AgentID(),
		limit,
		cursor,
	)
	if err != nil {
		return nil, err
	}
	items := make([]openapi.ReminderOccurrence, 0, len(page.Items))
	for _, value := range page.Items {
		item, err := runtimeOccurrenceDTO(value)
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
	return openapi.ListRuntimeReminderOccurrences200JSONResponse{Items: items, NextCursor: next}, nil
}

// AcknowledgeRuntimeReminderOccurrence 只允许 occurrence 所属 Agent 确认。
func (h *RuntimeHandler) AcknowledgeRuntimeReminderOccurrence(
	ctx context.Context,
	request openapi.AcknowledgeRuntimeReminderOccurrenceRequestObject,
) (openapi.AcknowledgeRuntimeReminderOccurrenceResponseObject, error) {
	principal, ok := CurrentRuntimePrincipal(ctx)
	if !ok {
		return nil, apperror.New(
			"runtime_credential_invalid",
			"Runtime 凭证无效",
			nil,
		)
	}
	var resultCode *string
	if request.Body != nil {
		resultCode = request.Body.ResultCode
	}
	value, err := h.occurrences.Acknowledge(
		ctx,
		principal.ServerID(),
		principal.AgentID(),
		request.OccurrenceId.String(),
		request.Params.IdempotencyKey,
		resultCode,
	)
	if err != nil {
		return nil, err
	}
	item, err := runtimeOccurrenceDTO(value)
	if err != nil {
		return nil, err
	}
	return openapi.AcknowledgeRuntimeReminderOccurrence200JSONResponse(item), nil
}

func (h *RuntimeHandler) ListRuntimeTasks(
	ctx context.Context,
	request openapi.ListRuntimeTasksRequestObject,
) (openapi.ListRuntimeTasksResponseObject, error) {
	principal, err := currentRuntimePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	options := workport.TaskListOptions{Limit: intValue(request.Params.Limit, 50), UpdatedAfter: request.Params.UpdatedAfter}
	if request.Params.Cursor != nil {
		options.Cursor = string(*request.Params.Cursor)
	}
	page, err := h.tasks.ListTasks(ctx, principal.ServerID(), principal.AgentID(), options)
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
	return openapi.ListRuntimeTasks200JSONResponse{Items: items, NextCursor: next}, nil
}

func (h *RuntimeHandler) GetRuntimeTask(
	ctx context.Context,
	request openapi.GetRuntimeTaskRequestObject,
) (openapi.GetRuntimeTaskResponseObject, error) {
	principal, err := currentRuntimePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	value, err := h.tasks.GetTask(
		ctx,
		principal.ServerID(),
		principal.AgentID(),
		request.TaskId.String(),
	)
	if err != nil {
		return nil, err
	}
	item, err := taskDTO(value)
	if err != nil {
		return nil, err
	}
	return openapi.GetRuntimeTask200JSONResponse(item), nil
}

func (h *RuntimeHandler) ClaimRuntimeTask(
	ctx context.Context,
	request openapi.ClaimRuntimeTaskRequestObject,
) (openapi.ClaimRuntimeTaskResponseObject, error) {
	principal, err := currentRuntimePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	value, err := h.tasks.ClaimTask(
		ctx,
		principal.ServerID(),
		principal.AgentID(),
		request.TaskId.String(),
		string(request.Params.IdempotencyKey),
	)
	if err != nil {
		return nil, err
	}
	item, err := taskDTO(value)
	if err != nil {
		return nil, err
	}
	return openapi.ClaimRuntimeTask200JSONResponse(item), nil
}

func (h *RuntimeHandler) UpdateRuntimeTaskStatus(
	ctx context.Context,
	request openapi.UpdateRuntimeTaskStatusRequestObject,
) (openapi.UpdateRuntimeTaskStatusResponseObject, error) {
	principal, err := currentRuntimePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return nil, apperror.New("invalid_request", "Runtime Task 状态不能为空", nil)
	}
	revision, err := workRevision(request.Params.XResourceRevision)
	if err != nil {
		return nil, err
	}
	value, err := h.tasks.UpdateTaskStatus(
		ctx,
		principal.ServerID(),
		principal.AgentID(),
		request.TaskId.String(),
		revision,
		string(request.Body.Status),
		string(request.Params.IdempotencyKey),
	)
	if err != nil {
		return nil, err
	}
	item, err := taskDTO(value)
	if err != nil {
		return nil, err
	}
	return openapi.UpdateRuntimeTaskStatus200JSONResponse{
		Body: item,
		Headers: openapi.UpdateRuntimeTaskStatus200ResponseHeaders{
			XResourceRevision: item.Revision,
		},
	}, nil
}

func (h *RuntimeHandler) ListRuntimeReminders(
	ctx context.Context,
	_ openapi.ListRuntimeRemindersRequestObject,
) (openapi.ListRuntimeRemindersResponseObject, error) {
	principal, err := currentRuntimePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	values, err := h.tasks.ListReminders(ctx, principal.ServerID(), principal.AgentID())
	if err != nil {
		return nil, err
	}
	response := make(openapi.ListRuntimeReminders200JSONResponse, 0, len(values))
	for _, value := range values {
		item, err := runtimeReminderDTO(value)
		if err != nil {
			return nil, err
		}
		response = append(response, item)
	}
	return response, nil
}

func (h *RuntimeHandler) CreateRuntimeReminder(
	ctx context.Context,
	request openapi.CreateRuntimeReminderRequestObject,
) (openapi.CreateRuntimeReminderResponseObject, error) {
	principal, err := currentRuntimePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return nil, apperror.New("invalid_request", "Reminder 请求体不能为空", nil)
	}
	anchor, err := runtimeReminderAnchor(request.Body.Anchor)
	if err != nil {
		return nil, err
	}
	value, err := h.tasks.CreateReminder(
		ctx,
		principal.ServerID(),
		principal.AgentID(),
		string(request.Params.IdempotencyKey),
		workport.ReminderDraft{
			ScheduleKind: string(request.Body.ScheduleKind),
			Schedule:     request.Body.Schedule, Timezone: request.Body.Timezone,
			Text: request.Body.Text, Anchor: anchor,
		},
	)
	if err != nil {
		return nil, err
	}
	item, err := runtimeReminderDTO(value)
	if err != nil {
		return nil, err
	}
	return openapi.CreateRuntimeReminder201JSONResponse(item), nil
}

func (h *RuntimeHandler) UpdateRuntimeReminder(
	ctx context.Context,
	request openapi.UpdateRuntimeReminderRequestObject,
) (openapi.UpdateRuntimeReminderResponseObject, error) {
	principal, err := currentRuntimePrincipal(ctx)
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
	patch := workport.ReminderPatch{
		Schedule: request.Body.Schedule,
		Timezone: request.Body.Timezone,
		Text:     request.Body.Text,
	}
	if request.Body.Status != nil {
		status := string(*request.Body.Status)
		patch.Status = &status
	}
	if request.Body.Anchor != nil {
		anchor, err := runtimeReminderAnchor(request.Body.Anchor)
		if err != nil {
			return nil, err
		}
		patch.Anchor = &anchor
	}
	value, err := h.tasks.UpdateReminder(
		ctx,
		principal.ServerID(),
		principal.AgentID(),
		request.ReminderId.String(),
		revision,
		string(request.Params.IdempotencyKey),
		patch,
	)
	if err != nil {
		return nil, err
	}
	item, err := runtimeReminderDTO(value)
	if err != nil {
		return nil, err
	}
	return openapi.UpdateRuntimeReminder200JSONResponse{
		Body: item,
		Headers: openapi.UpdateRuntimeReminder200ResponseHeaders{
			XResourceRevision: item.Revision,
		},
	}, nil
}

func (h *RuntimeHandler) CancelRuntimeReminder(
	ctx context.Context,
	request openapi.CancelRuntimeReminderRequestObject,
) (openapi.CancelRuntimeReminderResponseObject, error) {
	principal, err := currentRuntimePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	revision, err := workRevision(request.Params.XResourceRevision)
	if err != nil {
		return nil, err
	}
	if err := h.tasks.CancelReminder(
		ctx,
		principal.ServerID(),
		principal.AgentID(),
		request.ReminderId.String(),
		revision,
		string(request.Params.IdempotencyKey),
	); err != nil {
		return nil, err
	}
	return openapi.CancelRuntimeReminder204Response{}, nil
}

func (h *RuntimeHandler) SnoozeRuntimeReminder(
	ctx context.Context,
	request openapi.SnoozeRuntimeReminderRequestObject,
) (openapi.SnoozeRuntimeReminderResponseObject, error) {
	principal, err := currentRuntimePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return nil, apperror.New("invalid_request", "Reminder snooze 请求体不能为空", nil)
	}
	revision, err := workRevision(request.Params.XResourceRevision)
	if err != nil {
		return nil, err
	}
	value, err := h.tasks.SnoozeReminder(
		ctx,
		principal.ServerID(),
		principal.AgentID(),
		request.ReminderId.String(),
		revision,
		time.Duration(request.Body.DelaySeconds)*time.Second,
		string(request.Params.IdempotencyKey),
	)
	if err != nil {
		return nil, err
	}
	item, err := runtimeReminderDTO(value)
	if err != nil {
		return nil, err
	}
	return openapi.SnoozeRuntimeReminder200JSONResponse{
		Body: item,
		Headers: openapi.SnoozeRuntimeReminder200ResponseHeaders{
			XResourceRevision: item.Revision,
		},
	}, nil
}

func (h *RuntimeHandler) ListRuntimeReminderLog(
	ctx context.Context,
	request openapi.ListRuntimeReminderLogRequestObject,
) (openapi.ListRuntimeReminderLogResponseObject, error) {
	principal, err := currentRuntimePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	limit := 20
	if request.Params.Limit != nil {
		limit = *request.Params.Limit
	}
	cursor := ""
	if request.Params.Cursor != nil {
		cursor = *request.Params.Cursor
	}
	page, err := h.tasks.ListReminderLog(
		ctx,
		principal.ServerID(),
		principal.AgentID(),
		request.ReminderId.String(),
		cursor,
		limit,
	)
	if err != nil {
		return nil, err
	}
	items := make([]openapi.ReminderOccurrence, 0, len(page.Items))
	for _, value := range page.Items {
		item, err := runtimeReminderLogDTO(value)
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
	return openapi.ListRuntimeReminderLog200JSONResponse{Items: items, NextCursor: next}, nil
}

func currentRuntimePrincipal(ctx context.Context) (authnport.CurrentRuntimePrincipal, error) {
	principal, ok := CurrentRuntimePrincipal(ctx)
	if !ok {
		return authnport.CurrentRuntimePrincipal{}, apperror.New(
			"runtime_credential_invalid",
			"Runtime 凭证无效",
			nil,
		)
	}
	return principal, nil
}

// NewRuntimeRoutes 注册 Runtime Session、身份和 Reminder occurrence operation。
func NewRuntimeRoutes(
	service runtimeSessionService,
	occurrences runtimeOccurrenceService,
	tasks runtimeTaskService,
	directory runtimeDirectoryService,
	encoder *ErrorEncoder,
) (http.Handler, error) {
	if encoder == nil {
		return nil, ErrValidatorEncoderRequired
	}
	handler, err := NewRuntimeHandler(service, occurrences, tasks, directory)
	if err != nil {
		return nil, err
	}
	strict := openapi.NewStrictHandlerWithOptions(
		handler,
		nil,
		StrictServerOptions(encoder),
	)
	wrapper := &openapi.ServerInterfaceWrapper{
		Handler:          strict,
		ErrorHandlerFunc: StdHTTPErrorHandler(encoder),
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/runtime/me", strict.GetRuntimeMe)
	mux.HandleFunc("GET /v1/runtime/directory", strict.GetRuntimeDirectory)
	mux.HandleFunc("GET /v1/runtime/directory-v2", strict.GetRuntimeDirectoryV2)
	mux.HandleFunc(
		"GET /v1/runtime/channels/{channelId}/members",
		wrapper.GetRuntimeChannelMembers,
	)
	mux.HandleFunc("POST /v1/runtime/threads:resolve", wrapper.ResolveRuntimeThread)
	mux.HandleFunc(
		"POST /v1/runtime/threads/{threadId}/replies",
		wrapper.RegisterRuntimeThreadReply,
	)
	mux.HandleFunc("GET /v1/runtime/tasks", wrapper.ListRuntimeTasks)
	mux.HandleFunc("GET /v1/runtime/tasks/{taskId}", wrapper.GetRuntimeTask)
	mux.HandleFunc("PATCH /v1/runtime/tasks/{taskId}", wrapper.UpdateRuntimeTaskStatus)
	mux.HandleFunc("POST /v1/runtime/tasks/{taskId}/claim", wrapper.ClaimRuntimeTask)
	mux.HandleFunc("GET /v1/runtime/reminders", strict.ListRuntimeReminders)
	mux.HandleFunc("POST /v1/runtime/reminders", wrapper.CreateRuntimeReminder)
	mux.HandleFunc("PATCH /v1/runtime/reminders/{reminderId}", wrapper.UpdateRuntimeReminder)
	mux.HandleFunc("DELETE /v1/runtime/reminders/{reminderId}", wrapper.CancelRuntimeReminder)
	mux.HandleFunc(
		"POST /v1/runtime/reminders/{reminderId}/snooze",
		wrapper.SnoozeRuntimeReminder,
	)
	mux.HandleFunc(
		"GET /v1/runtime/reminders/{reminderId}/log",
		wrapper.ListRuntimeReminderLog,
	)
	mux.HandleFunc(
		"GET /v1/runtime/reminder-occurrences",
		wrapper.ListRuntimeReminderOccurrences,
	)
	mux.HandleFunc(
		"POST /v1/runtime/reminder-occurrences/{occurrenceId}/ack",
		wrapper.AcknowledgeRuntimeReminderOccurrence,
	)
	return mux, nil
}

func runtimeDirectoryDTO(
	value directoryport.Directory,
) (openapi.RuntimeDirectory, error) {
	serverID, err := uuid.Parse(value.Server.ID)
	if err != nil || serverID == uuid.Nil {
		return openapi.RuntimeDirectory{}, invalidRuntimeDirectory(err)
	}
	agentID, err := uuid.Parse(value.Self.AgentID)
	if err != nil || agentID == uuid.Nil {
		return openapi.RuntimeDirectory{}, invalidRuntimeDirectory(err)
	}
	memberID, err := uuid.Parse(value.Self.MemberID)
	if err != nil || memberID == uuid.Nil || value.ExpiresAt.IsZero() {
		return openapi.RuntimeDirectory{}, invalidRuntimeDirectory(err)
	}
	result := openapi.RuntimeDirectory{
		Server: openapi.RuntimeDirectoryServer{
			Id: serverID, Slug: value.Server.Slug, Name: value.Server.Name,
		},
		Self: openapi.RuntimeDirectorySelf{
			AgentId: agentID, MemberId: memberID, Handle: value.Self.Handle,
			DisplayName: value.Self.DisplayName, ImUserId: value.Self.IMUserID,
		},
		Channels: make([]openapi.RuntimeDirectoryChannel, 0, len(value.Channels)),
		Members:  make([]openapi.RuntimeDirectoryMember, 0, len(value.Members)),
		Revision: value.Revision, ExpiresAt: value.ExpiresAt.UTC(),
	}
	for _, channel := range value.Channels {
		item, err := runtimeDirectoryChannelDTO(channel)
		if err != nil {
			return openapi.RuntimeDirectory{}, err
		}
		result.Channels = append(result.Channels, item)
	}
	result.Members, err = runtimeDirectoryMembersDTO(value.Members)
	if err != nil {
		return openapi.RuntimeDirectory{}, err
	}
	return result, nil
}

func runtimeDirectoryV2DTO(
	value directoryport.Directory,
) (openapi.RuntimeDirectoryV2, error) {
	legacy, err := runtimeDirectoryDTO(value)
	if err != nil {
		return openapi.RuntimeDirectoryV2{}, err
	}
	result := openapi.RuntimeDirectoryV2{
		Server: legacy.Server, Self: legacy.Self,
		Channels: legacy.Channels, Members: legacy.Members,
		DirectConversations: make(
			[]openapi.RuntimeDirectoryDirectConversation,
			0,
			len(value.DirectConversations),
		),
		Revision: legacy.Revision, ExpiresAt: legacy.ExpiresAt,
	}
	for _, direct := range value.DirectConversations {
		id, err := uuid.Parse(direct.ID)
		if err != nil || id == uuid.Nil {
			return openapi.RuntimeDirectoryV2{}, invalidRuntimeDirectory(err)
		}
		peerMemberID, err := uuid.Parse(direct.PeerMemberID)
		state := openapi.DirectConversationIMState(direct.IMState)
		if err != nil || peerMemberID == uuid.Nil || !state.Valid() ||
			strings.TrimSpace(direct.IMGroupID) == "" || direct.Revision < 0 {
			return openapi.RuntimeDirectoryV2{}, invalidRuntimeDirectory(err)
		}
		result.DirectConversations = append(
			result.DirectConversations,
			openapi.RuntimeDirectoryDirectConversation{
				Id: id, PeerMemberId: peerMemberID,
				ImGroupId: direct.IMGroupID, ImState: state,
				Revision: direct.Revision,
			},
		)
	}
	return result, nil
}

func runtimeChannelMembersDTO(
	value directoryport.ChannelMembers,
) (openapi.RuntimeChannelMembers, error) {
	if value.ExpiresAt.IsZero() || strings.TrimSpace(value.Revision) == "" {
		return openapi.RuntimeChannelMembers{}, invalidRuntimeDirectory(nil)
	}
	channel, err := runtimeDirectoryChannelDTO(value.Channel)
	if err != nil {
		return openapi.RuntimeChannelMembers{}, err
	}
	members, err := runtimeDirectoryMembersDTO(value.Members)
	if err != nil {
		return openapi.RuntimeChannelMembers{}, err
	}
	return openapi.RuntimeChannelMembers{
		Channel: channel, Members: members,
		Revision: value.Revision, ExpiresAt: value.ExpiresAt.UTC(),
	}, nil
}

func runtimeDirectoryChannelDTO(
	channel directoryport.Channel,
) (openapi.RuntimeDirectoryChannel, error) {
	id, err := uuid.Parse(channel.ID)
	visibility := openapi.RuntimeDirectoryChannelVisibility(channel.Visibility)
	state := openapi.RuntimeDirectoryChannelImState(channel.IMState)
	if err != nil || id == uuid.Nil || !visibility.Valid() || !state.Valid() {
		return openapi.RuntimeDirectoryChannel{}, invalidRuntimeDirectory(err)
	}
	return openapi.RuntimeDirectoryChannel{
		Id: id, Name: channel.Name, Visibility: visibility,
		Joined: channel.Joined, ImGroupId: channel.IMGroupID,
		ImTopicId: channel.IMTopicID, ImState: state, Revision: channel.Revision,
	}, nil
}

func runtimeDirectoryMembersDTO(
	values []directoryport.Member,
) ([]openapi.RuntimeDirectoryMember, error) {
	result := make([]openapi.RuntimeDirectoryMember, 0, len(values))
	for _, member := range values {
		id, err := uuid.Parse(member.MemberID)
		kind := openapi.RuntimeDirectoryMemberKind(member.Kind)
		if err != nil || id == uuid.Nil || !kind.Valid() {
			return nil, invalidRuntimeDirectory(err)
		}
		item := openapi.RuntimeDirectoryMember{
			MemberId: id, Kind: kind, Handle: member.Handle,
			DisplayName: member.DisplayName, ImUserId: member.IMUserID,
		}
		if member.HumanID != nil {
			parsed, err := uuid.Parse(*member.HumanID)
			if err != nil || parsed == uuid.Nil {
				return nil, invalidRuntimeDirectory(err)
			}
			item.HumanId = &parsed
		}
		if member.AgentID != nil {
			parsed, err := uuid.Parse(*member.AgentID)
			if err != nil || parsed == uuid.Nil {
				return nil, invalidRuntimeDirectory(err)
			}
			item.AgentId = &parsed
		}
		result = append(result, item)
	}
	return result, nil
}

func invalidRuntimeDirectory(cause error) error {
	return apperror.New(
		"internal_error",
		"Runtime 协作目录响应无效",
		cause,
	)
}

func runtimeReminderAnchor(
	value *openapi.RuntimeReminderAnchor,
) (*workport.ReminderAnchor, error) {
	if value == nil {
		return nil, nil
	}
	if value.ChannelId == uuid.Nil || !value.Kind.Valid() {
		return nil, apperror.New("invalid_request", "Reminder 锚点无效", nil)
	}
	result := &workport.ReminderAnchor{
		Kind: string(value.Kind), ChannelID: value.ChannelId.String(),
	}
	switch value.Kind {
	case "message":
		if value.MessageRef == nil || value.ThreadId != nil || value.RootMessageRef != nil {
			return nil, apperror.New("invalid_request", "Message 锚点无效", nil)
		}
		result.MessageRef = threadMessageRef(*value.MessageRef)
	case "thread":
		if value.ThreadId == nil || *value.ThreadId == uuid.Nil ||
			value.RootMessageRef == nil || value.MessageRef != nil {
			return nil, apperror.New("invalid_request", "Thread 锚点无效", nil)
		}
		threadID := value.ThreadId.String()
		result.ThreadID = &threadID
		result.MessageRef = threadMessageRef(*value.RootMessageRef)
	default:
		return nil, apperror.New("invalid_request", "Reminder 锚点类型无效", nil)
	}
	return result, nil
}

func runtimeReminderDTO(value workport.Reminder) (openapi.RuntimeReminder, error) {
	id, err := requiredWorkUUID(value.ID)
	if err != nil {
		return openapi.RuntimeReminder{}, err
	}
	serverID, err := requiredWorkUUID(value.ServerID)
	if err != nil {
		return openapi.RuntimeReminder{}, err
	}
	agentID, err := requiredWorkUUID(value.AgentID)
	if err != nil {
		return openapi.RuntimeReminder{}, err
	}
	scheduleKind := openapi.RuntimeReminderScheduleKind(value.ScheduleKind)
	status := openapi.RuntimeReminderStatus(value.Status)
	if !scheduleKind.Valid() || !status.Valid() || value.Revision < 1 ||
		value.CreatedAt.IsZero() || value.UpdatedAt.IsZero() {
		return openapi.RuntimeReminder{}, invalidWorkData()
	}
	result := openapi.RuntimeReminder{
		Id: id, ServerId: serverID, AgentId: agentID,
		ScheduleKind: scheduleKind, Schedule: value.Schedule,
		Timezone: value.Timezone, Text: value.Text, Status: status,
		NextFireAt: value.NextFireAt, Revision: value.Revision,
		CreatedAt: value.CreatedAt.UTC(), UpdatedAt: value.UpdatedAt.UTC(),
	}
	if value.Anchor != nil {
		anchor, err := runtimeReminderAnchorDTO(*value.Anchor)
		if err != nil {
			return openapi.RuntimeReminder{}, err
		}
		result.Anchor = &anchor
	}
	return result, nil
}

func runtimeReminderAnchorDTO(
	value workport.ReminderAnchor,
) (openapi.RuntimeReminderAnchor, error) {
	channelID, err := requiredWorkUUID(value.ChannelID)
	if err != nil {
		return openapi.RuntimeReminderAnchor{}, err
	}
	kind := openapi.RuntimeReminderAnchorKind(value.Kind)
	if !kind.Valid() {
		return openapi.RuntimeReminderAnchor{}, invalidWorkData()
	}
	reference, err := threadMessageRefDTO(value.MessageRef)
	if err != nil {
		return openapi.RuntimeReminderAnchor{}, err
	}
	result := openapi.RuntimeReminderAnchor{ChannelId: channelID, Kind: kind}
	switch value.Kind {
	case "message":
		if value.ThreadID != nil {
			return openapi.RuntimeReminderAnchor{}, invalidWorkData()
		}
		result.MessageRef = &reference
	case "thread":
		if value.ThreadID == nil {
			return openapi.RuntimeReminderAnchor{}, invalidWorkData()
		}
		threadID, err := requiredWorkUUID(*value.ThreadID)
		if err != nil {
			return openapi.RuntimeReminderAnchor{}, err
		}
		result.ThreadId = &threadID
		result.RootMessageRef = &reference
	default:
		return openapi.RuntimeReminderAnchor{}, invalidWorkData()
	}
	return result, nil
}

func runtimeReminderLogDTO(
	value workport.ReminderLogEntry,
) (openapi.ReminderOccurrence, error) {
	id, err := requiredWorkUUID(value.ID)
	if err != nil {
		return openapi.ReminderOccurrence{}, err
	}
	serverID, err := requiredWorkUUID(value.ServerID)
	if err != nil {
		return openapi.ReminderOccurrence{}, err
	}
	reminderID, err := requiredWorkUUID(value.ReminderID)
	if err != nil {
		return openapi.ReminderOccurrence{}, err
	}
	agentID, err := requiredWorkUUID(value.AgentID)
	if err != nil {
		return openapi.ReminderOccurrence{}, err
	}
	state := openapi.ReminderOccurrenceState(value.State)
	if !state.Valid() || value.ScheduledFireAt.IsZero() {
		return openapi.ReminderOccurrence{}, invalidRuntimeOccurrence(nil)
	}
	return openapi.ReminderOccurrence{
		Id: id, ServerId: serverID, ReminderId: reminderID, AgentId: agentID,
		ScheduledFireAt: value.ScheduledFireAt.UTC(), State: state,
		Text: value.Text, AcknowledgedAt: value.AcknowledgedAt,
		ResultCode: value.ResultCode,
	}, nil
}

func runtimeOccurrenceDTO(
	value occurrenceport.Occurrence,
) (openapi.ReminderOccurrence, error) {
	id, err := uuid.Parse(value.ID)
	if err != nil || id == uuid.Nil {
		return openapi.ReminderOccurrence{}, invalidRuntimeOccurrence(err)
	}
	serverID, err := uuid.Parse(value.ServerID)
	if err != nil || serverID == uuid.Nil {
		return openapi.ReminderOccurrence{}, invalidRuntimeOccurrence(err)
	}
	reminderID, err := uuid.Parse(value.ReminderID)
	if err != nil || reminderID == uuid.Nil {
		return openapi.ReminderOccurrence{}, invalidRuntimeOccurrence(err)
	}
	agentID, err := uuid.Parse(value.AgentID)
	if err != nil || agentID == uuid.Nil {
		return openapi.ReminderOccurrence{}, invalidRuntimeOccurrence(err)
	}
	state := openapi.ReminderOccurrenceState(value.State)
	if !state.Valid() || value.ScheduledFireAt.IsZero() {
		return openapi.ReminderOccurrence{}, invalidRuntimeOccurrence(nil)
	}
	return openapi.ReminderOccurrence{
		Id: id, ServerId: serverID, ReminderId: reminderID, AgentId: agentID,
		ScheduledFireAt: value.ScheduledFireAt.UTC(),
		State:           state,
		Text:            value.Text,
		AcknowledgedAt:  value.AcknowledgedAt,
		ResultCode:      value.ResultCode,
	}, nil
}

func invalidRuntimeOccurrence(err error) error {
	return apperror.New(
		"internal_error",
		"Runtime Reminder occurrence 数据无效",
		err,
	)
}

func runtimeIdentityDTO(
	value appruntimesession.Identity,
) (openapi.RuntimeIdentity, error) {
	id, err := uuid.Parse(value.ID)
	if err != nil || id == uuid.Nil {
		return openapi.RuntimeIdentity{}, apperror.New(
			"internal_error",
			"Runtime Agent ID 无效",
			err,
		)
	}
	serverID, err := uuid.Parse(value.ServerID)
	if err != nil || serverID == uuid.Nil {
		return openapi.RuntimeIdentity{}, apperror.New(
			"internal_error",
			"Runtime Server ID 无效",
			err,
		)
	}
	if strings.TrimSpace(value.UserID) == "" ||
		!validRuntimeKind(value.RuntimeKind) ||
		!validRuntimeReplyPolicy(value.ReplyPolicy) {
		return openapi.RuntimeIdentity{}, apperror.New(
			"internal_error",
			"Runtime 身份配置无效",
			nil,
		)
	}
	result := openapi.RuntimeIdentity{
		Id:           id,
		ServerId:     serverID,
		UserId:       value.UserID,
		Capabilities: make([]openapi.RuntimeIdentityCapabilities, 0, len(value.Capabilities)),
		ReplyPolicy:  openapi.RuntimeIdentityReplyPolicy(value.ReplyPolicy),
		Runtime: openapi.RuntimeConfig{
			Kind: openapi.RuntimeConfigKind(value.RuntimeKind),
		},
	}
	for _, capability := range value.Capabilities {
		typed := openapi.RuntimeIdentityCapabilities(capability)
		if !typed.Valid() {
			return openapi.RuntimeIdentity{}, apperror.New(
				"internal_error",
				"Runtime 身份能力无效",
				nil,
			)
		}
		result.Capabilities = append(result.Capabilities, typed)
	}
	if len(result.Capabilities) == 0 {
		return openapi.RuntimeIdentity{}, apperror.New(
			"internal_error",
			"Runtime 身份能力无效",
			nil,
		)
	}
	if model := strings.TrimSpace(value.RuntimeModel); model != "" {
		result.Runtime.Model = &model
	}
	return result, nil
}

func validRuntimeKind(value string) bool {
	switch value {
	case "codex", "hermes-acp", "hermes-gateway":
		return true
	default:
		return false
	}
}

func validRuntimeReplyPolicy(value string) bool {
	switch value {
	case "mention_and_dm", "all_channel_messages", "dm_only":
		return true
	default:
		return false
	}
}
