import { beginObservedOperation } from "./observability";

export type HistoryLengthBucket = "lt50" | "50to199" | "200to499" | "500plus" | "unknown";
export interface HistoryPaintDetails {
  readonly lengthBucket: HistoryLengthBucket;
  readonly engine: "codex" | "pi" | "dsh" | "unknown";
}
export function historyLengthBucket(turns: number, complete: boolean, totalTurns?: number): HistoryLengthBucket {
  if (totalTurns !== undefined && Number.isSafeInteger(totalTurns) && totalTurns >= 0) return historyLengthBucket(totalTurns, true);
  if (!complete || !Number.isSafeInteger(turns) || turns < 0) return "unknown";
  return turns < 50 ? "lt50" : turns < 200 ? "50to199" : turns < 500 ? "200to499" : "500plus";
}
/** Classify only the Host's declared engine ownership, never a user label/model. */
export function historyEngine(extensions: Record<string, any> | null | undefined, threadId: string | null): HistoryPaintDetails["engine"] {
  const declaration = extensions?.["opencraft/execution-engines"];
  const provider = threadId && Array.isArray(declaration?.providers)
    ? declaration.providers.find((entry: any) => [entry.threadPrefix, entry.modelPrefix]
      .some(prefix => typeof prefix === "string" && prefix.length > 0 && threadId.startsWith(prefix))) : undefined;
  const engine = provider?.id ?? declaration?.defaultEngine;
  return engine === "codex" || engine === "pi" || engine === "dsh" ? engine : "unknown";
}
export interface HistoryPaintAttempt {
  /** Local fence only: never serialized into telemetry. */
  readonly viewId: string;
  readonly cache: "warm" | "cold";
  readonly finish: ReturnType<typeof beginObservedOperation>;
}
/** One user navigation owns the pending measurement, including after route commit. */
export function createThreadHistoryFirstPaintObserver(begin = beginObservedOperation) {
  let pending: HistoryPaintAttempt | null = null;
  const listeners = new Set<() => void>();
  const publish = () => { for (const listener of listeners) listener(); };
  const settle = (attempt: HistoryPaintAttempt, outcome: "ok" | "failed" | "aborted" | "empty", details?: HistoryPaintDetails) => {
    if (pending?.finish !== attempt.finish) return;
    const cache = pending.cache;
    pending = null;
    attempt.finish(outcome, {cache, ...(details ?? {})});
    publish();
  };
  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getSnapshot: () => pending,
    bindView(attempt: HistoryPaintAttempt, viewId: string, cache: "warm" | "cold") {
      if (pending?.finish !== attempt.finish) return attempt;
      pending = {...pending, viewId, cache};
      publish();
      return pending;
    },
    abort() { if (pending) settle(pending, "aborted"); },
    begin(viewId: string, cache: "warm" | "cold") {
      if (pending) settle(pending, "aborted");
      const attempt = { viewId, cache, finish: begin("thread_history_first_paint", { cache, lengthBucket: "unknown", engine: "unknown" }) };
      pending = attempt;
      publish();
      return attempt;
    },
    settle,
  };
}
