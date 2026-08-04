package agentcli

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/research/raft-computer-1.0.13/go-client/internal/agentapi"
)

func TestMessageSendReadsStdinAndUsesObservedBodyFields(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodPost ||
			request.URL.Path != "/internal/agent-api/send" {
			t.Fatalf("request = %s %s", request.Method, request.URL.Path)
		}
		var body struct {
			Target                string   `json:"target"`
			Content               string   `json:"content"`
			AttachmentIDs         []string `json:"attachmentIds"`
			DraftReholdCount      *float64 `json:"draftReholdCount"`
			DraftReplacedExisting *bool    `json:"draftReplacedExisting"`
		}
		if err := common.DecodeJson(request.Body, &body); err != nil {
			t.Fatal(err)
		}
		if body.Target != "#general" ||
			body.Content != "hello from stdin\n" ||
			strings.Join(body.AttachmentIDs, ",") != "attachment-1,attachment-2" ||
			body.DraftReholdCount != nil ||
			body.DraftReplacedExisting != nil {
			t.Fatalf("body = %#v", body)
		}
		_, _ = response.Write([]byte(`{"ok":true,"state":"sent","messageId":"message-1"}`))
	}))
	defer server.Close()

	app, stdout, stderr := newAgentCLITestApp(
		t,
		server.URL,
		strings.NewReader("hello from stdin\n"),
	)
	exitCode := app.Run(context.Background(), []string{
		"message", "send",
		"--target", "#general",
		"--attachment-id", "attachment-1",
		"--attachment-id", "attachment-2",
	})
	if exitCode != 0 {
		t.Fatalf("exit code = %d, stderr = %q", exitCode, stderr.String())
	}
	if stdout.String() != "Message sent to #general. Message ID: message-1 "+
		"(to reply in this message's thread, use target \"#general:message-\")\n" {
		t.Fatalf("stdout = %q", stdout.String())
	}
}

func TestMessageReadAndSearchUseObservedQueryNames(t *testing.T) {
	t.Parallel()

	requests := make(chan string, 2)
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		requests <- request.URL.RequestURI()
		switch request.URL.Path {
		case "/internal/agent-api/history":
			_, _ = response.Write([]byte(`{
				"messages":[],
				"has_more":false,
				"has_older":false,
				"has_newer":false
			}`))
		case "/internal/agent-api/search":
			_, _ = response.Write([]byte(`{"results":[],"hasMore":false}`))
		default:
			response.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()

	app, _, stderr := newAgentCLITestApp(t, server.URL, nil)
	if exitCode := app.Run(context.Background(), []string{
		"message", "read",
		"--target", "#general",
		"--after", "message-9",
		"--limit", "20",
	}); exitCode != 0 {
		t.Fatalf("read exit code = %d, stderr = %q", exitCode, stderr.String())
	}
	if exitCode := app.Run(context.Background(), []string{
		"message", "search",
		"--query", "incident",
		"--target", "#general",
		"--limit", "10",
		"--offset", "20",
	}); exitCode != 0 {
		t.Fatalf("search exit code = %d, stderr = %q", exitCode, stderr.String())
	}
	readURI := <-requests
	searchURI := <-requests
	if readURI != "/internal/agent-api/history?after=message-9&channel=%23general&limit=20" {
		t.Fatalf("read URI = %q", readURI)
	}
	if searchURI != "/internal/agent-api/search?channel=%23general&limit=10&offset=20&q=incident" {
		t.Fatalf("search URI = %q", searchURI)
	}
}

func TestMessageResolveAndRemoveReactionUsePathAndMethodSemantics(t *testing.T) {
	t.Parallel()

	requests := make(chan string, 2)
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		requests <- request.Method + " " + request.URL.Path
		if strings.HasSuffix(request.URL.Path, "/reactions") {
			var body map[string]string
			if err := common.DecodeJson(request.Body, &body); err != nil {
				t.Fatal(err)
			}
			if body["emoji"] != "👍" {
				t.Fatalf("reaction body = %#v", body)
			}
			_, _ = response.Write([]byte(`{"ok":true}`))
			return
		}
		_, _ = response.Write([]byte(`{"message":{"id":"message-1"}}`))
	}))
	defer server.Close()

	app, _, stderr := newAgentCLITestApp(t, server.URL, nil)
	if exitCode := app.Run(
		context.Background(),
		[]string{"message", "resolve", "message-1"},
	); exitCode != 0 {
		t.Fatalf("resolve exit code = %d, stderr = %q", exitCode, stderr.String())
	}
	if exitCode := app.Run(context.Background(), []string{
		"message", "react",
		"--message-id", "message-1",
		"--emoji", "👍",
		"--remove",
	}); exitCode != 0 {
		t.Fatalf("react exit code = %d, stderr = %q", exitCode, stderr.String())
	}
	if got := <-requests; got != "GET /internal/agent-api/messages/message-1/resolve" {
		t.Fatalf("resolve request = %q", got)
	}
	if got := <-requests; got != "DELETE /internal/agent-api/messages/message-1/reactions" {
		t.Fatalf("reaction request = %q", got)
	}
}

func TestLegacyMessageJSONReadIsRejectedBeforeIO(t *testing.T) {
	t.Parallel()

	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(
		response http.ResponseWriter,
		request *http.Request,
	) {
		calls.Add(1)
		response.WriteHeader(http.StatusTeapot)
	}))
	defer server.Close()

	app, _, stderr := newAgentCLITestApp(t, server.URL, nil)
	if exitCode := app.Run(context.Background(), []string{
		"message",
		"--json",
		`{"action":"read","msgId":"message-full-id"}`,
	}); exitCode != 2 {
		t.Fatalf("exit code = %d, want 2; stderr = %q", exitCode, stderr.String())
	}
	if calls.Load() != 0 {
		t.Fatalf("network calls = %d, want 0", calls.Load())
	}
}

func newAgentCLITestApp(
	t *testing.T,
	baseURL string,
	stdin *strings.Reader,
) (*App, *bytes.Buffer, *bytes.Buffer) {
	t.Helper()
	tokenFile := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(tokenFile, []byte("sap_test"), 0o600); err != nil {
		t.Fatal(err)
	}
	client, err := agentapi.New(agentapi.ClientOptions{
		BaseURL:   baseURL,
		TokenFile: tokenFile,
	})
	if err != nil {
		t.Fatal(err)
	}
	var inputReader *strings.Reader
	if stdin == nil {
		inputReader = strings.NewReader("")
	} else {
		inputReader = stdin
	}
	stdout := &bytes.Buffer{}
	stderr := &bytes.Buffer{}
	return New(Options{
		Client: client,
		Stdin:  inputReader,
		Stdout: stdout,
		Stderr: stderr,
	}), stdout, stderr
}
