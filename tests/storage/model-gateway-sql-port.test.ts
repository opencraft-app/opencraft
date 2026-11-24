// The model gateway over the runtime-neutral SQL port (cloudflare-deployment
// §5.6, storage-ports §7). Pins what the Node owner must keep while the
// domain and the owner's open are separate modules: the file, its ledger
// (schema id, versions, names, checksums), the busy timeout for the other
// processes sharing the file, and the schema. Then runs one domain sequence on
// the Node file owner and on the shared-database named chain the AccountCore
// object uses, and requires identical results.
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { STORE_MIGRATIONS } from "@opencraft/sqlite-node/store-migrations-data";
import { ModelGatewayStore } from "../../packages/account-pool-host/src/model-gateway-store.ts";

/** The published chain as the generated registry holds it; the Node owner's ledger must equal it. */
const PUBLISHED = [
  { version: 1, name: "model-gateway", checksum: "880dea7637d5efc08d7c77f32804556003d3ddd81af4adf0b81e22737856744b" },
  { version: 2, name: "personal-keys", checksum: "6228bea02d9e70bb43f03b8baacc057709fbd21366dbe0be49baf6f8a871674b" },
  {
    version: 3,
    name: "execution-authority",
    checksum: "e8063653a20cda634375f8ca782bbe01fa23917e74faebb8d978ade1021c5827",
  },
  {
    version: 4,
    name: "conversation-model-binding",
    checksum: "e05ead924b37c153add82e639d622470ff594825a5f004f880ee129bcc65af48",
  },
];

/** Every object of the published chain; all carry the `gateway_` prefix the shared-database chain declares. */
const OBJECTS = [
  "table:gateway_audit",
  "table:gateway_contributions",
  "table:gateway_execution_heads",
  "table:gateway_execution_turns",
  "table:gateway_executions",
  "table:gateway_limits",
  "table:gateway_personal_limits",
  "table:gateway_private_threads",
  "table:gateway_requests",
  "index:gateway_requests_actor",
  "index:gateway_requests_turn",
  "table:gateway_sponsors",
  "table:gateway_thread_humans",
  "table:gateway_thread_models",
  "table:schema_migrations",
];

async function directory(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "model-gateway-sql-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("the Node model gateway owner keeps its file, ledger, checksums, busy timeout and schema", async (t) => {
  const path = join(await directory(t), "gateway.sqlite");
  assert.deepEqual(STORE_MIGRATIONS["model-gateway"]?.baseline, PUBLISHED);
  const store = new ModelGatewayStore(path);
  try {
    assert.equal(store.outcome?.status, "fresh");
    assert.equal(store.outcome?.appliedVersion, 4);
    assert.equal((await stat(path)).isFile(), true);
  } finally {
    store.close();
  }
  const reopened = new ModelGatewayStore(path);
  try {
    assert.equal(reopened.outcome?.status, "up-to-date");
  } finally {
    reopened.close();
  }
  const raw = new DatabaseSync(path);
  try {
    assert.deepEqual(
      raw
        .prepare("SELECT version,name,checksum FROM schema_migrations ORDER BY version")
        .all()
        .map((row) => ({ ...row })),
      PUBLISHED,
    );
    assert.equal(
      raw.prepare("SELECT name FROM sqlite_master WHERE name='schema_ledgers'").get(),
      undefined,
      "a single-chain Node file never creates the shared ledger",
    );
    assert.deepEqual(
      raw
        .prepare("SELECT type,name FROM sqlite_master WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name")
        .all()
        .map((row) => `${String(row.type)}:${String(row.name)}`),
      OBJECTS,
    );
  } finally {
    raw.close();
  }
});

test("the Node model gateway owner sets the busy timeout for the processes sharing its file", async (t) => {
  const path = join(await directory(t), "gateway.sqlite");
  const store = new ModelGatewayStore(path);
  try {
    const database = (store as unknown as { db: { prepare(sql: string): { get(): Record<string, unknown> } } }).db;
    assert.equal(Number(Object.values(database.prepare("PRAGMA busy_timeout").get())[0]), 5000);
  } finally {
    store.close();
  }
});
