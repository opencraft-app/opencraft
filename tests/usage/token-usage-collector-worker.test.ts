import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TokenUsageStateDatabase } from "../../apps/opencraft-daemon/src/token-usage-state-database.js";
import { OpenCraftTokenUsageLedger, type UsageSubmission } from "../../apps/opencraft-daemon/src/token-usage-ledger.js";
import { CodexTokenUsageRuntime } from "../../apps/opencraft-daemon/src/token-usage-runtime.js";
import { TokenUsageCollector } from "../../apps/opencraft-daemon/src/token-usage-collector.js";
import { DatabaseSync } from "node:sqlite";

const entry = new URL("../../apps/opencraft-daemon/src/token-usage-query-worker.ts", import.meta.url).pathname;
const turnId = "019a0000-0000-7000-8000-000000000001";
const at = Number.parseInt(turnId.replaceAll("-", "").slice(0, 12), 16);
const query = {
  from: new Date(at).toISOString().slice(0, 10),
  through: new Date(at).toISOString().slice(0, 10),
  scope: "team",
} as const;
const admin = () => ({ actorId: "admin", administrator: true });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "oc-usage-collector-"));
  const home = join(root, "native"),
    host = join(root, "host"),
    path = join(home, "rollout.jsonl");
  await mkdir(home);
  await mkdir(host);
  const admission = (id: string) => ({
    type: "event_msg",
    payload: {
      type: "item_completed",
      thread_id: "thread",
      turn_id: turnId,
      item: { type: "UserMessage", client_id: id },
    },
  });
  const rows: unknown[] = [admission("A-input")];
  let total = 0;
  for (const [n, tokens] of [100, 200, 300].entries()) {
    total += tokens;
    rows.push({
      type: "token_usage_record",
      payload: {
        thread_id: "thread",
        turn_id: turnId,
        session_id: "s",
        response_id: `r${n}`,
        usage: { total_tokens: tokens },
        turn_token_usage: { total_tokens: total },
      },
    });
  }
  rows.push({ type: "event_msg", payload: { type: "task_complete", turn_id: turnId } });
  await writeFile(path, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  const state = new TokenUsageStateDatabase(host);
  new OpenCraftTokenUsageLedger(state, "server", () => at).setEnabled(true);
  state.close();
  const request = async (method: string) =>
    method === "thread/read"
      ? { thread: { id: "thread", path } }
      : { data: [{ id: turnId, startedAt: Math.floor(at / 1000), status: "completed" }], nextCursor: null };
  const identity: UsageSubmission = {
    threadId: "thread",
    inputId: "A-input",
    actorId: "A",
    actorKind: "human",
    mode: "start",
    sourceKind: "human",
    submittedAt: at,
  };
  return { root, home, host, request, identity, done: () => rm(root, { recursive: true, force: true }) };
}
function snapshot(host: string) {
  const state = new TokenUsageStateDatabase(host);
  try {
    const ledger = new OpenCraftTokenUsageLedger(state, "server", () => at);
    const { summary, daily } = ledger.query(query, admin);
    return {
      summary,
      daily,
      turn: ledger.readTurn({ threadId: "thread", turnId }),
      allocations: ledger.readAllocations({ threadId: "thread", turnId }),
    };
  } finally {
    state.close();
  }
}
async function until(check: () => boolean, ms = 8000) {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
}
// Poll with a plain read-only connection; the managed owner validates/migrates.
const settled = (host: string) => {
  const db = new DatabaseSync(join(host, "token-usage.sqlite"), { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout=2000");
    return (
      db
        .prepare("SELECT allocation_state AS s FROM token_usage_turns WHERE thread_id=? AND turn_id=?")
        .get("thread", turnId)?.s === "settled"
    );
  } finally {
    db.close();
  }
};

test("worker collector produces the same settled usage as the in-process runtime", async () => {
  const inline = await fixture(),
    worker = await fixture();
  try {
    const state = new TokenUsageStateDatabase(inline.host);
    const runtime = new CodexTokenUsageRuntime(new OpenCraftTokenUsageLedger(state, "server", () => at), {
      request: inline.request,
      diagnostic: () => {},
      submission: () => inline.identity,
    });
    try {
      runtime.initialize({ codexHome: inline.home });
      runtime.notification("turn/completed", { threadId: "thread", turn: { id: turnId, status: "completed" } });
      await until(() => runtime.ledger.readTurn({ threadId: "thread", turnId })?.allocationState === "settled");
    } finally {
      runtime.close();
      state.close();
    }

    const collector = await TokenUsageCollector.start(
      { entry, directory: worker.host, serverId: "server", submission: true, derived: false },
      { request: worker.request, submission: () => worker.identity, diagnostic: () => {}, failed: () => {} },
    );
    try {
      collector.initialize({ codexHome: worker.home });
      collector.notification("turn/completed", { threadId: "thread", turn: { id: turnId, status: "completed" } });
      await until(() => settled(worker.host));
    } finally {
      await collector.close();
    }

    const expected = snapshot(inline.host),
      actual = snapshot(worker.host);
    assert.equal(expected.turn?.allocationState, "settled");
    assert.equal(expected.summary.tokens, "600");
    assert.deepEqual(
      { ...actual, turn: { ...actual.turn, revision: 0 } },
      { ...expected, turn: { ...expected.turn, revision: 0 } },
    );
  } finally {
    await inline.done();
    await worker.done();
  }
});

test("collection progresses while the Host thread is blocked, and identity arrives late", async () => {
  const f = await fixture();
  let answered = 0;
  const collector = await TokenUsageCollector.start(
    { entry, directory: f.host, serverId: "server", submission: true, derived: false },
    {
      request: f.request,
      submission: () => {
        answered++;
        return f.identity;
      },
      diagnostic: () => {},
      failed: () => {},
    },
  );
  try {
    collector.initialize({ codexHome: f.home });
    collector.notification("turn/completed", { threadId: "thread", turn: { id: turnId, status: "completed" } });
    // Block this thread: native RPC replies queue, but the worker owns its SQL.
    const blockedUntil = Date.now() + 300;
    while (Date.now() < blockedUntil) {
      /* busy */
    }
    await until(() => settled(f.host));
    await collector.close();
    const result = snapshot(f.host);
    assert.equal(result.turn?.allocationState, "settled");
    assert.deepEqual(
      result.allocations.map((row) => [row.actorId, row.tokens]),
      [["A", "600"]],
      "late trusted identity attributed the turn",
    );
    assert.ok(answered >= 1);
  } finally {
    await collector.close();
    await f.done();
  }
});

test("close stops the worker before the Host closes the store, and later events are dropped", async () => {
  const f = await fixture();
  let failed = 0;
  const collector = await TokenUsageCollector.start(
    { entry, directory: f.host, serverId: "server", submission: false, derived: false },
    {
      request: f.request,
      diagnostic: () => {},
      failed: () => {
        failed++;
      },
    },
  );
  const coverage = await collector.setEnabled(false);
  assert.equal(coverage.enabled, false);
  assert.equal(collector.coverage().enabled, false);
  await collector.close();
  collector.notification("turn/completed", { threadId: "thread", turn: { id: turnId, status: "completed" } });
  await assert.rejects(collector.setEnabled(true));
  assert.equal(failed, 0, "an orderly close is not reported as a failure");
  const state = new TokenUsageStateDatabase(f.host);
  try {
    assert.equal(new OpenCraftTokenUsageLedger(state, "server", () => at).coverage().enabled, false);
  } finally {
    state.close();
    await f.done();
  }
});

test("a crashed collector reports failure and rejects pending replies", async () => {
  const f = await fixture();
  let failed = 0;
  const collector = await TokenUsageCollector.start(
    { entry, directory: f.host, serverId: "server", submission: false, derived: false },
    {
      request: f.request,
      diagnostic: () => {},
      failed: () => {
        failed++;
      },
    },
  );
  try {
    await (collector as unknown as { worker: import("node:worker_threads").Worker }).worker.terminate();
    await until(() => failed > 0, 2000);
    assert.equal(failed, 1);
    await assert.rejects(collector.setEnabled(true));
  } finally {
    await collector.close();
    await f.done();
  }
});
