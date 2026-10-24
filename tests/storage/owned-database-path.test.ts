import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openManagedDatabase, SqliteLifecycleError } from "@opencraft/sqlite-node";
import { ownedDatabasePath } from "../../apps/opencraft-daemon/src/owned-database-path.js";
import { OpenCraftHostStateDatabase, OPENCRAFT_HOST_STATE_MIGRATIONS } from "../../apps/opencraft-daemon/src/opencraft-host-state-database.js";
import { OpenCraftMessageAttachments, OPENCRAFT_MESSAGE_ATTACHMENTS_MIGRATIONS } from "../../apps/opencraft-daemon/src/opencraft-message-attachments.js";
import { TokenUsageStateDatabase } from "../../apps/opencraft-daemon/src/token-usage-state-database.js";

const owners = [
  { name: "Host state", current: "opencraft-host-state.sqlite", legacy: "codex-host-queue.sqlite",
    migrations: OPENCRAFT_HOST_STATE_MIGRATIONS, open: (root: string) => new OpenCraftHostStateDatabase(root),
    table: "message_senders", seed: "INSERT INTO message_senders VALUES('thread','input','{}',42)" },
  { name: "Attachments", current: "opencraft-message-attachments.sqlite", legacy: "codex-message-attachments.sqlite",
    migrations: OPENCRAFT_MESSAGE_ATTACHMENTS_MIGRATIONS, open: (root: string) => new OpenCraftMessageAttachments(root),
    table: "opencraft_message_attachments", seed: "INSERT INTO opencraft_message_attachments VALUES('thread','input','file',0,'{}')" },
];
async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "opencraft-owned-path-"));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}
const conflict = (error: unknown) => error instanceof SqliteLifecycleError && error.kind === "unsupported-legacy";

for (const owner of owners) {
  test(`${owner.name}: new stores use the owned path and reopen the same records`, () => fixture(async root => {
    const first = owner.open(root); assert.equal(first.path, join(root, owner.current)); first.close();
    const seed = new DatabaseSync(join(root, owner.current)); seed.exec(owner.seed); seed.close();
    const reopened = owner.open(root); assert.equal(reopened.outcome.status, "up-to-date"); reopened.close();
    const read = new DatabaseSync(join(root, owner.current), { readOnly: true });
    assert.equal(read.prepare(`SELECT count(*) AS n FROM ${owner.table}`).get()?.n, 1); read.close();
    assert.ok(!(await readdir(root)).includes(owner.legacy));
  }));
  test(`${owner.name}: existing legacy path stays in place with all records and no replacement`, () => fixture(async root => {
    const old = openManagedDatabase({ path: join(root, owner.legacy), migrations: owner.migrations });
    old.database.exec(owner.seed); old.database.close();
    const first = owner.open(root); assert.equal(first.path, join(root, owner.legacy)); first.close();
    const next = owner.open(root); assert.equal(next.path, join(root, owner.legacy)); next.close();
    const read = new DatabaseSync(join(root, owner.legacy), { readOnly: true });
    assert.equal(read.prepare(`SELECT count(*) AS n FROM ${owner.table}`).get()?.n, 1); read.close();
    assert.ok(!(await readdir(root)).includes(owner.current));
  }));
  test(`${owner.name}: two populated stores are refused without modifying either file`, () => fixture(async root => {
    for (const name of [owner.current, owner.legacy]) {
      const store = openManagedDatabase({ path: join(root, name), migrations: owner.migrations });
      store.database.exec(owner.seed); store.database.close();
    }
    const before = await Promise.all([owner.current, owner.legacy].map(name => readFile(join(root, name))));
    assert.throws(() => owner.open(root), conflict);
    assert.deepEqual(await Promise.all([owner.current, owner.legacy].map(name => readFile(join(root, name)))), before);
  }));
  for (const name of [owner.current, owner.legacy]) for (const suffix of ["-wal", "-shm", "-journal"]) {
    test(`${owner.name}: orphan ${name}${suffix} cannot create an empty replacement`, () => fixture(async root => {
      const orphan = join(root, name + suffix); await writeFile(orphan, "synthetic retained sidecar");
      assert.throws(() => owner.open(root), conflict);
      assert.deepEqual(await readdir(root), [name + suffix]);
      assert.equal(await readFile(orphan, "utf8"), "synthetic retained sidecar");
    }));
  }
  test(`${owner.name}: path selection never alters an active legacy WAL`, () => fixture(async root => {
    const path = join(root, owner.legacy), db = new DatabaseSync(path);
    try {
      db.exec("PRAGMA journal_mode=WAL; CREATE TABLE retained(value TEXT); INSERT INTO retained VALUES('committed'); BEGIN IMMEDIATE; INSERT INTO retained VALUES('pending')");
      const wal = await readFile(path + "-wal");
      assert.equal(ownedDatabasePath(root, owner.current, owner.legacy), path);
      assert.deepEqual(await readFile(path + "-wal"), wal);
      assert.ok(!(await readdir(root)).includes(owner.current));
      db.exec("ROLLBACK"); assert.equal(db.prepare("SELECT count(*) AS n FROM retained").get()?.n, 1);
    } finally { db.close(); }
  }));
}

test("metering imports through the selected Host path for new and legacy installations", () => fixture(async root => {
  for (const legacy of [false, true]) {
    const directory = join(root, legacy ? "existing" : "fresh");
    if (legacy) { const old = openManagedDatabase({ path: join(directory, "codex-host-queue.sqlite"), migrations: OPENCRAFT_HOST_STATE_MIGRATIONS }); old.database.close(); }
    const host = new OpenCraftHostStateDatabase(directory);
    try {
      host.database.exec("INSERT INTO token_usage_scopes VALUES('server',1000,1,42)");
      const usage = new TokenUsageStateDatabase(directory, host.path);
      try { assert.equal(usage.database.prepare("SELECT revision FROM token_usage_scopes WHERE server_id='server'").get()?.revision, 42); }
      finally { usage.close(); }
      assert.ok(!(await readdir(directory)).includes(legacy ? "opencraft-host-state.sqlite" : "codex-host-queue.sqlite"));
    } finally { host.close(); }
  }
}));
