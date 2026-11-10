import assert from "node:assert/strict";
import test from "node:test";

import { BRIDGE_SCHEMA_VERSION } from "@opencraft/agent-bridge-protocol";
import {
  EXISTING_APPSERVER_NOTIFICATION_METHODS,
  STEER_EVIDENCE_EXTENSION_METHOD,
} from "@opencraft/agent-bridge-assembler";
import { FIXTURE_CELL_BY_ID, replayCell } from "@opencraft/agent-bridge-assembler/testing";
import {
  OPENCRAFT_STEER_EVIDENCE_EXTENSION,
  OPENCRAFT_STEER_EVIDENCE_NOTIFICATION,
  OPENCRAFT_STEER_STATUS_METHOD,
  parseSteerEvidenceCapability,
  type TurnSteerResponse,
} from "@opencraft/appserver-protocol";
import type {
  ItemStartedNotification,
  TurnStartedNotification,
} from "@opencraft/appserver-protocol/generated/v2";

function cell(id: string) {
  const found = FIXTURE_CELL_BY_ID.get(id);
  assert.ok(found, `missing fixture cell ${id}`);
  return found;
}

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
  assert.equal(startedParams.turn.itemsView, "full");
  assert.equal(startedParams.threadId, "thr-fixture");

  const item = projected.find((n) => n.method === "item/started");
  assert.ok(item);
  const itemParams = item.params as ItemStartedNotification;
  assert.equal(itemParams.item.type, "commandExecution");
  assert.equal(typeof itemParams.startedAtMs, "number");
});

test("projected params are assignable to the generated upstream notification shapes", () => {
  const turnStarted: TurnStartedNotification = {
    threadId: "thr-fixture",
    turn: {
      id: "t1.1", items: [], itemsView: "full", status: "inProgress", error: null,
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
    inputs: Array<{ inputId: string; admission: { version: number }; evidence: { version: number } }>;
  };
  assert.equal(params.schemaVersion, BRIDGE_SCHEMA_VERSION);
  assert.ok(params.inputs.length >= 1);
  assert.equal(params.inputs[0].inputId, "in1");
  assert.equal(typeof params.inputs[0].admission.version, "number");
  assert.equal(typeof params.inputs[0].evidence.version, "number");

  // Core notifications remain present for old consumers reading the same stream.
  assert.ok(withCapability.some((n) => n.method === "turn/started"));
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
  assert.equal(parseSteerEvidenceCapability({ ...valid, version: 2 }), null);
  assert.equal(parseSteerEvidenceCapability({ ...valid, perInputEvidence: false }), null);
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

  // The canonical state that drove the fixture agrees with the legacy field.
  const states = replayCell(cell("steer-end-race")).events.filter((e) => e.kind === "input.state");
  const last = states[states.length - 1] as { status: { disposition: string | null } };
  assert.equal(last.status.disposition, queued.disposition);
});
