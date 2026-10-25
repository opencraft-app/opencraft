import { open, realpath } from "node:fs/promises";
import { relative, isAbsolute } from "node:path";
import { nativeUsageFact, nativeAcceptedInputFact, type NativeAcceptedInputFact } from "./token-usage-native-facts.js";
import type { OpenCraftTokenUsageLedger } from "./token-usage-ledger.js";

import { findNextNewline, OversizedRolloutLineError } from "@opencraft/native-history-node/codex-rollout-reader";
export { findNextNewline, OversizedRolloutLineError } from "@opencraft/native-history-node/codex-rollout-reader";

export interface RolloutTurnIdentity {
  readonly provider: string | null;
  readonly turnId: string | null;
  readonly model: string | null;
}

export async function readTurnIdentity(
  path: string,
  cursor: number,
  maxBytes = 8 * 1024 * 1024,
): Promise<RolloutTurnIdentity | null> {
  let file: import("node:fs/promises").FileHandle | null = null;
  try {
    file = await open(path, "r");
    const stat = await file.stat();
    let provider: string | null = null;
    const headLen = Math.min(64 * 1024, stat.size);
    if (headLen > 0) {
      const headBuf = Buffer.alloc(headLen);
      const { bytesRead } = await file.read(headBuf, 0, headLen, 0);
      const text = headBuf.subarray(0, bytesRead).toString("utf8");
      for (const line of text.split("\n")) {
        if (/^\s*\{[^\n]*?"type"\s*:\s*"session_meta"/.test(line)) {
          try {
            const parsed = JSON.parse(line);
            if (typeof parsed?.payload?.model_provider === "string") {
              provider = parsed.payload.model_provider;
              break;
            }
          } catch {}
        }
      }
    }
    let turnId: string | null = null;
    let model: string | null = null;
    const scanEnd = Math.min(cursor, stat.size);
    const scanStart = Math.max(0, scanEnd - maxBytes);
    const scanLen = scanEnd - scanStart;
    if (scanLen > 0) {
      const tailBuf = Buffer.alloc(scanLen);
      const { bytesRead } = await file.read(tailBuf, 0, scanLen, scanStart);
      const text = tailBuf.subarray(0, bytesRead).toString("utf8");
      const lines = text.split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i]!;
        if (/^\s*\{[^\n]*?"type"\s*:\s*"turn_context"/.test(line)) {
          try {
            const parsed = JSON.parse(line);
            if (typeof parsed?.payload?.turn_id === "string") {
              turnId = parsed.payload.turn_id;
              model = typeof parsed.payload.model === "string" ? parsed.payload.model : null;
              break;
            }
          } catch {}
        }
      }
    }
    if (provider === null && turnId === null && model === null) return null;
    return { provider, turnId, model };
  } catch {
    return null;
  } finally {
    await file?.close();
  }
}

export async function scanRolloutTurnModels(
  path: string,
): Promise<Map<string, { provider: string | null; model: string | null }>> {
  const result = new Map<string, { provider: string | null; model: string | null }>();
  let file: import("node:fs/promises").FileHandle | null = null;
  try {
    file = await open(path, "r");
    const stat = await file.stat();
    let currentProvider: string | null = null;
    let cursor = 0;
    const chunkSize = 1024 * 1024;
    let leftover = "";
    while (cursor < stat.size) {
      const toRead = Math.min(chunkSize, stat.size - cursor);
      const buf = Buffer.alloc(toRead);
      const { bytesRead } = await file.read(buf, 0, toRead, cursor);
      if (bytesRead === 0) break;
      const nlIndex = buf.subarray(0, bytesRead).indexOf(10);
      if (nlIndex === -1 && bytesRead === chunkSize) {
        const nextNl = await findNextNewline(file, cursor, 64 * 1024 * 1024);
        if (nextNl === null) break;
        cursor = nextNl;
        leftover = "";
        continue;
      }
      const text = leftover + buf.subarray(0, bytesRead).toString("utf8");
      const lines = text.split("\n");
      leftover = lines.pop() ?? "";
      cursor += bytesRead;
      for (const line of lines) {
        if (/^\s*\{[^\n]*?"type"\s*:\s*"session_meta"/.test(line)) {
          try {
            const parsed = JSON.parse(line);
            if (typeof parsed?.payload?.model_provider === "string") {
              currentProvider = parsed.payload.model_provider;
            }
          } catch {}
        } else if (/^\s*\{[^\n]*?"type"\s*:\s*"turn_context"/.test(line)) {
          try {
            const parsed = JSON.parse(line);
            if (typeof parsed?.payload?.turn_id === "string") {
              const turnId = parsed.payload.turn_id;
              const model = typeof parsed.payload.model === "string" ? parsed.payload.model : null;
              result.set(turnId, { provider: currentProvider, model });
            }
          } catch {}
        }
      }
    }
    if (leftover) {
      if (/^\s*\{[^\n]*?"type"\s*:\s*"turn_context"/.test(leftover)) {
        try {
          const parsed = JSON.parse(leftover);
          if (typeof parsed?.payload?.turn_id === "string") {
            result.set(parsed.payload.turn_id, {
              provider: currentProvider,
              model: typeof parsed.payload.model === "string" ? parsed.payload.model : null,
            });
          }
        } catch {}
      }
    }
  } catch {
  } finally {
    await file?.close();
  }
  return result;
}

export interface RolloutUsageResult {
  readonly cursor: number;
  readonly observed: number;
  readonly changed: number;
  readonly missing: number;
  readonly more: boolean;
  readonly blockedTurnId?: string;
  readonly skipped: number;
  readonly oversizedFact: boolean;
}

/** Bounded replay of native count facts. Neither prompt lines nor full rollout
 * JSON escape this boundary. Paths must come from native thread/read and still
 * resolve inside the Host's native storage. Each source and cursor commit in
 * the ledger's existing transaction; a crash can replay but cannot skip a fact.
 */
export async function replayRolloutUsage(options: {
  readonly path: string;
  readonly nativeHome: string;
  readonly threadId: string;
  readonly ledger: OpenCraftTokenUsageLedger;
  readonly cursor?: number;
  readonly maxBytes?: number;
  /** Exclusions verified from native turn start/coverage, never request input. */
  readonly excludedTurnIds?: ReadonlySet<string>;
  readonly onAdmission?: (fact: NativeAcceptedInputFact) => void;
  readonly onTerminal?: (turnId: string) => void;
  readonly maxFacts?: number;
  readonly onCommitCursor?: (cursor: number) => void;
  readonly signal?: AbortSignal;
  readonly onSourceTurn?: (key: {threadId:string;turnId:string}) => boolean;
  readonly onOversizedLine?: (mayContainFact: boolean, bytes: number) => void;
  readonly identity?: RolloutTurnIdentity;
  /** Receipt-only cutover keeps native admission recovery without token writes. */
  readonly counts?: boolean;
}): Promise<RolloutUsageResult> {
  options.signal?.throwIfAborted();
  const root = await realpath(options.nativeHome);
  const path = await realpath(options.path);
  const child = relative(root, path);
  if (!child || child === ".." || child.startsWith("../") || isAbsolute(child)) throw new Error("Usage rollout is outside native storage");
  const file = await open(path, "r");
  try {
    const stat = await file.stat();
    const cursor = options.cursor ?? 0;
    const maxBytes = options.maxBytes ?? 1024 * 1024;
    const maxFacts = options.maxFacts ?? 32;
    if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > stat.size) throw new Error("Usage rollout cursor requires reconciliation");
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 8 * 1024 * 1024) throw new Error("Invalid usage replay batch");
    if (!Number.isSafeInteger(maxFacts) || maxFacts < 1 || maxFacts > 1000) throw new Error("Invalid usage fact batch");
    const buffer = Buffer.alloc(Math.min(maxBytes, stat.size - cursor));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, cursor);
    options.signal?.throwIfAborted();

    let skipTo: number | null = null;
    let oversizedFact = false;
    if (bytesRead === maxBytes && !buffer.subarray(0, bytesRead).includes(10)) {
      const head = buffer.subarray(0, Math.min(bytesRead, 64 * 1024)).toString("utf8");
      oversizedFact = /"type"\s*:\s*"(?:token_usage_record|event_msg|turn_context|session_meta)"/.test(head);
      skipTo = await findNextNewline(file, cursor, 64 * 1024 * 1024);
    }

    return options.ledger.commitReplayBatch(() => {
      const finish = (result: Omit<RolloutUsageResult, "skipped" | "oversizedFact"> & { skipped?: number; oversizedFact?: boolean }): RolloutUsageResult => {
        const full: RolloutUsageResult = { skipped: 0, oversizedFact: false, ...result };
        options.onCommitCursor?.(full.cursor);
        return full;
      };
      let committed = cursor, observed = 0, changed = 0, missing = 0, handled = 0;
      let start = 0;
      const started = performance.now();
      let currentProvider: string | null = options.identity?.provider ?? null;
      const turnModels = new Map<string, string | null>();

      for (let index = 0; index < bytesRead; index++) {
        if (buffer[index] !== 10) continue;
        const end = cursor + index + 1;
        const line = buffer.subarray(start, index).toString("utf8");
        start = index + 1;
        // The stable native record tag precedes its payload. Skip unrelated
        // potentially sensitive history without parsing or returning its body.
        if (/^\s*\{[^\n]*?"type"\s*:\s*"(?:token_usage_record|event_msg|session_meta|turn_context)"/.test(line)) {
          let value: unknown;
          try { value = JSON.parse(line); } catch { missing++; committed = end; continue; }
          const row = value as { type?: unknown; payload?: { type?: unknown; turn_id?: unknown; model_provider?: unknown; model?: unknown } };
          if (row.type === "session_meta" && row.payload && typeof row.payload.model_provider === "string") {
            currentProvider = row.payload.model_provider;
          }
          if (row.type === "turn_context" && row.payload && typeof row.payload.turn_id === "string") {
            turnModels.set(row.payload.turn_id, typeof row.payload.model === "string" ? row.payload.model : null);
          }
          const admission = nativeAcceptedInputFact(value, options.threadId);
          if (admission && !options.excludedTurnIds?.has(admission.turnId) && options.onAdmission) { options.onAdmission(admission); handled++; }
          if (row.type === "event_msg" && row.payload?.type === "task_complete" && typeof row.payload.turn_id === "string" && !options.excludedTurnIds?.has(row.payload.turn_id)) {
            if (options.onTerminal) { options.onTerminal(row.payload.turn_id); handled++; }
          }
          const turnId = typeof row.payload?.turn_id === "string" ? row.payload.turn_id : undefined;
          const identity = {
            provider: currentProvider,
            model: (turnId ? turnModels.get(turnId) : null) ?? (options.identity && options.identity.turnId === turnId ? options.identity.model : options.identity?.model) ?? null,
          };
          const fact = options.counts === false ? null : nativeUsageFact(value, options.threadId, identity);
          if (fact?.kind === "missing") { missing++; handled++; }
          if (fact?.kind === "source") {
            if (options.excludedTurnIds?.has(fact.source.turnId)) { committed = end; continue; }
            if (options.onSourceTurn && !options.onSourceTurn(fact.source)) { committed = end; continue; }
            observed++;
            handled++;
            // Do not advance across an unregistered turn: its trusted native
            // start/receipt must be recovered before importing its responses.
            if (!options.ledger.readTurn(fact.source)) return finish({ cursor: committed, observed, changed, missing, more: true, blockedTurnId: fact.source.turnId });
            // The report is a verified per-turn total from the same native
            // record, never thread_token_usage. Commit alternatives and cursor
            // atomically so a crash cannot skip a required fallback snapshot.
            if (fact.turnCounts) {
              const before = options.ledger.readTurn(fact.source)?.revision;
              options.ledger.recordSourceBatch([fact.source, { ...fact.source, kind: "turn-snapshot", sourceId: "native-turn",
                version: end, provider: fact.source.provider, model: fact.source.model, counts: {...fact.turnCounts,totalTokens:fact.turnCounts.totalTokens!}, cursor: String(end) }]);
              if (options.ledger.readTurn(fact.source)?.revision !== before) changed++;
            } else {
              const result = options.ledger.recordSource({ ...fact.source, cursor: String(end) });
              if (result === "inserted" || result === "corrected") changed++;
            }
          }
        }
        committed = end;
        if (handled >= maxFacts || performance.now()-started>=8) return finish({ cursor: end, observed, changed, missing, more: end < stat.size });
      }
      // An incomplete tail remains unread until the native writer completes it.
      // A single oversized history line requires explicit reconciliation rather
      // than an unbounded buffer or silently skipping possible count evidence.
      if (start === 0 && bytesRead === maxBytes) {
        if (skipTo === null) throw new OversizedRolloutLineError("Usage rollout line exceeds replay batch");
        options.onOversizedLine?.(oversizedFact, skipTo - cursor);
        if (oversizedFact) missing++;
        return finish({ cursor: skipTo, observed, changed, missing, skipped: 1, oversizedFact, more: skipTo < stat.size });
      }
      return finish({ cursor: committed, observed, changed, missing, more: committed < stat.size });
    });
  } finally { await file.close(); }
}
