package agentgateway

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/research/raft-computer-1.0.13/go-client/internal/agentapi"
	"github.com/QuantumNous/new-api/research/raft-computer-1.0.13/go-client/internal/vela/im"
	"github.com/QuantumNous/new-api/research/raft-computer-1.0.13/go-client/internal/vela/platform"
)

func newTestGateway(t *testing.T, config Config) (*Gateway, error) {
	t.Helper()
	hub, err := NewHub()
	if err != nil {
		return nil, err
	}
	gateway, err := hub.Register(config)
	if err != nil {
		_ = hub.Close(context.Background())
		return nil, err
	}
	t.Cleanup(func() {
		_ = gateway.Close(context.Background())
		_ = hub.Close(context.Background())
	})
	return gateway, nil
}

func TestThreadTargetKeepsCompleteTencentMessageID(t *testing.T) {
	t.Parallel()

	const messageID = "144115249977133531-1785645385-69155770"
	if got := shortMessageID(messageID); got != messageID {
		t.Fatalf("Thread target message ID = %q, want complete %q", got, messageID)
	}
}

func TestValidateTencentAttachmentURLAllowsOnlyKnownMediaDomains(t *testing.T) {
	t.Parallel()

	for _, rawURL := range []string{
		"https://1600154578-cn.rich.my-imcloud.com/download/file.txt?auth=redacted",
		"https://cos.ap-shanghai.myqcloud.com/file.txt",
	} {
		if err := validateTencentAttachmentURL(rawURL); err != nil {
			t.Fatalf("known Tencent media URL %q rejected: %v", rawURL, err)
		}
	}
	for _, rawURL := range []string{
		"http://1600154578-cn.rich.my-imcloud.com/download/file.txt",
		"https://evil.my-imcloud.com/file.txt",
		"https://1600154578-cn.rich.my-imcloud.com.evil.example/file.txt",
	} {
		if err := validateTencentAttachmentURL(rawURL); err == nil {
			t.Fatalf("untrusted media URL %q accepted", rawURL)
		}
	}
}

func TestAttachmentFailureReturnsOnlySafeUpstreamDiagnosticCode(t *testing.T) {
	t.Parallel()

	recorder := httptest.NewRecorder()
	(&Gateway{}).writeAttachmentSendError(
		recorder,
		safeCodedTestError{code: "endpoint_denied", secret: "must-not-leak"},
	)
	if got := recorder.Header().Get("X-Vela-Upstream-Code"); got != "endpoint_denied" {
		t.Fatalf("diagnostic header = %q", got)
	}
	if got := recorder.Header().Get("X-Vela-Upstream-Detail"); got != "endpoint denied" {
		t.Fatalf("diagnostic detail = %q", got)
	}
	if strings.Contains(recorder.Body.String(), "must-not-leak") {
		t.Fatalf("error response leaked upstream detail: %s", recorder.Body.String())
	}
	if strings.Contains(fmt.Sprint(recorder.Header()), "must-not-leak") {
		t.Fatalf("diagnostic headers leaked upstream detail: %v", recorder.Header())
	}
}

type safeCodedTestError struct {
	code   string
	secret string
}

func (e safeCodedTestError) Error() string      { return e.secret }
func (e safeCodedTestError) SafeCode() string   { return e.code }
func (e safeCodedTestError) SafeDetail() string { return "endpoint denied" }

func TestGatewayBridgesTaskCommandsToRuntimeTaskAPI(t *testing.T) {
	t.Parallel()
	const (
		serverID = "0198f4c2-7a31-7c91-a6d2-7d76f9188c38"
		agentID  = "0198f4c2-7a33-7e45-913c-6baf30401a82"
		taskID   = "0198f4c2-7a34-7e45-913c-6baf30401a83"
	)
	status := "todo"
	revision := 1
	platformServer := httptest.NewServer(http.HandlerFunc(func(
		response http.ResponseWriter,
		request *http.Request,
	) {
		if request.Header.Get("Authorization") != "Bearer runtime-task-token" {
			t.Fatalf("platform Authorization = %q", request.Header.Get("Authorization"))
		}
		response.Header().Set("Content-Type", "application/json")
		payload := func() string {
			return fmt.Sprintf(
				`{"id":%q,"serverId":%q,"number":1,"title":"处理告警","status":%q,"ownerMemberId":%q,"assignmentRevision":1,"createdByMemberId":%q,"updatedByMemberId":%q,"revision":%d}`,
				taskID, serverID, status, agentID, agentID, agentID, revision,
			)
		}
		switch {
		case request.Method == http.MethodGet && request.URL.Path == "/v1/runtime/directory":
			_, _ = fmt.Fprintf(response, `{
              "server":{"id":%q,"slug":"tasks","name":"Tasks"},
              "self":{"agentId":%q,"memberId":%q,"handle":"task-agent","displayName":"Task Agent","imUserId":"agent_task"},
              "channels":[],
              "members":[{"memberId":%q,"kind":"agent","agentId":%q,"handle":"task-agent","displayName":"Task Agent","imUserId":"agent_task"}],
              "revision":"sha256:tasks","expiresAt":%q
            }`, serverID, agentID, agentID, agentID, agentID,
				time.Now().UTC().Add(5*time.Minute).Format(time.RFC3339))
		case request.Method == http.MethodGet && request.URL.Path == "/v1/runtime/tasks":
			_, _ = response.Write([]byte("[" + payload() + "]"))
		case request.Method == http.MethodPost && request.URL.Path == "/v1/runtime/tasks/"+taskID+"/claim":
			status, revision = "in_progress", 2
			_, _ = response.Write([]byte(payload()))
		case request.Method == http.MethodPatch && request.URL.Path == "/v1/runtime/tasks/"+taskID:
			var body struct {
				Status string `json:"status"`
			}
			if err := common.DecodeJson(request.Body, &body); err != nil || body.Status != "done" || request.Header.Get("If-Match") != "2" {
				t.Fatalf("update request = (%#v, %v), headers=%#v", body, err, request.Header)
			}
			status, revision = "done", 3
			_, _ = response.Write([]byte(payload()))
		default:
			http.NotFound(response, request)
		}
	}))
	defer platformServer.Close()
	platformClient, err := platform.NewClient(platform.Config{
		BaseURL: platformServer.URL + "/v1", HTTPClient: http.DefaultClient,
		AllowInsecureLoopback: true, Now: time.Now, MaxSessionTTL: time.Hour,
	})
	if err != nil {
		t.Fatal(err)
	}
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	gateway, err := newTestGateway(t, Config{
		AgentID: agentID, ServerID: serverID, RuntimeEpoch: "task-runtime-1",
		StateRoot: t.TempDir(), Executable: executable,
		Transport: NewTransportSlot(), PlatformClient: platformClient,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer gateway.Close(context.Background())
	token, err := platform.NewAccessToken("runtime-task-token")
	if err != nil {
		t.Fatal(err)
	}
	if err := gateway.UpdateSession(platform.RuntimeSession{
		AccessToken: token,
		Agent: platform.AgentIdentity{
			ID: agentID, ServerID: serverID, Capabilities: []string{"tasks"},
		},
	}); err != nil {
		t.Fatal(err)
	}
	environment := gateway.RuntimeEnvironment()
	client, err := agentapi.New(agentapi.ClientOptions{
		BaseURL:   environment["SLOCK_AGENT_PROXY_URL"],
		TokenFile: environment["SLOCK_AGENT_PROXY_TOKEN_FILE"],
	})
	if err != nil {
		t.Fatal(err)
	}
	var listed struct {
		Tasks []struct {
			TaskNumber int    `json:"taskNumber"`
			Status     string `json:"status"`
		} `json:"tasks"`
	}
	if err := client.Call(context.Background(), agentapi.TaskList, agentapi.Request{
		Query: url.Values{"channel": {"#general"}, "status": {"todo"}},
	}, &listed); err != nil || len(listed.Tasks) != 1 || listed.Tasks[0].TaskNumber != 1 {
		t.Fatalf("task list = (%#v, %v)", listed, err)
	}
	var claimed struct {
		Results []struct {
			TaskNumber int  `json:"taskNumber"`
			Success    bool `json:"success"`
		} `json:"results"`
	}
	if err := client.Call(context.Background(), agentapi.TaskClaim, agentapi.Request{
		Body: map[string]any{"channel": "#general", "task_numbers": []int{1}},
	}, &claimed); err != nil || len(claimed.Results) != 1 || !claimed.Results[0].Success {
		t.Fatalf("task claim = (%#v, %v)", claimed, err)
	}
	if err := client.Call(context.Background(), agentapi.TaskUpdateStatus, agentapi.Request{
		Body: map[string]any{"channel": "#general", "task_number": 1, "status": "done"},
	}, nil); err != nil {
		t.Fatalf("task update error = %v", err)
	}
}

func TestGatewayBridgesReminderCRUDWithIndexedMessageAnchor(t *testing.T) {
	t.Parallel()
	const (
		serverID     = "0198f4c2-7a31-7c91-a6d2-7d76f9188c38"
		agentID      = "0198f4c2-7a33-7e45-913c-6baf30401a82"
		channelID    = "0198f4c2-7a37-7e45-913c-6baf30401a86"
		reminderID   = "0198f4c2-7a36-7e45-913c-6baf30401a85"
		occurrenceID = "0198f4c2-7a38-7e45-913c-6baf30401a87"
	)
	now := time.Date(2026, 8, 2, 10, 0, 0, 0, time.UTC)
	nextFireAt := now.Add(time.Hour)
	revision := int64(1)
	status := "active"
	title := "处理这条消息"
	platformServer := httptest.NewServer(http.HandlerFunc(func(
		response http.ResponseWriter,
		request *http.Request,
	) {
		if request.Header.Get("Authorization") != "Bearer runtime-reminder-token" {
			t.Fatalf("platform Authorization = %q", request.Header.Get("Authorization"))
		}
		response.Header().Set("Content-Type", "application/json")
		payload := func() string {
			return fmt.Sprintf(`{
				"id":%q,"serverId":%q,"agentId":%q,"scheduleKind":"once",
				"schedule":%q,"timezone":"Asia/Shanghai","text":%q,"status":%q,
				"nextFireAt":%q,"revision":%d,"createdAt":%q,"updatedAt":%q,
				"anchor":{"kind":"message","channelId":%q,"messageRef":{
					"kind":"group","messageId":"message-reminder-root","groupId":"community-1",
					"topicId":"topic-general","sequence":44,"timestamp":%d}}
			}`, reminderID, serverID, agentID, nextFireAt.Format(time.RFC3339), title,
				status, nextFireAt.Format(time.RFC3339), revision, now.Format(time.RFC3339),
				now.Format(time.RFC3339), channelID, now.Unix())
		}
		switch {
		case request.Method == http.MethodGet && request.URL.Path == "/v1/runtime/directory":
			_, _ = fmt.Fprintf(response, `{
				"server":{"id":%q,"slug":"reminders","name":"Reminders"},
				"self":{"agentId":%q,"memberId":%q,"handle":"reminder-agent","displayName":"Reminder Agent","imUserId":"agent_reminder"},
				"channels":[{"id":%q,"name":"general","visibility":"public","joined":true,"imGroupId":"community-1","imTopicId":"topic-general","imState":"ready","revision":1}],
				"members":[{"memberId":%q,"kind":"agent","agentId":%q,"handle":"reminder-agent","displayName":"Reminder Agent","imUserId":"agent_reminder"}],
				"revision":"sha256:reminders","expiresAt":%q
			}`, serverID, agentID, agentID, channelID, agentID, agentID,
				now.Add(5*time.Minute).Format(time.RFC3339))
		case request.Method == http.MethodGet && request.URL.Path == "/v1/runtime/reminders":
			_, _ = response.Write([]byte("[" + payload() + "]"))
		case request.Method == http.MethodPost && request.URL.Path == "/v1/runtime/reminders":
			var body struct {
				Schedule string `json:"schedule"`
				Anchor   struct {
					Kind       string `json:"kind"`
					ChannelID  string `json:"channelId"`
					MessageRef struct {
						MessageID string `json:"messageId"`
					} `json:"messageRef"`
				} `json:"anchor"`
			}
			if err := common.DecodeJson(request.Body, &body); err != nil ||
				body.Schedule != nextFireAt.Format(time.RFC3339) ||
				body.Anchor.Kind != "message" || body.Anchor.ChannelID != channelID ||
				body.Anchor.MessageRef.MessageID != "message-reminder-root" {
				t.Fatalf("create reminder body = (%#v, %v)", body, err)
			}
			response.WriteHeader(http.StatusCreated)
			_, _ = response.Write([]byte(payload()))
		case request.Method == http.MethodPatch && request.URL.Path == "/v1/runtime/reminders/"+reminderID:
			var body struct {
				Text string `json:"text"`
			}
			if err := common.DecodeJson(request.Body, &body); err != nil || body.Text != "更新内容" ||
				request.Header.Get("If-Match") != "1" {
				t.Fatalf("update reminder = (%#v, %v), headers=%#v", body, err, request.Header)
			}
			title, revision = body.Text, 2
			_, _ = response.Write([]byte(payload()))
		case request.Method == http.MethodPost && request.URL.Path == "/v1/runtime/reminders/"+reminderID+"/snooze":
			if request.Header.Get("If-Match") != "2" {
				t.Fatalf("snooze If-Match = %q", request.Header.Get("If-Match"))
			}
			nextFireAt, revision = now.Add(2*time.Hour), 3
			_, _ = response.Write([]byte(payload()))
		case request.Method == http.MethodGet && request.URL.Path == "/v1/runtime/reminders/"+reminderID+"/log":
			_, _ = fmt.Fprintf(response, `[{
				"id":%q,"serverId":%q,"reminderId":%q,"agentId":%q,
				"scheduledFireAt":%q,"state":"acknowledged","text":%q
			}]`, occurrenceID, serverID, reminderID, agentID,
				nextFireAt.Format(time.RFC3339), title)
		case request.Method == http.MethodDelete && request.URL.Path == "/v1/runtime/reminders/"+reminderID:
			if request.Header.Get("If-Match") != "3" {
				t.Fatalf("cancel If-Match = %q", request.Header.Get("If-Match"))
			}
			status, revision = "canceled", 4
			response.WriteHeader(http.StatusNoContent)
		default:
			http.NotFound(response, request)
		}
	}))
	defer platformServer.Close()
	platformClient, err := platform.NewClient(platform.Config{
		BaseURL: platformServer.URL + "/v1", HTTPClient: platformServer.Client(),
		AllowInsecureLoopback: true, Now: func() time.Time { return now },
		MaxSessionTTL: 15 * time.Minute,
	})
	if err != nil {
		t.Fatal(err)
	}
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	gateway, err := newTestGateway(t, Config{
		AgentID: agentID, ServerID: serverID, RuntimeEpoch: "reminder-runtime-1",
		StateRoot: t.TempDir(), Executable: executable, Transport: NewTransportSlot(),
		PlatformClient: platformClient, Now: func() time.Time { return now },
	})
	if err != nil {
		t.Fatal(err)
	}
	defer gateway.Close(context.Background())
	token, _ := platform.NewAccessToken("runtime-reminder-token")
	if err := gateway.UpdateSession(platform.RuntimeSession{
		AccessToken: token,
		Agent: platform.AgentIdentity{
			ID: agentID, ServerID: serverID, Capabilities: []string{"reminders"},
		},
	}); err != nil {
		t.Fatal(err)
	}
	conversation, _ := im.NewTopicConversation("community-1", "topic-general")
	reference, _ := im.NewMessageRef(conversation, "message-reminder-root", 44, now.UnixMilli())
	if _, err := gateway.RegisterMessage(im.IncomingMessage{
		Ref: reference, SenderUserID: "human_alice",
		Elements: []im.Element{{Type: im.ElementText, Text: "需要跟进"}},
	}); err != nil {
		t.Fatal(err)
	}
	client := newGatewayTestClient(t, gateway.RuntimeEnvironment())
	var mutation struct {
		Reminder struct {
			ReminderID string  `json:"reminderId"`
			Title      string  `json:"title"`
			Status     string  `json:"status"`
			FireAt     string  `json:"fireAt"`
			AnchorKind string  `json:"anchorKind"`
			ThreadID   *string `json:"threadId"`
		} `json:"reminder"`
	}
	if err := client.Call(context.Background(), agentapi.ReminderCreate, agentapi.Request{
		Body: map[string]any{
			"title": "处理这条消息", "delaySeconds": 3600,
			"channel": "#general", "msgId": "message-reminder-root",
			"tz": "Asia/Shanghai",
		},
	}, &mutation); err != nil || mutation.Reminder.ReminderID != reminderID ||
		mutation.Reminder.FireAt != nextFireAt.Format(time.RFC3339) ||
		mutation.Reminder.AnchorKind != "message" || mutation.Reminder.ThreadID != nil {
		t.Fatalf("reminder create = (%#v, %v)", mutation, err)
	}
	var listed struct {
		Reminders []struct{ ReminderID, Status string } `json:"reminders"`
	}
	if err := client.Call(context.Background(), agentapi.ReminderList, agentapi.Request{}, &listed); err != nil ||
		len(listed.Reminders) != 1 || listed.Reminders[0].Status != "scheduled" {
		t.Fatalf("reminder list = (%#v, %v)", listed, err)
	}
	if err := client.Call(context.Background(), agentapi.ReminderUpdate, agentapi.Request{
		Path: map[string]string{"reminderId": reminderID}, Body: map[string]any{"title": "更新内容"},
	}, &mutation); err != nil || mutation.Reminder.Title != "更新内容" {
		t.Fatalf("reminder update = (%#v, %v)", mutation, err)
	}
	if err := client.Call(context.Background(), agentapi.ReminderSnooze, agentapi.Request{
		Path: map[string]string{"reminderId": reminderID}, Body: map[string]any{"delaySeconds": 7200},
	}, &mutation); err != nil || mutation.Reminder.FireAt != now.Add(2*time.Hour).Format(time.RFC3339) {
		t.Fatalf("reminder snooze = (%#v, %v)", mutation, err)
	}
	var log struct {
		Events []struct {
			EventType string `json:"eventType"`
		} `json:"events"`
	}
	if err := client.Call(context.Background(), agentapi.ReminderLog, agentapi.Request{
		Path: map[string]string{"reminderId": reminderID},
	}, &log); err != nil || len(log.Events) != 1 || log.Events[0].EventType != "acknowledged" {
		t.Fatalf("reminder log = (%#v, %v)", log, err)
	}
	if err := client.Call(context.Background(), agentapi.ReminderCancel, agentapi.Request{
		Path: map[string]string{"reminderId": reminderID},
	}, &mutation); err != nil || mutation.Reminder.Status != "canceled" {
		t.Fatalf("reminder cancel = (%#v, %v)", mutation, err)
	}
}

func TestResolveReminderAnchorPreservesThreadIdentity(t *testing.T) {
	t.Parallel()
	const (
		serverID  = "0198f4c2-8a31-7c91-a6d2-7d76f9188c38"
		agentID   = "0198f4c2-8a33-7e45-913c-6baf30401a82"
		channelID = "0198f4c2-8a37-7e45-913c-6baf30401a86"
		threadID  = "0198f4c2-8a39-7e45-913c-6baf30401a88"
		rootID    = "144115249977133531-1785645385-69155770"
	)
	now := time.Date(2026, 8, 2, 10, 0, 0, 0, time.UTC)
	platformServer := httptest.NewServer(http.HandlerFunc(func(
		response http.ResponseWriter,
		request *http.Request,
	) {
		if request.Method != http.MethodPost ||
			request.URL.Path != "/v1/runtime/threads:resolve" ||
			request.Header.Get("Authorization") != "Bearer runtime-thread-anchor-token" {
			http.NotFound(response, request)
			return
		}
		var body struct {
			ServerID  string `json:"serverId"`
			ChannelID string `json:"channelId"`
			Root      struct {
				MessageID string `json:"messageId"`
				Sequence  int64  `json:"sequence"`
			} `json:"rootMessageRef"`
		}
		if err := common.DecodeJson(request.Body, &body); err != nil ||
			body.ServerID != "" || body.ChannelID != channelID ||
			body.Root.MessageID != rootID || body.Root.Sequence != 44 {
			t.Fatalf("thread resolve body = (%#v, %v)", body, err)
		}
		response.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprintf(response, `{
			"id":%q,"serverId":%q,"channelId":%q,
			"rootMessageRef":{"kind":"group","messageId":%q,
			"groupId":"community-1","topicId":"topic-general",
			"senderUserId":"human_alice","sequence":44,"timestamp":%d},
			"replyCount":1,"unreadCount":0,"lastReplyAt":%q,"createdAt":%q
		}`, threadID, serverID, channelID, rootID, now.Unix(),
			now.Format(time.RFC3339), now.Format(time.RFC3339))
	}))
	defer platformServer.Close()
	platformClient, err := platform.NewClient(platform.Config{
		BaseURL: platformServer.URL + "/v1", HTTPClient: platformServer.Client(),
		AllowInsecureLoopback: true, Now: func() time.Time { return now },
		MaxSessionTTL: 15 * time.Minute,
	})
	if err != nil {
		t.Fatal(err)
	}
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	gateway, err := newTestGateway(t, Config{
		AgentID: agentID, ServerID: serverID, RuntimeEpoch: "thread-anchor-runtime",
		StateRoot: t.TempDir(), Executable: executable, Transport: NewTransportSlot(),
		Now: func() time.Time { return now },
	})
	if err != nil {
		t.Fatal(err)
	}
	defer gateway.Close(context.Background())
	conversation, _ := im.NewTopicConversation("community-1", "topic-general")
	gateway.mu.Lock()
	gateway.targets["#general"] = conversation
	gateway.targetAliases["#general"] = "#general"
	gateway.reverseTargets[conversation] = "#general"
	gateway.directory = platform.RuntimeDirectory{Channels: []platform.DirectoryChannel{{
		ID: channelID, Name: "general", Joined: true,
		IMGroupID: "community-1", IMTopicID: "topic-general", IMState: "ready",
	}}}
	gateway.directoryReady = true
	gateway.mu.Unlock()
	reference, _ := im.NewMessageRef(conversation, rootID, 44, now.UnixMilli())
	if _, err := gateway.RegisterMessage(im.IncomingMessage{
		Ref: reference, SenderUserID: "human_alice",
		Elements: []im.Element{{Type: im.ElementText, Text: "thread root"}},
	}); err != nil {
		t.Fatal(err)
	}
	token, _ := platform.NewAccessToken("runtime-thread-anchor-token")
	anchor, err := gateway.resolveReminderAnchor(
		context.Background(), platformClient, token,
		"#general:"+rootID, rootID,
	)
	if err != nil {
		t.Fatal(err)
	}
	if anchor.Kind != platform.ReminderAnchorThread ||
		anchor.ChannelID != channelID || anchor.ThreadID != threadID ||
		anchor.MessageRef.MessageID != rootID {
		t.Fatalf("thread reminder anchor = %#v", anchor)
	}
}

func TestGatewayLoadsDirectoryAndUsesHumanReadableTargets(t *testing.T) {
	t.Parallel()
	const (
		serverID  = "0198fab7-e66f-70d4-982c-13d1abea2101"
		agentID   = "0198fab7-e670-7d41-9d9d-da6a1bea2102"
		humanID   = "0198fab7-e671-7171-9264-51081bea2103"
		channelID = "0198fab7-e672-783f-b952-42ba1bea2104"
	)
	now := time.Date(2026, 8, 2, 19, 0, 0, 0, time.UTC)
	platformServer := httptest.NewServer(http.HandlerFunc(func(
		response http.ResponseWriter,
		request *http.Request,
	) {
		if request.Method != http.MethodGet ||
			request.Header.Get("Authorization") != "Bearer runtime-directory-token" {
			http.NotFound(response, request)
			return
		}
		response.Header().Set("Content-Type", "application/json")
		switch request.URL.Path {
		case "/v1/runtime/directory":
			_, _ = fmt.Fprintf(response, `{
          "server":{"id":%q,"slug":"team","name":"研发"},
          "self":{"agentId":%q,"memberId":%q,"handle":"builder","displayName":"Builder","imUserId":"agent_builder"},
          "channels":[{"id":%q,"name":"general","visibility":"public","joined":true,"imGroupId":"community-1","imTopicId":"topic-general","imState":"ready","revision":1}],
          "members":[
            {"memberId":%q,"kind":"agent","agentId":%q,"handle":"builder","displayName":"Builder","imUserId":"agent_builder"},
            {"memberId":%q,"kind":"human","humanId":%q,"handle":"alice","displayName":"Alice","imUserId":"human_alice"}
          ],
          "revision":"sha256:test","expiresAt":%q
        }`, serverID, agentID, agentID, channelID, agentID, agentID,
				humanID, humanID, now.Add(2*time.Minute).Format(time.RFC3339))
		case "/v1/runtime/channels/" + channelID + "/members":
			_, _ = fmt.Fprintf(response, `{
              "channel":{"id":%q,"name":"general","visibility":"public","joined":true,"imGroupId":"community-1","imTopicId":"topic-general","imState":"ready","revision":1},
              "members":[
                {"memberId":%q,"kind":"agent","agentId":%q,"handle":"builder","displayName":"Builder","imUserId":"agent_builder"},
                {"memberId":%q,"kind":"human","humanId":%q,"handle":"alice","displayName":"Alice","imUserId":"human_alice"}
              ],
              "revision":"sha256:members","expiresAt":%q
            }`, channelID, agentID, agentID, humanID, humanID,
				now.Add(2*time.Minute).Format(time.RFC3339))
		default:
			http.NotFound(response, request)
		}
	}))
	defer platformServer.Close()
	platformClient, err := platform.NewClient(platform.Config{
		BaseURL: platformServer.URL + "/v1", HTTPClient: platformServer.Client(),
		AllowInsecureLoopback: true, Now: func() time.Time { return now },
		MaxSessionTTL: 15 * time.Minute,
	})
	if err != nil {
		t.Fatal(err)
	}
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	slot := NewTransportSlot()
	transport := &recordingTransport{}
	binding := slot.Bind(transport)
	defer binding.Release()
	gateway, err := newTestGateway(t, Config{
		AgentID: agentID, ServerID: serverID, RuntimeEpoch: "directory-runtime-1",
		StateRoot: t.TempDir(), Executable: executable, Transport: slot,
		PlatformClient: platformClient,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer gateway.Close(context.Background())
	token, _ := platform.NewAccessToken("runtime-directory-token")
	if err := gateway.UpdateSession(platform.RuntimeSession{
		AccessToken: token,
		Agent: platform.AgentIdentity{
			ID: agentID, ServerID: serverID,
			Capabilities: []string{"read", "send", "server", "channels"},
		},
	}); err != nil {
		t.Fatal(err)
	}

	environment := gateway.RuntimeEnvironment()
	if _, exists := environment["RAFT_AGENT_CLI_PROFILE"]; exists {
		t.Fatalf("已删除的 CLI profile 仍被注入")
	}
	client := newGatewayTestClient(t, environment)
	var inventory struct {
		Channels []struct {
			Name string `json:"name"`
		} `json:"channels"`
		Humans []struct {
			Name string `json:"name"`
		} `json:"humans"`
	}
	if err := client.Call(context.Background(), agentapi.ServerInfo, agentapi.Request{}, &inventory); err != nil {
		t.Fatal(err)
	}
	if len(inventory.Channels) != 1 || inventory.Channels[0].Name != "general" ||
		len(inventory.Humans) != 1 || inventory.Humans[0].Name != "alice" {
		t.Fatalf("inventory = %#v", inventory)
	}
	var channelMembers struct {
		Channel struct {
			Ref string `json:"ref"`
		} `json:"channel"`
		Agents []struct {
			Name string `json:"name"`
		} `json:"agents"`
		Humans []struct {
			Name string `json:"name"`
		} `json:"humans"`
	}
	if err := client.Call(context.Background(), agentapi.ChannelMembers, agentapi.Request{
		Query: url.Values{"channel": {"#general"}},
	}, &channelMembers); err != nil || channelMembers.Channel.Ref != "#general" ||
		len(channelMembers.Agents) != 1 || channelMembers.Agents[0].Name != "builder" ||
		len(channelMembers.Humans) != 1 || channelMembers.Humans[0].Name != "alice" {
		t.Fatalf("channel members = (%#v, %v)", channelMembers, err)
	}

	conversation, _ := im.NewC2CConversation("human_alice")
	reference, _ := im.NewMessageRef(conversation, "message-directory-1", 1, now.UnixMilli())
	target, err := gateway.RegisterMessage(im.IncomingMessage{
		Ref: reference, SenderUserID: "human_alice",
		Elements: []im.Element{{Type: im.ElementText, Text: "你好"}},
	})
	if err != nil || target != "@alice" {
		t.Fatalf("RegisterMessage() = %q, %v", target, err)
	}
	if err := client.Call(context.Background(), agentapi.MessageSend, agentapi.Request{
		Body: map[string]any{"target": "@alice", "content": "收到"},
	}, nil); err != nil {
		t.Fatalf("proactive directory send error = %v", err)
	}
	if transport.request.Conversation.PeerUserID() != "human_alice" {
		t.Fatalf("send conversation = %#v", transport.request.Conversation)
	}
}

func TestGatewayRefreshesDirectoryBeforeExpiryAndOnTargetMiss(t *testing.T) {
	const (
		serverID  = "0198face-e66f-70d4-982c-13d1abea2101"
		agentID   = "0198face-e670-7d41-9d9d-da6a1bea2102"
		generalID = "0198face-e672-783f-b952-42ba1bea2104"
		opsID     = "0198face-e673-783f-b952-42ba1bea2105"
		newID     = "0198face-e674-783f-b952-42ba1bea2106"
	)
	now := time.Date(2026, 8, 2, 19, 0, 0, 0, time.UTC)
	directoryCalls := 0
	platformServer := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodGet || request.URL.Path != "/v1/runtime/directory" ||
			request.Header.Get("Authorization") != "Bearer runtime-directory-refresh-token" {
			http.NotFound(response, request)
			return
		}
		directoryCalls++
		channels := fmt.Sprintf(
			`{"id":%q,"name":"general","visibility":"public","joined":true,"imGroupId":"community-1","imTopicId":"topic-general","imState":"ready","revision":1}`,
			generalID,
		)
		expiresAt := now.Add(2 * time.Minute)
		if directoryCalls >= 2 {
			channels += fmt.Sprintf(
				`,{"id":%q,"name":"ops","visibility":"private","joined":true,"imGroupId":"community-1","imTopicId":"topic-ops","imState":"ready","revision":1}`,
				opsID,
			)
			expiresAt = now.Add(10 * time.Minute)
		}
		if directoryCalls >= 3 {
			channels += fmt.Sprintf(
				`,{"id":%q,"name":"new","visibility":"private","joined":true,"imGroupId":"community-1","imTopicId":"topic-new","imState":"ready","revision":1}`,
				newID,
			)
		}
		response.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprintf(response, `{
          "server":{"id":%q,"slug":"team","name":"研发"},
          "self":{"agentId":%q,"memberId":%q,"handle":"builder","displayName":"Builder","imUserId":"agent_builder"},
          "channels":[%s],
          "members":[{"memberId":%q,"kind":"agent","agentId":%q,"handle":"builder","displayName":"Builder","imUserId":"agent_builder"}],
          "revision":"sha256:refresh-%d","expiresAt":%q
        }`, serverID, agentID, agentID, channels, agentID, agentID,
			directoryCalls, expiresAt.Format(time.RFC3339))
	}))
	defer platformServer.Close()
	platformClient, err := platform.NewClient(platform.Config{
		BaseURL: platformServer.URL + "/v1", HTTPClient: platformServer.Client(),
		AllowInsecureLoopback: true, Now: func() time.Time { return now },
		MaxSessionTTL: 15 * time.Minute,
	})
	if err != nil {
		t.Fatal(err)
	}
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	slot := NewTransportSlot()
	binding := slot.Bind(&recordingTransport{})
	defer binding.Release()
	gateway, err := newTestGateway(t, Config{
		AgentID: agentID, ServerID: serverID, RuntimeEpoch: "directory-refresh-runtime-1",
		StateRoot: t.TempDir(), Executable: executable, Transport: slot,
		PlatformClient: platformClient, Now: func() time.Time { return now },
	})
	if err != nil {
		t.Fatal(err)
	}
	defer gateway.Close(context.Background())
	token, _ := platform.NewAccessToken("runtime-directory-refresh-token")
	if err := gateway.UpdateSession(platform.RuntimeSession{
		AccessToken: token,
		Agent: platform.AgentIdentity{
			ID: agentID, ServerID: serverID,
			Capabilities: []string{"read", "send", "server", "channels"},
		},
	}); err != nil {
		t.Fatal(err)
	}
	client := newGatewayTestClient(t, gateway.RuntimeEnvironment())
	now = now.Add(90 * time.Second)
	var inventory struct {
		Channels []struct {
			Name string `json:"name"`
		} `json:"channels"`
	}
	if err := client.Call(context.Background(), agentapi.ServerInfo, agentapi.Request{}, &inventory); err != nil {
		t.Fatal(err)
	}
	if directoryCalls != 2 || len(inventory.Channels) != 2 || inventory.Channels[1].Name != "ops" {
		t.Fatalf("expiry refresh calls=%d inventory=%#v", directoryCalls, inventory)
	}
	var resolved struct {
		ChannelID string `json:"channelId"`
	}
	if err := client.Call(context.Background(), agentapi.ChannelResolve, agentapi.Request{
		Body: map[string]string{"target": "#new"},
	}, &resolved); err != nil {
		t.Fatal(err)
	}
	if directoryCalls != 3 || resolved.ChannelID != newID {
		t.Fatalf("miss refresh calls=%d resolved=%#v", directoryCalls, resolved)
	}
}

func TestGatewayRefreshesDirectoryPeriodicallyWhileIdle(t *testing.T) {
	t.Parallel()
	const (
		serverID  = "0198facf-e66f-70d4-982c-13d1abea2101"
		agentID   = "0198facf-e670-7d41-9d9d-da6a1bea2102"
		channelID = "0198facf-e672-783f-b952-42ba1bea2104"
	)
	now := time.Date(2026, 8, 2, 19, 0, 0, 0, time.UTC)
	var calls atomic.Int32
	refreshed := make(chan struct{})
	platformServer := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/v1/runtime/directory" {
			http.NotFound(response, request)
			return
		}
		call := calls.Add(1)
		channels := ""
		if call >= 2 {
			channels = fmt.Sprintf(`{"id":%q,"name":"ops","visibility":"private","joined":true,"imGroupId":"community-1","imTopicId":"topic-ops","imState":"ready","revision":1}`, channelID)
		}
		response.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprintf(response, `{
          "server":{"id":%q,"slug":"team","name":"研发"},
          "self":{"agentId":%q,"memberId":%q,"handle":"builder","displayName":"Builder","imUserId":"agent_builder"},
          "channels":[%s],
          "members":[{"memberId":%q,"kind":"agent","agentId":%q,"handle":"builder","displayName":"Builder","imUserId":"agent_builder"}],
          "revision":"sha256:periodic-%d","expiresAt":%q
        }`, serverID, agentID, agentID, channels, agentID, agentID, call,
			now.Add(10*time.Minute).Format(time.RFC3339))
		if call == 2 {
			close(refreshed)
		}
	}))
	defer platformServer.Close()
	platformClient, err := platform.NewClient(platform.Config{
		BaseURL: platformServer.URL + "/v1", HTTPClient: platformServer.Client(),
		AllowInsecureLoopback: true, Now: func() time.Time { return now },
		MaxSessionTTL: 15 * time.Minute,
	})
	if err != nil {
		t.Fatal(err)
	}
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	slot := NewTransportSlot()
	binding := slot.Bind(&recordingTransport{})
	defer binding.Release()
	gateway, err := newTestGateway(t, Config{
		AgentID: agentID, ServerID: serverID, RuntimeEpoch: "directory-periodic-runtime-1",
		StateRoot: t.TempDir(), Executable: executable, Transport: slot,
		PlatformClient: platformClient, Now: func() time.Time { return now },
		DirectoryRefreshInterval: 20 * time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer gateway.Close(context.Background())
	token, _ := platform.NewAccessToken("runtime-directory-periodic-token")
	if err := gateway.UpdateSession(platform.RuntimeSession{
		AccessToken: token,
		Agent: platform.AgentIdentity{
			ID: agentID, ServerID: serverID, Capabilities: []string{"server"},
		},
	}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-refreshed:
	case <-time.After(time.Second):
		t.Fatal("directory was not refreshed while Gateway was idle")
	}
	client := newGatewayTestClient(t, gateway.RuntimeEnvironment())
	var inventory struct {
		Channels []struct {
			Name string `json:"name"`
		} `json:"channels"`
	}
	if err := client.Call(context.Background(), agentapi.ServerInfo, agentapi.Request{}, &inventory); err != nil ||
		len(inventory.Channels) != 1 || inventory.Channels[0].Name != "ops" {
		t.Fatalf("periodic directory = (%#v, %v), calls=%d", inventory, err, calls.Load())
	}
}

func TestGatewayResolvesIndexedTencentMessage(t *testing.T) {
	t.Parallel()
	const (
		serverID = "0198fad0-e66f-70d4-982c-13d1abea2101"
		agentID  = "0198fad0-e670-7d41-9d9d-da6a1bea2102"
	)
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	conversation, _ := im.NewC2CConversation("human_alice")
	reference, _ := im.NewMessageRef(conversation, "abcdef0123456789", 4, 1785701000000)
	message := im.IncomingMessage{
		Ref: reference, SenderUserID: "human_alice",
		Elements: []im.Element{{Type: im.ElementText, Text: "resolved"}},
	}
	transport := &recordingTransport{historyPage: im.HistoryPage{
		Messages: []im.IncomingMessage{message}, Completed: true,
	}}
	slot := NewTransportSlot()
	binding := slot.Bind(transport)
	defer binding.Release()
	gateway, err := newTestGateway(t, Config{
		AgentID: agentID, ServerID: serverID, RuntimeEpoch: "message-resolve-runtime-1",
		StateRoot: t.TempDir(), Executable: executable, Transport: slot,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer gateway.Close(context.Background())
	gateway.mu.Lock()
	gateway.targets["@alice"] = conversation
	gateway.targetAliases["@alice"] = "@alice"
	gateway.reverseTargets[conversation] = "@alice"
	gateway.memberNames["human_alice"] = "alice"
	gateway.directoryReady = true
	gateway.mu.Unlock()
	if err := gateway.UpdateAuthorization(platform.AgentIdentity{
		ID: agentID, ServerID: serverID, Capabilities: []string{"read"},
	}); err != nil {
		t.Fatal(err)
	}
	if err := gateway.messageIndex.Add("@alice", reference); err != nil {
		t.Fatal(err)
	}
	client := newGatewayTestClient(t, gateway.RuntimeEnvironment())
	var result struct {
		Message struct {
			MessageID   string `json:"message_id"`
			ChannelName string `json:"channel_name"`
			SenderName  string `json:"sender_name"`
			Content     string `json:"content"`
		} `json:"message"`
	}
	if err := client.Call(context.Background(), agentapi.MessageResolve, agentapi.Request{
		Path: map[string]string{"msgId": "abcdef01"},
	}, &result); err != nil {
		t.Fatal(err)
	}
	if result.Message.MessageID != "abcdef0123456789" ||
		result.Message.ChannelName != "alice" || result.Message.SenderName != "alice" ||
		result.Message.Content != "resolved" {
		t.Fatalf("resolved message = %#v", result.Message)
	}
}

func TestGatewayScansBoundedTopicSearchPages(t *testing.T) {
	t.Parallel()
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	conversation, _ := im.NewTopicConversation("community-1", "topic-general")
	firstRef, _ := im.NewMessageRef(conversation, "topic-search-first", 10, 1785701000000)
	secondRef, _ := im.NewMessageRef(conversation, "topic-search-second", 20, 1785702000000)
	transport := &recordingTransport{searchPages: map[string]im.SearchPage{
		"": {
			Messages: []im.IncomingMessage{{
				Ref: firstRef, SenderUserID: "human_alice",
				Elements: []im.Element{{Type: im.ElementText, Text: "第一条命中"}},
			}},
			NextCursor: "topic-next", Completed: false,
		},
		"topic-next": {
			Messages: []im.IncomingMessage{{
				Ref: secondRef, SenderUserID: "agent_reviewer",
				Elements: []im.Element{{Type: im.ElementText, Text: "第二条命中"}},
			}},
			Completed: true,
		},
	}}
	slot := NewTransportSlot()
	binding := slot.Bind(transport)
	defer binding.Release()
	gateway, err := newTestGateway(t, Config{
		AgentID: "agent_1", ServerID: "server_1", RuntimeEpoch: "search-runtime-1",
		StateRoot: t.TempDir(), Executable: executable, Transport: slot,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer gateway.Close(context.Background())
	gateway.mu.Lock()
	gateway.targets["#general"] = conversation
	gateway.targetAliases["#general"] = "#general"
	gateway.reverseTargets[conversation] = "#general"
	gateway.memberNames["human_alice"] = "alice"
	gateway.memberNames["agent_reviewer"] = "reviewer"
	gateway.directoryReady = true
	gateway.directory = platform.RuntimeDirectory{Members: []platform.DirectoryMember{
		{Kind: "human", Handle: "alice", IMUserID: "human_alice"},
		{Kind: "agent", Handle: "reviewer", IMUserID: "agent_reviewer"},
	}}
	gateway.mu.Unlock()
	if err := gateway.UpdateAuthorization(platform.AgentIdentity{
		ID: "agent_1", ServerID: "server_1", Capabilities: []string{"read"},
	}); err != nil {
		t.Fatal(err)
	}
	client := newGatewayTestClient(t, gateway.RuntimeEnvironment())
	var result struct {
		Results []struct {
			ID         string `json:"id"`
			SenderType string `json:"senderType"`
		} `json:"results"`
		HasMore bool `json:"hasMore"`
	}
	if err := client.Call(context.Background(), agentapi.MessageSearch, agentapi.Request{
		Query: url.Values{"q": {"命中"}, "channel": {"#general"}, "limit": {"20"}},
	}, &result); err != nil {
		t.Fatal(err)
	}
	if len(result.Results) != 2 || result.Results[0].ID != "topic-search-second" ||
		result.Results[0].SenderType != "agent" ||
		result.Results[1].ID != "topic-search-first" || result.HasMore ||
		len(transport.searchRequests) != 2 || transport.searchRequests[1].Cursor != "topic-next" {
		t.Fatalf("topic search = %#v, requests = %#v", result, transport.searchRequests)
	}
}

func TestGatewayStagesSendsProjectsAndDownloadsTencentAttachment(t *testing.T) {
	t.Parallel()
	const (
		serverID  = "0198fb93-94dc-7b86-bfab-d3b7ee8f4101"
		agentID   = "0198fb93-94dd-7be7-862b-3b5098604102"
		channelID = "0198fb93-94de-7b81-a380-98665d824103"
	)
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	conversation, err := im.NewGroupConversation("group-general")
	if err != nil {
		t.Fatal(err)
	}
	transport := &recordingTransport{attachmentReceipt: im.SendAttachmentReceipt{
		SendReceipt: im.SendReceipt{
			MessageID: "file-message-1", TimestampMS: 1785701000000, Sequence: 30,
		},
		Attachment: im.Attachment{
			ID: "tencent-file-1", Filename: "说明.txt", MIMEType: "text/plain",
			SizeBytes: 6, URL: "https://cos.ap-shanghai.myqcloud.com/tencent-file-1",
		},
	}}
	fetchCalls := 0
	slot := NewTransportSlot()
	binding := slot.Bind(transport)
	defer binding.Release()
	gateway, err := newTestGateway(t, Config{
		AgentID: agentID, ServerID: serverID, RuntimeEpoch: "attachment-runtime-1",
		StateRoot: t.TempDir(), Executable: executable, Transport: slot,
		AttachmentFetcher: func(
			_ context.Context,
			rawURL string,
		) ([]byte, string, error) {
			fetchCalls++
			if rawURL != "https://cos.ap-shanghai.myqcloud.com/tencent-file-1" {
				t.Fatalf("attachment URL = %q", rawURL)
			}
			return []byte("你好"), "text/plain", nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer gateway.Close(context.Background())
	gateway.mu.Lock()
	gateway.targets["#general"] = conversation
	gateway.targetAliases["#general"] = "#general"
	gateway.reverseTargets[conversation] = "#general"
	gateway.directoryReady = true
	gateway.directory = platform.RuntimeDirectory{
		Server: platform.DirectoryServer{ID: serverID, Slug: "team", Name: "Team"},
		Self:   platform.DirectorySelf{AgentID: agentID, MemberID: agentID, IMUserID: "agent_builder"},
		Channels: []platform.DirectoryChannel{{
			ID: channelID, Name: "general", Visibility: "public", Joined: true,
			IMGroupID: "group-general", IMState: "ready",
		}},
	}
	gateway.mu.Unlock()
	if err := gateway.UpdateAuthorization(platform.AgentIdentity{
		ID: agentID, ServerID: serverID,
		Capabilities: []string{"read", "send", "attachments"},
	}); err != nil {
		t.Fatal(err)
	}
	client := newGatewayTestClient(t, gateway.RuntimeEnvironment())
	var resolved struct {
		ChannelID string `json:"channelId"`
	}
	if err := client.Call(context.Background(), agentapi.ChannelResolve, agentapi.Request{
		Body: map[string]string{"target": "#general"},
	}, &resolved); err != nil || resolved.ChannelID != channelID {
		t.Fatalf("resolved channel = (%#v, %v)", resolved, err)
	}

	body := new(bytes.Buffer)
	writer := multipart.NewWriter(body)
	part, err := writer.CreateFormFile("file", "说明.txt")
	if err != nil {
		t.Fatal(err)
	}
	_, _ = part.Write([]byte("你好"))
	_ = writer.WriteField("channelId", channelID)
	_ = writer.WriteField("mimeType", "text/plain")
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	var uploaded struct {
		ID        string `json:"id"`
		Filename  string `json:"filename"`
		SizeBytes int64  `json:"sizeBytes"`
	}
	if err := client.Call(context.Background(), agentapi.AttachmentUpload, agentapi.Request{
		RawBody: body,
		Headers: http.Header{"Content-Type": []string{writer.FormDataContentType()}},
	}, &uploaded); err != nil || uploaded.ID == "" || uploaded.Filename != "说明.txt" ||
		uploaded.SizeBytes != 6 {
		t.Fatalf("uploaded = (%#v, %v)", uploaded, err)
	}
	if err := gateway.UpdateAuthorization(platform.AgentIdentity{
		ID: agentID, ServerID: serverID, Capabilities: []string{"read", "send"},
	}); err != nil {
		t.Fatal(err)
	}
	err = client.Call(context.Background(), agentapi.MessageSend, agentapi.Request{
		Body: map[string]any{
			"target": "#general", "content": "不应发送附件",
			"attachmentIds": []string{uploaded.ID},
		},
	}, nil)
	httpError, ok := err.(*agentapi.HTTPError)
	if !ok || httpError.StatusCode != http.StatusForbidden || transport.attachmentRequest.Filename != "" {
		t.Fatalf("attachment capability error = %#v, request = %#v", err, transport.attachmentRequest)
	}
	if err := gateway.UpdateAuthorization(platform.AgentIdentity{
		ID: agentID, ServerID: serverID,
		Capabilities: []string{"read", "send", "attachments"},
	}); err != nil {
		t.Fatal(err)
	}
	var sent map[string]any
	if err := client.Call(context.Background(), agentapi.MessageSend, agentapi.Request{
		Body: map[string]any{
			"target": "#general", "content": "请看附件",
			"attachmentIds": []string{uploaded.ID},
		},
	}, &sent); err != nil {
		t.Fatal(err)
	}
	if transport.attachmentRequest.Filename != "说明.txt" ||
		string(transport.attachmentRequest.Data) != "你好" ||
		transport.attachmentRequest.Conversation != conversation ||
		transport.request.Text != "请看附件" {
		t.Fatalf("attachment/text requests = %#v / %#v", transport.attachmentRequest, transport.request)
	}

	remoteRef, _ := im.NewMessageRef(conversation, "incoming-file-message", 31, 1785701001000)
	if _, err := gateway.RegisterMessage(im.IncomingMessage{
		Ref: remoteRef, SenderUserID: "human_alice",
		Elements: []im.Element{{
			Type: im.ElementAttachment,
			Attachment: &im.Attachment{
				ID: "tencent-file-1", Filename: "说明.txt", MIMEType: "text/plain",
				SizeBytes: 6, URL: "https://cos.ap-shanghai.myqcloud.com/tencent-file-1",
			},
		}},
	}); err != nil {
		t.Fatal(err)
	}
	var events struct {
		Events []struct {
			Attachments []struct {
				ID       string `json:"id"`
				Filename string `json:"filename"`
			} `json:"attachments"`
		} `json:"events"`
	}
	if err := client.Call(context.Background(), agentapi.Events, agentapi.Request{}, &events); err != nil ||
		len(events.Events) != 1 || len(events.Events[0].Attachments) != 1 ||
		events.Events[0].Attachments[0].Filename != "说明.txt" {
		t.Fatalf("attachment events = (%#v, %v)", events, err)
	}
	downloadID := events.Events[0].Attachments[0].ID
	rawRequest, err := http.NewRequest(
		http.MethodGet,
		gateway.RuntimeEnvironment()["SLOCK_AGENT_PROXY_URL"]+agentapi.BasePath+"/attachments/"+downloadID,
		nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	tokenData, err := os.ReadFile(gateway.RuntimeEnvironment()["SLOCK_AGENT_PROXY_TOKEN_FILE"])
	if err != nil {
		t.Fatal(err)
	}
	rawRequest.Header.Set("Authorization", "Bearer "+string(tokenData))
	rawResponse, err := http.DefaultClient.Do(rawRequest)
	if err != nil {
		t.Fatal(err)
	}
	defer rawResponse.Body.Close()
	downloaded, err := io.ReadAll(rawResponse.Body)
	if err != nil {
		t.Fatal(err)
	}
	if rawResponse.StatusCode != http.StatusOK || string(downloaded) != "你好" ||
		rawResponse.Header.Get("Content-Type") != "text/plain" {
		t.Fatalf("download = status %d, type %q, body %q",
			rawResponse.StatusCode, rawResponse.Header.Get("Content-Type"), downloaded)
	}
	gateway.mu.Lock()
	delete(gateway.targets, "#general")
	delete(gateway.targetAliases, "#general")
	delete(gateway.reverseTargets, conversation)
	gateway.directory.Channels = nil
	gateway.mu.Unlock()
	revokedRequest, err := http.NewRequest(
		http.MethodGet,
		gateway.RuntimeEnvironment()["SLOCK_AGENT_PROXY_URL"]+agentapi.BasePath+"/attachments/"+downloadID,
		nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	revokedRequest.Header.Set("Authorization", "Bearer "+string(tokenData))
	revokedResponse, err := http.DefaultClient.Do(revokedRequest)
	if err != nil {
		t.Fatal(err)
	}
	defer revokedResponse.Body.Close()
	if revokedResponse.StatusCode != http.StatusForbidden || fetchCalls != 1 {
		t.Fatalf("revoked attachment download = status %d, fetch calls %d", revokedResponse.StatusCode, fetchCalls)
	}
}

func TestGatewaySendsTencentThreadReplyThenRegistersStableReference(t *testing.T) {
	t.Parallel()
	const (
		serverID  = "0198fb3d-4057-7df5-9cf1-cc81fbaa3101"
		agentID   = "0198fb3d-4058-7f39-a40d-d44535a63102"
		humanID   = "0198fb3d-4059-7631-8de7-b23ed4d23103"
		channelID = "0198fb3d-405a-711d-9540-a46cce1f3104"
		threadID  = "0198fb3d-405b-73bf-9229-5f2665553105"
		replyID   = "0198fb3d-405c-75cd-b6bf-08abefaa3106"
	)
	now := time.Date(2026, 8, 2, 20, 0, 0, 0, time.UTC)
	resolveCalls := 0
	replyCalls := 0
	platformServer := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Authorization") != "Bearer runtime-thread-token" {
			http.NotFound(response, request)
			return
		}
		response.Header().Set("Content-Type", "application/json")
		switch {
		case request.Method == http.MethodGet && request.URL.Path == "/v1/runtime/directory":
			_, _ = fmt.Fprintf(response, `{
              "server":{"id":%q,"slug":"team","name":"研发"},
              "self":{"agentId":%q,"memberId":%q,"handle":"builder","displayName":"Builder","imUserId":"agent_builder"},
              "channels":[{"id":%q,"name":"general","visibility":"public","joined":true,"imGroupId":"community-1","imTopicId":"topic-general","imState":"ready","revision":1}],
              "members":[
                {"memberId":%q,"kind":"agent","agentId":%q,"handle":"builder","displayName":"Builder","imUserId":"agent_builder"},
                {"memberId":%q,"kind":"human","humanId":%q,"handle":"alice","displayName":"Alice","imUserId":"human_alice"}
              ],
              "revision":"sha256:thread","expiresAt":%q
            }`, serverID, agentID, agentID, channelID, agentID, agentID,
				humanID, humanID, now.Add(2*time.Minute).Format(time.RFC3339))
		case request.Method == http.MethodPost && request.URL.Path == "/v1/runtime/threads:resolve":
			resolveCalls++
			var body struct {
				ChannelID string `json:"channelId"`
				Root      struct {
					MessageID string `json:"messageId"`
					Sequence  int64  `json:"sequence"`
				} `json:"rootMessageRef"`
			}
			if err := common.DecodeJson(request.Body, &body); err != nil ||
				body.ChannelID != channelID || body.Root.MessageID != "root-message-12345678" ||
				body.Root.Sequence != 42 {
				t.Fatalf("resolve body = (%#v, %v)", body, err)
			}
			_, _ = fmt.Fprintf(response, `{
              "id":%q,"serverId":%q,"channelId":%q,
              "rootMessageRef":{"kind":"group","messageId":"root-message-12345678","groupId":"community-1","topicId":"topic-general","senderUserId":"human_alice","sequence":42,"timestamp":1785700800},
              "replyCount":0,"unreadCount":0,"lastReplyAt":null,"createdAt":%q
            }`, threadID, serverID, channelID, now.Format(time.RFC3339))
		case request.Method == http.MethodPost && request.URL.Path == "/v1/runtime/threads/"+threadID+"/replies":
			replyCalls++
			var body struct {
				ChannelID string `json:"channelId"`
				Message   struct {
					MessageID    string `json:"messageId"`
					SenderUserID string `json:"senderUserId"`
					Sequence     int64  `json:"sequence"`
				} `json:"messageRef"`
			}
			if err := common.DecodeJson(request.Body, &body); err != nil ||
				body.ChannelID != channelID || body.Message.MessageID != "sent-thread-reply" ||
				body.Message.SenderUserID != "agent_builder" || body.Message.Sequence != 43 {
				t.Fatalf("reply body = (%#v, %v)", body, err)
			}
			response.WriteHeader(http.StatusCreated)
			_, _ = fmt.Fprintf(response, `{
              "id":%q,"threadId":%q,
              "messageRef":{"kind":"group","messageId":"sent-thread-reply","groupId":"community-1","topicId":"topic-general","senderUserId":"agent_builder","sequence":43,"timestamp":1785700801},
              "createdAt":%q
            }`, replyID, threadID, now.Add(time.Second).Format(time.RFC3339))
		default:
			http.NotFound(response, request)
		}
	}))
	defer platformServer.Close()
	platformClient, err := platform.NewClient(platform.Config{
		BaseURL: platformServer.URL + "/v1", HTTPClient: platformServer.Client(),
		AllowInsecureLoopback: true, Now: func() time.Time { return now },
		MaxSessionTTL: 15 * time.Minute,
	})
	if err != nil {
		t.Fatal(err)
	}
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	transport := &recordingTransport{receipt: im.SendReceipt{
		MessageID: "sent-thread-reply", TimestampMS: 1785700801000, Sequence: 43,
	}}
	slot := NewTransportSlot()
	binding := slot.Bind(transport)
	defer binding.Release()
	gateway, err := newTestGateway(t, Config{
		AgentID: agentID, ServerID: serverID, RuntimeEpoch: "thread-runtime-1",
		StateRoot: t.TempDir(), Executable: executable, Transport: slot,
		PlatformClient: platformClient,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer gateway.Close(context.Background())
	token, _ := platform.NewAccessToken("runtime-thread-token")
	if err := gateway.UpdateSession(platform.RuntimeSession{
		AccessToken: token,
		Agent: platform.AgentIdentity{
			ID: agentID, ServerID: serverID,
			Capabilities: []string{"read", "send", "server", "channels", "threads"},
		},
	}); err != nil {
		t.Fatal(err)
	}
	conversation, _ := im.NewTopicConversation("community-1", "topic-general")
	rootRef, _ := im.NewMessageRef(conversation, "root-message-12345678", 42, 1785700800000)
	if _, err := gateway.RegisterMessage(im.IncomingMessage{
		Ref: rootRef, SenderUserID: "human_alice",
		Elements: []im.Element{{Type: im.ElementText, Text: "根消息"}},
	}); err != nil {
		t.Fatal(err)
	}
	client := newGatewayTestClient(t, gateway.RuntimeEnvironment())
	var sent map[string]any
	if err := client.Call(context.Background(), agentapi.MessageSend, agentapi.Request{
		Body: map[string]any{
			"target": "#general:root-mes", "content": "Thread 回复",
		},
	}, &sent); err != nil {
		t.Fatalf("MessageSend(thread) error = %v", err)
	}
	if resolveCalls != 1 || replyCalls != 1 || transport.request.Text != "Thread 回复" ||
		transport.request.Conversation != conversation || sent["messageId"] != "sent-thread-reply" {
		t.Fatalf("thread send: resolve=%d reply=%d request=%#v response=%#v",
			resolveCalls, replyCalls, transport.request, sent)
	}
	var metadata map[string]any
	if err := common.Unmarshal([]byte(transport.request.CloudCustomData), &metadata); err != nil ||
		metadata["schema"] != "raft.message/v1" || metadata["serverId"] != serverID ||
		metadata["conversationId"] != channelID ||
		metadata["parentMessageId"] != "root-message-12345678" ||
		metadata["rootMessageId"] != "root-message-12345678" {
		t.Fatalf("thread metadata = (%#v, %v)", metadata, err)
	}
	threadMetadata, ok := metadata["thread"].(map[string]any)
	if !ok || threadMetadata["role"] != "reply" || threadMetadata["threadId"] != threadID {
		t.Fatalf("thread metadata extension = %#v", metadata["thread"])
	}
	incomingRef, _ := im.NewMessageRef(conversation, "human-thread-reply", 44, 1785700802000)
	threadMessage := im.IncomingMessage{
		Ref: incomingRef, SenderUserID: "human_alice",
		CloudCustomData: transport.request.CloudCustomData,
		Elements:        []im.Element{{Type: im.ElementText, Text: "继续讨论"}},
	}
	if target, err := gateway.RegisterMessage(threadMessage); err != nil ||
		target != "#general:root-message-12345678" {
		t.Fatalf("RegisterMessage(thread reply) = %q, %v", target, err)
	}
	var events struct {
		ReplyTarget string `json:"reply_target"`
	}
	if err := client.Call(context.Background(), agentapi.Events, agentapi.Request{}, &events); err != nil ||
		events.ReplyTarget != "#general:root-message-12345678" {
		t.Fatalf("events = (%#v, %v)", events, err)
	}
	transport.historyPage = im.HistoryPage{
		Messages: []im.IncomingMessage{
			{Ref: rootRef, SenderUserID: "human_alice", Elements: []im.Element{{Type: im.ElementText, Text: "根消息"}}},
			threadMessage,
		},
		Completed: true,
	}
	var history struct {
		Messages []struct {
			ID string `json:"id"`
		} `json:"messages"`
	}
	if err := client.Call(context.Background(), agentapi.HistoryRead, agentapi.Request{
		Query: url.Values{"channel": {"#general:root-message-12345678"}, "limit": {"20"}},
	}, &history); err != nil || len(history.Messages) != 1 ||
		history.Messages[0].ID != "human-thread-reply" {
		t.Fatalf("thread history = (%#v, %v)", history, err)
	}
}

func TestGatewayRetriesPendingThreadRegistrationAfterRestart(t *testing.T) {
	const (
		serverID  = "0198fb4d-4057-7df5-9cf1-cc81fbaa3101"
		agentID   = "0198fb4d-4058-7f39-a40d-d44535a63102"
		channelID = "0198fb4d-405a-711d-9540-a46cce1f3104"
		threadID  = "0198fb4d-405b-73bf-9229-5f2665553105"
		replyID   = "0198fb4d-405c-75cd-b6bf-08abefaa3106"
	)
	now := time.Date(2026, 8, 2, 20, 0, 0, 0, time.UTC)
	replyCalls := 0
	platformServer := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Authorization") != "Bearer runtime-thread-token" {
			http.NotFound(response, request)
			return
		}
		response.Header().Set("Content-Type", "application/json")
		switch {
		case request.Method == http.MethodGet && request.URL.Path == "/v1/runtime/directory":
			_, _ = fmt.Fprintf(response, `{
              "server":{"id":%q,"slug":"team","name":"研发"},
              "self":{"agentId":%q,"memberId":%q,"handle":"builder","displayName":"Builder","imUserId":"agent_builder"},
              "channels":[{"id":%q,"name":"general","visibility":"public","joined":true,"imGroupId":"community-1","imTopicId":"topic-general","imState":"ready","revision":1}],
              "members":[{"memberId":%q,"kind":"agent","agentId":%q,"handle":"builder","displayName":"Builder","imUserId":"agent_builder"}],
              "revision":"sha256:thread-restart","expiresAt":%q
            }`, serverID, agentID, agentID, channelID, agentID, agentID,
				now.Add(10*time.Minute).Format(time.RFC3339))
		case request.Method == http.MethodPost && request.URL.Path == "/v1/runtime/threads:resolve":
			_, _ = fmt.Fprintf(response, `{
              "id":%q,"serverId":%q,"channelId":%q,
              "rootMessageRef":{"kind":"group","messageId":"root-message-12345678","groupId":"community-1","topicId":"topic-general","senderUserId":"human_alice","sequence":42,"timestamp":1785700800},
              "replyCount":0,"unreadCount":0,"lastReplyAt":null,"createdAt":%q
            }`, threadID, serverID, channelID, now.Format(time.RFC3339))
		case request.Method == http.MethodPost && request.URL.Path == "/v1/runtime/threads/"+threadID+"/replies":
			replyCalls++
			if replyCalls == 1 {
				http.Error(response, `{"code":"temporary_failure"}`, http.StatusServiceUnavailable)
				return
			}
			response.WriteHeader(http.StatusCreated)
			_, _ = fmt.Fprintf(response, `{
              "id":%q,"threadId":%q,
              "messageRef":{"kind":"group","messageId":"sent-thread-reply","groupId":"community-1","topicId":"topic-general","senderUserId":"agent_builder","sequence":43,"timestamp":1785700801},
              "createdAt":%q
            }`, replyID, threadID, now.Add(time.Second).Format(time.RFC3339))
		default:
			http.NotFound(response, request)
		}
	}))
	defer platformServer.Close()
	platformClient, err := platform.NewClient(platform.Config{
		BaseURL: platformServer.URL + "/v1", HTTPClient: platformServer.Client(),
		AllowInsecureLoopback: true, Now: func() time.Time { return now },
		MaxSessionTTL: 15 * time.Minute,
	})
	if err != nil {
		t.Fatal(err)
	}
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	stateRoot := t.TempDir()
	transport := &recordingTransport{receipt: im.SendReceipt{
		MessageID: "sent-thread-reply", TimestampMS: 1785700801000, Sequence: 43,
	}}
	slot := NewTransportSlot()
	binding := slot.Bind(transport)
	defer binding.Release()
	newGateway := func(epoch string) *Gateway {
		gateway, createErr := newTestGateway(t, Config{
			AgentID: agentID, ServerID: serverID, RuntimeEpoch: epoch,
			StateRoot: stateRoot, Executable: executable, Transport: slot,
			PlatformClient: platformClient, Now: func() time.Time { return now },
		})
		if createErr != nil {
			t.Fatal(createErr)
		}
		return gateway
	}
	session := platform.RuntimeSession{
		AccessToken: func() platform.AccessToken {
			token, _ := platform.NewAccessToken("runtime-thread-token")
			return token
		}(),
		Agent: platform.AgentIdentity{
			ID: agentID, ServerID: serverID,
			Capabilities: []string{"read", "send", "server", "channels", "threads"},
		},
	}
	first := newGateway("thread-runtime-restart-1")
	if err := first.UpdateSession(session); err != nil {
		t.Fatal(err)
	}
	conversation, _ := im.NewTopicConversation("community-1", "topic-general")
	rootRef, _ := im.NewMessageRef(conversation, "root-message-12345678", 42, 1785700800000)
	if _, err := first.RegisterMessage(im.IncomingMessage{
		Ref: rootRef, SenderUserID: "human_alice",
		Elements: []im.Element{{Type: im.ElementText, Text: "根消息"}},
	}); err != nil {
		t.Fatal(err)
	}
	client := newGatewayTestClient(t, first.RuntimeEnvironment())
	var sent map[string]any
	if err := client.Call(context.Background(), agentapi.MessageSend, agentapi.Request{
		Body: map[string]any{"target": "#general:root-mes", "content": "Thread 回复"},
	}, &sent); err != nil {
		t.Fatal(err)
	}
	if sent["threadRegistration"] != "pending" || replyCalls != 1 {
		t.Fatalf("first send = %#v, reply calls = %d", sent, replyCalls)
	}
	pendingPath := filepath.Join(stateRoot, pendingThreadRegistrationPath)
	if _, err := os.Stat(pendingPath); err != nil {
		t.Fatalf("pending registration not persisted: %v", err)
	}
	if err := first.Close(context.Background()); err != nil {
		t.Fatal(err)
	}

	second := newGateway("thread-runtime-restart-2")
	defer second.Close(context.Background())
	if err := second.UpdateSession(session); err != nil {
		t.Fatal(err)
	}
	if replyCalls != 2 {
		t.Fatalf("reply calls after restart = %d, want 2", replyCalls)
	}
	if _, err := os.Stat(pendingPath); !os.IsNotExist(err) {
		t.Fatalf("pending registration remains after recovery: %v", err)
	}
}

func TestThreadMetadataParserKeepsReadCompatibility(t *testing.T) {
	t.Parallel()
	const (
		serverID  = "0198fb5d-4057-7df5-9cf1-cc81fbaa3101"
		channelID = "0198fb5d-405a-711d-9540-a46cce1f3104"
		threadID  = "0198fb5d-405b-73bf-9229-5f2665553105"
		rootID    = "root-message-12345678"
	)
	for _, test := range []struct {
		name  string
		value string
	}{
		{
			name: "current web envelope",
			value: fmt.Sprintf(`{"schema":"raft.message/v1","serverId":%q,"conversationId":%q,"clientRequestId":"request-1","parentMessageId":%q,"rootMessageId":%q,"mentionedMemberIds":[],"attachmentIds":[]}`,
				serverID, channelID, rootID, rootID),
		},
		{
			name: "legacy flat envelope",
			value: fmt.Sprintf(`{"type":"raft.thread-reply/v1","threadId":%q,"channelId":%q,"rootMessageId":%q}`,
				threadID, channelID, rootID),
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			metadata, ok := parseThreadCloudMetadata(test.value)
			if !ok || metadata.RootMessageID != rootID || metadata.ChannelID != channelID {
				t.Fatalf("parseThreadCloudMetadata() = (%#v, %t)", metadata, ok)
			}
		})
	}
}

func TestGatewayExposesObservedInboxAndSendsThroughBoundTransport(t *testing.T) {
	t.Parallel()

	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	slot := NewTransportSlot()
	transport := &recordingTransport{}
	binding := slot.Bind(transport)
	defer binding.Release()
	gateway, err := newTestGateway(t, Config{
		AgentID:      "agent_1",
		ServerID:     "server_1",
		RuntimeEpoch: "runtime-epoch-1",
		StateRoot:    t.TempDir(),
		Executable:   executable,
		Transport:    slot,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer gateway.Close(context.Background())
	if err := gateway.UpdateAuthorization(platform.AgentIdentity{
		ID:           "agent_1",
		ServerID:     "server_1",
		Capabilities: []string{"read", "send", "server", "reactions"},
	}); err != nil {
		t.Fatal(err)
	}

	message := gatewayIncomingMessage(t)
	transport.historyPage = im.HistoryPage{
		Messages: []im.IncomingMessage{message}, Completed: true,
	}
	transport.searchPage = im.SearchPage{
		Messages: []im.IncomingMessage{message}, Completed: true, TotalCount: 1,
	}
	target, err := gateway.RegisterMessage(message)
	if err != nil {
		t.Fatal(err)
	}
	environment := gateway.RuntimeEnvironment()
	client, err := agentapi.New(agentapi.ClientOptions{
		BaseURL:   environment["SLOCK_AGENT_PROXY_URL"],
		TokenFile: environment["SLOCK_AGENT_PROXY_TOKEN_FILE"],
	})
	if err != nil {
		t.Fatal(err)
	}

	var inbox struct {
		Rows []struct {
			Target       string `json:"target"`
			PendingCount int    `json:"pendingCount"`
		} `json:"rows"`
	}
	if err := client.Call(
		context.Background(),
		agentapi.InboxCheck,
		agentapi.Request{},
		&inbox,
	); err != nil {
		t.Fatal(err)
	}
	if len(inbox.Rows) != 1 ||
		inbox.Rows[0].Target != target ||
		inbox.Rows[0].PendingCount != 1 {
		t.Fatalf("inbox = %#v", inbox)
	}

	var history struct {
		Messages []struct {
			Sequence   float64 `json:"seq"`
			ID         string  `json:"id"`
			SenderName string  `json:"senderName"`
			SenderType string  `json:"senderType"`
			Content    string  `json:"content"`
		} `json:"messages"`
		HasMore  bool `json:"has_more"`
		HasOlder bool `json:"has_older"`
		HasNewer bool `json:"has_newer"`
	}
	if err := client.Call(
		context.Background(),
		agentapi.HistoryRead,
		agentapi.Request{Query: url.Values{
			"channel": {target},
			"around":  {"message_1"},
			"limit":   {"20"},
		}},
		&history,
	); err != nil {
		t.Fatal(err)
	}
	if len(history.Messages) != 1 ||
		history.Messages[0].Sequence != 1 ||
		history.Messages[0].ID != "message_1" ||
		history.Messages[0].SenderName != "human_1" ||
		history.Messages[0].SenderType != "human" ||
		history.Messages[0].Content != "你好" ||
		history.HasMore ||
		history.HasOlder ||
		history.HasNewer {
		t.Fatalf("history = %#v", history)
	}
	if len(transport.historyRequests) != 1 ||
		transport.historyRequests[0].AroundTimestampMS !=
			message.Ref.TimestampMS() ||
		transport.historyRequests[0].AroundSequence != 0 {
		t.Fatalf(
			"C2C around history request = %#v",
			transport.historyRequests,
		)
	}
	var search struct {
		Results []struct {
			ID      string `json:"id"`
			Content string `json:"content"`
		} `json:"results"`
		HasMore bool `json:"hasMore"`
	}
	if err := client.Call(context.Background(), agentapi.MessageSearch, agentapi.Request{
		Query: url.Values{"q": {"你好"}, "channel": {target}, "limit": {"20"}},
	}, &search); err != nil {
		t.Fatal(err)
	}
	if len(search.Results) != 1 || search.Results[0].ID != "message_1" ||
		search.Results[0].Content != "你好" || search.HasMore {
		t.Fatalf("search = %#v", search)
	}
	if err := client.Call(context.Background(), agentapi.MessageReactionAdd, agentapi.Request{
		Path: map[string]string{"msgId": "message_1"},
		Body: map[string]string{"emoji": "👍"},
	}, nil); err != nil {
		t.Fatal(err)
	}
	if transport.reactionID != "👍" || !transport.reactionActive ||
		transport.reactionRef.MessageID() != "message_1" {
		t.Fatalf("reaction = (%#v, %q, %t)", transport.reactionRef, transport.reactionID, transport.reactionActive)
	}
	gateway.mu.Lock()
	delete(gateway.targets, target)
	delete(gateway.targetAliases, strings.ToLower(target))
	gateway.mu.Unlock()
	err = client.Call(context.Background(), agentapi.MessageReactionRemove, agentapi.Request{
		Path: map[string]string{"msgId": "message_1"},
		Body: map[string]string{"emoji": "👍"},
	}, nil)
	httpError, ok := err.(*agentapi.HTTPError)
	if !ok || httpError.StatusCode != http.StatusForbidden || !transport.reactionActive {
		t.Fatalf("revoked target reaction = error %#v, active %t", err, transport.reactionActive)
	}
	gateway.mu.Lock()
	gateway.targets[target] = message.Ref.Conversation()
	gateway.targetAliases[strings.ToLower(target)] = target
	gateway.reverseTargets[message.Ref.Conversation()] = target
	gateway.mu.Unlock()

	var events struct {
		Events []struct {
			MessageID string `json:"message_id"`
			Content   string `json:"content"`
		} `json:"events"`
		HasMore bool `json:"has_more"`
	}
	if err := client.Call(
		context.Background(),
		agentapi.Events,
		agentapi.Request{},
		&events,
	); err != nil {
		t.Fatal(err)
	}
	if len(events.Events) != 1 ||
		events.Events[0].MessageID != "message_1" ||
		events.Events[0].Content != "你好" ||
		events.HasMore {
		t.Fatalf("events = %#v", events)
	}
	var drained struct {
		Events  []any `json:"events"`
		HasMore bool  `json:"has_more"`
	}
	if err := client.Call(
		context.Background(),
		agentapi.Events,
		agentapi.Request{},
		&drained,
	); err != nil {
		t.Fatal(err)
	}
	if len(drained.Events) != 0 || drained.HasMore {
		t.Fatalf("drained events = %#v", drained)
	}

	var sent struct {
		OK        bool   `json:"ok"`
		State     string `json:"state"`
		MessageID string `json:"messageId"`
	}
	if err := client.Call(
		context.Background(),
		agentapi.MessageSend,
		agentapi.Request{Body: map[string]any{
			"target":  target,
			"content": "收到",
		}},
		&sent,
	); err != nil {
		t.Fatal(err)
	}
	if !sent.OK || sent.State != "sent" || sent.MessageID != "sent_1" {
		t.Fatalf("sent = %#v", sent)
	}
	if transport.request.Text != "收到" ||
		transport.request.Conversation.PeerUserID() != "human_1" {
		t.Fatalf("transport request = %#v", transport.request)
	}
	secondConversation, err := im.NewC2CConversation("human_2")
	if err != nil {
		t.Fatal(err)
	}
	secondRef, err := im.NewMessageRef(
		secondConversation, "message_2", 2, 1785398401000,
	)
	if err != nil {
		t.Fatal(err)
	}
	secondTarget, err := gateway.RegisterMessage(im.IncomingMessage{
		Ref: secondRef, SenderUserID: "human_2",
		Elements: []im.Element{{Type: im.ElementText, Text: "另一个目标"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := client.Call(
		context.Background(),
		agentapi.MessageSend,
		agentapi.Request{Body: map[string]any{
			"target": secondTarget, "content": "另一条独立消息",
		}},
		&sent,
	); err != nil {
		t.Fatal(err)
	}
	if !sent.OK || sent.State != "sent" || sent.MessageID != "sent_2" {
		t.Fatalf("second sent = %#v", sent)
	}
	if transport.request.Text != "另一条独立消息" ||
		transport.request.Conversation.PeerUserID() != "human_2" {
		t.Fatalf("second transport request = %#v", transport.request)
	}
}

func TestGatewayRejectsUnknownTokenAndUnobservedTarget(t *testing.T) {
	t.Parallel()

	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	slot := NewTransportSlot()
	binding := slot.Bind(&recordingTransport{})
	defer binding.Release()
	gateway, err := newTestGateway(t, Config{
		AgentID:      "agent_1",
		ServerID:     "server_1",
		RuntimeEpoch: "runtime-epoch-1",
		StateRoot:    t.TempDir(),
		Executable:   executable,
		Transport:    slot,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer gateway.Close(context.Background())
	if err := gateway.UpdateAuthorization(platform.AgentIdentity{
		ID:           "agent_1",
		ServerID:     "server_1",
		Capabilities: []string{"read", "send"},
	}); err != nil {
		t.Fatal(err)
	}
	environment := gateway.RuntimeEnvironment()

	request, err := http.NewRequest(
		http.MethodGet,
		environment["SLOCK_AGENT_PROXY_URL"]+
			"/internal/agent-api/inbox",
		nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Authorization", "Bearer sap_wrong")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusUnauthorized {
		t.Fatalf("status = %d", response.StatusCode)
	}

	client, err := agentapi.New(agentapi.ClientOptions{
		BaseURL:   environment["SLOCK_AGENT_PROXY_URL"],
		TokenFile: environment["SLOCK_AGENT_PROXY_TOKEN_FILE"],
	})
	if err != nil {
		t.Fatal(err)
	}
	err = client.Call(
		context.Background(),
		agentapi.MessageSend,
		agentapi.Request{Body: map[string]any{
			"target":  "c2c:not-observed",
			"content": "不应发送",
		}},
		nil,
	)
	httpError, ok := err.(*agentapi.HTTPError)
	if !ok || httpError.StatusCode != http.StatusForbidden {
		t.Fatalf("send error = %#v", err)
	}
}

type recordingTransport struct {
	request           im.SendTextRequest
	sendCalls         int
	historyPage       im.HistoryPage
	historyRequests   []im.HistoryRequest
	searchPage        im.SearchPage
	searchPages       map[string]im.SearchPage
	searchRequests    []im.SearchRequest
	reactionRef       im.MessageRef
	reactionID        string
	reactionActive    bool
	receipt           im.SendReceipt
	attachmentRequest im.SendAttachmentRequest
	attachmentReceipt im.SendAttachmentReceipt
}

func (r *recordingTransport) SendAttachment(
	_ context.Context,
	request im.SendAttachmentRequest,
) (im.SendAttachmentReceipt, error) {
	r.attachmentRequest = request
	return r.attachmentReceipt, nil
}

func (*recordingTransport) Start(context.Context, im.Session) error {
	return nil
}

func (r *recordingTransport) SendText(
	_ context.Context,
	request im.SendTextRequest,
) (im.SendReceipt, error) {
	r.request = request
	r.sendCalls++
	if r.receipt.MessageID != "" {
		return r.receipt, nil
	}
	return im.SendReceipt{
		MessageID:   fmt.Sprintf("sent_%d", r.sendCalls),
		TimestampMS: 1785398400000 + int64(r.sendCalls-1)*1000,
	}, nil
}

func (*recordingTransport) SendCustom(
	context.Context,
	im.SendCustomRequest,
) (im.SendReceipt, error) {
	return im.SendReceipt{}, nil
}

func (*recordingTransport) Events() <-chan im.Event {
	return nil
}

func (*recordingTransport) Close(context.Context) error {
	return nil
}

func (*recordingTransport) UnreadConversations(context.Context) ([]im.UnreadConversation, error) {
	return nil, nil
}

func (r *recordingTransport) History(
	_ context.Context,
	request im.HistoryRequest,
) (im.HistoryPage, error) {
	r.historyRequests = append(r.historyRequests, request)
	return r.historyPage, nil
}

func (*recordingTransport) MarkRead(context.Context, im.Conversation) error {
	return nil
}

func (r *recordingTransport) Search(_ context.Context, request im.SearchRequest) (im.SearchPage, error) {
	r.searchRequests = append(r.searchRequests, request)
	if r.searchPages != nil {
		return r.searchPages[request.Cursor], nil
	}
	return r.searchPage, nil
}

func (r *recordingTransport) SetReaction(
	_ context.Context,
	reference im.MessageRef,
	reactionID string,
	active bool,
) error {
	r.reactionRef = reference
	r.reactionID = reactionID
	r.reactionActive = active
	return nil
}

func gatewayIncomingMessage(t *testing.T) im.IncomingMessage {
	t.Helper()
	conversation, err := im.NewC2CConversation("human_1")
	if err != nil {
		t.Fatal(err)
	}
	reference, err := im.NewMessageRef(
		conversation,
		"message_1",
		1,
		time.Now().UnixMilli(),
	)
	if err != nil {
		t.Fatal(err)
	}
	return im.IncomingMessage{
		Ref:          reference,
		SenderUserID: "human_1",
		Elements: []im.Element{{
			Type: im.ElementText,
			Text: "你好",
		}},
	}
}
