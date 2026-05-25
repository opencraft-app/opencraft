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

func (g *ACPGateway) refreshPromptRuntimeIfIdle(scope Scope, sessionID string) error {
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
	lastUserAt := lastUserMessageAt(session.History)
	if lastUserAt.IsZero() || time.Since(lastUserAt) <= threshold {
		g.mu.Unlock()
		return nil
	}
	runtime := session.Runtime
	generation := session.RuntimeGeneration
	g.mu.Unlock()

	ctx, cancel := context.WithTimeout(context.Background(), acpRuntimeRefreshTimeout())
	defer cancel()
	if err := g.runtimeManager.RefreshSessionRuntime(ctx, runtime, sessionID); err != nil {
		g.mu.Lock()
		if current, ok := g.sessions[sessionID]; ok && current.RuntimeGeneration == generation {
			current.LastRuntimeError = err.Error()
			g.persistSession(current)
		}
		g.mu.Unlock()
		return fmt.Errorf("refresh session runtime after idle: %w", err)
	}
	fmt.Fprintf(os.Stderr, "timeline source=server event=acp_runtime_refresh_done session_id=%s generation=%d idle_seconds=%.3f outer_sandbox_id=%s inner_sandbox_id=%s\n", sessionID, generation, time.Since(lastUserAt).Seconds(), runtime.OuterSandboxID, runtime.InnerSandboxID)
	return nil
}

func lastUserMessageAt(history []acpHistoryEntry) time.Time {
	for i := len(history) - 1; i >= 0; i-- {
		if history[i].Role == "user" && !history[i].At.IsZero() {
			return history[i].At
		}
	}
	return time.Time{}
}
