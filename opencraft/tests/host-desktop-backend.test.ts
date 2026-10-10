import assert from "node:assert/strict";
import test from "node:test";
import { asHostId, createConversationKey } from "@opencraft/chat-core";
import { asConversationScopeId, createConversationBindingStore, HostRuntimeRegistry,
  type AppServerWorkbenchRuntime } from "@opencraft/workbench-runtime";
import { HostDesktopBackend } from "../apps/workbench-web/src/runtime/host-desktop-backend.js";
import { OPENCRAFT_DESKTOP_ATTACH, OPENCRAFT_DESKTOP_EXTENSION, parseHostDesktopCapability } from "@opencraft/appserver-protocol/desktop";
import type { RfbDesktopAdapter } from "../plugins/cloud-desktop/src/rfb";
import { DesktopViewController } from "../plugins/cloud-desktop/src/controller";

function fixture(origin = "http://127.0.0.1:10000", transport = "same-origin-loopback", openSocket?: (url: string) => WebSocket,
  overrides?: { renewable: boolean; media: RfbDesktopAdapter }) {
  const bindings = createConversationBindingStore(), listeners = new Set<() => void>();
  const scope = asConversationScopeId("view-scope");
  bindings.register(scope, asHostId("transport-alias"));
  bindings.bind(scope, createConversationKey(asHostId("transport-alias"), "native-thread"));
  let generation = 1, phase = "ready", advertised = true;
  const calls: { method: string; params: unknown }[] = [];
  let respond: () => Promise<unknown> = async () => ({ version: 1, target: { conversationId: "native-thread", serverId: "server",
    environmentId: "machine", principalId: "local-user" }, instanceId: "machine", resourceId: "machine",
    bindingRevision: "b".repeat(64), preparationGenerationId: "preparation", incarnation: "a".repeat(64),
    attachmentId: "x".repeat(22), ticket: "x".repeat(43), expiresAt: Date.now() + 60000 });
  const runtime = { subscribe(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener); },
    getSnapshot: () => ({ phase }), connect: async () => {}, dispose: async () => {}, resources: {
      host: { getConnectionGeneration: () => generation, getInitializeResult: () => ({ capabilities: { extensions: advertised
        ? { [OPENCRAFT_DESKTOP_EXTENSION]: { version: 1, observe: true, control: false, transport,
          serverId: "server", environmentId: "machine", principalId: "local-user",
          ...(overrides ? { renewable: overrides.renewable } : {}) } } : {} } }) },
      protocol: { request: async (method: string, params: unknown) => { calls.push({ method, params }); return method === OPENCRAFT_DESKTOP_ATTACH ? respond() : {}; } },
    } } as unknown as AppServerWorkbenchRuntime;
  const registry = new HostRuntimeRegistry([{ descriptor: { hostId: "transport-alias", label: "Fixture", kind: "codex",
    transportEndpoint: null, executionLocation: null, workspaceBrowseRoots: [] }, createRuntime: () => runtime }]);
  registry.getRuntime("transport-alias");
  // Socket address belongs to this adapter, not noVNC module loading. Open the
  // real wire channel through a media boundary so Node does not need a DOM.
  const media: RfbDesktopAdapter | undefined = openSocket ? { surfaces: { mount() { throw new Error("not mounted"); } },
    async connect(session) { try { session.openChannel(); throw new Error("fixture stop"); } finally { session.close(); } } } : undefined;
  const backend = new HostDesktopBackend({ bindings, registry, origin, openSocket, media: overrides?.media ?? media });
  return { backend, bindings, registry, calls, setResponse(value: () => Promise<unknown>) { respond = value; },
    retire() { generation++; phase = "idle"; for (const listener of listeners) listener(); },
    hide() { advertised = false; for (const listener of listeners) listener(); },
    async close() { backend.dispose(); bindings.dispose(); await registry.dispose(); } };
}

test("local adapter projects presentation Scope but requests only the native Thread", async () => {
  const f = fixture(); try {
    const target = f.backend.resolveTarget("view-scope")!;
    assert.equal(target.conversationId, "view-scope"); assert.equal(target.serverId, "server");
    const attachment = await f.backend.prepare(target, new AbortController().signal);
    assert.deepEqual(f.calls[0], { method: OPENCRAFT_DESKTOP_ATTACH, params: { threadId: "native-thread" } });
    assert.deepEqual(attachment.target, target);
    attachment.release(); attachment.release(); assert.equal(f.calls.length, 2);
    assert.equal(f.backend.resolveTarget("native-thread"), null, "do not confuse Thread ID with Scope ID");
    f.hide(); assert.equal(f.backend.resolveTarget("view-scope"), null);
  } finally { await f.close(); }
});

test("real Host backend, wire and controller retain one viewer across multiple five-minute deadlines", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000_000 });
  const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
  let renewals = 0, mounts = 0, closes = 0, enabled = 0;
  class Socket extends EventTarget {
    readyState = 0; bufferedAmount = 0;
    send(data: string) {
      const message = JSON.parse(data);
      if (message.event === "desktop/renew") {
        renewals++;
        queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({
          event: "desktop/renewed", requestId: message.requestId, expiresAt: Date.now() + 300_000,
        }) })));
      }
    }
    close() { this.readyState = 3; closes++; }
  }
  const socket = new Socket();
  const media: RfbDesktopAdapter = {
    surfaces: { mount() { mounts++; return { setActive() {}, enableInput() { enabled++; }, disableInput() {}, dispose() {} }; } },
    async connect(session) {
      const channel = session.openChannel();
      socket.readyState = 1; socket.dispatchEvent(new Event("open"));
      socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ event: "desktop/ready", version: 1,
        attachmentId: "x".repeat(22), controlAvailable: false, clipboardAvailable: false, renewable: true }) }));
      return { getSnapshot: () => ({ videoReady: channel.readyState === 1, inputReady: channel.readyState === 1,
        controlAvailable: false, ended: channel.readyState === 3,
        retryable: session.getTermination?.() === "transport-lost" }),
        subscribe(listener) { channel.addEventListener("close", listener); return () => channel.removeEventListener("close", listener); },
        requestControl: signal => session.control!.request(signal), close: () => session.close() };
    },
  };
  const f = fixture(undefined, undefined, () => socket as unknown as WebSocket, { renewable: true, media });
  f.setResponse(async () => ({ version: 1, target: { conversationId: "native-thread", serverId: "server",
    environmentId: "machine", principalId: "local-user" }, instanceId: "machine", resourceId: "machine",
    bindingRevision: "b".repeat(64), preparationGenerationId: "preparation", incarnation: "a".repeat(64),
    attachmentId: "x".repeat(22), ticket: "x".repeat(43), expiresAt: Date.now() + 300_000 }));
  const controller = new DesktopViewController(f.backend, media.surfaces, "view-scope", {} as HTMLElement);
  try {
    controller.start(); await flush(); assert.equal(controller.getSnapshot().phase, "ready");
    for (let i = 1; i <= 12; i++) {
      t.mock.timers.tick(270_000); await flush();
      assert.equal(renewals, i);
      assert.equal(controller.getSnapshot().phase, "ready");
      assert.equal(controller.getSnapshot().control, "observing");
    }
    assert.equal(f.calls.filter(call => call.method === OPENCRAFT_DESKTOP_ATTACH).length, 1);
    assert.equal(mounts, 1); assert.equal(closes, 0); assert.equal(enabled, 0);
    f.retire(); await flush();
    const before = renewals; t.mock.timers.tick(600_000); await flush();
    assert.equal(renewals, before); assert.equal(closes, 1);
    assert.notEqual(controller.getSnapshot().phase, "ready", "successor Client cannot retain the old authorization");
  } finally { controller.dispose(); await f.close(); }
});

test("public pages cannot infer a local desktop from a capability", async () => {
  const f = fixture("https://join.example"); try { assert.equal(f.backend.resolveTarget("view-scope"), null); }
  finally { await f.close(); }
});

test("only an explicit trusted-internal capability admits non-loopback pages and uses wss for HTTPS", async () => {
  for (const origin of ["https://workspace.internal", "http://10.0.0.5:8080"]) {
    let endpoint = "";
    const f = fixture(origin, "same-origin-trusted-internal", url => { endpoint = url; throw new Error("fixture stop before media"); });
    try {
      const target = f.backend.resolveTarget("view-scope")!;
      assert.ok(target);
      const attachment = await f.backend.prepare(target, new AbortController().signal);
      await assert.rejects(attachment.connect(new AbortController().signal));
      assert.equal(endpoint, `${origin.replace(/^http/, "ws")}/desktop/connect`);
    } finally { await f.close(); }
  }
  for (const [origin, transport] of [["https://workspace.internal", "unknown"], ["file:///workspace", "same-origin-trusted-internal"],
    ["https://workspace.internal/path", "same-origin-trusted-internal"]]) {
    const f = fixture(origin, transport); try { assert.equal(f.backend.resolveTarget("view-scope"), null); }
    finally { await f.close(); }
  }
  assert.equal(parseHostDesktopCapability({ version: 1, observe: true, control: true,
    transport: "same-origin-trusted-internal", serverId: "server", environmentId: "machine", principalId: "user" })?.control, true);
  assert.equal(parseHostDesktopCapability({ version: 1, observe: true, control: "true",
    transport: "same-origin-trusted-internal", serverId: "server", environmentId: "machine", principalId: "user" }), null);
});

test("cancelled late grant is released, while successor Client must not release an old grant", async () => {
  const f = fixture(); try {
    const target = f.backend.resolveTarget("view-scope")!;
    let complete!: (value: unknown) => void;
    f.setResponse(() => new Promise(resolve => complete = resolve));
    const abort = new AbortController(); const operation = f.backend.prepare(target, abort.signal);
    abort.abort(); complete({ attachmentId: "x".repeat(22) }); await assert.rejects(operation);
    assert.equal(f.calls.length, 2);
    const second = f.backend.prepare(target, new AbortController().signal);
    f.retire(); complete({ attachmentId: "x".repeat(22) }); await assert.rejects(second);
    assert.equal(f.calls.length, 3, "never issue release through the replacement Client");
  } finally { await f.close(); }
});

test("backend credential for another Thread is rejected and retired", async () => {
  const f = fixture(); try {
    f.setResponse(async () => ({ attachmentId: "x".repeat(22), version: 1, target: { conversationId: "other-thread" } }));
    await assert.rejects(f.backend.prepare(f.backend.resolveTarget("view-scope")!, new AbortController().signal));
    assert.equal(f.calls.length, 2);
  } finally { await f.close(); }
});
