package wrapper

import (
	"context"
	"fmt"
	"os"
	"sort"
	"strings"
	"time"
)

func (g *ACPGateway) persistSession(session *acpSession) {
	if g.store == nil || session == nil {
		return
	}
	if err := g.store.SaveACPSession(session); err != nil {
		fmt.Fprintf(os.Stderr, "timeline source=server event=acp_session_persist_failed session_id=%s error=%s\n", session.SessionID, quoteServerField(err.Error()))
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
		readOnly, readOnlyReason := acpSessionReadOnlyState(session)
		items = append(items, acpSessionListItem{
			SessionID: session.SessionID,
			CWD:       session.CWD,
			Title:     sessionTitle(session),
			UpdatedAt: session.UpdatedAt.Format(time.RFC3339),
			Meta: cloudAgentMetaBox(acpCloudAgentSessionResultMeta{
				State:          string(session.State),
				ReadOnly:       readOnly,
				ReadOnlyReason: readOnlyReason,
			}),
		})
	}
	sort.Slice(items, func(i, j int) bool {
		return items[i].UpdatedAt > items[j].UpdatedAt
	})
	return items
}

func acpNewSessionResultFor(session *acpSession) acpNewSessionResult {
	if session == nil {
		return acpNewSessionResult{}
	}
	return acpNewSessionResult{
		SessionID:     session.SessionID,
		ConfigOptions: cloneConfigOptions(session.ConfigOptions),
		Meta:          acpSessionResultMeta(session),
	}
}

func acpLoadedSessionResultFor(session *acpSession) acpLoadedSessionResult {
	if session == nil {
		return acpLoadedSessionResult{}
	}
	return acpLoadedSessionResult{
		ConfigOptions: cloneConfigOptions(session.ConfigOptions),
		Meta:          acpSessionResultMeta(session),
	}
}

func acpSessionResultMeta(session *acpSession) *acpCloudAgentMetaBox {
	readOnly, readOnlyReason := acpSessionReadOnlyState(session)
	return cloudAgentMetaBox(acpCloudAgentSessionResultMeta{
		State:          string(session.State),
		ReadOnly:       readOnly,
		ReadOnlyReason: readOnlyReason,
		SessionProxyID: session.Runtime.SessionProxyID,
	})
}

func cloudAgentMetaBox(meta acpCloudAgentSessionResultMeta) *acpCloudAgentMetaBox {
	if meta.State == "" && !meta.ReadOnly && meta.ReadOnlyReason == "" && meta.SessionProxyID == "" {
		return nil
	}
	return &acpCloudAgentMetaBox{CloudAgent: meta}
}
func acpSessionReadOnlyState(session *acpSession) (bool, string) {
	if session == nil || session.ReadOnlyReason == "" {
		return false, ""
	}
	if runtimeCanRecreate(session.Runtime) {
		return false, ""
	}
	return true, session.ReadOnlyReason
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
		Generation:       session.RuntimeGeneration,
		SandboxBackend:   strings.ToLower(strings.TrimSpace(req.Meta.CloudAgent.SandboxBackend)),
		OuterRuntime:     strings.ToLower(strings.TrimSpace(req.Meta.CloudAgent.OuterRuntime)),
		RuntimeRecovery:  strings.TrimSpace(req.Meta.CloudAgent.RuntimeRecovery),
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
			if !runtimeNeedsCleanup(runtime) {
				delete(g.sessions, sessionID)
				if g.store != nil {
					_ = g.store.DeleteACPSession(scope, sessionID)
				}
				return nil, err
			}
			current.Runtime = runtime
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
	if g.store != nil {
		g.mu.Unlock()
		loaded, err := g.store.LoadACPSession(scope, sessionID)
		g.mu.Lock()
		if err == nil {
			if current, ok := g.sessions[sessionID]; ok && sameScope(scope, current.Scope) {
				current.History = loaded.History
				current.Events = loaded.Events
				session = current
			}
		}
	}
	out := cloneSession(session)
	g.mu.Unlock()
	return out, nil
}
func (g *ACPGateway) resumeSession(scope Scope, sessionID, cwd string) (*acpSession, error) {
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
	startReq := sessionRuntimeStartRequest(session)
	generation := session.RuntimeGeneration
	commit := func(reattached ACPSessionRuntime) error {
		g.mu.Lock()
		defer g.mu.Unlock()
		current, ok := g.sessions[sessionID]
		if !ok || current.RuntimeGeneration != generation {
			return nil
		}
		current.Runtime = reattached
		g.ensureRuntimeProxyIDLocked(current)
		current.State = acpRuntimeStateReady
		current.Closed = false
		current.LastRuntimeError = ""
		current.ReadOnlyReason = ""
		current.UpdatedAt = time.Now().UTC()
		g.persistSession(current)
		return nil
	}
	reattached, err := g.ensureSessionRuntime(sessionID, generation, runtime, startReq, commit)
	g.mu.Lock()
	defer g.mu.Unlock()
	current, ok := g.sessions[sessionID]
	if !ok {
		return nil, fmt.Errorf("session changed while resuming runtime")
	}
	if current.RuntimeGeneration != generation {
		return cloneSession(current), nil
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
	current.LastRuntimeError = ""
	current.ReadOnlyReason = ""
	g.persistSession(current)
	return cloneSession(current), nil
}
func (g *ACPGateway) cloudAgentRuntimeEnsureReady(scope Scope, req acpCloudAgentRuntimeEnsureReadyRequest) (map[string]any, error) {
	return g.cloudAgentEnsureRuntimeReady(scope, req, "runtime_ensure_ready")
}

func (g *ACPGateway) cloudAgentEnsureRuntimeReady(scope Scope, req acpCloudAgentRuntimeEnsureReadyRequest, source string) (map[string]any, error) {
	sessionID := strings.TrimSpace(req.SessionID)
	if sessionID == "" {
		return nil, fmt.Errorf("session_id is required")
	}
	before, err := g.getSession(scope, sessionID)
	if err != nil {
		return nil, err
	}
	beforeRuntimeID := before.Runtime.RuntimeID
	beforeOuterSandboxID := before.Runtime.OuterSandboxID
	beforeGeneration := before.RuntimeGeneration
	runID := "restore_" + randomHex(12)
	ownership, err := g.acquireRuntimeOwnership(context.Background(), sessionID, beforeGeneration, runID, "restore")
	if err != nil {
		return nil, err
	}
	stopOwnershipHeartbeat := g.startRuntimeOwnershipHeartbeat(context.Background(), ownership, nil)
	defer stopOwnershipHeartbeat()
	defer g.releaseRuntimeOwnership(ownership)
	session, err := g.resumeSession(scope, sessionID, req.CWD)
	if err != nil {
		return nil, err
	}
	status, err := g.cloudAgentSessionStatus(scope, sessionID)
	if err != nil {
		return nil, err
	}
	status["configOptions"] = cloneConfigOptions(session.ConfigOptions)
	status["ok"] = session.State == acpRuntimeStateReady && !session.Closed && session.ReadOnlyReason == ""
	status["restore_source"] = source
	restore := map[string]any{
		"changed": beforeGeneration != session.RuntimeGeneration ||
			beforeRuntimeID != session.Runtime.RuntimeID ||
			beforeOuterSandboxID != session.Runtime.OuterSandboxID,
		"previous_runtime_id":       beforeRuntimeID,
		"previous_outer_sandbox_id": beforeOuterSandboxID,
		"runtime_id":                session.Runtime.RuntimeID,
		"outer_sandbox_id":          session.Runtime.OuterSandboxID,
	}
	status["runtime_ensure_ready"] = restore
	return status, nil
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
	copySession.PromptRuns = nil
	copySession.ConfigOptions = cloneConfigOptions(session.ConfigOptions)
	copySession.History = cloneHistory(session.History)
	copySession.Events = append([]acpSessionEvent(nil), session.Events...)
	return &copySession
}
func cloneHistory(history []acpHistoryEntry) []acpHistoryEntry {
	return append([]acpHistoryEntry(nil), history...)
}
