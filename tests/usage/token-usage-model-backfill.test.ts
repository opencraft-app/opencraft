import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TokenUsageStateDatabase } from "../../apps/opencraft-daemon/src/token-usage-state-database.js";
import { OpenCraftTokenUsageLedger } from "../../apps/opencraft-daemon/src/token-usage-ledger.js";
import { backfillTokenUsageModels } from "../../apps/opencraft-daemon/src/token-usage-model-backfill.js";

const now = Date.parse("2026-10-22T08:00:00Z");

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "oc-backfill-"));
  const state = new TokenUsageStateDatabase(dir);
  const ledger = new OpenCraftTokenUsageLedger(state, "server:test", () => now);
  return { dir, state, ledger };
}

test("backfillTokenUsageModels scans rollout, supports dry-run and applies idempotently", async () => {
  const { dir, state, ledger } = await setup();
  try {
    const threadId = "thread-backfill-1";
    const rolloutFile = join(dir, "rollout-1.jsonl");

    // Write a rollout file with session_meta specifying provider and model
    const lines = [
      JSON.stringify({
        type: "session_meta",
        payload: {
          model_provider: "anthropic",
          model: "claude-3-7-sonnet",
        },
      }),
      JSON.stringify({
        type: "event_msg",
        payload: {
          type: "turn_context",
          turn_id: "turn-1",
          model: "claude-3-7-sonnet",
        },
      }),
      JSON.stringify({
        type: "token_usage_record",
        turn_id: "turn-1",
        total_tokens: 1500,
      }),
    ];
    await writeFile(rolloutFile, lines.join("\n") + "\n", "utf8");

    // Register rollout in ledger
    ledger.rememberRollout(threadId, rolloutFile);

    // Create turn in ledger with NULL provider & model
    const turnKey = { threadId, turnId: "turn-1" };
    ledger.startTurn(turnKey, now, "human", true);
    ledger.recordInput(turnKey, {
      inputId: "in-1",
      actorId: "actor-1",
      actorKind: "human",
      mode: "start",
      admission: "confirmed",
    });
    ledger.recordSource({
      ...turnKey,
      lineage: "native",
      sourceId: "src-1",
      kind: "response",
      version: 0,
      provider: null,
      model: null,
      counts: { totalTokens: "1500" },
    });
    ledger.reconcile(turnKey, {
      executionState: "completed",
      participantsComplete: true,
      usageComplete: true,
      responsesComplete: true,
    });

    // Verify initial state has null model
    const beforeTurn = ledger.readTurn(turnKey);
    assert.ok(beforeTurn);
    const beforeSources = state.database
      .prepare("SELECT provider, model FROM token_usage_sources WHERE server_id=? AND thread_id=? AND turn_id=?")
      .all("server:test", threadId, "turn-1") as { provider: string | null; model: string | null }[];
    assert.equal(beforeSources[0]?.provider, null);
    assert.equal(beforeSources[0]?.model, null);

    // 1. Dry run
    const dryRunResult = await backfillTokenUsageModels({ ledger, state, apply: false });
    assert.equal(dryRunResult.threads, 1);
    assert.equal(dryRunResult.updatedTurns, 1);
    assert.equal(dryRunResult.missingRollouts, 0);

    // Verify dry run did NOT mutate database
    const afterDrySources = state.database
      .prepare("SELECT provider, model FROM token_usage_sources WHERE server_id=? AND thread_id=? AND turn_id=?")
      .all("server:test", threadId, "turn-1") as { provider: string | null; model: string | null }[];
    assert.equal(afterDrySources[0]?.provider, null);
    assert.equal(afterDrySources[0]?.model, null);

    // 2. Apply
    const applyResult = await backfillTokenUsageModels({ ledger, state, apply: true });
    assert.equal(applyResult.threads, 1);
    assert.equal(applyResult.updatedTurns, 1);
    assert.equal(applyResult.updatedSources, 1);

    // Verify database was updated
    const afterApplySources = state.database
      .prepare("SELECT provider, model FROM token_usage_sources WHERE server_id=? AND thread_id=? AND turn_id=?")
      .all("server:test", threadId, "turn-1") as { provider: string | null; model: string | null }[];
    assert.equal(afterApplySources[0]?.provider, "anthropic");
    assert.equal(afterApplySources[0]?.model, "claude-3-7-sonnet");

    // 3. Second apply should be idempotent (0 updated)
    const secondApply = await backfillTokenUsageModels({ ledger, state, apply: true });
    assert.equal(secondApply.updatedTurns, 0);
    assert.equal(secondApply.updatedSources, 0);
  } finally {
    state.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("backfillTokenUsageModels handles missing rollout files gracefully", async () => {
  const { dir, state, ledger } = await setup();
  try {
    ledger.rememberRollout("missing-thread", join(dir, "non-existent.jsonl"));
    const result = await backfillTokenUsageModels({ ledger, state, apply: true });
    assert.equal(result.threads, 1);
    assert.equal(result.missingRollouts, 1);
    assert.equal(result.updatedTurns, 0);
  } finally {
    state.close();
    await rm(dir, { recursive: true, force: true });
  }
});
