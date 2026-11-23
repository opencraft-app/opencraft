// WorkspaceHost stores in workerd (Miniflare, no Cloudflare account): every
// store's published migrations run unchanged on Durable Object SQL through the
// runtime-neutral ledger runner, give the same ledger and schema as on
// node:sqlite, survive a restart without reapplying, upgrade from an older
// build, refuse a tampered checksum, and the unchanged domain stores give the
// same results as on nodeSqlDatabase. See workspace-host-split.md §4.1.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { nodeSqlDatabase } from "@opencraft/sqlite-node";
import { migrate, publishedMigrations, scenario, schema, WORKSPACE_HOST_STORES } from "./workerd/workspace-host-domain.ts";

const COMPATIBILITY_DATE = "2026-07-30";
let directory: string;
let script: string;
let sequence = 0;
const running = new Set<Miniflare>();

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "workspace-host-workerd-"));
  const outfile = join(directory, "worker.mjs");
  await build({
    entryPoints: [resolve(import.meta.dirname, "workerd/workspace-host-worker.ts")],
    outfile,
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2023",
    mainFields: ["module", "main"],
    conditions: ["workerd", "worker", "import"],
    // nodejs_compat supplies node:crypto; node:sqlite, node:fs and node:path load but the Node owners are never called.
    external: ["cloudflare:*", "node:*"],
    logLevel: "silent",
  });
  script = await readFile(outfile, "utf8");
});
after(async () => {
  for (const miniflare of running) await miniflare.dispose();
  if (directory) await rm(directory, { recursive: true, force: true });
});

function start(persist?: string): Miniflare {
  const miniflare = new Miniflare({
    modules: [{ type: "ESModule", path: "worker.mjs", contents: script }],
    compatibilityDate: COMPATIBILITY_DATE,
    compatibilityFlags: ["nodejs_compat"],
    durableObjects: { STORE: { className: "WorkspaceHostStoreObject", useSQLite: true } },
    ...(persist ? { durableObjectsPersist: persist } : {}),
  });
  running.add(miniflare);
  return miniflare;
}
async function stop(miniflare: Miniflare) {
  running.delete(miniflare);
  await miniflare.dispose();
}
function client(miniflare: Miniflare, object = `workspace-${++sequence}`) {
  return async (method: string, store: string, limit?: number): Promise<any> => {
    const response = await miniflare.dispatchFetch("http://workspace/", { method: "POST", body: JSON.stringify({ object, method, store, limit }) });
    const outcome = (await response.json()) as { ok: boolean; value?: unknown; error?: string };
    if (!outcome.ok) throw new Error(outcome.error);
    return outcome.value;
  };
}
function nodeMemory() {
  const connection = new DatabaseSync(":memory:");
  return { connection, database: nodeSqlDatabase(connection) };
}

for (const store of WORKSPACE_HOST_STORES) {
  test(`${store}: published migrations run unchanged on Durable Object SQL`, async () => {
    const call = client(start());
    const expected = publishedMigrations(store).map(({ version, name, checksum }) => ({ version, name, checksum }));
    assert.deepEqual(await call("migrate", store), expected);
    const node = nodeMemory();
    try {
      migrate(node.database, store);
      assert.deepEqual(await call("schema", store), schema(node.database), "same schema as node:sqlite");
    } finally {
      node.connection.close();
    }
  });

  test(`${store}: domain operations on Durable Object SQL equal nodeSqlDatabase`, async () => {
    const call = client(start());
    const node = nodeMemory();
    try {
      migrate(node.database, store);
      assert.deepEqual(await call("scenario", store), await scenario(node.database, store));
    } finally {
      node.connection.close();
    }
  });
}

test("restart keeps every recorded ledger row, upgrades an older Host state object through v13–v17 and refuses a tampered checksum", async () => {
  const persist = await mkdtemp(join(directory, "persist-"));
  const first = start(persist);
  const recorded: Record<string, unknown> = {};
  for (const store of WORKSPACE_HOST_STORES) {
    // The Host state object stops at v12 so the restart runs v13–v17 (renames, rebuilt queue, foreign key).
    recorded[store] = await client(first, store)("migrate", store, store === "opencraft-host-state" ? 12 : undefined);
  }
  await client(first, "tampered")("migrate", "conversation-schedules");
  assert.equal(await client(first, "tampered")("tamperLedger", "conversation-schedules"), 1);
  await stop(first);

  const second = start(persist);
  for (const store of WORKSPACE_HOST_STORES) {
    const call = client(second, store);
    const ledger = await call("migrate", store);
    assert.deepEqual(ledger.slice(0, (recorded[store] as unknown[]).length), recorded[store], `${store}: earlier rows kept`);
    assert.equal(ledger.length, publishedMigrations(store).length);
  }
  await assert.rejects(client(second, "tampered")("migrate", "conversation-schedules"), /Unsupported database migration history/);
  await stop(second);
});
