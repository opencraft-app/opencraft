import assert from "node:assert/strict";
import test from "node:test";
import { WebSocket } from "ws";
import { JsonRpcAppServerClient } from "@opencraft/appserver-client";
import { WebSocketTransport } from "@opencraft/appserver-transport-websocket";
import { startEngineHost } from "../../apps/local-agent-host/src/engine-host.js";
import { projectComposerModelChoices } from "../../packages/workbench-runtime/src/composer-model-catalog.js";

test("server assigns Agent identity independently of provider grouping and preserves connected identity", async t => {
  const raw = { id: "same", model: "same", displayName: "Same model", description: "", hidden: false,
    supportedReasoningEfforts: [], defaultReasoningEffort: null, inputModalities: ["text"],
    supportsPersonality: false, additionalSpeedTiers: [], isDefault: true, groupKey: "vendor", groupLabel: "Vendor" };
  const provider = (id: string, label: string, models: unknown[]) => ({
    id, label, threadPrefix: `${id}_`, modelPrefix: `${id}:`, ownsThread: () => false, ownsModel: () => false,
    subscribe: () => () => {}, disconnect() {}, async close() {},
    async request(method: string) {
      if (method === "model/list") return { data: models, nextCursor: null };
      return {};
    },
  });
  const host = await startEngineHost({ defaultEngine: "pi", providers: [
    provider("pi", "Pi", [raw]),
    provider("acp", "ACP", [{ ...raw, id: "acp:same", model: "acp:same" }, { ...raw, id: "claude-code:same", model: "claude-code:same", agentId: "claude-code", agentLabel: "Claude" }]),
  ] as never });
  const client = new JsonRpcAppServerClient({ hostId: "fixture", transport: new WebSocketTransport({ url: host.websocketUrl, createSocket: url => new WebSocket(url) as never }) });
  t.after(async () => { await client.close(); await host.close(); });
  await client.connect({ clientInfo: { name: "test", version: "1" } });
  const page = await client.request("model/list", {});
  const choices = projectComposerModelChoices(page.data);
  assert.deepEqual(choices.map(model => [model.value, model.agentId, model.agentLabel]), [
    ["same", "pi", "Pi"], ["acp:same", "acp", "ACP"], ["claude-code:same", "claude-code", "Claude"],
  ]);
  assert.equal(choices[0]?.groupLabel, "Vendor", "model vendor grouping cannot replace execution Agent identity");
});
