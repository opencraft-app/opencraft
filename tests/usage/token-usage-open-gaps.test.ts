import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenCraftTokenUsageLedger } from "../../apps/opencraft-daemon/src/token-usage-ledger.js";
import { CodexTokenUsageRuntime } from "../../apps/opencraft-daemon/src/token-usage-runtime.js";
import { TokenUsageStateDatabase, TOKEN_USAGE_STATE_MIGRATIONS } from "../../apps/opencraft-daemon/src/token-usage-state-database.js";
import { openManagedDatabase } from "../../packages/sqlite-node/src/index.js";

async function directory<T>(body: (path: string) => Promise<T> | T): Promise<T> {
  const path = await mkdtemp(join(tmpdir(), "oc-usage-open-gaps-"));
  try { return await body(path); } finally { await rm(path, { recursive: true, force: true }); }
}

test("v4 indexes open gaps by thread and drops closed per-incident history", () => directory(path => {
  const previous = openManagedDatabase({ path: join(path, "token-usage.sqlite"), legacyPolicy: "reject-unknown", migrations: TOKEN_USAGE_STATE_MIGRATIONS.slice(0, 3) });
  const insert = previous.database.prepare("INSERT INTO token_usage_gaps VALUES('server',?,?,NULL,'source-offline',1,?)");
  for (let i = 0; i < 500; i++) insert.run(`closed-${i}`, "busy", 2);
  insert.run("open", "busy", null);
  insert.run("other-open", "quiet", null);
  previous.database.close();

  const state = new TokenUsageStateDatabase(path);
  try {
    const rows = state.database.prepare("SELECT gap_key FROM token_usage_gaps ORDER BY gap_key").all().map(row => row.gap_key);
    assert.deepEqual(rows, ["open", "other-open"], "closed incidents removed, open coverage retained");
    const plan = state.database.prepare("EXPLAIN QUERY PLAN UPDATE token_usage_gaps SET ends_ms=? WHERE server_id=? AND thread_id=? AND ends_ms IS NULL AND reason IN ('source-offline')")
      .all(1, "server", "busy").map(row => String(row.detail)).join(" ");
    assert.match(plan, /token_usage_gaps_open_thread/);
    const ledger = new OpenCraftTokenUsageLedger(state, "server", () => 5);
    ledger.resolveReplayGaps("busy");
    assert.deepEqual(ledger.gaps().filter(gap => gap.endsAt === null).map(gap => gap.id), ["other-open"]);
  } finally { state.close(); }
}));

test("a recurring gap reopens its existing row instead of adding history", () => directory(path => {
  const state = new TokenUsageStateDatabase(path);
  try {
    let now = 10;
    const ledger = new OpenCraftTokenUsageLedger(state, "server", () => now);
    for (let i = 0; i < 20; i++) {
      now += 10; ledger.noteGap({ id: "thread:t:source-offline", threadId: "t", reason: "source-offline" });
      now += 10; ledger.resolveReplayGaps("t");
    }
    now += 10; ledger.noteGap({ id: "thread:t:source-offline", threadId: "t", reason: "source-offline" });
    const gaps = ledger.gaps();
    assert.equal(gaps.length, 1);
    assert.equal(gaps[0]!.endsAt, null, "the latest occurrence is open");
    assert.equal(gaps[0]!.startsAt, now, "it records when the fault recurred");
  } finally { state.close(); }
}));

test("a replaced source backs off instead of re-reading on every activity event", () => directory(async path => {
  const state = new TokenUsageStateDatabase(path);
  const ledger = new OpenCraftTokenUsageLedger(state, "server", () => 1000);
  let reads = 0;
  const runtime = new CodexTokenUsageRuntime(ledger, { diagnostic: () => {}, request: async method => {
    if (method === "thread/read") { reads++; return { thread: { id: "thread", path: join(path, "missing.jsonl") } }; }
    return { data: [], nextCursor: null };
  } });
  try {
    runtime.initialize({ codexHome: path });
    runtime.notification("thread/tokenUsage/updated", { threadId: "thread" });
    const deadline = Date.now() + 3000;
    while (!runtime.liveGapCount() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(runtime.liveGapCount(), 1);
    const before = reads;
    for (let i = 0; i < 20; i++) {
      runtime.notification("thread/tokenUsage/updated", { threadId: "thread" });
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(reads, before, "activity during backoff does not re-read a replaced source");
    assert.equal(state.database.prepare("SELECT count(*) AS n FROM token_usage_gaps").get()!.n, 1);
  } finally { runtime.close(); state.close(); }
}));

test("retrying an open gap reports the fault once, not on every retry", () => directory(async path => {
  const state = new TokenUsageStateDatabase(path);
  const ledger = new OpenCraftTokenUsageLedger(state, "server", () => 1000);
  const reported: string[] = [];
  let reads = 0;
  const runtime = new CodexTokenUsageRuntime(ledger, { diagnostic: category => { reported.push(category); }, request: async method => {
    if (method === "thread/read") { reads++; return { thread: { id: "thread", path: join(path, "missing.jsonl") } }; }
    return { data: [], nextCursor: null };
  } });
  try {
    runtime.initialize({ codexHome: path });
    for (let round = 0; round < 3; round++) {
      // Expire the backoff so each round re-reads the replaced source.
      (runtime as unknown as { retry: Map<string, unknown> }).retry.clear();
      const before = reads;
      runtime.notification("thread/tokenUsage/updated", { threadId: "thread" });
      const deadline = Date.now() + 3000;
      while (reads === before && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.ok(reads >= 3, "the source was retried");
    assert.deepEqual(reported, ["source-replaced"]);
  } finally { runtime.close(); state.close(); }
}));

test("an open gap seeded from an older release with a random key is not reported again", () => directory(async path => {
  const state = new TokenUsageStateDatabase(path);
  state.database.prepare("INSERT INTO token_usage_gaps VALUES('server','legacy-random-key','thread',NULL,'source-replaced',1,NULL)").run();
  const ledger = new OpenCraftTokenUsageLedger(state, "server", () => 1000);
  const reported: string[] = [];
  let reads = 0;
  const runtime = new CodexTokenUsageRuntime(ledger, { diagnostic: category => { reported.push(category); }, request: async method => {
    if (method === "thread/read") { reads++; return { thread: { id: "thread", path: join(path, "missing.jsonl") } }; }
    return { data: [], nextCursor: null };
  } });
  try {
    runtime.initialize({ codexHome: path });
    for (let round = 0; round < 3; round++) {
      (runtime as unknown as { retry: Map<string, unknown> }).retry.clear();
      const before = reads;
      runtime.notification("thread/tokenUsage/updated", { threadId: "thread" });
      const deadline = Date.now() + 3000;
      while (reads === before && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.ok(reads >= 3, "the source was retried");
    assert.deepEqual(reported, []);
    assert.equal(state.database.prepare("SELECT count(*) AS n FROM token_usage_gaps").get()!.n, 1);
  } finally { runtime.close(); state.close(); }
}));
