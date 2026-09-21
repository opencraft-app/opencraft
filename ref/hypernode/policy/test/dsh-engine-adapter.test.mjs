import assert from "node:assert/strict";
import test from "node:test";

import { DshEngineAdapterService } from "../src/services/dsh-engine-adapter.js";
import { DshAppServerProjectionService } from "../src/services/dsh-appserver-projection.ts";
import { ShellCommandClassifierService } from "../src/services/shell-command-classifier.js";
import { TurnManagerService } from "../src/services/turn-manager.ts";

test("DSH awaits an asynchronous Vela browser capability and returns it to the worker", async () => {
  const runtimeCommands = [];
  let resolveCapability;
  const capabilityResult = new Promise((resolve) => { resolveCapability = resolve; });
  const service = Object.create(DshEngineAdapterService.prototype);
  service.ctx = {
    agentCapabilityEgress: {
      execute: () => capabilityResult,
    },
    dshRuntimeHost: {
      send: (processId, message) => runtimeCommands.push({ processId, message }),
    },
  };
  const worker = {
    threadId: "thread-1",
    processId: "worker-1",
    active: {
      connection: { identity: { id: "user-1" } },
      record: { turn: { id: "turn-1" } },
    },
  };
  service.onWorkerMessage(worker, {
    type: "capability-request",
    requestId: "call-1",
    capabilityId: "vela.browser.open",
    arguments: { url: "http://127.0.0.1:5173/" },
  });
  assert.deepEqual(runtimeCommands, []);
  resolveCapability({ text: "opened" });
  await Promise.resolve();
  assert.deepEqual(runtimeCommands, [{
    processId: "worker-1",
    message: {
      type: "capability-response",
      requestId: "call-1",
      result: { text: "opened" },
    },
  }]);
});

test("DSH capability cancellation is forwarded to the client egress boundary", () => {
  const cancellations = [];
  const service = Object.create(DshEngineAdapterService.prototype);
  service.ctx = {
    agentCapabilityEgress: {
      cancel: (...args) => cancellations.push(args),
    },
  };
  service.onWorkerMessage({ threadId: "thread-1" }, {
    type: "capability-cancel",
    requestId: "call-1",
  });
  assert.deepEqual(cancellations, [[
    "thread-1", "call-1", "DSH cancelled the browser capability call",
  ]]);
});

test("DSH registers a new native ledger only after the worker materializes it", () => {
  const persisted = [];
  const service = Object.create(DshEngineAdapterService.prototype);
  service.workers = new Map();
  service.ctx = {
    dshNativeSessionStore: {
      remember: (...args) => persisted.push(["remember", ...args]),
    },
  };
  const worker = { threadId: "thread-1", active: null };
  service.workers.set(worker.threadId, worker);
  const snapshot = {
    sessionId: "hypernode-dsh-thread-1",
    header: { id: "hypernode-dsh-thread-1", version: 0, createdAt: 1 },
    provenance: "native",
  };

  service.onWorkerMessage(worker, {
    type: "initialized",
    snapshot: { ...snapshot, materialized: false },
  });
  assert.deepEqual(persisted, []);
  service.onWorkerMessage(worker, {
    type: "session-materialized",
    sessionId: snapshot.sessionId,
    snapshot: { ...snapshot, materialized: true },
  });

  assert.equal(worker.initialized, true);
  assert.deepEqual(persisted, [
    ["remember", "thread-1", { ...snapshot, materialized: true }, "native"],
  ]);
});

test("DSH immediately registers a resumed authoritative native ledger", () => {
  const persisted = [];
  const service = Object.create(DshEngineAdapterService.prototype);
  service.workers = new Map();
  service.ctx = {
    dshNativeSessionStore: {
      remember: (...args) => persisted.push(args),
    },
  };
  const worker = { threadId: "thread-1", active: null };
  service.workers.set(worker.threadId, worker);
  const snapshot = {
    sessionId: "hypernode-dsh-thread-1",
    header: { id: "hypernode-dsh-thread-1", version: 0, createdAt: 1 },
    provenance: "dsh-sqlite-resume",
    materialized: true,
  };

  service.onWorkerMessage(worker, { type: "initialized", snapshot });

  assert.deepEqual(persisted, [["thread-1", snapshot, "dsh-sqlite-resume"]]);
});

test("a descriptor registry failure never terminates the authoritative DSH runtime", () => {
  const failures = [];
  const service = Object.create(DshEngineAdapterService.prototype);
  service.workers = new Map();
  service.failWorker = (...args) => failures.push(args);
  service.ctx = {
    dshNativeSessionStore: {
      remember: () => { throw new Error("descriptor unavailable"); },
    },
  };
  const worker = { threadId: "thread-1", active: null };
  service.workers.set(worker.threadId, worker);

  service.onWorkerMessage(worker, {
    type: "initialized",
    snapshot: {
      sessionId: "hypernode-dsh-thread-1",
      header: { id: "hypernode-dsh-thread-1", version: 0, createdAt: 1 },
      provenance: "dsh-sqlite-resume",
      materialized: true,
    },
  });
  service.onWorkerMessage(worker, {
    type: "session-event",
    sessionId: "hypernode-dsh-thread-1",
    event: { type: "turn/start", seq: 0, time: 2, data: { turn: 1 } },
  });

  assert.equal(worker.initialized, true);
  assert.deepEqual(failures, []);
  assert.equal(service.workers.get("thread-1"), worker);
});

test("a cold DSH worker dispatches only after its initialized readiness event", () => {
  const runtimeCommands = [];
  const service = Object.create(DshEngineAdapterService.prototype);
  service.workers = new Map();
  service.ctx = {
    dshNativeSessionStore: { remember() {} },
    dshRuntimeHost: {
      send: (processId, message) => runtimeCommands.push({ processId, message }),
    },
  };
  const worker = {
    threadId: "thread-1",
    processId: "worker-1",
    initialized: false,
    lifecycle: "starting",
    active: {
      completed: false,
      requestId: "request-1",
      record: { turn: { id: "turn-1" } },
      pendingUserInputs: [{ input: [{ type: "text", text: "hello" }] }],
      turnDispatched: false,
      startupDeadlineMs: Date.now() + 60_000,
      dispatchDeadlineMs: null,
    },
  };
  service.workers.set(worker.threadId, worker);

  assert.equal(service.dispatchActiveTurn(worker), false);
  assert.deepEqual(runtimeCommands, []);
  service.onWorkerMessage(worker, {
    type: "initialized",
    snapshot: {
      sessionId: "hypernode-dsh-thread-1",
      header: { id: "hypernode-dsh-thread-1" },
      materialized: false,
    },
  });

  assert.equal(worker.initialized, true);
  assert.equal(worker.lifecycle, "ready");
  assert.equal(worker.active.turnDispatched, true);
  assert.equal(worker.active.startupDeadlineMs, null);
  assert.ok(worker.active.dispatchDeadlineMs > Date.now());
  assert.deepEqual(runtimeCommands, [{
    processId: "worker-1",
    message: {
      type: "turn/start",
      requestId: "request-1",
      turnId: "turn-1",
      input: [{ type: "text", text: "hello" }],
    },
  }]);
});

test("preparing a DSH thread starts one reusable worker before the first Turn", () => {
  const creations = [];
  const service = Object.create(DshEngineAdapterService.prototype);
  service.workers = new Map();
  service.runtimeRoute = (username, providerId) => ({
    providerId,
    model: "model-1",
    displayName: "Model 1",
    gatewayBaseURL: "http://127.0.0.1:9988/providers/provider-1/v1",
  });
  service.createWorker = (options) => {
    creations.push(options);
    return {
      threadId: options.threadId,
      profileFingerprint: options.profile.fingerprint,
      capabilityFingerprint: options.capabilityFingerprint,
      active: null,
      initialized: false,
      prewarmed: options.prewarm,
    };
  };
  service.ctx = {
    userDirectory: { find: () => ({ username: "alice" }) },
    modelGateway: { resolveGatewayRoute: () => ({ model: "model-1" }) },
    modelMetadata: {
      inputModalitiesForRecord: () => ["text"],
      supportsRecordInput: () => false,
    },
    threadManager: {
      get: () => ({ id: "thread-1", cwd: "/workspace/projects/demo", turns: [] }),
    },
    canonicalTimeline: { turns: () => [] },
    dshNativeSessionStore: { has: () => false },
    threadExecution: {
      nativeHistory: () => ({ available: true, attempts: 0, nativeStarts: 0 }),
    },
  };
  const request = {
    threadId: "thread-1",
    profile: { engineKind: "dsh", providerId: "provider-1", fingerprint: "profile-1" },
    credential: { userId: "user-1" },
    filesystem: {},
    cwd: "/workspace/projects/demo",
    prewarm: true,
  };

  const first = service.prepareThread(request);
  const second = service.prepareThread({ ...request, prewarm: false });

  assert.equal(first, second);
  assert.equal(service.workers.get("thread-1"), first);
  assert.equal(creations.length, 1);
  assert.equal(creations[0].prewarm, true);
  assert.equal(Object.hasOwn(creations[0], "migrationHistory"), false);
});

test("a failed outer Turn without native turn/start may bootstrap a fresh DSH ledger", () => {
  const creations = [];
  const service = Object.create(DshEngineAdapterService.prototype);
  service.workers = new Map();
  service.runtimeRoute = () => ({ model: "model-1" });
  service.createWorker = (options) => {
    creations.push(options);
    return {
      threadId: options.threadId,
      profileFingerprint: options.profile.fingerprint,
      capabilityFingerprint: options.capabilityFingerprint,
    };
  };
  service.ctx = {
    userDirectory: { find: () => ({ username: "alice" }) },
    modelGateway: { resolveGatewayRoute: () => ({ model: "model-1" }) },
    modelMetadata: { inputModalitiesForRecord: () => ["text"] },
    threadManager: { get: () => ({ cwd: "/workspace/projects/demo" }) },
    canonicalTimeline: { turns: () => [{ id: "failed-outer-turn" }] },
    dshNativeSessionStore: { has: () => false },
    threadExecution: {
      nativeHistory: () => ({ available: true, attempts: 2, nativeStarts: 0 }),
    },
  };

  service.prepareThread({
    threadId: "thread-1",
    profile: { engineKind: "dsh", providerId: "provider-1", fingerprint: "profile-1" },
    credential: { userId: "user-1" },
    filesystem: {},
  });

  assert.equal(creations.length, 1);
  assert.equal(creations[0].expectExistingSession, false);
});

test("a stale prewarm pointer may bootstrap when no native turn ever started", () => {
  const creations = [];
  const service = Object.create(DshEngineAdapterService.prototype);
  service.workers = new Map();
  service.runtimeRoute = () => ({ model: "model-1" });
  service.createWorker = (options) => {
    creations.push(options);
    return {
      threadId: options.threadId,
      profileFingerprint: options.profile.fingerprint,
      capabilityFingerprint: options.capabilityFingerprint,
    };
  };
  service.ctx = {
    userDirectory: { find: () => ({ username: "alice" }) },
    modelGateway: { resolveGatewayRoute: () => ({ model: "model-1" }) },
    modelMetadata: { inputModalitiesForRecord: () => ["text"] },
    threadManager: { get: () => ({ cwd: "/workspace/projects/demo" }) },
    canonicalTimeline: { turns: () => [{ id: "failed-outer-turn" }] },
    dshNativeSessionStore: {
      currentSessionId: () => "hypernode-dsh-thread-1",
      has: () => true,
    },
    threadExecution: {
      nativeHistory: () => ({ available: true, attempts: 1, nativeStarts: 0 }),
    },
  };

  service.prepareThread({
    threadId: "thread-1",
    profile: { engineKind: "dsh", providerId: "provider-1", fingerprint: "profile-1" },
    credential: { userId: "user-1" },
    filesystem: {},
  });

  assert.equal(creations.length, 1);
  assert.equal(creations[0].currentSessionId, "hypernode-dsh-thread-1");
  assert.equal(creations[0].expectExistingSession, false);
});

test("a projected history without durable pre-native failure evidence still requires migration", () => {
  const service = Object.create(DshEngineAdapterService.prototype);
  service.workers = new Map();
  service.runtimeRoute = () => ({ model: "model-1" });
  service.ctx = {
    userDirectory: { find: () => ({ username: "alice" }) },
    modelGateway: { resolveGatewayRoute: () => ({ model: "model-1" }) },
    modelMetadata: { inputModalitiesForRecord: () => ["text"] },
    threadManager: { get: () => ({ cwd: "/workspace/projects/demo" }) },
    canonicalTimeline: { turns: () => [{ id: "historical-turn" }] },
    dshNativeSessionStore: { has: () => false },
    threadExecution: {
      nativeHistory: () => ({ available: true, attempts: 1, nativeStarts: 1 }),
    },
  };

  assert.throws(() => service.prepareThread({
    threadId: "thread-1",
    profile: { engineKind: "dsh", providerId: "provider-1", fingerprint: "profile-1" },
    credential: { userId: "user-1" },
    filesystem: {},
  }), /explicit engine migration/);
});

test("an unused prewarmed DSH worker is retired after its bounded idle window", () => {
  const stopped = [];
  const service = Object.create(DshEngineAdapterService.prototype);
  service.workers = new Map();
  service.stopWorker = (worker) => stopped.push(worker.processId);
  service.ctx = {
    dshRuntimeHost: {
      drain: () => ({ stdoutLines: [], stderrLines: [], exited: false }),
    },
  };
  const worker = {
    threadId: "thread-1",
    processId: "worker-1",
    active: null,
    prewarmed: true,
    used: false,
    prewarmExpiresAtMs: Date.now() - 1,
  };
  service.workers.set(worker.threadId, worker);

  service.pollWorker(worker);

  assert.deepEqual(stopped, ["worker-1"]);
  assert.equal(service.workers.has("thread-1"), false);
});

test("DSH dispatch SLA is not evaluated while the worker is still starting", () => {
  const failures = [];
  const service = Object.create(DshEngineAdapterService.prototype);
  service.workers = new Map();
  service.failWorker = (_worker, reason) => failures.push(reason);
  service.ctx = {
    dshRuntimeHost: {
      drain: () => ({ stdoutLines: [], stderrLines: [], exited: false }),
    },
  };
  const worker = {
    threadId: "thread-1",
    processId: "worker-1",
    initialized: false,
    active: {
      nativeStarted: false,
      turnDispatched: false,
      startupDeadlineMs: Date.now() + 60_000,
      // A stale value here must not accidentally apply before dispatch.
      dispatchDeadlineMs: Date.now() - 1,
    },
  };
  service.workers.set(worker.threadId, worker);

  service.pollWorker(worker);
  assert.deepEqual(failures, []);
});

test("native DSH turn/start is correlated to the immutable execution epoch", () => {
  const marked = [];
  const service = Object.create(DshEngineAdapterService.prototype);
  service.workers = new Map();
  service.recordSessionEvent = () => {};
  service.processSessionEvent = () => {};
  service.ctx = {
    threadExecution: {
      markNativeStarted: (...args) => {
        marked.push(args);
        return { state: "running" };
      },
    },
  };
  const connection = {};
  const worker = {
    threadId: "thread-1",
    active: {
      connection,
      executionEpoch: 9,
      record: { turn: { id: "outer-turn-1" } },
      nativeStarted: false,
      nativeTurnId: null,
      dispatchDeadlineMs: 123,
      eventBarrier: false,
    },
  };
  service.workers.set(worker.threadId, worker);

  service.onWorkerMessage(worker, {
    type: "session-event",
    sessionId: "hypernode-dsh-thread-1",
    clientTurnId: "outer-turn-1",
    event: { type: "turn/start", seq: 17, data: { turn: 3 } },
  });

  assert.deepEqual(marked, [["thread-1", connection, "3", 9]]);
  assert.equal(worker.active.nativeStarted, true);
  assert.equal(worker.active.nativeTurnId, "3");
  assert.equal(worker.active.dispatchDeadlineMs, null);
});

function adapterFixture() {
  const notifications = [];
  const completions = [];
  const aborts = [];
  const runtimeCommands = [];
  const responses = [];
  let itemSequence = 0;
  const appendItem = (record, item) => {
    record.itemLedger ??= [record.userItem];
    if (!record.itemLedger.some((candidate) => candidate.id === item.id)) {
      record.itemLedger.push(item);
    }
    return item;
  };
  const turnManager = {
    appendItem,
    createReasoning(record) {
      return appendItem(record, {
        id: `reasoning-${++itemSequence}`, type: "reasoning", summary: [], content: [],
      });
    },
    createAgent(record, phase) {
      const item = appendItem(record, {
        id: `agent-${++itemSequence}`, type: "agentMessage", text: "", phase,
        memoryCitation: null,
      });
      if (phase === "final_answer") record.agentItem = item;
      return item;
    },
    createUser(record, content, clientId) {
      return appendItem(record, {
        id: `user-${++itemSequence}`, type: "userMessage", clientId, content,
      });
    },
    complete(record) {
      record.turn.status = "completed";
      record.turn.items = [...record.itemLedger];
      return record;
    },
    interrupt(record) {
      record.turn.status = "interrupted";
      record.turn.items = [...record.itemLedger];
      return record;
    },
  };
  const service = Object.create(DshEngineAdapterService.prototype);
  service.workers = new Map();
  service.notify = (method, params) => notifications.push({ method, params });
  const projection = Object.create(DshAppServerProjectionService.prototype);
  const shellCommandClassifier = Object.create(ShellCommandClassifierService.prototype);
  projection.ctx = {
    turnManager,
    appServerProjection: {
      broadcast(method, params) { service.notify(method, params); },
    },
    shellCommandClassifier,
  };
  service.ctx = {
    turnManager,
    dshAppServerProjection: projection,
    textDeltaPacer: {
      enqueue(metadata, delta) {
        service.notify("item/agentMessage/delta", { ...metadata, delta });
      },
      afterDrained(_metadata, action) {
        action();
        return false;
      },
      flush() { return false; },
    },
    dshRuntimeHost: {
      send: (processId, message) => runtimeCommands.push({ processId, message }),
    },
    appServer: {
      send: (connection, message) => responses.push({ connection, message }),
    },
    threadExecution: {
      complete: (threadId, options) => completions.push({ threadId, options }),
      abortRequest: (...args) => aborts.push(args),
    },
  };
  const record = {
    threadId: "thread-1",
    turn: { id: "turn-1", status: "inProgress", items: [] },
    userItem: { id: "user-1", type: "userMessage", content: [] },
    itemLedger: [],
  };
  record.itemLedger.push(record.userItem);
  const connection = { threadWriteLease: { release() {} } };
  const worker = {
    threadId: "thread-1",
    active: {
      connection,
      requestId: "request-1",
      record,
      completed: false,
      reasoningItem: null,
      reasoningText: "",
      assistantStream: null,
      pendingUserInputs: [{ input: [], clientId: null, projected: true }],
      eventBarrier: false,
      deferredMessages: [],
      finalItem: null,
      finalText: "",
    },
  };
  worker.processId = "worker-1";
  projection.begin(worker.active, { cwd: "/workspace/projects/demo" });
  service.workers.set(worker.threadId, worker);
  return {
    aborts, completions, connection, notifications, projection, record, responses,
    runtimeCommands, service, worker,
  };
}

function sessionEvent(service, worker, event) {
  service.onWorkerMessage(worker, {
    type: "session-event",
    clientTurnId: "turn-1",
    event,
  });
}

test("DSH text deltas stream immediately while final phase waits for turn/end", () => {
  const { completions, notifications, record, service, worker } = adapterFixture();

  sessionEvent(service, worker, {
    type: "assistant/chunk", time: 1_000,
    data: { chunk: { type: "text-delta", text: "hello " } },
  });
  sessionEvent(service, worker, {
    type: "assistant/chunk", time: 1_010,
    data: { chunk: { type: "text-delta", text: "world" } },
  });
  sessionEvent(service, worker, {
    type: "assistant/message", time: 1_020,
    data: { message: { content: [{ type: "text", text: "hello world" }] } },
  });

  const liveStart = notifications.find(({ method, params }) =>
    method === "item/started" && params.item.type === "agentMessage"
  );
  assert.equal(liveStart.params.item.phase, null);
  assert.deepEqual(
    notifications.filter((message) => message.method === "item/agentMessage/delta")
      .map((message) => message.params.delta),
    ["hello ", "world"],
  );
  assert.equal(
    notifications.some(({ method, params }) =>
      method === "item/completed" && params.item.type === "agentMessage"
    ),
    false,
    "the live item remains open until the DSH terminal boundary determines its phase",
  );

  sessionEvent(service, worker, {
    type: "turn/end", time: 1_030, data: { reason: { kind: "completed" } },
  });

  assert.deepEqual(
    notifications.filter((message) => message.method === "item/agentMessage/delta")
      .map((message) => message.params.delta),
    ["hello ", "world"],
  );
  assert.equal(record.agentItem.text, "hello world");
  assert.equal(record.agentItem.phase, "final_answer");
  assert.equal(record.turn.status, "completed");
  assert.equal(completions.length, 1);
  assert.equal(worker.active, null);
});

test("DSH authoritative assistant message appends only an unstreamed suffix", () => {
  const { notifications, record, service, worker } = adapterFixture();

  sessionEvent(service, worker, {
    type: "assistant/chunk", time: 1_000,
    data: { chunk: { type: "text-delta", text: "hello" } },
  });
  sessionEvent(service, worker, {
    type: "assistant/message", time: 1_010,
    data: { message: { content: [{ type: "text", text: "hello world" }] } },
  });
  sessionEvent(service, worker, {
    type: "turn/end", time: 1_020, data: { reason: { kind: "completed" } },
  });

  const deltas = notifications
    .filter(({ method }) => method === "item/agentMessage/delta")
    .map(({ params }) => params.delta);
  assert.deepEqual(deltas, ["hello", " world"]);
  assert.equal(deltas.join(""), record.agentItem.text);
  assert.equal(record.agentItem.phase, "final_answer");
});

test("paced assistant text is a strict barrier before tool lifecycle events", () => {
  const { notifications, service, worker } = adapterFixture();
  const pendingDeltas = [];
  const barriers = [];
  service.ctx.textDeltaPacer = {
    enqueue(metadata, delta) { pendingDeltas.push({ metadata, delta }); },
    afterDrained(_metadata, action) { barriers.push(action); return true; },
    flush() { return false; },
  };

  sessionEvent(service, worker, {
    type: "assistant/chunk", time: 1_000,
    data: { chunk: { type: "text-delta", text: "I'll inspect." } },
  });
  sessionEvent(service, worker, {
    type: "assistant/message", time: 1_010,
    data: { message: { content: [{ type: "text", text: "I'll inspect." }] } },
  });
  sessionEvent(service, worker, {
    type: "tool/call", seq: 1, time: 1_020,
    data: { callId: "exec_command:0", name: "bash", arguments: '{"command":"date"}' },
  });
  sessionEvent(service, worker, {
    type: "tool/result", seq: 2, time: 1_030,
    data: {
      message: {
        source: { callId: "exec_command:0" },
        content: [{ content: [{ type: "text", text: "22:01" }], isError: false }],
      },
    },
  });

  assert.deepEqual(notifications.map(({ method }) => method), ["item/started"]);
  assert.equal(worker.active.deferredMessages.length, 1);
  for (const { metadata: item, delta } of pendingDeltas) {
    service.notify("item/agentMessage/delta", { ...item, delta });
  }
  barriers.shift()();

  assert.deepEqual(notifications.map(({ method }) => method), [
    "item/started",
    "item/agentMessage/delta",
    "item/completed",
    "item/started",
    "item/commandExecution/outputDelta",
    "item/completed",
  ]);
  assert.equal(notifications[2].params.item.phase, "commentary");
  assert.equal(notifications[3].params.item.type, "commandExecution");
});

test("interrupt flushes paced commentary and never starts a deferred tool", () => {
  const { aborts, notifications, record, service, worker } = adapterFixture();
  let barrier;
  service.ctx.textDeltaPacer = {
    enqueue() {},
    afterDrained(_metadata, action) { barrier = action; return true; },
    flush() { barrier(); return true; },
  };

  sessionEvent(service, worker, {
    type: "assistant/chunk", time: 1_000,
    data: { chunk: { type: "text-delta", text: "I'll inspect." } },
  });
  sessionEvent(service, worker, {
    type: "assistant/message", time: 1_010,
    data: { message: { content: [{ type: "text", text: "I'll inspect." }] } },
  });
  sessionEvent(service, worker, {
    type: "tool/call", seq: 1, time: 1_020,
    data: { callId: "exec_command:0", name: "bash", arguments: '{"command":"date"}' },
  });
  assert.equal(worker.active.eventBarrier, true);
  assert.equal(worker.active.deferredMessages.length, 0);

  service.interruptWorkerTurn(worker, "testInterrupt");

  assert.equal(record.turn.status, "interrupted");
  assert.equal(worker.active, null);
  assert.equal(aborts.length, 1);
  assert.equal(
    notifications.some(({ method, params }) =>
      method === "item/started" && params.item.type === "commandExecution"),
    false,
  );
  assert.deepEqual(
    notifications.filter(({ method }) => method === "item/completed")
      .map(({ params }) => params.item.type),
    ["agentMessage"],
  );
});

test("DSH preserves reasoning, commentary, tool, and final answer in native order", () => {
  const { completions, notifications, record, service, worker } = adapterFixture();

  sessionEvent(service, worker, {
    type: "step/start", time: 100, data: { turn: 1, step: 1 },
  });
  sessionEvent(service, worker, {
    type: "assistant/chunk", time: 110,
    data: { chunk: { type: "reasoning-delta", text: "inspect" } },
  });
  sessionEvent(service, worker, {
    type: "assistant/chunk", time: 120,
    data: { chunk: { type: "text-delta", text: "I'll check." } },
  });
  sessionEvent(service, worker, {
    type: "assistant/message", time: 130,
    data: { message: { content: [
      { type: "reasoning", text: "inspect" },
      { type: "text", text: "I'll check." },
      { type: "tool-call", id: "exec_command:0", name: "bash", arguments: "{}" },
    ] } },
  });
  sessionEvent(service, worker, {
    type: "tool/call", seq: 7, time: 140,
    data: { callId: "exec_command:0", name: "bash", arguments: '{"command":"date"}' },
  });
  sessionEvent(service, worker, {
    type: "tool/result", seq: 8, time: 150,
    data: { message: {
      source: { callId: "exec_command:0" },
      content: [{ content: [{ type: "text", text: "22:01" }], isError: false }],
    } },
  });
  sessionEvent(service, worker, {
    type: "step/start", time: 160, data: { turn: 1, step: 2 },
  });
  sessionEvent(service, worker, {
    type: "assistant/chunk", time: 170,
    data: { chunk: { type: "text-delta", text: "It is 22:01." } },
  });
  sessionEvent(service, worker, {
    type: "assistant/message", time: 180,
    data: { message: { content: [{ type: "text", text: "It is 22:01." }] } },
  });

  assert.equal(
    notifications.some(({ params }) => params?.item?.phase === "final_answer"),
    false,
    "final candidate must remain uncommitted before turn/end",
  );
  sessionEvent(service, worker, {
    type: "turn/end", time: 190, data: { reason: { kind: "completed" } },
  });

  assert.deepEqual(record.turn.items.map((item) => item.type), [
    "userMessage", "reasoning", "agentMessage", "commandExecution", "agentMessage",
  ]);
  const agents = record.turn.items.filter((item) => item.type === "agentMessage");
  assert.deepEqual(agents.map(({ phase, text }) => ({ phase, text })), [
    { phase: "commentary", text: "I'll check." },
    { phase: "final_answer", text: "It is 22:01." },
  ]);
  const starts = notifications
    .filter(({ method }) => method === "item/started")
    .map(({ params }) => params.item.type);
  assert.deepEqual(starts, [
    "reasoning", "agentMessage", "commandExecution", "agentMessage",
  ]);
  const commandCompletedIndex = notifications.findIndex(({ method, params }) =>
    method === "item/completed" && params.item.type === "commandExecution"
  );
  const finalStartedIndex = notifications.findIndex(({ method, params }) =>
    method === "item/started" && params.item.id === agents[1].id
  );
  assert.ok(commandCompletedIndex < finalStartedIndex);
  assert.equal(notifications[finalStartedIndex].params.item.phase, null);
  assert.equal(completions.length, 1);
});

test("DSH steer is projected at its native user/message boundary", () => {
  const {
    notifications, record, responses, runtimeCommands, service, worker,
  } = adapterFixture();

  // DSH acknowledges consumption of the already-projected turn/start input.
  sessionEvent(service, worker, {
    type: "user/message", time: 100, data: { message: { content: [] } },
  });
  service.steer({
    connection: worker.active.connection,
    threadId: worker.threadId,
    message: {
      id: "steer-1",
      params: {
        clientUserMessageId: "client-steer-1",
        input: [{ type: "text", text: "self-grown shrimp" }],
      },
    },
  });

  // The prior model response closes before DSH consumes the queued steer.
  sessionEvent(service, worker, {
    type: "assistant/message", time: 110,
    data: { message: { content: [{ type: "text", text: "full-stack response" }] } },
  });
  sessionEvent(service, worker, {
    type: "step/end", time: 120, data: { turn: 1, step: 1 },
  });
  sessionEvent(service, worker, {
    type: "user/message", time: 130, data: { message: { content: [] } },
  });
  sessionEvent(service, worker, {
    type: "step/start", time: 140, data: { turn: 1, step: 2 },
  });
  sessionEvent(service, worker, {
    type: "assistant/message", time: 150,
    data: { message: { content: [{ type: "text", text: "shrimp response" }] } },
  });
  sessionEvent(service, worker, {
    type: "turn/end", time: 160, data: { reason: { kind: "completed" } },
  });

  assert.deepEqual(record.turn.items.map((item) => item.type), [
    "userMessage", "agentMessage", "userMessage", "agentMessage",
  ]);
  assert.deepEqual(record.turn.items.map((item) => item.text ?? item.content?.[0]?.text), [
    undefined, "full-stack response", "self-grown shrimp", "shrimp response",
  ]);
  assert.equal(record.turn.items[1].phase, "commentary");
  assert.equal(record.turn.items[2].clientId, "client-steer-1");
  assert.equal(record.turn.items[3].phase, "final_answer");
  assert.deepEqual(runtimeCommands, [{
    processId: "worker-1",
    message: {
      type: "turn/steer",
      requestId: "steer-1",
      input: [{ type: "text", text: "self-grown shrimp" }],
    },
  }]);
  assert.deepEqual(responses[0].message, {
    id: "steer-1", result: { turnId: "turn-1" },
  });
  const steerStarted = notifications.find(({ method, params }) =>
    method === "item/started" && params.item.clientId === "client-steer-1"
  );
  assert.equal(steerStarted.params.startedAtMs, 130);
});

test("DSH step boundaries do not fabricate empty Desktop reasoning items", () => {
  const { notifications, record, service, worker } = adapterFixture();

  sessionEvent(service, worker, {
    type: "step/start", time: 100, data: { turn: 1, step: 1 },
  });
  sessionEvent(service, worker, {
    type: "assistant/message", time: 110,
    data: { message: { content: [{
      type: "tool-call", id: "exec_command:0", name: "bash", arguments: "{}",
    }] } },
  });
  sessionEvent(service, worker, {
    type: "tool/call", seq: 7, time: 120,
    data: { callId: "exec_command:0", name: "bash", arguments: '{"command":"date"}' },
  });
  sessionEvent(service, worker, {
    type: "tool/result", seq: 8, time: 130,
    data: { message: {
      source: { callId: "exec_command:0" },
      content: [{ content: [{ type: "text", text: "22:01" }], isError: false }],
    } },
  });
  sessionEvent(service, worker, {
    type: "step/end", time: 140, data: { turn: 1, step: 1 },
  });
  sessionEvent(service, worker, {
    type: "step/start", time: 150, data: { turn: 1, step: 2 },
  });
  sessionEvent(service, worker, {
    type: "assistant/message", time: 160,
    data: { message: { content: [{ type: "text", text: "It is 22:01." }] } },
  });
  sessionEvent(service, worker, {
    type: "step/end", time: 170, data: { turn: 1, step: 2 },
  });
  sessionEvent(service, worker, {
    type: "turn/end", time: 180, data: { reason: { kind: "completed" } },
  });

  assert.deepEqual(record.turn.items.map((item) => item.type), [
    "userMessage", "commandExecution", "agentMessage",
  ]);
  assert.equal(
    notifications.some(({ params }) => params?.item?.type === "reasoning"),
    false,
    "step/start without reasoning output must remain an internal engine boundary",
  );
  assert.equal(record.turn.items.at(-1).phase, "final_answer");
  assert.equal(record.turn.status, "completed");
});

test("DSH aborted terminal state persists an interrupted Turn with partial output", () => {
  const { aborts, record, service, worker } = adapterFixture();
  sessionEvent(service, worker, {
    type: "assistant/message", time: 200,
    data: {
      interrupted: true,
      message: { content: [{ type: "text", text: "partial" }] },
    },
  });
  sessionEvent(service, worker, {
    type: "turn/end", time: 210,
    data: { reason: { kind: "aborted", reason: { kind: "user" } } },
  });

  assert.equal(record.turn.status, "interrupted");
  assert.deepEqual(record.turn.items.map((item) => item.type), [
    "userMessage", "agentMessage",
  ]);
  assert.equal(record.turn.items[1].phase, "final_answer");
  assert.equal(record.turn.items[1].text, "partial");
  assert.equal(aborts.length, 1);
  assert.equal(worker.active, null);
});

test("DSH max-token terminal state fails closed instead of fabricating completion", () => {
  const failures = [];
  const { service, worker } = adapterFixture();
  service.failWorker = (failedWorker, reason) => failures.push({ failedWorker, reason });

  sessionEvent(service, worker, {
    type: "turn/end", time: 300, data: { reason: { kind: "max-tokens" } },
  });

  assert.equal(failures.length, 1);
  assert.match(failures[0].reason, /output-token limit/);
});

test("an idle DSH worker retires without affecting another Thread", () => {
  const stopped = [];
  const service = Object.create(DshEngineAdapterService.prototype);
  service.workers = new Map([
    ["idle", { threadId: "idle", active: null }],
    ["active", { threadId: "active", active: { record: {} } }],
  ]);
  service.stopWorker = (worker) => stopped.push(worker.threadId);

  assert.equal(service.retireThread("active"), false);
  assert.equal(service.retireThread("idle"), true);
  assert.equal(service.retireThread("missing"), false);
  assert.deepEqual(stopped, ["idle"]);
  assert.equal(service.workers.has("idle"), false);
  assert.equal(service.workers.has("active"), true);
});

test("DSH transport failure is projected as failed and retires the worker", () => {
  const failures = [];
  const service = Object.create(DshEngineAdapterService.prototype);
  service.workers = new Map();
  service.failWorker = (worker, reason) => failures.push({ worker, reason });
  const worker = {
    threadId: "thread-1",
    active: {
      record: { turn: { id: "turn-1" } },
      agentItem: { id: "agent-1", type: "agentMessage", text: "" },
      text: "",
    },
  };
  service.workers.set(worker.threadId, worker);

  service.onWorkerMessage(worker, {
    type: "session-event",
    clientTurnId: "turn-1",
    event: {
      type: "turn/end",
      data: {
        reason: {
          kind: "error",
          error: { message: "Connection error.", code: "TRANSPORT" },
        },
      },
    },
  });

  assert.equal(failures.length, 1);
  assert.equal(failures[0].reason, "Connection error.");
});

test("a failed DSH Turn persists the failed/idle state consumed by resume", () => {
  const changed = [];
  const thread = {
    id: "thread-1",
    status: { type: "active", activeFlags: [] },
    updatedAt: 10,
    recencyAt: 10,
  };
  const manager = Object.create(TurnManagerService.prototype);
  manager.ctx = {
    threadManager: {
      get: (threadId) => {
        assert.equal(threadId, thread.id);
        return thread;
      },
      changed: (threadId) => changed.push(threadId),
    },
  };
  const record = {
    threadId: thread.id,
    startedAtMs: 10_000,
    userItem: { id: "user-1", type: "userMessage", content: [] },
    turn: {
      id: "turn-1",
      status: "inProgress",
      error: null,
      items: [],
      completedAt: null,
      durationMs: null,
    },
  };

  manager.fail(record, "Connection error.", 12);

  assert.equal(record.turn.status, "failed");
  assert.deepEqual(record.turn.error, { message: "Connection error." });
  assert.equal(record.turn.completedAt, 12);
  assert.equal(record.turn.durationMs, 2_000);
  assert.deepEqual(record.turn.items, [record.userItem]);
  assert.deepEqual(thread.status, { type: "idle" });
  assert.equal(thread.updatedAt, 12);
  assert.equal(thread.recencyAt, 12);
  assert.deepEqual(changed, [thread.id]);
});

test("a failed DSH Turn emits the native error notification before completion", () => {
  const notifications = [];
  const aborted = [];
  const stopped = [];
  const service = Object.create(DshEngineAdapterService.prototype);
  service.workers = new Map();
  service.notify = (method, params) => notifications.push({ method, params });
  service.finishStoppedWorker = (worker, detail) => stopped.push({ worker, detail });
  const record = {
    threadId: "thread-1",
    startedAtMs: 10_000,
    itemLedger: [{ id: "user-1", type: "userMessage", content: [] }],
    turn: {
      id: "turn-1", status: "inProgress", error: null, items: [],
      completedAt: null, durationMs: null,
    },
  };
  const active = { connection: {}, requestId: "request-1", record, telemetry: null };
  const worker = { threadId: "thread-1", active };
  service.workers.set(worker.threadId, worker);
  service.ctx = {
    dshAppServerProjection: { settle() {} },
    turnManager: {
      fail(target, message, completedAt) {
        target.turn.status = "failed";
        target.turn.error = { message };
        target.turn.completedAt = completedAt;
        target.turn.items = [...target.itemLedger];
      },
    },
    threadExecution: { abortRequest: (...args) => aborted.push(args) },
  };

  service.finishFailedWorker(worker, active, "executable not found in SSH workspace: bash");

  assert.deepEqual(notifications.map(({ method }) => method), [
    "error", "turn/completed", "thread/status/changed",
  ]);
  assert.deepEqual(notifications[0].params, {
    error: {
      message: "executable not found in SSH workspace: bash",
      codexErrorInfo: null,
      additionalDetails: null,
    },
    willRetry: false,
    threadId: "thread-1",
    turnId: "turn-1",
  });
  assert.equal(notifications[1].params.turn.status, "failed");
  assert.deepEqual(notifications[1].params.turn.error, {
    message: "executable not found in SSH workspace: bash",
  });
  assert.equal(worker.active, null);
  assert.equal(aborted.length, 1);
  assert.equal(stopped.length, 1);
});

test("interrupting DSH is a deterministic control-plane transition", () => {
  const runtimeCommands = [];
  const responses = [];
  const notifications = [];
  const aborted = [];
  const stopped = [];
  const released = [];
  const service = Object.create(DshEngineAdapterService.prototype);
  service.workers = new Map();
  service.notify = (method, params) => notifications.push({ method, params });
  service.stopWorker = (worker) => stopped.push(worker.processId);
  service.ctx = {
    dshRuntimeHost: { send: (processId, message) => runtimeCommands.push({ processId, message }) },
    appServer: { send: (connection, message) => responses.push({ connection, message }) },
    textDeltaPacer: {
      enqueue(metadata, delta) {
        service.notify("item/agentMessage/delta", { ...metadata, delta });
      },
      afterDrained(_metadata, action) {
        action();
        return false;
      },
      flush() { return false; },
    },
    turnManager: {
      createAgent(record, phase) {
        const item = {
          id: "agent-1", type: "agentMessage", text: "", phase, memoryCitation: null,
        };
        record.agentItem = item;
        record.itemLedger.push(item);
        return item;
      },
      interrupt(record) {
        record.turn.status = "interrupted";
        record.turn.items = [...record.itemLedger];
        return record;
      },
    },
    threadExecution: {
      abortRequest: (...args) => aborted.push(args),
    },
  };
  const connection = {
    threadWriteLease: { release: (...args) => released.push(args) },
  };
  const record = {
    threadId: "thread-1",
    turn: { id: "turn-1", status: "inProgress", items: [] },
    userItem: { id: "user-1", type: "userMessage", content: [] },
    itemLedger: [],
  };
  record.itemLedger.push(record.userItem);
  const worker = {
    threadId: "thread-1",
    processId: "worker-1",
    active: {
      connection,
      requestId: "turn-start-1",
      record,
      reasoningItem: null,
      reasoningText: "",
      assistantStream: null,
      eventBarrier: false,
      deferredMessages: [],
      finalItem: null,
      finalText: "",
    },
  };
  service.workers.set(worker.threadId, worker);

  service.onWorkerMessage(worker, {
    type: "session-event",
    clientTurnId: "turn-1",
    event: {
      type: "assistant/chunk", time: 100,
      data: { chunk: { type: "text-delta", text: "partial answer" } },
    },
  });
  service.onWorkerMessage(worker, {
    type: "session-event",
    clientTurnId: "turn-1",
    event: {
      type: "assistant/message", time: 110,
      data: { message: { content: [{ type: "text", text: "partial answer" }] } },
    },
  });

  service.interrupt({
    connection,
    threadId: worker.threadId,
    message: { id: "interrupt-1", params: { turnId: "turn-1" } },
  });

  assert.equal(record.turn.status, "interrupted");
  assert.equal(record.agentItem.text, "partial answer");
  assert.deepEqual(runtimeCommands[0], {
    processId: "worker-1",
    message: { type: "turn/interrupt", requestId: "interrupt-1" },
  });
  assert.deepEqual(responses[0].message, { id: "interrupt-1", result: {} });
  assert.deepEqual(notifications.map(({ method }) => method), [
    "item/started", "item/agentMessage/delta", "item/completed",
    "turn/completed", "thread/status/changed",
  ]);
  assert.deepEqual(aborted[0].slice(0, 3), ["thread-1", connection, "turn-start-1"]);
  assert.deepEqual(released[0], ["thread-1", connection]);
  assert.deepEqual(stopped, ["worker-1"]);
  assert.equal(service.workers.has("thread-1"), false);
});

test("DSH completed Turn without visible assistant text is rejected", () => {
  const failures = [];
  const service = Object.create(DshEngineAdapterService.prototype);
  service.workers = new Map();
  service.failWorker = (worker, reason) => failures.push({ worker, reason });
  const worker = {
    threadId: "thread-1",
    active: {
      record: { turn: { id: "turn-1" } },
      agentItem: { id: "agent-1", type: "agentMessage", text: "" },
      text: "",
    },
  };
  service.workers.set(worker.threadId, worker);

  service.onWorkerMessage(worker, {
    type: "session-event",
    clientTurnId: "turn-1",
    event: { type: "turn/end", data: { reason: { kind: "completed" } } },
  });

  assert.equal(failures.length, 1);
  assert.equal(failures[0].reason, "DSH Turn completed without an assistant message");
});
