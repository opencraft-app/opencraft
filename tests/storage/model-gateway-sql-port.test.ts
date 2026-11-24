// The model gateway over the runtime-neutral SQL port (cloudflare-deployment
// §5.6, storage-ports §7). Pins what the Node owner must keep while the
// domain and the owner's open are separate modules: the file, its ledger
// (schema id, versions, names, checksums), the busy timeout for the other
// processes sharing the file, and the schema. Then runs one domain sequence on
// the Node file owner and on the shared-database migration family the AccountCore
// object uses, and requires identical results.
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { STORE_MIGRATIONS } from "@opencraft/sqlite-node/store-migrations-data";
import { nodeSqlDatabase } from "@opencraft/sqlite-node";
import { SqlMigrationError } from "@opencraft/sql/migrations";
import { migrateModelPolicySqlDatabase } from "@opencraft/model-usage-policy/sql-owner";
import { recordSealer } from "@opencraft/secret-storage/sealed-records";
import {
  ModelGatewayStore,
  openModelGatewayDatabase,
} from "../../packages/account-pool-host/src/model-gateway-store.ts";
import {
  ModelGatewayError,
  ModelGatewayStore as SqlModelGatewayStore,
} from "../../packages/account-pool-host/src/model-gateway.ts";
import { openAccountPoolSqlStorage } from "../../packages/account-pool-host/src/account-pool-sql-owner.ts";
import { modelGatewaySqlSchema } from "../../packages/account-pool-host/src/model-gateway-sql-owner.ts";

const sealer = recordSealer(`k1.${"A".repeat(43)}`);

/** The published chain as the generated registry holds it; the Node owner's ledger must equal it. */
const PUBLISHED = [
  {
    version: 1,
    name: "model-gateway",
    checksum: "880dea7637d5efc08d7c77f32804556003d3ddd81af4adf0b81e22737856744b",
  },
  {
    version: 2,
    name: "personal-keys",
    checksum: "6228bea02d9e70bb43f03b8baacc057709fbd21366dbe0be49baf6f8a871674b",
  },
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
      raw.prepare("SELECT name FROM sqlite_master WHERE name='schema_family_migrations'").get(),
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
  const opened = openModelGatewayDatabase(path);
  try {
    assert.equal(Number(Object.values(opened.database.prepare("PRAGMA busy_timeout").get()!)[0]), 5000);
  } finally {
    opened.close();
  }
});

/** One admission, limit, contribution, execution and metering sequence; failures become their error kinds. */
function domainSequence(store: SqlModelGatewayStore) {
  const seen: [string, unknown][] = [];
  const step = (label: string, run: () => unknown) => {
    try {
      seen.push([label, run()]);
    } catch (error) {
      seen.push([label, { error: error instanceof ModelGatewayError ? error.kind : String(error) }]);
    }
  };
  step("configure", () =>
    store.configure("human-a", { monthlyTokens: 300, requestTokens: 100, concurrency: 2 }, 0, "admin"),
  );
  step("stale", () => store.configure("human-a", { monthlyTokens: 1, requestTokens: 1, concurrency: 1 }, 0, "admin"));
  step("default limit", () =>
    store.configure("*", { monthlyTokens: 50, requestTokens: 10, concurrency: 1 }, 0, "admin"),
  );
  step("bind", () => store.bind("thread-a", "human-a"));
  step("bind child", () => store.bind("thread-b", null, "thread-a"));
  step("personal limit", () => store.setPersonalLimit("human-a", 250, 0));
  let first = "";
  step("reserve", () => (first = store.reserve("thread-a", "model").id));
  step("dispatched", () => store.dispatched(first));
  step("finish", () =>
    store.finish(first, 40, { inputTokens: 30, outputTokens: 10, cacheReadTokens: null, cacheWriteTokens: null }),
  );
  let second = "";
  step("reserve again", () => (second = store.reserve("thread-b", "model").id));
  step("reserve a third", () => store.reserve("thread-a", "model"));
  step("unknown outcome", () => store.finish(second, null));
  step("reconcile", () => store.reconcile(second, 20, "admin", "receipt"));
  step("summary", () => store.summary("human-a"));
  step("unsponsored", () => store.reserve("thread-z", "model"));
  step("prepare", () => store.prepareContribution("byok-1", "human-a", "approved"));
  step("share", () => store.contributionState("byok-1", "human-a", "shared"));
  step("scope", () => store.setScope("byok-1", "human-a", "team", 0));
  step("can use", () => [store.canUse("byok-1", "human-b"), store.canUse("byok-1", null)]);
  step("bind conversation", () => store.bindConversationModel("thread-c", "human-a", "configured/byok-1/model"));
  step("conversation", () => store.conversationModel("thread-c"));
  step("withdraw", () => store.contributionState("byok-1", "human-a", "withdrawn"));
  step("forbidden reconnect", () => store.reconnectContribution("byok-1", "human-a"));
  step("contributions", () => store.contributions("human-a"));
  step("execution", () =>
    store.beginExecution("thread-e", {
      id: "exec-1",
      authorizer: "human-a",
      executor: null,
      model: "model",
      expiresAt: Date.UTC(2030, 0, 1),
    }),
  );
  step("execution head", () => store.execution("thread-e"));
  step("end execution", () => store.endExecution("thread-e", "exec-1"));
  step("requests", () => store.requests("human-a"));
  return seen;
}

const normalize = (value: unknown) => {
  const ids = new Map<string, string>();
  return JSON.parse(
    JSON.stringify(value, (key, item) =>
      typeof item === "number" && item > 1e12 ? "<time>" : key === "at" || key === "created_at" ? "<time>" : item,
    ).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gu, (id) => {
      if (!ids.has(id)) ids.set(id, `<id${ids.size}>`);
      return ids.get(id)!;
    }),
  );
};

test("the gateway domain gives the same results on the Node file owner and on a named chain of a shared database", async (t) => {
  const path = join(await directory(t), "gateway.sqlite");
  // A clock that advances per call: request order (by creation time) is then defined on both owners.
  const clock = () => {
    let at = Date.UTC(2026, 10, 1);
    return () => (at += 1000);
  };
  const node = new ModelGatewayStore(path, clock());
  let nodeRun: unknown;
  try {
    nodeRun = normalize(domainSequence(node));
  } finally {
    node.close();
  }
  const connection = new DatabaseSync(":memory:");
  const database = nodeSqlDatabase(connection);
  // The policy has already opened its own ledger, as in AccountCore.
  migrateModelPolicySqlDatabase(database);
  const policyLedger = connection.prepare("SELECT version,name,checksum FROM schema_migrations ORDER BY version");
  const policyBefore = policyLedger.all();
  const shared = new SqlModelGatewayStore(openAccountPoolSqlStorage(database, sealer).gateway, clock());
  assert.deepEqual(shared.outcome, { status: "fresh", appliedVersion: 4, movedAsidePaths: [] });
  assert.deepEqual(normalize(domainSequence(shared)), nodeRun);
  // The sequence exercised refusals as well as writes.
  const result = (label: string) => (nodeRun as [string, unknown][]).find(([name]) => name === label)?.[1];
  assert.deepEqual(["stale", "unsponsored", "forbidden reconnect"].map(result), [
    { error: "gateway_revision_conflict" },
    { error: "gateway_human_sponsor_required" },
    { error: "gateway_contribution_forbidden" },
  ]);
  assert.equal((result("summary") as { usedTokens: number }).usedTokens, 40);
  // The shared chain's objects are exactly the Node file's, and its versions, names and checksums are the published ones.
  assert.deepEqual(
    connection
      .prepare("SELECT type,name FROM sqlite_master WHERE name LIKE 'gateway\\_%' ESCAPE '\\' ORDER BY name")
      .all()
      .map((row) => `${String(row.type)}:${String(row.name)}`),
    OBJECTS.filter((name) => name !== "table:schema_migrations"),
  );
  const declaration = modelGatewaySqlSchema();
  assert.deepEqual(
    declaration.migrations.map(({ version, name, checksum }) => ({ version, name, checksum })),
    PUBLISHED,
  );
  assert.equal(openAccountPoolSqlStorage(database, sealer).gateway.outcome?.status, "up-to-date");
  // The other chain is untouched, and a single-chain Node file was never given a shared ledger (above).
  assert.deepEqual(policyLedger.all(), policyBefore);
  connection.close();
});

test("a shared database refuses gateway objects without the gateway chain's ledger, and a changed gateway history", () => {
  const foreign = new DatabaseSync(":memory:");
  foreign.exec("CREATE TABLE gateway_limits(actor TEXT PRIMARY KEY) STRICT");
  assert.throws(() => openAccountPoolSqlStorage(nodeSqlDatabase(foreign), sealer), SqlMigrationError);
  foreign.close();
  const connection = new DatabaseSync(":memory:");
  const database = nodeSqlDatabase(connection);
  openAccountPoolSqlStorage(database, sealer);
  connection.exec("UPDATE schema_family_migrations SET checksum='0' WHERE family='model-gateway' AND version=2");
  assert.throws(() => openAccountPoolSqlStorage(database, sealer), SqlMigrationError);
  connection.close();
});
