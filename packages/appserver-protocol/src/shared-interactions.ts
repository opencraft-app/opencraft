import type { JsonRpcId } from "./json-rpc";

export const SHARED_INTERACTIONS_EXTENSION = "opencraft/shared-interactions";
export const SHARED_INTERACTIONS_CHANGED = "opencraft/interactions/changed";
export const SHARED_INTERACTIONS_READ = "opencraft/interactions/read";
export const SHARED_INTERACTIONS_RESPOND = "opencraft/interactions/respond";

export type InteractionResponseState = "pending" | "responding" | "unconfirmed";
export interface SharedInteraction {
  readonly id: string;
  readonly method: string;
  readonly params: Record<string, unknown>;
  readonly state: InteractionResponseState;
  /** Source route availability, independent of subscriber access and response state. */
  readonly canRespond?: boolean;
  readonly receivedAtMs: number;
}
export interface SharedInteractionSnapshot {
  readonly threadId: string;
  readonly epoch: string;
  readonly revision: number;
  readonly canRespond: boolean;
  readonly requests: readonly SharedInteraction[];
}
export interface SharedInteractionMethodMap {
  "opencraft/interactions/read": {
    params: { threadId: string };
    result: SharedInteractionSnapshot;
  };
  "opencraft/interactions/respond": {
    params: { threadId: string; interactionId: string; submissionId: string; result: Record<string, unknown> };
    result: { disposition: "submitted" | "already-submitted" | "resolved"; snapshot: SharedInteractionSnapshot };
  };
}
export interface InteractionSourceRequest {
  readonly id: JsonRpcId;
  readonly method: string;
  readonly params: Record<string, unknown>;
  /** Stable only for this producer's native request lifetime, never a grant. */
  readonly __opencraftInteractionKey?: string;
  readonly __opencraftInteractionState?: InteractionResponseState;
}

/** Shared human state must never dispatch an ordinary executable tool twice. */
export function isHumanInteraction(method: unknown, params: unknown): boolean {
  if (typeof method !== "string") return false;
  if (["item/commandExecution/requestApproval", "item/fileChange/requestApproval",
    "item/permissions/requestApproval", "item/tool/requestUserInput",
    "mcpServer/elicitation/request", "item/tool/requestOptionPicker",
    "item/tool/requestSetupCodexContextPicker"].includes(method)) return true;
  if (method !== "item/tool/call" || typeof params !== "object" || params === null) return false;
  const p = params as Record<string, unknown>;
  if (p.namespace !== undefined && p.namespace !== null && p.namespace !== "") return false;
  if (["request_onboarding_input", "request_option_picker", "setup_codex_context_picker"].includes(String(p.tool))) return true;
  const args = p.arguments as { step?: unknown } | null;
  return p.tool === "setup_codex_step" && ["role", "task", "context"].includes(String(args?.step));
}

/** Incoming wire boundary; callers still check their connection/scope epoch. */
export function parseSharedInteractionSnapshot(value: unknown): SharedInteractionSnapshot | null {
  if (typeof value !== "object" || value === null) return null;
  const s = value as Record<string, unknown>;
  if (typeof s.threadId !== "string" || !s.threadId || typeof s.epoch !== "string" || !s.epoch
    || !Number.isSafeInteger(s.revision) || Number(s.revision) < 0 || typeof s.canRespond !== "boolean"
    || !Array.isArray(s.requests) || s.requests.length > 256) return null;
  const seen = new Set<string>();
  for (const r of s.requests) {
    if (typeof r !== "object" || r === null || typeof r.id !== "string" || !r.id || seen.has(r.id)
      || typeof r.method !== "string" || typeof r.params !== "object" || r.params === null || Array.isArray(r.params)
      || r.params.threadId !== s.threadId || !isHumanInteraction(r.method, r.params)
      || (r.canRespond !== undefined && typeof r.canRespond !== "boolean")
      || !["pending", "responding", "unconfirmed"].includes(r.state) || !Number.isFinite(r.receivedAtMs)) return null;
    seen.add(r.id);
  }
  return s as unknown as SharedInteractionSnapshot;
}

/** Only explicit native flags establish a human wait; silence cannot. */
export function humanInteractionWaitReason(status: unknown): "approval" | "input" | null {
  if (typeof status !== "object" || status === null) return null;
  const value = status as Record<string, unknown>;
  if (value.type !== "active" || !Array.isArray(value.activeFlags)) return null;
  return value.activeFlags.includes("waitingOnApproval") ? "approval"
    : value.activeFlags.includes("waitingOnUserInput") ? "input" : null;
}
