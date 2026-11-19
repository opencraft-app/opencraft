import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenCraftHostQueue } from "../../apps/opencraft-daemon/src/opencraft-host-queue.js";
import { readInputCompletion } from "../../apps/opencraft-daemon/src/input-completion.js";
import { parseInputCompletion } from "@opencraft/appserver-protocol";

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "input-completion-"));
  let queue = new OpenCraftHostQueue(root);
  t.after(async () => {
    queue.close();
    await rm(root, { recursive: true, force: true });
  });
  const queued = queue.add("thread", "actor-input:request", [{ type: "text", text: "work" }]);
  queue.claim("thread", queued.id, "owned-turn");
  return {
    get queue() {
      return queue;
    },
    id: queued.id,
    restart() {
      queue.close();
      queue = new OpenCraftHostQueue(root);
    },
  };
}
const items = async () => ({
  data: [{ turnId: "owned-turn", item: { type: "agentMessage", text: "native result" } }],
  nextCursor: null,
});

for (const outcome of ["completed", "failed"] as const)
  test(`durable ${outcome} survives restart and a different later Turn without reading latest status`, async (t) => {
    const f = await fixture(t);
    f.queue.settle("thread", f.id, "delivered");
    f.queue.deliveries.finish("thread", "owned-turn", outcome);
    f.queue.deliveries.finish("thread", "later-turn", outcome === "completed" ? "failed" : "completed");
    f.restart();
    const result = await readInputCompletion(
      "thread",
      f.queue.findByClientId("thread", "actor-input:request")!,
      f.queue.deliveries,
      async () => {
        throw Error("durable terminal must not reread latest status");
      },
      async (thread, turn) => {
        assert.equal(thread, "thread");
        assert.equal(turn, "owned-turn");
        return items();
      },
    );
    assert.deepEqual(result, {
      version: 1,
      turnId: "owned-turn",
      status: outcome,
      text: "native result",
      truncated: false,
    });
    assert.deepEqual(parseInputCompletion(result, "owned-turn"), result);
  });

for (const state of ["completed", "failed", "interrupted"] as const)
  test(`lost ${state} notification recovers and commits only the bound native Turn`, async (t) => {
    const f = await fixture(t);
    f.queue.settle("thread", f.id, "delivered");
    const result = await readInputCompletion(
      "thread",
      f.queue.findByClientId("thread", "actor-input:request")!,
      f.queue.deliveries,
      async (thread, turn) => {
        assert.equal(thread, "thread");
        assert.equal(turn, "owned-turn");
        return { id: turn, status: state };
      },
      items,
    );
    assert.equal(result.status, state);
    f.restart();
    assert.equal(f.queue.findByClientId("thread", "actor-input:request")?.delivery?.execution, state);
    // A contradictory late observation cannot change the terminal owner.
    f.queue.deliveries.finish("thread", "owned-turn", state === "completed" ? "failed" : "completed");
    assert.equal(f.queue.findByClientId("thread", "actor-input:request")?.delivery?.execution, state);
  });

test("pending or ambiguous native admission cannot borrow a known target Turn's terminal", async (t) => {
  const f = await fixture(t);
  f.queue.deliveries.finish("thread", "owned-turn", "completed");
  const result = await readInputCompletion(
    "thread",
    f.queue.findByClientId("thread", "actor-input:request")!,
    f.queue.deliveries,
    async () => {
      throw Error("unadmitted input must not read a Turn");
    },
    async () => {
      throw Error("unadmitted input must not read output");
    },
  );
  assert.equal(result.status, "unknown");
});

test("foreign/missing native Turn stays explicitly unavailable", async (t) => {
  const f = await fixture(t);
  f.queue.settle("thread", f.id, "delivered");
  for (const turn of [undefined, { id: "later-turn", status: "completed" }]) {
    const result = await readInputCompletion(
      "thread",
      f.queue.findByClientId("thread", "actor-input:request")!,
      f.queue.deliveries,
      async () => turn,
      async () => {
        throw Error("must not read foreign output");
      },
    );
    assert.equal(result.status, "unknown");
    assert.equal(result.unavailable, true);
  }
  assert.equal(f.queue.findByClientId("thread", "actor-input:request")?.delivery?.execution, "running");
});

test("summary is bounded and rejects foreign Items and looping cursors", async (t) => {
  const f = await fixture(t);
  f.queue.settle("thread", f.id, "delivered");
  f.queue.deliveries.finish("thread", "owned-turn", "completed");
  const row = f.queue.findByClientId("thread", "actor-input:request")!;
  const unused = async () => {
    throw Error("already durable");
  };
  const result = await readInputCompletion("thread", row, f.queue.deliveries, unused, async () => ({
    data: [{ item: { type: "agentMessage", text: "a".repeat(17000) } }],
    nextCursor: null,
  }));
  assert.equal(result.text.length, 16000);
  assert.equal(result.truncated, true);
  await assert.rejects(
    readInputCompletion("thread", row, f.queue.deliveries, unused, async () => ({
      data: [{ turnId: "foreign", item: { type: "agentMessage", text: "wrong" } }],
      nextCursor: null,
    })),
    /another Turn/,
  );
  await assert.rejects(
    readInputCompletion("thread", row, f.queue.deliveries, unused, async () => ({ data: [], nextCursor: "same" })),
    /did not advance/,
  );
  let pages = 0;
  const bounded = await readInputCompletion("thread", row, f.queue.deliveries, unused, async () => ({
    data: [],
    nextCursor: String(++pages),
  }));
  assert.equal(pages, 5);
  assert.equal(bounded.truncated, true);
  assert.equal(parseInputCompletion({ ...result, turnId: "foreign" }, "owned-turn"), undefined);
  assert.equal(parseInputCompletion({ ...result, status: "unknown" }, "owned-turn"), undefined);
});

for (const status of [
  undefined,
  null,
  false,
  0,
  ["completed"],
  ["failed"],
  ["interrupted"],
  ["unknown"],
  [],
  { status: "completed" },
]) {
  test(`completion parser rejects non-string status ${JSON.stringify(status)}`, () => {
    assert.equal(parseInputCompletion({ version: 1, turnId: "owned-turn", status, text: "" }, "owned-turn"), undefined);
  });
}
for (const status of ["completed", "failed", "interrupted", "unknown"]) {
  test(`completion parser retains valid status ${status}`, () => {
    const result = parseInputCompletion({ version: 1, turnId: "owned-turn", status, text: "" }, "owned-turn");
    assert.equal(result?.status, status);
  });
}
