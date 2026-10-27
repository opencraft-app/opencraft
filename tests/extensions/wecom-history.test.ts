import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WeComHistoryApi,
  WECOM_HISTORY_TOOLS,
} from "../../plugins/wecom/src/history.js";
import { ImPostReceipts } from "../../plugins/im/src/post-receipts.js";
import { ImChannelService } from "../../scripts/im-channel-service.mjs";
import { SessionCapabilities } from "../../packages/session-capabilities/src/index.js";
import { SessionCapabilityMcp } from "../../packages/session-capabilities/src/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const ref = { serverId: "server", threadId: "thread" },
  signal = () => new AbortController().signal;
const json = (data: object) =>
  new Response(JSON.stringify({ errcode: 0, ...data }), {
    headers: { "content-type": "application/json" },
  });
test("native API signs the official SHA256 contract, coalesces and caches tokens; token rejection retries one read", async () => {
  let tokens = 0,
    reads = 0;
  const api = new WeComHistoryApi("bot-id", "secret", async (url, init) => {
    assert.equal(init?.redirect, "error");
    assert.equal(init?.method, "POST");
    const parsed = new URL(String(url));
    assert.equal(parsed.origin, "https://qyapi.weixin.qq.com");
    if (parsed.pathname.endsWith("/get_token")) {
      tokens++;
      const body = JSON.parse(String(init?.body));
      assert.equal(body.bot_id, "bot-id");
      assert.equal(
        body.signature,
        createHash("sha256")
          .update("secretbot-id" + body.time + body.nonce)
          .digest("hex"),
      );
      return json({ access_token: "token" + tokens });
    }
    reads++;
    return json({ topic_list: [], ...(reads === 3 ? { errcode: 40014 } : {}) });
  });
  await Promise.all([
    api.call("topic/get_topic_list", { type: 1 }, signal()),
    api.call("topic/get_topic_list", { type: 1 }, signal()),
  ]);
  assert.equal(tokens, 1);
  await api.call("topic/get_topic_list", { type: 1 }, signal());
  assert.equal(tokens, 2);
  assert.equal(reads, 4);
});
test("API errors redact transport/provider content, cap response size, and honor cancellation", async () => {
  for (const request of [
    async () => {
      throw Error("secret in URL");
    },
    async () => json({ errcode: 1, errmsg: "private provider body" }),
    async () => new Response("x".repeat(2 * 1024 * 1024 + 1)),
  ]) {
    const api = new WeComHistoryApi("bot", "secret", request);
    await assert.rejects(
      api.call("topic/get_topic_list", {}, signal()),
      (e) => {
        assert.doesNotMatch(String(e), /private|secret in URL/);
        return true;
      },
    );
  }
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    new WeComHistoryApi("b", "s", async () => {
      throw Error("unexpected network");
    }).call("topic/get_topic_list", {}, controller.signal),
    /abort/i,
  );
});

async function fixture(t: test.TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "wecom-history-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let valid = true,
    member = true,
    tokens = 0,
    hook: ((path: string) => void) | undefined;
  let sendResponse = async () => json({ post_id: "created-post" });
  const requests: { path: string; body: any }[] = [];
  const post = {
    post_id: "post-1",
    creator: { type: 0, userid: "other-member" },
    content: "其他成员的历史 " + "中".repeat(2000),
    create_time: 100,
    is_recalled: false,
    inline_file_list: [
      { cookie: "private-cookie", url: "https://private-attachment" },
    ],
  };
  const caps = new SessionCapabilities();
  const service = new ImChannelService({
    dataDirectory: dir,
    capabilities: caps,
    credentials: { resolve: async () => "fixture-secret" },
    actors: {
      get: () => ({
        actorId: "human",
        enabled: true,
        kind: "human",
        generation: 1,
      }),
      isCurrent: () => valid,
    },
    collaboration: {
      execution: { serverId: "server", hostId: "host" },
      conversationAllowed: () => valid,
    },
    getAppHost: () => null,
    wecomHistoryFetch: async (url, init) => {
      const path = new URL(String(url)).pathname.split("/aibot/")[1],
        body = JSON.parse(String(init?.body));
      requests.push({ path, body });
      if (path === "get_token") {
        tokens++;
        return json({ access_token: "private-token" });
      }
      let response: object;
      if (path === "topic/get_topic_list")
        response =
          body.type === 0
            ? {
                topic_list: [
                  { topic_id: body.topic_id_list[0], topic_name: "测试" },
                ],
              }
            : {
                topic_list: [
                  { topic_id: "selected", topic_name: "测试" },
                  { topic_id: "nonmember", topic_name: "hidden channel" },
                ],
                has_more: !body.cursor,
                next_cursor: "topic-page-2",
              };
      else if (path === "topic/get_topic_member_list")
        response = {
          member_list:
            member && body.topic_id !== "nonmember"
              ? [{ type: 0, userid: "sender" }]
              : [],
          has_more: false,
        };
      else if (path === "topic/get_post_list")
        response = {
          post_list: [post],
          has_more: body.type === 1 && !body.cursor,
          next_cursor: "post-page-2",
        };
      else if (path === "topic/get_reply_list")
        response = {
          reply_list: [
            { reply_id: "reply-1", content: "历史评论", is_recalled: false },
            {
              reply_id: "recalled",
              content: "removed private text",
              is_recalled: true,
            },
          ],
          has_more: false,
        };
      else if (path === "topic/search")
        response = {
          jobid: "search-job",
          topic_list: [{ topic_id: "selected" }],
          has_more: false,
        };
      else if (path === "topic/get_search_result")
        response = {
          result_list: [
            {
              post_id: "post-1",
              brief_content: "人呢",
              reply_list: Array.from({ length: 6 }, (_, i) => ({
                reply_id: "r" + i,
                brief_content: "预览",
              })),
            },
          ],
          has_more: !body.cursor,
          next_cursor: "search-page-2",
        };
      else if (path === "topic/send_post") {
        hook?.(path);
        return sendResponse();
      }
      else throw Error("unexpected endpoint");
      hook?.(path);
      return json(response);
    },
  });
  t.after(() => service.close());
  service.store.saveChannel(
    {
      id: "bot",
      provider: "wecom",
      ownerId: "human",
      name: "fixture",
      groupScope: "sender",
      botId: "fixture-bot",
    },
    true,
    null,
  );
  service.store.linkSender("bot", "sender", "human");
  const unregister = service.im.register({
    id: "bot",
    ownerId: "human",
    senders: {},
    groupScope: "sender",
  });
  service.store.accept({
    id: "a".repeat(64),
    channel_id: "bot",
    fingerprint: "f",
    actor_id: "human",
    source: JSON.stringify({
      chatId: "compat-unknown",
      chatType: "group",
      senderId: "sender",
    }),
    text: "anchor only",
    route_revision: 1,
    decision: null,
    reply_address: null,
  });
  service.store.patch("a".repeat(64), {
    conversation_ref: JSON.stringify(ref),
    state: "delivered",
    reply_mode: "tool",
    reply_ref: "opaque-anchor",
    reply_expires_at: Date.now() - 1,
  });
  const args = { replyRef: "opaque-anchor", topicId: "selected" };
  return {
    service,
    caps,
    args,
    requests,
    post,
    unregister,
    call: (name: string, values: object = {}) =>
      service.wecomHistory.call(ref, name, { ...args, ...values }, signal()),
    revoke: () => {
      valid = false;
    },
    membership: (v: boolean) => {
      member = v;
    },
    hook: (v: typeof hook) => {
      hook = v;
    },
    tokens: () => tokens,
    setSendResponse: (value: typeof sendResponse) => { sendResponse = value; },
    send: (values: object = {}) => service.wecomPosts.call(ref, { ...args, text: "独立频道帖", requestId: "intent-1", ...values }, signal()),
  };
}

test("native discovery requires no link, hides nonmember channels and never treats compatibility chatId as topicId", async (t) => {
  const f = await fixture(t);
  const result = await f.service.wecomHistory.call(
    ref,
    "wecom_list_channels",
    { replyRef: "opaque-anchor" },
    signal(),
  );
  assert.deepEqual(result.topics, [{ topicId: "selected", name: "测试" }]);
  assert.ok(result.nextCursor);
  assert.equal(result.coverage.platformHistory, true);
  assert.doesNotMatch(
    JSON.stringify(result),
    /hidden channel|private-token|private-cookie|compat-unknown/,
  );
  assert.ok(
    f.requests.filter((r) => r.path === "topic/get_topic_member_list").length >=
      3,
  );
  assert.equal(f.tokens(), 1);
});
test("native reads return earlier posts and comments with exact IDs and honest bounded coverage; store is unchanged", async (t) => {
  const f = await fixture(t),
    before = f.service.store.message("a".repeat(64));
  const result = await f.call("wecom_read_channel");
  assert.equal(result.posts[0].id, "post-1");
  assert.deepEqual(result.posts[0].author, {
    kind: "human",
    id: "other-member",
  });
  assert.match(result.posts[0].content.text, /其他成员的历史/);
  assert.ok(result.posts[0].content.truncated);
  assert.ok(Buffer.byteLength(result.posts[0].content.text) <= 4096);
  assert.doesNotMatch(result.posts[0].content.text, /\ufffd/);
  assert.equal(result.coverage.hasMore, true);
  assert.ok(!("complete" in result.coverage));
  assert.doesNotMatch(
    JSON.stringify(result),
    /private-cookie|private-attachment|fixture-secret/,
  );
  const page = await f.call("wecom_read_channel", {
    cursor: result.nextCursor,
  });
  assert.equal(page.nextCursor, null);
  const post = await f.call("wecom_read_post", { postId: "post-1" });
  assert.equal(post.replies[0].content.text, "历史评论");
  assert.equal(post.replies[1].content.text, "");
  assert.deepEqual(f.service.store.message("a".repeat(64)), before);
});
test("provider search is restricted to exactly one selected channel, carries job pagination and bounds previews", async (t) => {
  const f = await fixture(t),
    result = await f.call("wecom_search_channel", {
      query: "人呢",
      from: 1,
      until: 200,
    });
  const search = f.requests.find((r) => r.path === "topic/search")!;
  assert.deepEqual(search.body.topic_id_list, ["selected"]);
  assert.deepEqual(search.body.keyword_list, ["人呢"]);
  assert.equal(search.body.begin_time, 1);
  assert.equal(result.posts[0].replies.length, 5);
  assert.equal(result.posts[0].repliesTruncated, true);
  await f.call("wecom_search_channel", {
    query: "人呢",
    from: 1,
    until: 200,
    cursor: result.nextCursor,
  });
  assert.equal(f.requests.filter((r) => r.path === "topic/search").length, 1);
  assert.ok(
    f.requests
      .filter((r) => r.path === "topic/get_search_result")
      .every(
        (r) => r.body.topic_id === "selected" && r.body.jobid === "search-job",
      ),
  );
  await assert.rejects(
    f.call("wecom_search_channel", {
      query: "different",
      cursor: result.nextCursor,
    }),
    /invalid/,
  );
});
test("cursor tampering, injected scope, Unicode byte excess, wrong conversation and revoked sender fail closed", async (t) => {
  const f = await fixture(t),
    page = await f.call("wecom_read_channel");
  for (const values of [
    { cursor: page.nextCursor + "a" },
    { cursor: page.nextCursor, topicId: "other" },
    { limit: 21 },
    { from: 2, until: 1 },
    { actorId: "other" },
    { botId: "other" },
    { url: "https://other" },
  ])
    await assert.rejects(f.call("wecom_read_channel", values), /invalid/);
  await assert.rejects(
    f.call("wecom_search_channel", { query: "中".repeat(11) }),
    /invalid/,
  );
  await assert.rejects(
    f.service.wecomHistory.call(
      { ...ref, threadId: "foreign" },
      "wecom_read_channel",
      f.args,
      signal(),
    ),
    /denied/,
  );
  f.service.store.unlinkSender("bot", "sender");
  f.service.store.linkSender("bot", "sender", "other");
  await assert.rejects(f.call("wecom_read_channel"), /denied/);
  assert.equal(f.service.wecomHistory.available(ref), false);
});
test("membership removal and human revocation during asynchronous read prevent returning history", async (t) => {
  const f = await fixture(t);
  f.hook((path) => {
    if (path === "topic/get_post_list") f.membership(false);
  });
  await assert.rejects(f.call("wecom_read_channel"), /denied_or_invalid/);
  f.membership(true);
  f.hook((path) => {
    if (path === "topic/get_post_list") f.revoke();
  });
  await assert.rejects(f.call("wecom_read_channel"), /denied/);
});
test("production signed MCP exposes and invokes all four native read tools preauthorized, then withdraws on revocation", async (t) => {
  const f = await fixture(t),
    mcp = new SessionCapabilityMcp(f.caps, randomBytes(32));
  await mcp.listen();
  t.after(() => mcp.close());
  const session = { ...ref, execution: { inputId: "input", executionId: "execution" } };
  assert.deepEqual(f.caps.tools(session), f.caps.tools(ref));
  const config = mcp.config(session) as any;
  assert.equal(config.tools.wecom_send_post.approval_mode, "approve");
  assert.ok(
    WECOM_HISTORY_TOOLS.every(
      (tool) => config.tools[tool.name].approval_mode === "approve",
    ),
  );
  const client = new Client({ name: "native-history-test", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(config.url), {
      requestInit: { headers: config.http_headers },
    }),
  );
  t.after(() => client.close());
  const result = await client.callTool({
    name: "wecom_read_channel",
    arguments: f.args,
  });
  assert.equal(result.isError, false);
  assert.match(JSON.stringify(result.content), /provider_history/);
  const discovery = await client.callTool({
    name: "wecom_list_channels",
    arguments: { replyRef: f.args.replyRef },
  });
  assert.equal(discovery.isError, false);
  assert.match(JSON.stringify(discovery.content), /selected/);
  const posted = await client.callTool({ name: "wecom_send_post", arguments: {
    ...f.args, text: "通过正式MCP独立发帖", requestId: "signed-intent" } });
  assert.equal(posted.isError, false);
  assert.match(JSON.stringify(posted.content), /created-post/);
  assert.equal(f.requests.filter(r => r.path === "topic/send_post").length, 1);
  f.unregister();
  assert.deepEqual((await client.listTools()).tools, []);
  assert.equal(
    (
      await client.callTool({
        name: "wecom_search_channel",
        arguments: { ...f.args, query: "人呢" },
      })
    ).isError,
    true,
  );
});

test("channel configuration changes during a read invalidate both the result and old pagination", async (t) => {
  const f = await fixture(t),
    page = await f.call("wecom_read_channel");
  const change = () => {
    const c = f.service.store.channel("bot");
    f.service.store.saveChannel(
      { ...c, botId: "replacement-bot" },
      true,
      c.revision,
    );
  };
  f.hook((path) => {
    if (path === "topic/get_post_list") change();
  });
  await assert.rejects(f.call("wecom_read_channel"), /denied_or_invalid/);
  f.hook(undefined);
  await assert.rejects(
    f.call("wecom_read_channel", { cursor: page.nextCursor }),
    /denied_or_invalid/,
  );
});


test("standalone posting uses only the official endpoint and selected topic; identical retries deduplicate without consuming callback replies", async (t) => {
  const f = await fixture(t), before = f.service.store.message("a".repeat(64));
  const result = await f.send();
  assert.deepEqual(result, { status: "delivered", topicId: "selected", postId: "created-post", requestId: "intent-1", deduplicated: false });
  assert.deepEqual(f.requests.find(r => r.path === "topic/send_post")?.body, { topic_id: "selected", content: "独立频道帖" });
  assert.equal((await f.send()).deduplicated, true);
  assert.equal(f.requests.filter(r => r.path === "topic/send_post").length, 1);
  await assert.rejects(f.send({ text: "changed" }), /request_conflict/);
  await assert.rejects(f.send({ topicId: "different" }), /request_conflict/);
  assert.deepEqual(f.service.store.message("a".repeat(64)), before);
  assert.doesNotMatch(JSON.stringify(result), /private-token|fixture-secret|独立频道帖/);
});
test("post validation and current authority prevent sends after injected selectors, byte overflow, revocation, changed config and lost membership", async (t) => {
  const f = await fixture(t);
  for (const args of [{ actorId: "other" }, { url: "https://other" }, { text: "中".repeat(6827) },
    { text: "${inline_mention_all}" }, { text: " " }, { requestId: "a/b" }, { topicId: "x\n" }])
    await assert.rejects(f.send(args), /invalid/);
  f.membership(false);
  await assert.rejects(f.send(), /denied_or_invalid/);
  f.membership(true);
  f.hook(path => { if (path === "topic/get_topic_member_list") f.revoke(); });
  await assert.rejects(f.send(), /denied/);
  assert.equal(f.requests.filter(r => r.path === "topic/send_post").length, 0);
  const g = await fixture(t);
  g.hook(path => { if (path === "topic/get_topic_member_list") {
    const c = g.service.store.channel("bot");
    g.service.store.saveChannel({ ...c, botId: "replacement" }, true, c.revision);
  }});
  await assert.rejects(g.send(), /denied_or_invalid/);
  assert.equal(g.requests.filter(r => r.path === "topic/send_post").length, 0);
});
test("lost or invalid acknowledgements remain unknown, explicit rejections remain rejected, and neither is retried", async (t) => {
  for (const [response, code] of [
    [async () => { throw Error("private signed URL and token"); }, /delivery_unknown/],
    [async () => json({}), /delivery_unknown/],
    [async () => json({ errcode: 40014, errmsg: "private provider rejection" }), /delivery_rejected/],
  ] as const) {
    const f = await fixture(t);
    f.setSendResponse(response);
    await assert.rejects(f.send(), code);
    await assert.rejects(f.send(), code);
    assert.equal(f.requests.filter(r => r.path === "topic/send_post").length, 1);
  }
});
test("concurrent same-intent sends claim only one effect; permission loss after ACK preserves a delivered receipt", async (t) => {
  const f = await fixture(t);
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  f.setSendResponse(async () => { await wait; return json({ post_id: "created-post" }); });
  const first = f.send();
  while (!f.requests.some(r => r.path === "topic/send_post")) await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(f.send(), /delivery_unknown/);
  release();
  await first;
  assert.equal(f.requests.filter(r => r.path === "topic/send_post").length, 1);
  const g = await fixture(t);
  g.hook(path => { if (path === "topic/send_post") g.revoke(); });
  await assert.rejects(g.send(), /denied/);
  g.hook(undefined);
  assert.equal(g.requests.filter(r => r.path === "topic/send_post").length, 1);
});
test("post receipts survive restart; interrupted claims become unknown and cannot be re-claimed", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "im-post-receipts-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "posts.sqlite");
  let receipts = new ImPostReceipts(file);
  assert.equal(receipts.claim("scope", "done", "fingerprint"), true);
  receipts.finish("scope", "done", "delivered", "official-post");
  assert.equal(receipts.claim("scope", "interrupted", "other"), true);
  receipts.close();
  receipts = new ImPostReceipts(file);
  assert.equal(receipts.get("scope", "done")?.postId, "official-post");
  assert.equal(receipts.get("scope", "interrupted")?.state, "unknown");
  assert.equal(receipts.claim("scope", "interrupted", "other"), false);
  assert.equal(receipts.outcome.appliedVersion, 1);
  receipts.close();
  const db = new DatabaseSync(file);
  db.prepare("UPDATE schema_migrations SET checksum=? WHERE version=1").run("tampered");
  db.close();
  assert.throws(() => new ImPostReceipts(file), /history/i);
});
