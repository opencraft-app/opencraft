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
	Role       string
	EventType  string
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
	_, err := s.db.Exec(`
INSERT INTO sessions (
	session_id, scope_tenant, scope_project, scope_sandbox, cwd, title, model, state,
	closed, runtime_generation, current_response_id, last_runtime_error, created_at,
	updated_at, read_only_reason
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(session_id) DO UPDATE SET
	cwd = excluded.cwd,
	title = excluded.title,
	model = excluded.model,
	state = excluded.state,
	closed = excluded.closed,
	runtime_generation = excluded.runtime_generation,
	current_response_id = excluded.current_response_id,
	last_runtime_error = excluded.last_runtime_error,
	updated_at = excluded.updated_at,
	read_only_reason = excluded.read_only_reason,
	deleted_at = NULL`,
		session.SessionID, session.Scope.TenantID, session.Scope.ProjectID, session.Scope.SandboxScope,
		session.CWD, sessionTitle(session), session.Model, string(session.State), closed,
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
	_, err := s.db.Exec(`
INSERT INTO session_runtimes (
	session_id, generation, sandbox_backend, sandbox_template_id, runtime_id, outer_sandbox_id, outer_sandbox_domain,
	outer_envd_access_token, outer_traffic_token, daemon_addr, remote_binary,
	inner_sandbox_id, inner_sandbox_domain, inner_envd_access_token, session_proxy_id,
	health_state, cleanup_state, last_cleanup_error
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(session_id, generation) DO UPDATE SET
	sandbox_backend = excluded.sandbox_backend,
	sandbox_template_id = excluded.sandbox_template_id,
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
	health_state = excluded.health_state,
	cleanup_state = excluded.cleanup_state,
	last_cleanup_error = excluded.last_cleanup_error`,
		session.SessionID, session.RuntimeGeneration, runtime.SandboxBackend, runtime.SandboxTemplateID, runtime.RuntimeID, runtime.OuterSandboxID,
		runtime.OuterSandboxDomain, runtime.OuterEnvdAccessToken, runtime.OuterTrafficToken,
		runtime.DaemonAddr, runtime.RemoteBinary, runtime.InnerSandboxID, runtime.InnerSandboxDomain,
		runtime.InnerEnvdAccessToken, runtime.SessionProxyID, string(session.State), "", session.LastRuntimeError)
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
SELECT session_id, scope_tenant, scope_project, scope_sandbox, cwd, model, state, closed,
       runtime_generation, current_response_id, last_runtime_error, created_at, updated_at,
       read_only_reason
FROM sessions WHERE session_id = ? AND deleted_at IS NULL`, sessionID).Scan(
		&session.SessionID, &session.Scope.TenantID, &session.Scope.ProjectID, &session.Scope.SandboxScope,
		&session.CWD, &session.Model, &state, &closed, &session.RuntimeGeneration,
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
	if session.ReadOnlyReason == "" && !session.Closed && runtimeNeedsCleanup(runtime) {
		session.ReadOnlyReason = acpReadOnlyRuntimeNotRecovered
	}
	return &session, true, nil
}

func (s *Store) loadACPRuntimeLocked(sessionID string, generation int64) (ACPSessionRuntime, error) {
	var runtime ACPSessionRuntime
	err := s.db.QueryRow(`
SELECT runtime_id, outer_sandbox_id, outer_sandbox_domain, outer_envd_access_token,
       outer_traffic_token, daemon_addr, remote_binary, inner_sandbox_id,
       inner_sandbox_domain, inner_envd_access_token, session_proxy_id,
       sandbox_backend, sandbox_template_id
FROM session_runtimes WHERE session_id = ? AND generation = ?`, sessionID, generation).Scan(
		&runtime.RuntimeID, &runtime.OuterSandboxID, &runtime.OuterSandboxDomain,
		&runtime.OuterEnvdAccessToken, &runtime.OuterTrafficToken, &runtime.DaemonAddr,
		&runtime.RemoteBinary, &runtime.InnerSandboxID, &runtime.InnerSandboxDomain,
		&runtime.InnerEnvdAccessToken, &runtime.SessionProxyID, &runtime.SandboxBackend, &runtime.SandboxTemplateID,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return ACPSessionRuntime{}, nil
	}
	return runtime, err
}

func (s *Store) loadACPSessionEventsLocked(sessionID string) ([]acpSessionEvent, []acpHistoryEntry, error) {
	rows, err := s.db.Query(`
SELECT b.id, b.message_id, m.role, b.type, b.tool_call_id, b.response_id, b.payload_json, b.created_at
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
		if err := rows.Scan(&block.ID, &block.MessageID, &block.Role, &block.Type, &block.ToolCallID, &block.ResponseID, &payload, &createdAt); err != nil {
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
		Role:       b.Role,
		EventType:  eventType,
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
		event := acpSessionEvent{SessionID: sessionID, Seq: int64(blockIndex + 1), Role: "user", EventType: "user_message", MessageID: record.UserMessageID, BlockID: blockID, Payload: data, CreatedAt: now}
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
			if _, err := tx.Exec(`INSERT OR REPLACE INTO session_files (session_id, event_id, file_id, staged_rel_path, display_name, mime_type, bytes, purpose) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
				sessionID, 0, file.FileID, strings.TrimPrefix(file.WorkspacePath, "./"), file.Filename, file.ContentType, file.Bytes, "input"); err != nil {
				return acpPromptTurnRecord{}, err
			}
		}
		record.Events = append(record.Events, acpSessionEvent{SessionID: sessionID, Seq: int64(blockIndex + 1), Role: "user", EventType: "attachment", MessageID: record.UserMessageID, BlockID: blockID, Payload: data, CreatedAt: now})
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

func (s *Store) UpsertACPAssistantBlock(sessionID, turnID, messageID, responseID, blockType, toolCallID string, payload map[string]any) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.Begin()
	if err != nil {
		return "", err
	}
	defer tx.Rollback()
	now := time.Now().UTC()
	blockID, payloadJSON, err := upsertAssistantBlockTx(tx, sessionID, turnID, messageID, responseID, blockType, toolCallID, payload, now)
	if err != nil {
		return "", err
	}
	if err := tx.Commit(); err != nil {
		return "", err
	}
	_ = payloadJSON
	return blockID, nil
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
		sessionUpdate := "lifecycle"
		blockType := "lifecycle"
		payload := map[string]any{"sessionUpdate": sessionUpdate, "messageId": assistantMessageID, "status": status}
		if status == "failed" {
			blockType = "error"
			payload = map[string]any{"sessionUpdate": "error", "messageId": assistantMessageID, "error": map[string]any{"message": detail, "code": "provider_error", "source": "runtime"}}
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
