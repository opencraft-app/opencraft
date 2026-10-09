package httptransport

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
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

type fakeRuntimeSessionService struct {
	getArgs  []any
	identity appruntimesession.Identity
	getErr   error
}

type fakeRuntimeOccurrenceService struct {
	listArgs  []any
	ackArgs   []any
	values    []occurrenceport.Occurrence
	listError error
	ackError  error
}

type fakeRuntimeTaskService struct {
	value             workport.Task
	thread            workport.MessageThread
	threadReply       workport.ThreadReplyReference
	listArgs          []string
	getArgs           []string
	claimArgs         []string
	updateArgs        []any
	resolveThreadArgs []any
	replyThreadArgs   []any
	reminder          workport.Reminder
	reminderLog       []workport.ReminderLogEntry
	reminderListArgs  []string
	reminderCreate    []any
	reminderUpdate    []any
	reminderCancel    []any
	reminderSnooze    []any
	reminderLogArgs   []any
}

type fakeRuntimeDirectoryService struct {
	value          directoryport.Directory
	channelMembers directoryport.ChannelMembers
	args           []string
	membersArgs    []string
	err            error
}

func (service *fakeRuntimeDirectoryService) GetChannelMembers(
	_ context.Context,
	serverID string,
	agentID string,
	channelID string,
) (directoryport.ChannelMembers, error) {
	service.membersArgs = []string{serverID, agentID, channelID}
	return service.channelMembers, service.err
}

func (service *fakeRuntimeDirectoryService) Get(
	_ context.Context,
	serverID string,
	agentID string,
) (directoryport.Directory, error) {
	service.args = []string{serverID, agentID}
	return service.value, service.err
}

func (service *fakeRuntimeTaskService) ListTasks(
	_ context.Context, serverID string, agentID string, _ workport.TaskListOptions,
) (workport.TaskPage, error) {
	service.listArgs = []string{serverID, agentID}
	return workport.TaskPage{Items: []workport.Task{service.value}}, nil
}

func (service *fakeRuntimeTaskService) GetTask(
	_ context.Context, serverID string, agentID string, taskID string,
) (workport.Task, error) {
	service.getArgs = []string{serverID, agentID, taskID}
	return service.value, nil
}

func (service *fakeRuntimeTaskService) ClaimTask(
	_ context.Context,
	serverID string,
	agentID string,
	taskID string,
	idempotencyKey string,
) (workport.Task, error) {
	service.claimArgs = []string{serverID, agentID, taskID, idempotencyKey}
	return service.value, nil
}

func (service *fakeRuntimeTaskService) UpdateTaskStatus(
	_ context.Context,
	serverID string,
	agentID string,
	taskID string,
	revision int64,
	status string,
	idempotencyKey string,
) (workport.Task, error) {
	service.updateArgs = []any{
		serverID, agentID, taskID, revision, status, idempotencyKey,
	}
	return service.value, nil
}

func (service *fakeRuntimeTaskService) ResolveThread(
	_ context.Context,
	serverID string,
	agentID string,
	channelID string,
	idempotencyKey string,
	root workport.MessageRef,
) (workport.MessageThread, error) {
	service.resolveThreadArgs = []any{
		serverID, agentID, channelID, idempotencyKey, root,
	}
	return service.thread, nil
}

func (service *fakeRuntimeTaskService) RegisterThreadReply(
	_ context.Context,
	serverID string,
	agentID string,
	channelID string,
	threadID string,
	idempotencyKey string,
	reference workport.MessageRef,
) (workport.ThreadReplyReference, error) {
	service.replyThreadArgs = []any{
		serverID, agentID, channelID, threadID, idempotencyKey, reference,
	}
	return service.threadReply, nil
}

func (service *fakeRuntimeTaskService) ListReminders(
	_ context.Context, serverID string, agentID string,
) ([]workport.Reminder, error) {
	service.reminderListArgs = []string{serverID, agentID}
	return []workport.Reminder{service.reminder}, nil
}

func (service *fakeRuntimeTaskService) CreateReminder(
	_ context.Context,
	serverID string,
	agentID string,
	idempotencyKey string,
	draft workport.ReminderDraft,
) (workport.Reminder, error) {
	service.reminderCreate = []any{serverID, agentID, idempotencyKey, draft}
	return service.reminder, nil
}

func (service *fakeRuntimeTaskService) UpdateReminder(
	_ context.Context,
	serverID string,
	agentID string,
	reminderID string,
	revision int64,
	idempotencyKey string,
	patch workport.ReminderPatch,
) (workport.Reminder, error) {
	service.reminderUpdate = []any{
		serverID, agentID, reminderID, revision, idempotencyKey, patch,
	}
	return service.reminder, nil
}

func (service *fakeRuntimeTaskService) CancelReminder(
	_ context.Context,
	serverID string,
	agentID string,
	reminderID string,
	revision int64,
	idempotencyKey string,
) error {
	service.reminderCancel = []any{
		serverID, agentID, reminderID, revision, idempotencyKey,
	}
	return nil
}

func (service *fakeRuntimeTaskService) SnoozeReminder(
	_ context.Context,
	serverID string,
	agentID string,
	reminderID string,
	revision int64,
	delay time.Duration,
	idempotencyKey string,
) (workport.Reminder, error) {
	service.reminderSnooze = []any{
		serverID, agentID, reminderID, revision, delay, idempotencyKey,
	}
	return service.reminder, nil
}

func (service *fakeRuntimeTaskService) ListReminderLog(
	_ context.Context,
	serverID string,
	agentID string,
	reminderID string,
	cursor string,
	limit int,
) (workport.ReminderLogPage, error) {
	service.reminderLogArgs = []any{
		serverID, agentID, reminderID, cursor, limit,
	}
	return workport.ReminderLogPage{Items: service.reminderLog}, nil
}

func (service *fakeRuntimeOccurrenceService) List(
	_ context.Context,
	serverID string,
	agentID string,
	limit int,
	cursor string,
) (occurrenceport.Page, error) {
	service.listArgs = []any{serverID, agentID, limit, cursor}
	return occurrenceport.Page{Items: service.values}, service.listError
}

func (service *fakeRuntimeOccurrenceService) Acknowledge(
	_ context.Context,
	serverID string,
	agentID string,
	occurrenceID string,
	idempotencyKey string,
	resultCode *string,
) (occurrenceport.Occurrence, error) {
	service.ackArgs = []any{
		serverID, agentID, occurrenceID, idempotencyKey, resultCode,
	}
	if len(service.values) == 0 {
		return occurrenceport.Occurrence{}, service.ackError
	}
	return service.values[0], service.ackError
}

const (
	sessionServerID     = hookTestServerID
	sessionAgentID      = hookTestAgentID
	runtimeOccurrenceID = "0198f4c2-7a38-7e45-913c-6baf30401a87"
	workTaskID          = "0198f4c2-7a34-7e45-913c-6baf30401a83"
	workChannelID       = "0198f4c2-7a39-78f2-95ee-92d78dbc1a88"
	workThreadID        = "0198f4c2-7a3a-73cc-91a1-e9aef73f1a89"
	workThreadReplyID   = "0198f4c2-7a3b-77e4-a7da-8be0bfc61a8a"
	runtimeReminderID   = "0198f4c2-7a3c-75ef-8a7b-2d88d7c71a8b"
)

func (s *fakeRuntimeSessionService) Get(
	_ context.Context,
	serverID string,
	agentID string,
	version uint64,
) (appruntimesession.Identity, error) {
	s.getArgs = []any{serverID, agentID, version}
	return s.identity, s.getErr
}

func TestRuntimeHandlerReturnsCurrentIdentity(t *testing.T) {
	identity := runtimeHandlerIdentity()
	service := &fakeRuntimeSessionService{
		identity: identity,
	}
	handler, err := NewRuntimeHandler(
		service,
		&fakeRuntimeOccurrenceService{},
		&fakeRuntimeTaskService{},
		&fakeRuntimeDirectoryService{},
	)
	if err != nil {
		t.Fatal(err)
	}

	getResponse, err := handler.GetRuntimeMe(
		currentRuntimeContext(t),
		openapi.GetRuntimeMeRequestObject{},
	)
	if err != nil {
		t.Fatalf("GetRuntimeMe() error = %v", err)
	}
	got, ok := getResponse.(openapi.GetRuntimeMe200JSONResponse)
	if !ok ||
		got.Id.String() != sessionAgentID ||
		got.ServerId.String() != sessionServerID ||
		got.Runtime.Kind != "codex" ||
		got.Runtime.Model == nil ||
		*got.Runtime.Model != "default" {
		t.Fatalf("GetRuntimeMe() response = %#v", getResponse)
	}
}

func TestRuntimeHandlerEnforcesPrincipalPurpose(t *testing.T) {
	handler, err := NewRuntimeHandler(
		&fakeRuntimeSessionService{},
		&fakeRuntimeOccurrenceService{},
		&fakeRuntimeTaskService{},
		&fakeRuntimeDirectoryService{},
	)
	if err != nil {
		t.Fatal(err)
	}
	if response, err := handler.GetRuntimeMe(
		currentHumanContext(t),
		openapi.GetRuntimeMeRequestObject{},
	); response != nil || apperror.CodeOf(err) != "runtime_credential_invalid" {
		t.Fatalf("GetRuntimeMe(non-runtime principal) = (%#v, %v)", response, err)
	}
}

func TestRuntimeRoutesRegisterOnlyRuntimeOperations(t *testing.T) {
	encoder := NewErrorEncoder(fixedRequestIDGenerator{value: "request-1"})
	handler, err := NewRuntimeRoutes(
		&fakeRuntimeSessionService{},
		&fakeRuntimeOccurrenceService{},
		&fakeRuntimeTaskService{},
		&fakeRuntimeDirectoryService{},
		encoder,
	)
	if err != nil {
		t.Fatal(err)
	}
	for _, route := range []struct {
		method string
		path   string
	}{
		{method: http.MethodGet, path: "/v1/runtime/me"},
		{method: http.MethodGet, path: "/v1/runtime/directory"},
		{method: http.MethodGet, path: "/v1/runtime/channels/" + workChannelID + "/members"},
		{method: http.MethodPost, path: "/v1/runtime/threads:resolve"},
		{
			method: http.MethodPost,
			path:   "/v1/runtime/threads/" + workThreadID + "/replies",
		},
		{method: http.MethodGet, path: "/v1/runtime/reminder-occurrences"},
		{method: http.MethodGet, path: "/v1/runtime/tasks"},
		{method: http.MethodGet, path: "/v1/runtime/tasks/" + workTaskID},
		{method: http.MethodPost, path: "/v1/runtime/tasks/" + workTaskID + "/claim"},
		{method: http.MethodPatch, path: "/v1/runtime/tasks/" + workTaskID},
		{method: http.MethodGet, path: "/v1/runtime/reminders"},
		{method: http.MethodPost, path: "/v1/runtime/reminders"},
		{method: http.MethodPatch, path: "/v1/runtime/reminders/" + runtimeReminderID},
		{method: http.MethodDelete, path: "/v1/runtime/reminders/" + runtimeReminderID},
		{
			method: http.MethodPost,
			path:   "/v1/runtime/reminders/" + runtimeReminderID + "/snooze",
		},
		{
			method: http.MethodGet,
			path:   "/v1/runtime/reminders/" + runtimeReminderID + "/log",
		},
		{
			method: http.MethodPost,
			path:   "/v1/runtime/reminder-occurrences/" + runtimeOccurrenceID + "/ack",
		},
	} {
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(
			recorder,
			httptest.NewRequest(route.method, route.path, nil),
		)
		if recorder.Code == http.StatusNotFound {
			t.Fatalf("%s %s was not registered", route.method, route.path)
		}
	}
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(
		recorder,
		httptest.NewRequest(http.MethodGet, "/v1/servers", nil),
	)
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("GET /v1/servers status = %d", recorder.Code)
	}
}

func TestRuntimeHandlerListsAndAcknowledgesReminderOccurrences(t *testing.T) {
	fireAt := time.Date(2026, 7, 30, 14, 5, 0, 0, time.UTC)
	resultCode := "handled"
	occurrences := &fakeRuntimeOccurrenceService{
		values: []occurrenceport.Occurrence{{
			ID:              runtimeOccurrenceID,
			ServerID:        sessionServerID,
			ReminderID:      "0198f4c2-7a36-7e45-913c-6baf30401a85",
			AgentID:         sessionAgentID,
			ScheduledFireAt: fireAt,
			State:           "due",
			Text:            "汇报",
		}},
	}
	handler, err := NewRuntimeHandler(
		&fakeRuntimeSessionService{},
		occurrences,
		&fakeRuntimeTaskService{},
		&fakeRuntimeDirectoryService{},
	)
	if err != nil {
		t.Fatal(err)
	}
	limit := openapi.Limit(10)
	cursor := openapi.Cursor(runtimeOccurrenceID)
	listResponse, err := handler.ListRuntimeReminderOccurrences(
		currentRuntimeContext(t),
		openapi.ListRuntimeReminderOccurrencesRequestObject{
			Params: openapi.ListRuntimeReminderOccurrencesParams{
				Limit: &limit, Cursor: &cursor,
			},
		},
	)
	list, ok := listResponse.(openapi.ListRuntimeReminderOccurrences200JSONResponse)
	if err != nil || !ok || len(list.Items) != 1 ||
		list.Items[0].Id.String() != runtimeOccurrenceID ||
		list.Items[0].Text != "汇报" ||
		len(occurrences.listArgs) != 4 ||
		occurrences.listArgs[2] != 10 ||
		occurrences.listArgs[3] != runtimeOccurrenceID {
		t.Fatalf("ListRuntimeReminderOccurrences() = (%#v, %v), args = %#v", listResponse, err, occurrences.listArgs)
	}
	occurrenceID := openapi.OccurrenceId(
		uuid.MustParse(runtimeOccurrenceID),
	)
	ackResponse, err := handler.AcknowledgeRuntimeReminderOccurrence(
		currentRuntimeContext(t),
		openapi.AcknowledgeRuntimeReminderOccurrenceRequestObject{
			OccurrenceId: occurrenceID,
			Params: openapi.AcknowledgeRuntimeReminderOccurrenceParams{
				IdempotencyKey: "ack-1",
			},
			Body: &openapi.AcknowledgeRuntimeReminderOccurrenceJSONRequestBody{
				ResultCode: &resultCode,
			},
		},
	)
	ack, ok := ackResponse.(openapi.AcknowledgeRuntimeReminderOccurrence200JSONResponse)
	if err != nil || !ok || ack.Id.String() != runtimeOccurrenceID ||
		len(occurrences.ackArgs) != 5 ||
		occurrences.ackArgs[3] != "ack-1" {
		t.Fatalf("AcknowledgeRuntimeReminderOccurrence() = (%#v, %v), args = %#v", ackResponse, err, occurrences.ackArgs)
	}
}

func TestRuntimeHandlerListsClaimsAndUpdatesOwnTasks(t *testing.T) {
	tasks := &fakeRuntimeTaskService{value: workport.Task{
		ID: workTaskID, ServerID: sessionServerID, Number: 7,
		Title: "处理告警", Status: "in_progress",
		OwnerMemberID: &[]string{sessionAgentID}[0], AssignmentRevision: 2,
		CreatedByMemberID: sessionAgentID, UpdatedByMemberID: sessionAgentID,
		Revision: 3,
	}}
	handler, err := NewRuntimeHandler(
		&fakeRuntimeSessionService{},
		&fakeRuntimeOccurrenceService{},
		tasks,
		&fakeRuntimeDirectoryService{},
	)
	if err != nil {
		t.Fatal(err)
	}
	listedResponse, err := handler.ListRuntimeTasks(
		currentRuntimeContext(t),
		openapi.ListRuntimeTasksRequestObject{},
	)
	listed, ok := listedResponse.(openapi.ListRuntimeTasks200JSONResponse)
	if err != nil || !ok || len(listed.Items) != 1 || listed.Items[0].Number != 7 ||
		len(tasks.listArgs) != 2 || tasks.listArgs[1] != sessionAgentID {
		t.Fatalf("ListRuntimeTasks() = (%#v, %v), args=%#v", listedResponse, err, tasks.listArgs)
	}
	taskID := openapi.TaskId(uuid.MustParse(workTaskID))
	claimedResponse, err := handler.ClaimRuntimeTask(
		currentRuntimeContext(t),
		openapi.ClaimRuntimeTaskRequestObject{
			TaskId: taskID,
			Params: openapi.ClaimRuntimeTaskParams{IdempotencyKey: "claim-1"},
		},
	)
	claimed, ok := claimedResponse.(openapi.ClaimRuntimeTask200JSONResponse)
	if err != nil || !ok || claimed.Id.String() != workTaskID ||
		len(tasks.claimArgs) != 4 || tasks.claimArgs[3] != "claim-1" {
		t.Fatalf("ClaimRuntimeTask() = (%#v, %v), args=%#v", claimedResponse, err, tasks.claimArgs)
	}
	updatedResponse, err := handler.UpdateRuntimeTaskStatus(
		currentRuntimeContext(t),
		openapi.UpdateRuntimeTaskStatusRequestObject{
			TaskId: taskID,
			Params: openapi.UpdateRuntimeTaskStatusParams{
				XResourceRevision: 3, IdempotencyKey: "update-1",
			},
			Body: &openapi.RuntimeTaskStatusRequest{Status: "done"},
		},
	)
	updated, ok := updatedResponse.(openapi.UpdateRuntimeTaskStatus200JSONResponse)
	if err != nil || !ok || updated.Body.Id.String() != workTaskID ||
		updated.Headers.XResourceRevision != 3 ||
		len(tasks.updateArgs) != 6 || tasks.updateArgs[3] != int64(3) ||
		tasks.updateArgs[4] != "done" {
		t.Fatalf("UpdateRuntimeTaskStatus() = (%#v, %v), args=%#v", updatedResponse, err, tasks.updateArgs)
	}
}

func TestRuntimeHandlerProvidesReminderCRUDWithMessageAnchors(t *testing.T) {
	now := time.Date(2026, 8, 2, 18, 0, 0, 0, time.UTC)
	fireAt := now.Add(time.Hour)
	groupID, topicID := "community-1", "topic-general"
	sequence, timestamp := int64(44), now.Unix()
	anchor := &workport.ReminderAnchor{
		Kind: "message", ChannelID: workChannelID,
		MessageRef: workport.MessageRef{
			Kind: "group", MessageID: "message-44", GroupID: &groupID,
			TopicID: &topicID, Sequence: &sequence, Timestamp: &timestamp,
		},
	}
	work := &fakeRuntimeTaskService{
		reminder: workport.Reminder{
			ID: runtimeReminderID, ServerID: sessionServerID, AgentID: sessionAgentID,
			CreatedByMemberID: sessionAgentID, ScheduleKind: "once",
			Schedule: fireAt.Format(time.RFC3339), Timezone: "Asia/Shanghai",
			Text: "处理这条消息", Status: "active", NextFireAt: &fireAt,
			Revision: 2, CreatedAt: now, UpdatedAt: now, Anchor: anchor,
		},
		reminderLog: []workport.ReminderLogEntry{{
			ID: runtimeOccurrenceID, ServerID: sessionServerID,
			ReminderID: runtimeReminderID, AgentID: sessionAgentID,
			ScheduledFireAt: fireAt, State: "acknowledged", Text: "处理这条消息",
			CreatedAt: now, UpdatedAt: now,
		}},
	}
	handler, err := NewRuntimeHandler(
		&fakeRuntimeSessionService{}, &fakeRuntimeOccurrenceService{},
		work, &fakeRuntimeDirectoryService{},
	)
	if err != nil {
		t.Fatal(err)
	}
	ctx := currentRuntimeContext(t)
	reminderID := openapi.ReminderId(uuid.MustParse(runtimeReminderID))
	apiAnchor := openapi.RuntimeReminderAnchor{
		Kind: "message", ChannelId: uuid.MustParse(workChannelID),
		MessageRef: &openapi.ThreadMessageRef{
			Kind: "group", MessageId: "message-44", GroupId: &groupID,
			TopicId: &topicID, Sequence: sequence, Timestamp: timestamp,
		},
	}

	listedResponse, err := handler.ListRuntimeReminders(
		ctx, openapi.ListRuntimeRemindersRequestObject{},
	)
	listed, ok := listedResponse.(openapi.ListRuntimeReminders200JSONResponse)
	if err != nil || !ok || len(listed) != 1 || listed[0].Anchor == nil ||
		listed[0].Anchor.MessageRef == nil ||
		listed[0].Anchor.MessageRef.MessageId != "message-44" ||
		len(work.reminderListArgs) != 2 || work.reminderListArgs[1] != sessionAgentID {
		t.Fatalf("ListRuntimeReminders() = (%#v, %v), args=%#v",
			listedResponse, err, work.reminderListArgs)
	}
	createdResponse, err := handler.CreateRuntimeReminder(
		ctx,
		openapi.CreateRuntimeReminderRequestObject{
			Params: openapi.CreateRuntimeReminderParams{IdempotencyKey: "reminder-create-1"},
			Body: &openapi.CreateRuntimeReminderJSONRequestBody{
				ScheduleKind: "once", Schedule: fireAt.Format(time.RFC3339),
				Timezone: "Asia/Shanghai", Text: "处理这条消息", Anchor: &apiAnchor,
			},
		},
	)
	created, ok := createdResponse.(openapi.CreateRuntimeReminder201JSONResponse)
	createDraft, _ := work.reminderCreate[3].(workport.ReminderDraft)
	if err != nil || !ok || created.Id.String() != runtimeReminderID ||
		len(work.reminderCreate) != 4 || work.reminderCreate[2] != "reminder-create-1" ||
		createDraft.Anchor == nil || createDraft.Anchor.MessageRef.MessageID != "message-44" {
		t.Fatalf("CreateRuntimeReminder() = (%#v, %v), args=%#v",
			createdResponse, err, work.reminderCreate)
	}
	text := "更新内容"
	updatedResponse, err := handler.UpdateRuntimeReminder(
		ctx,
		openapi.UpdateRuntimeReminderRequestObject{
			ReminderId: reminderID,
			Params: openapi.UpdateRuntimeReminderParams{
				XResourceRevision: 2, IdempotencyKey: "reminder-update-1",
			},
			Body: &openapi.UpdateRuntimeReminderJSONRequestBody{Text: &text},
		},
	)
	_, updatedOK := updatedResponse.(openapi.UpdateRuntimeReminder200JSONResponse)
	if err != nil || !updatedOK || len(work.reminderUpdate) != 6 ||
		work.reminderUpdate[3] != int64(2) || work.reminderUpdate[4] != "reminder-update-1" {
		t.Fatalf("UpdateRuntimeReminder() = (%#v, %v), args=%#v",
			updatedResponse, err, work.reminderUpdate)
	}
	if response, err := handler.CancelRuntimeReminder(
		ctx,
		openapi.CancelRuntimeReminderRequestObject{
			ReminderId: reminderID,
			Params: openapi.CancelRuntimeReminderParams{
				XResourceRevision: 2, IdempotencyKey: "reminder-cancel-1",
			},
		},
	); err != nil {
		t.Fatalf("CancelRuntimeReminder() = (%#v, %v)", response, err)
	}
	if len(work.reminderCancel) != 5 || work.reminderCancel[4] != "reminder-cancel-1" {
		t.Fatalf("cancel args = %#v", work.reminderCancel)
	}
	if response, err := handler.SnoozeRuntimeReminder(
		ctx,
		openapi.SnoozeRuntimeReminderRequestObject{
			ReminderId: reminderID,
			Params: openapi.SnoozeRuntimeReminderParams{
				XResourceRevision: 2, IdempotencyKey: "reminder-snooze-1",
			},
			Body: &openapi.SnoozeRuntimeReminderJSONRequestBody{DelaySeconds: 90},
		},
	); err != nil {
		t.Fatalf("SnoozeRuntimeReminder() = (%#v, %v)", response, err)
	}
	if len(work.reminderSnooze) != 6 || work.reminderSnooze[4] != 90*time.Second {
		t.Fatalf("snooze args = %#v", work.reminderSnooze)
	}
	limit := openapi.Limit(20)
	cursor := openapi.Cursor(runtimeOccurrenceID)
	logResponse, err := handler.ListRuntimeReminderLog(
		ctx,
		openapi.ListRuntimeReminderLogRequestObject{
			ReminderId: reminderID,
			Params:     openapi.ListRuntimeReminderLogParams{Limit: &limit, Cursor: &cursor},
		},
	)
	logItems, ok := logResponse.(openapi.ListRuntimeReminderLog200JSONResponse)
	if err != nil || !ok || len(logItems.Items) != 1 ||
		logItems.Items[0].ReminderId.String() != runtimeReminderID ||
		len(work.reminderLogArgs) != 5 || work.reminderLogArgs[3] != runtimeOccurrenceID ||
		work.reminderLogArgs[4] != 20 {
		t.Fatalf("ListRuntimeReminderLog() = (%#v, %v), args=%#v",
			logResponse, err, work.reminderLogArgs)
	}
}

func TestRuntimeHandlerReturnsAuthorizedDirectory(t *testing.T) {
	humanID := "0198fa61-bc96-7352-8f91-0d31d1338123"
	channelID := "0198fa61-bc97-71f6-b248-296172c25124"
	directID := "0198fa61-bc98-71f6-b248-296172c25125"
	now := time.Date(2026, 8, 2, 17, 0, 0, 0, time.UTC)
	directories := &fakeRuntimeDirectoryService{value: directoryport.Directory{
		Server: directoryport.Server{ID: sessionServerID, Slug: "team", Name: "研发"},
		Self: directoryport.Self{
			AgentID: sessionAgentID, MemberID: sessionAgentID,
			Handle: "builder", DisplayName: "Builder", IMUserID: "agent_builder",
		},
		Channels: []directoryport.Channel{{
			ID: channelID, Name: "全员", Visibility: "public", Joined: true,
			IMGroupID: "community-1", IMState: "ready", Revision: 2,
		}},
		Members: []directoryport.Member{{
			MemberID: humanID, Kind: "human", HumanID: &humanID,
			Handle: "alice", DisplayName: "Alice", IMUserID: "human_alice",
		}},
		DirectConversations: []directoryport.DirectConversation{{
			ID: directID, PeerMemberID: humanID,
			IMGroupID: "an_dm_authorized", IMState: "ready", Revision: 3,
		}},
		Revision: "sha256:test", ExpiresAt: now,
	}}
	handler, err := NewRuntimeHandler(
		&fakeRuntimeSessionService{},
		&fakeRuntimeOccurrenceService{},
		&fakeRuntimeTaskService{},
		directories,
	)
	if err != nil {
		t.Fatal(err)
	}

	response, err := handler.GetRuntimeDirectory(
		currentRuntimeContext(t),
		openapi.GetRuntimeDirectoryRequestObject{},
	)
	body, ok := response.(openapi.GetRuntimeDirectory200JSONResponse)
	if err != nil || !ok || body.Server.Id.String() != sessionServerID ||
		body.Self.AgentId.String() != sessionAgentID || len(body.Channels) != 1 ||
		body.Channels[0].Id.String() != channelID || len(body.Members) != 1 ||
		body.Members[0].HumanId == nil || body.Members[0].HumanId.String() != humanID ||
		!body.ExpiresAt.Equal(now) || len(directories.args) != 2 ||
		directories.args[1] != sessionAgentID {
		t.Fatalf("GetRuntimeDirectory() = (%#v, %v), args=%#v", response, err, directories.args)
	}

	v2Response, err := handler.GetRuntimeDirectoryV2(
		currentRuntimeContext(t),
		openapi.GetRuntimeDirectoryV2RequestObject{},
	)
	v2Body, ok := v2Response.(openapi.GetRuntimeDirectoryV2200JSONResponse)
	if err != nil || !ok || len(v2Body.DirectConversations) != 1 ||
		v2Body.DirectConversations[0].Id.String() != directID ||
		v2Body.DirectConversations[0].PeerMemberId.String() != humanID ||
		v2Body.DirectConversations[0].ImGroupId != "an_dm_authorized" ||
		v2Body.DirectConversations[0].ImState != openapi.DirectConversationIMStateReady {
		t.Fatalf("GetRuntimeDirectoryV2() = (%#v, %v)", v2Response, err)
	}
}

func TestRuntimeHandlerReturnsChannelMembersAndRegistersThreadReferences(t *testing.T) {
	now := time.Date(2026, 8, 2, 17, 30, 0, 0, time.UTC)
	groupID := "community-1"
	topicID := "topic-general"
	senderID := "agent_builder"
	sequence := int64(42)
	timestamp := int64(1785689400)
	rootRef := workport.MessageRef{
		Kind: "group", MessageID: "root-message", GroupID: &groupID,
		TopicID: &topicID, SenderUserID: &senderID,
		Sequence: &sequence, Timestamp: &timestamp,
	}
	replySequence := int64(43)
	replyRef := rootRef
	replyRef.MessageID = "reply-message"
	replyRef.Sequence = &replySequence

	directories := &fakeRuntimeDirectoryService{
		channelMembers: directoryport.ChannelMembers{
			Channel: directoryport.Channel{
				ID: workChannelID, Name: "全员", Visibility: "public", Joined: true,
				IMGroupID: groupID, IMTopicID: &topicID, IMState: "ready", Revision: 2,
			},
			Members: []directoryport.Member{{
				MemberID: sessionAgentID, Kind: "agent", AgentID: &[]string{sessionAgentID}[0],
				Handle: "builder", DisplayName: "Builder", IMUserID: senderID,
			}},
			Revision: "sha256:channel-members", ExpiresAt: now,
		},
	}
	work := &fakeRuntimeTaskService{
		thread: workport.MessageThread{
			ID: workThreadID, ServerID: sessionServerID, ChannelID: workChannelID,
			RootMessageRef: rootRef, CreatedAt: now,
		},
		threadReply: workport.ThreadReplyReference{
			ID: workThreadReplyID, ThreadID: workThreadID,
			MessageRef: replyRef, CreatedAt: now,
		},
	}
	handler, err := NewRuntimeHandler(
		&fakeRuntimeSessionService{}, &fakeRuntimeOccurrenceService{},
		work, directories,
	)
	if err != nil {
		t.Fatal(err)
	}

	memberResponse, err := handler.GetRuntimeChannelMembers(
		currentRuntimeContext(t),
		openapi.GetRuntimeChannelMembersRequestObject{
			ChannelId: openapi.ChannelId(uuid.MustParse(workChannelID)),
		},
	)
	members, ok := memberResponse.(openapi.GetRuntimeChannelMembers200JSONResponse)
	if err != nil || !ok || members.Channel.Id.String() != workChannelID ||
		len(members.Members) != 1 || len(directories.membersArgs) != 3 ||
		directories.membersArgs[1] != sessionAgentID {
		t.Fatalf("GetRuntimeChannelMembers() = (%#v, %v), args=%#v",
			memberResponse, err, directories.membersArgs)
	}

	resolveResponse, err := handler.ResolveRuntimeThread(
		currentRuntimeContext(t),
		openapi.ResolveRuntimeThreadRequestObject{
			Params: openapi.ResolveRuntimeThreadParams{IdempotencyKey: "resolve-1"},
			Body: &openapi.ResolveRuntimeThreadJSONRequestBody{
				ChannelId: uuid.MustParse(workChannelID),
				RootMessageRef: openapi.ThreadMessageRef{
					Kind: "group", MessageId: "root-message", GroupId: &groupID,
					TopicId: &topicID, SenderUserId: &senderID,
					Sequence: sequence, Timestamp: timestamp,
				},
			},
		},
	)
	resolved, ok := resolveResponse.(openapi.ResolveRuntimeThread200JSONResponse)
	if err != nil || !ok || resolved.Id.String() != workThreadID ||
		len(work.resolveThreadArgs) != 5 || work.resolveThreadArgs[3] != "resolve-1" {
		t.Fatalf("ResolveRuntimeThread() = (%#v, %v), args=%#v",
			resolveResponse, err, work.resolveThreadArgs)
	}

	replyResponse, err := handler.RegisterRuntimeThreadReply(
		currentRuntimeContext(t),
		openapi.RegisterRuntimeThreadReplyRequestObject{
			ThreadId: openapi.ThreadId(uuid.MustParse(workThreadID)),
			Params:   openapi.RegisterRuntimeThreadReplyParams{IdempotencyKey: "reply-1"},
			Body: &openapi.RegisterRuntimeThreadReplyJSONRequestBody{
				ChannelId: uuid.MustParse(workChannelID),
				MessageRef: openapi.ThreadMessageRef{
					Kind: "group", MessageId: "reply-message", GroupId: &groupID,
					TopicId: &topicID, SenderUserId: &senderID,
					Sequence: replySequence, Timestamp: timestamp,
				},
			},
		},
	)
	reply, ok := replyResponse.(openapi.RegisterRuntimeThreadReply201JSONResponse)
	if err != nil || !ok || reply.Id.String() != workThreadReplyID ||
		len(work.replyThreadArgs) != 6 || work.replyThreadArgs[4] != "reply-1" {
		t.Fatalf("RegisterRuntimeThreadReply() = (%#v, %v), args=%#v",
			replyResponse, err, work.replyThreadArgs)
	}
}

func currentRuntimeContext(t *testing.T) context.Context {
	t.Helper()
	principal, err := authnport.NewCurrentRuntimePrincipal(
		sessionServerID,
		sessionAgentID,
		7,
	)
	if err != nil {
		t.Fatal(err)
	}
	return contextWithPrincipal(t, principal)
}

func contextWithPrincipal(
	t *testing.T,
	principal authnport.CurrentPrincipal,
) context.Context {
	t.Helper()
	state := &AuthState{}
	if err := state.setPrincipal(principal); err != nil {
		t.Fatal(err)
	}
	return context.WithValue(
		context.Background(),
		authStateContextKey{},
		state,
	)
}

func runtimeHandlerIdentity() appruntimesession.Identity {
	return appruntimesession.Identity{
		ID:           sessionAgentID,
		ServerID:     sessionServerID,
		UserID:       "a_OPAQUE",
		Capabilities: []string{"read", "send", "server"},
		ReplyPolicy:  "mention_and_dm",
		RuntimeKind:  "codex",
		RuntimeModel: "default",
	}
}
