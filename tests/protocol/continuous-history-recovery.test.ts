import assert from "node:assert/strict";
import test from "node:test";
import { JsonRpcAppServerClient } from "@opencraft/appserver-client";
import { createCordisThreadSessionRuntime } from "@opencraft/appserver-session";
import { MemoryTransport } from "@opencraft/appserver-transport-memory";
import { encodeJsonRpcMessage, isJsonRpcRequest, parseJsonRpcMessage } from "@opencraft/appserver-protocol";
const flush = async () => {
  for (let i = 0; i < 12; i++) await new Promise<void>((r) => setImmediate(r));
};
async function fixture() {
  let reads = 0,
    live = true,
    fail = false,
    held = false,
    late: (() => void) | undefined,
    elapsed = 0;
  const timers = new Map<number, () => void>();
  let seq = 0;
  const transport = new MemoryTransport({
    receive(frame, peer) {
      const request = parseJsonRpcMessage(frame);
      if (!isJsonRpcRequest(request)) return;
      const send = (result: unknown) => peer.send(encodeJsonRpcMessage({ id: request.id, result }));
      if (request.method === "initialize") {
        send({
          codexHome: "/fixture",
          platformFamily: "unix",
          platformOs: "linux",
          userAgent: "audit",
          capabilities: { extensions: { "opencraft/read-history": { version: 1 } } },
        });
        return;
      }
      if (request.method !== "thread/read") return;
      reads++;
      elapsed += 600;
      if (live)
        peer.send(
          encodeJsonRpcMessage({
            method: "item/agentMessage/delta",
            params: { threadId: "a", turnId: "turn", itemId: "item", delta: "x" },
          }),
        );
      const finish = () =>
        fail
          ? peer.send(encodeJsonRpcMessage({ id: request.id, error: { code: -32000, message: "temporary failure" } }))
          : send({
              thread: {
                id: "a",
                sessionId: "a",
                cwd: "/fixture",
                historyMode: "paginated",
                status: { type: "active", activeFlags: [] },
                turns: [],
              },
              initialTurnsPage: {
                data: [
                  {
                    id: "turn",
                    status: "inProgress",
                    itemsView: "full",
                    items: [{ id: "item", type: "agentMessage", text: "x".repeat(reads) }],
                  },
                ],
                nextCursor: null,
              },
            });
      if (held) late = finish;
      else finish();
    },
  });
  const client = new JsonRpcAppServerClient({ hostId: "continuous", transport });
  await client.connect({ clientInfo: { name: "test", version: "1" } });
  const session = await createCordisThreadSessionRuntime({
    client,
    readClock: {
      now: () => elapsed,
      setTimeout(run) {
        const id = ++seq;
        timers.set(id, run);
        return id;
      },
      clearTimeout(id) {
        timers.delete(id as number);
      },
    },
  });
  return {
    session,
    client,
    timers,
    get reads() {
      return reads;
    },
    get text() {
      return session.views.get("a")?.turns[0]?.items?.[0]?.text;
    },
    live(value: boolean) {
      live = value;
    },
    fail(value: boolean) {
      fail = value;
    },
    hold(value: boolean) {
      held = value;
    },
    late() {
      late?.();
    },
    async tick() {
      const [id, run] = [...timers][0] ?? [];
      assert.ok(run);
      timers.delete(id);
      run();
      await flush();
    },
    async close() {
      await session.dispose();
      await client.close();
    },
  };
}
test("continuous output releases baseline after two reads and follows bounded snapshots without duplicated deltas", async () => {
  const f = await fixture();
  try {
    await f.session.resume.read("a");
    await flush();
    assert.equal(f.reads, 2);
    assert.equal(f.text, "xx");
    assert.equal(f.timers.size, 1);
    for (let i = 0; i < 55; i++) {
      await f.tick();
      assert.equal(f.text, "x".repeat(f.reads));
      assert.equal(f.timers.size, 1);
    }
    f.live(false);
    await f.tick();
    assert.equal(f.timers.size, 0);
    assert.equal(f.text, "x".repeat(f.reads));
  } finally {
    await f.close();
  }
});
test("snapshot following retries a failed read without replaying ambiguous deltas", async () => {
  const f = await fixture();
  try {
    await f.session.resume.read("a");
    await flush();
    f.fail(true);
    await f.tick();
    assert.equal(f.text, "xx");
    assert.ok(f.session.views.get("a")?.historyError);
    f.fail(false);
    await f.tick();
    assert.equal(f.text, "xxxx");
    assert.equal(f.session.views.get("a")?.historyError, null);
  } finally {
    await f.close();
  }
});
for (const action of ["release", "fresh-read", "disconnect", "dispose"] as const)
  test(`snapshot follower fences held response on ${action}`, async () => {
    const f = await fixture();
    try {
      await f.session.resume.read("a");
      await flush();
      f.hold(true);
      await f.tick();
      f.live(false);
      f.hold(false);
      if (action === "release") f.session.resume.release("a");
      if (action === "fresh-read") await f.session.resume.read("a");
      if (action === "disconnect") await f.client.close();
      if (action === "dispose") await f.session.dispose();
      const before = f.session.views.get("a");
      f.late();
      await flush();
      assert.equal(f.timers.size, 0);
      assert.equal(f.session.views.get("a"), before);
    } finally {
      await f.close();
    }
  });
