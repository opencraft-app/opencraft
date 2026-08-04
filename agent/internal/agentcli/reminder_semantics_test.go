package agentcli

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/QuantumNous/new-api/common"
)

func TestReminderCommandsUseObservedTypesAndPaths(t *testing.T) {
	t.Parallel()

	const reminderID = "11111111-1111-4111-8111-111111111111"
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		switch calls.Add(1) {
		case 1:
			var body struct {
				Title        string  `json:"title"`
				DelaySeconds float64 `json:"delaySeconds"`
				MessageID    string  `json:"msgId"`
				Repeat       string  `json:"repeat"`
				Timezone     string  `json:"tz"`
				Channel      string  `json:"channel"`
			}
			if err := common.DecodeJson(request.Body, &body); err != nil {
				t.Fatal(err)
			}
			if request.Method != http.MethodPost ||
				request.URL.Path != "/internal/agent-api/reminders" ||
				body.Title != "review deploy" ||
				body.DelaySeconds != 1800 ||
				body.MessageID != "message-1" ||
				body.Repeat != "every:1d" ||
				body.Timezone != "Asia/Shanghai" ||
				body.Channel != "#general" {
				t.Fatalf("schedule body = %#v", body)
			}
			_, _ = response.Write([]byte(`{"reminder":{"id":"` + reminderID + `"}}`))
		case 2:
			if request.Method != http.MethodGet ||
				request.URL.RequestURI() != "/internal/agent-api/reminders?all=true" {
				t.Fatalf("list request = %s %s", request.Method, request.URL.RequestURI())
			}
			_, _ = response.Write([]byte(`{"reminders":[]}`))
		case 3:
			var body struct {
				DelaySeconds float64 `json:"delaySeconds"`
			}
			if err := common.DecodeJson(request.Body, &body); err != nil {
				t.Fatal(err)
			}
			if request.URL.Path != "/internal/agent-api/reminders/"+reminderID+"/snooze" ||
				body.DelaySeconds != 7200 {
				t.Fatalf("snooze path/body = %s %#v", request.URL.Path, body)
			}
			_, _ = response.Write([]byte(`{"reminder":{"id":"` + reminderID + `"}}`))
		case 4:
			var body struct {
				Title string `json:"title"`
			}
			if err := common.DecodeJson(request.Body, &body); err != nil {
				t.Fatal(err)
			}
			if request.Method != http.MethodPatch ||
				request.URL.Path != "/internal/agent-api/reminders/"+reminderID ||
				body.Title != "new title" {
				t.Fatalf("update path/body = %s %#v", request.URL.Path, body)
			}
			_, _ = response.Write([]byte(`{"reminder":{"id":"` + reminderID + `"}}`))
		case 5:
			if request.Method != http.MethodGet ||
				request.URL.Path != "/internal/agent-api/reminders/"+reminderID+"/log" {
				t.Fatalf("log request = %s %s", request.Method, request.URL.Path)
			}
			_, _ = response.Write([]byte(`{"events":[]}`))
		case 6:
			if request.Method != http.MethodDelete ||
				request.URL.Path != "/internal/agent-api/reminders/"+reminderID {
				t.Fatalf("cancel request = %s %s", request.Method, request.URL.Path)
			}
			_, _ = response.Write([]byte(`{"reminder":{"id":"` + reminderID + `"}}`))
		default:
			t.Fatalf("unexpected reminder request %s %s", request.Method, request.URL.Path)
		}
	}))
	defer server.Close()

	app, _, stderr := newAgentCLITestApp(t, server.URL, nil)
	commands := [][]string{
		{
			"reminder", "schedule",
			"--title", "review deploy",
			"--delay-seconds", "1800",
			"--message-id", "message-1",
			"--repeat", "every:1d",
			"--tz", "Asia/Shanghai",
			"--channel", "#general",
		},
		{"reminder", "list", "--all"},
		{"reminder", "snooze", "--id", reminderID, "--by", "2h"},
		{"reminder", "update", "--id", reminderID, "--title", "new title"},
		{"reminder", "log", "--id", reminderID},
		{"reminder", "cancel", "--id", reminderID},
	}
	for _, command := range commands {
		if exitCode := app.Run(context.Background(), command); exitCode != 0 {
			t.Fatalf(
				"command %s exit code = %d, stderr = %q",
				strings.Join(command, " "),
				exitCode,
				stderr.String(),
			)
		}
	}
	if got := calls.Load(); got != int32(len(commands)) {
		t.Fatalf("calls = %d, want %d", got, len(commands))
	}
}

func TestReminderUpdateRejectsMultipleMutationsBeforeRequest(t *testing.T) {
	t.Parallel()

	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		response.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	app, _, stderr := newAgentCLITestApp(t, server.URL, nil)
	exitCode := app.Run(context.Background(), []string{
		"reminder", "update",
		"--id", "11111111-1111-4111-8111-111111111111",
		"--title", "new title",
		"--in", "30m",
	})
	if exitCode != 2 {
		t.Fatalf("exit code = %d, want 2; stderr = %q", exitCode, stderr.String())
	}
	if got := calls.Load(); got != 0 {
		t.Fatalf("requests = %d, want 0", got)
	}
}

func TestReminderShortIDResolvesAgainstExpectedStatusScope(t *testing.T) {
	t.Parallel()

	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		switch calls.Add(1) {
		case 1:
			if request.Method != http.MethodGet ||
				request.URL.RequestURI() != "/internal/agent-api/reminders?status=scheduled%2Cfired" {
				t.Fatalf("list request = %s %s", request.Method, request.URL.RequestURI())
			}
			_, _ = response.Write([]byte(`{
				"reminders":[
					{"reminderId":"abcd1234-0000-4000-8000-000000000000"}
				]
			}`))
		case 2:
			if request.Method != http.MethodDelete ||
				request.URL.Path != "/internal/agent-api/reminders/abcd1234-0000-4000-8000-000000000000" {
				t.Fatalf("cancel request = %s %s", request.Method, request.URL.Path)
			}
			_, _ = response.Write([]byte(`{
				"reminder":{"reminderId":"abcd1234-0000-4000-8000-000000000000"}
			}`))
		default:
			t.Fatalf("unexpected request %s %s", request.Method, request.URL.Path)
		}
	}))
	defer server.Close()

	app, _, stderr := newAgentCLITestApp(t, server.URL, nil)
	if exitCode := app.Run(context.Background(), []string{
		"reminder", "cancel", "--id", "abcd1234",
	}); exitCode != 0 {
		t.Fatalf("exit code = %d, stderr = %q", exitCode, stderr.String())
	}
}
