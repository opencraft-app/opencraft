package wrapper

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"
)

type ACPGateway struct {
	store            *Store
	worker           Worker
	runtimeManager   ACPSessionRuntimeManager
	runtimeLock      RuntimeEnsureLocker
	runtimeOwnership RuntimeOwnershipStore
	workspaceService WorkspaceService
	ownerID          string
	mu               sync.Mutex
	sessions         map[string]*acpSession
	cleanups         map[string]*acpRuntimeCleanup
	runtimeEnsures   map[string]*acpRuntimeEnsureCall
	envdEnsures      map[string]*envdEnsureCall
	subscribers      map[string]map[*WSConn]acpSessionSubscriber
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
	SessionID             string
	Scope                 Scope
	Model                 string
	CWD                   string
	CreatedAt             time.Time
	UpdatedAt             time.Time
	Closed                bool
	State                 acpRuntimeState
	RuntimeGeneration     int64
	Runtime               ACPSessionRuntime
	PromptRuns            map[string]*acpPromptRun
	LastRuntimeActivityAt time.Time
	RuntimeVerified       bool
	LastRuntimeError      string
	CurrentResponseID     string
	ReadOnlyReason        string
	ConfigOptions         []ConfigOption
	History               []acpHistoryEntry
	Events                []acpSessionEvent
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
	Ownership          RuntimeOwnershipLease
}

type acpSessionSubscriber struct {
	WS              *WSConn
	AppEnvelope     bool
	Scope           Scope
	ReplayBuffering bool
	ReplayBuffer    []map[string]any
	ReplayDropped   int
}

type acpRuntimeCleanup struct {
	Runtime    ACPSessionRuntime
	Generation int64
	Reason     string
	Done       chan struct{}
	Err        error
}

type acpRuntimeEnsureCall struct {
	done      chan struct{}
	startedAt time.Time
	runtime   ACPSessionRuntime
	err       error
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
	SessionID string                `json:"sessionId"`
	CWD       string                `json:"cwd,omitempty"`
	Title     string                `json:"title,omitempty"`
	UpdatedAt string                `json:"updatedAt,omitempty"`
	Meta      *acpCloudAgentMetaBox `json:"_meta,omitempty"`
}

type acpPromptRequest struct {
	SessionID string           `json:"sessionId"`
	Prompt    []acpPromptBlock `json:"prompt"`
	CWD       string           `json:"cwd,omitempty"`
	Meta      acpPromptMeta    `json:"_meta,omitempty"`
}

type acpPromptMeta struct {
	CloudAgent acpCloudAgentPromptMeta `json:"cloudagent,omitempty"`
}

type acpCloudAgentPromptMeta struct {
	InboxMode string `json:"inbox_mode,omitempty"`
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
	OuterRuntime     string                           `json:"outer_runtime,omitempty"`
	RuntimeRecovery  string                           `json:"runtime_recovery,omitempty"`
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

type acpCloudAgentRuntimeEnsureReadyRequest struct {
	SessionID string `json:"session_id"`
	CWD       string `json:"cwd,omitempty"`
}

type acpSetConfigOptionRequest struct {
	SessionID string `json:"sessionId"`
	ConfigID  string `json:"configId"`
	Value     string `json:"value"`
}

type acpSessionIDRequest struct {
	SessionID string `json:"sessionId"`
}

type acpNewSessionResult struct {
	SessionID     string                `json:"sessionId"`
	ConfigOptions []ConfigOption        `json:"configOptions,omitempty"`
	Meta          *acpCloudAgentMetaBox `json:"_meta,omitempty"`
}

type acpLoadedSessionResult struct {
	ConfigOptions []ConfigOption        `json:"configOptions,omitempty"`
	Meta          *acpCloudAgentMetaBox `json:"_meta,omitempty"`
}

type acpCloudAgentMetaBox struct {
	CloudAgent acpCloudAgentSessionResultMeta `json:"cloudagent"`
}

type acpCloudAgentSessionResultMeta struct {
	State              string `json:"state,omitempty"`
	LifecycleState     string `json:"lifecycle_state,omitempty"`
	Recoverability     string `json:"recoverability,omitempty"`
	RecoverabilityNote string `json:"recoverability_note,omitempty"`
	ReadOnly           bool   `json:"read_only,omitempty"`
	ReadOnlyReason     string `json:"read_only_reason,omitempty"`
	SessionProxyID     string `json:"session_proxy_id,omitempty"`
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
	gateway := &ACPGateway{
		store:            store,
		worker:           worker,
		runtimeManager:   newACPSessionRuntimeManager(worker),
		ownerID:          "gateway_" + randomHex(12),
		sessions:         map[string]*acpSession{},
		cleanups:         map[string]*acpRuntimeCleanup{},
		runtimeEnsures:   map[string]*acpRuntimeEnsureCall{},
		envdEnsures:      map[string]*envdEnsureCall{},
		subscribers:      map[string]map[*WSConn]acpSessionSubscriber{},
		staleProxyIDs:    map[string]struct{}{},
		forceEnvdEnsures: map[string]struct{}{},
	}
	if store != nil {
		gateway.runtimeLock = store
		gateway.runtimeOwnership = store
		gateway.workspaceService = store
	}
	return gateway
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
	defer g.unsubscribeWS(ws)
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
			_ = g.handleNotification(ctx, scope, msg)
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
	defer g.unsubscribeWS(ws)
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
		_ = writeACPAppMessage(ws, "send", payload)
		if len(msg.ID) == 0 {
			_ = g.handleNotification(ctx, scope, msg)
			continue
		}
		if err := g.handleRequest(ctx, ws, scope, msg, true); err != nil {
			_ = g.writeResponse(ws, true, mustJSONRPCErrorFromError(msg.ID, err))
		}
	}
}

func (g *ACPGateway) handleRequest(ctx context.Context, ws *WSConn, scope Scope, msg jsonRPCMessage, appEnvelope bool) error {
	switch msg.Method {
	case "initialize":
		methods := []string{
			cloudAgentSessionStatusMethod,
			cloudAgentRuntimeEnsureReadyMethod,
		}
		if acpFaultInjectionEnabled() {
			methods = append(methods,
				cloudAgentRuntimeKillDaemonMethod,
				cloudAgentRuntimeKillOuterMethod,
				cloudAgentRuntimeKillInnerMethod,
			)
		}
		result := map[string]any{
			"protocolVersion": 1,
			"agentInfo": map[string]any{
				"name":    "cloudagent-gateway",
				"title":   "CloudAgent Gateway",
				"version": "0.1.0",
			},
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
						"methods": methods,
						"notifications": []string{
							cloudAgentWorkspaceLifecycleMethod,
							cloudAgentReplayDoneMethod,
							cloudAgentReplayGapMethod,
							cloudAgentTurnStatusMethod,
						},
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
		g.subscribeSession(scope, session.SessionID, ws, appEnvelope)
		return g.writeResponse(ws, appEnvelope, mustJSONRPCResult(msg.ID, g.acpNewSessionResultFor(session)))
	case "session/load":
		var req acpSessionRequest
		if err := decodeJSONRPCParams(msg.Params, &req); err != nil {
			return err
		}
		session, err := g.loadSession(scope, req.SessionID, req.CWD)
		if err != nil {
			return err
		}
		g.subscribeSessionForReplay(scope, session.SessionID, ws, appEnvelope)
		if err := g.replaySession(ws, appEnvelope, session); err != nil {
			return err
		}
		if err := g.flushReplayBufferedUpdates(session.SessionID, ws, appEnvelope); err != nil {
			return err
		}
		return g.writeResponse(ws, appEnvelope, mustJSONRPCResult(msg.ID, g.acpLoadedSessionResultFor(session)))
	case "session/resume":
		var req acpSessionRequest
		if err := decodeJSONRPCParams(msg.Params, &req); err != nil {
			return err
		}
		session, err := g.resumeSession(scope, req.SessionID, req.CWD)
		if err != nil {
			return err
		}
		g.subscribeSession(scope, session.SessionID, ws, appEnvelope)
		return g.writeResponse(ws, appEnvelope, mustJSONRPCResult(msg.ID, g.acpLoadedSessionResultFor(session)))
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
	case cloudAgentSessionStatusMethod:
		var req acpCloudAgentSessionRequest
		if err := decodeJSONRPCParams(msg.Params, &req); err != nil {
			return err
		}
		status, err := g.cloudAgentSessionStatus(scope, req.SessionID)
		if err != nil {
			return err
		}
		return g.writeResponse(ws, appEnvelope, mustJSONRPCResult(msg.ID, status))
	case cloudAgentRuntimeEnsureReadyMethod:
		var req acpCloudAgentRuntimeEnsureReadyRequest
		if err := decodeJSONRPCParams(msg.Params, &req); err != nil {
			return err
		}
		g.subscribeSession(scope, req.SessionID, ws, appEnvelope)
		result, err := g.cloudAgentRuntimeEnsureReady(scope, req)
		if err != nil {
			return err
		}
		return g.writeResponse(ws, appEnvelope, mustJSONRPCResult(msg.ID, result))
	case cloudAgentRuntimeKillDaemonMethod:
		var req acpCloudAgentSessionRequest
		if err := decodeJSONRPCParams(msg.Params, &req); err != nil {
			return err
		}
		result, err := g.killRuntimeForFaultInjection(ctx, scope, req.SessionID, "daemon")
		if err != nil {
			return err
		}
		return g.writeResponse(ws, appEnvelope, mustJSONRPCResult(msg.ID, result))
	case cloudAgentRuntimeKillOuterMethod:
		var req acpCloudAgentSessionRequest
		if err := decodeJSONRPCParams(msg.Params, &req); err != nil {
			return err
		}
		result, err := g.killRuntimeForFaultInjection(ctx, scope, req.SessionID, "outer")
		if err != nil {
			return err
		}
		return g.writeResponse(ws, appEnvelope, mustJSONRPCResult(msg.ID, result))
	case cloudAgentRuntimeKillInnerMethod:
		var req acpCloudAgentSessionRequest
		if err := decodeJSONRPCParams(msg.Params, &req); err != nil {
			return err
		}
		result, err := g.killRuntimeForFaultInjection(ctx, scope, req.SessionID, "inner")
		if err != nil {
			return err
		}
		return g.writeResponse(ws, appEnvelope, mustJSONRPCResult(msg.ID, result))
	case "session/prompt":
		var req acpPromptRequest
		if err := decodeJSONRPCParams(msg.Params, &req); err != nil {
			return err
		}
		session, err := g.getSession(scope, req.SessionID)
		if err != nil {
			return err
		}
		recovery := g.runtimeRecoverySnapshot(context.Background(), session.SessionID, session.Runtime)
		if session.ReadOnlyReason != "" && !recovery.Restorable {
			return g.writeResponse(ws, appEnvelope, mustJSONRPCErrorFromError(msg.ID, acpReadOnlyError{Reason: session.ReadOnlyReason}))
		}
		if session.Closed && !recovery.Restorable {
			return fmt.Errorf("session is closed; load or resume it before prompting")
		}
		session.Runtime = recovery.Runtime
		g.subscribeSession(scope, session.SessionID, ws, appEnvelope)
		return g.startPrompt(ws, msg.ID, session, req, appEnvelope)
	case "session/close":
		var req acpSessionIDRequest
		if err := decodeJSONRPCParams(msg.Params, &req); err != nil {
			return err
		}
		g.subscribeSession(scope, req.SessionID, ws, appEnvelope)
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
		g.subscribeSession(scope, req.SessionID, ws, appEnvelope)
		heldRun := g.holdPromptInterruptResponse(scope, req.SessionID)
		if err := g.deleteSession(scope, req.SessionID); err != nil {
			releasePromptInterruptResponse(heldRun)
			return err
		}
		err := g.writeResponse(ws, appEnvelope, mustJSONRPCResult(msg.ID, map[string]any{}))
		releasePromptInterruptResponse(heldRun)
		return err
	case "session/cancel":
		return fmt.Errorf("session/cancel is a JSON-RPC notification")
	default:
		return fmt.Errorf("method not found: %s", msg.Method)
	}
}

func (g *ACPGateway) handleNotification(ctx context.Context, scope Scope, msg jsonRPCMessage) error {
	switch msg.Method {
	case "session/cancel":
		var req acpSessionIDRequest
		if err := decodeJSONRPCParams(msg.Params, &req); err != nil {
			return err
		}
		return g.cancelSessionPrompt(scope, req.SessionID)
	default:
		return nil
	}
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
	return writeJSONRPCMessageWithin(ws, payload, 0)
}

func writeJSONRPCMessageWithin(ws *WSConn, payload any, timeout time.Duration) error {
	data, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	if timeout > 0 {
		return ws.WriteTextWithin(data, timeout)
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
	var ownershipHeld RuntimeOwnershipHeldError
	if errors.As(err, &ownershipHeld) || errors.Is(err, ErrRuntimeOwnershipHeld) {
		data := map[string]any{
			"error_code": "runtime_ownership_held",
			"retryable":  true,
		}
		if ownershipHeld.SessionID != "" {
			data["session_id"] = ownershipHeld.SessionID
		}
		if ownershipHeld.Generation != 0 {
			data["generation"] = ownershipHeld.Generation
		}
		if ownershipHeld.RunID != "" {
			data["run_id"] = ownershipHeld.RunID
		}
		if ownershipHeld.OwnerID != "" {
			data["owner_id"] = ownershipHeld.OwnerID
		}
		if ownershipHeld.Operation != "" {
			data["operation"] = ownershipHeld.Operation
		}
		if !ownershipHeld.ExpiresAt.IsZero() {
			data["expires_at"] = ownershipHeld.ExpiresAt.UTC().Format(time.RFC3339Nano)
		}
		return -32009, "runtime ownership is held", data
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
	if !appEnvelope {
		return writeJSONRPCMessage(ws, payload)
	}
	return writeACPAppMessage(ws, "recv", payload)
}

func (g *ACPGateway) writeNotification(ws *WSConn, appEnvelope bool, method string, params any) error {
	return g.writeNotificationWithin(ws, appEnvelope, method, params, 0)
}

func (g *ACPGateway) writeNotificationWithin(ws *WSConn, appEnvelope bool, method string, params any, timeout time.Duration) error {
	payload := map[string]any{
		"jsonrpc": "2.0",
		"method":  method,
		"params":  params,
	}
	if !appEnvelope {
		return writeJSONRPCMessageWithin(ws, payload, timeout)
	}
	return writeACPAppMessageWithin(ws, "recv", payload, timeout)
}

func unwrapACPAppMessage(frame []byte) []byte {
	var env acpAppEnvelope
	if err := json.Unmarshal(frame, &env); err == nil && env.Type == "acp" && len(env.Message) > 0 {
		return env.Message
	}
	return frame
}

func writeACPAppMessage(ws *WSConn, direction string, message any) error {
	return writeACPAppMessageWithin(ws, direction, message, 0)
}

func writeACPAppMessageWithin(ws *WSConn, direction string, message any, timeout time.Duration) error {
	data, err := json.Marshal(message)
	if err != nil {
		return err
	}
	return writeACPAppEnvelopeWithin(ws, acpAppEnvelope{Type: "acp", Direction: direction, Message: data}, timeout)
}

func writeACPAppError(ws *WSConn, code, kind, message string) error {
	return writeACPAppEnvelope(ws, acpAppEnvelope{
		Type:  "error",
		Error: &acpAppError{Code: code, Kind: kind, Message: message},
	})
}

func writeACPAppEnvelope(ws *WSConn, env acpAppEnvelope) error {
	return writeACPAppEnvelopeWithin(ws, env, 0)
}

func writeACPAppEnvelopeWithin(ws *WSConn, env acpAppEnvelope, timeout time.Duration) error {
	data, err := json.Marshal(env)
	if err != nil {
		return err
	}
	if timeout > 0 {
		return ws.WriteTextWithin(data, timeout)
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
