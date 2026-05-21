package wrapper

import (
	"bufio"
	"context"
	"crypto/rand"
	"crypto/sha1"
	"database/sql"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestACPInitializeSessionPromptAndReplay(t *testing.T) {
	srv, _ := newTestServer(t, FakeWorker{OutputText: "hello from acp"})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	client := dialACPWS(t, "ws"+trimHTTPPrefix(ts.URL)+"/acp", map[string]string{"Authorization": "Bearer test-key"})
	defer client.close()

	client.writeJSON(t, map[string]any{
		"jsonrpc": "2.0",
		"id":      1,
		"method":  "initialize",
		"params": map[string]any{
			"protocolVersion":    1,
			"clientInfo":         map[string]any{"name": "mychat", "version": "0.1.0"},
			"clientCapabilities": map[string]any{},
		},
	})
	initResp := waitForRPCID(t, client, float64(1))
	initResult := initResp["result"].(map[string]any)
	agentCaps := initResult["agentCapabilities"].(map[string]any)
	if agentCaps["loadSession"] != true {
		t.Fatalf("unexpected capabilities: %#v", agentCaps)
	}

	client.writeJSON(t, map[string]any{
		"jsonrpc": "2.0",
		"id":      2,
		"method":  "session/new",
		"params":  map[string]any{"cwd": "/Users/skipzhang/code/mychat", "mcpServers": []any{}},
	})
	newResp := waitForRPCID(t, client, float64(2))
	newResult := newResp["result"].(map[string]any)
	sessionID := newResult["sessionId"].(string)
	if sessionID == "" {
		t.Fatalf("missing session id: %#v", newResult)
	}
	configOptions := newResult["configOptions"].([]any)
	if len(configOptions) == 0 {
		t.Fatalf("missing config options: %#v", newResult)
	}

	client.writeJSON(t, map[string]any{
		"jsonrpc": "2.0",
		"id":      3,
		"method":  "session/prompt",
		"params": map[string]any{
			"sessionId": sessionID,
			"prompt": []any{
				map[string]any{"type": "text", "text": "你好，请介绍一下自己"},
			},
		},
	})
	update := waitForMethod(t, client, "session/update")
	params := update["params"].(map[string]any)
	if params["sessionId"] != sessionID {
		t.Fatalf("unexpected update session id: %#v", params)
	}
	updateBody := params["update"].(map[string]any)
	if updateBody["sessionUpdate"] != "agent_message_chunk" {
		t.Fatalf("unexpected update body: %#v", updateBody)
	}
	promptResp := waitForRPCID(t, client, float64(3))
	promptResult := promptResp["result"].(map[string]any)
	if promptResult["stopReason"] != "end_turn" {
		t.Fatalf("unexpected prompt result: %#v", promptResult)
	}

	client.writeJSON(t, map[string]any{
		"jsonrpc": "2.0",
		"id":      4,
		"method":  "session/list",
		"params":  map[string]any{"cwd": "/Users/skipzhang/code/mychat"},
	})
	listResp := waitForRPCID(t, client, float64(4))
	sessions := listResp["result"].(map[string]any)["sessions"].([]any)
	if len(sessions) != 1 {
		t.Fatalf("unexpected sessions: %#v", sessions)
	}
	row := sessions[0].(map[string]any)
	if row["sessionId"] != sessionID {
		t.Fatalf("unexpected listed session: %#v", row)
	}

	client.writeJSON(t, map[string]any{
		"jsonrpc": "2.0",
		"id":      5,
		"method":  "session/load",
		"params": map[string]any{
			"sessionId":  sessionID,
			"cwd":        "/Users/skipzhang/code/mychat",
			"mcpServers": []any{},
		},
	})
	loadResp := waitForRPCID(t, client, float64(5))
	if loadResp["result"].(map[string]any)["sessionId"] != sessionID {
		t.Fatalf("unexpected load result: %#v", loadResp)
	}
	firstReplay := waitForMethod(t, client, "session/update")
	firstUpdate := firstReplay["params"].(map[string]any)["update"].(map[string]any)
	if firstUpdate["sessionUpdate"] != "user_message_chunk" {
		t.Fatalf("unexpected first replay update: %#v", firstUpdate)
	}
	secondReplay := waitForMethod(t, client, "session/update")
	secondUpdate := secondReplay["params"].(map[string]any)["update"].(map[string]any)
	if secondUpdate["sessionUpdate"] != "agent_message_chunk" {
		t.Fatalf("unexpected second replay update: %#v", secondUpdate)
	}
	assertReplayDone(t, client, sessionID)
	if got := countTableRows(t, srv.store.db, "turns"); got != 1 {
		t.Fatalf("expected canonical turn row, got %d", got)
	}
	if got := countTableRows(t, srv.store.db, "messages"); got != 2 {
		t.Fatalf("expected user and assistant message rows, got %d", got)
	}
	if got := countTableRows(t, srv.store.db, "message_blocks"); got != 2 {
		t.Fatalf("expected canonical user and assistant blocks, got %d", got)
	}
	if tableExists(t, srv.store.db, "session_events") {
		t.Fatalf("legacy session_events table should not be part of fresh canonical schema")
	}
}

func TestACPPromptStreamsThoughtAndToolUpdates(t *testing.T) {
	manager := &recordingACPRuntimeManager{
		events: []workerEvent{
			{EventID: "evt_reasoning", Sequence: 1, Kind: "reasoning_delta", Delta: "need terminal"},
			{EventID: "evt_tool_start", Sequence: 2, Kind: "tool_call", ToolCallID: "call_1", ToolName: "terminal", ToolStatus: "running", ToolRawInput: json.RawMessage(`{"command":"pwd"}`)},
			{EventID: "evt_tool_done", Sequence: 3, Kind: "tool_call_update", ToolCallID: "call_1", ToolName: "terminal", ToolStatus: "done", ToolRawOutput: json.RawMessage(`{"stdout":"/workspace\n","exit_code":0}`), ToolContent: `{"stdout":"/workspace\n","exit_code":0}`},
			{EventID: "evt_text", Sequence: 4, Kind: "output_text_delta", Delta: "done"},
		},
	}
	srv := newACPTestServerWithRuntime(t, manager)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	client := dialACPWS(t, "ws"+trimHTTPPrefix(ts.URL)+"/acp", map[string]string{"Authorization": "Bearer test-key"})
	defer client.close()

	client.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": map[string]any{}})
	waitForRPCID(t, client, float64(1))
	client.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 2, "method": "session/new", "params": map[string]any{"cwd": "/workspace"}})
	sessionID := waitForRPCID(t, client, float64(2))["result"].(map[string]any)["sessionId"].(string)
	client.writeJSON(t, map[string]any{
		"jsonrpc": "2.0",
		"id":      3,
		"method":  "session/prompt",
		"params": map[string]any{
			"sessionId": sessionID,
			"prompt":    []any{map[string]any{"type": "text", "text": "run pwd"}},
		},
	})

	thought := waitForMethod(t, client, "session/update")["params"].(map[string]any)["update"].(map[string]any)
	if thought["sessionUpdate"] != "agent_thought_chunk" || thought["content"].(map[string]any)["text"] != "need terminal" {
		t.Fatalf("unexpected thought update: %#v", thought)
	}
	toolStart := waitForMethod(t, client, "session/update")["params"].(map[string]any)["update"].(map[string]any)
	if toolStart["sessionUpdate"] != "tool_call" || toolStart["toolCallId"] != "call_1" || toolStart["status"] != "in_progress" {
		t.Fatalf("unexpected tool start update: %#v", toolStart)
	}
	if toolStart["rawInput"].(map[string]any)["command"] != "pwd" || toolStart["kind"] != "execute" {
		t.Fatalf("unexpected tool start detail: %#v", toolStart)
	}
	toolDone := waitForMethod(t, client, "session/update")["params"].(map[string]any)["update"].(map[string]any)
	if toolDone["sessionUpdate"] != "tool_call_update" || toolDone["toolCallId"] != "call_1" || toolDone["status"] != "completed" {
		t.Fatalf("unexpected tool done update: %#v", toolDone)
	}
	if toolDone["name"] != "terminal" {
		t.Fatalf("tool update should preserve provided name when present: %#v", toolDone)
	}
	if toolDone["rawOutput"].(map[string]any)["stdout"] != "/workspace\n" || len(toolDone["content"].([]any)) != 1 {
		t.Fatalf("unexpected tool done detail: %#v", toolDone)
	}
	text := waitForMethod(t, client, "session/update")["params"].(map[string]any)["update"].(map[string]any)
	if text["sessionUpdate"] != "agent_message_chunk" || text["content"].(map[string]any)["text"] != "done" {
		t.Fatalf("unexpected text update: %#v", text)
	}
	waitForRPCID(t, client, float64(3))
}

func TestACPReplayPreservesInterleavedAssistantBlocks(t *testing.T) {
	manager := &recordingACPRuntimeManager{
		events: []workerEvent{
			{EventID: "evt_text_1", Sequence: 1, Kind: "output_text_delta", Delta: "before "},
			{EventID: "evt_tool_start", Sequence: 2, Kind: "tool_call", ToolCallID: "call_1", ToolName: "terminal", ToolStatus: "running", ToolRawInput: json.RawMessage(`{"command":"pwd"}`)},
			{EventID: "evt_tool_done", Sequence: 3, Kind: "tool_call_update", ToolCallID: "call_1", ToolName: "terminal", ToolStatus: "done", ToolRawOutput: json.RawMessage(`{"stdout":"/workspace\n"}`)},
			{EventID: "evt_text_2", Sequence: 4, Kind: "output_text_delta", Delta: "after"},
		},
	}
	srv := newACPTestServerWithRuntime(t, manager)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	client := dialACPWS(t, "ws"+trimHTTPPrefix(ts.URL)+"/acp", map[string]string{"Authorization": "Bearer test-key"})
	defer client.close()
	client.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": map[string]any{}})
	waitForRPCID(t, client, float64(1))
	client.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 2, "method": "session/new", "params": map[string]any{"cwd": "/workspace"}})
	sessionID := waitForRPCID(t, client, float64(2))["result"].(map[string]any)["sessionId"].(string)
	client.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 3, "method": "session/prompt", "params": map[string]any{"sessionId": sessionID, "prompt": []any{map[string]any{"type": "text", "text": "interleave"}}}})
	for i := 0; i < 4; i++ {
		waitForMethod(t, client, "session/update")
	}
	waitForRPCID(t, client, float64(3))

	client.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 4, "method": "session/load", "params": map[string]any{"sessionId": sessionID}})
	waitForRPCID(t, client, float64(4))
	assertUpdateKind(t, client, "user_message_chunk")
	assertTextUpdate(t, client, "agent_message_chunk", "before ")
	assertUpdateKind(t, client, "tool_call_update")
	assertTextUpdate(t, client, "agent_message_chunk", "after")
	assertReplayDone(t, client, sessionID)
}

func TestACPFinalOutputTextPersistsWhenOnlyToolEventsStream(t *testing.T) {
	manager := &recordingACPRuntimeManager{
		events: []workerEvent{
			{EventID: "evt_tool_done", Sequence: 1, Kind: "tool_call_update", ToolCallID: "call_1", ToolName: "terminal", ToolStatus: "done", ToolRawOutput: json.RawMessage(`{"stdout":"ok\n"}`)},
		},
		resultText: "final answer",
	}
	srv := newACPTestServerWithRuntime(t, manager)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	client := dialACPWS(t, "ws"+trimHTTPPrefix(ts.URL)+"/acp", map[string]string{"Authorization": "Bearer test-key"})
	defer client.close()
	client.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": map[string]any{}})
	waitForRPCID(t, client, float64(1))
	client.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 2, "method": "session/new", "params": map[string]any{"cwd": "/workspace"}})
	sessionID := waitForRPCID(t, client, float64(2))["result"].(map[string]any)["sessionId"].(string)
	client.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 3, "method": "session/prompt", "params": map[string]any{"sessionId": sessionID, "prompt": []any{map[string]any{"type": "text", "text": "use tool"}}}})
	waitForMethod(t, client, "session/update")
	waitForRPCID(t, client, float64(3))

	client.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 4, "method": "session/load", "params": map[string]any{"sessionId": sessionID}})
	waitForRPCID(t, client, float64(4))
	assertUpdateKind(t, client, "user_message_chunk")
	assertUpdateKind(t, client, "tool_call_update")
	assertTextUpdate(t, client, "agent_message_chunk", "final answer")
	assertReplayDone(t, client, sessionID)
}

func TestACPPromptAcceptsWrapperFileResourceBlocks(t *testing.T) {
	manager := &recordingACPRuntimeManager{}
	store, err := NewStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	srv := NewServer(store, FakeWorker{OutputText: "unused"})
	srv.acpGate.runtimeManager = manager
	upload := uploadFile(t, srv, "tenant-a", "project-a", "TODO.md", []byte("# todo\n"))
	fileID := upload["id"].(string)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	client := dialACPWS(t, "ws"+trimHTTPPrefix(ts.URL)+"/acp", map[string]string{"X-Tenant-ID": "tenant-a", "X-Project-ID": "project-a"})
	defer client.close()
	client.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": map[string]any{}})
	waitForRPCID(t, client, float64(1))
	client.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 2, "method": "session/new", "params": map[string]any{"cwd": "/workspace"}})
	sessionID := waitForRPCID(t, client, float64(2))["result"].(map[string]any)["sessionId"].(string)
	client.writeJSON(t, map[string]any{
		"jsonrpc": "2.0",
		"id":      3,
		"method":  "session/prompt",
		"params": map[string]any{
			"sessionId": sessionID,
			"prompt": []any{
				map[string]any{"type": "text", "text": "summarize the attachment"},
				map[string]any{"type": "resource", "resource": map[string]any{
					"uri":          "wrapper-file://" + fileID,
					"mimeType":     "text/markdown",
					"name":         "TODO.md",
					"size":         float64(7),
					"relativePath": "docs/TODO.md",
				}},
			},
		},
	})
	waitForMethod(t, client, "session/update")
	waitForRPCID(t, client, float64(3))

	manager.mu.Lock()
	defer manager.mu.Unlock()
	if len(manager.prompts) != 1 {
		t.Fatalf("expected one prompt, got %#v", manager.prompts)
	}
	prompt := manager.prompts[0]
	if len(prompt.InputFiles) != 1 {
		t.Fatalf("expected resource file to be materialized, got %#v", prompt.InputFiles)
	}
	file := prompt.InputFiles[0]
	if file.FileID != fileID || file.WorkspacePath != "./inputs/docs/TODO.md" || file.ContentType != "text/markdown" {
		t.Fatalf("unexpected materialized file: %#v", file)
	}
	if !strings.Contains(prompt.Prompt, "./inputs/docs/TODO.md") || strings.Contains(prompt.Prompt, "# todo") {
		t.Fatalf("prompt should contain compact manifest without file body: %q", prompt.Prompt)
	}
}

func TestACPRestartedSessionsLoadReadOnlyAndRejectPrompt(t *testing.T) {
	root := t.TempDir()
	store, err := NewStore(root)
	if err != nil {
		t.Fatal(err)
	}
	manager := &recordingACPRuntimeManager{}
	srv := NewServer(store, FakeWorker{OutputText: "unused"})
	srv.acpGate.runtimeManager = manager
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	client := dialACPWS(t, "ws"+trimHTTPPrefix(ts.URL)+"/acp", map[string]string{"Authorization": "Bearer test-key"})
	client.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": map[string]any{}})
	waitForRPCID(t, client, float64(1))
	client.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 2, "method": "session/new", "params": map[string]any{"cwd": "/workspace"}})
	sessionID := waitForRPCID(t, client, float64(2))["result"].(map[string]any)["sessionId"].(string)
	sendACPPrompt(t, client, sessionID, 3, "remember durable state")
	client.close()
	if err := store.db.Close(); err != nil {
		t.Fatal(err)
	}

	restartedStore, err := NewStore(root)
	if err != nil {
		t.Fatal(err)
	}
	restarted := NewServer(restartedStore, FakeWorker{OutputText: "should not run"})
	restartedTS := httptest.NewServer(restarted.Handler())
	defer restartedTS.Close()
	restartedClient := dialACPWS(t, "ws"+trimHTTPPrefix(restartedTS.URL)+"/acp", map[string]string{"Authorization": "Bearer test-key"})
	defer restartedClient.close()
	restartedClient.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": map[string]any{}})
	waitForRPCID(t, restartedClient, float64(1))
	restartedClient.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 2, "method": "session/list", "params": map[string]any{}})
	listResp := waitForRPCID(t, restartedClient, float64(2))
	row := listResp["result"].(map[string]any)["sessions"].([]any)[0].(map[string]any)
	if row["sessionId"] != sessionID || row["readOnly"] != true || row["readOnlyReason"] != acpReadOnlyRuntimeNotRecovered {
		t.Fatalf("unexpected read-only list row: %#v", row)
	}

	restartedClient.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 3, "method": "session/load", "params": map[string]any{"sessionId": sessionID}})
	loadResp := waitForRPCID(t, restartedClient, float64(3))
	loadResult := loadResp["result"].(map[string]any)
	if loadResult["readOnly"] != true || loadResult["readOnlyReason"] != acpReadOnlyRuntimeNotRecovered {
		t.Fatalf("unexpected read-only load result: %#v", loadResult)
	}
	waitForMethod(t, restartedClient, "session/update")
	waitForMethod(t, restartedClient, "session/update")
	assertReplayDone(t, restartedClient, sessionID)

	restartedClient.writeJSON(t, map[string]any{
		"jsonrpc": "2.0",
		"id":      4,
		"method":  "session/prompt",
		"params":  map[string]any{"sessionId": sessionID, "prompt": []any{map[string]any{"type": "text", "text": "continue"}}},
	})
	promptResp := waitForRPCID(t, restartedClient, float64(4))
	errorObject := promptResp["error"].(map[string]any)
	if errorObject["code"] != float64(-32010) || errorObject["message"] != "session is read-only" {
		t.Fatalf("unexpected read-only error: %#v", errorObject)
	}
	data := errorObject["data"].(map[string]any)
	if data["error_code"] != "session_read_only" || data["read_only_reason"] != acpReadOnlyRuntimeNotRecovered {
		t.Fatalf("unexpected read-only error data: %#v", data)
	}
}

func TestACPPromptMaxIterationsReturnsStopReason(t *testing.T) {
	manager := &recordingACPRuntimeManager{promptErr: workerStop("max_iterations_exceeded", "Max iterations exceeded: 12", "max_turn_requests")}
	srv := newACPTestServerWithRuntime(t, manager)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	client := dialACPWS(t, "ws"+trimHTTPPrefix(ts.URL)+"/acp", map[string]string{"Authorization": "Bearer test-key"})
	defer client.close()

	client.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": map[string]any{}})
	waitForRPCID(t, client, float64(1))
	client.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 2, "method": "session/new", "params": map[string]any{"cwd": "/workspace"}})
	sessionID := waitForRPCID(t, client, float64(2))["result"].(map[string]any)["sessionId"].(string)
	client.writeJSON(t, map[string]any{
		"jsonrpc": "2.0",
		"id":      3,
		"method":  "session/prompt",
		"params":  map[string]any{"sessionId": sessionID, "prompt": []any{map[string]any{"type": "text", "text": "loop"}}},
	})
	resp := waitForRPCID(t, client, float64(3))
	if resp["error"] != nil {
		t.Fatalf("unexpected error response: %#v", resp)
	}
	if got := resp["result"].(map[string]any)["stopReason"]; got != "max_turn_requests" {
		t.Fatalf("expected max_turn_requests stopReason, got %#v", resp)
	}
}

func TestACPPromptRuntimeErrorUsesJSONRPCErrorData(t *testing.T) {
	manager := &recordingACPRuntimeManager{promptErr: workerError("agent_runtime_error", "sandbox unavailable")}
	srv := newACPTestServerWithRuntime(t, manager)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	client := dialACPWS(t, "ws"+trimHTTPPrefix(ts.URL)+"/acp", map[string]string{"Authorization": "Bearer test-key"})
	defer client.close()

	client.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": map[string]any{}})
	waitForRPCID(t, client, float64(1))
	client.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 2, "method": "session/new", "params": map[string]any{"cwd": "/workspace"}})
	sessionID := waitForRPCID(t, client, float64(2))["result"].(map[string]any)["sessionId"].(string)
	client.writeJSON(t, map[string]any{
		"jsonrpc": "2.0",
		"id":      3,
		"method":  "session/prompt",
		"params":  map[string]any{"sessionId": sessionID, "prompt": []any{map[string]any{"type": "text", "text": "fail"}}},
	})
	resp := waitForRPCID(t, client, float64(3))
	errorObject := resp["error"].(map[string]any)
	if errorObject["code"] != float64(-32000) || errorObject["message"] != "sandbox unavailable" {
		t.Fatalf("unexpected error object: %#v", errorObject)
	}
	data := errorObject["data"].(map[string]any)
	if data["code"] != "agent_runtime_error" {
		t.Fatalf("unexpected error data: %#v", data)
	}
}

func TestACPPromptPreflightRuntimeUnavailableReturnsACPError(t *testing.T) {
	manager := &recordingACPRuntimeManager{
		reattachErr: fmt.Errorf("ags http 404 op=run_command sandbox_id=outer_1 domain=ap-beijing.tencentags.com envd_port=49983: The requested resource does not exist"),
	}
	srv := newACPTestServerWithRuntime(t, manager)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	client := dialACPWS(t, "ws"+trimHTTPPrefix(ts.URL)+"/acp", map[string]string{"Authorization": "Bearer test-key"})
	defer client.close()

	client.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": map[string]any{}})
	waitForRPCID(t, client, float64(1))
	client.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 2, "method": "session/new", "params": map[string]any{"cwd": "/workspace"}})
	sessionID := waitForRPCID(t, client, float64(2))["result"].(map[string]any)["sessionId"].(string)
	client.writeJSON(t, map[string]any{
		"jsonrpc": "2.0",
		"id":      3,
		"method":  "session/prompt",
		"params":  map[string]any{"sessionId": sessionID, "prompt": []any{map[string]any{"type": "text", "text": "hello"}}},
	})
	resp := waitForRPCID(t, client, float64(3))
	errorObject := resp["error"].(map[string]any)
	if errorObject["code"] != float64(-32003) || errorObject["message"] != "session runtime is unavailable" {
		t.Fatalf("unexpected error object: %#v", errorObject)
	}
	data := errorObject["data"].(map[string]any)
	if data["error_code"] != "session_runtime_unavailable" || data["read_only_reason"] != acpReadOnlyRuntimeNotRecovered || data["retryable"] != false {
		t.Fatalf("unexpected error data: %#v", data)
	}
	if data["outer_sandbox_id"] != "outer_1" || !strings.Contains(data["detail"].(string), "ags http 404") {
		t.Fatalf("missing runtime diagnostics: %#v", data)
	}
	if got := len(manager.promptTexts()); got != 0 {
		t.Fatalf("preflight failure must not invoke prompt runtime, got %d prompts", got)
	}

	client.writeJSON(t, map[string]any{
		"jsonrpc": "2.0",
		"id":      4,
		"method":  "_cloudagent.session.status",
		"params":  map[string]any{"session_id": sessionID},
	})
	statusResp := waitForRPCID(t, client, float64(4))
	status := statusResp["result"].(map[string]any)
	if status["read_only"] != true || status["read_only_reason"] != acpReadOnlyRuntimeNotRecovered || status["closed"] != true {
		t.Fatalf("runtime-unavailable prompt must mark session read-only: %#v", status)
	}
	if !strings.Contains(status["last_runtime_error"].(string), "ags http 404") {
		t.Fatalf("status missing last runtime error: %#v", status)
	}
}

func TestACPPromptRecoversRunCommandAuthFailure(t *testing.T) {
	manager := &recordingACPRuntimeManager{
		promptErrs: []error{
			fmt.Errorf("acp prompt sidecar client session_id=session_1 generation=5 job_id=job_1 outer_sandbox_id=outer_1: ags http 401 op=run_command sandbox_id=outer_1 domain=ap-beijing.tencentags.com envd_port=49983: map[code:AUTHENTICATION_FAILED message:Authentication failed]"),
		},
	}
	srv := newACPTestServerWithRuntime(t, manager)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	client := dialACPWS(t, "ws"+trimHTTPPrefix(ts.URL)+"/acp", map[string]string{"Authorization": "Bearer test-key"})
	defer client.close()

	client.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": map[string]any{}})
	waitForRPCID(t, client, float64(1))
	client.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 2, "method": "session/new", "params": map[string]any{"cwd": "/workspace"}})
	sessionID := waitForRPCID(t, client, float64(2))["result"].(map[string]any)["sessionId"].(string)
	sendACPPrompt(t, client, sessionID, 3, "你好")

	if got := manager.startCount(); got != 2 {
		t.Fatalf("expected recovered runtime start, got %d starts", got)
	}
	if got := len(manager.promptTexts()); got != 2 {
		t.Fatalf("expected prompt retry after recover, got %d prompts", got)
	}
	if got := manager.closeCount(); got != 1 {
		t.Fatalf("expected stale runtime cleanup during recover, got %d closes", got)
	}
}

func TestRecoverablePromptRuntimeErrorClassification(t *testing.T) {
	tests := []struct {
		name string
		err  error
		want bool
	}{
		{
			name: "missing sandbox",
			err:  fmt.Errorf("ags http 404: The requested resource does not exist"),
			want: true,
		},
		{
			name: "run command auth failure",
			err:  fmt.Errorf("ags http 401 op=run_command sandbox_id=outer_1 domain=ap-beijing.tencentags.com envd_port=49983: map[code:AUTHENTICATION_FAILED message:Authentication failed]"),
			want: true,
		},
		{
			name: "create sandbox auth failure",
			err:  fmt.Errorf("ags http 401 op=create_sandbox domain=ap-beijing.tencentags.com: map[code:AUTHENTICATION_FAILED message:Authentication failed]"),
			want: false,
		},
		{
			name: "unrelated runtime failure",
			err:  fmt.Errorf("sandbox unavailable"),
			want: false,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := isRecoverablePromptRuntimeError(tt.err); got != tt.want {
				t.Fatalf("isRecoverablePromptRuntimeError() = %t, want %t", got, tt.want)
			}
		})
	}
}

func TestACPSessionCloseAndDeleteLifecycle(t *testing.T) {
	srv, _ := newTestServer(t, FakeWorker{OutputText: "hello from acp"})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	client := dialACPWS(t, "ws"+trimHTTPPrefix(ts.URL)+"/acp", map[string]string{"Authorization": "Bearer test-key"})
	defer client.close()

	client.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": map[string]any{}})
	initResp := waitForRPCID(t, client, float64(1))
	sessionCaps := initResp["result"].(map[string]any)["agentCapabilities"].(map[string]any)["sessionCapabilities"].(map[string]any)
	if _, ok := sessionCaps["close"]; !ok {
		t.Fatalf("missing close capability: %#v", sessionCaps)
	}
	if _, ok := sessionCaps["delete"]; !ok {
		t.Fatalf("missing delete capability: %#v", sessionCaps)
	}

	client.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 2, "method": "session/new", "params": map[string]any{"cwd": "/workspace", "mcpServers": []any{}}})
	newResp := waitForRPCID(t, client, float64(2))
	sessionID := newResp["result"].(map[string]any)["sessionId"].(string)

	client.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 3, "method": "session/close", "params": map[string]any{"sessionId": sessionID}})
	closeResp := waitForRPCID(t, client, float64(3))
	if _, ok := closeResp["result"].(map[string]any); !ok {
		t.Fatalf("unexpected close response: %#v", closeResp)
	}

	client.writeJSON(t, map[string]any{
		"jsonrpc": "2.0",
		"id":      4,
		"method":  "session/prompt",
		"params": map[string]any{
			"sessionId": sessionID,
			"prompt":    []any{map[string]any{"type": "text", "text": "still there?"}},
		},
	})
	promptErr := waitForRPCID(t, client, float64(4))
	if _, ok := promptErr["error"].(map[string]any); !ok {
		t.Fatalf("expected prompt error after close: %#v", promptErr)
	}

	client.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 5, "method": "session/resume", "params": map[string]any{"sessionId": sessionID, "cwd": "/workspace"}})
	resumeResp := waitForRPCID(t, client, float64(5))
	if resumeResp["result"].(map[string]any)["sessionId"] != sessionID {
		t.Fatalf("unexpected resume response: %#v", resumeResp)
	}

	client.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 6, "method": "session/delete", "params": map[string]any{"sessionId": sessionID}})
	deleteResp := waitForRPCID(t, client, float64(6))
	if _, ok := deleteResp["result"].(map[string]any); !ok {
		t.Fatalf("unexpected delete response: %#v", deleteResp)
	}

	client.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 7, "method": "session/list", "params": map[string]any{}})
	listResp := waitForRPCID(t, client, float64(7))
	sessions := listResp["result"].(map[string]any)["sessions"].([]any)
	if len(sessions) != 0 {
		t.Fatalf("expected deleted session to disappear from list: %#v", sessions)
	}

	client.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 8, "method": "session/delete", "params": map[string]any{"sessionId": sessionID}})
	idempotentResp := waitForRPCID(t, client, float64(8))
	if _, ok := idempotentResp["result"].(map[string]any); !ok {
		t.Fatalf("unexpected idempotent delete response: %#v", idempotentResp)
	}
}

func TestACPConfigOptionUpdate(t *testing.T) {
	srv, _ := newTestServer(t, FakeWorker{OutputText: "ok"})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	client := dialACPWS(t, "ws"+trimHTTPPrefix(ts.URL)+"/acp", map[string]string{"Authorization": "Bearer test-key"})
	defer client.close()

	client.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": map[string]any{}})
	waitForRPCID(t, client, float64(1))
	client.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 2, "method": "session/new", "params": map[string]any{"cwd": "/workspace", "mcpServers": []any{}}})
	newResp := waitForRPCID(t, client, float64(2))
	result := newResp["result"].(map[string]any)
	sessionID := result["sessionId"].(string)
	configID := result["configOptions"].([]any)[0].(map[string]any)["id"].(string)

	client.writeJSON(t, map[string]any{
		"jsonrpc": "2.0",
		"id":      3,
		"method":  "session/set_config_option",
		"params": map[string]any{
			"sessionId": sessionID,
			"configId":  configID,
			"value":     "agent-sidecar-tool",
		},
	})
	update := waitForMethod(t, client, "session/update")
	updateBody := update["params"].(map[string]any)["update"].(map[string]any)
	if updateBody["sessionUpdate"] != "config_option_update" {
		t.Fatalf("unexpected config update: %#v", updateBody)
	}
	resp := waitForRPCID(t, client, float64(3))
	nextOptions := resp["result"].(map[string]any)["configOptions"].([]any)
	if nextOptions[0].(map[string]any)["currentValue"] != "agent-sidecar-tool" {
		t.Fatalf("unexpected config result: %#v", resp)
	}
}

func TestACPSessionRuntimeStartsOnNewAndPromptsAreIncremental(t *testing.T) {
	manager := &recordingACPRuntimeManager{}
	srv := newACPTestServerWithRuntime(t, manager)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	client := dialACPWS(t, "ws"+trimHTTPPrefix(ts.URL)+"/acp", map[string]string{"Authorization": "Bearer test-key"})
	defer client.close()
	client.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": map[string]any{}})
	waitForRPCID(t, client, float64(1))
	client.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 2, "method": "session/new", "params": map[string]any{"cwd": "/workspace"}})
	newResp := waitForRPCID(t, client, float64(2))
	sessionID := newResp["result"].(map[string]any)["sessionId"].(string)
	if manager.startCount() != 1 {
		t.Fatalf("expected runtime start on session/new, got %d", manager.startCount())
	}

	sendACPPrompt(t, client, sessionID, 3, "first")
	sendACPPrompt(t, client, sessionID, 4, "second")
	prompts := manager.promptTexts()
	if len(prompts) != 2 || prompts[0] != "first" || prompts[1] != "second" {
		t.Fatalf("expected incremental prompts only, got %#v", prompts)
	}
}

func TestACPRuntimeCWDIsAlwaysSandboxWorkspace(t *testing.T) {
	manager := &recordingACPRuntimeManager{}
	srv := newACPTestServerWithRuntime(t, manager)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	client := dialACPWS(t, "ws"+trimHTTPPrefix(ts.URL)+"/acp", map[string]string{"Authorization": "Bearer test-key"})
	defer client.close()
	client.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": map[string]any{}})
	waitForRPCID(t, client, float64(1))
	client.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 2, "method": "session/new", "params": map[string]any{"cwd": "/Users/skipzhang/code/mychat"}})
	newResp := waitForRPCID(t, client, float64(2))
	sessionID := newResp["result"].(map[string]any)["sessionId"].(string)

	if got := manager.startCWDs(); len(got) != 1 || got[0] != sidecarRequestCWD() {
		t.Fatalf("runtime start cwd must be sandbox-only, got %#v", got)
	}

	client.writeJSON(t, map[string]any{
		"jsonrpc": "2.0",
		"id":      3,
		"method":  "session/prompt",
		"params": map[string]any{
			"sessionId": sessionID,
			"cwd":       "/Users/skipzhang/other-client-path",
			"prompt":    []any{map[string]any{"type": "text", "text": "cwd?"}},
		},
	})
	waitForMethod(t, client, "session/update")
	waitForRPCID(t, client, float64(3))

	if got := manager.promptCWDs(); len(got) != 1 || got[0] != sidecarRequestCWD() {
		t.Fatalf("runtime prompt cwd must be sandbox-only, got %#v", got)
	}

	client.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 4, "method": "session/list", "params": map[string]any{"cwd": "/Users/skipzhang/code/mychat"}})
	listResp := waitForRPCID(t, client, float64(4))
	sessions := listResp["result"].(map[string]any)["sessions"].([]any)
	if got := sessions[0].(map[string]any)["cwd"]; got != acpRuntimeCWD {
		t.Fatalf("listed cwd must stay sandbox-only, got %#v", got)
	}
}

func TestACPSessionNewPassesCloudAgentSandboxBackendMeta(t *testing.T) {
	manager := &recordingACPRuntimeManager{}
	srv := newACPTestServerWithRuntime(t, manager)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	client := dialACPWS(t, "ws"+trimHTTPPrefix(ts.URL)+"/acp", map[string]string{"Authorization": "Bearer test-key"})
	defer client.close()
	client.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": map[string]any{}})
	waitForRPCID(t, client, float64(1))
	client.writeJSON(t, map[string]any{
		"jsonrpc": "2.0",
		"id":      2,
		"method":  "session/new",
		"params": map[string]any{
			"cwd": "/workspace",
			"_meta": map[string]any{
				"cloudagent": map[string]any{
					"sandbox_backend":     "talos",
					"sandbox_template_id": "498c6c11-74d7-426e-bdb1-13d8aa73997e",
				},
			},
		},
	})
	waitForRPCID(t, client, float64(2))

	if got := manager.startBackends(); len(got) != 1 || got[0] != "talos" {
		t.Fatalf("runtime start sandbox backend = %#v, want [talos]", got)
	}
	if got := manager.startTemplateIDs(); len(got) != 1 || got[0] != "498c6c11-74d7-426e-bdb1-13d8aa73997e" {
		t.Fatalf("runtime start sandbox template = %#v, want [498c6c11-74d7-426e-bdb1-13d8aa73997e]", got)
	}
}

func TestACPLoadDoesNotResumeRuntime(t *testing.T) {
	manager := &recordingACPRuntimeManager{}
	srv := newACPTestServerWithRuntime(t, manager)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	client := dialACPWS(t, "ws"+trimHTTPPrefix(ts.URL)+"/acp", map[string]string{"Authorization": "Bearer test-key"})
	defer client.close()
	client.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": map[string]any{}})
	waitForRPCID(t, client, float64(1))
	client.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 2, "method": "session/new", "params": map[string]any{"cwd": "/workspace"}})
	sessionID := waitForRPCID(t, client, float64(2))["result"].(map[string]any)["sessionId"].(string)
	sendACPPrompt(t, client, sessionID, 3, "remember me")
	client.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 4, "method": "session/close", "params": map[string]any{"sessionId": sessionID}})
	waitForRPCID(t, client, float64(4))
	if manager.closeCount() != 1 {
		t.Fatalf("expected one runtime close, got %d", manager.closeCount())
	}
	client.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 5, "method": "session/load", "params": map[string]any{"sessionId": sessionID}})
	waitForRPCID(t, client, float64(5))
	waitForMethod(t, client, "session/update")
	waitForMethod(t, client, "session/update")
	assertReplayDone(t, client, sessionID)
	if manager.startCount() != 1 {
		t.Fatalf("session/load must not start runtime, got starts=%d", manager.startCount())
	}
	client.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 6, "method": "session/resume", "params": map[string]any{"sessionId": sessionID}})
	resumeResp := waitForRPCID(t, client, float64(6))
	resumeResult := resumeResp["result"].(map[string]any)
	if resumeResult["readOnly"] != true {
		t.Fatalf("session/resume after close should be read-only, got %#v", resumeResult)
	}
	if manager.startCount() != 1 {
		t.Fatalf("session/resume must not start fresh runtime, got starts=%d", manager.startCount())
	}
}

func TestACPSameConnectionCancelInterruptsPrompt(t *testing.T) {
	manager := newBlockingACPRuntimeManager()
	srv := newACPTestServerWithRuntime(t, manager)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	client := dialACPWS(t, "ws"+trimHTTPPrefix(ts.URL)+"/acp", map[string]string{"Authorization": "Bearer test-key"})
	defer client.close()
	client.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": map[string]any{}})
	waitForRPCID(t, client, float64(1))
	client.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 2, "method": "session/new", "params": map[string]any{"cwd": "/workspace"}})
	sessionID := waitForRPCID(t, client, float64(2))["result"].(map[string]any)["sessionId"].(string)
	client.writeJSON(t, map[string]any{
		"jsonrpc": "2.0",
		"id":      3,
		"method":  "session/prompt",
		"params": map[string]any{
			"sessionId": sessionID,
			"prompt":    []any{map[string]any{"type": "text", "text": "block"}},
		},
	})
	manager.waitStarted(t)
	client.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 4, "method": "session/cancel", "params": map[string]any{"sessionId": sessionID}})
	promptResp := waitForRPCID(t, client, float64(3))
	stop := promptResp["result"].(map[string]any)["stopReason"]
	if stop != "cancelled" {
		t.Fatalf("expected cancelled stopReason, got %#v", promptResp)
	}
	cancelResp := waitForRPCID(t, client, float64(4))
	if _, ok := cancelResp["result"].(map[string]any); !ok {
		t.Fatalf("unexpected cancel response: %#v", cancelResp)
	}
	deadline := time.Now().Add(2 * time.Second)
	for {
		manager.mu.Lock()
		closeCount := len(manager.closes)
		manager.mu.Unlock()
		if closeCount == 1 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("expected runtime close to be forwarded once after cancel, got %d", closeCount)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestACPSameConnectionCloseAndDeleteInterruptPrompt(t *testing.T) {
	cases := []struct {
		name       string
		method     string
		stopReason string
	}{
		{name: "close", method: "session/close", stopReason: "closed"},
		{name: "delete", method: "session/delete", stopReason: "deleted"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			manager := newBlockingACPRuntimeManager()
			srv := newACPTestServerWithRuntime(t, manager)
			ts := httptest.NewServer(srv.Handler())
			defer ts.Close()

			client := dialACPWS(t, "ws"+trimHTTPPrefix(ts.URL)+"/acp", map[string]string{"Authorization": "Bearer test-key"})
			defer client.close()
			client.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": map[string]any{}})
			waitForRPCID(t, client, float64(1))
			client.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 2, "method": "session/new", "params": map[string]any{"cwd": "/workspace"}})
			sessionID := waitForRPCID(t, client, float64(2))["result"].(map[string]any)["sessionId"].(string)
			client.writeJSON(t, map[string]any{
				"jsonrpc": "2.0",
				"id":      3,
				"method":  "session/prompt",
				"params": map[string]any{
					"sessionId": sessionID,
					"prompt":    []any{map[string]any{"type": "text", "text": "block"}},
				},
			})
			manager.waitStarted(t)
			client.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 4, "method": tc.method, "params": map[string]any{"sessionId": sessionID}})
			interruptResp := waitForRPCID(t, client, float64(4))
			if _, ok := interruptResp["result"].(map[string]any); !ok {
				t.Fatalf("unexpected interrupt response: %#v", interruptResp)
			}
			promptResp := waitForRPCID(t, client, float64(3))
			stop := promptResp["result"].(map[string]any)["stopReason"]
			if stop != tc.stopReason {
				t.Fatalf("expected %s stopReason, got %#v", tc.stopReason, promptResp)
			}
		})
	}
}

func TestACPResumeRetriesPendingRuntimeCleanup(t *testing.T) {
	manager := &recordingACPRuntimeManager{closeFailures: 1}
	srv := newACPTestServerWithRuntime(t, manager)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	client := dialACPWS(t, "ws"+trimHTTPPrefix(ts.URL)+"/acp", map[string]string{"Authorization": "Bearer test-key"})
	defer client.close()
	client.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": map[string]any{}})
	waitForRPCID(t, client, float64(1))
	client.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 2, "method": "session/new", "params": map[string]any{"cwd": "/workspace"}})
	sessionID := waitForRPCID(t, client, float64(2))["result"].(map[string]any)["sessionId"].(string)

	client.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 3, "method": "session/close", "params": map[string]any{"sessionId": sessionID}})
	closeErr := waitForRPCID(t, client, float64(3))
	if _, ok := closeErr["error"].(map[string]any); !ok {
		t.Fatalf("expected close error: %#v", closeErr)
	}

	client.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 4, "method": "session/resume", "params": map[string]any{"sessionId": sessionID}})
	resumeResp := waitForRPCID(t, client, float64(4))
	if resumeResp["result"].(map[string]any)["sessionId"] != sessionID {
		t.Fatalf("expected resume to reattach existing runtime: %#v", resumeResp)
	}
	if manager.startCount() != 1 {
		t.Fatalf("resume after cleanup failure must not start a second runtime, got starts=%d", manager.startCount())
	}

	client.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 5, "method": "session/close", "params": map[string]any{"sessionId": sessionID}})
	closeResp := waitForRPCID(t, client, float64(5))
	if _, ok := closeResp["result"].(map[string]any); !ok {
		t.Fatalf("expected retry close to succeed: %#v", closeResp)
	}
	client.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 6, "method": "session/resume", "params": map[string]any{"sessionId": sessionID}})
	secondResumeResp := waitForRPCID(t, client, float64(6))
	secondResumeResult := secondResumeResp["result"].(map[string]any)
	if secondResumeResult["sessionId"] != sessionID || secondResumeResult["readOnly"] != true {
		t.Fatalf("unexpected resume response: %#v", secondResumeResp)
	}
	if manager.startCount() != 1 {
		t.Fatalf("resume after close must not start a fresh runtime, got starts=%d", manager.startCount())
	}
}

func TestACPCleanupSingleflightAcrossCloseAndResume(t *testing.T) {
	manager := &recordingACPRuntimeManager{closeDelay: 100 * time.Millisecond}
	gateway := NewACPGateway(nil, nil)
	gateway.runtimeManager = manager
	scope := Scope{TenantID: "tenant-live", ProjectID: "project-live"}
	session, err := gateway.createSession(context.Background(), scope, acpSessionRequest{CWD: "/workspace"})
	if err != nil {
		t.Fatal(err)
	}

	closeDone := make(chan error, 1)
	go func() {
		closeDone <- gateway.closeSession(scope, session.SessionID)
	}()
	manager.waitCloseCount(t, 1)

	resumed, err := gateway.resumeSession(context.Background(), scope, session.SessionID, "/workspace")
	if err != nil {
		t.Fatal(err)
	}
	if resumed.SessionID != session.SessionID {
		t.Fatalf("unexpected resumed session: %#v", resumed)
	}
	if !resumed.Closed || resumed.ReadOnlyReason != acpReadOnlyRuntimeNotRecovered {
		t.Fatalf("resume during cleanup should expose read-only closing state, got %#v", resumed)
	}
	if err := <-closeDone; err != nil {
		t.Fatal(err)
	}
	if manager.closeCount() != 1 {
		t.Fatalf("expected one shared cleanup, got %d", manager.closeCount())
	}
	if manager.startCount() != 1 {
		t.Fatalf("resume must not start a replacement runtime, got starts=%d", manager.startCount())
	}
}

func TestACPRejectsNonTextPromptBlocks(t *testing.T) {
	manager := &recordingACPRuntimeManager{}
	srv := newACPTestServerWithRuntime(t, manager)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()
	client := dialACPWS(t, "ws"+trimHTTPPrefix(ts.URL)+"/acp", map[string]string{"Authorization": "Bearer test-key"})
	defer client.close()
	client.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": map[string]any{}})
	waitForRPCID(t, client, float64(1))
	client.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 2, "method": "session/new", "params": map[string]any{"cwd": "/workspace"}})
	sessionID := waitForRPCID(t, client, float64(2))["result"].(map[string]any)["sessionId"].(string)
	client.writeJSON(t, map[string]any{
		"jsonrpc": "2.0",
		"id":      3,
		"method":  "session/prompt",
		"params": map[string]any{
			"sessionId": sessionID,
			"prompt":    []any{map[string]any{"type": "image", "data": "x"}},
		},
	})
	resp := waitForRPCID(t, client, float64(3))
	if _, ok := resp["error"].(map[string]any); !ok {
		t.Fatalf("expected non-text prompt error, got %#v", resp)
	}
}

func TestACPCloudAgentSessionStatus(t *testing.T) {
	manager := &recordingACPRuntimeManager{}
	srv := newACPTestServerWithRuntime(t, manager)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()
	client := dialACPWS(t, "ws"+trimHTTPPrefix(ts.URL)+"/acp", map[string]string{"Authorization": "Bearer test-key"})
	defer client.close()

	client.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": map[string]any{}})
	initResp := waitForRPCID(t, client, float64(1))
	capabilities := initResp["result"].(map[string]any)["agentCapabilities"].(map[string]any)
	meta := capabilities["_meta"].(map[string]any)["cloudagent"].(map[string]any)
	methods := meta["methods"].([]any)
	if !containsAnyString(methods, "_cloudagent.session.status") {
		t.Fatalf("missing cloudagent status method capability: %#v", meta)
	}

	client.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 2, "method": "session/new", "params": map[string]any{"cwd": "/workspace"}})
	sessionID := waitForRPCID(t, client, float64(2))["result"].(map[string]any)["sessionId"].(string)
	client.writeJSON(t, map[string]any{
		"jsonrpc": "2.0",
		"id":      3,
		"method":  "_cloudagent.session.status",
		"params":  map[string]any{"session_id": sessionID},
	})
	result := waitForRPCID(t, client, float64(3))["result"].(map[string]any)
	if result["session_id"] != sessionID {
		t.Fatalf("session_id=%#v want %s", result["session_id"], sessionID)
	}
	if _, hasCamel := result["sessionId"]; hasCamel {
		t.Fatalf("status extension must use snake_case fields, got sessionId in %#v", result)
	}
	if result["state"] != "ready" || result["runtime_generation"] != float64(1) || result["cleanup_pending"] != false {
		t.Fatalf("unexpected status result: %#v", result)
	}
	sandbox := result["sandbox"].(map[string]any)
	if sandbox["backend"] != "ags" || sandbox["outer_sandbox_id"] != "outer_1" {
		t.Fatalf("unexpected sandbox status: %#v", sandbox)
	}
	if _, leaksToken := sandbox["outer_envd_access_token"]; leaksToken {
		t.Fatalf("status leaked envd token: %#v", sandbox)
	}
	if _, leaksInnerID := sandbox["inner_sandbox_id"]; leaksInnerID {
		t.Fatalf("status leaked inner sandbox id: %#v", sandbox)
	}
	if result["session_proxy_id"] == "" {
		t.Fatalf("status missing session_proxy_id: %#v", result)
	}
}

func newACPTestServerWithRuntime(t *testing.T, manager ACPSessionRuntimeManager) *Server {
	t.Helper()
	store, err := NewStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return newACPTestServerWithRuntimeAndStore(store, manager)
}

func newACPTestServerWithRuntimeAndStore(store *Store, manager ACPSessionRuntimeManager) *Server {
	worker := FakeWorker{OutputText: "unused"}
	return &Server{
		store:  store,
		worker: worker,
		acpGate: &ACPGateway{
			store:          store,
			worker:         worker,
			runtimeManager: manager,
			sessions:       map[string]*acpSession{},
		},
	}
}

func sendACPPrompt(t *testing.T, client *acpWSClient, sessionID string, id int, text string) {
	t.Helper()
	client.writeJSON(t, map[string]any{
		"jsonrpc": "2.0",
		"id":      id,
		"method":  "session/prompt",
		"params": map[string]any{
			"sessionId": sessionID,
			"prompt":    []any{map[string]any{"type": "text", "text": text}},
		},
	})
	waitForMethod(t, client, "session/update")
	resp := waitForRPCID(t, client, float64(id))
	if resp["result"].(map[string]any)["stopReason"] != "end_turn" {
		t.Fatalf("unexpected prompt response: %#v", resp)
	}
}

type recordingACPRuntimeManager struct {
	mu            sync.Mutex
	starts        []ACPSessionRuntimeStartRequest
	prompts       []ACPSessionRuntimePromptRequest
	cancels       []ACPSessionRuntime
	closes        []ACPSessionRuntime
	events        []workerEvent
	resultText    string
	promptErr     error
	promptErrs    []error
	reattachErr   error
	closeFailures int
	closeDelay    time.Duration
}

func (m *recordingACPRuntimeManager) StartSessionRuntime(ctx context.Context, req ACPSessionRuntimeStartRequest) (ACPSessionRuntime, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.starts = append(m.starts, req)
	return ACPSessionRuntime{RuntimeID: fmt.Sprintf("rt_%d", len(m.starts)), SandboxBackend: req.SandboxBackend, SandboxTemplateID: req.SandboxTemplateID, OuterSandboxID: fmt.Sprintf("outer_%d", len(m.starts)), DaemonAddr: "fake"}, nil
}

func (m *recordingACPRuntimeManager) ReattachSessionRuntime(ctx context.Context, runtime ACPSessionRuntime) (ACPSessionRuntime, error) {
	m.mu.Lock()
	reattachErr := m.reattachErr
	m.mu.Unlock()
	if reattachErr != nil {
		return ACPSessionRuntime{}, reattachErr
	}
	if runtime.RuntimeID == "" && runtime.OuterSandboxID == "" {
		return ACPSessionRuntime{}, fmt.Errorf("runtime identity is missing")
	}
	return runtime, nil
}

func (m *recordingACPRuntimeManager) PromptSessionRuntime(ctx context.Context, runtime ACPSessionRuntime, req ACPSessionRuntimePromptRequest, emit func(workerEvent) error) (workerResult, ACPSessionRuntimeUpdate, error) {
	m.mu.Lock()
	m.prompts = append(m.prompts, req)
	promptErr := m.promptErr
	if len(m.promptErrs) > 0 {
		promptErr = m.promptErrs[0]
		m.promptErrs = m.promptErrs[1:]
	}
	m.mu.Unlock()
	if promptErr != nil {
		return workerResult{}, ACPSessionRuntimeUpdate{}, promptErr
	}
	if emit != nil {
		events := m.events
		if len(events) == 0 {
			events = []workerEvent{{WorkerContractVersion: WorkerContractVersion, EventID: "evt_" + req.JobID, JobID: req.JobID, Sequence: 1, Kind: "output_text_delta", Timestamp: time.Now().UTC().Unix(), Delta: "answer: " + req.Prompt}}
		}
		for _, event := range events {
			event.WorkerContractVersion = WorkerContractVersion
			event.JobID = req.JobID
			event.Timestamp = time.Now().UTC().Unix()
			if event.EventID == "" {
				event.EventID = fmt.Sprintf("evt_%s_%d", req.JobID, event.Sequence)
			}
			if err := emit(event); err != nil {
				return workerResult{}, ACPSessionRuntimeUpdate{}, err
			}
		}
	}
	outputText := m.resultText
	if outputText == "" {
		outputText = "answer: " + req.Prompt
	}
	return workerResult{WorkerContractVersion: WorkerContractVersion, JobID: req.JobID, Status: "completed", OutputText: outputText}, ACPSessionRuntimeUpdate{}, nil
}

func (m *recordingACPRuntimeManager) CloseSessionRuntime(ctx context.Context, runtime ACPSessionRuntime) error {
	m.mu.Lock()
	m.closes = append(m.closes, runtime)
	closeDelay := m.closeDelay
	m.mu.Unlock()
	if closeDelay > 0 {
		select {
		case <-time.After(closeDelay):
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closeFailures > 0 {
		m.closeFailures--
		return fmt.Errorf("injected close failure")
	}
	return nil
}

func (m *recordingACPRuntimeManager) CancelSessionRuntime(ctx context.Context, runtime ACPSessionRuntime, jobID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.cancels = append(m.cancels, runtime)
	return nil
}

func (m *recordingACPRuntimeManager) startCount() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.starts)
}

func (m *recordingACPRuntimeManager) closeCount() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.closes)
}

func (m *recordingACPRuntimeManager) waitCloseCount(t *testing.T, want int) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if m.closeCount() >= want {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for close count %d, got %d", want, m.closeCount())
}

func (m *recordingACPRuntimeManager) promptTexts() []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]string, 0, len(m.prompts))
	for _, prompt := range m.prompts {
		out = append(out, prompt.Prompt)
	}
	return out
}

func (m *recordingACPRuntimeManager) startCWDs() []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]string, 0, len(m.starts))
	for _, start := range m.starts {
		out = append(out, start.CWD)
	}
	return out
}

func (m *recordingACPRuntimeManager) startBackends() []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]string, 0, len(m.starts))
	for _, start := range m.starts {
		out = append(out, start.SandboxBackend)
	}
	return out
}

func (m *recordingACPRuntimeManager) startTemplateIDs() []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]string, 0, len(m.starts))
	for _, start := range m.starts {
		out = append(out, start.SandboxTemplateID)
	}
	return out
}

func (m *recordingACPRuntimeManager) promptCWDs() []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]string, 0, len(m.prompts))
	for _, prompt := range m.prompts {
		out = append(out, prompt.CWD)
	}
	return out
}

type blockingACPRuntimeManager struct {
	recordingACPRuntimeManager
	started chan struct{}
	once    sync.Once
}

func newBlockingACPRuntimeManager() *blockingACPRuntimeManager {
	return &blockingACPRuntimeManager{started: make(chan struct{})}
}

func (m *blockingACPRuntimeManager) PromptSessionRuntime(ctx context.Context, runtime ACPSessionRuntime, req ACPSessionRuntimePromptRequest, emit func(workerEvent) error) (workerResult, ACPSessionRuntimeUpdate, error) {
	m.mu.Lock()
	m.prompts = append(m.prompts, req)
	m.mu.Unlock()
	m.once.Do(func() { close(m.started) })
	<-ctx.Done()
	return workerResult{}, ACPSessionRuntimeUpdate{}, ctx.Err()
}

func (m *blockingACPRuntimeManager) waitStarted(t *testing.T) {
	t.Helper()
	select {
	case <-m.started:
	case <-time.After(2 * time.Second):
		t.Fatal("blocking runtime did not start prompt")
	}
}

type acpWSClient struct {
	conn net.Conn
	br   *bufio.Reader
}

func dialACPWS(t *testing.T, rawURL string, headers map[string]string) *acpWSClient {
	t.Helper()
	parsed, err := url.Parse(rawURL)
	if err != nil {
		t.Fatal(err)
	}
	conn, err := net.Dial("tcp", parsed.Host)
	if err != nil {
		t.Fatal(err)
	}
	keyBytes := make([]byte, 16)
	if _, err := rand.Read(keyBytes); err != nil {
		t.Fatal(err)
	}
	key := base64.StdEncoding.EncodeToString(keyBytes)
	path := parsed.RequestURI()
	if path == "" {
		path = "/"
	}
	var builder strings.Builder
	builder.WriteString(fmt.Sprintf("GET %s HTTP/1.1\r\nHost: %s\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: %s\r\n", path, parsed.Host, key))
	for k, v := range headers {
		builder.WriteString(fmt.Sprintf("%s: %s\r\n", k, v))
	}
	builder.WriteString("\r\n")
	if _, err := conn.Write([]byte(builder.String())); err != nil {
		t.Fatal(err)
	}
	br := bufio.NewReader(conn)
	resp, err := http.ReadResponse(br, &http.Request{Method: http.MethodGet})
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusSwitchingProtocols {
		t.Fatalf("unexpected status: %s", resp.Status)
	}
	if got, want := resp.Header.Get("Sec-WebSocket-Accept"), testWSAccept(key); got != want {
		t.Fatalf("bad accept: got %q want %q", got, want)
	}
	return &acpWSClient{conn: conn, br: br}
}

func trimHTTPPrefix(raw string) string {
	return strings.TrimPrefix(raw, "http")
}

func testWSAccept(key string) string {
	sum := sha1.Sum([]byte(key + websocketGUID))
	return base64.StdEncoding.EncodeToString(sum[:])
}

func (c *acpWSClient) close() {
	_ = c.conn.Close()
}

func (c *acpWSClient) writeJSON(t *testing.T, value any) {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	c.writeMasked(t, data)
}

func (c *acpWSClient) writeMasked(t *testing.T, payload []byte) {
	t.Helper()
	var header []byte
	header = append(header, 0x81)
	length := len(payload)
	switch {
	case length < 126:
		header = append(header, 0x80|byte(length))
	case length <= 65535:
		header = append(header, 0x80|126, byte(length>>8), byte(length))
	default:
		t.Fatalf("payload too large: %d", length)
	}
	mask := [4]byte{1, 2, 3, 4}
	masked := append([]byte(nil), payload...)
	for i := range masked {
		masked[i] ^= mask[i%4]
	}
	if _, err := c.conn.Write(append(append(header, mask[:]...), masked...)); err != nil {
		t.Fatal(err)
	}
}

func (c *acpWSClient) readJSON(t *testing.T) map[string]any {
	t.Helper()
	_ = c.conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	header := make([]byte, 2)
	if _, err := io.ReadFull(c.br, header); err != nil {
		t.Fatal(err)
	}
	opcode := header[0] & 0x0F
	if opcode == 0x8 {
		t.Fatal("websocket closed")
	}
	length := int(header[1] & 0x7F)
	switch length {
	case 126:
		var ext [2]byte
		if _, err := io.ReadFull(c.br, ext[:]); err != nil {
			t.Fatal(err)
		}
		length = int(binary.BigEndian.Uint16(ext[:]))
	case 127:
		t.Fatal("unexpected large websocket frame")
	}
	payload := make([]byte, length)
	if _, err := io.ReadFull(c.br, payload); err != nil {
		t.Fatal(err)
	}
	var out map[string]any
	if err := json.Unmarshal(payload, &out); err != nil {
		t.Fatalf("invalid json payload %s: %v", string(payload), err)
	}
	return out
}

func waitForRPCID(t *testing.T, client *acpWSClient, id float64) map[string]any {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		msg := client.readJSON(t)
		if got, ok := msg["id"].(float64); ok && got == id {
			return msg
		}
	}
	t.Fatal("timed out waiting for rpc response")
	return nil
}

func waitForMethod(t *testing.T, client *acpWSClient, method string) map[string]any {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		msg := client.readJSON(t)
		if got, ok := msg["method"].(string); ok && got == method {
			return msg
		}
	}
	t.Fatalf("timed out waiting for method %s", method)
	return nil
}

func assertReplayDone(t *testing.T, client *acpWSClient, sessionID string) {
	t.Helper()
	msg := waitForMethod(t, client, "session/update")
	params := msg["params"].(map[string]any)
	if params["sessionId"] != sessionID {
		t.Fatalf("unexpected replay_done session id: %#v", params)
	}
	update := params["update"].(map[string]any)
	if update["sessionUpdate"] != "replay_done" {
		t.Fatalf("expected replay_done update, got %#v", update)
	}
}

func assertUpdateKind(t *testing.T, client *acpWSClient, kind string) map[string]any {
	t.Helper()
	msg := waitForMethod(t, client, "session/update")
	update := msg["params"].(map[string]any)["update"].(map[string]any)
	if update["sessionUpdate"] != kind {
		t.Fatalf("expected update kind %s, got %#v", kind, update)
	}
	return update
}

func assertTextUpdate(t *testing.T, client *acpWSClient, kind, text string) {
	t.Helper()
	update := assertUpdateKind(t, client, kind)
	content := update["content"].(map[string]any)
	if content["text"] != text {
		t.Fatalf("expected %s text %q, got %#v", kind, text, update)
	}
}

func containsAnyString(values []any, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}

func countTableRows(t *testing.T, db queryRower, table string) int {
	t.Helper()
	var count int
	if err := db.QueryRow("SELECT COUNT(*) FROM " + table).Scan(&count); err != nil {
		t.Fatal(err)
	}
	return count
}

func tableExists(t *testing.T, db queryRower, table string) bool {
	t.Helper()
	var count int
	if err := db.QueryRow("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?", table).Scan(&count); err != nil {
		t.Fatal(err)
	}
	return count > 0
}

type queryRower interface {
	QueryRow(query string, args ...any) *sql.Row
}
