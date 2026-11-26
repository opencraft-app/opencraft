/** Operation effects are not execution provenance or installed configuration.
 * Trusted ingress still owns Thread/Actor authorization for every request. */
export type ExecutionRequestEffect =
  | "none" | "admit-input" | "queued-intent" | "thread-control"
  | "active-turn-input" | "configured-execution";

export function executionRequestEffect(method: string): ExecutionRequestEffect {
  // The collaboration receipt is a read-only projection of an already
  // admitted request.  It must remain available while the target account is
  // bound to a different execution environment; treating the queue
  // namespace as a write here makes the internal handoff unable to observe
  // its own durable request.
  if (method === "thread/queue/collaborationReceipt") return "none";
  if (["turn/start", "thread/queue/add", "thread/queue/start"].includes(method)) return "admit-input";
  if (["turn/steer", "thread/queue/steer"].includes(method)) return "active-turn-input";
  // Native Goal intent and stop do not acquire the editor's personal ENV.
  // Goal activation can continue native work; it is NOT classified read-only.
  if (["thread/goal/set", "thread/goal/clear", "turn/interrupt"].includes(method)) return "thread-control";
  if (method.startsWith("thread/queue/") && method !== "thread/queue/list") return "queued-intent";
  // Unknown execution methods stay conservative, never inherit control rights.
  if (method.startsWith("turn/") || method.startsWith("thread/realtime/")
    || method.startsWith("thread/backgroundTerminals/") && method !== "thread/backgroundTerminals/list"
    || ["thread/shellCommand", "thread/settings/update", "thread/compact/start",
      "thread/approveGuardianDeniedAction", "review/start"].includes(method)) return "configured-execution";
  return "none";
}
export function requiresEnvironmentAuthority(method: string, collaborationRequestId?: string): boolean {
  // The collaboration service already authorized a cancellation of this request.
  // The Host must still match the exact queued input to the trusted request ID.
  if (method === "thread/queue/delete" && collaborationRequestId) return false;
  return executionRequestEffect(method) !== "none";
}
export const requiresCurrentEnvironmentAuthority = (method: string, _params?: unknown): boolean => executionRequestEffect(method) === "configured-execution";
