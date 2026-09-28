import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { DshCapabilityBroker, normalizeCapabilities } from "../apps/local-agent-host/src/dsh-capability-broker.js";
import { DshCapabilityLink, verifyDshCapabilityRegistration } from "../apps/local-agent-host/src/dsh-capability-link.js";
import { DshExecutionAuthority } from "../apps/local-agent-host/src/dsh-execution-authority.js";
const a = { connectionId: "a", identity: { id: "local", username: "local" } };
const b = { connectionId: "b", identity: { id: "local", username: "local" } };
const specs = [{ type: "function", name: "browser_open", description: "Open owned browser", inputSchema: { type: "object", properties: { url: { type: "string" } } } }];

test("Host computes and propagates approval-aware deadlines, never trusting model configuration", () => {
  assert.equal(normalizeCapabilities(specs)[0].timeoutMs, 10000);
  assert.equal(normalizeCapabilities([{ type: "namespace", name: "connectors", description: "Connectors", tools: [{ ...specs[0], name: "call_tool", timeoutMs: 1 }] }])[0].timeoutMs, 150000);
  assert.equal(normalizeCapabilities([{ ...specs[0], name: "call_tool", timeoutMs: 1 }])[0].timeoutMs, 10000);
  assert.equal(normalizeCapabilities([{ type: "namespace", name: "other", description: "Other", tools: [{ ...specs[0], name: "call_tool" }] }])[0].timeoutMs, 10000);
});

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

test("engine capability readiness accepts cold deferral only at display hydration", () => {
  assert.doesNotThrow(() => verifyDshCapabilityRegistration(3, { registered: 3 }));
  assert.doesNotThrow(() => verifyDshCapabilityRegistration(
    3,
    { registered: 0, deferred: true },
    { allowDeferred: true },
  ));
  assert.throws(
    () => verifyDshCapabilityRegistration(3, { registered: 0, deferred: true }),
    /registered 0 of 3 dynamic tools/u,
  );
  assert.throws(
    () => verifyDshCapabilityRegistration(3, { registered: 2 }),
    /registered 2 of 3 dynamic tools/u,
  );
  assert.throws(
    () => verifyDshCapabilityRegistration(3, { registered: 2, deferred: true }, { allowDeferred: true }),
    /registered 2 of 3 dynamic tools/u,
  );
});

test("capability bridge failures expose only known codes, never exception text", async () => {
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.method === "GET" && request.url === "/events") {
      response.end(JSON.stringify({ events: [] }));
      return;
    }
    response.writeHead(400).end(JSON.stringify({
      code: "CAPABILITY_CONFLICT",
      error: `tool already registered\n${"x".repeat(500)}`,
      ignoredRequestPayload: "must-not-surface",
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const broker = new DshCapabilityBroker();
  const authority = new DshExecutionAuthority(":memory:");
  const link = new DshCapabilityLink("x".repeat(64), broker, authority);
  link.attach(`http://127.0.0.1:${address.port}`);
  try {
    await assert.rejects(link.validate([]), (error: Error) => {
      assert.equal(error.message, "DSH capability bridge request failed: 400 (CAPABILITY_CONFLICT)");
      assert.doesNotMatch(error.message, /tool already registered/u);
      assert.doesNotMatch(error.message, /must-not-surface/u);
      assert.ok(error.message.length < 380);
      return true;
    });
  } finally {
    await link.close();
    broker.close();
    authority.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("revoked capability owner cannot resurrect through a late registration", () => {
  const broker = new DshCapabilityBroker();
  try {
    broker.register("s", a, specs, () => {});
    broker.disconnect(a);
    assert.throws(() => broker.register("s", a, specs, () => {}), /disconnected/u);
    assert.doesNotThrow(() => broker.register("s", b, specs, () => {}));
    assert.equal(broker.release("s", a), false);
    assert.equal(broker.list("s").length, 1);
  } finally { broker.close(); }
});
