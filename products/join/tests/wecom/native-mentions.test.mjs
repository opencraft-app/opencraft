import test from "node:test";
import assert from "node:assert/strict";
import {
  checkedNativeMentions,
  nativeMentionFrames,
  nativeMentionRecipients,
} from "../../plugins/wecom/native-mentions.mjs";
import { createWeComChannelTransport } from "../../plugins/wecom/channel-transport.mjs";
const source = JSON.stringify([
  "wecom-customer-service",
  "wxfixture",
  "fwfixture",
  "room",
]);
test("native actor mapping uses only one verified same-corporation identity of a current member, never display names", () => {
  const service = {
    channels: { isMember: (_c, id) => id !== "left" },
    actors: {
      bindings: (id) =>
        id === "known"
          ? [{ provider: "wecom.wxfixture", subject: "zhangsan" }]
          : id === "ambiguous"
            ? [
                { provider: "wecom.wxfixture", subject: "a1" },
                { provider: "wecom.wxfixture", subject: "a2" },
              ]
            : [{ provider: "wecom.other", subject: "guessed" }],
    },
  };
  const inputs = ["known", "left", "ambiguous", "unmapped"].map(
    (actorId, i) => ({ actorId, start: i * 4, end: i * 4 + 3 }),
  );
  assert.deepEqual(
    nativeMentionRecipients(service, null, { source, channel_id: "g" }, inputs),
    [{ start: 0, end: 3, recipient: "zhangsan" }],
  );
});
test("rich frames retain emoji/text, replace only selected spans, bound bytes/parts and cannot @all", () => {
  const text = "😀 @同事 x @手打 " + "中".repeat(4000),
    m = checkedNativeMentions(text, [
      { start: 3, end: 6, recipient: "zhangsan" },
    ]),
    frames = nativeMentionFrames(text, m, "OpenCraft · Alice\n");
  assert.ok(frames.length > 1);
  assert.equal(frames.flat().filter((p) => p.type === "mentioned").length, 1);
  assert.ok(
    frames.every(
      (f) =>
        f.length <= 30 &&
        f
          .filter((p) => p.type === "text")
          .reduce((n, p) => n + Buffer.byteLength(p.text.content), 0) < 5000,
    ),
  );
  const pieces = frames
    .flatMap((f) => f.slice(1))
    .map((p) => (p.type === "text" ? p.text.content : "@同事"))
    .join("");
  assert.equal(pieces, text);
  for (const value of [
    [{ start: 3, end: 6, recipient: "all" }],
    [{ start: 0, end: 6, recipient: "valid" }],
    [{ start: 3, end: 99, recipient: "valid" }],
  ])
    assert.throws(() => checkedNativeMentions(text.slice(0, 20), value));
});
function transport({ members = ["zhangsan"], statuses = [] } = {}) {
  const calls = [];
  const t = createWeComChannelTransport({
    corpId: "wxfixture",
    corpSecret: "synthetic",
    serviceId: "fwfixture",
    token: "fixture",
    aesKey: "a".repeat(43),
    relayIngress: true,
    fetcher: async (url, o) => {
      if (String(url).includes("/gettoken"))
        return Response.json({
          errcode: 0,
          access_token: "synthetic",
          expires_in: 7200,
        });
      if (String(url).includes("/chat/get"))
        return Response.json({ errcode: 0, chat_info: { userlist: members } });
      if (String(url).includes("/chat/send")) {
        calls.push(JSON.parse(o.body));
        const value = statuses.shift();
        if (value === "unknown") throw Error("timeout");
        return Response.json({ errcode: value === "rejected" ? 1 : 0 });
      }
      throw Error("unexpected request");
    },
  });
  return { t, calls };
}
test("real provider send uses one rich_text message with a mentioned node, no trailing canned ping", async () => {
  const { t, calls } = transport();
  assert.equal(
    await t.send(
      {
        source,
        requestId: "one",
        author: "Alice",
        serverId: "server-01",
        text: "Hi @Bob",
        mentions: [{ start: 3, end: 7, recipient: "zhangsan" }],
      },
      new AbortController().signal,
    ),
    "delivered",
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].msgtype, "rich_text");
  assert.equal(calls[0].rich_text[0].text.content, "💬 Alice · server-01\n");
  assert.deepEqual(
    calls[0].rich_text.find((p) => p.type === "mentioned").mentioned.userlist,
    ["zhangsan"],
  );
  assert.ok(!JSON.stringify(calls).includes("请看上面"));
  const denied = transport({ members: [] });
  assert.equal(
    await denied.t.send(
      {
        source,
        author: "A",
        text: "@Bob",
        mentions: [{ start: 0, end: 4, recipient: "zhangsan" }],
      },
      new AbortController().signal,
    ),
    "rejected",
  );
  assert.equal(denied.calls.length, 0);
});
test("uncertain/partial rich sends stop immediately without duplicate fallback", async () => {
  const { t, calls } = transport({ statuses: ["unknown"] });
  await assert.rejects(
    t.send(
      {
        source,
        author: "A",
        text: "@Bob",
        mentions: [{ start: 0, end: 4, recipient: "zhangsan" }],
      },
      new AbortController().signal,
    ),
    /timeout/,
  );
  assert.equal(calls.length, 1);
  const f = transport({ statuses: [undefined, "rejected"] });
  await assert.rejects(
    f.t.send(
      {
        source,
        author: "A",
        text: "@Bob" + "中".repeat(4000),
        mentions: [{ start: 0, end: 4, recipient: "zhangsan" }],
      },
      new AbortController().signal,
    ),
    /partial/,
  );
  assert.equal(f.calls.length, 2);
});

test("Relay does not flatten structured mentions into stream or Markdown replies", async () => {
  const { MirrorService } = await import(
      "../../plugins/wecom/mirror/service.mjs"
    ),
    { Readable } = await import("node:stream");
  const sent = [];
  const service = new MirrorService({
    corpId: "wxfixture",
    streamReplies: true,
    servers: [{ id: "one", name: "One", credential: "x".repeat(43) }],
    store: { snapshot: async () => ({ binding: { serverId: "one" } }) },
    transport: {
      subscribe: () => () => {},
      send: async (input) => {
        sent.push(input);
        return "delivered";
      },
      respond: async () => assert.fail("mentions cannot use plain streams"),
      sendMarkdown: async () =>
        assert.fail("mentions cannot use plain Markdown"),
    },
  });
  service.authenticate = () => service.servers.get("one");
  for (const replyTo of [undefined, "M1"]) {
    const input = {
      source,
      requestId: "native" + String(replyTo),
      serverId: "spoofed-server",
      author: "Alice的助理",
      text: "Hi @Bob",
      mentions: [{ start: 3, end: 7, recipient: "zhangsan" }],
      ...(replyTo ? { replyTo } : {}),
    };
    const res = {
      writeHead(status) {
        this.status = status;
      },
      end(body) {
        this.body = body;
      },
    };
    await service.handle(
      Object.assign(Readable.from([Buffer.from(JSON.stringify(input))]), {
        url: "/__opencraft_wecom_mirror/send",
        method: "POST",
        headers: {},
        socket: { encrypted: true },
      }),
      res,
    );
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(res.body).status, "delivered");
    assert.deepEqual(sent.at(-1), {...input, serverId: "one", serverName: "One"});
  }
  await Promise.allSettled([...service.pending]);
});
