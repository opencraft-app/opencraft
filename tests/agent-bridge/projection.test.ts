import assert from "node:assert/strict";
import test from "node:test";

import {
  BRIDGE_SCHEMA_VERSION,
  type BridgeDelta,
  type DeltaScope,
} from "@opencraft/agent-bridge-protocol";
import {
  assemble,
  createAssemblerState,
  EXISTING_APPSERVER_NOTIFICATION_METHODS,
  projectToAppServer,
  querySteerStatus,
  STEER_EVIDENCE_EXTENSION_METHOD,
} from "@opencraft/agent-bridge-assembler";
import { FIXTURE_CELL_BY_ID, replayCell } from "@opencraft/agent-bridge-assembler/testing";
import {
  OPENCRAFT_STEER_EVIDENCE_EXTENSION,
  OPENCRAFT_STEER_EVIDENCE_NOTIFICATION,
  OPENCRAFT_STEER_STATUS_METHOD,
  parseSteerEvidenceCapability,
  type AppServerNotification,
  type TurnSteerResponse,
} from "@opencraft/appserver-protocol";
import type {
  ItemStartedNotification,
  TurnStartedNotification,
} from "@opencraft/appserver-protocol/generated/v2";
import {
  createEmptyThreadView,
  registerBuiltinThreadProjectors,
  type ThreadNotificationProjector,
  type ThreadView,
} from "@opencraft/appserver-session";

function cell(id: string) {
  const found = FIXTURE_CELL_BY_ID.get(id);
  assert.ok(found, `missing fixture cell ${id}`);
  return found;
}

/** Feed projected notifications through the real appserver-session projectors. */
function projectThroughSession(notifications: readonly AppServerNotification[]): ThreadView {
  const projectors: ThreadNotificationProjector[] = [];
  registerBuiltinThreadProjectors({
    threadResumeProjectors: { register: () => () => {} },
    threadNotificationProjectors: {
      register: (projector: ThreadNotificationProjector) => {
        projectors.push(projector);
        return () => {};
      },
    },
  } as never);
  const sorted = [...projectors].sort((left, right) => left.priority - right.priority);
  let view = createEmptyThreadView("fixture", "thr-fixture");
  for (const notification of notifications) {
    let next = view;
    for (const projector of sorted) next = projector.project(next, notification);
    view = {
      ...next,
      notificationRevision: next.notificationRevision + 1,
      lastNotification: notification,
    };
  }
  return view;
}

const S: DeltaScope = { threadId: "thr-fixture" };

test("projection emits only existing AppServer notifications for core events", () => {
  const projected = replayCell(cell("duplicate")).projected;
  const existing = new Set<string>(EXISTING_APPSERVER_NOTIFICATION_METHODS);
  for (const notification of projected) {
    assert.ok(existing.has(notification.method), `${notification.method} is not an existing contract method`);
    assert.ok(!notification.method.startsWith("opencraft/"), "core projection must not need extensions");
  }

  const started = projected.find((n) => n.method === "turn/started");
  assert.ok(started);
  const startedParams = started.params as TurnStartedNotification;
  assert.equal(startedParams.turn.status, "inProgress");
  assert.ok(Array.isArray(startedParams.turn.items));
  assert.equal(startedParams.turn.itemsView, "summary");
  assert.equal(startedParams.threadId, "thr-fixture");

  const item = projected.find((n) => n.method === "item/started");
  assert.ok(item);
  const itemParams = item.params as ItemStartedNotification;
  assert.equal(itemParams.item.type, "dynamicToolCall", "a generic tool is not a commandExecution");
  assert.equal(typeof itemParams.startedAtMs, "number");
});

test("projected params are assignable to the generated upstream notification shapes", () => {
  const turnStarted: TurnStartedNotification = {
    threadId: "thr-fixture",
    turn: {
      id: "t1.1", items: [], itemsView: "summary", status: "inProgress", error: null,
      startedAt: 1700000000, completedAt: null, durationMs: null,
    },
  };
  const itemStarted: ItemStartedNotification = {
    item: { type: "plan", id: "i1.1", text: "" },
    threadId: "thr-fixture", turnId: "t1.1", startedAtMs: 1700000000001,
  };
  assert.equal(turnStarted.turn.status, "inProgress");
  assert.equal(itemStarted.item.type, "plan");
});

test("BLOCKING: turn/completed is a summary and real projectors keep the items + startedAt", () => {
  const deltas: BridgeDelta[] = [
    { op: "turn.open", nativeTurnId: "n1", scope: S },
    { op: "item.textDelta", nativeKey: "s1", channel: "agentMessage", text: "Hello ", scope: S },
    { op: "item.textDelta", nativeKey: "s1", channel: "agentMessage", text: "world", scope: S },
    { op: "item.textClose", nativeKey: "s1", channel: "agentMessage", scope: S },
    { op: "item.open", nativeKey: "k1", shape: { kind: "tool", name: "fake.tool", status: "inProgress" }, scope: S },
    { op: "item.close", nativeKey: "k1", shape: { kind: "tool", name: "fake.tool", status: "completed", output: "done" }, scope: S },
    { op: "turn.boundary", nativeTurnId: "n1", status: "completed", scope: S },
  ];
  const assembled = assemble(createAssemblerState(BRIDGE_SCHEMA_VERSION), deltas, {
    threadId: "thr-fixture",
    clockSeed: 1_700_000_000_000,
    atMsStep: 1,
  });
  const projected = projectToAppServer(assembled.events, {
    steerEvidenceDeclared: false,
    schemaVersion: BRIDGE_SCHEMA_VERSION,
  }) as AppServerNotification[];

  // The completion notification itself is a lifecycle summary, never an empty
  // authoritative "full" snapshot, and keeps the original startedAt.
  const completed = projected.find((n) => n.method === "turn/completed")!;
  const completedTurn = (completed.params as { turn: { itemsView: string; items: unknown[]; startedAt: number } }).turn;
  assert.equal(completedTurn.itemsView, "summary");
  assert.equal(completedTurn.items.length, 0);
  const started = projected.find((n) => n.method === "turn/started")!;
  const startedTurn = (started.params as { turn: { startedAt: number } }).turn;
  assert.equal(completedTurn.startedAt, startedTurn.startedAt, "completion keeps the original startedAt");

  const view = projectThroughSession(projected);
  const turn = view.turns.find((candidate) => candidate.id === "t1.1");
  assert.ok(turn, "the turn is present in the session view");
  assert.equal(turn.status, "completed");
  assert.ok((turn.items?.length ?? 0) >= 2, "text and tool items survive turn/completed");
  const textItem = turn.items!.find((candidate) => candidate.id === "i1.1") as { text?: string } | undefined;
  assert.ok(textItem);
  assert.equal(textItem.text, "Hello world", "streamed text is preserved");
  assert.ok(turn.items!.some((candidate) => candidate.id === "i1.2"), "the tool item survives");
  assert.equal(turn.turnStartedAtMs, startedTurn.startedAt * 1000, "start time is not replaced by completion time");

  // Control: an old-style empty "full" completion really would erase the items,
  // proving the regression this fix prevents is real.
  const erased = projectThroughSession([
    ...projected.filter((n) => n.method !== "turn/completed"),
    {
      method: "turn/completed",
      params: {
        threadId: "thr-fixture",
        turn: { ...completedTurn, itemsView: "full", items: [] },
      },
    } as AppServerNotification,
  ]);
  const erasedTurn = erased.turns.find((candidate) => candidate.id === "t1.1");
  assert.equal(erasedTurn?.items?.length ?? 0, 0, "a full snapshot would replace the items away");
});

test("channel projection: reasoning/plan deltas and tool vs command items", () => {
  const projected = replayCell(cell("channel-projection")).projected;
  assert.ok(projected.some((n) => n.method === "item/reasoning/textDelta"));
  const reasoning = projected.find((n) => n.method === "item/reasoning/textDelta")!;
  assert.equal((reasoning.params as { contentIndex: number }).contentIndex, 0);
  assert.ok(projected.some((n) => n.method === "item/plan/delta"));

  const startedTypes = projected
    .filter((n) => n.method === "item/started")
    .map((n) => (n.params as { item: { type: string } }).item.type);
  assert.equal(startedTypes.filter((type) => type === "dynamicToolCall").length, 1, "generic tool -> dynamicToolCall");
  assert.equal(startedTypes.filter((type) => type === "commandExecution").length, 1, "real command -> commandExecution");
  assert.ok(!startedTypes.includes("commandExecution") || startedTypes.includes("dynamicToolCall"));
});

test("steer evidence is a capability-gated additive extension old clients ignore", () => {
  assert.equal(OPENCRAFT_STEER_EVIDENCE_EXTENSION, "opencraft/steer-evidence");
  assert.equal(OPENCRAFT_STEER_EVIDENCE_NOTIFICATION, "opencraft/steerEvidence/updated");
  assert.equal(OPENCRAFT_STEER_STATUS_METHOD, "opencraft/steer/status");
  assert.ok(STEER_EVIDENCE_EXTENSION_METHOD.startsWith("opencraft/"));
  assert.ok(
    EXISTING_APPSERVER_NOTIFICATION_METHODS.every((method) => !method.startsWith("opencraft/")),
    "existing methods come from the upstream contract, not the extension namespace",
  );

  const without = replayCell(cell("steer-end-race"), { steerEvidenceDeclared: false }).projected;
  assert.equal(
    without.some((n) => n.method === OPENCRAFT_STEER_EVIDENCE_NOTIFICATION),
    false,
    "a client that did not declare the capability gets no extension notification",
  );

  const withCapability = replayCell(cell("steer-end-race"), { steerEvidenceDeclared: true }).projected;
  const evidence = withCapability.filter((n) => n.method === OPENCRAFT_STEER_EVIDENCE_NOTIFICATION);
  assert.equal(evidence.length, 1, "one full-snapshot notification, not a flicker per facet");
  const params = evidence[0].params as {
    schemaVersion: number;
    inputs: Array<{
      inputId: string;
      disposition: string | null;
      outcome: string;
      expectedTurnId: string | null;
      nativeExecutions: number;
      admission: { version: number };
    }>;
  };
  assert.equal(params.schemaVersion, BRIDGE_SCHEMA_VERSION);
  assert.equal(params.inputs.length, 1, "the latest state per input, deduplicated");
  const input = params.inputs[0];
  assert.equal(input.inputId, "in1");
  assert.equal(input.disposition, "queued", "the notification carries disposition");
  assert.equal(input.outcome, "queued", "queued is not summarised as delivered");
  assert.equal(input.expectedTurnId, null, "queued does not point at an ended turn");
  assert.equal(typeof input.admission.version, "number");
  assert.ok(withCapability.some((n) => n.method === "turn/started"));
});

test("opencraft/steer/status is answered from the assembler's own state", () => {
  const race = replayCell(cell("steer-end-race"));
  const queried = querySteerStatus(race.state, { threadId: "thr-fixture" }, BRIDGE_SCHEMA_VERSION);
  assert.equal(queried.schemaVersion, BRIDGE_SCHEMA_VERSION);
  assert.equal(queried.inputs.length, 1);
  assert.equal(queried.inputs[0].disposition, "queued");
  assert.equal(queried.inputs[0].outcome, "queued");
  assert.equal(queried.inputs[0].expectedTurnId, null);
  const filtered = querySteerStatus(race.state, { threadId: "thr-fixture", inputIds: ["missing"] }, BRIDGE_SCHEMA_VERSION);
  assert.equal(filtered.inputs.length, 0);

  const eof = replayCell(cell("write-then-eof"));
  const eofQuery = querySteerStatus(eof.state, { threadId: "thr-fixture" }, BRIDGE_SCHEMA_VERSION);
  assert.equal(eofQuery.inputs[0].outcome, "unknown");
  assert.equal(eofQuery.inputs[0].nativeExecutions, 0, "no second native execution");
});

test("steer-evidence capability parses only well-formed version-1 declarations", () => {
  const valid = {
    version: 1, perInputEvidence: true, query: true,
    deliveryMethods: ["native-inject"], evidenceKinds: ["context-confirmed"],
    withdrawal: "before-dispatch",
  };
  const parsed = parseSteerEvidenceCapability(valid);
  assert.ok(parsed);
  assert.deepEqual(parsed.deliveryMethods, ["native-inject"]);
  assert.equal(parsed.query, true);
  // `query` is optional: a capability that only wants the notification parses.
  const withoutQuery = parseSteerEvidenceCapability({
    version: 1, perInputEvidence: true,
    deliveryMethods: ["native-inject"], evidenceKinds: ["context-confirmed"],
    withdrawal: "before-dispatch",
  });
  assert.ok(withoutQuery);
  assert.equal(withoutQuery.query, undefined);
  assert.equal(parseSteerEvidenceCapability({ ...valid, version: 2 }), null);
  assert.equal(parseSteerEvidenceCapability({ ...valid, perInputEvidence: false }), null);
  assert.equal(parseSteerEvidenceCapability({ ...valid, query: false }), null);
  assert.equal(parseSteerEvidenceCapability({ ...valid, deliveryMethods: ["unknown-path"] }), null);
  assert.equal(parseSteerEvidenceCapability(undefined), null);
});

test("TurnSteerResponse stays compatible and can express the steer/end race as queued", () => {
  const legacy: TurnSteerResponse = { turnId: "t1.1" };
  const queued: TurnSteerResponse = { turnId: "t1.1", disposition: "queued" };
  const steered: TurnSteerResponse = { turnId: "t1.1", disposition: "steered" };
  assert.equal(legacy.disposition, undefined, "absent disposition keeps the legacy meaning");
  assert.equal(queued.disposition, "queued");
  assert.equal(steered.disposition, "steered");
  const states = replayCell(cell("steer-end-race")).events.filter((e) => e.kind === "input.state");
  const last = states[states.length - 1] as { status: { disposition: string | null } };
  assert.equal(last.status.disposition, queued.disposition);
});
