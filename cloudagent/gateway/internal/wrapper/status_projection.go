package wrapper

import (
	"context"
	"fmt"
	"os"
	"strings"
	"time"
)

func acpFaultInjectionEnabled() bool {
	return envFlagEnabled("GATEWAY_ACP_FAULT_INJECTION") || envFlagEnabled("CLOUDAGENT_ACP_E2E_FAULT_INJECTION")
}
func (g *ACPGateway) cloudAgentSessionStatus(scope Scope, sessionID string) (map[string]any, error) {
	if strings.TrimSpace(sessionID) == "" {
		return nil, fmt.Errorf("session_id is required")
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
	g.ensureRuntimeProxyIDLocked(session)
	statusSession := *session
	if len(session.PromptRuns) > 0 {
		statusSession.PromptRuns = make(map[string]*acpPromptRun, len(session.PromptRuns))
		for jobID, run := range session.PromptRuns {
			statusSession.PromptRuns[jobID] = run
		}
	}
	cleanupPending := g.cleanups[sessionID] != nil
	messageCount := len(session.History)
	eventCount := len(session.Events)
	restoreInFlight := false
	restoreStartedAt := time.Time{}
	if call := g.runtimeEnsures[runtimeEnsureKey(sessionID, session.RuntimeGeneration)]; call != nil {
		restoreInFlight = true
		restoreStartedAt = call.startedAt
	}
	g.persistSession(session)
	g.mu.Unlock()

	recovery := g.runtimeRecoverySnapshot(context.Background(), statusSession.SessionID, statusSession.Runtime)
	statusSession.Runtime = recovery.Runtime
	runtime := statusSession.Runtime
	runtimeSnapshot, hasRuntimeSnapshot, runtimeSnapshotErr := g.sessionRuntimeStatusSnapshot(statusSession.SessionID, runtime, statusSession.Closed)
	if hasRuntimeSnapshot {
		statusSession.RuntimeVerified = true
		g.mu.Lock()
		if current, ok := g.sessions[sessionID]; ok && current.RuntimeGeneration == statusSession.RuntimeGeneration {
			current.RuntimeVerified = true
		}
		g.mu.Unlock()
	}
	runtimeStatusValue := runtimeStatusWithRestorable(&statusSession, recovery.Restorable)
	if hasRuntimeSnapshot && strings.TrimSpace(runtimeSnapshot.Status) != "" {
		runtimeStatusValue = runtimeSnapshot.Status
	}
	runtimeStatusSource := "gateway_projection"
	if hasRuntimeSnapshot {
		runtimeStatusSource = "runtime"
	}
	readOnly, readOnlyReason := acpSessionReadOnlyStateWithRestorable(&statusSession, recovery.Restorable)
	lifecycle := sessionLifecycleContract(&statusSession, restoreInFlight, cleanupPending, recovery.Restorable)
	backend := runtime.SandboxBackend
	if backend == "" && runtimeNeedsCleanup(runtime) {
		backend = "ags"
	}
	status := map[string]any{
		"session_id":                 statusSession.SessionID,
		"state":                      string(statusSession.State),
		"lifecycle_state":            lifecycle.LifecycleState,
		"recoverability":             lifecycle.Recoverability,
		"recoverability_note":        lifecycle.RecoverabilityNote,
		"closed":                     statusSession.Closed,
		"read_only":                  readOnly,
		"read_only_reason":           readOnlyReason,
		"runtime_restorable":         recovery.Restorable,
		"workspace_persistent":       recovery.WorkspacePersistent || (runtime.isWispOuterRuntime() && strings.TrimSpace(runtime.WispSMHSpaceID) != ""),
		"workspace_id":               recovery.WorkspaceID,
		"workspace_note":             recovery.WorkspaceNote,
		"runtime_status":             runtimeStatusValue,
		"runtime_status_source":      runtimeStatusSource,
		"runtime_status_error":       runtimeSnapshotErr,
		"runtime_store_load":         runtimeSnapshot.RuntimeStoreLoad,
		"active_run_id":              runtimeSnapshot.ActiveRunID,
		"pending_run_count":          runtimeSnapshot.PendingRunCount,
		"pending_by_mode":            runtimeSnapshot.PendingByMode,
		"run_count":                  runtimeSnapshot.RunCount,
		"transcript_count":           runtimeSnapshot.TranscriptCount,
		"last_user_hash":             runtimeSnapshot.LastUserHash,
		"last_assistant_hash":        runtimeSnapshot.LastAssistantHash,
		"last_run_status":            runtimeSnapshot.LastRunStatus,
		"run_ledger_tail":            runtimeSnapshot.RunLedgerTail,
		"cwd":                        statusSession.CWD,
		"model":                      statusSession.Model,
		"current_response_id":        statusSession.CurrentResponseID,
		"prompt_in_flight":           sessionHasPromptRuns(&statusSession),
		"runtime_restore_in_flight":  restoreInFlight,
		"runtime_restore_started_at": formatOptionalTime(restoreStartedAt),
		"runtime_restore_elapsed_ms": elapsedMillis(restoreStartedAt),
		"runtime_generation":         statusSession.RuntimeGeneration,
		"session_proxy_id":           runtime.SessionProxyID,
		"envd_proxy_domain":          envdProxyDomain(),
		"cleanup_pending":            cleanupPending,
		"last_runtime_error":         statusSession.LastRuntimeError,
		"created_at":                 statusSession.CreatedAt.Format(time.RFC3339Nano),
		"updated_at":                 statusSession.UpdatedAt.Format(time.RFC3339Nano),
		"message_count":              messageCount,
		"event_count":                eventCount,
		"sandbox": map[string]any{
			"backend":                     backend,
			"outer_runtime":               runtime.OuterRuntime,
			"runtime_recovery":            runtime.RuntimeRecovery,
			"agent_version":               runtime.AgentVersion,
			"agent_template_id":           runtime.AgentTemplateID,
			"workspace_version":           runtime.WorkspaceVersion,
			"workspace_template_id":       runtime.WorkspaceTemplateID,
			"runtime_id":                  runtime.RuntimeID,
			"outer_sandbox_id":            runtime.OuterSandboxID,
			"outer_sandbox_domain":        runtime.OuterSandboxDomain,
			"daemon_addr":                 runtime.DaemonAddr,
			"remote_binary":               runtime.RemoteBinary,
			"has_outer_envd_access_token": runtime.OuterEnvdAccessToken != "",
			"has_outer_traffic_token":     runtime.OuterTrafficToken != "",
			"has_inner_envd_target":       runtime.hasInnerEnvdTarget(),
			"wisp_name":                   runtime.WispName,
			"wisp_workspace_id":           runtime.WispWorkspaceID,
			"wisp_smh_space_id":           runtime.WispSMHSpaceID,
			"wisp_package_url":            runtime.WispPackageURL,
			"wisp_jfs_prefix":             runtime.WispJFSPrefix,
			"wisp_root_upper_size":        runtime.WispRootUpperSize,
			"has_workspace_lease":         runtime.WispLeaseID != "",
			"workspace_lease_fence":       runtime.WispLeaseFence,
			"workspace_lease_until":       formatOptionalTime(runtime.WispLeaseUntil),
		},
	}
	g.persistSession(session)
	return status, nil
}
func (g *ACPGateway) killRuntimeForFaultInjection(ctx context.Context, scope Scope, sessionID, target string) (map[string]any, error) {
	if !acpFaultInjectionEnabled() {
		return nil, fmt.Errorf("cloudagent runtime fault injection is disabled")
	}
	if strings.TrimSpace(sessionID) == "" {
		return nil, fmt.Errorf("session_id is required")
	}
	injector, ok := g.runtimeManager.(ACPSessionRuntimeFaultInjector)
	if !ok {
		return nil, fmt.Errorf("runtime manager does not support fault injection")
	}
	g.mu.Lock()
	session, ok := g.sessions[sessionID]
	if !ok {
		g.mu.Unlock()
		return nil, fmt.Errorf("session not found")
	}
	if !sameScope(scope, session.Scope) {
		g.mu.Unlock()
		return nil, fmt.Errorf("session is outside caller scope")
	}
	runtime := session.Runtime
	g.mu.Unlock()
	if runtime.OuterSandboxID == "" || runtime.RemoteBinary == "" || runtime.DaemonAddr == "" {
		return nil, fmt.Errorf("runtime identity is missing")
	}
	var err error
	fmt.Fprintf(os.Stderr, "timeline source=server event=acp_runtime_fault_kill_%s_start session_id=%s outer_sandbox_id=%s\n", target, sessionID, runtime.OuterSandboxID)
	switch target {
	case "daemon":
		err = injector.KillSessionRuntimeDaemon(ctx, runtime)
	case "outer":
		err = injector.KillSessionRuntimeOuter(ctx, runtime)
	case "inner":
		err = injector.KillSessionRuntimeInner(ctx, runtime)
	default:
		return nil, fmt.Errorf("unsupported runtime fault target %q", target)
	}
	if err != nil {
		fmt.Fprintf(os.Stderr, "timeline source=server event=acp_runtime_fault_kill_%s_failed session_id=%s outer_sandbox_id=%s error=%s\n", target, sessionID, runtime.OuterSandboxID, quoteServerField(err.Error()))
		return nil, err
	}
	fmt.Fprintf(os.Stderr, "timeline source=server event=acp_runtime_fault_kill_%s_done session_id=%s outer_sandbox_id=%s\n", target, sessionID, runtime.OuterSandboxID)
	return map[string]any{
		"ok":               true,
		"target":           target,
		"session_id":       sessionID,
		"outer_sandbox_id": runtime.OuterSandboxID,
	}, nil
}
func (g *ACPGateway) sessionRuntimeStatusSnapshot(sessionID string, runtime ACPSessionRuntime, closed bool) (ACPSessionRuntimeStatusSnapshot, bool, string) {
	if strings.TrimSpace(sessionID) == "" || !runtimeNeedsCleanup(runtime) || closed {
		return ACPSessionRuntimeStatusSnapshot{}, false, ""
	}
	statusCtx, cancel := context.WithTimeout(
		context.Background(),
		envDurationSeconds("GATEWAY_ACP_RUNTIME_STATUS_TIMEOUT_SECONDS", 15*time.Second),
	)
	status, err := g.runtimeManager.SessionRuntimeStatus(statusCtx, runtime, sessionID)
	cancel()
	if err != nil {
		return ACPSessionRuntimeStatusSnapshot{}, false, err.Error()
	}
	return status, true, ""
}
func runtimeStatus(session *acpSession) string {
	return runtimeStatusWithRestorable(session, session != nil && runtimeCanRecreate(session.Runtime))
}

func runtimeStatusWithRestorable(session *acpSession, runtimeRestorable bool) string {
	if session == nil {
		return "unknown"
	}
	if sessionHasPromptRuns(session) {
		return "prompting"
	}
	if session.Closed && runtimeRestorable {
		return "closed_restorable"
	}
	if session.ReadOnlyReason != "" {
		return "unavailable"
	}
	if session.State == acpRuntimeStateReady && runtimeNeedsCleanup(session.Runtime) {
		return "attached"
	}
	return string(session.State)
}
func formatOptionalTime(value time.Time) string {
	if value.IsZero() {
		return ""
	}
	return value.UTC().Format(time.RFC3339Nano)
}
