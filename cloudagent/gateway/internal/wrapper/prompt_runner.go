package wrapper

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path"
	"strings"
	"sync/atomic"
	"time"
)

func (g *ACPGateway) startPrompt(ws *WSConn, id json.RawMessage, session *acpSession, req acpPromptRequest, appEnvelope bool) error {
	instruction, userText, inputFiles, err := g.buildPromptInstruction(session.Scope, req.Prompt)
	if err != nil {
		return err
	}
	trimmed := strings.TrimSpace(instruction)
	if trimmed == "" {
		return fmt.Errorf("prompt must contain text or supported resources")
	}
	inboxMode, err := normalizeACPInboxMode(req.Meta.CloudAgent.InboxMode)
	if err != nil {
		return err
	}
	jobID := "job_" + randomHex(12)
	responseID := "resp_" + randomHex(18)
	ownership, err := g.acquireRuntimeOwnership(context.Background(), session.SessionID, session.RuntimeGeneration, jobID, "prompt")
	if err != nil {
		return err
	}
	releaseOwnership := true
	stopPreflightHeartbeat := g.startRuntimeOwnershipHeartbeat(context.Background(), ownership, nil)
	defer func() {
		stopPreflightHeartbeat()
		if releaseOwnership {
			g.releaseRuntimeOwnership(ownership)
		}
	}()
	if err := g.preflightPromptRuntime(session.Scope, session.SessionID); err != nil {
		return err
	}
	if err := g.refreshPromptRuntimeIfIdle(session.Scope, session.SessionID); err != nil {
		return err
	}
	if !g.runtimeOwnershipHeld(ownership) {
		return RuntimeOwnershipHeldError{SessionID: session.SessionID, Generation: session.RuntimeGeneration, RunID: jobID, OwnerID: g.ownerID, Operation: "prompt"}
	}
	promptCtx, cancel := context.WithCancel(context.Background())
	run, promptJob, err := g.beginPrompt(session.Scope, session.SessionID, cancel, req.CWD, inboxMode, trimmed, userText, jobID, responseID, inputFiles, ownership)
	if err != nil {
		cancel()
		return err
	}
	run.setResponseTarget(ws, id, appEnvelope)
	releaseOwnership = false
	go g.runPromptAsync(promptCtx, ws, id, session.SessionID, promptJob, run, appEnvelope)
	return nil
}
func (g *ACPGateway) runPromptAsync(ctx context.Context, ws *WSConn, id json.RawMessage, sessionID string, job workerJob, run *acpPromptRun, appEnvelope bool) {
	start := time.Now()
	stopOwnershipHeartbeat := g.startRuntimeOwnershipHeartbeat(ctx, run.Ownership, func(error) {
		run.interrupt("ownership_lost")
	})
	defer stopOwnershipHeartbeat()
	defer g.releaseRuntimeOwnership(run.Ownership)
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
				update["turnId"] = run.TurnID
				blockID, storedUpdate, err := g.store.UpsertACPAssistantBlock(sessionID, run.TurnID, run.AssistantMessageID, job.ResponseID, blockType, toolCallID, update)
				if err != nil {
					return err
				}
				if storedUpdate != nil {
					if blockType == "text" || blockType == "reasoning" {
						copyAssistantBlockIdentity(update, storedUpdate)
						attachCloudAgentAccumulatedText(update, nestedContentText(storedUpdate))
					} else {
						update = storedUpdate
					}
				}
				var eventSeq int64
				if seq, err := g.store.ACPBlockSequence(sessionID, blockID); err == nil {
					eventSeq = seq
				}
				attachACPEventIdentity(update, run.TurnID, run.AssistantMessageID, blockID, eventSeq)
			}
		}
		seq := atomic.AddInt64(&streamSeq, 1)
		params := map[string]any{
			"sessionId": sessionID,
			"update":    update,
		}
		delivered, failed := g.broadcastPromptUpdate(job.Scope, sessionID, run, params)
		if delivered == 0 {
			fmt.Fprintf(os.Stderr, "timeline source=server t=%.3fs event=acp_ws_stream_emit_skipped session_id=%s job_id=%s kind=%s seq=%d delta_bytes=%d reason=no_subscribers failed=%d\n", time.Since(start).Seconds(), sessionID, job.JobID, ev.Kind, seq, deltaBytes, failed)
			return nil
		}
		fmt.Fprintf(os.Stderr, "timeline source=server t=%.3fs event=acp_ws_stream_emit_done session_id=%s job_id=%s kind=%s seq=%d delta_bytes=%d subscribers=%d failed=%d\n", time.Since(start).Seconds(), sessionID, job.JobID, ev.Kind, seq, deltaBytes, delivered, failed)
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
			g.broadcastPromptTerminalUpdate(job.Scope, sessionID, run, reason, "")
			_ = g.finishInterruptedPrompt(ws, id, appEnvelope, sessionID, run, reason)
			return
		}
		g.broadcastPromptTerminalUpdate(job.Scope, sessionID, run, "failed", err.Error())
		_ = g.finishFailedPrompt(ws, id, appEnvelope, sessionID, run, err)
		return
	}
	if reason := run.stopReason(); reason != "" {
		g.broadcastPromptTerminalUpdate(job.Scope, sessionID, run, reason, "")
		_ = g.finishInterruptedPrompt(ws, id, appEnvelope, sessionID, run, reason)
		return
	}
	if !g.runtimeOwnershipHeld(run.Ownership) {
		g.broadcastPromptTerminalUpdate(job.Scope, sessionID, run, "ownership_lost", "")
		_ = g.finishInterruptedPrompt(ws, id, appEnvelope, sessionID, run, "ownership_lost")
		return
	}
	if err := g.finishSuccessfulPrompt(sessionID, run, job.ResponseID, result, result.RuntimeUpdate); err != nil {
		if targetWS, targetID, targetEnvelope, ok := run.responseTarget(); ok {
			_ = g.writeResponse(targetWS, targetEnvelope, mustJSONRPCError(targetID, -32000, err.Error()))
		}
		return
	}
	g.broadcastPromptTerminalUpdate(job.Scope, sessionID, run, "completed", "")
	if targetWS, targetID, targetEnvelope, ok := run.responseTarget(); ok {
		_ = g.writeResponse(targetWS, targetEnvelope, mustJSONRPCResult(targetID, acpPromptResult{StopReason: "end_turn"}))
	}
}

func copyAssistantBlockIdentity(update map[string]any, storedUpdate map[string]any) {
	if messageID, ok := storedUpdate["messageId"].(string); ok && messageID != "" {
		update["messageId"] = messageID
	}
	if messageID, ok := storedUpdate["message_id"].(string); ok && messageID != "" {
		update["message_id"] = messageID
	}
	if blockID, ok := storedUpdate["blockId"].(string); ok && blockID != "" {
		update["blockId"] = blockID
	}
	if blockID, ok := storedUpdate["block_id"].(string); ok && blockID != "" {
		update["block_id"] = blockID
	}
}

func attachCloudAgentAccumulatedText(update map[string]any, text string) {
	if text == "" {
		return
	}
	meta, _ := update["_meta"].(map[string]any)
	if meta == nil {
		meta = map[string]any{}
		update["_meta"] = meta
	}
	cloudagent, _ := meta["cloudagent"].(map[string]any)
	if cloudagent == nil {
		cloudagent = map[string]any{}
		meta["cloudagent"] = cloudagent
	}
	cloudagent["accumulated"] = true
	cloudagent["accumulated_text"] = text
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
	status := acpToolStatus(firstNonEmpty(ev.ToolStatus, "running"))
	update := map[string]any{
		"sessionUpdate": kind,
		"toolCallId":    toolCallID,
		"id":            toolCallID,
		"status":        status,
		"toolCall": map[string]any{
			"toolCallId": toolCallID,
			"id":         toolCallID,
			"status":     status,
		},
	}
	if name != "" {
		update["kind"] = acpToolKind(name)
		update["name"] = name
		update["title"] = name
		nested := update["toolCall"].(map[string]any)
		nested["kind"] = acpToolKind(name)
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

func (g *ACPGateway) broadcastPromptTerminalUpdate(scope Scope, sessionID string, run *acpPromptRun, status, message string) {
	update := map[string]any{
		"session_id": sessionID,
		"status":     status,
	}
	if status == "failed" {
		update["error"] = map[string]any{
			"message": firstNonEmpty(message, "Agent error"),
			"code":    "provider_error",
			"source":  "runtime",
		}
	}
	if run != nil {
		if run.TurnID != "" {
			update["turn_id"] = run.TurnID
		}
		if run.AssistantMessageID != "" {
			update["message_id"] = run.AssistantMessageID
		}
		if run.JobID != "" {
			update["job_id"] = run.JobID
		}
	}
	if message != "" {
		update["message"] = message
	}
	g.broadcastCloudAgentNotification(scope, sessionID, run, cloudAgentTurnStatusMethod, update)
}

func ensurePromptRuns(session *acpSession) map[string]*acpPromptRun {
	if session.PromptRuns == nil {
		session.PromptRuns = make(map[string]*acpPromptRun)
	}
	return session.PromptRuns
}
func sessionPromptRun(session *acpSession, run *acpPromptRun) bool {
	if session == nil || run == nil || session.PromptRuns == nil {
		return false
	}
	return session.PromptRuns[run.JobID] == run
}
func sessionHasPromptRuns(session *acpSession) bool {
	return session != nil && len(session.PromptRuns) > 0
}
func removeSessionPromptRun(session *acpSession, run *acpPromptRun) bool {
	if !sessionPromptRun(session, run) {
		return false
	}
	delete(session.PromptRuns, run.JobID)
	return true
}
func normalizeACPInboxMode(value string) (string, error) {
	mode := strings.ToLower(strings.TrimSpace(value))
	if mode == "" {
		return "prompt", nil
	}
	switch mode {
	case "prompt", "steer", "follow_up":
		return mode, nil
	case "followup", "follow-up":
		return "follow_up", nil
	default:
		return "", fmt.Errorf("unsupported cloudagent inbox_mode %q", value)
	}
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
	if !sessionHasPromptRuns(session) {
		g.mu.Unlock()
		return nil
	}
	var run *acpPromptRun
	for _, candidate := range session.PromptRuns {
		run = candidate
		break
	}
	runtime := session.Runtime
	g.mu.Unlock()
	run.interrupt("cancelled")
	var promptErr error
	if ws, promptID, promptEnvelope, ok := run.responseTarget(); ok {
		promptErr = g.finishInterruptedPrompt(ws, promptID, promptEnvelope, sessionID, run, "cancelled")
	}
	cancelCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	err := g.runtimeManager.CancelSessionRuntime(cancelCtx, runtime, sessionID, run.JobID)
	cancel()
	if err != nil {
		return errors.Join(promptErr, err)
	}
	return promptErr
}
func (g *ACPGateway) beginPrompt(scope Scope, sessionID string, cancel context.CancelFunc, cwd, inboxMode, prompt, userText, jobID, responseID string, inputFiles []materializedFile, ownership RuntimeOwnershipLease) (*acpPromptRun, workerJob, error) {
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
	if session.State != acpRuntimeStateReady && session.State != acpRuntimeStatePrompting {
		return nil, workerJob{}, fmt.Errorf("session is not ready")
	}
	if cwd != "" {
		session.CWD = defaultSessionCWD(cwd)
	}
	historySeed := runtimeHistorySeed(session.History)
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
		Ownership:          ownership,
	}
	ensurePromptRuns(session)[jobID] = run
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
		ACPInboxMode:          inboxMode,
		TimeoutSeconds:        300,
		ACPSessionID:          session.SessionID,
		ACPSessionGeneration:  session.RuntimeGeneration,
		ACPSessionRuntime:     session.Runtime,
		ACPSessionHistory:     historySeed,
	}
	g.persistSession(session)
	return run, job, nil
}

func runtimeHistorySeed(history []acpHistoryEntry) []runtimeHistoryEntry {
	if len(history) == 0 {
		return nil
	}
	seed := make([]runtimeHistoryEntry, 0, len(history))
	for _, entry := range history {
		role := strings.TrimSpace(strings.ToLower(entry.Role))
		if role != "user" && role != "assistant" && role != "system" {
			continue
		}
		text := strings.TrimSpace(entry.Text)
		if text == "" {
			continue
		}
		seed = append(seed, runtimeHistoryEntry{Role: role, Text: text})
	}
	return seed
}
func (g *ACPGateway) promptCanEmit(sessionID string, run *acpPromptRun) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	session, ok := g.sessions[sessionID]
	return ok && sessionPromptRun(session, run) && session.RuntimeGeneration == run.Generation && run.stopReason() == ""
}
func (g *ACPGateway) finishSuccessfulPrompt(sessionID string, run *acpPromptRun, responseID string, result workerResult, update ACPSessionRuntimeUpdate) error {
	g.mu.Lock()
	defer g.mu.Unlock()
	session, ok := g.sessions[sessionID]
	if !ok {
		return fmt.Errorf("session not found")
	}
	if !sessionPromptRun(session, run) || session.RuntimeGeneration != run.Generation {
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
	removeSessionPromptRun(session, run)
	if !sessionHasPromptRuns(session) {
		session.State = acpRuntimeStateReady
	}
	session.UpdatedAt = time.Now().UTC()
	session.CurrentResponseID = responseID
	if g.store != nil && run.TurnID != "" && run.AssistantMessageID != "" {
		if strings.TrimSpace(result.OutputText) != "" && !g.store.AssistantMessageHasTextBlock(run.AssistantMessageID) {
			payload := map[string]any{
				"sessionUpdate": "agent_message_chunk",
				"messageId":     run.AssistantMessageID,
				"content":       map[string]any{"text": result.OutputText},
			}
			if _, _, err := g.store.UpsertACPAssistantBlock(session.SessionID, run.TurnID, run.AssistantMessageID, responseID, "text", "", payload); err != nil {
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
	if session, ok := g.sessions[sessionID]; ok && sessionPromptRun(session, run) && session.RuntimeGeneration == run.Generation {
		removeSessionPromptRun(session, run)
		session.CurrentResponseID = ""
		if reason == "cancelled" && !sessionHasPromptRuns(session) {
			if !sessionHasPromptRuns(session) {
				session.State = acpRuntimeStateReady
			}
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
	targetWS, targetID, targetEnvelope, ok := run.responseTarget()
	if !ok {
		return nil
	}
	return g.writeResponse(targetWS, targetEnvelope, mustJSONRPCResult(targetID, acpPromptResult{StopReason: reason}))
}
func (g *ACPGateway) finishFailedPrompt(ws *WSConn, id json.RawMessage, appEnvelope bool, sessionID string, run *acpPromptRun, err error) error {
	if stopReason := workerStopReason(err); stopReason != "" {
		g.mu.Lock()
		if session, ok := g.sessions[sessionID]; ok && sessionPromptRun(session, run) && session.RuntimeGeneration == run.Generation {
			removeSessionPromptRun(session, run)
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
		targetWS, targetID, targetEnvelope, ok := run.responseTarget()
		if !ok {
			return nil
		}
		return g.writeResponse(targetWS, targetEnvelope, mustJSONRPCResult(targetID, acpPromptResult{StopReason: stopReason}))
	}
	g.mu.Lock()
	if session, ok := g.sessions[sessionID]; ok && sessionPromptRun(session, run) && session.RuntimeGeneration == run.Generation {
		removeSessionPromptRun(session, run)
		if sessionHasPromptRuns(session) {
			session.State = acpRuntimeStatePrompting
		} else {
			session.State = acpRuntimeStateFailed
		}
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
	targetWS, targetID, targetEnvelope, ok := run.responseTarget()
	if !ok {
		return nil
	}
	return g.writeResponse(targetWS, targetEnvelope, mustJSONRPCErrorFromError(targetID, err))
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
func (r *acpPromptRun) clearResponseTarget(ws *WSConn) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.WS != ws {
		return
	}
	r.WS = nil
	r.RPCID = nil
	r.AppEnvelope = false
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
	if !ok || !sameScope(scope, session.Scope) || !sessionHasPromptRuns(session) {
		return nil
	}
	var run *acpPromptRun
	for _, candidate := range session.PromptRuns {
		run = candidate
		break
	}
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
