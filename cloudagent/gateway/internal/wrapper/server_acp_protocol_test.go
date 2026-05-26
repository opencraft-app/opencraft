package wrapper

import (
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestACPProtocolInitializeAdvertisesCloudAgentExtensionNotifications(t *testing.T) {
	srv, _ := newTestServer(t, FakeWorker{OutputText: "hello"})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	client := dialACPWS(t, "ws"+trimHTTPPrefix(ts.URL)+"/acp", map[string]string{"Authorization": "Bearer test-key"})
	defer client.close()

	client.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": map[string]any{}})
	resp := waitForRPCID(t, client, float64(1))
	result := resp["result"].(map[string]any)
	agentInfo := result["agentInfo"].(map[string]any)
	if agentInfo["name"] != "cloudagent-gateway" {
		t.Fatalf("initialize should return standard agentInfo: %#v", result)
	}
	capabilities := result["agentCapabilities"].(map[string]any)
	meta := capabilities["_meta"].(map[string]any)
	cloudAgent := meta["cloudagent"].(map[string]any)
	notifications := cloudAgent["notifications"].([]any)
	assertStringSetContains(t, notifications, cloudAgentReplayDoneMethod)
	assertStringSetContains(t, notifications, cloudAgentReplayGapMethod)
	assertStringSetContains(t, notifications, cloudAgentTurnStatusMethod)
}

func TestACPProtocolSessionResultsUseStandardRootsAndCloudAgentMeta(t *testing.T) {
	session := &acpSession{
		SessionID: "session_protocol_shape",
		CWD:       "/workspace",
		State:     acpRuntimeStateReady,
		Runtime: ACPSessionRuntime{
			SessionProxyID: "proxy_protocol_shape",
		},
		ConfigOptions: []ConfigOption{{
			ID:           "model",
			Name:         "Model",
			Category:     "model",
			Type:         "select",
			CurrentValue: "agent-sidecar-chat",
		}},
	}

	newResult := mustJSONMap(t, acpNewSessionResultFor(session))
	assertRootKeys(t, newResult, "sessionId", "configOptions", "_meta")
	assertNoRootCloudAgentPrivateFields(t, newResult)
	assertCloudAgentMetaShape(t, newResult, map[string]any{
		"state":            string(acpRuntimeStateReady),
		"session_proxy_id": "proxy_protocol_shape",
	})
	if newResult["sessionId"] != "session_protocol_shape" {
		t.Fatalf("session/new must keep standard sessionId root field: %#v", newResult)
	}

	loadedResult := mustJSONMap(t, acpLoadedSessionResultFor(session))
	assertRootKeys(t, loadedResult, "configOptions", "_meta")
	assertNoRootCloudAgentPrivateFields(t, loadedResult)
	assertCloudAgentMetaShape(t, loadedResult, map[string]any{
		"state":            string(acpRuntimeStateReady),
		"session_proxy_id": "proxy_protocol_shape",
	})
	if _, ok := loadedResult["sessionId"]; ok {
		t.Fatalf("session/load and session/resume results must not invent root sessionId: %#v", loadedResult)
	}

	listItem := acpSessionListItem{
		SessionID: "session_protocol_shape",
		CWD:       "/workspace",
		Title:     "Protocol shape",
		UpdatedAt: "2026-05-26T00:00:00Z",
		Meta: cloudAgentMetaBox(acpCloudAgentSessionResultMeta{
			State:          string(acpRuntimeStateReady),
			ReadOnly:       true,
			ReadOnlyReason: "runtime_not_recovered",
		}),
	}
	listRow := mustJSONMap(t, listItem)
	assertRootKeys(t, listRow, "sessionId", "cwd", "title", "updatedAt", "_meta")
	assertNoRootCloudAgentPrivateFields(t, listRow)
	assertCloudAgentMetaShape(t, listRow, map[string]any{
		"state":            string(acpRuntimeStateReady),
		"read_only":        true,
		"read_only_reason": "runtime_not_recovered",
	})
}

func TestACPProtocolCloudAgentExtensionRequestsBindOnlySnakeCase(t *testing.T) {
	var statusReq acpCloudAgentSessionRequest
	if err := json.Unmarshal([]byte(`{"session_id":"session_snake"}`), &statusReq); err != nil {
		t.Fatal(err)
	}
	if statusReq.SessionID != "session_snake" {
		t.Fatalf("status extension should bind snake_case session_id: %#v", statusReq)
	}
	statusReq = acpCloudAgentSessionRequest{}
	if err := json.Unmarshal([]byte(`{"sessionId":"session_camel"}`), &statusReq); err != nil {
		t.Fatal(err)
	}
	if statusReq.SessionID != "" {
		t.Fatalf("status extension must not bind camelCase sessionId: %#v", statusReq)
	}

	var ensureReq acpCloudAgentRuntimeEnsureReadyRequest
	if err := json.Unmarshal([]byte(`{"session_id":"session_snake","cwd":"/workspace"}`), &ensureReq); err != nil {
		t.Fatal(err)
	}
	if ensureReq.SessionID != "session_snake" || ensureReq.CWD != "/workspace" {
		t.Fatalf("ensure_ready extension should bind snake_case fields: %#v", ensureReq)
	}
	ensureReq = acpCloudAgentRuntimeEnsureReadyRequest{}
	if err := json.Unmarshal([]byte(`{"sessionId":"session_camel","cwd":"/workspace"}`), &ensureReq); err != nil {
		t.Fatal(err)
	}
	if ensureReq.SessionID != "" {
		t.Fatalf("ensure_ready extension must not bind camelCase sessionId: %#v", ensureReq)
	}
}

func TestACPProtocolPromptResultUsesStandardStopReasonOnly(t *testing.T) {
	result := mustJSONMap(t, acpPromptResult{StopReason: "end_turn"})
	assertRootKeys(t, result, "stopReason")
	if result["stopReason"] != "end_turn" {
		t.Fatalf("prompt result should use standard stopReason: %#v", result)
	}
	if _, ok := result["stop_reason"]; ok {
		t.Fatalf("prompt result must not emit stop_reason alias: %#v", result)
	}
}

func TestACPProtocolSessionLoadReplaysBeforeResponseAndUsesExtensions(t *testing.T) {
	srv, _ := newTestServer(t, FakeWorker{OutputText: "remembered answer"})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	client := dialACPWS(t, "ws"+trimHTTPPrefix(ts.URL)+"/acp", map[string]string{"Authorization": "Bearer test-key"})
	client.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": map[string]any{}})
	waitForRPCID(t, client, float64(1))
	client.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 2, "method": "session/new", "params": map[string]any{"cwd": "/workspace"}})
	newResult := waitForRPCID(t, client, float64(2))["result"].(map[string]any)
	assertNoRootCloudAgentPrivateFields(t, newResult)
	if cloudAgentResultMeta(t, newResult)["state"] != "ready" {
		t.Fatalf("session/new should expose CloudAgent state under _meta.cloudagent: %#v", newResult)
	}
	sessionID := newResult["sessionId"].(string)
	client.writeJSON(t, map[string]any{
		"jsonrpc": "2.0",
		"id":      3,
		"method":  "session/prompt",
		"params": map[string]any{
			"sessionId": sessionID,
			"prompt":    []any{map[string]any{"type": "text", "text": "remember this"}},
		},
	})
	assertUpdateKind(t, client, "agent_message_chunk")
	waitForRPCID(t, client, float64(3))
	client.close()

	loader := dialACPWS(t, "ws"+trimHTTPPrefix(ts.URL)+"/acp", map[string]string{"Authorization": "Bearer test-key"})
	defer loader.close()
	loader.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 10, "method": "initialize", "params": map[string]any{}})
	waitForRPCID(t, loader, float64(10))
	loader.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 11, "method": "session/load", "params": map[string]any{"sessionId": sessionID}})

	first := loader.readJSON(t)
	assertSessionUpdateKindFrame(t, first, sessionID, "user_message_chunk")
	assertNoPrivateLifecycleSessionUpdate(t, first)
	second := loader.readJSON(t)
	assertSessionUpdateKindFrame(t, second, sessionID, "agent_message_chunk")
	assertNoPrivateLifecycleSessionUpdate(t, second)
	replayDone := loader.readJSON(t)
	if replayDone["method"] != cloudAgentReplayDoneMethod {
		t.Fatalf("expected replay_done extension before load response, got %#v", replayDone)
	}
	doneParams := replayDone["params"].(map[string]any)
	if doneParams["session_id"] != sessionID {
		t.Fatalf("unexpected replay_done params: %#v", doneParams)
	}
	if _, hasCamel := doneParams["sessionId"]; hasCamel {
		t.Fatalf("unexpected replay_done params: %#v", doneParams)
	}
	loadResp := loader.readJSON(t)
	if loadResp["id"] != float64(11) {
		t.Fatalf("expected load response after replay_done, got %#v", loadResp)
	}
	loadResult := loadResp["result"].(map[string]any)
	if _, hasSessionID := loadResult["sessionId"]; hasSessionID {
		t.Fatalf("session/load response must not add non-standard sessionId root field: %#v", loadResp)
	}
	assertNoRootCloudAgentPrivateFields(t, loadResult)
	if cloudAgentResultMeta(t, loadResult)["state"] != "ready" {
		t.Fatalf("unexpected load response extension meta: %#v", loadResp)
	}
}

func TestACPProtocolAppEnvelopePreservesSessionLoadOrdering(t *testing.T) {
	srv, _ := newTestServer(t, FakeWorker{OutputText: "app remembered answer"})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	client := dialACPWS(t, "ws"+trimHTTPPrefix(ts.URL)+"/ws", map[string]string{"Authorization": "Bearer test-key"})
	defer client.close()
	writeAppACP(t, client, map[string]any{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": map[string]any{}})
	waitForAppRPCID(t, client, float64(1))
	writeAppACP(t, client, map[string]any{"jsonrpc": "2.0", "id": 2, "method": "session/new", "params": map[string]any{"cwd": "/workspace"}})
	sessionID := waitForAppRPCID(t, client, float64(2))["result"].(map[string]any)["sessionId"].(string)
	writeAppACP(t, client, map[string]any{
		"jsonrpc": "2.0",
		"id":      3,
		"method":  "session/prompt",
		"params": map[string]any{
			"sessionId": sessionID,
			"prompt":    []any{map[string]any{"type": "text", "text": "remember via app envelope"}},
		},
	})
	assertSessionUpdateKindFrame(t, waitForAppMethod(t, client, "session/update"), sessionID, "agent_message_chunk")
	waitForAppRPCID(t, client, float64(3))

	writeAppACP(t, client, map[string]any{"jsonrpc": "2.0", "id": 4, "method": "session/load", "params": map[string]any{"sessionId": sessionID}})
	first := waitForAppRecv(t, client)
	assertSessionUpdateKindFrame(t, first, sessionID, "user_message_chunk")
	second := waitForAppRecv(t, client)
	assertSessionUpdateKindFrame(t, second, sessionID, "agent_message_chunk")
	replayDone := waitForAppRecv(t, client)
	if replayDone["method"] != cloudAgentReplayDoneMethod {
		t.Fatalf("expected app replay_done extension before load response, got %#v", replayDone)
	}
	loadResp := waitForAppRecv(t, client)
	if loadResp["id"] != float64(4) {
		t.Fatalf("expected app load response after replay_done, got %#v", loadResp)
	}
}

func TestACPProtocolPromptCompletionUsesCloudAgentTurnStatusExtension(t *testing.T) {
	srv, _ := newTestServer(t, FakeWorker{OutputText: "terminal answer"})
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
			"prompt":    []any{map[string]any{"type": "text", "text": "complete"}},
		},
	})
	var terminal map[string]any
	for terminal == nil {
		frame := client.readJSON(t)
		if frame["id"] == float64(3) {
			t.Fatalf("prompt response arrived before terminal extension: %#v", frame)
		}
		if frame["method"] == "session/update" {
			assertSessionUpdateKindFrame(t, frame, sessionID, "agent_message_chunk")
			assertNoPrivateLifecycleSessionUpdate(t, frame)
			continue
		}
		if frame["method"] == cloudAgentTurnStatusMethod {
			terminal = frame
			break
		}
		t.Fatalf("unexpected frame before terminal extension: %#v", frame)
	}
	terminalParams := terminal["params"].(map[string]any)
	if terminalParams["session_id"] != sessionID || terminalParams["status"] != "completed" {
		t.Fatalf("unexpected terminal params: %#v", terminalParams)
	}
	promptResp := client.readJSON(t)
	if promptResp["id"] != float64(3) || promptResp["result"].(map[string]any)["stopReason"] != "end_turn" {
		t.Fatalf("expected prompt response after terminal extension, got %#v", promptResp)
	}
}

func TestACPProtocolPromptFailureUsesCloudAgentTurnStatusExtension(t *testing.T) {
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
	var terminal map[string]any
	for {
		frame := client.readJSON(t)
		if frame["method"] == "session/update" {
			assertNoPrivateLifecycleSessionUpdate(t, frame)
			continue
		}
		if frame["method"] == cloudAgentTurnStatusMethod {
			terminal = frame
			continue
		}
		if frame["id"] == float64(3) {
			if _, ok := frame["error"].(map[string]any); !ok {
				t.Fatalf("expected JSON-RPC error after failed turn status, got %#v", frame)
			}
			break
		}
		t.Fatalf("unexpected frame during failed prompt: %#v", frame)
	}
	if terminal == nil {
		t.Fatal("expected CloudAgent failed turn status before prompt response")
	}
	terminalParams := terminal["params"].(map[string]any)
	if terminalParams["session_id"] != sessionID || terminalParams["status"] != "failed" {
		t.Fatalf("unexpected failed terminal params: %#v", terminalParams)
	}
	if _, ok := terminalParams["error"].(map[string]any); !ok {
		t.Fatalf("failed terminal status should carry extension error details: %#v", terminalParams)
	}
}

func TestACPProtocolWorkspaceWellDoneIsObservableByRestoreAndStatus(t *testing.T) {
	manager := &recordingACPRuntimeManager{}
	srv := newACPTestServerWithRuntime(t, manager)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	client := dialACPWS(t, "ws"+trimHTTPPrefix(ts.URL)+"/acp", map[string]string{"Authorization": "Bearer test-key"})
	defer client.close()
	client.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": map[string]any{}})
	initResp := waitForRPCID(t, client, float64(1))
	cloudagentMeta := initResp["result"].(map[string]any)["agentCapabilities"].(map[string]any)["_meta"].(map[string]any)["cloudagent"].(map[string]any)
	methods := cloudagentMeta["methods"].([]any)
	assertStringSetContains(t, methods, cloudAgentRuntimeEnsureReadyMethod)
	assertStringSetContains(t, methods, cloudAgentSessionStatusMethod)
	notifications := cloudagentMeta["notifications"].([]any)
	assertStringSetContains(t, notifications, cloudAgentWorkspaceLifecycleMethod)

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
	lifecycle := waitForWorkspaceLifecycleOperation(t, client, "restore")
	if lifecycle["session_id"] != sessionID || lifecycle["operation"] != "restore" {
		t.Fatalf("unexpected workspace lifecycle notification: %#v", lifecycle)
	}
	if _, hasCamel := lifecycle["sessionId"]; hasCamel {
		t.Fatalf("workspace lifecycle extension must use snake_case fields: %#v", lifecycle)
	}
	restoreResult := waitForRPCID(t, client, float64(4))["result"].(map[string]any)
	assertACPWorkspaceWellDone(t, restoreResult, sessionID)
	if restoreResult["ok"] != true || restoreResult["restore_source"] != "runtime_ensure_ready" {
		t.Fatalf("runtime ensure_ready should be explicit well-done response: %#v", restoreResult)
	}

	client.writeJSON(t, map[string]any{
		"jsonrpc": "2.0",
		"id":      5,
		"method":  "_cloudagent.session.status",
		"params":  map[string]any{"session_id": sessionID},
	})
	statusResult := waitForRPCID(t, client, float64(5))["result"].(map[string]any)
	assertACPWorkspaceWellDone(t, statusResult, sessionID)
}

func waitForWorkspaceLifecycleOperation(t *testing.T, client *acpWSClient, operation string) map[string]any {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		msg := client.readJSON(t)
		if got, ok := msg["method"].(string); !ok || got != cloudAgentWorkspaceLifecycleMethod {
			continue
		}
		params := msg["params"].(map[string]any)
		if params["operation"] == operation {
			return params
		}
	}
	t.Fatalf("timed out waiting for workspace lifecycle operation %s", operation)
	return nil
}

func TestACPProtocolRuntimeOwnershipHeldErrorIsStructuredRetryable(t *testing.T) {
	code, message, data := acpJSONRPCError(RuntimeOwnershipHeldError{
		SessionID:  "session_active",
		Generation: 2,
		RunID:      "job_active",
		OwnerID:    "gateway_active",
		Operation:  "prompt",
		ExpiresAt:  time.Date(2026, 5, 26, 2, 9, 54, 0, time.UTC),
	})
	if code != -32009 || message != "runtime ownership is held" {
		t.Fatalf("unexpected ownership error code/message: code=%d message=%q", code, message)
	}
	fields := data.(map[string]any)
	if fields["error_code"] != "runtime_ownership_held" || fields["retryable"] != true {
		t.Fatalf("ownership error should be structured retryable data: %#v", fields)
	}
	if fields["session_id"] != "session_active" || fields["run_id"] != "job_active" || fields["operation"] != "prompt" {
		t.Fatalf("ownership error should preserve owner diagnostics: %#v", fields)
	}
}

func TestACPProtocolCloudAgentExtensionsRejectCamelCaseInput(t *testing.T) {
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
		"method":  cloudAgentSessionStatusMethod,
		"params":  map[string]any{"sessionId": sessionID},
	})
	statusErr := waitForRPCID(t, client, float64(3))["error"].(map[string]any)
	if !strings.Contains(fmt.Sprint(statusErr["message"]), "session_id") {
		t.Fatalf("CloudAgent extension should require snake_case session_id, got %#v", statusErr)
	}

	client.writeJSON(t, map[string]any{
		"jsonrpc": "2.0",
		"id":      4,
		"method":  cloudAgentRuntimeEnsureReadyMethod,
		"params":  map[string]any{"sessionId": sessionID},
	})
	ensureErr := waitForRPCID(t, client, float64(4))["error"].(map[string]any)
	if !strings.Contains(fmt.Sprint(ensureErr["message"]), "session_id") {
		t.Fatalf("CloudAgent extension should require snake_case session_id, got %#v", ensureErr)
	}
}

func TestACPProtocolCancelNotificationCancelsPromptAndKeepsConnectionUsable(t *testing.T) {
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
	if got := promptResp["result"].(map[string]any)["stopReason"]; got != "cancelled" {
		t.Fatalf("expected cancelled prompt response, got %#v", promptResp)
	}
	client.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 4, "method": "session/list", "params": map[string]any{"cwd": "/workspace"}})
	listResp := waitForRPCID(t, client, float64(4))
	sessions, ok := listResp["result"].(map[string]any)["sessions"].([]any)
	if !ok {
		t.Fatalf("connection did not remain usable after cancel notification: %#v", listResp)
	}
	if len(sessions) != 1 {
		t.Fatalf("expected one listed session, got %#v", listResp)
	}
	listRow := sessions[0].(map[string]any)
	assertNoRootCloudAgentPrivateFields(t, listRow)
	if cloudAgentResultMeta(t, listRow)["state"] != "ready" {
		t.Fatalf("session/list should expose CloudAgent state under _meta.cloudagent: %#v", listResp)
	}
}

func TestACPProtocolAppEnvelopeCancelNotificationCancelsPrompt(t *testing.T) {
	manager := newBlockingACPRuntimeManager()
	srv := newACPTestServerWithRuntime(t, manager)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	client := dialACPWS(t, "ws"+trimHTTPPrefix(ts.URL)+"/ws", map[string]string{"Authorization": "Bearer test-key"})
	defer client.close()
	writeAppACP(t, client, map[string]any{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": map[string]any{}})
	waitForAppRPCID(t, client, float64(1))
	writeAppACP(t, client, map[string]any{"jsonrpc": "2.0", "id": 2, "method": "session/new", "params": map[string]any{"cwd": "/workspace"}})
	sessionID := waitForAppRPCID(t, client, float64(2))["result"].(map[string]any)["sessionId"].(string)
	writeAppACP(t, client, map[string]any{
		"jsonrpc": "2.0",
		"id":      3,
		"method":  "session/prompt",
		"params": map[string]any{
			"sessionId": sessionID,
			"prompt":    []any{map[string]any{"type": "text", "text": "block app"}},
		},
	})
	manager.waitStarted(t)
	writeAppACP(t, client, map[string]any{"jsonrpc": "2.0", "method": "session/cancel", "params": map[string]any{"sessionId": sessionID}})
	promptResp := waitForAppRPCID(t, client, float64(3))
	if got := promptResp["result"].(map[string]any)["stopReason"]; got != "cancelled" {
		t.Fatalf("expected app cancelled prompt response, got %#v", promptResp)
	}
	writeAppACP(t, client, map[string]any{"jsonrpc": "2.0", "id": 4, "method": "session/list", "params": map[string]any{"cwd": "/workspace"}})
	if resp := waitForAppRPCID(t, client, float64(4)); resp["result"] == nil {
		t.Fatalf("app connection did not remain usable after cancel notification: %#v", resp)
	}
}

func TestACPProtocolUnknownNotificationIsIgnoredAndKeepsConnectionUsable(t *testing.T) {
	srv, _ := newTestServer(t, FakeWorker{OutputText: "hello"})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	client := dialACPWS(t, "ws"+trimHTTPPrefix(ts.URL)+"/acp", map[string]string{"Authorization": "Bearer test-key"})
	defer client.close()
	client.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": map[string]any{}})
	waitForRPCID(t, client, float64(1))
	client.writeJSON(t, map[string]any{"jsonrpc": "2.0", "method": "$/unknownNotification", "params": map[string]any{"ignored": true}})
	client.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 2, "method": "session/list", "params": map[string]any{"cwd": "/workspace"}})
	if resp := waitForRPCID(t, client, float64(2)); resp["result"] == nil {
		t.Fatalf("connection did not remain usable after unknown notification: %#v", resp)
	}
}

func TestACPProtocolSessionCancelRequestIsRejected(t *testing.T) {
	srv, _ := newTestServer(t, FakeWorker{OutputText: "hello"})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	client := dialACPWS(t, "ws"+trimHTTPPrefix(ts.URL)+"/acp", map[string]string{"Authorization": "Bearer test-key"})
	defer client.close()
	client.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": map[string]any{}})
	waitForRPCID(t, client, float64(1))
	client.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 2, "method": "session/new", "params": map[string]any{"cwd": "/workspace"}})
	sessionID := waitForRPCID(t, client, float64(2))["result"].(map[string]any)["sessionId"].(string)
	client.writeJSON(t, map[string]any{"jsonrpc": "2.0", "id": 3, "method": "session/cancel", "params": map[string]any{"sessionId": sessionID}})
	cancelResp := waitForRPCID(t, client, float64(3))
	if cancelResp["error"] == nil {
		t.Fatalf("session/cancel request should be rejected; use notification form, got %#v", cancelResp)
	}
}

func assertStringSetContains(t *testing.T, values []any, expected string) {
	t.Helper()
	for _, value := range values {
		if value == expected {
			return
		}
	}
	t.Fatalf("expected %q in %#v", expected, values)
}

func assertSessionUpdateKindFrame(t *testing.T, msg map[string]any, sessionID, kind string) {
	t.Helper()
	if msg["method"] != "session/update" {
		t.Fatalf("expected session/update, got %#v", msg)
	}
	params := msg["params"].(map[string]any)
	if params["sessionId"] != sessionID {
		t.Fatalf("unexpected session id in update: %#v", params)
	}
	update := params["update"].(map[string]any)
	if update["sessionUpdate"] != kind {
		t.Fatalf("expected %s update, got %#v", kind, update)
	}
}

func assertACPWorkspaceWellDone(t *testing.T, result map[string]any, sessionID string) {
	t.Helper()
	if result["session_id"] != sessionID {
		t.Fatalf("unexpected well-done session id: %#v", result)
	}
	if _, hasCamel := result["sessionId"]; hasCamel {
		t.Fatalf("CloudAgent extension response must use snake_case fields: %#v", result)
	}
	if result["state"] != "ready" || result["read_only"] == true {
		t.Fatalf("workspace is not ready/writable: %#v", result)
	}
	status, _ := result["runtime_status"].(string)
	switch status {
	case "attached", "ready", "idle", "running", "recovered", "restored":
	default:
		t.Fatalf("runtime status is not well-done: %#v", result)
	}
}

func assertNoPrivateLifecycleSessionUpdate(t *testing.T, msg map[string]any) {
	t.Helper()
	params, _ := msg["params"].(map[string]any)
	update, _ := params["update"].(map[string]any)
	switch update["sessionUpdate"] {
	case "error", "lifecycle", "replay_done", "replay_gap", "turn_complete":
		t.Fatalf("private lifecycle marker leaked through standard session/update: %#v", msg)
	}
}

func assertNoRootCloudAgentPrivateFields(t *testing.T, result map[string]any) {
	t.Helper()
	for _, key := range []string{"readOnly", "readOnlyReason", "read_only", "read_only_reason", "session_proxy_id"} {
		if _, ok := result[key]; ok {
			t.Fatalf("CloudAgent private field %q must live under _meta.cloudagent: %#v", key, result)
		}
	}
}

func assertRootKeys(t *testing.T, result map[string]any, expected ...string) {
	t.Helper()
	want := make(map[string]bool, len(expected))
	for _, key := range expected {
		want[key] = true
	}
	for _, key := range expected {
		if _, ok := result[key]; !ok {
			t.Fatalf("result missing root field %q: %#v", key, result)
		}
	}
	for key := range result {
		if !want[key] {
			t.Fatalf("unexpected root field %q in result: %#v", key, result)
		}
	}
}

func assertCloudAgentMetaShape(t *testing.T, result map[string]any, expected map[string]any) {
	t.Helper()
	cloudAgent := cloudAgentResultMeta(t, result)
	for _, key := range []string{"readOnly", "readOnlyReason", "sessionId"} {
		if _, ok := cloudAgent[key]; ok {
			t.Fatalf("CloudAgent meta must use snake_case and no ACP root aliases: %#v", cloudAgent)
		}
	}
	for key, want := range expected {
		if got := cloudAgent[key]; got != want {
			t.Fatalf("unexpected _meta.cloudagent.%s: want=%#v got=%#v result=%#v", key, want, got, result)
		}
	}
}

func mustJSONMap(t *testing.T, value any) map[string]any {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	var out map[string]any
	if err := json.Unmarshal(data, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func writeAppACP(t *testing.T, client *acpWSClient, message map[string]any) {
	t.Helper()
	client.writeJSON(t, map[string]any{
		"type":    "acp",
		"message": message,
	})
}

func waitForAppRPCID(t *testing.T, client *acpWSClient, id float64) map[string]any {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		msg, ok := readAppRecv(t, client)
		if !ok {
			continue
		}
		if got, ok := msg["id"].(float64); ok && got == id {
			return msg
		}
	}
	t.Fatalf("timed out waiting for app rpc response id=%v", id)
	return nil
}

func waitForAppMethod(t *testing.T, client *acpWSClient, method string) map[string]any {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		msg, ok := readAppRecv(t, client)
		if !ok {
			continue
		}
		if got, ok := msg["method"].(string); ok && got == method {
			return msg
		}
	}
	t.Fatalf("timed out waiting for app method %s", method)
	return nil
}

func waitForAppRecv(t *testing.T, client *acpWSClient) map[string]any {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		msg, ok := readAppRecv(t, client)
		if ok {
			return msg
		}
	}
	t.Fatal("timed out waiting for app recv message")
	return nil
}

func readAppRecv(t *testing.T, client *acpWSClient) (map[string]any, bool) {
	t.Helper()
	env := client.readJSON(t)
	if env["type"] != "acp" || env["direction"] != "recv" {
		return nil, false
	}
	message, ok := env["message"].(map[string]any)
	if !ok {
		t.Fatalf("app recv envelope missing message: %#v", env)
	}
	return message, true
}
