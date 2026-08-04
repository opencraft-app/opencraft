package agentapi

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"velachat/agent/internal/common"
)

func TestClientCallsRegisteredRouteWithLaunchToken(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodPost || request.URL.Path != "/internal/agent-api/send" {
			t.Fatalf("request = %s %s", request.Method, request.URL.Path)
		}
		if request.Header.Get("Authorization") != "Bearer sap_test_launch_token" {
			t.Fatalf("authorization = %q", request.Header.Get("Authorization"))
		}
		var body map[string]string
		if err := common.DecodeJson(request.Body, &body); err != nil {
			t.Fatal(err)
		}
		if body["target"] != "#test" || body["text"] != "hello" {
			t.Fatalf("body = %#v", body)
		}
		response.Header().Set("Content-Type", "application/json")
		_, _ = response.Write([]byte(`{
			"ok":true,
			"state":"sent",
			"messageId":"message_test"
		}`))
	}))
	defer server.Close()

	tokenFile := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(tokenFile, []byte("sap_test_launch_token\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	client, err := New(ClientOptions{
		BaseURL:   server.URL,
		TokenFile: tokenFile,
	})
	if err != nil {
		t.Fatal(err)
	}
	var result struct {
		State string `json:"state"`
	}
	if err := client.Call(context.Background(), MessageSend, Request{
		Body: map[string]string{"target": "#test", "text": "hello"},
	}, &result); err != nil {
		t.Fatal(err)
	}
	if result.State != "sent" {
		t.Fatalf("state = %q", result.State)
	}
}

func TestClientReturnsStructuredHTTPError(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.WriteHeader(http.StatusForbidden)
		_, _ = response.Write([]byte(`{"code":"capability_denied","message":"not allowed"}`))
	}))
	defer server.Close()

	tokenFile := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(tokenFile, []byte("sap_test"), 0o600); err != nil {
		t.Fatal(err)
	}
	client, err := New(ClientOptions{BaseURL: server.URL, TokenFile: tokenFile})
	if err != nil {
		t.Fatal(err)
	}
	err = client.Call(context.Background(), ServerInfo, Request{}, &map[string]any{})
	httpError, ok := err.(*HTTPError)
	if !ok || httpError.StatusCode != http.StatusForbidden || httpError.Code != "capability_denied" {
		t.Fatalf("error = %#v", err)
	}
}

func TestClientNeverFollowsRedirectsFromLocalGateway(t *testing.T) {
	t.Parallel()

	var redirectTargetCalls atomic.Int32
	redirectTarget := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		redirectTargetCalls.Add(1)
		_, _ = io.WriteString(response, `{"status":"redirected"}`)
	}))
	defer redirectTarget.Close()
	gateway := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.Header().Set("Location", redirectTarget.URL)
		response.WriteHeader(http.StatusTemporaryRedirect)
	}))
	defer gateway.Close()

	tokenFile := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(tokenFile, []byte("sap_test"), 0o600); err != nil {
		t.Fatal(err)
	}
	client, err := New(ClientOptions{
		BaseURL:    gateway.URL,
		TokenFile:  tokenFile,
		HTTPClient: &http.Client{Timeout: time.Second},
	})
	if err != nil {
		t.Fatal(err)
	}
	err = client.Call(context.Background(), HistoryRead, Request{}, &map[string]any{})
	var httpError *HTTPError
	if !errors.As(err, &httpError) || httpError.StatusCode != http.StatusTemporaryRedirect {
		t.Fatalf("Call() error = %#v, want HTTP 307", err)
	}
	if redirectTargetCalls.Load() != 0 {
		t.Fatalf("redirect target calls = %d, want 0", redirectTargetCalls.Load())
	}
}

func TestClientRejectsOversizedResponsesWithoutSilentTruncation(t *testing.T) {
	t.Parallel()

	oversizedJSON := append(
		append([]byte(`{"value":"`), bytes.Repeat([]byte("x"), maximumJSONResponseBytes)...),
		[]byte(`"}`)...,
	)
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/internal/agent-api/history":
			response.Header().Set("Content-Type", "application/json")
			_, _ = response.Write(oversizedJSON)
		case "/internal/agent-api/attachments/attachment_test":
			response.Header().Set("Content-Type", "application/octet-stream")
			response.Header().Set("Content-Length", "52428801")
			response.WriteHeader(http.StatusOK)
		default:
			response.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()

	tokenFile := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(tokenFile, []byte("sap_test"), 0o600); err != nil {
		t.Fatal(err)
	}
	client, err := New(ClientOptions{BaseURL: server.URL, TokenFile: tokenFile})
	if err != nil {
		t.Fatal(err)
	}
	if err := client.Call(context.Background(), HistoryRead, Request{}, &map[string]any{}); !errors.Is(err, ErrResponseTooLarge) {
		t.Fatalf("JSON Call() error = %v, want ErrResponseTooLarge", err)
	}
	var output bytes.Buffer
	if err := client.Call(context.Background(), AttachmentDownload, Request{
		Path: map[string]string{"attachmentId": "attachment_test"},
	}, &output); !errors.Is(err, ErrResponseTooLarge) {
		t.Fatalf("binary Call() error = %v, want ErrResponseTooLarge", err)
	}
}

func TestClientStreamsAttachmentLargerThanJSONLimit(t *testing.T) {
	t.Parallel()
	const attachmentSize = maximumJSONResponseBytes + 1
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/internal/agent-api/attachments/attachment_test" {
			http.NotFound(response, request)
			return
		}
		response.Header().Set("Content-Type", "application/octet-stream")
		response.Header().Set("Content-Length", "16777217")
		_, _ = io.CopyN(response, zeroReader{}, attachmentSize)
	}))
	defer server.Close()

	client := newTestClient(t, server.URL)
	if err := client.Call(context.Background(), AttachmentDownload, Request{
		Path: map[string]string{"attachmentId": "attachment_test"},
	}, io.Discard); err != nil {
		t.Fatalf("AttachmentDownload() error = %v", err)
	}
}

type zeroReader struct{}

func (zeroReader) Read(buffer []byte) (int, error) {
	for index := range buffer {
		buffer[index] = 0
	}
	return len(buffer), nil
}

func TestClientValidatesSuccessfulJSONEvenWhenCallerDiscardsIt(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.Header().Set("Content-Type", "application/json")
		_, _ = response.Write([]byte(`[]`))
	}))
	defer server.Close()

	client := newTestClient(t, server.URL)
	if err := client.Call(context.Background(), ServerInfo, Request{}, nil); err == nil {
		t.Fatal("Call() error = nil, want non-object successful response rejection")
	}
}

func TestClientRejectsMissingRequiredFieldsForVelaResponses(t *testing.T) {
	t.Parallel()

	operations := []Operation{
		Events,
		HistoryRead,
		MessageSend,
		MessageResolve,
		MessageSearch,
		ChannelMembers,
		ChannelResolve,
		ServerInfo,
		TaskClaim,
		TaskList,
		TaskUpdateStatus,
		ReminderList,
		ReminderCreate,
		ReminderCancel,
		ReminderSnooze,
		ReminderUpdate,
		ReminderLog,
		AttachmentUpload,
	}

	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.Header().Set("Content-Type", "application/json")
		_, _ = response.Write([]byte("{}"))
	}))
	defer server.Close()
	client := newTestClient(t, server.URL)

	for _, operation := range operations {
		operation := operation
		t.Run(string(operation), func(t *testing.T) {
			err := client.Call(context.Background(), operation, Request{
				Path: map[string]string{
					"msgId":      "message_test",
					"reminderId": "reminder_test",
				},
			}, &map[string]any{})
			if err == nil {
				t.Fatal("Call() error = nil, want required response field rejection")
			}
		})
	}
}

func TestClientRejectsNonSentMessageResponse(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.Header().Set("Content-Type", "application/json")
		_, _ = response.Write([]byte(`{"ok":true,"state":"held","messageId":"message_test"}`))
	}))
	defer server.Close()

	client := newTestClient(t, server.URL)
	if err := client.Call(context.Background(), MessageSend, Request{}, &map[string]any{}); err == nil {
		t.Fatal("Call() error = nil, want Vela sent-state validation")
	}
}

func TestClientAcceptsMinimumVelaResponseShapes(t *testing.T) {
	t.Parallel()

	cases := map[Operation]string{
		Events:                `{"events":[]}`,
		HistoryRead:           `{"messages":[],"has_more":false,"has_older":false,"has_newer":false}`,
		MessageSend:           `{"ok":true,"state":"sent","messageId":"message_test"}`,
		MessageResolve:        `{"message":{}}`,
		MessageSearch:         `{"results":[],"hasMore":false}`,
		MessageReactionAdd:    `{"ok":true}`,
		MessageReactionRemove: `{"ok":true}`,
		ChannelMembers:        `{"channel":{},"agents":[],"humans":[]}`,
		ChannelResolve:        `{"channelId":"channel_test"}`,
		ServerInfo:            `{"runtimeContext":{"agentId":"agent_test","serverId":"server_test"},"channels":[],"agents":[],"humans":[]}`,
		TaskClaim:             `{"results":[]}`,
		TaskList:              `{"tasks":[]}`,
		TaskUpdateStatus:      `{"ok":true}`,
		ReminderList:          `{"reminders":[]}`,
		ReminderCreate:        `{"reminder":{}}`,
		ReminderCancel:        `{"reminder":{}}`,
		ReminderSnooze:        `{"reminder":{}}`,
		ReminderUpdate:        `{"reminder":{}}`,
		ReminderLog:           `{"events":[]}`,
		AttachmentUpload:      `{"id":"attachment_test","filename":"test.txt","sizeBytes":0}`,
		InboxCheck:            `{}`,
	}

	for operation, body := range cases {
		operation, body := operation, body
		t.Run(string(operation), func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
				response.Header().Set("Content-Type", "application/json")
				_, _ = response.Write([]byte(body))
			}))
			defer server.Close()

			client := newTestClient(t, server.URL)
			err := client.Call(context.Background(), operation, Request{
				Path: map[string]string{
					"msgId":      "message_test",
					"reminderId": "reminder_test",
				},
			}, &map[string]any{})
			if err != nil {
				t.Fatalf("Call() error = %v", err)
			}
		})
	}
}

func TestRemovedVelaRouteIsNotRegistered(t *testing.T) {
	t.Parallel()

	if _, ok := Lookup(Operation("migration.begin")); ok {
		t.Fatal("removed Vela migration route remains registered")
	}
	if _, ok := Match(http.MethodPost, BasePath+"/migrations"); ok {
		t.Fatal("removed Vela migration path remains matchable")
	}
}

func TestVelaRouteTableIsExact(t *testing.T) {
	t.Parallel()

	want := map[Operation]Route{
		Events:                {Method: http.MethodGet, Path: "/events", Capability: "read"},
		HistoryRead:           {Method: http.MethodGet, Path: "/history", Capability: "read"},
		MessageSend:           {Method: http.MethodPost, Path: "/send", Capability: "send"},
		MessageResolve:        {Method: http.MethodGet, Path: "/messages/:msgId/resolve", Capability: "read"},
		MessageSearch:         {Method: http.MethodGet, Path: "/search", Capability: "read"},
		MessageReactionAdd:    {Method: http.MethodPost, Path: "/messages/:msgId/reactions", Capability: "reactions"},
		MessageReactionRemove: {Method: http.MethodDelete, Path: "/messages/:msgId/reactions", Capability: "reactions"},
		ChannelMembers:        {Method: http.MethodGet, Path: "/channel-members", Capability: "channels"},
		ChannelResolve:        {Method: http.MethodPost, Path: "/resolve-channel", Capability: "send"},
		ServerInfo:            {Method: http.MethodGet, Path: "/server", Capability: "server"},
		TaskClaim:             {Method: http.MethodPost, Path: "/tasks/claim", Capability: "tasks"},
		TaskList:              {Method: http.MethodGet, Path: "/tasks", Capability: "tasks"},
		TaskUpdateStatus:      {Method: http.MethodPost, Path: "/tasks/update-status", Capability: "tasks"},
		ReminderList:          {Method: http.MethodGet, Path: "/reminders", Capability: "reminders"},
		ReminderCreate:        {Method: http.MethodPost, Path: "/reminders", Capability: "reminders"},
		ReminderCancel:        {Method: http.MethodDelete, Path: "/reminders/:reminderId", Capability: "reminders"},
		ReminderSnooze:        {Method: http.MethodPost, Path: "/reminders/:reminderId/snooze", Capability: "reminders"},
		ReminderUpdate:        {Method: http.MethodPatch, Path: "/reminders/:reminderId", Capability: "reminders"},
		ReminderLog:           {Method: http.MethodGet, Path: "/reminders/:reminderId/log", Capability: "reminders"},
		AttachmentUpload:      {Method: http.MethodPost, Path: "/upload", Capability: "attachments"},
		AttachmentDownload:    {Method: http.MethodGet, Path: "/attachments/:attachmentId", Capability: "attachments", Binary: true},
		InboxCheck:            {Method: http.MethodGet, Path: "/inbox", Capability: "read"},
	}
	if len(routes) != len(want) {
		t.Fatalf("route count = %d, want %d", len(routes), len(want))
	}
	for operation, expected := range want {
		actual, ok := routes[operation]
		if !ok || actual != expected {
			t.Fatalf("route %s = %#v, want %#v", operation, actual, expected)
		}
	}
}

func newTestClient(t *testing.T, baseURL string) *Client {
	t.Helper()
	tokenFile := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(tokenFile, []byte("sap_test"), 0o600); err != nil {
		t.Fatal(err)
	}
	client, err := New(ClientOptions{BaseURL: baseURL, TokenFile: tokenFile})
	if err != nil {
		t.Fatal(err)
	}
	return client
}
