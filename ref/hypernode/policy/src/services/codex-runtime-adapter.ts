import { Service, type Context } from "@deepseek-ai/cordis";
import type {
  EngineQuiesceHandlers,
  EngineRpcRequest,
  EngineRuntimeControlPort,
  EngineRuntimeNotification,
  EngineRuntimeWaiter,
} from "../types/engine.js";
import { errorMessage } from "../types/domain.ts";

const QUIESCE_TIMEOUT_MS = 5_000;

function key(runtimeId: unknown, threadId: unknown): string {
  return `${runtimeId}\0${threadId}`;
}

export class CodexRuntimeAdapterTable {
  readonly timeoutMs: number;
  readonly waiters = new Map<string, EngineRuntimeWaiter>();
  readonly activeTurns = new Map<string, string>();

  constructor({ timeoutMs = QUIESCE_TIMEOUT_MS }: { timeoutMs?: number } = {}) {
    this.timeoutMs = timeoutMs;
  }

  quiesce(
    runtimeId: unknown,
    threadId: unknown,
    request: EngineRpcRequest,
    handlers: EngineQuiesceHandlers,
    now = Date.now(),
  ): EngineRuntimeWaiter {
    const waiterKey = key(runtimeId, threadId);
    if (this.waiters.has(waiterKey)) throw new Error("thread runtime is already switching accounts");
    const waiter: EngineRuntimeWaiter = {
      runtimeId: String(runtimeId),
      threadId: String(threadId),
      request,
      handlers,
      phase: "draining",
      deadlineAtMs: now + this.timeoutMs,
    };
    this.waiters.set(waiterKey, waiter);
    const activeTurnId = this.activeTurns.get(waiterKey);
    if (activeTurnId) this.interrupt(waiterKey, activeTurnId, now);
    else this.unsubscribe(waiterKey, now);
    return waiter;
  }

  observe(runtimeId: unknown, message: EngineRuntimeNotification): boolean {
    const threadId = message?.params?.thread?.id ?? message?.params?.threadId;
    if (typeof threadId !== "string") return false;
    const waiterKey = key(runtimeId, threadId);
    if (message.method === "turn/started") {
      const turnId = message.params?.turn?.id;
      if (typeof turnId === "string" && turnId) this.activeTurns.set(waiterKey, turnId);
      return false;
    }
    if (message.method === "turn/completed") {
      const turnId = message.params?.turn?.id;
      if (!turnId || this.activeTurns.get(waiterKey) === turnId) this.activeTurns.delete(waiterKey);
      const waiter = this.waiters.get(waiterKey);
      if (waiter?.phase === "draining") this.unsubscribe(waiterKey);
      return false;
    }
    if (message.method !== "thread/closed") return false;
    this.activeTurns.delete(waiterKey);
    if (!this.waiters.has(waiterKey)) return false;
    this.ready(waiterKey);
    return true;
  }

  tick(now = Date.now()): void {
    for (const [waiterKey, waiter] of this.waiters) {
      if (waiter.deadlineAtMs <= now) {
        const action = waiter.phase === "draining" ? "stop its active turn" : "unsubscribe";
        this.fail(waiterKey, `Timed out waiting for the previous runtime to ${action}.`);
      }
    }
  }

  interrupt(waiterKey: string, turnId: string, now = Date.now()): void {
    const waiter = this.waiters.get(waiterKey);
    if (!waiter || waiter.phase !== "draining") return;
    waiter.deadlineAtMs = now + this.timeoutMs;
    waiter.request("turn/interrupt", { threadId: waiter.threadId, turnId }, (error) => {
      const current = this.waiters.get(waiterKey);
      if (!current || current.phase !== "draining") return;
      if (error && !/no active turn to interrupt/i.test(errorMessage(error))) {
        this.fail(waiterKey, `Could not interrupt the previous runtime: ${errorMessage(error)}`);
        return;
      }
      this.activeTurns.delete(waiterKey);
      this.unsubscribe(waiterKey);
    });
  }

  unsubscribe(waiterKey: string, now = Date.now()): void {
    const waiter = this.waiters.get(waiterKey);
    if (!waiter || waiter.phase === "unsubscribing") return;
    waiter.phase = "unsubscribing";
    waiter.deadlineAtMs = now + this.timeoutMs;
    waiter.request("thread/unsubscribe", { threadId: waiter.threadId }, (error, result) => {
      if (!this.waiters.has(waiterKey)) return;
      if (error) {
        this.fail(waiterKey, `Could not unsubscribe the previous runtime: ${errorMessage(error)}`);
        return;
      }
      const status = typeof result === "object" && result !== null && "status" in result
        ? Reflect.get(result, "status")
        : undefined;
      if (typeof status === "string" && ["unsubscribed", "notLoaded", "notSubscribed"].includes(status)) {
        this.ready(waiterKey);
        return;
      }
      this.fail(waiterKey, `Previous runtime returned an unknown unsubscribe status: ${String(status ?? "missing")}`);
    });
  }

  ready(waiterKey: string): void {
    const waiter = this.waiters.get(waiterKey);
    if (!waiter) return;
    this.waiters.delete(waiterKey);
    waiter.handlers.ready();
  }

  fail(waiterKey: string, reason: string): void {
    const waiter = this.waiters.get(waiterKey);
    if (!waiter) return;
    this.waiters.delete(waiterKey);
    waiter.handlers.error(new Error(reason));
  }
}

export class CodexRuntimeAdapterService extends Service implements EngineRuntimeControlPort {
  readonly table: CodexRuntimeAdapterTable;

  constructor(ctx: Context) {
    super(ctx, "codexRuntimeAdapter");
    this.table = new CodexRuntimeAdapterTable();
  }

  quiesce(...args: Parameters<CodexRuntimeAdapterTable["quiesce"]>): EngineRuntimeWaiter {
    return this.table.quiesce(...args);
  }

  observe(...args: Parameters<CodexRuntimeAdapterTable["observe"]>): boolean {
    return this.table.observe(...args);
  }

  tick(...args: Parameters<CodexRuntimeAdapterTable["tick"]>): void {
    this.table.tick(...args);
  }
}
