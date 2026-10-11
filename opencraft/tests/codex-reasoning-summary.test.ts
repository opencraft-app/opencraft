import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { LOGICAL_CLIENT_FIELD } from "@opencraft/app-host-protocol";
import type { DuplexTransport, TransportStatus } from "@opencraft/appserver-client/transport";
import { CodexEngineAdapter } from "../apps/opencraft-daemon/src/codex-engine-adapter.js";

type Frame = Record<string, unknown>;
const clientId = "synthetic-summary-client";
const paramsOf = (frame: Frame): Frame => frame.params as Frame;
const resultOf = (frame: Frame): Frame => frame.result as Frame;

async function waitFor(frames: readonly Frame[], predicate: (frame: Frame) => boolean): Promise<Frame> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const found = frames.find(predicate);
    if (found) return found;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for synthetic Codex summary frame");
}

/** Only the external physical connection is replaced; routing uses the real adapter. */
class SyntheticRemote implements DuplexTransport {
  status: TransportStatus = { state: "idle" };
  readonly writes: Frame[] = [];
  private readonly messages = new Set<(frame: string) => void>();
  private readonly statuses = new Set<(status: TransportStatus) => void>();
  private nextThread = 0;
  private nextTurn = 0;

  async connect(): Promise<void> { this.publish({ state: "open" }); }
  async close(): Promise<void> { this.publish({ state: "closed" }); }
  subscribeMessage(listener: (frame: string) => void): () => void {
    this.messages.add(listener);
    return () => this.messages.delete(listener);
  }
  subscribeStatus(listener: (status: TransportStatus) => void): () => void {
    this.statuses.add(listener);
    return () => this.statuses.delete(listener);
  }
  emit(frame: Frame): void {
    for (const listener of this.messages) listener(JSON.stringify(frame));
  }
  private publish(status: TransportStatus): void {
    this.status = status;
    for (const listener of this.statuses) listener(status);
  }
  async send(wire: string): Promise<void> {
    const frame = JSON.parse(wire) as Frame;
    this.writes.push(frame);
    if (typeof frame.id !== "string" && typeof frame.id !== "number") return;
    const params = (frame.params ?? {}) as Frame;
    let result: Frame = {};
    if (frame.method === "initialize") {
      result = { serverInfo: { name: "synthetic-codex", version: "1" } };
    } else if (frame.method === "thread/start" || frame.method === "thread/fork") {
      result = { thread: { id: `remote-thread-${++this.nextThread}`, turns: [] } };
    } else if (frame.method === "thread/resume") {
      result = { thread: { id: params.threadId, turns: [] } };
    } else if (frame.method === "turn/start") {
      // This synthetic native peer, not the Host, validates explicit modes.
      if (Object.hasOwn(params, "summary") && params.summary !== null
        && !["auto", "none", "concise", "detailed"].includes(params.summary as string)) {
        this.emit({ id: frame.id, error: { code: -32602, message: "Invalid native summary mode" } });
        return;
      }
      result = { turn: { id: `remote-turn-${++this.nextTurn}`, status: "inProgress", items: [] } };
    } else if (frame.method === "turn/steer") {
      result = { turnId: params.expectedTurnId };
    } else if (frame.method === "model/list") {
      result = { data: [], nextCursor: null };
    }
    this.emit({ id: frame.id, result });
  }
}

interface Harness {
  readonly adapter: CodexEngineAdapter;
  readonly frames: Frame[];
  readonly writes: Frame[];
  request(method: string, params?: Frame, id?: string | number): Promise<Frame>;
  close(): Promise<void>;
}

async function createHarness(kind: "local" | "remote", emitSummaryStream = false): Promise<Harness & { remote?: SyntheticRemote }> {
  const frames: Frame[] = [];
  const writes: Frame[] = [];
  const root = kind === "local" ? await mkdtemp(join(tmpdir(), "opencraft-codex-summary-")) : null;
  const remote = kind === "remote" ? new SyntheticRemote() : undefined;
  const adapter = remote
    ? new CodexEngineAdapter({ kind: "remote", transport: remote, logDiagnostic: () => undefined })
    : new CodexEngineAdapter({
      executable: process.execPath,
      runtimeDirectory: root!,
      dataDirectory: join(root!, "data"),
      nativeCodexHomeDirectory: join(root!, "isolated-empty-codex-home"),
      logDiagnostic: () => undefined,
      upstreamBaseUrl: "http://127.0.0.1:9/synthetic-only",
      fetch: async () => { throw new Error("Synthetic summary tests must not perform model/account HTTP requests"); },
      createMaintenanceClient: async () => { throw new Error("Synthetic summary tests must not start maintenance clients"); },
      spawnAppServer: ({ cwd, env }) => {
        const fixture = new URL("./fixtures/fake-codex-stdio-appserver.mjs", import.meta.url);
        // A test-local synthetic peer extension leaves the shared fixture
        // unchanged. It echoes only supplied synthetic events over real stdio.
        const childArgs = emitSummaryStream ? ["--input-type=module", "--eval", `
          import ${JSON.stringify(fixture.href)};
          import { createInterface } from "node:readline";
          createInterface({ input: process.stdin }).on("line", line => {
            const frame = JSON.parse(line);
            if (frame.method === "test/emitReasoningSummaryStream") {
              for (const event of frame.params.events) process.stdout.write(JSON.stringify(event) + "\\n");
            }
          });
        `] : [fixture.pathname];
        const child = spawn(process.execPath,
          childArgs, {
            cwd, env: { CODEX_HOME: env.CODEX_HOME }, stdio: ["pipe", "pipe", "pipe"],
          });
        const write = child.stdin.write.bind(child.stdin);
        let buffer = "";
        child.stdin.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
          buffer += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
          let end: number;
          while ((end = buffer.indexOf("\n")) !== -1) {
            writes.push(JSON.parse(buffer.slice(0, end)) as Frame);
            buffer = buffer.slice(end + 1);
          }
          return (write as (...args: unknown[]) => boolean)(chunk, ...rest);
        }) as typeof child.stdin.write;
        return child;
      },
    });
  adapter.subscribeMessage(frame => frames.push(JSON.parse(frame) as Frame));
  let sequence = 0;
  const request = async (method: string, params: Frame = {}, id: string | number = `request-${++sequence}`) => {
    const message = { id, method, params, [LOGICAL_CLIENT_FIELD]: clientId };
    const snapshot = structuredClone(message);
    await adapter.send(JSON.stringify(message));
    assert.deepEqual(message, snapshot, "the caller's request must remain unchanged");
    return waitFor(frames, frame => frame.id === id);
  };
  const close = async () => {
    await adapter.close();
    if (root) await rm(root, { recursive: true, force: true });
  };
  try {
    await adapter.connect();
    assert.ok((await request("initialize")).result);
    return { adapter, frames, writes: remote?.writes ?? writes, request, close, remote };
  } catch (error) {
    await close();
    throw error;
  }
}

function physicalTurn(harness: Harness, marker: string): Frame {
  const frame = harness.writes.find(frame => frame.method === "turn/start"
    && paramsOf(frame).clientUserMessageId === marker);
  assert.ok(frame, `native turn/start must be written for ${marker}`);
  return frame;
}

for (const kind of ["local", "remote"] as const) {
  test(`${kind} Codex physical starts request automatic summaries for new, existing, forked, resumed and empty-input turns`, async t => {
    const harness = await createHarness(kind);
    t.after(() => harness.close());
    const { request } = harness;
    const started = await request("thread/start", { testNoServerRequest: true });
    const newId = (resultOf(started).thread as Frame).id;
    const forked = await request("thread/fork", { threadId: newId });
    const forkId = (resultOf(forked).thread as Frame).id;
    const resumed = await request("thread/resume", { threadId: "resumed-summary-thread" });
    const resumeId = (resultOf(resumed).thread as Frame).id;
    const entries = [
      { marker: "new", threadId: newId, input: [{ type: "text", text: "new turn" }] },
      { marker: "fork", threadId: forkId, input: [{ type: "text", text: "fork turn" }] },
      { marker: "resume", threadId: resumeId, input: [{ type: "text", text: "resumed turn" }] },
      { marker: "direct-existing", threadId: newId, input: [{ type: "text", text: "next turn" }] },
      { marker: "empty-continuation", threadId: resumeId, input: [] },
    ];
    for (const entry of entries) {
      const response = await request("turn/start", {
        threadId: entry.threadId, input: entry.input, clientUserMessageId: entry.marker,
        model: "synthetic-model", effort: "high",
      }, entry.marker === "direct-existing" ? 0 : `turn-${entry.marker}`);
      assert.ok(response.result, `${entry.marker} is admitted by the synthetic native peer`);
      assert.deepEqual(paramsOf(physicalTurn(harness, entry.marker)), {
        threadId: entry.threadId, input: entry.input, clientUserMessageId: entry.marker,
        model: "synthetic-model", effort: "high", summary: "auto",
      });
      if (kind === "local") await request("test/completeTurn", { threadId: entry.threadId });
    }
    const lifecycle = harness.writes.filter(frame => ["initialize", "thread/start", "thread/fork", "thread/resume"].includes(frame.method as string));
    assert.equal(lifecycle.length, 4);
    for (const frame of lifecycle) assert.equal(Object.hasOwn(paramsOf(frame), "summary"), false);
  });

  test(`${kind} Codex preserves explicit summary modes, null and invalid values for native validation`, async t => {
    const harness = await createHarness(kind);
    t.after(() => harness.close());
    const values: unknown[] = [null, "none", "concise", "detailed", "auto", "invalid", "", false, 3, { mode: "auto" }, ["auto"]];
    for (const [index, summary] of values.entries()) {
      const marker = `explicit-${index}`;
      const response = await harness.request("turn/start", {
        threadId: marker, input: [], clientUserMessageId: marker, summary,
      });
      assert.deepEqual(paramsOf(physicalTurn(harness, marker)).summary, summary);
      if (kind === "remote" && index >= 5) {
        assert.equal((response.error as Frame).code, -32602, "invalid values reach the synthetic native validator unchanged");
      } else assert.ok(response.result);
    }
  });

  test(`${kind} Codex never adds the summary option to steer, Thread lifecycle or unrelated methods`, async t => {
    const harness = await createHarness(kind);
    t.after(() => harness.close());
    await harness.request("thread/resume", { threadId: "other-methods-thread" });
    const started = await harness.request("turn/start", {
      threadId: "other-methods-thread", input: [], clientUserMessageId: "other-methods-start",
    });
    const turnId = (resultOf(started).turn as Frame).id;
    for (const method of ["turn/steer", "turn/interrupt", "thread/start", "thread/fork", "thread/resume", "thread/read", "model/list"]) {
      for (const explicit of [false, true]) {
        const cursor = harness.writes.length;
        await harness.request(method, {
          threadId: "other-methods-thread", expectedTurnId: turnId, turnId,
          input: [], testNoServerRequest: true, ...(explicit ? { summary: null } : {}),
        });
        const forwarded = harness.writes.slice(cursor).find(frame => frame.method === method);
        assert.ok(forwarded, `native peer must receive ${method}`);
        assert.equal(Object.hasOwn(paramsOf(forwarded), "summary"), explicit);
        if (explicit) assert.equal(paramsOf(forwarded).summary, null);
      }
    }
  });
}

test("Host-owned queued starts use the same automatic-summary physical writer, independently of the prior Turn's explicit none", async t => {
  const harness = await createHarness("local");
  t.after(() => harness.close());
  await harness.request("thread/resume", { threadId: "queue-summary-thread" });
  const first = await harness.request("turn/start", {
    threadId: "queue-summary-thread", input: [], clientUserMessageId: "queue-first", summary: "none",
  });
  const firstTurnId = (resultOf(first).turn as Frame).id;
  const steered = await harness.request("thread/queue/add", {
    threadId: "queue-summary-thread", input: [{ type: "text", text: "queued steer" }], clientUserMessageId: "queue-steered",
  });
  const queueId = (resultOf(steered).queuedSubmission as Frame).id;
  assert.ok((await harness.request("thread/queue/steer", {
    threadId: "queue-summary-thread", queuedSubmissionId: queueId, expectedTurnId: firstTurnId,
  })).result);
  const nativeSteer = harness.writes.find(frame => frame.method === "turn/steer"
    && paramsOf(frame).clientUserMessageId === "queue-steered");
  assert.ok(nativeSteer);
  assert.match(String(nativeSteer.id), /^opencraft:host:/);
  assert.equal(Object.hasOwn(paramsOf(nativeSteer), "summary"), false, "Host-internal steer must not receive a turn/start default");
  await harness.request("thread/queue/add", {
    threadId: "queue-summary-thread", input: [{ type: "text", text: "queued turn" }], clientUserMessageId: "queue-next",
  });
  await harness.request("test/completeTurn", { threadId: "queue-summary-thread" });
  await waitFor(harness.frames, frame => frame.method === "turn/started"
    && (paramsOf(frame).turn as Frame).id !== firstTurnId);
  const queued = physicalTurn(harness, "queue-next");
  assert.match(String(queued.id), /^opencraft:host:/, "the automatic queue dispatch is a Host-internal native request");
  assert.deepEqual(paramsOf(queued), {
    threadId: "queue-summary-thread", input: [{ type: "text", text: "queued turn" }],
    clientUserMessageId: "queue-next", summary: "auto",
  });
  assert.equal(paramsOf(physicalTurn(harness, "queue-first")).summary, "none");
  assert.equal(harness.writes.some(frame => String(frame.method).startsWith("thread/queue/")), false);
});

for (const kind of ["local", "remote"] as const) {
  test(`${kind} returned native reasoning summary stream events remain exact, ordered and logically routed`, async t => {
    const harness = await createHarness(kind, kind === "local");
    t.after(() => harness.close());
    await harness.request("thread/resume", { threadId: "summary-stream-thread" });
    const started = await harness.request("turn/start", {
      threadId: "summary-stream-thread", input: [], clientUserMessageId: "summary-stream",
    });
    const turnId = (resultOf(started).turn as Frame).id;
    const events = [
      { method: "item/started", params: { threadId: "summary-stream-thread", turnId,
        item: { id: "reasoning-stream", type: "reasoning", summary: [], content: [] } } },
      { method: "item/reasoning/summaryPartAdded", params: { threadId: "summary-stream-thread", turnId,
        itemId: "reasoning-stream", summaryIndex: 0 } },
      { method: "item/reasoning/summaryTextDelta", params: { threadId: "summary-stream-thread", turnId,
        itemId: "reasoning-stream", summaryIndex: 0, delta: "Checking " } },
      { method: "item/reasoning/summaryTextDelta", params: { threadId: "summary-stream-thread", turnId,
        itemId: "reasoning-stream", summaryIndex: 0, delta: "the result." } },
      { method: "item/completed", params: { threadId: "summary-stream-thread", turnId,
        item: { id: "reasoning-stream", type: "reasoning", summary: ["Checking the result."], content: [] } } },
    ];
    const cursor = harness.frames.length;
    if (kind === "remote") {
      for (const event of events) harness.remote!.emit(event);
    } else {
      await harness.request("test/emitReasoningSummaryStream", { events });
      await waitFor(harness.frames, frame => frame.method === "item/completed"
        && (paramsOf(frame).item as Frame).id === "reasoning-stream");
    }
    assert.deepEqual(harness.frames.slice(cursor).filter(frame => typeof frame.method === "string"),
      events.map(event => ({ ...event, [LOGICAL_CLIENT_FIELD]: clientId })));
  });
}

test("physical summary default respects request identity and own-property presence without mutating frozen caller objects", async t => {
  const harness = await createHarness("remote");
  t.after(() => harness.close());
  // Public send accepts a serialized string. Exercise the writer's object
  // boundary directly as well, so accidental in-place mutation is observable.
  const writer = harness.adapter as unknown as { writePhysical(frame: Frame): Promise<void> | void };
  const cases: Array<{ message: Frame; expectedSummary: unknown; present: boolean }> = [
    { message: { id: 0, method: "turn/start", params: { input: [] } }, expectedSummary: "auto", present: true },
    { message: { id: "", method: "turn/start", params: {} }, expectedSummary: "auto", present: true },
    { message: { id: "native", method: "turn/start" }, expectedSummary: "auto", present: true },
    { message: { id: "native", method: "turn/start", params: null }, expectedSummary: "auto", present: true },
    { message: { method: "turn/start", params: {} }, expectedSummary: undefined, present: false },
    { message: { id: null, method: "turn/start", params: {} }, expectedSummary: undefined, present: false },
    { message: { id: false, method: "turn/start", params: {} }, expectedSummary: undefined, present: false },
    { message: { id: {}, method: "turn/start", params: {} }, expectedSummary: undefined, present: false },
    { message: { id: "native", method: "turn/steer", params: {} }, expectedSummary: undefined, present: false },
    { message: { id: "native", result: {} }, expectedSummary: undefined, present: false },
    { message: { id: "native", method: "turn/start", params: { summary: null } }, expectedSummary: null, present: true },
    { message: { id: "native", method: "turn/start", params: { summary: undefined } }, expectedSummary: undefined, present: false },
  ];
  for (const { message, expectedSummary, present } of cases) {
    if (message.params && typeof message.params === "object") Object.freeze(message.params);
    Object.freeze(message);
    const originalParams = message.params;
    const snapshot = structuredClone(message);
    await writer.writePhysical(message);
    const forwarded = harness.writes.at(-1)!;
    assert.equal(Object.hasOwn((forwarded.params ?? {}) as Frame, "summary"), present);
    assert.deepEqual(((forwarded.params ?? {}) as Frame).summary, expectedSummary);
    assert.deepEqual(message, snapshot);
    assert.equal(message.params, originalParams);
  }
  const inheritedParams = Object.freeze(Object.assign(Object.create({ summary: "none" }) as Frame, { input: [] }));
  const inheritedMessage = Object.freeze({ id: "inherited", method: "turn/start", params: inheritedParams });
  await writer.writePhysical(inheritedMessage);
  assert.equal(paramsOf(harness.writes.at(-1)!).summary, "auto", "an inherited property is not an explicit caller field");
  assert.equal(inheritedParams.summary, "none");
  assert.equal(Object.hasOwn(inheritedParams, "summary"), false);
});
