import assert from "node:assert/strict";
import test from "node:test";
import type { AppServerBotDirectoryHost } from "@opencraft/bot-conversation-appserver";
import type { HostConnectionProfile } from "@opencraft/workbench-runtime";
import { connectCloudHermesBotHost, resolveCloudHermesBotHost } from "../apps/workbench-web/src/runtime/bot-management-host";

const profile = (hostId: string, providerId: string, enabled = true) => ({
  hostId, providerId, enabled,
}) as HostConnectionProfile;
const state = (hostId: string, canManageBots: boolean) => ({ hostId, canManageBots, phase: "ready" }) as AppServerBotDirectoryHost;

test("Bot management ignores local and other providers and resolves the sole cloud Hermes Host", () => {
  assert.equal(resolveCloudHermesBotHost([
    profile("local", "local.agent"),
    profile("dsh", "builtin.agents"),
    profile("cloud", "lightvela.hermes"),
  ], [state("local", true), state("cloud", false)]), "cloud");
});

test("Bot management never invents an instance choice when multiple cloud Hermes Hosts are ambiguous", () => {
  const profiles = [profile("cloud-a", "lightvela.hermes"), profile("cloud-b", "lightvela.hermes")];
  assert.equal(resolveCloudHermesBotHost(profiles, []), null);
  assert.equal(resolveCloudHermesBotHost(profiles, [state("cloud-b", true)]), "cloud-b");
});

test("Bot management releases its busy state when a physical Host connection does not settle", async () => {
  await assert.rejects(
    connectCloudHermesBotHost(new Promise<void>(() => undefined), 5, () => "正在建立 Hermes AppServer 连接…"),
    /加载 Bots 超时：正在建立 Hermes AppServer 连接.*后台/u,
  );
});

test("Bot management clears its deadline when connection settles", async () => {
  await connectCloudHermesBotHost(Promise.resolve(), 5);
  await assert.rejects(connectCloudHermesBotHost(Promise.reject(new Error("connection failed")), 5), /connection failed/u);
});
