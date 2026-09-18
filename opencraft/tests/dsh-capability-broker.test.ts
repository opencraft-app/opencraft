import test from "node:test";
import assert from "node:assert/strict";
import { DshCapabilityBroker } from "../apps/local-agent-host/src/dsh-capability-broker.js";
import { verifyDshCapabilityRegistration } from "../apps/local-agent-host/src/dsh-capability-link.js";
const a = { connectionId: "a", identity: { id: "local", username: "local" } };
const b = { connectionId: "b", identity: { id: "local", username: "local" } };
const specs = [{ type: "function", name: "browser_open", description: "Open owned browser", inputSchema: { type: "object", properties: { url: { type: "string" } } } }];

test("capability registration and return are bound to the owning thread and connection", async () => {
  const broker = new DshCapabilityBroker();
  const frames: any[] = [];
  try {
    broker.register("s", a, specs, frame => frames.push(frame));
    assert.equal(broker.matches("s", a, specs), true);
    assert.equal(broker.matches("s", a, [{ ...specs[0], description: "changed" }]), false);
    assert.throws(() => broker.register("s", b, specs, () => {}), /another connection/);
    await assert.rejects(broker.invoke("s", "t", "browser_open", {}, new AbortController().signal, b), /owner/);
    await assert.rejects(broker.invoke("other", "t", "browser_open", {}, new AbortController().signal, a), /owner/);
    const result = broker.invoke("s", "t", "browser_open", { url: "about:blank" }, new AbortController().signal, a);
    assert.equal(frames[0].method, "item/tool/call");
    assert.equal(frames[0].params.threadId, "s");
    assert.equal(broker.respond(b, frames[0].id, { success: true }), false);
    assert.equal(broker.respond(a, frames[0].id, { success: true }), true);
    assert.deepEqual(await result, { success: true });
    assert.equal(broker.respond(a, frames[0].id, {}), false);
  } finally { broker.close(); }
});
test("cancel, timeout and disconnect revoke pending calls and reject late replies", async () => {
  const broker = new DshCapabilityBroker(15);
  const frames: any[] = [];
  try {
    broker.register("s", a, specs, frame => frames.push(frame));
    const abort = new AbortController();
    const cancelled = broker.invoke("s", "t", "browser_open", {}, abort.signal, a);
    const firstId = frames[0].id;
    abort.abort();
    await assert.rejects(cancelled, /cancelled/);
    assert.equal(broker.respond(a, firstId, {}), false);
    assert.equal(frames.at(-1).method, "serverRequest/resolved");
    await assert.rejects(broker.invoke("s", "t", "browser_open", {}, new AbortController().signal, a), /timed out/);
    const disconnected = broker.invoke("s", "t", "browser_open", {}, new AbortController().signal, a);
    broker.disconnect(a);
    await assert.rejects(disconnected, /disconnected/);
    assert.deepEqual(broker.list("s"), []);
  } finally { broker.close(); }
});

test("fork inherits original function/namespace specs, with a separate child reply owner", async () => {
  const broker = new DshCapabilityBroker();
  const parentFrames: any[] = [], childFrames: any[] = [];
  const wire = [...specs, { type: "namespace", name: "browser", description: "Browser tools", tools: [
    { name: "read", description: "Read", inputSchema: { type: "object", properties: {} } },
  ] }];
  try {
    broker.register("parent", a, wire, frame => parentFrames.push(frame));
    assert.throws(() => broker.register("wrong", a, broker.list("parent"), () => {}), /Invalid dynamic tool/);
    assert.throws(() => broker.specs("parent", b), /another connection/);
    const inherited = broker.specs("parent", a)!;
    assert.deepEqual(inherited, wire);
    broker.register("child", a, inherited, frame => childFrames.push(frame));
    (inherited[0] as any).name = "mutation";
    assert.deepEqual(broker.specs("child", a), wire);
    const result = broker.invoke("child", "turn", "browser.read", {}, new AbortController().signal, a);
    assert.equal(parentFrames.length, 0);
    assert.equal(childFrames[0].params.threadId, "child");
    assert.equal(childFrames[0].params.namespace, "browser");
    assert.equal(broker.respond(b, childFrames[0].id, {}), false);
    broker.respond(a, childFrames[0].id, { success: true });
    assert.deepEqual(await result, { success: true });
    assert.equal(broker.specs("unknown", a), undefined);
    broker.register("empty", a, [], () => {});
    assert.deepEqual(broker.specs("empty", a), []);
  } finally { broker.close(); }
});

test("engine capability readiness rejects deferred and partial registrations", () => {
  assert.doesNotThrow(() => verifyDshCapabilityRegistration(3, { registered: 3 }));
  assert.throws(
    () => verifyDshCapabilityRegistration(3, { registered: 0, deferred: true }),
    /registered 0 of 3 dynamic tools/u,
  );
  assert.throws(
    () => verifyDshCapabilityRegistration(3, { registered: 2 }),
    /registered 2 of 3 dynamic tools/u,
  );
});
