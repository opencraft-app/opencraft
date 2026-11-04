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
    params: { threadId: string } & (StructuredInteractionSubmission | { interactionId: string; submissionId: string; result: Record<string, unknown> });
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

/** Narrow external-human intent. Never an arbitrary Native RPC result. */
export type StructuredInteractionResponse =
  | { decision: "accept" | "acceptForSession" | "decline" | "cancel" }
  | { answers: Record<string, { answers: string[] }> };
export interface StructuredInteractionSubmission {
  interactionId: string; submissionId: string; expectedEpoch: string; expectedRevision: number;
  response: StructuredInteractionResponse;
}
export interface InteractionAction { decision: string; scope: "once" | "session" | "deny" | "cancel" }
export interface InteractionPrompt {
  id: string; method: string; state: InteractionResponseState; canRespond: boolean;
  supported: boolean; actions: InteractionAction[];
  prompt: Record<string, unknown> | null;
}
/** Method schema authority shared by projection and admission. Unknown actions stay absent. */
export function projectStructuredInteraction(request: SharedInteraction): InteractionPrompt {
  const p = request.params;
  let prompt: Record<string, unknown> | null = null;
  let actions: InteractionAction[] = [];
  if (["item/commandExecution/requestApproval", "item/fileChange/requestApproval"].includes(request.method)) {
    actions = [{decision:"accept",scope:"once"},{decision:"decline",scope:"deny"},{decision:"cancel",scope:"cancel"}];
    if (request.method === "item/commandExecution/requestApproval" && Array.isArray(p.availableDecisions)) {
      actions = actions.filter(a => (p.availableDecisions as unknown[]).includes(a.decision));
      if (p.availableDecisions.includes("acceptForSession")) actions.push({decision:"acceptForSession",scope:"session"});
    }
    prompt = Object.fromEntries(["turnId","itemId","command","cwd","reason","grantRoot"].filter(k => typeof p[k] === "string").map(k => [k,p[k]]));
    if (request.method === "item/commandExecution/requestApproval") for (const key of ["additionalPermissions","networkApprovalContext","commandActions"]) {
      if (p[key] !== undefined && p[key] !== null && typeof p[key] === "object") prompt[key] = p[key];
    }
  } else if (request.method === "item/tool/requestUserInput" && Array.isArray(p.questions) && p.questions.length <= 16
    && p.questions.every(q => q && typeof q.id === "string" && typeof q.question === "string" && typeof q.header === "string" && q.id.length>0 && q.id.length<=512
      && (q.options === null || Array.isArray(q.options) && q.options.length<=32 && q.options.every((o: unknown) => !!o && typeof o === "object" && typeof (o as Record<string,unknown>).label === "string" && typeof (o as Record<string,unknown>).description === "string")))
    && new Set(p.questions.map(q => q.id)).size === p.questions.length) {
    prompt = {questions:p.questions.map(q => ({id:q.id,header:q.header,question:q.question,isOther:q.isOther === true,isSecret:q.isSecret === true,
      options:Array.isArray(q.options) ? q.options.map((o: Record<string, unknown>) => ({label:o.label,description:o.description})) : null}))};
  }
  if (prompt && (JSON.stringify(prompt).length > 24000 || request.method !== "item/tool/requestUserInput" && actions.length === 0)) { prompt = null; actions = []; }
  return {id:request.id,method:request.method,state:request.state,canRespond:prompt !== null && request.canRespond !== false && request.state === "pending",
    supported:prompt !== null,actions,prompt};
}
export function structuredInteractionResult(request: SharedInteraction, value: unknown): Record<string, unknown> {
  const projection = projectStructuredInteraction(request);
  const invalid = () => { throw new Error("Invalid or unsupported structured interaction response"); };
  if (!projection.supported || !value || typeof value !== "object" || Array.isArray(value) || JSON.stringify(value).length > 24000) return invalid();
  const response = value as Record<string, unknown>;
  if (projection.actions.length) {
    if (Object.keys(response).length !== 1 || !projection.actions.some(a => a.decision === response.decision)) return invalid();
    return {decision:response.decision};
  }
  if (request.method !== "item/tool/requestUserInput" || Object.keys(response).length !== 1 || !response.answers || typeof response.answers !== "object" || Array.isArray(response.answers)) return invalid();
  const answers = response.answers as Record<string, unknown>;
  const questions = request.params.questions as {id:string;isOther?:boolean;options?:{label:string}[]|null}[];
  if (Object.keys(answers).length !== questions.length) return invalid();
  for (const q of questions) {
    const answer = answers[q.id] as {answers?:unknown} | undefined;
    if (!Object.hasOwn(answers,q.id) || !answer || typeof answer !== "object" || Array.isArray(answer) || Object.keys(answer).length !== 1 || !Array.isArray(answer.answers)
      || answer.answers.length > 16 || !answer.answers.every(a => typeof a === "string" && a.length <= 4000
        && (!q.options?.length || q.isOther === true || q.options.some(o => o.label === a)))) return invalid();
  }
  return {answers};
}
