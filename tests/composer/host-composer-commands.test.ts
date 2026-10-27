import assert from "node:assert/strict";
import test from "node:test";
import { asHostId, asThreadId } from "@opencraft/chat-core";
import type { SubmitIntent } from "@opencraft/composer-core";
import {
  HostConnectionProviderRegistry, createHostComposerCommandPort, findStandaloneHostComposerAction,
  type HostConnectionProvider, type HostComposerCommands, type HostComposerCommandContext,
} from "@opencraft/workbench-runtime";

const commands: HostComposerCommands["commands"] = [
  { name: "status", kind: "prompt", description: { id: "test.status", defaultMessage: "View status" } },
  { name: "stop", kind: "action", description: { id: "test.stop", defaultMessage: "Stop task" } },
];
const intent: SubmitIntent = {
  commandId: "command", clientMessageId: "message",
  target: { type: "existing-thread", key: { hostId: asHostId("one"), threadId: asThreadId("thread") } },
  document: { version: 1, blocks: [{ type: "paragraph", children: [{ type: "text", text: "/stop " }] }] },
  attachments: [], context: [], selections: {}, options: { autoContext: false }, createdAt: 0,
};
const provider = (composerCommands?: HostComposerCommands): HostConnectionProvider => ({
  id: "test", label: "Test", targets: ["web"], configVersion: 1, validate: c => c,
  createTransport() { throw new Error("No transport needed"); }, composerCommands,
});
function fixture(invoke: NonNullable<HostComposerCommands["invoke"]> = async () => {}) {
  const registry = new HostConnectionProviderRegistry();
  const unregister = registry.register("extension", provider({ commands, invoke }));
  const resident = registry.acquire("test", "web");
  let current = true;
  const protocol = { request: async () => ({}) as never };
  const port = createHostComposerCommandPort({
    provider: resident.provider, context: { platform: "web", hostId: "one", profileRevision: 3 }, protocol,
    isCurrent: () => current, acquire: () => registry.acquire("test", "web"),
  })!;
  return { registry, unregister, resident, port, protocol, invalidate: () => { current = false; } };
}

test("only an explicitly declared standalone action bypasses prompt submission", () => {
  assert.equal(findStandaloneHostComposerAction(intent, commands)?.name, "stop");
  assert.equal(findStandaloneHostComposerAction({ ...intent, document: { version: 1, blocks: [
    { type: "paragraph", children: [{ type: "command", name: "stop" }] },
  ] } }, commands)?.name, "stop");
  for (const text of ["/status", "/stop please", "/unknown", "text /stop"]) {
    assert.equal(findStandaloneHostComposerAction({ ...intent, document: { version: 1, blocks: [
      { type: "paragraph", children: [{ type: "text", text }] },
    ] } }, commands), null);
  }
  assert.equal(findStandaloneHostComposerAction(intent, []), null);
  assert.equal(findStandaloneHostComposerAction({ ...intent, document: { version: 1, blocks: [{ type: "code-block", text: "/stop" }] } }, commands), null);
  assert.equal(findStandaloneHostComposerAction({ ...intent, document: { ...intent.document, blocks: [...intent.document.blocks, ...intent.document.blocks] } }, commands), null);
  assert.equal(findStandaloneHostComposerAction({ ...intent, attachments: [{ id: "a", name: "image", mimeType: "image/png", size: 1, uri: "file://image", lifecycle: "ready", error: null }] }, commands), null);
  assert.equal(findStandaloneHostComposerAction({ ...intent, context: [{ id: "c", kind: "file", title: "file", uri: "file://context", visible: true }] }, commands), null);
});

test("registration validates and snapshots declarations without exposing executable callbacks", async () => {
  const registry = new HostConnectionProviderRegistry();
  for (const invalid of [
    { commands },
    { commands: [commands[0]!, commands[0]!] },
    { commands: [{ ...commands[0]!, name: "/bad" }] },
    { commands: [{ ...commands[0]!, kind: "other" as never }] },
    { commands: [{ ...commands[0]!, description: { id: "", defaultMessage: "Empty" } }] },
  ]) assert.throws(() => registry.register("extension", provider(invalid)), /require|Invalid/u);
  const mutable = structuredClone(commands) as Array<(typeof commands)[number]>;
  const unregister = registry.register("extension", provider({ commands: mutable, invoke: async () => {} }));
  mutable.length = 0;
  const descriptor = registry.getSnapshot().providers[0]!;
  assert.equal(descriptor.composerCommands?.length, 2);
  assert.equal(Object.isFrozen(descriptor.composerCommands), true);
  assert.equal(Object.isFrozen(descriptor.composerCommands?.[0]?.description), true);
  assert.equal("invoke" in descriptor, false);
  await unregister(); await registry.close();
});

test("new and active thread actions carry exact captured Host/profile/protocol and Turn targets", async () => {
  const calls: Array<[string, HostComposerCommandContext]> = [];
  const f = fixture(async (name, context) => { calls.push([name, context]); });
  // Structural typing permits extra fields on an existing object. Never spread them into the bound context.
  const target = { threadId: null, expectedTurnId: null, hostId: "foreign", profileRevision: 99,
    platform: "expo", protocol: { request: async () => { throw new Error("Foreign protocol"); } } };
  await f.port.invoke("stop", target);
  await f.port.invoke("stop", { threadId: "thread", expectedTurnId: "turn" });
  assert.deepEqual(calls.map(([name, c]) => [name, c.hostId, c.profileRevision, c.threadId, c.expectedTurnId]), [
    ["stop", "one", 3, null, null], ["stop", "one", 3, "thread", "turn"],
  ]);
  assert.equal(calls[0]?.[1].protocol, f.protocol);
  await assert.rejects(f.port.invoke("status", { threadId: null, expectedTurnId: null }), /unavailable/u);
  f.resident.release(); await f.unregister(); await f.registry.close();
});

test("Host/profile invalidation refuses new commands", async () => {
  let calls = 0; const f = fixture(async () => { calls++; }); f.invalidate();
  await assert.rejects(f.port.invoke("stop", { threadId: null, expectedTurnId: null }), /no longer current/u);
  assert.equal(calls, 0); f.resident.release(); await f.unregister(); await f.registry.close();
});

test("retirement drains accepted actions independently of resident disposal and rejects new actions", async () => {
  let finish!: () => void;
  const f = fixture(() => new Promise<void>(resolve => { finish = resolve; }));
  const action = f.port.invoke("stop", { threadId: "thread", expectedTurnId: "turn" });
  let retired = false; const retirement = f.unregister().then(() => { retired = true; });
  f.resident.release(); await Promise.resolve();
  assert.equal(retired, false);
  await assert.rejects(f.port.invoke("stop", { threadId: null, expectedTurnId: null }), /unavailable/u);
  finish(); await action; await retirement;
  assert.equal(retired, true); await f.registry.close();
});

test("a replacement with the same provider ID cannot receive commands from the old runtime", async () => {
  let calls = 0; const f = fixture(async () => { calls++; });
  const retirement = f.unregister();
  const unregisterNew = f.registry.register("replacement", provider({ commands, invoke: async () => { calls++; } }));
  await assert.rejects(f.port.invoke("stop", { threadId: null, expectedTurnId: null }), /has changed/u);
  assert.equal(calls, 0); f.resident.release(); await retirement; await unregisterNew(); await f.registry.close();
});

test("failed actions release their lease and providers without commands have no port", async () => {
  const f = fixture(async () => { throw new Error("Backend failed"); });
  await assert.rejects(f.port.invoke("stop", { threadId: null, expectedTurnId: null }), /Backend failed/u);
  f.resident.release(); await f.unregister(); await f.registry.close();
  assert.equal(createHostComposerCommandPort({ provider: provider(), context: { platform: "web", hostId: "none", profileRevision: 0 },
    protocol: f.protocol, isCurrent: () => true, acquire: () => { throw new Error("Must not acquire"); } }), undefined);
});
