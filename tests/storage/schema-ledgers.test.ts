// Several published migration chains in one database (storage-ports §3.1
// "同库多条迁移链"): the database's own chain keeps `schema_migrations`, every
// further chain its rows in `schema_ledgers` under its schema id. Runs on the
// Node SQL adapter; the AccountCore Durable Object runs the same chains in
// workerd (tests/storage/account-core-do-workerd.test.ts). Also covers the
// account pool's shared-SQL owner, synchronously sealed credential records,
// the renewal exchange and the renewal schedule on the owner wake-up port.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  hashSqlMigrations,
  resolveSqlMigrationContract,
  SqlMigrationError,
  validateMigrationHistory,
  type SqlMigration,
} from "@opencraft/sql/migrations";
import { nodeSqlDatabase, resolveStoreMigrations, schemaFingerprint } from "@opencraft/sqlite-node";
import { STORE_MIGRATIONS } from "@opencraft/sqlite-node/store-migrations-data";
import { SecretStoreCorruptError } from "@opencraft/secret-storage";
import { SecretSealingKeyError } from "@opencraft/secret-storage/sealed";
import { recordSealer } from "@opencraft/secret-storage/sealed-records";
import { migrateModelPolicySqlDatabase } from "@opencraft/model-usage-policy/sql-owner";
import { ModelPolicyStore } from "@opencraft/model-usage-policy/store";
import type { OwnerWake } from "@opencraft/owner-wake";
import {
  ACCOUNT_CREDENTIAL_RECORD_MIGRATIONS,
  ACCOUNT_POOL_SCHEMA,
  accountPoolSqlSchemas,
  openAccountPoolSqlStorage,
  ownedByAccountPoolSchemas,
} from "../../packages/account-pool-host/src/account-pool-sql-owner.ts";
import { ACCOUNT_POOL_MIGRATIONS, AccountPool, AccountPoolStore } from "../../packages/account-pool-host/src/store.ts";
import { assembleAccountPoolCore } from "../../packages/account-pool-host/src/account-pool-core.ts";
import {
  fetchAccountRenewal,
  parseAccountRenewalResponse,
} from "../../packages/account-pool-host/src/account-renewal.ts";
import {
  ACCOUNT_REFRESH_LEAD_MS,
  ACCOUNT_REFRESH_RETRY_MS,
} from "../../packages/account-pool-host/src/account-refresh-schedule.ts";
import { isMigrationLedgerObject, migrateSqlSchema, schemaMigrationLedger } from "@opencraft/sql/schema-ledgers";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const KEY = `k1.${"A".repeat(43)}`;
const OTHER_KEY = `k2.${"B".repeat(43)}`;

function memory() {
  const connection = new DatabaseSync(":memory:");
  connection.exec("PRAGMA foreign_keys=ON");
  return { connection, database: nodeSqlDatabase(connection) };
}

const chain = (prefix: string, versions = 2): SqlMigration[] =>
  Array.from({ length: versions }, (_, index) => ({
    version: index + 1,
    name: `${prefix}-${index + 1}`,
    sql:
      index === 0
        ? `CREATE TABLE ${prefix}_rows (id INTEGER PRIMARY KEY, v TEXT) STRICT`
        : `CREATE INDEX ${prefix}_rows_v${index} ON ${prefix}_rows(v)`,
  }));
const declare = (prefix: string, versions = 2) => ({
  schema: prefix,
  migrations: hashSqlMigrations(chain(prefix, versions), sha256),
  owns: (name: string) => name.startsWith(`${prefix}_`),
});

test("named chains share a database with its own chain: independent versions, ledgers and outcomes", () => {
  const { connection, database } = memory();
  const policy = migrateModelPolicySqlDatabase(database, {
    ownedByRuntime: (name) => isMigrationLedgerObject(name) || name.startsWith("alpha_") || name.startsWith("beta_"),
  });
  new ModelPolicyStore(policy).write(0, [{ engine: "pi", effort: "high" }], "admin");
  assert.deepEqual(migrateSqlSchema(database, declare("alpha")), {
    schema: "alpha",
    status: "fresh",
    appliedVersion: 2,
  });
  assert.deepEqual(migrateSqlSchema(database, declare("beta", 1)), {
    schema: "beta",
    status: "fresh",
    appliedVersion: 1,
  });
  // Version 1 exists in all three chains; each history is its own.
  assert.deepEqual(
    connection
      .prepare("SELECT schema_id,version,name FROM schema_ledgers ORDER BY schema_id,version")
      .all()
      .map((row) => ({ ...row })),
    [
      { schema_id: "alpha", version: 1, name: "alpha-1" },
      { schema_id: "alpha", version: 2, name: "alpha-2" },
      { schema_id: "beta", version: 1, name: "beta-1" },
    ],
  );
  const own = connection.prepare("SELECT version,name FROM schema_migrations ORDER BY version").all();
  assert.ok(own.length > 0 && own.every((row) => String(row.name) !== "alpha-1"));
  // A later chain version is applied on the next open; nothing else moves.
  assert.deepEqual(migrateSqlSchema(database, declare("beta", 2)).status, "migrated");
  assert.deepEqual(migrateSqlSchema(database, declare("alpha")).status, "up-to-date");
  assert.equal(migrateModelPolicySqlDatabase(database, { ownedByRuntime: () => true }).outcome.status, "up-to-date");
  assert.equal(new ModelPolicyStore(policy).read().revision, 1);
});

test("a named chain refuses a changed, foreign, newer or unledgered history without touching the others", () => {
  const { connection, database } = memory();
  migrateSqlSchema(database, declare("alpha"));
  migrateSqlSchema(database, declare("beta"));
  connection.prepare("UPDATE schema_ledgers SET checksum='0' WHERE schema_id='alpha' AND version=2").run();
  assert.throws(
    () => migrateSqlSchema(database, declare("alpha")),
    (error: unknown) => error instanceof SqlMigrationError && error.kind === "history-mismatch",
  );
  assert.equal(migrateSqlSchema(database, declare("beta")).status, "up-to-date");
  // A chain that renamed a published migration is another history.
  const renamed = {
    ...declare("beta"),
    migrations: hashSqlMigrations(
      chain("beta").map((m) => ({ ...m, name: `${m.name}x` })),
      sha256,
    ),
  };
  assert.throws(() => migrateSqlSchema(database, renamed), /Unsupported database migration history/);
  // A ledger beyond the declared chain is a newer schema.
  assert.throws(
    () => migrateSqlSchema(database, declare("beta", 1)),
    (error: unknown) => error instanceof SqlMigrationError && error.kind === "newer-schema",
  );
  // Owned objects without the chain's ledger are never adopted; foreign objects do not matter.
  connection.exec(
    "CREATE TABLE gamma_rows (id INTEGER PRIMARY KEY) STRICT; CREATE TABLE unrelated (id INTEGER) STRICT",
  );
  assert.throws(() => migrateSqlSchema(database, declare("gamma", 1)), /has objects but no migration ledger/);
  assert.equal(migrateSqlSchema(database, declare("delta", 1)).status, "fresh");
  assert.throws(() => migrateSqlSchema(database, { ...declare("delta"), schema: "Delta!" }), /Schema id/);
  // A failed migration leaves no ledger row and no object behind.
  const broken = {
    schema: "epsilon",
    migrations: hashSqlMigrations(
      [
        {
          version: 1,
          name: "broken",
          sql: "CREATE TABLE epsilon_rows (id INTEGER); CREATE TABLE unrelated (id INTEGER)",
        },
      ],
      sha256,
    ),
    owns: (name: string) => name.startsWith("epsilon_"),
  };
  assert.throws(() => migrateSqlSchema(database, broken), /already exists/);
  assert.equal(validateMigrationHistory(database, broken.migrations, { ledger: schemaMigrationLedger("epsilon") }), 0);
  assert.equal(connection.prepare("SELECT 1 FROM sqlite_master WHERE name='epsilon_rows'").get(), undefined);
});

test("the account pool's shared-SQL chains apply the Node owner's published chain and pin the credential record chain", async () => {
  // The neutral contract resolution gives exactly the Node owner's chain.
  assert.deepEqual(
    resolveSqlMigrationContract(ACCOUNT_POOL_MIGRATIONS, STORE_MIGRATIONS[ACCOUNT_POOL_SCHEMA], sha256),
    resolveStoreMigrations("account-pool-host", ACCOUNT_POOL_MIGRATIONS),
  );
  assert.throws(
    () =>
      resolveSqlMigrationContract(
        [{ ...ACCOUNT_POOL_MIGRATIONS[0]!, sql: "CREATE TABLE x (y)" }, ...ACCOUNT_POOL_MIGRATIONS.slice(1)],
        STORE_MIGRATIONS[ACCOUNT_POOL_SCHEMA],
        sha256,
      ),
    /prefix differs/,
  );
  // Published: changing this text is a new version, never an edit.
  assert.deepEqual(
    hashSqlMigrations(ACCOUNT_CREDENTIAL_RECORD_MIGRATIONS, sha256).map(({ version, name, checksum }) => ({
      version,
      name,
      checksum,
    })),
    [
      {
        version: 1,
        name: "account-credential-records",
        checksum: "c49052c274dce0fc0c668969f1498ca0762a3593fbd61c5c48fd282425f396de",
      },
    ],
  );
  // The pool's tables in the shared database are those of the Node file owner.
  const { connection, database } = memory();
  migrateModelPolicySqlDatabase(database, {
    ownedByRuntime: (name) => isMigrationLedgerObject(name) || ownedByAccountPoolSchemas(name),
  });
  const storage = openAccountPoolSqlStorage(database, recordSealer(KEY));
  assert.deepEqual(
    storage.outcomes.map((outcome) => [outcome.schema, outcome.status, outcome.appliedVersion]),
    [
      ["account-pool-host", "fresh", 4],
      ["account-credential-records", "fresh", 1],
    ],
  );
  const root = await mkdtemp(join(tmpdir(), "opencraft-shared-pool-"));
  try {
    const file = new AccountPoolStore({
      databasePath: join(root, "account-pool.sqlite"),
      secretsDirectory: join(root, "secrets"),
    });
    file.close();
    const reader = new DatabaseSync(join(root, "account-pool.sqlite"), { readOnly: true });
    const pools = (fingerprint: string) =>
      (JSON.parse(fingerprint) as { name: string }[]).filter((table) => table.name.startsWith("pool_"));
    try {
      assert.deepEqual(pools(schemaFingerprint(connection)), pools(schemaFingerprint(reader)));
    } finally {
      reader.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  assert.equal(
    openAccountPoolSqlStorage(database, recordSealer(KEY)).outcomes.every((o) => o.status === "up-to-date"),
    true,
  );
  assert.equal(accountPoolSqlSchemas().length, 2);
});

test("credential records are sealed in the pool's own SQL rows and join the pool's transaction", () => {
  const { connection, database } = memory();
  const pool = new AccountPool(openAccountPoolSqlStorage(database, recordSealer(KEY)));
  pool.addAccount(
    { id: "a", provider: "codex", label: "A", upstreamAccountId: "upstream-a", priority: 1, enabled: true },
    { accessToken: "plain-access", refreshToken: "plain-refresh", expiresAt: null },
  );
  const host = pool.issueHostToken("local-codex");
  const rows = connection.prepare("SELECT kind,id,sealed FROM account_credential_records ORDER BY kind").all();
  assert.equal(rows.length, 2);
  assert.doesNotMatch(JSON.stringify(rows), /plain-access|plain-refresh|local-codex/u);
  assert.ok(!JSON.stringify(rows).includes(host));
  assert.ok(rows.every((row) => String(row.sealed).startsWith("ocr1.k1.")));
  assert.equal(pool.readCredential("a").accessToken, "plain-access");
  assert.equal(pool.authenticateHostToken(host), "local-codex");
  // A sealed value moved to another row does not open, and is never read as plaintext.
  connection
    .prepare("INSERT INTO account_credential_records(kind,id,sealed) VALUES('account','b',?)")
    .run(String(rows[0]!.sealed));
  connection
    .prepare(
      "INSERT INTO pool_accounts(id,provider,label,upstream_account_id,priority,enabled,created_at) VALUES('b','codex','B','upstream-b',2,1,0)",
    )
    .run();
  assert.throws(() => pool.readCredential("b"), /Account credentials are unavailable/);
  connection
    .prepare("UPDATE account_credential_records SET sealed='{\"accessToken\":\"x\"}' WHERE kind='account' AND id='b'")
    .run();
  assert.throws(() => pool.readCredential("b"), /Account credentials are unavailable/);
  // Another key's records are refused, not returned.
  const other = new AccountPool(openAccountPoolSqlStorage(database, recordSealer(OTHER_KEY)));
  assert.throws(() => other.readCredential("a"), /Account credentials are unavailable/);
  // A removal hides the record and rolls it back when the row delete fails.
  connection.exec(
    "CREATE TRIGGER refuse_delete BEFORE DELETE ON pool_accounts BEGIN SELECT RAISE(ABORT, 'refused'); END",
  );
  assert.throws(() => pool.removeAccount("a"), /refused/);
  assert.equal(pool.readCredential("a").accessToken, "plain-access");
  connection.exec("DROP TRIGGER refuse_delete");
  pool.removeAccount("a");
  assert.equal(
    connection.prepare("SELECT 1 FROM account_credential_records WHERE kind='account' AND id='a'").get(),
    undefined,
  );
});

test("record sealing binds the context and key, and refuses malformed keys and values", () => {
  const sealer = recordSealer(KEY);
  const sealed = sealer.seal("account:a", "value");
  assert.equal(sealer.unseal("account:a", sealed), "value");
  assert.notEqual(sealer.seal("account:a", "value"), sealed);
  assert.throws(() => sealer.unseal("account:b", sealed), SecretStoreCorruptError);
  assert.throws(() => sealer.unseal("account:a", "value"), SecretStoreCorruptError);
  assert.throws(
    () =>
      sealer.unseal(
        "account:a",
        sealed.replace(/.$/u, (c) => (c === "A" ? "B" : "A")),
      ),
    SecretStoreCorruptError,
  );
  assert.throws(() => recordSealer(OTHER_KEY).unseal("account:a", sealed), SecretSealingKeyError);
  for (const bad of [undefined, "", "k1", "k1.short", `k1.${"A".repeat(43)}.x`])
    assert.throws(() => recordSealer(bad), SecretSealingKeyError);
});

test("the renewal exchange validates the executor's answer and keeps the account identity", async () => {
  const account = {
    id: "a",
    provider: "codex" as const,
    label: "A",
    upstreamAccountId: "upstream-a",
    priority: 1,
    enabled: true,
    allowCredits: false,
    createdAt: 0,
  };
  const secret = { accessToken: "t", refreshToken: "r", idToken: null, expiresAt: 1 };
  const answering = (status: number, body: unknown) => ({ fetch: async () => Response.json(body, { status }) });
  const renewed = {
    status: "renewed",
    upstreamAccountId: "upstream-a",
    secret: { accessToken: "t2", refreshToken: "r2", idToken: null, expiresAt: null },
  };
  assert.deepEqual(await fetchAccountRenewal(answering(200, renewed))(account, secret, "expired"), renewed.secret);
  const code = (promise: Promise<unknown>) =>
    promise.then(
      () => "resolved",
      (error: { diagnostic?: { code: string }; message: string }) => error.diagnostic?.code ?? error.message,
    );
  assert.equal(
    await code(
      fetchAccountRenewal(answering(200, { ...renewed, upstreamAccountId: "upstream-b" }))(account, secret, "expired"),
    ),
    "Codex refresh changed account identity",
  );
  assert.equal(
    await code(
      fetchAccountRenewal(answering(200, { status: "failed", code: "authorization-rejected" }))(
        account,
        secret,
        "expired",
      ),
    ),
    "authorization-rejected",
  );
  assert.equal(
    await code(fetchAccountRenewal(answering(200, { status: "failed", code: "made-up" }))(account, secret, "expired")),
    "renewal-incomplete",
  );
  assert.equal(await code(fetchAccountRenewal(answering(502, {}))(account, secret, "expired")), "service-unavailable");
  assert.equal(
    await code(
      fetchAccountRenewal({ fetch: () => Promise.reject(new TypeError("offline")) })(account, secret, "expired"),
    ),
    "service-unavailable",
  );
  assert.equal(
    await code(fetchAccountRenewal(answering(200, renewed))(account, { ...secret, refreshToken: null }, "expired")),
    "Codex account cannot refresh without a refresh token",
  );
  assert.throws(() =>
    parseAccountRenewalResponse({
      status: "renewed",
      upstreamAccountId: "u",
      secret: { accessToken: "", refreshToken: null, idToken: null, expiresAt: null },
    }),
  );
});

/** A manual owner clock: `advance` fires the armed wake-up when its time has come. */
function manualWake() {
  let now = 1_000_000;
  let armed: { at: number; fire: () => void } | null = null;
  const wake: OwnerWake = {
    now: () => now,
    timer: (fire) => ({
      arm: (at) => void (armed = { at, fire }),
      cancel: () => void (armed = null),
    }),
  };
  return {
    wake,
    armedAt: () => armed?.at ?? null,
    advance(ms: number) {
      now += ms;
      if (armed && armed.at <= now) {
        const { fire } = armed;
        armed = null;
        fire();
      }
    },
  };
}

test("the renewal schedule arms for the earliest due account, renews it once, backs off a failure and re-derives after a restart", async () => {
  const { database } = memory();
  const clock = manualWake();
  const calls: string[] = [];
  let fail = false;
  const open = () => {
    const storage = openAccountPoolSqlStorage(database, recordSealer(KEY));
    return assembleAccountPoolCore({
      pool: new AccountPool(storage, { now: clock.wake.now }),
      wake: clock.wake,
      renew: async (account, secret) => {
        calls.push(account.id);
        if (fail) throw new Error("renewal failed");
        return { ...secret, accessToken: `${secret.accessToken}+r`, expiresAt: clock.wake.now() + 60 * 60_000 };
      },
    });
  };
  let core = open();
  const add = (id: string, expiresAt: number | null, refreshToken: string | null = `ref-${id}`) => {
    core.pool.addAccount(
      { id, provider: "codex", label: id, upstreamAccountId: `u-${id}`, priority: 1, enabled: true },
      { accessToken: `tok-${id}`, refreshToken, expiresAt },
    );
    core.schedule.reschedule();
  };
  assert.equal(clock.armedAt(), null);
  add("never", null);
  add("no-refresh", clock.wake.now() + 1_000, null);
  assert.equal(clock.armedAt(), null);
  const expiry = clock.wake.now() + ACCOUNT_REFRESH_LEAD_MS + 10_000;
  add("a", expiry);
  add("b", expiry + 5_000);
  assert.equal(clock.armedAt(), expiry - ACCOUNT_REFRESH_LEAD_MS);
  clock.advance(9_999);
  assert.deepEqual(calls, []);
  clock.advance(1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["a"]);
  assert.equal(core.pool.readCredential("a").accessToken, "tok-a+r");
  assert.equal(clock.armedAt(), expiry + 5_000 - ACCOUNT_REFRESH_LEAD_MS);
  // A failed renewal keeps the credential and is retried after the back-off, not at once.
  fail = true;
  clock.advance(5_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["a", "b"]);
  assert.equal(core.pool.readCredential("b").accessToken, "tok-b");
  assert.equal(clock.armedAt(), clock.wake.now() + ACCOUNT_REFRESH_RETRY_MS);
  // A restart drops the back-off: the schedule re-derives from storage and is due at once.
  await core.close();
  core = open();
  assert.ok(clock.armedAt()! <= clock.wake.now());
  fail = false;
  clock.advance(0);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["a", "b", "b"]);
  assert.equal(core.pool.readCredential("b").accessToken, "tok-b+r");
  // Disabled accounts are not renewed.
  core.pool.setEnabled("a", false);
  core.schedule.reschedule();
  assert.equal(clock.armedAt(), core.schedule.nextDueAt());
  await core.close();
  assert.equal(clock.armedAt(), null);
});
