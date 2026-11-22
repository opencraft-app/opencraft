import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  dispatchQueuedStart,
  dispatchQueuedSteer,
  reconcileThreadQueue,
  THREAD_QUEUE_SCHEMA,
  ThreadQueueStore,
  type QueueDispatchPort,
} from "../../packages/thread-queue/src/index.ts";

const text = (value: string) => [{ type: "text", text: value }];
class Refused extends Error {}
function queue() {
  const db = new DatabaseSync(":memory:");
  db.exec(THREAD_QUEUE_SCHEMA);
  return new ThreadQueueStore(db);
}
function port(
  send: QueueDispatchPort<never, string, { ok: true }>["send"],
  failed: QueueDispatchPort<never, string, { ok: true }>["failed"] = () => ({
    state: "unknown",
    reason: "unconfirmed",
  }),
) {
  const changes: number[] = [];
  const value: QueueDispatchPort<never, string, { ok: true }> & { changes: number[] } = {
    changes,
    refuse: (message) => {
      throw new Refused(message);
    },
    prepare: async (row) => `prepared:${row.clientUserMessageId}`,
    send,
    failed,
    changed: () => {
      changes.push(1);
    },
  };
  return value;
}

test("a queued start is claimed, sent once with the prepared input and settled with its native turn", async () => {
  const q = queue(),
    item = q.add("t", "c1", text("one"));
  const sent: string[] = [];
  const p = port(async (row, prepared) => {
    assert.equal(q.find("t", row.id)!.state, "dispatching");
    sent.push(prepared);
    return { turnId: "turn-1", response: { ok: true } };
  });
  assert.deepEqual(await dispatchQueuedStart(q, "t", item.id, p), { ok: true });
  assert.deepEqual(sent, ["prepared:c1"]);
  const settled = q.find("t", item.id)!;
  assert.equal(settled.state, "delivered");
  assert.equal(settled.targetTurnId, "turn-1");
  assert.equal(settled.delivery!.nativeAdmission, "accepted");
  assert.equal(p.changes.length, 2, "claim and settlement are announced");
});

test("a failed send is recorded as the engine classifies it, and nothing is sent twice", async () => {
  const q = queue(),
    unsent = q.add("t", "c1", text("one"));
  await assert.rejects(
    dispatchQueuedStart(
      q,
      "t",
      unsent.id,
      port(
        async () => {
          throw Error("not sent");
        },
        () => ({ state: "queued", reason: "tools-recovering" }),
      ),
    ),
    /not sent/u,
  );
  assert.equal(q.find("t", unsent.id)!.state, "queued");
  assert.equal(q.find("t", unsent.id)!.pausedReason, "tools-recovering");
  let after = 0;
  await assert.rejects(
    dispatchQueuedStart(
      q,
      "t",
      unsent.id,
      port(
        async () => {
          throw Error("lost");
        },
        () => ({
          state: "unknown",
          reason: "unconfirmed",
          after: () => {
            after++;
          },
        }),
      ),
    ),
    /lost/u,
  );
  assert.equal(q.find("t", unsent.id)!.state, "unknown");
  assert.equal(after, 1);
  // A user's own unknown input waits for that user's retry or discard; it does not hold back later input.
  const next = q.add("t", "c2", text("two"));
  await dispatchQueuedStart(
    q,
    "t",
    next.id,
    port(async () => ({ turnId: "turn-2", response: { ok: true } })),
  );
  // An execution fault does: nothing behind it is sent until it is reconciled.
  q.interruptExecution("t", false);
  const blocked = q.add("t", "c3", text("three"));
  await assert.rejects(
    dispatchQueuedStart(
      q,
      "t",
      blocked.id,
      port(async () => assert.fail("must not send")),
    ),
    (error: Error) => error instanceof Refused && /still unconfirmed/u.test(error.message),
  );
});

test("a steer goes into the expected turn once; asking again answers from its receipt", async () => {
  const q = queue(),
    item = q.add("t", "c1", text("more"));
  let sends = 0;
  const p = port(async () => {
    sends++;
    return { turnId: "turn-1", response: { ok: true } };
  });
  const first = await dispatchQueuedSteer(q, "t", item.id, "turn-1", p, async () => {});
  assert.equal(first.turnId, "turn-1");
  assert.equal(first.delivery!.nativeAdmission, "accepted", "the receipt reflects the settlement");
  assert.equal(q.find("t", item.id)!.state, "steering");
  assert.deepEqual(await dispatchQueuedSteer(q, "t", item.id, "turn-1", p, async () => {}), {
    turnId: "turn-1",
    delivery: first.delivery,
  });
  assert.equal(sends, 1);
  await assert.rejects(
    dispatchQueuedSteer(q, "t", item.id, "turn-2", p, async () => {}),
    /another Turn/u,
  );
  q.deliveries.finish("t", "turn-1", "completed");
  const late = q.add("t", "c2", text("late"));
  await assert.rejects(
    dispatchQueuedSteer(q, "t", late.id, "turn-1", p, async () => {}),
    /no active turn to steer/u,
  );
  assert.equal(sends, 1);
});

test("reconciliation settles unknown inputs only from native evidence", async () => {
  const q = queue(),
    seen = q.add("t", "seen", text("a")),
    lost = q.add("t", "lost", text("b"));
  for (const row of [seen, lost]) {
    q.claim("t", row.id, "turn-1");
    q.settle("t", row.id, "unknown");
  }
  let changed = 0;
  const ended: string[] = [];
  await reconcileThreadQueue(q, "t", {
    historyHasInput: async (clientId) => clientId === "seen",
    isIdle: async () => true,
    findTurn: async () => ({ status: "completed" }),
    turnEnded: (turnId) => ended.push(turnId),
    changed: () => {
      changed++;
    },
  });
  assert.equal(q.find("t", seen.id)!.state, "delivered");
  assert.equal(q.find("t", seen.id)!.delivery!.context, "recorded");
  // No history evidence: the attempt's turn is proven terminal, but the input is not invented into it.
  assert.equal(q.find("t", lost.id)!.state, "closed");
  assert.equal(q.find("t", lost.id)!.delivery!.context, "unobserved");
  assert.deepEqual(ended, ["turn-1"]);
  assert.ok(changed >= 2);
});
