import { elapsedClock, type ElapsedClock } from "@opencraft/appserver-client/clock";
import { executionEngineExtension } from "@opencraft/appserver-client";
import { Context, Service } from "@deepseek-ai/cordis";
import { AppServerClientError, AppServerRpcError, isRetryableAppServerRpcError, isHistoryResponseTooLargeError, type AppServerClient } from "@opencraft/appserver-client";
import { OPENCRAFT_RESUME_HISTORY_EXTENSION, buildResumeHistoryRequest, type AppServerThread, type ThreadHistoryCheckpoint, type ThreadResumeParams, type ThreadResumeResponse, type ThreadForkResponse } from "@opencraft/appserver-protocol";

import type { DerivedHistoryPorts, DerivedReadContext } from "./derived-history";
import type { HydratedThreadHistory, ResumeHistoryContext } from "./history-strategies";
import { hydrateReadTurnItems, readTurnsPage } from "./history-strategies";
import { mergeTurns, reconcileHistoryTurns, reconcileHistoryWindow, reconcileRecoveryWindow } from "./merge-turns";
import type { ThreadExecutionProjection, ThreadStreamRole, ThreadView } from "./models";
import { resolveThreadId } from "./notification-buffer";
import type { ThreadViewFrameScheduler } from "./view-store";

let historyDetailReadGeneration = 0;
function tagHistoryDetails(turns: readonly import("@opencraft/appserver-protocol").AppServerTurn[], readGeneration: number) {
  return turns.map(turn => turn.items?.some(item => item.historyDetail) ? { ...turn,
    items: turn.items.map(item => item.historyDetail ? { ...item, historyDetail: { ...item.historyDetail, readGeneration } } : item),
  } : turn);
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    threadResume: ThreadResumeCoordinatorService;
  }
}

export type AppServerHostKind = "local" | "remote-ssh" | "durable" | "remote-control" | "wsl";

const TEXT_DELTA_METHODS = new Set([
  "item/agentMessage/delta",
  "item/plan/delta",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/textDelta",
]);

export interface ThreadResumeCoordinatorConfig {
  client: AppServerClient;
  hostKind?: AppServerHostKind;
  historyModeHint?: "legacy" | "paginated" | "message-window" | null | (() => "legacy" | "paginated" | "message-window" | null);
  useTailHydration?: boolean;
  supportsPaginatedHistory?: boolean;
  pageSize?: number;
  /** Per-RPC timeout and quiet-cut revalidation cap; zero disables these client budgets. */
  requestTimeoutMs?: number;
  drainTailHistory?: boolean;
  frameScheduler?: ThreadViewFrameScheduler;
  /** Elapsed clock for the bounded quiet-cut retry phase; RPC/provider budgets stay client-owned. */
  readClock?: ElapsedClock;
}

export interface ResumeThreadOptions {
  /** Revokes local history ownership; remote execution may continue. */
  signal?: AbortSignal;
  threadId: string;
  force?: boolean;
  /** Explicit user retry may reattempt a server-rejected resume in this connection generation. */
  retryRejected?: boolean;
  /** Explicitly unresolved admitted writes survive a canonical tail replacement. */
  unresolvedTurnIds?: readonly string[];
  history?: unknown;
  path?: string | null;
  model?: string | null;
  modelProvider?: string | null;
  serviceTier?: string | null;
  cwd?: string | null;
  approvalPolicy?: unknown;
  approvalsReviewer?: unknown;
  permissions?: unknown;
  runtimeWorkspaceRoots?: readonly string[];
  sandbox?: unknown;
  config?: Readonly<Record<string, unknown>>;
  baseInstructions?: string | null;
  developerInstructions?: string | null;
  personality?: unknown;
  /** Null explicitly suppresses a checkpoint that is no longer safe to reuse. */
  historyCheckpoint?: ThreadHistoryCheckpoint | null;
  requestOverrides?: Readonly<Record<string, unknown>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function requireThread(value: unknown, operation: string): AppServerThread {
  if (!isRecord(value) || typeof value.id !== "string" || !Array.isArray(value.turns)) {
    throw new Error(`${operation} returned an invalid Thread`);
  }
  return value as unknown as AppServerThread;
}

function requireResumeResponse(value: ThreadResumeResponse, threadId: string): ThreadResumeResponse {
  if (!isRecord(value)) throw new Error("thread/resume returned a non-object response");
  const thread = requireThread(value.thread, "thread/resume");
  if (thread.id !== threadId) throw new Error(`thread/resume returned ${thread.id} for requested Thread ${threadId}`);
  for (const field of ["model", "modelProvider", "cwd"] as const) {
    if (typeof value[field] !== "string") throw new Error(`thread/resume returned invalid ${field}`);
  }
  for (const field of ["approvalPolicy", "approvalsReviewer", "sandbox"] as const) {
    if (!(field in value)) throw new Error(`thread/resume response is missing ${field}`);
  }
  if (!Array.isArray(value.runtimeWorkspaceRoots) || value.runtimeWorkspaceRoots.some((root) => typeof root !== "string")) {
    throw new Error("thread/resume returned invalid runtimeWorkspaceRoots");
  }
  return { ...value, thread };
}

interface HistoryOperation<T = ThreadView> {
  readonly promise: Promise<T>;
  readonly signal: AbortSignal;
  current(): boolean;
  assertCurrent(): void;
  cancel(): void;
  limitUntil(deadline: number, error: Error): void;
  onCancel?: () => void;
}

function historyAborted(): AppServerClientError {
  return new AppServerClientError("ABORTED", "Thread history operation was superseded");
}

/** A joining caller may stop waiting without revoking the initiating owner. */
function waitForHistory<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(historyAborted());
  return new Promise<T>((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(historyAborted()); };
    signal.addEventListener("abort", abort, { once: true });
    promise.then(value => { signal.removeEventListener("abort", abort); resolve(value); },
      error => { signal.removeEventListener("abort", abort); reject(error); });
    if (signal.aborted) abort();
  });
}

export class ThreadResumeCoordinatorService extends Service {
  static inject = [
    "threadViews",
    "threadHistoryStrategies",
    "threadResumeProjectors",
    "threadNotificationProjectors",
    "threadStreamOwnership",
    "resumeNotificationBuffer",
  ];

  private readonly client: AppServerClient;
  private readonly hostKind: AppServerHostKind;
  private readonly useTailHydration: boolean;
  private readonly supportsPaginatedHistory: boolean;
  private readonly readHistoryMode: () => "legacy" | "paginated" | "message-window" | null;
  private get historyModeHint() { return this.readHistoryMode(); }
  private readonly pageSize: number;
  private readonly requestTimeoutMs: number;
  private readonly readClock: ElapsedClock;
  private readonly drainTailHistory: boolean;
  private readonly inFlight = new Map<string, HistoryOperation>();
  private readonly activations = new Map<string, HistoryOperation<void>>();
  private readonly activatedGenerations = new Map<string, number>();
  private executionNotificationRevision = 0;
  private readonly executionFieldRevisions = new Map<string, Map<keyof ThreadExecutionProjection, number>>();
  private readonly reads = new Map<string, HistoryOperation>();
  private readonly readContexts = new Map<string, DerivedReadContext>();
  private readonly rejectedResumes = new Map<string, { generation: number; error: AppServerRpcError }>();
  private readonly historyContexts = new Map<string, ResumeHistoryContext>();
  private readonly backgroundHistory = new Map<string, HistoryOperation<void>>();
  private readonly olderPageRequests = new Map<string, HistoryOperation>();
  private readonly itemDetailRequests = new Map<string, Set<HistoryOperation<void>>>();
  private readonly historyRefreshes = new Map<string, HistoryOperation<boolean>>();
  private disposed = false;
  private previewSequence = 0;
  private readonly previewTokens = new Map<string, string>();

  constructor(ctx: Context, config: ThreadResumeCoordinatorConfig) {
    super(ctx, "threadResume");
    this.client = config.client;
    this.hostKind = config.hostKind ?? (config.client.hostId === "durable" ? "durable" : "local");
    this.useTailHydration = config.useTailHydration ?? true;
    this.supportsPaginatedHistory = config.supportsPaginatedHistory ?? true;
    const hint = config.historyModeHint;
    this.readHistoryMode = typeof hint === "function" ? hint : () => hint ?? null;
    this.pageSize = config.pageSize ?? 5;
    this.requestTimeoutMs = config.requestTimeoutMs ?? 30_000;
    this.readClock = config.readClock ?? elapsedClock;
    this.drainTailHistory = config.drainTailHistory ?? false;
    if (!Number.isInteger(this.pageSize) || this.pageSize < 1) throw new RangeError("pageSize must be positive");

    const removeNotification = this.client.subscribeNotification((notification) => {
      const threadId = resolveThreadId(notification.params);
      if (threadId === null || !ctx.threadViews.has(threadId)) return;
      if (notification.method === "thread/history/preview") {
        const params = notification.params;
        if (!isRecord(params) || typeof params.token !== "string" || params.token !== this.previewTokens.get(threadId) || !Array.isArray(params.turns)) return;
        const turns = params.turns as AppServerThread["turns"];
        if (turns.some(turn => !isRecord(turn) || typeof turn.id !== "string" || !Array.isArray(turn.items))) return;
        ctx.threadViews.update(threadId, current => ({
          ...current, historySource: "message-window", turns: reconcileHistoryWindow(current.turns, turns),
        }));
        return;
      }
      const project = (current: ThreadView) => {
        const projected = ctx.threadNotificationProjectors.project(current, notification);
        this.noteExecutionNotification(threadId, current.execution, projected.execution, notification.method, notification.params);
        return projected;
      };
      const params = notification.params as Record<string, unknown> | null;
      if (TEXT_DELTA_METHODS.has(notification.method) && typeof params?.delta === "string") {
        ctx.threadViews.queueProjection(threadId, this.client.connectionGeneration, project, params.delta.length * 2);
      } else {
        // Lifecycle/replacement/unknown notifications are ordered flush barriers.
        ctx.threadViews.update(threadId, project);
      }
    }, { intercept: (notification, next) => ctx.resumeNotificationBuffer.interceptProjection(notification, next) });
    const removeStatus = this.client.subscribeStatus((status) => {
      if (status.state !== "closed" && status.state !== "failed") return;
      for (const operation of [...this.inFlight.values(), ...this.reads.values(), ...this.activations.values()]) operation.cancel();
      for (const threadId of new Set([...this.readContexts.keys(), ...this.historyContexts.keys()])) this.retireHistoryContext(threadId);
      this.rejectedResumes.clear();
      this.activatedGenerations.clear();
      this.executionFieldRevisions.clear();
      ctx.threadStreamOwnership.resetAfterReconnect();
      for (const view of ctx.threadViews.getAll()) {
        ctx.threadViews.update(view.threadId, (current) => ({
          ...current,
          resumeState: "needs_resume",
          streamRole: null,
        }));
      }
    });
    ctx.effect(() => () => {
      this.disposed = true;
      removeNotification();
      removeStatus();
      for (const operation of [...this.inFlight.values(), ...this.reads.values(), ...this.activations.values()]) operation.cancel();
      this.inFlight.clear();
      this.reads.clear();
      this.activations.clear();
      this.activatedGenerations.clear();
      this.executionFieldRevisions.clear();
      this.readContexts.clear();
      this.rejectedResumes.clear();
      this.historyContexts.clear();
      for (const operation of [...this.backgroundHistory.values(), ...this.olderPageRequests.values(), ...this.historyRefreshes.values(), ...[...this.itemDetailRequests.values()].flatMap(requests => [...requests])]) operation.cancel();
      this.backgroundHistory.clear();
      this.olderPageRequests.clear();
      this.historyRefreshes.clear();
      this.itemDetailRequests.clear();
      this.previewTokens.clear();
    });
  }

  /** A fresh baseline revokes the previous source's derived readers even
   * when the physical client generation is unchanged. Cached paint survives. */
  /** End optional presentation waits without releasing the cached baseline or
   * execution stream. Snapshot first: cancellation observers may admit new work. */
  cancelDerivedHistory(threadId: string): void {
    const retired = [this.backgroundHistory.get(threadId), this.olderPageRequests.get(threadId), this.historyRefreshes.get(threadId), ...(this.itemDetailRequests.get(threadId) ?? [])];
    for (const operation of retired) operation?.cancel();
  }

  private retireHistoryContext(threadId: string): void {
    this.readContexts.delete(threadId);
    this.historyContexts.delete(threadId);
    const retired = [this.backgroundHistory.get(threadId), this.olderPageRequests.get(threadId), this.historyRefreshes.get(threadId), ...(this.itemDetailRequests.get(threadId) ?? [])];
    this.backgroundHistory.delete(threadId);
    this.olderPageRequests.delete(threadId);
    this.historyRefreshes.delete(threadId);
    this.itemDetailRequests.delete(threadId);
    for (const operation of retired) operation?.cancel();
  }

  /** Retiring an owner may synchronously admit another through abort/view
   * observers. Re-read both slots instead of overwriting that successor. */
  private baselineOperation(threadId: string): { kind: "read" | "resume"; operation: HistoryOperation } | undefined {
    for (;;) {
      const reading = this.reads.get(threadId), operation = reading ?? this.inFlight.get(threadId);
      if (!operation) return;
      if (operation.current()) return { kind: reading === operation ? "read" : "resume", operation };
      operation.cancel();
    }
  }

  /** Admission precedes observers/I/O. Local retirement and settlement precede
   * timer cleanup or child abort; late callbacks retain only their own ticket. */
  private startHistoryOperation<T>(
    slots: Map<string, HistoryOperation<T>>, threadId: string, signal: AbortSignal | undefined,
    run: (operation: HistoryOperation<T>) => Promise<T>, baseline = false, cancelledValue?: () => T,
  ): Promise<T> {
    if (this.disposed || signal?.aborted) return Promise.reject(historyAborted());
    const generation = this.client.connectionGeneration;
    const controller = new AbortController();
    let active = true, budgetTicket = 0;
    let deadline: number | undefined, budgetError: Error | undefined, failure: Error | undefined;
    let timer: { handle: unknown } | null = null;
    let resolve!: (view: T) => void, reject!: (error: unknown) => void;
    const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
    const valid = () => active && !signal?.aborted && !this.disposed && generation === this.client.connectionGeneration
      && slots.get(threadId) === operation;
    const release = () => {
      const owned = slots.get(threadId) === operation, handle = timer;
      active = false; timer = null; ++budgetTicket;
      if (owned) slots.delete(threadId);
      signal?.removeEventListener("abort", operation.cancel);
      return { owned, handle };
    };
    const clear = (scheduled: { handle: unknown } | null) => { if (scheduled) this.readClock.clearTimeout(scheduled.handle); };
    const retire = (error: Error) => {
      if (!active) return;
      const released = release(); failure = error;
      if (cancelledValue) resolve(cancelledValue()); else reject(error);
      try {
        if (released.owned && baseline) {
          this.retireHistoryContext(threadId);
          this.previewTokens.delete(threadId);
          this.ctx.resumeNotificationBuffer.discard(threadId, error);
        }
        if (released.owned) operation.onCancel?.();
      } finally { try { clear(released.handle); } finally { controller.abort(); } }
    };
    const arm = () => {
      if (!valid() || deadline === undefined) return;
      const ticket = ++budgetTicket;
      const scheduled = { handle: this.readClock.setTimeout(() => {
        if (!active || ticket !== budgetTicket) return;
        timer = null;
        if (this.readClock.now() >= deadline!) retire(budgetError!);
        else arm(); // Respect the elapsed deadline if a platform rounds a timer early.
      }, Math.max(1, Math.ceil(deadline - this.readClock.now()))) };
      if (active && ticket === budgetTicket) timer = scheduled;
      else clear(scheduled);
    };
    const operation: HistoryOperation<T> = {
      promise, signal: controller.signal,
      current: () => {
        if (!valid()) return false;
        if (deadline !== undefined && this.readClock.now() >= deadline) { retire(budgetError!); return false; }
        return valid();
      },
      assertCurrent() { if (!this.current()) throw failure ?? historyAborted(); },
      cancel: () => retire(historyAborted()),
      limitUntil: (at, error) => {
        if (!active || !Number.isFinite(at) || (deadline !== undefined && at >= deadline)) return;
        deadline = at; budgetError = error;
        const previous = timer; timer = null; ++budgetTicket;
        clear(previous);
        if (operation.current()) arm();
      },
    };
    slots.set(threadId, operation);
    signal?.addEventListener("abort", operation.cancel, { once: true });
    if (signal?.aborted) operation.cancel();
    void Promise.resolve().then(() => { operation.assertCurrent(); return run(operation); }).then(view => {
      if (!active) return;
      if (!operation.current()) { operation.cancel(); return; }
      const released = release(); resolve(view); clear(released.handle);
    }, error => {
      if (!active) return;
      if (!operation.current()) { operation.cancel(); return; }
      const released = release(); reject(error); clear(released.handle);
    });
    return promise;
  }

  private noteExecutionNotification(threadId: string, before: ThreadExecutionProjection, after: ThreadExecutionProjection, method: string, params: unknown): void {
    const settings = method === "thread/settings/updated" && isRecord(params) && isRecord(params.threadSettings) ? params.threadSettings : null;
    const keys = (Object.keys(after) as (keyof ThreadExecutionProjection)[]).filter(key => {
      const input = key === "reasoningEffort" ? "effort" : key === "sandbox" ? "sandboxPolicy" : key;
      return before[key] !== after[key] || (settings !== null && Object.hasOwn(settings, input) && Object.is(after[key], settings[input]));
    });
    if (keys.length === 0) return;
    const revisions = this.executionFieldRevisions.get(threadId) ?? new Map<keyof ThreadExecutionProjection, number>();
    const revision = ++this.executionNotificationRevision;
    for (const key of keys) revisions.set(key, revision);
    this.executionFieldRevisions.set(threadId, revisions);
  }

  private preserveLiveExecution(threadId: string, since: number, current: ThreadExecutionProjection, projected: ThreadExecutionProjection): ThreadExecutionProjection {
    return Object.fromEntries(Object.entries(projected).map(([key, value]) => [key,
      (this.executionFieldRevisions.get(threadId)?.get(key as keyof ThreadExecutionProjection) ?? 0) > since
        ? current[key as keyof ThreadExecutionProjection] : value,
    ])) as unknown as ThreadExecutionProjection;
  }

  private executionFromRead(threadId: string, generation: number, metadata: AppServerThread, current: ThreadExecutionProjection): ThreadExecutionProjection {
    if (this.activatedGenerations.get(threadId) === generation && this.ctx.threadStreamOwnership.get(threadId)?.role === "owner") return current;
    const observed = this.executionFieldRevisions.get(threadId);
    return { ...current,
      model: observed?.has("model") ? current.model : typeof metadata.model === "string" ? metadata.model : current.model,
      modelProvider: observed?.has("modelProvider") ? current.modelProvider : typeof metadata.modelProvider === "string" ? metadata.modelProvider : current.modelProvider,
      cwd: observed?.has("cwd") ? current.cwd : metadata.cwd ?? current.cwd,
      reasoningEffort: observed?.has("reasoningEffort") ? current.reasoningEffort : metadata.reasoningEffort ?? current.reasoningEffort,
    };
  }

  private resumeRejection(options: Pick<ResumeThreadOptions, "threadId" | "retryRejected">): Error | undefined {
    if (options.retryRejected) this.rejectedResumes.delete(options.threadId);
    else {
      const rejected = this.rejectedResumes.get(options.threadId);
      if (rejected?.generation === this.client.connectionGeneration) return rejected.error;
      if (rejected !== undefined) this.rejectedResumes.delete(options.threadId);
    }
  }

  /** Prepare execution only. History Read keeps its own owner and source;
   * activation does not allocate a preview, buffer or hydration strategy. */
  activate(options: Pick<ResumeThreadOptions, "threadId" | "signal" | "retryRejected" | "force">): Promise<void> {
    if (this.disposed || options.signal?.aborted) return Promise.reject(historyAborted());
    for (;;) {
      const existing = this.activations.get(options.threadId);
      if (existing) {
        if (existing.current()) return waitForHistory(existing.promise, options.signal);
        existing.cancel(); continue;
      }
      const historical = this.inFlight.get(options.threadId);
      if (historical) {
        if (historical.current()) return waitForHistory(historical.promise, options.signal).then(() => undefined);
        historical.cancel(); continue;
      }
      break;
    }
    const rejected = this.resumeRejection(options);
    if (rejected) return Promise.reject(rejected);
    return this.startHistoryOperation(this.activations, options.threadId, options.signal,
      async operation => { await this.resumeOnce(options, operation, "execution"); });
  }

  resume(options: ResumeThreadOptions): Promise<ThreadView> {
    if (this.disposed || options.signal?.aborted) return Promise.reject(historyAborted());
    for (;;) {
      const existing = this.baselineOperation(options.threadId);
      if (existing?.kind === "read") return waitForHistory(existing.operation.promise, options.signal).then(() => this.resume(options));
      if (existing) return waitForHistory(existing.operation.promise, options.signal);
      const activation = this.activations.get(options.threadId);
      if (activation) {
        if (activation.current()) return waitForHistory(activation.promise, options.signal).then(() => this.resume(options));
        activation.cancel(); continue;
      }
      break;
    }
    const rejected = this.resumeRejection(options);
    if (rejected) return Promise.reject(rejected);
    return this.startHistoryOperation(this.inFlight, options.threadId, options.signal,
      operation => this.resumeOnce(options, operation), true);
  }

  /** Open presentation history without acquiring an execution stream or model. */
  read(threadId: string, options: Pick<ResumeThreadOptions, "historyCheckpoint" | "unresolvedTurnIds" | "signal"> = {}): Promise<ThreadView> {
    if (this.disposed || options.signal?.aborted) return Promise.reject(historyAborted());
    const existing = this.baselineOperation(threadId);
    if (existing) return waitForHistory(existing.operation.promise, options.signal);
    return this.startHistoryOperation(this.reads, threadId, options.signal, async operation => {
      this.retireHistoryContext(threadId);
      this.ctx.resumeNotificationBuffer.begin(threadId);
      const deadline = this.readClock.now() + this.requestTimeoutMs;
      try {
        let view = await this.readOnce(threadId, options, operation);
        // History notifications and native snapshots lack a shared sequence: obtain a quiet
        // canonical cut, preserving admitted requests across rereads.
        operation.assertCurrent();
        while (this.ctx.resumeNotificationBuffer.hasSnapshotOverlap(threadId)) {
          if (this.requestTimeoutMs > 0 && Number.isFinite(this.requestTimeoutMs)) operation.limitUntil(deadline,
            new AppServerClientError("TIMEOUT", `History loading timed out after ${this.requestTimeoutMs} ms; retry the read`));
          operation.assertCurrent();
          this.ctx.resumeNotificationBuffer.supersedeNotifications(threadId);
          view = await this.readOnce(threadId, { ...options, historyCheckpoint: null }, operation, true);
          operation.assertCurrent();
        }
        this.ctx.resumeNotificationBuffer.release(threadId);
        operation.assertCurrent();
        return this.ctx.threadViews.get(threadId) ?? view;
      } catch (error) {
        if (operation.current()) this.ctx.resumeNotificationBuffer.discard(threadId, error instanceof Error ? error : new Error(String(error)));
        throw error;
      }
    }, true);
  }

  private async readOnce(threadId: string, options: Pick<ResumeThreadOptions, "historyCheckpoint" | "unresolvedTurnIds">, operation: HistoryOperation, reread = false): Promise<ThreadView> {
    operation.assertCurrent();
    const initial = this.ctx.threadViews.getOrCreate(threadId);
    operation.assertCurrent();
    const generation = this.client.connectionGeneration;
    const readCapability = executionEngineExtension(this.client.initializeResult?.capabilities?.extensions,
      threadId, "opencraft/read-history");
    const supportsWindow = readCapability?.version === 1 && readCapability.initialTurnsPage !== false;
    const requestRead = (window: boolean) => this.client.request("thread/read", { threadId, includeTurns: false,
      ...(readCapability?.version === 1 ? { watch: true } : {}),
      ...(window ? { initialTurnsPage: { limit: readCapability?.itemDetails === true ? 1 : 10, itemsView: readCapability?.itemDetails === true ? "presentation" as const : "full" as const, sortDirection: "desc" as const } } : {}),
      ...(readCapability?.boundedRecovery === true && options.historyCheckpoint ? { historyCheckpoint: options.historyCheckpoint } : {}),
    }, { timeoutMs: this.requestTimeoutMs, priority: "user-visible", signal: operation.signal, historySource: reread ? "snapshot-reread" : "open" });
    let result;
    try { result = await requestRead(supportsWindow); }
    catch (error) {
      if (!supportsWindow || !isHistoryResponseTooLargeError(error)) throw error;
      result = await requestRead(false);
    }
    operation.assertCurrent();
    const metadata = requireThread(result.thread, "thread/read");
    if (metadata.id !== threadId) throw new Error("thread/read returned an unexpected Thread");
    const mode = metadata.historyMode ?? this.historyModeHint;
    const paginated = mode === "paginated" || mode === "message-window";
    const recovery = result.historyRecovery;
    if (recovery && (typeof recovery.checkpoint?.epoch !== "string" || !Number.isSafeInteger(recovery.checkpoint.nextSeq)
      || recovery.checkpoint.nextSeq < 0 || !["unchanged", "append", "replace"].includes(recovery.mode))) throw new Error("Invalid read history checkpoint");
    const context = { signal: operation.signal, client: this.client, threadId, requestTimeoutMs: this.requestTimeoutMs };
    const page = result.initialTurnsPage ?? (paginated ? await readTurnsPage(context, null) : null);
    let turns: readonly import("@opencraft/appserver-protocol").AppServerTurn[] = page ? [...page.data].reverse() : requireThread((await this.client.request("thread/read", {
      threadId, includeTurns: true,
    }, { timeoutMs: this.requestTimeoutMs, priority: "user-visible", signal: operation.signal })).thread, "thread/read").turns;
    operation.assertCurrent();
    if (page) turns = await hydrateReadTurnItems(context, turns.map(turn => turn.itemsView === undefined && supportsWindow ? { ...turn, itemsView: "full" as const } : turn));
    operation.assertCurrent();
    if (this.disposed) throw new Error("Thread reader was disposed");
    const detailGeneration = ++historyDetailReadGeneration;
    this.readContexts.set(threadId, { generation, hydrateItems: !supportsWindow });
    return this.ctx.threadViews.update(threadId, current => ({
      ...current, thread: { ...metadata, historyTurnCount: page?.totalTurnCount ?? metadata.historyTurnCount }, connectionGeneration: generation,
      resumeState: current.connectionGeneration === generation ? current.resumeState : "needs_resume",
      turns: tagHistoryDetails(recovery?.mode === "unchanged" ? current.turns : recovery?.mode === "append"
        ? reconcileHistoryTurns(current.turns, turns, "latest", { baselineTurns: initial.turns })
        : reconcileRecoveryWindow(current.turns, turns, initial.turns, options.unresolvedTurnIds), detailGeneration),
      historyMode: mode ?? "legacy",
      ...(recovery ? { historyCheckpoint: recovery.checkpoint } : { historyCheckpoint: undefined }),
      historySource: paginated ? "paginated" : "thread-read-fallback",
      tailHydrationComplete: recovery && recovery.mode !== "replace" ? initial.tailHydrationComplete : page?.nextCursor == null,
      turnsPagination: recovery && recovery.mode !== "replace" ? initial.turnsPagination : { olderCursor: page?.nextCursor ?? null, oldestLoadedTurnId: turns[0]?.id ?? null,
        hasLoadedOldest: page?.nextCursor == null, isLoadingOlder: false },
      execution: this.executionFromRead(threadId, generation, metadata, current.execution),
      resumeError: null, historyError: null,
    }));
  }

  /** A successful fork already owns a live stream; an ephemeral fork has no rollout to Resume. */
  adoptFork(response: ThreadForkResponse, generation: number): ThreadView {
    this.ensureGeneration(generation);
    const thread = requireThread(response.thread, "thread/fork");
    const baseline = requireResumeResponse({ ...response, thread }, thread.id);
    this.rejectedResumes.delete(thread.id);
    this.ctx.threadStreamOwnership.set(thread.id, { role: "owner" });
    const view = this.ctx.threadViews.update(thread.id, current => ({
      ...this.ctx.threadResumeProjectors.project(current, { metadata: thread, response: baseline }),
      connectionGeneration: generation,
      resumeState: "resumed",
      streamRole: { role: "owner" },
      turns: mergeTurns(thread.turns, current.turns),
      historySource: "fork",
      tailHydrationComplete: true,
      turnsPagination: { olderCursor: null, oldestLoadedTurnId: thread.turns[0]?.id ?? null, isLoadingOlder: false, hasLoadedOldest: true },
      resumeError: null,
      historyError: null,
    }));
    this.ctx.resumeNotificationBuffer.release(thread.id);
    this.activatedGenerations.set(thread.id, generation);
    return view;
  }

  setStreamRole(threadId: string, role: ThreadStreamRole | null): ThreadView {
    // An ownership notification alone does not provide execution metadata.
    this.activatedGenerations.delete(threadId);
    this.ctx.threadStreamOwnership.set(threadId, role);
    return this.ctx.threadViews.update(threadId, (current) => ({ ...current, streamRole: role }));
  }

  markNeedsResume(threadId: string): ThreadView {
    this.retireHistoryContext(threadId);
    return this.ctx.threadViews.update(threadId, (current) => ({
      ...current,
      resumeState: "needs_resume",
    }));
  }

  /** A confirmed lifecycle change may make a previously rejected Thread resumable. */
  clearResumeRejection(threadId: string): void {
    this.rejectedResumes.delete(threadId);
  }

  /** Drop presentation/history ownership after the last runtime consumer.
   * Background history checks its operation identity before publishing, so
   * deleting it also fences an old drain from recreating an evicted View. */
  release(threadId: string): void {
    if (this.inFlight.has(threadId) || this.reads.has(threadId) || this.activations.has(threadId)) throw new Error("Cannot release a loading Thread");
    this.activatedGenerations.delete(threadId);
    this.executionFieldRevisions.delete(threadId);
    this.retireHistoryContext(threadId);
    this.previewTokens.delete(threadId);
    this.ctx.resumeNotificationBuffer.discard(threadId);
    this.ctx.threadStreamOwnership.set(threadId, null);
    this.ctx.threadViews.remove(threadId);
  }

  async resumeAll(options: (view: ThreadView) => Omit<ResumeThreadOptions, "threadId"> = () => ({})): Promise<readonly ThreadView[]> {
    return Promise.all(this.ctx.threadViews.getAll().map((view) => this.resume({
      threadId: view.threadId,
      ...options(view),
    })));
  }

  waitForBackgroundHistory(threadId: string): Promise<void> {
    return this.backgroundHistory.get(threadId)?.promise.catch(() => undefined) ?? Promise.resolve();
  }

  private derivedPorts(threadId: string): DerivedHistoryPorts {
    return { client: this.client, views: this.ctx.threadViews, strategies: this.ctx.threadHistoryStrategies,
      requestTimeoutMs: this.requestTimeoutMs,
      source: () => this.readContexts.get(threadId) ?? this.historyContexts.get(threadId) ?? null };
  }

  /** Refresh history only; never Resume or reclaim execution. */
  refreshHistory(threadId: string, signal?: AbortSignal): Promise<boolean> {
    if (this.disposed || signal?.aborted) return Promise.resolve(false);
    let older: Promise<ThreadView> | undefined;
    for (;;) {
      const existing = this.historyRefreshes.get(threadId);
      if (existing) {
        if (!existing.current()) { existing.cancel(); continue; }
        if (!signal) return existing.promise;
        return waitForHistory(existing.promise, signal).catch(error => {
          if (error instanceof AppServerClientError && error.code === "ABORTED") return false;
          throw error;
        });
      }
      const predecessor = this.olderPageRequests.get(threadId);
      if (predecessor && !predecessor.current()) { predecessor.cancel(); continue; }
      older = predecessor?.promise; break;
    }
    return this.startHistoryOperation(this.historyRefreshes, threadId, signal, async operation => {
      await older?.catch(() => undefined);
      operation.assertCurrent();
      const module = await import("./derived-history");
      operation.assertCurrent();
      return module.refreshDerivedHistory(this.derivedPorts(threadId), threadId, operation);
    }, false, () => false);
  }

  /** Hydrate just the requested Items, retaining every live replacement and
   * the history source/epoch that admitted the preview. No execution Resume. */
  async loadItemDetails(threadId: string, itemIds: readonly string[], signal?: AbortSignal): Promise<void> {
    // Each disclosure owns its own cancellation. Identical native work may
    // still coalesce at the Host, which already tracks independent waiters.
    const slots = new Map<string, HistoryOperation<void>>();
    const pending = this.startHistoryOperation(slots, threadId, signal, async operation => {
      const source = this.readContexts.get(threadId) ?? this.historyContexts.get(threadId);
      const baseline = this.ctx.threadViews.get(threadId);
      if (!source || !baseline) return;
      const requested = new Set(itemIds);
      for (const turn of baseline.turns) for (const item of turn.items ?? []) {
        if (!requested.has(item.id) || !item.historyDetail) continue;
        operation.assertCurrent();
        const page = await this.client.request("thread/turns/list", {
          threadId, cursor: item.historyDetail.cursor, detailItemId: item.id,
          limit: 1, itemsView: "full", sortDirection: "desc",
        }, { timeoutMs: this.requestTimeoutMs, priority: "user-visible", signal: operation.signal });
        operation.assertCurrent();
        if ((this.readContexts.get(threadId) ?? this.historyContexts.get(threadId)) !== source) throw historyAborted();
        const fullTurn = page.data[0], full = fullTurn?.items?.find(candidate => candidate.id === item.id);
        if (fullTurn?.id !== turn.id || !full || full.historyDetail) throw new Error("History Item detail is unavailable");
        this.ctx.threadViews.update(threadId, view => ({ ...view, turns: view.turns.map(current => current.id !== turn.id ? current : {
          ...current, items: current.items?.map(candidate => candidate === item ? { ...full, ...Object.fromEntries(["startedAtMs", "completedAtMs"].flatMap(key => full[key] == null && item[key] != null ? [[key, item[key]]] : [])) } : candidate),
        }) }));
      }
    });
    const operation = slots.get(threadId);
    if (operation) {
      const requests = this.itemDetailRequests.get(threadId) ?? new Set<HistoryOperation<void>>();
      this.itemDetailRequests.set(threadId, requests); requests.add(operation);
      void pending.finally(() => {
        requests.delete(operation);
        if (!requests.size && this.itemDetailRequests.get(threadId) === requests) this.itemDetailRequests.delete(threadId);
      }).catch(() => {});
    }
    return pending;
  }

  loadOlder(threadId: string, signal?: AbortSignal): Promise<ThreadView> {
    if (this.disposed || signal?.aborted) return Promise.reject(historyAborted());
    let refreshing: Promise<boolean> | undefined;
    for (;;) {
      const existing = this.olderPageRequests.get(threadId);
      if (existing) {
        if (!existing.current()) { existing.cancel(); continue; }
        return waitForHistory(existing.promise, signal);
      }
      const predecessor = this.historyRefreshes.get(threadId);
      if (predecessor && !predecessor.current()) { predecessor.cancel(); continue; }
      refreshing = predecessor?.promise; break;
    }
    return this.startHistoryOperation(this.olderPageRequests, threadId, signal, async operation => {
      await refreshing?.catch(() => false);
      operation.assertCurrent();
      const module = await import("./derived-history");
      operation.assertCurrent();
      return module.loadOlderHistory(this.derivedPorts(threadId), threadId, operation);
    });
  }

  private async resumeOnce<T>(options: ResumeThreadOptions, operation: HistoryOperation<T>, purpose: "history" | "execution" = "history"): Promise<ThreadView> {
    operation.assertCurrent();
    const threadId = options.threadId, presentation = purpose === "history";
    const executionRevision = this.executionNotificationRevision;
    const initial = presentation ? this.ctx.threadViews.getOrCreate(threadId) : this.ctx.threadViews.get(threadId);
    if (!initial) throw new Error(`Thread ${threadId} has no loaded baseline for execution activation`);
    operation.assertCurrent();
    const currentRole = this.ctx.threadStreamOwnership.get(threadId);
    if (!options.force && currentRole !== null && (presentation
      ? initial.resumeState === "resumed" && initial.connectionGeneration === this.client.connectionGeneration
      : currentRole.role === "follower" || this.activatedGenerations.get(threadId) === this.client.connectionGeneration)) return initial;

    if (presentation) this.retireHistoryContext(threadId);
    let provisionalRole: ThreadStreamRole | null = null;
    const revokeProvisionalRole = () => {
      if (provisionalRole && this.ctx.threadStreamOwnership.get(threadId) === provisionalRole)
        this.ctx.threadStreamOwnership.set(threadId, null);
    };
    operation.onCancel = () => {
      revokeProvisionalRole();
      if (!this.disposed && this.ctx.threadViews.get(threadId)) this.ctx.threadViews.update(threadId, current => ({
        ...current, ...(presentation ? { resumeState: "needs_resume" as const } : {}), streamRole: this.ctx.threadStreamOwnership.get(threadId),
      }));
    };
    if (presentation) this.ctx.threadViews.update(threadId, (current) => ({
      ...current,
      resumeState: "resuming",
      streamRole: currentRole,
      resumeError: null,
      historyError: null,
    }));
    operation.assertCurrent();
    if (presentation) this.ctx.resumeNotificationBuffer.begin(threadId);
    const generation = this.client.connectionGeneration;
    let metadata: AppServerThread | null = initial.thread;
    try {
      if (metadata === null && this.historyModeHint === null) {
        try {
          const read = await this.client.request("thread/read", {
            threadId,
            includeTurns: false,
          }, { timeoutMs: this.requestTimeoutMs, priority: "user-visible", signal: operation.signal });
          metadata = requireThread(read.thread, "thread/read");
        } catch {
          operation.assertCurrent();
          metadata = null;
        }
      }

      operation.assertCurrent();
      const roleAfterRead = this.ctx.threadStreamOwnership.get(threadId);
      if (roleAfterRead?.role === "follower") {
        if (!presentation) return this.ctx.threadViews.get(threadId) ?? initial;
        const followerView = this.ctx.threadViews.update(threadId, (current) => ({
          ...current,
          thread: metadata ?? current.thread,
          historyMode: metadata?.historyMode ?? this.historyModeHint ?? current.historyMode,
          connectionGeneration: generation,
          resumeState: "resumed",
          streamRole: roleAfterRead,
        }));
        operation.assertCurrent();
        this.ctx.resumeNotificationBuffer.release(threadId);
        return followerView;
      }

      if (roleAfterRead === null) {
        this.ctx.threadStreamOwnership.set(threadId, { role: "owner" });
        provisionalRole = this.ctx.threadStreamOwnership.get(threadId);
      }

      const engineHistory = executionEngineExtension(this.client.initializeResult?.capabilities?.extensions, threadId, OPENCRAFT_RESUME_HISTORY_EXTENSION);
      const historyMode = metadata?.historyMode ?? engineHistory?.mode ?? this.historyModeHint ?? initial.historyMode;
      const isDurableHost = this.hostKind === "durable" && engineHistory?.mode !== "legacy";
      const supportsPaginatedHistory = this.useTailHydration
        && this.hostKind !== "durable"
        && historyMode === "paginated"
        && this.supportsPaginatedHistory;
      const capability = engineHistory as {
        version?: unknown; initialTurnsPage?: unknown; boundedRecovery?: unknown;
      } | undefined;
      const supportsMergedPage = capability?.version === 1 && capability.initialTurnsPage === true;
      const supportsBoundedRecovery = presentation && supportsMergedPage && capability?.boundedRecovery === true;
      const requestedCheckpoint = options.historyCheckpoint === undefined
        ? initial.historyCheckpoint : options.historyCheckpoint ?? undefined;
      const historyRequest: ReturnType<typeof buildResumeHistoryRequest> = presentation ? buildResumeHistoryRequest({
        useTailHydration: this.useTailHydration,
        isDurableHost,
        supportsPaginatedHistory,
        supportsInitialTurnsPage: supportsMergedPage,
      }) : { excludeTurns: true };
      const {
        threadId: _ignoredThreadId,
        history: _ignoredHistory,
        historyCheckpoint: _ignoredCheckpoint,
        path: _ignoredPath,
        excludeTurns: _ignoredExcludeTurns,
        initialTurnsPage: _ignoredInitialTurnsPage,
        ...safeRequestOverrides
      } = options.requestOverrides ?? {};
      const params: ThreadResumeParams = {
        ...safeRequestOverrides,
        threadId,
        history: options.history ?? null,
        path: options.path === undefined ? metadata?.path ?? initial.thread?.path ?? null : options.path,
        model: options.model ?? null,
        modelProvider: options.modelProvider
          ?? initial.execution.modelProvider
          ?? (typeof metadata?.modelProvider === "string" ? metadata.modelProvider : null),
        cwd: options.cwd ?? initial.execution.cwd ?? metadata?.cwd ?? null,
        ...(options.serviceTier === undefined ? {} : { serviceTier: options.serviceTier }),
        ...(options.approvalPolicy === undefined ? {} : { approvalPolicy: options.approvalPolicy }),
        ...(options.approvalsReviewer === undefined ? {} : { approvalsReviewer: options.approvalsReviewer }),
        ...(options.permissions === undefined ? {} : {
          permissions: options.permissions,
          runtimeWorkspaceRoots: options.runtimeWorkspaceRoots ?? [],
        }),
        ...(options.permissions === undefined && options.sandbox !== undefined ? { sandbox: options.sandbox } : {}),
        ...(options.config === undefined ? {} : { config: options.config }),
        ...(options.baseInstructions === undefined ? {} : { baseInstructions: options.baseInstructions }),
        ...(options.developerInstructions === undefined ? {} : { developerInstructions: options.developerInstructions }),
        ...(options.personality === undefined ? {} : { personality: options.personality }),
        ...historyRequest,
        ...(supportsBoundedRecovery && requestedCheckpoint
          ? { historyCheckpoint: requestedCheckpoint } : {}),
        ...(presentation && historyMode === "message-window" ? {
          historyPreviewToken: `${generation}:${++this.previewSequence}`,
        } : {}),
      };
      if (typeof params.historyPreviewToken === "string") this.previewTokens.set(threadId, params.historyPreviewToken);
      const requestResume = (request: ThreadResumeParams) => this.client.request("thread/resume", request, {
        // The message-window provider owns independent gateway and HTTP-idle
        // deadlines. An outer wall-clock limit would cancel a healthy body
        // download merely because its transport is slow.
        // Execution activation can join native tool retirement (up to 90s).
        // Its budget must cover that preflight; ordinary history keeps its
        // independent read deadline and explicit unlimited budgets stay so.
        timeoutMs: historyMode === "message-window" ? 0 : !presentation && this.requestTimeoutMs > 0
          ? Math.max(this.requestTimeoutMs, 120_000) : this.requestTimeoutMs,
        priority: "user-blocking", signal: operation.signal,
      });
      let resumed: Awaited<ReturnType<typeof requestResume>>;
      try {
        resumed = await requestResume(params);
      } catch (error) {
        if (!params.initialTurnsPage || !isHistoryResponseTooLargeError(error)) throw error;
        operation.assertCurrent();
        // A merged window can exceed a transport limit. Resume without the
        // window, then let the normal adaptive history reader fetch it.
        const { initialTurnsPage: _oversizedPage, ...withoutPage } = params;
        resumed = await requestResume(withoutPage);
      }
      const response = requireResumeResponse(resumed, threadId);
      operation.assertCurrent();
      if (!presentation) {
        const current = this.ctx.threadViews.get(threadId);
        const execution = current ? this.ctx.threadResumeProjectors.project(current, { metadata: response.thread, response }).execution : null;
        operation.assertCurrent();
        // The ACK grants execution readiness, not authority over a newer read.
        // Apply only execution fields to the current View; never revive a View.
        this.ctx.threadStreamOwnership.set(threadId, { role: "owner" });
        if (execution && this.ctx.threadViews.get(threadId)) this.ctx.threadViews.update(threadId, view => ({
          ...view,
          execution: this.preserveLiveExecution(threadId, executionRevision, view.execution, execution),
          resumeState: "resumed", streamRole: this.ctx.threadStreamOwnership.get(threadId),
        }));
        operation.assertCurrent();
        provisionalRole = null;
        this.activatedGenerations.set(threadId, generation);
        this.rejectedResumes.delete(threadId);
        return this.ctx.threadViews.get(threadId) ?? initial;
      }
      const recovery = supportsBoundedRecovery ? response.historyRecovery : undefined;
      if (recovery && (typeof recovery.checkpoint?.epoch !== "string" || !Number.isSafeInteger(recovery.checkpoint.nextSeq)
        || recovery.checkpoint.nextSeq < 0 || !["unchanged", "append", "replace"].includes(recovery.mode))) {
        throw new Error("Invalid provider history recovery checkpoint");
      }

      const historyContext: ResumeHistoryContext = {
        signal: operation.signal,
        client: this.client,
        threadId,
        response,
        metadata,
        useTailHydration: this.useTailHydration,
        isDurableHost,
        supportsPaginatedHistory,
        supportsInitialTurnsPage: historyRequest.initialTurnsPage !== undefined,
        pageSize: this.pageSize,
        requestTimeoutMs: this.requestTimeoutMs,
      };
      // The provider already proved that our authoritative transcript still
      // matches its head. Do not re-read every Turn or replay the history stage
      // merely to discard that identical payload.
      const history: HydratedThreadHistory = recovery?.mode === "unchanged" ? {
        source: initial.historySource ?? "paginated",
        turns: [],
        complete: initial.tailHydrationComplete,
        olderCursor: initial.turnsPagination.olderCursor,
        itemsPaginationByTurnId: initial.itemsPaginationByTurnId,
      } : await this.ctx.threadHistoryStrategies.load(historyContext);
      operation.assertCurrent();
      const { signal: _operationSignal, ...committedContext } = historyContext;
      this.historyContexts.set(threadId, committedContext);
      this.readContexts.delete(threadId);

      const committed = this.ctx.threadViews.update(threadId, (current) => {
        const projected = this.ctx.threadResumeProjectors.project(current, { metadata, response });
        operation.assertCurrent();
        if (recovery && recovery.mode !== "replace" && (!requestedCheckpoint
          || requestedCheckpoint.epoch !== recovery.checkpoint.epoch
          || recovery.checkpoint.nextSeq < requestedCheckpoint.nextSeq
          || (recovery.mode === "unchanged" && (recovery.checkpoint.nextSeq !== requestedCheckpoint.nextSeq || history.turns.length !== 0)))) {
          throw new Error("History recovery does not cover the requested checkpoint");
        }
        const preserveRange = recovery?.mode === "unchanged" || recovery?.mode === "append";
        const turns = recovery?.mode === "unchanged" ? current.turns
          : recovery?.mode === "replace" ? reconcileRecoveryWindow(projected.turns, history.turns, initial.turns, options.unresolvedTurnIds)
          : history.source === "message-window"
          ? reconcileHistoryWindow(projected.turns, history.turns, initial.turns)
          : reconcileHistoryTurns(projected.turns, history.turns, "latest");
        const oldestLoadedTurnId = turns[0]?.id ?? null;
        return {
          ...projected,
          execution: this.preserveLiveExecution(threadId, executionRevision, current.execution, projected.execution),
          connectionGeneration: generation,
          resumeState: "resumed",
          streamRole: { role: "owner" },
          turns,
          historySource: history.source,
          historyCheckpoint: recovery?.checkpoint,
          tailHydrationComplete: preserveRange ? initial.tailHydrationComplete : history.complete,
          turnsPagination: preserveRange ? { ...initial.turnsPagination, isLoadingOlder: false } : {
            olderCursor: history.olderCursor,
            oldestLoadedTurnId,
            isLoadingOlder: false,
            hasLoadedOldest: history.complete,
          },
          itemsPaginationByTurnId: recovery?.mode === "unchanged" ? initial.itemsPaginationByTurnId
            : preserveRange ? { ...initial.itemsPaginationByTurnId, ...history.itemsPaginationByTurnId } : history.itemsPaginationByTurnId,
          resumeError: null,
          historyError: null,
        };
      });
      operation.assertCurrent();
      provisionalRole = null;
      this.ctx.threadStreamOwnership.set(threadId, { role: "owner" });
      this.activatedGenerations.set(threadId, generation);
      this.rejectedResumes.delete(threadId);
      this.ctx.resumeNotificationBuffer.release(threadId);
      operation.assertCurrent();
      if (this.drainTailHistory && history.drainRemaining !== undefined) {
        this.startBackgroundDrain(threadId, generation, history);
      }
      return committed;
    } catch (error) {
      if (!operation.current()) throw historyAborted();
      const failure = error instanceof Error ? error : new Error(String(error));
      // Only an explicitly retryable rejection may be reissued in this generation.
      // Other rejections still require explicit retry or a new connection.
      if (failure instanceof AppServerRpcError && generation === this.client.connectionGeneration
        && !isRetryableAppServerRpcError(failure)) {
        this.rejectedResumes.set(threadId, { generation, error: failure });
      }
      revokeProvisionalRole();
      if (this.ctx.threadViews.get(threadId)) this.ctx.threadViews.update(threadId, (current) => ({
        ...current,
        ...(presentation ? { resumeState: "needs_resume" as const, resumeError: failure } : {}),
        streamRole: this.ctx.threadStreamOwnership.get(threadId),
      }));
      if (presentation && operation.current()) this.ctx.resumeNotificationBuffer.release(threadId);
      throw failure;
    } finally {
      if (presentation && operation.current()) this.previewTokens.delete(threadId);
    }
  }

  private startBackgroundDrain(threadId: string, generation: number, history: HydratedThreadHistory): void {
    if (this.disposed || generation !== this.client.connectionGeneration) return;
    this.backgroundHistory.get(threadId)?.cancel();
    const operation = this.startHistoryOperation(this.backgroundHistory, threadId, undefined, async owner => {
      const module = await import("./derived-history");
      owner.assertCurrent();
      return module.drainHistory(this.derivedPorts(threadId), threadId, owner, history);
    });
    void operation.catch(() => undefined);
  }

  private ensureGeneration(expected: number): void {
    if (this.client.connectionGeneration !== expected) {
      throw new Error(`Stale Resume generation ${expected}; current generation is ${this.client.connectionGeneration}`);
    }
  }
}
