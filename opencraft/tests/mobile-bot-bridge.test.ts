import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { BOT_COMMAND_CAPABILITIES, botCommandScript, encodeBotBridgeMessage, parseBotCommand, parseBotToHostMessage } from "../packages/mobile-bot-bridge/src/index";

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
  assert.deepEqual(BOT_COMMAND_CAPABILITIES, ["select", "refresh", "create", "delete", "link"]);
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
