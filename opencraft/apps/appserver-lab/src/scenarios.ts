import {
  AppServerClientError,
  AppServerRpcError,
  type AppServerClient,
} from "@opencraft/appserver-client";
import { buildResumeHistoryRequest } from "@opencraft/appserver-protocol";
import { MemoryReplicaStorage, ReplicaClient } from "@opencraft/appserver-replica";
import {
  createCodexThreadReplicaSource,
  createCordisThreadSessionRuntime,
} from "@opencraft/appserver-session";
import { asHostId, createConversationKey } from "@opencraft/chat-core";
import { createReplicaConversationRuntime } from "@opencraft/chat-runtime";
import {
  AppServerInteractionBroker,
  createAppServerConversationCommandPort,
} from "@opencraft/composer-appserver";
import { createComposerController } from "@opencraft/composer-core";

import type { LabCommand, LabOptions, LabScenarioName } from "./args";
import { resolveCanonicalThread } from "./canonical-thread-identity";
import type { FaultInjectingTransport } from "./fault-injecting-transport";
import { NdjsonReporter, preview } from "./reporter";

interface ThreadRecord {
  id?: unknown;
  name?: unknown;
  title?: unknown;
  cwd?: unknown;
  status?: unknown;
  turns?: unknown;
  [field: string]: unknown;
}

interface ThreadListResponse {
  data: ThreadRecord[];
  nextCursor?: unknown;
  backwardsCursor?: unknown;
}

interface CursorPage<T> {
  data: T[];
  nextCursor?: unknown;
  backwardsCursor?: unknown;
}

export interface LabScenarioEnvironment {
  client: AppServerClient;
  transport: FaultInjectingTransport;
  reporter: NdjsonReporter;
  options: LabOptions;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, milliseconds));
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) return false;
    await sleep(Math.min(10, Math.max(1, deadline - Date.now())));
  }
  return true;
}

function threadSummary(thread: ThreadRecord): Readonly<Record<string, unknown>> {
  const turns = Array.isArray(thread.turns) ? thread.turns.length : null;
  return {
    id: thread.id ?? null,
    title: thread.name ?? thread.title ?? null,
    cwd: thread.cwd ?? null,
    status: thread.status ?? null,
    turns,
  };
}

function requireThreadList(value: unknown): ThreadListResponse {
  if (typeof value !== "object" || value === null || !("data" in value) || !Array.isArray(value.data)) {
    throw new Error("thread/list response does not contain a data array");
  }
  return value as ThreadListResponse;
}

function requireCursorPage<T>(value: unknown, method: string): CursorPage<T> {
  if (typeof value !== "object" || value === null || !("data" in value) || !Array.isArray(value.data)) {
    throw new Error(`${method} response does not contain a data array`);
  }
  return value as CursorPage<T>;
}

function requireClientError(error: unknown, code: string): AppServerClientError {
  if (!(error instanceof AppServerClientError) || error.code !== code) throw error;
  return error;
}

function selectThreadId(environment: LabScenarioEnvironment, listed: ThreadListResponse): string {
  const threadId = environment.options.threadId
    ?? listed.data.find((thread) => typeof thread.id === "string")?.id;
  if (typeof threadId !== "string") {
    throw new Error("scenario needs --thread or at least one listed thread");
  }
  return threadId;
}

async function initialize(environment: LabScenarioEnvironment): Promise<void> {
  const result = await environment.client.connect({
    clientInfo: { name: "opencraft-appserver-lab", version: "0.1.0" },
    capabilities: { experimentalApi: true },
  });
  environment.reporter.emit("appserver.initialized", {
    hostId: environment.client.hostId,
    generation: environment.client.connectionGeneration,
    platformFamily: result.platformFamily,
    platformOs: result.platformOs,
    codexHome: result.codexHome,
    userAgent: result.userAgent,
  });
}

async function listThreads(environment: LabScenarioEnvironment): Promise<ThreadListResponse> {
  const response = requireThreadList(await environment.client.requestRaw("thread/list", {
    archived: false,
    cursor: null,
    limit: environment.options.limit,
    sortDirection: "desc",
    sortKey: "updated_at",
  }, { timeoutMs: environment.options.timeoutMs, priority: "user-visible" }));
  environment.reporter.emit("thread.list", {
    hostId: environment.client.hostId,
    generation: environment.client.connectionGeneration,
    count: response.data.length,
    threads: response.data.map(threadSummary),
    nextCursor: response.nextCursor ?? null,
    backwardsCursor: response.backwardsCursor ?? null,
  });
  return response;
}

async function runReconnect(environment: LabScenarioEnvironment): Promise<void> {
  await initialize(environment);
  const before = await listThreads(environment);
  environment.transport.setInboundLatency(environment.options.inboundLatencyMs);

  const pendingOutcome = environment.client.requestRaw("thread/list", {
    archived: false,
    cursor: null,
    limit: environment.options.limit,
  }, { timeoutMs: environment.options.timeoutMs }).then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  await sleep(environment.options.disconnectAfterMs);
  environment.reporter.emit("fault.disconnect.injected", {
    afterMs: environment.options.disconnectAfterMs,
    inboundLatencyMs: environment.options.inboundLatencyMs,
    pendingRequests: environment.client.getPendingRequestCount(),
  });
  await environment.transport.disconnect();
  const interrupted = await pendingOutcome;
  if (interrupted.ok) throw new Error("disconnect scenario unexpectedly completed its in-flight request");
  if (!(interrupted.error instanceof AppServerClientError) || interrupted.error.code !== "TRANSPORT_ERROR") {
    throw interrupted.error;
  }
  environment.reporter.emit("fault.disconnect.observed", {
    error: interrupted.error,
    pendingRequests: environment.client.getPendingRequestCount(),
  });

  environment.transport.setInboundLatency(0);
  await initialize(environment);
  const after = await listThreads(environment);
  const beforeIds = before.data.map((thread) => thread.id).filter((id) => typeof id === "string");
  const afterIds = after.data.map((thread) => thread.id).filter((id) => typeof id === "string");
  environment.reporter.emit("reconnect.verified", {
    generation: environment.client.connectionGeneration,
    pendingRequests: environment.client.getPendingRequestCount(),
    sameVisibleThreadHead: JSON.stringify(beforeIds) === JSON.stringify(afterIds),
  });
  if (environment.client.connectionGeneration < 2) throw new Error("connection generation did not advance");
}

async function runResume(environment: LabScenarioEnvironment): Promise<void> {
  await initialize(environment);
  const listed = await listThreads(environment);
  const threadId = selectThreadId(environment, listed);
  await resumeThread(environment, threadId);
}

async function resumeThread(environment: LabScenarioEnvironment, threadId: string): Promise<ThreadRecord> {
  const response = await environment.client.request("thread/resume", {
    threadId,
    ...buildResumeHistoryRequest({
      useTailHydration: true,
      isDurableHost: environment.client.hostId === "durable",
      supportsPaginatedHistory: false,
    }),
  }, { timeoutMs: environment.options.timeoutMs, priority: "user-blocking" });
  const thread = typeof response.thread === "object" && response.thread !== null
    ? response.thread as ThreadRecord
    : {};
  if (typeof thread.id !== "string") {
    throw new Error("thread/resume response is missing thread.id");
  }
  if (thread.id !== threadId) {
    throw new Error(`thread/resume returned ${thread.id} for requested Thread ${threadId}`);
  }
  environment.reporter.emit("thread.resumed", {
    hostId: environment.client.hostId,
    threadId,
    generation: environment.client.connectionGeneration,
    thread: threadSummary(thread),
    runtimeWorkspaceRoots: response.runtimeWorkspaceRoots,
    turnsBackwardsCursor: response.turnsBackwardsCursor,
    itemsBackwardsCursor: response.itemsBackwardsCursor,
    initialTurnsPage: preview(response.initialTurnsPage),
  });
  return thread;
}

async function requestTailResume(environment: LabScenarioEnvironment, threadId: string) {
  return environment.client.request("thread/resume", {
    threadId,
    ...buildResumeHistoryRequest({
      useTailHydration: true,
      isDurableHost: environment.client.hostId === "durable",
      supportsPaginatedHistory: false,
    }),
  }, { timeoutMs: environment.options.timeoutMs, priority: "user-blocking" });
}

function resumedThreadId(response: Awaited<ReturnType<typeof requestTailResume>>): string | null {
  if (typeof response.thread !== "object" || response.thread === null || !("id" in response.thread)) return null;
  return typeof response.thread.id === "string" ? response.thread.id : null;
}

async function runResumeContract(environment: LabScenarioEnvironment): Promise<void> {
  await initialize(environment);
  const listed = await listThreads(environment);
  const threadId = selectThreadId(environment, listed);
  const first = await requestTailResume(environment, threadId);
  const second = await requestTailResume(environment, threadId);
  if (resumedThreadId(first) !== threadId || resumedThreadId(second) !== threadId) {
    throw new Error("repeated thread/resume changed the canonical Thread ID");
  }

  await environment.transport.disconnect();
  await initialize(environment);
  const afterReconnect = await requestTailResume(environment, threadId);
  if (resumedThreadId(afterReconnect) !== threadId) {
    throw new Error("thread/resume changed the Thread ID after reconnect");
  }

  const missingThreadId = "appserver-lab-missing-thread";
  let missingError: AppServerRpcError | null = null;
  try {
    await requestTailResume(environment, missingThreadId);
  } catch (error) {
    if (!(error instanceof AppServerRpcError)) throw error;
    missingError = error;
  }
  if (missingError === null) throw new Error("missing Thread unexpectedly resumed");
  if (missingError.code !== -32000) {
    throw new Error(`missing Thread resume must fail with -32000, got ${missingError.code}`);
  }
  environment.reporter.emit("resume-contract.verified", {
    threadId,
    repeatedResumeIds: [resumedThreadId(first), resumedThreadId(second)],
    afterReconnectThreadId: resumedThreadId(afterReconnect),
    generation: environment.client.connectionGeneration,
    missingThreadErrorCode: missingError.code,
    pendingRequests: environment.client.getPendingRequestCount(),
  });
}

async function runDesktopResume(environment: LabScenarioEnvironment): Promise<void> {
  await initialize(environment);
  const listed = await listThreads(environment);
  const threadId = selectThreadId(environment, listed);
  const runtime = await createCordisThreadSessionRuntime({
    client: environment.client,
    hostKind: environment.client.hostId === "durable" ? "durable" : "local",
    useTailHydration: true,
    supportsPaginatedHistory: true,
    pageSize: 5,
    requestTimeoutMs: environment.options.timeoutMs,
  });
  try {
    await runtime.resume.resume({ threadId });
    await runtime.resume.waitForBackgroundHistory(threadId);
    const view = runtime.views.get(threadId);
    if (view === null || view.resumeState !== "resumed") {
      throw new Error("Desktop Resume did not commit a resumed Thread View");
    }
    environment.reporter.emit("desktop-resume.verified", {
      threadId,
      generation: view.connectionGeneration,
      resumeState: view.resumeState,
      streamRole: view.streamRole,
      historySource: view.historySource,
      historyMode: view.historyMode,
      tailHydrationComplete: view.tailHydrationComplete,
      turnCount: view.turns.length,
      olderCursor: view.turnsPagination.olderCursor,
      itemPaginationTurns: Object.keys(view.itemsPaginationByTurnId).length,
      model: view.execution.model,
      modelProvider: view.execution.modelProvider,
      cwd: view.execution.cwd,
      runtimeWorkspaceRoots: view.execution.runtimeWorkspaceRoots,
      approvalPolicy: view.execution.approvalPolicy,
      notificationRevision: view.notificationRevision,
    });
  } finally {
    await runtime.dispose();
  }
}

async function runReplicaResume(environment: LabScenarioEnvironment): Promise<void> {
  await initialize(environment);
  const listed = await listThreads(environment);
  const threadId = selectThreadId(environment, listed);
  const session = await createCordisThreadSessionRuntime({
    client: environment.client,
    hostKind: environment.client.hostId === "durable" ? "durable" : "local",
    useTailHydration: true,
    supportsPaginatedHistory: true,
    pageSize: 5,
    requestTimeoutMs: environment.options.timeoutMs,
  });
  const storage = new MemoryReplicaStorage();
  let first: ReplicaClient | null = null;
  let restarted: ReplicaClient | null = null;
  try {
    await session.resume.resume({ threadId });
    await session.resume.waitForBackgroundHistory(threadId);
    const source = createCodexThreadReplicaSource(
      session.views,
      environment.client.hostId,
      threadId,
    );
    first = new ReplicaClient({
      scope: source.scope,
      storageKey: `${environment.client.hostId}:${threadId}`,
      storage,
      pageSize: environment.options.limit,
    });
    await first.synchronize(source);
    const firstCursor = first.getSnapshot().nextSeq;

    session.resume.markNeedsResume(threadId);
    await session.resume.resume({ threadId, force: true });
    await session.resume.waitForBackgroundHistory(threadId);
    const updatedView = session.views.get(threadId);
    if (updatedView === null) throw new Error("Replica Resume lost its Thread View");
    const caughtUp = await waitUntil(
      () => first?.getSnapshot().nextSeq === updatedView.revision + 1,
      environment.options.timeoutMs,
    );
    if (!caughtUp) throw new Error("Codex V3 Replica adapter did not apply every View revision");
    first.dispose();
    first = null;

    restarted = new ReplicaClient({
      scope: source.scope,
      storageKey: `${environment.client.hostId}:${threadId}`,
      storage,
      pageSize: environment.options.limit,
    });
    await restarted.prepare();
    const cachedPhase = restarted.getSnapshot().phase;
    const cachedAuthoritative = restarted.getSnapshot().authoritative;
    await restarted.synchronize(source);
    const record = restarted.get(threadId);
    if (record === null) throw new Error("Replica cache does not contain the selected Thread");
    environment.reporter.emit("replica-resume.verified", {
      threadId,
      protocol: "codex-v3-resume-adapter",
      scope: source.scope,
      epoch: restarted.getSnapshot().epoch,
      firstCursor,
      nextSeq: restarted.getSnapshot().nextSeq,
      cachedPhase,
      cachedAuthoritative,
      livePhase: restarted.getSnapshot().phase,
      liveAuthoritative: restarted.getSnapshot().authoritative,
      entities: restarted.getSnapshot().entities.size,
      viewRevision: updatedView.revision,
      turnCount: updatedView.turns.length,
    });
  } finally {
    first?.dispose();
    restarted?.dispose();
    await session.dispose();
  }
}

async function findThreadById(
  environment: LabScenarioEnvironment,
  threadId: string,
  archived = false,
): Promise<{ thread: ThreadRecord; pages: number } | null> {
  const cursors = new Set<string>();
  let cursor: string | null = null;
  for (let pages = 1; pages <= 100; pages += 1) {
    const response = requireThreadList(await environment.client.requestRaw("thread/list", {
      archived,
      cursor,
      limit: environment.options.limit,
      sortDirection: "desc",
      sortKey: "updated_at",
    }, { timeoutMs: environment.options.timeoutMs, priority: "user-visible" }));
    const thread = response.data.find((candidate) => candidate.id === threadId);
    if (thread !== undefined) return { thread, pages };
    if (typeof response.nextCursor !== "string") return null;
    if (cursors.has(response.nextCursor)) {
      throw new Error(`thread/list cursor cycled while locating canonical Thread ${threadId}`);
    }
    cursors.add(response.nextCursor);
    cursor = response.nextCursor;
  }
  throw new Error(`thread/list exceeded 100 pages while locating canonical Thread ${threadId}`);
}

async function runCanonicalSession(environment: LabScenarioEnvironment): Promise<void> {
  await initialize(environment);
  let serverCreatedThreadId: string | null = null;
  let canonicalThreadId: string | null = null;
  const resolution = await resolveCanonicalThread({
    identityFile: environment.options.identityFile,
    lockTimeoutMs: environment.options.timeoutMs,
    create: async () => {
      if (environment.options.threadId !== undefined) return environment.options.threadId;
      const response = await environment.client.request("thread/start", {
        model: environment.options.model,
        cwd: environment.options.cwd,
      }, { timeoutMs: environment.options.timeoutMs, priority: "user-blocking" });
      if (typeof response.thread?.id !== "string" || response.thread.id.length === 0) {
        throw new Error("thread/start response does not contain thread.id");
      }
      serverCreatedThreadId = response.thread.id;
      environment.reporter.emit("canonical-thread.started", {
        threadId: response.thread.id,
        model: environment.options.model,
        cwd: environment.options.cwd,
      });
      return response.thread.id;
    },
  });
  const threadId = resolution.identity.threadId;
  canonicalThreadId = threadId;
  if (environment.options.threadId !== undefined && environment.options.threadId !== threadId) {
    throw new Error(
      `--thread ${environment.options.threadId} conflicts with persisted canonical Thread ${threadId}`,
    );
  }
  environment.reporter.emit("canonical-thread.resolved", {
    threadId,
    identityFile: environment.options.identityFile,
    source: serverCreatedThreadId === threadId
      ? "thread/start"
      : resolution.created
        ? "explicit"
        : "persisted",
  });

  try {
    const listed = await findThreadById(environment, threadId);
    if (listed !== null) {
      environment.reporter.emit("canonical-thread.listed", {
        threadId,
        pages: listed.pages,
        thread: threadSummary(listed.thread),
      });
      const resumed = await resumeThread(environment, threadId);
      if (resumed.id !== threadId) {
        throw new Error(`thread/resume returned ${String(resumed.id)} for canonical Thread ${threadId}`);
      }
      environment.reporter.emit("canonical-session.verified", {
        threadId,
        created: serverCreatedThreadId === threadId,
        stateBeforeCleanup: "active",
        listedPages: listed.pages,
        resumed: true,
        resumedThreadId: resumed.id,
        singleCanonicalId: resumed.id === listed.thread.id && listed.thread.id === threadId,
      });
    } else {
      const archived = await findThreadById(environment, threadId, true);
      if (archived === null) {
        throw new Error(`canonical Thread ${threadId} is absent from active and archived thread/list`);
      }
      environment.reporter.emit("canonical-thread.archive-verified", {
        threadId,
        pages: archived.pages,
      });
      let archivedResumeError: AppServerRpcError | null = null;
      try {
        await requestTailResume(environment, threadId);
      } catch (error) {
        if (!(error instanceof AppServerRpcError)) throw error;
        archivedResumeError = error;
      }
      if (archivedResumeError?.code !== -32071) {
        throw new Error(
          `archived Thread resume must fail with -32071, got ${String(archivedResumeError?.code)}`,
        );
      }
      environment.reporter.emit("canonical-thread.archived-resume-rejected", {
        threadId,
        error: archivedResumeError,
      });
      environment.reporter.emit("canonical-session.verified", {
        threadId,
        created: false,
        stateBeforeCleanup: "archived",
        archivedPages: archived.pages,
        archivedResumeErrorCode: archivedResumeError.code,
        resumed: false,
        resumedThreadId: null,
        singleCanonicalId: archived.thread.id === threadId,
      });
    }
  } finally {
    if (canonicalThreadId !== null) {
      await environment.client.request("thread/archive", { threadId: canonicalThreadId }, {
        timeoutMs: environment.options.timeoutMs,
        priority: "background",
      });
      const finalArchived = await findThreadById(environment, canonicalThreadId, true);
      if (finalArchived === null) {
        throw new Error(`canonical Thread ${canonicalThreadId} was not archived during cleanup`);
      }
      environment.reporter.emit("canonical-thread.finally-archived", {
        threadId: canonicalThreadId,
        pages: finalArchived.pages,
      });
    }
  }
}

/**
 * Mutating end-to-end smoke. Unlike canonical-session, this scenario keeps one
 * persisted Thread alive because it is the SDK recovery fixture, not cleanup
 * data. Run it explicitly; it is intentionally excluded from the safe suite.
 */
async function runChatRuntime(environment: LabScenarioEnvironment): Promise<void> {
  await initialize(environment);
  const resolution = await resolveCanonicalThread({
    identityFile: environment.options.identityFile,
    lockTimeoutMs: environment.options.timeoutMs,
    create: async () => {
      if (environment.options.threadId !== undefined) return environment.options.threadId;
      const started = await environment.client.request("thread/start", {
        ...(environment.options.model === "auto" ? {} : { model: environment.options.model }),
        cwd: environment.options.cwd,
        runtimeWorkspaceRoots: [environment.options.cwd],
        historyMode: "paginated",
        ...(environment.options.projectId === undefined ? {} : { projectId: environment.options.projectId }),
      }, { timeoutMs: environment.options.timeoutMs, priority: "user-blocking" });
      return started.thread.id;
    },
  });
  const threadId = resolution.identity.threadId;
  if (environment.options.threadId !== undefined && environment.options.threadId !== threadId) {
    throw new Error(`--thread ${environment.options.threadId} conflicts with persisted Chat Runtime Thread ${threadId}`);
  }

  const session = await createCordisThreadSessionRuntime({
    client: environment.client,
    hostKind: environment.options.hostId === "durable" ? "durable" : "local",
    supportsPaginatedHistory: true,
    useTailHydration: true,
    requestTimeoutMs: environment.options.timeoutMs,
  });
  const replica = new ReplicaClient({
    scope: `codex-thread:${environment.options.hostId}:${threadId}`,
    storageKey: `chat-runtime:${environment.options.hostId}:${threadId}`,
    storage: new MemoryReplicaStorage(),
  });
  const source = createCodexThreadReplicaSource(session.views, environment.options.hostId, threadId);
  const interactionBroker = new AppServerInteractionBroker({
    hostId: environment.options.hostId,
    client: environment.client,
    store: session.views,
  });
  const diagnostics: string[] = [];
  const commandPort = createAppServerConversationCommandPort({
    hostId: asHostId(environment.options.hostId),
    client: environment.client,
    interactions: interactionBroker,
    compiler: { historyMode: "paginated" },
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.code),
  });
  let runtime: ReturnType<typeof createReplicaConversationRuntime> | null = null;
  try {
    await session.resume.resume({ threadId });
    await session.resume.waitForBackgroundHistory(threadId);
    await replica.synchronize(source);
    const key = createConversationKey(environment.options.hostId, threadId);
    runtime = createReplicaConversationRuntime({
      key,
      replica,
      commands: commandPort,
      history: { loadOlder: async () => { await session.resume.loadOlder(threadId); } },
    });
    let id = 0;
    const composer = createComposerController({ type: "existing-thread", key }, {
      now: Date.now,
      createId: () => `lab-${Date.now()}-${++id}`,
    });
    composer.dispatch({
      type: "set-document",
      document: {
        version: 1,
        blocks: [{ type: "paragraph", children: [{ type: "text", text: environment.options.prompt }] }],
      },
    });
    const receipt = await runtime.submit(composer.createSubmitIntent());
    if (receipt.threadId !== threadId || receipt.turnId === null) {
      throw new Error("Chat Runtime submission changed Thread identity or returned no Turn");
    }
    const projected = await waitUntil(
      () => runtime?.getSnapshot().timeline.frames.some((frame) => frame.turnId === receipt.turnId) === true,
      environment.options.timeoutMs,
    );
    if (!projected) throw new Error(`Turn ${receipt.turnId} was accepted but never entered the Replica projection`);
    environment.reporter.emit("chat-runtime.submitted", {
      threadId,
      turnId: receipt.turnId,
      created: resolution.created,
      identityFile: environment.options.identityFile,
      phase: runtime.getSnapshot().phase,
      authoritative: runtime.getSnapshot().authoritative,
      frames: runtime.getSnapshot().timeline.frames.length,
      diagnostics,
    });

    await environment.transport.disconnect();
    replica.disconnect();
    await initialize(environment);
    session.resume.markNeedsResume(threadId);
    await session.resume.resume({ threadId, force: true });
    await replica.synchronize(source);
    const recovered = runtime.getSnapshot();
    if (!recovered.authoritative || recovered.key.threadId !== threadId) {
      throw new Error("Chat Runtime did not recover the same authoritative Thread after reconnect");
    }
    environment.reporter.emit("chat-runtime.recovered", {
      threadId,
      connectionGeneration: environment.client.connectionGeneration,
      phase: recovered.phase,
      authoritative: recovered.authoritative,
      frames: recovered.timeline.frames.length,
      epoch: replica.getSnapshot().epoch,
      nextSeq: replica.getSnapshot().nextSeq,
    });
  } finally {
    runtime?.dispose();
    interactionBroker.dispose();
    replica.dispose();
    await session.dispose();
  }
}

async function runPagination(environment: LabScenarioEnvironment): Promise<void> {
  await initialize(environment);
  const first = await listThreads(environment);
  const firstIds = new Set(first.data.map((thread) => thread.id).filter((id): id is string => typeof id === "string"));
  let second: ThreadListResponse | null = null;
  if (typeof first.nextCursor === "string") {
    second = requireThreadList(await environment.client.requestRaw("thread/list", {
      archived: false,
      cursor: first.nextCursor,
      limit: environment.options.limit,
      sortDirection: "desc",
      sortKey: "updated_at",
    }, { timeoutMs: environment.options.timeoutMs, priority: "user-visible" }));
  }
  const secondIds = second?.data
    .map((thread) => thread.id)
    .filter((id): id is string => typeof id === "string") ?? [];
  const overlaps = secondIds.filter((id) => firstIds.has(id));
  const cursorAdvanced = second === null
    || typeof first.nextCursor !== "string"
    || second.nextCursor !== first.nextCursor;
  environment.reporter.emit("pagination.verified", {
    pages: second === null ? 1 : 2,
    firstCount: first.data.length,
    secondCount: second?.data.length ?? 0,
    firstCursor: first.nextCursor ?? null,
    secondCursor: second?.nextCursor ?? null,
    overlaps,
    cursorAdvanced,
  });
  if (overlaps.length > 0) throw new Error(`thread/list pages overlap: ${overlaps.join(", ")}`);
  if (!cursorAdvanced) throw new Error("thread/list pagination cursor did not advance");
}

async function runConcurrency(environment: LabScenarioEnvironment): Promise<void> {
  await initialize(environment);
  const startedIds = new Set<string | number>();
  let peakPendingRequests = 0;
  const removeLifecycle = environment.client.subscribeRequestLifecycle((event) => {
    peakPendingRequests = Math.max(peakPendingRequests, environment.client.getPendingRequestCount());
    if (event.type === "started" && event.method === "thread/list") startedIds.add(event.id);
  });
  try {
    const responses = await Promise.all(Array.from({ length: environment.options.requests }, (_, index) =>
      environment.client.requestRaw<ThreadListResponse>("thread/list", {
        archived: false,
        cursor: null,
        limit: 1,
        searchTerm: `lab-concurrency-${index}`,
      }, { timeoutMs: environment.options.timeoutMs, priority: "background" })));
    let correlatedEchoes = 0;
    responses.forEach((response, index) => {
      const page = requireThreadList(response);
      const echoedSearchTerm = page.data[0]?.name;
      if (typeof echoedSearchTerm !== "string" || !echoedSearchTerm.startsWith("lab-concurrency-")) return;
      if (echoedSearchTerm !== `lab-concurrency-${index}`) {
        throw new Error(`concurrent response correlation mismatch at request ${index}`);
      }
      correlatedEchoes += 1;
    });
    environment.reporter.emit("concurrency.verified", {
      requested: environment.options.requests,
      completed: responses.length,
      uniqueRequestIds: startedIds.size,
      correlatedEchoes,
      peakPendingRequests,
      pendingRequests: environment.client.getPendingRequestCount(),
    });
    if (startedIds.size !== environment.options.requests) throw new Error("concurrent request ids were not unique");
    if (environment.client.getPendingRequestCount() !== 0) throw new Error("concurrent requests leaked pending state");
  } finally {
    removeLifecycle();
  }
}

async function runTimeout(environment: LabScenarioEnvironment): Promise<void> {
  await initialize(environment);
  const timeoutMs = Math.min(environment.options.timeoutMs, 250);
  environment.transport.setInboundBlackhole(true);
  let timeoutError: AppServerClientError;
  try {
    await environment.client.requestRaw("thread/list", {
      archived: false,
      cursor: null,
      limit: 1,
    }, { timeoutMs, priority: "background" });
    throw new Error("timeout scenario unexpectedly received a response");
  } catch (error) {
    timeoutError = requireClientError(error, "TIMEOUT");
  } finally {
    environment.transport.setInboundBlackhole(false);
  }
  const after = await listThreads(environment);
  environment.reporter.emit("timeout.verified", {
    error: timeoutError,
    transportState: environment.client.status.state,
    pendingRequests: environment.client.getPendingRequestCount(),
    subsequentThreadCount: after.data.length,
  });
  if (environment.client.status.state !== "open") throw new Error("request timeout closed a healthy transport");
}

async function runAbort(environment: LabScenarioEnvironment): Promise<void> {
  await initialize(environment);
  const latencyMs = Math.max(environment.options.inboundLatencyMs, 25);
  const abortAfterMs = Math.min(environment.options.disconnectAfterMs, Math.max(0, latencyMs - 1));
  let lateResponses = 0;
  const removeLifecycle = environment.client.subscribeRequestLifecycle((event) => {
    if (event.type === "late-response") lateResponses += 1;
  });
  environment.transport.setInboundLatency(latencyMs);
  try {
    const controller = new AbortController();
    const outcome = environment.client.requestRaw("thread/list", {
      archived: false,
      cursor: null,
      limit: 1,
    }, { signal: controller.signal, timeoutMs: environment.options.timeoutMs }).then(
      () => null,
      (error: unknown) => error,
    );
    await sleep(abortAfterMs);
    controller.abort();
    const abortError = requireClientError(await outcome, "ABORTED");
    await waitUntil(
      () => lateResponses > 0,
      Math.max(environment.options.timeoutMs, latencyMs + 50),
    );
    environment.reporter.emit("abort.verified", {
      error: abortError,
      lateResponses,
      pendingRequests: environment.client.getPendingRequestCount(),
      transportState: environment.client.status.state,
    });
    if (lateResponses < 1) throw new Error("aborted request response was not isolated as a late response");
    if (environment.client.status.state !== "open") throw new Error("request abort closed a healthy transport");
  } finally {
    environment.transport.setInboundLatency(0);
    removeLifecycle();
  }
  await listThreads(environment);
}

async function runReconnectLoop(environment: LabScenarioEnvironment): Promise<void> {
  await initialize(environment);
  const initialGeneration = environment.client.connectionGeneration;
  for (let cycle = 1; cycle <= environment.options.cycles; cycle += 1) {
    await environment.transport.disconnect();
    if (environment.client.getPendingRequestCount() !== 0) throw new Error("disconnect leaked pending requests");
    await initialize(environment);
    const listed = await listThreads(environment);
    environment.reporter.emit("reconnect.cycle", {
      cycle,
      generation: environment.client.connectionGeneration,
      visibleThreads: listed.data.length,
      pendingRequests: environment.client.getPendingRequestCount(),
    });
  }
  const expectedGeneration = initialGeneration + environment.options.cycles;
  if (environment.client.connectionGeneration !== expectedGeneration) {
    throw new Error(`expected connection generation ${expectedGeneration}, got ${environment.client.connectionGeneration}`);
  }
  environment.reporter.emit("reconnect-loop.verified", {
    cycles: environment.options.cycles,
    generation: environment.client.connectionGeneration,
  });
}

async function runHistory(environment: LabScenarioEnvironment): Promise<void> {
  await initialize(environment);
  const listed = await listThreads(environment);
  const threadId = selectThreadId(environment, listed);
  const resumed = await environment.client.request("thread/resume", {
    threadId,
    ...buildResumeHistoryRequest({
      useTailHydration: true,
      isDurableHost: environment.client.hostId === "durable",
      supportsPaginatedHistory: true,
    }),
  }, { timeoutMs: environment.options.timeoutMs, priority: "user-blocking" });
  let olderTurns: CursorPage<unknown> | null = null;
  if (typeof resumed.turnsBackwardsCursor === "string") {
    olderTurns = requireCursorPage(await environment.client.requestRaw("thread/turns/list", {
      threadId,
      cursor: resumed.turnsBackwardsCursor,
      limit: environment.options.limit,
      itemsView: "full",
      sortDirection: "desc",
    }, { timeoutMs: environment.options.timeoutMs, priority: "background" }), "thread/turns/list");
  }
  environment.reporter.emit("history.verified", {
    threadId,
    initialTurns: resumed.initialTurnsPage?.data.length ?? 0,
    turnsBackwardsCursor: resumed.turnsBackwardsCursor,
    olderTurns: olderTurns?.data.length ?? 0,
    olderTurnsNextCursor: olderTurns?.nextCursor ?? null,
    runtimeWorkspaceRoots: resumed.runtimeWorkspaceRoots,
  });
}

async function runSuite(environment: LabScenarioEnvironment): Promise<void> {
  const scenarios = [
    "smoke",
    "pagination",
    "resume",
    "resume-contract",
    "history",
    "concurrency",
    "timeout",
    "abort",
    "reconnect",
  ] as const satisfies readonly LabScenarioName[];
  for (const name of scenarios) {
    environment.reporter.emit("suite.case.started", { name });
    await runNamedScenario(name, environment);
    environment.reporter.emit("suite.case.completed", { name });
  }
  environment.reporter.emit("suite.verified", { cases: scenarios });
}

async function runNamedScenario(name: LabScenarioName, environment: LabScenarioEnvironment): Promise<void> {
  switch (name) {
    case "initialize":
      await initialize(environment);
      return;
    case "smoke":
      await initialize(environment);
      await listThreads(environment);
      return;
    case "reconnect":
      await runReconnect(environment);
      return;
    case "resume":
      await runResume(environment);
      return;
    case "resume-contract":
      await runResumeContract(environment);
      return;
    case "desktop-resume":
      await runDesktopResume(environment);
      return;
    case "replica-resume":
      await runReplicaResume(environment);
      return;
    case "pagination":
      await runPagination(environment);
      return;
    case "concurrency":
      await runConcurrency(environment);
      return;
    case "timeout":
      await runTimeout(environment);
      return;
    case "abort":
      await runAbort(environment);
      return;
    case "reconnect-loop":
      await runReconnectLoop(environment);
      return;
    case "history":
      await runHistory(environment);
      return;
    case "canonical-session":
      await runCanonicalSession(environment);
      return;
    case "chat-runtime":
      await runChatRuntime(environment);
      return;
    case "suite":
      await runSuite(environment);
  }
}

export async function runLabCommand(command: LabCommand, environment: LabScenarioEnvironment): Promise<void> {
  if (command.kind === "scenario") {
    environment.reporter.emit("scenario.started", { name: command.name });
    await runNamedScenario(command.name, environment);
    environment.reporter.emit("scenario.completed", { name: command.name });
    return;
  }
  await initialize(environment);
  environment.reporter.emit("request.started", { method: command.method, params: preview(command.params) });
  const result = await environment.client.requestRaw(command.method, command.params, {
    timeoutMs: environment.options.timeoutMs,
    priority: "user-visible",
  });
  environment.reporter.emit("request.completed", { method: command.method, result: preview(result, 10_000) });
}
