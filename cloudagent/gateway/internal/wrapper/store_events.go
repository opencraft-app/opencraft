package wrapper

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

const acpReadOnlyRuntimeNotRecovered = "runtime_not_recovered"

type acpSessionEvent struct {
	SessionID  string
	Seq        int64
	TurnID     string
	Role       string
	EventType  string
	TurnStatus string
	MessageID  string
	BlockID    string
	ResponseID string
	Payload    json.RawMessage
	CreatedAt  time.Time
}

type acpPromptTurnRecord struct {
	TurnID             string
	UserMessageID      string
	AssistantMessageID string
	Events             []acpSessionEvent
	History            []acpHistoryEntry
}

type acpStoredBlock struct {
	ID         string
	TurnID     string
	MessageID  string
	Role       string
	Type       string
	TurnStatus string
	ToolCallID string
	ResponseID string
	Payload    json.RawMessage
	CreatedAt  time.Time
	Seq        int64
}

func (s *Store) SaveACPSession(session *acpSession) error {
	if session == nil {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.saveACPSessionLocked(session)
}

func (s *Store) saveACPSessionLocked(session *acpSession) error {
	closed := 0
	if session.Closed {
		closed = 1
	}
	query := `
INSERT INTO sessions (
	session_id, scope_tenant, scope_project, scope_sandbox, cwd, workspace_key, title, model, state,
	closed, runtime_generation, current_response_id, last_runtime_error, created_at,
	updated_at, read_only_reason
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(session_id) DO UPDATE SET
	cwd = excluded.cwd,
	workspace_key = excluded.workspace_key,
	title = excluded.title,
	model = excluded.model,
	state = excluded.state,
	closed = excluded.closed,
	runtime_generation = excluded.runtime_generation,
	current_response_id = excluded.current_response_id,
	last_runtime_error = excluded.last_runtime_error,
	updated_at = excluded.updated_at,
	read_only_reason = excluded.read_only_reason,
	deleted_at = NULL`
	if s.isMySQL() {
		query = `
INSERT INTO sessions (
	session_id, scope_tenant, scope_project, scope_sandbox, cwd, workspace_key, title, model, state,
	closed, runtime_generation, current_response_id, last_runtime_error, created_at,
	updated_at, read_only_reason
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON DUPLICATE KEY UPDATE
	cwd = VALUES(cwd),
	workspace_key = VALUES(workspace_key),
	title = VALUES(title),
	model = VALUES(model),
	state = VALUES(state),
	closed = VALUES(closed),
	runtime_generation = VALUES(runtime_generation),
	current_response_id = VALUES(current_response_id),
	last_runtime_error = VALUES(last_runtime_error),
	updated_at = VALUES(updated_at),
	read_only_reason = VALUES(read_only_reason),
	deleted_at = NULL`
	}
	_, err := s.db.Exec(query,
		session.SessionID, session.Scope.TenantID, session.Scope.ProjectID, session.Scope.SandboxScope,
		session.CWD, session.WorkspaceKey, sessionTitle(session), session.Model, string(session.State), closed,
		session.RuntimeGeneration, session.CurrentResponseID, session.LastRuntimeError,
		session.CreatedAt.Format(time.RFC3339Nano), session.UpdatedAt.Format(time.RFC3339Nano),
		session.ReadOnlyReason)
	if err != nil {
		return err
	}
	return s.saveACPRuntimeLocked(session)
}

func (s *Store) saveACPRuntimeLocked(session *acpSession) error {
	if session.RuntimeGeneration == 0 {
		return nil
	}
	runtime := session.Runtime
	wispOwnsSMHSpace := 0
	if runtime.WispOwnsSMHSpace {
		wispOwnsSMHSpace = 1
	}
	wispLeaseUntil := ""
	if !runtime.WispLeaseUntil.IsZero() {
		wispLeaseUntil = runtime.WispLeaseUntil.Format(time.RFC3339Nano)
	}
	workspaceLeaseUntil := ""
	if !runtime.WorkspaceLeaseUntil.IsZero() {
		workspaceLeaseUntil = runtime.WorkspaceLeaseUntil.Format(time.RFC3339Nano)
	}
	query := `
	INSERT INTO session_runtimes (
		session_id, generation, sandbox_backend, outer_runtime, runtime_recovery, agent_version, agent_template_id,
		sidecar_url, sidecar_sha256, sidecar_sig_url, signing_key_id,
		workspace_version, workspace_template_id, runtime_id, outer_sandbox_id, outer_sandbox_domain,
	outer_envd_access_token, outer_traffic_token, daemon_addr, remote_binary,
	inner_sandbox_id, inner_sandbox_domain, inner_envd_access_token, session_proxy_id,
	wisp_name, wisp_workspace_id, wisp_smh_space_id, wisp_owns_smh_space,
	wisp_package_url, wisp_install_dir, wisp_client_path, wisp_jfs_prefix, wisp_root_upper_size,
	wisp_lease_id, wisp_lease_fence, wisp_lease_until,
	workspace_id, workspace_runtime_id, workspace_wisp_name, workspace_wisp_client, workspace_lease_id, workspace_fence, workspace_lease_until,
	workspace_attach_state, health_state, cleanup_state, last_cleanup_error
	) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	ON CONFLICT(session_id, generation) DO UPDATE SET
		sandbox_backend = excluded.sandbox_backend,
		outer_runtime = excluded.outer_runtime,
		runtime_recovery = excluded.runtime_recovery,
		agent_version = excluded.agent_version,
		agent_template_id = excluded.agent_template_id,
		sidecar_url = excluded.sidecar_url,
		sidecar_sha256 = excluded.sidecar_sha256,
		sidecar_sig_url = excluded.sidecar_sig_url,
		signing_key_id = excluded.signing_key_id,
		workspace_version = excluded.workspace_version,
	workspace_template_id = excluded.workspace_template_id,
	runtime_id = excluded.runtime_id,
	outer_sandbox_id = excluded.outer_sandbox_id,
	outer_sandbox_domain = excluded.outer_sandbox_domain,
	outer_envd_access_token = excluded.outer_envd_access_token,
	outer_traffic_token = excluded.outer_traffic_token,
	daemon_addr = excluded.daemon_addr,
	remote_binary = excluded.remote_binary,
	inner_sandbox_id = excluded.inner_sandbox_id,
	inner_sandbox_domain = excluded.inner_sandbox_domain,
	inner_envd_access_token = excluded.inner_envd_access_token,
	session_proxy_id = excluded.session_proxy_id,
	wisp_name = excluded.wisp_name,
	wisp_workspace_id = excluded.wisp_workspace_id,
	wisp_smh_space_id = excluded.wisp_smh_space_id,
	wisp_owns_smh_space = excluded.wisp_owns_smh_space,
	wisp_package_url = excluded.wisp_package_url,
	wisp_install_dir = excluded.wisp_install_dir,
	wisp_client_path = excluded.wisp_client_path,
	wisp_jfs_prefix = excluded.wisp_jfs_prefix,
	wisp_root_upper_size = excluded.wisp_root_upper_size,
	wisp_lease_id = excluded.wisp_lease_id,
	wisp_lease_fence = excluded.wisp_lease_fence,
	wisp_lease_until = excluded.wisp_lease_until,
	workspace_id = excluded.workspace_id,
	workspace_runtime_id = excluded.workspace_runtime_id,
	workspace_wisp_name = excluded.workspace_wisp_name,
	workspace_wisp_client = excluded.workspace_wisp_client,
	workspace_lease_id = excluded.workspace_lease_id,
	workspace_fence = excluded.workspace_fence,
	workspace_lease_until = excluded.workspace_lease_until,
	workspace_attach_state = excluded.workspace_attach_state,
	health_state = excluded.health_state,
	cleanup_state = excluded.cleanup_state,
	last_cleanup_error = excluded.last_cleanup_error`
	if s.isMySQL() {
		query = `
	INSERT INTO session_runtimes (
		session_id, generation, sandbox_backend, outer_runtime, runtime_recovery, agent_version, agent_template_id,
		sidecar_url, sidecar_sha256, sidecar_sig_url, signing_key_id,
		workspace_version, workspace_template_id, runtime_id, outer_sandbox_id, outer_sandbox_domain,
	outer_envd_access_token, outer_traffic_token, daemon_addr, remote_binary,
	inner_sandbox_id, inner_sandbox_domain, inner_envd_access_token, session_proxy_id,
	wisp_name, wisp_workspace_id, wisp_smh_space_id, wisp_owns_smh_space,
	wisp_package_url, wisp_install_dir, wisp_client_path, wisp_jfs_prefix, wisp_root_upper_size,
	wisp_lease_id, wisp_lease_fence, wisp_lease_until,
	workspace_id, workspace_runtime_id, workspace_wisp_name, workspace_wisp_client, workspace_lease_id, workspace_fence, workspace_lease_until,
	workspace_attach_state, health_state, cleanup_state, last_cleanup_error
	) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	ON DUPLICATE KEY UPDATE
		sandbox_backend = VALUES(sandbox_backend),
		outer_runtime = VALUES(outer_runtime),
		runtime_recovery = VALUES(runtime_recovery),
		agent_version = VALUES(agent_version),
		agent_template_id = VALUES(agent_template_id),
		sidecar_url = VALUES(sidecar_url),
		sidecar_sha256 = VALUES(sidecar_sha256),
		sidecar_sig_url = VALUES(sidecar_sig_url),
		signing_key_id = VALUES(signing_key_id),
		workspace_version = VALUES(workspace_version),
	workspace_template_id = VALUES(workspace_template_id),
	runtime_id = VALUES(runtime_id),
	outer_sandbox_id = VALUES(outer_sandbox_id),
	outer_sandbox_domain = VALUES(outer_sandbox_domain),
	outer_envd_access_token = VALUES(outer_envd_access_token),
	outer_traffic_token = VALUES(outer_traffic_token),
	daemon_addr = VALUES(daemon_addr),
	remote_binary = VALUES(remote_binary),
	inner_sandbox_id = VALUES(inner_sandbox_id),
	inner_sandbox_domain = VALUES(inner_sandbox_domain),
	inner_envd_access_token = VALUES(inner_envd_access_token),
	session_proxy_id = VALUES(session_proxy_id),
	wisp_name = VALUES(wisp_name),
	wisp_workspace_id = VALUES(wisp_workspace_id),
	wisp_smh_space_id = VALUES(wisp_smh_space_id),
	wisp_owns_smh_space = VALUES(wisp_owns_smh_space),
	wisp_package_url = VALUES(wisp_package_url),
	wisp_install_dir = VALUES(wisp_install_dir),
	wisp_client_path = VALUES(wisp_client_path),
	wisp_jfs_prefix = VALUES(wisp_jfs_prefix),
	wisp_root_upper_size = VALUES(wisp_root_upper_size),
	wisp_lease_id = VALUES(wisp_lease_id),
	wisp_lease_fence = VALUES(wisp_lease_fence),
	wisp_lease_until = VALUES(wisp_lease_until),
	workspace_id = VALUES(workspace_id),
	workspace_runtime_id = VALUES(workspace_runtime_id),
	workspace_wisp_name = VALUES(workspace_wisp_name),
	workspace_wisp_client = VALUES(workspace_wisp_client),
	workspace_lease_id = VALUES(workspace_lease_id),
	workspace_fence = VALUES(workspace_fence),
	workspace_lease_until = VALUES(workspace_lease_until),
	workspace_attach_state = VALUES(workspace_attach_state),
	health_state = VALUES(health_state),
	cleanup_state = VALUES(cleanup_state),
	last_cleanup_error = VALUES(last_cleanup_error)`
	}
	_, err := s.db.Exec(query,
		session.SessionID, session.RuntimeGeneration, runtime.SandboxBackend, runtime.OuterRuntime, runtime.RuntimeRecovery,
		runtime.AgentVersion, runtime.AgentTemplateID, runtime.SidecarURL, runtime.SidecarSHA256, runtime.SidecarSigURL, runtime.SigningKeyID,
		runtime.WorkspaceVersion, runtime.WorkspaceTemplateID,
		runtime.RuntimeID, runtime.OuterSandboxID, runtime.OuterSandboxDomain, runtime.OuterEnvdAccessToken, runtime.OuterTrafficToken,
		runtime.DaemonAddr, runtime.RemoteBinary, runtime.InnerSandboxID, runtime.InnerSandboxDomain,
		runtime.InnerEnvdAccessToken, runtime.SessionProxyID, runtime.WispName, runtime.WispWorkspaceID,
		runtime.WispSMHSpaceID, wispOwnsSMHSpace, runtime.WispPackageURL, runtime.WispInstallDir,
		runtime.WispClientPath, runtime.WispJFSPrefix, runtime.WispRootUpperSize,
		runtime.WispLeaseID, runtime.WispLeaseFence, wispLeaseUntil,
		runtime.WorkspaceID, runtime.WorkspaceRuntimeID, runtime.WorkspaceWispName,
		runtime.WorkspaceWispClient,
		runtime.WorkspaceLeaseID, runtime.WorkspaceFence,
		workspaceLeaseUntil, runtime.WorkspaceAttachState, string(session.State), "", session.LastRuntimeError)
	return err
}

func (s *Store) ClearACPRuntimeTokens(sessionID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.Exec(`
UPDATE session_runtimes
SET outer_envd_access_token = '', outer_traffic_token = '', inner_envd_access_token = ''
WHERE session_id = ?`, sessionID)
	return err
}

func (s *Store) ListACPSessions(scope Scope) ([]*acpSession, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	rows, err := s.db.Query(`
SELECT session_id
FROM sessions
WHERE scope_tenant = ? AND scope_project = ? AND scope_sandbox = ? AND deleted_at IS NULL
ORDER BY updated_at DESC`, scope.TenantID, scope.ProjectID, scope.SandboxScope)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var sessionIDs []string
	for rows.Next() {
		var sessionID string
		if err := rows.Scan(&sessionID); err != nil {
			return nil, err
		}
		sessionIDs = append(sessionIDs, sessionID)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	var sessions []*acpSession
	for _, sessionID := range sessionIDs {
		session, ok, err := s.loadACPSessionLocked(sessionID)
		if err != nil {
			return nil, err
		}
		if ok {
			sessions = append(sessions, session)
		}
	}
	return sessions, nil
}

func (s *Store) LoadACPSession(scope Scope, sessionID string) (*acpSession, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	session, ok, err := s.loadACPSessionLocked(sessionID)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, fmt.Errorf("session not found")
	}
	if !sameScope(scope, session.Scope) {
		return nil, fmt.Errorf("session is outside caller scope")
	}
	return session, nil
}

func (s *Store) LoadACPSessionByProxyID(proxyID string) (*acpSession, int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var sessionID string
	var generation int64
	var deletedAt sql.NullString
	err := s.db.QueryRow(`
SELECT r.session_id, r.generation, s.deleted_at
FROM session_runtimes r
LEFT JOIN sessions s ON s.session_id = r.session_id
WHERE r.session_proxy_id = ?
ORDER BY r.generation DESC
LIMIT 1`, proxyID).Scan(&sessionID, &generation, &deletedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, 0, fmt.Errorf("session proxy not found")
	}
	if err != nil {
		return nil, 0, err
	}
	if deletedAt.Valid {
		return nil, generation, staleSessionProxyError{}
	}
	session, ok, err := s.loadACPSessionLocked(sessionID)
	if err != nil {
		return nil, 0, err
	}
	if !ok {
		return nil, 0, fmt.Errorf("session not found")
	}
	return session, generation, nil
}

func (s *Store) loadACPSessionLocked(sessionID string) (*acpSession, bool, error) {
	var session acpSession
	var state string
	var closed int
	var createdAt, updatedAt string
	err := s.db.QueryRow(`
SELECT session_id, scope_tenant, scope_project, scope_sandbox, cwd, COALESCE(workspace_key, ''), model, state, closed,
       runtime_generation, current_response_id, last_runtime_error, created_at, updated_at,
       read_only_reason
FROM sessions WHERE session_id = ? AND deleted_at IS NULL`, sessionID).Scan(
		&session.SessionID, &session.Scope.TenantID, &session.Scope.ProjectID, &session.Scope.SandboxScope,
		&session.CWD, &session.WorkspaceKey, &session.Model, &state, &closed, &session.RuntimeGeneration,
		&session.CurrentResponseID, &session.LastRuntimeError, &createdAt, &updatedAt,
		&session.ReadOnlyReason,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	session.State = acpRuntimeState(state)
	session.Closed = closed != 0
	session.ConfigOptions = defaultACPConfigOptions()
	if t, err := time.Parse(time.RFC3339Nano, createdAt); err == nil {
		session.CreatedAt = t
	}
	if t, err := time.Parse(time.RFC3339Nano, updatedAt); err == nil {
		session.UpdatedAt = t
	}
	runtime, _ := s.loadACPRuntimeLocked(sessionID, session.RuntimeGeneration)
	session.Runtime = runtime
	events, history, err := s.loadACPSessionEventsLocked(sessionID)
	if err != nil {
		return nil, false, err
	}
	session.Events = events
	session.History = history
	if session.ReadOnlyReason == "" && !session.Closed && runtimeNeedsCleanup(runtime) && !runtimeCanRecreate(runtime) {
		session.ReadOnlyReason = acpReadOnlyRuntimeNotRecovered
	}
	return &session, true, nil
}

func (s *Store) loadACPRuntimeLocked(sessionID string, generation int64) (ACPSessionRuntime, error) {
	var runtime ACPSessionRuntime
	var wispOwnsSMHSpace int
	var wispLeaseUntil string
	var workspaceLeaseUntil string
	err := s.db.QueryRow(`
SELECT runtime_id, outer_sandbox_id, outer_sandbox_domain, outer_envd_access_token,
       outer_traffic_token, daemon_addr, remote_binary, inner_sandbox_id,
       inner_sandbox_domain, inner_envd_access_token, session_proxy_id,
	       sandbox_backend, outer_runtime, runtime_recovery, agent_version, agent_template_id,
	       sidecar_url, sidecar_sha256, sidecar_sig_url, signing_key_id,
	       workspace_version, workspace_template_id,
       wisp_name, wisp_workspace_id, wisp_smh_space_id, wisp_owns_smh_space,
       wisp_package_url, wisp_install_dir, wisp_client_path, wisp_jfs_prefix, wisp_root_upper_size,
       wisp_lease_id, wisp_lease_fence, wisp_lease_until,
       workspace_id, workspace_runtime_id, workspace_wisp_name, workspace_wisp_client, workspace_lease_id, workspace_fence, workspace_lease_until,
       workspace_attach_state
FROM session_runtimes WHERE session_id = ? AND generation = ?`, sessionID, generation).Scan(
		&runtime.RuntimeID, &runtime.OuterSandboxID, &runtime.OuterSandboxDomain,
		&runtime.OuterEnvdAccessToken, &runtime.OuterTrafficToken, &runtime.DaemonAddr,
		&runtime.RemoteBinary, &runtime.InnerSandboxID, &runtime.InnerSandboxDomain,
		&runtime.InnerEnvdAccessToken, &runtime.SessionProxyID, &runtime.SandboxBackend,
		&runtime.OuterRuntime, &runtime.RuntimeRecovery, &runtime.AgentVersion, &runtime.AgentTemplateID,
		&runtime.SidecarURL, &runtime.SidecarSHA256, &runtime.SidecarSigURL, &runtime.SigningKeyID,
		&runtime.WorkspaceVersion, &runtime.WorkspaceTemplateID,
		&runtime.WispName, &runtime.WispWorkspaceID, &runtime.WispSMHSpaceID, &wispOwnsSMHSpace,
		&runtime.WispPackageURL, &runtime.WispInstallDir, &runtime.WispClientPath,
		&runtime.WispJFSPrefix, &runtime.WispRootUpperSize,
		&runtime.WispLeaseID, &runtime.WispLeaseFence, &wispLeaseUntil,
		&runtime.WorkspaceID, &runtime.WorkspaceRuntimeID, &runtime.WorkspaceWispName,
		&runtime.WorkspaceWispClient,
		&runtime.WorkspaceLeaseID,
		&runtime.WorkspaceFence, &workspaceLeaseUntil, &runtime.WorkspaceAttachState,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return ACPSessionRuntime{}, nil
	}
	if err == nil {
		runtime.OuterRuntime = normalizeOuterRuntime(runtime.OuterRuntime)
		runtime.RuntimeRecovery = normalizeRuntimeRecovery(runtime.RuntimeRecovery, runtime.OuterRuntime)
		runtime.AgentVersion = normalizeRuntimeVersion(runtime.AgentVersion, defaultAgentVersion)
		runtime.WorkspaceVersion = normalizeRuntimeVersion(runtime.WorkspaceVersion, defaultWorkspaceVersion)
		runtime.WispOwnsSMHSpace = wispOwnsSMHSpace != 0
		if wispLeaseUntil != "" {
			runtime.WispLeaseUntil, err = time.Parse(time.RFC3339Nano, wispLeaseUntil)
		}
		if err == nil && workspaceLeaseUntil != "" {
			runtime.WorkspaceLeaseUntil, err = time.Parse(time.RFC3339Nano, workspaceLeaseUntil)
		}
	}
	return runtime, err
}

func (s *Store) loadACPSessionEventsLocked(sessionID string) ([]acpSessionEvent, []acpHistoryEntry, error) {
	rows, err := s.db.Query(`
SELECT b.id, b.turn_id, b.message_id, m.role, b.type, t.status, b.tool_call_id, b.response_id, b.payload_json, b.created_at
FROM turns t
JOIN messages m ON m.turn_id = t.id
JOIN message_blocks b ON b.message_id = m.id
WHERE t.session_id = ?
ORDER BY t.turn_index, m.message_index, b.block_index`, sessionID)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	var events []acpSessionEvent
	var history []acpHistoryEntry
	var seq int64
	for rows.Next() {
		var block acpStoredBlock
		var payload string
		var createdAt string
		if err := rows.Scan(&block.ID, &block.TurnID, &block.MessageID, &block.Role, &block.Type, &block.TurnStatus, &block.ToolCallID, &block.ResponseID, &payload, &createdAt); err != nil {
			return nil, nil, err
		}
		seq++
		block.Seq = seq
		block.Payload = json.RawMessage(payload)
		if t, err := time.Parse(time.RFC3339Nano, createdAt); err == nil {
			block.CreatedAt = t
		}
		event := block.toReplayEvent(sessionID)
		events = append(events, event)
		text := eventText(block.Payload)
		switch {
		case block.Role == "user" && block.Type == "text":
			history = append(history, acpHistoryEntry{Role: "user", Text: text, At: event.CreatedAt, MessageID: event.MessageID, BlockID: event.BlockID, Seq: event.Seq})
		case block.Role == "assistant" && block.Type == "text":
			history = append(history, acpHistoryEntry{Role: "assistant", Text: text, At: event.CreatedAt, ResponseID: event.ResponseID, MessageID: event.MessageID, BlockID: event.BlockID, Seq: event.Seq})
		}
	}
	return events, history, rows.Err()
}

func (b acpStoredBlock) toReplayEvent(sessionID string) acpSessionEvent {
	eventType := b.Type
	if b.Role == "assistant" && b.Type == "text" {
		eventType = "assistant_text"
	}
	if b.Role == "user" && b.Type == "text" {
		eventType = "user_message"
	}
	return acpSessionEvent{
		SessionID:  sessionID,
		Seq:        b.Seq,
		TurnID:     b.TurnID,
		Role:       b.Role,
		EventType:  eventType,
		TurnStatus: b.TurnStatus,
		MessageID:  b.MessageID,
		BlockID:    b.ID,
		ResponseID: b.ResponseID,
		Payload:    b.Payload,
		CreatedAt:  b.CreatedAt,
	}
}

func eventText(payload json.RawMessage) string {
	var value struct {
		Content struct {
			Text string `json:"text"`
		} `json:"content"`
	}
	_ = json.Unmarshal(payload, &value)
	return value.Content.Text
}

func (s *Store) BeginACPPromptTurn(sessionID, responseID, userText string, inputFiles []materializedFile) (acpPromptTurnRecord, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.Begin()
	if err != nil {
		return acpPromptTurnRecord{}, err
	}
	defer tx.Rollback()
	now := time.Now().UTC()
	turnIndex, err := nextTurnIndexTx(tx, sessionID)
	if err != nil {
		return acpPromptTurnRecord{}, err
	}
	record := acpPromptTurnRecord{
		TurnID:             "turn_" + randomHex(12),
		UserMessageID:      "msg_" + randomHex(12),
		AssistantMessageID: "msg_" + randomHex(12),
	}
	if _, err := tx.Exec(`INSERT INTO turns (id, session_id, turn_index, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
		record.TurnID, sessionID, turnIndex, "running", now.Format(time.RFC3339Nano), now.Format(time.RFC3339Nano)); err != nil {
		return acpPromptTurnRecord{}, err
	}
	if _, err := tx.Exec(`INSERT INTO messages (id, turn_id, session_id, role, status, message_index, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		record.UserMessageID, record.TurnID, sessionID, "user", "completed", 0, now.Format(time.RFC3339Nano), now.Format(time.RFC3339Nano)); err != nil {
		return acpPromptTurnRecord{}, err
	}
	if _, err := tx.Exec(`INSERT INTO messages (id, turn_id, session_id, role, status, message_index, response_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		record.AssistantMessageID, record.TurnID, sessionID, "assistant", "pending", 1, responseID, now.Format(time.RFC3339Nano), now.Format(time.RFC3339Nano)); err != nil {
		return acpPromptTurnRecord{}, err
	}
	blockIndex := 0
	if strings.TrimSpace(userText) != "" {
		blockID := "block_" + randomHex(12)
		payload := map[string]any{
			"sessionUpdate": "user_message_chunk",
			"messageId":     record.UserMessageID,
			"blockId":       blockID,
			"content":       map[string]any{"text": userText},
		}
		data, err := json.Marshal(payload)
		if err != nil {
			return acpPromptTurnRecord{}, err
		}
		if err := insertMessageBlockTx(tx, sessionID, record.TurnID, record.UserMessageID, blockID, blockIndex, "text", "completed", "", "", string(data), now); err != nil {
			return acpPromptTurnRecord{}, err
		}
		event := acpSessionEvent{SessionID: sessionID, Seq: int64(blockIndex + 1), TurnID: record.TurnID, Role: "user", EventType: "user_message", MessageID: record.UserMessageID, BlockID: blockID, Payload: data, CreatedAt: now}
		record.Events = append(record.Events, event)
		record.History = append(record.History, acpHistoryEntry{Role: "user", Text: userText, At: now, MessageID: record.UserMessageID, BlockID: blockID, Seq: event.Seq})
		blockIndex++
	}
	if len(inputFiles) > 0 {
		blockID := "block_" + randomHex(12)
		attachments := make([]map[string]any, 0, len(inputFiles))
		for _, file := range inputFiles {
			attachments = append(attachments, map[string]any{
				"id":            file.FileID,
				"name":          file.Filename,
				"mimeType":      file.ContentType,
				"size":          file.Bytes,
				"url":           "/v1/files/" + file.FileID + "/content",
				"workspacePath": file.WorkspacePath,
			})
		}
		payload := map[string]any{
			"sessionUpdate": "attachment",
			"messageId":     record.UserMessageID,
			"blockId":       blockID,
			"kind":          "input",
			"attachments":   attachments,
		}
		data, err := json.Marshal(payload)
		if err != nil {
			return acpPromptTurnRecord{}, err
		}
		if err := insertMessageBlockTx(tx, sessionID, record.TurnID, record.UserMessageID, blockID, blockIndex, "attachment", "completed", "", "", string(data), now); err != nil {
			return acpPromptTurnRecord{}, err
		}
		for _, file := range inputFiles {
			query := `INSERT OR REPLACE INTO session_files (session_id, event_id, file_id, staged_rel_path, display_name, mime_type, bytes, purpose) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
			if s.isMySQL() {
				query = `REPLACE INTO session_files (session_id, event_id, file_id, staged_rel_path, display_name, mime_type, bytes, purpose) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
			}
			if _, err := tx.Exec(query,
				sessionID, 0, file.FileID, strings.TrimPrefix(file.WorkspacePath, "./"), file.Filename, file.ContentType, file.Bytes, "input"); err != nil {
				return acpPromptTurnRecord{}, err
			}
		}
		record.Events = append(record.Events, acpSessionEvent{SessionID: sessionID, Seq: int64(blockIndex + 1), TurnID: record.TurnID, Role: "user", EventType: "attachment", MessageID: record.UserMessageID, BlockID: blockID, Payload: data, CreatedAt: now})
	}
	if err := tx.Commit(); err != nil {
		return acpPromptTurnRecord{}, err
	}
	return record, nil
}

func nextTurnIndexTx(tx *sql.Tx, sessionID string) (int64, error) {
	var current sql.NullInt64
	if err := tx.QueryRow(`SELECT MAX(turn_index) FROM turns WHERE session_id = ?`, sessionID).Scan(&current); err != nil {
		return 0, err
	}
	if !current.Valid {
		return 0, nil
	}
	return current.Int64 + 1, nil
}

func insertMessageBlockTx(tx *sql.Tx, sessionID, turnID, messageID, blockID string, blockIndex int, blockType, status, toolCallID, responseID, payload string, now time.Time) error {
	_, err := tx.Exec(`
INSERT INTO message_blocks (id, message_id, turn_id, session_id, block_index, type, status, tool_call_id, response_id, payload_json, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		blockID, messageID, turnID, sessionID, blockIndex, blockType, status, toolCallID, responseID, payload, now.Format(time.RFC3339Nano), now.Format(time.RFC3339Nano))
	return err
}

func (s *Store) UpsertACPAssistantBlock(sessionID, turnID, messageID, responseID, blockType, toolCallID string, payload map[string]any) (string, map[string]any, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.Begin()
	if err != nil {
		return "", nil, err
	}
	defer tx.Rollback()
	now := time.Now().UTC()
	blockID, payloadJSON, err := upsertAssistantBlockTx(tx, sessionID, turnID, messageID, responseID, blockType, toolCallID, payload, now)
	if err != nil {
		return "", nil, err
	}
	if err := tx.Commit(); err != nil {
		return "", nil, err
	}
	var merged map[string]any
	if err := json.Unmarshal([]byte(payloadJSON), &merged); err != nil {
		return "", nil, err
	}
	return blockID, merged, nil
}

func (s *Store) ACPBlockSequence(sessionID, blockID string) (int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var seq int64
	err := s.db.QueryRow(`
WITH target AS (
	SELECT t.turn_index AS turn_index, m.message_index AS message_index, b.block_index AS block_index
	FROM message_blocks b
	JOIN messages m ON m.id = b.message_id
	JOIN turns t ON t.id = b.turn_id
	WHERE b.session_id = ? AND b.id = ?
)
SELECT COUNT(*)
FROM message_blocks b
JOIN messages m ON m.id = b.message_id
JOIN turns t ON t.id = b.turn_id
JOIN target
WHERE b.session_id = ?
  AND (
	t.turn_index < target.turn_index
	OR (t.turn_index = target.turn_index AND m.message_index < target.message_index)
	OR (t.turn_index = target.turn_index AND m.message_index = target.message_index AND b.block_index <= target.block_index)
  )`, sessionID, blockID, sessionID).Scan(&seq)
	return seq, err
}

func upsertAssistantBlockTx(tx *sql.Tx, sessionID, turnID, messageID, responseID, blockType, toolCallID string, payload map[string]any, now time.Time) (string, string, error) {
	_, _ = tx.Exec(`UPDATE messages SET status = CASE WHEN status = 'pending' THEN 'in_progress' ELSE status END, updated_at = ? WHERE id = ?`,
		now.Format(time.RFC3339Nano), messageID)
	var blockID string
	var existingPayload string
	var blockIndex int
	var err error
	if toolCallID != "" {
		query := `SELECT id, block_index, payload_json FROM message_blocks WHERE message_id = ? AND tool_call_id = ? ORDER BY block_index DESC LIMIT 1`
		err = tx.QueryRow(query, messageID, toolCallID).Scan(&blockID, &blockIndex, &existingPayload)
	} else if blockType == "text" || blockType == "reasoning" {
		var lastType string
		var lastToolCallID string
		query := `SELECT id, block_index, type, tool_call_id, payload_json FROM message_blocks WHERE message_id = ? ORDER BY block_index DESC LIMIT 1`
		err = tx.QueryRow(query, messageID).Scan(&blockID, &blockIndex, &lastType, &lastToolCallID, &existingPayload)
		if err == nil && (lastType != blockType || lastToolCallID != "") {
			err = sql.ErrNoRows
		}
	} else {
		query := `SELECT id, block_index, payload_json FROM message_blocks WHERE message_id = ? AND type = ? AND tool_call_id = '' ORDER BY block_index DESC LIMIT 1`
		err = tx.QueryRow(query, messageID, blockType).Scan(&blockID, &blockIndex, &existingPayload)
	}
	if errors.Is(err, sql.ErrNoRows) {
		return insertAssistantBlockTx(tx, sessionID, turnID, messageID, responseID, blockType, toolCallID, payload, now)
	}
	if err != nil {
		return "", "", err
	}
	merged := payload
	if blockType == "text" || blockType == "reasoning" {
		var previous map[string]any
		_ = json.Unmarshal([]byte(existingPayload), &previous)
		prevText := nestedContentText(previous)
		nextText := nestedContentText(payload)
		merged = cloneMap(payload)
		merged["content"] = map[string]any{"text": prevText + nextText}
	}
	merged["messageId"] = messageID
	merged["blockId"] = blockID
	data, err := json.Marshal(merged)
	if err != nil {
		return "", "", err
	}
	_, err = tx.Exec(`UPDATE message_blocks SET payload_json = ?, status = ?, response_id = ?, updated_at = ? WHERE id = ?`,
		string(data), "in_progress", responseID, now.Format(time.RFC3339Nano), blockID)
	return blockID, string(data), err
}

func insertAssistantBlockTx(tx *sql.Tx, sessionID, turnID, messageID, responseID, blockType, toolCallID string, payload map[string]any, now time.Time) (string, string, error) {
	var blockIndex int
	if err := tx.QueryRow(`SELECT COALESCE(MAX(block_index), -1) + 1 FROM message_blocks WHERE message_id = ?`, messageID).Scan(&blockIndex); err != nil {
		return "", "", err
	}
	blockID := "block_" + randomHex(12)
	payload["messageId"] = messageID
	payload["blockId"] = blockID
	data, err := json.Marshal(payload)
	if err != nil {
		return "", "", err
	}
	if err := insertMessageBlockTx(tx, sessionID, turnID, messageID, blockID, blockIndex, blockType, "in_progress", toolCallID, responseID, string(data), now); err != nil {
		return "", "", err
	}
	return blockID, string(data), nil
}

func nestedContentText(payload map[string]any) string {
	content, _ := payload["content"].(map[string]any)
	text, _ := content["text"].(string)
	return text
}

func cloneMap(input map[string]any) map[string]any {
	out := make(map[string]any, len(input))
	for key, value := range input {
		out[key] = value
	}
	return out
}

func (s *Store) AssistantMessageHasTextBlock(messageID string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	var count int
	_ = s.db.QueryRow(`SELECT COUNT(*) FROM message_blocks WHERE message_id = ? AND type = 'text'`, messageID).Scan(&count)
	return count > 0
}

func (s *Store) CompleteACPTurn(turnID, assistantMessageID string) error {
	return s.finishACPTurn(turnID, assistantMessageID, "completed", "")
}

func (s *Store) CancelACPTurn(turnID, assistantMessageID, reason string) error {
	return s.finishACPTurn(turnID, assistantMessageID, "cancelled", reason)
}

func (s *Store) FailACPTurn(turnID, assistantMessageID, message string) error {
	return s.finishACPTurn(turnID, assistantMessageID, "failed", message)
}

func (s *Store) finishACPTurn(turnID, assistantMessageID, status, detail string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	now := time.Now().UTC()
	var sessionID string
	if err := tx.QueryRow(`SELECT session_id FROM turns WHERE id = ?`, turnID).Scan(&sessionID); err != nil {
		return err
	}
	if status == "cancelled" || status == "failed" {
		blockType := "lifecycle"
		payload := map[string]any{"sessionUpdate": "lifecycle", "messageId": assistantMessageID, "status": status}
		if status == "failed" {
			payload["error"] = map[string]any{"message": detail, "code": "provider_error", "source": "runtime"}
		} else if detail != "" {
			payload["reason"] = detail
		}
		_, _, err := upsertAssistantBlockTx(tx, sessionID, turnID, assistantMessageID, "", blockType, "", payload, now)
		if err != nil {
			return err
		}
	}
	_, err = tx.Exec(`UPDATE messages SET status = ?, updated_at = ? WHERE id = ?`, status, now.Format(time.RFC3339Nano), assistantMessageID)
	if err != nil {
		return err
	}
	_, err = tx.Exec(`UPDATE turns SET status = ?, updated_at = ? WHERE id = ?`, status, now.Format(time.RFC3339Nano), turnID)
	if err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) DeleteACPSession(scope Scope, sessionID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, err := s.db.Exec(`DELETE FROM session_files WHERE session_id = ?`, sessionID); err != nil {
		return err
	}
	if _, err := s.db.Exec(`DELETE FROM message_blocks WHERE session_id = ?`, sessionID); err != nil {
		return err
	}
	if _, err := s.db.Exec(`DELETE FROM messages WHERE session_id = ?`, sessionID); err != nil {
		return err
	}
	if _, err := s.db.Exec(`DELETE FROM turns WHERE session_id = ?`, sessionID); err != nil {
		return err
	}
	_, err := s.db.Exec(`
UPDATE sessions SET deleted_at = ?, read_only_reason = '', current_response_id = ''
WHERE session_id = ? AND scope_tenant = ? AND scope_project = ? AND scope_sandbox = ?`,
		time.Now().UTC().Format(time.RFC3339Nano), sessionID, scope.TenantID, scope.ProjectID, scope.SandboxScope)
	return err
}
