import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { AccountPoolStore } from "../../packages/account-pool-host/src/store.js";
import { openManagedDatabase, resolveStoreMigrations, type Migration } from "../../packages/sqlite-node/src/index.js";
import { readOwnerMigrations } from "../../scripts/storage-owner-source.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const legacy: readonly Migration[] = await readOwnerMigrations(root, { id: "account-pool-host", owner: "packages/account-pool-host/src/store.ts" });
const expected = [
  "5f9f2441b9b1eacd659433ccab4aca8280d8c705def3331ab5cb5f96caf40306",
  "efa5915505be9cb222c51a6f8a21f525a487709d6ef06c13cfb48e7ca35748fa",
  "cfce61648b03c24768cf6266631c8236302727405f66ee3a2b3c974321d2755f",
];
assert.equal(legacy.length, 3);
assert.deepEqual(legacy.map(m => createHash("sha256").update(m.sql).digest("hex")), expected);
// This exact identity was already executed by the private owner; generated SQL
// must adopt it, not replace its name or normalized SQL in an existing ledger.
const adopted: Migration = { version: 4, name: "codex-account-human-owner",
  sql: "ALTER TABLE pool_accounts ADD COLUMN owner_actor TEXT; CREATE INDEX pool_account_owner ON pool_accounts(owner_actor);" };
assert.deepEqual(resolveStoreMigrations("account-pool-host", legacy), [...legacy, adopted]);

async function fixture(t: test.TestContext, version?: 3 | 4) {
  const directory = await mkdtemp(join(tmpdir(), "account-history-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const databasePath = join(directory, "pool.sqlite"), secretsDirectory = join(directory, "secrets");
  if (version) {
    const old = openManagedDatabase({ path: databasePath, migrations: version === 3 ? legacy : [...legacy, adopted] });
    old.database.prepare("INSERT INTO pool_accounts(id,provider,label,upstream_account_id,priority,enabled,created_at) VALUES(?,?,?,?,?,?,?)")
      .run("existing", "codex", "Retained account", "synthetic-owner", 0, 1, 1);
    old.database.close();
  }
  return { databasePath, secretsDirectory };
}

for (const version of [undefined, 3, 4] as const) test(`account pool adopts exact private v4 identity from ${version ?? "fresh"}`, async t => {
  const options = await fixture(t, version), store = new AccountPoolStore(options);
  try {
    assert.equal(store.outcome.status, version === undefined ? "fresh" : version === 3 ? "migrated" : "up-to-date");
    assert.equal(store.outcome.appliedVersion, 4);
    assert.deepEqual(store.listAccounts().map(row => row.id), version ? ["existing"] : []);
  } finally { store.close(); }
  const db = new DatabaseSync(options.databasePath, { readOnly: true });
  try {
    const row = db.prepare("SELECT name,checksum FROM schema_migrations WHERE version=4").get()!;
    assert.equal(row.name, adopted.name);
    assert.equal(row.checksum, "06806b3015f024068147ba07c2310cd9df00b4f0946db414c95b9d87bea516fc");
    assert.ok(db.prepare("PRAGMA table_info(pool_accounts)").all().some(column => column.name === "owner_actor"));
  } finally { db.close(); }
  const reopened = new AccountPoolStore(options); try { assert.equal(reopened.outcome.status, "up-to-date"); } finally { reopened.close(); }
});

for (const damage of ["name", "checksum", "schema"] as const) test(`account history adoption still rejects changed ${damage}`, async t => {
  const options = await fixture(t, 4), db = new DatabaseSync(options.databasePath);
  if (damage === "schema") db.exec("DROP INDEX pool_account_owner; ALTER TABLE pool_accounts DROP COLUMN owner_actor");
  else db.prepare(`UPDATE schema_migrations SET ${damage}=? WHERE version=4`).run("changed-published-identity");
  db.close();
  assert.throws(() => new AccountPoolStore(options), (error: any) => error.kind === "history-mismatch");
  const read = new DatabaseSync(options.databasePath, { readOnly: true });
  try { assert.equal(read.prepare("SELECT count(*) AS count FROM pool_accounts").get()!.count, 1); } finally { read.close(); }
});
