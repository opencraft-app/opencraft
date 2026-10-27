import assert from "node:assert/strict";
import test from "node:test";
import type { AppServerBotDirectoryHost } from "@opencraft/bot-conversation-appserver";
import type { HostConnectionProfile } from "@opencraft/workbench-runtime";
import { connectBotManagementHost, resolveBotManagementHost } from "../../apps/workbench-web/src/runtime/bot-management-host";

const profile = (hostId: string, providerId: string, enabled = true) => ({
  hostId, providerId, enabled,
}) as HostConnectionProfile;
const state = (hostId: string, canManageBots: boolean) => ({ hostId, canManageBots, phase: "ready" }) as AppServerBotDirectoryHost;

test("Bot management resolves any enabled provider, preferring a unique management-capable Host", () => {
  const profiles = [profile("a", "engine.alpha"), profile("b", "engine.beta"), profile("disabled", "engine.beta", false)];
  assert.equal(resolveBotManagementHost(profiles, []), null);
  assert.equal(resolveBotManagementHost(profiles, [state("b", true), state("disabled", true)]), "b");
  assert.equal(resolveBotManagementHost(profiles, [state("a", true), state("b", true)]), null);
  assert.equal(resolveBotManagementHost([profiles[0]!, profiles[2]!], []), "a");
  assert.equal(resolveBotManagementHost([profiles[2]!], [state("disabled", true)]), null);
  assert.equal(resolveBotManagementHost([], [state("unknown", true)]), null);
});

test("Bot management releases its busy state when a physical Host connection does not settle", async () => {
  await assert.rejects(
    connectBotManagementHost(new Promise<void>(() => undefined), 5, () => "正在建立 Agent 连接…"),
    /加载 Bots 超时：正在建立 Agent 连接.*后台/u,
  );
});

test("Bot management clears its deadline when connection settles", async () => {
  await connectBotManagementHost(Promise.resolve(), 5);
  await assert.rejects(connectBotManagementHost(Promise.reject(new Error("connection failed")), 5), /connection failed/u);
});

import { resolveBotManagementPolicy } from "@opencraft/client-product";
import { eligibleBotManagementProfiles } from "../../apps/workbench-web/src/runtime/bot-management-host";

test("product policy filters candidates before capability selection; explicit empty policy does not fall back", () => {
  const profiles = [profile("a", "provider.a"), profile("b", "provider.b"), profile("off", "provider.a", false)];
  assert.deepEqual(eligibleBotManagementProfiles(profiles, resolveBotManagementPolicy()).map(p => p.hostId), ["a", "b"]);
  const eligible = eligibleBotManagementProfiles(profiles, resolveBotManagementPolicy({ providerIds: ["provider.a"] }));
  assert.equal(resolveBotManagementHost(eligible, [state("b", true)]), "a");
  assert.deepEqual(eligibleBotManagementProfiles(profiles, resolveBotManagementPolicy({ providerIds: [] })), []);
});

test("trusted product input is validated and snapshotted, without retaining mutable arrays or copy", () => {
  const providerIds = ["provider.a"];
  const messages = { noHosts: "Product entry" };
  const policy = resolveBotManagementPolicy({ providerIds, messages });
  providerIds.push("provider.b"); messages.noHosts = "Changed";
  assert.deepEqual(policy.providerIds, ["provider.a"]);
  assert.equal(policy.messages.noHosts, "Product entry");
  assert.ok(policy.messages.ambiguousHosts);
  assert.ok(Object.isFrozen(policy) && Object.isFrozen(policy.providerIds) && Object.isFrozen(policy.messages));
  for (const ids of [[""], [" bad "], ["a", "a"], [1], null]) {
    assert.throws(() => resolveBotManagementPolicy({ providerIds: ids as unknown as string[] }));
  }
  assert.throws(() => resolveBotManagementPolicy({ messages: { noHosts: "  " } }));
});
