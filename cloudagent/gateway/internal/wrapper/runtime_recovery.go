package wrapper

import (
	"context"
	"fmt"
	"os"
	"strings"
	"time"
)

func (g *ACPGateway) recoverPromptRuntime(ctx context.Context, sessionID string, run *acpPromptRun, job workerJob, cause error) (workerJob, bool) {
	g.mu.Lock()
	session, ok := g.sessions[sessionID]
	if !ok || !sessionPromptRun(session, run) || session.RuntimeGeneration != run.Generation || run.stopReason() != "" {
		g.mu.Unlock()
		return job, false
	}
	staleRuntime := g.runtimeRecoverySnapshot(context.Background(), sessionID, job.ACPSessionRuntime).Runtime
	recoverRuntime := staleRuntime
	if runtimeCanRecreate(staleRuntime) {
		recoverRuntime = runtimeAfterClose(staleRuntime)
	}
	g.markStaleRuntimeProxyLocked(session.Runtime)
	session.RuntimeGeneration++
	run.Generation = session.RuntimeGeneration
	session.Runtime = recoverRuntime
	session.LastRuntimeError = cause.Error()
	session.UpdatedAt = time.Now().UTC()
	g.persistSession(session)
	startReq := ACPSessionRuntimeStartRequest{
		SessionID:        session.SessionID,
		Scope:            session.Scope,
		CWD:              sidecarRequestCWD(),
		Generation:       session.RuntimeGeneration,
		SandboxBackend:   staleRuntime.SandboxBackend,
		OuterRuntime:     staleRuntime.OuterRuntime,
		RuntimeRecovery:  staleRuntime.RuntimeRecovery,
		AgentVersion:     staleRuntime.AgentVersion,
		WorkspaceVersion: staleRuntime.WorkspaceVersion,
		SidecarArtifact:  runtimeSidecarArtifact(staleRuntime),
	}
	recoveredJob := job
	recoveredJob.ACPSessionGeneration = session.RuntimeGeneration
	generation := session.RuntimeGeneration
	g.mu.Unlock()

	fmt.Fprintf(os.Stderr, "timeline source=server event=acp_runtime_recover_start session_id=%s old_outer_sandbox_id=%s error=%s\n", sessionID, staleRuntime.OuterSandboxID, quoteServerField(cause.Error()))
	if staleRuntime.RuntimeID != "" || staleRuntime.OuterSandboxID != "" {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		_ = g.runtimeManager.CloseSessionRuntime(cleanupCtx, staleRuntime)
		cancel()
	}
	recoveredRuntime, err := g.runtimeManager.EnsureSessionRuntime(ctx, recoverRuntime, startReq)
	g.mu.Lock()
	defer g.mu.Unlock()
	current, ok := g.sessions[sessionID]
	if !ok || !sessionPromptRun(current, run) || current.RuntimeGeneration != generation {
		if err == nil {
			go func() {
				cleanupCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
				defer cancel()
				_ = g.runtimeManager.CloseSessionRuntime(cleanupCtx, recoveredRuntime)
			}()
		}
		return recoveredJob, false
	}
	if err != nil {
		current.State = acpRuntimeStateFailed
		current.LastRuntimeError = err.Error()
		current.UpdatedAt = time.Now().UTC()
		g.persistSession(current)
		fmt.Fprintf(os.Stderr, "timeline source=server event=acp_runtime_recover_failed session_id=%s error=%s\n", sessionID, quoteServerField(err.Error()))
		return recoveredJob, false
	}
	current.Runtime = recoveredRuntime
	g.ensureRuntimeProxyIDLocked(current)
	current.State = acpRuntimeStatePrompting
	current.Closed = false
	current.RuntimeVerified = true
	current.LastRuntimeError = ""
	current.UpdatedAt = time.Now().UTC()
	g.persistSession(current)
	fmt.Fprintf(os.Stderr, "timeline source=server event=acp_runtime_recover_done session_id=%s new_outer_sandbox_id=%s\n", sessionID, recoveredRuntime.OuterSandboxID)
	recoveredJob.ACPSessionRuntime = recoveredRuntime
	return recoveredJob, true
}
func (g *ACPGateway) preflightPromptRuntime(scope Scope, sessionID string) error {
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
	recovery := g.runtimeRecoverySnapshot(context.Background(), sessionID, session.Runtime)
	if session.ReadOnlyReason != "" && !recovery.Restorable {
		reason := firstNonEmpty(session.ReadOnlyReason, acpReadOnlyRuntimeNotRecovered)
		g.mu.Unlock()
		return acpReadOnlyError{Reason: reason}
	}
	if recovery.Restorable && runtimeEnsureChanged(recovery.Runtime, session.Runtime) {
		session.Runtime = recovery.Runtime
		g.persistSession(session)
	}
	closedRestorable := session.Closed && recovery.Restorable
	if session.Closed && !closedRestorable {
		g.mu.Unlock()
		return fmt.Errorf("session is closed; resume it before prompting")
	}
	if session.State != acpRuntimeStateReady && session.State != acpRuntimeStatePrompting && !closedRestorable {
		g.mu.Unlock()
		return fmt.Errorf("session is not ready")
	}
	runtime := session.Runtime
	generation := session.RuntimeGeneration
	startReq := sessionRuntimeStartRequest(session)
	if !runtimeNeedsCleanup(runtime) {
		session.State = acpRuntimeStateClosed
		session.Closed = true
		session.ReadOnlyReason = acpReadOnlyRuntimeNotRecovered
		session.LastRuntimeError = "runtime identity is missing"
		session.UpdatedAt = time.Now().UTC()
		g.persistSession(session)
		g.mu.Unlock()
		return acpRuntimeUnavailableError{
			SessionID: sessionID,
			Reason:    acpReadOnlyRuntimeNotRecovered,
			Detail:    "runtime identity is missing",
		}
	}
	g.mu.Unlock()

	commit := func(checked ACPSessionRuntime) error {
		g.mu.Lock()
		defer g.mu.Unlock()
		if current, ok := g.sessions[sessionID]; ok && current.RuntimeGeneration == generation && (current.State == acpRuntimeStateReady || current.State == acpRuntimeStatePrompting || closedRestorable) {
			current.Runtime = checked
			g.ensureRuntimeProxyIDLocked(current)
			if !sessionHasPromptRuns(current) {
				current.State = acpRuntimeStateReady
			}
			current.Closed = false
			current.RuntimeVerified = true
			current.LastRuntimeError = ""
			current.ReadOnlyReason = ""
			current.UpdatedAt = time.Now().UTC()
			g.persistSession(current)
		}
		return nil
	}
	checked, err := g.ensureSessionRuntime(sessionID, generation, runtime, startReq, commit, closedRestorable)
	if err != nil {
		return g.markPromptRuntimeUnavailable(sessionID, generation, runtime, err)
	}

	g.mu.Lock()
	if current, ok := g.sessions[sessionID]; ok && current.RuntimeGeneration == generation && (current.State == acpRuntimeStateReady || current.State == acpRuntimeStatePrompting || closedRestorable) {
		current.Runtime = checked
		g.ensureRuntimeProxyIDLocked(current)
		if !sessionHasPromptRuns(current) {
			current.State = acpRuntimeStateReady
		}
		current.Closed = false
		current.RuntimeVerified = true
		current.LastRuntimeError = ""
		current.ReadOnlyReason = ""
		current.UpdatedAt = time.Now().UTC()
		g.persistSession(current)
	}
	g.mu.Unlock()
	return nil
}

func (g *ACPGateway) ensureSessionRuntime(sessionID string, generation int64, runtime ACPSessionRuntime, req ACPSessionRuntimeStartRequest, commit func(ACPSessionRuntime) error, emitLifecycle bool) (ACPSessionRuntime, error) {
	key := runtimeEnsureKey(sessionID, generation)
	for {
		g.mu.Lock()
		if g.runtimeEnsures == nil {
			g.runtimeEnsures = map[string]*acpRuntimeEnsureCall{}
		}
		if call := g.runtimeEnsures[key]; call != nil {
			done := call.done
			startedAt := call.startedAt
			g.mu.Unlock()
			fmt.Fprintf(os.Stderr, "timeline source=server event=acp_runtime_ensure_join session_id=%s generation=%d wait_ms=%d\n", sessionID, generation, elapsedMillis(startedAt))
			<-done
			if call.err != nil {
				fmt.Fprintf(os.Stderr, "timeline source=server event=acp_runtime_ensure_join_failed session_id=%s generation=%d elapsed_ms=%d error=%s\n", sessionID, generation, elapsedMillis(startedAt), quoteServerField(call.err.Error()))
				return ACPSessionRuntime{}, call.err
			}
			fmt.Fprintf(os.Stderr, "timeline source=server event=acp_runtime_ensure_join_done session_id=%s generation=%d elapsed_ms=%d runtime_id=%s outer_sandbox_id=%s\n", sessionID, generation, elapsedMillis(startedAt), call.runtime.RuntimeID, call.runtime.OuterSandboxID)
			return call.runtime, nil
		}
		call := &acpRuntimeEnsureCall{done: make(chan struct{}), startedAt: time.Now().UTC()}
		g.runtimeEnsures[key] = call
		g.mu.Unlock()

		checked, err := g.runSessionRuntimeEnsure(key, sessionID, generation, runtime, req, commit, emitLifecycle)

		g.mu.Lock()
		if current := g.runtimeEnsures[key]; current == call {
			delete(g.runtimeEnsures, key)
		}
		call.runtime = checked
		call.err = err
		close(call.done)
		g.mu.Unlock()
		return checked, err
	}
}

func (g *ACPGateway) runSessionRuntimeEnsure(key, sessionID string, generation int64, runtime ACPSessionRuntime, req ACPSessionRuntimeStartRequest, commit func(ACPSessionRuntime) error, emitLifecycle bool) (ACPSessionRuntime, error) {
	startedAt := time.Now().UTC()
	timeout := envDurationSeconds("GATEWAY_ACP_RUNTIME_ENSURE_TIMEOUT_SECONDS", 300*time.Second)
	ensureCtx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	fmt.Fprintf(os.Stderr, "timeline source=server event=acp_runtime_ensure_start session_id=%s generation=%d timeout_ms=%d runtime_id=%s outer_sandbox_id=%s outer_runtime=%s runtime_recovery=%s sandbox_backend=%s agent_version=%s workspace_version=%s wisp_workspace_id=%s\n", sessionID, generation, timeout.Milliseconds(), runtime.RuntimeID, runtime.OuterSandboxID, firstNonEmpty(runtime.OuterRuntime, req.OuterRuntime), firstNonEmpty(runtime.RuntimeRecovery, req.RuntimeRecovery), firstNonEmpty(runtime.SandboxBackend, req.SandboxBackend), firstNonEmpty(runtime.AgentVersion, req.AgentVersion), firstNonEmpty(runtime.WorkspaceVersion, req.WorkspaceVersion), runtime.WispWorkspaceID)
	leaseStartedAt := time.Now().UTC()
	fmt.Fprintf(os.Stderr, "timeline source=server event=acp_runtime_ensure_lease_wait_start session_id=%s generation=%d lock_key=%s\n", sessionID, generation, quoteServerField("acp_runtime_ensure:"+key))
	if emitLifecycle {
		g.broadcastWorkspaceLifecycle(req.Scope, sessionID, generation, "restore", "lease_wait", "running", "等待 Runtime 所有权", startedAt, nil)
	}
	lease, err := acquireRuntimeEnsureLease(ensureCtx, g.runtimeLock, "acp_runtime_ensure:"+key, timeout)
	if err != nil {
		fmt.Fprintf(os.Stderr, "timeline source=server event=acp_runtime_ensure_lease_failed session_id=%s generation=%d elapsed_ms=%d error=%s\n", sessionID, generation, elapsedMillis(leaseStartedAt), quoteServerField(err.Error()))
		if emitLifecycle {
			g.broadcastWorkspaceLifecycle(req.Scope, sessionID, generation, "restore", "lease_wait", "failed", "获取 Runtime 所有权失败", startedAt, map[string]any{"error": err.Error()})
		}
		return ACPSessionRuntime{}, err
	}
	fmt.Fprintf(os.Stderr, "timeline source=server event=acp_runtime_ensure_lease_acquired session_id=%s generation=%d wait_ms=%d\n", sessionID, generation, elapsedMillis(leaseStartedAt))
	if emitLifecycle {
		g.broadcastWorkspaceLifecycle(req.Scope, sessionID, generation, "restore", "lease_wait", "done", "已获得 Runtime 所有权", startedAt, nil)
	}
	defer func() {
		releaseCtx, releaseCancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer releaseCancel()
		if releaseErr := lease.Release(releaseCtx); releaseErr != nil {
			fmt.Fprintf(os.Stderr, "timeline source=server event=acp_runtime_ensure_unlock_failed session_id=%s generation=%d error=%s\n", sessionID, generation, quoteServerField(releaseErr.Error()))
		}
	}()

	if refreshed, ok := g.committedEnsuredRuntime(req.Scope, sessionID, generation, runtime); ok {
		if commit != nil {
			if err := commit(refreshed); err != nil {
				fmt.Fprintf(os.Stderr, "timeline source=server event=acp_runtime_ensure_commit_failed session_id=%s generation=%d elapsed_ms=%d error=%s\n", sessionID, generation, elapsedMillis(startedAt), quoteServerField(err.Error()))
				return ACPSessionRuntime{}, err
			}
		}
		fmt.Fprintf(os.Stderr, "timeline source=server event=acp_runtime_ensure_committed_reuse session_id=%s generation=%d elapsed_ms=%d runtime_id=%s outer_sandbox_id=%s\n", sessionID, generation, elapsedMillis(startedAt), refreshed.RuntimeID, refreshed.OuterSandboxID)
		if emitLifecycle {
			g.broadcastWorkspaceLifecycle(req.Scope, sessionID, generation, "restore", "ready", "done", "Workspace 已恢复", startedAt, map[string]any{
				"runtime_id":       refreshed.RuntimeID,
				"outer_sandbox_id": refreshed.OuterSandboxID,
			})
		}
		return refreshed, nil
	}

	managerStartedAt := time.Now().UTC()
	fmt.Fprintf(os.Stderr, "timeline source=server event=acp_runtime_ensure_manager_start session_id=%s generation=%d runtime_id=%s outer_sandbox_id=%s wisp_workspace_id=%s\n", sessionID, generation, runtime.RuntimeID, runtime.OuterSandboxID, runtime.WispWorkspaceID)
	if emitLifecycle {
		g.broadcastWorkspaceLifecycle(req.Scope, sessionID, generation, "restore", "runtime", "running", "恢复 Runtime Host", startedAt, map[string]any{
			"runtime_id":       runtime.RuntimeID,
			"outer_sandbox_id": runtime.OuterSandboxID,
		})
	}
	checked, err := g.runtimeManager.EnsureSessionRuntime(ensureCtx, runtime, req)
	if err != nil {
		fmt.Fprintf(os.Stderr, "timeline source=server event=acp_runtime_ensure_manager_failed session_id=%s generation=%d elapsed_ms=%d total_ms=%d error=%s\n", sessionID, generation, elapsedMillis(managerStartedAt), elapsedMillis(startedAt), quoteServerField(err.Error()))
		if emitLifecycle {
			g.broadcastWorkspaceLifecycle(req.Scope, sessionID, generation, "restore", "runtime", "failed", "Runtime Host 恢复失败", startedAt, map[string]any{"error": err.Error()})
		}
		return ACPSessionRuntime{}, err
	}
	fmt.Fprintf(os.Stderr, "timeline source=server event=acp_runtime_ensure_manager_done session_id=%s generation=%d elapsed_ms=%d runtime_id=%s outer_sandbox_id=%s wisp_workspace_id=%s\n", sessionID, generation, elapsedMillis(managerStartedAt), checked.RuntimeID, checked.OuterSandboxID, checked.WispWorkspaceID)
	if emitLifecycle {
		g.broadcastWorkspaceLifecycle(req.Scope, sessionID, generation, "restore", "runtime", "done", "Runtime Host 已恢复", startedAt, map[string]any{
			"runtime_id":       checked.RuntimeID,
			"outer_sandbox_id": checked.OuterSandboxID,
		})
	}
	if commit != nil {
		if err := commit(checked); err != nil {
			fmt.Fprintf(os.Stderr, "timeline source=server event=acp_runtime_ensure_commit_failed session_id=%s generation=%d elapsed_ms=%d error=%s\n", sessionID, generation, elapsedMillis(startedAt), quoteServerField(err.Error()))
			return ACPSessionRuntime{}, err
		}
	}
	fmt.Fprintf(os.Stderr, "timeline source=server event=acp_runtime_ensure_done session_id=%s generation=%d elapsed_ms=%d runtime_id=%s outer_sandbox_id=%s\n", sessionID, generation, elapsedMillis(startedAt), checked.RuntimeID, checked.OuterSandboxID)
	if emitLifecycle {
		g.broadcastWorkspaceLifecycle(req.Scope, sessionID, generation, "restore", "ready", "done", "Workspace 已恢复", startedAt, map[string]any{
			"runtime_id":       checked.RuntimeID,
			"outer_sandbox_id": checked.OuterSandboxID,
		})
	}
	return checked, nil
}

func runtimeEnsureKey(sessionID string, generation int64) string {
	return fmt.Sprintf("%s:%d", sessionID, generation)
}

func elapsedMillis(startedAt time.Time) int64 {
	if startedAt.IsZero() {
		return 0
	}
	return time.Since(startedAt).Milliseconds()
}

func (g *ACPGateway) committedEnsuredRuntime(scope Scope, sessionID string, generation int64, original ACPSessionRuntime) (ACPSessionRuntime, bool) {
	if g.store == nil {
		return ACPSessionRuntime{}, false
	}
	session, err := g.store.LoadACPSession(scope, sessionID)
	if err != nil || session.RuntimeGeneration != generation {
		return ACPSessionRuntime{}, false
	}
	if !runtimeNeedsCleanup(session.Runtime) || !runtimeEnsureChanged(session.Runtime, original) {
		return ACPSessionRuntime{}, false
	}
	if session.ReadOnlyReason != "" || session.LastRuntimeError != "" {
		return ACPSessionRuntime{}, false
	}
	return session.Runtime, true
}

func runtimeEnsureChanged(next, original ACPSessionRuntime) bool {
	return next.RuntimeID != original.RuntimeID ||
		next.OuterSandboxID != original.OuterSandboxID ||
		next.OuterSandboxDomain != original.OuterSandboxDomain ||
		next.OuterEnvdAccessToken != original.OuterEnvdAccessToken ||
		next.OuterTrafficToken != original.OuterTrafficToken ||
		next.DaemonAddr != original.DaemonAddr ||
		next.RemoteBinary != original.RemoteBinary ||
		next.InnerSandboxID != original.InnerSandboxID ||
		next.InnerSandboxDomain != original.InnerSandboxDomain ||
		next.InnerEnvdAccessToken != original.InnerEnvdAccessToken ||
		next.SessionProxyID != original.SessionProxyID ||
		next.WispLeaseID != original.WispLeaseID ||
		next.WispLeaseFence != original.WispLeaseFence ||
		!next.WispLeaseUntil.Equal(original.WispLeaseUntil) ||
		next.WorkspaceID != original.WorkspaceID ||
		next.WorkspaceRuntimeID != original.WorkspaceRuntimeID ||
		next.WorkspaceLeaseID != original.WorkspaceLeaseID ||
		next.WorkspaceFence != original.WorkspaceFence ||
		!next.WorkspaceLeaseUntil.Equal(original.WorkspaceLeaseUntil) ||
		next.WorkspaceAttachState != original.WorkspaceAttachState
}

func (g *ACPGateway) markPromptRuntimeUnavailable(sessionID string, generation int64, runtime ACPSessionRuntime, cause error) error {
	detail := ""
	if cause != nil {
		detail = cause.Error()
	}
	g.mu.Lock()
	if session, ok := g.sessions[sessionID]; ok && session.RuntimeGeneration == generation {
		session.State = acpRuntimeStateClosed
		session.Closed = true
		session.PromptRuns = nil
		session.CurrentResponseID = ""
		session.LastRuntimeError = detail
		session.ReadOnlyReason = acpReadOnlyRuntimeNotRecovered
		session.UpdatedAt = time.Now().UTC()
		g.persistSession(session)
	}
	g.mu.Unlock()
	fmt.Fprintf(os.Stderr, "timeline source=server event=acp_runtime_preflight_unavailable session_id=%s runtime_id=%s outer_sandbox_id=%s error=%s\n", sessionID, runtime.RuntimeID, runtime.OuterSandboxID, quoteServerField(detail))
	return acpRuntimeUnavailableError{
		SessionID:      sessionID,
		RuntimeID:      runtime.RuntimeID,
		OuterSandboxID: runtime.OuterSandboxID,
		Reason:         acpReadOnlyRuntimeNotRecovered,
		Detail:         detail,
	}
}
func runtimeNeedsCleanup(runtime ACPSessionRuntime) bool {
	return runtime.RuntimeID != "" || runtime.OuterSandboxID != "" || runtime.InnerSandboxID != "" || runtimeCanRecreate(runtime)
}
func runtimeCanRecreate(runtime ACPSessionRuntime) bool {
	return runtime.isWispOuterRuntime() &&
		runtime.RuntimeRecovery == runtimeRecoveryReattachOrRecreate &&
		strings.TrimSpace(runtime.WispSMHSpaceID) != ""
}
func sessionRuntimeStartRequest(session *acpSession) ACPSessionRuntimeStartRequest {
	runtime := session.Runtime
	return ACPSessionRuntimeStartRequest{
		SessionID:        session.SessionID,
		Scope:            session.Scope,
		CWD:              sidecarRequestCWD(),
		Generation:       session.RuntimeGeneration,
		SandboxBackend:   runtime.SandboxBackend,
		OuterRuntime:     runtime.OuterRuntime,
		RuntimeRecovery:  runtime.RuntimeRecovery,
		AgentVersion:     runtime.AgentVersion,
		SidecarArtifact:  runtimeSidecarArtifact(runtime),
		WorkspaceVersion: runtime.WorkspaceVersion,
	}
}
func runtimeSidecarArtifact(runtime ACPSessionRuntime) agentSidecarArtifact {
	return agentSidecarArtifact{
		URL:          runtime.SidecarURL,
		SHA256:       runtime.SidecarSHA256,
		SigURL:       runtime.SidecarSigURL,
		SigningKeyID: runtime.SigningKeyID,
	}
}
func runtimeAfterClose(runtime ACPSessionRuntime) ACPSessionRuntime {
	if !runtimeCanRecreate(runtime) {
		return ACPSessionRuntime{}
	}
	runtime.RuntimeID = ""
	runtime.OuterSandboxID = ""
	runtime.OuterSandboxDomain = ""
	runtime.OuterEnvdAccessToken = ""
	runtime.OuterTrafficToken = ""
	runtime.InnerSandboxID = ""
	runtime.InnerSandboxDomain = ""
	runtime.InnerEnvdAccessToken = ""
	runtime.SessionProxyID = ""
	runtime.WispLeaseID = ""
	runtime.WispLeaseFence = 0
	runtime.WispLeaseUntil = time.Time{}
	runtime.WorkspaceRuntimeID = ""
	runtime.WorkspaceLeaseID = ""
	runtime.WorkspaceFence = 0
	runtime.WorkspaceLeaseUntil = time.Time{}
	runtime.WorkspaceAttachState = ""
	return runtime
}
func isRecoverablePromptRuntimeError(err error) bool {
	if err == nil {
		return false
	}
	message := strings.ToLower(err.Error())
	if strings.Contains(message, "ags http 404") ||
		strings.Contains(message, "http 404") && strings.Contains(message, "requested resource does not exist") {
		return true
	}
	if strings.Contains(message, "unexpected client argument") && strings.Contains(message, "session-input") {
		return true
	}
	return strings.Contains(message, "ags http 401") &&
		strings.Contains(message, "op=run_command") &&
		strings.Contains(message, "authentication_failed")
}
func (g *ACPGateway) cleanupSessionRuntime(scope Scope, sessionID, reason string) (ACPSessionRuntime, int64, bool, error) {
	session, err := g.getSession(scope, sessionID)
	if err != nil {
		return ACPSessionRuntime{}, 0, false, err
	}
	runID := "cleanup_" + randomHex(12)
	ownership, err := g.acquireRuntimeOwnershipWithOptions(context.Background(), sessionID, session.RuntimeGeneration, runID, "cleanup:"+reason, true)
	if err != nil {
		return ACPSessionRuntime{}, 0, false, err
	}
	stopOwnershipHeartbeat := g.startRuntimeOwnershipHeartbeat(context.Background(), ownership, nil)
	defer stopOwnershipHeartbeat()
	defer g.releaseRuntimeOwnership(ownership)
	cleanup, owner, ok, err := g.beginRuntimeCleanup(scope, sessionID, reason)
	if err != nil || !ok {
		return ACPSessionRuntime{}, 0, false, err
	}
	if !owner {
		<-cleanup.Done
		return cleanup.Runtime, cleanup.Generation, true, cleanup.Err
	}

	runtime := cleanup.Runtime
	fmt.Fprintf(os.Stderr, "timeline source=server event=acp_runtime_cleanup_start reason=%s session_id=%s outer_sandbox_id=%s inner_sandbox_id=%s\n", reason, sessionID, runtime.OuterSandboxID, runtime.InnerSandboxID)
	cleanupStartedAt := time.Now().UTC()
	g.broadcastWorkspaceLifecycle(scope, sessionID, cleanup.Generation, "storage", "cleanup", "running", "正在贮藏 Workspace", cleanupStartedAt, map[string]any{
		"reason":           reason,
		"runtime_id":       runtime.RuntimeID,
		"outer_sandbox_id": runtime.OuterSandboxID,
	})
	cleanupCtx, cancel := context.WithTimeout(context.Background(), envDurationSeconds("GATEWAY_ACP_RUNTIME_CLEANUP_TIMEOUT_SECONDS", 60*time.Second))
	var cleanupErr error
	if reason == "deleted" {
		cleanupErr = g.runtimeManager.DeleteSessionRuntime(cleanupCtx, runtime)
	} else {
		cleanupErr = g.runtimeManager.CloseSessionRuntime(cleanupCtx, runtime)
	}
	cancel()
	if cleanupErr != nil {
		fmt.Fprintf(os.Stderr, "timeline source=server event=acp_runtime_cleanup_failed reason=%s session_id=%s error=%s\n", reason, sessionID, quoteServerField(cleanupErr.Error()))
		g.broadcastWorkspaceLifecycle(scope, sessionID, cleanup.Generation, "storage", "cleanup", "failed", "Workspace 贮藏失败", cleanupStartedAt, map[string]any{
			"reason": reason,
			"error":  cleanupErr.Error(),
		})
		g.completeRuntimeCleanup(sessionID, cleanup, cleanupErr)
		return runtime, cleanup.Generation, true, cleanupErr
	}
	g.completeRuntimeCleanup(sessionID, cleanup, nil)
	fmt.Fprintf(os.Stderr, "timeline source=server event=acp_runtime_cleanup_done reason=%s session_id=%s outer_sandbox_id=%s inner_sandbox_id=%s\n", reason, sessionID, runtime.OuterSandboxID, runtime.InnerSandboxID)
	g.broadcastWorkspaceLifecycle(scope, sessionID, cleanup.Generation, "storage", "cleanup", "done", "Workspace 已贮藏", cleanupStartedAt, map[string]any{
		"reason":           reason,
		"runtime_id":       runtime.RuntimeID,
		"outer_sandbox_id": runtime.OuterSandboxID,
	})
	return runtime, cleanup.Generation, true, nil
}
func (g *ACPGateway) beginRuntimeCleanup(scope Scope, sessionID, reason string) (*acpRuntimeCleanup, bool, bool, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	session, ok := g.sessions[sessionID]
	if !ok {
		return nil, false, false, fmt.Errorf("session not found")
	}
	if !sameScope(scope, session.Scope) {
		return nil, false, false, fmt.Errorf("session is outside caller scope")
	}
	if g.cleanups == nil {
		g.cleanups = map[string]*acpRuntimeCleanup{}
	}
	if cleanup := g.cleanups[sessionID]; cleanup != nil {
		return cleanup, false, true, nil
	}
	for _, run := range session.PromptRuns {
		run.interrupt(reason)
		if run.HistoryLenBefore <= len(session.History) {
			session.History = session.History[:run.HistoryLenBefore]
		}
	}
	runtime := session.Runtime
	g.markStaleRuntimeProxyLocked(runtime)
	session.RuntimeGeneration++
	session.PromptRuns = nil
	session.CurrentResponseID = ""
	session.Closed = true
	session.UpdatedAt = time.Now().UTC()
	if !runtimeNeedsCleanup(runtime) {
		session.Runtime = ACPSessionRuntime{}
		session.State = acpRuntimeStateClosed
		session.LastRuntimeError = ""
		session.ReadOnlyReason = ""
		g.persistSession(session)
		if g.store != nil {
			_ = g.store.ClearACPRuntimeTokens(sessionID)
		}
		return nil, false, false, nil
	}
	session.State = acpRuntimeStateClosing
	g.persistSession(session)
	cleanup := &acpRuntimeCleanup{
		Runtime:    runtime,
		Generation: session.RuntimeGeneration,
		Reason:     reason,
		Done:       make(chan struct{}),
	}
	g.cleanups[sessionID] = cleanup
	return cleanup, true, true, nil
}
func (g *ACPGateway) completeRuntimeCleanup(sessionID string, cleanup *acpRuntimeCleanup, err error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if current := g.cleanups[sessionID]; current == cleanup {
		delete(g.cleanups, sessionID)
	}
	if session, ok := g.sessions[sessionID]; ok && session.RuntimeGeneration == cleanup.Generation {
		session.State = acpRuntimeStateClosed
		session.Closed = true
		session.UpdatedAt = time.Now().UTC()
		if err != nil {
			session.LastRuntimeError = err.Error()
			if cleanup.Reason == "closed" && runtimeCanRecreate(cleanup.Runtime) {
				session.Runtime = runtimeAfterClose(cleanup.Runtime)
				session.RuntimeVerified = false
				session.ReadOnlyReason = ""
			}
		} else {
			session.Runtime = runtimeAfterClose(cleanup.Runtime)
			session.RuntimeVerified = false
			session.LastRuntimeError = ""
			session.ReadOnlyReason = ""
		}
		g.persistSession(session)
		if g.store != nil && err == nil {
			_ = g.store.ClearACPRuntimeTokens(sessionID)
		}
	}
	cleanup.Err = err
	close(cleanup.Done)
}
