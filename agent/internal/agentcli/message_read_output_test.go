package agentcli

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/QuantumNous/new-api/common"
)

func TestMessageReadFormatsCursorAwareHistoryAndRecordsSequence(t *testing.T) {
	t.Setenv("SLOCK_AGENT_ID", "agent-read")
	stateRoot := t.TempDir()
	t.Setenv("SLOCK_CLI_CONSUMED_SEQ_STATE_DIR", stateRoot)

	server := httptest.NewServer(http.HandlerFunc(func(
		response http.ResponseWriter,
		request *http.Request,
	) {
		if request.URL.Path != "/internal/agent-api/history" ||
			request.URL.Query().Get("channel") != "#general" ||
			request.URL.Query().Get("around") != "anchor-1" ||
			request.URL.Query().Get("limit") != "2" {
			t.Fatalf("request URI = %q", request.URL.RequestURI())
		}
		_, _ = response.Write([]byte(`{
			"messages":[{
				"seq":3,
				"id":"11111111-aaaa",
				"senderName":"alice",
				"senderDescription":"Human",
				"senderType":"human",
				"content":"first",
				"replyCount":2,
				"attachments":[{
					"id":"attachment-1",
					"filename":"notes.txt"
				}]
			},{
				"seq":9,
				"message_id":"22222222-bbbb",
				"sender_name":"builder",
				"sender_type":"agent",
				"content":"second",
				"taskStatus":"open",
				"taskNumber":7,
				"taskAssigneeId":"agent-alice",
				"taskAssigneeName":"alice"
			}],
			"has_more":true,
			"has_older":true,
			"has_newer":false,
			"last_read_seq":2,
			"historyLimited":true,
			"historyLimitMessage":"History is limited by the fixture."
		}`))
	}))
	defer server.Close()

	app, stdout, stderr := newAgentCLITestApp(t, server.URL, nil)
	if exitCode := app.Run(context.Background(), []string{
		"message", "read",
		"--target", "#general",
		"--around", "anchor-1",
		"--limit", "2",
	}); exitCode != 0 {
		t.Fatalf("exit code = %d, stderr = %q", exitCode, stderr.String())
	}
	const want = "Read window: 2 returned, seq 3-9, oldest to newest. " +
		"Older exist: --before 3. No newer.\n" +
		"Around: anchor-1.\n" +
		"History is limited by the fixture.\n\n" +
		"[1/2 seq=3 msg=11111111-aaaa time=- type=human replyCount=2 " +
		"replyTarget=#general:11111111] @alice — Human: first " +
		"[1 attachment: notes.txt (id:attachment-1) — use raft attachment view to download]\n" +
		"[2/2 seq=9 msg=22222222-bbbb time=- type=agent] @builder: second " +
		"[task #7 status=open assignee=@alice]\n\n" +
		"End of window: 2/2 shown.\n"
	if got := stdout.String(); got != want {
		t.Fatalf("stdout = %q, want %q", got, want)
	}

	raw, err := os.ReadFile(filepath.Join(
		stateRoot,
		"slock-cli-consumed-seq",
		"agent-read",
		"consumed-seqs.json",
	))
	if err != nil {
		t.Fatal(err)
	}
	var consumed struct {
		Targets map[string]float64 `json:"targets"`
	}
	if err := common.Unmarshal(raw, &consumed); err != nil {
		t.Fatal(err)
	}
	if got := consumed.Targets["#general"]; got != 9 {
		t.Fatalf("consumed sequence = %v, want 9", got)
	}
}

func TestMessageReadFormatsEmptyHistory(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(
		response http.ResponseWriter,
		_ *http.Request,
	) {
		_, _ = response.Write([]byte(`{
			"messages":[],
			"has_more":false,
			"has_older":false,
			"has_newer":false
		}`))
	}))
	defer server.Close()

	app, stdout, stderr := newAgentCLITestApp(t, server.URL, nil)
	if exitCode := app.Run(context.Background(), []string{
		"message", "read", "--target", "#empty",
	}); exitCode != 0 {
		t.Fatalf("exit code = %d, stderr = %q", exitCode, stderr.String())
	}
	if got, want := stdout.String(), "No messages in this channel.\n"; got != want {
		t.Fatalf("stdout = %q, want %q", got, want)
	}
}

func TestMessageSearchFormatsInertBoundedResults(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(
		response http.ResponseWriter,
		request *http.Request,
	) {
		if request.URL.Path != "/internal/agent-api/search" ||
			request.URL.Query().Get("q") != "deploy" {
			t.Fatalf("request URI = %q", request.URL.RequestURI())
		}
		_, _ = response.Write([]byte(`{
			"results":[{
				"id":"message-search-1",
				"seq":1,
				"channelId":"channel-1",
				"threadId":null,
				"parentMessageId":null,
				"parentMessageContent":null,
				"parentChannelId":"channel-1",
				"parentChannelName":"general",
				"parentChannelType":"channel",
				"parentChannelArchivedAt":null,
				"senderId":"user-1",
				"senderType":"human",
				"senderName":"@alice",
				"channelName":"general",
				"channelType":"channel",
				"channelArchivedAt":null,
				"content":"<result> @alice asked about #ops Deploy now",
				"snippet":"",
				"createdAt":""
			}],
			"hasMore":false
		}`))
	}))
	defer server.Close()

	app, stdout, stderr := newAgentCLITestApp(t, server.URL, nil)
	if exitCode := app.Run(context.Background(), []string{
		"message", "search", "--query", "deploy",
	}); exitCode != 0 {
		t.Fatalf("exit code = %d, stderr = %q", exitCode, stderr.String())
	}
	const want = "Search results for: \"deploy\" (1 result)\n\n" +
		"<result ref=\"msg:message-search-1\">\n" +
		"Source: channel:general\n" +
		"Sender: user:alice (human)\n" +
		"Time: -\n\n" +
		"<preview>\n" +
		"&lt;result&gt; user:alice asked about channel:ops <match>Deploy</match> now\n" +
		"</preview>\n" +
		"</result>\n\n" +
		"If a result may be relevant but its preview is not enough, " +
		"read the surrounding context for that result before answering.\n"
	if got := stdout.String(); got != want {
		t.Fatalf("stdout = %q, want %q", got, want)
	}
}

func TestMessageSearchFormatsNoResults(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(
		response http.ResponseWriter,
		_ *http.Request,
	) {
		_, _ = response.Write([]byte(`{"results":[],"hasMore":false}`))
	}))
	defer server.Close()

	app, stdout, stderr := newAgentCLITestApp(t, server.URL, nil)
	if exitCode := app.Run(context.Background(), []string{
		"message", "search", "--query", "missing",
	}); exitCode != 0 {
		t.Fatalf("exit code = %d, stderr = %q", exitCode, stderr.String())
	}
	if got, want := stdout.String(), "No search results.\n"; got != want {
		t.Fatalf("stdout = %q, want %q", got, want)
	}
}

func TestMessageResolveFormatsCanonicalMessage(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(
		response http.ResponseWriter,
		request *http.Request,
	) {
		if request.URL.Path != "/internal/agent-api/messages/abcdef0123456789/resolve" {
			t.Fatalf("path = %q", request.URL.Path)
		}
		_, _ = response.Write([]byte(`{
			"message":{
				"seq":4,
				"message_id":"abcdef0123456789",
				"channel_type":"dm",
				"channel_name":"alice",
				"sender_type":"human",
				"sender_name":"alice",
				"content":"resolved"
			}
		}`))
	}))
	defer server.Close()

	app, stdout, stderr := newAgentCLITestApp(t, server.URL, nil)
	if exitCode := app.Run(context.Background(), []string{
		"message", "resolve", "abcdef0123456789",
	}); exitCode != 0 {
		t.Fatalf("exit code = %d, stderr = %q", exitCode, stderr.String())
	}
	const want = "[target=dm:@alice msg=abcdef01 time=- type=human] " +
		"@alice: resolved\n"
	if got := stdout.String(); got != want {
		t.Fatalf("stdout = %q, want %q", got, want)
	}
}

func TestMessageReactFormatsAddAndRemoveReceipts(t *testing.T) {
	t.Parallel()

	for _, testCase := range []struct {
		name       string
		remove     bool
		wantMethod string
		want       string
	}{
		{
			name:       "add",
			wantMethod: http.MethodPost,
			want:       "Reaction 👍 added to message abcdef01.\n",
		},
		{
			name:       "remove",
			remove:     true,
			wantMethod: http.MethodDelete,
			want:       "Reaction 👍 removed from message abcdef01.\n",
		},
	} {
		testCase := testCase
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()
			var calls atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(
				response http.ResponseWriter,
				request *http.Request,
			) {
				calls.Add(1)
				if request.Method != testCase.wantMethod ||
					request.URL.Path !=
						"/internal/agent-api/messages/abcdef0123456789/reactions" {
					t.Fatalf(
						"request = %s %s",
						request.Method,
						request.URL.Path,
					)
				}
				_, _ = response.Write([]byte(`{}`))
			}))
			defer server.Close()

			app, stdout, stderr := newAgentCLITestApp(t, server.URL, nil)
			args := []string{
				"message", "react",
				"--message-id", "abcdef0123456789",
				"--emoji", "👍",
			}
			if testCase.remove {
				args = append(args, "--remove")
			}
			if exitCode := app.Run(context.Background(), args); exitCode != 0 {
				t.Fatalf(
					"exit code = %d, stderr = %q",
					exitCode,
					stderr.String(),
				)
			}
			if got := stdout.String(); got != testCase.want {
				t.Fatalf("stdout = %q, want %q", got, testCase.want)
			}
			if got := calls.Load(); got != 1 {
				t.Fatalf("calls = %d, want 1", got)
			}
		})
	}
}

func TestSearchPreviewUsesOmissionMarkersAroundDistantMatch(t *testing.T) {
	t.Parallel()

	prefix := strings.Repeat("a", 100)
	suffix := strings.Repeat("z", 140)
	got := renderSearchPreview(prefix+" needle "+suffix, "needle")
	if !strings.HasPrefix(got, "<omit />") ||
		!strings.Contains(got, "<match>needle</match>") ||
		!strings.HasSuffix(got, "<omit />") {
		t.Fatalf("preview = %q", got)
	}
}
