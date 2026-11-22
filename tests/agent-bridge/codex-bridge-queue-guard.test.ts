import assert from "node:assert/strict";
import test from "node:test";
import { CodexEngineAdapter } from "../../apps/opencraft-daemon/src/codex-engine-adapter.js";

type Row = { id: string; clientUserMessageId: string; state: string; targetTurnId: string | null };

// The guard reads only the Host's collaboration options, so it is exercised without a running Host.
function guard(rows: Row[], options: { mode?: "queue" | "steer" | null; allowed?: boolean } = {}) {
  const calls: unknown[] = [];
  const host = {
    options: {
      collaboration: {
        command: async (_actor: unknown, body: unknown) => {
          calls.push(["command", body]);
        },
        authorize: (_actor: unknown, threadId: string, inputId: string) => {
          calls.push(["authorize", threadId, inputId]);
          if (options.allowed === false) throw Error("Not allowed");
        },
      },
      collaborationInput: {
        available: () => true,
        mode: () => (options.mode === undefined ? "queue" : options.mode),
        authorize: (threadId: string, inputId: string, mode: string, expectedTurnId?: string) => {
          calls.push(["input", threadId, inputId, mode, expectedTurnId ?? null]);
          return options.allowed !== false;
        },
      },
    },
  };
  const find = async (by: { queuedSubmissionId: string } | { clientUserMessageId: string }) =>
    rows.find((row) =>
      "queuedSubmissionId" in by
        ? row.id === by.queuedSubmissionId
        : row.clientUserMessageId === by.clientUserMessageId,
    ) ?? null;
  const run = (method: string, params: Record<string, unknown>, context: Record<string, unknown> = {}) =>
    CodexEngineAdapter.prototype.guardExternalQueue.call(
      host as never,
      "bridge:codex:t",
      method,
      params,
      { sender: null, ...context } as never,
      find,
    );
  return { run, calls };
}

const actor = { actorContext: { actorId: "person" } };

test("bridge queue: ordinary input is authorized for its actor before it is queued", async () => {
  const { run, calls } = guard([]);
  assert.equal(await run("thread/queue/add", { clientUserMessageId: "c1", input: [] }, actor), null);
  assert.deepEqual(calls, [["authorize", "bridge:codex:t", "c1"]]);
  await assert.rejects(
    guard([], { allowed: false }).run("thread/queue/add", { clientUserMessageId: "c1", input: [] }, actor),
    /Not allowed/u,
  );
});

test("bridge queue: Actor input needs its own trusted admission and stays immutable", async () => {
  const rows = [{ id: "q1", clientUserMessageId: "actor-input:r1", state: "queued", targetTurnId: null }];
  const { run, calls } = guard(rows);
  await assert.rejects(
    run("thread/queue/add", { clientUserMessageId: "actor-input:r1", input: [] }),
    /trusted admission/u,
  );
  await assert.rejects(
    run("thread/queue/add", { clientUserMessageId: "actor-input:r1", input: [] }, { collaborationRequestId: "r2" }),
    /trusted admission/u,
  );
  assert.equal(
    await run(
      "thread/queue/add",
      { clientUserMessageId: "actor-input:r1", input: [] },
      { collaborationRequestId: "r1" },
    ),
    null,
  );
  assert.deepEqual(calls.at(-1), ["input", "bridge:codex:t", "actor-input:r1", "queue", null]);
  await assert.rejects(
    run("thread/queue/update", { queuedSubmissionId: "q1", input: [] }, { collaborationRequestId: "r1" }),
    /immutable/u,
  );
  await assert.rejects(
    guard(rows, { mode: null }).run(
      "thread/queue/add",
      { clientUserMessageId: "actor-input:r1" },
      { collaborationRequestId: "r1" },
    ),
    /unavailable/u,
  );
  await assert.rejects(
    guard(rows, { allowed: false }).run(
      "thread/queue/steer",
      { queuedSubmissionId: "q1", expectedTurnId: "turn-1" },
      { collaborationRequestId: "r1" },
    ),
    /authorization changed/u,
  );
});

test("bridge queue: a person deleting Actor input cancels the request instead", async () => {
  const rows = [{ id: "q1", clientUserMessageId: "actor-input:r1", state: "queued", targetTurnId: null }];
  const { run, calls } = guard(rows);
  assert.deepEqual(await run("thread/queue/delete", { queuedSubmissionId: "q1" }, actor), {
    result: { deleted: true },
  });
  assert.deepEqual(calls, [["command", { action: "cancel", requestId: "r1" }]]);
});

test("bridge queue: collaboration receipts come from the Host queue rows", async () => {
  const rows = [{ id: "q1", clientUserMessageId: "actor-input:r1", state: "delivered", targetTurnId: "turn-1" }];
  const { run } = guard(rows);
  await assert.rejects(run("thread/queue/collaborationReceipt", {}), /Trusted Actor admission required/u);
  assert.deepEqual(await run("thread/queue/collaborationReceipt", {}, { collaborationRequestId: "r1" }), {
    result: { receipt: { id: "q1", state: "delivered", targetTurnId: "turn-1" } },
  });
  assert.deepEqual(await run("thread/queue/collaborationReceipt", {}, { collaborationRequestId: "r9" }), {
    result: { receipt: null },
  });
});
