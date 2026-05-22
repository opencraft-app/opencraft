package wrapper

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

type ACPGateway struct {
	store            *Store
	worker           Worker
	runtimeManager   ACPSessionRuntimeManager
	mu               sync.Mutex
	writeMu          sync.Mutex
	sessions         map[string]*acpSession
	cleanups         map[string]*acpRuntimeCleanup
	envdEnsures      map[string]*envdEnsureCall
	staleProxyIDs    map[string]struct{}
	forceEnvdEnsures map[string]struct{}
}

type acpAppEnvelope struct {
	Type      string          `json:"type"`
	Direction string          `json:"direction,omitempty"`
	Status    string          `json:"status,omitempty"`
	Message   json.RawMessage `json:"message,omitempty"`
	Error     *acpAppError    `json:"error,omitempty"`
}

type acpAppError struct {
	Code    string `json:"code"`
	Kind    string `json:"kind"`
	Message string `json:"message,omitempty"`
}

type acpSession struct {
	SessionID         string
	Scope             Scope
	Model             string
	CWD               string
	CreatedAt         time.Time
	UpdatedAt         time.Time
	Closed            bool
	State             acpRuntimeState
	RuntimeGeneration int64
	Runtime           ACPSessionRuntime
	CurrentPrompt     *acpPromptRun
	LastRuntimeError  string
	CurrentResponseID string
	ReadOnlyReason    string
	ConfigOptions     []ConfigOption
	History           []acpHistoryEntry
	Events            []acpSessionEvent
}

type acpPromptRun struct {
	Generation         int64
	JobID              string
	TurnID             string
	UserMessageID      string
	AssistantMessageID string
	HistoryLenBefore   int
	Cancel             context.CancelFunc
	mu                 sync.Mutex
	StopReason         string
	WS                 *WSConn
	RPCID              json.RawMessage
	AppEnvelope        bool
	Responded          bool
	InterruptReady     chan struct{}
}

type acpRuntimeCleanup struct {
	Runtime    ACPSessionRuntime
	Generation int64
	Done       chan struct{}
	Err        error
}

type acpHistoryEntry struct {
	Role       string
	Text       string
	At         time.Time
	ResponseID string
	MessageID  string
	BlockID    string
	Seq        int64
}

type ConfigOption struct {
	ID           string               `json:"id"`
	Name         string               `json:"name,omitempty"`
	Category     string               `json:"category,omitempty"`
	Type         string               `json:"type"`
	CurrentValue string               `json:"currentValue"`
	Options      []ConfigOptionChoice `json:"options,omitempty"`
}

type ConfigOptionChoice struct {
	Value       string `json:"value"`
	Name        string `json:"name,omitempty"`
	Description string `json:"description,omitempty"`
}

type acpPromptBlock struct {
	Type     string             `json:"type"`
	Text     string             `json:"text,omitempty"`
	MimeType string             `json:"mimeType,omitempty"`
	Data     string             `json:"data,omitempty"`
	Resource *acpPromptResource `json:"resource,omitempty"`
}

type acpPromptResource struct {
	URI          string `json:"uri"`
	MimeType     string `json:"mimeType,omitempty"`
	Text         string `json:"text,omitempty"`
	Name         string `json:"name,omitempty"`
	Size         int64  `json:"size,omitempty"`
	RelativePath string `json:"relativePath,omitempty"`
}

type acpSessionListItem struct {
	SessionID      string `json:"sessionId"`
	CWD            string `json:"cwd,omitempty"`
	Title          string `json:"title,omitempty"`
	UpdatedAt      string `json:"updatedAt,omitempty"`
	State          string `json:"state,omitempty"`
	ReadOnly       bool   `json:"readOnly,omitempty"`
	ReadOnlyReason string `json:"readOnlyReason,omitempty"`
}

type acpPromptRequest struct {
	SessionID string           `json:"sessionId"`
	Prompt    []acpPromptBlock `json:"prompt"`
	CWD       string           `json:"cwd,omitempty"`
}

type acpSessionRequest struct {
	SessionID             string         `json:"sessionId,omitempty"`
	CWD                   string         `json:"cwd,omitempty"`
	MCPServers            []any          `json:"mcpServers,omitempty"`
	AdditionalDirectories []string       `json:"additionalDirectories,omitempty"`
	Meta                  acpSessionMeta `json:"_meta,omitempty"`
}

type acpSessionMeta struct {
	CloudAgent acpCloudAgentSessionMeta `json:"cloudagent,omitempty"`
}

type acpCloudAgentSessionMeta struct {
	SandboxBackend   string                           `json:"sandbox_backend,omitempty"`
	AgentVersion     string                           `json:"agent_version,omitempty"`
	WorkspaceVersion string                           `json:"workspace_version,omitempty"`
	SidecarURL       string                           `json:"sidecar_url,omitempty"`
	SidecarSHA256    string                           `json:"sidecar_sha256,omitempty"`
	SidecarSigURL    string                           `json:"sidecar_sig_url,omitempty"`
	SigningKeyID     string                           `json:"signing_key_id,omitempty"`
	SidecarArtifact  acpCloudAgentSidecarArtifactMeta `json:"sidecar_artifact,omitempty"`
}

type acpCloudAgentSidecarArtifactMeta struct {
	SidecarURL    string `json:"sidecar_url,omitempty"`
	SidecarSHA256 string `json:"sidecar_sha256,omitempty"`
	SidecarSigURL string `json:"sidecar_sig_url,omitempty"`
	SigningKeyID  string `json:"signing_key_id,omitempty"`
}

func (m acpCloudAgentSessionMeta) sidecarArtifact() agentSidecarArtifact {
	artifact := agentSidecarArtifact{
		URL:          strings.TrimSpace(m.SidecarArtifact.SidecarURL),
		SHA256:       normalizeSHA256(m.SidecarArtifact.SidecarSHA256),
		SigURL:       strings.TrimSpace(m.SidecarArtifact.SidecarSigURL),
		SigningKeyID: strings.TrimSpace(m.SidecarArtifact.SigningKeyID),
	}
	if artifact.URL == "" {
		artifact.URL = strings.TrimSpace(m.SidecarURL)
	}
	if artifact.SHA256 == "" {
		artifact.SHA256 = normalizeSHA256(m.SidecarSHA256)
	}
	if artifact.SigURL == "" {
		artifact.SigURL = strings.TrimSpace(m.SidecarSigURL)
	}
	if artifact.SigningKeyID == "" {
		artifact.SigningKeyID = strings.TrimSpace(m.SigningKeyID)
	}
	return artifact
}

type acpCloudAgentSessionRequest struct {
	SessionID string `json:"session_id"`
}

type acpSetConfigOptionRequest struct {
	SessionID string `json:"sessionId"`
	ConfigID  string `json:"configId"`
	Value     string `json:"value"`
}

type acpSessionIDRequest struct {
	SessionID string `json:"sessionId"`
}

type acpCreateSessionResult struct {
	SessionID      string         `json:"sessionId"`
	ConfigOptions  []ConfigOption `json:"configOptions"`
	ReadOnly       bool           `json:"readOnly,omitempty"`
	ReadOnlyReason string         `json:"readOnlyReason,omitempty"`
	SessionProxyID string         `json:"session_proxy_id,omitempty"`
}

type acpListSessionsResult struct {
	Sessions []acpSessionListItem `json:"sessions"`
}

type acpPromptResult struct {
	StopReason string `json:"stopReason"`
}

type acpReadOnlyError struct {
	Reason string
}

func (e acpReadOnlyError) Error() string {
	return "session is read-only"
}

type acpRuntimeUnavailableError struct {
	SessionID      string
	RuntimeID      string
	OuterSandboxID string
	Reason         string
	Detail         string
}

func (e acpRuntimeUnavailableError) Error() string {
	return "session runtime is unavailable"
}

func NewACPGateway(store *Store, worker Worker) *ACPGateway {
	return &ACPGateway{
		store:            store,
		worker:           worker,
		runtimeManager:   newACPSessionRuntimeManager(worker),
		sessions:         map[string]*acpSession{},
		cleanups:         map[string]*acpRuntimeCleanup{},
		envdEnsures:      map[string]*envdEnsureCall{},
		staleProxyIDs:    map[string]struct{}{},
		forceEnvdEnsures: map[string]struct{}{},
	}
}

func (g *ACPGateway) HandleRawWS(w http.ResponseWriter, r *http.Request) {
	scope, errResp := acpScopeFromRequest(r)
	if errResp != nil {
		writeError(w, http.StatusUnauthorized, errResp.Code, errResp.Message)
		return
	}
	ws, err := AcceptWebSocket(w, r)
	if err != nil {
		writeError(w, http.StatusBadRequest, "websocket_upgrade_failed", err.Error())
		return
	}
	g.serveRawConnection(r.Context(), ws, scope)
}

func (g *ACPGateway) HandleAppWS(w http.ResponseWriter, r *http.Request) {
	scope, errResp := acpScopeFromRequest(r)
	if errResp != nil {
		writeError(w, http.StatusUnauthorized, errResp.Code, errResp.Message)
		return
	}
	ws, err := AcceptWebSocket(w, r)
	if err != nil {
		writeError(w, http.StatusBadRequest, "websocket_upgrade_failed", err.Error())
		return
	}
	g.serveAppConnection(r.Context(), ws, scope)
}

func (g *ACPGateway) serveRawConnection(parent context.Context, ws *WSConn, scope Scope) {
	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	defer ws.Close()
	for {
		frame, err := ws.ReadText()
		if err != nil {
			return
		}
		msg, err := parseJSONRPC(frame)
		if err != nil {
			_ = writeJSONRPCError(ws, nil, -32600, err.Error())
			continue
		}
		if msg.Method == "" {
			continue
		}
		if len(msg.ID) == 0 {
			continue
		}
		if err := g.handleRequest(ctx, ws, scope, msg, false); err != nil {
			_ = g.writeResponse(ws, false, mustJSONRPCErrorFromError(msg.ID, err))
		}
	}
}

func (g *ACPGateway) serveAppConnection(parent context.Context, ws *WSConn, scope Scope) {
	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	defer ws.Close()
	_ = writeACPAppEnvelope(ws, acpAppEnvelope{Type: "connection", Status: "connected"})
	for {
		frame, err := ws.ReadText()
		if err != nil {
			return
		}
		payload := unwrapACPAppMessage(frame)
		msg, err := parseJSONRPC(payload)
		if err != nil {
			_ = writeACPAppError(ws, "bad_request", "invalid_jsonrpc", err.Error())
			continue
		}
		if msg.Method == "" {
			continue
		}
		if len(msg.ID) == 0 {
			continue
		}
		_ = writeACPAppMessage(ws, "send", payload)
		if err := g.handleRequest(ctx, ws, scope, msg, true); err != nil {
			_ = g.writeResponse(ws, true, mustJSONRPCErrorFromError(msg.ID, err))
		}
	}
}

func (g *ACPGateway) handleRequest(ctx context.Context, ws *WSConn, scope Scope, msg jsonRPCMessage, appEnvelope bool) error {
	switch msg.Method {
	case "initialize":
		result := map[string]any{
			"protocolVersion": 1,
			"agentCapabilities": map[string]any{
				"loadSession": true,
				"sessionCapabilities": map[string]any{
					"list":   map[string]any{},
					"resume": map[string]any{},
					"close":  map[string]any{},
					"delete": map[string]any{},
				},
				"promptCapabilities": map[string]any{
					"image":           false,
					"embeddedContext": false,
				},
				"_meta": map[string]any{
					"cloudagent": map[string]any{
						"methods":     []string{"_cloudagent.session.status"},
						"field_style": "snake_case",
					},
				},
			},
		}
		return g.writeResponse(ws, appEnvelope, mustJSONRPCResult(msg.ID, result))
	case "session/list":
		items := g.listSessions(scope)
		return g.writeResponse(ws, appEnvelope, mustJSONRPCResult(msg.ID, acpListSessionsResult{Sessions: items}))
	case "session/new":
		var req acpSessionRequest
		if err := decodeJSONRPCParams(msg.Params, &req); err != nil {
			return err
		}
		session, err := g.createSession(ctx, scope, req)
		if err != nil {
			return err
		}
		return g.writeResponse(ws, appEnvelope, mustJSONRPCResult(msg.ID, acpSessionResult(session)))
	case "session/load":
		var req acpSessionRequest
		if err := decodeJSONRPCParams(msg.Params, &req); err != nil {
			return err
		}
		session, err := g.loadSession(scope, req.SessionID, req.CWD)
		if err != nil {
			return err
		}
		if err := g.writeResponse(ws, appEnvelope, mustJSONRPCResult(msg.ID, acpSessionResult(session))); err != nil {
			return err
		}
		for _, event := range session.Events {
			update, ok := acpReplayUpdate(event)
			if !ok {
				continue
			}
			if err := g.writeNotification(ws, appEnvelope, "session/update", update); err != nil {
				return err
			}
		}
		if len(session.Events) == 0 {
			for _, item := range session.History {
				if strings.TrimSpace(item.Text) == "" {
					continue
				}
				update := map[string]any{
					"sessionId": session.SessionID,
					"update": map[string]any{
						"sessionUpdate": mapRoleToReplayUpdate(item.Role),
						"content":       map[string]any{"text": item.Text},
					},
				}
				if err := g.writeNotification(ws, appEnvelope, "session/update", update); err != nil {
					return err
				}
			}
		}
		if err := g.writeNotification(ws, appEnvelope, "session/update", map[string]any{
			"sessionId": session.SessionID,
			"update": map[string]any{
				"sessionUpdate": "replay_done",
			},
		}); err != nil {
			return err
		}
		return nil
	case "session/resume":
		var req acpSessionRequest
		if err := decodeJSONRPCParams(msg.Params, &req); err != nil {
			return err
		}
		session, err := g.resumeSession(ctx, scope, req.SessionID, req.CWD)
		if err != nil {
			return err
		}
		return g.writeResponse(ws, appEnvelope, mustJSONRPCResult(msg.ID, acpSessionResult(session)))
	case "session/set_config_option":
		var req acpSetConfigOptionRequest
		if err := decodeJSONRPCParams(msg.Params, &req); err != nil {
			return err
		}
		session, err := g.getSession(scope, req.SessionID)
		if err != nil {
			return err
		}
		if err := g.applyConfigOption(session, req.ConfigID, req.Value); err != nil {
			return err
		}
		update := map[string]any{
			"sessionId": session.SessionID,
			"update": map[string]any{
				"sessionUpdate": "config_option_update",
				"configOptions": cloneConfigOptions(session.ConfigOptions),
			},
		}
		if err := g.writeNotification(ws, appEnvelope, "session/update", update); err != nil {
			return err
		}
		return g.writeResponse(ws, appEnvelope, mustJSONRPCResult(msg.ID, map[string]any{"configOptions": cloneConfigOptions(session.ConfigOptions)}))
	case "_cloudagent.session.status":
		var req acpCloudAgentSessionRequest
		if err := decodeJSONRPCParams(msg.Params, &req); err != nil {
			return err
		}
		status, err := g.cloudAgentSessionStatus(scope, req.SessionID)
		if err != nil {
			return err
		}
		return g.writeResponse(ws, appEnvelope, mustJSONRPCResult(msg.ID, status))
	case "session/prompt":
		var req acpPromptRequest
		if err := decodeJSONRPCParams(msg.Params, &req); err != nil {
			return err
		}
		session, err := g.getSession(scope, req.SessionID)
		if err != nil {
			return err
		}
		if session.ReadOnlyReason != "" {
			return g.writeResponse(ws, appEnvelope, mustJSONRPCErrorFromError(msg.ID, acpReadOnlyError{Reason: session.ReadOnlyReason}))
		}
		if session.Closed {
			return fmt.Errorf("session is closed; load or resume it before prompting")
		}
		return g.startPrompt(ctx, ws, msg.ID, session, req, appEnvelope)
	case "session/close":
		var req acpSessionIDRequest
		if err := decodeJSONRPCParams(msg.Params, &req); err != nil {
			return err
		}
		heldRun := g.holdPromptInterruptResponse(scope, req.SessionID)
		if err := g.closeSession(scope, req.SessionID); err != nil {
			releasePromptInterruptResponse(heldRun)
			return err
		}
		err := g.writeResponse(ws, appEnvelope, mustJSONRPCResult(msg.ID, map[string]any{}))
		releasePromptInterruptResponse(heldRun)
		return err
	case "session/delete":
		var req acpSessionIDRequest
		if err := decodeJSONRPCParams(msg.Params, &req); err != nil {
			return err
		}
		heldRun := g.holdPromptInterruptResponse(scope, req.SessionID)
		if err := g.deleteSession(scope, req.SessionID); err != nil {
			releasePromptInterruptResponse(heldRun)
			return err
		}
		err := g.writeResponse(ws, appEnvelope, mustJSONRPCResult(msg.ID, map[string]any{}))
		releasePromptInterruptResponse(heldRun)
		return err
	case "session/cancel":
		var req acpSessionIDRequest
		if err := decodeJSONRPCParams(msg.Params, &req); err != nil {
			return err
		}
		if err := g.cancelSessionPrompt(scope, req.SessionID); err != nil {
			return err
		}
		return g.writeResponse(ws, appEnvelope, mustJSONRPCResult(msg.ID, map[string]any{}))
	default:
		return fmt.Errorf("method not found: %s", msg.Method)
	}
}

func (g *ACPGateway) startPrompt(ctx context.Context, ws *WSConn, id json.RawMessage, session *acpSession, req acpPromptRequest, appEnvelope bool) error {
	instruction, userText, inputFiles, err := g.buildPromptInstruction(session.Scope, req.Prompt)
	if err != nil {
		return err
	}
	trimmed := strings.TrimSpace(instruction)
	if trimmed == "" {
		return fmt.Errorf("prompt must contain text or supported resources")
	}
	if err := g.preflightPromptRuntime(ctx, session.Scope, session.SessionID); err != nil {
		return err
	}
	promptCtx, cancel := context.WithCancel(ctx)
	run, promptJob, err := g.beginPrompt(session.Scope, session.SessionID, cancel, req.CWD, trimmed, userText, inputFiles)
	if err != nil {
		cancel()
		return err
	}
	run.setResponseTarget(ws, id, appEnvelope)
	go g.runPromptAsync(promptCtx, ws, id, session.SessionID, promptJob, run, appEnvelope)
	return nil
}

func (g *ACPGateway) runPromptAsync(ctx context.Context, ws *WSConn, id json.RawMessage, sessionID string, job workerJob, run *acpPromptRun, appEnvelope bool) {
	start := time.Now()
	var streamSeq int64
	emit := func(ev workerEvent) error {
		if !g.promptCanEmit(sessionID, run) {
			return context.Canceled
		}
		update, deltaBytes, ok := acpUpdateFromWorkerEvent(ev)
		if !ok {
			return nil
		}
		if g.store != nil && run.TurnID != "" && run.AssistantMessageID != "" {
			blockType, toolCallID := canonicalBlockTypeFromWorkerEvent(ev)
			if blockType != "" {
				blockID, err := g.store.UpsertACPAssistantBlock(sessionID, run.TurnID, run.AssistantMessageID, job.ResponseID, blockType, toolCallID, update)
				if err != nil {
					return err
				}
				update["messageId"] = run.AssistantMessageID
				update["blockId"] = blockID
			}
		}
		seq := atomic.AddInt64(&streamSeq, 1)
		fmt.Fprintf(os.Stderr, "timeline source=server t=%.3fs event=acp_ws_stream_emit_start session_id=%s job_id=%s kind=%s seq=%d delta_bytes=%d app_envelope=%t\n", time.Since(start).Seconds(), sessionID, job.JobID, ev.Kind, seq, deltaBytes, appEnvelope)
		err := g.writeNotification(ws, appEnvelope, "session/update", map[string]any{
			"sessionId": sessionID,
			"update":    update,
		})
		if err != nil {
			fmt.Fprintf(os.Stderr, "timeline source=server t=%.3fs event=acp_ws_stream_emit_failed session_id=%s job_id=%s kind=%s seq=%d delta_bytes=%d error=%q\n", time.Since(start).Seconds(), sessionID, job.JobID, ev.Kind, seq, deltaBytes, err.Error())
			return err
		}
		fmt.Fprintf(os.Stderr, "timeline source=server t=%.3fs event=acp_ws_stream_emit_done session_id=%s job_id=%s kind=%s seq=%d delta_bytes=%d\n", time.Since(start).Seconds(), sessionID, job.JobID, ev.Kind, seq, deltaBytes)
		return nil
	}
	result, err := g.runPromptWorker(ctx, job, emit)
	if err != nil && isRecoverablePromptRuntimeError(err) {
		recoveredJob, recovered := g.recoverPromptRuntime(ctx, sessionID, run, job, err)
		if recovered {
			result, err = g.runPromptWorker(ctx, recoveredJob, emit)
			job = recoveredJob
		}
	}
	if err != nil {
		if reason := run.stopReason(); reason != "" {
			_ = g.finishInterruptedPrompt(ws, id, appEnvelope, sessionID, run, reason)
			return
		}
		_ = g.finishFailedPrompt(ws, id, appEnvelope, sessionID, run, err)
		return
	}
	if reason := run.stopReason(); reason != "" {
		_ = g.finishInterruptedPrompt(ws, id, appEnvelope, sessionID, run, reason)
		return
	}
	if err := g.finishSuccessfulPrompt(sessionID, run, job.ResponseID, result, result.RuntimeUpdate); err != nil {
		_ = g.writeResponse(ws, appEnvelope, mustJSONRPCError(id, -32000, err.Error()))
		return
	}
	_ = g.writeResponse(ws, appEnvelope, mustJSONRPCResult(id, acpPromptResult{StopReason: "end_turn"}))
}

func (g *ACPGateway) runPromptWorker(ctx context.Context, job workerJob, emit func(workerEvent) error) (workerResult, error) {
	if g.worker == nil {
		return workerResult{}, fmt.Errorf("acp prompt worker is unavailable")
	}
	result, err := g.worker.Run(ctx, job, emit)
	if err != nil {
		return workerResult{}, err
	}
	if result.JobID == "" {
		result.JobID = job.JobID
	}
	if result.WorkerContractVersion == "" {
		result.WorkerContractVersion = WorkerContractVersion
	}
	if result.Status == "" {
		result.Status = "completed"
	}
	return result, nil
}

func acpUpdateFromWorkerEvent(ev workerEvent) (map[string]any, int, bool) {
	switch ev.Kind {
	case "output_text_delta":
		if ev.Delta == "" {
			return nil, 0, false
		}
		return map[string]any{
			"sessionUpdate": "agent_message_chunk",
			"content":       map[string]any{"text": ev.Delta},
		}, len(ev.Delta), true
	case "reasoning_delta":
		if ev.Delta == "" {
			return nil, 0, false
		}
		return map[string]any{
			"sessionUpdate": "agent_thought_chunk",
			"content":       map[string]any{"text": ev.Delta},
		}, len(ev.Delta), true
	case "tool_call":
		return acpToolCallUpdate("tool_call", ev), 0, true
	case "tool_call_update":
		return acpToolCallUpdate("tool_call_update", ev), 0, true
	default:
		return nil, 0, false
	}
}

func canonicalBlockTypeFromWorkerEvent(ev workerEvent) (string, string) {
	switch ev.Kind {
	case "output_text_delta":
		return "text", ""
	case "reasoning_delta":
		return "reasoning", ""
	case "tool_call", "tool_call_update":
		return "tool", firstNonEmpty(ev.ToolCallID, ev.EventID, ev.JobID)
	default:
		return "", ""
	}
}

func acpToolCallUpdate(kind string, ev workerEvent) map[string]any {
	toolCallID := firstNonEmpty(ev.ToolCallID, ev.EventID, ev.JobID)
	name := strings.TrimSpace(ev.ToolName)
	if name == "" && kind == "tool_call" {
		name = toolCallID
	}
	status := acpToolStatus(firstNonEmpty(ev.ToolStatus, "running"))
	update := map[string]any{
		"sessionUpdate": kind,
		"toolCallId":    toolCallID,
		"id":            toolCallID,
		"kind":          acpToolKind(name),
		"status":        status,
		"toolCall": map[string]any{
			"toolCallId": toolCallID,
			"id":         toolCallID,
			"kind":       acpToolKind(name),
			"status":     status,
		},
	}
	if name != "" {
		update["name"] = name
		update["title"] = name
		nested := update["toolCall"].(map[string]any)
		nested["name"] = name
		nested["title"] = name
	}
	if ev.ToolError != "" {
		update["error"] = ev.ToolError
	}
	if len(ev.ToolRawInput) > 0 {
		update["rawInput"] = rawJSONValue(ev.ToolRawInput)
		nested := update["toolCall"].(map[string]any)
		nested["rawInput"] = rawJSONValue(ev.ToolRawInput)
	}
	if len(ev.ToolRawOutput) > 0 {
		update["rawOutput"] = rawJSONValue(ev.ToolRawOutput)
		nested := update["toolCall"].(map[string]any)
		nested["rawOutput"] = rawJSONValue(ev.ToolRawOutput)
	}
	if ev.ToolContent != "" || ev.ToolError != "" {
		text := firstNonEmpty(ev.ToolError, ev.ToolContent)
		update["content"] = []map[string]any{{"type": "content", "content": truncateToolText(text, 4000)}}
	}
	return update
}

func acpToolStatus(status string) string {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "running", "in_progress":
		return "in_progress"
	case "done", "completed", "success":
		return "completed"
	case "error", "failed":
		return "failed"
	case "pending":
		return "pending"
	default:
		return status
	}
}

func acpToolKind(name string) string {
	switch name {
	case "web_search", "memory_search":
		return "search"
	case "web_fetch", "http_request":
		return "fetch"
	case "terminal", "code_execution", "patch":
		return "execute"
	case "todo":
		return "edit"
	default:
		return "other"
	}
}

func rawJSONValue(raw json.RawMessage) any {
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		return string(raw)
	}
	return value
}

func truncateToolText(value string, limit int) string {
	if len(value) <= limit {
		return value
	}
	return value[:limit] + "\n...[truncated]"
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

func (g *ACPGateway) persistSession(session *acpSession) {
	if g.store == nil || session == nil {
		return
	}
	if err := g.store.SaveACPSession(session); err != nil {
		fmt.Fprintf(os.Stderr, "timeline source=server event=acp_session_persist_failed session_id=%s error=%s\n", session.SessionID, quoteServerField(err.Error()))
	}
}

func (g *ACPGateway) recoverPromptRuntime(ctx context.Context, sessionID string, run *acpPromptRun, job workerJob, cause error) (workerJob, bool) {
	g.mu.Lock()
	session, ok := g.sessions[sessionID]
	if !ok || session.CurrentPrompt != run || session.RuntimeGeneration != run.Generation || session.State != acpRuntimeStatePrompting || run.stopReason() != "" {
		g.mu.Unlock()
		return job, false
	}
	staleRuntime := job.ACPSessionRuntime
	historyLen := run.HistoryLenBefore
	if historyLen > len(session.History) {
		historyLen = len(session.History)
	}
	history := cloneHistory(session.History[:historyLen])
	g.markStaleRuntimeProxyLocked(session.Runtime)
	session.RuntimeGeneration++
	run.Generation = session.RuntimeGeneration
	session.Runtime = ACPSessionRuntime{}
	session.LastRuntimeError = cause.Error()
	session.UpdatedAt = time.Now().UTC()
	g.persistSession(session)
	startReq := ACPSessionRuntimeStartRequest{
		SessionID:        session.SessionID,
		Scope:            session.Scope,
		CWD:              sidecarRequestCWD(),
		History:          history,
		Generation:       session.RuntimeGeneration,
		SandboxBackend:   staleRuntime.SandboxBackend,
		AgentVersion:     staleRuntime.AgentVersion,
		WorkspaceVersion: staleRuntime.WorkspaceVersion,
	}
	recoveredJob := job
	recoveredJob.ACPSessionGeneration = session.RuntimeGeneration
	generation := session.RuntimeGeneration
	g.mu.Unlock()

	fmt.Fprintf(os.Stderr, "timeline source=server event=acp_runtime_recover_start session_id=%s old_outer_sandbox_id=%s error=%s\n", sessionID, staleRuntime.OuterSandboxID, quoteServerField(cause.Error()))
	if staleRuntime.RuntimeID != "" || staleRuntime.OuterSandboxID != "" {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		_ = g.runtimeManager.CloseSessionRuntime(cleanupCtx, staleRuntime)
		cancel()
	}
	recoveredRuntime, err := g.runtimeManager.StartSessionRuntime(ctx, startReq)
	g.mu.Lock()
	defer g.mu.Unlock()
	current, ok := g.sessions[sessionID]
	if !ok || current.CurrentPrompt != run || current.RuntimeGeneration != generation {
		if err == nil {
			go func() {
				cleanupCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
				defer cancel()
				_ = g.runtimeManager.CloseSessionRuntime(cleanupCtx, recoveredRuntime)
			}()
		}
		return recoveredJob, false
	}
	if err != nil {
		current.State = acpRuntimeStateFailed
		current.LastRuntimeError = err.Error()
		current.UpdatedAt = time.Now().UTC()
		g.persistSession(current)
		fmt.Fprintf(os.Stderr, "timeline source=server event=acp_runtime_recover_failed session_id=%s error=%s\n", sessionID, quoteServerField(err.Error()))
		return recoveredJob, false
	}
	current.Runtime = recoveredRuntime
	g.ensureRuntimeProxyIDLocked(current)
	current.State = acpRuntimeStatePrompting
	current.Closed = false
	current.LastRuntimeError = ""
	current.UpdatedAt = time.Now().UTC()
	g.persistSession(current)
	fmt.Fprintf(os.Stderr, "timeline source=server event=acp_runtime_recover_done session_id=%s new_outer_sandbox_id=%s\n", sessionID, recoveredRuntime.OuterSandboxID)
	recoveredJob.ACPSessionRuntime = recoveredRuntime
	return recoveredJob, true
}

func (g *ACPGateway) preflightPromptRuntime(ctx context.Context, scope Scope, sessionID string) error {
	g.mu.Lock()
	session, ok := g.sessions[sessionID]
	if !ok {
		g.mu.Unlock()
		return fmt.Errorf("session not found")
	}
	if !sameScope(scope, session.Scope) {
		g.mu.Unlock()
		return fmt.Errorf("session is outside caller scope")
	}
	if session.ReadOnlyReason != "" {
		reason := firstNonEmpty(session.ReadOnlyReason, acpReadOnlyRuntimeNotRecovered)
		g.mu.Unlock()
		return acpReadOnlyError{Reason: reason}
	}
	if session.Closed || session.State == acpRuntimeStateClosed {
		g.mu.Unlock()
		return fmt.Errorf("session is closed; resume it before prompting")
	}
	if session.State != acpRuntimeStateReady {
		g.mu.Unlock()
		return fmt.Errorf("session is not ready")
	}
	if session.CurrentPrompt != nil {
		g.mu.Unlock()
		return fmt.Errorf("session already has an in-flight prompt")
	}
	runtime := session.Runtime
	generation := session.RuntimeGeneration
	if !runtimeNeedsCleanup(runtime) {
		session.State = acpRuntimeStateClosed
		session.Closed = true
		session.ReadOnlyReason = acpReadOnlyRuntimeNotRecovered
		session.LastRuntimeError = "runtime identity is missing"
		session.UpdatedAt = time.Now().UTC()
		g.persistSession(session)
		g.mu.Unlock()
		return acpRuntimeUnavailableError{
			SessionID: sessionID,
			Reason:    acpReadOnlyRuntimeNotRecovered,
			Detail:    "runtime identity is missing",
		}
	}
	g.mu.Unlock()

	checked, err := g.runtimeManager.ReattachSessionRuntime(ctx, runtime)
	if err != nil {
		return g.markPromptRuntimeUnavailable(sessionID, generation, runtime, err)
	}

	g.mu.Lock()
	if current, ok := g.sessions[sessionID]; ok && current.RuntimeGeneration == generation && current.State == acpRuntimeStateReady && !current.Closed {
		current.Runtime = checked
		current.LastRuntimeError = ""
		current.ReadOnlyReason = ""
		current.UpdatedAt = time.Now().UTC()
		g.persistSession(current)
	}
	g.mu.Unlock()
	return nil
}

func (g *ACPGateway) markPromptRuntimeUnavailable(sessionID string, generation int64, runtime ACPSessionRuntime, cause error) error {
	detail := ""
	if cause != nil {
		detail = cause.Error()
	}
	g.mu.Lock()
	if session, ok := g.sessions[sessionID]; ok && session.RuntimeGeneration == generation {
		session.State = acpRuntimeStateClosed
		session.Closed = true
		session.CurrentPrompt = nil
		session.CurrentResponseID = ""
		session.LastRuntimeError = detail
		session.ReadOnlyReason = acpReadOnlyRuntimeNotRecovered
		session.UpdatedAt = time.Now().UTC()
		g.persistSession(session)
	}
	g.mu.Unlock()
	fmt.Fprintf(os.Stderr, "timeline source=server event=acp_runtime_preflight_unavailable session_id=%s runtime_id=%s outer_sandbox_id=%s error=%s\n", sessionID, runtime.RuntimeID, runtime.OuterSandboxID, quoteServerField(detail))
	return acpRuntimeUnavailableError{
		SessionID:      sessionID,
		RuntimeID:      runtime.RuntimeID,
		OuterSandboxID: runtime.OuterSandboxID,
		Reason:         acpReadOnlyRuntimeNotRecovered,
		Detail:         detail,
	}
}

func (g *ACPGateway) listSessions(scope Scope) []acpSessionListItem {
	var persisted []*acpSession
	if g.store != nil {
		if sessions, err := g.store.ListACPSessions(scope); err == nil {
			persisted = sessions
		}
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	for _, session := range persisted {
		if _, ok := g.sessions[session.SessionID]; !ok {
			g.sessions[session.SessionID] = session
		}
	}
	items := make([]acpSessionListItem, 0, len(g.sessions))
	for _, session := range g.sessions {
		if !sameScope(scope, session.Scope) {
			continue
		}
		if session.State == acpRuntimeStateStarting || session.State == acpRuntimeStateClosing {
			continue
		}
		items = append(items, acpSessionListItem{
			SessionID:      session.SessionID,
			CWD:            session.CWD,
			Title:          sessionTitle(session),
			UpdatedAt:      session.UpdatedAt.Format(time.RFC3339),
			State:          string(session.State),
			ReadOnly:       session.ReadOnlyReason != "",
			ReadOnlyReason: session.ReadOnlyReason,
		})
	}
	sort.Slice(items, func(i, j int) bool {
		return items[i].UpdatedAt > items[j].UpdatedAt
	})
	return items
}

func acpSessionResult(session *acpSession) acpCreateSessionResult {
	if session == nil {
		return acpCreateSessionResult{}
	}
	return acpCreateSessionResult{
		SessionID:      session.SessionID,
		ConfigOptions:  cloneConfigOptions(session.ConfigOptions),
		ReadOnly:       session.ReadOnlyReason != "",
		ReadOnlyReason: session.ReadOnlyReason,
		SessionProxyID: session.Runtime.SessionProxyID,
	}
}

func (g *ACPGateway) cloudAgentSessionStatus(scope Scope, sessionID string) (map[string]any, error) {
	if strings.TrimSpace(sessionID) == "" {
		return nil, fmt.Errorf("session_id is required")
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	session, ok := g.sessions[sessionID]
	if !ok {
		return nil, fmt.Errorf("session not found")
	}
	if !sameScope(scope, session.Scope) {
		return nil, fmt.Errorf("session is outside caller scope")
	}
	g.ensureRuntimeProxyIDLocked(session)
	runtime := session.Runtime
	backend := runtime.SandboxBackend
	if backend == "" && runtimeNeedsCleanup(runtime) {
		backend = "ags"
	}
	status := map[string]any{
		"session_id":          session.SessionID,
		"state":               string(session.State),
		"closed":              session.Closed,
		"read_only":           session.ReadOnlyReason != "",
		"read_only_reason":    session.ReadOnlyReason,
		"cwd":                 session.CWD,
		"model":               session.Model,
		"current_response_id": session.CurrentResponseID,
		"prompt_in_flight":    session.CurrentPrompt != nil,
		"runtime_generation":  session.RuntimeGeneration,
		"session_proxy_id":    runtime.SessionProxyID,
		"envd_proxy_domain":   envdProxyDomain(),
		"cleanup_pending":     g.cleanups[sessionID] != nil,
		"last_runtime_error":  session.LastRuntimeError,
		"created_at":          session.CreatedAt.Format(time.RFC3339Nano),
		"updated_at":          session.UpdatedAt.Format(time.RFC3339Nano),
		"message_count":       len(session.History),
		"event_count":         len(session.Events),
		"sandbox": map[string]any{
			"backend":                     backend,
			"agent_version":               runtime.AgentVersion,
			"agent_template_id":           runtime.AgentTemplateID,
			"workspace_version":           runtime.WorkspaceVersion,
			"workspace_template_id":       runtime.WorkspaceTemplateID,
			"runtime_id":                  runtime.RuntimeID,
			"outer_sandbox_id":            runtime.OuterSandboxID,
			"outer_sandbox_domain":        runtime.OuterSandboxDomain,
			"daemon_addr":                 runtime.DaemonAddr,
			"remote_binary":               runtime.RemoteBinary,
			"has_outer_envd_access_token": runtime.OuterEnvdAccessToken != "",
			"has_outer_traffic_token":     runtime.OuterTrafficToken != "",
			"has_inner_envd_target":       runtime.hasInnerEnvdTarget(),
		},
	}
	g.persistSession(session)
	return status, nil
}

func acpReplayUpdate(event acpSessionEvent) (map[string]any, bool) {
	var payload map[string]any
	if len(event.Payload) == 0 || json.Unmarshal(event.Payload, &payload) != nil {
		return nil, false
	}
	return map[string]any{
		"sessionId": event.SessionID,
		"update":    payload,
	}, true
}

func (g *ACPGateway) createSession(ctx context.Context, scope Scope, req acpSessionRequest) (*acpSession, error) {
	sidecarArtifact := req.Meta.CloudAgent.sidecarArtifact()
	g.mu.Lock()
	sessionID := "session_" + randomHex(16)
	now := time.Now().UTC()
	session := &acpSession{
		SessionID:         sessionID,
		Scope:             scope,
		Model:             defaultACPModel(),
		CWD:               defaultSessionCWD(req.CWD),
		CreatedAt:         now,
		UpdatedAt:         now,
		State:             acpRuntimeStateStarting,
		RuntimeGeneration: 1,
		ConfigOptions:     defaultACPConfigOptions(),
	}
	g.sessions[sessionID] = session
	startReq := ACPSessionRuntimeStartRequest{
		SessionID:        session.SessionID,
		Scope:            session.Scope,
		CWD:              sidecarRequestCWD(),
		History:          cloneHistory(session.History),
		Generation:       session.RuntimeGeneration,
		SandboxBackend:   strings.ToLower(strings.TrimSpace(req.Meta.CloudAgent.SandboxBackend)),
		AgentVersion:     strings.TrimSpace(req.Meta.CloudAgent.AgentVersion),
		WorkspaceVersion: strings.TrimSpace(req.Meta.CloudAgent.WorkspaceVersion),
		SidecarArtifact:  sidecarArtifact,
	}
	g.mu.Unlock()
	runtime, err := g.runtimeManager.StartSessionRuntime(ctx, startReq)
	g.mu.Lock()
	defer g.mu.Unlock()
	if current, ok := g.sessions[sessionID]; ok && current.RuntimeGeneration == startReq.Generation {
		current.UpdatedAt = time.Now().UTC()
		if err != nil {
			current.State = acpRuntimeStateFailed
			current.LastRuntimeError = err.Error()
			g.persistSession(current)
			return cloneSession(current), err
		}
		current.Runtime = runtime
		g.ensureRuntimeProxyIDLocked(current)
		current.State = acpRuntimeStateReady
		current.Closed = false
		g.persistSession(current)
		return cloneSession(current), nil
	}
	if err != nil {
		return nil, err
	}
	return nil, fmt.Errorf("session changed while starting runtime")
}

func (g *ACPGateway) getSession(scope Scope, sessionID string) (*acpSession, error) {
	if strings.TrimSpace(sessionID) == "" {
		return nil, fmt.Errorf("sessionId is required")
	}
	g.mu.Lock()
	session, ok := g.sessions[sessionID]
	if !ok {
		g.mu.Unlock()
		if g.store == nil {
			return nil, fmt.Errorf("session not found")
		}
		loaded, err := g.store.LoadACPSession(scope, sessionID)
		if err != nil {
			return nil, err
		}
		g.mu.Lock()
		g.sessions[sessionID] = loaded
		session = loaded
	}
	if !sameScope(scope, session.Scope) {
		g.mu.Unlock()
		return nil, fmt.Errorf("session is outside caller scope")
	}
	g.mu.Unlock()
	return session, nil
}

func (g *ACPGateway) loadSession(scope Scope, sessionID, cwd string) (*acpSession, error) {
	g.mu.Lock()
	session, ok := g.sessions[sessionID]
	if !ok {
		g.mu.Unlock()
		if g.store == nil {
			return nil, fmt.Errorf("session not found")
		}
		loaded, err := g.store.LoadACPSession(scope, sessionID)
		if err != nil {
			return nil, err
		}
		g.mu.Lock()
		g.sessions[sessionID] = loaded
		session = loaded
	}
	if !sameScope(scope, session.Scope) {
		g.mu.Unlock()
		return nil, fmt.Errorf("session is outside caller scope")
	}
	if cwd != "" {
		session.CWD = defaultSessionCWD(cwd)
	}
	session.UpdatedAt = time.Now().UTC()
	g.persistSession(session)
	out := cloneSession(session)
	g.mu.Unlock()
	return out, nil
}

func (g *ACPGateway) resumeSession(ctx context.Context, scope Scope, sessionID, cwd string) (*acpSession, error) {
	g.mu.Lock()
	session, ok := g.sessions[sessionID]
	if !ok {
		g.mu.Unlock()
		if g.store == nil {
			return nil, fmt.Errorf("session not found")
		}
		loaded, err := g.store.LoadACPSession(scope, sessionID)
		if err != nil {
			return nil, err
		}
		g.mu.Lock()
		g.sessions[sessionID] = loaded
		session = loaded
	}
	if !sameScope(scope, session.Scope) {
		g.mu.Unlock()
		return nil, fmt.Errorf("session is outside caller scope")
	}
	if cwd != "" {
		session.CWD = defaultSessionCWD(cwd)
	}
	if cleanup := g.cleanups[sessionID]; cleanup != nil {
		session.ReadOnlyReason = acpReadOnlyRuntimeNotRecovered
		session.State = acpRuntimeStateClosing
		session.Closed = true
		session.UpdatedAt = time.Now().UTC()
		g.persistSession(session)
		out := cloneSession(session)
		g.mu.Unlock()
		return out, nil
	}
	runtime := session.Runtime
	if !runtimeNeedsCleanup(runtime) {
		session.ReadOnlyReason = acpReadOnlyRuntimeNotRecovered
		session.State = acpRuntimeStateClosed
		session.Closed = true
		session.UpdatedAt = time.Now().UTC()
		g.persistSession(session)
		out := cloneSession(session)
		g.mu.Unlock()
		return out, nil
	}
	g.mu.Unlock()
	reattached, err := g.runtimeManager.ReattachSessionRuntime(ctx, runtime)
	g.mu.Lock()
	defer g.mu.Unlock()
	current, ok := g.sessions[sessionID]
	if !ok {
		return nil, fmt.Errorf("session changed while resuming runtime")
	}
	current.UpdatedAt = time.Now().UTC()
	if err != nil {
		current.State = acpRuntimeStateClosed
		current.Closed = true
		current.LastRuntimeError = err.Error()
		current.ReadOnlyReason = acpReadOnlyRuntimeNotRecovered
		g.persistSession(current)
		return cloneSession(current), nil
	}
	current.Runtime = reattached
	g.ensureRuntimeProxyIDLocked(current)
	current.State = acpRuntimeStateReady
	current.Closed = false
	current.ReadOnlyReason = ""
	g.persistSession(current)
	return cloneSession(current), nil
}

func runtimeNeedsCleanup(runtime ACPSessionRuntime) bool {
	return runtime.RuntimeID != "" || runtime.OuterSandboxID != "" || runtime.InnerSandboxID != ""
}

func (g *ACPGateway) closeSession(scope Scope, sessionID string) error {
	_, _, _, err := g.cleanupSessionRuntime(scope, sessionID, "closed")
	return err
}

func (g *ACPGateway) deleteSession(scope Scope, sessionID string) error {
	if strings.TrimSpace(sessionID) == "" {
		return fmt.Errorf("sessionId is required")
	}
	g.mu.Lock()
	session, ok := g.sessions[sessionID]
	if !ok || !sameScope(scope, session.Scope) {
		g.mu.Unlock()
		fmt.Fprintf(os.Stderr, "timeline source=server event=acp_session_delete_noop session_id=%s found=%t\n", sessionID, ok)
		return nil
	}
	historyItems := len(session.History)
	state := session.State
	runtime := session.Runtime
	g.mu.Unlock()
	fmt.Fprintf(os.Stderr, "timeline source=server event=acp_session_delete_start session_id=%s state=%s history_items=%d outer_sandbox_id=%s inner_sandbox_id=%s\n", sessionID, state, historyItems, runtime.OuterSandboxID, runtime.InnerSandboxID)
	if _, _, _, err := g.cleanupSessionRuntime(scope, sessionID, "deleted"); err != nil {
		fmt.Fprintf(os.Stderr, "timeline source=server event=acp_session_delete_failed session_id=%s error=%s\n", sessionID, quoteServerField(err.Error()))
		return err
	}
	if g.store != nil {
		_ = g.store.DeleteACPSession(scope, sessionID)
		_ = g.store.ClearACPRuntimeTokens(sessionID)
	}
	g.mu.Lock()
	delete(g.sessions, sessionID)
	g.mu.Unlock()
	fmt.Fprintf(os.Stderr, "timeline source=server event=acp_session_delete_done session_id=%s history_items=%d outer_sandbox_id=%s inner_sandbox_id=%s\n", sessionID, historyItems, runtime.OuterSandboxID, runtime.InnerSandboxID)
	return nil
}

func (g *ACPGateway) cancelSessionPrompt(scope Scope, sessionID string) error {
	g.mu.Lock()
	session, ok := g.sessions[sessionID]
	if !ok {
		g.mu.Unlock()
		return fmt.Errorf("session not found")
	}
	if !sameScope(scope, session.Scope) {
		g.mu.Unlock()
		return fmt.Errorf("session is outside caller scope")
	}
	if session.CurrentPrompt == nil {
		g.mu.Unlock()
		return nil
	}
	run := session.CurrentPrompt
	g.mu.Unlock()
	run.interrupt("cancelled")
	var promptErr error
	if ws, promptID, promptEnvelope, ok := run.responseTarget(); ok {
		promptErr = g.finishInterruptedPrompt(ws, promptID, promptEnvelope, sessionID, run, "cancelled")
	}
	runtime, _, ok, err := g.cleanupSessionRuntime(scope, sessionID, "cancelled")
	if err != nil || !ok {
		return err
	}
	if runtimeNeedsCleanup(runtime) && promptErr != nil {
		return promptErr
	}
	return nil
}

func (g *ACPGateway) beginPrompt(scope Scope, sessionID string, cancel context.CancelFunc, cwd, prompt, userText string, inputFiles []materializedFile) (*acpPromptRun, workerJob, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	session, ok := g.sessions[sessionID]
	if !ok {
		return nil, workerJob{}, fmt.Errorf("session not found")
	}
	if !sameScope(scope, session.Scope) {
		return nil, workerJob{}, fmt.Errorf("session is outside caller scope")
	}
	if session.Closed || session.State == acpRuntimeStateClosed {
		return nil, workerJob{}, fmt.Errorf("session is closed; resume it before prompting")
	}
	if session.State != acpRuntimeStateReady {
		return nil, workerJob{}, fmt.Errorf("session is not ready")
	}
	if session.CurrentPrompt != nil {
		return nil, workerJob{}, fmt.Errorf("session already has an in-flight prompt")
	}
	if cwd != "" {
		session.CWD = defaultSessionCWD(cwd)
	}
	jobID := "job_" + randomHex(12)
	responseID := "resp_" + randomHex(18)
	var turnRecord acpPromptTurnRecord
	if g.store != nil {
		var err error
		turnRecord, err = g.store.BeginACPPromptTurn(session.SessionID, responseID, userText, inputFiles)
		if err != nil {
			return nil, workerJob{}, err
		}
	}
	run := &acpPromptRun{
		Generation:         session.RuntimeGeneration,
		JobID:              jobID,
		TurnID:             turnRecord.TurnID,
		UserMessageID:      turnRecord.UserMessageID,
		AssistantMessageID: turnRecord.AssistantMessageID,
		HistoryLenBefore:   len(session.History),
		Cancel:             cancel,
	}
	session.CurrentPrompt = run
	session.State = acpRuntimeStatePrompting
	session.CurrentResponseID = responseID
	session.UpdatedAt = time.Now().UTC()
	if len(turnRecord.History) > 0 || len(turnRecord.Events) > 0 {
		session.History = append(session.History, turnRecord.History...)
		session.Events = append(session.Events, turnRecord.Events...)
	} else if userText != "" {
		messageID := "msg_" + randomHex(12)
		run.UserMessageID = messageID
		session.History = append(session.History, acpHistoryEntry{Role: "user", Text: userText, At: session.UpdatedAt, MessageID: messageID, BlockID: "block_" + randomHex(12)})
	}
	job := workerJob{
		WorkerContractVersion: WorkerContractVersion,
		JobID:                 jobID,
		ResponseID:            responseID,
		Model:                 session.Model,
		Scope:                 session.Scope,
		CWD:                   sidecarRequestCWD(),
		Instruction:           prompt,
		InputFiles:            append([]materializedFile(nil), inputFiles...),
		TimeoutSeconds:        300,
		ACPSessionID:          session.SessionID,
		ACPSessionGeneration:  session.RuntimeGeneration,
		ACPSessionRuntime:     session.Runtime,
	}
	g.persistSession(session)
	return run, job, nil
}

func (g *ACPGateway) promptCanEmit(sessionID string, run *acpPromptRun) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	session, ok := g.sessions[sessionID]
	return ok && session.CurrentPrompt == run && session.State == acpRuntimeStatePrompting && session.RuntimeGeneration == run.Generation && run.stopReason() == ""
}

func (g *ACPGateway) finishSuccessfulPrompt(sessionID string, run *acpPromptRun, responseID string, result workerResult, update ACPSessionRuntimeUpdate) error {
	g.mu.Lock()
	defer g.mu.Unlock()
	session, ok := g.sessions[sessionID]
	if !ok {
		return fmt.Errorf("session not found")
	}
	if session.CurrentPrompt != run || session.RuntimeGeneration != run.Generation {
		return fmt.Errorf("prompt generation is stale")
	}
	if update.InnerSandboxID != "" {
		session.Runtime.InnerSandboxID = update.InnerSandboxID
	}
	if update.InnerSandboxDomain != "" {
		session.Runtime.InnerSandboxDomain = update.InnerSandboxDomain
	}
	if update.InnerEnvdAccessToken != "" {
		session.Runtime.InnerEnvdAccessToken = update.InnerEnvdAccessToken
	}
	session.State = acpRuntimeStateReady
	session.CurrentPrompt = nil
	session.UpdatedAt = time.Now().UTC()
	session.CurrentResponseID = responseID
	if g.store != nil && run.TurnID != "" && run.AssistantMessageID != "" {
		if strings.TrimSpace(result.OutputText) != "" && !g.store.AssistantMessageHasTextBlock(run.AssistantMessageID) {
			payload := map[string]any{
				"sessionUpdate": "agent_message_chunk",
				"messageId":     run.AssistantMessageID,
				"content":       map[string]any{"text": result.OutputText},
			}
			if _, err := g.store.UpsertACPAssistantBlock(session.SessionID, run.TurnID, run.AssistantMessageID, responseID, "text", "", payload); err != nil {
				return err
			}
		}
		if err := g.store.CompleteACPTurn(run.TurnID, run.AssistantMessageID); err != nil {
			return err
		}
		if refreshed, err := g.store.LoadACPSession(session.Scope, sessionID); err == nil {
			session.History = refreshed.History
			session.Events = refreshed.Events
		}
	} else if strings.TrimSpace(result.OutputText) != "" {
		messageID := firstNonEmpty(run.AssistantMessageID, "msg_"+randomHex(12))
		blockID := "block_" + randomHex(12)
		session.History = append(session.History, acpHistoryEntry{Role: "assistant", Text: result.OutputText, At: session.UpdatedAt, ResponseID: responseID, MessageID: messageID, BlockID: blockID})
	}
	g.persistSession(session)
	return nil
}

func (g *ACPGateway) finishInterruptedPrompt(ws *WSConn, id json.RawMessage, appEnvelope bool, sessionID string, run *acpPromptRun, reason string) error {
	g.mu.Lock()
	if session, ok := g.sessions[sessionID]; ok && session.CurrentPrompt == run && session.RuntimeGeneration == run.Generation {
		session.CurrentPrompt = nil
		session.CurrentResponseID = ""
		if reason == "cancelled" {
			session.State = acpRuntimeStateReady
		}
		session.UpdatedAt = time.Now().UTC()
		if g.store != nil && run.TurnID != "" && run.AssistantMessageID != "" {
			_ = g.store.CancelACPTurn(run.TurnID, run.AssistantMessageID, reason)
			if refreshed, err := g.store.LoadACPSession(session.Scope, sessionID); err == nil {
				session.History = refreshed.History
				session.Events = refreshed.Events
			}
		}
		g.persistSession(session)
	}
	g.mu.Unlock()
	if !run.markResponded() {
		return nil
	}
	run.waitInterruptResponseReady()
	return g.writeResponse(ws, appEnvelope, mustJSONRPCResult(id, acpPromptResult{StopReason: reason}))
}

func (g *ACPGateway) finishFailedPrompt(ws *WSConn, id json.RawMessage, appEnvelope bool, sessionID string, run *acpPromptRun, err error) error {
	if stopReason := workerStopReason(err); stopReason != "" {
		g.mu.Lock()
		if session, ok := g.sessions[sessionID]; ok && session.CurrentPrompt == run && session.RuntimeGeneration == run.Generation {
			session.CurrentPrompt = nil
			session.State = acpRuntimeStateReady
			session.LastRuntimeError = err.Error()
			session.UpdatedAt = time.Now().UTC()
			if g.store != nil && run.TurnID != "" && run.AssistantMessageID != "" {
				_ = g.store.CompleteACPTurn(run.TurnID, run.AssistantMessageID)
				if refreshed, refreshErr := g.store.LoadACPSession(session.Scope, sessionID); refreshErr == nil {
					session.History = refreshed.History
					session.Events = refreshed.Events
				}
			}
			g.persistSession(session)
		}
		g.mu.Unlock()
		if !run.markResponded() {
			return nil
		}
		return g.writeResponse(ws, appEnvelope, mustJSONRPCResult(id, acpPromptResult{StopReason: stopReason}))
	}
	g.mu.Lock()
	if session, ok := g.sessions[sessionID]; ok && session.CurrentPrompt == run && session.RuntimeGeneration == run.Generation {
		session.CurrentPrompt = nil
		session.State = acpRuntimeStateFailed
		session.LastRuntimeError = err.Error()
		session.UpdatedAt = time.Now().UTC()
		if g.store != nil && run.TurnID != "" && run.AssistantMessageID != "" {
			_ = g.store.FailACPTurn(run.TurnID, run.AssistantMessageID, err.Error())
			if refreshed, refreshErr := g.store.LoadACPSession(session.Scope, sessionID); refreshErr == nil {
				session.History = refreshed.History
				session.Events = refreshed.Events
			}
		}
		g.persistSession(session)
	}
	g.mu.Unlock()
	return g.writeResponse(ws, appEnvelope, mustJSONRPCErrorFromError(id, err))
}

func isRecoverablePromptRuntimeError(err error) bool {
	if err == nil {
		return false
	}
	message := strings.ToLower(err.Error())
	if strings.Contains(message, "ags http 404") ||
		strings.Contains(message, "http 404") && strings.Contains(message, "requested resource does not exist") {
		return true
	}
	return strings.Contains(message, "ags http 401") &&
		strings.Contains(message, "op=run_command") &&
		strings.Contains(message, "authentication_failed")
}

func (g *ACPGateway) cleanupSessionRuntime(scope Scope, sessionID, reason string) (ACPSessionRuntime, int64, bool, error) {
	cleanup, owner, ok, err := g.beginRuntimeCleanup(scope, sessionID, reason)
	if err != nil || !ok {
		return ACPSessionRuntime{}, 0, false, err
	}
	if !owner {
		<-cleanup.Done
		return cleanup.Runtime, cleanup.Generation, true, cleanup.Err
	}

	runtime := cleanup.Runtime
	fmt.Fprintf(os.Stderr, "timeline source=server event=acp_runtime_cleanup_start reason=%s session_id=%s outer_sandbox_id=%s inner_sandbox_id=%s\n", reason, sessionID, runtime.OuterSandboxID, runtime.InnerSandboxID)
	cleanupCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	cleanupErr := g.runtimeManager.CloseSessionRuntime(cleanupCtx, runtime)
	cancel()
	if cleanupErr != nil {
		fmt.Fprintf(os.Stderr, "timeline source=server event=acp_runtime_cleanup_failed reason=%s session_id=%s error=%s\n", reason, sessionID, quoteServerField(cleanupErr.Error()))
		g.completeRuntimeCleanup(sessionID, cleanup, cleanupErr)
		return runtime, cleanup.Generation, true, cleanupErr
	}
	g.completeRuntimeCleanup(sessionID, cleanup, nil)
	fmt.Fprintf(os.Stderr, "timeline source=server event=acp_runtime_cleanup_done reason=%s session_id=%s outer_sandbox_id=%s inner_sandbox_id=%s\n", reason, sessionID, runtime.OuterSandboxID, runtime.InnerSandboxID)
	return runtime, cleanup.Generation, true, nil
}

func (g *ACPGateway) beginRuntimeCleanup(scope Scope, sessionID, reason string) (*acpRuntimeCleanup, bool, bool, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	session, ok := g.sessions[sessionID]
	if !ok {
		return nil, false, false, fmt.Errorf("session not found")
	}
	if !sameScope(scope, session.Scope) {
		return nil, false, false, fmt.Errorf("session is outside caller scope")
	}
	if g.cleanups == nil {
		g.cleanups = map[string]*acpRuntimeCleanup{}
	}
	if cleanup := g.cleanups[sessionID]; cleanup != nil {
		return cleanup, false, true, nil
	}
	if session.CurrentPrompt != nil {
		session.CurrentPrompt.interrupt(reason)
		if session.CurrentPrompt.HistoryLenBefore <= len(session.History) {
			session.History = session.History[:session.CurrentPrompt.HistoryLenBefore]
		}
	}
	runtime := session.Runtime
	g.markStaleRuntimeProxyLocked(runtime)
	session.RuntimeGeneration++
	session.CurrentPrompt = nil
	session.CurrentResponseID = ""
	session.Closed = true
	session.UpdatedAt = time.Now().UTC()
	if !runtimeNeedsCleanup(runtime) {
		session.Runtime = ACPSessionRuntime{}
		session.State = acpRuntimeStateClosed
		session.LastRuntimeError = ""
		session.ReadOnlyReason = ""
		g.persistSession(session)
		if g.store != nil {
			_ = g.store.ClearACPRuntimeTokens(sessionID)
		}
		return nil, false, false, nil
	}
	session.State = acpRuntimeStateClosing
	g.persistSession(session)
	cleanup := &acpRuntimeCleanup{
		Runtime:    runtime,
		Generation: session.RuntimeGeneration,
		Done:       make(chan struct{}),
	}
	g.cleanups[sessionID] = cleanup
	return cleanup, true, true, nil
}

func (g *ACPGateway) completeRuntimeCleanup(sessionID string, cleanup *acpRuntimeCleanup, err error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if current := g.cleanups[sessionID]; current == cleanup {
		delete(g.cleanups, sessionID)
	}
	if session, ok := g.sessions[sessionID]; ok && session.RuntimeGeneration == cleanup.Generation {
		session.State = acpRuntimeStateClosed
		session.Closed = true
		session.UpdatedAt = time.Now().UTC()
		if err != nil {
			session.LastRuntimeError = err.Error()
		} else {
			session.Runtime = ACPSessionRuntime{}
			session.LastRuntimeError = ""
			session.ReadOnlyReason = ""
		}
		g.persistSession(session)
		if g.store != nil && err == nil {
			_ = g.store.ClearACPRuntimeTokens(sessionID)
		}
	}
	cleanup.Err = err
	close(cleanup.Done)
}

func (r *acpPromptRun) interrupt(reason string) {
	r.mu.Lock()
	if r.StopReason == "" {
		r.StopReason = reason
	}
	cancel := r.Cancel
	r.mu.Unlock()
	if cancel != nil {
		cancel()
	}
}

func (r *acpPromptRun) stopReason() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.StopReason
}

func (r *acpPromptRun) setResponseTarget(ws *WSConn, id json.RawMessage, appEnvelope bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.WS = ws
	r.RPCID = append(json.RawMessage(nil), id...)
	r.AppEnvelope = appEnvelope
}

func (r *acpPromptRun) responseTarget() (*WSConn, json.RawMessage, bool, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.WS == nil || len(r.RPCID) == 0 {
		return nil, nil, false, false
	}
	return r.WS, append(json.RawMessage(nil), r.RPCID...), r.AppEnvelope, true
}

func (r *acpPromptRun) markResponded() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.Responded {
		return false
	}
	r.Responded = true
	return true
}

func (g *ACPGateway) holdPromptInterruptResponse(scope Scope, sessionID string) *acpPromptRun {
	g.mu.Lock()
	defer g.mu.Unlock()
	session, ok := g.sessions[sessionID]
	if !ok || !sameScope(scope, session.Scope) || session.CurrentPrompt == nil {
		return nil
	}
	run := session.CurrentPrompt
	run.mu.Lock()
	if run.InterruptReady == nil {
		run.InterruptReady = make(chan struct{})
	}
	run.mu.Unlock()
	return run
}

func releasePromptInterruptResponse(run *acpPromptRun) {
	if run == nil {
		return
	}
	run.mu.Lock()
	ready := run.InterruptReady
	run.InterruptReady = nil
	run.mu.Unlock()
	if ready != nil {
		close(ready)
	}
}

func (r *acpPromptRun) waitInterruptResponseReady() {
	r.mu.Lock()
	ready := r.InterruptReady
	r.mu.Unlock()
	if ready == nil {
		return
	}
	<-ready
}

func (g *ACPGateway) applyConfigOption(session *acpSession, configID, value string) error {
	for i := range session.ConfigOptions {
		if session.ConfigOptions[i].ID != configID {
			continue
		}
		session.ConfigOptions[i].CurrentValue = value
		if session.ConfigOptions[i].Category == "model" {
			session.Model = value
		}
		session.UpdatedAt = time.Now().UTC()
		g.persistSession(session)
		return nil
	}
	return fmt.Errorf("config option not found: %s", configID)
}

func defaultACPConfigOptions() []ConfigOption {
	models := configuredModels()
	choices := make([]ConfigOptionChoice, 0, len(models))
	for _, model := range models {
		choices = append(choices, ConfigOptionChoice{Value: model.ID, Name: model.ID})
	}
	return []ConfigOption{{
		ID:           "model",
		Name:         "Model",
		Category:     "model",
		Type:         "select",
		CurrentValue: defaultACPModel(),
		Options:      choices,
	}}
}

func defaultACPModel() string {
	models := configuredModels()
	if len(models) == 0 {
		return "agent-sidecar-chat"
	}
	return models[0].ID
}

func defaultSessionCWD(value string) string {
	return acpRuntimeCWD
}

func sidecarRequestCWD() string {
	return acpSidecarRequestCWD
}

func sessionTitle(session *acpSession) string {
	for _, item := range session.History {
		if item.Role == "user" && strings.TrimSpace(item.Text) != "" {
			text := strings.TrimSpace(item.Text)
			runes := []rune(text)
			if len(runes) > 32 {
				return string(runes[:32])
			}
			return text
		}
	}
	return "New conversation"
}

func cloneConfigOptions(options []ConfigOption) []ConfigOption {
	if len(options) == 0 {
		return nil
	}
	out := make([]ConfigOption, len(options))
	copy(out, options)
	for i := range out {
		if len(options[i].Options) == 0 {
			continue
		}
		out[i].Options = append([]ConfigOptionChoice(nil), options[i].Options...)
	}
	return out
}

func cloneSession(session *acpSession) *acpSession {
	copySession := *session
	copySession.ConfigOptions = cloneConfigOptions(session.ConfigOptions)
	copySession.History = cloneHistory(session.History)
	copySession.Events = append([]acpSessionEvent(nil), session.Events...)
	return &copySession
}

func cloneHistory(history []acpHistoryEntry) []acpHistoryEntry {
	return append([]acpHistoryEntry(nil), history...)
}

func (g *ACPGateway) buildPromptInstruction(scope Scope, blocks []acpPromptBlock) (string, string, []materializedFile, error) {
	var parts []string
	var userParts []string
	var files []materializedFile
	for _, block := range blocks {
		switch block.Type {
		case "text":
			if strings.TrimSpace(block.Text) != "" {
				text := strings.TrimSpace(block.Text)
				parts = append(parts, text)
				userParts = append(userParts, text)
			}
		case "image":
			return "", "", nil, fmt.Errorf("unsupported prompt block type %q in text-only ACP runtime", block.Type)
		case "resource":
			file, err := g.materializePromptResource(scope, block.Resource)
			if err != nil {
				return "", "", nil, err
			}
			files = append(files, file)
		default:
			return "", "", nil, fmt.Errorf("unsupported prompt block type %q", block.Type)
		}
	}
	if len(files) > 0 {
		parts = append(parts, renderPromptFileManifest(files))
	}
	return strings.TrimSpace(strings.Join(parts, "\n\n")), strings.TrimSpace(strings.Join(userParts, "\n\n")), files, nil
}

func (g *ACPGateway) materializePromptResource(scope Scope, resource *acpPromptResource) (materializedFile, error) {
	if resource == nil {
		return materializedFile{}, fmt.Errorf("resource block must include resource")
	}
	fileID, ok := parseWrapperFileURI(resource.URI)
	if !ok {
		return materializedFile{}, fmt.Errorf("unsupported resource uri %q", resource.URI)
	}
	rec, _, apiErr := g.store.GetFile(scope, fileID)
	if apiErr != nil {
		return materializedFile{}, fmt.Errorf("%s: %s", apiErr.Code, apiErr.Message)
	}
	relativePath, err := normalizePromptResourcePath(firstNonEmpty(resource.RelativePath, resource.Name, rec.Filename, rec.ID))
	if err != nil {
		return materializedFile{}, err
	}
	return materializedFile{
		FileID:        rec.ID,
		Filename:      firstNonEmpty(resource.Name, rec.Filename, rec.ID),
		ContentType:   firstNonEmpty(resource.MimeType, rec.ContentType),
		Bytes:         rec.Bytes,
		SHA256:        rec.SHA256,
		Path:          rec.StoragePath,
		WorkspacePath: relativePath,
	}, nil
}

func parseWrapperFileURI(uri string) (string, bool) {
	const prefix = "wrapper-file://"
	if !strings.HasPrefix(uri, prefix) {
		return "", false
	}
	id := strings.TrimSpace(strings.TrimPrefix(uri, prefix))
	return id, strings.HasPrefix(id, "file_") && !strings.ContainsAny(id, `/\`)
}

func normalizePromptResourcePath(value string) (string, error) {
	value = strings.ReplaceAll(strings.TrimSpace(value), "\\", "/")
	value = strings.TrimPrefix(value, "./")
	if value == "" {
		return "", fmt.Errorf("resource relative path is required")
	}
	if strings.HasPrefix(value, "/") {
		return "", fmt.Errorf("resource path must be relative")
	}
	for _, segment := range strings.Split(value, "/") {
		if segment == "" || segment == "." || segment == ".." {
			return "", fmt.Errorf("resource path contains unsafe segment")
		}
		if strings.ContainsAny(segment, "\x00\r\n\t") {
			return "", fmt.Errorf("resource path contains control characters")
		}
	}
	clean := path.Clean(value)
	if clean == "." || strings.HasPrefix(clean, "../") || clean == ".." {
		return "", fmt.Errorf("resource path escapes inputs directory")
	}
	return "./" + path.Join("inputs", clean), nil
}

func renderPromptFileManifest(files []materializedFile) string {
	lines := []string{"Uploaded files are available in the sandbox workspace. Use tools to inspect them; do not assume their contents from this manifest."}
	for _, file := range files {
		lines = append(lines, fmt.Sprintf("- %s: %s (%s, %d bytes, sha256:%s)", file.WorkspacePath, file.Filename, file.ContentType, file.Bytes, file.SHA256))
	}
	return strings.Join(lines, "\n")
}

func mapRoleToReplayUpdate(role string) string {
	if role == "user" {
		return "user_message_chunk"
	}
	return "agent_message_chunk"
}

func acpScopeFromRequest(r *http.Request) (Scope, *APIError) {
	scope, errResp := scopeFromRequest(r)
	if errResp == nil {
		return scope, nil
	}
	if errResp.Code != "identity_missing" {
		return Scope{}, errResp
	}
	return Scope{
		TenantID:     envDefault("GATEWAY_DEFAULT_TENANT_ID", "default"),
		ProjectID:    envDefault("GATEWAY_DEFAULT_PROJECT_ID", "default"),
		SandboxScope: envDefault("GATEWAY_DEFAULT_SANDBOX_SCOPE", ""),
	}, nil
}

func decodeJSONRPCParams(raw json.RawMessage, out any) error {
	if len(raw) == 0 {
		return nil
	}
	return json.Unmarshal(raw, out)
}

func writeJSONRPCResult(ws *WSConn, id json.RawMessage, result any) error {
	return writeJSONRPCMessage(ws, mustJSONRPCResult(id, result))
}

func writeJSONRPCError(ws *WSConn, id json.RawMessage, code int, message string) error {
	return writeJSONRPCMessage(ws, mustJSONRPCError(id, code, message))
}

func writeJSONRPCNotification(ws *WSConn, method string, params any) error {
	payload := map[string]any{
		"jsonrpc": "2.0",
		"method":  method,
		"params":  params,
	}
	return writeJSONRPCMessage(ws, payload)
}

func writeJSONRPCMessage(ws *WSConn, payload any) error {
	data, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	return ws.WriteText(data)
}

func mustJSONRPCResult(id json.RawMessage, result any) map[string]any {
	return map[string]any{
		"jsonrpc": "2.0",
		"id":      rawMessageOrNull(id),
		"result":  result,
	}
}

func mustJSONRPCError(id json.RawMessage, code int, message string) map[string]any {
	return mustJSONRPCErrorData(id, code, message, nil)
}

func mustJSONRPCErrorData(id json.RawMessage, code int, message string, data any) map[string]any {
	errorObject := map[string]any{
		"code":    code,
		"message": message,
	}
	if data != nil {
		errorObject["data"] = data
	}
	return map[string]any{
		"jsonrpc": "2.0",
		"id":      rawMessageOrNull(id),
		"error":   errorObject,
	}
}

func mustJSONRPCErrorFromError(id json.RawMessage, err error) map[string]any {
	code, message, data := acpJSONRPCError(err)
	return mustJSONRPCErrorData(id, code, message, data)
}

func acpJSONRPCError(err error) (int, string, any) {
	if err == nil {
		return -32603, "internal error", nil
	}
	var readOnly acpReadOnlyError
	if errors.As(err, &readOnly) {
		reason := firstNonEmpty(readOnly.Reason, acpReadOnlyRuntimeNotRecovered)
		return -32010, "session is read-only", map[string]any{
			"error_code":       "session_read_only",
			"read_only_reason": reason,
		}
	}
	var runtimeUnavailable acpRuntimeUnavailableError
	if errors.As(err, &runtimeUnavailable) {
		data := map[string]any{
			"error_code":       "session_runtime_unavailable",
			"read_only_reason": firstNonEmpty(runtimeUnavailable.Reason, acpReadOnlyRuntimeNotRecovered),
			"retryable":        false,
		}
		if runtimeUnavailable.SessionID != "" {
			data["session_id"] = runtimeUnavailable.SessionID
		}
		if runtimeUnavailable.RuntimeID != "" {
			data["runtime_id"] = runtimeUnavailable.RuntimeID
		}
		if runtimeUnavailable.OuterSandboxID != "" {
			data["outer_sandbox_id"] = runtimeUnavailable.OuterSandboxID
		}
		if runtimeUnavailable.Detail != "" {
			data["detail"] = runtimeUnavailable.Detail
		}
		return -32003, "session runtime is unavailable", data
	}
	var failure *workerFailure
	if errors.As(err, &failure) {
		return -32000, failure.message, map[string]any{"code": failure.code}
	}
	return -32000, err.Error(), map[string]any{"code": "agent_runtime_error"}
}

func workerStopReason(err error) string {
	var failure *workerFailure
	if errors.As(err, &failure) {
		return failure.stopReason
	}
	return ""
}

func (g *ACPGateway) writeResponse(ws *WSConn, appEnvelope bool, payload any) error {
	g.writeMu.Lock()
	defer g.writeMu.Unlock()
	if !appEnvelope {
		return writeJSONRPCMessage(ws, payload)
	}
	return writeACPAppMessage(ws, "recv", payload)
}

func (g *ACPGateway) writeNotification(ws *WSConn, appEnvelope bool, method string, params any) error {
	g.writeMu.Lock()
	defer g.writeMu.Unlock()
	if !appEnvelope {
		return writeJSONRPCNotification(ws, method, params)
	}
	return writeACPAppMessage(ws, "recv", map[string]any{
		"jsonrpc": "2.0",
		"method":  method,
		"params":  params,
	})
}

func unwrapACPAppMessage(frame []byte) []byte {
	var env acpAppEnvelope
	if err := json.Unmarshal(frame, &env); err == nil && env.Type == "acp" && len(env.Message) > 0 {
		return env.Message
	}
	return frame
}

func writeACPAppMessage(ws *WSConn, direction string, message any) error {
	data, err := json.Marshal(message)
	if err != nil {
		return err
	}
	return writeACPAppEnvelope(ws, acpAppEnvelope{Type: "acp", Direction: direction, Message: data})
}

func writeACPAppError(ws *WSConn, code, kind, message string) error {
	return writeACPAppEnvelope(ws, acpAppEnvelope{
		Type:  "error",
		Error: &acpAppError{Code: code, Kind: kind, Message: message},
	})
}

func writeACPAppEnvelope(ws *WSConn, env acpAppEnvelope) error {
	data, err := json.Marshal(env)
	if err != nil {
		return err
	}
	return ws.WriteText(data)
}

func rawMessageOrNull(id json.RawMessage) any {
	if len(id) == 0 {
		return nil
	}
	var value any
	if err := json.Unmarshal(id, &value); err != nil {
		return nil
	}
	return value
}
