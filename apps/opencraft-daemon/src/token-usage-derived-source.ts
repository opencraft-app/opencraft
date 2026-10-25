import { createHash } from "node:crypto";
import { normalizeUsageCounts, type UsageCounts } from "./token-usage-ledger.js";
import { readRolloutIncrement } from "@opencraft/native-history-node/codex-rollout-reader";

type Counts = readonly (string | null)[];
export type RetainedUsageEvent =
  | { kind: "session"; data: [string, string | null] }
  | { kind: "context"; data: [string, string | null, string | null] }
  | { kind: "start"; data: [string] }
  | { kind: "end"; data: [string, "completed" | "failed" | "interrupted"] }
  | { kind: "response"; data: [string, string, string, Counts] }
  | { kind: "count"; data: [Counts, Counts] };
const fields = ["totalTokens", "inputTokens", "cachedInputTokens", "cacheWriteInputTokens", "outputTokens", "reasoningOutputTokens"] as const;
const nativeFields = ["total_tokens", "input_tokens", "cached_input_tokens", "cache_write_input_tokens", "output_tokens", "reasoning_output_tokens"] as const;
function object(value: unknown): Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function id(value: unknown): string | null { return typeof value === "string" && value.length > 0 && value.length <= 1024 ? value : null; }
function counts(value: unknown): Counts {
  const row = object(value);
  const normalized = normalizeUsageCounts(Object.fromEntries(fields.map((key, i) => [key, row[nativeFields[i]!] ?? null])) as { totalTokens: string });
  return fields.map(key => normalized[key]);
}
export function usageCounts(value: Counts): UsageCounts { return Object.fromEntries(fields.map((key, i) => [key, value[i] ?? null])) as unknown as UsageCounts; }
/** Whitelist only native metering and routing metadata. Bodies never leave the reader. */
export function retainUsageEvent(value: unknown): RetainedUsageEvent | null {
  const row = object(value), p = object(row.payload), turn = id(p.turn_id);
  if (row.type === "session_meta" && id(p.id)) return { kind: "session", data: [id(p.id)!, id(p.model_provider)] };
  if (row.type === "turn_context" && turn) return { kind: "context", data: [turn, id(p.model), id(p.model_provider)] };
  if (row.type === "token_usage_record" && id(p.thread_id) && turn && id(p.response_id)) return { kind: "response", data: [id(p.thread_id)!,turn,id(p.response_id)!,counts(p.usage)] };
  if (row.type !== "event_msg") return null;
  if (p.type === "task_started" && turn) return { kind: "start", data: [turn] };
  if (["task_complete", "turn_aborted", "task_failed"].includes(String(p.type)) && turn) return { kind: "end", data: [turn, p.type === "task_complete" ? "completed" : p.type === "turn_aborted" ? "interrupted" : "failed"] };
  if (p.type === "token_count" && object(p.info).total_token_usage && object(p.info).last_token_usage) {
    const info = object(p.info);
    return { kind: "count", data: [counts(info.total_token_usage), counts(info.last_token_usage)] };
  }
  return null;
}

export interface UsageParserState {
  session: string | null; provider: string | null; turn: string | null; model: string | null;
  total: Counts | null; responseThread: string | null;
}
export const emptyUsageParserState = (): UsageParserState => ({ session: null, provider: null, turn: null, model: null, total: null, responseThread: null });
export interface ParsedUsageDelta { turnId: string; provider: string | null; model: string | null; counts: UsageCounts; evidence:"exact"|"counter" }
/** Native thread cumulative totals are dedup/baseline evidence, never a turn total.
 * First observations use last, and resets/ambiguous gaps remain incomplete. */
export function parseUsageEvent(state: UsageParserState, event: RetainedUsageEvent, threadId: string): { delta?: ParsedUsageDelta; terminal?: { turnId: string; state: "completed" | "failed" | "interrupted" }; missing?: boolean } {
  if (event.kind === "session") { state.session = event.data[0]; state.provider = event.data[1]; return {}; }
  if (event.kind === "context") { state.turn = event.data[0]; state.model = event.data[1]; state.provider = event.data[2] ?? state.provider; return {}; }
  if (event.kind === "start") { state.turn = event.data[0]; state.model = null; return {}; }
  if (event.kind === "response") {
    state.responseThread=event.data[0];
    if(state.session!==threadId||event.data[0]!==threadId)return {};
    return {delta:{turnId:event.data[1],provider:state.provider,model:state.turn===event.data[1]?state.model:null,counts:usageCounts(event.data[3]),evidence:"exact"}};
  }
  if (event.kind === "end") return { terminal: { turnId: event.data[0], state: event.data[1] } };
  const [total, last] = event.data, previous = state.total;
  state.total = total;
  const paired = state.responseThread !== null;
  state.responseThread = null;
  if (state.session !== threadId || paired) return {};
  if (!state.turn) return { missing: true };
  if (previous?.[0] === total[0]) return {};
  let delta = last;
  if (previous) {
    if (total.some((n, i) => n !== null && previous[i] != null && BigInt(n) < BigInt(previous[i]!))) return { missing: true };
    delta = total.map((n, i) => n === null || previous[i] == null ? null : (BigInt(n) - BigInt(previous[i]!)).toString());
    // A changed counter without the corresponding response is ambiguous across
    // compaction/reset boundaries; do not guess the missing response's model.
    if (delta[0] !== last[0]) return { missing: true };
  }
  return { delta: { turnId: state.turn, provider: state.provider, model: state.model, counts: usageCounts(delta),evidence:"counter" } };
}

export interface RetainedRead { cursor: number; identity: string; events: { key: string; at: number; event: RetainedUsageEvent }[]; missing: boolean; more: boolean; bytes: number }
/** At most one MiB plus a bounded newline search. A partial tail is retried. */
export async function readUsageIncrement(options: { path: string; nativeHome: string; threadId: string; cursor: number; identity: string | null }): Promise<RetainedRead> {
  const selected = (head: string): boolean => {
    const tag = head.match(/"type"\s*:\s*"([^"]+)"/)?.[1];
    if (!tag || !["session_meta", "turn_context", "token_usage_record", "event_msg"].includes(tag)) return false;
    if (tag !== "event_msg") return true;
    const subtype = head.match(/"payload"\s*:\s*\{\s*"type"\s*:\s*"([^"]+)"/)?.[1];
    return !subtype || ["token_count", "task_started", "task_complete", "turn_aborted", "task_failed"].includes(subtype);
  };
  return readRolloutIncrement({ ...options, select: selected, oversized: selected,
    retain(value): RetainedRead["events"][number] | null {
      const event = retainUsageEvent(value);
      if (!event) return null;
      const at = Date.parse(value.timestamp);
      if (!Number.isSafeInteger(at) || at < 0) throw new Error("Invalid usage timestamp");
      const key = createHash("sha256").update(JSON.stringify(event.kind === "response"
        ? [options.threadId, "response", ...event.data.slice(0, 3)] : [options.threadId, at, event])).digest("hex");
      return { key, at, event };
    },
  });
}
