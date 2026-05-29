package wrapper

const (
	acpLifecycleStarting               = "starting"
	acpLifecycleRestoring              = "restoring"
	acpLifecycleStoring                = "storing"
	acpLifecyclePrompting              = "prompting"
	acpLifecycleLive                   = "live"
	acpLifecycleDetached               = "detached"
	acpLifecycleStoredRestorable       = "stored_restorable"
	acpLifecycleRestoreFailedRetryable = "restore_failed_retryable"
	acpLifecycleBlockedTerminal        = "blocked_terminal"
	acpLifecycleFailed                 = "failed"
	acpLifecycleClosed                 = "closed"

	acpRecoverabilityLive       = "live"
	acpRecoverabilityRestorable = "restorable"
	acpRecoverabilityRetryable  = "retryable"
	acpRecoverabilityTerminal   = "terminal"
	acpRecoverabilityUnknown    = "unknown"
)

type acpSessionLifecycleContract struct {
	LifecycleState     string
	Recoverability     string
	RecoverabilityNote string
}

func sessionLifecycleContract(session *acpSession, restoreInFlight, cleanupPending, runtimeRestorable bool) acpSessionLifecycleContract {
	if session == nil {
		return acpSessionLifecycleContract{
			LifecycleState:     acpLifecycleBlockedTerminal,
			Recoverability:     acpRecoverabilityTerminal,
			RecoverabilityNote: "session_missing",
		}
	}
	runtime := session.Runtime
	if restoreInFlight {
		return acpSessionLifecycleContract{
			LifecycleState:     acpLifecycleRestoring,
			Recoverability:     recoverabilityForRuntime(runtime, session, runtimeRestorable),
			RecoverabilityNote: "runtime_restore_in_flight",
		}
	}
	if cleanupPending || session.State == acpRuntimeStateClosing {
		return acpSessionLifecycleContract{
			LifecycleState:     acpLifecycleStoring,
			Recoverability:     recoverabilityForRuntime(runtime, session, runtimeRestorable),
			RecoverabilityNote: "runtime_cleanup_in_flight",
		}
	}
	if sessionHasPromptRuns(session) {
		return acpSessionLifecycleContract{
			LifecycleState:     acpLifecyclePrompting,
			Recoverability:     acpRecoverabilityLive,
			RecoverabilityNote: "active_prompt_run",
		}
	}
	if session.ReadOnlyReason != "" && !runtimeRestorable {
		return acpSessionLifecycleContract{
			LifecycleState:     acpLifecycleBlockedTerminal,
			Recoverability:     acpRecoverabilityTerminal,
			RecoverabilityNote: session.ReadOnlyReason,
		}
	}
	if session.Closed {
		if runtimeRestorable {
			if session.LastRuntimeError != "" || session.ReadOnlyReason != "" {
				return acpSessionLifecycleContract{
					LifecycleState:     acpLifecycleRestoreFailedRetryable,
					Recoverability:     acpRecoverabilityRetryable,
					RecoverabilityNote: firstNonEmpty(session.ReadOnlyReason, session.LastRuntimeError, "restore_failed_retryable"),
				}
			}
			return acpSessionLifecycleContract{
				LifecycleState:     acpLifecycleStoredRestorable,
				Recoverability:     acpRecoverabilityRestorable,
				RecoverabilityNote: "workspace_persistent",
			}
		}
		return acpSessionLifecycleContract{
			LifecycleState:     acpLifecycleBlockedTerminal,
			Recoverability:     acpRecoverabilityTerminal,
			RecoverabilityNote: firstNonEmpty(session.ReadOnlyReason, session.LastRuntimeError, "runtime_not_restorable"),
		}
	}
	if session.State == acpRuntimeStateStarting {
		return acpSessionLifecycleContract{
			LifecycleState:     acpLifecycleStarting,
			Recoverability:     recoverabilityForRuntime(runtime, session, runtimeRestorable),
			RecoverabilityNote: "runtime_starting",
		}
	}
	if session.State == acpRuntimeStateFailed {
		recoverability := recoverabilityForRuntime(runtime, session, runtimeRestorable)
		state := acpLifecycleFailed
		if recoverability == acpRecoverabilityRetryable {
			state = acpLifecycleRestoreFailedRetryable
		}
		if recoverability == acpRecoverabilityTerminal {
			state = acpLifecycleBlockedTerminal
		}
		return acpSessionLifecycleContract{
			LifecycleState:     state,
			Recoverability:     recoverability,
			RecoverabilityNote: firstNonEmpty(session.LastRuntimeError, "runtime_failed"),
		}
	}
	if session.State == acpRuntimeStateReady && runtimeNeedsCleanup(runtime) {
		if !session.RuntimeVerified {
			return acpSessionLifecycleContract{
				LifecycleState:     acpLifecycleDetached,
				Recoverability:     recoverabilityForRuntime(runtime, session, runtimeRestorable),
				RecoverabilityNote: "runtime_identity_unverified",
			}
		}
		return acpSessionLifecycleContract{
			LifecycleState:     acpLifecycleLive,
			Recoverability:     acpRecoverabilityLive,
			RecoverabilityNote: "runtime_attached",
		}
	}
	return acpSessionLifecycleContract{
		LifecycleState:     firstNonEmpty(string(session.State), acpLifecycleClosed),
		Recoverability:     recoverabilityForRuntime(runtime, session, runtimeRestorable),
		RecoverabilityNote: firstNonEmpty(session.LastRuntimeError, "runtime_state_projection"),
	}
}

func recoverabilityForRuntime(runtime ACPSessionRuntime, session *acpSession, runtimeRestorable bool) string {
	if session != nil && !session.Closed && session.ReadOnlyReason == "" && runtimeNeedsCleanup(runtime) {
		return acpRecoverabilityLive
	}
	if runtimeRestorable {
		if session != nil && (session.LastRuntimeError != "" || session.ReadOnlyReason != "") {
			return acpRecoverabilityRetryable
		}
		return acpRecoverabilityRestorable
	}
	if runtimeNeedsCleanup(runtime) {
		return acpRecoverabilityUnknown
	}
	return acpRecoverabilityTerminal
}
