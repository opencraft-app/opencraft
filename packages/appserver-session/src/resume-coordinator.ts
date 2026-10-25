import { executionEngineExtension } from "@opencraft/appserver-client";
import { Context, Service } from "@deepseek-ai/cordis";
import { AppServerClientError, AppServerRpcError, isRetryableAppServerRpcError, isHistoryResponseTooLargeError, type AppServerClient } from "@opencraft/appserver-client";
import { OPENCRAFT_RESUME_HISTORY_EXTENSION, buildResumeHistoryRequest, type AppServerThread, type ThreadHistoryCheckpoint, type ThreadResumeParams, type ThreadResumeResponse, type ThreadForkResponse } from "@opencraft/appserver-protocol";

import type { HydratedThreadHistory, ResumeHistoryContext } from "./history-strategies";
import { hydrateReadTurnItems, readTurnsPage } from "./history-strategies";
import { mergeTurns, reconcileHistoryTurns, reconcileHistoryWindow, reconcileRecoveryWindow } from "./merge-turns";
import type { ThreadStreamRole, ThreadView } from "./models";
import { resolveThreadId } from "./notification-buffer";
import type { ThreadViewFrameScheduler } from "./view-store";

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
  requestTimeoutMs?: number;
  drainTailHistory?: boolean;
  frameScheduler?: ThreadViewFrameScheduler;
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

interface HistoryOperation {
  readonly promise: Promise<ThreadView>;
  readonly signal: AbortSignal;
  current(): boolean;
  assertCurrent(): void;
  cancel(): void;
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
  private readonly drainTailHistory: boolean;
  private readonly inFlight = new Map<string, HistoryOperation>();
  private readonly reads = new Map<string, HistoryOperation>();
  private readonly readContexts = new Map<string, { generation: number; hydrateItems: boolean }>();
  private readonly rejectedResumes = new Map<string, { generation: number; error: AppServerRpcError }>();
  private readonly historyContexts = new Map<string, ResumeHistoryContext>();
  private readonly backgroundHistory = new Map<string, Promise<void>>();
  private readonly olderPageRequests = new Map<string, Promise<ThreadView>>();
  private readonly historyRefreshes = new Map<string, Promise<boolean>>();
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
      const project = (current: ThreadView) => ctx.threadNotificationProjectors.project(current, notification);
      const params = notification.params as Record<string, unknown> | null;
      if (TEXT_DELTA_METHODS.has(notification.method) && typeof params?.delta === "string") {
        ctx.threadViews.queueProjection(threadId, this.client.connectionGeneration, project, params.delta.length * 2);
      } else {
        // Lifecycle/replacement/unknown notifications are ordered flush barriers.
        ctx.threadViews.update(threadId, project);
      }
    });
    const removeStatus = this.client.subscribeStatus((status) => {
      if (status.state !== "closed" && status.state !== "failed") return;
      for (const operation of [...this.inFlight.values(), ...this.reads.values()]) operation.cancel();
      this.rejectedResumes.clear();
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
      for (const operation of [...this.inFlight.values(), ...this.reads.values()]) operation.cancel();
      this.inFlight.clear();
      this.reads.clear();
      this.readContexts.clear();
      this.rejectedResumes.clear();
      this.historyContexts.clear();
      this.backgroundHistory.clear();
      this.olderPageRequests.clear();
      this.historyRefreshes.clear();
      this.previewTokens.clear();
    });
  }

  /** A fresh baseline revokes the previous source's derived readers even
   * when the physical client generation is unchanged. Cached paint survives. */
  private retireHistoryContext(threadId: string): void {
    this.readContexts.delete(threadId);
    this.historyContexts.delete(threadId);
    this.backgroundHistory.delete(threadId);
    this.olderPageRequests.delete(threadId);
    this.historyRefreshes.delete(threadId);
  }

  /** Install the owner before I/O or observers. Revocation releases local
   * admission and settles callers before aborting potentially reentrant children. */
  private startHistoryOperation(
    slots: Map<string, HistoryOperation>, threadId: string, signal: AbortSignal | undefined,
    run: (operation: HistoryOperation) => Promise<ThreadView>,
  ): Promise<ThreadView> {
    if (this.disposed || signal?.aborted) return Promise.reject(historyAborted());
    const generation = this.client.connectionGeneration;
    const controller = new AbortController();
    let active = true;
    let resolve!: (view: ThreadView) => void, reject!: (error: unknown) => void;
    const promise = new Promise<ThreadView>((done, fail) => { resolve = done; reject = fail; });
    const release = () => {
      active = false;
      signal?.removeEventListener("abort", operation.cancel);
      if (slots.get(threadId) === operation) slots.delete(threadId);
    };
    const operation: HistoryOperation = {
      promise, signal: controller.signal,
      current: () => active && !signal?.aborted && !this.disposed && generation === this.client.connectionGeneration
        && slots.get(threadId) === operation,
      assertCurrent() { if (!this.current()) throw historyAborted(); },
      cancel: () => {
        if (!active) return;
        release();
        reject(historyAborted());
        this.retireHistoryContext(threadId);
        this.previewTokens.delete(threadId);
        this.ctx.resumeNotificationBuffer.discard(threadId, historyAborted());
        operation.onCancel?.();
        controller.abort();
      },
    };
    slots.set(threadId, operation);
    signal?.addEventListener("abort", operation.cancel, { once: true });
    if (signal?.aborted) operation.cancel();
    void Promise.resolve().then(() => { operation.assertCurrent(); return run(operation); }).then(view => {
      if (!active) return;
      release(); resolve(view);
    }, error => {
      if (!active) return;
      release(); reject(error);
    });
    return promise;
  }

  resume(options: ResumeThreadOptions): Promise<ThreadView> {
    if (this.disposed || options.signal?.aborted) return Promise.reject(historyAborted());
    let reading = this.reads.get(options.threadId);
    if (reading && !reading.current()) { reading.cancel(); reading = undefined; }
    if (reading) return waitForHistory(reading.promise, options.signal).then(() => this.resume(options));
    let existing = this.inFlight.get(options.threadId);
    if (existing && !existing.current()) { existing.cancel(); existing = undefined; }
    if (existing !== undefined) return waitForHistory(existing.promise, options.signal);
    if (options.retryRejected) this.rejectedResumes.delete(options.threadId);
    else {
      const rejected = this.rejectedResumes.get(options.threadId);
      if (rejected?.generation === this.client.connectionGeneration) return Promise.reject(rejected.error);
      if (rejected !== undefined) this.rejectedResumes.delete(options.threadId);
    }
    return this.startHistoryOperation(this.inFlight, options.threadId, options.signal,
      operation => this.resumeOnce(options, operation));
  }

  /** Open presentation history without acquiring an execution stream or model. */
  read(threadId: string, options: Pick<ResumeThreadOptions, "historyCheckpoint" | "unresolvedTurnIds" | "signal"> = {}): Promise<ThreadView> {
    if (this.disposed || options.signal?.aborted) return Promise.reject(historyAborted());
    let existing = this.reads.get(threadId) ?? this.inFlight.get(threadId);
    if (existing && !existing.current()) { existing.cancel(); existing = undefined; }
    if (existing) return waitForHistory(existing.promise, options.signal);
    return this.startHistoryOperation(this.reads, threadId, options.signal, async operation => {
      this.retireHistoryContext(threadId);
      this.ctx.resumeNotificationBuffer.begin(threadId);
      const deadline = Date.now() + this.requestTimeoutMs;
      try {
        let view = await this.readOnce(threadId, options, operation);
        // Deltas and native snapshots lack a shared sequence: obtain a quiet
        // canonical cut, preserving admitted requests across rereads.
        operation.assertCurrent();
        while (this.ctx.resumeNotificationBuffer.hasDeltas(threadId)) {
          if (Date.now() >= deadline) throw new Error("History changed continuously while loading; retry the read");
          this.ctx.resumeNotificationBuffer.supersedeNotifications(threadId);
          view = await this.readOnce(threadId, { ...options, historyCheckpoint: null }, operation);
          operation.assertCurrent();
        }
        this.ctx.resumeNotificationBuffer.release(threadId);
        operation.assertCurrent();
        return this.ctx.threadViews.get(threadId) ?? view;
      } catch (error) {
        if (operation.current()) this.ctx.resumeNotificationBuffer.discard(threadId, error instanceof Error ? error : new Error(String(error)));
        throw error;
      }
    });
  }

  private async readOnce(threadId: string, options: Pick<ResumeThreadOptions, "historyCheckpoint" | "unresolvedTurnIds">, operation: HistoryOperation): Promise<ThreadView> {
    operation.assertCurrent();
    const initial = this.ctx.threadViews.getOrCreate(threadId);
    operation.assertCurrent();
    const generation = this.client.connectionGeneration;
    const readCapability = executionEngineExtension(this.client.initializeResult?.capabilities?.extensions,
      threadId, "opencraft/read-history");
    const supportsWindow = readCapability?.version === 1 && readCapability.initialTurnsPage !== false;
    const requestRead = (window: boolean) => this.client.request("thread/read", { threadId, includeTurns: false,
      ...(readCapability?.version === 1 ? { watch: true } : {}),
      ...(window ? { initialTurnsPage: { limit: 10, itemsView: "full" as const, sortDirection: "desc" as const } } : {}),
      ...(readCapability?.boundedRecovery === true && options.historyCheckpoint ? { historyCheckpoint: options.historyCheckpoint } : {}),
    }, { timeoutMs: this.requestTimeoutMs, priority: "user-visible", signal: operation.signal });
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
    this.readContexts.set(threadId, { generation, hydrateItems: !supportsWindow });
    return this.ctx.threadViews.update(threadId, current => ({
      ...current, thread: metadata, connectionGeneration: generation,
      resumeState: current.connectionGeneration === generation ? current.resumeState : "needs_resume",
      turns: recovery?.mode === "unchanged" ? current.turns : recovery?.mode === "append"
        ? reconcileHistoryTurns(current.turns, turns, "latest", { baselineTurns: initial.turns })
        : reconcileRecoveryWindow(current.turns, turns, initial.turns, options.unresolvedTurnIds),
      historyMode: mode ?? "legacy",
      ...(recovery ? { historyCheckpoint: recovery.checkpoint } : { historyCheckpoint: undefined }),
      historySource: paginated ? "paginated" : "thread-read-fallback",
      tailHydrationComplete: recovery && recovery.mode !== "replace" ? initial.tailHydrationComplete : page?.nextCursor == null,
      turnsPagination: recovery && recovery.mode !== "replace" ? initial.turnsPagination : { olderCursor: page?.nextCursor ?? null, oldestLoadedTurnId: turns[0]?.id ?? null,
        hasLoadedOldest: page?.nextCursor == null, isLoadingOlder: false },
      execution: { ...current.execution,
        model: typeof metadata.model === "string" ? metadata.model : current.execution.model,
        modelProvider: typeof metadata.modelProvider === "string" ? metadata.modelProvider : current.execution.modelProvider,
        cwd: metadata.cwd ?? current.execution.cwd,
        reasoningEffort: metadata.reasoningEffort ?? current.execution.reasoningEffort },
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
    return view;
  }

  setStreamRole(threadId: string, role: ThreadStreamRole | null): ThreadView {
    this.ctx.threadStreamOwnership.set(threadId, role);
    return this.ctx.threadViews.update(threadId, (current) => ({ ...current, streamRole: role }));
  }

  markNeedsResume(threadId: string): ThreadView {
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
    if (this.inFlight.has(threadId) || this.reads.has(threadId)) throw new Error("Cannot release a loading Thread");
    this.readContexts.delete(threadId);
    this.historyContexts.delete(threadId);
    this.historyRefreshes.delete(threadId);
    this.backgroundHistory.delete(threadId);
    this.olderPageRequests.delete(threadId);
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
    return this.backgroundHistory.get(threadId) ?? Promise.resolve();
  }

  /** Refresh only durable message-window history; never Resume or reclaim execution. */
  refreshHistory(threadId: string, signal?: AbortSignal): Promise<boolean> {
    const existing = this.historyRefreshes.get(threadId);
    if (existing) return existing;
    const operation = this.refreshHistoryOnce(threadId, signal).finally(() => {
      if (this.historyRefreshes.get(threadId) === operation) this.historyRefreshes.delete(threadId);
    });
    this.historyRefreshes.set(threadId, operation);
    return operation;
  }

  private async refreshHistoryOnce(threadId: string, signal?: AbortSignal): Promise<boolean> {
    await this.olderPageRequests.get(threadId);
    if (this.disposed || signal?.aborted) return false;
    const initial = this.ctx.threadViews.get(threadId);
    const context = this.historyContexts.get(threadId);
    if (!initial || !context || initial.resumeState !== "resumed" || initial.historySource !== "message-window") return false;
    const generation = this.client.connectionGeneration;
    const current = () => !this.disposed && !signal?.aborted
      && generation === this.client.connectionGeneration
      && this.historyContexts.get(threadId) === context
      && this.ctx.threadViews.get(threadId)?.resumeState === "resumed";
    if (!current()) return false;
    const { thread } = await this.client.request("thread/read", { threadId, includeTurns: false }, {
      timeoutMs: this.requestTimeoutMs, priority: "background", signal,
    });
    if (!current()) return false;
    requireThread(thread, "thread/read");
    if (thread.id !== threadId) throw new Error("History refresh returned a different Thread");
    const revision = (value: AppServerThread | null) => value === null ? null
      : JSON.stringify([value.updatedAt, value.preview, value.extra]);
    if (revision(initial.thread) === revision(thread)) return false;
    // Ignore the initial Resume page/cursor: this read must fetch the current tail.
    const history = await this.ctx.threadHistoryStrategies.load({
      ...context, signal, response: { ...context.response, thread, initialTurnsPage: null, turnsBackwardsCursor: null },
    });
    if (!current()) return false;
    this.ctx.threadViews.update(threadId, view => ({
      ...view, thread,
      turns: reconcileHistoryWindow(view.turns, history.turns, initial.turns),
      turnsPagination: { ...view.turnsPagination, olderCursor: history.olderCursor,
        oldestLoadedTurnId: history.turns[0]?.id ?? null, hasLoadedOldest: history.complete },
      historyError: null,
    }));
    return true;
  }

  loadOlder(threadId: string): Promise<ThreadView> {
    const refreshing = this.historyRefreshes.get(threadId);
    if (refreshing) return refreshing.catch(() => false).then(() => this.loadOlder(threadId));
    const existing = this.olderPageRequests.get(threadId);
    if (existing !== undefined) return existing;
    const operation = this.loadOlderOnce(threadId).finally(() => {
      if (this.olderPageRequests.get(threadId) === operation) this.olderPageRequests.delete(threadId);
    });
    this.olderPageRequests.set(threadId, operation);
    return operation;
  }

  private async resumeOnce(options: ResumeThreadOptions, operation: HistoryOperation): Promise<ThreadView> {
    operation.assertCurrent();
    const threadId = options.threadId;
    const initial = this.ctx.threadViews.getOrCreate(threadId);
    operation.assertCurrent();
    const currentRole = this.ctx.threadStreamOwnership.get(threadId);
    if (!options.force && initial.resumeState === "resumed"
      && initial.connectionGeneration === this.client.connectionGeneration
      && currentRole !== null) return initial;

    this.retireHistoryContext(threadId);
    let provisionalOwner = false;
    operation.onCancel = () => {
      if (provisionalOwner && this.ctx.threadStreamOwnership.get(threadId)?.role === "owner")
        this.ctx.threadStreamOwnership.set(threadId, null);
      if (!this.disposed) this.ctx.threadViews.update(threadId, current => ({
        ...current, resumeState: "needs_resume", streamRole: this.ctx.threadStreamOwnership.get(threadId),
      }));
    };
    this.ctx.threadViews.update(threadId, (current) => ({
      ...current,
      resumeState: "resuming",
      streamRole: currentRole,
      resumeError: null,
      historyError: null,
    }));
    operation.assertCurrent();
    this.ctx.resumeNotificationBuffer.begin(threadId);
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
        provisionalOwner = true;
        this.ctx.threadStreamOwnership.set(threadId, { role: "owner" });
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
      const supportsBoundedRecovery = supportsMergedPage && capability?.boundedRecovery === true;
      const requestedCheckpoint = options.historyCheckpoint === undefined
        ? initial.historyCheckpoint : options.historyCheckpoint ?? undefined;
      const historyRequest = buildResumeHistoryRequest({
        useTailHydration: this.useTailHydration,
        isDurableHost,
        supportsPaginatedHistory,
        supportsInitialTurnsPage: supportsMergedPage,
      });
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
        ...(historyMode === "message-window" ? {
          historyPreviewToken: `${generation}:${++this.previewSequence}`,
        } : {}),
      };
      if (typeof params.historyPreviewToken === "string") this.previewTokens.set(threadId, params.historyPreviewToken);
      const requestResume = (request: ThreadResumeParams) => this.client.request("thread/resume", request, {
        // The message-window provider owns independent gateway and HTTP-idle
        // deadlines. An outer wall-clock limit would cancel a healthy body
        // download merely because its transport is slow.
        timeoutMs: historyMode === "message-window" ? 0 : this.requestTimeoutMs,
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
      provisionalOwner = false;
      this.ctx.threadStreamOwnership.set(threadId, { role: "owner" });
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
      if (provisionalOwner && this.ctx.threadStreamOwnership.get(threadId)?.role === "owner") {
        this.ctx.threadStreamOwnership.set(threadId, null);
      }
      this.ctx.threadViews.update(threadId, (current) => ({
        ...current,
        resumeState: "needs_resume",
        streamRole: this.ctx.threadStreamOwnership.get(threadId),
        resumeError: failure,
      }));
      if (operation.current()) this.ctx.resumeNotificationBuffer.release(threadId);
      throw failure;
    } finally {
      if (operation.current()) this.previewTokens.delete(threadId);
    }
  }

  private startBackgroundDrain(
    threadId: string,
    generation: number,
    history: HydratedThreadHistory,
  ): void {
    const views = this.ctx.threadViews;
    const baselineTurns = views.get(threadId)?.turns ?? [];
    const operation = history.drainRemaining?.().then((olderTurns) => {
      if (
        this.disposed
        || this.client.connectionGeneration !== generation
        || this.backgroundHistory.get(threadId) !== operation
      ) return;
      views.update(threadId, (current) => ({
        ...current,
        turns: reconcileHistoryTurns(current.turns, olderTurns, "older", { baselineTurns }),
        tailHydrationComplete: true,
        turnsPagination: {
          olderCursor: null,
          oldestLoadedTurnId: olderTurns[0]?.id ?? current.turns[0]?.id ?? null,
          isLoadingOlder: false,
          hasLoadedOldest: true,
        },
        historyError: null,
      }));
    }).catch((error: unknown) => {
      // A superseded generation owns neither the View nor its history error.
      // Cordis also removes injected services during disposal, so late async
      // completions must stop before dereferencing this.ctx.
      if (
        this.disposed
        || this.client.connectionGeneration !== generation
        || this.backgroundHistory.get(threadId) !== operation
      ) return;
      const failure = error instanceof Error ? error : new Error(String(error));
      views.update(threadId, (current) => ({
        ...current,
        historyError: failure,
      }));
    }).finally(() => {
      if (this.backgroundHistory.get(threadId) === operation) this.backgroundHistory.delete(threadId);
    }) ?? Promise.resolve();
    this.backgroundHistory.set(threadId, operation);
  }

  private async loadOlderOnce(threadId: string): Promise<ThreadView> {
    const readContext = this.readContexts.get(threadId);
    if (readContext) {
      const current = this.ctx.threadViews.get(threadId);
      if (!current || current.turnsPagination.olderCursor === null) return current!;
      const page = await readTurnsPage({ client: this.client, threadId, requestTimeoutMs: this.requestTimeoutMs }, current.turnsPagination.olderCursor);
      this.ensureGeneration(readContext.generation);
      if (this.disposed || this.readContexts.get(threadId) !== readContext) throw new Error("History read was superseded");
      const turns = await hydrateReadTurnItems({ client: this.client, threadId, requestTimeoutMs: this.requestTimeoutMs },
        [...page.data].reverse().map(turn => !readContext.hydrateItems && turn.itemsView === undefined ? { ...turn, itemsView: "full" as const } : turn));
      this.ensureGeneration(readContext.generation);
      if (this.disposed || this.readContexts.get(threadId) !== readContext) throw new Error("History read was superseded");
      return this.ctx.threadViews.update(threadId, view => ({ ...view,
        turns: reconcileHistoryTurns(view.turns, turns, "older", { baselineTurns: current.turns }),
        tailHydrationComplete: page.nextCursor === null,
        turnsPagination: { olderCursor: page.nextCursor, oldestLoadedTurnId: turns[0]?.id ?? view.turnsPagination.oldestLoadedTurnId,
          hasLoadedOldest: page.nextCursor === null, isLoadingOlder: false },
      }));
    }
    const context = this.historyContexts.get(threadId);
    const current = this.ctx.threadViews.get(threadId);
    if (context === undefined || current === null) throw new Error(`Thread ${threadId} has not been resumed`);
    const cursor = current.turnsPagination.olderCursor;
    if (cursor === null) return current;
    this.ctx.threadViews.update(threadId, (view) => ({
      ...view,
      turnsPagination: { ...view.turnsPagination, isLoadingOlder: true },
      historyError: null,
    }));
    try {
      const page = await this.ctx.threadHistoryStrategies.loadOlder(context, cursor);
      this.ensureGeneration(current.connectionGeneration);
      if (this.historyContexts.get(threadId) !== context || this.ctx.threadViews.get(threadId)?.resumeState !== "resumed") {
        return this.ctx.threadViews.get(threadId) ?? current;
      }
      return this.ctx.threadViews.update(threadId, (view) => ({
        ...view,
        turns: page.source === "message-window"
          ? reconcileHistoryWindow(view.turns, page.turns)
          : reconcileHistoryTurns(view.turns, page.turns, "older", { baselineTurns: current.turns }),
        tailHydrationComplete: page.complete,
        turnsPagination: {
          olderCursor: page.olderCursor,
          oldestLoadedTurnId: page.turns[0]?.id ?? view.turns[0]?.id ?? null,
          isLoadingOlder: false,
          hasLoadedOldest: page.complete,
        },
        itemsPaginationByTurnId: {
          ...view.itemsPaginationByTurnId,
          ...page.itemsPaginationByTurnId,
        },
      }));
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      if (this.historyContexts.get(threadId) !== context || this.ctx.threadViews.get(threadId) === null) throw failure;
      this.ctx.threadViews.update(threadId, (view) => ({
        ...view,
        turnsPagination: { ...view.turnsPagination, isLoadingOlder: false },
        historyError: failure,
      }));
      throw failure;
    }
  }

  private ensureGeneration(expected: number): void {
    if (this.client.connectionGeneration !== expected) {
      throw new Error(`Stale Resume generation ${expected}; current generation is ${this.client.connectionGeneration}`);
    }
  }
}
