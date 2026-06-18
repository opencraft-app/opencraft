package wrapper

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

type cloudAgentRunRecord struct {
	RunID              string    `json:"run_id"`
	SessionID          string    `json:"session_id"`
	IdempotencyKey     string    `json:"idempotency_key,omitempty"`
	RequestFingerprint string    `json:"request_fingerprint,omitempty"`
	TurnID             string    `json:"turn_id,omitempty"`
	ResponseID         string    `json:"response_id,omitempty"`
	Status             string    `json:"status"`
	StopReason         string    `json:"stop_reason,omitempty"`
	ErrorMessage       string    `json:"error_message,omitempty"`
	OutputText         string    `json:"output_text,omitempty"`
	CreatedAt          time.Time `json:"created_at"`
	UpdatedAt          time.Time `json:"updated_at"`
	CompletedAt        time.Time `json:"completed_at,omitempty"`
}

type cloudAgentRunEvent struct {
	Seq       int64           `json:"seq"`
	RunID     string          `json:"run_id"`
	SessionID string          `json:"session_id"`
	TurnID    string          `json:"turn_id,omitempty"`
	Kind      string          `json:"kind,omitempty"`
	Event     json.RawMessage `json:"event"`
	CreatedAt time.Time       `json:"created_at"`
}

func (s *Store) CreateCloudAgentRun(run cloudAgentRunRecord) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now().UTC()
	if run.CreatedAt.IsZero() {
		run.CreatedAt = now
	}
	if run.UpdatedAt.IsZero() {
		run.UpdatedAt = run.CreatedAt
	}
	if run.Status == "" {
		run.Status = "running"
	}
	if s.dialect == storeDialectMySQL {
		_, err := s.db.Exec(`
INSERT INTO cloudagent_runs (run_id, session_id, idempotency_key, request_fingerprint, turn_id, response_id, status, stop_reason, error_message, output_text, created_at, updated_at, completed_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON DUPLICATE KEY UPDATE
	session_id = VALUES(session_id),
	idempotency_key = IF(VALUES(idempotency_key) = '', idempotency_key, VALUES(idempotency_key)),
	request_fingerprint = IF(VALUES(request_fingerprint) = '', request_fingerprint, VALUES(request_fingerprint)),
	turn_id = VALUES(turn_id),
	response_id = VALUES(response_id),
	status = VALUES(status),
	stop_reason = VALUES(stop_reason),
	error_message = VALUES(error_message),
	output_text = VALUES(output_text),
	updated_at = VALUES(updated_at),
	completed_at = VALUES(completed_at)`,
			run.RunID, run.SessionID, run.IdempotencyKey, run.RequestFingerprint, run.TurnID, run.ResponseID, run.Status, run.StopReason,
			run.ErrorMessage, run.OutputText, run.CreatedAt.Format(time.RFC3339Nano),
			run.UpdatedAt.Format(time.RFC3339Nano), formatOptionalRunTime(run.CompletedAt))
		return err
	}
	_, err := s.db.Exec(`
INSERT INTO cloudagent_runs (run_id, session_id, idempotency_key, request_fingerprint, turn_id, response_id, status, stop_reason, error_message, output_text, created_at, updated_at, completed_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(run_id) DO UPDATE SET
	session_id = excluded.session_id,
	idempotency_key = CASE WHEN excluded.idempotency_key = '' THEN cloudagent_runs.idempotency_key ELSE excluded.idempotency_key END,
	request_fingerprint = CASE WHEN excluded.request_fingerprint = '' THEN cloudagent_runs.request_fingerprint ELSE excluded.request_fingerprint END,
	turn_id = excluded.turn_id,
	response_id = excluded.response_id,
	status = excluded.status,
	stop_reason = excluded.stop_reason,
	error_message = excluded.error_message,
	output_text = excluded.output_text,
	updated_at = excluded.updated_at,
	completed_at = excluded.completed_at`,
		run.RunID, run.SessionID, run.IdempotencyKey, run.RequestFingerprint, run.TurnID, run.ResponseID, run.Status, run.StopReason,
		run.ErrorMessage, run.OutputText, run.CreatedAt.Format(time.RFC3339Nano),
		run.UpdatedAt.Format(time.RFC3339Nano), formatOptionalRunTime(run.CompletedAt))
	return err
}

func (s *Store) TryReserveCloudAgentRun(scope Scope, runID, sessionID, idempotencyKey, requestFingerprint string) (cloudAgentRunRecord, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if idempotencyKey == "" {
		return cloudAgentRunRecord{}, false, fmt.Errorf("idempotency_key is required")
	}
	if existing, err := s.loadCloudAgentRunByIdempotencyKeyLocked(sessionID, idempotencyKey); err == nil {
		if err := s.ensureCloudAgentRunScopeLocked(scope, existing.SessionID); err != nil {
			return cloudAgentRunRecord{}, true, err
		}
		return existing, true, nil
	} else if !isCloudAgentRunNotFound(err) {
		return cloudAgentRunRecord{}, false, err
	}
	if err := s.ensureCloudAgentRunScopeLocked(scope, sessionID); err != nil {
		return cloudAgentRunRecord{}, false, err
	}
	now := time.Now().UTC()
	run := cloudAgentRunRecord{
		RunID:              runID,
		SessionID:          sessionID,
		IdempotencyKey:     idempotencyKey,
		RequestFingerprint: requestFingerprint,
		Status:             "running",
		CreatedAt:          now,
		UpdatedAt:          now,
	}
	insertSQL := `
INSERT INTO cloudagent_runs (run_id, session_id, idempotency_key, request_fingerprint, turn_id, response_id, status, stop_reason, error_message, output_text, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
	if s.dialect == storeDialectMySQL {
		insertSQL = `
INSERT INTO cloudagent_runs (run_id, session_id, idempotency_key, request_fingerprint, turn_id, response_id, status, stop_reason, error_message, output_text, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
	}
	_, err := s.db.Exec(insertSQL,
		run.RunID, run.SessionID, run.IdempotencyKey, run.RequestFingerprint, run.TurnID, run.ResponseID, run.Status, run.StopReason, run.ErrorMessage, run.OutputText,
		run.CreatedAt.Format(time.RFC3339Nano), run.UpdatedAt.Format(time.RFC3339Nano))
	if err != nil {
		if existing, loadErr := s.loadCloudAgentRunByIdempotencyKeyLocked(sessionID, idempotencyKey); loadErr == nil {
			return existing, true, nil
		}
		return cloudAgentRunRecord{}, false, err
	}
	return run, false, nil
}

func (s *Store) LoadCloudAgentRunByIdempotencyKey(scope Scope, sessionID, idempotencyKey string) (cloudAgentRunRecord, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	run, err := s.loadCloudAgentRunByIdempotencyKeyLocked(sessionID, idempotencyKey)
	if err != nil {
		return cloudAgentRunRecord{}, err
	}
	if err := s.ensureCloudAgentRunScopeLocked(scope, run.SessionID); err != nil {
		return cloudAgentRunRecord{}, err
	}
	return run, nil
}

func (s *Store) UpdateCloudAgentRun(runID, status, stopReason, errorMessage, outputText string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	existing, err := s.loadCloudAgentRunLocked(runID)
	if err != nil {
		return err
	}
	if cloudAgentRunTerminal(existing.Status) && existing.Status != status {
		return nil
	}
	now := time.Now().UTC()
	completedAt := ""
	switch status {
	case "completed", "failed", "cancelled", "interrupted":
		if existing.CompletedAt.IsZero() {
			completedAt = now.Format(time.RFC3339Nano)
		}
	}
	_, err = s.db.Exec(`
UPDATE cloudagent_runs
SET status = ?, stop_reason = ?, error_message = ?, output_text = ?, updated_at = ?, completed_at = CASE WHEN ? = '' THEN completed_at ELSE ? END
WHERE run_id = ?`,
		status, stopReason, errorMessage, outputText, now.Format(time.RFC3339Nano), completedAt, completedAt, runID)
	if err != nil {
		return err
	}
	return err
}

func (s *Store) UpdateCloudAgentRunFromRuntime(runID, status, stopReason, errorMessage string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now().UTC()
	completedAt := ""
	switch status {
	case "completed", "failed", "cancelled", "interrupted":
		completedAt = now.Format(time.RFC3339Nano)
	}
	_, err := s.db.Exec(`
UPDATE cloudagent_runs
SET status = ?, stop_reason = ?, error_message = ?, updated_at = ?, completed_at = CASE WHEN ? = '' THEN completed_at ELSE ? END
WHERE run_id = ? AND status NOT IN ('completed', 'failed', 'cancelled', 'interrupted')`,
		status, stopReason, errorMessage, now.Format(time.RFC3339Nano), completedAt, completedAt, runID)
	return err
}

func (s *Store) LoadCloudAgentRun(scope Scope, runID string) (cloudAgentRunRecord, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	run, err := s.loadCloudAgentRunLocked(runID)
	if err != nil {
		return cloudAgentRunRecord{}, err
	}
	if err := s.ensureCloudAgentRunScopeLocked(scope, run.SessionID); err != nil {
		return cloudAgentRunRecord{}, err
	}
	return run, nil
}

func (s *Store) ListCloudAgentRuns(scope Scope, sessionID string, limit int) ([]cloudAgentRunRecord, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if limit <= 0 {
		limit = 50
	}
	args := []any{scope.TenantID, scope.ProjectID, scope.SandboxScope}
	filter := ""
	if sessionID != "" {
		filter = " AND r.session_id = ?"
		args = append(args, sessionID)
	}
	args = append(args, limit)
	rows, err := s.db.Query(`
SELECT r.run_id, r.session_id, r.idempotency_key, r.request_fingerprint, r.turn_id, r.response_id, r.status, r.stop_reason,
	r.error_message, r.output_text, r.created_at, r.updated_at, r.completed_at
FROM cloudagent_runs r
JOIN sessions s ON s.session_id = r.session_id
WHERE s.scope_tenant = ? AND s.scope_project = ? AND s.scope_sandbox = ? AND s.deleted_at IS NULL`+filter+`
ORDER BY r.updated_at DESC
LIMIT ?`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var runs []cloudAgentRunRecord
	for rows.Next() {
		run, err := scanCloudAgentRun(rows)
		if err != nil {
			return nil, err
		}
		runs = append(runs, run)
	}
	return runs, rows.Err()
}

func (s *Store) ListCloudAgentRunsForSession(scope Scope, sessionID string, limit int) ([]cloudAgentRunRecord, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if strings.TrimSpace(sessionID) == "" {
		return nil, fmt.Errorf("session_id is required")
	}
	if limit <= 0 {
		limit = 200
	}
	if limit > 1000 {
		limit = 1000
	}
	if err := s.ensureCloudAgentRunScopeLocked(scope, sessionID); err != nil {
		return nil, err
	}
	rows, err := s.db.Query(`
SELECT run_id, session_id, idempotency_key, request_fingerprint, turn_id, response_id, status, stop_reason,
	error_message, output_text, created_at, updated_at, completed_at
FROM cloudagent_runs
WHERE session_id = ?
ORDER BY created_at ASC, run_id ASC
LIMIT ?`, sessionID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var runs []cloudAgentRunRecord
	for rows.Next() {
		run, err := scanCloudAgentRun(rows)
		if err != nil {
			return nil, err
		}
		runs = append(runs, run)
	}
	return runs, rows.Err()
}

func (s *Store) CloudAgentRunEventsSince(scope Scope, runID string, afterSeq int64) (cloudAgentRunRecord, []cloudAgentRunEvent, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	run, err := s.loadCloudAgentRunLocked(runID)
	if err != nil {
		return cloudAgentRunRecord{}, nil, err
	}
	if err := s.ensureCloudAgentRunScopeLocked(scope, run.SessionID); err != nil {
		return cloudAgentRunRecord{}, nil, err
	}
	events, err := s.cloudAgentRunEventsSinceLocked(run, afterSeq)
	return run, events, err
}

func (s *Store) CloudAgentRunUserEventPrefix(scope Scope, runID string) (cloudAgentRunRecord, int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	run, err := s.loadCloudAgentRunLocked(runID)
	if err != nil {
		return cloudAgentRunRecord{}, 0, err
	}
	if err := s.ensureCloudAgentRunScopeLocked(scope, run.SessionID); err != nil {
		return cloudAgentRunRecord{}, 0, err
	}
	if run.TurnID == "" {
		return run, 0, nil
	}
	var count int64
	err = s.db.QueryRow(`
SELECT COUNT(*)
FROM message_blocks b
JOIN messages m ON m.id = b.message_id
WHERE b.turn_id = ? AND m.role = 'user'`, run.TurnID).Scan(&count)
	if err != nil {
		return cloudAgentRunRecord{}, 0, err
	}
	return run, count, nil
}

func (s *Store) SeedCloudAgentRunEventsFromTurn(runID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	run, err := s.loadCloudAgentRunLocked(runID)
	if err != nil {
		return err
	}
	if run.TurnID == "" {
		return nil
	}
	events, err := s.cloudAgentRunEventsFromBlocksLocked(run, 0)
	if err != nil {
		return err
	}
	existingSeq := map[int64]struct{}{}
	rows, err := s.db.Query(`SELECT seq FROM cloudagent_run_events WHERE run_id = ?`, run.RunID)
	if err != nil {
		return err
	}
	for rows.Next() {
		var seq int64
		if err := rows.Scan(&seq); err != nil {
			_ = rows.Close()
			return err
		}
		existingSeq[seq] = struct{}{}
	}
	if err := rows.Close(); err != nil {
		return err
	}
	for _, event := range events {
		if _, ok := existingSeq[event.Seq]; ok {
			continue
		}
		if err := s.importCloudAgentRunEventLocked(event); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) AppendCloudAgentRunEvent(runID, kind string, event json.RawMessage) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	run, err := s.loadCloudAgentRunLocked(runID)
	if err != nil {
		return err
	}
	return s.appendCloudAgentRunEventLocked(run.RunID, run.SessionID, run.TurnID, kind, event)
}

func (s *Store) ImportCloudAgentRunEvent(event cloudAgentRunEvent) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if event.RunID == "" {
		return fmt.Errorf("run id is required")
	}
	if event.Seq <= 0 {
		return fmt.Errorf("event seq is required")
	}
	run, err := s.loadCloudAgentRunLocked(event.RunID)
	if err != nil {
		return err
	}
	if event.SessionID == "" {
		event.SessionID = run.SessionID
	}
	if event.TurnID == "" {
		event.TurnID = run.TurnID
	}
	if event.Kind == "" {
		event.Kind = cloudAgentRunEventKind(event.Event)
	}
	if event.CreatedAt.IsZero() {
		event.CreatedAt = time.Now().UTC()
	}
	return s.importCloudAgentRunEventLocked(event)
}

func (s *Store) importCloudAgentRunEventLocked(event cloudAgentRunEvent) error {
	if s.failCloudAgentEventAppend {
		return errors.New("cloudagent run event append disabled by test hook")
	}
	insertSQL := `
INSERT INTO cloudagent_run_events (run_id, seq, session_id, turn_id, kind, event_json, created_at)
VALUES (?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(run_id, seq) DO NOTHING`
	if s.dialect == storeDialectMySQL {
		insertSQL = `
INSERT IGNORE INTO cloudagent_run_events (run_id, seq, session_id, turn_id, kind, event_json, created_at)
VALUES (?, ?, ?, ?, ?, ?, ?)`
	}
	res, err := s.db.Exec(insertSQL,
		event.RunID, event.Seq, event.SessionID, event.TurnID, event.Kind,
		string(event.Event), event.CreatedAt.Format(time.RFC3339Nano))
	if err != nil {
		return err
	}
	if rows, err := res.RowsAffected(); err == nil && rows > 0 {
		return nil
	}
	var existingSessionID, existingTurnID, existingKind, existingEvent string
	err = s.db.QueryRow(`
SELECT session_id, turn_id, kind, event_json
FROM cloudagent_run_events
WHERE run_id = ? AND seq = ?`, event.RunID, event.Seq).Scan(
		&existingSessionID, &existingTurnID, &existingKind, &existingEvent,
	)
	if err != nil {
		return err
	}
	if existingSessionID != event.SessionID || existingTurnID != event.TurnID || existingKind != event.Kind || existingEvent != string(event.Event) {
		return fmt.Errorf("cloudagent run event conflict for run_id %s seq %d", event.RunID, event.Seq)
	}
	return nil
}

func (s *Store) ensureCloudAgentRunScopeLocked(scope Scope, sessionID string) error {
	var tenant, project, sandbox string
	err := s.db.QueryRow(`SELECT scope_tenant, scope_project, scope_sandbox FROM sessions WHERE session_id = ? AND deleted_at IS NULL`, sessionID).Scan(&tenant, &project, &sandbox)
	if errors.Is(err, sql.ErrNoRows) {
		return fmt.Errorf("session not found")
	}
	if err != nil {
		return err
	}
	if !sameScope(scope, Scope{TenantID: tenant, ProjectID: project, SandboxScope: sandbox}) {
		return fmt.Errorf("session is outside caller scope")
	}
	return nil
}

func (s *Store) loadCloudAgentRunLocked(runID string) (cloudAgentRunRecord, error) {
	run, err := scanCloudAgentRun(s.db.QueryRow(`
SELECT run_id, session_id, idempotency_key, request_fingerprint, turn_id, response_id, status, stop_reason, error_message, output_text, created_at, updated_at, completed_at
	FROM cloudagent_runs WHERE run_id = ?`, runID))
	if errors.Is(err, sql.ErrNoRows) {
		return cloudAgentRunRecord{}, fmt.Errorf("run not found")
	}
	return run, err
}

func (s *Store) loadCloudAgentRunByIdempotencyKeyLocked(sessionID, idempotencyKey string) (cloudAgentRunRecord, error) {
	run, err := scanCloudAgentRun(s.db.QueryRow(`
SELECT run_id, session_id, idempotency_key, request_fingerprint, turn_id, response_id, status, stop_reason, error_message, output_text, created_at, updated_at, completed_at
FROM cloudagent_runs WHERE session_id = ? AND idempotency_key = ?`, sessionID, idempotencyKey))
	if errors.Is(err, sql.ErrNoRows) {
		legacy, legacyErr := s.loadCloudAgentRunLocked(idempotencyKey)
		if legacyErr == nil && legacy.SessionID == sessionID {
			return legacy, nil
		}
		return cloudAgentRunRecord{}, fmt.Errorf("run not found")
	}
	return run, err
}

type cloudAgentRunScanner interface {
	Scan(dest ...any) error
}

func scanCloudAgentRun(scanner cloudAgentRunScanner) (cloudAgentRunRecord, error) {
	var run cloudAgentRunRecord
	var createdAt, updatedAt string
	var completedAt sql.NullString
	err := scanner.Scan(
		&run.RunID, &run.SessionID, &run.IdempotencyKey, &run.RequestFingerprint, &run.TurnID, &run.ResponseID, &run.Status, &run.StopReason,
		&run.ErrorMessage, &run.OutputText, &createdAt, &updatedAt, &completedAt,
	)
	if err != nil {
		return cloudAgentRunRecord{}, err
	}
	if t, err := time.Parse(time.RFC3339Nano, createdAt); err == nil {
		run.CreatedAt = t
	}
	if t, err := time.Parse(time.RFC3339Nano, updatedAt); err == nil {
		run.UpdatedAt = t
	}
	if completedAt.Valid {
		if t, err := time.Parse(time.RFC3339Nano, completedAt.String); err == nil {
			run.CompletedAt = t
		}
	}
	return run, nil
}

func isCloudAgentRunNotFound(err error) bool {
	return err != nil && err.Error() == "run not found"
}

func (s *Store) cloudAgentRunEventsSinceLocked(run cloudAgentRunRecord, afterSeq int64) ([]cloudAgentRunEvent, error) {
	var storedCount int64
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM cloudagent_run_events WHERE run_id = ?`, run.RunID).Scan(&storedCount); err != nil {
		return nil, err
	}
	if storedCount > 0 {
		rows, err := s.db.Query(`
SELECT seq, session_id, turn_id, kind, event_json, created_at
FROM cloudagent_run_events
WHERE run_id = ? AND seq > ?
ORDER BY seq`, run.RunID, afterSeq)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		var events []cloudAgentRunEvent
		for rows.Next() {
			var event cloudAgentRunEvent
			var payload, createdAt string
			if err := rows.Scan(&event.Seq, &event.SessionID, &event.TurnID, &event.Kind, &payload, &createdAt); err != nil {
				return nil, err
			}
			event.RunID = run.RunID
			event.Event = json.RawMessage(payload)
			if t, err := time.Parse(time.RFC3339Nano, createdAt); err == nil {
				event.CreatedAt = t
			}
			events = append(events, event)
		}
		return events, rows.Err()
	}
	return s.cloudAgentRunEventsFromBlocksLocked(run, afterSeq)
}

func (s *Store) cloudAgentRunEventsFromBlocksLocked(run cloudAgentRunRecord, afterSeq int64) ([]cloudAgentRunEvent, error) {
	if run.TurnID == "" {
		return nil, nil
	}
	rows, err := s.db.Query(`
SELECT b.id, b.turn_id, b.session_id, b.payload_json, b.created_at
FROM message_blocks b
JOIN messages m ON m.id = b.message_id
WHERE b.turn_id = ?
ORDER BY m.message_index, b.block_index`, run.TurnID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var events []cloudAgentRunEvent
	var seq int64
	for rows.Next() {
		var blockID, turnID, sessionID, payload, createdAt string
		if err := rows.Scan(&blockID, &turnID, &sessionID, &payload, &createdAt); err != nil {
			return nil, err
		}
		seq++
		if seq <= afterSeq {
			continue
		}
		event := cloudAgentRunEvent{
			Seq:       seq,
			RunID:     run.RunID,
			SessionID: sessionID,
			TurnID:    turnID,
			Kind:      cloudAgentRunEventKind(json.RawMessage(payload)),
			Event:     json.RawMessage(payload),
		}
		if t, err := time.Parse(time.RFC3339Nano, createdAt); err == nil {
			event.CreatedAt = t
		}
		events = append(events, event)
		_ = blockID
	}
	return events, rows.Err()
}

func (s *Store) appendCloudAgentRunEventLocked(runID, sessionID, turnID, kind string, event json.RawMessage) error {
	if len(event) == 0 {
		return nil
	}
	if s.failCloudAgentEventAppend {
		return errors.New("cloudagent run event append disabled by test hook")
	}
	if kind == "" {
		kind = cloudAgentRunEventKind(event)
	}
	var seq int64
	if err := s.db.QueryRow(`SELECT COALESCE(MAX(seq), 0) + 1 FROM cloudagent_run_events WHERE run_id = ?`, runID).Scan(&seq); err != nil {
		return err
	}
	now := time.Now().UTC()
	_, err := s.db.Exec(`
INSERT INTO cloudagent_run_events (run_id, seq, session_id, turn_id, kind, event_json, created_at)
VALUES (?, ?, ?, ?, ?, ?, ?)`,
		runID, seq, sessionID, turnID, kind, string(event), now.Format(time.RFC3339Nano))
	return err
}

func cloudAgentRunEventKind(raw json.RawMessage) string {
	var payload struct {
		SessionUpdate string `json:"sessionUpdate"`
	}
	_ = json.Unmarshal(raw, &payload)
	switch payload.SessionUpdate {
	case "user_message_chunk":
		return "user_message"
	case "agent_message_chunk":
		return "assistant_text"
	case "agent_thought_chunk":
		return "reasoning"
	case "tool_call", "tool_call_update":
		return payload.SessionUpdate
	case "attachment":
		return "attachment"
	default:
		return payload.SessionUpdate
	}
}

func formatOptionalRunTime(value time.Time) any {
	if value.IsZero() {
		return nil
	}
	return value.Format(time.RFC3339Nano)
}
