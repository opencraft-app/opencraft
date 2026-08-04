package agentcli

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"velachat/agent/internal/common"
)

func TestTaskCommandsUseServerScopeAndTypedBodies(t *testing.T) {
	t.Parallel()

	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		switch calls.Add(1) {
		case 1:
			if request.Method != http.MethodGet ||
				request.URL.RequestURI() != "/internal/agent-api/tasks?channel=%23server&status=in_progress" {
				t.Fatalf("list request = %s %s", request.Method, request.URL.RequestURI())
			}
			_, _ = response.Write([]byte(`{"tasks":[]}`))
		case 2:
			var body struct {
				Channel     string   `json:"channel"`
				TaskNumbers []int    `json:"task_numbers"`
				MessageIDs  []string `json:"message_ids"`
			}
			if err := common.DecodeJson(request.Body, &body); err != nil {
				t.Fatal(err)
			}
			if request.URL.Path != "/internal/agent-api/tasks/claim" ||
				body.Channel != "#server" ||
				len(body.TaskNumbers) != 2 ||
				body.TaskNumbers[0] != 2 ||
				body.TaskNumbers[1] != 4 ||
				len(body.MessageIDs) != 0 {
				t.Fatalf("claim body = %#v", body)
			}
			_, _ = response.Write([]byte(`{"results":[]}`))
		case 3:
			var body struct {
				Channel    string `json:"channel"`
				TaskNumber int    `json:"task_number"`
				Status     string `json:"status"`
			}
			if err := common.DecodeJson(request.Body, &body); err != nil {
				t.Fatal(err)
			}
			if request.URL.Path != "/internal/agent-api/tasks/update-status" ||
				body.Channel != "#server" || body.TaskNumber != 4 || body.Status != "done" {
				t.Fatalf("update body = %#v", body)
			}
			_, _ = response.Write([]byte(`{"ok":true}`))
		default:
			t.Fatalf("unexpected request %s %s", request.Method, request.URL.Path)
		}
	}))
	defer server.Close()

	app, _, stderr := newAgentCLITestApp(t, server.URL, nil)
	commands := [][]string{
		{"task", "list", "--status", "in_progress"},
		{"task", "claim", "--number", "2", "--number", "4"},
		{"task", "update", "--number", "4", "--status", "done"},
	}
	for _, command := range commands {
		if exitCode := app.Run(context.Background(), command); exitCode != 0 {
			t.Fatalf("command %v exit code = %d, stderr = %q", command, exitCode, stderr.String())
		}
	}
	if got := calls.Load(); got != int32(len(commands)) {
		t.Fatalf("calls = %d, want %d", got, len(commands))
	}
}

func TestTaskClaimRejectsNonPositiveNumberBeforeRequest(t *testing.T) {
	t.Parallel()

	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		response.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	app, _, stderr := newAgentCLITestApp(t, server.URL, nil)
	exitCode := app.Run(context.Background(), []string{"task", "claim", "--number", "0"})
	if exitCode != 2 || !strings.Contains(stderr.String(), "positive integer") {
		t.Fatalf("exit code = %d, want 2; stderr = %q", exitCode, stderr.String())
	}
	if got := calls.Load(); got != 0 {
		t.Fatalf("requests = %d, want 0", got)
	}
}
