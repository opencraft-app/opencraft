import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import {
  installPreviewBridgeRuntime,
  PREVIEW_BRIDGE_SOURCE,
  PREVIEW_BRIDGE_PROTOCOL_VERSION,
} from "@opencraft/browser-preview-bridge";

function fixture(t: test.TestContext, html = '<button aria-label="Action">Run</button><input aria-label="Name">') {
  const dom = new JSDOM(html, { url: "https://child.test/page", pretendToBeVisual: true }),
    window = dom.window;
  const replies: any[] = [],
    identity = {
      source: PREVIEW_BRIDGE_SOURCE,
      protocolVersion: PREVIEW_BRIDGE_PROTOCOL_VERSION,
      previewId: "preview",
      generation: 1,
      nonce: "private-nonce",
    };
  window.HTMLElement.prototype.getClientRects = () => [{ width: 100, height: 20 }] as never;
  window.HTMLElement.prototype.scrollIntoView = () => {};
  window.postMessage = ((message: unknown) => {
    replies.push(message);
  }) as never;
  const dispose = installPreviewBridgeRuntime({ window: window as never, parentOrigin: "https://parent.test" });
  t.after(() => {
    dispose();
    window.close();
  });
  const send = (body: object) =>
    window.dispatchEvent(
      new window.MessageEvent("message", {
        source: window as never,
        origin: "https://parent.test",
        data: { ...identity, ...body },
      }),
    );
  send({ type: "platform:connect" });
  assert(replies.some((row) => row.type === "preview:ready"));
  assert.equal(replies.find((row) => row.type === "preview:ready").capabilities.networkObservation, "none");
  let sequence = 0;
  const call = async (method: string, params: object = {}) => {
    const callId = String(++sequence);
    send({ type: "platform:call", callId, method, params });
    await Promise.resolve();
    await Promise.resolve();
    const reply = replies.find((row) => row.type === "preview:call-result" && row.callId === callId);
    assert(reply, "Runtime must answer the correlated invocation");
    return reply;
  };
  return { window, replies, send, call };
}
test("fresh inspection drains already pending mutations before issuing references", async (t) => {
  const f = fixture(t);
  f.window.document.querySelector("input")!.setAttribute("data-state", "changed");
  const snapshot = await f.call("inspect"),
    field = snapshot.result.elements.find((row) => row.name === "Name");
  assert(field);
  const filled = await f.call("fill", { ref: field.ref, expectedRevision: snapshot.result.revision, value: "fresh" });
  assert.equal(filled.ok, true);
  assert.equal(f.window.document.querySelector("input")!.value, "fresh");
});
test("unobserved DOM mutation rejects a previous reference before any click", async (t) => {
  const f = fixture(t),
    button = f.window.document.querySelector("button")!;
  let clicks = 0;
  button.addEventListener("click", () => clicks++);
  const snapshot = await f.call("inspect"),
    target = snapshot.result.elements.find((row) => row.name === "Action");
  button.textContent = "Changed";
  const clicked = await f.call("click", { ref: target.ref, expectedRevision: snapshot.result.revision });
  assert.equal(clicked.ok, false);
  assert.equal(clicked.error.code, "STALE_ELEMENT_REFERENCE");
  assert.equal(clicks, 0);
});
test("focus replacing the target cannot dispatch a click to the detached old element", async (t) => {
  const f = fixture(t),
    button = f.window.document.querySelector("button")!;
  let clicks = 0;
  button.addEventListener("click", () => clicks++);
  button.addEventListener("focus", () => button.replaceWith(f.window.document.createElement("button")));
  const snapshot = await f.call("inspect"),
    target = snapshot.result.elements.find((row) => row.name === "Action");
  const clicked = await f.call("click", { ref: target.ref, expectedRevision: snapshot.result.revision });
  assert.equal(clicked.ok, false);
  assert.equal(clicked.error.code, "STALE_ELEMENT_REFERENCE");
  assert.equal(clicks, 0);
});
test("same-document navigation invalidates refs even when DOM did not change", async (t) => {
  const f = fixture(t),
    snapshot = await f.call("inspect"),
    target = snapshot.result.elements.find((row) => row.name === "Action");
  f.window.history.pushState({}, "", "/next");
  f.window.dispatchEvent(new f.window.PopStateEvent("popstate"));
  const clicked = await f.call("click", { ref: target.ref, expectedRevision: snapshot.result.revision });
  assert.equal(clicked.ok, false);
  assert.equal(clicked.error.code, "STALE_ELEMENT_REFERENCE");
});
test("runtime still fences foreign identity and redacts/blocks sensitive controls", async (t) => {
  const f = fixture(t, '<input type="password" aria-label="Secret" value="private-test-value">');
  f.send({ type: "platform:call", generation: 2, method: "inspect", callId: "foreign", params: {} });
  await Promise.resolve();
  assert(!f.replies.some((row) => row.callId === "foreign"));
  const snapshot = await f.call("inspect"),
    target = snapshot.result.elements[0];
  assert(!JSON.stringify(snapshot).includes("private-test-value"));
  const filled = await f.call("fill", {
    ref: target.ref,
    expectedRevision: snapshot.result.revision,
    value: "blocked",
  });
  assert.equal(filled.error.code, "POLICY_BLOCKED");
  assert.equal(f.window.document.querySelector("input")!.value, "private-test-value");
});
test("replacing handshake identity invalidates old refs and cannot relabel old results", async (t) => {
  const f = fixture(t),
    snapshot = await f.call("inspect"),
    target = snapshot.result.elements.find((row) => row.name === "Action");
  f.send({ type: "platform:call", callId: "reused", method: "wait", params: { text: "never-present", timeoutMs: 0 } });
  f.send({ type: "platform:connect", generation: 2, nonce: "successor" });
  f.send({
    type: "platform:call",
    generation: 2,
    nonce: "successor",
    callId: "old-ref",
    method: "click",
    params: { ref: target.ref, expectedRevision: snapshot.result.revision },
  });
  f.send({ type: "platform:call", generation: 2, nonce: "successor", callId: "reused", method: "inspect", params: {} });
  await Promise.resolve();
  await Promise.resolve();
  const results = f.replies.filter((row) => row.type === "preview:call-result" && row.callId === "reused");
  assert.equal(results.length, 1);
  assert.equal(results[0].ok, true);
  assert.equal(results[0].nonce, "successor");
  assert.equal(f.replies.find((row) => row.callId === "old-ref").error.code, "STALE_ELEMENT_REFERENCE");
});
test("repeating the same handshake does not invalidate a live reference", async (t) => {
  const f = fixture(t),
    snapshot = await f.call("inspect"),
    target = snapshot.result.elements.find((row) => row.name === "Action");
  let clicks = 0;
  f.window.document.querySelector("button")!.addEventListener("click", () => clicks++);
  f.send({ type: "platform:connect" });
  const clicked = await f.call("click", { ref: target.ref, expectedRevision: snapshot.result.revision });
  assert.equal(clicked.ok, true);
  assert.equal(clicks, 1);
});
