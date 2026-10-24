import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SwitchboardStore } from "../../plugins/im/src/store.js";
import { ImPlugin, type ImExecutionPort } from "../../plugins/im/src/server.js";
import { IM_READ_TOOLS } from "../../plugins/im/src/read-tools.js";
import { SessionCapabilities } from "../../packages/session-capabilities/src/index.js";
import { SessionCapabilityMcp } from "../../packages/session-capabilities/src/mcp.js";
import { ImChannelService } from "../../scripts/im-channel-service.mjs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const ref = { serverId: "server", threadId: "thread" };
const signal = () => new AbortController().signal;
async function fixture(t: test.TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "im-read-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new SwitchboardStore(join(dir, "im.sqlite"));
  let current = true, target = ref, sends = 0;
  const execution: ImExecutionPort = {
    human: actorId => ({ actorId, generation: 1, credentialId: null, expiresAt: Number.MAX_SAFE_INTEGER }),
    authorize() { if (!current) throw Error("denied"); },
    async create() { return target; }, async validate() {}, async submit() { return "request"; },
    async result() { throw Error("unexpected inference"); },
  };
  const im = new ImPlugin(store, execution, 1024, true);
  const unregister = im.register({ id: "bot", ownerId: "owner", senders: { sender: "human", other: "other-human" }, groupScope: "sender" });
  im.register({ id: "other-bot", ownerId: "owner", senders: { sender: "human" }, groupScope: "sender" });
  t.after(() => im.close());
  let seq = 0;
  async function receive(text: string, chatId = "wecom-channel:post", senderId = "sender", bot = "bot") {
    const id = "arrival-" + ++seq;
    await im.receive(bot, { id, source: { chatId, chatType: "group", senderId }, text,
      replyAddress: { token: "private-address", expiresAt: Date.now() + 60000 }, async reply() { sends++; } });
    const m = store.messages(bot, 500).find(m => m.text === text && JSON.parse(m.source).senderId === senderId)!;
    assert.ok(m?.reply_ref); return m;
  }
  return { im, store, receive, target: (value: typeof ref) => { target = value; }, revoke: () => { current = false; }, unregister, sends: () => sends };
}

test("context and literal search constrain bot, actor and canonical conversation before returning data", async t => {
  const f = await fixture(t);
  const anchor = await f.receive("发布 NEEDLE %_ 一");
  await f.receive("发布 needle 二", "wecom-channel:another-post");
  await f.receive("private needle sender", "wecom-channel:post", "other");
  await f.receive("private needle bot", "wecom-channel:post", "sender", "other-bot");
  f.target({ ...ref, threadId: "secret-thread" });
  await f.receive("private needle thread", "wecom-channel:third-post");
  const context = await f.im.read(ref, "im_read_context", { replyRef: anchor.reply_ref }, signal());
  assert.deepEqual(context.messages.map(m => m.content.text), [anchor.text]);
  const found = await f.im.read(ref, "im_search_messages", { replyRef: anchor.reply_ref, query: "needle" }, signal());
  assert.equal(found.messages.length, 2);
  assert.ok(found.messages.every(m => !m.content.text.startsWith("private")));
  assert.equal(found.coverage.kind, "received_only"); assert.equal(found.coverage.platformHistory, false);
  assert.equal(found.coverage.retentionDays, 7); assert.equal(found.coverage.globalTerminalRecordLimit, 10000);
  assert.equal((await f.im.read(ref, "im_search_messages", { replyRef: anchor.reply_ref, query: "%_" }, signal())).messages.length, 1);
  const empty = await f.im.read(ref, "im_search_messages", { replyRef: anchor.reply_ref, query: "' OR 1=1 --" }, signal());
  assert.deepEqual(empty.messages, []); assert.match(empty.coverage.warning, /do not prove absence/);
  assert.doesNotMatch(JSON.stringify(found), /private-address|reply_address|replyRef|senderId|fingerprint/);
  await assert.rejects(f.im.read({ ...ref, threadId: "other" }, "im_read_context", { replyRef: anchor.reply_ref }, signal()), /denied/);
  await assert.rejects(f.im.read({ ...ref, serverId: "other" }, "im_read_context", { replyRef: anchor.reply_ref }, signal()), /denied/);
});

test("equal-timestamp pagination is stable, time bounds are inclusive and Unicode excerpts are bounded", async t => {
  const f = await fixture(t), time = Date.now() - 1000;
  const rows = [];
  for (let i = 0; i < 5; i++) rows.push(await f.receive("同一秒 " + i + " 中".repeat(1200)));
  const db = (f.store as any).managed.database;
  db.prepare("UPDATE im_messages SET created_at=?").run(time);
  let cursor: string | undefined, ids: string[] = [];
  do {
    const page = await f.im.read(ref, "im_read_context", { replyRef: rows[0].reply_ref, limit: 2, ...(cursor ? { cursor } : {}), from: time, until: time }, signal());
    assert.ok(page.messages.every(m => Buffer.byteLength(m.content.text) <= 1024 && m.content.truncated));
    assert.ok(page.messages.every(m => !m.content.text.includes("\ufffd")));
    ids.push(...page.messages.map(m => m.messageId)); cursor = page.nextCursor ?? undefined;
  } while (cursor);
  assert.equal(ids.length, 5); assert.equal(new Set(ids).size, 5);
  assert.deepEqual(ids, rows.map(m => m.id).sort().reverse());
  assert.deepEqual((await f.im.read(ref, "im_read_context", { replyRef: rows[0].reply_ref, until: time - 1 }, signal())).messages, []);
});

test("retained expired replies remain readable without changing delivery state; revocation and input limits fail closed", async t => {
  const f = await fixture(t), m = await f.receive("已收到");
  f.store.patch(m.id, { state: "reply_failed", error: "reply_expired", reply_expires_at: Date.now() - 1 });
  const before = f.store.message(m.id);
  await f.im.read(ref, "im_read_context", { replyRef: m.reply_ref }, signal());
  assert.deepEqual(f.store.message(m.id), before); assert.equal(f.sends(), 0);
  for (const args of [{ limit: 21 }, { limit: 0 }, { cursor: "garbage" }, { cursor: "" }, { from: -1 }, { from: 2, until: 1 }, { topicId: "foreign" }, { actorId: "foreign" }, { conversation: ref }, { query: "extra" }])
    await assert.rejects(f.im.read(ref, "im_read_context", { replyRef: m.reply_ref, ...args }, signal()), /invalid_message/);
  for (const query of ["", " ", "x".repeat(257), 42])
    await assert.rejects(f.im.read(ref, "im_search_messages", { replyRef: m.reply_ref, query }, signal()), /invalid_message/);
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(f.im.read(ref, "im_read_context", { replyRef: m.reply_ref }, aborted.signal), /abort/i);
  f.store.linkSender("bot", "sender", "different-human");
  assert.equal(f.im.readAvailable(ref), false);
  await assert.rejects(f.im.read(ref, "im_read_context", { replyRef: m.reply_ref }, signal()), /denied/);
  f.store.unlinkSender("bot", "sender"); f.revoke();
  await assert.rejects(f.im.read(ref, "im_read_context", { replyRef: m.reply_ref }, signal()), /denied/);
});

test("seven-day read boundary and endpoint withdrawal apply even when the caller kept its anchor", async t => {
  const f = await fixture(t), old = await f.receive("old"), fresh = await f.receive("fresh");
  (f.store as any).managed.database.prepare("UPDATE im_messages SET created_at=? WHERE id=?").run(Date.now() - 8 * 86400000, old.id);
  await assert.rejects(f.im.read(ref, "im_read_context", { replyRef: old.reply_ref }, signal()), /denied/);
  assert.deepEqual((await f.im.read(ref, "im_read_context", { replyRef: fresh.reply_ref }, signal())).messages.map(m => m.content.text), ["fresh"]);
  f.unregister(); assert.equal(f.im.readAvailable(ref), false);
  await assert.rejects(f.im.read(ref, "im_read_context", { replyRef: fresh.reply_ref }, signal()), /denied/);
});

test("production Headless provider exposes read tools through signed MCP with exact per-tool preauthorization", async t => {
  const dir = await mkdtemp(join(tmpdir(), "im-read-mcp-")); t.after(() => rm(dir, { recursive: true, force: true }));
  let valid = true;
  const human = { actorId: "human", enabled: true, kind: "human", generation: 1 };
  const caps = new SessionCapabilities();
  const service = new ImChannelService({ dataDirectory: dir, capabilities: caps,
    credentials: {}, actors: { get: () => human, isCurrent: () => valid },
    collaboration: { execution: { serverId: "server", hostId: "host" }, conversationAllowed: () => valid }, getAppHost: () => null });
  t.after(() => service.close());
  service.im.register({ id: "bot", ownerId: "human", senders: { sender: "human" }, groupScope: "sender" });
  service.store.accept({ id: "a".repeat(64), channel_id: "bot", fingerprint: "f", actor_id: "human", source: JSON.stringify({ chatId: "wecom-channel:post", chatType: "group", senderId: "sender" }), text: "known history", route_revision: 1, decision: null, reply_address: null });
  service.store.patch("a".repeat(64), { conversation_ref: JSON.stringify(ref), state: "delivered", reply_mode: "tool", reply_ref: "opaque-anchor", reply_expires_at: Date.now() + 1000 });
  const mcp = new SessionCapabilityMcp(caps, randomBytes(32)); await mcp.listen(); t.after(() => mcp.close());
  const config = mcp.config(ref) as any;
  assert.deepEqual(Object.keys(config.tools).sort(), ["im_read_context", "im_reply", "im_search_messages"]);
  assert.ok(IM_READ_TOOLS.every(tool => config.tools[tool.name].approval_mode === "approve"));
  const client = new Client({ name: "im-read", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.http_headers } })); t.after(() => client.close());
  const listed = (await client.listTools()).tools;
  assert.ok(listed.some(tool => tool.name === "im_search_messages")); assert.ok(listed.every(tool => !("approval" in tool)));
  const result = await client.callTool({ name: "im_search_messages", arguments: { replyRef: "opaque-anchor", query: "history" } });
  assert.equal(result.isError, false); assert.match(JSON.stringify(result.content), /known history/);
  assert.deepEqual(caps.tools({ ...ref, threadId: "foreign" }), []);
  valid = false; assert.deepEqual((await client.listTools()).tools, []);
  assert.equal((await client.callTool({ name: "im_read_context", arguments: { replyRef: "opaque-anchor" } })).isError, true);
});
