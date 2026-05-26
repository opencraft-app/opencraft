package wrapper

import (
	"context"
	"fmt"
	"os"
	"time"
)

const defaultACPRuntimeRefreshIdleThreshold = 45 * time.Second

func acpRuntimeRefreshIdleThreshold() time.Duration {
	return envDurationSeconds("GATEWAY_ACP_RUNTIME_REFRESH_IDLE_SECONDS", defaultACPRuntimeRefreshIdleThreshold)
}

func acpRuntimeRefreshTimeout() time.Duration {
	return envDurationSeconds("GATEWAY_ACP_RUNTIME_REFRESH_TIMEOUT_SECONDS", 15*time.Second)
}

func acpRuntimeRefreshActiveInterval() time.Duration {
	return envDurationSeconds("GATEWAY_ACP_RUNTIME_REFRESH_ACTIVE_SECONDS", acpRuntimeRefreshIdleThreshold())
}

func (g *ACPGateway) refreshPromptRuntimeIfIdle(scope Scope, sessionID string) error {
	return g.refreshSessionRuntimeIfIdle(scope, sessionID, "prompt")
}

func (g *ACPGateway) refreshSessionRuntimeIfIdle(scope Scope, sessionID string, reason string) error {
	threshold := acpRuntimeRefreshIdleThreshold()
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
	lastActivityAt := lastRuntimeActivityAt(session)
	active := sessionHasPromptRuns(session)
	if lastActivityAt.IsZero() || time.Since(lastActivityAt) <= threshold {
		g.mu.Unlock()
		return nil
	}
	runtime := session.Runtime
	generation := session.RuntimeGeneration
	g.mu.Unlock()

	if err := g.refreshRuntimeNow(sessionID, generation, runtime, reason); err != nil {
		return fmt.Errorf("refresh session runtime after idle for %s: %w", reason, err)
	}
	fmt.Fprintf(os.Stderr, "timeline source=server event=acp_runtime_refresh_idle_done reason=%s session_id=%s generation=%d active=%t idle_seconds=%.3f outer_sandbox_id=%s inner_sandbox_id=%s\n", quoteTimelineField(reason), sessionID, generation, active, time.Since(lastActivityAt).Seconds(), runtime.OuterSandboxID, runtime.InnerSandboxID)
	return nil
}

func (g *ACPGateway) startActiveRuntimeRefreshHeartbeat(ctx context.Context, sessionID string, run *acpPromptRun) func() {
	if run == nil {
		return func() {}
	}
	interval := acpRuntimeRefreshActiveInterval()
	if interval <= 0 {
		return func() {}
	}
	heartbeatCtx, cancel := context.WithCancel(ctx)
	done := make(chan struct{})
	go func() {
		defer close(done)
		timer := time.NewTimer(interval)
		defer timer.Stop()
		for {
			select {
			case <-heartbeatCtx.Done():
				return
			case <-timer.C:
				if err := g.refreshActivePromptRuntime(sessionID, run, "active_prompt"); err != nil {
					fmt.Fprintf(os.Stderr, "timeline source=server event=acp_runtime_refresh_active_failed session_id=%s generation=%d job_id=%s error=%s\n", sessionID, run.Generation, run.JobID, quoteServerField(err.Error()))
				}
				timer.Reset(interval)
			}
		}
	}()
	return func() {
		cancel()
		<-done
	}
}

func (g *ACPGateway) refreshActivePromptRuntime(sessionID string, run *acpPromptRun, reason string) error {
	g.mu.Lock()
	session, ok := g.sessions[sessionID]
	if !ok {
		g.mu.Unlock()
		return fmt.Errorf("session not found")
	}
	if !sessionPromptRun(session, run) || session.RuntimeGeneration != run.Generation || run.stopReason() != "" {
		g.mu.Unlock()
		return nil
	}
	runtime := session.Runtime
	generation := session.RuntimeGeneration
	g.mu.Unlock()
	return g.refreshRuntimeNow(sessionID, generation, runtime, reason)
}

func (g *ACPGateway) refreshRuntimeNow(sessionID string, generation int64, runtime ACPSessionRuntime, reason string) error {
	ctx, cancel := context.WithTimeout(context.Background(), acpRuntimeRefreshTimeout())
	defer cancel()
	if err := g.runtimeManager.RefreshSessionRuntime(ctx, runtime, sessionID); err != nil {
		g.mu.Lock()
		if current, ok := g.sessions[sessionID]; ok && current.RuntimeGeneration == generation {
			current.LastRuntimeError = err.Error()
			g.persistSession(current)
		}
		g.mu.Unlock()
		return err
	}
	fmt.Fprintf(os.Stderr, "timeline source=server event=acp_runtime_refresh_done reason=%s session_id=%s generation=%d outer_sandbox_id=%s inner_sandbox_id=%s\n", quoteTimelineField(reason), sessionID, generation, runtime.OuterSandboxID, runtime.InnerSandboxID)
	return nil
}

func (g *ACPGateway) noteRuntimeActivity(scope Scope, sessionID string, generation int64, reason string) {
	now := time.Now().UTC()
	g.mu.Lock()
	defer g.mu.Unlock()
	session, ok := g.sessions[sessionID]
	if !ok || !sameScope(scope, session.Scope) || session.RuntimeGeneration != generation {
		return
	}
	session.LastRuntimeActivityAt = now
	session.UpdatedAt = now
	g.persistSession(session)
	fmt.Fprintf(os.Stderr, "timeline source=server event=acp_runtime_activity session_id=%s generation=%d reason=%s\n", sessionID, generation, quoteTimelineField(reason))
}

func lastRuntimeActivityAt(session *acpSession) time.Time {
	if session == nil {
		return time.Time{}
	}
	last := lastUserMessageAt(session.History)
	if session.LastRuntimeActivityAt.After(last) {
		last = session.LastRuntimeActivityAt
	}
	return last
}

func lastUserMessageAt(history []acpHistoryEntry) time.Time {
	for i := len(history) - 1; i >= 0; i-- {
		if history[i].Role == "user" && !history[i].At.IsZero() {
			return history[i].At
		}
	}
	return time.Time{}
}
