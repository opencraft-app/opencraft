import { Context, Service } from "@deepseek-ai/cordis";
import type { AppServerClient } from "@opencraft/appserver-client";
import { buildResumeHistoryRequest, type AppServerThread, type ThreadResumeParams, type ThreadResumeResponse, type ThreadForkResponse } from "@opencraft/appserver-protocol";

import type { HydratedThreadHistory, ResumeHistoryContext } from "./history-strategies";
import { mergeTurns, reconcileHistoryWindow } from "./merge-turns";
import type { ThreadStreamRole, ThreadView } from "./models";
import { resolveThreadId } from "./notification-buffer";

declare module "@deepseek-ai/cordis" {
  interface Context {
    threadResume: ThreadResumeCoordinatorService;
  }
}

export type AppServerHostKind = "local" | "remote-ssh" | "durable" | "remote-control" | "wsl";

export interface ThreadResumeCoordinatorConfig {
  client: AppServerClient;
  hostKind?: AppServerHostKind;
  useTailHydration?: boolean;
  supportsPaginatedHistory?: boolean;
  pageSize?: number;
  requestTimeoutMs?: number;
  drainTailHistory?: boolean;
}

export interface ResumeThreadOptions {
  threadId: string;
  force?: boolean;
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
  private readonly pageSize: number;
  private readonly requestTimeoutMs: number;
  private readonly drainTailHistory: boolean;
  private readonly inFlight = new Map<string, Promise<ThreadView>>();
  private readonly historyContexts = new Map<string, ResumeHistoryContext>();
  private readonly backgroundHistory = new Map<string, Promise<void>>();
  private readonly olderPageRequests = new Map<string, Promise<ThreadView>>();
  private disposed = false;
  private previewSequence = 0;
  private readonly previewTokens = new Map<string, string>();

  constructor(ctx: Context, config: ThreadResumeCoordinatorConfig) {
    super(ctx, "threadResume");
    this.client = config.client;
    this.hostKind = config.hostKind ?? (config.client.hostId === "durable" ? "durable" : "local");
    this.useTailHydration = config.useTailHydration ?? true;
    this.supportsPaginatedHistory = config.supportsPaginatedHistory ?? true;
    this.pageSize = config.pageSize ?? 5;
    this.requestTimeoutMs = config.requestTimeoutMs ?? 30_000;
    this.drainTailHistory = config.drainTailHistory ?? true;
    if (!Number.isInteger(this.pageSize) || this.pageSize < 1) throw new RangeError("pageSize must be positive");

    const removeNotification = this.client.subscribeNotification((notification) => {
      const threadId = resolveThreadId(notification.params);
      if (threadId === null || ctx.threadViews.get(threadId) === null) return;
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
      ctx.threadViews.update(threadId, (current) => ctx.threadNotificationProjectors.project(current, notification));
    });
    const removeStatus = this.client.subscribeStatus((status) => {
      if (status.state !== "closed" && status.state !== "failed") return;
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
      this.inFlight.clear();
      this.historyContexts.clear();
      this.backgroundHistory.clear();
      this.olderPageRequests.clear();
      this.previewTokens.clear();
    });
  }

  resume(options: ResumeThreadOptions): Promise<ThreadView> {
    const existing = this.inFlight.get(options.threadId);
    if (existing !== undefined) return existing;
    const operation = this.resumeOnce(options).finally(() => {
      if (this.inFlight.get(options.threadId) === operation) this.inFlight.delete(options.threadId);
    });
    this.inFlight.set(options.threadId, operation);
    return operation;
  }

  /** A successful fork already owns a live stream; an ephemeral fork has no rollout to Resume. */
  adoptFork(response: ThreadForkResponse, generation: number): ThreadView {
    this.ensureGeneration(generation);
    const thread = requireThread(response.thread, "thread/fork");
    const baseline = requireResumeResponse({ ...response, thread }, thread.id);
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

  async resumeAll(options: (view: ThreadView) => Omit<ResumeThreadOptions, "threadId"> = () => ({})): Promise<readonly ThreadView[]> {
    return Promise.all(this.ctx.threadViews.getAll().map((view) => this.resume({
      threadId: view.threadId,
      ...options(view),
    })));
  }

  waitForBackgroundHistory(threadId: string): Promise<void> {
    return this.backgroundHistory.get(threadId) ?? Promise.resolve();
  }

  loadOlder(threadId: string): Promise<ThreadView> {
    const existing = this.olderPageRequests.get(threadId);
    if (existing !== undefined) return existing;
    const operation = this.loadOlderOnce(threadId).finally(() => {
      if (this.olderPageRequests.get(threadId) === operation) this.olderPageRequests.delete(threadId);
    });
    this.olderPageRequests.set(threadId, operation);
    return operation;
  }

  private async resumeOnce(options: ResumeThreadOptions): Promise<ThreadView> {
    const threadId = options.threadId;
    const initial = this.ctx.threadViews.getOrCreate(threadId);
    const currentRole = this.ctx.threadStreamOwnership.get(threadId);
    if (!options.force && initial.resumeState === "resumed"
      && initial.connectionGeneration === this.client.connectionGeneration
      && currentRole !== null) return initial;

    this.ctx.threadViews.update(threadId, (current) => ({
      ...current,
      resumeState: "resuming",
      streamRole: currentRole,
      resumeError: null,
      historyError: null,
    }));
    this.ctx.resumeNotificationBuffer.begin(threadId);
    const generation = this.client.connectionGeneration;
    let metadata: AppServerThread | null = null;
    let provisionalOwner = false;
    try {
      try {
        const read = await this.client.request("thread/read", {
          threadId,
          includeTurns: false,
        }, { timeoutMs: this.requestTimeoutMs, priority: "user-visible" });
        metadata = requireThread(read.thread, "thread/read");
      } catch {
        metadata = null;
      }

      const roleAfterRead = this.ctx.threadStreamOwnership.get(threadId);
      if (roleAfterRead?.role === "follower") {
        const followerView = this.ctx.threadViews.update(threadId, (current) => ({
          ...current,
          thread: metadata ?? current.thread,
          historyMode: metadata?.historyMode ?? current.historyMode,
          connectionGeneration: generation,
          resumeState: "resumed",
          streamRole: roleAfterRead,
        }));
        this.ctx.resumeNotificationBuffer.release(threadId);
        return followerView;
      }

      if (roleAfterRead === null) {
        provisionalOwner = true;
        this.ctx.threadStreamOwnership.set(threadId, { role: "owner" });
      }

      const historyMode = metadata?.historyMode ?? initial.historyMode;
      const supportsPaginatedHistory = this.useTailHydration
        && this.hostKind !== "durable"
        && historyMode === "paginated"
        && this.supportsPaginatedHistory;
      const historyRequest = buildResumeHistoryRequest({
        useTailHydration: this.useTailHydration,
        isDurableHost: this.hostKind === "durable",
        supportsPaginatedHistory,
      });
      const {
        threadId: _ignoredThreadId,
        history: _ignoredHistory,
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
        ...(historyMode === "message-window" ? {
          historyPreviewToken: `${generation}:${++this.previewSequence}`,
        } : {}),
      };
      if (typeof params.historyPreviewToken === "string") this.previewTokens.set(threadId, params.historyPreviewToken);
      const response = requireResumeResponse(await this.client.request("thread/resume", params, {
        // The message-window provider owns independent gateway and HTTP-idle
        // deadlines. An outer wall-clock limit would cancel a healthy body
        // download merely because its transport is slow.
        timeoutMs: historyMode === "message-window" ? 0 : this.requestTimeoutMs,
        priority: "user-blocking",
      }), threadId);
      this.ensureGeneration(generation);

      const historyContext: ResumeHistoryContext = {
        client: this.client,
        threadId,
        response,
        metadata,
        useTailHydration: this.useTailHydration,
        isDurableHost: this.hostKind === "durable",
        supportsPaginatedHistory,
        pageSize: this.pageSize,
        requestTimeoutMs: this.requestTimeoutMs,
      };
      const history = await this.ctx.threadHistoryStrategies.load(historyContext);
      this.ensureGeneration(generation);
      this.historyContexts.set(threadId, historyContext);

      const committed = this.ctx.threadViews.update(threadId, (current) => {
        const projected = this.ctx.threadResumeProjectors.project(current, { metadata, response });
        const turns = history.source === "message-window"
          ? reconcileHistoryWindow(projected.turns, history.turns, initial.turns)
          : mergeTurns(projected.turns, history.turns, { placement: "prepend" });
        const oldestLoadedTurnId = turns[0]?.id ?? null;
        return {
          ...projected,
          connectionGeneration: generation,
          resumeState: "resumed",
          streamRole: { role: "owner" },
          turns,
          historySource: history.source,
          tailHydrationComplete: history.complete,
          turnsPagination: {
            olderCursor: history.olderCursor,
            oldestLoadedTurnId,
            isLoadingOlder: false,
            hasLoadedOldest: history.complete,
          },
          itemsPaginationByTurnId: history.itemsPaginationByTurnId,
          resumeError: null,
          historyError: null,
        };
      });
      this.ctx.threadStreamOwnership.set(threadId, { role: "owner" });
      this.ctx.resumeNotificationBuffer.release(threadId);
      if (this.drainTailHistory && history.drainRemaining !== undefined) {
        this.startBackgroundDrain(threadId, generation, history);
      }
      return committed;
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      if (provisionalOwner && this.ctx.threadStreamOwnership.get(threadId)?.role === "owner") {
        this.ctx.threadStreamOwnership.set(threadId, null);
      }
      this.ctx.threadViews.update(threadId, (current) => ({
        ...current,
        resumeState: "needs_resume",
        streamRole: this.ctx.threadStreamOwnership.get(threadId),
        resumeError: failure,
      }));
      this.ctx.resumeNotificationBuffer.release(threadId);
      throw failure;
    } finally {
      this.previewTokens.delete(threadId);
    }
  }

  private startBackgroundDrain(
    threadId: string,
    generation: number,
    history: HydratedThreadHistory,
  ): void {
    const views = this.ctx.threadViews;
    const operation = history.drainRemaining?.().then((olderTurns) => {
      if (
        this.disposed
        || this.client.connectionGeneration !== generation
        || this.backgroundHistory.get(threadId) !== operation
      ) return;
      views.update(threadId, (current) => ({
        ...current,
        turns: mergeTurns(current.turns, olderTurns, { placement: "prepend" }),
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
          : mergeTurns(view.turns, page.turns, { placement: "prepend" }),
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
