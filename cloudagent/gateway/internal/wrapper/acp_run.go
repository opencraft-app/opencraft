package wrapper

import (
	"context"
	"fmt"
	"strings"
	"time"
)

func (g *ACPGateway) cloudAgentRunCreate(scope Scope, req acpCloudAgentRunCreateRequest) (map[string]any, error) {
	session, err := g.getSession(scope, req.SessionID)
	if err != nil {
		return nil, err
	}
	recovery := g.runtimeRecoverySnapshot(context.Background(), session.SessionID, session.Runtime)
	if session.ReadOnlyReason != "" && !recovery.Restorable {
		return nil, acpReadOnlyError{Reason: session.ReadOnlyReason}
	}
	if session.Closed && !recovery.Restorable {
		return nil, fmt.Errorf("session is closed; load or resume it before prompting")
	}
	session.Runtime = recovery.Runtime
	promptReq := acpPromptRequest{
		SessionID: req.SessionID,
		Prompt:    req.Prompt,
		CWD:       req.CWD,
		Meta:      req.Meta,
	}
	runID, err := g.startPromptRun(nil, nil, session, promptReq, false)
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"run": map[string]any{
			"run_id":     runID,
			"session_id": session.SessionID,
			"status":     "running",
		},
	}, nil
}

func (g *ACPGateway) cloudAgentRunWait(ctx context.Context, scope Scope, req acpCloudAgentRunWaitRequest) (map[string]any, error) {
	run, sessionID, err := g.findPromptRun(scope, req.SessionID, req.RunID)
	if err != nil {
		return nil, err
	}
	completion, completed, done := run.completionSnapshot()
	if !completed {
		if done == nil {
			return nil, fmt.Errorf("run is not waitable")
		}
		select {
		case <-done:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
		completion, completed, _ = run.completionSnapshot()
	}
	if !completed {
		return nil, fmt.Errorf("run did not complete")
	}
	outputText := strings.TrimSpace(completion.OutputText)
	if outputText == "" {
		outputText = strings.TrimSpace(g.assistantTextForRun(scope, sessionID, run))
	}
	runResult := map[string]any{
		"run_id":       run.JobID,
		"session_id":   sessionID,
		"status":       completion.Status,
		"stop_reason":  completion.StopReason,
		"output_text":  outputText,
		"completed_at": completion.CompletedAt.Format(time.RFC3339Nano),
	}
	if completion.Error != "" {
		runResult["error"] = map[string]any{
			"message": completion.Error,
			"code":    "agent_runtime_error",
		}
	}
	return map[string]any{"run": runResult}, nil
}

func (g *ACPGateway) findPromptRun(scope Scope, sessionID, runID string) (*acpPromptRun, string, error) {
	if strings.TrimSpace(sessionID) == "" {
		return nil, "", fmt.Errorf("missing session_id")
	}
	if strings.TrimSpace(runID) == "" {
		return nil, "", fmt.Errorf("missing run_id")
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	session, ok := g.sessions[sessionID]
	if !ok {
		return nil, "", fmt.Errorf("session not found")
	}
	if !sameScope(scope, session.Scope) {
		return nil, "", fmt.Errorf("session is outside caller scope")
	}
	if run := session.PromptRuns[runID]; run != nil {
		return run, session.SessionID, nil
	}
	if run := session.CompletedPromptRuns[runID]; run != nil {
		return run, session.SessionID, nil
	}
	return nil, "", fmt.Errorf("run not found")
}

func (g *ACPGateway) assistantTextForRun(scope Scope, sessionID string, run *acpPromptRun) string {
	if run == nil {
		return ""
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	session, ok := g.sessions[sessionID]
	if !ok || !sameScope(scope, session.Scope) {
		return ""
	}
	for i := len(session.History) - 1; i >= 0; i-- {
		entry := session.History[i]
		if entry.Role != "assistant" {
			continue
		}
		if run.AssistantMessageID != "" && entry.MessageID != "" && entry.MessageID != run.AssistantMessageID {
			continue
		}
		return entry.Text
	}
	return ""
}
