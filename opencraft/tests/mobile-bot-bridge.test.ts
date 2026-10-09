import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { boundBotConsoleState, BOT_COMMAND_CAPABILITIES, botCommandScript, encodeBotBridgeMessage, parseBotCommand, parseBotToHostMessage } from "../packages/mobile-bot-bridge/src/index";

test("panel ports preserve runtime and conversation identity and reject malformed geometry", () => {
  const command = { type: "chat-panel" as const, command: { ownerId: "thread-a", action: "select" as const, tabId: "file" } };
  const wire = encodeBotBridgeMessage("generation-1", command);
  assert.deepEqual(parseBotCommand(wire, "generation-1"), command);
  assert.equal(parseBotCommand(wire, "generation-2"), null);
  assert.equal(parseBotCommand(wire.replace('"select"', '"execute"'), "generation-1"), null);
  const geometry = { type: "chat-panel-geometry", ownerId: "thread-a", geometry: { containerWidth: 390, panelWidth: 390, chromeHeight: 54, overlay: true } };
  assert.deepEqual(parseBotCommand(encodeBotBridgeMessage("generation-1", geometry), "generation-1"), geometry);
  assert.equal(parseBotCommand(encodeBotBridgeMessage("generation-1", { ...geometry, geometry: { ...geometry.geometry, panelWidth: 400 } }), "generation-1"), null);
  const state = { type: "chat-panel-state", instanceId: "instance-a", profileId: "main", state: {
    ownerId: "thread-a", available: true, open: true, fullWidth: false, activeTabId: "file",
    tabs: [{ id: "file", kind: "resource", title: "Notes", closable: true, preview: true }], actions: [] } };
  const projected = encodeBotBridgeMessage("generation-1", state);
  assert.deepEqual(parseBotToHostMessage(projected, "generation-1"), state);
  assert.equal(parseBotToHostMessage(projected.replace('"instance-a"', '""'), "generation-1"), null);
  assert.equal(parseBotToHostMessage(projected.replace('"activeTabId":"file"', '"activeTabId":"missing"'), "generation-1"), null);
});

test("bridge rejects stale runtime generations, unknown versions, and malformed payloads", () => {
  const catalog = encodeBotBridgeMessage("session-b", { type: "bot-catalog", loading: false, error: false, bots: [{ id: "b1", instanceId: "instance-1", profileId: "main", name: "Bot", status: "ready", isDefault: true }] });
  assert.equal(parseBotToHostMessage(catalog, "session-a"), null);
  assert.equal(parseBotToHostMessage(catalog.replace('"protocol":1', '"protocol":2'), "session-b"), null);
  assert.equal(parseBotToHostMessage('{"protocol":1,"runtimeId":"session-b","payload":{"type":"bot-catalog","bots":[{"id":1}]}}', "session-b"), null);
  assert.equal(parseBotToHostMessage(catalog, "session-b")?.type, "bot-catalog");
  assert.equal(parseBotToHostMessage(catalog.replace('"instanceId":"instance-1"', '"instanceId":""'), "session-b"), null);
});

test("command injection preserves user text as data and validates commands", () => {
  const botId = "x'); alert(1); //";
  const command = { type: "delete" as const, botId };
  const wire = encodeBotBridgeMessage("runtime-1", command);
  assert.deepEqual(parseBotCommand(wire, "runtime-1"), command);
  assert.equal(parseBotCommand(wire, "runtime-2"), null);
  const script = botCommandScript("runtime-1", command);
  const dispatched: unknown[] = [];
  let executed = false;
  vm.runInNewContext(script, {
    window: { dispatchEvent(event: { detail: unknown }) { dispatched.push(event.detail); } },
    CustomEvent: class { detail: unknown; constructor(_name: string, options: { detail: unknown }) { this.detail = options.detail; } },
    alert() { executed = true; },
  });
  assert.equal(executed, false);
  assert.deepEqual(parseBotCommand(dispatched[0] as string, "runtime-1"), command);
  assert.deepEqual(BOT_COMMAND_CAPABILITIES, ["select", "refresh", "create", "delete", "link", "session", "visibility", "chat-panel", "chat-panel-geometry", "chat-panel-gesture"]);
});

test("ready advertises commands before host sends feature actions", () => {
  const ready = encodeBotBridgeMessage("runtime-1", { type: "bot-runtime-ready", originMatches: true, capabilities: BOT_COMMAND_CAPABILITIES });
  assert.equal(parseBotToHostMessage(ready, "runtime-1")?.type, "bot-runtime-ready");
  const unknownCapability = ready.replace('"delete"', '"execute-shell"');
  assert.equal(parseBotToHostMessage(unknownCapability, "runtime-1"), null);
});

test("Bot avatar messages accept only known shapes and safe colors", () => {
  const avatar = encodeBotBridgeMessage("runtime-1", { type: "bot-avatar", botId: "bot-1", configured: true, shapeId: "circle", color: "#8B5CF6" });
  assert.equal(parseBotToHostMessage(avatar, "runtime-1")?.type, "bot-avatar");
  assert.equal(parseBotToHostMessage(avatar.replace('"shapeId":"circle"', '"shapeId":"unknown"'), "runtime-1"), null);
  assert.equal(parseBotToHostMessage(avatar.replace('"color":"#8B5CF6"', '"color":"url(javascript:bad)"'), "runtime-1"), null);
});

test("a failed section is identified without invalidating the runtime protocol", () => {
  const failure = encodeBotBridgeMessage("runtime-1", { type: "bot-section-render-failed", section: "connectors" });
  assert.deepEqual(parseBotToHostMessage(failure, "runtime-1"), { type: "bot-section-render-failed", section: "connectors" });
  assert.equal(parseBotToHostMessage(failure.replace('"connectors"', '42'), "runtime-1"), null);
  const olderRuntime = encodeBotBridgeMessage("runtime-1", { type: "bot-section-render-failed" });
  assert.equal(parseBotToHostMessage(olderRuntime, "runtime-1")?.type, "bot-section-render-failed");
});


test("session mutations validate generation, Bot identity and draft targets", () => {
  const rename = { type: "session" as const, botId: "bot-1", action: "rename" as const, chatId: "chat-1", title: "New title" };
  const encoded = encodeBotBridgeMessage("generation-1", rename);
  assert.deepEqual(parseBotCommand(encoded, "generation-1"), rename);
  assert.equal(parseBotCommand(encoded, "generation-2"), null);
  assert.equal(parseBotCommand(encodeBotBridgeMessage("generation-1", { ...rename, chatId: "" }), "generation-1"), null);
  assert.equal(parseBotCommand(encodeBotBridgeMessage("generation-1", { ...rename, botId: "" }), "generation-1"), null);
  assert.equal(parseBotCommand(encodeBotBridgeMessage("generation-1", { ...rename, title: " " }), "generation-1"), null);
  assert.equal(parseBotCommand(encodeBotBridgeMessage("generation-1", { ...rename, title: "a".repeat(257) }), "generation-1"), null);
});

test("content touch ownership is boolean and belongs to this runtime", () => {
  const payload = { type: "bot-touch-ownership" as const, owned: true };
  const wire = encodeBotBridgeMessage("runtime-1", payload);
  assert.deepEqual(parseBotToHostMessage(wire, "runtime-1"), payload);
  assert.equal(parseBotToHostMessage(wire, "runtime-2"), null);
  assert.equal(parseBotToHostMessage(wire.replace('"owned":true', '"owned":"true"'), "runtime-1"), null);
});


test("large console projections fit the envelope and stop advertising more at capacity", () => {
  const state = boundBotConsoleState({ type: "bot-console-state", botId: "bot-1", section: "chat", groups: [],
    sessions: Array.from({length:1000}, (_, index) => ({chatId: `${index}` + "x".repeat(1000), title: "a".repeat(256), pinned: false, unread: false})),
    selectedChatId: null, loading:false, hasMore:true, commandsReady:true, pinSupported:true, pending:false, error:false });
  assert.ok(state.sessions.length > 0 && state.sessions.length < 1000);
  assert.equal(state.hasMore, false);
  assert.equal(parseBotToHostMessage(encodeBotBridgeMessage("generation-1", state), "generation-1")?.type, "bot-console-state");
});

test("panel gesture and presentation ports are generation scoped and reject impossible samples", () => {
  const input = { type: "chat-panel-gesture", ownerId: "thread-a", gesture: { id: 2, phase: "move", translationX: -90, velocityX: -240 } };
  assert.deepEqual(parseBotCommand(encodeBotBridgeMessage("runtime-1", input), "runtime-1"), input);
  assert.equal(parseBotCommand(encodeBotBridgeMessage("runtime-1", input), "runtime-2"), null);
  assert.equal(parseBotCommand(encodeBotBridgeMessage("runtime-1", { ...input, gesture: { ...input.gesture, phase: "execute" } }), "runtime-1"), null);
  const output = { type: "chat-panel-presentation", ownerId: "thread-a", active: true };
  assert.deepEqual(parseBotToHostMessage(encodeBotBridgeMessage("runtime-1", output), "runtime-1"), output);
  assert.equal(parseBotToHostMessage(encodeBotBridgeMessage("runtime-1", { ...output, active: "true" }), "runtime-1"), null);
});
