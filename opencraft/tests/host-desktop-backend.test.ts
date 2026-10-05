import assert from "node:assert/strict";
import test from "node:test";
import { asHostId, createConversationKey } from "@opencraft/chat-core";
import { asConversationScopeId, createConversationBindingStore, HostRuntimeRegistry,
  type AppServerWorkbenchRuntime } from "@opencraft/workbench-runtime";
import { HostDesktopBackend } from "../apps/workbench-web/src/runtime/host-desktop-backend.js";
import { OPENCRAFT_DESKTOP_ATTACH, OPENCRAFT_DESKTOP_EXTENSION } from "@opencraft/appserver-protocol/desktop";

function fixture(origin = "http://127.0.0.1:10000") {
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
        ? { [OPENCRAFT_DESKTOP_EXTENSION]: { version: 1, observe: true, control: false, transport: "same-origin-loopback",
          serverId: "server", environmentId: "machine", principalId: "local-user" } } : {} } }) },
      protocol: { request: async (method: string, params: unknown) => { calls.push({ method, params }); return method === OPENCRAFT_DESKTOP_ATTACH ? respond() : {}; } },
    } } as unknown as AppServerWorkbenchRuntime;
  const registry = new HostRuntimeRegistry([{ descriptor: { hostId: "transport-alias", label: "Fixture", kind: "codex",
    transportEndpoint: null, executionLocation: null, workspaceBrowseRoots: [] }, createRuntime: () => runtime }]);
  registry.getRuntime("transport-alias");
  const backend = new HostDesktopBackend({ bindings, registry, origin });
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

test("public pages cannot infer a local desktop from a capability", async () => {
  const f = fixture("https://join.example"); try { assert.equal(f.backend.resolveTarget("view-scope"), null); }
  finally { await f.close(); }
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
