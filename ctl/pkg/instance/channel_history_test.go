package instance

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	psandbox "ctl/pkg/adapter/sandbox"
	pctx "ctl/pkg/context"
	"ctl/pkg/errcode"
	modelinstance "ctl/pkg/model/instance"

	"go.uber.org/zap"
)

func TestReadChannelHistoryUsesOneRemoteCommand(t *testing.T) {
	adapter := &commandSandboxAdapterStub{ptyBatches: [][]psandbox.PtyExecStreamEvent{
		{{Type: "output", Chunk: `{"kind":"lightvela.channel-history.v1","items":[],"sources":[]}`}, {Type: "finished", Status: "SUCCESS"}},
		{{Type: "output", Chunk: `{"kind":"lightvela.channel-history.v1","error":"bot_not_found"}`}, {Type: "finished", Status: "SUCCESS"}},
	}}
	l := &logic{
		instanceDao: &commandInstanceDaoStub{getFunc: func(ctx pctx.Context, instanceID string) (*modelinstance.Entity, error) {
			if ctx.GetUserID() != "user-1" || instanceID != "ins-1" {
				return nil, errcode.ErrInstanceNotFound
			}
			return &modelinstance.Entity{InstanceId: instanceID, SandboxId: "sbx-1", Status: modelinstance.InstanceStatusRunning}, nil
		}},
		sandboxAdapter: adapter,
		logger:         zap.NewNop(),
	}
	ctx := pctx.NewContext(nil).WithUserID("user-1")
	if _, err := l.ListChannelSessions(ctx, "ins-1", "sales", "", "", 20); err != nil {
		t.Fatalf("list channel sessions: %v", err)
	}
	if len(adapter.ptyCalls) != 1 || adapter.ptyCalls[0].Username != "agentuser" {
		t.Fatalf("expected one agentuser TAT command, got %+v", adapter.ptyCalls)
	}
	if _, err := l.ListChannelMessages(ctx, "ins-1", "deleted", "session-1", "", 20); !errors.Is(err, errcode.ErrInstanceBotNotFound) {
		t.Fatalf("expected missing Bot, got %v", err)
	}
	if len(adapter.ptyCalls) != 2 {
		t.Fatalf("expected one TAT command per request, got %d for two requests", len(adapter.ptyCalls))
	}
	denied := pctx.NewContext(nil).WithUserID("another-user")
	if _, err := l.ListChannelSessions(denied, "ins-1", "sales", "", "", 20); !errors.Is(err, errcode.ErrInstanceNotFound) {
		t.Fatalf("expected instance ownership denial, got %v", err)
	}
	if len(adapter.ptyCalls) != 2 {
		t.Fatalf("ownership denial started TAT: %d calls", len(adapter.ptyCalls))
	}
}

func TestReadChannelHistoryScriptKeepsProfilesAndToolsPrivate(t *testing.T) {
	python, err := exec.LookPath("python3")
	if err != nil {
		t.Skip("python3 unavailable")
	}
	home := t.TempDir()
	modules := t.TempDir()
	if err := os.MkdirAll(filepath.Join(modules, "hermes_cli"), 0755); err != nil {
		t.Fatal(err)
	}
	for name, content := range map[string]string{
		"hermes_cli/__init__.py":   "",
		"hermes_cli/web_server.py": "app = object()\n",
		"httpx.py": `import json, os
class ASGITransport:
    def __init__(self, app): pass
class Response:
    def raise_for_status(self): pass
    def json(self): return {"profiles": json.loads(os.environ["HERMES_TEST_PROFILES"])}
class AsyncClient:
    def __init__(self, **kwargs): pass
    async def __aenter__(self): return self
    async def __aexit__(self, *args): pass
    async def get(self, *args, **kwargs): return Response()
`,
	} {
		if err := os.WriteFile(filepath.Join(modules, name), []byte(content), 0644); err != nil {
			t.Fatal(err)
		}
	}
	setup := `import sqlite3,sys
from pathlib import Path
root=Path(sys.argv[1])
for profile in ('main','sales'):
    folder=root if profile=='main' else root/'profiles'/profile
    folder.mkdir(parents=True,exist_ok=True)
    db=sqlite3.connect(folder/'state.db')
    db.executescript('CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT, session_key TEXT, started_at REAL, display_name TEXT, chat_type TEXT); CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, timestamp REAL, tool_calls TEXT, active INTEGER DEFAULT 1, compacted INTEGER DEFAULT 0, _compressed_summary INTEGER DEFAULT 0, display_kind TEXT, display_metadata TEXT);')
    db.execute('INSERT INTO sessions VALUES (?,?,?,?,?,?)',(profile+'-session','feishu','agent:main:feishu:group:test',100,'Project group','group'))
    db.execute('INSERT INTO messages (session_id,role,content,timestamp,tool_calls) VALUES (?,?,?,?,?)',(profile+'-session','user','hello '+profile,101,None))
    db.execute('INSERT INTO messages (session_id,role,content,timestamp,tool_calls) VALUES (?,?,?,?,?)',(profile+'-session','assistant','secret tool call',102,'[{"name":"secret"}]'))
    db.execute('INSERT INTO messages (session_id,role,content,timestamp,tool_calls) VALUES (?,?,?,?,?)',(profile+'-session','assistant','reply '+profile,103,None))
    db.execute('INSERT INTO messages (session_id,role,content,timestamp,tool_calls,active,compacted) VALUES (?,?,?,?,?,?,?)',(profile+'-session','user','archived '+profile,99,None,0,1))
    db.execute('INSERT INTO messages (session_id,role,content,timestamp,tool_calls,active) VALUES (?,?,?,?,?,?)',(profile+'-session','user','rewound '+profile,104,None,0))
    db.execute('INSERT INTO messages (session_id,role,content,timestamp,tool_calls,_compressed_summary) VALUES (?,?,?,?,?,?)',(profile+'-session','assistant','internal summary',105,None,1))
    db.execute('INSERT INTO messages (session_id,role,content,timestamp,tool_calls,display_metadata) VALUES (?,?,?,?,?,?)',(profile+'-session','user','model only',106,None,'{"model_only":true}'))
    db.execute('INSERT INTO messages (session_id,role,content,timestamp,tool_calls) VALUES (?,?,?,?,?)',(profile+'-session','user','\x00json:[{"type":"text","text":"image caption"},{"type":"image_url","image_url":{"url":"data:image/png;base64,AAA"}}]',107,None))
    db.execute('INSERT INTO sessions VALUES (?,?,?,?,?,?)',(profile+'-old','qqbot','agent:main:qqbot:private:test',1,'Old chat','private'))
    db.commit()
    db.close()
`
	command := exec.Command(python, "-c", setup, home)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("create fixture: %v: %s", err, output)
	}
	profiles := `[{"name":"default","is_default":true},{"name":"sales","is_default":false}]`
	runWithProfiles := func(profiles string, args ...string) channelHistoryPayload {
		t.Helper()
		command := exec.Command(python, append([]string{"-c", readChannelHistoryScript}, args...)...)
		command.Env = append(os.Environ(), "HERMES_HOME="+filepath.Clean(home), "PYTHONPATH="+modules, "HERMES_TEST_PROFILES="+profiles)
		output, err := command.CombinedOutput()
		if err != nil {
			t.Fatalf("query fixture: %v: %s", err, output)
		}
		var payload channelHistoryPayload
		if err := json.Unmarshal(output, &payload); err != nil {
			t.Fatalf("decode fixture: %v: %s", err, output)
		}
		return payload
	}
	run := func(args ...string) channelHistoryPayload {
		return runWithProfiles(profiles, args...)
	}
	main := run("list", "ins-1", "ins-1", "", "", "1", "")
	sales := run("list", "sales", "ins-1", "", "", "20", "")
	if string(main.Items) == string(sales.Items) || main.Error != "" || sales.Error != "" ||
		!bytes.Contains(sales.Items, []byte("sales-session")) ||
		bytes.Contains(sales.Items, []byte("main-session")) {
		t.Fatalf("profile lists were not isolated: main=%s sales=%s", main.Items, sales.Items)
	}
	if len(main.Sources) != 2 || main.Sources[0] != "feishu" || main.Sources[1] != "qqbot" {
		t.Fatalf("source list did not include older conversations: %+v", main.Sources)
	}
	invalidCursor := run("list", "sales", "ins-1", "", "missing-session", "20", "")
	if invalidCursor.Error != "invalid_cursor" {
		t.Fatalf("missing cursor was not rejected: %+v", invalidCursor)
	}
	foreign := run("messages", "sales", "ins-1", "", "", "30", "main-session")
	if !foreign.NotFound {
		t.Fatalf("foreign session was readable: %+v", foreign)
	}
	own := run("messages", "sales", "ins-1", "", "", "30", "sales-session")
	if string(own.Items) == "" || string(own.Items) == "null" ||
		bytes.Contains(own.Items, []byte("secret tool call")) ||
		bytes.Contains(own.Items, []byte("rewound sales")) ||
		bytes.Contains(own.Items, []byte("internal summary")) ||
		bytes.Contains(own.Items, []byte("model only")) ||
		bytes.Contains(own.Items, []byte("data:image")) ||
		!bytes.Contains(own.Items, []byte("archived sales")) ||
		!bytes.Contains(own.Items, []byte("image caption")) ||
		!bytes.Contains(own.Items, []byte("reply sales")) {
		t.Fatalf("unsafe message projection: %s", own.Items)
	}
	missingBot := runWithProfiles(`[{"name":"default","is_default":true}]`, "list", "sales", "ins-1", "", "", "20", "")
	if missingBot.Error != "bot_not_found" {
		t.Fatalf("deleted Bot still resolved: %+v", missingBot)
	}
	invalidProfile := runWithProfiles(`[{"name":"../main"}]`, "list", "../main", "ins-1", "", "", "20", "")
	if invalidProfile.Error != "invalid_profile" {
		t.Fatalf("unsafe Profile ID accepted: %+v", invalidProfile)
	}
	profileFailure := runWithProfiles(`invalid`, "list", "sales", "ins-1", "", "", "20", "")
	if profileFailure.Error != "profile_list_failed" {
		t.Fatalf("Profile API error lost: %+v", profileFailure)
	}
}
