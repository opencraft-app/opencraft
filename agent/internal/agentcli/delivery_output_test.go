package agentcli

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"velachat/agent/internal/common"
)

func TestMessageCheckDrainsMultiplePagesAndFormatsMessages(t *testing.T) {
	t.Parallel()

	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(
		response http.ResponseWriter,
		request *http.Request,
	) {
		call := calls.Add(1)
		if request.URL.Path != "/internal/agent-api/events" {
			t.Fatalf("path = %q", request.URL.Path)
		}
		if got := request.URL.Query().Get("since"); got != "latest" {
			t.Fatalf("since = %q, want latest", got)
		}
		switch call {
		case 1:
			_, _ = response.Write([]byte(`{
				"events":[{
					"seq":9,
					"message_id":"message999999999",
					"channel_type":"channel",
					"channel_name":"general",
					"sender_type":"human",
					"sender_name":"alice",
					"content":"second"
				}],
				"last_seen_msgId":"message999999999",
				"last_seen_seq":9,
				"reply_target":null,
				"pending_notice_ids":[],
				"wake_reason":null,
				"has_more":true
			}`))
		case 2:
			_, _ = response.Write([]byte(`{
				"events":[{
					"seq":2,
					"message_id":"message222222222",
					"channel_type":"channel",
					"channel_name":"general",
					"sender_type":"agent",
					"sender_name":"builder",
					"sender_description":"Build agent",
					"content":"first",
					"attachments":[{
						"id":"attachment-1",
						"filename":"notes.txt"
					}],
					"task_status":"open",
					"task_number":7,
					"task_assignee_id":"agent-alice",
					"task_assignee_name":"alice"
				}],
				"last_seen_msgId":"message222222222",
				"last_seen_seq":2,
				"reply_target":null,
				"pending_notice_ids":[],
				"wake_reason":null,
				"has_more":false
			}`))
		default:
			t.Fatalf("unexpected events request %d", call)
		}
	}))
	defer server.Close()

	app, stdout, stderr := newAgentCLITestApp(t, server.URL, nil)
	if exitCode := app.Run(
		context.Background(),
		[]string{"message", "check"},
	); exitCode != 0 {
		t.Fatalf("exit code = %d, stderr = %q", exitCode, stderr.String())
	}
	const want = "[target=#general msg=message2 time=- type=agent] " +
		"@builder — Build agent: first " +
		"[1 attachment: notes.txt (id:attachment-1) — use vela attachment view to download] " +
		"[task #7 status=open assignee=@alice]\n" +
		"[target=#general msg=message9 time=- type=human] @alice: second\n" +
		"No more new messages.\n"
	if got := stdout.String(); got != want {
		t.Fatalf("stdout = %q, want %q", got, want)
	}
	if got := calls.Load(); got != 2 {
		t.Fatalf("events calls = %d, want 2", got)
	}
}

func TestMessageCheckReturnsPartialMessagesWhenLaterPageFails(t *testing.T) {
	t.Parallel()

	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(
		response http.ResponseWriter,
		_ *http.Request,
	) {
		switch calls.Add(1) {
		case 1:
			_, _ = response.Write([]byte(`{
				"events":[{
					"seq":3,
					"message_id":"abcdef0123456789",
					"channel_type":"dm",
					"channel_name":"alice",
					"sender_type":"human",
					"sender_name":"alice",
					"content":"keep this"
				}],
				"last_seen_msgId":"abcdef0123456789",
				"last_seen_seq":3,
				"reply_target":null,
				"pending_notice_ids":[],
				"wake_reason":null,
				"has_more":true
			}`))
		case 2:
			response.WriteHeader(http.StatusInternalServerError)
			_, _ = response.Write([]byte(`{"error":"temporary failure"}`))
		default:
			t.Fatal("unexpected request")
		}
	}))
	defer server.Close()

	app, stdout, stderr := newAgentCLITestApp(t, server.URL, nil)
	if exitCode := app.Run(
		context.Background(),
		[]string{"message", "check"},
	); exitCode != 0 {
		t.Fatalf(
			"exit code = %d, want partial success; stderr = %q",
			exitCode,
			stderr.String(),
		)
	}
	const want = "[target=dm:@alice msg=abcdef01 time=- type=human] " +
		"@alice: keep this\n" +
		"More messages are pending. Run `vela message check` again.\n"
	if got := stdout.String(); got != want {
		t.Fatalf("stdout = %q, want %q", got, want)
	}
}

func TestMessageCheckEmptyOutputDoesNotClaimItDrainedMessages(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(
		response http.ResponseWriter,
		_ *http.Request,
	) {
		_, _ = response.Write([]byte(`{
			"events":[],
			"last_seen_msgId":null,
			"last_seen_seq":null,
			"reply_target":null,
			"pending_notice_ids":[],
			"wake_reason":null,
			"has_more":false
		}`))
	}))
	defer server.Close()

	app, stdout, stderr := newAgentCLITestApp(t, server.URL, nil)
	if exitCode := app.Run(
		context.Background(),
		[]string{"message", "check"},
	); exitCode != 0 {
		t.Fatalf("exit code = %d, stderr = %q", exitCode, stderr.String())
	}
	if got, want := stdout.String(), "No new messages.\n"; got != want {
		t.Fatalf("stdout = %q, want %q", got, want)
	}
}

func TestMessageCheckStopsAfterFiftyDrainRounds(t *testing.T) {
	t.Parallel()

	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(
		response http.ResponseWriter,
		_ *http.Request,
	) {
		call := calls.Add(1)
		_, _ = fmt.Fprintf(response, `{
			"events":[{
				"seq":%d,
				"message_id":"%08d-message",
				"channel_type":"channel",
				"channel_name":"general",
				"sender_type":"human",
				"sender_name":"alice",
				"content":"page %d"
			}],
			"last_seen_msgId":"%08d-message",
			"last_seen_seq":%d,
			"reply_target":null,
			"pending_notice_ids":[],
			"wake_reason":null,
			"has_more":true
		}`, call, call, call, call, call)
	}))
	defer server.Close()

	app, stdout, stderr := newAgentCLITestApp(t, server.URL, nil)
	if exitCode := app.Run(
		context.Background(),
		[]string{"message", "check"},
	); exitCode != 0 {
		t.Fatalf("exit code = %d, stderr = %q", exitCode, stderr.String())
	}
	if got := calls.Load(); got != 50 {
		t.Fatalf("events calls = %d, want 50", got)
	}
	if got := stdout.String(); !strings.HasSuffix(
		got,
		"More messages are pending. Run `vela message check` again.\n",
	) {
		t.Fatalf("stdout suffix = %q", got)
	}
}

func TestMessageCheckRecordsMaximumConsumedSequencePerTarget(t *testing.T) {
	t.Setenv("VELA_AGENT_ID", "agent-consumed")
	stateRoot := t.TempDir()
	t.Setenv("VELA_CLI_CONSUMED_SEQ_STATE_DIR", stateRoot)

	server := httptest.NewServer(http.HandlerFunc(func(
		response http.ResponseWriter,
		_ *http.Request,
	) {
		_, _ = response.Write([]byte(`{
			"events":[{
				"seq":2,
				"message_id":"channel-low",
				"channel_type":"channel",
				"channel_name":"general"
			},{
				"seq":8,
				"message_id":"channel-high",
				"channel_type":"channel",
				"channel_name":"general"
			},{
				"seq":5,
				"message_id":"dm-high",
				"channel_type":"dm",
				"channel_name":"alice"
			}],
			"last_seen_msgId":"dm-high",
			"last_seen_seq":5,
			"reply_target":null,
			"pending_notice_ids":[],
			"wake_reason":null,
			"has_more":false
		}`))
	}))
	defer server.Close()

	app, _, stderr := newAgentCLITestApp(t, server.URL, nil)
	if exitCode := app.Run(
		context.Background(),
		[]string{"message", "check"},
	); exitCode != 0 {
		t.Fatalf("exit code = %d, stderr = %q", exitCode, stderr.String())
	}
	statePath := filepath.Join(
		stateRoot,
		"vela-cli-consumed-seq",
		"agent-consumed",
		"consumed-seqs.json",
	)
	raw, err := os.ReadFile(statePath)
	if err != nil {
		t.Fatal(err)
	}
	var consumed struct {
		Targets map[string]float64 `json:"targets"`
	}
	if err := common.Unmarshal(raw, &consumed); err != nil {
		t.Fatal(err)
	}
	if consumed.Targets["#general"] != 8 ||
		consumed.Targets["dm:@alice"] != 5 {
		t.Fatalf("consumed targets = %#v", consumed.Targets)
	}
	info, err := os.Stat(statePath)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("consumed state mode = %o, want 600", info.Mode().Perm())
	}
}

func TestConsumedSequenceFallbackStaysInsideVelaState(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("VELA_CLI_CONSUMED_SEQ_STATE_DIR", "")

	store, relative, ok := consumedSequenceStore("agent-consumed")
	if !ok {
		t.Fatal("consumedSequenceStore() rejected a safe Agent ID")
	}
	if got, want := store.Root(), filepath.Join(home, ".vela", "state"); got != want {
		t.Fatalf("store root = %q, want %q", got, want)
	}
	if got, want := relative, filepath.Join(
		"agents",
		"agent-consumed",
		"runtime",
		"vela-cli-consumed-seq.json",
	); got != want {
		t.Fatalf("relative path = %q, want %q", got, want)
	}
}

func TestInboxCheckFormatsManagedSnapshot(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(
		response http.ResponseWriter,
		request *http.Request,
	) {
		if request.URL.Path != "/internal/agent-api/inbox" {
			t.Fatalf("path = %q", request.URL.Path)
		}
		_, _ = response.Write([]byte(`{
			"rows":[{
				"target":"#general",
				"pendingCount":2,
				"firstPendingMsgId":"message111111111",
				"latestMsgId":"message222222222",
				"latestSenderName":"alice",
				"flags":["mention"]
			},{
				"target":"dm:@bob",
				"pendingCount":1,
				"latestSenderName":"bob",
				"flags":[]
			}]
		}`))
	}))
	defer server.Close()

	app, stdout, stderr := newAgentCLITestApp(t, server.URL, nil)
	if exitCode := app.Run(
		context.Background(),
		[]string{"inbox", "check"},
	); exitCode != 0 {
		t.Fatalf("exit code = %d, stderr = %q", exitCode, stderr.String())
	}
	const want = "Inbox: 2 pending targets\n\n" +
		"#general\n" +
		"pending: 2 messages · first msg=message111111111 · latest sender @alice · " +
		"latest msg=message222222222 · you were mentioned\n\n" +
		"dm:@bob\n" +
		"pending: 1 message · latest sender @bob\n"
	if got := stdout.String(); got != want {
		t.Fatalf("stdout = %q, want %q", got, want)
	}
}

func TestInboxCheckFormatsMissingRowsAsEmpty(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(
		response http.ResponseWriter,
		_ *http.Request,
	) {
		_, _ = response.Write([]byte(`{}`))
	}))
	defer server.Close()

	app, stdout, stderr := newAgentCLITestApp(t, server.URL, nil)
	if exitCode := app.Run(
		context.Background(),
		[]string{"inbox", "check"},
	); exitCode != 0 {
		t.Fatalf("exit code = %d, stderr = %q", exitCode, stderr.String())
	}
	if got, want := stdout.String(), "Inbox: empty\n"; got != want {
		t.Fatalf("stdout = %q, want %q", got, want)
	}
}

func TestShortIDKeepsCompleteTencentMessageReference(t *testing.T) {
	t.Parallel()

	const messageID = "144115249977133531-1785645385-69155770"
	if got := shortID(messageID); got != messageID {
		t.Fatalf("Tencent message reference = %q, want %q", got, messageID)
	}
}
