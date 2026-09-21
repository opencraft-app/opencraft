import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createCordisAppServerRegistry } from "@opencraft/appserver-client";
import {
  encodeJsonRpcMessage,
  isJsonRpcRequest,
  parseJsonRpcMessage,
  type AppServerInitializeResponse,
} from "@opencraft/appserver-protocol";
import {
  MemoryTransport,
  type InMemoryAppServer,
  type InMemoryAppServerPeer,
} from "@opencraft/appserver-transport-memory";

import { parseLabArgs, type LabScenarioName } from "../apps/appserver-lab/src/args";
import { FaultInjectingTransport } from "../apps/appserver-lab/src/fault-injecting-transport";
import { NdjsonReporter } from "../apps/appserver-lab/src/reporter";
import { runLabCommand } from "../apps/appserver-lab/src/scenarios";

const initializeResponse: AppServerInitializeResponse = {
  codexHome: "/tmp/codex",
  platformFamily: "unix",
  platformOs: "linux",
  userAgent: "appserver-lab-test/1",
};

const threads = [
  { id: "thread-one", name: "Visible content", cwd: "/workspace", status: { type: "idle" }, turns: [] },
  { id: "thread-two", name: "Second page", cwd: "/workspace", status: { type: "idle" }, turns: [] },
  { id: "thread-three", name: "Third page", cwd: "/workspace", status: { type: "idle" }, turns: [] },
];

interface TestServerOptions {
  emptyThreads?: boolean;
  overlapPagination?: boolean;
  omitHistoryCursor?: boolean;
  threadListDelayMs?: number;
  cyclicPaginationCursor?: boolean;
  canonicalThreadId?: string;
  canonicalThreadIndex?: number;
  preloadCanonicalThread?: boolean;
  preloadCanonicalThreadArchived?: boolean;
  startCounter?: { count: number };
}

function objectParams(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

function sendLater(peer: InMemoryAppServerPeer, frame: string, delayMs: number): void {
  globalThis.setTimeout(() => peer.send(frame), delayMs);
}

function server(options: TestServerOptions = {}): InMemoryAppServer {
  const visibleThreads = [...threads];
  const archivedThreadIds = new Set<string>();
  if (options.canonicalThreadId !== undefined && options.preloadCanonicalThread) {
    visibleThreads.splice(options.canonicalThreadIndex ?? 0, 0, {
      id: options.canonicalThreadId,
      name: "Canonical Lab Thread",
      cwd: "/workspace",
      status: { type: "idle" },
      turns: [],
    });
    if (options.preloadCanonicalThreadArchived) archivedThreadIds.add(options.canonicalThreadId);
  }
  return {
    receive(frame, peer) {
      const request = parseJsonRpcMessage(frame);
      if (!isJsonRpcRequest(request)) return;
      const params = objectParams(request.params);
      if (request.method === "initialize") {
        peer.send(encodeJsonRpcMessage({ id: request.id, result: initializeResponse }));
        return;
      }
      if (request.method === "thread/list") {
        const searchTerm = params.searchTerm;
        if (typeof searchTerm === "string" && searchTerm.startsWith("lab-concurrency-")) {
          const marker = Number(searchTerm.slice("lab-concurrency-".length));
          sendLater(peer, encodeJsonRpcMessage({
            id: request.id,
            result: { data: [{ id: `echo-${marker}`, name: searchTerm }], nextCursor: null },
          }), Math.max(0, 12 - marker));
          return;
        }
        if (options.cyclicPaginationCursor) {
          const isContinuation = params.cursor === "cycle";
          peer.send(encodeJsonRpcMessage({
            id: request.id,
            result: {
              data: isContinuation ? [] : threads.slice(0, 1),
              nextCursor: "cycle",
              backwardsCursor: "head",
            },
          }));
          return;
        }
        const wantsArchived = params.archived === true;
        const available = options.emptyThreads
          ? []
          : visibleThreads.filter((thread) =>
              typeof thread.id === "string" && archivedThreadIds.has(thread.id) === wantsArchived);
        const requestedLimit = typeof params.limit === "number" ? params.limit : 1;
        const cursor = typeof params.cursor === "string" ? params.cursor : null;
        let offset = cursor?.startsWith("offset:") ? Number(cursor.slice("offset:".length)) : 0;
        if (options.overlapPagination && offset > 0) offset -= 1;
        const data = available.slice(offset, offset + requestedLimit);
        const nextOffset = offset + requestedLimit;
        const nextCursor = nextOffset < available.length ? `offset:${nextOffset}` : null;
        const response = encodeJsonRpcMessage({
          id: request.id,
          result: { data, nextCursor, backwardsCursor: "head" },
        });
        if ((options.threadListDelayMs ?? 0) > 0) {
          sendLater(peer, response, options.threadListDelayMs ?? 0);
        } else {
          peer.send(response);
        }
        return;
      }
      if (request.method === "thread/start") {
        options.startCounter && (options.startCounter.count += 1);
        const threadId = options.canonicalThreadId ?? "thread-canonical";
        if (!visibleThreads.some((thread) => thread.id === threadId)) {
          visibleThreads.splice(options.canonicalThreadIndex ?? 0, 0, {
            id: threadId,
            name: "Canonical Lab Thread",
            cwd: typeof params.cwd === "string" ? params.cwd : "/workspace",
            status: { type: "idle" },
            turns: [],
          });
        }
        peer.send(encodeJsonRpcMessage({
          id: request.id,
          result: { thread: visibleThreads.find((thread) => thread.id === threadId) },
        }));
        return;
      }
      if (request.method === "thread/archive" || request.method === "thread/unarchive") {
        const threadId = typeof params.threadId === "string" ? params.threadId : null;
        if (threadId === null || !visibleThreads.some((thread) => thread.id === threadId)) {
          peer.send(encodeJsonRpcMessage({
            id: request.id,
            error: { code: -32000, message: `Unknown thread ${String(threadId)}` },
          }));
          return;
        }
        if (request.method === "thread/archive") archivedThreadIds.add(threadId);
        else archivedThreadIds.delete(threadId);
        peer.send(encodeJsonRpcMessage({ id: request.id, result: {} }));
        return;
      }
      if (request.method === "thread/resume") {
        const threadId = typeof params.threadId === "string" ? params.threadId : "thread-one";
        if (!visibleThreads.some((thread) => thread.id === threadId)) {
          peer.send(encodeJsonRpcMessage({
            id: request.id,
            error: { code: -32000, message: `thread not found: ${threadId}` },
          }));
          return;
        }
        if (archivedThreadIds.has(threadId)) {
          peer.send(encodeJsonRpcMessage({
            id: request.id,
            error: {
              code: -32071,
              message: "workspace view has been destroyed; fork the archived conversation to continue",
            },
          }));
          return;
        }
        peer.send(encodeJsonRpcMessage({
          id: request.id,
          result: {
            thread: { ...threads[0], id: threadId },
            model: "codex",
            modelProvider: "openai",
            serviceTier: null,
            reasoningEffort: "high",
            cwd: "/workspace",
            approvalPolicy: "on-request",
            approvalsReviewer: "user",
            sandbox: { type: "workspaceWrite", writableRoots: ["/workspace"] },
            runtimeWorkspaceRoots: ["/workspace"],
            turnsBackwardsCursor: options.omitHistoryCursor ? null : "turns:older",
            itemsBackwardsCursor: "items:older",
            initialTurnsPage: {
              data: [{ id: "turn-current", items: [] }],
              nextCursor: null,
            },
          },
        }));
        return;
      }
      if (request.method === "thread/read") {
        const threadId = typeof params.threadId === "string" ? params.threadId : "thread-one";
        peer.send(encodeJsonRpcMessage({
          id: request.id,
          result: {
            thread: {
              ...threads[0],
              id: threadId,
              sessionId: `session:${threadId}`,
              path: `/rollouts/${threadId}.jsonl`,
              historyMode: "legacy",
              turns: [],
            },
          },
        }));
        return;
      }
      if (request.method === "thread/turns/list") {
        peer.send(encodeJsonRpcMessage({
          id: request.id,
          result: {
            data: [{ id: "turn-older", items: [] }],
            nextCursor: null,
            backwardsCursor: null,
          },
        }));
        return;
      }
      peer.send(encodeJsonRpcMessage({
        id: request.id,
        error: { code: -32601, message: `Unknown method ${request.method}` },
      }));
    },
  };
}

interface ScenarioResult {
  events: Array<Record<string, unknown>>;
  generation: number;
  pendingRequests: number;
  status: string;
}

async function runScenario(
  name: LabScenarioName,
  serverOptions: TestServerOptions = {},
  extraArgs: readonly string[] = [],
): Promise<ScenarioResult> {
  const lines: string[] = [];
  let now = 100;
  const reporter = new NdjsonReporter({ write: (line) => lines.push(line) }, { now: () => now++ });
  const options = parseLabArgs([
    "scenario", name,
    "--limit", "1",
    "--requests", "5",
    "--cycles", "3",
    "--timeout-ms", "80",
    "--inbound-latency-ms", "20",
    "--disconnect-after-ms", "1",
    ...extraArgs,
  ]);
  const transport = new FaultInjectingTransport({ transport: new MemoryTransport(server(serverOptions)) });
  const runtime = await createCordisAppServerRegistry();
  const client = runtime.clients.create({ hostId: "test", transport, requestTimeoutMs: 1_000 });
  try {
    await runLabCommand(options.command, { client, transport, reporter, options });
    return {
      generation: client.connectionGeneration,
      pendingRequests: client.getPendingRequestCount(),
      status: client.status.state,
      events: lines.map((line) => JSON.parse(line) as Record<string, unknown>),
    };
  } finally {
    await runtime.dispose();
  }
}

function event(result: ScenarioResult, name: string): Record<string, unknown> {
  const found = result.events.find((candidate) => candidate.event === name);
  assert.ok(found, `missing ${name} event`);
  return found;
}

test("initialize reports host capabilities and generation", async () => {
  const result = await runScenario("initialize");
  assert.equal(event(result, "appserver.initialized").platformOs, "linux");
  assert.equal(result.generation, 1);
});

test("smoke proves initialized content through public SDK APIs", async () => {
  const result = await runScenario("smoke");
  const listed = event(result, "thread.list");
  assert.equal(listed.count, 1);
  assert.equal((listed.threads as Array<{ title: string }>)[0]?.title, "Visible content");
});

test("pagination follows an opaque cursor without overlap", async () => {
  const result = await runScenario("pagination");
  const verified = event(result, "pagination.verified");
  assert.equal(verified.pages, 2);
  assert.deepEqual(verified.overlaps, []);
});

test("pagination fails loudly when the server repeats an item across pages", async () => {
  await assert.rejects(runScenario("pagination", { overlapPagination: true }), /pages overlap: thread-one/);
});

test("pagination rejects an empty page whose cursor cycles forever", async () => {
  await assert.rejects(
    runScenario("pagination", { cyclicPaginationCursor: true }),
    /cursor did not advance/,
  );
});

test("resume auto-selects a visible thread and exposes tail-hydration cursors", async () => {
  const result = await runScenario("resume");
  const resumed = event(result, "thread.resumed");
  assert.equal(resumed.threadId, "thread-one");
  assert.equal(resumed.turnsBackwardsCursor, "turns:older");
  assert.deepEqual(resumed.runtimeWorkspaceRoots, ["/workspace"]);
});

test("resume accepts an explicit thread id", async () => {
  const result = await runScenario("resume", {}, ["--thread", "thread-two"]);
  assert.equal(event(result, "thread.resumed").threadId, "thread-two");
});

test("resume fails deterministically when no thread can be selected", async () => {
  await assert.rejects(runScenario("resume", { emptyThreads: true }), /at least one listed thread/);
});

test("history follows the resume cursor into thread/turns/list", async () => {
  const result = await runScenario("history");
  const verified = event(result, "history.verified");
  assert.equal(verified.initialTurns, 1);
  assert.equal(verified.olderTurns, 1);
  assert.equal(verified.turnsBackwardsCursor, "turns:older");
});

test("history remains valid when no older-turn cursor exists", async () => {
  const result = await runScenario("history", { omitHistoryCursor: true });
  assert.equal(event(result, "history.verified").olderTurns, 0);
});

test("resume contract is idempotent, reconnect-safe, and rejects a missing ID", async () => {
  const result = await runScenario("resume-contract", {}, ["--thread", "thread-one"]);
  const verified = event(result, "resume-contract.verified");
  assert.deepEqual(verified.repeatedResumeIds, ["thread-one", "thread-one"]);
  assert.equal(verified.afterReconnectThreadId, "thread-one");
  assert.equal(verified.generation, 2);
  assert.equal(verified.missingThreadErrorCode, -32000);
  assert.equal(verified.pendingRequests, 0);
});

test("Desktop Resume commits a projected owner View through Cordis plugins", async () => {
  const result = await runScenario("desktop-resume", {}, ["--thread", "thread-one"]);
  const verified = event(result, "desktop-resume.verified");
  assert.equal(verified.threadId, "thread-one");
  assert.equal(verified.resumeState, "resumed");
  assert.deepEqual(verified.streamRole, { role: "owner" });
  assert.equal(verified.historySource, "tail");
  assert.equal(verified.turnCount, 1);
  assert.equal(verified.model, "codex");
  assert.equal(verified.cwd, "/workspace");
});

test("Replica Resume distinguishes cached paint from authoritative Codex V3 sync", async () => {
  const result = await runScenario("replica-resume", {}, ["--thread", "thread-one"]);
  const verified = event(result, "replica-resume.verified");
  assert.equal(verified.threadId, "thread-one");
  assert.equal(verified.protocol, "codex-v3-resume-adapter");
  assert.equal(verified.cachedPhase, "painted");
  assert.equal(verified.cachedAuthoritative, false);
  assert.equal(verified.livePhase, "live");
  assert.equal(verified.liveAuthoritative, true);
  assert.equal(verified.entities, 1);
  assert.equal(verified.turnCount, 1);
  assert.equal(
    typeof verified.nextSeq === "number" && typeof verified.firstCursor === "number"
      ? verified.nextSeq > verified.firstCursor
      : false,
    true,
  );
});

test("canonical session starts once, finds the same ID through pagination, and resumes it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencraft-canonical-thread-"));
  const identityFile = join(directory, "identity.json");
  const startCounter = { count: 0 };
  try {
    const first = await runScenario("canonical-session", {
      canonicalThreadId: "thread-canonical",
      canonicalThreadIndex: 1,
      startCounter,
    }, ["--identity-file", identityFile, "--model", "auto", "--cwd", "/workspace"]);
    const verified = event(first, "canonical-session.verified");
    assert.equal(verified.threadId, "thread-canonical");
    assert.equal(verified.resumedThreadId, "thread-canonical");
    assert.equal(verified.listedPages, 2);
    assert.equal(verified.stateBeforeCleanup, "active");
    assert.equal(verified.resumed, true);
    assert.equal(verified.singleCanonicalId, true);
    assert.equal(verified.created, true);
    assert.equal(event(first, "canonical-thread.finally-archived").threadId, "thread-canonical");
    assert.equal(startCounter.count, 1);

    const second = await runScenario("canonical-session", {
      canonicalThreadId: "thread-canonical",
      canonicalThreadIndex: 1,
      preloadCanonicalThread: true,
      preloadCanonicalThreadArchived: true,
      startCounter,
    }, ["--identity-file", identityFile]);
    assert.equal(event(second, "canonical-thread.resolved").source, "persisted");
    assert.equal(event(second, "canonical-session.verified").created, false);
    assert.equal(event(second, "canonical-session.verified").stateBeforeCleanup, "archived");
    assert.equal(event(second, "canonical-session.verified").resumed, false);
    assert.equal(event(second, "canonical-session.verified").archivedResumeErrorCode, -32071);
    assert.equal(
      event(second, "canonical-thread.archived-resume-rejected").threadId,
      "thread-canonical",
    );
    assert.equal(event(second, "canonical-thread.finally-archived").threadId, "thread-canonical");
    assert.equal(startCounter.count, 1, "a persisted identity must never call thread/start again");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("canonical session never replaces a persisted ID that is missing from thread/list", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencraft-missing-canonical-thread-"));
  const identityFile = join(directory, "identity.json");
  const startCounter = { count: 0 };
  try {
    await runScenario("canonical-session", {
      canonicalThreadId: "thread-canonical",
      startCounter,
    }, ["--identity-file", identityFile]);
    await assert.rejects(
      runScenario("canonical-session", { startCounter }, ["--identity-file", identityFile]),
      /Unknown thread/,
    );
    assert.equal(startCounter.count, 1, "missing canonical state must fail instead of creating a replacement ID");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("concurrency correlates out-of-order replies and drains pending state", async () => {
  const result = await runScenario("concurrency");
  const verified = event(result, "concurrency.verified");
  assert.equal(verified.requested, 5);
  assert.equal(verified.completed, 5);
  assert.equal(verified.uniqueRequestIds, 5);
  assert.equal(verified.correlatedEchoes, 5);
  assert.equal(verified.peakPendingRequests, 5);
  assert.equal(verified.pendingRequests, 0);
});

test("timeout rejects only the request and leaves the transport usable", async () => {
  const result = await runScenario("timeout");
  const verified = event(result, "timeout.verified");
  assert.equal((verified.error as { code: string }).code, "TIMEOUT");
  assert.equal(verified.transportState, "open");
  assert.equal(verified.pendingRequests, 0);
  assert.equal(result.status, "open");
});

test("abort isolates the delayed response and a subsequent request still succeeds", async () => {
  const result = await runScenario("abort");
  const verified = event(result, "abort.verified");
  assert.equal((verified.error as { code: string }).code, "ABORTED");
  assert.equal(verified.lateResponses, 1);
  assert.equal(verified.pendingRequests, 0);
  assert.equal(result.events.filter((entry) => entry.event === "thread.list").length, 1);
});

test("abort waits for a late response whose server turnaround exceeds injected latency", async () => {
  const result = await runScenario("abort", { threadListDelayMs: 35 });
  assert.equal(event(result, "abort.verified").lateResponses, 1);
});

test("reconnect interrupts in-flight work and advances generation", async () => {
  const result = await runScenario("reconnect");
  assert.equal(result.generation, 2);
  assert.ok(result.events.some((entry) => entry.event === "fault.disconnect.observed"));
  const verified = event(result, "reconnect.verified");
  assert.equal(verified.pendingRequests, 0);
  assert.equal(verified.sameVisibleThreadHead, true);
});

test("reconnect-loop survives repeated disconnects without state leakage", async () => {
  const result = await runScenario("reconnect-loop");
  assert.equal(result.generation, 4);
  assert.equal(result.events.filter((entry) => entry.event === "reconnect.cycle").length, 3);
  assert.equal(event(result, "reconnect-loop.verified").cycles, 3);
  assert.equal(result.pendingRequests, 0);
});

test("suite executes every safe non-creating lab case", async () => {
  const result = await runScenario("suite");
  const verified = event(result, "suite.verified");
  assert.deepEqual(verified.cases, [
    "smoke", "pagination", "resume", "resume-contract", "history", "concurrency", "timeout", "abort", "reconnect",
  ]);
  assert.equal(result.events.filter((entry) => entry.event === "suite.case.completed").length, 9);
});
