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
    elapsed = 0,
    olderHeld = false,
    olderReply: (() => void) | undefined,
    nextCursor: string | null = "older",
    turnId = "turn",
    epoch: string | undefined;
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
      if (request.method === "thread/turns/list") {
        olderReply = () =>
          send({ data: [{ id: "old", status: "completed", itemsView: "full", items: [] }], nextCursor: null });
        if (!olderHeld) olderReply();
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
              ...(epoch ? { historyRecovery: { mode: "replace", checkpoint: { epoch, nextSeq: reads } } } : {}),
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
                    id: turnId,
                    status: "inProgress",
                    itemsView: "full",
                    items: [{ id: "item", type: "agentMessage", text: "x".repeat(reads) }],
                  },
                ],
                nextCursor,
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
    epoch(value: string) {
      epoch = value;
    },
    olderHold() {
      olderHeld = true;
    },
    olderRelease() {
      olderReply?.();
    },
    full() {
      nextCursor = null;
    },
    disjoint() {
      turnId = "replacement";
    },
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
test("snapshot following preserves loaded older turns and cursor", async () => {
  const f = await fixture();
  try {
    await f.session.resume.read("a");
    await flush();
    await f.session.resume.loadOlder("a");
    const pagination = f.session.views.get("a")!.turnsPagination;
    for (let i = 0; i < 3; i++) {
      await f.tick();
      assert.deepEqual(
        f.session.views.get("a")!.turns.map((t) => t.id),
        ["old", "turn"],
      );
      assert.deepEqual(f.session.views.get("a")!.turnsPagination, pagination);
    }
  } finally {
    await f.close();
  }
});
test("older page in flight survives an overlapping follower read", async () => {
  const f = await fixture();
  try {
    await f.session.resume.read("a");
    await flush();
    f.olderHold();
    const older = f.session.resume.loadOlder("a");
    await flush();
    await f.tick();
    f.olderRelease();
    await older;
    assert.deepEqual(
      f.session.views.get("a")!.turns.map((t) => t.id),
      ["old", "turn"],
    );
    await f.tick();
    assert.equal(f.session.views.get("a")!.turnsPagination.hasLoadedOldest, true);
  } finally {
    await f.close();
  }
});
for (const mode of ["full", "disjoint", "fresh"] as const)
  test(mode + " snapshot still replaces obsolete history", async () => {
    const f = await fixture();
    try {
      await f.session.resume.read("a");
      await flush();
      await f.session.resume.loadOlder("a");
      if (mode === "full") f.full();
      if (mode === "disjoint") f.disjoint();
      if (mode === "fresh") await f.session.resume.read("a");
      else await f.tick();
      assert.deepEqual(
        f.session.views.get("a")!.turns.map((t) => t.id),
        [mode === "disjoint" ? "replacement" : "turn"],
      );
    } finally {
      await f.close();
    }
  });

test("changed snapshot epoch cannot retain an old prefix despite matching turn IDs", async () => {
  const f = await fixture();
  try {
    f.epoch("first");
    await f.session.resume.read("a");
    await flush();
    await f.session.resume.loadOlder("a");
    f.epoch("replacement");
    await f.tick();
    assert.deepEqual(
      f.session.views.get("a")!.turns.map((t) => t.id),
      ["turn"],
    );
    assert.equal(f.session.views.get("a")!.turnsPagination.olderCursor, "older");
  } finally {
    await f.close();
  }
});
