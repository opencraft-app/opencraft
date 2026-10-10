package instance

import (
	"bytes"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestReadChannelHistoryScriptKeepsProfilesAndToolsPrivate(t *testing.T) {
	python, err := exec.LookPath("python3")
	if err != nil {
		t.Skip("python3 unavailable")
	}
	home := t.TempDir()
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
	run := func(args ...string) channelHistoryPayload {
		t.Helper()
		command := exec.Command(python, append([]string{"-c", readChannelHistoryScript}, args...)...)
		command.Env = append(os.Environ(), "HERMES_HOME="+filepath.Clean(home))
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
	main := run("list", "main", "", "", "1", "")
	sales := run("list", "sales", "", "", "20", "")
	if string(main.Items) == string(sales.Items) || main.Error != "" || sales.Error != "" ||
		!bytes.Contains(sales.Items, []byte("sales-session")) ||
		bytes.Contains(sales.Items, []byte("main-session")) {
		t.Fatalf("profile lists were not isolated: main=%s sales=%s", main.Items, sales.Items)
	}
	if len(main.Sources) != 2 || main.Sources[0] != "feishu" || main.Sources[1] != "qqbot" {
		t.Fatalf("source list did not include older conversations: %+v", main.Sources)
	}
	invalidCursor := run("list", "sales", "", "missing-session", "20", "")
	if invalidCursor.Error != "invalid_cursor" {
		t.Fatalf("missing cursor was not rejected: %+v", invalidCursor)
	}
	foreign := run("messages", "sales", "", "", "30", "main-session")
	if !foreign.NotFound {
		t.Fatalf("foreign session was readable: %+v", foreign)
	}
	own := run("messages", "sales", "", "", "30", "sales-session")
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
}
