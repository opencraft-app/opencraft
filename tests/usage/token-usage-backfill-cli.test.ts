import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { OpenCraftHostStateDatabase } from "../../apps/opencraft-daemon/src/opencraft-host-state-database.js";
import { TokenUsageStateDatabase } from "../../apps/opencraft-daemon/src/token-usage-state-database.js";
import { OpenCraftTokenUsageLedger } from "../../apps/opencraft-daemon/src/token-usage-ledger.js";

const execute = promisify(execFile);
const script = fileURLToPath(new URL("../../scripts/backfill-token-usage-models.ts", import.meta.url));
const loader = new URL("../../node_modules/tsx/dist/loader.mjs", import.meta.url).href;
const at = Date.parse("2026-10-22T08:00:00Z");
const serverId = "server:fixture";
const target = ["--server-id", serverId];

async function cli(directory: string, args: string[], environment: Record<string, string> = {}) {
  return execute(process.execPath, ["--import", loader, script, ...args], {
    cwd: directory,
    env: { ...process.env, OPENCRAFT_USAGE_DATA_DIR: "", OPENCRAFT_CODEX_DATA_DIR: "", OPENCRAFT_SERVER_ID: "", ...environment },
    timeout: 15_000,
  });
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "opencraft-backfill-cli-"));
  const path = join(directory, "rollout.jsonl");
  await writeFile(path, [
    { type: "session_meta", payload: { model_provider: "fixture-provider" } },
    { type: "turn_context", payload: { turn_id: "turn", model: "fixture-model" } },
  ].map(line => JSON.stringify(line)).join("\n") + "\n");
  for (const state of [new OpenCraftHostStateDatabase(directory), new TokenUsageStateDatabase(directory)]) {
    for (const id of [serverId, "other-server"]) {
      const ledger = new OpenCraftTokenUsageLedger(state, id, () => at);
      const key = { threadId: "thread", turnId: "turn" };
      ledger.startTurn(key, at, "human", true);
      ledger.recordSource({ ...key, lineage: "fixture", sourceId: "response", version: 0, kind: "response", provider: null, model: null, counts: { totalTokens: "42" } });
      ledger.rememberRollout(key.threadId, path);
    }
    state.close();
  }
  return directory;
}

function sources(directory: string) {
  const db = new DatabaseSync(join(directory, "token-usage.sqlite"), { readOnly: true });
  try { return db.prepare("SELECT server_id,provider,model FROM token_usage_sources ORDER BY server_id").all(); }
  finally { db.close(); }
}

test("backfill CLI requires explicit target configuration and never creates a missing store", async t => {
  const directory = await mkdtemp(join(tmpdir(), "opencraft-backfill-empty-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await assert.rejects(cli(directory, []), /Explicit --data-dir and --server-id/);
  await assert.rejects(cli(directory, ["--data-dir", directory]), /Explicit --data-dir and --server-id/);
  await assert.rejects(cli(directory, [...target, "--data-dir", directory, "--apply"]), /unable to open database/);
  assert.deepEqual(await readdir(directory), []);
  assert.match((await cli(directory, ["--help"])).stdout, /token-usage.sqlite/);
});

test("default preview and --dry-run never recover pending attempts or write model corrections", async t => {
  const directory = await fixture();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const db = new DatabaseSync(join(directory, "token-usage.sqlite"));
  db.prepare("INSERT INTO token_usage_attempts VALUES(?,?,?,?,?,?,?,?,?,'pending',NULL)")
    .run(serverId, "pending", "thread", "input", "start", "actor", "human", "human", at);
  db.close();
  const before = await readFile(join(directory, "token-usage.sqlite"));
  for (const mode of [[], ["--apply", "--dry-run"]]) {
    const result = JSON.parse((await cli(directory, [...target, "--data-dir", directory, ...mode])).stdout);
    assert.equal(result.apply, false);
    assert.equal(result.updatedTurns, 1);
    assert.deepEqual(await readFile(join(directory, "token-usage.sqlite")), before);
  }
  await assert.rejects(cli(directory, [...target, "--data-dir", directory, "--apply"]), /Pending delivery attempts/);
  assert.deepEqual(await readFile(join(directory, "token-usage.sqlite")), before);
});

test("apply repairs only the selected scope in the current usage store and leaves the legacy store intact", async t => {
  const directory = await fixture();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const legacy = await readFile(join(directory, "opencraft-host-state.sqlite"));
  const before = await readFile(join(directory, "token-usage.sqlite"));
  await assert.rejects(cli(directory, ["--data-dir", directory, "--server-id", "unknown", "--apply"]), /Server ID is not present/);
  assert.deepEqual(await readFile(join(directory, "token-usage.sqlite")), before);
  const args = [...target, "--data-dir", directory, "--apply"];
  assert.equal(JSON.parse((await cli(directory, args)).stdout).updatedTurns, 1);
  assert.deepEqual(sources(directory).map(row => ({ ...row })), [
    { server_id: "other-server", provider: null, model: null },
    { server_id: serverId, provider: "fixture-provider", model: "fixture-model" },
  ]);
  assert.deepEqual(await readFile(join(directory, "opencraft-host-state.sqlite")), legacy);
  assert.equal(JSON.parse((await cli(directory, args)).stdout).updatedTurns, 0);
});

test("explicit environment targets support the current and legacy data-directory variables", async t => {
  const directory = await fixture();
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const name of ["OPENCRAFT_USAGE_DATA_DIR", "OPENCRAFT_CODEX_DATA_DIR"]) {
    const result = await cli(directory, [], { [name]: directory, OPENCRAFT_SERVER_ID: serverId });
    assert.equal(JSON.parse(result.stdout).threads, 1);
    assert.equal(JSON.parse(result.stdout).apply, false);
  }
});
