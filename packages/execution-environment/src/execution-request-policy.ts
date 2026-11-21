/** Operation effects are not execution provenance or installed configuration.
 * Trusted ingress still owns Thread/Actor authorization for every request. */
export type ExecutionRequestEffect =
  | "none" | "admit-input" | "queued-intent" | "thread-control"
  | "active-turn-input" | "configured-execution";

export function executionRequestEffect(method: string): ExecutionRequestEffect {
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
export const requiresEnvironmentAuthority = (method: string): boolean => executionRequestEffect(method) !== "none";
export const requiresCurrentEnvironmentAuthority = (method: string, _params?: unknown): boolean => executionRequestEffect(method) === "configured-execution";
