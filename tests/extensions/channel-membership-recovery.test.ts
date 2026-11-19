import assert from "node:assert/strict";
import test from "node:test";
import { ImChannelsAppServer } from "../../scripts/im-channels-appserver.mjs";
import { LOGICAL_CLIENT_FIELD } from "../../packages/app-host-protocol/src/index.ts";
const flush = async () => {
  for (let i = 0; i < 12; i++) await new Promise<void>((r) => setImmediate(r));
};
for (const failure of ["temporary worker unavailable", "channel_denied"])
  test("membership check: " + failure, async () => {
    let timer: (() => void) | undefined,
      change: ((v: unknown) => void) | undefined,
      fail = false;
    const native = {
      available: true,
      actors: { authority: "test", isCurrent: () => true },
      admittedActor: () => true,
      channels: {
        onChange(fn: any) {
          change = fn;
          return () => {};
        },
      },
      async communicate(_ctx: any, method: string) {
        if (method === "channel/readable" && fail) throw Error(failure);
        return {};
      },
    };
    const server = new ImChannelsAppServer(() => native as any);
    const original = setInterval;
    globalThis.setInterval = ((fn: any) => {
      timer = fn;
      return { unref() {} };
    }) as any;
    const frames: any[] = [];
    let sequence = 0;
    const context = { actorContext: { actorId: "me" }, resourceOwner: { assertCurrent() {} } };
    const send = async (method: string, params = {}) => {
      await server.sendWithContext(
        JSON.stringify({ jsonrpc: "2.0", id: ++sequence, method, params, [LOGICAL_CLIENT_FIELD]: "logical" }),
        context,
      );
      await flush();
      assert.equal(frames.find((f) => f.id === sequence)?.error, undefined);
    };
    try {
      await server.connect();
      server.subscribeMessage((frame: string) => frames.push(JSON.parse(frame)));
      await send("initialize");
      await send("opencraft/channels/subscribe", {
        channelId: "group:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        subscriptionId: "watch",
      });
      const hints = () => frames.filter((f) => f.method === "opencraft/channels/changed").length;
      change!({ channelId: "group:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" });
      await flush();
      const before = hints();
      assert.equal(before, 1);
      fail = true;
      timer!();
      await flush();
      const invalidated = hints();
      assert.equal(invalidated, 2);
      fail = false;
      await send("opencraft/channels/messages/list", { channelId: "group:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" });
      change!({ channelId: "group:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" });
      await flush();
      const after = hints();
      assert.equal(after, invalidated + (failure === "channel_denied" ? 0 : 1));
      await send("opencraft/channels/subscribe", {
        channelId: "group:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        subscriptionId: "watch",
      });
      change!({ channelId: "group:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" });
      await flush();
      assert.equal(hints(), after + 1);
    } finally {
      globalThis.setInterval = original;
      await server.close();
    }
  });
