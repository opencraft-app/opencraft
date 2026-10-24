import { tokenInteger } from "./token-usage-allocation.js";
import { normalizeUsageCounts, type UsageSource, type UsageCounts } from "./token-usage-ledger.js";

const fields = {
  totalTokens: "total_tokens", inputTokens: "input_tokens", cachedInputTokens: "cached_input_tokens",
  cacheWriteInputTokens: "cache_write_input_tokens", outputTokens: "output_tokens", reasoningOutputTokens: "reasoning_output_tokens",
} as const;
function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function id(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 1024 ? value : null;
}
export type NativeUsageFact = { readonly kind: "source"; readonly source: UsageSource; readonly turnCounts: UsageCounts | null }
  | { readonly kind: "missing"; readonly reason: "invalid-usage-record" | "missing-response-identity" };

function nativeCounts(value: unknown): UsageCounts {
  const usage = object(value);
  const counts = Object.fromEntries(Object.entries(fields).map(([key, native]) => [key,
    usage[native] == null ? null : tokenInteger(usage[native]).toString()]));
  if (counts.totalTokens == null) throw new TypeError("Missing native total");
  return normalizeUsageCounts(counts as UsageSource["counts"]);
}

export interface NativeAcceptedInputFact {
  readonly threadId: string;
  readonly turnId: string;
  readonly inputId: string;
}

/** Durable evidence of native admission, not evidence of who submitted it.
 * Resolve the input ID against a trusted persisted submission receipt. Never
 * derive the Actor, input mode or initiator from body text or message order.
 */
export function nativeAcceptedInputFact(value: unknown, expectedThreadId: string): NativeAcceptedInputFact | null {
  const row = object(value), payload = object(row.payload), item = object(payload.item);
  if (row.type !== "event_msg" || payload.type !== "item_completed" || payload.thread_id !== expectedThreadId || item.type !== "UserMessage") return null;
  const turnId = id(payload.turn_id), inputId = id(item.client_id);
  return turnId && inputId ? { threadId: expectedThreadId, turnId, inputId } : null;
}

/** Live protocol evidence also covers ephemeral threads with no rollout.
 * Call only from the physical native notification boundary, never Renderer RPC.
 * Native live casing differs from its internal durable representation. */
export function nativeLiveAcceptedInputFact(method:string, value:unknown):NativeAcceptedInputFact|null {
  if(method!=="item/completed")return null;
  const payload=object(value),item=object(payload.item);
  if(item.type!=="userMessage")return null;
  const threadId=id(payload.threadId),turnId=id(payload.turnId),inputId=id(item.clientId);
  return threadId&&turnId&&inputId?{threadId,turnId,inputId}:null;
}

/** Decode Host-owned durable response facts, never thread/last counters.
 * Inherited fork records retain their original thread. Model menus are not
 * evidence of the actual response model; missing identities remain null.
 */
export function nativeUsageFact(
  value: unknown,
  expectedThreadId: string,
  identity?: { readonly provider?: string | null; readonly model?: string | null },
): NativeUsageFact | null {
  const row = object(value);
  if (row.type !== "token_usage_record") return null;
  const payload = object(row.payload);
  if (payload.thread_id !== expectedThreadId) return null;
  const turnId = id(payload.turn_id), sessionId = id(payload.session_id), responseId = id(payload.response_id);
  if (!turnId || !sessionId) return { kind: "missing", reason: "invalid-usage-record" };
  if (!responseId) return { kind: "missing", reason: "missing-response-identity" };
  try {
    const normalized = nativeCounts(payload.usage);
    let turnCounts: UsageCounts | null = null;
    try { turnCounts = nativeCounts(payload.turn_token_usage); } catch { /* valid response survives an unavailable report */ }
    return { kind: "source", turnCounts, source: {
      threadId: expectedThreadId, turnId, lineage: `native-session:${sessionId}`, sourceId: responseId,
      kind: "response", version: 0, provider: identity?.provider ?? null, model: identity?.model ?? null,
      counts: { ...normalized, totalTokens: normalized.totalTokens! },
    } };
  } catch { return { kind: "missing", reason: "invalid-usage-record" }; }
}
