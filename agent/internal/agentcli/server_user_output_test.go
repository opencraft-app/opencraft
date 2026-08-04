package agentcli

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func TestVelaServerInfoRendersAuthoritativeDirectory(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/internal/agent-api/server" {
			t.Fatalf("path = %q", request.URL.Path)
		}
		_, _ = response.Write([]byte(`{
			"runtimeContext":{"agentId":"agent-self","serverId":"server-1"},
			"server":{"id":"server-1","slug":"team","name":"研发"},
			"channels":[
				{"id":"channel-general","name":"general","type":"channel","joined":true},
				{"id":"channel-private","name":"private-room","type":"private","joined":true}
			],
			"agents":[{"name":"builder","displayName":"Builder","status":"active","memberId":"member-agent","agentId":"agent-builder"}],
			"humans":[{"name":"alice","displayName":"Alice","memberId":"member-human","humanId":"human-alice"}]
		}`))
	}))
	defer server.Close()

	app, stdout, stderr := newAgentCLITestApp(t, server.URL, nil)
	if exitCode := app.Run(context.Background(), []string{"server", "info"}); exitCode != 0 {
		t.Fatalf("exit code = %d, stderr = %q", exitCode, stderr.String())
	}
	const want = "## Server Directory\n\nServer: 研发\nSlug: team\nID: server-1\n\n" +
		"### Channels\n- #general [public, joined] — channel-general\n" +
		"- #private-room [private, joined] — channel-private\n\n" +
		"### Agents\n- @builder — Builder [active] — agent agent-builder; member member-agent\n\n" +
		"### Humans\n- @alice — Alice — human human-alice; member member-human\n"
	if got := stdout.String(); got != want {
		t.Fatalf("stdout:\n%s\nwant:\n%s", got, want)
	}
	for _, unavailable := range []string{"--channels", "--full", "vela channel join", "Workspace", "Runtime"} {
		if strings.Contains(stdout.String(), unavailable) {
			t.Errorf("directory exposes removed surface %q", unavailable)
		}
	}
}

func TestUserInfoUsesOneDirectoryRequest(t *testing.T) {
	t.Parallel()
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		requests.Add(1)
		if request.URL.Path != "/internal/agent-api/server" {
			t.Fatalf("path = %q", request.URL.Path)
		}
		_, _ = response.Write([]byte(`{
			"runtimeContext":{"agentId":"agent-self","serverId":"server-1"},
			"server":{"id":"server-1","slug":"team","name":"研发"},
			"channels":[],
			"agents":[{"name":"builder","displayName":"Builder","status":"active","memberId":"member-agent","agentId":"agent-builder"}],
			"humans":[]
		}`))
	}))
	defer server.Close()

	app, stdout, stderr := newAgentCLITestApp(t, server.URL, nil)
	if exitCode := app.Run(context.Background(), []string{"user", "info", "@builder"}); exitCode != 0 {
		t.Fatalf("exit code = %d, stderr = %q", exitCode, stderr.String())
	}
	if requests.Load() != 1 {
		t.Fatalf("requests = %d, want 1", requests.Load())
	}
	for _, value := range []string{"User: @builder", "Kind: agent", "Display Name: Builder", "Agent ID: agent-builder", "Member ID: member-agent"} {
		if !strings.Contains(stdout.String(), value) {
			t.Fatalf("stdout lacks %q: %s", value, stdout.String())
		}
	}
}
