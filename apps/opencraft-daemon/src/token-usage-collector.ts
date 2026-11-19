import { Worker } from "node:worker_threads";
import type { UsageSubmission, UsageTurnKey } from "./token-usage-ledger.js";

type Coverage = { enabled: boolean; enabledAt: number | null; revision: number };
export type CollectorCall =
  | { kind: "request"; method: string; params: Record<string, unknown> }
  | { kind: "submission"; threadId: string; inputId: string };
export type CollectorEvent =
  | { type: "result"; id: number; result?: unknown; error?: { code?: number; message?: string } }
  | { type: "identity"; input: UsageSubmission }
  | { type: "initialize"; codexHome: string }
  | { type: "notification"; method: string; params: Record<string, unknown> }
  | { type: "threadStarted"; value: unknown }
  | { type: "threadLoaded"; threadId: string }
  | { type: "releaseEphemeral"; threadId: string }
  | { type: "submission"; input: UsageSubmission }
  | { type: "admission"; key: UsageTurnKey; inputId: string }
  | {
      type: "attempt";
      id: number;
      attemptId: string;
      threadId: string;
      inputId: string;
      mode: UsageSubmission["mode"];
      identity?: UsageSubmission;
    }
  | { type: "attemptOutcome"; attemptId: string; outcome: "accepted" | "rejected" | "unknown"; turnId: string | null }
  | { type: "setEnabled"; id: number; enabled: boolean }
  | { type: "coverage"; id: number }
  | { type: "storedSubmission"; id: number; threadId: string; inputId: string }
  | { type: "close" };
export type CollectorReply = { type: "reply"; id: number; result?: unknown; error?: true };

export type CollectorNotice = { type: "invalidate"; threadId: string; path?: string };

export class TokenUsageCollectorUnavailable extends Error {}

/** Host-side handle for the usage collector worker. Native accounting events are
 * posted without waiting; the Host thread never runs ledger SQL for collection.
 * The worker calls back only for native RPC and trusted submission identity. */
export class TokenUsageCollector {
  private readonly worker: Worker;
  private sequence = 0;
  private closed = false;
  private gaps = 0;
  private coverageValue: Coverage;
  private readonly replies = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  private constructor(
    worker: Worker,
    coverage: Coverage,
    private readonly port: {
      request(method: string, params: Record<string, unknown>): Promise<unknown>;
      submission?: (threadId: string, inputId: string) => UsageSubmission | null;
      diagnostic(category: string): void;
      invalidate?: (threadId: string, path?: string) => void;
      failed(): void;
    },
  ) {
    this.worker = worker;
    this.coverageValue = coverage;
    worker.on("message", (message) => this.receive(message));
    const fail = () => {
      if (this.closed) return;
      this.closed = true;
      for (const reply of this.replies.values())
        reply.reject(new TokenUsageCollectorUnavailable("Usage collector stopped"));
      this.replies.clear();
      try {
        this.port.failed();
      } catch {}
    };
    worker.on("error", fail);
    worker.on("exit", fail);
  }
  static async start(
    options: {
      entry: string;
      directory: string;
      serverId: string;
      projectLegacy?: boolean;
      submission: boolean;
      derived: boolean;
      coreEndpoint?: string;
      coreAuthToken?: string;
      timeoutMs?: number;
    },
    port: TokenUsageCollector["port"],
  ): Promise<TokenUsageCollector> {
    const worker = new Worker(
      `const {workerData}=require('node:worker_threads');
      if(workerData.entry.endsWith('.ts')){require('tsx/cjs');require(workerData.entry);}
      else import(require('node:url').pathToFileURL(workerData.entry).href).catch(()=>process.exit(1));`,
      { eval: true, resourceLimits: { maxOldGenerationSizeMb: 256 }, workerData: { ...options, role: "collector" } },
    );
    try {
      const coverage = await new Promise<Coverage>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new TokenUsageCollectorUnavailable("Usage collector start timed out")),
          options.timeoutMs ?? 30_000,
        );
        const done = (error?: Error, value?: Coverage) => {
          clearTimeout(timer);
          worker.off("message", ready);
          worker.off("error", failed);
          worker.off("exit", exited);
          error ? reject(error) : resolve(value!);
        };
        const ready = (message: { type?: string; coverage?: Coverage }) => {
          if (message?.type === "ready") done(undefined, message.coverage!);
        };
        const failed = (error: Error) => done(error);
        const exited = () => done(new TokenUsageCollectorUnavailable("Usage collector exited during start"));
        worker.on("message", ready);
        worker.on("error", failed);
        worker.on("exit", exited);
      });
      return new TokenUsageCollector(worker, coverage, port);
    } catch (error) {
      await worker.terminate();
      throw error;
    }
  }
  private post(event: CollectorEvent): void {
    if (!this.closed) this.worker.postMessage(event);
  }
  private ask<T>(build: (id: number) => CollectorEvent): Promise<T> {
    if (this.closed) return Promise.reject(new TokenUsageCollectorUnavailable("Usage collector stopped"));
    const id = ++this.sequence;
    return new Promise<T>((resolve, reject) => {
      this.replies.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.worker.postMessage(build(id));
    });
  }
  private receive(message: { type: string; [key: string]: any }): void {
    if (message.type === "reply") {
      const reply = this.replies.get(message.id);
      if (!reply) return;
      this.replies.delete(message.id);
      if (message.error) reply.reject(new Error("unavailable"));
      else reply.resolve(message.result);
    } else if (message.type === "gaps") this.gaps = Number(message.count) || 0;
    else if (message.type === "diagnostic") {
      try {
        this.port.diagnostic(String(message.category));
      } catch {}
    } else if (message.type === "invalidate") {
      try {
        this.port.invalidate?.(String(message.threadId), typeof message.path === "string" ? message.path : undefined);
      } catch {}
    } else if (message.type === "call") void this.serve(message.id, message.request as CollectorCall);
  }
  private async serve(id: number, request: CollectorCall): Promise<void> {
    try {
      const result =
        request.kind === "request"
          ? await this.port.request(request.method, request.params)
          : (this.port.submission?.(request.threadId, request.inputId) ?? null);
      this.post({ type: "result", id, result });
    } catch (error) {
      const cause = error && typeof error === "object" ? (error as { code?: unknown; message?: unknown }) : {};
      this.post({
        type: "result",
        id,
        error: {
          code: typeof cause.code === "number" ? cause.code : undefined,
          message: typeof cause.message === "string" ? cause.message : "request failed",
        },
      });
    }
  }
  initialize(value: unknown): void {
    const home = value && typeof value === "object" ? (value as { codexHome?: unknown }).codexHome : undefined;
    if (typeof home === "string" && home) this.post({ type: "initialize", codexHome: home });
  }
  notification(method: string, params: Record<string, unknown>): void {
    this.post({ type: "notification", method, params });
  }
  threadStarted(value: unknown): void {
    this.post({ type: "threadStarted", value });
  }
  threadLoaded(threadId: string): void {
    if (threadId) this.post({ type: "threadLoaded", threadId });
  }
  releaseEphemeral(threadId: string): void {
    this.post({ type: "releaseEphemeral", threadId });
  }
  submission(input: UsageSubmission): void {
    this.post({ type: "submission", input });
  }
  admission(key: UsageTurnKey, inputId: string): void {
    if (!inputId) return;
    const trusted = this.port.submission?.(key.threadId, inputId);
    if (trusted) this.post({ type: "identity", input: trusted });
    this.post({ type: "admission", key, inputId });
  }
  /** Resolves after the attempt is durable (or recorded as a gap). */
  attempt(
    attemptId: string,
    threadId: string,
    inputId: string,
    mode: UsageSubmission["mode"],
    identity?: UsageSubmission,
  ): Promise<void> {
    const trusted = identity ?? this.port.submission?.(threadId, inputId) ?? undefined;
    return this.ask<void>((id) => ({
      type: "attempt",
      id,
      attemptId,
      threadId,
      inputId,
      mode,
      ...(trusted ? { identity: trusted } : {}),
    })).catch(() => {});
  }
  attemptOutcome(attemptId: string, outcome: "accepted" | "rejected" | "unknown", turnId: string | null = null): void {
    this.post({ type: "attemptOutcome", attemptId, outcome, turnId });
  }
  liveGapCount(): number {
    return this.gaps;
  }
  coverage(): Coverage {
    return this.coverageValue;
  }
  async setEnabled(enabled: boolean): Promise<Coverage> {
    this.coverageValue = await this.ask<Coverage>((id) => ({ type: "setEnabled", id, enabled }));
    return this.coverageValue;
  }
  storedSubmission(threadId: string, inputId: string): Promise<UsageSubmission | null> {
    return this.ask<UsageSubmission | null>((id) => ({ type: "storedSubmission", id, threadId, inputId })).catch(
      () => null,
    );
  }
  async close(): Promise<void> {
    if (this.closed) return;
    const closed = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 5000);
      this.worker.on("message", (message) => {
        if (message?.type === "closed") {
          clearTimeout(timer);
          resolve();
        }
      });
      this.worker.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    this.post({ type: "close" });
    await closed;
    this.closed = true;
    for (const reply of this.replies.values())
      reply.reject(new TokenUsageCollectorUnavailable("Usage collector stopped"));
    this.replies.clear();
    await this.worker.terminate();
  }
}
