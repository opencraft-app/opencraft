import assert from "node:assert/strict";
import test from "node:test";
import { createConversationKey } from "@opencraft/chat-core";
import { botConversationResourceUri, botSelectionResourceUri, parseBotConversationViewResource } from "../../packages/bot-conversation/src/view-resource";
import { createCordisAppServerRegistry } from "@opencraft/appserver-client";
import { MemoryTransport } from "@opencraft/appserver-transport-memory";
import { createCordisBotConversationRuntime } from "@opencraft/bot-conversation-appserver";
import { OPENCRAFT_BOT_CONVERSATIONS_EXTENSION, OPENCRAFT_BOT_CONVERSATIONS_CAPABILITY, parseJsonRpcMessage, isJsonRpcRequest, encodeJsonRpcMessage } from "@opencraft/appserver-protocol";


test("Bot resources write the current scheme and preserve exact identities in the current scheme", () => {
  const key = createConversationKey("host:/scope α", "conversation:/?&β");
  const uri = botConversationResourceUri(key);
  assert.equal(new URL(uri).protocol, "opencraft-bot:");
  assert.deepEqual(parseBotConversationViewResource(uri), { kind: "conversation", key });
  for (const botId of [undefined, null, "", " saved bot "]) {
    const selection = botSelectionResourceUri(key.hostId, botId);
    assert.equal(new URL(selection).protocol, "opencraft-bot:");
    assert.deepEqual(parseBotConversationViewResource(selection), { kind: "selection", hostId: key.hostId, botId: botId?.trim() || null });
  }
  for (const input of [null, "not a URI", "third-party-bot:selection?hostId=h", "opencraft-bot:conversation?hostId=h", "opencraft-bot:selection", "opencraft-bot:other?hostId=h"]) {
    assert.equal(parseBotConversationViewResource(input), null);
  }
});

test("real client initialization validates current Bot capabilities", async () => {
  const capability = OPENCRAFT_BOT_CONVERSATIONS_CAPABILITY;
  const cases = [
    { extensions: { [OPENCRAFT_BOT_CONVERSATIONS_EXTENSION]: capability }, supported: true },
    { extensions: { [OPENCRAFT_BOT_CONVERSATIONS_EXTENSION]: { version: 2 } }, supported: false },
    { extensions: { [OPENCRAFT_BOT_CONVERSATIONS_EXTENSION]: null }, supported: false },
    { extensions: { ["third-party/bot-conversations"]: capability }, supported: false },
    { extensions: {}, supported: false },
    { extensions: null, supported: false },
  ];
  for (const { extensions, supported } of cases) {
    const registry = await createCordisAppServerRegistry();
    const bots = await createCordisBotConversationRuntime(registry.context);
    const client = registry.clients.create({ hostId: "custom-bot-host", transport: new MemoryTransport({ server: {
      receive(frame, peer) {
        const message = parseJsonRpcMessage(frame);
        if (isJsonRpcRequest(message) && message.method === "initialize") peer.send(encodeJsonRpcMessage({ id: message.id, result: {
          userAgent: "bot-fixture", codexHome: "/synthetic/runtime", platformFamily: "unix", platformOs: "linux", capabilities: { extensions },
        } }));
      },
    } }) });
    try {
      const waiting = supported ? bots.service.waitForCapability(client.hostId) : null;
      await client.connect({ clientInfo: { name: "bot-contract-fixture", version: "1" }, capabilities: { experimentalApi: true } });
      assert.equal(bots.service.supports(client.hostId), supported);
      if (waiting) assert.deepEqual(await waiting, capability);
      else assert.equal(bots.service.capability(client.hostId), null);
    } finally { await bots.dispose(); await registry.dispose(); }
  }
});
