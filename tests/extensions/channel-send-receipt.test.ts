import assert from "node:assert/strict";
import test from "node:test";
import { ChannelsClient, type ChannelRpc } from "../../plugins/im/src/channel-client";
import { ImHttpError } from "../../plugins/im/src/client";

const receipt = {
  sequence: 1,
  messageId: "native-message",
  author: "Human",
  text: "",
  at: 1,
  status: "sending" as const,
};
const failure = new Error("connection lost");
test("a cancelled channel wait never sends after a shared reconnect completes", async () => {
  let connected!: () => void,
    writes = 0;
  const rpc = {
    connect: () =>
      new Promise<void>((resolve) => {
        connected = resolve;
      }),
    async request() {
      writes++;
      return { receipt };
    },
  } as unknown as ChannelRpc;
  const client = new ChannelsClient(fetch, rpc),
    owner = new AbortController();
  const result = client.sendText("group:one", "original", "hello", owner.signal);
  owner.abort();
  await assert.rejects(result);
  connected();
  await Promise.resolve();
  assert.equal(writes, 0);
});
function fixture(
  options: { receipt?: typeof receipt | null; error?: Error; lookupError?: Error; abort?: AbortController } = {},
) {
  const methods: string[] = [];
  let writes = 0;
  const write = () => {
    writes++;
    options.abort?.abort();
    throw options.error ?? failure;
  };
  const rpc = {
    async connect() {},
    async request(method: string, params: { channelId: string; clientMessageId: string }) {
      methods.push(method);
      assert.equal(params.channelId, "group:one");
      assert.equal(params.clientMessageId, "original");
      if (method === "opencraft/channels/messages/send") return write();
      assert.equal(method, "opencraft/channels/delivery/get");
      if (options.lookupError) throw options.lookupError;
      return { receipt: options.receipt === undefined ? receipt : options.receipt };
    },
  } as unknown as ChannelRpc;
  return { client: new ChannelsClient(async () => write(), rpc), methods, writes: () => writes };
}

for (const kind of ["text", "image"] as const) {
  const send = (f: ReturnType<typeof fixture>, signal = new AbortController().signal) =>
    kind === "text"
      ? f.client.sendText("group:one", "original", "hello", signal)
      : f.client.sendChannelImage(
          "group:one",
          "original",
          new File(["bytes"], "photo.png", { type: "image/png" }),
          signal,
        );
  test(`${kind}: lost ACK resolves by the existing receipt without replaying the write`, async () => {
    const f = fixture();
    assert.equal((await send(f)).receipt, receipt);
    assert.equal(f.writes(), 1);
    assert.equal(f.methods.at(-1), "opencraft/channels/delivery/get");
  });
  test(`${kind}: missing/unavailable receipt preserves the original failure`, async () => {
    for (const options of [{ receipt: null }, { lookupError: new Error("lookup offline") }]) {
      const f = fixture(options);
      await assert.rejects(send(f), (error) => error === failure);
      assert.equal(f.writes(), 1);
    }
  });
  test(`${kind}: revoked owner and explicit denial cannot be reconciled into success`, async () => {
    const denied = fixture({ error: new ImHttpError("channel_denied", 403) });
    await assert.rejects(send(denied), /channel_denied/);
    assert(!denied.methods.includes("opencraft/channels/delivery/get"));
    const owner = new AbortController(),
      aborted = fixture({ abort: owner });
    await assert.rejects(send(aborted, owner.signal));
    assert(!aborted.methods.includes("opencraft/channels/delivery/get"));
  });
}

test("markRead and assistantStatus retire cancelled waits without closing shared connection", async () => {
  for (const operation of ["markRead", "assistantStatus"] as const) {
    let release!: () => void,
      writes = 0;
    const shared = new Promise<void>((r) => (release = r));
    const rpc = {
      connect: () => shared,
      supportsRead: true,
      request: async () => {
        writes++;
      },
    } as unknown as ChannelRpc;
    const client = new ChannelsClient(fetch, rpc),
      owner = new AbortController();
    const result =
      operation === "markRead" ? client.markRead("group:one", 1, owner.signal) : client.assistantStatus(owner.signal);
    owner.abort();
    await assert.rejects(result);
    assert.equal(writes, 0);
    release();
    await shared;
  }
});
test("a declared idempotency conflict cannot be converted to an old successful receipt", async () => {
  const f = fixture({ error: Object.assign(Error("idempotency_conflict"), { code: -32009 }) });
  await assert.rejects(
    f.client.sendText("group:one", "original", "different", new AbortController().signal),
    /idempotency_conflict/,
  );
  assert.deepEqual(f.methods, ["opencraft/channels/messages/send"]);
});
test("channel file transfer uses bounded frames and exact chunk replay after a lost acknowledgement", async () => {
  const offsets: number[] = [],
    lengths: number[] = [];
  let failed = false;
  const rpc = {
    supportsAttachmentChunks: true,
    connect: async () => {},
    request: async (method: string, p: any) => {
      assert.equal(method, "opencraft/channels/attachments/upload");
      offsets.push(p.offset);
      const size = atob(p.base64).length;
      lengths.push(size);
      if (p.offset === 65536 && !failed) {
        failed = true;
        throw Object.assign(Error("lost ACK"), { code: "TIMEOUT" });
      }
      const nextOffset = p.offset + size;
      return { nextOffset, ...(nextOffset === p.total ? { receipt } : {}) };
    },
  } as unknown as ChannelRpc;
  const client = new ChannelsClient(fetch, rpc);
  assert.equal(
    (
      await client.sendChannelAttachment(
        "group:one",
        "file",
        new File([new Uint8Array(150000)], "x"),
        new AbortController().signal,
      )
    ).receipt,
    receipt,
  );
  assert.deepEqual(offsets, [0, 65536, 65536, 131072]);
  assert.ok(lengths.every((n) => n <= 65536));
});
