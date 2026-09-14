package policy

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"sort"
	"testing"

	"hypernode/internal/store"
)

func TestPolicyAuthenticationAndDurableVMState(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "policy.js")
	source := `
		let calls = 0;
		globalThis.policy = {
			authenticateNone(c) { calls++; return {allow:true, stdout:"", stderr:"", exitCode:0}; },
			authenticate(c) { calls++; return {allow: secrets.verifyPassword(c.password), stdout:"", stderr:"", exitCode:0}; },
			onExec(c) { return {allow:true, stdout:String(calls), stdoutBytes:[1, 2], stderr:"", exitCode:0, stream:"test"}; },
			onStreamData(c) { return {allow:true, stdout:"data", stderr:"", exitCode:0}; },
			onStreamClose(c) { return {allow:true, stdout:"close", stderr:"", exitCode:0}; },
			onRequest(c) { return {allow:false, stdout:"", stderr:"", exitCode:1}; }
		};`
	if err := os.WriteFile(path, []byte(source), 0o600); err != nil {
		t.Fatal(err)
	}
	engine, err := New(path, "secret")
	if err != nil {
		t.Fatal(err)
	}
	allowed, err := engine.Authenticate(map[string]any{"password": "secret"})
	if err != nil || !allowed {
		t.Fatalf("allowed=%v err=%v", allowed, err)
	}
	decision, err := engine.Exec(map[string]any{"command": "pwd"})
	if err != nil || decision.Stdout != "1" {
		t.Fatalf("decision=%+v err=%v", decision, err)
	}
	if len(decision.StdoutBytes) != 2 || decision.StdoutBytes[0] != 1 || decision.StdoutBytes[1] != 2 {
		t.Fatalf("binary stdout was not exported: %+v", decision)
	}
	if decision.Stream != "test" {
		t.Fatalf("stream was not exported: %+v", decision)
	}
	allowed, err = engine.AuthenticateNone(map[string]any{"username": "codex"})
	if err != nil || !allowed {
		t.Fatalf("none auth allowed=%v err=%v", allowed, err)
	}
}

func TestPolicyStoreBridgeSharesStateAcrossEngines(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "policy.js")
	source := `
		globalThis.policy = {
			authenticateNone() { return {allow:true}; },
			authenticate() { return {allow:true}; },
			onExec(c) {
				const value = policyStore.getOrInsert("test", "identity", c.command);
				return {allow:true, stdout:value, stderr:"", exitCode:0};
			},
			onStreamData() { return {allow:true}; },
			onStreamClose() { return {allow:true}; },
			onRequest() { return {allow:false}; }
		};`
	if err := os.WriteFile(path, []byte(source), 0o600); err != nil {
		t.Fatal(err)
	}
	state := newMemoryStore()
	first, err := NewWithStore(path, "", state)
	if err != nil {
		t.Fatal(err)
	}
	defer first.Close()
	firstDecision, err := first.Exec(map[string]any{"command": "first"})
	if err != nil || firstDecision.Stdout != "first" {
		t.Fatalf("first decision=%+v err=%v", firstDecision, err)
	}
	second, err := NewWithStore(path, "", state)
	if err != nil {
		t.Fatal(err)
	}
	secondDecision, err := second.Exec(map[string]any{"command": "second"})
	if err != nil || secondDecision.Stdout != "first" {
		t.Fatalf("second decision=%+v err=%v", secondDecision, err)
	}
}

func TestDurableSQLiteBridgeAndCursor(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "policy.js")
	source := `
		globalThis.policy = {
			authenticateNone() { return {allow:true}; },
			authenticate() { return {allow:true}; },
			onExec(c) {
				durableStorage.sql.exec("CREATE TABLE IF NOT EXISTS do_values(id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
				if (c.command === "write") {
					durableStorage.sql.exec("DELETE FROM do_values");
					const inserted = durableStorage.sql.exec(
						"INSERT INTO do_values(value) VALUES (?), (?) RETURNING id, value",
						"alpha", "beta"
					);
					const names = inserted.columnNames.join(",");
					const first = inserted.next().value;
					const tail = inserted.raw().toArray();
					durableStorage.transactionSync(() => {
						policyStore.set("test", "transactional", "committed");
					});
					try {
						durableStorage.transactionSync(() => {
							durableStorage.sql.exec("INSERT INTO do_values(value) VALUES (?)", "rollback");
							policyStore.set("test", "transactional", "rolled-back");
							throw new Error("rollback");
						});
					} catch (_) {}
					const count = durableStorage.sql.exec("SELECT count(*) AS total FROM do_values").one().total;
					return {allow:true, stdout:[names, first.value, tail[0][1], count, policyStore.get("test", "transactional")].join("|"), exitCode:0};
				}
				const count = durableStorage.sql.exec("SELECT count(*) AS total FROM do_values").one().total;
				return {allow:true, stdout:String(count), exitCode:0};
			},
			onStreamData() { return {allow:true}; },
			onStreamClose() { return {allow:true}; },
			onRequest() { return {allow:false}; }
		};`
	if err := os.WriteFile(path, []byte(source), 0o600); err != nil {
		t.Fatal(err)
	}
	state, err := store.Open(filepath.Join(dir, "state.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer state.Close()
	first, err := NewWithStore(path, "", state)
	if err != nil {
		t.Fatal(err)
	}
	decision, err := first.Exec(map[string]any{"command": "write"})
	if err != nil || decision.Stdout != "id,value|alpha|beta|2|committed" {
		t.Fatalf("decision=%+v err=%v", decision, err)
	}
	second, err := NewWithStore(path, "", state)
	if err != nil {
		t.Fatal(err)
	}
	defer second.Close()
	decision, err = second.Exec(map[string]any{"command": "read"})
	if err != nil || decision.Stdout != "2" {
		t.Fatalf("persisted decision=%+v err=%v", decision, err)
	}
}

func TestDurableSQLiteCursorDoesNotExhaustQuickJSFunctionHandles(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "policy.js")
	// The former Go-backed cursor allocated five host callbacks per exec. Since
	// QuickJS stores callback magic in 16 bits, 7,000 cursor calls deterministically
	// crossed the limit and reproduced the production `Function not found` fault.
	source := `
		globalThis.policy = {
			authenticateNone() { return {allow:true}; },
			authenticate() { return {allow:true}; },
			onExec() {
				let total = 0;
				for (let index = 0; index < 7000; index++) {
					total += durableStorage.sql.exec("SELECT ? AS value", index).one().value;
				}
				return {allow:true, stdout:String(total), exitCode:0};
			},
			onStreamData() { return {allow:true}; },
			onStreamClose() { return {allow:true}; },
			onRequest() { return {allow:false}; }
		};`
	if err := os.WriteFile(path, []byte(source), 0o600); err != nil {
		t.Fatal(err)
	}
	state, err := store.Open(filepath.Join(dir, "state.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer state.Close()
	engine, err := NewWithStore(path, "", state)
	if err != nil {
		t.Fatal(err)
	}
	defer engine.Close()
	decision, err := engine.Exec(nil)
	if err != nil {
		t.Fatal(err)
	}
	if decision.Stdout != "24496500" {
		t.Fatalf("unexpected SQL cursor sum: %q", decision.Stdout)
	}
}

func TestDefaultPolicyHandlesCodexWrappedProbes(t *testing.T) {
	_, filename, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("could not locate policy test")
	}
	path := filepath.Join(filepath.Dir(filename), "..", "..", "policy", "default.js")
	engine, err := NewWithStoreConfig(path, "unused", newMemoryStore(), RuntimeConfig{
		AuthenticationMode: "bootstrap",
		UsersRoot:          t.TempDir(),
	})
	if err != nil {
		t.Fatal(err)
	}

	sentinel := []byte{0x12, 0x83, 0xaa, 0x97, 0x3e, 0x67, 0x31, 0x8b}
	prefix := `sh -c 'CODEX_REMOTE_PAYLOAD="$1"; printf "\022\203\252\227\076\147\061\213"; `
	tests := []struct {
		name       string
		command    string
		wantStdout string
	}{
		{name: "locate", command: prefix + `command -v codex'`, wantStdout: ""},
		{name: "version", command: prefix + `codex --version'`, wantStdout: "codex-cli 0.148.0-alpha.21\n"},
		{name: "boot", command: prefix + `codex -c features.code_mode_host=true app-server --listen unix://'`, wantStdout: ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			decision, err := engine.Exec(map[string]any{"command": tt.command})
			if err != nil {
				t.Fatal(err)
			}
			if decision.ExitCode != 0 || decision.Stdout != tt.wantStdout {
				t.Fatalf("decision=%+v", decision)
			}
			if !bytes.Equal(decision.StdoutBytes, sentinel) {
				t.Fatalf("stdoutBytes=%x want=%x", decision.StdoutBytes, sentinel)
			}
		})
	}

	proxy, err := engine.Exec(map[string]any{"sessionId": "proxy-test", "command": prefix + `codex app-server proxy'`})
	if err != nil || proxy.Stream != "codex-app-server-proxy" {
		t.Fatalf("proxy=%+v err=%v", proxy, err)
	}
	request := "GET /rpc HTTP/1.1\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n"
	handshake, err := engine.StreamData(map[string]any{
		"sessionId": "proxy-test", "stream": "codex-app-server-proxy", "dataBytes": []byte(request),
	})
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(handshake.StdoutBytes, []byte("Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=")) {
		t.Fatalf("unexpected handshake: %+v", handshake)
	}

	response, err := engine.StreamData(map[string]any{
		"sessionId": "proxy-test",
		"stream":    "codex-app-server-proxy",
		"dataBytes": maskedTextFrame(`{"id":"init","method":"initialize","params":{}}`),
	})
	if err != nil {
		t.Fatal(err)
	}
	responseText := serverTextFrame(t, response.StdoutBytes)
	if !bytes.Contains([]byte(responseText), []byte(`"id":"init"`)) ||
		!bytes.Contains([]byte(responseText), []byte(`"platformOs":"linux"`)) {
		t.Fatalf("unexpected initialize response: %q", responseText)
	}

	auth, err := engine.StreamData(map[string]any{
		"sessionId": "proxy-test",
		"stream":    "codex-app-server-proxy",
		"dataBytes": maskedTextFrame(`{"id":"auth","method":"getAuthStatus","params":{}}`),
	})
	if err != nil {
		t.Fatal(err)
	}
	authText := serverTextFrame(t, auth.StdoutBytes)
	if !bytes.Contains([]byte(authText), []byte(`"authMethod":"chatgpt"`)) ||
		!bytes.Contains([]byte(authText), []byte(`"requiresOpenaiAuth":true`)) {
		t.Fatalf("unexpected auth response: %q", authText)
	}

	rootText := streamRequest(t, engine, "proxy-test", `{"id":"root","method":"hypernode/rootThread/read","params":{}}`)
	var rootResponse struct {
		Result struct {
			Thread struct {
				ID string `json:"id"`
			} `json:"thread"`
		} `json:"result"`
	}
	if err := json.Unmarshal([]byte(rootText), &rootResponse); err != nil || rootResponse.Result.Thread.ID == "" {
		t.Fatalf("unexpected root thread response: %q err=%v", rootText, err)
	}
	threadID := rootResponse.Result.Thread.ID
	streamRequest(t, engine, "proxy-test", fmt.Sprintf(
		`{"id":"thread-read","method":"thread/read","params":{"threadId":%q,"includeTurns":true}}`,
		threadID,
	))
	shadowText := streamRequest(t, engine, "proxy-test", fmt.Sprintf(
		`{"id":"dsh-shadow","method":"hypernode/dshShadow/read","params":{"threadId":%q}}`,
		threadID,
	))
	if !bytes.Contains([]byte(shadowText), []byte(`"code":-32601`)) {
		t.Fatalf("disabled protocol audit endpoint unexpectedly remained available: %q", shadowText)
	}

	metadata := streamRequest(t, engine, "proxy-test", `{"id":"metadata","method":"fs/getMetadata","params":{"path":"/workspace"}}`)
	if !bytes.Contains([]byte(metadata), []byte(`"isDirectory":true`)) {
		t.Fatalf("unexpected metadata response: %q", metadata)
	}

	read := streamRequest(t, engine, "proxy-test", `{"id":"read","method":"fs/readFile","params":{"path":"/workspace/.codex/.tmp/bundled-marketplaces/openai-bundled/.materialization-key"}}`)
	wantBase64 := base64.StdEncoding.EncodeToString([]byte("hypernode-memory-v1\n"))
	if !bytes.Contains([]byte(read), []byte(wantBase64)) {
		t.Fatalf("unexpected read response: %q", read)
	}

	writeData := base64.StdEncoding.EncodeToString([]byte("hello VFS"))
	streamRequest(t, engine, "proxy-test", `{"id":"mkdir","method":"fs/createDirectory","params":{"path":"/workspace/project"}}`)
	streamRequest(t, engine, "proxy-test", `{"id":"write","method":"fs/writeFile","params":{"path":"/workspace/project/readme.txt","dataBase64":"`+writeData+`"}}`)
	fileMetadata := streamRequest(t, engine, "proxy-test", `{"id":"file-metadata","method":"fs/getMetadata","params":{"path":"/workspace/project/readme.txt"}}`)
	var fileMetadataResponse struct {
		Result map[string]any `json:"result"`
	}
	if err := json.Unmarshal([]byte(fileMetadata), &fileMetadataResponse); err != nil {
		t.Fatalf("decode file metadata response: %v", err)
	}
	wantMetadataKeys := []string{"createdAtMs", "isDirectory", "isFile", "isSymlink", "modifiedAtMs"}
	gotMetadataKeys := make([]string, 0, len(fileMetadataResponse.Result))
	for key := range fileMetadataResponse.Result {
		gotMetadataKeys = append(gotMetadataKeys, key)
	}
	sort.Strings(gotMetadataKeys)
	if !reflect.DeepEqual(gotMetadataKeys, wantMetadataKeys) {
		t.Fatalf("fs/getMetadata wire keys mismatch: got %v want %v; response=%q", gotMetadataKeys, wantMetadataKeys, fileMetadata)
	}
	directory := streamRequest(t, engine, "proxy-test", `{"id":"directory","method":"fs/readDirectory","params":{"path":"/workspace/project"}}`)
	if !bytes.Contains([]byte(directory), []byte(`"fileName":"readme.txt"`)) {
		t.Fatalf("unexpected directory response: %q", directory)
	}

	streamRequest(t, engine, "proxy-test", `{"id":"copy","method":"fs/copy","params":{"sourcePath":"/workspace/project/readme.txt","destinationPath":"/workspace/project/copy.txt"}}`)
	copied := streamRequest(t, engine, "proxy-test", `{"id":"copied","method":"fs/readFile","params":{"path":"/workspace/project/copy.txt"}}`)
	if !bytes.Contains([]byte(copied), []byte(writeData)) {
		t.Fatalf("unexpected copied file: %q", copied)
	}

	streamRequest(t, engine, "proxy-test", `{"id":"remove","method":"fs/remove","params":{"path":"/workspace/project"}}`)
	removed := streamRequest(t, engine, "proxy-test", `{"id":"removed","method":"fs/getMetadata","params":{"path":"/workspace/project"}}`)
	if !bytes.Contains([]byte(removed), []byte(`"code":"ENOENT"`)) {
		t.Fatalf("unexpected removed metadata response: %q", removed)
	}
}

func TestDefaultPolicyMultiplexesHTTPAndSSHInJavaScript(t *testing.T) {
	_, filename, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("could not locate policy test")
	}
	path := filepath.Join(filepath.Dir(filename), "..", "..", "policy", "default.js")
	usersRoot := t.TempDir()
	engine, err := NewWithStoreConfig(path, "unused", newMemoryStore(), RuntimeConfig{
		AuthenticationMode: "debug",
		UsersRoot:          usersRoot,
	})
	if err != nil {
		t.Fatal(err)
	}
	allowed, err := engine.AuthenticateNone(map[string]any{
		"connectionId": "dashboard-user", "username": "alice", "remoteAddr": "127.0.0.1:10000",
	})
	if err != nil || !allowed {
		t.Fatalf("register dashboard user: allowed=%v err=%v", allowed, err)
	}
	aliceCodexHome := filepath.Join(usersRoot, userHomeSegment("alice"), ".codex")
	if err := os.WriteFile(filepath.Join(aliceCodexHome, "auth.json"), []byte(
		`{"auth_mode":"chatgpt","tokens":{"account_id":"account-alice"}}`,
	), 0o600); err != nil {
		t.Fatal(err)
	}

	httpContext := map[string]any{"connectionId": "http-dashboard", "remoteAddr": "127.0.0.1:10001"}
	opened, err := engine.TCPOpen(httpContext)
	if err != nil || !opened.Allow || len(opened.StdoutBytes) != 0 {
		t.Fatalf("http open=%+v err=%v", opened, err)
	}
	httpResponse, err := engine.TCPData(map[string]any{
		"connectionId": "http-dashboard", "remoteAddr": "127.0.0.1:10001",
		"dataBytes": []byte("GET /healthz HTTP/1.1\r\nHost: hypernode\r\n\r\n"),
	})
	if err != nil || !httpResponse.Allow ||
		!bytes.Contains(httpResponse.StdoutBytes, []byte("HTTP/1.1 200 OK")) ||
		!bytes.Contains(httpResponse.StdoutBytes, []byte(`"transports":["ssh","http","websocket","model-gateway"]`)) ||
		!bytes.Contains(httpResponse.StdoutBytes, []byte(`"port":9988`)) {
		t.Fatalf("http response=%q err=%v", httpResponse.StdoutBytes, err)
	}
	_, _ = engine.TCPClose(httpContext)

	directWSContext := map[string]any{"connectionId": "direct-websocket", "remoteAddr": "127.0.0.1:10006"}
	if _, err := engine.TCPOpen(directWSContext); err != nil {
		t.Fatal(err)
	}
	directHandshake, err := engine.TCPData(map[string]any{
		"connectionId": "direct-websocket", "remoteAddr": "127.0.0.1:10006",
		"dataBytes": []byte("GET /rpc HTTP/1.1\r\nHost: hypernode\r\nX-HyperNode-User: alice\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nConnection: keep-alive, Upgrade\r\nUpgrade: websocket\r\n\r\n"),
	})
	if err != nil || !directHandshake.Allow ||
		!bytes.Contains(directHandshake.StdoutBytes, []byte("101 Switching Protocols")) ||
		!bytes.Contains(directHandshake.StdoutBytes, []byte("Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=")) {
		t.Fatalf("direct websocket handshake=%q err=%v", directHandshake.StdoutBytes, err)
	}
	directInitialize, err := engine.TCPData(map[string]any{
		"connectionId": "direct-websocket", "remoteAddr": "127.0.0.1:10006",
		"dataBytes": maskedTextFrame(`{"id":"direct-init","method":"initialize","params":{}}`),
	})
	if err != nil {
		t.Fatal(err)
	}
	directInitializeText := serverTextFrame(t, directInitialize.StdoutBytes)
	if !bytes.Contains([]byte(directInitializeText), []byte(`"id":"direct-init"`)) ||
		!bytes.Contains([]byte(directInitializeText), []byte(`"platformOs":"linux"`)) {
		t.Fatalf("unexpected direct websocket initialize response: %q", directInitializeText)
	}
	_, _ = engine.TCPClose(directWSContext)

	gatewayContext := map[string]any{"connectionId": "http-model-gateway", "remoteAddr": "127.0.0.1:10005"}
	if _, err := engine.TCPOpen(gatewayContext); err != nil {
		t.Fatal(err)
	}
	gatewayResponse, err := engine.TCPData(map[string]any{
		"connectionId": "http-model-gateway", "remoteAddr": "127.0.0.1:10005",
		"dataBytes": []byte("POST /providers/test/v1/responses HTTP/1.1\r\nHost: hypernode\r\nContent-Length: 2\r\n\r\n{}"),
	})
	if err != nil || !gatewayResponse.Allow ||
		!bytes.Contains(gatewayResponse.StdoutBytes, []byte("HTTP/1.1 401 Unauthorized")) ||
		!bytes.Contains(gatewayResponse.StdoutBytes, []byte("missing Authorization header")) {
		t.Fatalf("model gateway response=%q err=%v", gatewayResponse.StdoutBytes, err)
	}
	_, _ = engine.TCPClose(gatewayContext)

	dashboardContext := map[string]any{"connectionId": "http-dashboard-forms", "remoteAddr": "127.0.0.1:10003"}
	if _, err := engine.TCPOpen(dashboardContext); err != nil {
		t.Fatal(err)
	}
	dashboardResponse, err := engine.TCPData(map[string]any{
		"connectionId": "http-dashboard-forms", "remoteAddr": "127.0.0.1:10003",
		"dataBytes": []byte("GET /api/dashboard?username=alice HTTP/1.1\r\nHost: hypernode\r\n\r\n"),
	})
	if err != nil || !bytes.Contains(dashboardResponse.StdoutBytes, []byte(`"id":"execution-profile.select"`)) ||
		!bytes.Contains(dashboardResponse.StdoutBytes, []byte(`"value":"codex:subscription-`)) {
		t.Fatalf("dashboard forms response=%q err=%v", dashboardResponse.StdoutBytes, err)
	}
	_, _ = engine.TCPClose(dashboardContext)

	switchBody := `{"username":"alice","values":{"profile":"codex:default"}}`
	switchContext := map[string]any{"connectionId": "http-dashboard-switch", "remoteAddr": "127.0.0.1:10004"}
	if _, err := engine.TCPOpen(switchContext); err != nil {
		t.Fatal(err)
	}
	switchResponse, err := engine.TCPData(map[string]any{
		"connectionId": "http-dashboard-switch", "remoteAddr": "127.0.0.1:10004",
		"dataBytes": []byte(fmt.Sprintf(
			"POST /api/dashboard/actions/execution-profile.select HTTP/1.1\r\nHost: hypernode\r\nContent-Type: application/json\r\nContent-Length: %d\r\n\r\n%s",
			len(switchBody), switchBody,
		)),
	})
	if err != nil || !bytes.Contains(switchResponse.StdoutBytes, []byte("HTTP/1.1 200 OK")) ||
		!bytes.Contains(switchResponse.StdoutBytes, []byte(`"kind":"codex"`)) {
		t.Fatalf("dashboard switch response=%q err=%v", switchResponse.StdoutBytes, err)
	}
	_, _ = engine.TCPClose(switchContext)

	sshContext := map[string]any{"connectionId": "ssh-client", "remoteAddr": "127.0.0.1:10002"}
	opened, err = engine.TCPOpen(sshContext)
	if err != nil || !opened.Allow || len(opened.StdoutBytes) != 0 {
		t.Fatalf("ssh open=%+v err=%v", opened, err)
	}
	sshResponse, err := engine.TCPData(map[string]any{
		"connectionId": "ssh-client", "remoteAddr": "127.0.0.1:10002",
		"dataBytes": []byte("SSH-2.0-OpenSSH_9.9\r\n"),
	})
	if err != nil || !sshResponse.Allow || !bytes.Contains(sshResponse.StdoutBytes, []byte("SSH-2.0-Hypernode")) {
		t.Fatalf("ssh response=%q err=%v", sshResponse.StdoutBytes, err)
	}
	_, _ = engine.TCPClose(sshContext)
}

func TestDefaultPolicyStreamsLargeFileResponseAcrossBoundedPolls(t *testing.T) {
	root := t.TempDir()
	payload := bytes.Repeat([]byte("hypernode-stream-boundary\n"), (7*1024*1024)/26)
	if err := os.WriteFile(filepath.Join(root, "large.txt"), payload, 0o600); err != nil {
		t.Fatal(err)
	}
	_, filename, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("could not locate policy test")
	}
	path := filepath.Join(filepath.Dir(filename), "..", "..", "policy", "default.js")
	engine, err := NewWithStoreConfig(path, "unused", newMemoryStore(), RuntimeConfig{
		AuthenticationMode: "debug",
		LocalhostRoot:      root,
		UsersRoot:          t.TempDir(),
	})
	if err != nil {
		t.Fatal(err)
	}

	prefix := `sh -c 'CODEX_REMOTE_PAYLOAD="$1"; printf "\022\203\252\227\076\147\061\213"; `
	proxy, err := engine.Exec(map[string]any{"sessionId": "large-file", "command": prefix + `codex app-server proxy'`})
	if err != nil || proxy.Stream != "codex-app-server-proxy" {
		t.Fatalf("proxy=%+v err=%v", proxy, err)
	}
	handshake, err := engine.StreamData(map[string]any{
		"sessionId": "large-file", "stream": proxy.Stream,
		"dataBytes": []byte("GET /rpc HTTP/1.1\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n"),
	})
	if err != nil || !bytes.Contains(handshake.StdoutBytes, []byte("101 Switching Protocols")) {
		t.Fatalf("handshake=%+v err=%v", handshake, err)
	}

	decision, err := engine.StreamData(map[string]any{
		"sessionId": "large-file", "stream": proxy.Stream,
		"dataBytes": maskedTextFrame(`{"id":"large","method":"fs/readFile","params":{"path":"/localhost/large.txt"}}`),
	})
	if err != nil {
		t.Fatal(err)
	}
	wire := append([]byte(nil), decision.StdoutBytes...)
	if len(decision.StdoutBytes) > 512*1024 {
		t.Fatalf("first WebSocket drain exceeded bound: %d", len(decision.StdoutBytes))
	}
	for total, complete := serverFrameTotal(wire); !complete || len(wire) < total; total, complete = serverFrameTotal(wire) {
		decision, err = engine.StreamPoll(map[string]any{"sessionId": "large-file", "stream": proxy.Stream})
		if err != nil {
			t.Fatal(err)
		}
		if len(decision.StdoutBytes) == 0 {
			t.Fatal("large WebSocket response stalled before the frame completed")
		}
		if len(decision.StdoutBytes) > 512*1024 {
			t.Fatalf("WebSocket drain exceeded bound: %d", len(decision.StdoutBytes))
		}
		wire = append(wire, decision.StdoutBytes...)
	}

	responseText := serverTextFrame(t, wire)
	var response struct {
		ID     string `json:"id"`
		Result struct {
			DataBase64 string `json:"dataBase64"`
		} `json:"result"`
	}
	if err := json.Unmarshal([]byte(responseText), &response); err != nil {
		t.Fatal(err)
	}
	decoded, err := base64.StdEncoding.DecodeString(response.Result.DataBase64)
	if err != nil {
		t.Fatal(err)
	}
	if response.ID != "large" || !bytes.Equal(decoded, payload) {
		t.Fatalf("large file response mismatch: id=%q bytes=%d want=%d", response.ID, len(decoded), len(payload))
	}
}

func streamRequest(t *testing.T, engine *Engine, sessionID, message string) string {
	t.Helper()
	decision, err := engine.StreamData(map[string]any{
		"sessionId": sessionID,
		"stream":    "codex-app-server-proxy",
		"dataBytes": maskedTextFrame(message),
	})
	if err != nil {
		t.Fatal(err)
	}
	return serverTextFrame(t, decision.StdoutBytes)
}

func maskedTextFrame(text string) []byte {
	payload := []byte(text)
	mask := []byte{0x12, 0x34, 0x56, 0x78}
	frame := []byte{0x81}
	if len(payload) < 126 {
		frame = append(frame, 0x80|byte(len(payload)))
	} else {
		frame = append(frame, 0xfe, byte(len(payload)>>8), byte(len(payload)))
	}
	frame = append(frame, mask...)
	for index, value := range payload {
		frame = append(frame, value^mask[index%4])
	}
	return frame
}

func serverTextFrame(t *testing.T, frame []byte) string {
	t.Helper()
	if len(frame) < 2 || frame[0] != 0x81 || frame[1]&0x80 != 0 {
		t.Fatalf("invalid server WebSocket frame: %x", frame)
	}
	length := int(frame[1] & 0x7f)
	offset := 2
	if length == 126 {
		if len(frame) < 4 {
			t.Fatalf("truncated server WebSocket frame: %x", frame)
		}
		length = int(frame[2])<<8 | int(frame[3])
		offset = 4
	} else if length == 127 {
		if len(frame) < 10 {
			t.Fatalf("truncated server WebSocket frame: %x", frame)
		}
		if frame[2] != 0 || frame[3] != 0 || frame[4] != 0 || frame[5] != 0 {
			t.Fatalf("server WebSocket frame exceeds local test limits: %x", frame[:10])
		}
		length = int(frame[6])<<24 | int(frame[7])<<16 | int(frame[8])<<8 | int(frame[9])
		offset = 10
	}
	if len(frame) < offset+length {
		t.Fatalf("truncated payload: have=%d want=%d", len(frame)-offset, length)
	}
	return string(frame[offset : offset+length])
}

func serverFrameTotal(frame []byte) (int, bool) {
	if len(frame) < 2 {
		return 0, false
	}
	length := int(frame[1] & 0x7f)
	offset := 2
	if length == 126 {
		if len(frame) < 4 {
			return 0, false
		}
		length = int(frame[2])<<8 | int(frame[3])
		offset = 4
	} else if length == 127 {
		if len(frame) < 10 {
			return 0, false
		}
		if frame[2] != 0 || frame[3] != 0 || frame[4] != 0 || frame[5] != 0 {
			return 0, false
		}
		length = int(frame[6])<<24 | int(frame[7])<<16 | int(frame[8])<<8 | int(frame[9])
		offset = 10
	}
	return offset + length, true
}
