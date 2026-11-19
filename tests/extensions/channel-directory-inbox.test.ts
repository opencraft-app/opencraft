import assert from "node:assert/strict";
import test from "node:test";
import { MemoryTransport } from "@opencraft/appserver-transport-memory";
import {
  encodeJsonRpcMessage,
  isJsonRpcRequest,
  parseJsonRpcMessage,
  CHANNELS_EXTENSION,
} from "@opencraft/appserver-protocol";
import { createChannelsRpc } from "../../apps/workbench-web/src/runtime/channels-rpc";
const flush = async () => {
  for (let i = 0; i < 8; i++) await new Promise<void>((r) => setImmediate(r));
};
async function fixture(groupLifecycle?: 1) {
  let reply: (error?: string) => void = () => {},
    reads = 0;
  const recovery = new Set<() => void>();
  const transport = new MemoryTransport({
    receive(frame, peer) {
      const req = parseJsonRpcMessage(frame);
      if (!isJsonRpcRequest(req)) return;
      const send = (result: unknown) => peer.send(encodeJsonRpcMessage({ id: req.id, result }));
      if (req.method === "initialize")
        send({
          codexHome: "/fixture",
          platformFamily: "unix",
          platformOs: "linux",
          userAgent: "test",
          capabilities: {
            extensions: {
              [CHANNELS_EXTENSION]: {
                version: 1,
                inbox: 1,
                actorId: "me",
                authority: "server",
                ...(groupLifecycle ? { groupLifecycle } : {}),
              },
            },
          },
        });
      else if (req.method === "opencraft/channels/list")
        send({ groups: [{ id: "group:a", title: "Available group" }] });
      else if (req.method === "opencraft/inbox/sync") {
        reads++;
        reply = (error) =>
          error
            ? peer.send(encodeJsonRpcMessage({ id: req.id, error: { code: -32000, message: error } }))
            : send({
                actorId: "me",
                reset: true,
                hasMore: false,
                cursor: "1",
                changes: [
                  {
                    channelId: "group:a",
                    revision: "1",
                    item: {
                      kind: "group",
                      channelId: "group:a",
                      title: "Available group",
                      unreadCount: 4,
                      latestMessage: null,
                    },
                  },
                ],
              });
      } else send({});
    },
  });
  Object.assign(transport, {
    subscribeRecoveryHint(fn: () => void) {
      recovery.add(fn);
      return () => {
        recovery.delete(fn);
      };
    },
  });
  const abort = new AbortController(),
    rpc = createChannelsRpc(transport, abort.signal);
  await rpc.connect();
  await rpc.request("opencraft/channels/subscribe", { subscriptionId: "directory" });
  return {
    rpc,
    hint() {
      for (const fn of [...recovery]) fn();
    },
    reply: (e?: string) => reply(e),
    get reads() {
      return reads;
    },
    async close() {
      await rpc.close();
      abort.abort();
    },
  };
}
test("directory is available while optional inbox is held; completed summaries invalidate only directory", async () => {
  const f = await fixture();
  try {
    const events: string[] = [];
    const remove = f.rpc.onChanged((id) => events.push(id));
    const result = await f.rpc.request("opencraft/channels/list", {});
    assert.equal(result.groups.length, 1);
    await flush();
    assert.equal(f.reads, 1);
    f.reply();
    await flush();
    assert.deepEqual(events, ["directory"]);
    const next = await f.rpc.request("opencraft/channels/list", {});
    assert.equal(next.groups[0].unreadCount, 4);
    await flush();
    f.reply();
    await flush();
    assert.equal(events.length, 1, "unchanged summary cannot create a refresh loop");
    remove();
  } finally {
    await f.close();
  }
});
test("transient inbox failure does not discard a valid directory", async () => {
  const f = await fixture();
  try {
    await f.rpc.request("opencraft/channels/list", {});
    await flush();
    f.reply("temporary failure");
    await flush();
    assert.equal((await f.rpc.request("opencraft/channels/list", {})).groups.length, 1);
  } finally {
    await f.close();
  }
});
test("inbox authority revocation is not degraded to optional metadata failure", async () => {
  const f = await fixture();
  try {
    const events: string[] = [];
    f.rpc.onChanged((id) => events.push(id));
    await f.rpc.request("opencraft/channels/list", {});
    await flush();
    f.reply("channel_denied");
    await flush();
    assert.deepEqual(events, ["directory"]);
    await assert.rejects(f.rpc.request("opencraft/channels/list", {}), /channel_denied/);
    await assert.rejects(f.rpc.connect(), /channel_denied/);
  } finally {
    await f.close();
  }
});
test("late inbox settlement cannot notify after close", async () => {
  const f = await fixture();
  let calls = 0;
  f.rpc.onChanged(() => calls++);
  await f.rpc.request("opencraft/channels/list", {});
  await flush();
  await f.close();
  f.reply();
  await flush();
  assert.equal(calls, 0);
});

for (const supported of [false, true])
  test("native lifecycle negotiation is explicit, including older Servers: " + supported, async () => {
    const f = await fixture(supported ? 1 : undefined);
    try {
      assert.equal(f.rpc.supportsGroupLifecycle, supported);
    } finally {
      await f.close();
    }
  });

test("shared AppHost recovery hints reach Channels RPC and stop after removal or retirement", async () => {
  const f = await fixture();
  try {
    let calls = 0;
    const remove = f.rpc.onRecoveryHint!(() => calls++);
    f.hint();
    assert.equal(calls, 1);
    remove();
    f.hint();
    assert.equal(calls, 1);
    f.rpc.onRecoveryHint!(() => calls++);
    await f.rpc.close();
    f.hint();
    assert.equal(calls, 1);
  } finally {
    await f.close();
  }
});
