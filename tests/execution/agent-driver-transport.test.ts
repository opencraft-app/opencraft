import assert from "node:assert/strict";
import test from "node:test";
import { AgentDriverTransport } from "../../apps/opencraft-daemon/src/agent-driver-transport.js";
import type { DuplexTransport } from "../../packages/appserver-client/src/transport.js";
import type { Collaboration } from "../../packages/access-control/src/collaboration.js";

function fixture() {
  const frames: any[] = [], grants: any[] = [];
  const inner: DuplexTransport = { status: { state: "open" }, async connect() {}, async send(frame) { frames.push(JSON.parse(frame)); },
    subscribeMessage: () => () => {}, subscribeStatus: () => () => {}, async close() {} };
  const collaboration = { authorizeExecution(...args: unknown[]) { grants.push(args); } } as unknown as Collaboration;
  return { frames, grants, transport: new AgentDriverTransport(inner, collaboration, () => "server:machine:pi") };
}

test("Renderer control forgery cannot create native children, even with a matching wire operation id", async () => {
  const f = fixture(), frame = JSON.stringify({ id: 1, method: "opencraft/orchestration/create", params: { operationId: "spoofed", settings: { driver: "pi" } } });
  await assert.rejects(f.transport.send(frame), /Trusted orchestration admission/);
  await assert.rejects(f.transport.sendWithContext(frame, { sender: null, orchestrationOperationId: "spoofed", orchestrationCanAdmit: () => false }), /Trusted orchestration admission/);
  assert.equal(f.frames.length, 0);
  await f.transport.sendWithContext(frame, { sender: null, orchestrationOperationId: "spoofed", orchestrationCanAdmit: () => true });
  assert.equal(f.frames.length, 1);
});

test("verified human Pi input receives its own scoped delegation before remote native admission", async () => {
  const f = fixture(), actor = { actorId: "human:synthetic", generation: 4, credentialId: null, expiresAt: Date.now() + 10_000 };
  await f.transport.sendWithContext(JSON.stringify({ id: 1, method: "turn/start", params: { threadId: "pi_test", input: [{ type: "text", text: "Delegate this task" }] } }),
    { sender: null, actorContext: actor });
  assert.equal(f.grants.length, 1); assert.equal(f.grants[0][0], actor); assert.equal(f.grants[0][1], "pi_test");
  assert.equal(f.grants[0][4], "server:machine:pi"); assert.equal(f.grants[0][2], f.frames[0].params.clientUserMessageId);
  assert.match(f.frames[0].params.clientUserMessageId, /^human-input:/);
  assert.equal(JSON.stringify(f.frames).includes("human:synthetic"), false, "private ingress authority is never serialized to the engine");
  await f.transport.sendWithContext(JSON.stringify({ id: 2, method: "thread/queue/add", params: { threadId: "pi_test", clientUserMessageId: "human-explicit", input: [] } }),
    { sender: null, actorContext: actor });
  assert.equal(f.grants[1][2], "human-explicit");
});
