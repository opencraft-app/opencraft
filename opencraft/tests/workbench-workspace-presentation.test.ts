import assert from "node:assert/strict";
import test from "node:test";
import { Context } from "@deepseek-ai/cordis";
import { WorkbenchPanelService, createConversationPanelState, reduceConversationPanelState } from "@opencraft/workbench-panels";
import { createConversationKey } from "@opencraft/chat-core";
import { SideChatService, type AppServerWorkbenchRuntime, type AppServerThreadRuntimeLease } from "@opencraft/workbench-runtime";
import { shouldPresentMainComposerOverlay } from "../apps/workbench-web/src/components/thread-composer-presentation-model";
import { restoreRightPanelTabs } from "../apps/workbench-web/src/runtime/restore-right-panel-tabs";

test("WSP-01 expanded tools keep the main composer, side/background conversations exclude it", () => {
  for (const id of [null, "browser:a", "terminal:a", "resource:a"]) assert.equal(shouldPresentMainComposerOverlay(true, id), true);
  for (const id of ["sidechat:child", "background-agent:child"]) assert.equal(shouldPresentMainComposerOverlay(true, id), false);
  assert.equal(shouldPresentMainComposerOverlay(false, "browser:a"), false);
});

test("WSP-14 legacy bottom tabs return to the right without closing resources", async () => {
  const ctx = new Context(); const fiber = ctx.plugin(WorkbenchPanelService); await fiber;
  const closed: string[] = [];
  ctx.workbenchPanels.register<{ id: string }>({ kind: "legacy", createTab: ({ id }) => ({ id, kind: "legacy", region: "right", title: id, resource: id, closable: true, preview: false }), disposeTab: tab => { closed.push(tab.id); } });
  ctx.workbenchPanels.open("owner", "legacy", { id: "browser" });
  ctx.workbenchPanels.open("owner", "legacy", { id: "terminal" });
  ctx.workbenchPanels.dispatch("owner", { type: "transfer-tab", region: "right", targetRegion: "bottom", tabId: "terminal" });
  restoreRightPanelTabs(ctx.workbenchPanels, "owner");
  const restored = ctx.workbenchPanels.getOwnerSnapshot("owner");
  assert.deepEqual(restored.right.tabs.map(tab => tab.id), ["browser", "terminal"]);
  assert.equal(restored.bottom.tabs.length, 0);
  assert.equal(restored.bottom.open, false);
  assert.deepEqual(closed, []);
  restoreRightPanelTabs(ctx.workbenchPanels, "owner");
  assert.equal(ctx.workbenchPanels.getOwnerSnapshot("owner"), restored);
  await fiber.dispose();
});

test("WSP-03 transfer preserves resource identity, MRU and a single region; never invokes close", async () => {
  const ctx = new Context();
  const fiber = ctx.plugin(WorkbenchPanelService); await fiber;
  const disposed: string[] = [];
  ctx.workbenchPanels.register<{ id: string }>({ kind: "terminal", createTab: ({ id }) => ({ id, kind: "terminal", region: "right", title: id, resource: id, preview: false, closable: true }), disposeTab: tab => { disposed.push(tab.id); } });
  const service = ctx.workbenchPanels;
  service.open("host-a/thread", "terminal", { id: "a" });
  service.open("host-a/thread", "terminal", { id: "b" });
  const result = service.dispatch("host-a/thread", { type: "transfer-tab", region: "right", targetRegion: "bottom", tabId: "b" });
  assert.equal(result.right.activeTabId, "a"); assert.equal(result.bottom.activeTabId, "b");
  assert.equal(result.bottom.tabs[0]?.resource, "b"); assert.deepEqual(disposed, []);
  service.open("host-a/thread", "terminal", { id: "b" });
  assert.deepEqual(service.getOwnerSnapshot("host-a/thread").right.tabs.map(tab => tab.id), ["a"]);
  service.close("host-a/thread", "bottom", "b"); assert.deepEqual(disposed, ["b"]);
  assert.equal(service.getOwnerSnapshot("host-b/thread").bottom.tabs.length, 0);
  await fiber.dispose();
});

test("WSP-03 invalid transfer is a no-op; last right tab transfer exits full-width", () => {
  let state = createConversationPanelState({ ownerId: "scope" });
  state = reduceConversationPanelState(state, { type: "open-tab", tab: { id: "browser:a", kind: "browser", region: "right", title: "Browser", closable: true, preview: false } });
  state = reduceConversationPanelState(state, { type: "toggle-right-full-width" });
  assert.equal(reduceConversationPanelState(state, { type: "transfer-tab", region: "right", targetRegion: "bottom", tabId: "missing" }), state);
  assert.equal(reduceConversationPanelState(state, { type: "transfer-tab", region: "right", targetRegion: "bottom", tabId: "browser:a", beforeTabId: "missing" }), state);
  const next = reduceConversationPanelState(state, { type: "transfer-tab", region: "right", targetRegion: "bottom", tabId: "browser:a" });
  assert.equal(next.right.open, false); assert.equal(next.rightPanelFullWidth, false); assert.equal(next.bottom.open, true);
});

function fixture() {
  const calls: unknown[] = [];
  let resolveFork!: (thread: { id: string }) => void;
  const fork = new Promise<{ id: string }>(resolve => { resolveFork = resolve; });
  const lease = { threadId: "child", release: () => calls.push("release"), getSnapshot: () => ({ activeTurn: null, timeline: { frames: [] } }), submit: async (intent: unknown) => { calls.push(intent); return {}; } } as unknown as AppServerThreadRuntimeLease;
  const runtime = { resources: { threads: { fork: (params: unknown) => { calls.push(params); return fork; }, unsubscribe: async (id: string) => { calls.push(["unsubscribe", id]); } } }, acquireThread: async () => lease } as unknown as AppServerWorkbenchRuntime;
  return { calls, runtime, resolveFork };
}

test("WSP-07 side chat forks an ephemeral child on the parent's host and owns a separate draft", async () => {
  const f = fixture(); const ctx = new Context(); const hosts: string[] = [];
  const fiber = ctx.plugin(SideChatService, { resolveHost: async (host: string) => { hosts.push(host); return f.runtime; } }); await fiber;
  const pending = ctx.sideChats.open("request", createConversationKey("remote", "parent"), "/work");
  f.resolveFork({ id: "child" }); const session = await pending;
  assert.deepEqual(hosts, ["remote"]); assert.equal(session.key.threadId, "child");
  assert.deepEqual(session.composer.getSnapshot().draft.target, { type: "existing-thread", key: session.key });
  assert.equal((f.calls[0] as { ephemeral: boolean }).ephemeral, true);
  session.composer.dispatch({ type: "set-document", document: { version: 1, blocks: [{ type: "paragraph", children: [{ type: "text", text: "child question" }] }] } });
  const intent = session.composer.createSubmitIntent();
  session.composer.dispatch({ type: "set-lifecycle", phase: "submitting" });
  await ctx.sideChats.submit("request", intent, null);
  assert.equal(f.calls.at(-1), intent, "admission consumes the frozen intent, not the submitting draft");
  await assert.rejects(ctx.sideChats.submit("request", { ...intent, target: { type: "existing-thread", key: createConversationKey("other-host", "child") } }, null), /different conversation/);
  await ctx.sideChats.close("request"); assert.equal(ctx.sideChats.get("request"), null);
  assert.deepEqual(f.calls.slice(-2), ["release", ["unsubscribe", "child"]]);
  await fiber.dispose(); assert.deepEqual(hosts, ["remote"]);
});

test("WSP-08 cancelled fork cannot mount a late child and releases the server subscription", async () => {
  const f = fixture(); const ctx = new Context();
  const fiber = ctx.plugin(SideChatService, { resolveHost: async () => f.runtime }); await fiber;
  const pending = ctx.sideChats.open("request", createConversationKey("local", "parent"), null);
  await Promise.resolve(); ctx.sideChats.cancel("request"); f.resolveFork({ id: "late" });
  await assert.rejects(pending, /cancelled/); assert.equal(ctx.sideChats.get("request"), null);
  assert.deepEqual(f.calls.at(-1), ["unsubscribe", "late"]);
  await fiber.dispose();
});
