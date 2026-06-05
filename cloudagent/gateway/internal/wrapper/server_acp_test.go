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
	"errors"
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
	loadResp := waitForRPCID(t, client, float64(5))
	loadResult := loadResp["result"].(map[string]any)
	if _, hasSessionID := loadResult["sessionId"]; hasSessionID || cloudAgentResultMeta(t, loadResult)["state"] != "ready" {
		t.Fatalf("unexpected load result: %#v", loadResp)
	}
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
	client.writeJSON(t, map[string]any{
		"jsonrpc": "2.0",
		"id":      2,
		"method":  "session/new",
		"params": map[string]any{
			"cwd":   "/workspace",
			"_meta": map[string]any{"cloudagent": map[string]any{"outer_runtime": "ags"}},
		},
	})
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

func TestACPToolCallDoesNotExposeCallIDAsToolName(t *testing.T) {
	update := acpToolCallUpdate("tool_call", workerEvent{
		Kind:         "tool_call",
		ToolCallID:   "call_function_abc_1",
		ToolStatus:   "running",
		ToolRawInput: json.RawMessage(`{"question":"pay?"}`),
	})

	if update["name"] != nil || update["title"] != nil || update["kind"] != nil {
		t.Fatalf("tool call id must not be surfaced as tool name: %#v", update)
	}
	nested := update["toolCall"].(map[string]any)
	if nested["name"] != nil || nested["title"] != nil || nested["kind"] != nil {
		t.Fatalf("nested tool call id must not be surfaced as tool name: %#v", update)
	}
	if update["toolCallId"] != "call_function_abc_1" {
		t.Fatalf("toolCallId should still be preserved: %#v", update)
	}
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
	client.writeJSON(t, map[string]any{
		"jsonrpc": "2.0",
		"id":      2,
		"method":  "session/new",
		"params": map[string]any{
			"cwd":   "/workspace",
			"_meta": map[string]any{"cloudagent": map[string]any{"outer_runtime": "ags"}},
		},
	})
	sessionID := waitForRPCID(t, client, float64(2))["result"].(map[string]any)["sessionId"].(string)
	client.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 3, "method": "session/prompt", "params": map[string]any{"sessionId": sessionID, "prompt": []any{map[string]any{"type": "text", "text": "interleave"}}}})
	for i := 0; i < 4; i++ {
		waitForMethod(t, client, "session/update")
	}
	waitForRPCID(t, client, float64(3))

	client.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 4, "method": "session/load", "params": map[string]any{"sessionId": sessionID}})
	assertUpdateKind(t, client, "user_message_chunk")
	assertTextUpdate(t, client, "agent_message_chunk", "before ")
	assertUpdateKind(t, client, "tool_call_update")
	assertTextUpdate(t, client, "agent_message_chunk", "after")
	assertReplayDone(t, client, sessionID)
	waitForRPCID(t, client, float64(4))
}

func TestACPLiveTextChunksStreamDeltasWithAccumulatedMeta(t *testing.T) {
	manager := &recordingACPRuntimeManager{
		events: []workerEvent{
			{EventID: "evt_text_1", Sequence: 1, Kind: "output_text_delta", Delta: "BROWS"},
			{EventID: "evt_text_2", Sequence: 2, Kind: "output_text_delta", Delta: "ER_FINAL_123"},
		},
		resultText: "BROWSER_FINAL_123",
	}
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
			"cwd":   "/workspace",
			"_meta": map[string]any{"cloudagent": map[string]any{"outer_runtime": "ags"}},
		},
	})
	sessionID := waitForRPCID(t, client, float64(2))["result"].(map[string]any)["sessionId"].(string)
	client.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 3, "method": "session/prompt", "params": map[string]any{"sessionId": sessionID, "prompt": []any{map[string]any{"type": "text", "text": "stream"}}}})

	first := assertUpdateKind(t, client, "agent_message_chunk")
	if _, ok := first["accumulated"]; ok {
		t.Fatalf("expected no top-level accumulated protocol extension, got %#v", first)
	}
	if first["content"].(map[string]any)["text"] != "BROWS" {
		t.Fatalf("expected first ACP chunk delta, got %#v", first)
	}
	firstMeta := first["_meta"].(map[string]any)["cloudagent"].(map[string]any)
	if firstMeta["accumulated"] != true || firstMeta["accumulated_text"] != "BROWS" {
		t.Fatalf("expected first CloudAgent accumulated metadata, got %#v", first)
	}
	second := assertUpdateKind(t, client, "agent_message_chunk")
	if _, ok := second["accumulated"]; ok {
		t.Fatalf("expected no top-level accumulated protocol extension, got %#v", second)
	}
	if second["content"].(map[string]any)["text"] != "ER_FINAL_123" {
		t.Fatalf("expected second ACP chunk delta, got %#v", second)
	}
	secondMeta := second["_meta"].(map[string]any)["cloudagent"].(map[string]any)
	if secondMeta["accumulated"] != true || secondMeta["accumulated_text"] != "BROWSER_FINAL_123" {
		t.Fatalf("expected second CloudAgent accumulated metadata, got %#v", second)
	}
	if first["messageId"] != second["messageId"] || first["blockId"] != second["blockId"] {
		t.Fatalf("expected live chunks to share message/block identity, first=%#v second=%#v", first, second)
	}
	waitForRPCID(t, client, float64(3))
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
	client.writeJSON(t, map[string]any{
		"jsonrpc": "2.0",
		"id":      2,
		"method":  "session/new",
		"params": map[string]any{
			"cwd":   "/workspace",
			"_meta": map[string]any{"cloudagent": map[string]any{"outer_runtime": "ags"}},
		},
	})
	sessionID := waitForRPCID(t, client, float64(2))["result"].(map[string]any)["sessionId"].(string)
	client.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 3, "method": "session/prompt", "params": map[string]any{"sessionId": sessionID, "prompt": []any{map[string]any{"type": "text", "text": "use tool"}}}})
	waitForMethod(t, client, "session/update")
	waitForRPCID(t, client, float64(3))

	client.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 4, "method": "session/load", "params": map[string]any{"sessionId": sessionID}})
	assertUpdateKind(t, client, "user_message_chunk")
	assertUpdateKind(t, client, "tool_call_update")
	assertTextUpdate(t, client, "agent_message_chunk", "final answer")
	assertReplayDone(t, client, sessionID)
	waitForRPCID(t, client, float64(4))
}

func TestACPLoadSubscribesReconnectedClientToActivePrompt(t *testing.T) {
	afterFirst := make(chan struct{})
	continueEvents := make(chan struct{})
	manager := &recordingACPRuntimeManager{
		events: []workerEvent{
			{EventID: "evt_reasoning", Sequence: 1, Kind: "reasoning_delta", Delta: "thinking"},
			{EventID: "evt_tail", Sequence: 2, Kind: "output_text_delta", Delta: "tail answer"},
		},
		resultText:      "tail answer",
		afterFirstEvent: afterFirst,
		continueEvents:  continueEvents,
	}
	srv := newACPTestServerWithRuntime(t, manager)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	client := dialACPWS(t, "ws"+trimHTTPPrefix(ts.URL)+"/acp", map[string]string{"Authorization": "Bearer test-key"})
	client.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": map[string]any{}})
	waitForRPCID(t, client, float64(1))
	client.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 2, "method": "session/new", "params": map[string]any{"cwd": "/workspace"}})
	sessionID := waitForRPCID(t, client, float64(2))["result"].(map[string]any)["sessionId"].(string)
	client.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 3, "method": "session/prompt", "params": map[string]any{"sessionId": sessionID, "prompt": []any{map[string]any{"type": "text", "text": "stream tail"}}}})
	waitForMethod(t, client, "session/update")
	<-afterFirst
	client.close()

	reconnected := dialACPWS(t, "ws"+trimHTTPPrefix(ts.URL)+"/acp", map[string]string{"Authorization": "Bearer test-key"})
	defer reconnected.close()
	reconnected.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 10, "method": "initialize", "params": map[string]any{}})
	waitForRPCID(t, reconnected, float64(10))
	reconnected.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 11, "method": "session/load", "params": map[string]any{"sessionId": sessionID}})
	assertUpdateKind(t, reconnected, "user_message_chunk")
	assertUpdateKind(t, reconnected, "agent_thought_chunk")
	assertReplayDone(t, reconnected, sessionID)
	waitForRPCID(t, reconnected, float64(11))

	close(continueEvents)
	assertTextUpdate(t, reconnected, "agent_message_chunk", "tail answer")
	waitForACPSessionState(t, srv.acpGate, sessionID, acpRuntimeStateReady)
}

func TestACPReplaySubscriberBuffersLiveUpdatesUntilReplayFlush(t *testing.T) {
	scope := Scope{TenantID: "tenant-a", ProjectID: "project-a"}
	sessionID := "session_replay_buffer"
	g := &ACPGateway{
		sessions: map[string]*acpSession{
			sessionID: {SessionID: sessionID, Scope: scope},
		},
		subscribers: map[string]map[*WSConn]acpSessionSubscriber{},
	}
	serverConn, clientConn := net.Pipe()
	defer serverConn.Close()
	defer clientConn.Close()
	ws := &WSConn{conn: serverConn, br: bufio.NewReader(serverConn)}
	client := &acpWSClient{conn: clientConn, br: bufio.NewReader(clientConn)}

	g.subscribeSessionForReplay(scope, sessionID, ws, false)
	first := map[string]any{
		"sessionId": sessionID,
		"update": map[string]any{
			"sessionUpdate": "agent_message_chunk",
			"content":       map[string]any{"text": "buffered-tail"},
		},
	}
	broadcastDone := make(chan struct{})
	var delivered, failed int
	go func() {
		delivered, failed = g.broadcastPromptUpdate(scope, sessionID, nil, first)
		close(broadcastDone)
	}()
	select {
	case <-broadcastDone:
	case <-time.After(time.Second):
		t.Fatal("broadcast should buffer replay updates without writing to websocket")
	}
	if delivered != 1 || failed != 0 {
		t.Fatalf("unexpected buffered broadcast result delivered=%d failed=%d", delivered, failed)
	}

	flushDone := make(chan error, 1)
	go func() {
		flushDone <- g.flushReplayBufferedUpdates(sessionID, ws, false)
	}()
	assertTextUpdateFrame(t, client.readJSON(t), sessionID, "buffered-tail")
	if err := <-flushDone; err != nil {
		t.Fatalf("flush replay buffer failed: %v", err)
	}

	second := map[string]any{
		"sessionId": sessionID,
		"update": map[string]any{
			"sessionUpdate": "agent_message_chunk",
			"content":       map[string]any{"text": "live-tail"},
		},
	}
	broadcastDone = make(chan struct{})
	go func() {
		delivered, failed = g.broadcastPromptUpdate(scope, sessionID, nil, second)
		close(broadcastDone)
	}()
	assertTextUpdateFrame(t, client.readJSON(t), sessionID, "live-tail")
	<-broadcastDone
	if delivered != 1 || failed != 0 {
		t.Fatalf("unexpected live broadcast result delivered=%d failed=%d", delivered, failed)
	}
}

func TestACPReplayBufferOverflowEmitsGap(t *testing.T) {
	scope := Scope{TenantID: "tenant-a", ProjectID: "project-a"}
	sessionID := "session_replay_gap"
	g := &ACPGateway{
		sessions: map[string]*acpSession{
			sessionID: {SessionID: sessionID, Scope: scope},
		},
		subscribers: map[string]map[*WSConn]acpSessionSubscriber{},
	}
	serverConn, clientConn := net.Pipe()
	defer serverConn.Close()
	defer clientConn.Close()
	ws := &WSConn{conn: serverConn, br: bufio.NewReader(serverConn)}
	client := &acpWSClient{conn: clientConn, br: bufio.NewReader(clientConn)}

	g.subscribeSessionForReplay(scope, sessionID, ws, false)
	for i := 0; i < maxACPReplayBufferedUpdates+2; i++ {
		params := map[string]any{
			"sessionId": sessionID,
			"update": map[string]any{
				"sessionUpdate": "agent_message_chunk",
				"content":       map[string]any{"text": fmt.Sprintf("tail-%d", i)},
			},
		}
		delivered, failed := g.broadcastPromptUpdate(scope, sessionID, nil, params)
		if delivered != 1 || failed != 0 {
			t.Fatalf("unexpected broadcast result delivered=%d failed=%d", delivered, failed)
		}
	}

	flushDone := make(chan error, 1)
	go func() {
		flushDone <- g.flushReplayBufferedUpdates(sessionID, ws, false)
	}()
	gap := client.readJSON(t)
	if gap["method"] != cloudAgentReplayGapMethod {
		t.Fatalf("expected replay gap extension, got %#v", gap)
	}
	gapParams := gap["params"].(map[string]any)
	if gapParams["session_id"] != sessionID || gapParams["dropped"] != float64(2) {
		t.Fatalf("expected replay gap for two dropped updates, got %#v", gapParams)
	}
	for i := 0; i < maxACPReplayBufferedUpdates; i++ {
		_ = client.readJSON(t)
	}
	if err := <-flushDone; err != nil {
		t.Fatalf("flush replay buffer failed: %v", err)
	}
}

func TestACPLiveAndReplayUpdatesCarryStableEventIdentity(t *testing.T) {
	srv, _ := newTestServer(t, FakeWorker{OutputText: "identity answer"})
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
			"prompt":    []any{map[string]any{"type": "text", "text": "identity"}},
		},
	})
	live := assertUpdateKind(t, client, "agent_message_chunk")
	liveEventID, _ := live["eventId"].(string)
	liveTurnID, _ := live["turnId"].(string)
	liveSeq, _ := live["eventSeq"].(float64)
	if liveEventID == "" || liveTurnID == "" || liveSeq <= 0 {
		t.Fatalf("live update missing event identity: %#v", live)
	}
	waitForRPCID(t, client, float64(3))

	client.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 4, "method": "session/load", "params": map[string]any{"sessionId": sessionID}})
	assertUpdateKind(t, client, "user_message_chunk")
	replayed := assertUpdateKind(t, client, "agent_message_chunk")
	if replayed["eventId"] != liveEventID || replayed["turnId"] != liveTurnID || replayed["eventSeq"] != liveSeq {
		t.Fatalf("replayed identity does not match live identity live=%#v replayed=%#v", live, replayed)
	}
	assertReplayDone(t, client, sessionID)
	waitForRPCID(t, client, float64(4))
}

func TestACPPromptAcceptsWrapperFileResourceBlocks(t *testing.T) {
	manager := &recordingACPRuntimeManager{}
	store, err := NewStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	srv := NewServer(store, manager)
	srv.acpGate.runtimeManager = manager
	upload := uploadFile(t, srv, "tenant-a", "project-a", "TODO.md", []byte("# todo\n"))
	fileID := upload["id"].(string)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	client := dialACPWS(t, "ws"+trimHTTPPrefix(ts.URL)+"/acp", map[string]string{"X-Tenant-ID": "tenant-a", "X-Project-ID": "project-a"})
	defer client.close()
	client.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": map[string]any{}})
	waitForRPCID(t, client, float64(1))
	client.writeJSON(t, map[string]any{
		"jsonrpc": "2.0",
		"id":      2,
		"method":  "session/new",
		"params": map[string]any{
			"cwd":   "/workspace",
			"_meta": map[string]any{"cloudagent": map[string]any{"outer_runtime": "ags"}},
		},
	})
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
	if len(manager.workerJobs) != 1 {
		t.Fatalf("expected one prompt, got %#v", manager.workerJobs)
	}
	prompt := manager.workerJobs[0]
	if len(prompt.InputFiles) != 1 {
		t.Fatalf("expected resource file to be materialized, got %#v", prompt.InputFiles)
	}
	file := prompt.InputFiles[0]
	if file.FileID != fileID || file.WorkspacePath != "./inputs/docs/TODO.md" || file.ContentType != "text/markdown" {
		t.Fatalf("unexpected materialized file: %#v", file)
	}
	if !strings.Contains(prompt.Instruction, "./inputs/docs/TODO.md") || strings.Contains(prompt.Instruction, "# todo") {
		t.Fatalf("prompt should contain compact manifest without file body: %q", prompt.Instruction)
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
	client.writeJSON(t, map[string]any{
		"jsonrpc": "2.0",
		"id":      2,
		"method":  "session/new",
		"params": map[string]any{
			"cwd":   "/workspace",
			"_meta": map[string]any{"cloudagent": map[string]any{"outer_runtime": "ags"}},
		},
	})
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
	rowMeta := cloudAgentResultMeta(t, row)
	if row["sessionId"] != sessionID || rowMeta["read_only"] != true || rowMeta["read_only_reason"] != acpReadOnlyRuntimeNotRecovered {
		t.Fatalf("unexpected read-only list row: %#v", row)
	}
	if rowMeta["lifecycle_state"] != acpLifecycleBlockedTerminal || rowMeta["recoverability"] != acpRecoverabilityTerminal {
		t.Fatalf("read-only list row should expose terminal lifecycle contract: %#v", rowMeta)
	}

	restartedClient.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 3, "method": "session/load", "params": map[string]any{"sessionId": sessionID}})
	waitForMethod(t, restartedClient, "session/update")
	waitForMethod(t, restartedClient, "session/update")
	assertReplayDone(t, restartedClient, sessionID)
	loadResp := waitForRPCID(t, restartedClient, float64(3))
	loadResult := loadResp["result"].(map[string]any)
	loadMeta := cloudAgentResultMeta(t, loadResult)
	if loadMeta["read_only"] != true || loadMeta["read_only_reason"] != acpReadOnlyRuntimeNotRecovered {
		t.Fatalf("unexpected read-only load result: %#v", loadResult)
	}
	if loadMeta["lifecycle_state"] != acpLifecycleBlockedTerminal || loadMeta["recoverability"] != acpRecoverabilityTerminal {
		t.Fatalf("read-only load result should expose terminal lifecycle contract: %#v", loadMeta)
	}

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

func TestACPRestartedWispSessionCanRecreateRuntime(t *testing.T) {
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
	client.close()
	if err := store.db.Close(); err != nil {
		t.Fatal(err)
	}

	restartedStore, err := NewStore(root)
	if err != nil {
		t.Fatal(err)
	}
	restartedManager := &recordingACPRuntimeManager{reattachErr: fmt.Errorf("old outer gone")}
	restarted := NewServer(restartedStore, FakeWorker{OutputText: "unused"})
	restarted.acpGate.runtimeManager = restartedManager
	restartedTS := httptest.NewServer(restarted.Handler())
	defer restartedTS.Close()
	restartedClient := dialACPWS(t, "ws"+trimHTTPPrefix(restartedTS.URL)+"/acp", map[string]string{"Authorization": "Bearer test-key"})
	defer restartedClient.close()
	restartedClient.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": map[string]any{}})
	waitForRPCID(t, restartedClient, float64(1))
	restartedClient.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 2, "method": "session/list", "params": map[string]any{}})
	listResp := waitForRPCID(t, restartedClient, float64(2))
	row := listResp["result"].(map[string]any)["sessions"].([]any)[0].(map[string]any)
	rowMeta := cloudAgentResultMeta(t, row)
	if row["sessionId"] != sessionID || rowMeta["read_only"] == true {
		t.Fatalf("wisp session should remain resumable after restart: %#v", row)
	}
	if rowMeta["lifecycle_state"] != acpLifecycleDetached || rowMeta["recoverability"] != acpRecoverabilityLive {
		t.Fatalf("persisted wisp runtime should expose detached lifecycle until resume verifies it: %#v", rowMeta)
	}
	restartedClient.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 3, "method": "session/resume", "params": map[string]any{"sessionId": sessionID}})
	resumeResp := waitForRPCID(t, restartedClient, float64(3))
	if cloudAgentResultMeta(t, resumeResp["result"].(map[string]any))["read_only"] == true {
		t.Fatalf("wisp resume should recreate runtime: %#v", resumeResp)
	}
	if restartedManager.startCount() != 1 {
		t.Fatalf("restart resume should start replacement runtime, got %d", restartedManager.startCount())
	}
	starts := restartedManager.recordedStarts()
	if starts[0].OuterRuntime != outerRuntimeWisp || starts[0].RuntimeRecovery != runtimeRecoveryReattachOrRecreate {
		t.Fatalf("restore start lost wisp recovery fields: %#v", starts[0])
	}
}

func TestACPRestartedWispSessionIgnoresStaleCleanupAuthFailureWhenRecreating(t *testing.T) {
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
	client.close()
	persisted, err := store.LoadACPSession(Scope{TenantID: "default", ProjectID: "default"}, sessionID)
	if err != nil {
		t.Fatal(err)
	}
	persisted.Runtime.RuntimeID = "old_rt"
	persisted.Runtime.OuterSandboxID = "old_outer"
	if err := store.SaveACPSession(persisted); err != nil {
		t.Fatal(err)
	}
	if err := store.db.Close(); err != nil {
		t.Fatal(err)
	}

	restartedStore, err := NewStore(root)
	if err != nil {
		t.Fatal(err)
	}
	restartedManager := &recordingACPRuntimeManager{
		reattachErr:         fmt.Errorf("old outer gone"),
		closeBeforeRecreate: true,
		closeErr:            errors.New(`stop wisp outer runtime agent-session_1: wisp stop failed runtime_id=rt_1 outer_sandbox_id=outer_1 wisp_name=agent-session_1: exit=0 exited=false stdout_bytes=0 stderr_bytes=0 error="ags http 401 op=run_command sandbox_id=outer_1 domain=ap-shanghai.tencentags.com envd_port=49983: map[code:AUTHENTICATION_FAILED message:Authentication failed]"`),
	}
	restarted := NewServer(restartedStore, FakeWorker{OutputText: "unused"})
	restarted.acpGate.runtimeManager = restartedManager
	restartedTS := httptest.NewServer(restarted.Handler())
	defer restartedTS.Close()
	restartedClient := dialACPWS(t, "ws"+trimHTTPPrefix(restartedTS.URL)+"/acp", map[string]string{"Authorization": "Bearer test-key"})
	defer restartedClient.close()
	restartedClient.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": map[string]any{}})
	waitForRPCID(t, restartedClient, float64(1))

	restartedClient.writeJSON(t, map[string]any{
		"jsonrpc": "2.0",
		"id":      2,
		"method":  cloudAgentRuntimeEnsureReadyMethod,
		"params":  map[string]any{"session_id": sessionID, "cwd": "/workspace"},
	})
	restoreResp := waitForRPCID(t, restartedClient, float64(2))
	result := restoreResp["result"].(map[string]any)
	if result["ok"] != true || result["state"] != "ready" || result["read_only"] == true {
		t.Fatalf("stale cleanup auth failure should not leave session read-only: %#v", restoreResp)
	}
	if result["last_runtime_error"] != "" {
		t.Fatalf("successful recreate should clear stale runtime error: %#v", result)
	}
	restore := result["runtime_ensure_ready"].(map[string]any)
	if restore["changed"] != true || restore["outer_sandbox_id"] == restore["previous_outer_sandbox_id"] {
		t.Fatalf("runtime ensure_ready should report replacement runtime: %#v", restore)
	}
	if restartedManager.closeCount() != 1 || restartedManager.startCount() != 1 {
		t.Fatalf("expected one stale cleanup attempt and one replacement runtime, closes=%d starts=%d", restartedManager.closeCount(), restartedManager.startCount())
	}
}

func TestACPRestartedSessionRecoversFromWorkspaceRecordWhenRuntimeSMHMissing(t *testing.T) {
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
	client.writeJSON(t, map[string]any{
		"jsonrpc": "2.0",
		"id":      2,
		"method":  "session/new",
		"params":  map[string]any{"cwd": "/workspace", "_meta": map[string]any{"cloudagent": map[string]any{"outer_runtime": "wisp"}}},
	})
	sessionID := waitForRPCID(t, client, float64(2))["result"].(map[string]any)["sessionId"].(string)
	client.close()

	spaceID := "space_" + sessionID
	if err := store.EnsureWorkspace(context.Background(), WorkspaceRecord{
		WorkspaceID:           spaceID,
		Backend:               "wisp",
		ProviderWorkspaceID:   spaceID,
		State:                 "active",
		OwnerSessionID:        sessionID,
		WorkspaceVersion:      defaultWorkspaceVersion,
		WispName:              "persisted-wisp",
		WispSMHSpaceID:        spaceID,
		WispOwnsSMHSpace:      true,
		WispPackageURL:        "https://example.com/wisp.tgz",
		WispJFSPrefix:         "jfs-prefix",
		WispRootUpperSize:     "10G",
		CleanupState:          "active",
		DeleteState:           "",
		OuterCleanupPending:   false,
		LastOuterCleanupError: "",
	}); err != nil {
		t.Fatal(err)
	}
	persisted, err := store.LoadACPSession(Scope{TenantID: "default", ProjectID: "default"}, sessionID)
	if err != nil {
		t.Fatal(err)
	}
	persisted.Runtime.WispWorkspaceID = ""
	persisted.Runtime.WispSMHSpaceID = ""
	persisted.Runtime.WorkspaceID = ""
	persisted.Runtime.WispName = ""
	persisted.Runtime.WispPackageURL = ""
	persisted.Runtime.WispJFSPrefix = ""
	persisted.Runtime.WispRootUpperSize = ""
	if err := store.SaveACPSession(persisted); err != nil {
		t.Fatal(err)
	}
	if err := store.db.Close(); err != nil {
		t.Fatal(err)
	}

	restartedStore, err := NewStore(root)
	if err != nil {
		t.Fatal(err)
	}
	restartedManager := &recordingACPRuntimeManager{reattachErr: fmt.Errorf("old outer gone")}
	restarted := NewServer(restartedStore, FakeWorker{OutputText: "unused"})
	restarted.acpGate.runtimeManager = restartedManager
	restartedTS := httptest.NewServer(restarted.Handler())
	defer restartedTS.Close()
	restartedClient := dialACPWS(t, "ws"+trimHTTPPrefix(restartedTS.URL)+"/acp", map[string]string{"Authorization": "Bearer test-key"})
	defer restartedClient.close()
	restartedClient.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": map[string]any{}})
	waitForRPCID(t, restartedClient, float64(1))

	restartedClient.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 2, "method": "_cloudagent.session.status", "params": map[string]any{"session_id": sessionID}})
	status := waitForRPCID(t, restartedClient, float64(2))["result"].(map[string]any)
	if status["runtime_restorable"] != true || status["workspace_persistent"] != true || status["workspace_id"] != spaceID {
		t.Fatalf("workspace record should make stripped runtime restorable: %#v", status)
	}

	restartedClient.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 3, "method": "session/resume", "params": map[string]any{"sessionId": sessionID}})
	resumeResp := waitForRPCID(t, restartedClient, float64(3))
	if cloudAgentResultMeta(t, resumeResp["result"].(map[string]any))["read_only"] == true {
		t.Fatalf("workspace-backed session should resume writable: %#v", resumeResp)
	}
	if restartedManager.startCount() != 1 {
		t.Fatalf("workspace-backed resume should start replacement runtime, got %d", restartedManager.startCount())
	}
	starts := restartedManager.recordedStarts()
	if starts[0].OuterRuntime != outerRuntimeWisp || starts[0].RuntimeRecovery != runtimeRecoveryReattachOrRecreate {
		t.Fatalf("workspace-backed restore lost recovery request fields: %#v", starts[0])
	}
	restartedClient.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 4, "method": "_cloudagent.session.status", "params": map[string]any{"session_id": sessionID}})
	restoredStatus := waitForRPCID(t, restartedClient, float64(4))["result"].(map[string]any)
	sandbox := restoredStatus["sandbox"].(map[string]any)
	if sandbox["wisp_smh_space_id"] != spaceID || sandbox["wisp_package_url"] != "https://example.com/wisp.tgz" {
		t.Fatalf("restored runtime should be hydrated from workspace record: %#v", sandbox)
	}
}

func TestACPRuntimeEnsureReadyExtensionRecreatesWispRuntime(t *testing.T) {
	manager := &recordingACPRuntimeManager{}
	srv := newACPTestServerWithRuntime(t, manager)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	client := dialACPWS(t, "ws"+trimHTTPPrefix(ts.URL)+"/acp", map[string]string{"Authorization": "Bearer test-key"})
	defer client.close()
	client.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": map[string]any{}})
	initResp := waitForRPCID(t, client, float64(1))
	methods := initResp["result"].(map[string]any)["agentCapabilities"].(map[string]any)["_meta"].(map[string]any)["cloudagent"].(map[string]any)["methods"].([]any)
	if !containsAnyString(methods, cloudAgentRuntimeEnsureReadyMethod) {
		t.Fatalf("initialize should advertise runtime ensure_ready extension: %#v", methods)
	}

	client.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 2, "method": "session/new", "params": map[string]any{"cwd": "/workspace"}})
	sessionID := waitForRPCID(t, client, float64(2))["result"].(map[string]any)["sessionId"].(string)
	client.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 3, "method": "session/close", "params": map[string]any{"sessionId": sessionID}})
	waitForRPCID(t, client, float64(3))

	client.writeJSON(t, map[string]any{
		"jsonrpc": "2.0",
		"id":      4,
		"method":  cloudAgentRuntimeEnsureReadyMethod,
		"params":  map[string]any{"session_id": sessionID, "cwd": "/workspace"},
	})
	restoreResp := waitForRPCID(t, client, float64(4))
	result := restoreResp["result"].(map[string]any)
	if result["ok"] != true || result["session_id"] != sessionID {
		t.Fatalf("unexpected runtime ensure_ready result: %#v", result)
	}
	if _, hasCamel := result["sessionId"]; hasCamel {
		t.Fatalf("runtime ensure_ready extension must use snake_case fields: %#v", result)
	}
	if result["read_only"] == true || result["state"] != "ready" || result["runtime_status"] != "idle" {
		t.Fatalf("runtime ensure_ready should return writable ready status: %#v", result)
	}
	restore := result["runtime_ensure_ready"].(map[string]any)
	if restore["changed"] != true || restore["outer_sandbox_id"] == restore["previous_outer_sandbox_id"] {
		t.Fatalf("runtime ensure_ready should report replacement runtime: %#v", restore)
	}
	if manager.startCount() != 2 {
		t.Fatalf("runtime ensure_ready should recreate wisp runtime once, got starts=%d", manager.startCount())
	}
}

func TestACPPromptMaxIterationsReturnsStopReason(t *testing.T) {
	manager := &recordingACPRuntimeManager{promptErr: workerStop("max_iterations_exceeded", "Max iterations exceeded: 256", "max_turn_requests")}
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
			"cwd":   "/workspace",
			"_meta": map[string]any{"cloudagent": map[string]any{"outer_runtime": "ags"}},
		},
	})
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
	client.writeJSON(t, map[string]any{
		"jsonrpc": "2.0",
		"id":      2,
		"method":  "session/new",
		"params": map[string]any{
			"cwd":   "/workspace",
			"_meta": map[string]any{"cloudagent": map[string]any{"outer_runtime": "ags"}},
		},
	})
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
	client.writeJSON(t, map[string]any{
		"jsonrpc": "2.0",
		"id":      2,
		"method":  "session/new",
		"params": map[string]any{
			"cwd":   "/workspace",
			"_meta": map[string]any{"cloudagent": map[string]any{"outer_runtime": "ags"}},
		},
	})
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
	srv.acpGate.ownerID = "gateway_owner_recover"
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
			"_meta": map[string]any{"cloudagent": map[string]any{
				"sidecar_url":    "https://example.com/recover-sidecar",
				"sidecar_sha256": strings.Repeat("b", 64),
			}},
		},
	})
	sessionID := waitForRPCID(t, client, float64(2))["result"].(map[string]any)["sessionId"].(string)
	sendACPPrompt(t, client, sessionID, 3, "你好")

	if got := manager.startCount(); got != 2 {
		t.Fatalf("expected recovered runtime start, got %d starts", got)
	}
	starts := manager.recordedStarts()
	if starts[1].SidecarArtifact.URL != "https://example.com/recover-sidecar" || starts[1].SidecarArtifact.SHA256 != strings.Repeat("b", 64) {
		t.Fatalf("prompt recovery lost sidecar artifact: %#v", starts[1].SidecarArtifact)
	}
	if starts[0].OwnerID != "gateway_owner_recover" || starts[1].OwnerID != "gateway_owner_recover" {
		t.Fatalf("prompt recovery must preserve gateway owner across replacement start: %#v", starts)
	}
	if got := len(manager.promptTexts()); got != 2 {
		t.Fatalf("expected prompt retry after recover, got %d prompts", got)
	}
	if got := manager.closeCount(); got != 1 {
		t.Fatalf("expected stale runtime cleanup during recover, got %d closes", got)
	}
}

func TestACPPromptCloudAgentInboxModeReachesWorkerJob(t *testing.T) {
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
			"prompt":    []any{map[string]any{"type": "text", "text": "steer me"}},
			"_meta":     map[string]any{"cloudagent": map[string]any{"inbox_mode": "steer"}},
		},
	})
	waitForMethod(t, client, "session/update")
	waitForRPCID(t, client, float64(3))

	jobs := manager.recordedWorkerJobs()
	if len(jobs) != 1 {
		t.Fatalf("expected one job, got %d", len(jobs))
	}
	if jobs[0].ACPInboxMode != "steer" {
		t.Fatalf("expected inbox mode steer, got %#v", jobs[0])
	}
}

func TestACPPromptRejectsInvalidCloudAgentInboxMode(t *testing.T) {
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
			"prompt":    []any{map[string]any{"type": "text", "text": "bad mode"}},
			"_meta":     map[string]any{"cloudagent": map[string]any{"inbox_mode": "interrupt"}},
		},
	})
	resp := waitForRPCID(t, client, float64(3))
	if _, ok := resp["error"].(map[string]any); !ok {
		t.Fatalf("expected invalid inbox mode error, got %#v", resp)
	}
	if got := len(manager.recordedWorkerJobs()); got != 0 {
		t.Fatalf("invalid inbox mode must not create worker jobs, got %d", got)
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
			name: "old sidecar missing session input runtime command",
			err:  fmt.Errorf("acp prompt sidecar client session_id=session_1 generation=1 job_id=job_1 outer_sandbox_id=outer_1: error: unexpected client argument 'session-input'"),
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
	resumeErr := resumeResp["error"].(map[string]any)
	resumeData := resumeErr["data"].(map[string]any)
	if resumeErr["code"] != float64(-32010) || resumeData["error_code"] != "session_read_only" || resumeData["read_only_reason"] != acpReadOnlyRuntimeNotRecovered {
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
	jobs := manager.recordedWorkerJobs()
	if len(jobs) != 2 {
		t.Fatalf("expected two worker jobs, got %d", len(jobs))
	}
	if len(jobs[0].ACPSessionHistory) != 0 {
		t.Fatalf("first prompt must not seed synthetic history: %#v", jobs[0].ACPSessionHistory)
	}
	if got := jobs[1].ACPSessionHistory; len(got) != 2 ||
		got[0] != (runtimeHistoryEntry{Role: "user", Text: "first"}) ||
		got[1] != (runtimeHistoryEntry{Role: "assistant", Text: "answer: first"}) {
		t.Fatalf("second prompt should seed prior session history, got %#v", got)
	}
}

func TestACPPromptRefreshesOuterAndInnerRuntimeAfterIdleUserGap(t *testing.T) {
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

	srv.acpGate.mu.Lock()
	session := srv.acpGate.sessions[sessionID]
	session.History = append(session.History, acpHistoryEntry{Role: "user", Text: "old prompt", At: time.Now().Add(-46 * time.Second)})
	session.Runtime.InnerSandboxID = "inner_refresh_1"
	session.Runtime.InnerSandboxDomain = "mock.example"
	session.Runtime.InnerEnvdAccessToken = "inner_token"
	srv.acpGate.persistSession(session)
	srv.acpGate.mu.Unlock()

	sendACPPrompt(t, client, sessionID, 3, "refresh before prompt")
	refreshes := manager.recordedRefreshes()
	if len(refreshes) != 1 {
		t.Fatalf("expected one runtime refresh before prompt, got %d", len(refreshes))
	}
	if refreshes[0].OuterSandboxID == "" || refreshes[0].InnerSandboxID != "inner_refresh_1" {
		t.Fatalf("refresh must include both outer and inner sandbox identity: %#v", refreshes[0])
	}
}

func TestACPRuntimeRefreshRenewsSessionRunLease(t *testing.T) {
	t.Setenv("GATEWAY_ACP_RUNTIME_REFRESH_IDLE_SECONDS", "1")
	store, err := NewStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	manager := &recordingACPRuntimeManager{}
	srv := newACPTestServerWithRuntimeAndStore(store, manager)
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
		"params":  map[string]any{"cwd": "/workspace", "_meta": map[string]any{"cloudagent": map[string]any{"outer_runtime": outerRuntimeWisp}}},
	})
	sessionID := waitForRPCID(t, client, float64(2))["result"].(map[string]any)["sessionId"].(string)

	workspaceID := "lease_bug_" + sessionID
	lease, err := store.AcquireLease(context.Background(), WorkspaceLeaseRequest{
		WorkspaceID: workspaceID,
		RuntimeID:   "lease_owner_runtime",
		Provider:    "ags",
		TTL:         time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	srv.acpGate.mu.Lock()
	session := srv.acpGate.sessions[sessionID]
	session.History = append(session.History, acpHistoryEntry{Role: "user", Text: "old prompt", At: time.Now().Add(-2 * time.Second)})
	session.Runtime.RuntimeID = lease.RuntimeID
	session.Runtime.OuterRuntime = outerRuntimeWisp
	session.Runtime.RuntimeRecovery = runtimeRecoveryReattachOrRecreate
	session.Runtime.WispWorkspaceID = workspaceID
	session.Runtime.WispSMHSpaceID = workspaceID
	session.Runtime.WispLeaseID = lease.LeaseID
	session.Runtime.WispLeaseFence = lease.FencingToken
	session.Runtime.WispLeaseUntil = lease.ExpiresAt
	session.Runtime.InnerSandboxID = "inner_lease_bug"
	srv.acpGate.persistSession(session)
	srv.acpGate.mu.Unlock()

	time.Sleep(500 * time.Millisecond)
	sendACPPrompt(t, client, sessionID, 3, "refresh should renew session run lease")
	if refreshes := manager.recordedRefreshes(); len(refreshes) != 1 {
		t.Fatalf("expected one runtime refresh before prompt, got %#v", refreshes)
	}
	time.Sleep(time.Until(lease.ExpiresAt) + 250*time.Millisecond)
	stolen, err := store.AcquireLease(context.Background(), WorkspaceLeaseRequest{
		WorkspaceID: workspaceID,
		RuntimeID:   "lease_thief_runtime",
		Provider:    "ags",
		TTL:         time.Minute,
	})
	if err == nil {
		_ = store.ReleaseLease(context.Background(), stolen)
		t.Fatalf("session run lease was stealable after active runtime refresh; refresh did not renew lease (original_expires_at=%s stolen=%+v)", lease.ExpiresAt.Format(time.RFC3339Nano), stolen)
	}
	if !errors.Is(err, ErrWorkspaceLeaseHeld) {
		t.Fatalf("expected session run lease to remain held after refresh, got %v", err)
	}
}

func TestACPActivePromptLostSessionRunLeaseInterruptsRun(t *testing.T) {
	t.Setenv("GATEWAY_ACP_RUNTIME_REFRESH_ACTIVE_SECONDS", "1")
	t.Setenv("GATEWAY_ACP_RUNTIME_REFRESH_TIMEOUT_SECONDS", "2")
	store, err := NewStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	manager := newBlockingACPRuntimeManager()
	srv := newACPTestServerWithRuntimeAndStore(store, manager)
	scope := Scope{TenantID: "tenant-owner", ProjectID: "project-owner"}
	sessionID := "session_lost_session_run_lease"
	now := time.Now().UTC()
	workspaceID := "workspace_lost_session_run_lease"
	lease, err := store.AcquireLease(context.Background(), WorkspaceLeaseRequest{
		WorkspaceID: workspaceID,
		RuntimeID:   "runtime_lost_session_run_lease",
		Provider:    "ags",
		TTL:         time.Minute,
	})
	if err != nil {
		t.Fatal(err)
	}
	session := &acpSession{
		SessionID:         sessionID,
		Scope:             scope,
		Model:             defaultACPModel(),
		CWD:               "/workspace",
		State:             acpRuntimeStateReady,
		RuntimeGeneration: 1,
		Runtime: ACPSessionRuntime{
			RuntimeID:          "runtime_lost_session_run_lease",
			SandboxBackend:     "ags",
			OuterRuntime:       outerRuntimeWisp,
			RuntimeRecovery:    runtimeRecoveryReattachOrRecreate,
			OuterSandboxID:     "outer_lost_session_run_lease",
			DaemonAddr:         "fake",
			RemoteBinary:       "/tmp/hermes-sidecar",
			WispWorkspaceID:    workspaceID,
			WispSMHSpaceID:     workspaceID,
			WispLeaseID:        lease.LeaseID,
			WispLeaseFence:     lease.FencingToken,
			WispLeaseUntil:     lease.ExpiresAt,
			WorkspaceID:        workspaceID,
			WorkspaceRuntimeID: "workspace_runtime_lost_session_run_lease",
			InnerSandboxID:     "inner_lost_session_run_lease",
		},
		CreatedAt: now,
		UpdatedAt: now,
	}
	if err := store.SaveACPSession(session); err != nil {
		t.Fatal(err)
	}
	srv.acpGate.sessions[sessionID] = cloneSession(session)

	req := acpPromptRequest{Prompt: []acpPromptBlock{{Type: "text", Text: "hold until lease loss"}}}
	if err := srv.acpGate.startPrompt(nil, nil, cloneSession(session), req, false); err != nil {
		t.Fatalf("start prompt: %v", err)
	}
	manager.waitStarted(t)
	if err := store.ReleaseLease(context.Background(), lease); err != nil {
		t.Fatal(err)
	}
	thief, err := store.AcquireLease(context.Background(), WorkspaceLeaseRequest{
		WorkspaceID: workspaceID,
		RuntimeID:   "runtime_lost_session_run_lease_thief",
		Provider:    "ags",
		TTL:         time.Minute,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer store.ReleaseLease(context.Background(), thief)

	deadline := time.Now().Add(4 * time.Second)
	for {
		srv.acpGate.mu.Lock()
		current := srv.acpGate.sessions[sessionID]
		state := current.State
		hasRuns := sessionHasPromptRuns(current)
		lastErr := current.LastRuntimeError
		srv.acpGate.mu.Unlock()
		if state == acpRuntimeStateReady && !hasRuns && strings.Contains(lastErr, "workspace_lost_session_run_lease") {
			if refreshes := manager.recordedRefreshes(); len(refreshes) != 0 {
				t.Fatalf("lost session run lease must stop before sandbox refresh side effects, got refreshes=%#v", refreshes)
			}
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("active prompt was not interrupted after session run lease loss state=%s has_runs=%t last_err=%q", state, hasRuns, lastErr)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestACPFastRetryAfterLostSessionRunLeaseIsRejectedBeforeRuntimeRun(t *testing.T) {
	store, err := NewStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	manager := &recordingACPRuntimeManager{}
	srv := newACPTestServerWithRuntimeAndStore(store, manager)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	client := dialACPWS(t, "ws"+trimHTTPPrefix(ts.URL)+"/acp", map[string]string{"Authorization": "Bearer test-key"})
	defer client.close()
	client.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": map[string]any{}})
	waitForRPCID(t, client, float64(1))
	client.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 2, "method": "session/new", "params": map[string]any{"cwd": "/workspace"}})
	sessionID := waitForRPCID(t, client, float64(2))["result"].(map[string]any)["sessionId"].(string)

	srv.acpGate.mu.Lock()
	session := srv.acpGate.sessions[sessionID]
	session.Runtime.RuntimeID = "runtime_fast_retry_lost_lease"
	session.Runtime.OuterRuntime = outerRuntimeWisp
	session.Runtime.RuntimeRecovery = runtimeRecoveryReattachOrRecreate
	session.Runtime.OuterSandboxID = "outer_fast_retry_lost_lease"
	session.Runtime.WispWorkspaceID = "workspace_fast_retry_lost_lease"
	session.Runtime.WispSMHSpaceID = "workspace_fast_retry_lost_lease"
	session.Runtime.WispLeaseID = "lease_not_owned"
	session.Runtime.WispLeaseFence = 9
	session.Runtime.WispLeaseUntil = time.Now().UTC().Add(time.Minute)
	srv.acpGate.persistSession(session)
	srv.acpGate.mu.Unlock()

	client.writeJSON(t, map[string]any{
		"jsonrpc": "2.0",
		"id":      3,
		"method":  "session/prompt",
		"params":  map[string]any{"sessionId": sessionID, "prompt": []any{map[string]any{"type": "text", "text": "should not run"}}},
	})
	resp := waitForRPCID(t, client, float64(3))
	if _, ok := resp["error"].(map[string]any); !ok {
		t.Fatalf("expected prompt rejection after lost session run lease, got %#v", resp)
	}
	if got := len(manager.promptTexts()); got != 0 {
		t.Fatalf("lost session run lease must reject before worker run, got prompts=%d", got)
	}
	if refreshes := manager.recordedRefreshes(); len(refreshes) != 0 {
		t.Fatalf("lost session run lease must reject before runtime refresh, got refreshes=%#v", refreshes)
	}
}

func TestSessionRunLeaseLostErrorIncludesRuntimeOwnership(t *testing.T) {
	if !isSessionRunLeaseLostError(RuntimeOwnershipHeldError{SessionID: "session_1"}) {
		t.Fatal("runtime ownership held must be classified as session run lease loss")
	}
}

func TestACPPromptSkipsRuntimeRefreshWhenPreviousUserMessageIsRecent(t *testing.T) {
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

	srv.acpGate.mu.Lock()
	session := srv.acpGate.sessions[sessionID]
	session.History = append(session.History, acpHistoryEntry{Role: "user", Text: "recent prompt", At: time.Now().Add(-44 * time.Second)})
	session.Runtime.InnerSandboxID = "inner_recent_1"
	srv.acpGate.persistSession(session)
	srv.acpGate.mu.Unlock()

	sendACPPrompt(t, client, sessionID, 3, "do not refresh yet")
	if refreshes := manager.recordedRefreshes(); len(refreshes) != 0 {
		t.Fatalf("recent prompt must not refresh runtime, got %#v", refreshes)
	}
}

func TestACPPromptRefreshesRuntimeWhileActive(t *testing.T) {
	t.Setenv("GATEWAY_ACP_RUNTIME_REFRESH_ACTIVE_SECONDS", "1")
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

	srv.acpGate.mu.Lock()
	session := srv.acpGate.sessions[sessionID]
	session.Runtime.InnerSandboxID = "inner_active_1"
	session.Runtime.InnerSandboxDomain = "mock.example"
	session.Runtime.InnerEnvdAccessToken = "inner_token"
	srv.acpGate.persistSession(session)
	srv.acpGate.mu.Unlock()

	client.writeJSON(t, map[string]any{
		"jsonrpc": "2.0",
		"id":      3,
		"method":  "session/prompt",
		"params": map[string]any{
			"sessionId": sessionID,
			"prompt":    []any{map[string]any{"type": "text", "text": "long running"}},
		},
	})
	manager.waitStarted(t)
	manager.waitRefreshCount(t, 1)
	refreshes := manager.recordedRefreshes()
	if refreshes[0].OuterSandboxID == "" || refreshes[0].InnerSandboxID != "inner_active_1" {
		t.Fatalf("active refresh must include both outer and inner sandbox identity: %#v", refreshes[0])
	}
	client.writeJSON(t, map[string]any{"jsonrpc": "2.0", "method": "session/cancel", "params": map[string]any{"sessionId": sessionID}})
	promptResp := waitForRPCID(t, client, float64(3))
	if stop := promptResp["result"].(map[string]any)["stopReason"]; stop != "cancelled" {
		t.Fatalf("expected cancelled stopReason, got %#v", promptResp)
	}
}

func TestACPPromptExecutesThroughWorkerRunWithSessionRuntime(t *testing.T) {
	manager := &recordingACPRuntimeManager{}
	srv := newACPTestServerWithRuntime(t, manager)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	client := dialACPWS(t, "ws"+trimHTTPPrefix(ts.URL)+"/acp", map[string]string{"Authorization": "Bearer test-key"})
	defer client.close()
	client.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": map[string]any{}})
	waitForRPCID(t, client, float64(1))
	client.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 2, "method": "session/new", "params": map[string]any{}})
	newResp := waitForRPCID(t, client, float64(2))
	sessionID := newResp["result"].(map[string]any)["sessionId"].(string)

	sendACPPrompt(t, client, sessionID, 3, "worker run")

	jobs := manager.recordedWorkerJobs()
	if len(jobs) != 1 {
		t.Fatalf("expected one Worker.Run job, got %d", len(jobs))
	}
	job := jobs[0]
	if job.ACPSessionID != sessionID || job.ACPSessionGeneration != 1 {
		t.Fatalf("worker job missing ACP session identity: %#v", job)
	}
	if job.ACPSessionRuntime.OuterSandboxID == "" || job.ACPSessionRuntime.RuntimeID == "" {
		t.Fatalf("worker job missing ACP runtime host identity: %#v", job.ACPSessionRuntime)
	}
	if job.Instruction != "worker run" || job.CWD != sidecarRequestCWD() {
		t.Fatalf("unexpected worker job prompt fields: %#v", job)
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
					"sandbox_backend": "talos",
				},
			},
		},
	})
	waitForRPCID(t, client, float64(2))

	if got := manager.startBackends(); len(got) != 1 || got[0] != "talos" {
		t.Fatalf("runtime start sandbox backend = %#v, want [talos]", got)
	}
}

func TestACPSessionNewFailureDoesNotLeaveListedSession(t *testing.T) {
	manager := &recordingACPRuntimeManager{startErr: fmt.Errorf("agent version %q is not registered", "missing.agent-version.e2e")}
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
					"agent_version": "missing.agent-version.e2e",
				},
			},
		},
	})
	newResp := waitForRPCID(t, client, float64(2))
	if _, ok := newResp["error"].(map[string]any); !ok {
		t.Fatalf("expected session/new to fail: %#v", newResp)
	}

	client.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 3, "method": "session/list", "params": map[string]any{}})
	listResp := waitForRPCID(t, client, float64(3))
	sessions := listResp["result"].(map[string]any)["sessions"].([]any)
	if len(sessions) != 0 {
		t.Fatalf("failed session/new must not leave listed sessions: %#v", sessions)
	}
}

func TestACPSessionNewPassesAgentAndWorkspaceVersions(t *testing.T) {
	manager := &recordingACPRuntimeManager{}
	srv := newACPTestServerWithRuntime(t, manager)
	srv.acpGate.ownerID = "gateway_owner_session_new"
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
					"agent_version":     "builtin.v1",
					"workspace_version": "builtin.v1",
				},
			},
		},
	})
	waitForRPCID(t, client, float64(2))

	starts := manager.recordedStarts()
	if len(starts) != 1 {
		t.Fatalf("expected one start request, got %d", len(starts))
	}
	start := starts[0]
	if start.AgentVersion != "builtin.v1" || start.WorkspaceVersion != "builtin.v1" {
		t.Fatalf("unexpected version selection: %#v", start)
	}
	if start.OwnerID != "gateway_owner_session_new" {
		t.Fatalf("session/new must bind runtime start to gateway owner, got %#v", start)
	}
}

func TestACPSessionNewPassesCustomSidecarURL(t *testing.T) {
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
					"sidecar_url": "https://example.com/cloudagent-sidecar-linux-amd64-custom",
				},
			},
		},
	})
	waitForRPCID(t, client, float64(2))

	starts := manager.recordedStarts()
	if len(starts) != 1 {
		t.Fatalf("expected one start request, got %d", len(starts))
	}
	artifact := starts[0].SidecarArtifact
	if artifact.URL != "https://example.com/cloudagent-sidecar-linux-amd64-custom" {
		t.Fatalf("unexpected sidecar url: %#v", artifact)
	}
	if artifact.SHA256 != "" || artifact.SigURL != "" || artifact.SigningKeyID != "" {
		t.Fatalf("gateway should pass raw sidecar artifact to runtime validator: %#v", artifact)
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
	client.writeJSON(t, map[string]any{
		"jsonrpc": "2.0",
		"id":      2,
		"method":  "session/new",
		"params": map[string]any{
			"cwd":   "/workspace",
			"_meta": map[string]any{"cloudagent": map[string]any{"outer_runtime": "ags"}},
		},
	})
	sessionID := waitForRPCID(t, client, float64(2))["result"].(map[string]any)["sessionId"].(string)
	sendACPPrompt(t, client, sessionID, 3, "remember me")
	client.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 4, "method": "session/close", "params": map[string]any{"sessionId": sessionID}})
	waitForRPCID(t, client, float64(4))
	if manager.closeCount() != 1 {
		t.Fatalf("expected one runtime close, got %d", manager.closeCount())
	}
	client.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 5, "method": "session/load", "params": map[string]any{"sessionId": sessionID}})
	waitForMethod(t, client, "session/update")
	waitForMethod(t, client, "session/update")
	assertReplayDone(t, client, sessionID)
	waitForRPCID(t, client, float64(5))
	if manager.startCount() != 1 {
		t.Fatalf("session/load must not start runtime, got starts=%d", manager.startCount())
	}
	client.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 6, "method": "session/resume", "params": map[string]any{"sessionId": sessionID}})
	resumeResp := waitForRPCID(t, client, float64(6))
	resumeErr := resumeResp["error"].(map[string]any)
	resumeData := resumeErr["data"].(map[string]any)
	if resumeErr["code"] != float64(-32010) || resumeData["error_code"] != "session_read_only" || resumeData["read_only_reason"] != acpReadOnlyRuntimeNotRecovered {
		t.Fatalf("session/resume after close should fail read-only, got %#v", resumeResp)
	}
	if manager.startCount() != 1 {
		t.Fatalf("session/resume must not start fresh runtime, got starts=%d", manager.startCount())
	}
}

func TestACPWispCloseResumeRecreatesRuntime(t *testing.T) {
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
			"_meta": map[string]any{"cloudagent": map[string]any{
				"outer_runtime": "wisp",
			}},
		},
	})
	sessionID := waitForRPCID(t, client, float64(2))["result"].(map[string]any)["sessionId"].(string)
	if manager.startCount() != 1 {
		t.Fatalf("expected initial runtime start, got %d", manager.startCount())
	}
	client.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 3, "method": "session/close", "params": map[string]any{"sessionId": sessionID}})
	waitForRPCID(t, client, float64(3))
	if manager.closeCount() != 1 {
		t.Fatalf("expected close to release runtime once, got %d", manager.closeCount())
	}
	srv.acpGate.mu.Lock()
	srv.acpGate.sessions[sessionID].LastRuntimeError = "old runtime error"
	srv.acpGate.sessions[sessionID].ReadOnlyReason = acpReadOnlyRuntimeNotRecovered
	srv.acpGate.sessions[sessionID].Runtime.WispName = ""
	srv.acpGate.mu.Unlock()
	client.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 4, "method": "session/list", "params": map[string]any{}})
	listResp := waitForRPCID(t, client, float64(4))
	listRow := listResp["result"].(map[string]any)["sessions"].([]any)[0].(map[string]any)
	listMeta := cloudAgentResultMeta(t, listRow)
	if listRow["sessionId"] != sessionID || listMeta["read_only"] == true || listMeta["read_only_reason"] != nil {
		t.Fatalf("recoverable wisp session without cached wisp name should not be listed read-only: %#v", listRow)
	}
	client.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 5, "method": "session/resume", "params": map[string]any{"sessionId": sessionID}})
	resumeResp := waitForRPCID(t, client, float64(5))
	resumeResult := resumeResp["result"].(map[string]any)
	resumeMeta := cloudAgentResultMeta(t, resumeResult)
	if resumeMeta["read_only"] == true || resumeMeta["read_only_reason"] != nil {
		t.Fatalf("wisp session should be writable after restore: %#v", resumeResp)
	}
	if manager.startCount() != 2 {
		t.Fatalf("resume should recreate wisp runtime, got starts=%d", manager.startCount())
	}
	starts := manager.recordedStarts()
	if starts[1].OuterRuntime != outerRuntimeWisp {
		t.Fatalf("restored runtime should request wisp outer, got %#v", starts[1])
	}
	client.writeJSON(t, map[string]any{
		"jsonrpc": "2.0",
		"id":      6,
		"method":  "_cloudagent.session.status",
		"params":  map[string]any{"session_id": sessionID},
	})
	status := waitForRPCID(t, client, float64(6))["result"].(map[string]any)
	if status["last_runtime_error"] != "" {
		t.Fatalf("resume should clear stale runtime error: %#v", status)
	}
}

func TestACPWispSessionSupportsRepeatedCloseResumeAndPromptRestore(t *testing.T) {
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
			"_meta": map[string]any{"cloudagent": map[string]any{
				"outer_runtime": "wisp",
			}},
		},
	})
	sessionID := waitForRPCID(t, client, float64(2))["result"].(map[string]any)["sessionId"].(string)

	client.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 3, "method": "session/close", "params": map[string]any{"sessionId": sessionID}})
	waitForRPCID(t, client, float64(3))
	if manager.closeCount() != 1 {
		t.Fatalf("first close should release runtime once, got %d", manager.closeCount())
	}
	client.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 4, "method": "session/resume", "params": map[string]any{"sessionId": sessionID}})
	firstResume := waitForRPCID(t, client, float64(4))["result"].(map[string]any)
	if meta := cloudAgentResultMeta(t, firstResume); meta["read_only"] == true || meta["read_only_reason"] != nil {
		t.Fatalf("first resume should be writable: %#v", firstResume)
	}
	if manager.startCount() != 2 {
		t.Fatalf("first resume should recreate runtime, got starts=%d", manager.startCount())
	}

	client.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 5, "method": "session/close", "params": map[string]any{"sessionId": sessionID}})
	waitForRPCID(t, client, float64(5))
	if manager.closeCount() != 2 {
		t.Fatalf("second close should release runtime once, got %d", manager.closeCount())
	}
	sendACPPrompt(t, client, sessionID, 6, "restore from prompt after second close")
	if manager.startCount() != 3 {
		t.Fatalf("prompt after second close should recreate runtime, got starts=%d", manager.startCount())
	}
	jobs := manager.recordedWorkerJobs()
	if len(jobs) == 0 || jobs[len(jobs)-1].ACPSessionID != sessionID || jobs[len(jobs)-1].Instruction != "restore from prompt after second close" {
		t.Fatalf("prompt restore did not reach runtime worker: %#v", jobs)
	}

	client.writeJSON(t, map[string]any{
		"jsonrpc": "2.0",
		"id":      7,
		"method":  "_cloudagent.session.status",
		"params":  map[string]any{"session_id": sessionID},
	})
	status := waitForRPCID(t, client, float64(7))["result"].(map[string]any)
	if status["read_only"] == true || status["read_only_reason"] != "" || status["last_runtime_error"] != "" {
		t.Fatalf("session should remain writable after repeated restore: %#v", status)
	}

	loader := dialACPWS(t, "ws"+trimHTTPPrefix(ts.URL)+"/acp", map[string]string{"Authorization": "Bearer test-key"})
	defer loader.close()
	loader.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 8, "method": "initialize", "params": map[string]any{}})
	waitForRPCID(t, loader, float64(8))
	loader.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 9, "method": "session/load", "params": map[string]any{"sessionId": sessionID}})
	userReplay := loader.readJSON(t)
	assertSessionUpdateKindFrame(t, userReplay, sessionID, "user_message_chunk")
	assistantReplay := loader.readJSON(t)
	assertSessionUpdateKindFrame(t, assistantReplay, sessionID, "agent_message_chunk")
	assertReplayDone(t, loader, sessionID)
	waitForRPCID(t, loader, float64(9))
	if manager.startCount() != 3 {
		t.Fatalf("session/load after repeated restore must not recreate runtime, got starts=%d", manager.startCount())
	}
}

func TestACPWispClosePromptRecreatesRuntime(t *testing.T) {
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
			"_meta": map[string]any{"cloudagent": map[string]any{
				"outer_runtime": "wisp",
			}},
		},
	})
	sessionID := waitForRPCID(t, client, float64(2))["result"].(map[string]any)["sessionId"].(string)
	client.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 3, "method": "session/close", "params": map[string]any{"sessionId": sessionID}})
	waitForRPCID(t, client, float64(3))
	sendACPPrompt(t, client, sessionID, 4, "restore by prompt")
	if manager.startCount() != 2 {
		t.Fatalf("direct prompt should recreate closed wisp runtime, got starts=%d", manager.startCount())
	}
}

func TestACPWispRuntimeRestorePreservesSidecarArtifact(t *testing.T) {
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
	client.writeJSON(t, map[string]any{
		"jsonrpc": "2.0",
		"id":      2,
		"method":  "session/new",
		"params": map[string]any{
			"cwd": "/workspace",
			"_meta": map[string]any{"cloudagent": map[string]any{
				"outer_runtime":  "wisp",
				"sidecar_url":    "https://example.com/custom-sidecar",
				"sidecar_sha256": strings.Repeat("a", 64),
			}},
		},
	})
	sessionID := waitForRPCID(t, client, float64(2))["result"].(map[string]any)["sessionId"].(string)
	client.close()
	if err := store.db.Close(); err != nil {
		t.Fatal(err)
	}

	restartedStore, err := NewStore(root)
	if err != nil {
		t.Fatal(err)
	}
	restartedManager := &recordingACPRuntimeManager{reattachErr: fmt.Errorf("old outer gone")}
	restarted := NewServer(restartedStore, FakeWorker{OutputText: "unused"})
	restarted.acpGate.runtimeManager = restartedManager
	restartedTS := httptest.NewServer(restarted.Handler())
	defer restartedTS.Close()
	restartedClient := dialACPWS(t, "ws"+trimHTTPPrefix(restartedTS.URL)+"/acp", map[string]string{"Authorization": "Bearer test-key"})
	defer restartedClient.close()
	restartedClient.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": map[string]any{}})
	waitForRPCID(t, restartedClient, float64(1))
	restartedClient.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 2, "method": "session/resume", "params": map[string]any{"sessionId": sessionID}})
	waitForRPCID(t, restartedClient, float64(2))
	starts := restartedManager.recordedStarts()
	if len(starts) != 1 {
		t.Fatalf("expected one replacement start, got %#v", starts)
	}
	if starts[0].SidecarArtifact.URL != "https://example.com/custom-sidecar" || starts[0].SidecarArtifact.SHA256 != strings.Repeat("a", 64) {
		t.Fatalf("restore lost sidecar artifact: %#v", starts[0].SidecarArtifact)
	}
}

func TestACPWispPromptRecreatesUnavailableRuntime(t *testing.T) {
	manager := &recordingACPRuntimeManager{reattachErr: fmt.Errorf("runtime gone")}
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
			"_meta": map[string]any{"cloudagent": map[string]any{
				"outer_runtime": "wisp",
			}},
		},
	})
	sessionID := waitForRPCID(t, client, float64(2))["result"].(map[string]any)["sessionId"].(string)
	sendACPPrompt(t, client, sessionID, 3, "after restore")
	if manager.startCount() != 2 {
		t.Fatalf("prompt preflight should recreate unavailable wisp runtime, got starts=%d", manager.startCount())
	}
	jobs := manager.recordedWorkerJobs()
	if len(jobs) != 1 || jobs[0].ACPSessionRuntime.OuterSandboxID != "outer_2" {
		t.Fatalf("prompt should run on recreated runtime, got %#v", jobs)
	}
}

func TestACPWispDeleteUsesRuntimeDelete(t *testing.T) {
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
			"_meta": map[string]any{"cloudagent": map[string]any{
				"outer_runtime": "wisp",
			}},
		},
	})
	sessionID := waitForRPCID(t, client, float64(2))["result"].(map[string]any)["sessionId"].(string)
	client.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 3, "method": "session/delete", "params": map[string]any{"sessionId": sessionID}})
	waitForRPCID(t, client, float64(3))
	if manager.deleteCount() != 1 {
		t.Fatalf("delete should call runtime delete once, got %d", manager.deleteCount())
	}
}

func TestWispHermesBootstrapManifestMatchesRuntimeIdentity(t *testing.T) {
	req := ACPSessionRuntimeStartRequest{SessionID: "session_manifest"}
	runtime := ACPSessionRuntime{
		AgentVersion:  "agent.v1",
		SidecarURL:    "https://example.com/sidecar",
		SidecarSHA256: strings.Repeat("c", 64),
	}
	manifest := wispHermesBootstrapManifestFor(runtime, req)
	if !manifest.matches(runtime, req) {
		t.Fatalf("expected manifest to match originating runtime")
	}
	changedSidecar := runtime
	changedSidecar.SidecarSHA256 = strings.Repeat("d", 64)
	if manifest.matches(changedSidecar, req) {
		t.Fatalf("manifest must not match a different sidecar sha")
	}
	changedAgent := runtime
	changedAgent.AgentVersion = "agent.v2"
	if manifest.matches(changedAgent, req) {
		t.Fatalf("manifest must not match a different agent version")
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
	client.writeJSON(t, map[string]any{"jsonrpc": "2.0", "method": "session/cancel", "params": map[string]any{"sessionId": sessionID}})
	promptResp := waitForRPCID(t, client, float64(3))
	stop := promptResp["result"].(map[string]any)["stopReason"]
	if stop != "cancelled" {
		t.Fatalf("expected cancelled stopReason, got %#v", promptResp)
	}
	deadline := time.Now().Add(2 * time.Second)
	for {
		manager.mu.Lock()
		cancelCount := len(manager.cancels)
		closeCount := len(manager.closes)
		manager.mu.Unlock()
		if cancelCount == 1 && closeCount == 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("expected runtime cancel without close after cancel, got cancels=%d closes=%d", cancelCount, closeCount)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestACPTransportDisconnectDoesNotCancelPromptRun(t *testing.T) {
	store, err := NewStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	manager := newReleasableACPRuntimeManager()
	srv := newACPTestServerWithRuntimeAndStore(store, manager)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	client := dialACPWS(t, "ws"+trimHTTPPrefix(ts.URL)+"/acp", map[string]string{"Authorization": "Bearer test-key"})
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
			"prompt":    []any{map[string]any{"type": "text", "text": "survive disconnect"}},
		},
	})
	manager.waitStarted(t)
	client.close()
	manager.releaseAll()
	manager.waitDone(t)

	scope := Scope{TenantID: "default", ProjectID: "default"}
	deadline := time.Now().Add(2 * time.Second)
	for {
		session, err := store.LoadACPSession(scope, sessionID)
		if err == nil && session.State == acpRuntimeStateReady && historyContainsText(session.History, "assistant", "answer: survive disconnect") {
			if len(session.Events) == 0 {
				t.Fatalf("expected completed prompt to persist replay events")
			}
			manager.mu.Lock()
			cancelCount := len(manager.cancels)
			manager.mu.Unlock()
			if cancelCount != 0 {
				t.Fatalf("transport disconnect must not cancel runtime, got cancels=%d", cancelCount)
			}
			return
		}
		if time.Now().After(deadline) {
			if err != nil {
				t.Fatalf("prompt did not persist after disconnect: %v", err)
			}
			t.Fatalf("prompt did not finish ready after disconnect")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestACPActivePromptSubmitsSecondPromptToRuntime(t *testing.T) {
	manager := newReleasableACPRuntimeManager()
	srv := newACPTestServerWithRuntime(t, manager)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	client := dialACPWS(t, "ws"+trimHTTPPrefix(ts.URL)+"/acp", map[string]string{"Authorization": "Bearer test-key"})
	defer client.close()
	client.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": map[string]any{}})
	waitForRPCID(t, client, float64(1))
	client.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 2, "method": "session/new", "params": map[string]any{"cwd": "/workspace"}})
	sessionID := waitForRPCID(t, client, float64(2))["result"].(map[string]any)["sessionId"].(string)

	client.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 3, "method": "session/prompt", "params": map[string]any{"sessionId": sessionID, "prompt": []any{map[string]any{"type": "text", "text": "first"}}}})
	manager.waitStarted(t)
	client.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 4, "method": "session/prompt", "params": map[string]any{"sessionId": sessionID, "prompt": []any{map[string]any{"type": "text", "text": "second"}}}})

	manager.waitWorkerJobCount(t, 2)
	prompts := manager.promptTexts()
	if len(prompts) != 2 || prompts[0] != "first" || prompts[1] != "second" {
		t.Fatalf("expected both prompts to reach runtime, got %#v", prompts)
	}
	manager.releaseAll()
	waitForRPCIDs(t, client, float64(3), float64(4))
	manager.waitDone(t)
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

func TestACPResumeRetriesDeferredRuntimeCleanup(t *testing.T) {
	manager := &recordingACPRuntimeManager{closeFailures: 1}
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
			"cwd":   "/workspace",
			"_meta": map[string]any{"cloudagent": map[string]any{"outer_runtime": "ags"}},
		},
	})
	sessionID := waitForRPCID(t, client, float64(2))["result"].(map[string]any)["sessionId"].(string)

	client.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 3, "method": "session/close", "params": map[string]any{"sessionId": sessionID}})
	closeResp := waitForRPCID(t, client, float64(3))
	if _, ok := closeResp["result"].(map[string]any); !ok {
		t.Fatalf("session/close should acknowledge closed state even when runtime cleanup is deferred: %#v", closeResp)
	}

	client.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 4, "method": "session/resume", "params": map[string]any{"sessionId": sessionID}})
	resumeResp := waitForRPCID(t, client, float64(4))
	resumeResult := resumeResp["result"].(map[string]any)
	if _, hasSessionID := resumeResult["sessionId"]; hasSessionID || cloudAgentResultMeta(t, resumeResult)["state"] != "ready" {
		t.Fatalf("expected resume to reattach existing runtime: %#v", resumeResp)
	}
	if manager.startCount() != 1 {
		t.Fatalf("resume after cleanup failure must not start a second runtime, got starts=%d", manager.startCount())
	}

	client.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 5, "method": "session/close", "params": map[string]any{"sessionId": sessionID}})
	retryCloseResp := waitForRPCID(t, client, float64(5))
	if _, ok := retryCloseResp["result"].(map[string]any); !ok {
		t.Fatalf("expected retry close to succeed: %#v", retryCloseResp)
	}
	client.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 6, "method": "session/resume", "params": map[string]any{"sessionId": sessionID}})
	secondResumeResp := waitForRPCID(t, client, float64(6))
	secondResumeErr := secondResumeResp["error"].(map[string]any)
	secondResumeData := secondResumeErr["data"].(map[string]any)
	if secondResumeErr["code"] != float64(-32010) || secondResumeData["error_code"] != "session_read_only" || secondResumeData["read_only_reason"] != acpReadOnlyRuntimeNotRecovered {
		t.Fatalf("unexpected resume response: %#v", secondResumeResp)
	}
	if manager.startCount() != 1 {
		t.Fatalf("resume after close must not start a fresh runtime, got starts=%d", manager.startCount())
	}
}

func TestACPWispCloseCheckpointFailureReturnsJSONRPCError(t *testing.T) {
	closeErr := errors.New(`stop wisp outer runtime agent-session_1: wispclient: http 500: {"error":"juicefs-smount meta-barrier /mnt/cloudagent-wisp: checkpoint cut failed: input/output error"}`)
	manager := &recordingACPRuntimeManager{closeErr: closeErr}
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
			"cwd":   "/workspace",
			"_meta": map[string]any{"cloudagent": map[string]any{"outer_runtime": "wisp"}},
		},
	})
	sessionID := waitForRPCID(t, client, float64(2))["result"].(map[string]any)["sessionId"].(string)

	client.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 3, "method": "session/close", "params": map[string]any{"sessionId": sessionID}})
	closeResp := waitForRPCID(t, client, float64(3))
	errorObject, ok := closeResp["error"].(map[string]any)
	if !ok {
		t.Fatalf("wisp checkpoint failure must not be acknowledged as close success: %#v", closeResp)
	}
	if !strings.Contains(fmt.Sprint(errorObject["message"]), "checkpoint cut failed") {
		t.Fatalf("close error should expose checkpoint failure: %#v", errorObject)
	}
	if manager.closeCount() != 1 {
		t.Fatalf("expected one close attempt, got %d", manager.closeCount())
	}

	client.writeJSON(t, map[string]any{
		"jsonrpc": "2.0",
		"id":      4,
		"method":  cloudAgentSessionStatusMethod,
		"params":  map[string]any{"session_id": sessionID},
	})
	status := waitForRPCID(t, client, float64(4))["result"].(map[string]any)
	if status["lifecycle_state"] != acpLifecycleRestoreFailedRetryable || status["recoverability"] != acpRecoverabilityRetryable {
		t.Fatalf("failed wisp close should leave an explicit retryable failure state: %#v", status)
	}
	if !strings.Contains(fmt.Sprint(status["last_runtime_error"]), "checkpoint cut failed") {
		t.Fatalf("status should retain checkpoint failure diagnostics: %#v", status)
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

	resumed, err := gateway.resumeSession(scope, session.SessionID, "/workspace")
	if resumed.SessionID != session.SessionID {
		t.Fatalf("unexpected resumed session: %#v", resumed)
	}
	var readOnly acpReadOnlyError
	if !errors.As(err, &readOnly) || readOnly.Reason != acpReadOnlyRuntimeNotRecovered {
		t.Fatalf("resume during cleanup should fail read-only, got %T %v", err, err)
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

func TestACPRuntimeEnsureSingleflight(t *testing.T) {
	manager := newBlockingEnsureACPRuntimeManager()
	gateway := NewACPGateway(nil, nil)
	gateway.runtimeManager = manager

	scope := Scope{TenantID: "tenant-live", ProjectID: "project-live"}
	runtime := ACPSessionRuntime{
		OuterRuntime:     outerRuntimeWisp,
		RuntimeRecovery:  runtimeRecoveryReattachOrRecreate,
		WispSMHSpaceID:   "space-singleflight",
		WorkspaceVersion: defaultWorkspaceVersion,
		AgentVersion:     defaultAgentVersion,
	}
	req := ACPSessionRuntimeStartRequest{
		SessionID:        "session_singleflight",
		Scope:            scope,
		CWD:              "/workspace",
		Generation:       3,
		OuterRuntime:     outerRuntimeWisp,
		RuntimeRecovery:  runtimeRecoveryReattachOrRecreate,
		WorkspaceVersion: defaultWorkspaceVersion,
		AgentVersion:     defaultAgentVersion,
	}

	type ensureResult struct {
		runtime ACPSessionRuntime
		err     error
	}
	results := make(chan ensureResult, 2)
	go func() {
		checked, err := gateway.ensureSessionRuntime(req.SessionID, req.Generation, runtime, req, nil, false)
		results <- ensureResult{runtime: checked, err: err}
	}()
	manager.waitStarted(t)
	go func() {
		checked, err := gateway.ensureSessionRuntime(req.SessionID, req.Generation, runtime, req, nil, false)
		results <- ensureResult{runtime: checked, err: err}
	}()
	time.Sleep(20 * time.Millisecond)
	if manager.ensureCount() != 1 {
		t.Fatalf("second ensure should wait on the in-flight runtime ensure, got %d", manager.ensureCount())
	}
	manager.releaseAll()

	for i := 0; i < 2; i++ {
		select {
		case result := <-results:
			if result.err != nil {
				t.Fatalf("ensure failed: %v", result.err)
			}
			if result.runtime.RuntimeID != "rt_ensured" {
				t.Fatalf("unexpected runtime: %#v", result.runtime)
			}
		case <-time.After(2 * time.Second):
			t.Fatal("timed out waiting for ensure result")
		}
	}
	if manager.ensureCount() != 1 {
		t.Fatalf("expected one runtime ensure, got %d", manager.ensureCount())
	}
}

func TestACPSessionStatusReportsRuntimeRestoreInFlight(t *testing.T) {
	manager := newBlockingEnsureACPRuntimeManager()
	gateway := NewACPGateway(nil, nil)
	gateway.runtimeManager = manager
	scope := Scope{TenantID: "tenant-live", ProjectID: "project-live"}
	session, err := gateway.createSession(context.Background(), scope, acpSessionRequest{
		CWD: "/workspace",
		Meta: acpSessionMeta{CloudAgent: acpCloudAgentSessionMeta{
			OuterRuntime:     outerRuntimeWisp,
			RuntimeRecovery:  runtimeRecoveryReattachOrRecreate,
			WorkspaceVersion: defaultWorkspaceVersion,
			AgentVersion:     defaultAgentVersion,
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	req := sessionRuntimeStartRequest(session)
	result := make(chan error, 1)
	go func() {
		_, err := gateway.ensureSessionRuntime(session.SessionID, session.RuntimeGeneration, session.Runtime, req, nil, false)
		result <- err
	}()
	manager.waitStarted(t)

	status, err := gateway.cloudAgentSessionStatus(scope, session.SessionID)
	if err != nil {
		t.Fatal(err)
	}
	if status["runtime_restore_in_flight"] != true {
		t.Fatalf("status should expose in-flight runtime restore: %#v", status)
	}
	if status["runtime_restore_started_at"] == "" {
		t.Fatalf("status should expose restore start time: %#v", status)
	}
	elapsed, ok := status["runtime_restore_elapsed_ms"].(int64)
	if !ok || elapsed < 0 {
		t.Fatalf("status should expose restore elapsed milliseconds: %#v", status)
	}

	manager.releaseAll()
	select {
	case err := <-result:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for runtime ensure")
	}
	status, err = gateway.cloudAgentSessionStatus(scope, session.SessionID)
	if err != nil {
		t.Fatal(err)
	}
	if status["runtime_restore_in_flight"] != false {
		t.Fatalf("status should clear in-flight runtime restore after ensure exits: %#v", status)
	}
}

func TestACPRuntimeEnsureSQLiteLockAcrossGateways(t *testing.T) {
	root := t.TempDir()
	storeA, err := NewStore(root)
	if err != nil {
		t.Fatal(err)
	}
	storeB, err := NewStore(root)
	if err != nil {
		t.Fatal(err)
	}
	manager := newBlockingEnsureACPRuntimeManager()
	gatewayA := NewACPGateway(storeA, nil)
	gatewayA.runtimeManager = manager
	gatewayB := NewACPGateway(storeB, nil)
	gatewayB.runtimeManager = manager

	scope := Scope{TenantID: "tenant-live", ProjectID: "project-live"}
	runtime := ACPSessionRuntime{
		OuterRuntime:     outerRuntimeWisp,
		RuntimeRecovery:  runtimeRecoveryReattachOrRecreate,
		WispSMHSpaceID:   "space-distributed",
		WorkspaceVersion: defaultWorkspaceVersion,
		AgentVersion:     defaultAgentVersion,
	}
	session := &acpSession{
		SessionID:         "session_distributed",
		Scope:             scope,
		Model:             defaultACPModel(),
		CWD:               "/workspace",
		State:             acpRuntimeStateClosed,
		Closed:            true,
		RuntimeGeneration: 5,
		Runtime:           runtime,
		CreatedAt:         time.Now().UTC(),
		UpdatedAt:         time.Now().UTC(),
	}
	if err := storeA.SaveACPSession(session); err != nil {
		t.Fatal(err)
	}
	gatewayA.sessions[session.SessionID] = cloneSession(session)
	gatewayB.sessions[session.SessionID] = cloneSession(session)
	req := sessionRuntimeStartRequest(session)

	makeCommit := func(gateway *ACPGateway) func(ACPSessionRuntime) error {
		return func(checked ACPSessionRuntime) error {
			gateway.mu.Lock()
			current := gateway.sessions[session.SessionID]
			if current == nil {
				current = cloneSession(session)
				gateway.sessions[session.SessionID] = current
			}
			current.Runtime = checked
			current.State = acpRuntimeStateReady
			current.Closed = false
			current.LastRuntimeError = ""
			current.ReadOnlyReason = ""
			current.UpdatedAt = time.Now().UTC()
			gateway.persistSession(current)
			gateway.mu.Unlock()
			return nil
		}
	}

	type ensureResult struct {
		runtime ACPSessionRuntime
		err     error
	}
	results := make(chan ensureResult, 2)
	go func() {
		checked, err := gatewayA.ensureSessionRuntime(req.SessionID, req.Generation, runtime, req, makeCommit(gatewayA), false)
		results <- ensureResult{runtime: checked, err: err}
	}()
	manager.waitStarted(t)
	go func() {
		checked, err := gatewayB.ensureSessionRuntime(req.SessionID, req.Generation, runtime, req, makeCommit(gatewayB), false)
		results <- ensureResult{runtime: checked, err: err}
	}()
	time.Sleep(50 * time.Millisecond)
	if manager.ensureCount() != 1 {
		t.Fatalf("second gateway should wait on sqlite lock, got ensures=%d", manager.ensureCount())
	}
	manager.releaseAll()

	for i := 0; i < 2; i++ {
		select {
		case result := <-results:
			if result.err != nil {
				t.Fatalf("ensure failed: %v", result.err)
			}
			if result.runtime.RuntimeID != "rt_ensured" {
				t.Fatalf("unexpected runtime: %#v", result.runtime)
			}
		case <-time.After(2 * time.Second):
			t.Fatal("timed out waiting for ensure result")
		}
	}
	if manager.ensureCount() != 1 {
		t.Fatalf("expected one runtime ensure across gateways, got %d", manager.ensureCount())
	}
	loaded, err := storeB.LoadACPSession(scope, session.SessionID)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.Runtime.RuntimeID != "rt_ensured" || loaded.State != acpRuntimeStateReady {
		t.Fatalf("ensured runtime was not committed before unlock: %#v", loaded)
	}
}

func TestACPPromptOwnershipRejectsSecondGateway(t *testing.T) {
	root := t.TempDir()
	storeA, err := NewStore(root)
	if err != nil {
		t.Fatal(err)
	}
	storeB, err := NewStore(root)
	if err != nil {
		t.Fatal(err)
	}
	scope := Scope{TenantID: "tenant-owner", ProjectID: "project-owner"}
	session := &acpSession{
		SessionID:         "session_prompt_owner",
		Scope:             scope,
		Model:             defaultACPModel(),
		CWD:               "/workspace",
		State:             acpRuntimeStateReady,
		RuntimeGeneration: 1,
		Runtime: ACPSessionRuntime{
			RuntimeID:  "runtime_prompt_owner",
			DaemonAddr: "http://127.0.0.1:39001",
		},
		CreatedAt: time.Now().UTC(),
		UpdatedAt: time.Now().UTC(),
	}
	if err := storeA.SaveACPSession(session); err != nil {
		t.Fatal(err)
	}
	manager := newBlockingACPRuntimeManager()
	gatewayA := NewACPGateway(storeA, nil)
	gatewayA.runtimeManager = manager
	gatewayA.worker = manager
	gatewayA.ownerID = "gateway_a"
	gatewayA.sessions[session.SessionID] = cloneSession(session)
	gatewayB := NewACPGateway(storeB, nil)
	gatewayB.runtimeManager = manager
	gatewayB.worker = manager
	gatewayB.ownerID = "gateway_b"
	gatewayB.sessions[session.SessionID] = cloneSession(session)

	req := acpPromptRequest{Prompt: []acpPromptBlock{{Type: "text", Text: "hold owner"}}}
	if err := gatewayA.startPrompt(nil, nil, cloneSession(session), req, false); err != nil {
		t.Fatalf("first gateway should start prompt: %v", err)
	}
	manager.waitStarted(t)
	if err := gatewayB.startPrompt(nil, nil, cloneSession(session), req, false); !errors.Is(err, ErrRuntimeOwnershipHeld) {
		t.Fatalf("second gateway should be rejected by runtime ownership, got %v", err)
	}
	if _, err := gatewayB.cloudAgentRuntimeEnsureReady(scope, acpCloudAgentRuntimeEnsureReadyRequest{SessionID: session.SessionID}); !errors.Is(err, ErrRuntimeOwnershipHeld) {
		t.Fatalf("restore on second gateway should be rejected by runtime ownership, got %v", err)
	}
	if err := gatewayB.closeSession(scope, session.SessionID); !errors.Is(err, ErrRuntimeOwnershipHeld) {
		t.Fatalf("cleanup on second gateway should be rejected by runtime ownership, got %v", err)
	}
	if err := gatewayA.cancelSessionPrompt(scope, session.SessionID); err != nil {
		t.Fatalf("cancel first prompt: %v", err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for {
		lease, err := storeB.AcquireRuntimeOwnership(context.Background(), RuntimeOwnershipRequest{
			SessionID:  session.SessionID,
			Generation: session.RuntimeGeneration,
			RunID:      "job_after_release",
			OwnerID:    "gateway_b",
			Operation:  "prompt",
			TTL:        time.Minute,
		})
		if err == nil {
			_ = storeB.ReleaseRuntimeOwnership(context.Background(), lease)
			break
		}
		if !errors.Is(err, ErrRuntimeOwnershipHeld) {
			t.Fatalf("unexpected ownership acquire error: %v", err)
		}
		if time.Now().After(deadline) {
			t.Fatalf("first prompt ownership was not released")
		}
		time.Sleep(10 * time.Millisecond)
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
	t.Setenv("ACP_ENVD_PROXY_DOMAIN", "envd.cloudagent.lightvela.com")
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
	if result["lifecycle_state"] != acpLifecycleLive || result["recoverability"] != acpRecoverabilityLive {
		t.Fatalf("status should expose live lifecycle contract: %#v", result)
	}
	if result["runtime_status_source"] != "runtime" || result["runtime_status_error"] != "" {
		t.Fatalf("unexpected runtime status source/error: %#v", result)
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
	if result["envd_proxy_domain"] != "envd.cloudagent.lightvela.com" {
		t.Fatalf("status missing envd proxy domain: %#v", result)
	}
}

func TestACPCloudAgentSessionStatusProjectsSessionRunLease(t *testing.T) {
	scope := Scope{TenantID: "tenant-owner", ProjectID: "project-owner"}
	sessionID := "session_status_session_run_lease"
	leaseUntil := time.Date(2026, 5, 28, 1, 2, 3, 0, time.UTC)
	gateway := &ACPGateway{
		runtimeManager: &recordingACPRuntimeManager{},
		sessions: map[string]*acpSession{
			sessionID: {
				SessionID:         sessionID,
				Scope:             scope,
				Model:             defaultACPModel(),
				CWD:               "/workspace",
				State:             acpRuntimeStateReady,
				RuntimeGeneration: 1,
				Runtime: ACPSessionRuntime{
					RuntimeID:        "runtime_status",
					SandboxBackend:   "ags",
					OuterRuntime:     outerRuntimeWisp,
					RuntimeRecovery:  runtimeRecoveryReattachOrRecreate,
					OuterSandboxID:   "outer_status",
					DaemonAddr:       "fake",
					RemoteBinary:     "/tmp/hermes-sidecar",
					WispWorkspaceID:  "workspace_status",
					WispSMHSpaceID:   "workspace_status",
					WispLeaseID:      "lease_status",
					WispLeaseFence:   17,
					WispLeaseUntil:   leaseUntil,
					WorkspaceID:      "workspace_status",
					InnerSandboxID:   "inner_status",
					SessionProxyID:   "spx_status",
					AgentVersion:     defaultAgentVersion,
					WorkspaceVersion: defaultWorkspaceVersion,
				},
				CreatedAt: time.Now().UTC(),
				UpdatedAt: time.Now().UTC(),
			},
		},
	}
	status, err := gateway.cloudAgentSessionStatus(scope, sessionID)
	if err != nil {
		t.Fatal(err)
	}
	sandbox := status["sandbox"].(map[string]any)
	if sandbox["has_session_run_lease"] != true || sandbox["session_run_lease_fence"] != int64(17) || sandbox["session_run_lease_until"] == "" {
		t.Fatalf("status missing session run lease projection: %#v", sandbox)
	}
	if sandbox["has_workspace_lease"] != true || sandbox["workspace_lease_fence"] != int64(17) {
		t.Fatalf("legacy workspace lease fields should mirror session run lease: %#v", sandbox)
	}
}

func TestACPCloudAgentSessionStatusReportsRuntimeSnapshotError(t *testing.T) {
	manager := &recordingACPRuntimeManager{statusErr: fmt.Errorf("runtime status timeout")}
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
		"method":  "_cloudagent.session.status",
		"params":  map[string]any{"session_id": sessionID},
	})
	result := waitForRPCID(t, client, float64(3))["result"].(map[string]any)
	if result["runtime_status_source"] != "gateway_projection" {
		t.Fatalf("runtime status source should be gateway_projection on snapshot failure: %#v", result)
	}
	if !strings.Contains(fmt.Sprint(result["runtime_status_error"]), "runtime status timeout") {
		t.Fatalf("runtime status error missing cause: %#v", result)
	}
	if result["runtime_status"] != "attached" {
		t.Fatalf("runtime status should retain gateway projection fallback: %#v", result)
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
	var worker Worker = FakeWorker{OutputText: "unused"}
	if executor, ok := manager.(Worker); ok {
		worker = executor
	}
	return &Server{
		store:  store,
		worker: worker,
		acpGate: &ACPGateway{
			store:            store,
			worker:           worker,
			runtimeManager:   manager,
			workspaceService: store,
			sessions:         map[string]*acpSession{},
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

func waitForACPSessionState(t *testing.T, gateway *ACPGateway, sessionID string, state acpRuntimeState) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		gateway.mu.Lock()
		session := gateway.sessions[sessionID]
		gotState := acpRuntimeState("")
		hasRuns := false
		if session != nil {
			gotState = session.State
			hasRuns = sessionHasPromptRuns(session)
		}
		gateway.mu.Unlock()
		if session != nil && gotState == state && !hasRuns {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for ACP session %s state %s", sessionID, state)
}

type recordingACPRuntimeManager struct {
	mu                  sync.Mutex
	starts              []ACPSessionRuntimeStartRequest
	workerJobs          []workerJob
	cancels             []ACPSessionRuntime
	refreshes           []ACPSessionRuntime
	closes              []ACPSessionRuntime
	deletes             []ACPSessionRuntime
	events              []workerEvent
	resultText          string
	promptErr           error
	promptErrs          []error
	reattachErr         error
	closeBeforeRecreate bool
	closeErr            error
	closeFailures       int
	closeDelay          time.Duration
	status              ACPSessionRuntimeStatusSnapshot
	statusErr           error
	startErr            error
	afterFirstEvent     chan struct{}
	continueEvents      chan struct{}
}

func (m *recordingACPRuntimeManager) StartSessionRuntime(ctx context.Context, req ACPSessionRuntimeStartRequest) (ACPSessionRuntime, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.starts = append(m.starts, req)
	if m.startErr != nil {
		return ACPSessionRuntime{}, m.startErr
	}
	outerRuntime := normalizeOuterRuntime(req.OuterRuntime)
	runtimeRecovery := normalizeRuntimeRecovery(req.RuntimeRecovery, outerRuntime)
	wispName := ""
	wispSpaceID := ""
	wispOwns := false
	if outerRuntime == outerRuntimeWisp {
		wispName = wispNameFromRuntime(req.SessionID)
		wispSpaceID = "space_" + req.SessionID
		wispOwns = true
	}
	return ACPSessionRuntime{
		RuntimeID:        fmt.Sprintf("rt_%d", len(m.starts)),
		SandboxBackend:   req.SandboxBackend,
		OuterRuntime:     outerRuntime,
		RuntimeRecovery:  runtimeRecovery,
		AgentVersion:     normalizeRuntimeVersion(req.AgentVersion, defaultAgentVersion),
		SidecarURL:       req.SidecarArtifact.URL,
		SidecarSHA256:    req.SidecarArtifact.SHA256,
		SidecarSigURL:    req.SidecarArtifact.SigURL,
		SigningKeyID:     req.SidecarArtifact.SigningKeyID,
		WorkspaceVersion: normalizeRuntimeVersion(req.WorkspaceVersion, defaultWorkspaceVersion),
		OuterSandboxID:   fmt.Sprintf("outer_%d", len(m.starts)),
		DaemonAddr:       "fake",
		RemoteBinary:     "/tmp/hermes-sidecar",
		WispName:         wispName,
		WispWorkspaceID:  wispSpaceID,
		WispSMHSpaceID:   wispSpaceID,
		WispOwnsSMHSpace: wispOwns,
	}, nil
}

func (m *recordingACPRuntimeManager) EnsureSessionRuntime(ctx context.Context, runtime ACPSessionRuntime, req ACPSessionRuntimeStartRequest) (ACPSessionRuntime, error) {
	if runtime.OuterSandboxID == "" && runtimeCanRecreate(runtime) {
		return m.StartSessionRuntime(ctx, req)
	}
	reattached, err := m.ReattachSessionRuntime(ctx, runtime)
	if err == nil {
		return reattached, nil
	}
	if runtimeCanRecreate(runtime) {
		if m.closeBeforeRecreate {
			if cleanupErr := m.CloseSessionRuntime(ctx, runtime); cleanupErr != nil && !isNonBlockingStaleRuntimeCleanupError(cleanupErr) {
				return ACPSessionRuntime{}, cleanupErr
			}
		}
		return m.StartSessionRuntime(ctx, req)
	}
	return ACPSessionRuntime{}, err
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

func (m *recordingACPRuntimeManager) SessionRuntimeStatus(ctx context.Context, runtime ACPSessionRuntime, sessionID string) (ACPSessionRuntimeStatusSnapshot, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.statusErr != nil {
		return ACPSessionRuntimeStatusSnapshot{}, m.statusErr
	}
	status := m.status
	if status.SessionID == "" {
		status.SessionID = sessionID
	}
	if status.Status == "" {
		status.Status = "idle"
	}
	status.OK = true
	return status, nil
}

func (m *recordingACPRuntimeManager) RefreshSessionRuntime(ctx context.Context, runtime ACPSessionRuntime, sessionID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.refreshes = append(m.refreshes, runtime)
	return nil
}

func (m *recordingACPRuntimeManager) Run(ctx context.Context, job workerJob, emit func(workerEvent) error) (workerResult, error) {
	m.mu.Lock()
	m.workerJobs = append(m.workerJobs, job)
	promptErr := m.promptErr
	if len(m.promptErrs) > 0 {
		promptErr = m.promptErrs[0]
		m.promptErrs = m.promptErrs[1:]
	}
	m.mu.Unlock()
	if promptErr != nil {
		return workerResult{}, promptErr
	}
	if emit != nil {
		events := m.events
		if len(events) == 0 {
			events = []workerEvent{{WorkerContractVersion: WorkerContractVersion, EventID: "evt_" + job.JobID, JobID: job.JobID, Sequence: 1, Kind: "output_text_delta", Timestamp: time.Now().UTC().Unix(), Delta: "answer: " + job.Instruction}}
		}
		for _, event := range events {
			event.WorkerContractVersion = WorkerContractVersion
			event.JobID = job.JobID
			event.Timestamp = time.Now().UTC().Unix()
			if event.EventID == "" {
				event.EventID = fmt.Sprintf("evt_%s_%d", job.JobID, event.Sequence)
			}
			if err := emit(event); err != nil {
				return workerResult{}, err
			}
			if event.Sequence == 1 && m.afterFirstEvent != nil {
				close(m.afterFirstEvent)
				m.afterFirstEvent = nil
			}
			if event.Sequence == 1 && m.continueEvents != nil {
				<-m.continueEvents
			}
		}
	}
	outputText := m.resultText
	if outputText == "" {
		outputText = "answer: " + job.Instruction
	}
	return workerResult{WorkerContractVersion: WorkerContractVersion, JobID: job.JobID, Status: "completed", OutputText: outputText}, nil
}

func (m *recordingACPRuntimeManager) FetchArtifact(ctx context.Context, job workerJob, artifact artifactDescriptor) ([]byte, error) {
	return nil, fmt.Errorf("artifacts are not supported by recording ACP test worker")
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
	if m.closeErr != nil {
		return m.closeErr
	}
	if m.closeFailures > 0 {
		m.closeFailures--
		return fmt.Errorf("injected close failure")
	}
	return nil
}

func (m *recordingACPRuntimeManager) DeleteSessionRuntime(ctx context.Context, runtime ACPSessionRuntime) error {
	m.mu.Lock()
	m.deletes = append(m.deletes, runtime)
	m.mu.Unlock()
	return m.CloseSessionRuntime(ctx, runtime)
}

func (m *recordingACPRuntimeManager) CancelSessionRuntime(ctx context.Context, runtime ACPSessionRuntime, sessionID, jobID string) error {
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

func (m *recordingACPRuntimeManager) deleteCount() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.deletes)
}

func (m *recordingACPRuntimeManager) recordedRefreshes() []ACPSessionRuntime {
	m.mu.Lock()
	defer m.mu.Unlock()
	return append([]ACPSessionRuntime(nil), m.refreshes...)
}

func (m *recordingACPRuntimeManager) waitRefreshCount(t *testing.T, want int) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for {
		m.mu.Lock()
		got := len(m.refreshes)
		m.mu.Unlock()
		if got >= want {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("runtime refresh count = %d, want >= %d", got, want)
		}
		time.Sleep(10 * time.Millisecond)
	}
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
	out := make([]string, 0, len(m.workerJobs))
	for _, prompt := range m.workerJobs {
		out = append(out, prompt.Instruction)
	}
	return out
}

func (m *recordingACPRuntimeManager) recordedWorkerJobs() []workerJob {
	m.mu.Lock()
	defer m.mu.Unlock()
	return append([]workerJob(nil), m.workerJobs...)
}

func (m *recordingACPRuntimeManager) recordedStarts() []ACPSessionRuntimeStartRequest {
	m.mu.Lock()
	defer m.mu.Unlock()
	return append([]ACPSessionRuntimeStartRequest(nil), m.starts...)
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

func (m *recordingACPRuntimeManager) promptCWDs() []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]string, 0, len(m.workerJobs))
	for _, prompt := range m.workerJobs {
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

func (m *blockingACPRuntimeManager) Run(ctx context.Context, job workerJob, emit func(workerEvent) error) (workerResult, error) {
	m.mu.Lock()
	m.workerJobs = append(m.workerJobs, job)
	m.mu.Unlock()
	m.once.Do(func() { close(m.started) })
	<-ctx.Done()
	return workerResult{}, ctx.Err()
}

func (m *blockingACPRuntimeManager) waitStarted(t *testing.T) {
	t.Helper()
	select {
	case <-m.started:
	case <-time.After(2 * time.Second):
		t.Fatal("blocking runtime did not start prompt")
	}
}

func (m *blockingACPRuntimeManager) waitWorkerJobCount(t *testing.T, want int) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for {
		m.mu.Lock()
		got := len(m.workerJobs)
		m.mu.Unlock()
		if got >= want {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("expected at least %d worker jobs, got %d", want, got)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

type releasableACPRuntimeManager struct {
	recordingACPRuntimeManager
	started     chan struct{}
	release     chan struct{}
	once        sync.Once
	releaseOnce sync.Once
	wg          sync.WaitGroup
}

func newReleasableACPRuntimeManager() *releasableACPRuntimeManager {
	return &releasableACPRuntimeManager{
		started: make(chan struct{}),
		release: make(chan struct{}),
	}
}

type blockingEnsureACPRuntimeManager struct {
	recordingACPRuntimeManager
	started     chan struct{}
	release     chan struct{}
	once        sync.Once
	releaseOnce sync.Once
	ensureMu    sync.Mutex
	ensures     int
}

func newBlockingEnsureACPRuntimeManager() *blockingEnsureACPRuntimeManager {
	return &blockingEnsureACPRuntimeManager{
		started: make(chan struct{}),
		release: make(chan struct{}),
	}
}

func (m *blockingEnsureACPRuntimeManager) EnsureSessionRuntime(ctx context.Context, runtime ACPSessionRuntime, req ACPSessionRuntimeStartRequest) (ACPSessionRuntime, error) {
	m.ensureMu.Lock()
	m.ensures++
	m.ensureMu.Unlock()
	m.once.Do(func() { close(m.started) })
	select {
	case <-m.release:
	case <-ctx.Done():
		return ACPSessionRuntime{}, ctx.Err()
	}
	runtime.RuntimeID = "rt_ensured"
	runtime.OuterRuntime = normalizeOuterRuntime(firstNonEmpty(runtime.OuterRuntime, req.OuterRuntime))
	runtime.RuntimeRecovery = normalizeRuntimeRecovery(firstNonEmpty(runtime.RuntimeRecovery, req.RuntimeRecovery), runtime.OuterRuntime)
	runtime.WispSMHSpaceID = firstNonEmpty(runtime.WispSMHSpaceID, "space_"+req.SessionID)
	return runtime, nil
}

func (m *blockingEnsureACPRuntimeManager) waitStarted(t *testing.T) {
	t.Helper()
	select {
	case <-m.started:
	case <-time.After(2 * time.Second):
		t.Fatal("runtime ensure did not start")
	}
}

func (m *blockingEnsureACPRuntimeManager) releaseAll() {
	m.releaseOnce.Do(func() { close(m.release) })
}

func (m *blockingEnsureACPRuntimeManager) ensureCount() int {
	m.ensureMu.Lock()
	defer m.ensureMu.Unlock()
	return m.ensures
}

func (m *releasableACPRuntimeManager) Run(ctx context.Context, job workerJob, emit func(workerEvent) error) (workerResult, error) {
	m.wg.Add(1)
	defer m.wg.Done()
	m.mu.Lock()
	m.workerJobs = append(m.workerJobs, job)
	m.mu.Unlock()
	m.once.Do(func() { close(m.started) })
	select {
	case <-m.release:
	case <-ctx.Done():
		return workerResult{}, ctx.Err()
	}
	if emit != nil {
		if err := emit(workerEvent{
			WorkerContractVersion: WorkerContractVersion,
			EventID:               "evt_" + job.JobID,
			JobID:                 job.JobID,
			Sequence:              1,
			Kind:                  "output_text_delta",
			Timestamp:             time.Now().UTC().Unix(),
			Delta:                 "answer: " + job.Instruction,
		}); err != nil {
			return workerResult{}, err
		}
	}
	return workerResult{WorkerContractVersion: WorkerContractVersion, JobID: job.JobID, Status: "completed", OutputText: "answer: " + job.Instruction}, nil
}

func (m *releasableACPRuntimeManager) waitStarted(t *testing.T) {
	t.Helper()
	select {
	case <-m.started:
	case <-time.After(2 * time.Second):
		t.Fatal("releasable runtime did not start prompt")
	}
}

func (m *releasableACPRuntimeManager) releaseAll() {
	m.releaseOnce.Do(func() { close(m.release) })
}

func (m *releasableACPRuntimeManager) waitDone(t *testing.T) {
	t.Helper()
	done := make(chan struct{})
	go func() {
		m.wg.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for releasable runtime prompts to finish")
	}
}

func (m *releasableACPRuntimeManager) waitWorkerJobCount(t *testing.T, want int) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for {
		m.mu.Lock()
		got := len(m.workerJobs)
		m.mu.Unlock()
		if got >= want {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("expected at least %d worker jobs, got %d", want, got)
		}
		time.Sleep(10 * time.Millisecond)
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

func waitForRPCIDs(t *testing.T, client *acpWSClient, ids ...float64) map[float64]map[string]any {
	t.Helper()
	pending := make(map[float64]struct{}, len(ids))
	for _, id := range ids {
		pending[id] = struct{}{}
	}
	responses := make(map[float64]map[string]any, len(ids))
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) && len(pending) > 0 {
		msg := client.readJSON(t)
		got, ok := msg["id"].(float64)
		if !ok {
			continue
		}
		if _, want := pending[got]; !want {
			continue
		}
		responses[got] = msg
		delete(pending, got)
	}
	if len(pending) > 0 {
		t.Fatalf("timed out waiting for rpc responses: %#v", pending)
	}
	return responses
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
	msg := waitForMethod(t, client, cloudAgentReplayDoneMethod)
	params := msg["params"].(map[string]any)
	if params["session_id"] != sessionID {
		t.Fatalf("unexpected replay_done session id: %#v", params)
	}
	if _, hasCamel := params["sessionId"]; hasCamel {
		t.Fatalf("replay_done extension must use snake_case fields: %#v", params)
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

func assertTextUpdateFrame(t *testing.T, msg map[string]any, sessionID, text string) {
	t.Helper()
	if msg["method"] != "session/update" {
		t.Fatalf("expected session/update, got %#v", msg)
	}
	params := msg["params"].(map[string]any)
	if params["sessionId"] != sessionID {
		t.Fatalf("unexpected update session id: %#v", params)
	}
	update := params["update"].(map[string]any)
	if update["sessionUpdate"] != "agent_message_chunk" {
		t.Fatalf("expected agent_message_chunk, got %#v", update)
	}
	content := update["content"].(map[string]any)
	if content["text"] != text {
		t.Fatalf("expected text %q, got %#v", text, update)
	}
}

func historyContainsText(history []acpHistoryEntry, role, text string) bool {
	for _, item := range history {
		if item.Role == role && strings.Contains(item.Text, text) {
			return true
		}
	}
	return false
}

func containsAnyString(values []any, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}

func cloudAgentResultMeta(t *testing.T, result map[string]any) map[string]any {
	t.Helper()
	meta, ok := result["_meta"].(map[string]any)
	if !ok {
		t.Fatalf("result missing _meta: %#v", result)
	}
	cloudAgent, ok := meta["cloudagent"].(map[string]any)
	if !ok {
		t.Fatalf("result missing _meta.cloudagent: %#v", result)
	}
	return cloudAgent
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
