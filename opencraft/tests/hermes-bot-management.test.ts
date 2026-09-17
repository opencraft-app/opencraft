import assert from "node:assert/strict";
import test from "node:test";
import { HermesInstanceBotManagement } from "../plugins/lightvela-hermes/src/hermes-appserver-bridge/instance-bot-management";
import { parseInstanceProfileBots } from "../plugins/lightvela-hermes/src/hermes-appserver-bridge/instance-profile-bots";
import { HermesBotAppServerHandler } from "../plugins/lightvela-hermes/src/hermes-appserver-bridge/bot-protocol-handler";
import type { HermesAppServerAdapter } from "../plugins/lightvela-hermes/src/hermes-appserver-bridge/adapter";

export function managementFixture() {
  const rows = [{ bot_id: "instance", instance_id: "instance", profile_id: "main", name: "主 Bot", status: "ready" }];
  const calls: Array<{ path: string; method: string; body?: any }> = [];
  let sequence = 0;
  let writeError: Error | null = null;
  const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const method = init?.method ?? "GET", body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ path, method, body });
    if (method === "GET") return { items: rows.map(row => ({ ...row })) } as T;
    if (writeError) throw writeError;
    if (method === "POST") {
      const row = { bot_id: `profile-${++sequence}`, instance_id: "instance", profile_id: `profile-${sequence}`, name: body.name, status: "ready" };
      rows.push(row); return row as T;
    }
    const id = decodeURIComponent(path.split("/").at(-1)!);
    const row = rows.find(row => row.bot_id === id)!;
    if (method === "PUT") { row.name = body.name; return { ...row } as T; }
    if (method === "DELETE") { rows.splice(rows.indexOf(row), 1); return row as T; }
    throw new Error("Unexpected request");
  };
  const management = new HermesInstanceBotManagement("instance", request);
  const adapter = { async listProfiles() { return rows.map(row => ({ name: row.profile_id === "main" ? "default" : row.profile_id })); } } as HermesAppServerAdapter;
  const events: any[] = [];
  const handler = new HermesBotAppServerHandler(adapter, event => events.push(event), {
    resolveProfileBots: async () => parseInstanceProfileBots({ items: rows }, "instance"), management,
  });
  return { management, handler, adapter, rows, calls, events, failWrites(error: Error) { writeError = error; } };
}

test("managed Bot create/clone/rename/delete use control-plane identities and monotonic revisions", async () => {
  const { handler, calls, rows, events } = managementFixture();
  await handler.prepareCapability(); assert.equal(handler.botManagement, true);
  const root = (await handler.handle("bot/read", { botId: "instance" }) as any).bot;
  assert.deepEqual(root.management, { rename: true, clone: true, delete: false });
  const params = { clientRequestId: "one", name: "中文名字" };
  const [first, duplicate] = await Promise.all([handler.handle("bot/create", params), handler.handle("bot/create", params)]) as any[];
  assert.equal(first.bot.botId, duplicate.bot.botId);
  assert.equal(calls.filter(call => call.method === "POST").length, 1);
  assert.deepEqual(calls.find(call => call.method === "POST")?.body, { name: "中文名字", create_mode: "blank" });
  const cloned = await handler.handle("bot/create", { clientRequestId: "two", name: "副本", templateId: "instance" }) as any;
  assert.deepEqual(calls.filter(call => call.method === "POST")[1]?.body, { name: "副本", create_mode: "clone", source_bot_id: "instance" });
  const renamed = await handler.handle("bot/update", { botId: cloned.bot.botId, expectedRevision: cloned.bot.revision, patch: { name: "改名" } }) as any;
  assert.equal(renamed.bot.botId, cloned.bot.botId);
  assert.ok(renamed.bot.revision > cloned.bot.revision);
  await assert.rejects(handler.handle("bot/delete", { botId: renamed.bot.botId, expectedRevision: cloned.bot.revision }), /发生变化/);
  await assert.rejects(handler.handle("bot/delete", { botId: root.botId, expectedRevision: root.revision }), /默认 Bot/);
  await handler.handle("bot/delete", { botId: renamed.bot.botId, expectedRevision: renamed.bot.revision });
  assert.equal(rows.some(row => row.bot_id === renamed.bot.botId), false);
  assert.ok(events.some(event => event.method === "bot/deleted" && event.params.botId === renamed.bot.botId));
});

test("unknown creation result is never retried by a duplicate command, including after bridge replacement", async () => {
  const { management, failWrites, calls } = managementFixture();
  failWrites(new Error("network disconnected"));
  const command = { clientRequestId: "uncertain", name: "New Bot" };
  await assert.rejects(management.create(command), /结果尚未确认/);
  await assert.rejects(management.create(command), /结果尚未确认/);
  assert.equal(calls.filter(call => call.method === "POST").length, 1);
  await assert.rejects(management.create({ ...command, name: "Different" }), /已用于其他内容/);
});

test("failed clone exposes only a safe upstream status and code without retrying", async () => {
  const { management, failWrites, calls } = managementFixture();
  failWrites(Object.assign(new Error("private server details"), {
    status: 500, code: "INSTANCE_BOT_PROFILE_FAILED",
  }));
  const command = { clientRequestId: "failed-clone", name: "主 Bot 副本", templateId: "instance" };
  await assert.rejects(management.create(command), error => {
    assert.match((error as Error).message, /HTTP 500 · INSTANCE_BOT_PROFILE_FAILED/u);
    assert.doesNotMatch((error as Error).message, /private server details/u);
    return true;
  });
  await assert.rejects(management.create(command), /结果尚未确认/u);
  assert.equal(calls.filter(call => call.method === "POST").length, 1);
});

test("invalid name and missing clone source are rejected before control-plane writes", async () => {
  const { management, calls } = managementFixture();
  assert.throws(() => management.create({ clientRequestId: "x", name: " ".repeat(2) }), /1–60/);
  await assert.rejects(management.create({ clientRequestId: "y", name: "Copy", templateId: "foreign-instance-bot" }), /不存在/);
  assert.equal(calls.some(call => call.method === "POST"), false);
});

test("an older in-flight catalog finishes before mutation publication", async () => {
  const { handler, adapter, calls } = managementFixture();
  await handler.prepareCapability();
  const readProfiles = adapter.listProfiles.bind(adapter);
  let finish: (() => void) | undefined;
  adapter.listProfiles = async () => {
    const profiles = await readProfiles();
    await new Promise<void>(resolve => { finish = resolve; });
    return profiles;
  };
  const listing = handler.handle("bot/list", {});
  await new Promise(resolve => setImmediate(resolve));
  const creation = handler.handle("bot/create", { clientRequestId: "after-read", name: "Fresh" }) as Promise<any>;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.some(call => call.method === "POST"), false);
  finish!();
  await listing;
  const created = await creation;
  const selected = await handler.handle("bot/read", { botId: created.bot.botId }) as any;
  assert.equal(selected.bot.name, "Fresh");
});
