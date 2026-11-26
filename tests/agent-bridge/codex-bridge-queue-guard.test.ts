import assert from "node:assert/strict";
import test from "node:test";
import { collaborationQueueGuard } from "../../apps/opencraft-daemon/src/codex-bridge-owners.js";

type Row = { id: string; clientUserMessageId: string; state: string; targetTurnId: string | null };

// The guard is built from the collaboration owners alone, so it runs without a local Host.
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
  const check = collaborationQueueGuard(host.options as never);
  const run = (method: string, params: Record<string, unknown>, context: Record<string, unknown> = {}) =>
    check("bridge:codex:t", method, params, { sender: null, ...context } as never, find);
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
  const rows = [
    { id: "q1", clientUserMessageId: "actor-input:r1", state: "queued", targetTurnId: null },
    { id: "q2", clientUserMessageId: "ordinary", state: "queued", targetTurnId: null },
  ];
  const { run, calls } = guard(rows);
  assert.deepEqual(await run("thread/queue/delete", { queuedSubmissionId: "q1" }, actor), {
    result: { deleted: true },
  });
  assert.deepEqual(calls, [["command", { action: "cancel", requestId: "r1" }]]);
  const trusted = { collaborationRequestId: "r1" };
  assert.equal(await run("thread/queue/delete", { queuedSubmissionId: "q1" }, trusted), null);
  await assert.rejects(run("thread/queue/delete", { queuedSubmissionId: "q2" }, trusted), /trusted admission/u);
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

test("bridge completion is requested only after trusted Actor admission", async () => {
  const row = { id: "q", clientUserMessageId: "actor-input:r", state: "delivered", targetTurnId: "turn" };
  const check = collaborationQueueGuard({});
  let reads = 0;
  const completion = { version: 1 as const, turnId: "turn", status: "completed" as const, text: "Exact reply", truncated: false };
  const read = async () => { reads++; return completion; };
  await assert.rejects(check("thread", "thread/queue/collaborationReceipt", { includeCompletion: true }, {}, async () => row, read), /Trusted Actor admission/u);
  assert.equal(reads, 0);
  const result = await check("thread", "thread/queue/collaborationReceipt", { includeCompletion: true }, { collaborationRequestId: "r" }, async () => row, read);
  assert.deepEqual(result, { result: { receipt: { id: "q", state: "delivered", targetTurnId: "turn", completion } } });
  assert.equal(reads, 1);
});
