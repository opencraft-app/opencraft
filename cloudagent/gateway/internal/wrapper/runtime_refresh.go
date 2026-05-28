package wrapper

import (
	"context"
	"errors"
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
					if isSessionRunLeaseLostError(err) {
						run.interrupt("session_run_lease_lost")
						return
					}
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
	refreshed, err := g.renewSessionRunLease(ctx, sessionID, generation, runtime)
	if err != nil {
		g.recordRuntimeRefreshError(sessionID, generation, err)
		return err
	}
	if err := g.runtimeManager.RefreshSessionRuntime(ctx, refreshed, sessionID); err != nil {
		g.recordRuntimeRefreshError(sessionID, generation, err)
		return err
	}
	fmt.Fprintf(os.Stderr, "timeline source=server event=acp_runtime_refresh_done reason=%s session_id=%s generation=%d outer_sandbox_id=%s inner_sandbox_id=%s session_run_lease_until=%s\n", quoteTimelineField(reason), sessionID, generation, refreshed.OuterSandboxID, refreshed.InnerSandboxID, formatOptionalTime(refreshed.WispLeaseUntil))
	return nil
}

func (g *ACPGateway) recordRuntimeRefreshError(sessionID string, generation int64, err error) {
	g.mu.Lock()
	if current, ok := g.sessions[sessionID]; ok && current.RuntimeGeneration == generation {
		current.LastRuntimeError = err.Error()
		g.persistSession(current)
	}
	g.mu.Unlock()
}

func (g *ACPGateway) renewSessionRunLease(ctx context.Context, sessionID string, generation int64, runtime ACPSessionRuntime) (ACPSessionRuntime, error) {
	if g.workspaceService == nil {
		return runtime, nil
	}
	ttl := envDurationSeconds("GATEWAY_WISP_WORKSPACE_LEASE_TTL_SECONDS", defaultWorkspaceLeaseTTL)
	refreshed := runtime
	renewed := false
	renewedByKey := map[string]WorkspaceLease{}
	renew := func(label string, workspaceID string, runtimeID string, leaseID string, fence int64, expiresAt time.Time) (WorkspaceLease, bool, error) {
		if workspaceID == "" || runtimeID == "" || leaseID == "" || fence == 0 {
			return WorkspaceLease{}, false, nil
		}
		key := workspaceID + "\x00" + runtimeID + "\x00" + leaseID
		if lease, ok := renewedByKey[key]; ok {
			return lease, true, nil
		}
		lease, err := g.workspaceService.RenewLease(ctx, WorkspaceLease{
			WorkspaceID:  workspaceID,
			RuntimeID:    runtimeID,
			LeaseID:      leaseID,
			FencingToken: fence,
			ExpiresAt:    expiresAt,
		}, ttl)
		if err != nil {
			return WorkspaceLease{}, false, fmt.Errorf("renew %s session run lease %s: %w", label, workspaceID, err)
		}
		renewedByKey[key] = lease
		fmt.Fprintf(os.Stderr, "timeline source=server event=acp_runtime_session_run_lease_renewed session_id=%s generation=%d label=%s workspace_id=%s runtime_id=%s lease_id=%s expires_at=%s\n", sessionID, generation, quoteTimelineField(label), workspaceID, runtimeID, leaseID, lease.ExpiresAt.Format(time.RFC3339Nano))
		return lease, true, nil
	}
	if lease, ok, err := renew("session_run", firstNonEmpty(runtime.WispWorkspaceID, runtime.WispSMHSpaceID, runtime.WorkspaceID), runtime.RuntimeID, runtime.WispLeaseID, runtime.WispLeaseFence, runtime.WispLeaseUntil); err != nil {
		return runtime, err
	} else if ok {
		refreshed.WispLeaseID = lease.LeaseID
		refreshed.WispLeaseFence = lease.FencingToken
		refreshed.WispLeaseUntil = lease.ExpiresAt
		renewed = true
	}
	if !renewed {
		return runtime, nil
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	current, ok := g.sessions[sessionID]
	if !ok || current.RuntimeGeneration != generation {
		return refreshed, nil
	}
	if current.Runtime.WispLeaseID == runtime.WispLeaseID && current.Runtime.WispLeaseFence == runtime.WispLeaseFence {
		current.Runtime.WispLeaseID = refreshed.WispLeaseID
		current.Runtime.WispLeaseFence = refreshed.WispLeaseFence
		current.Runtime.WispLeaseUntil = refreshed.WispLeaseUntil
	}
	current.UpdatedAt = time.Now().UTC()
	g.persistSession(current)
	return current.Runtime, nil
}

func isSessionRunLeaseLostError(err error) bool {
	return errors.Is(err, ErrRuntimeOwnershipHeld) || errors.Is(err, ErrWorkspaceLeaseHeld)
}

func (g *ACPGateway) validatePromptSessionRunLease(scope Scope, sessionID string) error {
	ctx, cancel := context.WithTimeout(context.Background(), acpRuntimeRefreshTimeout())
	defer cancel()
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
	runtime := session.Runtime
	generation := session.RuntimeGeneration
	g.mu.Unlock()
	_, err := g.renewSessionRunLease(ctx, sessionID, generation, runtime)
	if err != nil {
		g.recordRuntimeRefreshError(sessionID, generation, err)
	}
	return err
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
